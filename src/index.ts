#!/usr/bin/env node
// Copyright (c) 2026 cbastuck
// SPDX-License-Identifier: AGPL-3.0-only
import path from "path";
import { config as loadEnv } from "dotenv";
import { createRuntimeServer } from "./server";
import { createCoordinatorRouter } from "./coordinator";
import { AllowedOrigins, AuthConfig, isLoopbackHost } from "./auth";

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
  });

  if (coordinatorEnabled) {
    const { router: coordinatorRouter, coordinator } = createCoordinatorRouter({
      auth: authConfig,
    });
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
  const audience = process.env.AUTH0_AUDIENCE;
  const allowedEmails = parseAllowedEmails(process.env.ALLOWED_EMAILS);
  if (domain && audience) {
    if (allowedEmails) {
      console.log(
        `[hkp-node] Access restricted to ${allowedEmails.length} allowlisted email(s).`,
      );
    }
    return { mode: "jwt", domain, audience, allowedEmails };
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
