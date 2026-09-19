import { describe, expect, it } from "vitest";

import { TracksService } from "../src/services/tracks";
import { MapService } from "../src/services/map";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
} from "../src/types";

/**
 * Several pipelines over one input.
 *
 * Two things are worth pinning here and the rest follows from them: every track
 * is given the same value and none of them can see another's answer, and the
 * shape that leaves is the board's to decide rather than this service's.
 */

/** What each fake service did, in the order it happened. */
const trace: string[] = [];

/**
 * Stands in for whatever a board nests. Its state says how to behave: `answer`
 * is what it returns, `delay` how long it takes, `fail` makes it throw, and
 * `stop` makes it stop the pipeline the way any service does.
 */
function fakeService(config: ServiceConfiguration): HostedService {
  const state = (config.state ?? {}) as JsonRecord;
  if (config.serviceId === "map") {
    return new MapService(config) as unknown as HostedService;
  }
  return {
    serviceId: config.serviceId,
    serviceName: "Fake",
    uuid: config.uuid,
    configure: () => state,
    getState: () => state,
    process: async (input: unknown) => {
      trace.push(`${config.uuid}:start`);
      await new Promise((resolve) => setTimeout(resolve, (state.delay as number) ?? 1));
      trace.push(`${config.uuid}:end`);
      if (state.fail) {
        throw new Error("no good");
      }
      if (state.stop) {
        return null;
      }
      return state.answer !== undefined ? state.answer : { saw: input };
    },
  };
}

let built = 0;

function creator(config: ServiceConfiguration): HostedService {
  built += 1;
  return fakeService(config);
}

function hostFor(): RuntimeHost {
  return {
    processFrom: () => null,
    notify: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => ({ owner: "tester", boardName: "Board" }),
    emitResult: () => {},
  } as unknown as RuntimeHost;
}

/** One service per track, named after the track, so the trace reads plainly. */
function track(name: string, state: JsonRecord = {}) {
  return {
    name,
    pipeline: [{ serviceId: "fake", uuid: name, state }],
  };
}

function tracks(state: Record<string, unknown>) {
  const service = new TracksService(
    { uuid: "tracks-1", serviceId: "tracks", state } as never,
    creator,
  );
  service.setHost(hostFor());
  return service;
}

const noop = () => {};

describe("tracks", () => {
  it("gives every track the same input and answers in declaration order", async () => {
    const service = tracks({ tracks: [track("keep"), track("drop")] });

    expect(await service.process({ intent: "keep" }, noop)).toEqual([
      { saw: { intent: "keep" } },
      { saw: { intent: "keep" } },
    ]);
  });

  it("leaves a hole where a track stopped, rather than leaving it out", async () => {
    // Position still names the track that produced it, so a missing answer is
    // visible rather than absent.
    const service = tracks({
      tracks: [track("keep", { stop: true }), track("drop", { answer: { rows: 1 } })],
    });

    expect(await service.process({}, noop)).toEqual([null, { rows: 1 }]);
  });

  it("runs one track at a time by default", async () => {
    trace.length = 0;
    const service = tracks({
      tracks: [track("first", { delay: 8 }), track("second", { delay: 1 })],
    });

    await service.process({}, noop);

    expect(trace).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("overlaps them when asked, and still answers in declaration order", async () => {
    trace.length = 0;
    const service = tracks({
      run: "parallel",
      tracks: [
        track("slow", { delay: 8, answer: "slow" }),
        track("quick", { delay: 1, answer: "quick" }),
      ],
    });

    const answers = await service.process({}, noop);

    // Both started before either finished — that is the whole point of asking.
    expect(trace.slice(0, 2)).toEqual(["slow:start", "quick:start"]);
    // How they ran is not something the next service should be able to tell.
    expect(answers).toEqual(["slow", "quick"]);
  });

  it("hands the reducer what came in beside what the tracks answered", async () => {
    const service = tracks({
      tracks: [track("keep", { answer: { rows: 1 } })],
      reduce: [
        {
          serviceId: "map",
          uuid: "shape",
          state: { mode: "replace", template: { "wrote=": "params.results[0].rows", "for=": "params.input.link" } },
        },
      ],
    });

    expect(await service.process({ link: "https://example.test" }, noop)).toEqual({
      wrote: 1,
      for: "https://example.test",
    });
  });

  it("carries the input on in one term, for tracks that were side effects", async () => {
    const service = tracks({
      tracks: [track("keep", { answer: { changes: 1 } }), track("drop", { stop: true })],
      reduce: [
        {
          serviceId: "map",
          uuid: "carry",
          state: { mode: "replace", template: { "=": "params.input" } },
        },
      ],
    });

    const input = { intent: "keep", link: "https://example.test" };
    expect(await service.process(input, noop)).toEqual(input);
  });

  it("stops the pipeline when the reducer says so, and not before", async () => {
    // An array of nothing but nulls is still an array; whether that means stop
    // is the board's to say.
    const silent = tracks({ tracks: [track("a", { stop: true }), track("b", { stop: true })] });
    expect(await silent.process({}, noop)).toEqual([null, null]);

    const service = tracks({
      tracks: [track("a", { stop: true })],
      reduce: [
        {
          serviceId: "map",
          uuid: "decide",
          state: { mode: "replace", template: { "=": "params.results[0]" } },
        },
      ],
    });
    expect(await service.process({}, noop)).toBeNull();
  });

  it("keeps the other tracks when one throws", async () => {
    const service = tracks({
      tracks: [track("broken", { fail: true }), track("fine", { answer: "ok" })],
    });

    expect(await service.process({}, noop)).toEqual([null, "ok"]);
    expect(service.getState().error).toMatch(/track 'broken' failed/);
  });

  it("passes its input through when bypassed, and holes for a bypassed track", async () => {
    const whole = tracks({ bypass: true, tracks: [track("keep")] });
    expect(await whole.process({ a: 1 }, noop)).toEqual({ a: 1 });

    const one = tracks({
      tracks: [{ ...track("keep"), bypass: true }, track("drop", { answer: "ran" })],
    });
    expect(await one.process({}, noop)).toEqual([null, "ran"]);
  });

  it("keeps a track's services when a track beside it is edited", async () => {
    // Rebuilding a pipeline destroys what is running inside it — a mount, a
    // timer — so an edit to one track must not touch another.
    built = 0;
    const service = tracks({ tracks: [track("keep"), track("drop")] });
    expect(built).toBe(2);

    service.configure({ tracks: [track("keep"), track("drop"), track("tell")] });

    expect(built).toBe(3);
    expect((service.getState().tracks as unknown[]).length).toBe(3);
  });

  it("refuses a track called after the reducer, or two with one name", () => {
    expect(() => tracks({ tracks: [track("reduce")] })).toThrow(/reducer/);
    expect(() => tracks({ tracks: [track("keep"), track("keep")] })).toThrow(/both called/);
  });
});
