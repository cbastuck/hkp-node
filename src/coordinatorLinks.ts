import fs from "node:fs";
import path from "node:path";

import { WebSocket } from "ws";

import {
  CLOSE_REPLACED,
  CLOSE_TICKET_REVOKED,
  CoordinatorToParticipant,
  JOIN_PATH,
  ParticipantRequest,
  ParticipantToCoordinator,
  ProvisionPayload,
  ProvisionResult,
  ReportedService,
} from "./coordinator/participantProtocol";
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  frameBytes,
  fromBinaryPayload,
  toBinaryPayload,
} from "./coordinator/binaryFrame";
import { SecretEntry } from "./secrets";
import { ProcessContext } from "./types";

/**
 * This runtime server's connections to the coordinators its runtimes belong to.
 *
 * A coordinator never dials a runtime server. When a person deploys a board,
 * their client — the one party holding a session with both sides — asks the
 * coordinator for a ticket and tells this server: *connect to that coordinator,
 * with this ticket*. From then on the runtime the ticket speaks for is built,
 * configured and driven over the connection this server opened.
 *
 * Nothing needs to be able to reach this server for that to work, which is why
 * a laptop behind NAT and a loopback address are not special cases.
 *
 * The ticket is kept beside this server's other data and presented again after
 * a restart or a dropped connection, with nobody present. It is all that is
 * kept: the runtime itself is rebuilt by the coordinator, from the board's
 * config, once this server is connected again.
 */

/** What is remembered about one link, and everything a reconnect needs. */
export type LinkRecord = {
  /** The tenant this link acts as: whoever introduced it. */
  owner: string;
  boardName: string;
  runtimeId: string;
  coordinatorUrl: string;
  ticket: string;
};

export interface LinkStore {
  load(): LinkRecord[];
  save(records: LinkRecord[]): void;
}

export function createMemoryLinkStore(): LinkStore {
  let held: LinkRecord[] = [];
  return {
    load: () => [...held],
    save: (records) => {
      held = [...records];
    },
  };
}

function isLinkRecord(value: unknown): value is LinkRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.owner === "string" &&
    typeof record.boardName === "string" &&
    typeof record.runtimeId === "string" &&
    typeof record.coordinatorUrl === "string" &&
    typeof record.ticket === "string"
  );
}

/**
 * Links kept in one file, readable by its owner only: a ticket is a bearer
 * credential for one runtime of one board.
 */
export function createFileLinkStore(file: string): LinkStore {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed) ? parsed.filter(isLinkRecord) : [];
      } catch {
        // Not written yet, or unreadable: either way there is nothing to
        // reconnect with, and the next introduction writes it afresh.
        return [];
      }
    },
    save(records) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(records, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    },
  };
}

/** The runtime a link speaks for: one runtime of one board of one tenant. */
export type LinkedRuntime = {
  owner: string;
  boardName: string;
  runtimeId: string;
};

/**
 * What a link may do on this server — exactly the runtime it speaks for, as
 * the tenant that introduced it. Supplied by the server, which owns runtimes.
 *
 * The runtime is the board's: it shares its id with nothing a client created
 * here, nor with another board's runtime of the same id.
 */
export type LinkHost = {
  kind: string;
  registry(): unknown[];
  runtimeExists(runtime: LinkedRuntime): boolean;
  /** Builds the runtime, replacing the one this board had under its id. May throw. */
  provision(
    runtime: LinkedRuntime,
    payload: ProvisionPayload,
    secrets: Record<string, SecretEntry>,
  ): ProvisionResult;
  describe(runtime: LinkedRuntime): { services: ReportedService[] } | null;
  configureService(
    runtime: LinkedRuntime,
    serviceUuid: string,
    config: unknown,
    context: unknown,
  ): Promise<unknown>;
  /**
   * Begins the runtime's pipeline at one service, as the run `context` names.
   * Returns once the work is taken — throwing when it cannot be — and reports
   * what the pipeline produced through `done`, with the run it belongs to.
   */
  processService(
    runtime: LinkedRuntime,
    serviceUuid: string,
    params: unknown,
    context: unknown,
    done: (result: { data: unknown; context?: ProcessContext }) => void,
  ): void;
  setState(runtime: LinkedRuntime, state: Record<string, unknown>): unknown;
  remove(runtime: LinkedRuntime): void;
  /**
   * Runs the runtime's pipeline as the run `context` names. Answers with what
   * it produced and the run it produced it in, which the coordinator hands to
   * the next runtime.
   */
  process(
    runtime: LinkedRuntime,
    params: unknown,
    context: unknown,
  ): Promise<{ data: unknown; context?: ProcessContext }>;
};

export type CoordinatorLinksOptions = {
  /** First delay before reconnecting; doubles up to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** How long an introduction waits to be welcomed. */
  introduceTimeoutMs?: number;
  /**
   * How often the coordinator is asked whether it is still there. A network
   * that vanished closes nothing, and a link that went on waiting for it would
   * never reconnect.
   */
  heartbeatMs?: number;
};

/** The coordinator's `/join` endpoint for a coordinator's base address. */
export function joinUrlFor(coordinatorUrl: string): string {
  const url = new URL(coordinatorUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Not a coordinator address: ${coordinatorUrl}`);
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${JOIN_PATH}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

// A runtime id is unique within a board, and a board's name within a tenant.
// NUL occurs in none of the parts.
function linkKey(runtime: LinkedRuntime): string {
  return `${runtime.owner}\u0000${runtime.boardName}\u0000${runtime.runtimeId}`;
}

type FirstOutcome = { ok: true } | { ok: false; reason: string };

class Link {
  private socket: WebSocket | null = null;
  private welcomed = false;
  private disposed = false;
  private attempts = 0;
  private timer: NodeJS.Timeout | null = null;
  private reportFirst: ((outcome: FirstOutcome) => void) | null = null;
  /**
   * Values for the references this runtime's services carry, handed over by
   * the person's client when it introduced this link. Held in memory only:
   * after this server restarts the runtime is rebuilt without them, and says
   * which ones it is missing.
   */
  secrets: Record<string, SecretEntry> = {};

  constructor(
    readonly record: LinkRecord,
    private readonly host: LinkHost,
    private readonly options: Required<CoordinatorLinksOptions>,
    /** The coordinator no longer knows this ticket: the link is over. */
    private readonly onRejected: (link: Link) => void,
  ) {}

  get connected(): boolean {
    return this.welcomed && this.socket?.readyState === WebSocket.OPEN;
  }

  /** Connects, and reports how the first attempt went. Retries afterwards. */
  connect(): Promise<FirstOutcome> {
    return new Promise<FirstOutcome>((resolve) => {
      this.reportFirst = resolve;
      this.open();
    });
  }

  private settleFirst(outcome: FirstOutcome): void {
    this.reportFirst?.(outcome);
    this.reportFirst = null;
  }

  private open(): void {
    if (this.disposed) {
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(joinUrlFor(this.record.coordinatorUrl), {
        // A header rather than the URL, which is what ends up in logs.
        headers: { Authorization: `Bearer ${this.record.ticket}` },
        // No ceiling of the library's own: exceeding one closes the link,
        // and the board would lose its runtime over one large value.
        maxPayload: 0,
      });
    } catch (err) {
      this.settleFirst({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
      this.retry();
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    let rejected = false;

    // Dropped when it does not answer by the next asking, so that a connection
    // which is gone without having closed is reconnected rather than trusted.
    let answered = true;
    socket.on("pong", () => {
      answered = true;
    });
    const heartbeat = setInterval(() => {
      if (!answered) {
        socket.terminate();
        return;
      }
      answered = false;
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }, this.options.heartbeatMs);
    heartbeat.unref?.();

    socket.on("open", () => {
      this.send({
        type: "hello",
        server: this.host.kind,
        registry: this.host.registry(),
        runtimeExists: this.host.runtimeExists(this.record),
      });
    });

    // The coordinator refused the upgrade. 401 is its answer to a ticket it
    // does not hold — replaced, or belonging to a board that was deleted.
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403) {
        rejected = true;
        this.settleFirst({
          ok: false,
          reason: "the coordinator did not accept the ticket",
        });
        socket.terminate();
        this.reject();
        return;
      }
      this.settleFirst({
        ok: false,
        reason: `the coordinator answered ${response.statusCode}`,
      });
      socket.terminate();
    });

    socket.on("message", (raw, isBinary) => {
      if (socket !== this.socket) {
        return;
      }
      const bytes = frameBytes(raw);
      let message: CoordinatorToParticipant;
      if (isBinary) {
        // Input for the pipeline that holds bytes; see binaryFrame.ts.
        const frame = decodeBinaryFrame(bytes);
        if (!frame || frame.header.type !== "processRuntime") {
          return;
        }
        message = {
          type: "processRuntime",
          params: fromBinaryPayload(frame.payload),
          // Read where it is used; see LinkHost.process.
          context: frame.header.context as ProcessContext | undefined,
        };
      } else {
        try {
          message = JSON.parse(bytes.toString("utf8"));
        } catch {
          return;
        }
      }
      void this.onMessage(message);
    });

    socket.on("error", (err) => {
      this.settleFirst({ ok: false, reason: err.message });
    });

    socket.on("close", (code) => {
      clearInterval(heartbeat);
      if (socket !== this.socket || rejected) {
        return;
      }
      this.socket = null;
      this.welcomed = false;
      this.settleFirst({ ok: false, reason: `connection closed (${code})` });
      // Revoked, or another runtime server took this runtime's place in the
      // board. Either way this server's copy is no longer the board's, and
      // reconnecting would only fight whoever holds the place now.
      if (code === CLOSE_TICKET_REVOKED || code === CLOSE_REPLACED) {
        this.reject();
        return;
      }
      this.retry();
    });
  }

  private retry(): void {
    if (this.disposed || this.timer) {
      return;
    }
    const delay = Math.min(
      this.options.maxReconnectDelayMs,
      this.options.reconnectDelayMs * 2 ** this.attempts,
    );
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
    this.timer.unref?.();
  }

  private reject(): void {
    if (this.disposed) {
      return;
    }
    this.dispose();
    this.onRejected(this);
  }

  /** Stops for good, without telling anyone. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    socket?.close();
  }

  send(message: ParticipantToCoordinator): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    // A result holding bytes goes as a binary frame; as text it would arrive
    // as an object of numbered keys. The header is the message without its
    // value, so the run it belongs to travels in it either way.
    const binary =
      message.type === "result" ? toBinaryPayload(message.data) : null;
    this.socket.send(
      binary && message.type === "result"
        ? encodeBinaryFrame({ type: "result", context: message.context }, binary)
        : JSON.stringify(message),
    );
  }

  /** The runtime said something; only a welcomed link has anyone to tell. */
  emit(message: ParticipantToCoordinator): void {
    if (this.welcomed) {
      this.send(message);
    }
  }

  private async onMessage(message: CoordinatorToParticipant): Promise<void> {
    const { runtimeId } = this.record;

    if (message.type === "welcome") {
      this.welcomed = true;
      this.attempts = 0;
      this.settleFirst({ ok: true });
      return;
    }

    if (message.type === "processRuntime") {
      if (message.params === undefined) {
        return;
      }
      try {
        const { data, context } = await this.host.process(
          this.record,
          message.params,
          message.context,
        );
        this.send({ type: "result", data, context });
      } catch (err) {
        console.error(
          `[coordinator-link] Runtime "${runtimeId}" failed to process:`,
          err instanceof Error ? err.message : err,
        );
      }
      return;
    }

    if (message.type === "request") {
      const { requestId } = message;
      try {
        const data = await this.serve(message);
        this.send({ type: "response", requestId, ok: true, data });
      } catch (err) {
        this.send({
          type: "response",
          requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async serve(request: ParticipantRequest): Promise<unknown> {
    const runtime = this.record;
    switch (request.op) {
      case "provision": {
        const { op: _op, ...payload } = request;
        return this.host.provision(
          runtime,
          // The board this link was introduced for, whatever the request says:
          // a ticket speaks for one board.
          { ...payload, boardName: runtime.boardName },
          this.secrets,
        );
      }
      case "describe": {
        const described = this.host.describe(runtime);
        if (!described) {
          throw new Error("the runtime is not running");
        }
        return described;
      }
      case "configureService":
        return this.host.configureService(
          runtime,
          request.serviceUuid,
          request.config,
          request.context,
        );
      case "processService":
        this.host.processService(
          runtime,
          request.serviceUuid,
          request.params,
          request.context,
          // What the pipeline made of it goes to the coordinator the way any
          // of this runtime's output does, to be carried to the next runtime.
          ({ data, context }) => this.emit({ type: "result", data, context }),
        );
        return { accepted: true };
      case "setState":
        return this.host.setState(runtime, request.state ?? {});
      case "remove":
        this.host.remove(runtime);
        return {};
      default:
        throw new Error(
          `Unknown operation "${(request as { op?: string }).op}"`,
        );
    }
  }
}

export class CoordinatorLinks {
  private readonly links = new Map<string, Link>();
  private readonly options: Required<CoordinatorLinksOptions>;

  constructor(
    private readonly host: LinkHost,
    private readonly store: LinkStore = createMemoryLinkStore(),
    options: CoordinatorLinksOptions = {},
  ) {
    this.options = {
      reconnectDelayMs: options.reconnectDelayMs ?? 1_000,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 30_000,
      introduceTimeoutMs: options.introduceTimeoutMs ?? 10_000,
      heartbeatMs: options.heartbeatMs ?? 30_000,
    };
  }

  /**
   * Connects this server to a coordinator as one runtime of one board.
   *
   * Resolves once the coordinator has accepted the ticket, and rejects — and
   * keeps nothing — when it has not: an introduction is made by somebody
   * waiting to hear whether it worked, so this is the one connection attempt
   * that is not retried.
   *
   * A runtime that is already connected to that coordinator stays as it is:
   * the link it has is kept, the ticket handed over goes unused, and only the
   * secrets are taken. Being introduced is the first step of a deploy that
   * may yet fail, and must not change what is running. One connected to a
   * *different* coordinator is refused — a board's runtime here belongs to
   * one coordinator at a time, and the other is named.
   */
  async introduce(
    record: LinkRecord,
    secrets: Record<string, SecretEntry> = {},
  ): Promise<void> {
    // Validated before anything is replaced: a malformed address must not cost
    // a runtime the link it already has.
    const joinUrl = joinUrlFor(record.coordinatorUrl);

    const key = linkKey(record);
    const existing = this.links.get(key);
    if (existing?.connected) {
      if (joinUrlFor(existing.record.coordinatorUrl) !== joinUrl) {
        throw new Error(
          `"${record.boardName}" is already deployed here by ${existing.record.coordinatorUrl}`,
        );
      }
      existing.secrets = secrets;
      return;
    }
    existing?.dispose();

    const link = this.createLink(record);
    link.secrets = secrets;
    this.links.set(key, link);

    const outcome = await Promise.race([
      link.connect(),
      new Promise<FirstOutcome>((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, reason: "the coordinator did not answer" }),
          this.options.introduceTimeoutMs,
        );
        timer.unref?.();
      }),
    ]);

    if (!outcome.ok) {
      link.dispose();
      if (this.links.get(key) === link) {
        this.links.delete(key);
      }
      this.persist();
      throw new Error(outcome.reason);
    }
    this.persist();
  }

  /** Reconnects with the tickets kept from before this process started. */
  restore(): void {
    for (const record of this.store.load()) {
      const key = linkKey(record);
      if (this.links.has(key)) {
        continue;
      }
      const link = this.createLink(record);
      this.links.set(key, link);
      void link.connect();
    }
  }

  /**
   * A tenant's links, without their tickets. `running` is whether the runtime
   * the link is for has been built: a board's runtimes are not among those a
   * client lists, so this is where they are seen.
   */
  list(owner: string): Array<{
    boardName: string;
    runtimeId: string;
    coordinatorUrl: string;
    connected: boolean;
    running: boolean;
  }> {
    return [...this.links.values()]
      .filter((link) => link.record.owner === owner)
      .map((link) => ({
        boardName: link.record.boardName,
        runtimeId: link.record.runtimeId,
        coordinatorUrl: link.record.coordinatorUrl,
        connected: link.connected,
        running: this.host.runtimeExists(link.record),
      }));
  }

  /** Leaves a board: drops the link and the runtime it was for. */
  remove(runtime: LinkedRuntime): boolean {
    const key = linkKey(runtime);
    const link = this.links.get(key);
    if (!link) {
      return false;
    }
    link.dispose();
    this.links.delete(key);
    this.host.remove(link.record);
    this.persist();
    return true;
  }

  /** Carries a runtime's output to its coordinator, when it has one. */
  emit(runtime: LinkedRuntime, message: ParticipantToCoordinator): void {
    this.links.get(linkKey(runtime))?.emit(message);
  }

  /** Merges values into what a link's runtime is built with. */
  setSecrets(
    runtime: LinkedRuntime,
    secrets: Record<string, SecretEntry>,
  ): void {
    const link = this.links.get(linkKey(runtime));
    if (link) {
      link.secrets = { ...link.secrets, ...secrets };
    }
  }

  /** Closes every connection and keeps every ticket. */
  stop(): void {
    for (const link of this.links.values()) {
      link.dispose();
    }
    this.links.clear();
  }

  private createLink(record: LinkRecord): Link {
    return new Link(record, this.host, this.options, (rejected) => {
      // The coordinator no longer holds this ticket, so the runtime it was
      // for is nobody's: it was built to outlive its clients, and the only
      // party that would have released it has just said it is not theirs.
      const key = linkKey(record);
      if (this.links.get(key) !== rejected) {
        return;
      }
      this.links.delete(key);
      this.host.remove(record);
      this.persist();
    });
  }

  private persist(): void {
    try {
      this.store.save([...this.links.values()].map((link) => link.record));
    } catch (err) {
      console.warn(
        "[coordinator-link] Could not persist coordinator links, so they will " +
          "not be re-established after a restart:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
