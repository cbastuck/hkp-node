/**
 * Service Documentation
 * Service ID: conversations
 * Service Name: Conversations
 * Runtime: hkp-node
 * Modes: ingest | thread | transition | actionable
 *        put-artifact | list-artifacts | set-artifact-status
 * Key Config: mode, states, initialState, direction, state, stateFrom,
 *             conversationFrom, inState, idleSeconds, limit,
 *             kind, status, payloadFrom
 * IO: in=an email envelope (ingest) or a conversation id (everything else)
 *     ingest              -> { conversationId, state, isNew, email }, or
 *                            nothing at all when the message is already known
 *     thread              -> { conversationId, emails, count }
 *     transition          -> { conversationId, state, previous, updatedAt }
 *     actionable          -> { conversations, count } — pair with `iterator` to
 *                            act on them one at a time
 *     put-artifact        -> the artifact
 *     list-artifacts      -> { artifacts, count }
 *     set-artifact-status -> the artifact
 *
 * The domain half of the pair. `sql` knows SQL and nothing else; this knows
 * what a conversation is — that mail arrives in threads, that a thread is in
 * some state, and that work produced along the way has to be found again — and
 * owns the three tables that say so.
 *
 * It reaches the database through `database.ts` directly, not through the `sql`
 * service. Two services, one module: a service instance wrapping another
 * service instance would be a service with a host no runtime gave it and a uuid
 * nobody registered. The module is the shared part because the sharing happens
 * at the level of a call.
 *
 * **Threading is by header, and therefore deterministic.** A conversation's id
 * is the message id that began it: the id of any message already known from
 * this one's `References`/`In-Reply-To` chain, else the oldest entry in that
 * chain, else this message's own id. Two replies to a root nobody ever saw
 * still land together, because they name the same root. The cost of choosing
 * headers over a subject-and-participants heuristic is that a correspondent
 * whose client drops `References` starts a new conversation — wrong, but
 * wrong in the direction that leaves two threads to merge rather than two
 * customers' bookings in one thread.
 *
 * **Ingesting a message twice is not an event.** A mailbox poll re-delivers,
 * and the second delivery stops the pipeline exactly as a `store` miss does —
 * there is nothing to pass on. That is what makes the mail loop safe to run on
 * a timer without a board having to remember what it has seen.
 *
 * **States are declared by the board, not by this service.** A workflow's
 * states are the workflow's, and hard-coding them here would mean a code change
 * to add one. Declaring them buys something specific in return: whatever writes
 * a transition — a model deciding the next step, most of all — can be refused
 * when it invents a state, instead of stranding the conversation in a state no
 * poll will ever select again.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { Database, DatabaseStore, SqlValue } from "./database";
import { normalizeMessageId, normalizeReferences } from "./imap-email";

export const conversationsDescriptor: ServiceRegistryEntry = {
  serviceId: "conversations",
  serviceName: "Conversations",
  version: "v1",
  capabilities: [],
};

type Mode =
  | "ingest"
  | "thread"
  | "transition"
  | "actionable"
  | "put-artifact"
  | "list-artifacts"
  | "set-artifact-status";

const MODES: Mode[] = [
  "ingest",
  "thread",
  "transition",
  "actionable",
  "put-artifact",
  "list-artifacts",
  "set-artifact-status",
];

type Direction = "inbound" | "outbound";

const DEFAULT_STATE = "init";
const DEFAULT_ARTIFACT_STATUS = "pending";
const DEFAULT_LIMIT = 100;

/**
 * The tables, created on first use.
 *
 * `sender`/`recipient` rather than `from`/`to` because both of those are SQL
 * keywords, and a column that has to be quoted everywhere it appears is a
 * column that will one day not be. The board still sees `from` and `to`: the
 * envelope vocabulary is `imap-email`'s, and this is the only place the two
 * names differ.
 *
 * Every index here answers a query this service actually makes — `actionable`
 * selects on state and age, `thread` reads one conversation in order, the
 * facade lists artifacts by status. An index for anything else would be a
 * guess.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversation (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversation_by_state
    ON conversation (state, updatedAt);

  CREATE TABLE IF NOT EXISTS email (
    messageId TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL
      REFERENCES conversation (id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    sentAt TEXT NOT NULL,
    receivedAt TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '',
    recipient TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS email_by_conversation
    ON email (conversationId, sentAt, receivedAt);

  CREATE TABLE IF NOT EXISTS artifact (
    id TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL
      REFERENCES conversation (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS artifact_by_conversation
    ON artifact (conversationId, createdAt);
  CREATE INDEX IF NOT EXISTS artifact_by_status
    ON artifact (status, updatedAt);
`;

type Notify = (payload: unknown, instanceId?: string) => void;

/** The value at a dotted path, or undefined where the path does not lead. */
function valueAt(input: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  let current: unknown = input;
  for (const step of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as JsonRecord)[step];
  }
  return current;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * An address list as one string.
 *
 * A `to` header holds several addresses and arrives as an array as often as a
 * string; keeping the shape would make every reader handle both.
 */
function addresses(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean).join(", ");
  }
  return text(value);
}

/** A list of names, however the board chose to write it. */
function names(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

/** An ISO timestamp, whatever the header offered. */
function timestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return fallback;
}

/** Reads a JSON column, tolerating one that was never written by us. */
function parsed(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** A row as a board sees it: the envelope's names, and JSON columns opened. */
function describedEmail(row: JsonRecord): JsonRecord {
  return {
    messageId: row.messageId,
    conversationId: row.conversationId,
    direction: row.direction,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    from: row.sender,
    to: row.recipient,
    subject: row.subject,
    body: row.body,
  };
}

function describedConversation(row: JsonRecord): JsonRecord {
  return {
    conversationId: row.id,
    state: row.state,
    subject: row.subject,
    participants: parsed(row.participants, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function describedArtifact(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind,
    payload: parsed(row.payload, row.payload),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ConversationsService implements HostedService {
  readonly serviceId = conversationsDescriptor.serviceId;
  readonly serviceName = conversationsDescriptor.serviceName;
  readonly version = conversationsDescriptor.version;
  readonly capabilities = conversationsDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private mode: Mode = "ingest";
  /** The declared state machine. Empty accepts anything. */
  private states: string[] = [];
  private initialState = DEFAULT_STATE;
  private direction: Direction = "inbound";
  private state = "";
  private stateFrom = "state";
  private conversationFrom = "";
  private inState: string[] = [];
  private idleSeconds = 0;
  private limit = DEFAULT_LIMIT;
  private kind = "";
  private status = "";
  private payloadFrom = "";
  private lastCount = 0;
  private lastError = "";
  /** Boards whose tables this instance has already created. */
  private prepared = new Set<string>();

  constructor(
    config: ServiceConfiguration,
    private readonly databases: DatabaseStore,
  ) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  getState(): JsonRecord {
    return {
      mode: this.mode,
      states: [...this.states],
      initialState: this.initialState,
      direction: this.direction,
      state: this.state,
      stateFrom: this.stateFrom,
      conversationFrom: this.conversationFrom,
      inState: [...this.inState],
      idleSeconds: this.idleSeconds,
      limit: this.limit,
      kind: this.kind,
      status: this.status,
      payloadFrom: this.payloadFrom,
      lastCount: this.lastCount,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.mode === "string" && MODES.includes(config.mode as Mode)) {
      this.mode = config.mode as Mode;
    }
    if (config.states !== undefined) {
      this.states = names(config.states);
    }
    if (typeof config.initialState === "string" && config.initialState) {
      this.initialState = config.initialState;
    }
    if (config.direction === "inbound" || config.direction === "outbound") {
      this.direction = config.direction;
    }
    if (typeof config.state === "string") {
      this.state = config.state;
    }
    if (typeof config.stateFrom === "string") {
      this.stateFrom = config.stateFrom;
    }
    if (typeof config.conversationFrom === "string") {
      this.conversationFrom = config.conversationFrom;
    }
    if (config.inState !== undefined) {
      this.inState = names(config.inState);
    }
    if (typeof config.idleSeconds === "number" && config.idleSeconds >= 0) {
      this.idleSeconds = config.idleSeconds;
    }
    if (typeof config.limit === "number" && config.limit > 0) {
      this.limit = Math.floor(config.limit);
    }
    if (typeof config.kind === "string") {
      this.kind = config.kind;
    }
    if (typeof config.status === "string") {
      this.status = config.status;
    }
    if (typeof config.payloadFrom === "string") {
      this.payloadFrom = config.payloadFrom;
    }
    return this.getState();
  }

  /**
   * Runs the mode and returns what it produced.
   *
   * Synchronous like `sql` and unlike `store`: SQLite answers inside the call,
   * so there is nothing to wait for and no reason to stop the pipeline and
   * re-enter it. `actionable` is the exception, and for the opposite reason —
   * it has several things to say, not one.
   */
  process(input: unknown, notify: Notify): unknown {
    const scope = this.host?.scope();
    if (!scope) {
      return this.fail(notify, "conversations has no runtime to scope its database to");
    }

    let db: Database;
    try {
      db = this.databases.open(scope);
      const key = `${scope.owner} ${scope.boardName}`;
      if (!this.prepared.has(key)) {
        db.exec(SCHEMA);
        this.prepared.add(key);
      }
    } catch (err) {
      return this.fail(notify, `could not open the board's database: ${reason(err)}`);
    }

    try {
      return this.run(db, input, notify);
    } catch (err) {
      return this.fail(notify, `${this.mode} failed: ${reason(err)}`);
    }
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private run(db: Database, input: unknown, notify: Notify): unknown {
    switch (this.mode) {
      case "ingest":
        return this.ingest(db, input, notify);
      case "thread":
        return this.thread(db, input, notify);
      case "transition":
        return this.transition(db, input, notify);
      case "actionable":
        return this.actionable(db, notify);
      case "put-artifact":
        return this.putArtifact(db, input, notify);
      case "list-artifacts":
        return this.listArtifacts(db, input, notify);
      case "set-artifact-status":
        return this.setArtifactStatus(db, input, notify);
      default:
        return this.fail(notify, `unknown mode '${this.mode}'`);
    }
  }

  /**
   * Files a message under the conversation it belongs to.
   *
   * The conversation is created if this is the first message of a thread, and
   * left alone otherwise — its state belongs to whatever has been deciding it,
   * and an arriving reply is not a decision. What does change is `updatedAt`,
   * because a thread with a new message in it is a thread something may now
   * need to do, and that is what `actionable` sorts on.
   */
  private ingest(db: Database, input: unknown, notify: Notify): unknown {
    const envelope = asRecord(input);
    const messageId = normalizeMessageId(envelope.messageId);
    if (!messageId) {
      return this.fail(notify, "ingest needs a messageId to file the message under");
    }

    const now = new Date().toISOString();
    const conversationId = this.threadOf(db, messageId, envelope);
    const subject = text(envelope.subject);
    const sender = text(envelope.from);
    const recipient = addresses(envelope.to);
    const direction =
      envelope.direction === "inbound" || envelope.direction === "outbound"
        ? (envelope.direction as Direction)
        : this.direction;

    const existing = db.query("SELECT * FROM conversation WHERE id = $id", {
      $id: conversationId,
    })[0];
    const isNew = existing === undefined;

    if (isNew) {
      db.run(
        `INSERT INTO conversation (id, state, subject, participants, createdAt, updatedAt)
         VALUES ($id, $state, $subject, $participants, $now, $now)`,
        {
          $id: conversationId,
          $state: this.initialState,
          $subject: subject,
          $participants: JSON.stringify(
            [sender, recipient].filter(Boolean),
          ),
          $now: now,
        },
      );
    }

    const stored = db.run(
      `INSERT INTO email
         (messageId, conversationId, direction, sentAt, receivedAt,
          sender, recipient, subject, body)
       VALUES ($messageId, $conversationId, $direction, $sentAt, $receivedAt,
               $sender, $recipient, $subject, $body)
       ON CONFLICT (messageId) DO NOTHING`,
      {
        $messageId: messageId,
        $conversationId: conversationId,
        $direction: direction,
        $sentAt: timestamp(envelope.date ?? envelope.sentAt, now),
        $receivedAt: now,
        $sender: sender,
        $recipient: recipient,
        $subject: subject,
        $body: text(envelope.text ?? envelope.body),
      },
    );

    if (stored.changes === 0) {
      // Already filed. A poll re-delivering is the normal case, so this is not
      // a failure — it is simply nothing to pass on, and the pipeline stops
      // here rather than answering the same message twice.
      this.lastCount = 0;
      this.lastError = "";
      notify({ conversationId, messageId, stored: false });
      return null;
    }

    if (!isNew) {
      this.touch(db, conversationId, now, sender, recipient);
    }
    this.lastCount = 1;
    this.lastError = "";

    const conversation = describedConversation(
      db.query("SELECT * FROM conversation WHERE id = $id", {
        $id: conversationId,
      })[0],
    );
    const email = describedEmail(
      db.query("SELECT * FROM email WHERE messageId = $id", {
        $id: messageId,
      })[0],
    );
    const result = { ...conversation, isNew, email };
    notify(result);
    return result;
  }

  /**
   * The conversation a message belongs to.
   *
   * The chain is read newest-intent-first — the message it directly answers,
   * then the references from newest to oldest — so a reply joins the most
   * specific thread we already know about. Only when none of them is known does
   * the root of the chain name a conversation of its own.
   */
  private threadOf(
    db: Database,
    messageId: string,
    envelope: JsonRecord,
  ): string {
    const references = normalizeReferences(envelope.references);
    const inReplyTo = normalizeMessageId(envelope.inReplyTo);
    const chain = [inReplyTo, ...[...references].reverse(), messageId].filter(
      Boolean,
    );

    for (const id of chain) {
      const found = db.query(
        "SELECT conversationId FROM email WHERE messageId = $id",
        { $id: id },
      )[0];
      if (found) {
        return String(found.conversationId);
      }
    }

    // Nothing known: the thread is named by whatever began it, so two replies
    // to a root we never saw still meet.
    return references[0] || inReplyTo || messageId;
  }

  /** Marks a conversation as having moved, and widens who is known to be in it. */
  private touch(
    db: Database,
    conversationId: string,
    now: string,
    ...seen: string[]
  ): void {
    const row = db.query(
      "SELECT participants FROM conversation WHERE id = $id",
      { $id: conversationId },
    )[0];
    const known = parsed(row?.participants, []) as unknown[];
    const merged = [...new Set([...known.map(text), ...seen].filter(Boolean))];
    db.run(
      `UPDATE conversation SET updatedAt = $now, participants = $participants
       WHERE id = $id`,
      {
        $id: conversationId,
        $now: now,
        $participants: JSON.stringify(merged),
      },
    );
  }

  private thread(db: Database, input: unknown, notify: Notify): unknown {
    const conversationId = this.conversationId(input);
    if (!conversationId) {
      return this.fail(notify, "thread needs a conversation id");
    }
    const emails = db
      .query(
        `SELECT * FROM email WHERE conversationId = $id
         ORDER BY sentAt ASC, receivedAt ASC LIMIT $limit`,
        { $id: conversationId, $limit: this.limit },
      )
      .map(describedEmail);
    this.lastCount = emails.length;
    this.lastError = "";
    const result = { conversationId, emails, count: emails.length };
    notify(result);
    return result;
  }

  /**
   * Moves a conversation to another state.
   *
   * A state the board never declared is refused rather than written. Whatever
   * decides a transition is often a model, and a state nothing selects on is
   * indistinguishable from a conversation that has quietly stopped being
   * worked on — the failure would show up as silence, days later.
   */
  private transition(db: Database, input: unknown, notify: Notify): unknown {
    const conversationId = this.conversationId(input);
    if (!conversationId) {
      return this.fail(notify, "transition needs a conversation id");
    }

    const target =
      this.state || text(valueAt(input, this.stateFrom) ?? asRecord(input).state);
    if (!target) {
      return this.fail(notify, "transition needs a state to move to");
    }
    if (this.states.length > 0 && !this.states.includes(target)) {
      return this.fail(
        notify,
        `'${target}' is not one of this board's states (${this.states.join(", ")})`,
      );
    }

    const before = db.query("SELECT state FROM conversation WHERE id = $id", {
      $id: conversationId,
    })[0];
    if (!before) {
      return this.fail(notify, `no conversation '${conversationId}'`);
    }

    const now = new Date().toISOString();
    db.run(
      "UPDATE conversation SET state = $state, updatedAt = $now WHERE id = $id",
      { $id: conversationId, $state: target, $now: now },
    );
    this.lastCount = 1;
    this.lastError = "";
    const result = {
      conversationId,
      state: target,
      previous: before.state,
      updatedAt: now,
    };
    notify(result);
    return result;
  }

  /**
   * The conversations something should now be doing something about.
   *
   * Says what it found and nothing more. Acting on them one at a time is
   * iteration, which is `iterator`'s job — a service that looped over its own
   * results would be building that into whichever service needed it first, and
   * every other service producing a list would then need it too.
   *
   * `idleSeconds` is what stops a poll from picking the same conversation up
   * every tick while the last decision is still being carried out.
   */
  private actionable(db: Database, notify: Notify): unknown {
    if (this.inState.length === 0) {
      return this.fail(notify, "actionable needs inState to say which states to poll");
    }

    const placeholders = this.inState.map((_, index) => `$s${index}`);
    const params: Record<string, SqlValue> = { $limit: this.limit };
    this.inState.forEach((state, index) => {
      params[`$s${index}`] = state;
    });

    let where = `state IN (${placeholders.join(", ")})`;
    if (this.idleSeconds > 0) {
      where += " AND updatedAt <= $before";
      params.$before = new Date(
        Date.now() - this.idleSeconds * 1000,
      ).toISOString();
    }

    const rows = db.query(
      `SELECT * FROM conversation WHERE ${where}
       ORDER BY updatedAt ASC LIMIT $limit`,
      params,
    );
    this.lastCount = rows.length;
    this.lastError = "";

    const conversations = rows.map(describedConversation);
    const result = { conversations, count: conversations.length };
    notify(result);
    return result;
  }

  /**
   * Keeps something the workflow produced, against the conversation it is for.
   *
   * A draft reply, an extraction, a booking — the service does not care which,
   * because `kind` is the board's word and the payload is whatever it was. What
   * this owns is that the thing is findable later: by conversation, and by
   * whether anyone has dealt with it yet.
   */
  private putArtifact(db: Database, input: unknown, notify: Notify): unknown {
    const conversationId = this.conversationId(input);
    if (!conversationId) {
      return this.fail(notify, "put-artifact needs a conversation id");
    }
    if (!this.kind) {
      return this.fail(notify, "put-artifact needs a kind");
    }
    const known = db.query("SELECT 1 FROM conversation WHERE id = $id", {
      $id: conversationId,
    })[0];
    if (!known) {
      return this.fail(notify, `no conversation '${conversationId}'`);
    }

    const payload = this.payloadFrom ? valueAt(input, this.payloadFrom) : input;
    const now = new Date().toISOString();
    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    db.run(
      `INSERT INTO artifact
         (id, conversationId, kind, payload, status, createdAt, updatedAt)
       VALUES ($id, $conversationId, $kind, $payload, $status, $now, $now)`,
      {
        $id: id,
        $conversationId: conversationId,
        $kind: this.kind,
        $payload: JSON.stringify(payload ?? null),
        $status: this.status || DEFAULT_ARTIFACT_STATUS,
        $now: now,
      },
    );
    this.lastCount = 1;
    this.lastError = "";
    const result = describedArtifact(
      db.query("SELECT * FROM artifact WHERE id = $id", { $id: id })[0],
    );
    notify(result);
    return result;
  }

  /**
   * The artifacts, newest last, narrowed by whatever was configured.
   *
   * Returns a list rather than a pass each: this is what a facade table reads,
   * and a table wants the rows together.
   */
  private listArtifacts(db: Database, input: unknown, notify: Notify): unknown {
    const conversationId = this.conversationId(input);
    const clauses: string[] = [];
    const params: Record<string, SqlValue> = { $limit: this.limit };
    if (conversationId) {
      clauses.push("conversationId = $conversationId");
      params.$conversationId = conversationId;
    }
    if (this.kind) {
      clauses.push("kind = $kind");
      params.$kind = this.kind;
    }
    if (this.status) {
      clauses.push("status = $status");
      params.$status = this.status;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const artifacts = db
      .query(
        `SELECT * FROM artifact ${where} ORDER BY createdAt ASC LIMIT $limit`,
        params,
      )
      .map(describedArtifact);
    this.lastCount = artifacts.length;
    this.lastError = "";
    const result = { artifacts, count: artifacts.length };
    notify(result);
    return result;
  }

  /**
   * Records what was decided about one artifact.
   *
   * Unlike a conversation's state, the status is not checked against a declared
   * set. A transition is written by whatever is deciding — a model, most of all
   * — where an invented value goes unnoticed; a status is written by a person
   * pressing a button whose payload the board fixed, where an invented value is
   * a board bug that shows up the first time anyone presses it.
   */
  private setArtifactStatus(
    db: Database,
    input: unknown,
    notify: Notify,
  ): unknown {
    const record = asRecord(input);
    const id = text(record.id) || (typeof input === "string" ? input : "");
    if (!id) {
      return this.fail(notify, "set-artifact-status needs an artifact id");
    }
    const target = this.status || text(record.status);
    if (!target) {
      return this.fail(notify, "set-artifact-status needs a status");
    }

    const now = new Date().toISOString();
    const changed = db.run(
      "UPDATE artifact SET status = $status, updatedAt = $now WHERE id = $id",
      { $id: id, $status: target, $now: now },
    );
    if (changed.changes === 0) {
      return this.fail(notify, `no artifact '${id}'`);
    }
    this.lastCount = 1;
    this.lastError = "";
    const result = describedArtifact(
      db.query("SELECT * FROM artifact WHERE id = $id", { $id: id })[0],
    );
    notify(result);
    return result;
  }

  /**
   * The conversation this pass acts on.
   *
   * The input decides before the configuration does, the way `store` resolves a
   * key: a pass carrying a conversation is being specific about which one.
   */
  private conversationId(input: unknown): string {
    if (this.conversationFrom) {
      const found = valueAt(input, this.conversationFrom);
      if (typeof found === "string" && found) {
        return found;
      }
    }
    const record = asRecord(input);
    if (typeof record.conversationId === "string" && record.conversationId) {
      return record.conversationId;
    }
    if (typeof input === "string" && input) {
      return input;
    }
    return "";
  }

  /** Reports a failure and produces nothing, so the pipeline stops here. */
  private fail(notify: Notify, error: string): null {
    this.lastError = error;
    this.host?.log("error", "service.failed", { message: error });
    notify({ error });
    return null;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
