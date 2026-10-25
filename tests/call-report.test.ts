import { describe, expect, it } from "vitest";

import {
  CALL_REPORT_LIMIT,
  PREVIEW_LENGTH,
  isTooLarge,
  outgoingPayload,
  reportedValue,
} from "../src/callReport";

/**
 * A call report carries the value only up to a limit; above it, a description.
 * The same cases in hkp-python (test_call_report.py), hkp-rt
 * (call_report.test.cpp) and hkp-frontend (call-report.test.ts).
 */

const LIMIT = 100;

describe("a value small enough", () => {
  it("is reported as it is", () => {
    const value = { a: [1, "two", null, true] };
    expect(reportedValue(value, LIMIT)).toBe(value);
    expect(reportedValue("short", LIMIT)).toBe("short");
    expect(reportedValue(42, LIMIT)).toBe(42);
    expect(reportedValue(null, LIMIT)).toBeNull();
    expect(reportedValue(undefined, LIMIT)).toBeUndefined();
    expect(reportedValue(new Uint8Array(LIMIT), LIMIT)).toBeInstanceOf(Uint8Array);
  });

  it("is anything that is not data, which is not looked inside", () => {
    // An instance may reach a whole graph, in a cycle; none of it is a value.
    class Holder {
      self = this;
      big = "x".repeat(LIMIT * 10);
    }
    const holder = new Holder();
    expect(reportedValue(holder, LIMIT)).toBe(holder);
    expect(isTooLarge(reportedValue({ holder }, LIMIT))).toBe(false);
  });
});

describe("a value too large", () => {
  it("is a text described by its size in bytes and how it begins", () => {
    const text = "é".repeat(60); // 120 bytes in 60 characters
    expect(reportedValue(text, LIMIT)).toEqual({
      __hkpTooLarge: { type: "string", bytes: 120, exact: true, preview: text },
    });
  });

  it("is a text longer than the limit in characters, not counted further", () => {
    const reported = reportedValue("x".repeat(PREVIEW_LENGTH * 2), LIMIT);
    expect(reported).toEqual({
      __hkpTooLarge: {
        type: "string",
        bytes: PREVIEW_LENGTH * 2,
        exact: false,
        preview: "x".repeat(PREVIEW_LENGTH),
      },
    });
  });

  it("is bytes described by their size alone", () => {
    expect(reportedValue(new Uint8Array(LIMIT + 1), LIMIT)).toEqual({
      __hkpTooLarge: { type: "binary", bytes: LIMIT + 1, exact: true },
    });
  });

  it("is JSON, counted only until it passes the limit, with how it begins", () => {
    const reported = reportedValue({ items: Array.from({ length: 50 }, (_, i) => `item-${i}`) }, LIMIT);
    expect(isTooLarge(reported)).toBe(true);
    const { type, bytes, exact, preview } = (reported as any).__hkpTooLarge;
    expect({ type, exact }).toEqual({ type: "json", exact: false });
    expect(bytes).toBeGreaterThan(LIMIT);
    expect(preview.startsWith('{"items":["item-0","item-1"')).toBe(true);
  });

  it("is judged without visiting all of it", () => {
    // Ten million entries: counting every one would take far longer than this
    // test allows, and building their JSON far more memory.
    const huge = new Array(10_000_000).fill(1);
    const started = Date.now();
    const reported = reportedValue(huge);
    expect(Date.now() - started).toBeLessThan(200);
    expect((reported as any).__hkpTooLarge).toMatchObject({ type: "json", exact: false });
  });

  it("has a preview of at most its length, ending in an ellipsis", () => {
    const reported = reportedValue({ text: "y".repeat(5000) }, LIMIT) as any;
    expect(reported.__hkpTooLarge.preview).toBe(`{"text":"${"y".repeat(PREVIEW_LENGTH - 9)}…`);
  });
});

describe("a description", () => {
  it("is told apart from a value", () => {
    expect(isTooLarge({ __hkpTooLarge: { type: "json", bytes: 1, exact: false } })).toBe(true);
    expect(isTooLarge({ tooLarge: true })).toBe(false);
    expect(isTooLarge([{ __hkpTooLarge: {} }])).toBe(false);
    expect(isTooLarge(null)).toBe(false);
  });
});

describe("what leaves for a listener", () => {
  const report = (state: string, data?: unknown) => ({
    __internal: { state, ...(data !== undefined ? { data } : {}), call: 7 },
  });

  it("is only that a call happened, without Capture mode", () => {
    expect(outgoingPayload(report("call-process", { secret: 1 }), false)).toEqual({
      __internal: { state: "call-process", call: 7 },
    });
    expect(outgoingPayload(report("call-process-finished", { secret: 1 }), false)).toEqual({
      __internal: { state: "call-process-finished", call: 7 },
    });
  });

  it("says when a call passed nothing on, without Capture mode", () => {
    expect(
      outgoingPayload({ __internal: { state: "call-process-finished", data: null } }, false),
    ).toEqual({ __internal: { state: "call-process-finished", stopped: true } });
    expect(
      outgoingPayload({ __internal: { state: "call-process-finished" } }, false),
    ).toEqual({ __internal: { state: "call-process-finished", stopped: true } });
  });

  it("is the value, bounded, with Capture mode", () => {
    expect(outgoingPayload(report("call-process", { a: 1 }), true)).toEqual(
      report("call-process", { a: 1 }),
    );
    const big = "z".repeat(CALL_REPORT_LIMIT + 1);
    const carried = outgoingPayload(report("call-process-finished", big), true) as any;
    expect(carried.__internal.data.__hkpTooLarge).toMatchObject({ type: "string" });
  });

  it("is any other notification as it is", () => {
    const own = { level: 0.5 };
    expect(outgoingPayload(own, false)).toBe(own);
    const other = { __internal: { state: "something-else", data: 1 } };
    expect(outgoingPayload(other, false)).toBe(other);
  });
});
