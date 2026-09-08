#!/usr/bin/env node
// Copyright (c) 2026 cbastuck
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { config as loadEnv } from "dotenv";
import { createRuntimeServer } from "./server";
import { BoardCoordinator, createCoordinatorRouter } from "./coordinator";
import { createFileBoardStore } from "./coordinator/fileBoardStore";
import { createFileLogStore } from "./coordinator/logStore";
import { AllowedOrigins, AuthConfig, isLoopbackHost } from "./auth";

/**
 * The key public mount addresses are derived from.
 *
 * Taken from the environment where there is one, so a deployment can hold it
 * with its other secrets and several instances behind a load balancer agree on
 * the addresses they serve. Otherwise drawn once and kept beside the rest of
 * this runtime's data, because the alternative — a fresh key per start — is
 * what makes an endpoint configured in somebody else's product stop working
 * after a restart.
 */
function resolveMountSecret(): string {
  if (process.env.HKP_MOUNT_SECRET) {
    return process.env.HKP_MOUNT_SECRET;
  }
  const file = path.join(os.homedir(), ".hkp", "node", "mount-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Not written yet, which is the first start on this machine.
  }
  const secret = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(
      "[hkp-node] Could not persist the mount secret, so public endpoint " +
        "addresses will change on restart:",
      err instanceof Error ? err.message : err,
    );
  }
  return secret;
}

async function main() {
  if (!process.env.SKIP_LOADING_ENV) {
    loadEnv({ path: path.join(__dirname, "..", ".env") });
  }

  const port = readInteger(process.env.PORT, 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const externalHost = process.env.EXTERNAL_HOST ?? "127.0.0.1";
  const externalSecure = process.env.EXTERNAL_SECURE === "true";
  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const coordinatorEnabled = process.env.COORDINATOR_ENABLED === "true";
  const authConfig = resolveServerAuthConfig(host);

  const server = createRuntimeServer({
    auth: authConfig,
    allowedOrigins,
    externalHost,
    externalSecure,
    host,
    name: process.env.NAME ?? "hkp-node",
    // Keeps public endpoint addresses the same across restarts; see
    // MountRegistry. Without a stable key every restart hands every webhook
    // configured elsewhere a dead URL.
    mountSecret: resolveMountSecret(),
    // What boards remember between runs. On by default, because a `store` that
    // silently forgot everything on restart would be worse than one that is not
    // there: HKP_STORE_DIR="" keeps records in memory instead.
    recordStore:
      process.env.HKP_STORE_DIR ??
      path.join(os.homedir(), ".hkp", "node", "store"),
    // Where a board's SQL tables live. Persisted for the same reason records
    // are: HKP_DB_DIR="" keeps them in memory instead.
    database:
      process.env.HKP_DB_DIR ?? path.join(os.homedir(), ".hkp", "node", "db"),
    quotas: {
      maxRuntimesPerUser: readInteger(process.env.HKP_MAX_RUNTIMES_PER_USER, 0),
      maxServicesPerRuntime: readInteger(
        process.env.HKP_MAX_SERVICES_PER_RUNTIME,
        0,
      ),
      minTimerIntervalMs: readInteger(process.env.HKP_MIN_TIMER_INTERVAL_MS, 0),
      // Undefined keeps the server's own default; an explicit 0 disables.
      maxRequestBodyBytes: process.env.HKP_MAX_REQUEST_BODY_BYTES
        ? readInteger(process.env.HKP_MAX_REQUEST_BODY_BYTES, 0)
        : undefined,
    },
  });

  if (coordinatorEnabled) {
    // A coordinator that forgot its boards whenever it restarted would be a
    // coordinator you could not restart, so this is on unless it is pointed at
    // nowhere: HKP_COORDINATOR_DATA_DIR="" keeps the boards in memory.
    const dataDir =
      process.env.HKP_COORDINATOR_DATA_DIR ??
      path.join(os.homedir(), ".hkp", "coordinator", "boards");
    // Beside the boards, and governed by the same switch: a coordinator told to
    // keep nothing on disk keeps no log either, and one that persists boards
    // records what they did. Entries carry board data, so createFileLogStore
    // gives them the board store's own per-user, owner-only posture.
    const logDir =
      process.env.HKP_COORDINATOR_LOG_DIR ??
      (dataDir ? path.join(path.dirname(dataDir), "logs") : "");
    const { router: coordinatorRouter, coordinator } = createCoordinatorRouter({
      auth: authConfig,
      coordinator: dataDir
        ? new BoardCoordinator(
            createFileBoardStore(dataDir),
            logDir ? createFileLogStore(logDir) : undefined,
          )
        : undefined,
    });
    // Before the server listens: until this finishes the coordinator would tell
    // a browser the user has no boards, which is not the same as not answering.
    await coordinator.restore();
    if (dataDir) {
      console.log(
        `hkp-node coordinator boards: ${dataDir} (${coordinator.getBoardCount()} restored)`,
      );
    }
    if (logDir) {
      console.log(`hkp-node coordinator board logs: ${logDir}`);
    }
    server.expressApp.use("/coordinator", coordinatorRouter);
    server.setBridgeUpgradeHandler((ws, user) => {
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

        // A browser may only bridge its own board. In no-auth dev mode there is
        // no real identity, so this is only enforced under JWT auth.
        if (authConfig.mode === "jwt" && user.sub !== userId) {
          console.warn(
            `[bridge] Authenticated user "${user.sub}" may not bridge board for userId="${userId}" — closing`,
          );
          ws.close();
          return;
        }
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
  const storeDir =
    process.env.HKP_STORE_DIR ?? path.join(os.homedir(), ".hkp", "node", "store");
  console.log(
    storeDir
      ? `hkp-node board store: ${storeDir}`
      : "hkp-node board store: in memory (records are lost on restart)",
  );
  console.log(`hkp-node listening on ${address.baseUrl}`);
}

/**
 * One runtime hosts every board on this machine, so a stray asynchronous failure
 * inside one service — a socket error nobody listened for, a promise nobody
 * awaited — must not be the end of all the others. Report it and keep serving.
 * Anything a caller can actually be told about is still handled where it happens;
 * this is only the floor under the cases that reach the process.
 */
process.on("uncaughtException", (error) => {
  console.error("[hkp-node] Uncaught exception — continuing:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[hkp-node] Unhandled rejection — continuing:", reason);
});

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

/**
 * Accepted `aud` values, comma-separated. Several is the normal case: the web
 * and native apps are necessarily separate Auth0 applications, so the id_tokens
 * they issue carry different client ids while both address this one runtime.
 */
function parseAudiences(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((audience) => audience.trim())
    .filter(Boolean);
}

function parseAllowedEmails(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const emails = value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return emails.length ? emails : undefined;
}

function parseAllowedOrigins(value: string | undefined): AllowedOrigins {
  if (!value || value.trim() === "*") {
    return "*";
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * A development checkout runs from the source tree; the published package runs
 * from inside node_modules. Only the former may opt out of authentication.
 */
function isDevCheckout(): boolean {
  return !__dirname.split(path.sep).includes("node_modules");
}

/**
 * Fail closed: refuse to start without authentication unless the server is
 * reachable only locally (loopback bind) or this is a local checkout that
 * explicitly opts in via ALLOW_NO_AUTH=true. The npm package bound to a public
 * interface can never reach no-auth mode.
 */
function resolveServerAuthConfig(host: string): AuthConfig {
  const domain = process.env.AUTH0_DOMAIN;
  const audiences = parseAudiences(process.env.AUTH0_AUDIENCE);
  const allowedEmails = parseAllowedEmails(process.env.ALLOWED_EMAILS);
  if (domain && audiences.length) {
    if (allowedEmails) {
      console.log(
        `[hkp-node] Access restricted to ${allowedEmails.length} allowlisted email(s).`,
      );
    }
    return { mode: "jwt", domain, audience: audiences, allowedEmails };
  }

  // An allowlist without JWT auth cannot be enforced; starting anyway would
  // silently grant access to everyone the operator meant to exclude.
  if (allowedEmails) {
    console.error(
      "[hkp-node] ALLOWED_EMAILS is set but AUTH0_DOMAIN/AUTH0_AUDIENCE are not. " +
        "The email allowlist can only be enforced with Auth0 configured — refusing to start.",
    );
    process.exit(1);
  }

  if (isLoopbackHost(host)) {
    console.warn(
      `[hkp-node] No Auth0 configured; bound to loopback (${host}), so the server ` +
        "is reachable only from this machine. Running without authentication.",
    );
    return { mode: "none" };
  }

  if (isDevCheckout() && process.env.ALLOW_NO_AUTH === "true") {
    console.warn(
      "[hkp-node] AUTH0_DOMAIN/AUTH0_AUDIENCE not set and ALLOW_NO_AUTH=true — running " +
        `with NO AUTHENTICATION on a non-loopback bind (${host}). Local development only; never expose this.`,
    );
    return { mode: "none" };
  }

  console.error(
    `[hkp-node] Refusing to start without authentication on a non-loopback bind (${host}). ` +
      "Set AUTH0_DOMAIN and AUTH0_AUDIENCE, bind to 127.0.0.1 for local-only use, or " +
      "(from a checkout) set ALLOW_NO_AUTH=true.",
  );
  process.exit(1);
}
