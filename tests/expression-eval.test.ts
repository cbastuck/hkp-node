import { describe, expect, it } from "vitest";

import { evaluate, parse } from "../src/expressionEval";

/**
 * The expressions a board writes, and what evaluating one may reach
 * (src/expressionEval.ts). The same cases are pinned in the browser's twin
 * (hkp-frontend .../base/tests/expressionEval.test.ts).
 */

const run = (source: string, scope: Record<string, unknown> = {}) =>
  evaluate(parse(source), scope);

describe("an expression", () => {
  it("computes what JavaScript would", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("'a' + 1")).toBe("a1");
    expect(run("7 % 4 === 3 && !false")).toBe(true);
    expect(run("x > 2 ? 'big' : 'small'", { x: 3 })).toBe("big");
    expect(run("[1, x, 3]", { x: 2 })).toEqual([1, 2, 3]);
    expect(run("-x", { x: 4 })).toBe(-4);
  });

  it("short-circuits as JavaScript does", () => {
    let called = false;
    const touch = () => {
      called = true;
      return true;
    };
    expect(run("false && touch()", { touch })).toBe(false);
    expect(run("true || touch()", { touch })).toBe(true);
    expect(called).toBe(false);
  });

  it("reads members and calls what the scope gives it", () => {
    const scope = {
      params: { name: "Ada", list: [1, 2, 3] },
      max: Math.max,
      double: (x: number) => x * 2,
    };
    expect(run("params.name", scope)).toBe("Ada");
    expect(run("params['name']", scope)).toBe("Ada");
    expect(run("params.list[1]", scope)).toBe(2);
    expect(run("params.name.toUpperCase()", scope)).toBe("ADA");
    expect(run("params.list.map(double)", scope)).toEqual([2, 4, 6]);
    expect(run("max(1, 5)", scope)).toBe(5);
  });

  it("names only what the scope owns", () => {
    expect(run("missing")).toBeUndefined();
    // Inherited from Object.prototype, and not a name here.
    expect(run("constructor")).toBeUndefined();
    expect(run("toString")).toBeUndefined();
    expect(run("hasOwnProperty")).toBeUndefined();
  });

  it("has no way from a value to the code behind it", () => {
    const scope = { x: {}, s: "text", f: () => 1 };
    for (const source of [
      "x.constructor",
      "x['constructor']",
      "x[['constructor']]",
      "s.constructor.constructor('return process')()",
      "f.constructor('return process')()",
      "f.prototype",
      "x.__proto__",
      "x['__proto__']",
      "x.__defineGetter__",
      "x.__lookupGetter__",
    ]) {
      expect(() => run(source, scope), source).toThrow(/disallowed/);
    }
  });

  it("cannot assign", () => {
    expect(() => parse("x = 1")).toThrow();
    expect(() => parse("x.y = 1")).toThrow();
  });

  it("refuses to call what is not a function", () => {
    expect(() => run("x()", { x: 1 })).toThrow(TypeError);
    expect(() => run("missing()")).toThrow(TypeError);
  });
});
