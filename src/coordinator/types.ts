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

export type BoardSessionStatus = "running" | "error";

export type BoardSessionInfo = {
  boardName: string;
  userId: string;
  status: BoardSessionStatus;
  createdAt: string;
  config: CloudBoardConfig;
};

export function isRemoteRuntime(rt: CloudRuntimeDescriptor): boolean {
  return toCanonicalCloudRuntimeType(rt.type) === "rest";
}

export function isBrowserRuntime(rt: CloudRuntimeDescriptor): boolean {
  return toCanonicalCloudRuntimeType(rt.type) === "browser";
}
