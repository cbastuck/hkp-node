import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every way out of this server goes through the egress guard (`src/egress.ts`).
 *
 * A `fetch` is covered without doing anything — the guard is the process's
 * dispatcher — so the only way to dial a destination unchecked is to open a
 * socket some other way. This reads the sources for those ways and fails on
 * one it was not told about, saying what to use instead. It reads the code
 * rather than running it, so it is a tripwire, not a proof: the backstop on a
 * hosted machine is still its firewall.
 */

const SRC = path.join(__dirname, "../src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Code with comments taken out, so that describing a call is not making it. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Ways to open a connection that the guard does not see. */
const RAW = [
  { pattern: /\b(net|tls)\.connect\(/, what: "net/tls.connect" },
  { pattern: /\bcreateConnection\(/, what: "createConnection" },
  { pattern: /\bnew (net\.)?Socket\(/, what: "new Socket" },
  { pattern: /\bhttps?\.(request|get)\(/, what: "http(s).request/get" },
  { pattern: /\bnew WebSocket\(/, what: "a WebSocket client" },
  { pattern: /\bdgram\b/, what: "UDP sockets" },
  { pattern: /from "undici"|import\("undici"\)/, what: "undici, whose dispatchers bypass the guard" },
];

/**
 * Where a raw connection is not a board's destination, and why. Each entry is
 * a decision; add one only with its reason.
 */
const EXEMPT: Record<string, { what: string; why: string }> = {
  "coordinatorLinks.ts": {
    what: "a WebSocket client",
    why: "the link to a coordinator, whose address the operator gave this server",
  },
  "egress.ts": {
    what: "undici, whose dispatchers bypass the guard",
    why: "the guard itself",
  },
};

/** Libraries that open their own socket, and must be handed the address the
 *  guard checked. */
const DIALS_ITSELF = [
  { pattern: /\bnew ImapFlow\(/, what: "ImapFlow" },
  { pattern: /\bcreateTransport\(/, what: "nodemailer's createTransport" },
];

describe("ways out of this server", () => {
  const files = sources(SRC);

  it("are all known to the egress guard", () => {
    const found: string[] = [];
    for (const file of files) {
      const name = path.relative(SRC, file);
      const text = code(file);
      for (const { pattern, what } of RAW) {
        const exempt = EXEMPT[name];
        if (pattern.test(text) && !(exempt && exempt.what === what)) {
          found.push(
            `${name} opens ${what}. Use fetch, which the guard dispatches; or, for a library that opens its own socket, connect it to reachableAddress(host) from src/egress.ts`,
          );
        }
      }
      for (const { pattern, what } of DIALS_ITSELF) {
        if (pattern.test(text) && !/\breachableAddress\(/.test(text)) {
          found.push(
            `${name} opens ${what} without asking reachableAddress(host) from src/egress.ts where to connect`,
          );
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("include no exemption for a file that no longer needs one", () => {
    for (const [name, { what }] of Object.entries(EXEMPT)) {
      const file = path.join(SRC, name);
      const pattern = RAW.find((entry) => entry.what === what)!.pattern;
      expect(fs.existsSync(file) && pattern.test(code(file)), name).toBe(true);
    }
  });
});
