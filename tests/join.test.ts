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
