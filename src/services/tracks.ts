/**
 * Service Documentation
 * Service ID: tracks
 * Service Name: Tracks
 * Runtime: hkp-node
 * Modes: serial | parallel
 * Key Config: tracks, reduce, run, bypass
 * IO: in=any -> out=what the reducer made of the tracks' answers
 * Arrays: the answers are an array, one element per track, in declaration order
 * Binary: handed to every track untouched
 * MixedData: not native in runtime
 *
 * Several pipelines over one input, and one answer out.
 *
 * `iterator` runs one pipeline over many items. This is the other half of that
 * pair: many pipelines over one item. A board that has to do two unrelated
 * things with the same value — write it to a table *and* tell somebody about
 * it, ask three services and compare — has until now had to fake it by putting
 * those things in a row and teaching each of them to pass its input through.
 * That works and says nothing: nothing in the board records that they are
 * siblings rather than a sequence, in which order they may run, or which of
 * their answers matters.
 *
 *     input ──┬── track ── answer ──┬── reduce ── output
 *             ├── track ── answer ──┤
 *             └── track ── answer ──┘
 *
 * **Every track is given the same input.** They do not feed each other, which
 * is the whole point: a track can be read on its own.
 *
 * **`run` says whether that happens one at a time or all at once**, and the
 * default is one at a time. Two tracks writing to the same table are a race the
 * moment they overlap, and a board author should have to ask for concurrency
 * rather than discover it. `parallel` is for tracks that wait on something
 * else — an HTTP call, another runtime — where the waiting is the cost.
 * Whichever is chosen, the answers come back in **declaration order**: how they
 * were run is not something the next service should be able to tell.
 *
 * **The answers are an array with one element per track, nulls included.** A
 * track that stopped — declined, found nothing, failed — leaves a hole rather
 * than being left out, so position still names the track that produced it, and
 * a missing answer is visible rather than absent.
 *
 * **`reduce` is a pipeline, not a list of strategies.** Taking the first answer,
 * merging them, keeping only what came in — these are all one `map` term, and a
 * board that needs something stranger writes more services rather than waiting
 * for a strategy to be added here. It is given `{ input, results }`: the value
 * the tracks were run on, and what they answered. Carrying on as though the
 * tracks were side effects is then `{"=": "params.input"}`, which is the common
 * case and needs nothing else. With no reducer configured the answers travel on
 * as they are.
 *
 * A reducer that returns `null` stops the pipeline, as any service does. That
 * is the only way this service stops: an array of nothing but nulls is still an
 * array, and whether it means "stop" is the board's to say.
 */
import {
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  RuntimeScope,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
  HostedService,
  SlotStore,
} from "../types";
import { MOUNT_FIELD, collectMountRefs } from "../coordinator/mount";
import { isJsonRecord, NestedPipeline, PipelineEntryState } from "./nested-pipeline";

export const tracksDescriptor: ServiceRegistryEntry = {
  serviceId: "tracks",
  serviceName: "Tracks",
  version: "v1",
  // Like every service holding a pipeline: the board's UI needs to know there
  // is something to look inside.
  capabilities: ["subservices"],
};

/** How the tracks are run. Serial is the default, and the safe one. */
type RunMode = "serial" | "parallel";

const RUN_MODES: RunMode[] = ["serial", "parallel"];

/**
 * The name the reducer answers to when a pipeline edit names a branch. A track
 * may not take it, the same way a dispatcher reserves `decide`.
 */
export const REDUCE = "reduce";

type Track = {
  name: string;
  /** A track switched off contributes a hole, like one that stopped. */
  bypass: boolean;
  pipeline: NestedPipeline;
};

export class TracksService implements HostedService {
  readonly serviceId = tracksDescriptor.serviceId;
  readonly serviceName = tracksDescriptor.serviceName;
  readonly version = tracksDescriptor.version;
  readonly capabilities = tracksDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private bypass = false;
  private run: RunMode = "serial";
  /**
   * The cells this service's pipelines hold values in.
   *
   * Owned here, like an endpoint's: the branches are pipelines of one
   * arrangement, so a value one leaves for another belongs to this service
   * rather than to the runtime around it — and two of these on a runtime may
   * both use a name without meeting. A scope says the same thing with
   * `scope: { slots: "own" }`; here it is what the service is.
   */
  private readonly slotStore: SlotStore = new Map<string, unknown>();
  private tracks: Track[] = [];
  private reduce: NestedPipeline;
  private lastError = "";

  constructor(
    config: ServiceConfiguration,
    private readonly createService: ServiceCreator,
  ) {
    this.uuid = config.uuid;
    this.reduce = new NestedPipeline(`${this.uuid}:${REDUCE}`, createService, this.uuid);
    this.reduce.shareSlots(this.slotStore);

    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
    this.reduce.attach(host);
    for (const track of this.tracks) {
      track.pipeline.attach(host);
    }
  }

  /** Passes the scope on to every nested pipeline; see NestedPipeline.setScope. */
  setScope(scope: RuntimeScope): void {
    this.reduce.setScope(scope);
    for (const track of this.tracks) {
      track.pipeline.setScope(scope);
    }
  }

  /**
   * The nested service a scoped address names, tracks first and in declaration
   * order, then the reducer. A name used in two tracks resolves to the earlier,
   * which is the cost of addressing a branch by what is in it rather than by
   * the branch's own name.
   */
  findNested(instanceId: string): HostedService | undefined {
    for (const track of this.tracks) {
      const found = track.pipeline.find(instanceId);
      if (found) {
        return found;
      }
    }
    return this.reduce.find(instanceId);
  }

  getState(): JsonRecord {
    return {
      bypass: this.bypass,
      run: this.run,
      tracks: this.tracks.map((track) => ({
        name: track.name,
        bypass: track.bypass,
        pipeline: track.pipeline.state(),
      })),
      reduce: this.reduce.state(),
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    // An edit naming a track is about one pipeline under this service rather
    // than about the service, the same way a dispatcher scopes an edit to a
    // branch. Without it there is no way to say *which* pipeline to append to.
    if (typeof config.track === "string") {
      this.configureTrack(config.track, config);
      return this.getState();
    }

    if (typeof config.bypass === "boolean") {
      this.bypass = config.bypass;
    }
    if (typeof config.run === "string" && RUN_MODES.includes(config.run as RunMode)) {
      this.run = config.run as RunMode;
    }
    if (Array.isArray(config.tracks)) {
      this.setTracks(config.tracks);
    }
    if (Array.isArray(config.reduce)) {
      this.reduce.setPipeline(config.reduce);
    }

    // An address handed to a service holding pipelines is handed on to the
    // services inside them: the coordinator resolves a reference wherever it
    // appears in this service's state, but configures the service it found it
    // on, which for a nested consumer is this one.
    if (typeof config[MOUNT_FIELD] === "string" && config[MOUNT_FIELD]) {
      this.handDownMount(config[MOUNT_FIELD] as string);
    }

    return this.getState();
  }

  async process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (this.bypass || this.tracks.length === 0) {
      return input;
    }

    const parent = this.host?.currentContext() ?? null;
    const results =
      this.run === "parallel"
        ? await Promise.all(this.tracks.map((track) => this.runTrack(track, input, parent)))
        : await this.serially(input, parent);

    if (this.reduce.isEmpty()) {
      return results;
    }
    return this.reduce.process({ input, results }, parent);
  }

  destroy(): void {
    this.reduce.destroy();
    for (const track of this.tracks) {
      track.pipeline.destroy();
    }
    this.tracks = [];
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** One at a time, each awaited before the next begins. */
  private async serially(
    input: unknown,
    parent: ProcessContext | null,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const track of this.tracks) {
      results.push(await this.runTrack(track, input, parent));
    }
    return results;
  }

  /**
   * One track's answer, or null where it has none.
   *
   * A track that throws is reported and leaves a hole, rather than taking the
   * other tracks down with it: they were given the same input and have nothing
   * to do with each other, which is exactly why they are tracks.
   */
  private async runTrack(
    track: Track,
    input: unknown,
    parent: ProcessContext | null,
  ): Promise<unknown> {
    if (track.bypass || track.pipeline.isEmpty()) {
      return null;
    }
    try {
      return await track.pipeline.process(input, parent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `track '${track.name}' failed: ${message}`;
      this.host?.log("error", "service.failed", { message: this.lastError });
      return null;
    }
  }

  private setTracks(value: unknown[]): void {
    const previous = new Map(this.tracks.map((track) => [track.name, track]));
    const next: Track[] = [];

    for (const [index, entry] of value.entries()) {
      if (!isJsonRecord(entry)) {
        throw new Error("every track is an object with a name and a pipeline");
      }
      // A name is what a reducer, a log and a panel call this track. Unnamed,
      // it is called by the position it was declared in, which is at least
      // stable within one board.
      const name = typeof entry.name === "string" && entry.name ? entry.name : `${index}`;
      if (name === REDUCE) {
        throw new Error(`'${REDUCE}' is the reducer's name and cannot be a track's`);
      }
      if (next.some((track) => track.name === name)) {
        throw new Error(`two tracks are both called '${name}'`);
      }

      // A track already here keeps its pipeline: rebuilding it would destroy
      // running services — a mount, a timer — because a track beside it was
      // edited.
      const existing = previous.get(name);
      const pipeline =
        existing?.pipeline ?? new NestedPipeline(`${this.uuid}:${name}`, this.createService, this.uuid);
      pipeline.shareSlots(this.slotStore);
      if (Array.isArray(entry.pipeline)) {
        pipeline.setPipeline(entry.pipeline);
      }
      if (!existing && this.host) {
        pipeline.attach(this.host);
      }

      next.push({
        name,
        bypass: entry.bypass === true,
        pipeline,
      });
      previous.delete(name);
    }

    // Whatever is left was removed, and holds services nothing will reach again.
    for (const dropped of previous.values()) {
      dropped.pipeline.destroy();
    }
    this.tracks = next;
  }

  /** Applies a pipeline edit to one track, or to the reducer. */
  private configureTrack(name: string, config: JsonRecord): void {
    const track = this.tracks.find((entry) => entry.name === name);
    const pipeline = name === REDUCE ? this.reduce : track?.pipeline;
    if (!pipeline) {
      throw new Error(`no track called '${name}'`);
    }

    if (typeof config.bypass === "boolean" && track) {
      track.bypass = config.bypass;
    }
    if (Array.isArray(config.pipeline)) {
      pipeline.setPipeline(config.pipeline);
    }
    if (isJsonRecord(config.appendService)) {
      pipeline.append(config.appendService);
    }
    if (typeof config.removeService === "string") {
      pipeline.remove(config.removeService);
    }
    if (isJsonRecord(config.configureService)) {
      const payload = config.configureService;
      if (typeof payload.instanceId === "string" && isJsonRecord(payload.state)) {
        pipeline.configureService(payload.instanceId, payload.state);
      }
    }
  }

  /**
   * Gives an address to the nested services that named a mount.
   *
   * Only those that named one: a nested service holding no reference is calling
   * something it already has an address for, and must not be repointed at
   * whatever this service was told about.
   */
  private handDownMount(url: string): void {
    const pipelines = [this.reduce, ...this.tracks.map((track) => track.pipeline)];
    for (const pipeline of pipelines) {
      for (const service of pipeline.services()) {
        if (collectMountRefs(service.state as JsonRecord).size === 0) {
          continue;
        }
        if ((service.state as JsonRecord)?.[MOUNT_FIELD] === url) {
          continue;
        }
        pipeline.configureService(service.uuid, { [MOUNT_FIELD]: url });
      }
    }
  }
}

export type { PipelineEntryState };
