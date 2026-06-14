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
  // clients (e.g. Meander + a browser tab) can watch the same board at once;
  // runtime output is fanned out to all of them.
  private readonly bridges = new Set<BrowserBridge>();
  private readonly pendingBrowserResults = new Map<
    string,
    (data: unknown) => void
  >();
  // Per-runtime session tokens this session minted (runtimeId → token). Used for
  // the long-lived machine calls (result WS, teardown) that outlive the user's JWT.
  private readonly sessionTokens = new Map<string, string>();

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
  }

  getStatus(): BoardSessionStatus {
    return this.status;
  }

  getErrors(): string[] {
    return [...this.errors];
  }

  async destroy(): Promise<void> {
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
      let message: {
        type?: string;
        requestId?: string;
        runtimeId?: string;
        data?: unknown;
      };
      try {
        message = JSON.parse(raw.toString());
      } catch (err) {
        console.error(
          `[coordinator] Failed to parse bridge message for board "${this.boardName}":`,
          err instanceof Error ? err.message : err,
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

    let outputUrl: string | undefined;

    const existing = await fetch(
      `${baseUrl}/runtimes/${encodeURIComponent(id)}`,
      { headers: userAuth },
    );
    if (existing.ok) {
      const descriptor = (await existing.json()) as { outputUrl?: string };
      outputUrl = descriptor.outputUrl;
    }

    if (!outputUrl) {
      const payload = {
        id,
        name: runtime.name,
        boardName: this.boardName,
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
      };
      outputUrl = body.runtimes?.[0]?.outputUrl;
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
    const res = await fetch(
      `${baseUrl}/runtimes/${encodeURIComponent(runtimeId)}/session-token`,
      { method: "POST", headers: this.bearer(this.userJwt) },
    );
    if (!res.ok) {
      throw new Error(`Failed to mint session token (${res.status})`);
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
      let message: { type?: string; data?: unknown };
      try {
        message = JSON.parse(raw.toString());
      } catch (err) {
        console.error(
          `[coordinator] Failed to parse message from runtime "${runtime.id}":`,
          err instanceof Error ? err.message : err,
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
