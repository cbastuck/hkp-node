/**
 * Addressing a service inside a scope.
 *
 * A runtime's services are a flat list, and a uuid names one of them. A service
 * holding a pipeline of its own — a SubService, an endpoint, Tracks — has
 * services inside it that the flat list does not reach, and until now nothing
 * outside could name one. A **scoped address** names it by the path through the
 * services containing it:
 *
 *     read.kept-articles          the `kept-articles` inside the `read` scope
 *     read.list.feed-doc          two levels down
 *
 * **The separator is a dot, and that is forced rather than chosen.** A service
 * address is carried in a URL path segment (`/runtimes/:runtimeId/services/
 * :instanceId`), which a slash would split; the same constraint already picked
 * a dot for the separator between a unit's name and its runtime ids.
 *
 * **A flat uuid is tried before the path is walked**, so a board whose service
 * uuid happens to contain a dot keeps resolving to that service rather than
 * being read as an address into something else.
 */
import { HostedService } from "./types";

export const ADDRESS_SEPARATOR = ".";

/** Something that can be asked for one of the services directly inside it. */
export type ServiceContainer = {
  /**
   * The service this segment names inside this one, if there is one.
   *
   * A service with more than one pipeline searches them in declaration order,
   * so a name used twice inside one service resolves to the first — which is
   * why an instanceId is worth keeping unique across a service's branches.
   */
  findNested?(instanceId: string): HostedService | undefined;
};

/** `["read", "kept-articles"]` for `"read.kept-articles"`. */
export function splitAddress(address: string): string[] {
  return address.split(ADDRESS_SEPARATOR).filter((part) => part.length > 0);
}

/** The address of `instanceId` inside `owner`. */
export function joinAddress(owner: string, instanceId: string): string {
  return owner ? `${owner}${ADDRESS_SEPARATOR}${instanceId}` : instanceId;
}

/** True where an address names something nested rather than a flat uuid. */
export function isScopedAddress(address: string): boolean {
  return splitAddress(address).length > 1;
}

/**
 * Walks the rest of an address down from a service that has been resolved.
 *
 * Answers undefined at the first segment nothing claims, rather than the
 * nearest service it did reach: a partial address is a miss, not a match.
 */
export function descend(
  service: HostedService,
  segments: string[],
): HostedService | undefined {
  let current: HostedService | undefined = service;
  for (const segment of segments) {
    const container = current as ServiceContainer | undefined;
    current = container?.findNested?.(segment);
    if (!current) {
      return undefined;
    }
  }
  return current;
}
