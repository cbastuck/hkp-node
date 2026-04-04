import {
  HostedService,
  HostedServiceFactory,
  JsonRecord,
  RuntimeConfiguration,
  RuntimeDescriptor,
  RuntimeHost,
  RuntimeNotification,
  ServiceCreator,
  ServiceConfiguration,
  ServiceDescriptor,
} from "./types";

export class HostedRuntime implements RuntimeHost {
  readonly id: string;
  readonly name: string;
  readonly boardName: string;

  private readonly services = new Map<string, HostedService>();
  private serviceOrder: string[] = [];
  private readonly notificationTargets = new Set<
    (notification: RuntimeNotification) => void
  >();
  private readonly resultTargets = new Set<(result: unknown) => void>();
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

    service.setHost?.(this);

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
    const service = this.services.get(uuid);
    service?.destroy?.();

    const deleted = this.services.delete(uuid);
    if (deleted) {
      this.serviceOrder = this.serviceOrder.filter(
        (serviceUuid) => serviceUuid !== uuid,
      );
    }
    return deleted;
  }

  destroy(): void {
    for (const service of this.services.values()) {
      service.destroy?.();
    }
    this.services.clear();
    this.serviceOrder = [];
    this.notificationTargets.clear();
    this.resultTargets.clear();
  }

  registerNotificationTarget(
    target: (notification: RuntimeNotification) => void,
  ): () => void {
    this.notificationTargets.add(target);
    return () => {
      this.notificationTargets.delete(target);
    };
  }

  registerResultTarget(target: (result: unknown) => void): () => void {
    this.resultTargets.add(target);
    return () => {
      this.resultTargets.delete(target);
    };
  }

  emitResult(output: unknown): void {
    for (const target of this.resultTargets) {
      target(output);
    }
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
    return this.processFromIndex(0, input, onNotification);
  }

  // ── RuntimeHost ────────────────────────────────────────────────────────────

  processFrom(
    startAfterUuid: string,
    input: unknown,
    onNotification: (notification: RuntimeNotification) => void,
  ): unknown {
    const startIndex = this.serviceOrder.indexOf(startAfterUuid) + 1;
    return this.processFromIndex(startIndex, input, onNotification);
  }

  notify(payload: unknown, instanceId: string): void {
    this.emitNotification({ instanceId, payload }, () => {});
  }

  // ──────────────────────────────────────────────────────────────────────────

  private processFromIndex(
    startIndex: number,
    input: unknown,
    onNotification: (notification: RuntimeNotification) => void,
  ): unknown {
    let result: unknown = input;

    for (const uuid of this.serviceOrder.slice(startIndex)) {
      const service = this.services.get(uuid);
      if (!service) {
        continue;
      }

      this.emitNotification(
        {
          instanceId: uuid,
          payload: {
            __internal: {
              state: "call-process",
              data: result,
            },
          },
        },
        onNotification,
      );

      result = service.process(result, (payload, instanceId) => {
        this.emitNotification(
          { instanceId: instanceId ?? uuid, payload },
          onNotification,
        );
      });

      this.emitNotification(
        {
          instanceId: uuid,
          payload: {
            __internal: {
              state: "call-process-finished",
              data: result,
            },
          },
        },
        onNotification,
      );

      if (result === null || result === undefined) {
        break;
      }
    }

    return result;
  }

  private emitNotification(
    notification: RuntimeNotification,
    onNotification: (notification: RuntimeNotification) => void,
  ): void {
    onNotification(notification);
    for (const target of this.notificationTargets) {
      target(notification);
    }
  }
}

export class RuntimeApp {
  private readonly runtimes = new Map<string, HostedRuntime>();

  constructor(private readonly registry: Map<string, HostedServiceFactory>) {}

  createRuntime(config: RuntimeConfiguration): HostedRuntime {
    const existing = this.runtimes.get(config.id);
    existing?.destroy();

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
    const runtime = this.runtimes.get(runtimeId);
    runtime?.destroy();
    return this.runtimes.delete(runtimeId);
  }

  removeAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.destroy();
    }
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
