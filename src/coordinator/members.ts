import { normalizeEmail } from "../auth";

/**
 * The people a deployed board is shared with.
 *
 * A board has one owner — the person who deployed it, in whose tenant its
 * runtimes run and its data lives — and a list of members. Whoever is on the
 * list may attach to the board and use its facade, and nothing else; the list
 * *is* the membership.
 *
 * It is kept by the coordinator, beside the board and never in the board
 * document: who a board is shared with is not part of what the board is, and a
 * board that carried its own list would hand it to everyone it was exported
 * to.
 */

export type BoardMember = {
  /** A verified address, as `normalizeEmail` keeps one. The key of the list. */
  email: string;
  /**
   * What the other members see this person called. The owner's to set: a name
   * taken from the person's own token would let them appear as someone else.
   */
  name: string;
};

/** A board somebody else owns, as a member is told about it. */
export type SharedBoardInfo = {
  /** The owner's id: what a member names, with the board, to attach. */
  owner: string;
  boardName: string;
  status: string;
  /** What the board's list calls the person asking. */
  name: string;
};

/** What a coordinator's operator allows of membership. */
export type MemberLimits = {
  /** How many people one board may be shared with. */
  maxMembersPerBoard?: number;
  /** How many bridges one member may hold on one board at once. */
  maxBridgesPerMember?: number;
  /** How many process calls a member may make on one board per minute. */
  maxMemberProcessPerMinute?: number;
};

export const DEFAULT_MEMBER_LIMITS: Required<MemberLimits> = {
  maxMembersPerBoard: 200,
  maxBridgesPerMember: 4,
  maxMemberProcessPerMinute: 120,
};

/** Refused for being over a limit; carries what to tell the owner. */
export class MemberLimitError extends Error {}

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;

/**
 * A list entry from what a client sent, or null when it is not one.
 *
 * The address only has to look like one — it is compared with what an identity
 * provider verified, so one that belongs to nobody simply admits nobody.
 */
export function readMember(value: unknown): BoardMember | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { email, name } = value as Record<string, unknown>;
  if (typeof email !== "string" || typeof name !== "string") {
    return null;
  }
  const address = normalizeEmail(email);
  const label = name.trim();
  if (
    !address ||
    address.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+$/.test(address) ||
    !label ||
    label.length > MAX_NAME_LENGTH
  ) {
    return null;
  }
  return { email: address, name: label };
}

/** The entries of a stored list that are still well formed, one per email. */
export function readMembers(value: unknown): BoardMember[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byEmail = new Map<string, BoardMember>();
  for (const entry of value) {
    const member = readMember(entry);
    if (member) {
      byEmail.set(member.email, member);
    }
  }
  return [...byEmail.values()];
}

/** The entry for an email, when the list has one. */
export function findMember(
  members: BoardMember[],
  email: string | undefined,
): BoardMember | undefined {
  if (!email) {
    return undefined;
  }
  const address = normalizeEmail(email);
  return members.find((member) => member.email === address);
}
