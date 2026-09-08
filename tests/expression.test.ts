import { describe, expect, it } from "vitest";

import { compileExpression } from "../src/services/expression";
import { MapService } from "../src/services/map";

/**
 * An expression is written by a board and run by the runtime, so the evaluator
 * is the boundary between the two. These pin the boundary from both sides:
 * what a term must not be able to reach, and what a term must still be able to
 * do.
 */

function evaluate(source: string, params: unknown = {}) {
  return compileExpression(source)(params);
}

describe("what an expression cannot reach", () => {
  it("cannot climb out through a constructor", () => {
    // The classic way out of an interpreter: take any value that *is* in
    // scope, walk to its constructor, and ask that for the Function
    // constructor. Refused at the member access, so the walk never starts.
    expect(() =>
      evaluate(
        "params.text.constructor.constructor('return process')()",
        { text: "hello" },
      ),
    ).toThrow(/constructor/);

    expect(() => evaluate("params.text['constructor']", { text: "x" })).toThrow(
      /constructor/,
    );
    expect(() => evaluate("params.text[params.key]", { text: "x", key: "constructor" }))
      .toThrow(/constructor/);
    expect(() => evaluate("params.obj.__proto__", { obj: {} })).toThrow(
      /__proto__/,
    );
  });

  it("does not see the runtime it runs in", () => {
    // Not an error — simply a name nothing in scope answers to. The whole
    // scope is `params` plus the helpers.
    expect(evaluate("process")).toBeUndefined();
    expect(evaluate("require")).toBeUndefined();
    expect(evaluate("globalThis")).toBeUndefined();
    expect(evaluate("module")).toBeUndefined();
  });

  it("has no statements to smuggle anything into", () => {
    for (const source of [
      "params.x = 1", // assignment
      "(a) => a", // arrow function
      "function(){}", // function expression
      "`${params.x}`", // template string
    ]) {
      expect(() => evaluate(source, { x: 1 })).toThrow();
    }
  });

  it("refuses the same syntax the browser refuses", () => {
    // The two runtimes share one Map UI, and it validates a template with the
    // browser's parser. A term node accepted but the browser rejected would
    // make that validation a lie — which is how an object-literal template
    // came to be written and then failed on import.
    expect(() => evaluate("({ prompt: 'hi' })")).toThrow(/Unclosed/);
  });
});

describe("what an expression can still do", () => {
  it("reads its input and the helpers", () => {
    expect(evaluate("params.a + params.b", { a: 1, b: 2 })).toBe(3);
    expect(evaluate("concat('a', 'b', string(params.n))", { n: 3 })).toBe("ab3");
    expect(evaluate("sum(params.xs)", { xs: [1, 2, 3] })).toBe(6);
    expect(evaluate("params.missing || 'fallback'", {})).toBe("fallback");
    expect(evaluate("params.n > 1 ? 'many' : 'one'", { n: 2 })).toBe("many");
    expect(evaluate("[params.a, params.b]", { a: 1, b: 2 })).toEqual([1, 2]);
  });

  it("still runs a predicate over an array", () => {
    // find/filter take their predicate as an expression string, because the
    // dialect has no lambdas — so a predicate is compiled by the same parser
    // and is bounded the same way.
    expect(evaluate("filter(params.xs, 'item > 1')", { xs: [1, 2, 3] })).toEqual([
      2, 3,
    ]);
    expect(evaluate("find(params.xs, 'index === 1')", { xs: ["a", "b"] })).toBe(
      "b",
    );
    expect(() =>
      evaluate("filter(params.xs, 'item.constructor')", { xs: ["a"] }),
    ).toThrow(/constructor/);
  });

  it("reports a term that does not parse, rather than throwing on compile", () => {
    const broken = compileExpression("1 +");
    expect(() => broken({})).toThrow(/invalid expression '1 \+'/);
  });

  it("passes a non-string source through as the constant it is", () => {
    expect(compileExpression(42)({})).toBe(42);
    expect(compileExpression(null)({})).toBeNull();
  });
});

describe("a Map template that tries to escape", () => {
  it("maps nothing rather than running anything", () => {
    // Map treats a failing template as a reason to pass the input along
    // unchanged, so the board degrades to identity instead of to a shell.
    const service = new MapService({
      uuid: "m",
      serviceId: "map",
      state: {
        mode: "replace",
        template: {
          "owned=":
            "params.subject.constructor.constructor('return process.pid')()",
        },
      },
    } as never);

    const input = { subject: "Anfrage" };
    expect(service.process(input, () => {})).toEqual(input);
  });
});
