/**
 * Service Documentation
 * Service ID: queue
 * Service Name: Queue
 * Runtime: hkp-node
 * Modes: publish | consume | ack | fail | list
 * Key Config: mode, topic, payloadFrom, idFrom, limit, visibilitySeconds,
 *             maxAttempts, status
 * IO: in=whatever is being sent (publish) or a claimed message (ack/fail)
 *     publish -> the message as stored
 *     consume -> { messages, count } — claimed; pair with `iterator`
 *     ack     -> { id, status: "done" }
 *     fail    -> { id, status: "pending" | "dead", attempts }
 *     list    -> { messages, count } — reads without claiming
 * Arrays: a published array is one message, not many (pair with `iterator`)
 * Binary: not accepted
 *
 * How one board says something to another.
 *
 * A board owns its data, and a second board has no business reading the first
 * one's tables — the whole reason the two are separate boards. What crosses is
 * a *message*: a payload on a named topic, meaning nothing to the queue and
 * everything to the two boards that agreed on the name.
 *
 * **The store is the owner's, not the board's.** Every other table in this
 * runtime lives in a per-board file, which is what stops one board reading
 * another's. A queue is the deliberate exception and the only one: publishing
 * and consuming are by definition not the same board, so the rows live in the
 * owner-wide database (`DatabaseStore.openShared`). Isolation still holds
 * where it matters — between owners, and around everything that is not a
 * message.
 *
 * **Nobody dispatches.** There is no delivery loop and no router: a board
 * *pulls*, by putting a `consume` in a pipeline a `timer` drives, exactly as
 * it polls anything else. A queue that pushed would be a wire between boards,
 * and wires are the thing the ordered service list exists to avoid. What the
 * queue adds is not routing but *time* — the two sides run on different
 * clocks, and neither has to be up when the other speaks.
 *
 * **Both sides are on one runtime server.** The messages live with the runtime
 * that took them in, and a board reaching them is a board on that same server —
 * which is the same locality rule `conversations` and `sql` already have, not a
 * new one. Two units that talk sit on one server until a coordinator, which
 * already holds a credential for every runtime of a board, can make the claim
 * on a consumer's behalf.
 *
 * **At-least-once, and the board says when.** `consume` claims a message for
 * `visibilitySeconds` and hands it on; the pipeline does the work; an `ack`
 * placed where success is known closes it. Anything that stops in between —
 * a crash, a failed send, a runtime restarted mid-flight — leaves the claim to
 * expire and the message to be handed out again. That is the honest guarantee
 * for work driven by mail: the same enquiry twice is a nuisance, an enquiry
 * lost is a customer. A message handed out `maxAttempts` times without an ack
 * stops being retried and is marked `dead`, where it stays readable rather
 * than disappearing.
 *
 * **Publish before you commit.** The one thing a board has to get right: a
 * publish that fails passes nothing on and stops the pipeline, so the state
 * change saying the message was sent must come *after* it. Ordered that way, a
 * failed publish leaves the board where it was and the next tick sends it
 * again — the board's own timer is the retry, and the framework needs no
 * outbox to make it so.
 *
 * **Acked messages are kept.** A queue that deletes on ack answers "what is
 * pending" and nothing else; the question actually asked while debugging is
 * "what did the other board send me an hour ago, and what did I do with it".
 * `list` reads the whole log, claim state and attempt count included.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { Database, DatabaseStore } from "./database";
import * as queue from "./queue-store";

export const queueDescriptor: ServiceRegistryEntry = {
  serviceId: "queue",
  serviceName: "Queue",
  version: "v1",
  capabilities: [],
};

type Mode = "publish" | "consume" | "ack" | "fail" | "list";

const MODES: Mode[] = ["publish", "consume", "ack", "fail", "list"];

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

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class QueueService implements HostedService {
  readonly serviceId = queueDescriptor.serviceId;
  readonly serviceName = queueDescriptor.serviceName;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private mode: Mode = "publish";
  private topic = "";
  private payloadFrom = "";
  private idFrom = "id";
  private limit = queue.DEFAULT_LIMIT;
  private visibilitySeconds = queue.DEFAULT_VISIBILITY_SECONDS;
  private maxAttempts = queue.DEFAULT_MAX_ATTEMPTS;
  private status = "";

  private lastCount = 0;
  private lastError = "";
  /** Owners whose table this instance has already created. */
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
      topic: this.topic,
      payloadFrom: this.payloadFrom,
      idFrom: this.idFrom,
      limit: this.limit,
      visibilitySeconds: this.visibilitySeconds,
      maxAttempts: this.maxAttempts,
      status: this.status,
      lastCount: this.lastCount,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.mode === "string" && MODES.includes(config.mode as Mode)) {
      this.mode = config.mode as Mode;
    }
    if (typeof config.topic === "string") {
      this.topic = config.topic.trim();
    }
    if (typeof config.payloadFrom === "string") {
      this.payloadFrom = config.payloadFrom;
    }
    if (typeof config.idFrom === "string" && config.idFrom) {
      this.idFrom = config.idFrom;
    }
    if (typeof config.limit === "number" && config.limit > 0) {
      this.limit = Math.floor(config.limit);
    }
    if (typeof config.visibilitySeconds === "number" && config.visibilitySeconds > 0) {
      this.visibilitySeconds = Math.floor(config.visibilitySeconds);
    }
    if (typeof config.maxAttempts === "number" && config.maxAttempts > 0) {
      this.maxAttempts = Math.floor(config.maxAttempts);
    }
    if (typeof config.status === "string") {
      this.status = config.status.trim();
    }
    return this.getState();
  }

  /**
   * Runs the mode and returns what it produced.
   *
   * Synchronous, like `sql` and `conversations`: SQLite answers inside the
   * call, so there is nothing to wait for.
   */
  process(input: unknown, notify: Notify): unknown {
    const scope = this.host?.scope();
    if (!scope) {
      return this.fail(notify, "queue has no runtime to scope its database to");
    }

    try {
      return this.run(input, notify, scope.owner, scope.boardName);
    } catch (err) {
      return this.fail(notify, `${this.mode} failed: ${reason(err)}`);
    }
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private run(
    input: unknown,
    notify: Notify,
    owner: string,
    board: string,
  ): unknown {
    let db: Database;
    try {
      db = this.databases.openShared(owner);
      if (!this.prepared.has(owner)) {
        queue.prepare(db);
        this.prepared.add(owner);
      }
    } catch (err) {
      return this.fail(notify, `could not open the owner's database: ${reason(err)}`);
    }

    switch (this.mode) {
      case "publish": {
        if (!this.topic) {
          return this.fail(notify, "publish needs a topic");
        }
        const payload = this.payloadFrom
          ? valueAt(input, this.payloadFrom)
          : input;
        if (payload === undefined || payload === null) {
          // Nothing to say is not the same as saying nothing: a pipeline that
          // produced no payload has not produced a message either.
          return this.fail(
            notify,
            this.payloadFrom
              ? `nothing at '${this.payloadFrom}' to publish`
              : "publish was given nothing to send",
          );
        }
        return this.reported(
          notify,
          queue.publish(db, { topic: this.topic, payload, publishedBy: board }),
          1,
        );
      }

      case "consume": {
        if (!this.topic) {
          return this.fail(notify, "consume needs a topic");
        }
        const result = queue.consume(db, {
          topic: this.topic,
          limit: this.limit,
          visibilitySeconds: this.visibilitySeconds,
          maxAttempts: this.maxAttempts,
        });
        return this.reported(notify, result, result.count);
      }

      case "ack":
      case "fail": {
        const id = valueAt(input, this.idFrom);
        if (typeof id !== "string" || !id) {
          return this.fail(
            notify,
            `${this.mode} needs the message id at '${this.idFrom}'`,
          );
        }
        const result = queue.close(db, {
          id,
          outcome: this.mode === "ack" ? "done" : "pending",
          error: String(valueAt(input, "error") ?? ""),
          maxAttempts: this.maxAttempts,
        });
        if (!result) {
          return this.fail(notify, `no message '${id}'`);
        }
        return this.reported(notify, result, 1);
      }

      case "list": {
        const result = queue.list(db, {
          topic: this.topic,
          status: this.status,
          limit: this.limit,
        });
        return this.reported(notify, result, result.count);
      }

      default:
        return this.fail(notify, `unknown mode '${this.mode}'`);
    }
  }

  private reported(notify: Notify, result: unknown, count: number): unknown {
    this.lastError = "";
    this.lastCount = count;
    notify(result);
    return result;
  }

  private fail(notify: Notify, error: string): null {
    this.lastError = error;
    this.host?.log("error", "service.failed", { message: error });
    notify({ error });
    return null;
  }
}
