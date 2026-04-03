import {
  HostedService,
  JsonRecord,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const mapDescriptor: ServiceRegistryEntry = {
  serviceId: "map",
  serviceName: "Map",
  version: "v1",
  capabilities: [],
};

type MapMode = "replace" | "add" | "overwrite";

type MapState = JsonRecord & {
  mode: MapMode;
  template: JsonRecord;
  sensingMode: boolean;
};

export class MapService implements HostedService {
  readonly serviceId = mapDescriptor.serviceId;
  readonly serviceName = mapDescriptor.serviceName;
  readonly version = mapDescriptor.version;
  readonly capabilities = mapDescriptor.capabilities;
  readonly uuid: string;

  private state: MapState;
  private terms: Record<string, unknown> = {};
  private properties: Record<string, unknown> = {};

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    this.state = {
      mode: "replace",
      template: {},
      sensingMode: false,
    };

    if (config.state) {
      this.configure(config.state);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    if (isJsonRecord(config.template)) {
      this.updateTemplate(config.template);
    }

    if (
      config.mode === "replace" ||
      config.mode === "add" ||
      config.mode === "overwrite"
    ) {
      this.state.mode = config.mode;
    }

    if (typeof config.sensingMode === "boolean") {
      this.state.sensingMode = config.sensingMode;
    }

    return this.getState();
  }

  getState(): JsonRecord {
    return {
      mode: this.state.mode,
      template: { ...this.state.template },
      sensingMode: this.state.sensingMode,
    };
  }

  process(input: unknown, _notify: (payload: unknown) => void): unknown {
    if (this.state.sensingMode) {
      if (isJsonRecord(input)) {
        this.updateTemplate(input);
      } else {
        this.updateTemplate({ value: input });
      }
      this.state.sensingMode = false;
      return null;
    }

    if (Array.isArray(input)) {
      return input.map((entry) => this.mapper(entry));
    }

    if (
      !Object.keys(this.terms).length &&
      !Object.keys(this.properties).length
    ) {
      return this.state.mode === "replace" ? {} : input;
    }

    return this.mapper(input);
  }

  private mapper(input: unknown): unknown {
    try {
      const termKeys = Object.keys(this.terms);
      if (termKeys.length === 1 && termKeys[0] === "") {
        return evaluateExpression(this.terms[termKeys[0]], input);
      }

      const inputRecord = isJsonRecord(input) ? input : {};
      const initial =
        this.state.mode === "replace"
          ? deepCopy(this.properties)
          : this.state.mode === "overwrite"
            ? { ...inputRecord, ...deepCopy(this.properties) }
            : { ...deepCopy(this.properties), ...inputRecord };

      return termKeys.reduce<Record<string, unknown>>((acc, key) => {
        const expression = this.terms[key];
        const value = evaluateExpression(expression, input);

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
        JSON.stringify(this.state.template || {}),
      );
      return input;
    }
  }

  private updateTemplate(template: Record<string, unknown>): void {
    this.state.template = flattenObject(template);

    this.properties = {};
    this.terms = {};

    for (const [key, value] of Object.entries(template)) {
      if (key.endsWith("=")) {
        this.terms[key.slice(0, -1)] = value;
        continue;
      }

      if (key.includes(".")) {
        this.properties = mergeAtPath(this.properties, value, key);
      } else {
        this.properties[key] = value;
      }
    }
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenObject(
  value: Record<string, unknown>,
  prefix = "",
  target: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isJsonRecord(entry) && Object.keys(entry).length > 0) {
      flattenObject(entry, path, target);
    } else {
      target[path] = entry;
    }
  }
  return target;
}

function evaluateExpression(expression: unknown, params: unknown): unknown {
  if (typeof expression !== "string") {
    return expression;
  }

  const evaluator = new Function(
    "params",
    `"use strict"; return (${expression});`,
  ) as (params: unknown) => unknown;
  return evaluator(params);
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
