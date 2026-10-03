/**
 * Service Documentation
 * Service ID: asset
 * Service Name: Asset
 * Runtime: hkp-node
 * Modes: none
 * Key Config: asset (an `hkp-asset://<id>` reference)
 * IO: in=anything, or a reference naming another asset -> out={meta, body}
 *     for text, {meta, binary} otherwise
 * Arrays: not primary
 * Binary: an asset that is not text leaves as bytes
 * MixedData: not native in runtime
 *
 * Puts one of the board's assets into the pipeline, for any service that has no
 * way of its own to take one. A service that serves, plays or loads content
 * resolves a reference itself; everything else composes with this.
 *
 * **The asset is resolved on every pass**, from the runtime's asset store, so
 * editing the asset changes what the next pass carries without anything being
 * reconfigured.
 *
 * **The input can name the asset.** A bare `hkp-asset://…` string, or an object
 * whose `asset` field is one, takes the place of the configured reference for
 * that pass — so a Map that picks an asset by request path, followed by this,
 * serves whichever one it picked. Any other input only triggers the pass.
 *
 * **The answer is shaped like an HTTP response** (`meta` beside `body` or
 * `binary`, with `status` and `contentType`), like `filesystem`'s: most assets
 * end up served, and an endpoint can hand this straight back. An asset that
 * does not resolve is answered with an error status and reported, never passed
 * on as its reference.
 *
 * Not meant for large content: a model does not belong in a pipeline frame.
 */
import { isTextMediaType, parseAssetRef } from "../assets";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const assetDescriptor: ServiceRegistryEntry = {
  serviceId: "asset",
  serviceName: "Asset",
  version: "v1",
  capabilities: [],
};

type Notify = (payload: unknown, instanceId?: string) => void;

export class AssetService implements HostedService {
  readonly serviceId = assetDescriptor.serviceId;
  readonly serviceName = assetDescriptor.serviceName;
  readonly version = assetDescriptor.version;
  readonly capabilities = assetDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  /** The reference this service emits when its input names none. */
  private asset = "";
  private lastError = "";
  private lastMediaType = "";
  private lastSize = 0;

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
    return {
      asset: this.asset,
      mediaType: this.lastMediaType,
      size: this.lastSize,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.asset === "string") {
      this.asset = config.asset.trim();
    }
    return this.getState();
  }

  async process(input: unknown, notify: Notify): Promise<unknown> {
    const reference = requestedReference(input) ?? this.asset;
    if (!reference) {
      return this.fail(notify, 400, "no asset is configured");
    }
    if (!parseAssetRef(reference)) {
      return this.fail(notify, 400, `${JSON.stringify(reference)} is not an asset reference`);
    }
    const store = this.host?.assets?.();
    if (!store) {
      return this.fail(notify, 500, "this runtime has no assets");
    }

    const { asset, problem } = await store.resolve(reference);
    if (!asset) {
      return this.fail(notify, 404, problem);
    }

    this.lastError = "";
    this.lastMediaType = asset.mediaType;
    this.lastSize = asset.bytes.length;
    notify(this.getState());

    const meta: JsonRecord = {
      status: 200,
      contentType: asset.mediaType,
      asset: asset.id,
      size: asset.bytes.length,
    };
    return isTextMediaType(asset.mediaType)
      ? { meta, body: Buffer.from(asset.bytes).toString("utf8") }
      : { meta, binary: asset.bytes };
  }

  private fail(notify: Notify, status: number, message: string): JsonRecord {
    this.lastError = message;
    notify(this.getState());
    return {
      meta: { status, contentType: "application/json" },
      body: { error: message },
    };
  }
}

/** The reference an input names, when it names one. */
function requestedReference(input: unknown): string | null {
  if (typeof input === "string" && parseAssetRef(input.trim())) {
    return input.trim();
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const named = (input as JsonRecord).asset;
    if (typeof named === "string" && parseAssetRef(named.trim())) {
      return named.trim();
    }
  }
  return null;
}
