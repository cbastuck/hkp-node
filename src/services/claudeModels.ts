/**
 * What a Claude model accepts, for the requests `text-generation` builds.
 *
 * A board says what it wants — think, think less, answer in this shape, this
 * much effort — and the Claude models disagree on how that is said. Current
 * models think unasked and refuse a thinking budget; older ones think only
 * with one. Some refuse to be told not to think, one is told so in a word of
 * its own, and the newest refuse a forced tool, which is how a shape used to
 * be asked for.
 *
 * Two sources, each for what it can answer:
 *
 *   - **The Models API** (`GET /v1/models/{id}`) reports whether a model takes
 *     adaptive thinking or a budget, which effort levels, and structured
 *     outputs. Asked once per model and address, and preferred wherever it
 *     answers, so a model released after this file still gets those right.
 *   - **This table** says what the API does not describe — how a model is told
 *     not to think, and whether it takes a forced tool — and stands in for the
 *     API when it cannot be asked: a proxy that does not serve it, a network
 *     that is down. A model the table does not know gets the requests this
 *     service sent before any of this existed.
 *
 * Nothing here is consulted for the `server` backend, whose servers speak
 * another API with its own vocabulary.
 */
import { JsonRecord } from "../types";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type ClaudeModel = {
  /**
   * How thinking is asked for: `adaptive` (the model decides how long, effort
   * sets how much), `budget` (a number of tokens, the older form), or `none`.
   */
  thinking: "adaptive" | "budget" | "none";
  /**
   * How "do not think" is said, or null where the model cannot be told — it
   * thinks regardless, and lowering effort is the only way to have it think
   * less. Only meaningful for an adaptive model.
   */
  thinkingOff: "disabled" | "between_tools" | null;
  /** The highest effort `thinkingOff` is accepted at; absent, any. */
  thinkingOffUpTo?: Effort;
  /** The effort a model uses when none is sent. */
  defaultEffort: Effort;
  /** The effort levels it takes; empty where it takes none. */
  efforts: readonly Effort[];
  /** Whether `tool_choice` may force a tool, the older way to ask for a shape. */
  forcedTool: boolean;
  /** Whether `output_config.format` may constrain the answer to a schema. */
  structuredOutputs: boolean;
  /**
   * Whether `temperature` and `top_k` are accepted, under the API version
   * text-generation pins. Current models refuse any value but their own, and
   * from API version 2026-10-21 every model refuses them — moving to it makes
   * this false throughout.
   */
  sampling: boolean;
};

const ALL_EFFORTS = EFFORTS;
const NO_XHIGH: readonly Effort[] = ["low", "medium", "high", "max"];

/**
 * What every model the table has no line for is assumed to accept. Sampling is
 * the exception to "what this service sent before": leaving it out is accepted
 * by every model, and sending it is refused by every recent one.
 */
const UNKNOWN: ClaudeModel = {
  thinking: "budget",
  thinkingOff: null,
  defaultEffort: "high",
  efforts: [],
  forcedTool: true,
  structuredOutputs: false,
  sampling: false,
};

/**
 * Per model id, as the API spells them. A dated id (`…-20251001`) is the model
 * it dates. Ordered newest first only for reading; matching is exact.
 */
const TABLE: Record<string, ClaudeModel> = {
  "claude-fable-5-1": {
    thinking: "adaptive",
    thinkingOff: null,
    defaultEffort: "high",
    efforts: ALL_EFFORTS,
    forcedTool: false,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-fable-5": {
    thinking: "adaptive",
    thinkingOff: null,
    defaultEffort: "high",
    efforts: ALL_EFFORTS,
    forcedTool: true,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-opus-5-5": {
    thinking: "adaptive",
    thinkingOff: null,
    defaultEffort: "medium",
    efforts: ALL_EFFORTS,
    forcedTool: false,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-opus-5": {
    thinking: "adaptive",
    thinkingOff: "disabled",
    thinkingOffUpTo: "high",
    defaultEffort: "high",
    efforts: ALL_EFFORTS,
    forcedTool: true,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-opus-4-8": {
    thinking: "adaptive",
    thinkingOff: "disabled",
    defaultEffort: "high",
    efforts: ALL_EFFORTS,
    forcedTool: true,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-opus-4-7": {
    thinking: "adaptive",
    thinkingOff: "disabled",
    defaultEffort: "high",
    efforts: ALL_EFFORTS,
    forcedTool: true,
    structuredOutputs: false,
    sampling: false,
  },
  "claude-opus-4-6": {
    thinking: "adaptive",
    thinkingOff: "disabled",
    defaultEffort: "high",
    efforts: NO_XHIGH,
    forcedTool: true,
    structuredOutputs: false,
    sampling: true,
  },
  "claude-sonnet-5-5": {
    thinking: "adaptive",
    thinkingOff: "between_tools",
    thinkingOffUpTo: "high",
    defaultEffort: "high",
    efforts: ALL_EFFORTS,
    forcedTool: false,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-sonnet-5": {
    thinking: "adaptive",
    thinkingOff: "disabled",
    defaultEffort: "high",
    efforts: ALL_EFFORTS,
    forcedTool: true,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-sonnet-4-6": {
    thinking: "adaptive",
    thinkingOff: "disabled",
    defaultEffort: "high",
    efforts: NO_XHIGH,
    forcedTool: true,
    structuredOutputs: false,
    sampling: true,
  },
  "claude-haiku-5-5": {
    thinking: "adaptive",
    thinkingOff: "disabled",
    thinkingOffUpTo: "high",
    defaultEffort: "medium",
    efforts: ALL_EFFORTS,
    forcedTool: true,
    structuredOutputs: true,
    sampling: false,
  },
  "claude-haiku-4-5": {
    thinking: "budget",
    thinkingOff: null,
    defaultEffort: "high",
    efforts: [],
    forcedTool: true,
    structuredOutputs: true,
    sampling: true,
  },
};
// The Project Glasswing models are the same models under other names.
TABLE["claude-mythos-5-1"] = TABLE["claude-fable-5-1"];
TABLE["claude-mythos-5"] = TABLE["claude-fable-5"];

/** The table's line for a model, a dated id reading as the model it dates. */
export function tabledModel(id: string): ClaudeModel {
  return TABLE[id] ?? TABLE[id.replace(/-\d{8}$/, "")] ?? UNKNOWN;
}

/** What the Models API said, reduced to what this file decides with. */
type Reported = Partial<Pick<ClaudeModel, "thinking" | "efforts" | "structuredOutputs">>;

/** Reads the capability tree, keeping only leaves that are actually there. */
export function reportedCapabilities(model: unknown): Reported {
  const caps = (model as JsonRecord | null)?.capabilities as JsonRecord | undefined;
  if (!caps || typeof caps !== "object") {
    return {};
  }
  const supported = (node: unknown): boolean | undefined => {
    const value = (node as JsonRecord | undefined)?.supported;
    return typeof value === "boolean" ? value : undefined;
  };
  const reported: Reported = {};

  const thinking = caps.thinking as JsonRecord | undefined;
  const types = thinking?.types as JsonRecord | undefined;
  if (supported(types?.adaptive) === true) {
    reported.thinking = "adaptive";
  } else if (supported(types?.enabled) === true) {
    reported.thinking = "budget";
  } else if (supported(thinking) === false) {
    reported.thinking = "none";
  }

  const effort = caps.effort as JsonRecord | undefined;
  const effortSupported = supported(effort);
  if (effortSupported === false) {
    reported.efforts = [];
  } else if (effortSupported === true) {
    reported.efforts = EFFORTS.filter((level) => supported(effort?.[level]) === true);
  }

  const structured = supported(caps.structured_outputs);
  if (structured !== undefined) {
    reported.structuredOutputs = structured;
  }
  return reported;
}

/** How long a lookup that got no answer is trusted before asking again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;
/** A lookup is a courtesy to the request behind it, never a wait for it. */
const LOOKUP_TIMEOUT_MS = 5000;

const looked = new Map<string, { at: number; reported: Reported | null }>();
const asking = new Map<string, Promise<Reported | null>>();

/**
 * The model as the API reports it where it can, and as the table says
 * otherwise.
 *
 * Asked once per address and model while the process lives; a lookup that
 * failed is asked again after a while rather than on every request. Never
 * throws: a lookup that cannot be made leaves the table to answer.
 */
export async function claudeModel(
  base: string,
  id: string,
  headers: Record<string, string>,
): Promise<ClaudeModel> {
  const key = `${base}|${id}`;
  const known = looked.get(key);
  if (known && (known.reported || Date.now() - known.at < RETRY_AFTER_MS)) {
    return merged(id, known.reported);
  }
  let pending = asking.get(key);
  if (!pending) {
    pending = lookUp(base, id, headers).finally(() => asking.delete(key));
    asking.set(key, pending);
  }
  const reported = await pending;
  looked.set(key, { at: Date.now(), reported });
  return merged(id, reported);
}

/** What is known without asking: the last answer if there was one, else the table. */
export function knownClaudeModel(base: string, id: string): ClaudeModel {
  return merged(id, looked.get(`${base}|${id}`)?.reported ?? null);
}

function merged(id: string, reported: Reported | null): ClaudeModel {
  return { ...tabledModel(id), ...(reported ?? {}) };
}

async function lookUp(
  base: string,
  id: string,
  headers: Record<string, string>,
): Promise<Reported | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/v1/models/${encodeURIComponent(id)}`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const reported = reportedCapabilities(await response.json());
    return Object.keys(reported).length ? reported : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `effort` is at or below `ceiling`. */
export function atMost(effort: Effort, ceiling: Effort): boolean {
  return EFFORTS.indexOf(effort) <= EFFORTS.indexOf(ceiling);
}

/** Keywords structured outputs refuse, which a constraint elsewhere may carry. */
const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
];

/**
 * A board's schema as structured outputs takes it.
 *
 * Every object closed (`additionalProperties: false`, which the API requires),
 * and the numeric and length constraints it does not support left out — the
 * shape is still enforced; those bounds are not. The board's own schema is not
 * touched: this is a copy for one request.
 */
export function structuredSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(structuredSchema);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(schema as JsonRecord)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as JsonRecord).map(([name, sub]) => [name, structuredSchema(sub)]),
      );
    } else if (key === "$defs" || key === "definitions") {
      out[key] = Object.fromEntries(
        Object.entries((value ?? {}) as JsonRecord).map(([name, sub]) => [name, structuredSchema(sub)]),
      );
    } else if (["items", "anyOf", "allOf", "oneOf", "prefixItems", "not"].includes(key)) {
      out[key] = structuredSchema(value);
    } else {
      out[key] = value;
    }
  }
  const isObject = out.type === "object" || (out.properties !== undefined && out.type === undefined);
  if (isObject) {
    out.additionalProperties = false;
  }
  return out;
}
