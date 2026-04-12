/**
 * Service Documentation
 * Service ID: peer-server
 * Service Name: PeerServer
 * Runtime: hkp-node
 * Modes: standalone PeerJS signaling server
 * Key Config: port, path, bypass, emitEvents
 * IO: passthrough — the service's value is the signaling side-effect
 *     When emitEvents=true, peer connect/disconnect events are pushed to
 *     the next service in the pipeline (e.g. a Monitor).
 * Compatible with the peerjs browser client.
 */
import http from "node:http";

import express from "express";
import { ExpressPeerServer, IClient } from "peer";

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
  private port = 0;
  private path = "/";
  private emitEvents = false;
  private server: http.Server | null = null;
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
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.port === "number" && config.port !== this.port) {
      this.port = config.port;
      if (this.server) {
        this.restartServer();
      }
    }

    if (typeof config.path === "string") {
      this.path = config.path;
    }

    if (typeof config.emitEvents === "boolean") {
      this.emitEvents = config.emitEvents;
    }

    if (typeof config.bypass === "boolean" && config.bypass !== this.bypass) {
      this.bypass = config.bypass;
      if (this.bypass) {
        this.stopServer();
      } else {
        this.startServer();
      }
    }

    if (!this.bypass && !this.server) {
      this.startServer();
    }

    return this.getState();
  }

  getState(): JsonRecord {
    return {
      bypass: this.bypass,
      port: this.port,
      path: this.path,
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
    this.stopServer();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private onPeerConnected = (client: IClient): void => {
    if (!this.server) return;
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
    if (!this.server) return;
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

  private startServer(): void {
    if (this.server) return;

    const app = express();
    const httpServer = http.createServer(app);
    const peerServer = ExpressPeerServer(httpServer, { allow_discovery: true });
    app.use(this.path, peerServer);

    peerServer.on("connection", this.onPeerConnected);
    peerServer.on("disconnect", this.onPeerDisconnected);

    this.peerServer = peerServer;
    this.server = httpServer;

    httpServer.on("error", (err) => {
      console.error("peer-server error", err);
    });

    httpServer.listen(this.port, () => {
      const address = this.server?.address();
      if (address && typeof address !== "string") {
        this.port = address.port;
        this.host?.notify({ port: this.port }, this.uuid);
      }
    });
  }

  private stopServer(): void {
    if (this.peerServer) {
      this.peerServer.removeListener("connection", this.onPeerConnected);
      this.peerServer.removeListener("disconnect", this.onPeerDisconnected);
      this.peerServer = null;
    }

    const server = this.server;
    this.server = null;

    if (this.connectedPeers.length > 0) {
      this.connectedPeers = [];
      this.host?.notify({ connectedPeers: this.connectedPeers }, this.uuid);
    }

    if (server) {
      // Force-close all keep-alive connections so the port is released
      // immediately rather than waiting for connections to drain naturally.
      server.closeAllConnections?.();
      server.close((err) => {
        if (err) console.error("peer-server close error", err);
      });
    }
  }

  private restartServer(): void {
    this.stopServer();
    if (!this.bypass) {
      this.startServer();
    }
  }
}
