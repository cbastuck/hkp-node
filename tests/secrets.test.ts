import { describe, expect, it } from "vitest";

import {
  SecretVault,
  destinationHost,
  readSecretsPayload,
  referencedSecrets,
} from "../src/secrets";

/**
 * What a runtime does with the values it was given.
 *
 * They arrive apart from every service's state and leave only through
 * `resolve`, for one use, named destination first. Nothing else can reach
 * them — which is what lets a service hold a reference and report it back.
 */

function vaultOf(entries: Record<string, { value: string; audience?: string[] }>) {
  const vault = new SecretVault();
  vault.replace(entries);
  return vault;
}

describe("resolving for one use", () => {
  it("substitutes a value the runtime was given", () => {
    const { value, missing, refused } = vaultOf({
      mail: { value: "hunter2" },
    }).resolve({ pass: "{{secret.mail}}" }, { to: "imap.example.com:993" });

    expect(value).toEqual({ pass: "hunter2" });
    expect(missing).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("substitutes inside a larger string and anywhere in a structure", () => {
    const { value } = vaultOf({ api: { value: "sk-1" } }).resolve(
      { headers: { Authorization: "Bearer {{secret.api}}" } },
      { to: "https://api.example.com/v1" },
    );

    expect(value).toEqual({ headers: { Authorization: "Bearer sk-1" } });
  });

  it("resolves an alias it was not given to empty, and names it", () => {
    const { value, missing } = vaultOf({}).resolve(
      { pass: "{{secret.absent}}" },
      { to: "example.com" },
    );

    expect(value).toEqual({ pass: "" });
    expect(missing).toEqual(["absent"]);
  });

  it("leaves a value with no references alone", () => {
    const { value } = vaultOf({}).resolve("literal", { to: "example.com" });

    expect(value).toBe("literal");
  });

  it("requires a destination", () => {
    const vault = vaultOf({ mail: { value: "hunter2" } });

    expect(() => vault.resolve("{{secret.mail}}", { to: "" })).toThrow(
      /destination/,
    );
    expect(() => vault.resolve("{{secret.mail}}", undefined as never)).toThrow(
      /destination/,
    );
  });
});

describe("audience", () => {
  it("releases a secret to a host it is bound to", () => {
    const { value, refused } = vaultOf({
      slack: { value: "xoxb", audience: ["hooks.slack.com"] },
    }).resolve("{{secret.slack}}", { to: "https://hooks.slack.com/services/x" });

    expect(value).toBe("xoxb");
    expect(refused).toEqual([]);
  });

  it("withholds it from anywhere else, and says so", () => {
    const { value, refused } = vaultOf({
      slack: { value: "xoxb", audience: ["hooks.slack.com"] },
    }).resolve("{{secret.slack}}", { to: "https://evil.example/?p=1" });

    expect(value).toBe("");
    expect(refused).toEqual([
      { alias: "slack", to: "evil.example", audience: ["hooks.slack.com"] },
    ]);
  });

  it("treats an entry with no audience as unconstrained", () => {
    const { value } = vaultOf({ any: { value: "v" } }).resolve(
      "{{secret.any}}",
      { to: "https://anywhere.example" },
    );

    expect(value).toBe("v");
  });

  it("matches a subdomain wildcard but not the bare domain", () => {
    const vault = vaultOf({ k: { value: "v", audience: ["*.example.com"] } });

    expect(vault.resolve("{{secret.k}}", { to: "api.example.com" }).value).toBe("v");
    expect(vault.resolve("{{secret.k}}", { to: "example.com" }).refused).toHaveLength(1);
  });
});

describe("what the vault will say about itself", () => {
  it("names the aliases it holds and nothing else", () => {
    const vault = vaultOf({ a: { value: "1" }, b: { value: "2" } });

    expect(vault.aliases().sort()).toEqual(["a", "b"]);
    expect(JSON.stringify(vault)).not.toContain("1");
  });

  it("merges a partial push without stripping the rest", () => {
    const vault = vaultOf({ a: { value: "1" }, b: { value: "2" } });
    vault.merge({ b: { value: "changed" } });

    expect(vault.resolve("{{secret.a}} {{secret.b}}", { to: "x.example" }).value)
      .toBe("1 changed");
  });
});

describe("reading a payload off the wire", () => {
  it("accepts a bare string as a value with no audience", () => {
    expect(readSecretsPayload({ a: "v" })).toEqual({ a: { value: "v" } });
  });

  it("accepts the long form and keeps the audience", () => {
    expect(readSecretsPayload({ a: { value: "v", audience: ["h.example"] } }))
      .toEqual({ a: { value: "v", audience: ["h.example"] } });
  });

  it("drops what it cannot read rather than failing the request", () => {
    expect(
      readSecretsPayload({ a: { audience: ["x"] }, b: 7, c: null, d: "ok" }),
    ).toEqual({ d: { value: "ok" } });
    expect(readSecretsPayload("nonsense")).toEqual({});
    expect(readSecretsPayload(undefined)).toEqual({});
  });
});

describe("naming what a board asks for", () => {
  it("finds every alias, however nested", () => {
    expect(
      referencedSecrets({
        a: "{{secret.one}}",
        b: [{ c: "x {{ secret.two }} y" }],
        d: "{{secret.one}}",
      }).sort(),
    ).toEqual(["one", "two"]);
  });

  it("reads a host out of whatever shape a caller holds", () => {
    expect(destinationHost("https://api.example.com/v1?q=1")).toBe("api.example.com");
    expect(destinationHost("imap.example.com:993")).toBe("imap.example.com");
    expect(destinationHost("API.Example.COM")).toBe("api.example.com");
    expect(destinationHost("")).toBe(null);
  });
});
