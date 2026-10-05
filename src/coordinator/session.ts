import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  CloudBoardConfig,
  CloudRuntimeDescriptor,
  BoardSessionStatus,
  isRemoteRuntime,
  isBrowserRuntime,
} from "./types";
import { LogStore } from "./logStore";
import {
  BinaryPayload,
  decodeBinaryFrame,
  encodeBinaryFrame,
  frameBytes,
} from "./binaryFrame";
import { Caller, LogEntry, LogLevel, ProcessContext } from "../types";
import { MOUNT_FIELD, collectMountRefs, formatMountRef } from "./mount";
import {
  BridgeMessage,
  RuntimeSnapshot,
  ServiceStates,
  isBridgeMessage,
} from "./bridgeProtocol";
import {
  BoardParticipants,
  NO_PARTICIPANTS,
  Participant,
  ParticipantEvent,
  ProvisionResult,
  ReportedService,
} from "./participantProtocol";
import { AssetDescriptor } from "../assets";
import {
  FacadeAccess,
  projectConfig,
  projectState,
  readFacadeAccess,
  runtimeHolding,
} from "./facadeAccess";
import { DEFAULT_MEMBER_LIMITS, MemberLimits } from "./members";

/**
 * What a browser attached to a board is to it.
 *
 * The **owner** deployed the board: their bridge is sent the board whole, may
 * configure its services, and hosts its browser runtimes. A **member** is
 * somebody the board is shared with: their bridge is sent the facade and what
 * the facade reads, and may ask for exactly what the facade asks for.
 */
export type BridgeRole = "owner" | "member";

/** Who attached, as whoever admitted them established it. */
export type BridgeAttach = {
  role: BridgeRole;
  /** Absent where there is no identity to state — a coordinator without auth. */
  caller?: Caller;
};

type BrowserBridge = BridgeAttach & {
  ws: WebSocket;
  runtimeIds: Set<string>;
  // Each browser is told the board in its own sequence: what a member is sent
  // is a subset of what the owner is, and a shared count would read to them as
  // increments going missing.
  seq: number;
};

/** Closing a member's bridge because the board is no longer shared with them.
 *  Final: a client that reconnected would only be refused. */
export const CLOSE_NOT_A_MEMBER = 4403;

/** Machinery a runtime reports about its own flow, carrying the data passing
 *  through. A facade ignores it, so a member is not sent it. */
function isFlowNotification(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    "__internal" in (payload as Record<string, unknown>)
  );
}

/**
 * One board, owned by this coordinator.
 *
 * The session dials nothing. Every runtime the board has is run by a
 * *participant* that connected in — a runtime server holding a ticket for that
 * runtime, or a browser attached over the bridge — and the session builds,
 * configures and drives the board over those connections.
 *
 * Participants are of two kinds, told apart by the runtime's type:
 *
 * - **Required** — a remote runtime. The board cannot run without it, so one
 *   that is not connected puts the board in `error`, naming it. That is not
 *   terminal: when its runtime server connects, the runtime is built from the
 *   board's config and the board goes back to `running`.
 * - **Transient** — a browser runtime, run by whichever browser has the board
 *   open. Browsers come and go as a matter of course, so data arriving for one
 *   that is away stops there, the way a `null` stops a pipeline, and the board
 *   stays `running`.
 */
export class BoardSession {
  readonly createdAt: string;
  // Set while the board is not being run: stopped by its owner, or restored
  // from a store that says it was.
  private stopped = false;
  // Why each runtime is not as the board wants it, by runtime id.
  private readonly runtimeErrors = new Map<string, string>();
  // What stopping could not release. Kept apart from the above because it
  // describes the run that ended, not the one being attempted.
  private residue: string[] = [];
  // The runtimes that produced `residue`, by id. A stopped board only removes
  // one that reconnects when it knows that runtime is a leftover from its own
  // run. An editor may legitimately recreate the same runtime id after Stop;
  // treating every runtime seen while stopped as residue would delete the
  // editor's live work during the next deploy introduction.
  private readonly pendingRelease = new Set<string>();
  // Runtimes this session has built or picked back up, whose participant is
  // connected right now.
  private readonly live = new Set<string>();
  // Runtimes this session built at some point. One whose participant dropped
  // and came back with the runtime still running is picked up, not rebuilt.
  private readonly built = new Set<string>();
  // Every browser currently viewing this board has its own bridge. Multiple
  // clients (e.g. Readymade + a browser tab) can watch the same board at once;
  // runtime output is fanned out to all of them.
  private readonly bridges = new Set<BrowserBridge>();
  private readonly pendingBrowserResults = new Map<
    string,
    (data: unknown) => void
  >();
  // Addresses services published for the mounts they own, keyed
  // "runtimeId/serviceUuid". This session coordinates the board, so it is what
  // turns a reference into the address it names — no runtime can see far enough
  // to do it for itself.
  private readonly mountAddresses = new Map<string, string>();
  // The address last handed to each consumer, keyed the same way. Guards
  // against re-configuring a service with what it already has, while still
  // letting a *changed* address through.
  private readonly pushedStates = new Map<string, string>();
  // What each remote runtime's services last reported, and what that runtime
  // says it can run. This is the board as the coordinator knows it, and what an
  // attached browser renders from — it owns none of it itself.
  private readonly serviceStates = new Map<string, ServiceStates>();
  private readonly registries = new Map<string, unknown[]>();
  // What the board's facade lets a member do and see. The config is fixed for
  // the life of a session — deploying again makes a new one — so it is read
  // once.
  private readonly access: FacadeAccess;
  // When each member last asked for something to be processed, by email, for
  // the rate that bounds them.
  private readonly memberProcessTimes = new Map<string, number[]>();
  // Building, releasing and picking up runtimes happen one at a time: a
  // participant arriving while the board is starting must not be built twice.
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;

  constructor(
    readonly boardName: string,
    readonly userId: string,
    readonly config: CloudBoardConfig,
    // The runtime servers connected for this board, and word of their coming
    // and going. Supplied by the coordinator, which holds the tickets.
    private readonly participants: BoardParticipants = NO_PARTICIPANTS,
    // Set when the board comes back from a store rather than from a deploy. It
    // keeps the date the board was first registered, and whether it was left
    // stopped. See docs/content/concepts/cloud-boards.md.
    restored?: { createdAt: string; stopped: boolean },
    // Where this board's entries are kept. Absent means nothing is collected —
    // a session in a test, or a coordinator configured without a log root.
    private readonly logStore?: LogStore,
    // The largest frame a browser may send that is passed on; unset means no
    // limit. The same setting bounds what a runtime server sends, where the
    // participants are accepted.
    private readonly limits: { maxFrameBytes?: number } & MemberLimits = {},
  ) {
    this.createdAt = restored?.createdAt ?? new Date().toISOString();
    this.stopped = restored?.stopped ?? false;
    this.access = readFacadeAccess(config.facade);
  }

  /** The runtimes this board cannot run without, in chain order. */
  private required(): CloudRuntimeDescriptor[] {
    return this.config.runtimes.filter(isRemoteRuntime);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs the board: builds every required runtime whose participant is
   * connected, and from then on builds the others as they arrive.
   *
   * A participant that is not connected is not waited for. The board says
   * which one is missing and comes up when it does.
   */
  async start(): Promise<void> {
    await this.serial(async () => {
      this.stopped = false;
      this.residue = [];
      this.pendingRelease.clear();
      this.unsubscribe ??= this.participants.subscribe({
        onJoin: (participant) => this.onJoin(participant),
        onLeave: (runtimeId) => this.onLeave(runtimeId),
      });

      for (const runtime of this.required()) {
        const participant = this.participants.get(runtime.id);
        if (participant) {
          await this.bringUp(runtime, participant);
        }
      }

      // Runtimes are built one by one, so a service pointed at a mount on a
      // runtime built later cannot have been resolved as it was created. Hand
      // out the addresses once the whole board exists.
      await this.publishMountAddresses();
    });
    this.broadcastSnapshot();
  }

  /** Whether the board was left stopped, for a store to remember. */
  isStopped(): boolean {
    return this.stopped;
  }

  getStatus(): BoardSessionStatus {
    if (this.stopped) {
      return "stopped";
    }
    return this.getErrors().length > 0 ? "error" : "running";
  }

  getErrors(): string[] {
    if (this.stopped) {
      return [...this.residue];
    }
    const errors: string[] = [];
    for (const runtime of this.required()) {
      const reason = this.runtimeErrors.get(runtime.id);
      if (reason) {
        errors.push(`Runtime "${runtime.id}": ${reason}`);
      } else if (!this.live.has(runtime.id)) {
        errors.push(
          `Runtime "${runtime.id}" is not connected — its runtime server has to connect to this coordinator`,
        );
      }
    }
    return errors;
  }

  /**
   * Builds a runtime on the participant that connected for it, or picks it
   * back up when that participant only dropped its connection and still has
   * the runtime this session built.
   */
  private async bringUp(
    runtime: CloudRuntimeDescriptor,
    participant: Participant,
  ): Promise<void> {
    const { id } = runtime;
    try {
      let services: ReportedService[] | undefined;
      if (this.built.has(id) && participant.hello.runtimeExists) {
        // Its state is live and the board's is not: rebuilding would throw
        // away what the runtime has been doing.
        services = (
          await participant.request<{ services?: ReportedService[] }>({
            op: "describe",
          })
        )?.services;
        this.registries.set(id, participant.hello.registry);
        // Whatever stopped it from being picked up last time no longer does.
        // What it was built without is still missing, and still said.
        if (!this.runtimeErrors.get(id)?.startsWith("needs configuration")) {
          this.runtimeErrors.delete(id);
        }
      } else {
        const result = await participant.request<ProvisionResult>({
          op: "provision",
          name: runtime.name,
          boardName: this.boardName,
          // The board's own settings for this runtime — `logData`, and
          // whatever a runtime reads from its state later.
          state: runtime.state ?? {},
          services: (this.config.services[id] ?? []).map((svc) => ({
            uuid: svc.uuid,
            serviceId: svc.serviceId,
            serviceName: svc.serviceName ?? svc.name ?? svc.serviceId,
            state: svc.state ?? {},
          })),
          // Every asset this runtime is given, named by a service or not.
          // Host-local content cannot travel this way — a `file://` source is
          // read by the runtime, inside its own volumes.
          assets: this.assetsFor(runtime),
        });
        this.registries.set(
          id,
          Array.isArray(result?.registry)
            ? result.registry
            : participant.hello.registry,
        );
        services =
          result?.services ??
          (
            await participant.request<{ services?: ReportedService[] }>({
              op: "describe",
            })
          )?.services;
        // A newly built runtime has been told nothing yet, so whatever was
        // handed to the one before it has to be handed over again.
        for (const svc of this.config.services[id] ?? []) {
          this.pushedStates.delete(
            formatMountRef({ runtimeId: id, serviceUuid: svc.uuid }),
          );
        }
        this.built.add(id);
        if (result?.missingSecrets?.length) {
          // Built, and unable to do its job: say what is missing and where,
          // rather than leave it to surface as a failed login hours later.
          this.runtimeErrors.set(
            id,
            `needs configuration — its runtime server holds no value for ${result.missingSecrets.join(", ")}`,
          );
        } else {
          this.runtimeErrors.delete(id);
        }
      }

      this.recordServices(id, services ?? []);
      participant.listen((event) => this.onParticipantEvent(id, event));
      this.live.add(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.live.delete(id);
      this.runtimeErrors.set(id, reason);
      console.error(
        `[coordinator] Failed to provision runtime "${id}" for board "${this.boardName}":`,
        reason,
      );
    }
  }

  /** A required participant connected, now or again. */
  private onJoin(participant: Participant): void {
    const runtime = this.required().find((rt) => rt.id === participant.runtimeId);
    void this.serial(async () => {
      if (this.destroyed) {
        return;
      }
      if (!runtime) {
        // The board no longer contains this runtime. Its ticket is revoked by
        // the coordinator immediately after the old session is destroyed, but
        // a connection already arriving is still made harmless here.
        if (participant.hello.runtimeExists) {
          await participant.request({ op: "remove" }).catch(() => undefined);
        }
        return;
      }
      if (this.stopped) {
        // Only a runtime this session failed to release is ours to remove. A
        // stopped board is also the normal state while a browser edits it, and
        // that browser may have recreated the same runtime id on this server.
        if (
          participant.hello.runtimeExists &&
          this.pendingRelease.has(participant.runtimeId)
        ) {
          try {
            await participant.request({ op: "remove" });
            this.pendingRelease.delete(participant.runtimeId);
            this.residue = this.residue.filter(
              (line) => !line.startsWith(`Runtime "${participant.runtimeId}"`),
            );
          } catch {
            // Still residue; the status continues to say so.
          }
        }
        return;
      }
      await this.bringUp(runtime, participant);
      await this.publishMountAddresses();
    })
      .catch((err) => {
        console.error(
          `[coordinator] Failed to take runtime "${participant.runtimeId}" back into board "${this.boardName}":`,
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => this.broadcastSnapshot());
  }

  /** A required participant's connection went away. */
  private onLeave(runtimeId: string): void {
    if (!this.live.delete(runtimeId)) {
      return;
    }
    console.log(
      `[coordinator] Runtime "${runtimeId}" of board "${this.boardName}" disconnected`,
    );
    this.broadcastSnapshot();
  }

  private onParticipantEvent(runtimeId: string, event: ParticipantEvent): void {
    // An entry from one of this board's runtimes. It is written before it is
    // forwarded: a browser may or may not be attached, and the log is for the
    // case where none is.
    if (event.type === "log") {
      if (event.entry) {
        this.logStore?.append(this.userId, this.boardName, event.entry);
        // The board's log is its owner's: an entry names services, runs and
        // callers a member has no business seeing.
        this.toOwners({ type: "log", entry: event.entry });
      }
      return;
    }

    // A service publishes the address of a mount it owns through a
    // notification — when it is unbypassed at runtime, say, long after the
    // board loaded. Whoever is waiting on that address learns of it here.
    if (event.type === "notification") {
      if (event.serviceUuid) {
        this.onRuntimeNotification(
          runtimeId,
          event.serviceUuid,
          event.payload,
          event.caller,
        );
      }
      return;
    }

    if (event.data === null || event.data === undefined) {
      return;
    }
    this.routeResult(runtimeId, event.data, event.context).catch((err) => {
      console.error(
        `[coordinator] Failed to route result from runtime "${runtimeId}":`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  /** Takes in what a runtime's services report: their state, and any mounts. */
  private recordServices(runtimeId: string, services: ReportedService[]): void {
    const states: ServiceStates = {};
    for (const svc of services) {
      if (!svc?.uuid) {
        continue;
      }
      states[svc.uuid] = svc.state;
      const published = svc.state?.[MOUNT_FIELD];
      if (typeof published === "string" && published) {
        this.recordMountAddress(runtimeId, svc.uuid, published);
      }
    }
    this.serviceStates.set(runtimeId, states);
  }

  /**
   * Hands the board's runtimes back without giving up the board.
   *
   * This is what editing does: the browser takes the runtimes over and
   * provisions them itself, so the coordinator must not still hold them — but
   * the board keeps its place in the coordinator's list and keeps its config,
   * because a board being edited must not be a board that can be lost.
   * Attached browsers stay attached and are told the board is now empty.
   */
  async stop(): Promise<void> {
    await this.serial(async () => {
      const unreleased = await this.teardownRuntimes();
      this.live.clear();
      this.built.clear();
      this.runtimeErrors.clear();
      this.mountAddresses.clear();
      this.pushedStates.clear();
      this.serviceStates.clear();
      this.registries.clear();
      // Whatever went wrong starting the board is history now; what is worth
      // carrying is what would not let go.
      this.residue = unreleased;
      this.stopped = true;
    });
    this.broadcastSnapshot();
  }

  /**
   * Turn this board's logging on or off, on the runtimes already running.
   *
   * Applied live rather than by re-provisioning: the setting is one a board
   * revisits — on to look into something, off again afterwards — and rebuilding
   * every runtime to carry a boolean would restart the board to change its mind.
   *
   * The config is updated too, so the setting survives a restart and so a
   * runtime provisioned later comes up with it already on. Returns the runtimes
   * it could not reach; they keep whatever they had, which is why the caller is
   * told rather than left to assume it took.
   */
  async setLogging(enabled: boolean, level: LogLevel = "info"): Promise<string[]> {
    for (const runtime of this.config.runtimes) {
      // Only what this switch is for. `logData` is not touched: what a board
      // records about its own flow and what it is willing to write of the data
      // passing through are different decisions, and a control that quietly
      // did both would turn a verbosity setting into an exposure one.
      runtime.state = {
        ...(runtime.state ?? {}),
        logging: enabled,
        logLevel: level,
      };
    }

    const unreachable: string[] = [];
    await Promise.all(
      this.required().map(async ({ id }) => {
        if (!this.built.has(id)) {
          return;
        }
        const participant = this.live.has(id)
          ? this.participants.get(id)
          : undefined;
        if (!participant) {
          unreachable.push(id);
          return;
        }
        try {
          await participant.request({
            op: "setState",
            state: { logging: enabled, logLevel: level },
          });
        } catch {
          unreachable.push(id);
        }
      }),
    );
    return unreachable;
  }

  /**
   * Releases the runtimes this session built, and reports the ones it could
   * not.
   *
   * Releasing is best-effort by design: a runtime server that is away must not
   * make a board impossible to stop. But a runtime that was not released is
   * very likely still running — built to persist, holding its mount. Saying so
   * is the difference between an orphan someone can go and deal with and one
   * nobody ever hears about. It is released when its server next connects.
   */
  private async teardownRuntimes(): Promise<string[]> {
    const unreleased: string[] = [];
    await Promise.all(
      [...this.built].map(async (id) => {
        const participant = this.participants.get(id);
        if (!participant) {
          this.pendingRelease.add(id);
          unreleased.push(
            `Runtime "${id}" could not be released because its runtime server is not connected; it may still be running, and is released when that server reconnects.`,
          );
          return;
        }
        try {
          await participant.request({ op: "remove" });
          participant.listen(null);
          this.pendingRelease.delete(id);
        } catch (err) {
          this.pendingRelease.add(id);
          const reason = err instanceof Error ? err.message : String(err);
          console.error(
            `[coordinator] Failed to release runtime "${id}":`,
            reason,
          );
          unreleased.push(
            `Runtime "${id}" could not be released (${reason}); it may still be running.`,
          );
        }
      }),
    );
    return unreleased;
  }

  /**
   * Ends this session: releases its runtimes and lets go of its browsers.
   *
   * The participants' connections are not this session's to close. They belong
   * to the tickets, so a session replacing this one finds them still there.
   */
  async destroy(): Promise<void> {
    await this.serial(async () => {
      this.destroyed = true;
      this.unsubscribe?.();
      this.unsubscribe = null;
      // What it reported while it ran is left as it was: a session that has
      // been replaced still answers for the run it was.
      await this.teardownRuntimes();
    });

    // Bridges are either transferred to the new session or closed here.
    for (const bridge of this.bridges) {
      console.log(
        `[bridge-close] Server initiating close: destroy() closing bridge for board "${this.boardName}"`,
      );
      bridge.ws.close();
    }
    this.bridges.clear();
  }

  /**
   * Detach all browser bridges from this session and return them so the caller
   * can hand them to the replacement session without the browsers seeing a
   * disconnect. Each comes with who it is, which the replacement checks again.
   */
  takeBridges(): Array<{ ws: WebSocket; runtimeIds: string[] } & BridgeAttach> {
    const taken = [...this.bridges].map((bridge) => {
      // Detach handlers so the old session no longer processes bridge messages.
      bridge.ws.removeAllListeners("message");
      bridge.ws.removeAllListeners("close");
      return {
        ws: bridge.ws,
        runtimeIds: [...bridge.runtimeIds],
        role: bridge.role,
        ...(bridge.caller ? { caller: bridge.caller } : {}),
      };
    });
    this.bridges.clear();
    return taken;
  }

  /** How many bridges somebody holds on this board, by the email they attached as. */
  countMemberBridges(email: string): number {
    let count = 0;
    for (const bridge of this.bridges) {
      if (bridge.role === "member" && bridge.caller?.email === email) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Closes the bridges of somebody the board is no longer shared with. At
   * once: being taken off the list is not something that waits for a
   * reconnect.
   */
  evictMember(email: string): void {
    for (const bridge of [...this.bridges]) {
      if (bridge.role === "member" && bridge.caller?.email === email) {
        bridge.ws.close(CLOSE_NOT_A_MEMBER, "no longer shared");
      }
    }
    this.memberProcessTimes.delete(email);
  }

  /**
   * What the board's list now calls an email, for the bridges attached as it.
   * The name rides with every run they begin, so a rename has to reach
   * somebody who is already attached.
   */
  renameMember(email: string, name: string | undefined): void {
    for (const bridge of this.bridges) {
      if (bridge.caller?.email !== email) {
        continue;
      }
      const { name: _previous, ...rest } = bridge.caller;
      bridge.caller = name ? { ...rest, name } : rest;
      this.send(bridge.ws, this.snapshotFor(bridge));
    }
  }

  /**
   * Takes a browser that whoever is calling has already admitted, as what it
   * was admitted as. Deciding that is not this session's job: it holds no
   * list, and is told.
   */
  registerBrowserSocket(
    ws: WebSocket,
    runtimeIds: string[],
    attach: BridgeAttach = { role: "owner" },
  ): void {
    // A member's bridge never hosts a runtime, whatever it says it has: the
    // chain would wait on an answer that is not theirs to give.
    const hosted = attach.role === "owner" ? runtimeIds : [];

    // The same socket re-registering (e.g. its browser runtimes changed) — just
    // refresh its runtimeIds rather than adding a duplicate or re-attaching
    // listeners.
    for (const existing of this.bridges) {
      if (existing.ws === ws) {
        existing.runtimeIds = new Set(hosted);
        return;
      }
    }

    const bridge: BrowserBridge = {
      ws,
      runtimeIds: new Set(hosted),
      role: attach.role,
      ...(attach.caller ? { caller: attach.caller } : {}),
      seq: 0,
    };
    this.bridges.add(bridge);

    ws.on("message", (raw, isBinary) => {
      const bytes = frameBytes(raw);
      const limit = this.limits.maxFrameBytes;
      if (limit && bytes.length > limit) {
        this.logStore?.append(this.userId, this.boardName, {
          runId: "",
          ts: new Date().toISOString(),
          runtimeId: [...bridge.runtimeIds][0] ?? "",
          serviceUuid: "",
          level: "warn",
          event: "frame-dropped",
          data: { bytes: bytes.length, limit },
        });
        return;
      }

      let message: BridgeMessage;
      try {
        // A browser runtime's output that holds bytes. The header is the
        // message it would have sent as text; the payload goes on as it came.
        const frame = isBinary ? decodeBinaryFrame(bytes) : null;
        if (isBinary && !frame) {
          return;
        }
        const parsed: unknown = frame
          ? { ...frame.header, data: frame.payload }
          : JSON.parse(bytes.toString("utf8"));
        if (!isBridgeMessage(parsed)) {
          return;
        }
        message = parsed;
      } catch (err) {
        console.error(
          `[coordinator] Failed to parse bridge message for board "${this.boardName}":`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      // A browser that reconnected, or noticed a gap in the sequence, asking to
      // be told the board again rather than carrying on from a stale view.
      if (message.type === "resync") {
        this.send(ws, this.snapshotFor(bridge));
        return;
      }

      if (message.type === "processService") {
        void this.serveProcessRequest(bridge, message);
        return;
      }

      // Everything below is the owner's. A member's bridge may ask to be told
      // the board again and ask the facade's services to do their job, and
      // that is the whole of what it may send: it configures nothing, records
      // nothing, and answers for no runtime.
      if (bridge.role !== "owner") {
        if (message.type === "configureService") {
          this.send(ws, {
            type: "response",
            requestId: message.requestId,
            error: "Only the board's owner may configure it",
          });
        }
        return;
      }

      if (message.type === "configureService") {
        void this.serveBrowserRequest(ws, message);
        return;
      }

      // An entry from a runtime this browser hosts. The board's log spans every
      // runtime it uses, and a browser runtime has no other route into it —
      // it does not hold a socket of its own to this coordinator.
      //
      // Not forwarded on to the other bridges, unlike an entry arriving from a
      // remote runtime: the browser that sent it already has it, and a second
      // browser watching the same board is not hosting the runtime that
      // produced it.
      if (message.type === "log" && message.entry) {
        this.logStore?.append(
          this.userId,
          this.boardName,
          message.entry as LogEntry,
        );
        return;
      }

      if (message.type === "result" && message.requestId) {
        const resolve = this.pendingBrowserResults.get(message.requestId);
        if (resolve) {
          this.pendingBrowserResults.delete(message.requestId);
          resolve(message.data);
        }
        return;
      }

      if (message.type === "result-from-browser" && message.runtimeId) {
        // A run begun in this browser, by whoever attached with it.
        this.routeResult(
          message.runtimeId,
          message.data,
          this.beginRun(bridge),
        ).catch((err) => {
          console.error(
            `[coordinator] Failed to route result from browser runtime "${message.runtimeId}":`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    });

    ws.on("close", () => {
      this.bridges.delete(bridge);
      // Only abandon in-flight browser results once nobody remains who could
      // answer them; another of the owner's bridges may still reply.
      if (this.hostingBridges().length === 0) {
        for (const [requestId, resolve] of this.pendingBrowserResults) {
          this.pendingBrowserResults.delete(requestId);
          resolve(null);
        }
      }
    });

    // Attaching is a read: the browser renders what the board currently is,
    // rather than provisioning anything itself.
    this.send(ws, this.snapshotFor(bridge));

    console.log(
      `[coordinator] Browser bridge registered for board "${this.boardName}" (${bridge.role}, runtimeIds: ${hosted.join(", ")}, bridges: ${this.bridges.size})`,
    );
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * The assets a runtime is given: every one the board declares, unless an
   * asset names the runtimes it is for. Not only the ones its services name —
   * which asset a service uses can be decided as it runs, by its input or by a
   * request, and a reference that reaches a runtime has to resolve there.
   *
   * None for a runtime a unit contributed: it resolves against that unit's
   * assets, which are not the board's.
   */
  private assetsFor(runtime: CloudRuntimeDescriptor): Record<string, AssetDescriptor> {
    const assets: Record<string, AssetDescriptor> = {};
    if (runtime.unit) {
      return assets;
    }
    for (const descriptor of this.config.assets ?? []) {
      if (!descriptor.runtimes || descriptor.runtimes.includes(runtime.id)) {
        assets[descriptor.id] = descriptor;
      }
    }
    return assets;
  }

  private onRuntimeNotification(
    runtimeId: string,
    serviceUuid: string,
    payload: unknown,
    caller?: Caller,
  ): void {
    // Pass it on as what it is. A service's notifications are its output, not
    // its state — a Monitor's message never appears in its getState — so a
    // browser reaching this runtime through us must receive the same
    // notifications it would have received from the runtime directly. A payload
    // is whatever the service said, string and number included; only the mount
    // address below is looked for, and only an object can carry one.
    this.deliverNotification(runtimeId, serviceUuid, payload, caller);

    if (!payload || typeof payload !== "object") {
      return;
    }

    const published = (payload as Record<string, unknown>)[MOUNT_FIELD];
    if (typeof published !== "string" || !published) {
      return;
    }

    // A published address *is* state, and the one piece of it a browser cannot
    // work out for itself, so keep the board's view of it current.
    const states = this.serviceStates.get(runtimeId) ?? {};
    const previous = states[serviceUuid];
    states[serviceUuid] =
      previous && typeof previous === "object"
        ? { ...(previous as Record<string, unknown>), [MOUNT_FIELD]: published }
        : { [MOUNT_FIELD]: published };
    this.serviceStates.set(runtimeId, states);
    this.broadcastServiceState(runtimeId, serviceUuid, states[serviceUuid]);

    if (this.recordMountAddress(runtimeId, serviceUuid, published)) {
      void this.publishMountAddresses().catch((err) => {
        console.error(
          `[coordinator] Failed to publish mount addresses for board "${this.boardName}":`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  /**
   * Tells the browsers that are to hear it what a service said.
   *
   * A notification raised inside a run somebody began is theirs: it goes to
   * the bridges they attached with, and to nobody else — what one member's
   * action produced is not another member's to read, and not the owner's to
   * watch. One raised in a run nobody began — a timer, a request at a mount —
   * is the board's own news and goes to everyone.
   *
   * A member is sent it only from a service the facade reads, and never the
   * runtime's own account of its flow, which carries the data passing through
   * every service.
   */
  private deliverNotification(
    runtimeId: string,
    serviceUuid: string,
    payload: unknown,
    caller?: Caller,
  ): void {
    let frame: string | null = null;
    for (const bridge of this.bridges) {
      if (caller && bridge.caller?.sub !== caller.sub) {
        continue;
      }
      if (
        bridge.role === "member" &&
        (!this.access.sources.has(serviceUuid) || isFlowNotification(payload))
      ) {
        continue;
      }
      if (bridge.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      frame ??= JSON.stringify({
        type: "notification",
        runtimeId,
        serviceUuid,
        payload,
      });
      bridge.ws.send(frame);
    }
  }

  /** Sends a message to every browser the board's owner has attached. */
  private toOwners(message: BridgeMessage): void {
    const payload = JSON.stringify(message);
    for (const bridge of this.bridges) {
      if (bridge.role === "owner" && bridge.ws.readyState === WebSocket.OPEN) {
        bridge.ws.send(payload);
      }
    }
  }

  /** The owner's open bridges: the only ones a browser runtime can be on. */
  private hostingBridges(): BrowserBridge[] {
    return [...this.bridges].filter(
      (bridge) =>
        bridge.role === "owner" && bridge.ws.readyState === WebSocket.OPEN,
    );
  }

  /** Tells every browser the board again, each as it is entitled to see it. */
  private broadcastSnapshot(): void {
    for (const bridge of this.bridges) {
      this.send(bridge.ws, this.snapshotFor(bridge));
    }
  }

  /**
   * Tells every browser one service's new state. A member is told only of a
   * service the facade names, and only what the facade reads of it.
   */
  private broadcastServiceState(
    runtimeId: string,
    serviceUuid: string,
    state: unknown,
  ): void {
    for (const bridge of this.bridges) {
      if (bridge.role === "member") {
        if (!this.access.named.has(serviceUuid)) {
          continue;
        }
        this.send(bridge.ws, {
          type: "serviceState",
          seq: ++bridge.seq,
          runtimeId,
          serviceUuid,
          state: projectState(this.access, serviceUuid, state),
        });
        continue;
      }
      this.send(bridge.ws, {
        type: "serviceState",
        seq: ++bridge.seq,
        runtimeId,
        serviceUuid,
        state,
      });
    }
  }

  private send(ws: WebSocket, message: BridgeMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /** A run a browser begins, as whoever attached with it. */
  private beginRun(bridge: BrowserBridge): ProcessContext {
    return {
      runId: randomUUID(),
      ...(bridge.caller ? { caller: bridge.caller } : {}),
    };
  }

  /**
   * The board as this coordinator knows it, for one browser.
   *
   * Sent when a browser attaches, and again on request. For the owner it is
   * every remote runtime's registry and the state its services last reported:
   * the live state rather than the saved board, because that is the part a
   * browser cannot work out for itself — a mount's address is assigned when
   * the runtime is provisioned and appears in no saved board.
   *
   * For a member it is a projection: the facade, and of the board only the
   * services the facade names with what it reads of each. A board's config
   * carries service state, and state can carry credentials, so not showing a
   * member the board would mean little if this sent it to them.
   */
  private snapshotFor(bridge: BrowserBridge): BridgeMessage {
    const you = bridge.caller
      ? {
          ...(bridge.caller.email ? { email: bridge.caller.email } : {}),
          ...(bridge.caller.name ? { name: bridge.caller.name } : {}),
        }
      : undefined;
    const common = {
      type: "snapshot" as const,
      seq: ++bridge.seq,
      boardName: this.boardName,
      status: this.getStatus(),
      role: bridge.role,
      ...(you ? { you } : {}),
    };

    if (bridge.role === "member") {
      const config = projectConfig(this.config, this.access, (runtimeId, uuid) =>
        this.liveState(runtimeId, uuid),
      );
      return {
        ...common,
        // Whether the board is running is a member's to know; which runtime
        // server is away, and why, is its owner's.
        errors: [],
        config,
        runtimes: config.runtimes.map(({ id }) => ({
          runtimeId: id,
          registry: [],
          services: Object.fromEntries(
            (config.services[id] ?? []).map((svc) => [svc.uuid, svc.state ?? {}]),
          ),
        })),
      };
    }

    // In the board's own order, and including a runtime whose participant has
    // dropped: what it last reported is still the best account of it there is,
    // and the status beside it says that it is away.
    const runtimes: RuntimeSnapshot[] = this.required()
      .filter(({ id }) => this.built.has(id))
      .map(({ id }) => ({
        runtimeId: id,
        registry: this.registries.get(id) ?? [],
        services: this.serviceStates.get(id) ?? {},
      }));
    return {
      ...common,
      errors: this.getErrors(),
      config: this.config,
      runtimes,
    };
  }

  /** What a service last reported, or what the board configured it with. */
  private liveState(runtimeId: string, serviceUuid: string): unknown {
    const reported = this.serviceStates.get(runtimeId)?.[serviceUuid];
    if (reported !== undefined) {
      return reported;
    }
    return (this.config.services[runtimeId] ?? []).find(
      (svc) => svc.uuid === serviceUuid,
    )?.state;
  }

  /**
   * Whether a member has asked for more than they are allowed in the last
   * minute. Counted per person rather than per bridge, so opening another tab
   * is not a way round it.
   */
  private overMemberRate(email: string): boolean {
    const limit =
      this.limits.maxMemberProcessPerMinute ??
      DEFAULT_MEMBER_LIMITS.maxMemberProcessPerMinute;
    const now = Date.now();
    const recent = (this.memberProcessTimes.get(email) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (recent.length >= limit) {
      this.memberProcessTimes.set(email, recent);
      return true;
    }
    recent.push(now);
    this.memberProcessTimes.set(email, recent);
    return false;
  }

  /**
   * Asks a service on a remote runtime to do its job, for a browser.
   *
   * The run begins here, as whoever attached with the bridge — which is what
   * makes the caller something the runtime can rely on: it was established
   * when the bridge was admitted, and nothing in the message can change it.
   *
   * The answer says only whether the work was taken. What it produces arrives
   * the way a pipeline's output always does — as notifications, and as a
   * result this session carries to the board's next runtime.
   */
  private async serveProcessRequest(
    bridge: BrowserBridge,
    message: Extract<BridgeMessage, { type: "processService" }>,
  ): Promise<void> {
    const refuse = (error: string) =>
      this.send(bridge.ws, {
        type: "response",
        requestId: message.requestId,
        error,
      });
    if (
      typeof message.requestId !== "string" ||
      typeof message.serviceUuid !== "string"
    ) {
      return;
    }

    let runtimeId = message.runtimeId;
    if (bridge.role === "member") {
      // The entry point is the capability: a member may begin at a service
      // the facade asks to process, and at no other.
      if (!this.access.processTargets.has(message.serviceUuid)) {
        refuse("This board does not offer that");
        return;
      }
      // Where that service is, is the board's to say and not the message's.
      runtimeId = runtimeHolding(this.config, message.serviceUuid) ?? "";
      const email = bridge.caller?.email ?? "";
      if (this.overMemberRate(email)) {
        refuse("Too many requests — try again in a moment");
        return;
      }
    }

    if (this.stopped) {
      refuse("This board is stopped");
      return;
    }
    const participant = this.live.has(runtimeId)
      ? this.participants.get(runtimeId)
      : undefined;
    if (!participant) {
      refuse(
        bridge.role === "member"
          ? "This board is not running right now"
          : this.required().some((rt) => rt.id === runtimeId)
            ? `Runtime "${runtimeId}" is not connected`
            : `Unknown runtime "${runtimeId}"`,
      );
      return;
    }

    try {
      await participant.request({
        op: "processService",
        serviceUuid: message.serviceUuid,
        params: message.payload ?? null,
        context: this.beginRun(bridge),
      });
      this.send(bridge.ws, {
        type: "response",
        requestId: message.requestId,
        data: { accepted: true },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      refuse(
        bridge.role === "member"
          ? "This board could not take that right now"
          : `Runtime "${runtimeId}": ${reason}`,
      );
    }
  }

  /**
   * Acts on a remote service for a browser that cannot reach it.
   *
   * The browser is a viewer: it renders this board and asks for changes, but the
   * runtimes are the coordinator's to talk to. The reply carries whatever the
   * runtime returned, so a panel can reconcile its optimistic state with what
   * actually took effect.
   */
  private async serveBrowserRequest(
    ws: WebSocket,
    message: Extract<BridgeMessage, { type: "configureService" }>,
  ): Promise<void> {
    const participant = this.live.has(message.runtimeId)
      ? this.participants.get(message.runtimeId)
      : undefined;
    if (!participant) {
      this.send(ws, {
        type: "response",
        requestId: message.requestId,
        error: this.required().some((rt) => rt.id === message.runtimeId)
          ? `Runtime "${message.runtimeId}" is not connected`
          : `Unknown runtime "${message.runtimeId}"`,
      });
      return;
    }

    try {
      // Configuring returns the service's whole state; record it so a browser
      // attaching later sees the same thing this one just did.
      const data = await participant.request({
        op: "configureService",
        serviceUuid: message.serviceUuid,
        config: message.config ?? {},
      });
      const states = this.serviceStates.get(message.runtimeId) ?? {};
      states[message.serviceUuid] = data;
      this.serviceStates.set(message.runtimeId, states);
      this.broadcastServiceState(message.runtimeId, message.serviceUuid, data);
      this.send(ws, { type: "response", requestId: message.requestId, data });
    } catch (err) {
      this.send(ws, {
        type: "response",
        requestId: message.requestId,
        error: `Runtime "${message.runtimeId}": ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Records a published address. Returns whether it changed anything. */
  private recordMountAddress(
    runtimeId: string,
    serviceUuid: string,
    url: string,
  ): boolean {
    const key = formatMountRef({ runtimeId, serviceUuid });
    if (this.mountAddresses.get(key) === url) {
      return false;
    }
    this.mountAddresses.set(key, url);
    return true;
  }

  /**
   * Hands every service holding a mount reference the address it names.
   *
   * A runtime cannot do this for itself: it sees its own services and nothing
   * else, while a reference names a service on another runtime, possibly on
   * another machine. So the coordinator resolves against the board it owns and
   * configures the consumer with a plain address, which is the same value the
   * consumer would have been given had the board been exported.
   *
   * Services on browser runtimes are not reachable from here — the bridge only
   * carries processing — so those still resolve in the browser, which
   * coordinates its own board state.
   */
  private async publishMountAddresses(): Promise<void> {
    if (this.mountAddresses.size === 0) {
      return;
    }

    await Promise.all(
      this.required().map(async (descriptor) => {
        if (!this.live.has(descriptor.id)) {
          return;
        }
        const services = this.config.services[descriptor.id] ?? [];
        for (const svc of services) {
          const state = svc.state;
          if (!state) {
            continue;
          }
          // A reference is written wherever the service names its target, so it
          // is looked for by scheme rather than read out of one field.
          const refs = [...collectMountRefs(state)];
          if (refs.length === 0) {
            continue;
          }
          if (refs.length > 1) {
            // One address field, so one mount per consumer. A service needing
            // two should host a pipeline instead.
            console.warn(
              `[coordinator] Service "${descriptor.id}/${svc.uuid}" names ${refs.length} mounts; only the first is resolved`,
            );
          }
          const address = this.mountAddresses.get(refs[0]);
          if (!address) {
            // The owner has not published yet. Later passes run whenever an
            // address appears.
            continue;
          }
          const key = formatMountRef({
            runtimeId: descriptor.id,
            serviceUuid: svc.uuid,
          });
          if (this.pushedStates.get(key) === address) {
            continue;
          }
          this.pushedStates.set(key, address);
          // Only the address, and only in the field addresses live in. The
          // board keeps its reference: that is what survives being saved and
          // reopened somewhere else, while an address is only true of this run.
          await this.configureService(descriptor.id, svc.uuid, {
            [MOUNT_FIELD]: address,
          });
        }
      }),
    );
  }

  private async configureService(
    runtimeId: string,
    serviceUuid: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.participants
        .get(runtimeId)
        ?.request({ op: "configureService", serviceUuid, config: state });
    } catch (err) {
      console.error(
        `[coordinator] Failed to configure "${serviceUuid}" on runtime "${runtimeId}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Hands what one runtime produced to the next one in the board.
   *
   * `context` is the run it was produced in. It goes on with the data, which
   * is what makes a board's runtimes one run rather than one each — and what
   * lets the second runtime know who began it.
   */
  private async routeResult(
    fromRuntimeId: string,
    data: unknown,
    context?: ProcessContext,
  ): Promise<void> {
    const next = this.nextRuntime(fromRuntimeId, this.config.runtimes);
    if (!next) {
      return;
    }

    if (isRemoteRuntime(next)) {
      const participant = this.live.has(next.id)
        ? this.participants.get(next.id)
        : undefined;
      if (!participant) {
        // A required participant that is away: the board already says so.
        console.warn(
          `[coordinator] Next runtime "${next.id}" is not connected — dropping result`,
        );
        return;
      }
      participant.process(data, context);
      return;
    }

    if (isBrowserRuntime(next)) {
      // The owner's browsers, and only those: a browser runtime is theirs to
      // run, and a member's bridge asked would leave the chain waiting on an
      // answer that is dropped when it comes.
      const targets = this.hostingBridges();
      if (targets.length === 0) {
        // A transient participant that is away. Nothing is wrong: the data
        // stops here, as it would at a service that returned null, and the
        // board goes on running.
        return;
      }

      const requestId = randomUUID();
      // Fan the work out to each of them so each client's UI (e.g. a
      // Monitor) updates. The first reply resolves the chain; later replies for
      // the same requestId are no-ops since its pending entry is already gone.
      const result = await new Promise<unknown>((resolve) => {
        this.pendingBrowserResults.set(requestId, resolve);
        // The browser is told the run so that what it records belongs to it.
        // What continues the chain below is the context held here, not
        // whatever comes back.
        const header = {
          type: "processRuntime",
          runtimeId: next.id,
          requestId,
          ...(context ? { context } : {}),
        };
        const payload =
          data instanceof BinaryPayload
            ? encodeBinaryFrame(header, data)
            : JSON.stringify({ ...header, params: data });
        for (const target of targets) {
          target.ws.send(payload);
        }
      });

      if (result !== null) {
        await this.routeResult(next.id, result, context);
      }
    }
  }

  private nextRuntime(
    currentId: string,
    allRuntimes: CloudRuntimeDescriptor[],
  ): CloudRuntimeDescriptor | null {
    const idx = allRuntimes.findIndex((rt) => rt.id === currentId);
    for (let i = idx + 1; i < allRuntimes.length; i++) {
      const next = allRuntimes[i];
      if (isBrowserRuntime(next)) {
        return next;
      }
      if (isRemoteRuntime(next)) {
        return next;
      }
    }
    return null;
  }
}
