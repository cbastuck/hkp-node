import { describe, expect, it } from "vitest";

import { createMemoryDatabaseStore } from "../src/services/database";
import { SqlService } from "../src/services/sql";
import { RuntimeHost } from "../src/types";

/**
 * The generic half: SQL in, rows out, and nothing in between that knows what
 * the rows mean.
 *
 * The parts worth pinning are the two a board does not write itself — where
 * the parameters come from, and where the tables come from.
 */

function hostFor(scope = { owner: "tester", boardName: "SYN" }) {
  const logged: unknown[] = [];
  const host = {
    processFrom: (_uuid: string, data: unknown) => data,
    notify: () => {},
    currentContext: () => null,
    log: (level: string, event: string, data: unknown) => {
      logged.push({ level, event, data });
    },
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => scope,
    emitResult: () => {},
  } as unknown as RuntimeHost;
  return { host, logged };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mail (
    messageId TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL,
    sentAt TEXT NOT NULL,
    body TEXT
  );
`;

function serviceWith(
  state: Record<string, unknown>,
  databases = createMemoryDatabaseStore(),
  scope?: { owner: string; boardName: string },
) {
  const { host, logged } = hostFor(scope);
  const service = new SqlService(
    { uuid: "sql-1", serviceId: "sql", state } as never,
    databases,
  );
  service.setHost(host);
  const notifications: unknown[] = [];
  return {
    service,
    databases,
    logged,
    notifications,
    notify: (payload: unknown) => notifications.push(payload),
  };
}

describe("parameters", () => {
  it("takes the values the statement names, from the input", () => {
    const databases = createMemoryDatabaseStore();
    const insert = serviceWith(
      {
        mode: "run",
        schema: SCHEMA,
        statement:
          "INSERT INTO mail VALUES ($messageId, $conversationId, $sentAt, $body)",
      },
      databases,
    );

    const result = insert.service.process(
      {
        messageId: "a@x",
        conversationId: "root@x",
        sentAt: "2026-08-28T09:00:00Z",
        body: "Zwei Zimmer bitte",
        // Not mentioned by the statement, and so not bound — SQLite rejects a
        // parameter it was not asked for.
        subject: "Anfrage",
      },
      insert.notify,
    );

    expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
  });

  it("binds values rather than interpolating them", () => {
    // A subject containing a quote is a subject, not a syntax error.
    const databases = createMemoryDatabaseStore();
    const insert = serviceWith(
      {
        mode: "run",
        schema: SCHEMA,
        statement:
          "INSERT INTO mail VALUES ($messageId, 'c', '2026-01-01', $body)",
      },
      databases,
    );
    insert.service.process(
      { messageId: "a@x", body: "it's ok'; DROP TABLE mail; --" },
      insert.notify,
    );

    const read = serviceWith(
      { mode: "query", statement: "SELECT body FROM mail" },
      databases,
    );
    expect(read.service.process({}, read.notify)).toEqual({
      rows: [{ body: "it's ok'; DROP TABLE mail; --" }],
      count: 1,
    });
  });

  it("stores what has no column type rather than refusing it", () => {
    const databases = createMemoryDatabaseStore();
    const insert = serviceWith(
      {
        mode: "run",
        schema: "CREATE TABLE t (flag INTEGER, blob TEXT, absent TEXT)",
        statement: "INSERT INTO t VALUES ($flag, $blob, $absent)",
      },
      databases,
    );
    insert.service.process(
      { flag: true, blob: { a: 1 } },
      insert.notify,
    );

    const read = serviceWith(
      { mode: "query", statement: "SELECT * FROM t" },
      databases,
    );
    expect(read.service.process({}, read.notify)).toEqual({
      rows: [{ flag: 1, blob: '{"a":1}', absent: null }],
      count: 1,
    });
  });
});

describe("the schema", () => {
  it("creates the tables before the first statement needs them", () => {
    // Not on configure: a service's first configure runs in its constructor,
    // before the runtime hands it a host — so there is no scope yet, and no
    // way to know which board's database the tables belong in.
    const t = serviceWith({
      mode: "query",
      schema: SCHEMA,
      statement: "SELECT count(*) AS n FROM mail",
    });

    expect(t.service.process({}, t.notify)).toEqual({
      rows: [{ n: 0 }],
      count: 1,
    });
  });

  it("applies it once per board, not once per call", () => {
    const databases = createMemoryDatabaseStore();
    const t = serviceWith(
      {
        mode: "run",
        // Deliberately not IF NOT EXISTS: a second application would throw.
        schema: "CREATE TABLE once (x TEXT)",
        statement: "INSERT INTO once VALUES ('a')",
      },
      databases,
    );

    t.service.process({}, t.notify);
    expect(t.service.process({}, t.notify)).toEqual({
      changes: 1,
      lastInsertRowid: 2,
    });
  });
});

describe("what a board can reach", () => {
  it("sees the same tables from two services without being told to", () => {
    // The database comes from the runtime's scope, not from configuration.
    const databases = createMemoryDatabaseStore();
    const writer = serviceWith(
      {
        mode: "run",
        schema: SCHEMA,
        statement: "INSERT INTO mail VALUES ('a@x', 'root@x', '2026-01-01', 'hi')",
      },
      databases,
    );
    writer.service.process({}, writer.notify);

    const reader = serviceWith(
      { mode: "query", statement: "SELECT messageId FROM mail" },
      databases,
    );
    expect(reader.service.process({}, reader.notify)).toEqual({
      rows: [{ messageId: "a@x" }],
      count: 1,
    });
  });

  it("cannot reach another board's rows, however the SQL is written", () => {
    const databases = createMemoryDatabaseStore();
    const mine = serviceWith(
      {
        mode: "run",
        schema: SCHEMA,
        statement: "INSERT INTO mail VALUES ('a@x', 'root@x', '2026-01-01', 'hi')",
      },
      databases,
    );
    mine.service.process({}, mine.notify);

    const theirs = serviceWith(
      { mode: "query", statement: "SELECT * FROM mail" },
      databases,
      { owner: "someone-else", boardName: "SYN" },
    );
    // No table at all, rather than an empty one: it is a different file.
    expect(theirs.service.process({}, theirs.notify)).toBeNull();
    expect(theirs.notifications.some((n: any) => n?.error)).toBe(true);
  });
});

describe("failure", () => {
  it("stops the pipeline and says why", () => {
    const t = serviceWith({ mode: "query", statement: "SELECT * FROM nope" });

    expect(t.service.process({}, t.notify)).toBeNull();
    expect(t.logged).toHaveLength(1);
    expect(t.service.getState().error).toContain("query failed");
  });

  it("refuses to run with no statement", () => {
    const t = serviceWith({ mode: "query" });
    expect(t.service.process({}, t.notify)).toBeNull();
    expect(t.service.getState().error).toContain("no statement");
  });
});

describe("what counts as a parameter", () => {
  it("does not read an email address as one", () => {
    // '@x' inside a literal is an address, not a parameter — and binding one
    // SQLite never asked for fails the whole statement.
    const databases = createMemoryDatabaseStore();
    const t = serviceWith(
      {
        mode: "run",
        schema: SCHEMA,
        statement:
          "INSERT INTO mail VALUES ('anna@example.com', 'root@example.com', '2026-01-01', $body)",
      },
      databases,
    );

    expect(t.service.process({ body: "hi" }, t.notify)).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
  });

  it("ignores one written in a comment", () => {
    const t = serviceWith({
      mode: "query",
      schema: SCHEMA,
      statement: "SELECT count(*) AS n FROM mail -- once took $conversationId",
    });

    expect(t.service.process({}, t.notify)).toEqual({
      rows: [{ n: 0 }],
      count: 1,
    });
  });
});

/**
 * What a statement hands onward is separate from what it did.
 *
 * The case is a board where several statements act on one request in turn — a
 * booking that may cancel, may insert, and then re-reads the timetable it
 * changed. Each names its parameters out of the same object, so the first
 * statement's row count must not become the second one's input: there it would
 * find none of the names it asked for and bind them all to null.
 */
describe("what travels onward", () => {
  const SCHEMA_BOOKING = `
    CREATE TABLE IF NOT EXISTS slot (court INTEGER, member TEXT);
  `;

  it("passes the result on by default", () => {
    const { service, notify } = serviceWith({
      mode: "query",
      statement: "SELECT $court AS court",
    });
    expect(service.process({ court: 2 }, notify)).toEqual({
      rows: [{ court: 2 }],
      count: 1,
    });
  });

  it("passes the input through when asked, so the next statement still sees it", () => {
    const shared = createMemoryDatabaseStore();
    const first = serviceWith(
      {
        mode: "run",
        emit: "input",
        schema: SCHEMA_BOOKING,
        statement: "INSERT INTO slot (court, member) VALUES ($court, $member)",
      },
      shared,
    );
    const request = { court: 2, member: "anna@club.example" };
    const passed = first.service.process(request, first.notify);
    expect(passed).toBe(request);

    // The second statement is handed what the first was given, and can bind the
    // same names — which is the whole point of the option.
    const second = serviceWith(
      { mode: "query", statement: "SELECT member FROM slot WHERE court = $court" },
      shared,
    );
    expect(second.service.process(passed, second.notify)).toEqual({
      rows: [{ member: "anna@club.example" }],
      count: 1,
    });
  });

  it("still reports what it did, whatever it passes on", () => {
    const { service, notify, notifications } = serviceWith(
      {
        mode: "run",
        emit: "input",
        schema: SCHEMA_BOOKING,
        statement: "INSERT INTO slot (court, member) VALUES ($court, $member)",
      },
      createMemoryDatabaseStore(),
    );
    service.process({ court: 1, member: "ben@club.example" }, notify);
    // A panel showing the row count does not depend on the board passing it on.
    expect(notifications).toEqual([{ changes: 1, lastInsertRowid: 1 }]);
  });

  it("reports the choice in its state, so a panel can show it", () => {
    const { service } = serviceWith({ mode: "run", emit: "input", statement: "SELECT 1" });
    expect(service.getState().emit).toBe("input");
  });

  it("ignores an emit it does not know, rather than inventing one", () => {
    const { service } = serviceWith({ statement: "SELECT 1", emit: "sideways" });
    expect(service.getState().emit).toBe("result");
  });

});
