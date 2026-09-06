/**
 * Service Documentation
 * Service ID: imap-email
 * Service Name: IMAP Email
 * Runtime: hkp-node
 * Modes: listen (source — uses IMAP IDLE to push new emails downstream in real-time)
 * Key Config: host, port, username, password, tls, mailbox
 * IO: in=any (pass-through) -> out=EmailEnvelope pushed on new mail, shaped
 *     { messageId, subject, from, to, date, uid, references, inReplyTo, text }
 */

import { ImapFlow, MailboxObject } from "imapflow";
import { simpleParser } from "mailparser";
import { referencedSecrets, resolveCredential } from "../secrets";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const imapEmailDescriptor: ServiceRegistryEntry = {
  serviceId: "imap-email",
  serviceName: "IMAP Email",
};

/** Backoff bounds for re-establishing a connection that went away. */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * How long a single IDLE runs before it is renewed. Servers drop IDLE sessions
 * after ~30 minutes, and a connection that died without a FIN — a suspended
 * machine, a NAT that forgot the mapping — is only noticed when something is
 * written, so renewing periodically is what turns a silently dead socket into
 * an error we can act on.
 */
const MAX_IDLE_MS = 5 * 60_000;

type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

type ImapEmailState = {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  mailbox: string;
  /** What the user asked for — survives a dropped connection and a reload. */
  enabled: boolean;
  /** Whether a connection is actually up right now. */
  running: boolean;
  status: ConnectionStatus;
  reconnectAttempts: number;
  error: string;
};

/**
 * A message id without its angle brackets.
 *
 * Headers carry `<id@host>`; the brackets are the header syntax rather than
 * part of the identity, and leaving them on means the same message compares
 * unequal depending on which header it was read from.
 */
export function normalizeMessageId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** The References chain, oldest first. A single reference may arrive unwrapped. */
export function normalizeReferences(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];
  return raw.map(normalizeMessageId).filter((id) => id.length > 0);
}

export class ImapEmailService implements HostedService {
  readonly serviceId = imapEmailDescriptor.serviceId;
  readonly serviceName = imapEmailDescriptor.serviceName;
  readonly uuid: string;

  private state: ImapEmailState = {
    host: "",
    port: 993,
    username: "",
    password: "",
    tls: true,
    mailbox: "INBOX",
    enabled: false,
    running: false,
    status: "disconnected",
    reconnectAttempts: 0,
    error: "",
  };

  private client: ImapFlow | null = null;
  private runtimeHost: RuntimeHost | null = null;
  private lastSeenUid = 0;
  /**
   * Which mailbox `lastSeenUid` counts in: path plus the server's UIDVALIDITY.
   * Where it still matches, a fresh connection resumes from the last delivered
   * message instead of skipping whatever arrived while it was gone.
   */
  private mailboxKey = "";
  /**
   * Bumped whenever the current client is abandoned. Events and loops carry the
   * generation they were started under, so a socket that dies while its
   * replacement is already connecting cannot report over the live one.
   */
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.runtimeHost = host;
    // A board that was saved (or deployed) while listening starts listening
    // again on its own — nobody may be attached to press Connect.
    if (this.state.enabled && !this.client && !this.reconnectTimer) {
      void this._openConnection();
    }
  }

  getState(): JsonRecord {
    // Nothing to hide: `password` holds the reference it was configured with,
    // never a value, so what a board saves is what it already said.
    return { ...this.state };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.host === "string") {
      this.state.host = config.host;
    }
    if (typeof config.port === "number") {
      this.state.port = config.port;
    }
    if (typeof config.username === "string") {
      this.state.username = config.username;
    }
    // A `{{secret.<alias>}}` reference, kept as written and resolved when the
    // connection is opened. Empty is a real value here — it clears the field —
    // because nothing masks this any more, so nothing round-trips as blank.
    if (typeof config.password === "string") {
      this.state.password = config.password;
    }
    if (typeof config.tls === "boolean") {
      this.state.tls = config.tls;
    }
    if (typeof config.mailbox === "string") {
      this.state.mailbox = config.mailbox;
    }

    // `connect` is a two-way switch; `disconnect` and `enabled` are the same
    // switch under the names a board and a restored state use for it.
    const start =
      config.connect === true ||
      config.disconnect === false ||
      (config.enabled === true && config.connect !== false) ||
      // Boards written before `enabled` existed persisted `running`.
      (config.running === true && config.enabled === undefined);
    const stop =
      config.connect === false ||
      config.disconnect === true ||
      config.enabled === false;

    if (start) {
      this._start();
    } else if (stop) {
      this._stop();
    }

    return this.getState();
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    // Pass-through — this service is a source that pushes emails via host.processFrom().
    return input;
  }

  destroy(): void {
    this._stop();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Take up the connection, and keep taking it up until told otherwise. */
  private _start(): void {
    this.state.enabled = true;
    this.state.reconnectAttempts = 0;
    this._clearReconnectTimer();
    void this._openConnection();
  }

  /** Put the connection down and leave it down. */
  private _stop(): void {
    this.state.enabled = false;
    this._clearReconnectTimer();
    this._abandonClient();
    this.state.running = false;
    this.state.status = "disconnected";
    this.state.reconnectAttempts = 0;
    this._notifyState();
  }

  private async _openConnection(): Promise<void> {
    if (!this.state.enabled) {
      return;
    }

    this._abandonClient();

    if (
      !this.state.host ||
      !this.state.username ||
      !this.state.password.trim()
    ) {
      this.state.enabled = false;
      this.state.running = false;
      this.state.status = "disconnected";
      this.state.error = "host, username and password are required";
      this._notifyState();
      return;
    }

    const generation = ++this.generation;
    this.state.running = false;
    this.state.status =
      this.state.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    this._notifyState();

    // A service is constructed and configured before it is given a host, so a
    // board that was listening starts its first connection with no vault to
    // ask. Wait rather than fail: `enabled` stays set, and `setHost` opens the
    // connection as soon as there is something to resolve against.
    if (!this.runtimeHost && referencedSecrets(this.state.password).length) {
      this.state.running = false;
      this.state.status = "connecting";
      this._notifyState();
      return;
    }

    // The password exists from here to the end of this connection attempt and
    // nowhere else. It is resolved against the host being dialled, so a
    // credential the vault binds to one server cannot be sent to another by
    // reconfiguring this service.
    const { value: password, problem } = resolveCredential(
      this.runtimeHost?.secrets?.(),
      this.state.password,
      `${this.state.host}:${this.state.port}`,
    );
    if (problem) {
      this.state.enabled = false;
      this.state.running = false;
      this.state.status = "disconnected";
      this.state.error = problem;
      this._notifyState();
      return;
    }

    const client = new ImapFlow({
      host: this.state.host,
      port: this.state.port,
      secure: this.state.tls,
      auth: {
        user: this.state.username,
        pass: password,
      },
      // Own the IDLE cycle: the loop below has to know when IDLE ends to fetch
      // what arrived, which it cannot if the client also idles on its own.
      disableAutoIdle: true,
      maxIdleTime: MAX_IDLE_MS,
    });

    // ImapFlow is an EventEmitter: without a listener here, a socket error —
    // ECONNRESET when a laptop lid closes — is an unhandled 'error' event and
    // takes the whole runtime process down with it.
    client.on("error", (err: unknown) =>
      this._onConnectionLost(generation, err),
    );
    client.on("close", () => this._onConnectionLost(generation, null));

    this.client = client;

    try {
      await client.connect();
      await this._seedLastSeenUid(client);

      if (generation !== this.generation) {
        // Superseded while connecting — this client is no longer the one.
        return;
      }

      this.state.running = true;
      this.state.status = "connected";
      this.state.reconnectAttempts = 0;
      this.state.error = "";
      this._notifyState();

      void this._idleLoop(client, generation);
    } catch (err) {
      this._onConnectionLost(generation, err);
    }
  }

  /**
   * Decide where to resume from. On the first connection to a mailbox that
   * means the current end — old mail is not news. On a later one it means
   * wherever the last connection got to, so a message that arrived while the
   * connection was down is still delivered.
   */
  private async _seedLastSeenUid(client: ImapFlow): Promise<void> {
    const status = await client.status(this.state.mailbox, {
      uidNext: true,
      uidValidity: true,
    });
    const key = `${this.state.mailbox}:${status.uidValidity ?? ""}`;
    if (key !== this.mailboxKey) {
      this.lastSeenUid = Number(status.uidNext ?? 1) - 1;
      this.mailboxKey = key;
    }
  }

  /**
   * The current connection is gone — from a socket error, a close, or a failed
   * connect. Called more than once for the same connection (an error is
   * normally followed by a close), so everything here is idempotent.
   */
  private _onConnectionLost(generation: number, err: unknown): void {
    if (generation !== this.generation) {
      return; // A client we already walked away from.
    }
    this.generation++;

    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.close();
      } catch {
        // already gone
      }
    }

    this.state.running = false;
    if (err) {
      this.state.error = this._message(err);
    }

    if (!this.state.enabled) {
      this.state.status = "disconnected";
      this._notifyState();
      return;
    }

    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    this._clearReconnectTimer();

    const attempt = ++this.state.reconnectAttempts;
    // Exponential up to a minute, with jitter so several listeners coming back
    // from the same outage do not retry in lockstep.
    const base = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** (attempt - 1),
    );
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));

    this.state.status = "reconnecting";
    this._notify({ ...this.getState(), retryInMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._openConnection();
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") {
      this.reconnectTimer.unref();
    }
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Drop the current client without touching the desired state. */
  private _abandonClient(): void {
    const client = this.client;
    if (!client) {
      return;
    }
    this.generation++;
    this.client = null;
    // Best-effort LOGOUT so the server releases the session; a connection that
    // has already gone rejects, and then closing the socket is all that is left.
    void Promise.resolve()
      .then(() => client.logout())
      .catch(() => {
        try {
          client.close();
        } catch {
          // already gone
        }
      });
  }

  private async _idleLoop(client: ImapFlow, generation: number): Promise<void> {
    try {
      // Open the mailbox so it is selected before IDLE starts.
      const initLock = await client.getMailboxLock(this.state.mailbox);
      initLock.release();

      // Anything that arrived while there was no connection is news now.
      await this._fetchUnderLock(client, generation);

      while (this._isCurrent(client, generation) && client.usable) {
        // fetchPromise is set by the 'exists' handler so we can await it after
        // idle() resolves (idle() resolves as a side-effect of getMailboxLock()
        // sending DONE, which happens inside _fetchUnderLock()).
        let fetchPromise: Promise<void> | null = null;

        const onExists = () => {
          fetchPromise = this._fetchUnderLock(client, generation);
        };

        client.once("exists", onExists);

        try {
          // idle() blocks until the server terminates the IDLE session.
          // Calling getMailboxLock() from onExists sends DONE, which causes
          // the server to end IDLE and idle() to resolve here.
          await client.idle();
        } finally {
          client.off("exists", onExists);
        }

        // Wait for the fetch triggered by EXISTS (or do a catch-up fetch on the
        // maxIdleTime renewal when no EXISTS was received).
        if (fetchPromise) {
          await fetchPromise;
        } else if (this._isCurrent(client, generation)) {
          await this._fetchUnderLock(client, generation);
        }
      }
    } catch (err) {
      // The loop only ends by error when the connection is unusable; hand it to
      // the same path a socket error takes so it reconnects rather than stops.
      this._onConnectionLost(generation, err);
    }
  }

  private async _fetchUnderLock(
    client: ImapFlow,
    generation: number,
  ): Promise<void> {
    if (!this._isCurrent(client, generation)) {
      return;
    }
    try {
      const lock = await client.getMailboxLock(this.state.mailbox);
      try {
        await this._fetchNew(client);
      } finally {
        lock.release();
      }
    } catch (err) {
      if (this._isCurrent(client, generation)) {
        this.state.error = this._message(err);
        this._notifyState();
      }
    }
  }

  private async _fetchNew(client: ImapFlow): Promise<void> {
    const mailbox = client.mailbox as MailboxObject | null;
    if (!mailbox?.exists) {
      return;
    }

    for await (const msg of client.fetch(
      { uid: `${this.lastSeenUid + 1}:*` },
      { envelope: true, uid: true, source: true },
    )) {
      if (msg.uid <= this.lastSeenUid) continue;
      this.lastSeenUid = msg.uid;

      let text = "";
      // Which conversation a message belongs to is stated by the sending
      // client, in these two headers, and is far steadier than anything that
      // can be recovered from a subject line — clients rewrite those, and the
      // reply prefix differs by language ("RE:", "AW:", "SV:", "Antw:").
      let references: string[] = [];
      let inReplyTo = "";
      if (msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
          text = parsed.text ?? parsed.textAsHtml ?? "";
          references = normalizeReferences(parsed.references);
          inReplyTo = normalizeMessageId(parsed.inReplyTo);
        } catch {
          // ignore parse errors — email still forwarded without body
        }
      }

      const email: JsonRecord = {
        messageId: normalizeMessageId(msg.envelope?.messageId),
        subject: msg.envelope?.subject ?? "",
        from:
          msg.envelope?.from?.map((a) => a.address ?? a.name).join(", ") ?? "",
        to: msg.envelope?.to?.map((a) => a.address ?? a.name).join(", ") ?? "",
        date: msg.envelope?.date?.toISOString() ?? "",
        uid: msg.uid,
        // Oldest first, so `references[0]` is the message that began the
        // thread — the identity every reply in it shares.
        references,
        inReplyTo,
        text,
      };

      await this._push(email);
    }
  }

  /** Is this client still the one we are running on? */
  private _isCurrent(client: ImapFlow, generation: number): boolean {
    return (
      this.state.enabled &&
      generation === this.generation &&
      this.client === client
    );
  }

  private async _push(data: unknown): Promise<void> {
    if (!this.runtimeHost) return;
    // Whatever the rest of the board does with an email, failing at it is not a
    // reason to lose the connection that delivered it.
    try {
      const result = await this.runtimeHost.processFrom(
        this.uuid,
        data,
        (n: RuntimeNotification) =>
          this._notify(n.payload as JsonRecord, n.instanceId),
      );
      if (result instanceof Promise) {
        result
          .then((value) => this.runtimeHost?.emitResult(value))
          .catch((err) => this._reportPushFailure(err));
        return;
      }
      this.runtimeHost.emitResult(result);
    } catch (err) {
      this._reportPushFailure(err);
    }
  }

  private _reportPushFailure(err: unknown): void {
    this.state.error = this._message(err);
    this._notifyState();
  }

  private _notifyState(): void {
    this._notify(this.getState());
  }

  private _notify(payload: JsonRecord, instanceId: string = this.uuid): void {
    this.runtimeHost?.notify(payload, instanceId);
  }

  private _message(err: unknown): string {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      return code ? `${err.message} (${code})` : err.message;
    }
    return String(err);
  }
}
