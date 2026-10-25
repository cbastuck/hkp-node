import { describe, expect, it } from "vitest";

import { MapService } from "../src/services/map";
import { RuntimeHost, RuntimeNotification } from "../src/types";
import { SecretVault } from "../src/secrets";

function createMap(state?: Record<string, unknown>) {
  return new MapService({ serviceId: "map", uuid: "map-1", state });
}

const noopNotify = () => {};

type RecordingHost = RuntimeHost & {
  notifications: Array<{ instanceId: string; payload: unknown }>;
  logs: Array<{ level: string; event: string; data: unknown }>;
  processed: unknown[];
  results: unknown[];
};

function createHost(): RecordingHost {
  const host: RecordingHost = {
    notifications: [],
    logs: [],
    processed: [],
    results: [],
    async processFrom(
      _startAfterUuid: string,
      data: unknown,
      _onNotification: (notification: RuntimeNotification) => void,
    ) {
      host.processed.push(data);
      return data;
    },
    currentContext() {
      return null;
    },
    secrets: () => new SecretVault(),
    log(level, event, data) {
      host.logs.push({ level, event, data });
    },
    forwardLog() {},
    logSettings() {
      return { logging: false, logData: false, logLevel: "info" as const };
    },
    scope() {
      return { owner: "tester", boardName: "Board" };
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

});

/**
 * What a pass says about itself — the same in every runtime (browser Map.ts,
 * hkp-python map_service.py, hkp-rt map.h).
 */
describe("MapService — missing reads, warnings and errors", () => {
  function reported(host: RecordingHost) {
    return host.notifications.map((n) => n.payload);
  }

  it("maps a read that found nothing to null, and warns", () => {
    const map = createMap({ template: { "title=": "params.titel", "x=": "params.missing.deep" } });
    const host = createHost();
    map.setHost(host);

    expect(map.process({ title: "Hello" }, noopNotify)).toEqual({ title: null, x: null });
    expect(reported(host)).toEqual([
      { warnings: ["title: params.titel not found", "x: params.missing not found"] },
    ]);
  });

  it("does not warn about a read that a fallback covered, or a value that is null", () => {
    const map = createMap({
      template: { "slug=": "params.id || params.link", "none=": "params.none" },
    });
    const host = createHost();
    map.setHost(host);

    expect(map.process({ link: "l", none: null }, noopNotify)).toEqual({ slug: "l", none: null });
    expect(reported(host)).toEqual([]);
  });

  it("builds the template without input", () => {
    const map = createMap({ template: { "text=": "'Today is ' + string(1 + 1)" } });

    expect(map.process(undefined, noopNotify)).toEqual({ text: "Today is 2" });
  });

  it("stops the flow on a failing term, says why, and clears it once it works", () => {
    const map = createMap({ template: { "x=": "params.n.toFixed(1)" } });
    const host = createHost();
    map.setHost(host);

    expect(map.process({}, noopNotify)).toBeNull();
    expect(map.process({ n: 2 }, noopNotify)).toEqual({ x: "2.0" });
    // A failing term is the error alone: what it read is not also a warning.
    expect(reported(host)).toEqual([
      { error: "x: params.n.toFixed is not a function" },
      { error: "" },
    ]);
  });

  it("fails an array input when one element fails", () => {
    const map = createMap({ template: { "x=": "params.n.toFixed(1)" } });

    expect(map.process([{ n: 1 }, {}], noopNotify)).toBeNull();
  });

  it("says a term does not parse as soon as it is configured", () => {
    const map = createMap();
    const host = createHost();
    map.setHost(host);

    map.configure({ template: { "x=": "nope(" } });

    expect(reported(host)[1]).toEqual({
      error: expect.stringMatching(/^x: invalid expression 'nope\('/),
    });
    expect(map.process({}, noopNotify)).toBeNull();
  });

  it("names a term in a structured template by where it sits", () => {
    const map = createMap({ template: { items: [{ "title=": "params.titel" }] } });
    const host = createHost();
    map.setHost(host);

    expect(map.process({}, noopNotify)).toEqual({ items: [{ title: null }] });
    expect(reported(host)).toEqual([{ warnings: ["items.0.title: params.titel not found"] }]);
  });

  it("warns about a read through a field that is there but null", () => {
    const map = createMap({ template: { "name=": "params.author.name" } });
    const host = createHost();
    map.setHost(host);

    expect(map.process({ author: null }, noopNotify)).toEqual({ name: null });
    expect(reported(host)).toEqual([{ warnings: ["name: params.author.name not found"] }]);
  });

  it("logs a failing pass, since nobody may be watching", () => {
    const map = createMap({ template: { "x=": "params.n.toFixed(1)" } });
    const host = createHost();
    map.setHost(host);

    map.process({}, noopNotify);
    map.process({}, noopNotify);
    expect(host.logs).toEqual([
      { level: "error", event: "service.failed", data: { message: "x: params.n.toFixed is not a function" } },
      { level: "error", event: "service.failed", data: { message: "x: params.n.toFixed is not a function" } },
    ]);
  });

  it("keeps what it says in its state while it says something", () => {
    const map = createMap({ template: { "x=": "params.n.toFixed(1)" } });
    map.setHost(createHost());

    map.process({}, noopNotify);
    expect(map.getState().error).toBe("x: params.n.toFixed is not a function");

    map.configure({ template: { "x=": "params.missing" } });
    map.process({}, noopNotify);
    expect(map.getState()).not.toHaveProperty("error");
    expect(map.getState().warnings).toEqual(["x: params.missing not found"]);

    map.process({ missing: 1 }, noopNotify);
    expect(map.getState()).not.toHaveProperty("warnings");
  });

  it("names a failing term the same when configured and on a pass", () => {
    for (const [template, name] of [
      [{ "=": "bad(", "x=": "1" }, "="],
      [{ items: { "=": "bad(" }, other: [1] }, "items"],
    ] as const) {
      const map = createMap();
      const host = createHost();
      map.setHost(host);
      map.configure({ template });
      map.process({}, noopNotify);

      const errors = reported(host).filter(
        (payload) => typeof payload === "object" && payload !== null && "error" in payload,
      );
      expect(errors).toEqual([
        { error: expect.stringMatching(new RegExp(`^${name}: invalid expression 'bad\\('`)) },
      ]);
    }
  });
});

describe("MapService — lone '='", () => {
  it("is null when its read found nothing, so the flow stops", () => {
    const map = createMap({ template: { "=": "params.missing" } });

    expect(map.process({}, noopNotify)).toBeNull();
  });

  it("is its value whatever the mode", () => {
    for (const mode of ["add", "overwrite"]) {
      const map = createMap({ mode, template: { "=": { a: 1 } } });

      expect(map.process({ b: 2 }, noopNotify)).toEqual({ a: 1 });
    }
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

  it("pushes the mapped result downstream on an inject command", async () => {
    const map = createMap({ template: { "greeting=": "'hi ' + params.name" } });
    const host = createHost();
    map.setHost(host);

    map.configure({ command: { action: "inject", params: { name: "ada" } } });
    // `configure` answers with the service's state, so the push it started runs
    // on its own: an inject is a command, not a call anything waits on.
    await new Promise((resolve) => setTimeout(resolve, 0));

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
