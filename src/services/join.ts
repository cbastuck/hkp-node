/**
 * Service Documentation
 * Service ID: join
 * Service Name: Join
 * Runtime: hkp-node
 * Modes: overwrite | add
 * Key Config: as, mode, onFailure (stop | merge), pipeline, bypass
 * IO: in=any -> out=the input and the nested pipeline's result, together
 * Arrays: the input is one value; nesting an `iterator` handles arrays
 * Binary: passed to the nested pipeline untouched
 * MixedData: not native in runtime
 *
 * Splitting off a piece of work and getting the answer back **beside** what you
 * already had, rather than instead of it.
 *
 * Most services replace their input: `text-generation` answers with an answer,
 * not with the question and the answer. That is right for the service and wrong
 * for the pipeline around it, because whatever the input was carrying — which
 * conversation this is, which record it came from — is gone by the time the
 * answer arrives, and the service that has to file the answer no longer knows
 * where it belongs.
 *
 * The usual workarounds are all bad: teach every service to pass its input
 * through, which makes every output a pile of everything that ever touched it;
 * ask a model to echo an id back, which makes correctness a matter of the model
 * being careful; or keep the id somewhere on the side, which stops working the
 * moment two runs overlap. Join is the structural answer — the carrier never
 * goes anywhere, because the nested pipeline is a detour rather than the road.
 *
 *     input ──┬──────────────────────────────► merged output
 *             └── nested pipeline ── result ──┘
 *
 * **`as` is the safe way to use it.** Naming a key puts the result there, and
 * nothing the nested pipeline produces can collide with what the input was
 * carrying. Merging at the top level is available for the cases where the two
 * shapes are known to be disjoint.
 *
 * A nested pipeline that **stops** — returns `null` — stops this one too. The
 * merge is the reason the Join is there, so continuing without it would hand
 * the services downstream an input that looks like a successful merge and is
 * not: a board that files the result would file nothing, under a name that says
 * it filed something.
 *
 * **Unless it stopped because something in it failed, and the board asked to
 * hear about it** (`onFailure: "merge"`). A detour can end with nothing for two
 * reasons: a service chose to stop — a filter, a claim that found nothing to
 * take — or a service failed, and said why in an `error` notification. The
 * first is flow and still stops. The second, with `merge`, passes the input on
 * with `{ error, service }` where the result would have gone, so the services
 * after the Join can record the failure beside the thing it happened to rather
 * than the run ending with the reason in a notification nobody kept. Only a
 * service directly in the detour is heard: one inside a scope of its own
 * reports to that scope.
 *
 * A detour that takes its time is still a detour: the runtime awaits every
 * service, so a nested `text-generation` taking a minute is waited for and its
 * answer merged like any other. That is the whole reason the pipeline awaits —
 * without it a service answering late has to call the rest of the pipeline
 * itself, and there is no longer an input for anything to be re-joined with.
 */
import {
  JsonRecord,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";
import { childRun } from "../runtime";
import { SubService } from "./sub-service";

export const joinDescriptor: ServiceRegistryEntry = {
  serviceId: "join",
  serviceName: "Join",
  version: "v1",
  // Holds a pipeline, so the board's UI must let anyone look inside it.
  capabilities: ["subservices"],
};

type JoinMode = "overwrite" | "add";

const MODES: JoinMode[] = ["overwrite", "add"];

/** What a detour that failed does to this pipeline. */
type FailureMode = "stop" | "merge";

const FAILURE_MODES: FailureMode[] = ["stop", "merge"];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JoinService extends SubService {
  readonly serviceId = joinDescriptor.serviceId;
  readonly serviceName = joinDescriptor.serviceName;
  readonly version = joinDescriptor.version;
  readonly capabilities = joinDescriptor.capabilities;

  private as = "";
  private mode: JoinMode = "overwrite";
  private onFailure: FailureMode = "stop";

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    super(config, createService);
    // The base constructor already called `configure`, but a subclass's fields
    // are defined only once `super()` returns — so what it read was overwritten
    // by the declarations above. Reading it again is what makes a Join
    // configured in the board behave like one configured later. See `iterator`,
    // which has the same shape and the same note.
    if (config.state) {
      this.settle(config.state);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    this.settle(config);
    // The pipeline, bypass and the editing commands belong to the base.
    super.configure(config);
    return this.getState();
  }

  getState(): JsonRecord {
    return {
      ...super.getState(),
      as: this.as,
      mode: this.mode,
      onFailure: this.onFailure,
    };
  }

  async process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (
      this.bypass ||
      !this.pipeline ||
      this.pipeline.listServices().length === 0
    ) {
      return input;
    }

    // What this call's detour reported, and only this call's: the callback is
    // handed to this one run of the pipeline, so two articles in flight at once
    // never hear each other's failures.
    let failure: { error: string; service: string } | null = null;
    const result = await this.pipeline.process(
      input,
      (notification) => {
        const error = isRecord(notification.payload)
          ? notification.payload.error
          : undefined;
        if (typeof error !== "string") {
          return;
        }
        if (error) {
          failure = { error, service: notification.instanceId };
        } else if (failure?.service === notification.instanceId) {
          // A service clearing what it said before: it recovered.
          failure = null;
        }
      },
      childRun(this.host?.currentContext() ?? null),
    );

    if (result === null || result === undefined) {
      if (failure && this.onFailure === "merge") {
        return this.merged(input, failure);
      }
      // Nothing to merge, so nothing to pass on. Continuing with the input
      // alone would be indistinguishable downstream from a merge that worked.
      return null;
    }

    return this.merged(input, result);
  }

  /** The input with what came back from the detour beside it. */
  private merged(input: unknown, result: unknown): unknown {
    if (this.as) {
      return isRecord(input)
        ? { ...input, [this.as]: result }
        : { input, [this.as]: result };
    }

    if (!isRecord(input) || !isRecord(result)) {
      // Nothing to merge into or nothing to merge: a scalar or an array on
      // either side has no fields to combine, and silently dropping one of them
      // would be worse than saying which one a board gets.
      return isRecord(result) ? result : input;
    }

    return this.mode === "add"
      ? { ...result, ...input }
      : { ...input, ...result };
  }

  /** The part of a configuration this service owns rather than its base. */
  private settle(config: JsonRecord): void {
    if (typeof config.as === "string") {
      this.as = config.as;
    }
    if (typeof config.mode === "string" && MODES.includes(config.mode as JoinMode)) {
      this.mode = config.mode as JoinMode;
    }
    if (
      typeof config.onFailure === "string" &&
      FAILURE_MODES.includes(config.onFailure as FailureMode)
    ) {
      this.onFailure = config.onFailure as FailureMode;
    }
  }
}
