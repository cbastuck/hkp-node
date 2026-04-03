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
  services: ServiceConfiguration[];
  inputs?: Array<Record<string, unknown>>;
};

export type RuntimeDescriptor = {
  id: string;
  name: string;
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
