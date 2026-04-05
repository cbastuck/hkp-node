/**
 * Service Documentation
 * Service ID: monitor
 * Service Name: Monitor
 * Runtime: hkp-node
 * Modes: observe
 * Key Config: runtime-specific observe/log settings
 * IO: in=any -> out=identity
 * Arrays: pass-through
 * Binary: inspect/log support depends on runtime UI/logging
 * MixedData: not native in runtime
 */
import {
  HostedService,
  JsonRecord,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const monitorDescriptor: ServiceRegistryEntry = {
  serviceId: "monitor",
  serviceName: "Monitor",
};

type MonitorState = JsonRecord & {
  fileLogPath: string;
  logToConsole: boolean;
  message: string;
  renderTextEditor: boolean;
};

export class MonitorService implements HostedService {
  readonly serviceId = monitorDescriptor.serviceId;
  readonly serviceName = monitorDescriptor.serviceName;
  readonly uuid: string;

  private state: MonitorState;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    this.state = {
      fileLogPath: "",
      logToConsole: false,
      message: "",
      renderTextEditor: true,
    };

    if (config.state) {
      this.configure(config.state);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.logToConsole === "boolean") {
      this.state.logToConsole = config.logToConsole;
    }
    if (typeof config.fileLogPath === "string") {
      this.state.fileLogPath = config.fileLogPath;
    }
    if (typeof config.renderTextEditor === "boolean") {
      this.state.renderTextEditor = config.renderTextEditor;
    }
    if (typeof config.message === "string") {
      this.state.message = config.message;
    }
    return this.getState();
  }

  getState(): JsonRecord {
    const { message: _message, ...config } = this.state;
    return config;
  }

  process(input: unknown, notify: (payload: unknown) => void): unknown {
    this.state.message = formatMessage(input);
    if (this.state.logToConsole) {
      // Mirror the C++ monitor service: optional console logging for visibility.
      console.log("[MONITOR]", input);
    }
    notify(input);
    return input;
  }
}

function formatMessage(input: unknown): string {
  if (input === null) {
    return "null";
  }
  if (input === undefined) {
    return "undefined";
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return String(input);
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
