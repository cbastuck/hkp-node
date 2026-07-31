import { describe, expect, it } from "vitest";

import { MapService } from "../src/services/map";
import { RuntimeHost, RuntimeNotification } from "../src/types";

function createMap(state?: Record<string, unknown>) {
  return new MapService({ serviceId: "map", uuid: "map-1", state });
}

const noopNotify = () => {};

type RecordingHost = RuntimeHost & {
  notifications: Array<{ instanceId: string; payload: unknown }>;
  processed: unknown[];
  results: unknown[];
};

function createHost(): RecordingHost {
  const host: RecordingHost = {
    notifications: [],
    processed: [],
    results: [],
    processFrom(
      _startAfterUuid: string,
      data: unknown,
      _onNotification: (notification: RuntimeNotification) => void,
    ) {
      host.processed.push(data);
      return data;
    },
    notify(payload: unknown, instanceId: string) {
      host.notifications.push({ instanceId, payload });
    },
    emitResult(output: unknown) {
      host.results.push(output);
    },
  };
  return host;
}

describe("MapService — flat templates", () => {
  it("copies static properties and evaluates dynamic terms", () => {
    const map = createMap({
      template: { label: "hello", "answer=": "params.value * 2" },
    });

    expect(map.process({ value: 21 }, noopNotify)).toEqual({
      label: "hello",
      answer: 42,
    });
  });

  it("maps to a scalar for a lone '=' key", () => {
    const map = createMap({ template: { "=": "params.value + 1" } });

    expect(map.process({ value: 1 }, noopNotify)).toBe(2);
  });

  it("nests dotted keys", () => {
    const map = createMap({
      template: { "position.x=": "params.n", "position.y": 0 },
    });

    expect(map.process({ n: 3 }, noopNotify)).toEqual({
      position: { x: 3, y: 0 },
    });
  });

  it("honours the merge modes", () => {
    const template = { "value=": "params.value * 2", extra: true };

    expect(
      createMap({ template, mode: "replace" }).process(
        { value: 2, keep: 1 },
        noopNotify,
      ),
    ).toEqual({ value: 4, extra: true });

    expect(
      createMap({ template, mode: "overwrite" }).process(
        { value: 2, keep: 1 },
        noopNotify,
      ),
    ).toEqual({ value: 4, keep: 1, extra: true });

    // add: input wins over template for keys that already exist
    expect(
      createMap({ template, mode: "add" }).process(
        { value: 2, keep: 1 },
        noopNotify,
      ),
    ).toEqual({ value: 2, keep: 1, extra: true });
  });

  it("maps each element of an array input", () => {
    const map = createMap({ template: { "n=": "params.n + 1" } });

    expect(map.process([{ n: 1 }, { n: 2 }], noopNotify)).toEqual([
      { n: 2 },
      { n: 3 },
    ]);
  });

  it("maps the array as a whole in arrayMode 'single'", () => {
    const map = createMap({
      arrayMode: "single",
      template: { "count=": "params.length" },
    });

    expect(map.process([1, 2, 3], noopNotify)).toEqual({ count: 3 });
  });

  it("returns the input unchanged when an expression fails", () => {
    const map = createMap({ template: { "x=": "params.missing.deep" } });

    expect(map.process({ value: 1 }, noopNotify)).toEqual({ value: 1 });
  });
});

describe("MapService — structured templates", () => {
  it("keeps nested objects and evaluates terms inside them", () => {
    const map = createMap({
      template: { outer: { "inner=": "params.value * 3", static: "keep" } },
    });

    expect(map.process({ value: 2 }, noopNotify)).toEqual({
      outer: { inner: 6, static: "keep" },
    });
    expect(map.getState().template).toEqual({
      outer: { "inner=": "params.value * 3", static: "keep" },
    });
  });

  it("maps an array template into an array result", () => {
    const map = createMap({
      template: [{ "role=": "'user'" }, { "text=": "params.text" }],
    });

    expect(map.process({ text: "hi" }, noopNotify)).toEqual([
      { role: "user" },
      { text: "hi" },
    ]);
  });

  it("merges a structured result with the input in overwrite mode", () => {
    const map = createMap({
      mode: "overwrite",
      template: { nested: { "a=": "params.a" } },
    });

    expect(map.process({ a: 1, keep: 2 }, noopNotify)).toEqual({
      a: 1,
      keep: 2,
      nested: { a: 1 },
    });
  });
});

describe("MapService — expression scope", () => {
  it("exposes the shared helper functions", () => {
    const map = createMap({
      template: {
        "rounded=": "round(params.value)",
        "joined=": "concat('a', 'b')",
        "total=": "sum(params.list)",
        "picked=": "find(params.list, 'item > 1')",
      },
    });

    expect(map.process({ value: 1.6, list: [1, 2, 3] }, noopNotify)).toEqual({
      rounded: 2,
      joined: "ab",
      total: 6,
      picked: 2,
    });
  });

  it("formats dates with moment-style tokens", () => {
    const map = createMap({
      template: { "date=": "reformatDate(params.d, 'YYYY-MM-DD', 'DD.MM.YYYY')" },
    });

    expect(map.process({ d: "2026-07-30" }, noopNotify)).toEqual({
      date: "30.07.2026",
    });
  });
});

describe("MapService — UI-driven behaviour", () => {
  it("learns a flat template from the incoming data in sensing mode", () => {
    const map = createMap({ sensingMode: true });

    expect(map.process({ a: { b: 1 }, c: "x" }, noopNotify)).toBeNull();

    const state = map.getState();
    expect(state.sensingMode).toBe(false);
    expect(state.template).toEqual({ "a.b": 1, c: "x" });
    expect(map.process({}, noopNotify)).toEqual({ a: { b: 1 }, c: "x" });
  });

  it("notifies the UI about template, mode and sensing changes", () => {
    const map = createMap();
    const host = createHost();
    map.setHost(host);

    map.configure({ mode: "add" });
    map.configure({ sensingMode: true });
    map.configure({ template: { "x=": "params.x" } });

    expect(host.notifications).toEqual([
      { instanceId: "map-1", payload: { mode: "add" } },
      { instanceId: "map-1", payload: { sensingMode: true } },
      { instanceId: "map-1", payload: { template: { "x=": "params.x" } } },
    ]);
  });

  it("pushes the mapped result downstream on an inject command", () => {
    const map = createMap({ template: { "greeting=": "'hi ' + params.name" } });
    const host = createHost();
    map.setHost(host);

    map.configure({ command: { action: "inject", params: { name: "ada" } } });

    expect(host.processed).toEqual([{ greeting: "hi ada" }]);
    expect(host.results).toEqual([{ greeting: "hi ada" }]);
  });

  it("does not push anything downstream when the mapping stops the flow", () => {
    const map = createMap({ sensingMode: true });
    const host = createHost();
    map.setHost(host);

    map.configure({ command: { action: "inject", params: { a: 1 } } });

    expect(host.processed).toEqual([]);
    expect(host.results).toEqual([]);
  });
});
