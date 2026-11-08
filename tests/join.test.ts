import { describe, expect, it } from "vitest";

import { JoinService } from "../src/services/join";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
} from "../src/types";

/**
 * The carrier must survive the detour. Everything here is a variation on that
 * one question: what does the pipeline still know after a nested service
 * replaced its input?
 */

/** Stands in for whatever a board nests; its state says what it answers. */
function fakeService(config: ServiceConfiguration): HostedService {
  const state = config.state ?? {};
  return {
    serviceId: config.serviceId,
    serviceName: "Fake",
    uuid: config.uuid,
    configure: () => state,
    getState: () => state,
    process: async () => {
      // Answering after a turn of the event loop is what a real detour does —
      // an HTTP call, a model. The Join must merge that answer, not miss it.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return state.answers === undefined ? { text: "answer" } : state.answers;
    },
  };
}

function hostFor() {
  return {
    processFrom: () => null,
    notify: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => ({ owner: "tester", boardName: "SYN" }),
    emitResult: () => {},
  } as unknown as RuntimeHost;
}

function join(state: Record<string, unknown> = {}, nested: JsonRecord = {}) {
  const service = new JoinService(
    {
      uuid: "join-1",
      serviceId: "join",
      state: {
        pipeline: [{ serviceId: "fake", uuid: "inner-1", state: nested }],
        ...state,
      },
    } as never,
    fakeService,
  );
  service.setHost(hostFor());
  return (input: unknown) => service.process(input, () => {});
}

describe("keeping what the input was carrying", () => {
  it("puts the answer beside it, under a name", async () => {
    // The shape the board uses: a conversation goes in, an extraction comes
    // back, and the conversation id is still there to file it under.
    const run = join(
      { as: "extraction" },
      { answers: { json: { rooms: 2 }, model: "qwen" } },
    );

    expect(await run({ conversationId: "a@x", emails: [], count: 0 })).toEqual({
      conversationId: "a@x",
      emails: [],
      count: 0,
      extraction: { json: { rooms: 2 }, model: "qwen" },
    });
  });

  it("merges at the top level when no name is given", async () => {
    const run = join({}, { answers: { text: "hi", model: "qwen" } });

    expect(await run({ conversationId: "a@x" })).toEqual({
      conversationId: "a@x",
      text: "hi",
      model: "qwen",
    });
  });

  it("lets the nested answer win a collision, or not", async () => {
    const overwrite = join({}, { answers: { text: "the answer" } });
    expect(await overwrite({ text: "the question" })).toEqual({ text: "the answer" });

    const add = join({ mode: "add" }, { answers: { text: "the answer" } });
    expect(await add({ text: "the question" })).toEqual({ text: "the question" });
  });

  it("cannot collide at all under a name", async () => {
    // Which is why `as` is the safe way to use it.
    const run = join({ as: "result" }, { answers: { text: "the answer" } });

    expect(await run({ text: "the question" })).toEqual({
      text: "the question",
      result: { text: "the answer" },
    });
  });
});

describe("when the detour produces nothing", () => {
  it("stops, rather than looking like a merge that worked", async () => {
    // The merge is why the Join is there. Passing the input through would hand
    // whatever files the result an input that says it has an extraction and
    // does not — which is how an empty payload gets filed under a name that
    // claims otherwise.
    const run = join({ as: "extraction" }, { answers: null });

    expect(await run({ conversationId: "a@x" })).toBeNull();
  });

  it("waits for a detour that answers late", async () => {
    // The case the board is built on: `text-generation` takes seconds, and the
    // conversation id has to still be there when it answers. The runtime awaits
    // each service, so the Join awaits its nested pipeline and the merge holds
    // however long the detour takes.
    const run = join({ as: "extraction" }, { answers: { json: { rooms: 2 } } });

    expect(await run({ conversationId: "a@x", emails: [] })).toEqual({
      conversationId: "a@x",
      emails: [],
      extraction: { json: { rooms: 2 } },
    });
  });
});

describe("shapes that have no fields to merge", () => {
  it("keeps a scalar input beside a named result", async () => {
    const run = join({ as: "result" }, { answers: { text: "hi" } });

    expect(await run("a@x")).toEqual({ input: "a@x", result: { text: "hi" } });
  });

  it("says which side wins rather than losing one quietly", async () => {
    // Merging a scalar into an object is not a thing; the board gets the half
    // that has fields, and `as` is how a board avoids the question.
    const scalarResult = join({}, { answers: "just text" });
    expect(await scalarResult({ conversationId: "a@x" })).toEqual({
      conversationId: "a@x",
    });

    const scalarInput = join({}, { answers: { text: "hi" } });
    expect(await scalarInput("a@x")).toEqual({ text: "hi" });
  });
});

describe("a Join with nothing in it", () => {
  it("passes its input straight through", async () => {
    const empty = new JoinService(
      { uuid: "join-1", serviceId: "join", state: { pipeline: [] } } as never,
      fakeService,
    );
    empty.setHost(hostFor());
    expect(await empty.process({ a: 1 }, () => {})).toEqual({ a: 1 });
  });

  it("passes through when bypassed", async () => {
    const run = join({ bypass: true });
    expect(await run({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("configuration", () => {
  it("survives being set in the constructor", async () => {
    const service = new JoinService(
      {
        uuid: "join-1",
        serviceId: "join",
        state: { as: "extraction", mode: "add", pipeline: [] },
      } as never,
      fakeService,
    );
    expect(service.getState()).toMatchObject({ as: "extraction", mode: "add" });
  });
});

/**
 * A detour that fails, told apart from one that chose to stop.
 *
 * Both end with nothing. Only the failure has a reason, and with `onFailure:
 * "merge"` that reason is what the rest of the pipeline gets, beside the thing
 * it happened to — so a board can record it instead of the run just ending.
 */
describe("when something in the detour fails", () => {
  /** Fails for an input carrying `fail`, after a delay it also carries. */
  function judging(config: ServiceConfiguration): HostedService {
    return {
      serviceId: config.serviceId,
      serviceName: "Judging",
      uuid: config.uuid,
      configure: () => ({}),
      getState: () => ({}),
      process: async (input: any, notify) => {
        await new Promise((resolve) => setTimeout(resolve, input?.delay ?? 1));
        if (input?.fail) {
          notify({ error: input.fail });
          return null;
        }
        if (input?.skip) {
          // A filter, or a claim that found nothing: a stop, not a failure.
          return null;
        }
        return { text: `brief of ${input.id}` };
      },
    };
  }

  function judged(state: Record<string, unknown>) {
    const service = new JoinService(
      {
        uuid: "brief",
        serviceId: "join",
        state: {
          pipeline: [{ serviceId: "judging", uuid: "write", state: {} }],
          ...state,
        },
      } as never,
      judging,
    );
    service.setHost(hostFor());
    return (input: unknown) => service.process(input, () => {});
  }

  it("passes the input on with the failure where the result would have gone", async () => {
    const run = judged({ as: "brief", onFailure: "merge" });

    expect(await run({ id: "a", fail: "no value stored for anthropic.key" })).toEqual({
      id: "a",
      fail: "no value stored for anthropic.key",
      brief: { error: "no value stored for anthropic.key", service: "write" },
    });
  });

  it("keeps a failure under a name of its own when no name is given", async () => {
    // Spread like a result, it would be hidden by an `error` the item already
    // carried in `add` mode, and replace the item's own `service` otherwise.
    const added = judged({ onFailure: "merge", mode: "add" });
    expect(await added({ id: "a", fail: "boom", error: "" })).toEqual({
      id: "a",
      fail: "boom",
      error: "",
      failure: { error: "boom", service: "write" },
    });

    const overwritten = judged({ onFailure: "merge" });
    expect(await overwritten({ id: "a", fail: "boom", service: "court-3" })).toEqual({
      id: "a",
      fail: "boom",
      service: "court-3",
      failure: { error: "boom", service: "write" },
    });
  });

  it("still stops on a detour that chose to stop", async () => {
    const run = judged({ as: "brief", onFailure: "merge" });
    expect(await run({ id: "a", skip: true })).toBeNull();
  });

  it("stops on a failure too unless the board asked to hear it", async () => {
    // The default is what a Join always did, so no board changes meaning.
    const run = judged({ as: "brief" });
    expect(await run({ id: "a", fail: "boom" })).toBeNull();
  });

  it("never hands one run another run's failure", async () => {
    // Two articles in flight at once through the same Join: the one that fails
    // finishes first, and the one that succeeds must not be marked failed.
    const run = judged({ as: "brief", onFailure: "merge" });

    const [ok, failed] = await Promise.all([
      run({ id: "ok", delay: 20 }),
      run({ id: "bad", fail: "timeout", delay: 1 }),
    ]);

    expect(ok).toEqual({ id: "ok", delay: 20, brief: { text: "brief of ok" } });
    expect((failed as any).brief).toEqual({ error: "timeout", service: "write" });
  });

  it("says how it handles a failure", () => {
    const service = new JoinService(
      { uuid: "j", serviceId: "join", state: { onFailure: "merge", pipeline: [] } } as never,
      fakeService,
    );
    expect(service.getState()).toMatchObject({ onFailure: "merge" });
    service.configure({ onFailure: "nonsense" });
    expect(service.getState()).toMatchObject({ onFailure: "merge" });
  });
});
