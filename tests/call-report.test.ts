import { describe, expect, it } from "vitest";

import {
  CALL_REPORT_LIMIT,
  PREVIEW_LENGTH,
  isTooLarge,
  reportedValue,
} from "../src/callReport";
import { HostedRuntime } from "../src/runtime";
import { HostedService, RuntimeNotification, ServiceConfiguration } from "../src/types";

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

describe("the reports a runtime sends", () => {
  /** Answers with a text of `length` characters, whatever it is given. */
  const producing = (length: number) => (config: ServiceConfiguration): HostedService => ({
    serviceId: config.serviceId,
    serviceName: "Producer",
    uuid: config.uuid,
    configure: () => ({}),
    getState: () => ({}),
    process: () => "z".repeat(length),
  });

  it("describe a value above the limit, while the run carries all of it", async () => {
    const runtime = new HostedRuntime(
      { id: "rt", name: "Rt", services: [{ serviceId: "producer", uuid: "p" }] },
      producing(CALL_REPORT_LIMIT + 1),
    );
    const reports: RuntimeNotification[] = [];

    const result = await runtime.processAt("p", "in", (n) => reports.push(n));

    expect(result).toHaveLength(CALL_REPORT_LIMIT + 1);
    const finished = reports
      .map((n) => (n.payload as any)?.__internal)
      .find((internal) => internal?.state === "call-process-finished");
    expect(finished.data.__hkpTooLarge).toMatchObject({
      type: "string",
      bytes: CALL_REPORT_LIMIT + 1,
      // Past the limit in characters already: not counted in bytes.
      exact: false,
    });
  });

  it("carry a value at the limit as it is", async () => {
    const runtime = new HostedRuntime(
      { id: "rt", name: "Rt", services: [{ serviceId: "producer", uuid: "p" }] },
      producing(CALL_REPORT_LIMIT),
    );
    const reports: RuntimeNotification[] = [];

    await runtime.processAt("p", "in", (n) => reports.push(n));

    const finished = reports
      .map((n) => (n.payload as any)?.__internal)
      .find((internal) => internal?.state === "call-process-finished");
    expect(finished.data).toHaveLength(CALL_REPORT_LIMIT);
  });
});
