/**
 * The messages a coordinator and a participating runtime server exchange.
 *
 * A coordinator never dials a runtime server. Each one *connects in*, holding a
 * ticket that speaks for one runtime of one board of one person, and everything
 * the coordinator needs of that runtime travels over the connection that came
 * in: building it, configuring its services, driving it, and hearing what it
 * says. That is the whole of what a ticket can do — the operations below name a
 * runtime nowhere, because the connection already is one.
 *
 * The same idea as the browser's bridge (`bridgeProtocol.ts`), for the other
 * kind of participant: one socket, the board's traffic multiplexed over it, and
 * the coordinator accepting rather than reaching out.
 */

import { AssetDescriptor } from "../assets";
import { Caller, LogEntry, ProcessContext } from "../types";

/** Where a runtime server connects in; relative to the coordinator's base. */
export const JOIN_PATH = "/join";

/**
 * Close codes a participant reads to decide whether to come back.
 *
 * Only the first two are final. Anything else — a network drop, a coordinator
 * restarting — is something a participant reconnects through.
 */
export const CLOSE_TICKET_REVOKED = 4403;
export const CLOSE_REPLACED = 4409;

/** What a runtime server says about itself and its runtime when it connects. */
export type ParticipantHello = {
  type: "hello";
  /** "node", "python", "c++" — as the runtime server names itself. */
  server?: string;
  /** What that server can run; a property of its build. */
  registry: unknown[];
  /** Whether the runtime this ticket speaks for is running there right now. */
  runtimeExists: boolean;
};

/** What a runtime is built from; the board's own description of it. */
export type ProvisionPayload = {
  name: string;
  boardName: string;
  state: Record<string, unknown>;
  services: Array<{
    uuid: string;
    serviceId: string;
    serviceName: string;
    state: Record<string, unknown>;
  }>;
  /**
   * The descriptors of the assets this runtime is given, by id. Absent means
   * none, as it does from a browser provisioning the board.
   */
  assets?: Record<string, AssetDescriptor>;
};

/** A service as the runtime reports it. */
export type ReportedService = { uuid?: string; state?: Record<string, unknown> };

export type ProvisionResult = {
  registry?: unknown[];
  services?: ReportedService[];
  /**
   * Secret aliases the runtime's services reference and its runtime server
   * holds no value for. Named so the board can say what is missing and where,
   * rather than fail hours later as an authentication error that names nothing.
   */
  missingSecrets?: string[];
};

export type ParticipantRequest =
  /** Build the runtime, replacing anything under its id. */
  | ({ op: "provision" } & ProvisionPayload)
  /** Report the runtime's services and their state. */
  | { op: "describe" }
  | { op: "configureService"; serviceUuid: string; config: unknown }
  /**
   * Begin at one service: run the pipeline from it onward with `params`, as
   * the run `context` names. Answered once the work is taken; what it
   * produces follows as a `result`, carrying the same context.
   */
  | {
      op: "processService";
      serviceUuid: string;
      params: unknown;
      context?: ProcessContext;
    }
  /** Change what the running runtime records; see PATCH /runtimes/:id/state. */
  | { op: "setState"; state: Record<string, unknown> }
  /** Tear the runtime down. Removing one that is not there is a success. */
  | { op: "remove" };

export type ParticipantOp = ParticipantRequest["op"];

export type CoordinatorToParticipant =
  /** The ticket was accepted; this connection now is that runtime. */
  | { type: "welcome"; boardName: string; runtimeId: string }
  | ({ type: "request"; requestId: string } & ParticipantRequest)
  /** Run the runtime's pipeline; it answers with a `result`. */
  | { type: "processRuntime"; params: unknown; context?: ProcessContext };

/**
 * `result.data` and `processRuntime.params` are JSON when the message is a
 * text frame. A value holding bytes travels as a binary frame instead, and is
 * a `BinaryPayload` here; see `binaryFrame.ts`.
 */
export type ParticipantToCoordinator =
  | ParticipantHello
  | { type: "response"; requestId: string; ok: true; data?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  /**
   * What the runtime's pipeline produced, with the run it was produced in.
   * The coordinator hands that context to the next runtime, which is what
   * carries a run — and who began it — across a board's runtimes.
   */
  | { type: "result"; data: unknown; context?: ProcessContext }
  /**
   * `caller` is whoever began the run the notification was raised in, absent
   * when it was raised outside one. It decides who is told.
   */
  | {
      type: "notification";
      serviceUuid: string;
      payload: unknown;
      caller?: Caller;
    }
  | { type: "log"; entry: LogEntry };

/** What a participant says unprompted: its runtime's output. */
export type ParticipantEvent = Extract<
  ParticipantToCoordinator,
  { type: "result" | "notification" | "log" }
>;

/**
 * One connected runtime of one board, as a session sees it.
 *
 * An interface rather than the socket itself so that what owns a board does not
 * depend on how its participants are reached.
 */
export interface Participant {
  readonly runtimeId: string;
  readonly hello: ParticipantHello;
  request<T = unknown>(request: ParticipantRequest): Promise<T>;
  /** Runs the runtime's pipeline, as the run `context` names when given. */
  process(params: unknown, context?: ProcessContext): void;
  /** Where the runtime's output goes; one listener, replaced by the next. */
  listen(listener: ((event: ParticipantEvent) => void) | null): void;
}

/** The participants of one board, and word of their coming and going. */
export interface BoardParticipants {
  get(runtimeId: string): Participant | undefined;
  subscribe(listener: {
    onJoin: (participant: Participant) => void;
    onLeave: (runtimeId: string) => void;
  }): () => void;
}

/** A board with nobody connected and nobody arriving. */
export const NO_PARTICIPANTS: BoardParticipants = {
  get: () => undefined,
  subscribe: () => () => {},
};
