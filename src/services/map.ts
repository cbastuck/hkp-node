/**
 * Service Documentation
 * Service ID: map
 * Service Name: Map
 * Runtime: hkp-node
 * Modes: replace | add | overwrite | sensingMode
 * Key Config: template, mode, arrayMode, sensingMode
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
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { CompiledExpression, compileExpression } from "./expression";

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

    if (isJsonRecord(config.command)) {
      this.runCommand(config.command);
    }

    return this.getState();
  }

  getState(): JsonRecord {
    return {
      mode: this.state.mode,
      arrayMode: this.state.arrayMode,
      template: deepCopy(this.state.template),
      sensingMode: this.state.sensingMode,
    };
  }

  process(input: unknown, _notify: (payload: unknown) => void): unknown {
    if (this.state.sensingMode) {
      this.updateTemplate(
        isJsonRecord(input) || Array.isArray(input)
          ? flatten(input)
          : { value: input },
      );
      this.updateSensingMode(false);
      return null;
    }

    if (this.state.arrayMode !== "single" && Array.isArray(input)) {
      return input.map((entry) => this.mapper(entry));
    }

    if (
      !this.structuredTemplate &&
      !Object.keys(this.terms).length &&
      !Object.keys(this.properties).length
    ) {
      return this.state.mode === "replace" ? {} : input;
    }

    return this.mapper(input);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private mapper(input: unknown): unknown {
    try {
      if (this.structuredTemplate) {
        return this.mergeWithInput(
          this.evaluateNode(this.structuredTemplate, input),
          input,
        );
      }

      const termKeys = Object.keys(this.terms);
      // A lone "=" key maps to a scalar rather than to an object.
      if (termKeys.length === 1 && termKeys[0] === "") {
        return this.terms[termKeys[0]](input);
      }

      const inputRecord = isJsonRecord(input) ? input : {};
      const initial =
        this.state.mode === "replace"
          ? deepCopy(this.properties)
          : this.state.mode === "overwrite"
            ? { ...inputRecord, ...deepCopy(this.properties) }
            : { ...deepCopy(this.properties), ...inputRecord };

      return termKeys.reduce<Record<string, unknown>>((acc, key) => {
        const value = this.terms[key](input);

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
    } catch (error) {
      console.error(
        "MapService.process error",
        error,
        JSON.stringify(this.state.template ?? {}),
      );
      return input;
    }
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

  private evaluateNode(node: TemplateNode, params: unknown): unknown {
    if (node.type === "value") {
      return deepCopy(node.value);
    }

    if (node.type === "expression") {
      return node.expression(params);
    }

    if (node.type === "array") {
      return node.items.map((item) => this.evaluateNode(item, params));
    }

    const entries = node.entries;
    if (
      entries.length === 1 &&
      entries[0].dynamic &&
      entries[0].key === "" &&
      entries[0].node.type === "expression"
    ) {
      return this.evaluateNode(entries[0].node, params);
    }

    const out: Record<string, unknown> = {};
    for (const entry of entries) {
      const value = this.evaluateNode(entry.node, params);
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
  }

  private updateSensingMode(isActive: boolean): void {
    this.state.sensingMode = isActive;
    this.notify({ sensingMode: isActive });
  }

  private runCommand(command: JsonRecord): void {
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
    const result = this.host.processFrom(this.uuid, output, () => {});
    this.host.emitResult(result);
  }

  private notify(payload: JsonRecord): void {
    this.host?.notify(payload, this.uuid);
  }
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

function mergeAtPath<T extends Record<string, unknown>>(
  destination: T,
  value: unknown,
  path: string,
): T {
  const target = destination;
  const segments = path.split(".");

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
