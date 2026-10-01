import { AssetDescriptor } from "../assets";

export type CloudRuntimeType =
  | "browser"
  | "graphql"
  | "rest"
  | "remote" // @deprecated use "graphql"
  | "realtime"; // @deprecated use "rest"

export type CanonicalCloudRuntimeType = "browser" | "graphql" | "rest";

export function toCanonicalCloudRuntimeType(
  type: CloudRuntimeType,
): CanonicalCloudRuntimeType {
  if (type === "remote") {
    return "graphql";
  }
  if (type === "realtime") {
    return "rest";
  }
  return type;
}

export type CloudRuntimeDescriptor = {
  id: string;
  name: string;
  type: CloudRuntimeType;
  /**
   * How the board says where this runtime belongs: an address, a remote's name
   * or a requirement. All three are labels here — for the person reading the
   * board, and for the client that resolved them. The coordinator dials none of
   * them: it knows a runtime by the ticket its runtime server connects with.
   */
  url?: string;
  remote?: string;
  requires?: { kind: string };
  state?: Record<string, unknown>;
  /**
   * Set on a runtime a unit contributed: the unit's name, and the id the
   * runtime has in that unit. Such a runtime resolves against the unit's own
   * assets, not the board's.
   */
  unit?: string;
  unitRuntimeId?: string;
};

export type CloudServiceDescriptor = {
  uuid: string;
  serviceId: string;
  serviceName?: string;
  name?: string;
  state?: Record<string, unknown>;
};

export type CloudBoardConfig = {
  boardName: string;
  runtimes: CloudRuntimeDescriptor[];
  services: Record<string, CloudServiceDescriptor[]>;
  facade?: unknown;
  /**
   * The board's asset descriptors. Each provisioned runtime of the board's own
   * is sent all of them, less the ones kept to other runtimes, the way a
   * browser provisioning the board does.
   */
  assets?: AssetDescriptor[];
};

/**
 * "stopped" is a board the coordinator still owns but is not running: what a
 * board is while someone edits it. Editing takes the board over — exactly one
 * party owns its runtimes at a time — and a stopped board keeps its place and
 * its config so that taking it over cannot lose it.
 */
export type BoardSessionStatus = "running" | "stopped" | "error";

export type BoardSessionInfo = {
  boardName: string;
  userId: string;
  status: BoardSessionStatus;
  createdAt: string;
  config: CloudBoardConfig;
  /** Human-readable reasons the session is in "error" — a runtime whose
   *  runtime server is not connected, one that could not be built. Empty when
   *  running cleanly. */
  errors: string[];
};

export function isRemoteRuntime(rt: CloudRuntimeDescriptor): boolean {
  return toCanonicalCloudRuntimeType(rt.type) === "rest";
}

export function isBrowserRuntime(rt: CloudRuntimeDescriptor): boolean {
  return toCanonicalCloudRuntimeType(rt.type) === "browser";
}
