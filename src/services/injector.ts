/**
 * Service Documentation
 * Service ID: injector
 * Service Name: Injector
 * Runtime: hkp-node
 * Modes: none
 * Key Config: inject, injectBinary, recentInjection, plainText
 * IO: in=any -> out=stored injection (or identity when nothing was injected)
 * Arrays: pass-through
 * Binary: supported (base64 via injectBinary, decoded to a Buffer)
 * MixedData: pass-through only
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const injectorDescriptor: ServiceRegistryEntry = {
  serviceId: "injector",
  serviceName: "Injector",
};

export class InjectorService implements HostedService {
  readonly serviceId = injectorDescriptor.serviceId;
  readonly serviceName = injectorDescriptor.serviceName;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private injection: unknown = undefined;
  private hasInjection = false;
  private plainText = false;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  getState(): JsonRecord {
    return this.injectionState();
  }

  configure(config: JsonRecord): JsonRecord {
    if (config.inject !== undefined) {
      this.setInjection(config.inject);
      this.emitInjection();
    }

    if (typeof config.injectBinary === "string") {
      this.setInjection(Buffer.from(config.injectBinary, "base64"));
      this.emitInjection();
    }

    // Restores what was injected (e.g. from persisted board state) without
    // re-triggering the pipeline the way inject/injectBinary do.
    if (config.recentInjection !== undefined) {
      this.setInjection(config.recentInjection);
    }

    if (typeof config.plainText === "boolean") {
      this.plainText = config.plainText;
      this._notify({ plainText: this.plainText });
    }

    return this.getState();
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    return this.hasInjection ? this.injection : input;
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private setInjection(value: unknown): void {
    this.injection = value;
    this.hasInjection = true;
    this._notify(this.injectionState());
  }

  /**
   * Runs the services after Injector with the value just set. inject and
   * injectBinary act immediately rather than waiting for the next call to
   * reach this service, mirroring the browser (`app.next`) and hkp-rt
   * (`emit`) implementations.
   */
  private emitInjection(): void {
    const host = this.host;
    if (!host) {
      return;
    }
    // No-op notification callback: processFrom already fans notifications out
    // to the runtime's own notification targets, so re-notifying through the
    // host here would deliver every one twice.
    void host
      .processFrom(this.uuid, this.injection, (_n: RuntimeNotification) => {})
      .then((result) => host.emitResult(result));
  }

  /**
   * The stored injection as it is reported to the frontend. A binary payload
   * is described by its size instead of being echoed back.
   */
  private injectionState(): JsonRecord {
    const state: JsonRecord = { plainText: this.plainText };
    if (!this.hasInjection) {
      return state;
    }
    if (this.injection instanceof Uint8Array) {
      state.recentInjectionSize = this.injection.length;
    } else {
      state.recentInjection = this.injection;
    }
    return state;
  }

  private _notify(payload: JsonRecord, instanceId: string = this.uuid): void {
    this.host?.notify(payload, instanceId);
  }
}
