import {
  HostedService,
  HostedServiceFactory,
  JsonRecord,
  RuntimeConfiguration,
  RuntimeDescriptor,
  RuntimeNotification,
  ServiceCreator,
  ServiceConfiguration,
  ServiceDescriptor,
} from "./types";

export class HostedRuntime {
  readonly id: string;
  readonly name: string;
  readonly boardName: string;

  private readonly services = new Map<string, HostedService>();
  private serviceOrder: string[] = [];
  private readonly createService: ServiceCreator;

  constructor(
    config: RuntimeConfiguration,
    createService: (config: ServiceConfiguration) => HostedService,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.boardName = config.boardName ?? "";
    this.createService = createService;

    for (const serviceConfig of config.services) {
      this.addService(serviceConfig);
    }
  }

  serialize(outputUrl?: string): RuntimeDescriptor {
    const descriptor: RuntimeDescriptor = {
      id: this.id,
      name: this.name,
      boardName: this.boardName,
      services: this.listServices(),
      inputs: [],
    };

    if (outputUrl) {
      descriptor.outputUrl = outputUrl;
    }

    return descriptor;
  }

  listServices(): ServiceDescriptor[] {
    return this.serviceOrder
      .map((serviceId) => this.services.get(serviceId))
      .filter((service): service is HostedService => Boolean(service))
      .map((service) => ({
        serviceId: service.serviceId,
        serviceName: service.serviceName,
        version: service.version,
        capabilities: service.capabilities,
        uuid: service.uuid,
        state: service.getState(),
      }));
  }

  getService(uuid: string): HostedService | undefined {
    return this.services.get(uuid);
  }

  addService(config: ServiceConfiguration): JsonRecord {
    if (this.services.has(config.uuid)) {
      throw new Error(`Service already exists: ${config.uuid}`);
    }

    const service = this.createService(config);
    this.services.set(service.uuid, service);
    this.serviceOrder.push(service.uuid);
    return service.getState();
  }

  configureService(uuid: string, config: JsonRecord): JsonRecord | null {
    const service = this.services.get(uuid);
    if (!service) {
      return null;
    }
    return service.configure(config);
  }

  removeService(uuid: string): boolean {
    const deleted = this.services.delete(uuid);
    if (deleted) {
      this.serviceOrder = this.serviceOrder.filter(
        (serviceUuid) => serviceUuid !== uuid,
      );
    }
    return deleted;
  }

  rearrangeServices(newOrder: string[]): boolean {
    if (newOrder.length !== this.serviceOrder.length) {
      return false;
    }

    const known = new Set(this.serviceOrder);
    for (const uuid of newOrder) {
      if (!known.has(uuid)) {
        return false;
      }
    }

    this.serviceOrder = [...newOrder];
    return true;
  }

  process(
    input: unknown,
    onNotification: (notification: RuntimeNotification) => void,
  ): unknown {
    let result: unknown = input;
    for (const uuid of this.serviceOrder) {
      const service = this.services.get(uuid);
      if (!service) {
        continue;
      }

      onNotification({
        instanceId: uuid,
        payload: {
          __internal: {
            state: "call-process",
            data: result,
          },
        },
      });

      result = service.process(result, (payload, instanceId) => {
        onNotification({ instanceId: instanceId ?? uuid, payload });
      });

      onNotification({
        instanceId: uuid,
        payload: {
          __internal: {
            state: "call-process-finished",
            data: result,
          },
        },
      });

      if (result === null || result === undefined) {
        break;
      }
    }

    return result;
  }
}

export class RuntimeApp {
  private readonly runtimes = new Map<string, HostedRuntime>();

  constructor(private readonly registry: Map<string, HostedServiceFactory>) {}

  createRuntime(config: RuntimeConfiguration): HostedRuntime {
    const runtime = new HostedRuntime(config, (serviceConfig) =>
      this.createService(serviceConfig),
    );
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  getRuntime(runtimeId: string): HostedRuntime | undefined {
    return this.runtimes.get(runtimeId);
  }

  getRuntimes(): HostedRuntime[] {
    return [...this.runtimes.values()];
  }

  removeRuntime(runtimeId: string): boolean {
    return this.runtimes.delete(runtimeId);
  }

  removeAllRuntimes(): void {
    this.runtimes.clear();
  }

  getRegistry() {
    return [...this.registry.values()].map((entry) => entry.descriptor);
  }

  createService(config: ServiceConfiguration): HostedService {
    const factory = this.registry.get(config.serviceId);
    if (!factory) {
      throw new Error(`Unknown serviceId: ${config.serviceId}`);
    }
    return factory.create(config, (serviceConfig) =>
      this.createService(serviceConfig),
    );
  }
}
