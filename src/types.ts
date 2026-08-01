import { MountHandle, MountHandlers } from "./mounts";

export type JsonRecord = Record<string, unknown>;

export type ServiceRegistryEntry = {
  serviceId: string;
  serviceName: string;
  version?: string;
  capabilities?: string[];
};

export type ServiceConfiguration = {
  serviceId: string;
  uuid: string;
  name?: string;
  serviceName?: string;
  state?: JsonRecord;
};

export type RuntimeConfiguration = {
  id: string;
  name: string;
  boardName?: string;
  /**
   * Whether this runtime should be torn down once the last client that was
   * connected to it disconnects.
   *
   * Declared by whoever creates it, because only they know: a browser
   * provisioning a board it is running says `true` — it is the controller, and
   * its runtimes should not outlive it — while a coordinator, a config file or
   * a script says nothing and gets a runtime that lives until it is deleted.
   *
   * Absent means persist. Cleanup is opted into, so nothing that exists today
   * starts disappearing, and a runtime is never reaped because of who happened
   * to connect to it.
   */
  garbageCollected?: boolean;
  services: ServiceConfiguration[];
  inputs?: Array<Record<string, unknown>>;
};

export type RuntimeDescriptor = {
  id: string;
  name: string;
  /** How this runtime is cleaned up; see RuntimeConfiguration. Reported so a
   *  client can see whether it outlives them. */
  garbageCollected?: boolean;
  boardName: string;
  services: ServiceDescriptor[];
  inputs: Array<Record<string, unknown>>;
  outputUrl?: string;
};

export type ServiceDescriptor = {
  serviceId: string;
  serviceName: string;
  version?: string;
  capabilities?: string[];
  uuid: string;
  state: JsonRecord;
};

export interface HostedService {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly version?: string;
  readonly capabilities?: string[];
  readonly uuid: string;
  configure(config: JsonRecord): JsonRecord;
  getState(): JsonRecord;
  process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): unknown;
  setHost?(host: RuntimeHost): void;
  destroy?(): void;
}

export type ServiceCreator = (config: ServiceConfiguration) => HostedService;

export type HostedServiceFactory = {
  descriptor: ServiceRegistryEntry;
  create: (
    config: ServiceConfiguration,
    createService: ServiceCreator,
  ) => HostedService;
};

export type RuntimeNotification = {
  instanceId: string;
  payload: unknown;
};

export interface RuntimeHost {
  processFrom(
    startAfterUuid: string,
    data: unknown,
    onNotification: (notification: RuntimeNotification) => void,
  ): unknown;
  notify(payload: unknown, instanceId: string): void;
  emitResult(output: unknown): void;
  /**
   * Claim a publicly reachable endpoint served by the shared server, for a
   * service that needs to be called from outside (an HTTP endpoint, a
   * signalling server). Returns null when the host cannot serve mounts — an
   * inner sub-service pipeline, or a server that is not listening yet — in
   * which case the service has no public endpoint and should say so in its
   * state rather than falling back to a port of its own.
   */
  mount?(serviceUuid: string, handlers: MountHandlers): MountHandle | null;
}
