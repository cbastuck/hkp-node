import { generateKeyPairSync, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticator } from "../src/auth";

/**
 * Real verification against keys a harness serves itself (`jwksUri`): what
 * lets an end-to-end run sign in an owner, a member and a stranger without
 * turning authentication off. Signature, audience and the verified-email rule
 * are all the production ones; only where the keys come from differs.
 */

const DOMAIN = "auth.invalid";
const AUDIENCE = "e2e-audience";

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...(publicKey as KeyObject).export({ format: "jwk" }), kid, use: "sig", alg: "RS256" },
  };
}

const served = keyPair("served");
const unserved = keyPair("unserved");
let server: http.Server;
let jwksUri = "";

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [served.jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/jwks.json`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function token(
  key: { kid: string; privateKey: KeyObject },
  claims: Record<string, unknown>,
  audience = AUDIENCE,
) {
  return jwt.sign(claims, key.privateKey, {
    algorithm: "RS256",
    keyid: key.kid,
    audience,
    issuer: `https://${DOMAIN}/`,
    expiresIn: 600,
  });
}

function authenticator() {
  return createAuthenticator({
    mode: "jwt",
    domain: DOMAIN,
    audience: AUDIENCE,
    jwksUri,
  });
}

describe("verifying against a harness's own signing keys", () => {
  it("identifies a person by a token signed with a served key", async () => {
    const user = await authenticator().identifyToken(
      token(served, { sub: "e2e|ana", email: "Ana@Club.example", email_verified: true }),
    );
    expect(user).toEqual({ sub: "e2e|ana", email: "ana@club.example" });
  });

  it("refuses a token signed with a key it was not served", async () => {
    expect(
      await authenticator().identifyToken(
        token(unserved, { sub: "e2e|mallory", email: "m@x.example", email_verified: true }),
      ),
    ).toBeNull();
  });

  it("still checks the audience", async () => {
    expect(
      await authenticator().identifyToken(
        token(served, { sub: "e2e|ana" }, "another-application"),
      ),
    ).toBeNull();
  });

  it("still drops an address nobody verified", async () => {
    expect(
      await authenticator().identifyToken(
        token(served, { sub: "e2e|dan", email: "dan@club.example" }),
      ),
    ).toEqual({ sub: "e2e|dan" });
  });
});
