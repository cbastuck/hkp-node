/**
 * Service Documentation
 * Service ID: communication-dispatcher
 * Service Name: Communication Dispatcher
 * Runtime: hkp-node
 * Modes: none
 * Key Config: goal, states, actions ([{ name, describe, available, pipeline }]),
 *             decide (the pipeline that asks a model), instruction, stateFrom,
 *             maxContextChars
 * IO: in=the exchange so far (JSON) -> out={ ...input, action, params, reason,
 *     result, state } — or nothing at all when there is nothing to do and
 *     nothing to change
 * Notifies: { decidePrompt, decideAnswer } — the question put to the decide
 *     pipeline and what came back, every pass, for reading a decision that
 *     went wrong; `lastAnswer` keeps an abbreviated copy in state
 * Arrays: treated as one context, not iterated (pair with `iterator`)
 * Binary: not accepted
 * MixedData: not native in runtime
 *
 * The manager in the middle of the star.
 *
 * Around it sit the actions — a nested pipeline each, doing one thing a
 * business does: understand what was asked, ask for what is missing, quote,
 * send. This service decides which of them is the right thing to do next, runs
 * it, and takes the result back. A board grows by gaining an action, not by
 * gaining a runtime, and the workflow stays readable in one place.
 *
 * The decision is a model's, not a rule's, and deliberately so: what arrives is
 * a person writing an email, and no expression over `state` anticipates what
 * they will say. The model is given what a new colleague would be given — the
 * goal, the states the work can be in, the actions available and when each is
 * for, and the exchange so far — and answers with one action and the state that
 * follows if it works.
 *
 * Two things keep that from being a licence to invent. The answer is
 * constrained by a JSON schema this service generates from its own
 * configuration, so `action` and `next` are enums of what actually exists —
 * an invented name cannot be uttered, never mind acted on. And an action can
 * declare `available`, an expression over the input, which decides whether it
 * is on the menu this turn at all; sending an approved draft is not a judgement
 * call when there is no approved draft. Narrowing the menu to the legal moves
 * is what makes the choice good, and it is a different question from which of
 * the legal moves to make.
 *
 * One action per pass, and the state it moves to is persisted by whatever comes
 * next in the board. The loop is the poll that fed this service, not a loop in
 * here: the position of the machine is then a row someone can read rather than
 * a stack frame, a restart resumes rather than restarts, and a model that
 * changes its mind costs one call per tick instead of spending a budget in a
 * cycle nobody is watching.
 */
import { compileExpression } from "./expression";
import { isJsonRecord, NestedPipeline } from "./nested-pipeline";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeScope,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";

export const communicationDispatcherDescriptor: ServiceRegistryEntry = {
  serviceId: "communication-dispatcher",
  serviceName: "Communication Dispatcher",
  capabilities: ["subservices"],
};

/** The branch that asks the model, as opposed to the branches that act. */
const DECIDE = "decide";

/**
 * Always offered, never configured: the manager's right to do nothing.
 *
 * Without it a model asked to choose an action must choose one, and a
 * conversation waiting on a customer gets a second follow-up because answering
 * "none of these" was not among the things it could say.
 */
const WAIT = "wait";

/**
 * Sent as the opening of the question rather than as a system message.
 *
 * The decide pipeline is a pipeline, not a model handle: what is in it may take
 * a system prompt, may already have one saying something else, or may not be a
 * model at all. Putting the instruction in the question means the whole of what
 * was asked is one string a board author can read.
 */
const DEFAULT_INSTRUCTION =
  "You manage an ongoing exchange with a customer on behalf of a business. " +
  "You are given the goal, the states the exchange can be in, the actions you " +
  "may take, and everything that has happened so far. Choose the single next " +
  "action, and say which state the exchange is in once that action has been " +
  "carried out. Do not repeat an action that has already been taken unless " +
  "what has happened since calls for it. Choose '" +
  WAIT +
  "' when the right thing to do is nothing — when the exchange is waiting on " +
  "someone else.";

/**
 * How much of an answer is kept, and how much is sent.
 *
 * The state figure is the one that matters: state is what the frontend writes
 * back into the board when it saves, so anything kept here is kept forever.
 * Enough to see the shape of what came back; the notification carries enough
 * to read it.
 */
const ANSWER_STATE_CHARS = 600;
/** Also the cap on the question, which goes the same way and is far longer. */
const ANSWER_NOTIFY_CHARS = 8_000;

type DeclaredState = { name: string; describe: string };

type Action = {
  name: string;
  describe: string;
  /** Expression over the input deciding whether this action is offered at all. */
  available: string;
  pipeline: NestedPipeline;
};

export class CommunicationDispatcherService implements HostedService {
  readonly serviceId = communicationDispatcherDescriptor.serviceId;
  readonly serviceName = communicationDispatcherDescriptor.serviceName;
  readonly capabilities = communicationDispatcherDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private readonly createService: ServiceCreator;

  private goal = "";
  private instruction = DEFAULT_INSTRUCTION;
  private states: DeclaredState[] = [];
  private stateFrom = "state";
  private maxContextChars = 20_000;
  private actions: Action[] = [];
  private decide: NestedPipeline;

  private lastAction = "";
  private lastReason = "";
  private lastNext = "";
  private lastError = "";
  private lastAnswer = "";

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    this.uuid = config.uuid;
    this.createService = createService;
    this.decide = new NestedPipeline(`${this.uuid}:${DECIDE}`, createService);

    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
    this.decide.attach(host);
    for (const action of this.actions) {
      action.pipeline.attach(host);
    }
  }

  /** Passes the scope on to every nested pipeline; see NestedPipeline.setScope. */
  setScope(scope: RuntimeScope): void {
    this.decide.setScope(scope);
    for (const action of this.actions) {
      action.pipeline.setScope(scope);
    }
  }

  getState(): JsonRecord {
    return {
      goal: this.goal,
      instruction: this.instruction,
      stateFrom: this.stateFrom,
      maxContextChars: this.maxContextChars,
      states: this.states.map((state) => ({ ...state })),
      decide: this.decide.state(),
      actions: this.actions.map((action) => ({
        name: action.name,
        describe: action.describe,
        available: action.available,
        pipeline: action.pipeline.state(),
      })),
      lastAction: this.lastAction,
      lastReason: this.lastReason,
      lastNext: this.lastNext,
      // Kept short and kept here, unlike the question: a decision that did not
      // parse is unreadable without the thing that failed to parse, and this
      // is the one part small enough to live in state a board writes to disk.
      lastAnswer: this.lastAnswer,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    // Branch-scoped edits arrive from the UI, which speaks one pipeline at a
    // time and says which one it means. Handled first: the rest of this method
    // is about the dispatcher, this is about one of the pipelines under it.
    if (typeof config.branch === "string") {
      this.configureBranch(config.branch, config);
      return this.getState();
    }

    if (typeof config.goal === "string") {
      this.goal = config.goal;
    }
    if (typeof config.instruction === "string") {
      this.instruction = config.instruction;
    }
    if (typeof config.stateFrom === "string") {
      this.stateFrom = config.stateFrom;
    }
    if (typeof config.maxContextChars === "number") {
      this.maxContextChars = Math.max(0, Math.floor(config.maxContextChars));
    }
    if (config.states !== undefined) {
      this.states = declaredStates(config.states);
    }
    if (Array.isArray(config.decide)) {
      this.decide.setPipeline(config.decide);
    }
    if (Array.isArray(config.actions)) {
      this.setActions(config.actions);
    }
    if (isJsonRecord(config.addAction)) {
      this.setActions([...this.actionConfigs(), config.addAction]);
    }
    if (typeof config.removeAction === "string") {
      const name = config.removeAction;
      this.setActions(
        this.actionConfigs().filter((entry) => entry.name !== name),
      );
    }

    // The shape of the answer follows from what there is to answer with, so it
    // is rewritten whenever either changes rather than configured by hand and
    // left to drift out of step with the actions it names.
    this.publishSchema();
    return this.getState();
  }

  async process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (input === null || input === undefined) {
      return null;
    }
    if (this.decide.isEmpty()) {
      return this.fail(notify, "no decide pipeline — add a text-generation service to it");
    }

    const offered = this.availableActions(input);
    const decision = await this.ask(input, offered, notify);
    if (!decision) {
      return null;
    }

    const { action: name, reason, next, params } = decision;
    this.lastAction = name;
    this.lastReason = reason;
    this.lastNext = next;

    if (name === WAIT) {
      // Nothing to *do* is not the same as nothing to say. A manager reading a
      // complete enquiry decides there is nothing left to obtain and moves the
      // exchange on; without that, a state reachable only by judgement would be
      // unreachable, because every other route out of here runs an action.
      notify({ action: WAIT, reason, next, lastAction: WAIT, lastReason: reason });
      const current = valueAt(input, this.stateFrom);
      if (!next || next === current) {
        // Nothing changed, so nothing is passed on: whatever follows would
        // otherwise write a transition for a pass in which nothing happened.
        return null;
      }
      return { ...(isJsonRecord(input) ? input : { input }), action: WAIT, reason, state: next };
    }

    const action = offered.find((entry) => entry.name === name);
    if (!action) {
      // The schema enumerates what may be said, so this is a model ignoring it
      // rather than a board naming something that does not exist.
      return this.fail(notify, `'${name}' is not an action available here`);
    }

    notify({ action: name, reason, next, params, lastAction: name, lastReason: reason });

    const carried = isJsonRecord(input) ? input : { input };
    const result = await action.pipeline.process(
      { ...carried, action: name, params, reason },
      this.host?.currentContext() ?? null,
    );
    if (result === null || result === undefined) {
      // The action did not do what it was asked, so the state it would have
      // moved to is not the state anything is in. Nothing to pass on.
      return this.fail(notify, `action '${name}' produced nothing — not advancing`);
    }

    this.lastError = "";
    return { ...carried, action: name, params, reason, result, state: next };
  }

  destroy(): void {
    this.decide.destroy();
    for (const action of this.actions) {
      action.pipeline.destroy();
    }
    this.actions = [];
    this.host = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** The actions on the menu for this input. */
  private availableActions(input: unknown): Action[] {
    return this.actions.filter((action) => {
      if (!action.available) {
        return true;
      }
      try {
        return !!compileExpression(action.available)(input);
      } catch (error) {
        // A broken predicate hides an action rather than offering it: the
        // safe reading of "we could not tell whether this is allowed".
        this.host?.log("warn", "service.degraded", {
          message: `action '${action.name}' has an unusable 'available' expression: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return false;
      }
    });
  }

  /**
   * What the decide pipeline's own services are reporting, if anything.
   *
   * A pipeline that produced nothing has already been told why by whatever
   * failed inside it — an address that refused, a key that was not accepted —
   * and that sits in the failing service's state, one level down from anything
   * a board shows. Reading it out here is the difference between "it did not
   * work" and knowing what to fix.
   */
  private decideErrors(): string {
    const reported: string[] = [];
    for (const service of this.decide.services()) {
      const state = service.state;
      if (isJsonRecord(state) && typeof state.error === "string" && state.error) {
        reported.push(`${service.uuid}: ${preview(state.error, 300)}`);
      }
    }
    return reported.join("; ");
  }

  /** Puts the question to the decide pipeline and reads the answer back. */
  private async ask(
    input: unknown,
    offered: Action[],
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<{ action: string; reason: string; next: string; params: JsonRecord } | null> {
    const prompt = this.prompt(input, offered);
    const answer = await this.decide.process(
      { prompt },
      this.host?.currentContext() ?? null,
    );

    // What was asked and what came back, verbatim, every pass — a decision is
    // a model's, so the only way to see why it went the way it did is to read
    // the exchange that produced it. Sent rather than stored: the question
    // carries the whole conversation, and a board that saved it would write
    // that conversation into itself.
    this.lastAnswer = preview(answer, ANSWER_STATE_CHARS);
    notify({
      decidePrompt: preview(prompt, ANSWER_NOTIFY_CHARS),
      decideAnswer: preview(answer, ANSWER_NOTIFY_CHARS),
      lastAnswer: this.lastAnswer,
    });

    // Nothing came back at all, which is a service in the pipeline failing
    // rather than a model answering badly — a different thing to go and look
    // at, and the service that failed has already said what went wrong.
    if (answer === null || answer === undefined) {
      const reported = this.decideErrors();
      return this.failNull(
        notify,
        reported
          ? `the decide pipeline produced nothing — ${reported}`
          : "the decide pipeline produced nothing, and none of its services " +
            "reported why — something in it returned null and stopped the run",
      );
    }

    const record = isJsonRecord(answer) ? answer : null;
    const decision = record && isJsonRecord(record.json) ? record.json : null;
    if (!decision) {
      const reported = this.decideErrors();
      return this.failNull(
        notify,
        `the decide pipeline did not answer in the required shape — ${describeAnswer(answer)}` +
          (reported ? `; ${reported}` : ""),
      );
    }

    const action = typeof decision.action === "string" ? decision.action : "";
    if (!action) {
      return this.failNull(notify, "the decision named no action");
    }
    const next = typeof decision.next === "string" ? decision.next : "";
    if (next && this.states.length > 0 && !this.states.some((s) => s.name === next)) {
      return this.failNull(
        notify,
        `'${next}' is not one of this board's states (${this.states
          .map((s) => s.name)
          .join(", ")})`,
      );
    }

    return {
      action,
      reason: typeof decision.reason === "string" ? decision.reason : "",
      next,
      params: isJsonRecord(decision.params) ? decision.params : {},
    };
  }

  /** Everything a new colleague would be told before being asked to decide. */
  private prompt(input: unknown, offered: Action[]): string {
    const lines: string[] = [];
    if (this.instruction) {
      lines.push(this.instruction, "");
    }
    if (this.goal) {
      lines.push(`GOAL: ${this.goal}`, "");
    }
    if (this.states.length > 0) {
      lines.push("STATES THE EXCHANGE CAN BE IN:");
      for (const state of this.states) {
        lines.push(state.describe ? `- ${state.name}: ${state.describe}` : `- ${state.name}`);
      }
      lines.push("");
    }
    lines.push("ACTIONS YOU MAY TAKE NOW:");
    for (const action of offered) {
      lines.push(action.describe ? `- ${action.name}: ${action.describe}` : `- ${action.name}`);
    }
    lines.push(`- ${WAIT}: do nothing; the exchange is waiting on someone else.`, "");

    const current = valueAt(input, this.stateFrom);
    if (typeof current === "string" && current) {
      lines.push(`CURRENT STATE: ${current}`, "");
    }
    lines.push("WHAT HAS HAPPENED SO FAR:", this.context(input));
    return lines.join("\n");
  }

  /**
   * The input, as the model sees it.
   *
   * All of it: what is worth knowing about an exchange is whatever the board
   * put in front of this service — the thread, what has already been extracted,
   * what has already been drafted — and a service that named the parts it
   * understood would stop being general the first time a board added one.
   * Truncated only so that one long attachment cannot cost a context window.
   */
  private context(input: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(input, null, 1) ?? String(input);
    } catch {
      text = String(input);
    }
    if (this.maxContextChars > 0 && text.length > this.maxContextChars) {
      return `${text.slice(0, this.maxContextChars)}\n… (truncated)`;
    }
    return text;
  }

  /**
   * The shape of an answer, as a JSON schema, handed to the decide pipeline.
   *
   * `action` and `next` are enums of what this dispatcher actually has, which
   * is what stops a decision naming something that does not exist. Pushed into
   * whichever nested services take a `jsonSchema`, so that the constraint
   * follows the configuration rather than being written out by hand beside it.
   */
  private publishSchema(): void {
    const schema: JsonRecord = {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...this.actions.map((action) => action.name), WAIT],
          description: "The single next action to take.",
        },
        reason: {
          type: "string",
          description: "Why this action, in one sentence.",
        },
        next: {
          type: "string",
          enum: this.states.map((state) => state.name),
          description: "The state the exchange is in once the action is done.",
        },
        params: {
          type: "object",
          description: "What the action needs to know, if anything.",
          additionalProperties: true,
        },
      },
      required: ["action", "reason", "next"],
    };

    for (const service of this.decide.services()) {
      if (isJsonRecord(service.state) && "jsonSchema" in service.state) {
        this.decide.configureService(service.uuid, { jsonSchema: schema });
      }
    }
  }

  /** The actions as configuration, for edits that rewrite the whole list. */
  private actionConfigs(): JsonRecord[] {
    return this.actions.map((action) => ({
      name: action.name,
      describe: action.describe,
      available: action.available,
      pipeline: action.pipeline.state(),
    }));
  }

  private setActions(value: unknown[]): void {
    const previous = new Map(this.actions.map((action) => [action.name, action]));
    const next: Action[] = [];

    for (const entry of value) {
      if (!isJsonRecord(entry) || typeof entry.name !== "string" || !entry.name) {
        throw new Error("every action needs a name");
      }
      if (entry.name === WAIT) {
        throw new Error(`'${WAIT}' is always available and cannot be configured`);
      }
      if (next.some((action) => action.name === entry.name)) {
        throw new Error(`two actions are both called '${entry.name}'`);
      }

      // An action already here keeps its pipeline: rebuilding it would destroy
      // running services — a mount, a timer — because something unrelated
      // beside it was edited.
      const existing = previous.get(entry.name);
      const pipeline =
        existing?.pipeline ??
        new NestedPipeline(`${this.uuid}:${entry.name}`, this.createService);
      if (Array.isArray(entry.pipeline)) {
        pipeline.setPipeline(entry.pipeline);
      }
      if (!existing && this.host) {
        pipeline.attach(this.host);
      }

      next.push({
        name: entry.name,
        describe: typeof entry.describe === "string" ? entry.describe : "",
        available: typeof entry.available === "string" ? entry.available : "",
        pipeline,
      });
      previous.delete(entry.name);
    }

    // Whatever is left was removed, and holds services nothing will reach again.
    for (const dropped of previous.values()) {
      dropped.pipeline.destroy();
    }
    this.actions = next;
  }

  /** Applies a pipeline edit to one branch: an action by name, or `decide`. */
  private configureBranch(branch: string, config: JsonRecord): void {
    const pipeline =
      branch === DECIDE
        ? this.decide
        : this.actions.find((action) => action.name === branch)?.pipeline;
    if (!pipeline) {
      throw new Error(`no action called '${branch}'`);
    }

    if (typeof config.describe === "string" || typeof config.available === "string") {
      this.actions = this.actions.map((action) =>
        action.name === branch
          ? {
              ...action,
              describe:
                typeof config.describe === "string" ? config.describe : action.describe,
              available:
                typeof config.available === "string" ? config.available : action.available,
            }
          : action,
      );
    }

    if (Array.isArray(config.pipeline)) {
      pipeline.setPipeline(config.pipeline);
    }
    if (isJsonRecord(config.appendService)) {
      pipeline.append(config.appendService);
    }
    if (typeof config.removeService === "string") {
      pipeline.remove(config.removeService);
    }
    if (isJsonRecord(config.configureService)) {
      const payload = config.configureService;
      if (typeof payload.instanceId === "string" && isJsonRecord(payload.state)) {
        pipeline.configureService(payload.instanceId, payload.state);
      }
    }

    if (branch === DECIDE) {
      this.publishSchema();
    }
  }

  private fail(
    notify: (payload: unknown, instanceId?: string) => void,
    message: string,
  ): null {
    this.lastError = message;
    notify({ error: message });
    this.host?.log("warn", "service.degraded", { message });
    return null;
  }

  private failNull(
    notify: (payload: unknown, instanceId?: string) => void,
    message: string,
  ): null {
    this.fail(notify, message);
    return null;
  }
}

/** A value as text, short enough to put in a message. */
function preview(value: unknown, max: number): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return max > 0 && text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Why an answer was not a decision, in the terms of the thing that produced it.
 *
 * "Not the required shape" says a pipeline whose services are all fine, whose
 * model answered, and whose board is one setting away from working — which of
 * those it is decides where to look, and only what came back can say.
 */
function describeAnswer(answer: unknown): string {
  if (!isJsonRecord(answer)) {
    return `it produced a ${typeof answer}: ${preview(answer, 200)}`;
  }

  const keys = Object.keys(answer);
  if (keys.length === 1 && keys[0] === "prompt") {
    return (
      "the question came back unchanged, so nothing in the pipeline answered " +
      "it — every service in it is bypassed, or it passes its input through"
    );
  }
  if (typeof answer.text === "string" && answer.json === undefined) {
    return (
      "it answered with text but no `json`, so the answer was not JSON " +
      "matching the schema — the model wrote prose or was cut off, or the " +
      "server ignored the schema it was sent. It said: " +
      preview(answer.text, 300)
    );
  }
  return `it produced [${keys.join(", ")}], with no \`json\` object: ${preview(answer, 300)}`;
}

function declaredStates(value: unknown): DeclaredState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const states: DeclaredState[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry) {
      states.push({ name: entry, describe: "" });
    } else if (isJsonRecord(entry) && typeof entry.name === "string" && entry.name) {
      states.push({
        name: entry.name,
        describe: typeof entry.describe === "string" ? entry.describe : "",
      });
    }
  }
  return states;
}

/** Reads a dotted path out of a value. */
function valueAt(input: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  let current: unknown = input;
  for (const part of path.split(".")) {
    if (!isJsonRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}
