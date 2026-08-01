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
  url?: string;
  state?: Record<string, unknown>;
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
  /** Human-readable reasons the session is in "error" (e.g. a runtime that
   *  failed to provision). Empty when running cleanly. */
  errors: string[];
};

export function isRemoteRuntime(rt: CloudRuntimeDescriptor): boolean {
  return toCanonicalCloudRuntimeType(rt.type) === "rest";
}

export function isBrowserRuntime(rt: CloudRuntimeDescriptor): boolean {
  return toCanonicalCloudRuntimeType(rt.type) === "browser";
}
