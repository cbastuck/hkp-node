/**
 * The queue itself: one table, and the five things that can be done to it.
 *
 * A module rather than part of the service, for the same reason `database.ts`
 * is one. Two callers need this and they are not both services: the `queue`
 * service running in a pipeline, and the runtime's own `/queue` route, which
 * is how a board on *another* server reaches these rows. One implementation
 * means a remote claim and a local claim are the same claim — the guarantee
 * cannot drift between the two paths, because there is only one path.
 *
 * Every function takes the database it works on. Which database that is —
 * whose, and therefore which messages exist at all — is decided by the caller
 * from something it was told rather than something it was asked: a service
 * reads its runtime's scope, the route reads the authenticated user.
 */
import { randomUUID } from "node:crypto";

import { JsonRecord } from "../types";
import { Database } from "./database";

/** What a message is doing, as far as the queue is concerned. */
export type Status = "pending" | "claimed" | "done" | "dead";

export const DEFAULT_LIMIT = 10;
/**
 * How long a claim holds before the message is handed out again.
 *
 * Long enough for a pipeline that calls a model and sends mail — the work
 * between a consume and its ack is I/O with other people's servers in it —
 * and short enough that a runtime killed mid-flight does not strand the
 * message for the rest of the afternoon.
 */
export const DEFAULT_VISIBILITY_SECONDS = 300;
/**
 * Attempts before a message is left alone.
 *
 * A message that five separate runs could not finish is not going to be
 * finished by a sixth, and a queue that keeps trying turns one bad payload
 * into an unbounded bill.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * One table, and the index the two hot queries need.
 *
 * `consume` asks for the oldest claimable message on a topic and `list` reads
 * a topic in order; both are served by (topic, status, availableAt). Nothing
 * here is indexed on a guess.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    publishedBy TEXT NOT NULL DEFAULT '',
    publishedAt TEXT NOT NULL,
    availableAt TEXT NOT NULL,
    claimedAt TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS message_by_topic
    ON message (topic, status, availableAt);
`;

/** Creates the table if this database has not seen it yet. */
export function prepare(db: Database): void {
  db.exec(SCHEMA);
}

/** Reads a JSON column, tolerating one that was never written by us. */
function parsed(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** A row as a board sees it: the payload opened, the bookkeeping visible. */
export function describedMessage(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    topic: row.topic,
    payload: parsed(row.payload, row.payload),
    status: row.status,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
    availableAt: row.availableAt,
    claimedAt: row.claimedAt ?? null,
    attempts: row.attempts,
    updatedAt: row.updatedAt,
    error: row.error,
  };
}

/**
 * Puts one message on the topic.
 *
 * `id` is the caller's when it has one. A publish that crossed a network may
 * arrive twice — the sender timed out on a request that in fact succeeded —
 * and a message identified by the sender lands once however many times it is
 * delivered.
 */
export function publish(
  db: Database,
  params: {
    topic: string;
    payload: unknown;
    publishedBy: string;
    id?: string;
  },
): JsonRecord {
  const now = new Date().toISOString();
  const id = params.id || randomUUID();
  db.run(
    `INSERT INTO message
       (id, topic, payload, status, publishedBy, publishedAt, availableAt,
        claimedAt, attempts, updatedAt, error)
     VALUES ($id, $topic, $payload, 'pending', $board, $now, $now, NULL, 0, $now, '')
     ON CONFLICT (id) DO NOTHING`,
    {
      $id: id,
      $topic: params.topic,
      $payload: JSON.stringify(params.payload),
      $board: params.publishedBy,
      $now: now,
    },
  );
  const row = db.query("SELECT * FROM message WHERE id = $id", { $id: id })[0];
  return describedMessage(row ?? {});
}

/**
 * Hands out the messages that may be worked on now.
 *
 * "May be worked on" is one condition, not two: a message is claimable when
 * its `availableAt` has passed, which covers both one nobody has taken and one
 * whose claim ran out. A claim is therefore not a lock to be released — it is
 * a deadline, and a runtime that dies holds nothing.
 */
export function consume(
  db: Database,
  params: {
    topic: string;
    limit?: number;
    visibilitySeconds?: number;
    maxAttempts?: number;
  },
): { messages: JsonRecord[]; count: number } {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const visibilitySeconds = params.visibilitySeconds ?? DEFAULT_VISIBILITY_SECONDS;
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const now = new Date();
  const nowText = now.toISOString();
  const rows = db.query(
    `SELECT * FROM message
      WHERE topic = $topic
        AND status IN ('pending', 'claimed')
        AND availableAt <= $now
      ORDER BY publishedAt ASC, id ASC
      LIMIT $limit`,
    { $topic: params.topic, $now: nowText, $limit: limit },
  );

  const claimed: JsonRecord[] = [];
  for (const row of rows) {
    const attempts = Number(row.attempts) + 1;
    if (attempts > maxAttempts) {
      // Handed out its share of times and never acked. Left where it is, with
      // the count that says why, rather than deleted.
      db.run(
        `UPDATE message
            SET status = 'dead', updatedAt = $now, error = $error
          WHERE id = $id AND attempts = $previousAttempts`,
        {
          $id: String(row.id),
          $previousAttempts: Number(row.attempts),
          $now: nowText,
          $error: `not acknowledged after ${maxAttempts} attempts`,
        },
      );
      continue;
    }

    const availableAt = new Date(
      now.getTime() + visibilitySeconds * 1000,
    ).toISOString();
    // The claim re-states the conditions the row was selected under, and
    // `attempts` doubles as its version. Between the select and this update
    // another consumer may have taken the same row — another process on the
    // same file, or a board on another server claiming over the route — and
    // the one whose update changes no rows simply does not deliver it.
    // Without the guard both would hand out the same message and one of the
    // two acks would land on work the other did.
    const { changes } = db.run(
      `UPDATE message
          SET status = 'claimed', attempts = $attempts, claimedAt = $now,
              availableAt = $availableAt, updatedAt = $now
        WHERE id = $id
          AND attempts = $previousAttempts
          AND status IN ('pending', 'claimed')
          AND availableAt <= $now`,
      {
        $id: String(row.id),
        $attempts: attempts,
        $previousAttempts: Number(row.attempts),
        $now: nowText,
        $availableAt: availableAt,
      },
    );
    if (changes === 0) {
      continue;
    }
    claimed.push(describedMessage({ ...row, status: "claimed", attempts }));
  }

  return { messages: claimed, count: claimed.length };
}

/**
 * Closes a claimed message: acknowledged, or handed back.
 *
 * Handing back returns it immediately rather than waiting out the claim,
 * because a pipeline that knows it failed knows it now. The attempt has
 * already been counted, so a payload nothing can process still reaches `dead`
 * rather than cycling for ever.
 */
export function close(
  db: Database,
  params: {
    id: string;
    outcome: "done" | "pending";
    error?: string;
    maxAttempts?: number;
  },
): JsonRecord | null {
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const row = db.query("SELECT * FROM message WHERE id = $id", {
    $id: params.id,
  })[0];
  if (!row) {
    return null;
  }

  const now = new Date().toISOString();
  const error = params.outcome === "pending" ? (params.error ?? "") : "";
  // A failure that has used up its attempts is finished here rather than being
  // handed out once more only to be buried on the next consume.
  const status: Status =
    params.outcome === "done"
      ? "done"
      : Number(row.attempts) >= maxAttempts
        ? "dead"
        : "pending";

  db.run(
    `UPDATE message
        SET status = $status, availableAt = $now, claimedAt = NULL,
            updatedAt = $now, error = $error
      WHERE id = $id`,
    { $id: params.id, $status: status, $now: now, $error: error },
  );

  return { id: params.id, status, attempts: Number(row.attempts) };
}

/** Reads the log without touching it. For a facade table, and for looking. */
export function list(
  db: Database,
  params: { topic?: string; status?: string; limit?: number },
): { messages: JsonRecord[]; count: number } {
  const values: Record<string, string | number> = {
    $limit: params.limit ?? DEFAULT_LIMIT,
  };
  const conditions: string[] = [];
  if (params.topic) {
    conditions.push("topic = $topic");
    values.$topic = params.topic;
  }
  if (params.status) {
    conditions.push("status = $status");
    values.$status = params.status;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db.query(
    `SELECT * FROM message ${where}
      ORDER BY publishedAt DESC, id DESC
      LIMIT $limit`,
    values,
  );
  const messages = rows.map(describedMessage);
  return { messages, count: messages.length };
}
