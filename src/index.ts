#!/usr/bin/env node
// Copyright (c) 2026 cbastuck
// SPDX-License-Identifier: AGPL-3.0-only
import { createRuntimeServer } from "./server";

async function main() {
  const port = readInteger(process.env.PORT, 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const externalHost = process.env.EXTERNAL_HOST ?? "127.0.0.1";
  const allowedOrigins = process.env.ALLOWED_ORIGINS ?? "*";

  const server = createRuntimeServer({
    allowedOrigins,
    externalHost,
    host,
    name: process.env.NAME ?? "hkp-node",
  });

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