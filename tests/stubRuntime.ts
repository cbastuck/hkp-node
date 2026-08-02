import http from "node:http";
import { AddressInfo, Socket } from "node:net";

import { WebSocketServer } from "ws";

/**
 * A runtime that records what the coordinator configures on it. Stands in for a
 * runtime whose services consume a mount — hkp-node has no such service yet, so
 * the consumer side is observed at the HTTP boundary rather than in a service.
 */
export type StubRuntime = {
  url: string;
  configured: Array<{ serviceUuid: string; state: Record<string, unknown> }>;
  close: () => Promise<void>;
};

export async function startStubRuntime(runtimeId: string): Promise<StubRuntime> {
  const configured: StubRuntime["configured"] = [];
  let created = false;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url === `/runtimes/${runtimeId}`) {
      if (!created) {
        send(404, { error: "not found" });
        return;
      }
      // This runtime's services own no mounts, so nothing to publish back.
      send(200, { id: runtimeId, services: [] });
      return;
    }

    if (req.method === "POST" && url === "/runtimes") {
      created = true;
      const { port } = server.address() as AddressInfo;
      send(200, {
        runtimes: [{ id: runtimeId, outputUrl: `ws://127.0.0.1:${port}/${runtimeId}` }],
        registry: [],
      });
      return;
    }

    const configurePrefix = `/runtimes/${runtimeId}/services/`;
    if (req.method === "POST" && url.startsWith(configurePrefix)) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        configured.push({
          serviceUuid: decodeURIComponent(url.slice(configurePrefix.length)),
          state: JSON.parse(body || "{}"),
        });
        send(200, {});
      });
      return;
    }

    send(404, { error: "unexpected request" });
  });

  const sockets = new WebSocketServer({ server });
  // Closing an http server waits for its connections to end, and a coordinator
  // holds an open WebSocket to this one — so a test that shuts the host down
  // would wait on the very socket it is trying to take away. Track them and
  // cut them, so "the host is gone" happens when the test says it does.
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    configured,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.close();
        for (const socket of connections) {
          socket.destroy();
        }
        connections.clear();
        server.close(() => resolve());
      }),
  };
}
