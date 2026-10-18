#!/usr/bin/env node
// Copyright (c) 2026 cbastuck
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { config as loadEnv } from "dotenv";
import { createRuntimeServer } from "./server";
import {
  BoardCoordinator,
  SHARED_BOARDS_PATH,
  attachCoordinatorJoin,
  createBridgeHandler,
  createCoordinatorRouter,
} from "./coordinator";
import { createFileBoardStore } from "./coordinator/fileBoardStore";
import { createFileLogStore } from "./coordinator/logStore";
import { AuthConfig, isLoopbackHost } from "./auth";
import { parseAllowedOrigins } from "./origins";
import { readEgressPolicy, setEgressPolicy } from "./egress";
import {
  InstanceError,
  acquireInstanceLock,
  legacyState,
  resolveInstance,
} from "./instance";
import { describeReset, resetInstance } from "./reset";

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
function resolveMountSecret(file: string): string {
  if (process.env.HKP_MOUNT_SECRET) {
    return process.env.HKP_MOUNT_SECRET;
  }
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

/** The settings this server is started with: the environment, then `.env`. */
function loadEnvironment(): void {
  if (!process.env.SKIP_LOADING_ENV) {
    loadEnv({ path: path.join(__dirname, "..", ".env") });
  }
}

/**
 * `hkp-node reset [--yes] [--all]`: moves this instance's folder aside so the
 * next start begins empty. The instance is the one the server would start as
 * — the same environment, the same `.env` — so a reset reaches exactly what
 * that server keeps, and nothing of another. See reset.ts.
 */
function reset(args: string[]): void {
  loadEnvironment();
  const known = new Set(["--yes", "--all"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length) {
    console.error(
      `[hkp-node] reset does not know ${unknown.join(", ")}. ` +
        "Usage: hkp-node reset [--yes] [--all]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const instance = resolveInstance(process.env.HKP_INSTANCE);
    const outcome = resetInstance(instance, {
      apply: args.includes("--yes"),
      includeMountSecret: args.includes("--all"),
    });
    console.log(describeReset(instance, outcome));
  } catch (error) {
    // Every failure ends here rather than at the process's handler below,
    // which keeps a server serving and would let a failed reset exit 0.
    console.error(
      error instanceof InstanceError ? `[hkp-node] ${error.message}` : error,
    );
    process.exitCode = 1;
  }
}

async function main() {
  loadEnvironment();

  const port = readInteger(process.env.PORT, 8080);

  // Which server this is, before anything is read from or written to disk:
  // every default location below is inside its folder. See instance.ts.
  let instance;
  try {
    instance = resolveInstance(process.env.HKP_INSTANCE);
    const release = acquireInstanceLock(instance, { port });
    process.on("exit", release);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        release();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  } catch (error) {
    if (error instanceof InstanceError) {
      console.error(`[hkp-node] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const instanceDir = instance.dir;
  console.log(`hkp-node instance "${instance.name}": ${instanceDir}`);
  const legacy = legacyState();
  if (legacy.length) {
    console.warn(
      "[hkp-node] Found state from before servers were named instances, " +
        `which is no longer read:\n  ${legacy.join("\n  ")}\n` +
        `Move what this server should keep into ${instanceDir} — its mount ` +
        "secret too, or its public endpoint addresses change — or delete it.",
    );
  }
  const host = process.env.HOST ?? "0.0.0.0";
  const externalHost = process.env.EXTERNAL_HOST ?? "127.0.0.1";
  const externalSecure = process.env.EXTERNAL_SECURE === "true";
  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const coordinatorEnabled = process.env.COORDINATOR_ENABLED === "true";
  const authConfig = resolveServerAuthConfig(host);
  // Before anything can dial out: a hosted server reaches only public
  // addresses on a board's behalf (egress.ts).
  const egress = readEgressPolicy(process.env);
  await setEgressPolicy(egress);
  if (egress.mode === "public") {
    console.log(
      `[hkp-node] HKP_EGRESS=public: boards reach public addresses only` +
        (egress.allow.length
          ? `, and ${egress.allow.length} allowed address${egress.allow.length === 1 ? "" : "es"} or range${egress.allow.length === 1 ? "" : "s"}`
          : ""),
    );
  }
  const storeDir = process.env.HKP_STORE_DIR ?? path.join(instanceDir, "store");

  const server = createRuntimeServer({
    auth: authConfig,
    allowedOrigins,
    externalHost,
    externalSecure,
    host,
    // What clients are told this server is called: the instance's name,
    // unless it is meant to be shown as something else.
    name: process.env.NAME ?? instance.name,
    // Keeps public endpoint addresses the same across restarts; see
    // MountRegistry. Without a stable key every restart hands every webhook
    // configured elsewhere a dead URL.
    mountSecret: resolveMountSecret(path.join(instanceDir, "mount-secret")),
    // What boards remember between runs. On by default, because a `store` that
    // silently forgot everything on restart would be worse than one that is not
    // there: HKP_STORE_DIR="" keeps records in memory instead.
    recordStore: storeDir,
    // Where a board's SQL tables live. Persisted for the same reason records
    // are: HKP_DB_DIR="" keeps them in memory instead.
    database: process.env.HKP_DB_DIR ?? path.join(instanceDir, "db"),
    // Where the bytes a board keeps are written. Persisted for the same reason,
    // and a real directory rather than a derived one all the way down: what is
    // here is meant to be findable, copyable and servable by its owner.
    // HKP_FILES_DIR="" keeps them in memory instead.
    files: process.env.HKP_FILES_DIR ?? path.join(instanceDir, "files"),
    // The tickets this server reconnects to coordinators with, beside the
    // mount secret. HKP_COORDINATOR_LINKS_FILE="" keeps them in memory, so a
    // restart leaves every deployed board waiting to be deployed again.
    coordinatorLinks:
      process.env.HKP_COORDINATOR_LINKS_FILE ??
      path.join(instanceDir, "coordinator-links.json"),
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
      // Unset or 0 keeps the server's own default.
      maxInlineAssetBytes: readInteger(process.env.HKP_MAX_INLINE_ASSET_BYTES, 0),
      maxAssetRequestBodyBytes: readInteger(
        process.env.HKP_MAX_ASSET_REQUEST_BODY_BYTES,
        0,
      ),
    },
  });

  if (coordinatorEnabled) {
    // A coordinator that forgot its boards whenever it restarted would be a
    // coordinator you could not restart, so this is on unless it is pointed at
    // nowhere: HKP_COORDINATOR_DATA_DIR="" keeps the boards in memory.
    const dataDir =
      process.env.HKP_COORDINATOR_DATA_DIR ??
      path.join(instanceDir, "coordinator", "boards");
    // Beside the boards, and governed by the same switch: a coordinator told to
    // keep nothing on disk keeps no log either, and one that persists boards
    // records what they did. Entries carry board data, so createFileLogStore
    // gives them the board store's own per-user, owner-only posture.
    const logDir =
      process.env.HKP_COORDINATOR_LOG_DIR ??
      (dataDir ? path.join(path.dirname(dataDir), "logs") : "");
    const { router: coordinatorRouter, coordinator } = createCoordinatorRouter({
      auth: authConfig,
      // One verifier for the server and what is mounted on it.
      authenticator: server.authenticator,
      coordinator: dataDir
        ? new BoardCoordinator(
            createFileBoardStore(dataDir),
            logDir ? createFileLogStore(logDir) : undefined,
            undefined,
            {
              maxFrameBytes:
                readInteger(process.env.HKP_COORDINATOR_MAX_FRAME_BYTES, 0) ||
                undefined,
              // What sharing a board may cost this coordinator. Unset keeps
              // the defaults in coordinator/members.ts.
              maxMembersPerBoard:
                readInteger(process.env.HKP_COORDINATOR_MAX_MEMBERS, 0) ||
                undefined,
              maxBridgesPerMember:
                readInteger(process.env.HKP_COORDINATOR_MAX_MEMBER_BRIDGES, 0) ||
                undefined,
              maxMemberProcessPerMinute:
                readInteger(
                  process.env.HKP_COORDINATOR_MAX_MEMBER_PROCESS_PER_MINUTE,
                  0,
                ) || undefined,
              maxPersonRunAgeMs:
                readInteger(
                  process.env.HKP_COORDINATOR_MAX_PERSON_RUN_AGE_MS,
                  0,
                ) || undefined,
            },
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
    // Where runtime servers connect in with their tickets. The coordinator
    // reaches a board's runtimes over those connections and no other way.
    attachCoordinatorJoin(server, coordinator);
    // The one route of a coordinator open to somebody the server's allowlist
    // does not name: a member asking which boards are shared with them.
    server.addSelfAuthenticatedRoute(
      "GET",
      `/coordinator${SHARED_BOARDS_PATH}`,
    );
    // A browser attaching to a board: its owner, or somebody on its list.
    server.setBridgeUpgradeHandler(
      createBridgeHandler(coordinator, { authMode: authConfig.mode }),
    );
    console.log("hkp-node coordinator enabled at /coordinator");
  }

  const address = await server.start(port, host);
  // Once this server is listening: a coordinator it reconnects to may build a
  // runtime at once, and that runtime's mounts need an address to publish.
  server.coordinatorLinks.restore();
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

if (process.argv[2] === "reset") {
  reset(process.argv.slice(3));
} else {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

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
