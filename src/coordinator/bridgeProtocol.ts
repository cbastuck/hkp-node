/**
 * The messages a coordinator and an attached browser exchange.
 *
 * A cloud board is owned by its coordinator: it provisions the remote runtimes
 * and holds their state. A browser that opens the board *attaches* — it renders
 * what the coordinator tells it and asks the coordinator to act on its behalf,
 * rather than dialling those runtimes itself. That way a board's runtimes may
 * live somewhere the browser cannot reach, which is the point of having a
 * coordinator at all.
 *
 * Direction is part of each name below. The browser owns its own runtimes, so
 * what the coordinator knows about *those* is cache, and what the browser knows
 * about remote runtimes is cache — see TODO-CLOUD-COORDINATOR.md.
 */

import { LogEntry } from "../types";

/** State a service last reported, keyed by service uuid. */
export type ServiceStates = Record<string, unknown>;

/** What the browser needs to render a remote runtime it does not own. */
export type RuntimeSnapshot = {
  runtimeId: string;
  /** Service ids, versions and capabilities, as that runtime advertises them.
   *  Panel selection resolves by id *and* version, so a snapshot without this
   *  renders the wrong UIs. */
  registry: unknown[];
  /** Each service's live state, including addresses assigned at provision time
   *  (`__hkpMount`) which no saved board can carry. */
  services: ServiceStates;
};

export type BridgeMessage =
  // ── Coordinator → browser ────────────────────────────────────────────────
  /**
   * Everything the browser needs to render the board, sent when it attaches and
   * again whenever it asks for a fresh one. Carries `seq` so a browser can tell
   * that it missed an increment and ask again rather than drift.
   */
  | {
      type: "snapshot";
      seq: number;
      boardName: string;
      status: string;
      /**
       * The board as authored. Also fetchable over REST — the board list reads
       * it there for boards nobody has attached to — but sent here so that an
       * attached browser gets structure and live state as one consistent thing,
       * at one `seq`, rather than two fetches that can disagree.
       */
      config: unknown;
      runtimes: RuntimeSnapshot[];
    }
  /**
   * A service said something — the same notifications a runtime sends its own
   * clients, forwarded to browsers that reach this runtime through us.
   *
   * Kept apart from `serviceState` because the two are different things: a
   * Monitor's output is not part of its state (its `getState` deliberately
   * omits it), so a browser that only saw state changes would render nothing.
   */
  | {
      type: "notification";
      runtimeId: string;
      serviceUuid: string;
      payload: unknown;
    }
  /**
   * A log entry from one of the board's runtimes, forwarded for live display.
   *
   * Kept apart from `notification` for the reason the log exists at all: a
   * notification is for whoever is watching and may be dropped when nobody is,
   * while an entry is written whether or not anyone is attached. What arrives
   * here is a copy of what was already stored, not the storage path.
   */
  | { type: "log"; entry: LogEntry }
  /** One service reported new state. `seq` continues the snapshot's sequence. */
  | {
      type: "serviceState";
      seq: number;
      runtimeId: string;
      serviceUuid: string;
      state: unknown;
    }
  /** Run a browser runtime's pipeline; the browser answers `result`. */
  | { type: "processRuntime"; runtimeId?: string; params: unknown; requestId?: string }
  /** The answer to a `configureService` / `processService` request. */
  | { type: "response"; requestId: string; data?: unknown; error?: string }

  // ── Browser → coordinator ────────────────────────────────────────────────
  /** Attach: which browser runtimes this client owns, so the coordinator knows
   *  who to ask when the chain reaches one. */
  | { type: "connect"; userId?: string; boardName?: string; runtimeIds: string[] }
  /** Send me a fresh snapshot — used after a reconnect or a detected gap. */
  | { type: "resync" }
  /**
   * Act on a remote service on the browser's behalf.
   *
   * Configuring is the only thing a browser asks for so far. Running a runtime
   * is browser-initiated too — the ▶ control, a board's play action, a browser
   * service calling another runtime by name — but whether that should proxy a
   * runtime call or be a board-level action the coordinator owns is undecided,
   * so it is not in the protocol until something calls it. Driving the chain
   * from one runtime to the next is never it: that is the coordinator's own
   * job (see routeResult).
   */
  | {
      type: "configureService";
      requestId: string;
      runtimeId: string;
      serviceUuid: string;
      config: unknown;
    }
  /** A result the browser produced for a `processRuntime` it was asked to run. */
  | { type: "result"; requestId: string; data?: unknown }
  /** A browser runtime finished its own pipeline; drive the next runtime. */
  | { type: "result-from-browser"; runtimeId: string; data?: unknown }
  /**
   * An entry a runtime this browser hosts recorded.
   *
   * The same shape travels the other way for entries from remote runtimes; the
   * direction is what differs. A browser runtime holds no socket of its own to
   * the coordinator, so this bridge is the only route its entries have into the
   * board's log.
   */
  | { type: "log"; entry: LogEntry };

/** Narrow a parsed bridge message without trusting its shape. */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
