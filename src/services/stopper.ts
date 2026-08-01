/**
 * Service Documentation
 * Service ID: stopper
 * Service Name: Stopper
 * Runtime: hkp-node
 * Modes: none
 * Key Config: none
 * IO: in=anything -> out=null (nothing is forwarded)
 *
 * Returns null on every call, which the runtime reads as "nothing to pass on":
 * the services after it are not called, and the runtime emits no result, so the
 * next runtime in the chain is not driven either.
 *
 * That last part is the reason to reach for it on a board with several
 * runtimes. Runtimes are chained — the result of one becomes the input of the
 * next — so a runtime whose work is a side effect rather than a value should
 * end here, instead of feeding whatever it happened to produce into the next
 * runtime. Mirrors the browser runtime's `hookup.to/service/stopper`.
 */
import {
  HostedService,
  JsonRecord,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const stopperDescriptor: ServiceRegistryEntry = {
  serviceId: "stopper",
  serviceName: "Stopper",
  version: "v1",
  capabilities: [],
};

export class StopperService implements HostedService {
  readonly serviceId = stopperDescriptor.serviceId;
  readonly serviceName = stopperDescriptor.serviceName;
  readonly version = stopperDescriptor.version;
  readonly capabilities = stopperDescriptor.capabilities;
  readonly uuid: string;

  private bypass = false;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  getState(): JsonRecord {
    return { bypass: this.bypass };
  }

  configure(config: JsonRecord): JsonRecord {
    // Bypass is the only setting worth having: it turns the dead end back into
    // a passthrough, so a chain can be opened up without moving services around.
    if (typeof config.bypass === "boolean") {
      this.bypass = config.bypass;
    }
    return this.getState();
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    return this.bypass ? input : null;
  }
}
