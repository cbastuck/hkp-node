/**
 * Service Documentation
 * Service ID: peer-server
 * Service Name: PeerServer
 * Runtime: hkp-node
 * Modes: PeerJS signaling server on a runtime-assigned mount
 * Key Config: bypass, emitEvents (the endpoint is assigned, not configured)
 * IO: passthrough — the service's value is the signaling side-effect
 *     When emitEvents=true, peer connect/disconnect events are pushed to
 *     the next service in the pipeline (e.g. a Monitor).
 * Compatible with the peerjs browser client.
 */
import http from "node:http";

import express, { Express } from "express";
import { ExpressPeerServer, IClient } from "peer";
import { WebSocketServer } from "ws";

import { MountHandle } from "../mounts";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const peerServerDescriptor: ServiceRegistryEntry = {
  serviceId: "peer-server",
  serviceName: "PeerServer",
};

export class PeerServerService implements HostedService {
  readonly serviceId = peerServerDescriptor.serviceId;
  readonly serviceName = peerServerDescriptor.serviceName;
  readonly uuid: string;

  private bypass = true;
  private emitEvents = false;
  private mount: MountHandle | null = null;
  private app: Express | null = null;
  private socketServer: WebSocketServer | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private peerServer: any = null;
  private host: RuntimeHost | null = null;
  private connectedPeers: string[] = [];

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
    // State is applied in the constructor, before the host exists, so a service
    // configured as already-active has nothing to claim its mount from until now.
    if (!this.bypass && !this.mount) {
      this.claimMount();
    }
  }

  configure(config: JsonRecord): JsonRecord {
    // `port` and `path` are accepted and ignored: the signalling endpoint is
    // served by the shared runtime server at an assigned path, so the service
    // no longer picks either. Older boards still carry the fields, and
    // rejecting them would fail those boards on load.

    if (typeof config.emitEvents === "boolean") {
      this.emitEvents = config.emitEvents;
    }

    if (typeof config.bypass === "boolean" && config.bypass !== this.bypass) {
      this.bypass = config.bypass;
      if (this.bypass) {
        this.releaseMount();
      } else {
        this.claimMount();
      }
    }

    if (!this.bypass && !this.mount) {
      this.claimMount();
    }

    return this.getState();
  }

  getState(): JsonRecord {
    return {
      bypass: this.bypass,
      // Public signalling endpoint, assigned by the runtime. A PeerJS client is
      // configured from `path` (with the runtime's own host and port).
      url: this.mount?.url ?? "",
      path: this.mount?.path ?? "",
      emitEvents: this.emitEvents,
      connectedPeers: this.connectedPeers,
    };
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    return input;
  }

  destroy(): void {
    this.releaseMount();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private onPeerConnected = (client: IClient): void => {
    if (!this.mount) return;
    const peerId = client.getId();
    this.connectedPeers = [...this.connectedPeers, peerId];
    this.host?.notify({ connectedPeers: this.connectedPeers }, this.uuid);
    if (this.emitEvents) {
      this.host?.processFrom(
        this.uuid,
        { event: "peer-connected", peerId, connectedPeers: this.connectedPeers },
        (_n: RuntimeNotification) => {},
      );
    }
  };

  private onPeerDisconnected = (client: IClient): void => {
    if (!this.mount) return;
    const peerId = client.getId();
    this.connectedPeers = this.connectedPeers.filter((id) => id !== peerId);
    this.host?.notify({ connectedPeers: this.connectedPeers }, this.uuid);
    if (this.emitEvents) {
      this.host?.processFrom(
        this.uuid,
        { event: "peer-disconnected", peerId, connectedPeers: this.connectedPeers },
        (_n: RuntimeNotification) => {},
      );
    }
  };

  private claimMount(): void {
    if (this.mount || !this.host?.mount) {
      return;
    }

    // Claim the public path first: PeerJS derives its WebSocket route from the
    // Express mountpath, so the sub-app can only be built once the path is known.
    const mount = this.host.mount(this.uuid, {
      request: (req, res) => {
        this.app?.(req, res);
      },
      upgrade: (req, socket, head) => {
        const socketServer = this.socketServer;
        if (!socketServer) {
          socket.destroy();
          return;
        }
        socketServer.handleUpgrade(req, socket, head, (ws) => {
          socketServer.emit("connection", ws, req);
        });
      },
    });
    if (!mount) {
      return;
    }
    this.mount = mount;

    const app = express();
    // A detached http.Server that is never listened on. PeerJS insists on a
    // server to attach to, and giving it this one rather than the shared runtime
    // server is what keeps upgrade routing ours: attaching to a live server
    // installs a `ws` upgrade listener that answers 400 on every path it does
    // not own, which would take out the runtime notification sockets.
    const carrier = http.createServer();
    const peerServer = ExpressPeerServer(carrier, {
      allow_discovery: true,
      // The carrier receives nothing, so without a reference to the socket
      // server PeerJS builds there is no way to hand it an upgrade. This hook is
      // that reference; `noServer` only makes the detachment explicit.
      createWebSocketServer: (options) => {
        this.socketServer = new WebSocketServer({
          ...options,
          server: undefined,
          noServer: true,
        });
        return this.socketServer;
      },
    });
    app.use(mount.path, peerServer);

    peerServer.on("connection", this.onPeerConnected);
    peerServer.on("disconnect", this.onPeerDisconnected);

    this.peerServer = peerServer;
    this.app = app;

    this.host?.notify({ url: mount.url, path: mount.path }, this.uuid);
  }

  private releaseMount(): void {
    if (this.peerServer) {
      this.peerServer.removeListener("connection", this.onPeerConnected);
      this.peerServer.removeListener("disconnect", this.onPeerDisconnected);
      this.peerServer = null;
    }

    this.socketServer?.close();
    this.socketServer = null;
    this.app = null;

    this.mount?.release();
    this.mount = null;

    if (this.connectedPeers.length > 0) {
      this.connectedPeers = [];
      this.host?.notify({ connectedPeers: this.connectedPeers }, this.uuid);
    }
  }
}
