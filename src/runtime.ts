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
import { MountHandle, MountHandlers } from "./mounts";

/**
 * Grants a runtime's services public endpoints. Supplied by the server, which
 * owns the listening socket; absent for inner sub-service pipelines, which are
 * not addressable from outside.
 */
export type RuntimeMounts = {
  mount(serviceUuid: string, handlers: MountHandlers): MountHandle | null;
};

export class HostedRuntime implements RuntimeHost {
  readonly id: string;
  readonly name: string;
  readonly boardName: string;
  /** See RuntimeConfiguration.garbageCollected. Absent means persist. */
  readonly garbageCollected: boolean;

  private readonly services = new Map<string, HostedService>();
  private serviceOrder: string[] = [];
  private readonly notificationTargets = new Set<
    (notification: RuntimeNotification) => void
  >();
  private readonly resultTargets = new Set<(result: unknown) => void>();
  private readonly createService: ServiceCreator;
  private readonly mounts?: RuntimeMounts;

  constructor(
    config: RuntimeConfiguration,
    createService: (config: ServiceConfiguration) => HostedService,
    mounts?: RuntimeMounts,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.boardName = config.boardName ?? "";
    this.garbageCollected = config.garbageCollected === true;
    this.createService = createService;
    this.mounts = mounts;

    for (const serviceConfig of config.services) {
      this.addService(serviceConfig);
    }
  }

  serialize(outputUrl?: string): RuntimeDescriptor {
    const descriptor: RuntimeDescriptor = {
      id: this.id,
      name: this.name,
      garbageCollected: this.garbageCollected,
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

    // A service pushing from itself (a Timer tick, an inbound message, a peer
    // event) was never called by the loop below, so the loop never reported it.
    // Report it here, or the UI shows a service producing nothing while the
    // service after it plainly receives data.
    this.emitNotification(
      {
        instanceId: startAfterUuid,
        payload: { __internal: { state: "call-process", data: null } },
      },
      onNotification,
    );
    this.emitNotification(
      {
        instanceId: startAfterUuid,
        payload: { __internal: { state: "call-process-finished", data: input } },
      },
      onNotification,
    );

    return this.processFromIndex(startIndex, input, onNotification);
  }

  notify(payload: unknown, instanceId: string): void {
    this.emitNotification({ instanceId, payload }, () => {});
  }

  mount(serviceUuid: string, handlers: MountHandlers): MountHandle | null {
    return this.mounts?.mount(serviceUuid, handlers) ?? null;
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

/**
 * A single tenant's view of the runtime app. Runtime ids are only unique within
 * an owner — boards ship stable, human-readable ids (`node`, `chat-node`), so
 * two users loading the same board must each get their own runtime rather than
 * sharing one. Every route resolves runtimes through one of these views, so a
 * handler cannot reach another tenant's runtime even by id.
 */
export class TenantRuntimes {
  constructor(
    readonly owner: string,
    private readonly app: RuntimeApp,
  ) {}

  createRuntime(config: RuntimeConfiguration): HostedRuntime {
    return this.app.createRuntime(this.owner, config);
  }

  getRuntime(runtimeId: string): HostedRuntime | undefined {
    return this.app.getRuntime(this.owner, runtimeId);
  }

  getRuntimes(): HostedRuntime[] {
    return this.app.getRuntimes(this.owner);
  }

  removeRuntime(runtimeId: string): boolean {
    return this.app.removeRuntime(this.owner, runtimeId);
  }

  removeAllRuntimes(): void {
    this.app.removeAllRuntimes(this.owner);
  }
}

export class RuntimeApp {
  // ownerKey → runtimeId → runtime. The owner key is the authenticated `sub`
  // (or "anonymous" when auth is off, collapsing to a single bucket).
  private readonly runtimes = new Map<string, Map<string, HostedRuntime>>();

  constructor(
    private readonly registry: Map<string, HostedServiceFactory>,
    // Supplied by the server, which owns the listening socket. Absent in tests
    // and anywhere runtimes need no public endpoints.
    private readonly mountsFor?: (
      owner: string,
      runtimeId: string,
    ) => RuntimeMounts,
  ) {}

  /** A tenant-scoped view; the only way route handlers reach runtimes. */
  forOwner(owner: string): TenantRuntimes {
    return new TenantRuntimes(owner, this);
  }

  createRuntime(owner: string, config: RuntimeConfiguration): HostedRuntime {
    const owned = this.ownerRuntimes(owner);
    const existing = owned.get(config.id);
    existing?.destroy();

    const runtime = new HostedRuntime(
      config,
      (serviceConfig) => this.createService(serviceConfig),
      this.mountsFor?.(owner, config.id),
    );
    owned.set(runtime.id, runtime);
    return runtime;
  }

  getRuntime(owner: string, runtimeId: string): HostedRuntime | undefined {
    return this.runtimes.get(owner)?.get(runtimeId);
  }

  getRuntimes(owner: string): HostedRuntime[] {
    const owned = this.runtimes.get(owner);
    return owned ? [...owned.values()] : [];
  }

  removeRuntime(owner: string, runtimeId: string): boolean {
    const owned = this.runtimes.get(owner);
    if (!owned) {
      return false;
    }
    const runtime = owned.get(runtimeId);
    runtime?.destroy();
    const deleted = owned.delete(runtimeId);
    if (owned.size === 0) {
      this.runtimes.delete(owner);
    }
    return deleted;
  }

  removeAllRuntimes(owner: string): void {
    const owned = this.runtimes.get(owner);
    if (!owned) {
      return;
    }
    for (const runtime of owned.values()) {
      runtime.destroy();
    }
    this.runtimes.delete(owner);
  }

  getRegistry() {
    return [...this.registry.values()].map((entry) => entry.descriptor);
  }

  private ownerRuntimes(owner: string): Map<string, HostedRuntime> {
    const existing = this.runtimes.get(owner);
    if (existing) {
      return existing;
    }
    const created = new Map<string, HostedRuntime>();
    this.runtimes.set(owner, created);
    return created;
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
