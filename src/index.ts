#!/usr/bin/env node
// Copyright (c) 2026 cbastuck
// SPDX-License-Identifier: AGPL-3.0-only
import path from "path";
import { config as loadEnv } from "dotenv";
import { createRuntimeServer } from "./server";
import { createCoordinatorRouter } from "./coordinator";

async function main() {
  loadEnv({ path: path.join(__dirname, "..", ".env") });
  const port = readInteger(process.env.PORT, 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const externalHost = process.env.EXTERNAL_HOST ?? "127.0.0.1";
  const externalSecure = process.env.EXTERNAL_SECURE === "true";
  const allowedOrigins = process.env.ALLOWED_ORIGINS ?? "*";
  const coordinatorEnabled = process.env.COORDINATOR_ENABLED === "true";

  const server = createRuntimeServer({
    allowedOrigins,
    externalHost,
    externalSecure,
    host,
    name: process.env.NAME ?? "hkp-node",
  });

  if (coordinatorEnabled) {
    const { router: coordinatorRouter, coordinator } =
      createCoordinatorRouter();
    server.expressApp.use("/coordinator", coordinatorRouter);
    server.setBridgeUpgradeHandler((ws) => {
      ws.once("message", (raw) => {
        const text = raw.toString();
        let msg: {
          type?: string;
          userId?: string;
          boardName?: string;
          runtimeIds?: string[];
        };
        try {
          msg = JSON.parse(text);
        } catch {
          console.warn("[bridge] Failed to parse connect message — closing");
          console.log(
            "[bridge-close] Server initiating close: invalid JSON in initial connect message",
          );
          ws.close();
          return;
        }
        if (msg.type !== "connect" || !msg.userId || !msg.boardName) {
          console.warn(
            `[bridge] Invalid connect message (type=${msg.type}, userId=${msg.userId}, boardName=${msg.boardName}) — closing`,
          );
          console.log(
            `[bridge-close] Server initiating close: invalid connect payload (type=${msg.type}, userId=${msg.userId}, boardName=${msg.boardName})`,
          );
          ws.close();
          return;
        }
        const { userId, boardName, runtimeIds = [] } = msg;
        // The session may not exist yet if the bridge connects before
        // onBoardInfrastructureChange has registered the board (500 ms debounce).
        // Poll for up to 3 s before giving up.
        const pollForSession = (attemptsLeft: number) => {
          if (ws.readyState !== 1 /* OPEN */) {
            return;
          }
          const session = coordinator.getBoard(userId, boardName);
          if (session) {
            session.registerBrowserSocket(ws, runtimeIds);
            return;
          }
          if (attemptsLeft <= 0) {
            const knownBoards = coordinator
              .getBoards(userId)
              .map((b) => b.boardName);
            console.warn(
              `[bridge] No session found for userId="${userId}" boardName="${boardName}" after retries. Known: [${knownBoards.join(", ")}]`,
            );
            console.log(
              `[bridge-close] Server initiating close: no session found after retries for userId="${userId}" boardName="${boardName}"`,
            );
            ws.close();
            return;
          }
          setTimeout(() => pollForSession(attemptsLeft - 1), 100);
        };
        pollForSession(30);
      });
    });
    console.log("hkp-node coordinator enabled at /coordinator");
  }

  const address = await server.start(port, host);
  console.log(`hkp-node listening on ${address.baseUrl}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
