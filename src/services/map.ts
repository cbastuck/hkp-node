/**
 * Service Documentation
 * Service ID: map
 * Service Name: Map
 * Runtime: hkp-node
 * Modes: replace | add | overwrite | sensingMode
 * Key Config: template, mode, arrayMode, sensingMode, __hkpMount (an address
 *             this template mentions)
 * IO: in=object|array|scalar -> out=mapped payload
 * Arrays: maps each element (arrayMode "single" maps the array as a whole)
 * Binary: not intended for raw binary
 * MixedData: not native in runtime
 *
 * The template dialect matches the browser runtime's Map so both share one UI:
 * a key ending in "=" is a dynamic term whose value is an expression evaluated
 * against `params`, a plain key is a static value, a dot in a key nests the
 * result, and a lone "=" key produces a scalar instead of an object. Templates
 * that nest objects or arrays keep their shape and are evaluated recursively.
 *
 * Both runtimes parse those terms with the same library, so the shared UI can
 * tell an author whether a template is valid without knowing where it will
 * run. What a term may reach is bounded there rather than here — see
 * `expression.ts`.
 *
 * What a pass says about itself is notified when it changes, and is part of
 * the state while there is something to say, so a panel opened later shows it;
 * configuring it does nothing. The same in every runtime:
 *
 * - `error`: a term that does not parse — said when the template is
 *   configured — or that fails to evaluate. A failing pass stops the flow
 *   (null), since a mapping that could not be made has nothing to pass on,
 *   and is logged, since nobody may be watching. With an array input, one
 *   failing element fails the pass.
 * - `warnings`: a term whose value is empty because what it read was not
 *   there — `title: params.titel not found`. The flow goes on: an absent field
 *   is often legitimate, and a typo is only visible this way.
 *
 * A lone "=" is the value of its term, whatever the mode; a null one has
 * nothing to pass on.
 *
 * A `hkp-mount://` value anywhere in what a template produces becomes the
 * address it names. That is what lets a board *mention* an endpoint it cannot
 * write down — an enclosure URL in a feed, a link somebody is handed — as
 * against dialling one, which `http-client` already does with the same
 * reference in the field it calls.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { CompiledExpression, compileExpression } from "./expression";
import {
  MOUNT_FIELD,
  parseMountRef,
  substituteMounts,
} from "../coordinator/mount";

export const mapDescriptor: ServiceRegistryEntry = {
  serviceId: "map",
  serviceName: "Map",
  version: "v1",
  capabilities: [],
};

type MapMode = "replace" | "add" | "overwrite";
type ArrayMode = "array" | "single";

type MapState = {
  mode: MapMode;
  arrayMode: ArrayMode;
  template: unknown;
  sensingMode: boolean;
};

/** A term that failed, named by where it sits in the template. */
class TermError extends Error {}

// A template that nests objects or arrays is kept in its authored shape and
// evaluated node by node, rather than being flattened into dotted keys.
type TemplateNode =
  | { type: "value"; value: unknown }
  | { type: "expression"; expression: CompiledExpression }
  | { type: "array"; items: TemplateNode[] }
  | {
      type: "object";
      entries: Array<{ key: string; dynamic: boolean; node: TemplateNode }>;
    };

/**
 * A sensed template: the shape of what arrived, and nothing that runs.
 *
 * Sensing builds a template out of *input*, and a template key ending in "="
 * is an expression — so a field named `pwned=` would arrive as data and be
 * compiled as code on the next pass. Input reaches this service from wherever
 * the board is fed: an unauthenticated mount, an email body, an HTTP response.
 * None of those may decide what the runtime executes.
 *
 * The suffix is dropped rather than the field, so sensing an unlucky name
 * still produces the field it was meant to. Nothing is lost: a legitimate
 * sensed key is a data field, never an expression a board wrote.
 */
function sensed(flat: JsonRecord): JsonRecord {
  const safe: JsonRecord = {};
  for (const [key, value] of Object.entries(flat)) {
    safe[key.endsWith("=") ? key.replace(/=+$/, "") : key] = value;
  }
  return safe;
}

export class MapService implements HostedService {
  readonly serviceId = mapDescriptor.serviceId;
  readonly serviceName = mapDescriptor.serviceName;
  readonly version = mapDescriptor.version;
  readonly capabilities = mapDescriptor.capabilities;
  readonly uuid: string;

  private state: MapState;
  private terms: Record<string, CompiledExpression> = {};
  private properties: Record<string, unknown> = {};
  private structuredTemplate: TemplateNode | undefined;
  private host: RuntimeHost | undefined;
  /**
   * The address a mount reference in this template resolves to.
   *
   * A board that has to *mention* an endpoint — an enclosure URL in a feed, a
   * link somebody scans, an address handed to a caller — cannot write one down:
   * it is assigned when the board loads. `http-client` already takes a
   * reference in the field it dials; this is the same thing for a service that
   * only carries the address somewhere. Reserved name: the coordinator writes
   * it, nobody authors it.
   */
  private mount = "";
  /** What was last notified about the template, so only a change is. */
  private reported = { error: "", warnings: [] as string[] };

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    this.state = {
      mode: "replace",
      arrayMode: "array",
      template: {},
      sensingMode: false,
    };

    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  configure(config: JsonRecord): JsonRecord {
    if (isJsonRecord(config.template) || Array.isArray(config.template)) {
      this.updateTemplate(config.template);
    }

    if (
      config.mode === "replace" ||
      config.mode === "add" ||
      config.mode === "overwrite"
    ) {
      this.state.mode = config.mode;
      this.notify({ mode: config.mode });
    }

    if (config.arrayMode === "array" || config.arrayMode === "single") {
      this.state.arrayMode = config.arrayMode;
      this.notify({ arrayMode: config.arrayMode });
    }

    if (typeof config.sensingMode === "boolean") {
      this.updateSensingMode(config.sensingMode);
    }

    if (typeof config[MOUNT_FIELD] === "string") {
      this.mount = config[MOUNT_FIELD] as string;
      this.notify({ [MOUNT_FIELD]: this.mount });
    }

    if (isJsonRecord(config.command)) {
      void this.runCommand(config.command).catch((err) =>
        this.host?.log("error", "service.failed", {
          message: `map inject failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }

    return this.getState();
  }

  getState(): JsonRecord {
    return {
      mode: this.state.mode,
      arrayMode: this.state.arrayMode,
      template: deepCopy(this.state.template),
      sensingMode: this.state.sensingMode,
      [MOUNT_FIELD]: this.mount,
      ...(this.reported.error ? { error: this.reported.error } : {}),
      ...(this.reported.warnings.length
        ? { warnings: [...this.reported.warnings] }
        : {}),
    };
  }

  process(input: unknown, _notify: (payload: unknown) => void): unknown {
    if (this.state.sensingMode) {
      this.updateTemplate(
        sensed(
          isJsonRecord(input) || Array.isArray(input)
            ? flatten(input)
            : { value: input },
        ),
      );
      this.updateSensingMode(false);
      return null;
    }

    if (
      !this.structuredTemplate &&
      !Object.keys(this.terms).length &&
      !Object.keys(this.properties).length &&
      !(this.state.arrayMode !== "single" && Array.isArray(input))
    ) {
      return this.state.mode === "replace" ? {} : input;
    }

    const warnings = new Set<string>();
    try {
      const mapped =
        this.state.arrayMode !== "single" && Array.isArray(input)
          ? input.map((entry) => this.mapper(entry, warnings))
          : this.mapper(input, warnings);
      this.report("", [...warnings]);
      return this.addressed(mapped);
    } catch (error) {
      if (!(error instanceof TermError)) {
        throw error;
      }
      this.report(error.message, [...warnings]);
      this.host?.log("error", "service.failed", { message: error.message });
      return null;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Replaces a mount reference in what was produced with the address it names.
   *
   * Applied to the output rather than to the template, so it covers a reference
   * written as a static value and one an expression produced, and so a template
   * still reads as what the board author wrote.
   *
   * An unresolved reference is left as it stands — the same choice a unit
   * parameter makes. The owner has not published yet, and a value that says
   * `hkp-mount://…` is visibly not an address, where an empty string would look
   * like a field nobody filled in.
   */
  private addressed<T>(value: T): T {
    if (!this.mount || parseMountRef(this.mount)) {
      return value;
    }
    return substituteMounts(value, (ref) =>
      parseMountRef(ref) ? this.mount : ref,
    );
  }

  private mapper(input: unknown, warnings: Set<string>): unknown {
    if (this.structuredTemplate) {
      const mapped = this.evaluateNode(this.structuredTemplate, input, warnings, "");
      return isLoneTerm(this.structuredTemplate)
        ? mapped
        : this.mergeWithInput(mapped, input);
    }

    const termKeys = Object.keys(this.terms);
    // A lone "=" key maps to a scalar rather than to an object.
    if (termKeys.length === 1 && termKeys[0] === "") {
      return keyed(this.evaluateTerm(this.terms[""], input, warnings, pathIn("", "")));
    }

    const inputRecord = isJsonRecord(input) ? input : {};
    const initial =
      this.state.mode === "replace"
        ? deepCopy(this.properties)
        : this.state.mode === "overwrite"
          ? { ...inputRecord, ...deepCopy(this.properties) }
          : { ...deepCopy(this.properties), ...inputRecord };

    return termKeys.reduce<Record<string, unknown>>((acc, key) => {
      const value = keyed(this.evaluateTerm(this.terms[key], input, warnings, pathIn("", key)));

      if (key.includes(".")) {
        return mergeAtPath(acc, value, key);
      }

      const existing = inputRecord[key];
      return {
        ...acc,
        [key]:
          this.state.mode === "add" && existing !== undefined
            ? existing
            : value,
      };
    }, initial);
  }

  /**
   * One term's value. A failure is named by `label`, where the term sits in
   * the template; an empty value whose reads found nothing is a warning.
   */
  private evaluateTerm(
    term: CompiledExpression,
    params: unknown,
    warnings: Set<string>,
    label: string,
  ): unknown {
    const missing: string[] = [];
    let value: unknown;
    try {
      value = term(params, (path) => missing.push(path));
    } catch (error) {
      throw new TermError(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if ((value === undefined || value === null) && missing.length) {
      warnings.add(`${label}: ${missing.join(", ")} not found`);
    }
    return value;
  }

  /** Notifies what a pass or a template said about itself, when it changed. */
  private report(error: string, warnings: string[]): void {
    if (error !== this.reported.error) {
      this.notify({ error });
    }
    if (JSON.stringify(warnings) !== JSON.stringify(this.reported.warnings)) {
      this.notify({ warnings });
    }
    this.reported = { error, warnings };
  }

  // Merging only applies when both sides are plain objects; a template that
  // produced an array or a scalar replaces the input whatever the mode.
  private mergeWithInput(mapped: unknown, input: unknown): unknown {
    if (
      this.state.mode === "replace" ||
      !isJsonRecord(mapped) ||
      !isJsonRecord(input)
    ) {
      return mapped;
    }

    return this.state.mode === "overwrite"
      ? { ...input, ...mapped }
      : { ...mapped, ...input };
  }

  private evaluateNode(
    node: TemplateNode,
    params: unknown,
    warnings: Set<string>,
    label: string,
  ): unknown {
    if (node.type === "value") {
      return deepCopy(node.value);
    }

    if (node.type === "expression") {
      return this.evaluateTerm(node.expression, params, warnings, label);
    }

    if (node.type === "array") {
      return node.items.map((item, index) =>
        keyed(this.evaluateNode(item, params, warnings, pathIn(label, String(index)))),
      );
    }

    const entries = node.entries;
    if (isLoneTerm(node)) {
      return keyed(this.evaluateNode(entries[0].node, params, warnings, pathIn(label, "")));
    }

    const out: Record<string, unknown> = {};
    for (const entry of entries) {
      const value = keyed(
        this.evaluateNode(entry.node, params, warnings, pathIn(label, entry.key)),
      );
      if (entry.key.includes(".")) {
        mergeAtPath(out, value, entry.key);
      } else {
        out[entry.key] = value;
      }
    }
    return out;
  }

  private updateTemplate(template: unknown): void {
    this.structuredTemplate = undefined;
    this.terms = {};
    this.properties = {};

    if (isStructuredTemplate(template)) {
      this.state.template = deepCopy(template);
      this.structuredTemplate = compileTemplate(template);
      this.notify({ template: deepCopy(this.state.template) });
      this.report(firstParseError(this.structuredTemplate, ""), []);
      return;
    }

    const flat = isJsonRecord(template) ? template : {};
    this.state.template = flatten(flat); // stored flat for persistence

    for (const [key, value] of Object.entries(flat)) {
      if (key.endsWith("=")) {
        this.terms[key.slice(0, -1)] = compileExpression(value);
        continue;
      }

      if (key.includes(".")) {
        mergeAtPath(this.properties, value, key);
      } else {
        this.properties[key] = value;
      }
    }

    this.notify({ template: deepCopy(this.state.template) });
    const broken = Object.entries(this.terms).find(([, term]) => term.parseError);
    this.report(broken ? `${pathIn("", broken[0])}: ${broken[1].parseError}` : "", []);
  }

  private updateSensingMode(isActive: boolean): void {
    this.state.sensingMode = isActive;
    this.notify({ sensingMode: isActive });
  }

  private async runCommand(command: JsonRecord): Promise<void> {
    if (command.action !== "inject") {
      return;
    }

    const output = this.process(command.params, () => {});
    if (output === null || output === undefined || !this.host) {
      return;
    }

    // Push the injected result through the rest of the pipeline, the way an
    // autonomously emitting service does — the runtime fans the notifications
    // out to its own targets, so none are re-sent here.
    const result = await this.host.processFrom(this.uuid, output, () => {});
    this.host.emitResult(result);
  }

  private notify(payload: JsonRecord): void {
    this.host?.notify(payload, this.uuid);
  }
}

/** An object of a lone "=" key, which stands for its term's value. */
function isLoneTerm(node: TemplateNode): boolean {
  return (
    node.type === "object" &&
    node.entries.length === 1 &&
    node.entries[0].dynamic &&
    node.entries[0].key === ""
  );
}

/**
 * Where a term sits in a template: `items.0.title`. A lone "=" adds nothing to
 * the path, since it stands for the value it sits in; at the top it is named
 * "=". The one rule both configuring and a pass name a term by, so the same
 * failure is said in the same words.
 */
function pathIn(label: string, key: string): string {
  if (!key) {
    return label || "=";
  }
  return label ? `${label}.${key}` : key;
}

/**
 * A term's value under a key: a read that found nothing still produces the
 * key, as null, so the output has the same shape in every runtime.
 */
function keyed(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** The first term in a structured template that does not parse, named. */
function firstParseError(node: TemplateNode, label: string): string {
  if (node.type === "expression") {
    return node.expression.parseError
      ? `${label}: ${node.expression.parseError}`
      : "";
  }
  if (node.type === "array") {
    for (const [index, item] of node.items.entries()) {
      const error = firstParseError(item, pathIn(label, String(index)));
      if (error) {
        return error;
      }
    }
  }
  if (node.type === "object") {
    for (const entry of node.entries) {
      const error = firstParseError(entry.node, pathIn(label, entry.key));
      if (error) {
        return error;
      }
    }
  }
  return "";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// An array, or an object with an object/array somewhere in it, keeps its shape;
// anything else is a flat key/value template.
function isStructuredTemplate(template: unknown): boolean {
  if (Array.isArray(template)) {
    return true;
  }

  if (!isJsonRecord(template)) {
    return false;
  }

  return Object.values(template).some(
    (value) => value !== null && typeof value === "object",
  );
}

function compileTemplate(template: unknown): TemplateNode {
  if (Array.isArray(template)) {
    return {
      type: "array",
      items: template.map((item) => compileTemplate(item)),
    };
  }

  if (isJsonRecord(template)) {
    return {
      type: "object",
      entries: Object.keys(template).map((key) => {
        const value = template[key];
        const dynamic = key.endsWith("=");
        return {
          key: dynamic ? key.slice(0, -1) : key,
          dynamic,
          node: dynamic
            ? { type: "expression" as const, expression: compileExpression(value) }
            : compileTemplate(value),
        };
      }),
    };
  }

  return { type: "value", value: template };
}

function flatten(
  value: unknown,
  prefix = "",
  target: Record<string, unknown> = {},
): Record<string, unknown> {
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value as Record<string, unknown>);

  for (const [key, entry] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    const isBranch =
      (isJsonRecord(entry) || Array.isArray(entry)) &&
      Object.keys(entry).length > 0;
    if (isBranch) {
      flatten(entry, path, target);
    } else {
      target[path] = entry;
    }
  }
  return target;
}

function deepCopy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

const MACHINERY = new Set(["__proto__", "constructor", "prototype"]);

function mergeAtPath<T extends Record<string, unknown>>(
  destination: T,
  value: unknown,
  path: string,
): T {
  const target = destination;
  const segments = path.split(".");
  // A segment like `__proto__` leads out of the value into what every object
  // in the process inherits; such a key sets nothing.
  if (segments.some((segment) => MACHINERY.has(segment))) {
    return target;
  }

  segments.reduce<Record<string, unknown>>((branch, segment, index) => {
    const isLast = index === segments.length - 1;
    if (isLast) {
      branch[segment] = value;
      return branch;
    }

    const current = branch[segment];
    if (!isJsonRecord(current)) {
      branch[segment] = {};
    }

    return branch[segment] as Record<string, unknown>;
  }, target);

  return target;
}
