import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  CloudBoardConfig,
  CloudRuntimeDescriptor,
  BoardSessionStatus,
  isRemoteRuntime,
  isBrowserRuntime,
} from "./types";
import { assertRuntimeUrlAllowed } from "./urlGuard";
import {
  MOUNT_FIELD,
  formatMountRef,
  parseMountRef,
  substituteMounts,
} from "./mount";
import {
  BridgeMessage,
  RuntimeSnapshot,
  ServiceStates,
  isBridgeMessage,
} from "./bridgeProtocol";

type ProvisionedRuntime = {
  descriptor: CloudRuntimeDescriptor;
  wsUrl: string;
};

type BrowserBridge = {
  ws: WebSocket;
  runtimeIds: Set<string>;
};

export class BoardSession {
  readonly createdAt: string;
  private status: BoardSessionStatus = "running";
  // Human-readable reasons for an "error" status, surfaced to the UI.
  private readonly errors: string[] = [];
  private readonly sockets = new Map<string, WebSocket>();
  private readonly provisioned: ProvisionedRuntime[] = [];
  // Every browser currently viewing this board has its own bridge. Multiple
  // clients (e.g. Readymade + a browser tab) can watch the same board at once;
  // runtime output is fanned out to all of them.
  private readonly bridges = new Set<BrowserBridge>();
  private readonly pendingBrowserResults = new Map<
    string,
    (data: unknown) => void
  >();
  // Per-runtime session tokens this session minted (runtimeId → token). Used for
  // the long-lived machine calls (result WS, teardown) that outlive the user's JWT.
  private readonly sessionTokens = new Map<string, string>();
  // Addresses services published for the mounts they own, keyed
  // "runtimeId/serviceUuid". This session coordinates the board, so it is what
  // turns a reference into the address it names — no runtime can see far enough
  // to do it for itself.
  private readonly mountAddresses = new Map<string, string>();
  // What was last handed to each consumer, keyed the same way. Guards against
  // re-configuring a service with a state it already has.
  private readonly pushedStates = new Map<string, string>();
  // What each remote runtime's services last reported, and what that runtime
  // says it can run. This is the board as the coordinator knows it, and what an
  // attached browser renders from — it owns none of it itself.
  private readonly serviceStates = new Map<string, ServiceStates>();
  private readonly registries = new Map<string, unknown[]>();
  // Ordering for snapshots and the increments that follow, so a browser can
  // tell it missed one and ask for a fresh snapshot rather than drift.
  private seq = 0;

  constructor(
    readonly boardName: string,
    readonly userId: string,
    readonly config: CloudBoardConfig,
    // The user's JWT, captured while they create/modify the board. It bootstraps
    // provisioning and is exchanged for per-runtime session tokens. Undefined when
    // auth is off (local dev), in which case runtimes are passthrough.
    private readonly userJwt?: string,
  ) {
    this.createdAt = new Date().toISOString();
  }

  /** Bearer Authorization header for a token, or empty when there is none. */
  private bearer(token: string | undefined): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async start(): Promise<void> {
    const { runtimes } = this.config;

    for (const runtime of runtimes) {
      if (!isRemoteRuntime(runtime) || !runtime.url) {
        continue;
      }

      const services = this.config.services[runtime.id] ?? [];

      let wsUrl: string;
      try {
        wsUrl = await this.provision(runtime, services);
      } catch (err) {
        this.status = "error";
        const reason = err instanceof Error ? err.message : String(err);
        this.errors.push(`Runtime "${runtime.id}": ${reason}`);
        console.error(
          `[coordinator] Failed to provision runtime "${runtime.id}" for board "${this.boardName}":`,
          reason,
        );
        continue;
      }

      this.provisioned.push({ descriptor: runtime, wsUrl });
    }

    for (const entry of this.provisioned) {
      this.connect(entry);
    }

    // Provisioning runs runtime by runtime, so a service pointed at a mount on
    // a runtime provisioned later cannot have been resolved as it was created.
    // Collect what everything published, then hand out the addresses once the
    // whole board exists.
    await this.collectMountAddresses();
    await this.publishMountAddresses();
  }

  getStatus(): BoardSessionStatus {
    return this.status;
  }

  getErrors(): string[] {
    return [...this.errors];
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
    await this.teardownRuntimes();
    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();
    this.provisioned.length = 0;
    this.mountAddresses.clear();
    this.pushedStates.clear();
    this.serviceStates.clear();
    this.registries.clear();
    this.status = "stopped";
    this.broadcast(this.snapshot());
  }

  private async teardownRuntimes(): Promise<void> {
    await Promise.all(
      this.provisioned
        .filter(({ descriptor }) => !!descriptor.url)
        .map(({ descriptor }) =>
          fetch(
            `${descriptor.url}/runtimes/${encodeURIComponent(descriptor.id)}`,
            {
              method: "DELETE",
              // Teardown can happen after the user is gone, so use the session
              // token (still valid for this runtime's lifetime), not the JWT.
              headers: this.bearer(this.sessionTokens.get(descriptor.id)),
            },
          ).catch((err) => {
            console.error(
              `[coordinator] Failed to DELETE runtime "${descriptor.id}":`,
              err instanceof Error ? err.message : err,
            );
          }),
        ),
    );
  }

  async destroy(): Promise<void> {
    await this.teardownRuntimes();

    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();

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
   * disconnect.
   */
  takeBridges(): { ws: WebSocket; runtimeIds: string[] }[] {
    const taken = [...this.bridges].map((bridge) => {
      // Detach handlers so the old session no longer processes bridge messages.
      bridge.ws.removeAllListeners("message");
      bridge.ws.removeAllListeners("close");
      return { ws: bridge.ws, runtimeIds: [...bridge.runtimeIds] };
    });
    this.bridges.clear();
    return taken;
  }

  registerBrowserSocket(ws: WebSocket, runtimeIds: string[]): void {
    // The same socket re-registering (e.g. its browser runtimes changed) — just
    // refresh its runtimeIds rather than adding a duplicate or re-attaching
    // listeners.
    for (const existing of this.bridges) {
      if (existing.ws === ws) {
        existing.runtimeIds = new Set(runtimeIds);
        return;
      }
    }

    const bridge: BrowserBridge = { ws, runtimeIds: new Set(runtimeIds) };
    this.bridges.add(bridge);

    ws.on("message", (raw) => {
      let message: BridgeMessage;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
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
        this.send(ws, this.snapshot());
        return;
      }

      if (message.type === "configureService") {
        void this.serveBrowserRequest(ws, message);
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
        this.routeResult(message.runtimeId, message.data).catch((err) => {
          console.error(
            `[coordinator] Failed to route result from browser runtime "${message.runtimeId}":`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    });

    ws.on("close", () => {
      this.bridges.delete(bridge);
      // Only abandon in-flight browser results once no client remains to answer
      // them; another connected bridge may still reply.
      if (this.bridges.size === 0) {
        for (const [requestId, resolve] of this.pendingBrowserResults) {
          this.pendingBrowserResults.delete(requestId);
          resolve(null);
        }
      }
    });

    // Attaching is a read: the browser renders what the board currently is,
    // rather than provisioning anything itself.
    this.send(ws, this.snapshot());

    console.log(
      `[coordinator] Browser bridge registered for board "${this.boardName}" (runtimeIds: ${runtimeIds.join(", ")}, bridges: ${this.bridges.size})`,
    );
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async provision(
    runtime: CloudRuntimeDescriptor,
    services: CloudBoardConfig["services"][string],
  ): Promise<string> {
    const { url, id } = runtime;
    const baseUrl = url!;
    // SSRF guard: the board config is untrusted (shared/imported boards), so
    // refuse to dial blocked targets (cloud metadata, internal hosts) before any
    // request leaves this process.
    await assertRuntimeUrlAllowed(baseUrl);
    // Provisioning runs while the user is creating/modifying the board, so it is
    // authenticated with their JWT — the runtime validates it the same way it
    // validates a browser's. The JWT is then exchanged for a session token below.
    const userAuth = this.bearer(this.userJwt);

    // Registering a board is a deploy: the board is being handed to this
    // coordinator, so its runtimes are provisioned — created, replacing
    // anything under those ids. Attaching to runtimes that are already running
    // is the other intent, and belongs to resuming a board rather than
    // deploying one; nothing resumes yet, so it is not built.
    let outputUrl: string | undefined;

    {
      const payload = {
        id,
        name: runtime.name,
        boardName: this.boardName,
        // Ours until we delete it: a deployed board keeps running with no
        // browser attached, and our own sockets come and go as sessions are
        // replaced.
        garbageCollected: false,
        services: services.map((svc) => ({
          uuid: svc.uuid,
          serviceId: svc.serviceId,
          serviceName: svc.serviceName ?? svc.name ?? svc.serviceId,
          state: svc.state ?? {},
        })),
      };

      const response = await fetch(`${baseUrl}/runtimes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...userAuth },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`POST /runtimes returned ${response.status}`);
      }

      const body = (await response.json()) as {
        runtimes?: Array<{ outputUrl?: string }>;
        registry?: unknown[];
      };
      outputUrl = body.runtimes?.[0]?.outputUrl;
      if (Array.isArray(body.registry)) {
        this.registries.set(id, body.registry);
      }
    }

    if (!outputUrl) {
      throw new Error("Runtime provisioned but no outputUrl returned");
    }

    // The runtime returns the WS URL it wants us to connect to; re-validate it in
    // case a (possibly malicious) target tried to redirect us to a blocked host.
    await assertRuntimeUrlAllowed(outputUrl);

    // Exchange the user JWT for a long-lived session token scoped to this runtime.
    await this.mintSessionToken(baseUrl, id);

    return outputUrl;
  }

  /**
   * Ask the runtime to issue a session token (delegated from the user JWT) that
   * this session will present on its machine calls. Skipped when there is no user
   * JWT (auth off / local dev), where the runtime is passthrough anyway.
   */
  private async mintSessionToken(
    baseUrl: string,
    runtimeId: string,
  ): Promise<void> {
    if (!this.userJwt) {
      return;
    }
    const url = `${baseUrl}/runtimes/${encodeURIComponent(runtimeId)}/session-token`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.bearer(this.userJwt),
    });
    if (!res.ok) {
      // Name the runtime server that was asked: a 404 means the runtime this
      // session just provisioned does not exist for this user, which is worth
      // being able to point at.
      throw new Error(`Failed to mint session token (${res.status}) at ${url}`);
    }
    const body = (await res.json()) as { token?: string };
    if (body.token) {
      this.sessionTokens.set(runtimeId, body.token);
    }
  }

  private connect(entry: ProvisionedRuntime): void {
    const { descriptor: runtime, wsUrl } = entry;
    // As a non-browser client we can authenticate the WS upgrade with a header,
    // keeping the session token out of the URL.
    const socket = new WebSocket(wsUrl, {
      headers: this.bearer(this.sessionTokens.get(runtime.id)),
    });
    this.sockets.set(runtime.id, socket);

    socket.on("open", () => {
      console.log(
        `[coordinator] Connected to runtime "${runtime.id}" (board: "${this.boardName}")`,
      );
    });

    socket.on("message", (raw) => {
      let message: {
        type?: string;
        data?: unknown;
        instanceId?: string;
        value?: string;
      };
      try {
        message = JSON.parse(raw.toString());
      } catch (err) {
        console.error(
          `[coordinator] Failed to parse message from runtime "${runtime.id}":`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      // A service publishes the address of a mount it owns through a
      // notification — when it is unbypassed at runtime, say, long after the
      // board loaded. Whoever is waiting on that address learns of it here.
      if (message.type === "notification" && message.instanceId) {
        this.onRuntimeNotification(
          runtime.id,
          message.instanceId,
          message.value,
        );
        return;
      }

      if (message.type !== "result" || message.data === null) {
        return;
      }

      this.routeResult(runtime.id, message.data).catch((err) => {
        console.error(
          `[coordinator] Failed to route result from runtime "${runtime.id}":`,
          err instanceof Error ? err.message : err,
        );
      });
    });

    socket.on("close", () => {
      console.log(
        `[coordinator] Disconnected from runtime "${runtime.id}" (board: "${this.boardName}")`,
      );
      this.sockets.delete(runtime.id);
    });

    socket.on("error", (err) => {
      console.error(
        `[coordinator] WebSocket error for runtime "${runtime.id}":`,
        err.message,
      );
    });
  }

  private onRuntimeNotification(
    runtimeId: string,
    serviceUuid: string,
    value: string | undefined,
  ): void {
    let payload: unknown;
    try {
      payload = value === undefined ? undefined : JSON.parse(value);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") {
      return;
    }

    // Pass it on as what it is. A service's notifications are its output, not
    // its state — a Monitor's message never appears in its getState — so a
    // browser reaching this runtime through us must receive the same
    // notifications it would have received from the runtime directly.
    this.broadcast({
      type: "notification",
      runtimeId,
      serviceUuid,
      payload,
    });

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
    this.broadcast({
      type: "serviceState",
      seq: ++this.seq,
      runtimeId,
      serviceUuid,
      state: states[serviceUuid],
    });

    if (this.recordMountAddress(runtimeId, serviceUuid, published)) {
      void this.publishMountAddresses().catch((err) => {
        console.error(
          `[coordinator] Failed to publish mount addresses for board "${this.boardName}":`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  /** Sends a message to every browser watching this board. */
  private broadcast(message: BridgeMessage): void {
    const payload = JSON.stringify(message);
    for (const bridge of this.bridges) {
      if (bridge.ws.readyState === WebSocket.OPEN) {
        bridge.ws.send(payload);
      }
    }
  }

  private send(ws: WebSocket, message: BridgeMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * The board as this coordinator knows it: every remote runtime's registry and
   * the state its services last reported.
   *
   * Sent when a browser attaches, and again on request. It carries the live
   * state rather than the saved board because that is the part a browser cannot
   * work out for itself — a mount's address is assigned when the runtime is
   * provisioned and appears in no saved board.
   */
  private snapshot(): BridgeMessage {
    const runtimes: RuntimeSnapshot[] = this.provisioned.map(
      ({ descriptor }) => ({
        runtimeId: descriptor.id,
        registry: this.registries.get(descriptor.id) ?? [],
        services: this.serviceStates.get(descriptor.id) ?? {},
      }),
    );
    return {
      type: "snapshot",
      seq: ++this.seq,
      boardName: this.boardName,
      status: this.status,
      config: this.config,
      runtimes,
    };
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
    const runtime = this.provisioned.find(
      ({ descriptor }) => descriptor.id === message.runtimeId,
    )?.descriptor;
    if (!runtime?.url) {
      this.send(ws, {
        type: "response",
        requestId: message.requestId,
        error: `Unknown runtime "${message.runtimeId}"`,
      });
      return;
    }

    const path = `/runtimes/${encodeURIComponent(runtime.id)}/services/${encodeURIComponent(message.serviceUuid)}`;

    try {
      const res = await fetch(`${runtime.url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.bearer(this.sessionTokens.get(runtime.id)),
        },
        body: JSON.stringify(message.config ?? {}),
      });
      if (!res.ok) {
        this.send(ws, {
          type: "response",
          requestId: message.requestId,
          error: `Runtime "${runtime.id}" answered ${res.status}`,
        });
        return;
      }
      // Configuring returns the service's whole state; record it so a browser
      // attaching later sees the same thing this one just did.
      const data = await res.json().catch(() => null);
      const states = this.serviceStates.get(runtime.id) ?? {};
      states[message.serviceUuid] = data;
      this.serviceStates.set(runtime.id, states);
      this.broadcast({
        type: "serviceState",
        seq: ++this.seq,
        runtimeId: runtime.id,
        serviceUuid: message.serviceUuid,
        state: data,
      });
      this.send(ws, { type: "response", requestId: message.requestId, data });
    } catch (err) {
      this.send(ws, {
        type: "response",
        requestId: message.requestId,
        error: err instanceof Error ? err.message : String(err),
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
   * Reads back what every provisioned runtime's services currently report.
   *
   * Addresses are assigned while a runtime is provisioned, which happens before
   * this session subscribes to it — so the notifications announcing them are
   * already gone by the time anyone is listening. Asking is how the coordinator
   * catches up.
   */
  private async collectMountAddresses(): Promise<void> {
    await Promise.all(
      this.provisioned.map(async ({ descriptor }) => {
        if (!descriptor.url) {
          return;
        }
        try {
          const res = await fetch(
            `${descriptor.url}/runtimes/${encodeURIComponent(descriptor.id)}`,
            { headers: this.bearer(this.sessionTokens.get(descriptor.id)) },
          );
          if (!res.ok) {
            return;
          }
          const body = (await res.json()) as {
            services?: Array<{
              uuid?: string;
              state?: Record<string, unknown>;
            }>;
          };
          const states: ServiceStates = {};
          for (const svc of body.services ?? []) {
            if (!svc.uuid) {
              continue;
            }
            states[svc.uuid] = svc.state;
            const published = svc.state?.[MOUNT_FIELD];
            if (typeof published === "string" && published) {
              this.recordMountAddress(descriptor.id, svc.uuid, published);
            }
          }
          this.serviceStates.set(descriptor.id, states);
        } catch (err) {
          console.error(
            `[coordinator] Failed to read services of runtime "${descriptor.id}":`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
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

    const resolve = (ref: string): string | null =>
      this.mountAddresses.get(ref) ?? null;

    await Promise.all(
      this.provisioned.map(async ({ descriptor }) => {
        const services = this.config.services[descriptor.id] ?? [];
        for (const svc of services) {
          const state = svc.state;
          if (!state) {
            continue;
          }
          const resolved = substituteMounts(state, resolve);
          const serialized = JSON.stringify(resolved);
          // Nothing resolved, or this exact state has already been handed over
          // — later passes run whenever an address appears, and re-sending a
          // service its own configuration would be pointless churn.
          if (serialized === JSON.stringify(state)) {
            continue;
          }
          const key = formatMountRef({
            runtimeId: descriptor.id,
            serviceUuid: svc.uuid,
          });
          if (this.pushedStates.get(key) === serialized) {
            continue;
          }
          this.pushedStates.set(key, serialized);
          // The board keeps its references. They are what survives being saved
          // and reopened somewhere else; an address is only true of this run.
          await this.configureService(descriptor, svc.uuid, resolved);
        }
      }),
    );
  }

  private async configureService(
    runtime: CloudRuntimeDescriptor,
    serviceUuid: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    if (!runtime.url) {
      return;
    }
    try {
      const res = await fetch(
        `${runtime.url}/runtimes/${encodeURIComponent(runtime.id)}/services/${encodeURIComponent(serviceUuid)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.bearer(this.sessionTokens.get(runtime.id)),
          },
          body: JSON.stringify(state),
        },
      );
      if (!res.ok) {
        console.error(
          `[coordinator] Failed to configure "${serviceUuid}" on runtime "${runtime.id}": ${res.status}`,
        );
      }
    } catch (err) {
      console.error(
        `[coordinator] Failed to configure "${serviceUuid}" on runtime "${runtime.id}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async routeResult(
    fromRuntimeId: string,
    data: unknown,
  ): Promise<void> {
    const next = this.nextRuntime(fromRuntimeId, this.config.runtimes);
    if (!next) {
      return;
    }

    if (isRemoteRuntime(next)) {
      const nextSocket = this.sockets.get(next.id);
      if (!nextSocket || nextSocket.readyState !== WebSocket.OPEN) {
        console.warn(
          `[coordinator] Next runtime "${next.id}" not ready — dropping result`,
        );
        return;
      }
      nextSocket.send(JSON.stringify({ type: "processRuntime", params: data }));
      return;
    }

    if (isBrowserRuntime(next)) {
      const targets = [...this.bridges].filter(
        (b) => b.ws.readyState === WebSocket.OPEN,
      );
      if (targets.length === 0) {
        console.warn(
          `[coordinator] Browser runtime "${next.id}" has no connected bridge — dropping result`,
        );
        return;
      }

      const requestId = randomUUID();
      // Fan the work out to every connected viewer so each client's UI (e.g. a
      // Monitor) updates. The first reply resolves the chain; later replies for
      // the same requestId are no-ops since its pending entry is already gone.
      const result = await new Promise<unknown>((resolve) => {
        this.pendingBrowserResults.set(requestId, resolve);
        const payload = JSON.stringify({
          type: "processRuntime",
          runtimeId: next.id,
          params: data,
          requestId,
        });
        for (const target of targets) {
          target.ws.send(payload);
        }
      });

      if (result !== null) {
        await this.routeResult(next.id, result);
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
      if (isRemoteRuntime(next) && next.url) {
        return next;
      }
    }
    return null;
  }
}
