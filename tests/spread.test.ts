import { describe, expect, it } from "vitest";

import { SpreadService } from "../src/services/spread";
import { ProcessContext, RuntimeHost } from "../src/types";

/**
 * Spread: one value in, as many out as it has items. What is worth pinning is
 * that each item goes down the rest of the board and leaves the runtime by
 * itself — that is the whole reason the service exists — and what each one
 * carries for a Gather to put the array back together.
 */

function spread(
  state: Record<string, unknown> = {},
  context: ProcessContext | null = null,
  downstream: (data: unknown) => unknown = (data) => data,
) {
  const pulled: Array<{ after: string; data: any; context: unknown }> = [];
  const emitted: Array<{ output: any; context: unknown }> = [];
  const host = {
    processFrom: async (
      after: string,
      data: unknown,
      _n: unknown,
      ctx?: ProcessContext,
    ) => {
      pulled.push({ after, data, context: ctx });
      return downstream(data);
    },
    emitResult: (output: unknown, ctx?: ProcessContext | null) =>
      emitted.push({ output, context: ctx }),
    notify: () => {},
    currentContext: () => context,
    log: () => {},
    forwardLog: () => {},
  } as unknown as RuntimeHost;
  const service = new SpreadService({
    uuid: "spread-1",
    serviceId: "spread",
    state,
  } as never);
  service.setHost(host);
  const notifications: unknown[] = [];
  return {
    service,
    pulled,
    emitted,
    notifications,
    run: (input: unknown) =>
      service.process(input, (payload) => notifications.push(payload)),
  };
}

describe("Spread", () => {
  it("sends each item on by itself, saying where it sat", async () => {
    const t = spread();

    expect(await t.run(["a", "b", "c"])).toBeNull();

    expect(t.pulled.every((p) => p.after === "spread-1")).toBe(true);
    const parts = t.emitted.map((e) => e.output);
    expect(parts.map((p) => [p.item, p.index, p.total])).toEqual([
      ["a", 0, 3],
      ["b", 1, 3],
      ["c", 2, 3],
    ]);
    // One group per array, the same for all of its items.
    expect(new Set(parts.map((p) => p.group)).size).toBe(1);
  });

  it("gives each array a group of its own", async () => {
    const t = spread();

    await t.run(["a"]);
    await t.run(["b"]);

    expect(t.emitted[0].output.group).not.toBe(t.emitted[1].output.group);
  });

  it("treats a single item as an array of one", async () => {
    const t = spread();

    await t.run({ x: 1 });

    expect(t.emitted.map((e) => e.output)).toMatchObject([
      { item: { x: 1 }, index: 0, total: 1 },
    ]);
  });

  it("reaches into a result that says more than the list", async () => {
    const t = spread({ itemsFrom: "rows" });

    await t.run({ rows: [1, 2], count: 2 });

    expect(t.emitted.map((e) => e.output.item)).toEqual([1, 2]);
  });

  it("sends nothing on for nothing", async () => {
    const t = spread();

    expect(await t.run(null)).toBeNull();
    expect(await t.run([])).toBeNull();
    expect(t.pulled).toHaveLength(0);
    expect(t.notifications).toHaveLength(0);
  });

  it("lets an item the rest of the pipeline stopped go no further", async () => {
    const t = spread({}, null, (data: any) => (data.item === "skip" ? null : data));

    await t.run(["keep", "skip", "keep too"]);

    expect(t.pulled).toHaveLength(3);
    expect(t.emitted.map((e) => e.output.item)).toEqual(["keep", "keep too"]);
  });

  it("sends every item on in the run that reached it", async () => {
    const run = { runId: "run-1", actor: { kind: "board" } } as ProcessContext;
    const t = spread({}, run);

    await t.run([1, 2]);

    expect(t.pulled.map((p) => p.context)).toEqual([run, run]);
    expect(t.emitted.map((e) => e.context)).toEqual([run, run]);
  });

  it("says how many it sent on, and keeps where they come from", async () => {
    const t = spread({ itemsFrom: "rows" });

    await t.run({ rows: [1, 2, 3] });

    expect(t.notifications).toEqual([{ lastTotal: 3 }]);
    expect(t.service.getState()).toEqual({
      bypass: false,
      itemsFrom: "rows",
      lastTotal: 3,
    });
  });

  it("passes its input through untouched when bypassed", async () => {
    const t = spread({ bypass: true });

    expect(await t.run([1, 2])).toEqual([1, 2]);
    expect(t.pulled).toHaveLength(0);
  });
});
