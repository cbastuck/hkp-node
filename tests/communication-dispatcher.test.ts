import { describe, expect, it } from "vitest";

import { CommunicationDispatcherService } from "../src/services/communication-dispatcher";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeScope,
  ServiceConfiguration,
} from "../src/types";

/**
 * The manager in the middle of the star. What is worth pinning is which action
 * runs and what comes out — and, just as much, what the model is never given
 * the chance to say.
 */

type Seen = { uuid: string; input: unknown; scope: RuntimeScope | undefined };

const seen: Seen[] = [];
const configured: Array<{ uuid: string; state: JsonRecord }> = [];

/**
 * Stands in for whatever a board nests. `decide` answers with a decision; every
 * other instance is an action, and reports what it was handed.
 */
function fakeService(config: ServiceConfiguration): HostedService {
  let host: RuntimeHost | null = null;
  const state: JsonRecord = { ...(config.state ?? {}) };
  return {
    serviceId: config.serviceId,
    serviceName: "Fake",
    uuid: config.uuid,
    configure: (update: JsonRecord) => {
      configured.push({ uuid: config.uuid, state: update });
      Object.assign(state, update);
      return state;
    },
    getState: () => state,
    setHost: (h) => {
      host = h;
    },
    process(input: unknown) {
      seen.push({ uuid: config.uuid, input, scope: host?.scope() });
      if (state.answer !== undefined) {
        return { text: "", json: state.answer };
      }
      if (state.produceNothing) {
        return null;
      }
      return { did: config.uuid };
    },
  };
}

function hostFor() {
  const logged: JsonRecord[] = [];
  return {
    host: {
      processFrom: () => null,
      notify: () => {},
      currentContext: () => null,
      log: (_l: string, _e: string, data: JsonRecord) => logged.push(data),
      forwardLog: () => {},
      logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
      scope: () => ({ owner: "tester", boardName: "SYN" }),
      emitResult: () => {},
    } as unknown as RuntimeHost,
    logged,
  };
}

/** A dispatcher whose model answers with `answer`, over two actions. */
function dispatcher(answer: unknown, overrides: JsonRecord = {}) {
  seen.length = 0;
  configured.length = 0;
  const { host, logged } = hostFor();
  const service = new CommunicationDispatcherService(
    {
      uuid: "manager",
      serviceId: "communication-dispatcher",
      state: {
        goal: "Book a hotel room for the customer.",
        states: [
          { name: "init", describe: "nothing read yet" },
          { name: "needs-follow-up", describe: "something is missing" },
          "waiting-approval",
        ],
        decide: [
          {
            serviceId: "text-generation",
            uuid: "brain",
            // Present so the dispatcher recognises it as something that takes
            // a schema, exactly as text-generation's own state does.
            state: { jsonSchema: null, answer },
          },
        ],
        actions: [
          { name: "extract", describe: "read the enquiry", pipeline: [
            { serviceId: "fake", uuid: "do-extract" },
          ] },
          {
            name: "send",
            describe: "send the approved draft",
            available: "params.hasApprovedDraft",
            pipeline: [{ serviceId: "fake", uuid: "do-send" }],
          },
        ],
        ...overrides,
      },
    } as never,
    fakeService,
  );
  service.setHost(host);
  const notifications: JsonRecord[] = [];
  return {
    service,
    logged,
    notifications,
    run: (input: unknown) =>
      service.process(input, (payload) => notifications.push(payload as JsonRecord)),
  };
}

describe("acting on the decision", () => {
  it("runs the action the model named, and says what state follows", async () => {
    const t = dispatcher({ action: "extract", reason: "nothing read yet", next: "needs-follow-up" });

    const out = await t.run({ conversationId: "c1", state: "init" });

    expect(seen.map((s) => s.uuid)).toEqual(["brain", "do-extract"]);
    expect(out).toMatchObject({
      conversationId: "c1",
      action: "extract",
      state: "needs-follow-up",
      result: { did: "do-extract" },
    });
  });

  it("hands the action its reason and parameters", async () => {
    // The dispatcher passing parameters is what lets one action serve several
    // situations instead of one action existing per phrasing.
    const t = dispatcher({
      action: "extract",
      reason: "first look",
      next: "needs-follow-up",
      params: { ask: ["dateOfArrival"] },
    });

    await t.run({ conversationId: "c1", state: "init" });

    expect(seen[1].input).toMatchObject({
      conversationId: "c1",
      action: "extract",
      reason: "first look",
      params: { ask: ["dateOfArrival"] },
    });
  });

  it("waits without running anything, and stops when nothing changed", async () => {
    // Nothing to do is a decision. Passing something on would have whatever
    // comes next write a transition for a pass in which nothing happened.
    const t = dispatcher({
      action: "wait",
      reason: "waiting on the customer",
      next: "needs-follow-up",
    });

    const out = await t.run({ conversationId: "c1", state: "needs-follow-up" });

    expect(out).toBeNull();
    expect(seen.map((s) => s.uuid)).toEqual(["brain"]);
    expect(t.notifications.at(-1)).toMatchObject({ action: "wait" });
  });

  it("moves the exchange on when waiting is itself the change", async () => {
    // A manager reading a complete enquiry decides there is nothing left to
    // obtain. Without this, a state reachable only by judgement would be
    // unreachable, because every other route out of here runs an action.
    const t = dispatcher({
      action: "wait",
      reason: "everything required is known",
      next: "waiting-approval",
    });

    const out = await t.run({ conversationId: "c1", state: "init" });

    expect(seen.map((s) => s.uuid)).toEqual(["brain"]);
    expect(out).toMatchObject({
      conversationId: "c1",
      action: "wait",
      state: "waiting-approval",
    });
  });

  it("refuses a state this board has not declared, even when waiting", async () => {
    const t = dispatcher({ action: "wait", reason: "", next: "invoiced" });

    expect(await t.run({ conversationId: "c1", state: "init" })).toBeNull();
    expect(t.service.getState().error).toContain("invoiced");
  });

  it("does not advance when the action produced nothing", async () => {
    // The state the model named is the state that follows the action working.
    const t = dispatcher(
      { action: "extract", reason: "have a look", next: "needs-follow-up" },
      {
        actions: [
          {
            name: "extract",
            describe: "read the enquiry",
            pipeline: [
              { serviceId: "fake", uuid: "do-extract", state: { produceNothing: true } },
            ],
          },
        ],
      },
    );

    expect(await t.run({ conversationId: "c1", state: "init" })).toBeNull();
    expect(t.service.getState().error).toContain("produced nothing");
  });
});

describe("what the model is not allowed to say", () => {
  it("constrains the answer to the actions that exist, plus waiting", async () => {
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    const schema = configured.find((c) => c.uuid === "brain")?.state.jsonSchema as any;

    expect(schema.properties.action.enum).toEqual(["extract", "send", "wait"]);
    expect(schema.properties.next.enum).toEqual([
      "init",
      "needs-follow-up",
      "waiting-approval",
    ]);
    void t;
  });

  it("rewrites the schema when the actions change", async () => {
    // A schema written by hand beside the actions drifts out of step with them
    // the first time one is added.
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    t.service.configure({ addAction: { name: "quote", describe: "send a price" } });

    const schema = configured.filter((c) => c.uuid === "brain").at(-1)?.state.jsonSchema as any;
    expect(schema.properties.action.enum).toEqual(["extract", "send", "quote", "wait"]);
  });

  it("refuses a state this board has not declared", async () => {
    const t = dispatcher({ action: "extract", reason: "", next: "invoiced" });

    expect(await t.run({ conversationId: "c1", state: "init" })).toBeNull();
    expect(t.service.getState().error).toContain("invoiced");
    expect(seen.map((s) => s.uuid)).toEqual(["brain"]);
  });

  it("refuses an action that is not available on this pass", async () => {
    // `send` needs an approved draft. Nothing here has one, so it is neither
    // offered nor accepted — a model ignoring the menu still cannot act.
    const t = dispatcher({ action: "send", reason: "off we go", next: "waiting-approval" });

    expect(await t.run({ conversationId: "c1", state: "init" })).toBeNull();
    expect(seen.map((s) => s.uuid)).toEqual(["brain"]);
    expect(t.service.getState().error).toContain("not an action available here");
  });

  it("leaves an unavailable action off the menu it shows the model", async () => {
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    await t.run({ conversationId: "c1", state: "init" });

    const prompt = String((seen[0].input as JsonRecord).prompt);
    expect(prompt).toContain("- extract: read the enquiry");
    expect(prompt).not.toContain("- send:");
    expect(prompt).toContain(`- wait:`);
  });

  it("offers an action whose precondition is met", async () => {
    const t = dispatcher({ action: "send", reason: "approved", next: "waiting-approval" });

    const out = await t.run({ conversationId: "c1", state: "init", hasApprovedDraft: true });

    expect(seen.map((s) => s.uuid)).toEqual(["brain", "do-send"]);
    expect(out).toMatchObject({ action: "send" });
  });

  it("stops when the decide pipeline answers in no shape at all", async () => {
    const t = dispatcher(undefined, {
      decide: [{ serviceId: "fake", uuid: "brain", state: { jsonSchema: null } }],
    });

    expect(await t.run({ conversationId: "c1", state: "init" })).toBeNull();
    expect(t.service.getState().error).toContain("required shape");
  });
});

describe("what the model is told", () => {
  it("shows it the goal, the states and everything the board put in front of it", async () => {
    // Naming the parts it understood would stop this service being general the
    // first time a board added one.
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    await t.run({
      conversationId: "c1",
      state: "init",
      thread: { emails: [{ body: "Ich brauche ein Zimmer" }] },
      known: { artifacts: [{ payload: { missing: ["dateOfArrival"] } }] },
    });

    const prompt = String((seen[0].input as JsonRecord).prompt);
    expect(prompt).toContain("Book a hotel room for the customer.");
    expect(prompt).toContain("- needs-follow-up: something is missing");
    expect(prompt).toContain("CURRENT STATE: init");
    expect(prompt).toContain("Ich brauche ein Zimmer");
    expect(prompt).toContain("dateOfArrival");
  });

  it("truncates a context too large to send", async () => {
    const t = dispatcher({ action: "extract", reason: "", next: "init" }, {
      maxContextChars: 200,
    });

    await t.run({ state: "init", attachment: "x".repeat(5_000) });

    const prompt = String((seen[0].input as JsonRecord).prompt);
    expect(prompt).toContain("(truncated)");
    // The attachment is what must not get through, not the instructions.
    expect(prompt).not.toContain("x".repeat(250));
  });
});

describe("the pipelines it holds", () => {
  it("gives every action pipeline the board's scope", async () => {
    // A nested service that keeps something durable must answer to the board
    // and tenant it belongs to, however deeply it sits.
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    await t.run({ conversationId: "c1", state: "init" });

    expect(seen.map((s) => s.scope)).toEqual([
      { owner: "tester", boardName: "SYN" },
      { owner: "tester", boardName: "SYN" },
    ]);
  });

  it("passes a later scope down to every action", async () => {
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    t.service.setScope({ owner: "someone-else", boardName: "Other" });
    await t.run({ conversationId: "c1", state: "init" });

    expect(seen.map((s) => s.scope?.owner)).toEqual(["someone-else", "someone-else"]);
  });

  it("leaves an untouched action's services alone when another is edited", async () => {
    // Rebuilding a pipeline destroys what is running in it — a mount, a timer —
    // and editing one action is no reason for that to happen to another.
    const t = dispatcher({ action: "extract", reason: "", next: "init" });
    const before = (t.service.getState().actions as any[])[0].pipeline[0].instanceId;

    t.service.configure({ branch: "send", appendService: { serviceId: "fake" } });

    const after = (t.service.getState().actions as any[])[0].pipeline[0].instanceId;
    expect(after).toBe(before);
    expect((t.service.getState().actions as any[])[1].pipeline).toHaveLength(2);
  });

  it("refuses two actions with the same name", () => {
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    expect(() =>
      t.service.configure({
        actions: [{ name: "extract" }, { name: "extract" }],
      }),
    ).toThrow(/both called 'extract'/);
  });

  it("refuses an action called 'wait'", () => {
    // Waiting is always available; an action of that name would shadow it.
    const t = dispatcher({ action: "extract", reason: "", next: "init" });

    expect(() => t.service.configure({ actions: [{ name: "wait" }] })).toThrow(/wait/);
  });

  it("says so when there is no decide pipeline", async () => {
    const t = dispatcher(undefined, { decide: [] });

    expect(await t.run({ state: "init" })).toBeNull();
    expect(t.service.getState().error).toContain("no decide pipeline");
  });
});
