import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileDatabaseStore,
  createMemoryDatabaseStore,
} from "../src/services/database";
import { SqlService } from "../src/services/sql";
import { codeOf, refuseImport } from "../src/services/sql-dump";
import { RuntimeHost } from "../src/types";

/**
 * A database leaving as SQL and arriving as SQL: `export`, `import` and
 * `databases`. The format is shared with the browser's `sql`, so a round trip
 * here is the promise that tables built in a browser continue on a server.
 */

const SCOPE = { owner: "tester", boardName: "Dump" };

function sql(
  state: Record<string, unknown>,
  databases = createMemoryDatabaseStore(),
) {
  const host = {
    processFrom: (_uuid: string, data: unknown) => data,
    notify: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => SCOPE,
    emitResult: () => {},
  } as unknown as RuntimeHost;
  const service = new SqlService(
    { uuid: "sql-1", serviceId: "sql", state } as never,
    databases,
  );
  service.setHost(host);
  const notifications: any[] = [];
  const run = (input: unknown = {}) =>
    service.process(input, (payload) => notifications.push(payload)) as any;
  return { service, run, notifications, databases };
}

const SOURCE = `
  CREATE TABLE booking (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    note   TEXT,
    score  REAL,
    photo  BLOB,
    twice  INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL
  );
  CREATE UNIQUE INDEX one_per_member ON booking(member);
  CREATE TABLE "we""ird" ("it's" TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TABLE audit (what TEXT);
  CREATE TRIGGER booked AFTER INSERT ON booking BEGIN
    INSERT INTO audit VALUES ('booked ' || NEW.member);
  END;
  CREATE VIEW members AS SELECT member FROM booking;
  INSERT INTO booking (member, note, score, photo) VALUES
    ('anna', 'it''s mine; -- not a comment', 0.1, X'00FF'),
    ('ben', 'two
lines', 1e300, NULL),
    ('gone', NULL, NULL, NULL);
  DELETE FROM booking WHERE member = 'gone';
  INSERT INTO "we""ird" VALUES ('a''b');
`;

function sourceDatabase() {
  const databases = createMemoryDatabaseStore();
  const setup = sql({ mode: "exec", database: "tennis", statement: SOURCE }, databases);
  setup.run();
  return databases;
}

const everything = (databases: ReturnType<typeof createMemoryDatabaseStore>, name: string) => {
  const db = databases.openNamed(SCOPE.owner, name);
  return {
    booking: db.query("SELECT id, member, note, score, hex(photo) AS photo, twice FROM booking ORDER BY id"),
    weird: db.query('SELECT * FROM "we""ird"'),
    audit: db.query("SELECT * FROM audit ORDER BY rowid"),
    members: db.query("SELECT * FROM members ORDER BY member"),
    sequence: db.query("SELECT name, seq FROM sqlite_sequence"),
    schema: db.query(
      "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ),
  };
};

describe("export", () => {
  it("hands on the database as SQL, and reports what it exported", () => {
    const databases = sourceDatabase();
    const { run, notifications } = sql({ mode: "export", database: "tennis" }, databases);
    const dump = run();
    expect(typeof dump).toBe("string");
    expect(dump.startsWith("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n")).toBe(true);
    expect(dump.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(notifications).toEqual([{ exported: "tennis", bytes: dump.length }]);
  });

  it("needs no statement", () => {
    const { run, notifications } = sql({ mode: "export", database: "empty" });
    expect(run()).toBe("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCOMMIT;\n");
    expect(notifications[0].error).toBeUndefined();
  });
});

describe("import", () => {
  it("brings back everything an export carried", () => {
    const databases = sourceDatabase();
    const dump = sql({ mode: "export", database: "tennis" }, databases).run();
    const imported = sql({ mode: "import", database: "copy" }, databases);
    expect(imported.run(dump)).toEqual({ executed: true });

    const copy = everything(databases, "copy");
    expect(copy).toEqual(everything(databases, "tennis"));
    // What the rows alone could not have said: 'gone' used id 3 up.
    expect(copy.sequence).toEqual([{ name: "booking", seq: 3 }]);
    // Values exactly, not approximately.
    expect(copy.booking[0]).toMatchObject({ note: "it's mine; -- not a comment", score: 0.1, photo: "00FF", twice: 2 });
    expect(copy.booking[1]).toMatchObject({ note: "two\nlines", score: 1e300 });
  });

  it("loads into a database whose schema already made the tables", () => {
    const databases = sourceDatabase();
    const dump = sql({ mode: "export", database: "tennis" }, databases).run();
    const prepared = sql(
      {
        mode: "import",
        database: "prepared",
        schema: "CREATE TABLE IF NOT EXISTS booking (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, note TEXT, score REAL, photo BLOB, twice INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL);",
      },
      databases,
    );
    expect(prepared.run(dump)).toEqual({ executed: true });
    expect(everything(databases, "prepared").booking).toHaveLength(2);
  });

  it("takes bytes as well as text", () => {
    const { run } = sql({ mode: "import", database: "bytes" });
    expect(run(new TextEncoder().encode("CREATE TABLE t (n INTEGER);"))).toEqual({ executed: true });
  });

  it("brings in nothing of a dump that fails part way", () => {
    const databases = sourceDatabase();
    const dump = sql({ mode: "export", database: "tennis" }, databases).run();
    const target = sql({ mode: "import", database: "busy" }, databases);
    // Anna already holds a booking here, so the dump's row for her collides.
    databases.openNamed(SCOPE.owner, "busy").exec(
      "CREATE TABLE booking (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, note TEXT, score REAL, photo BLOB, twice INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL); CREATE UNIQUE INDEX one_per_member ON booking(member); INSERT INTO booking (id, member) VALUES (1, 'anna');",
    );
    expect(target.run(dump)).toBeNull();
    expect(target.notifications[0].error).toMatch(/^import failed: UNIQUE constraint failed/);
    const busy = databases.openNamed(SCOPE.owner, "busy");
    expect(busy.query("SELECT member FROM booking")).toEqual([{ member: "anna" }]);
    expect(busy.query("SELECT name FROM sqlite_schema WHERE name = 'audit'")).toEqual([]);
    // And the connection is usable afterwards: no transaction left open.
    busy.exec("BEGIN; COMMIT;");
  });

  it("leaves foreign keys on for what runs after it", () => {
    const databases = createMemoryDatabaseStore();
    sql({ mode: "import", database: "fk" }, databases).run(
      "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE p (id INTEGER PRIMARY KEY);\nCREATE TABLE c (p INTEGER REFERENCES p(id));\nCOMMIT;\n",
    );
    const db = databases.openNamed(SCOPE.owner, "fk");
    expect(db.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(() => db.run("INSERT INTO c VALUES (42)")).toThrow(/FOREIGN KEY/);
  });

  it("refuses what reaches past the database's own file", () => {
    for (const [text, why] of [
      ["ATTACH DATABASE '/tmp/other.db' AS other;", "ATTACH"],
      ["VACUUM INTO '/tmp/copy.db';", "VACUUM"],
      ["SELECT load_extension('evil');", "LOAD_EXTENSION"],
      ["PRAGMA journal_mode = OFF;", "PRAGMA journal_mode"],
    ]) {
      const { run, notifications } = sql({ mode: "import", database: "guarded" });
      expect(run(text), text).toBeNull();
      expect(notifications[0].error).toContain(why);
    }
  });

  it("is not fooled by a quote inside a comment", () => {
    // Blanking strings before comments would read `'t\nATTACH '` as one string
    // literal and never see the ATTACH between.
    expect(refuseImport("-- don't\nATTACH '/etc/x' AS y; -- '")).toMatch(/ATTACH/);
    expect(refuseImport("/* it's */ ATTACH 'x' AS y")).toMatch(/ATTACH/);
  });

  it("allows those words where they are only data", () => {
    expect(
      refuseImport("INSERT INTO t VALUES ('ATTACH this; PRAGMA that'); -- VACUUM"),
    ).toBeNull();
    expect(refuseImport("PRAGMA main.foreign_keys = OFF;")).toBeNull();
  });

  it("needs SQL text as its input", () => {
    const { run, notifications } = sql({ mode: "import", database: "empty" });
    expect(run({ not: "sql" })).toBeNull();
    expect(notifications[0].error).toBe("import failed: an import needs SQL text as its input");
  });
});

describe("what counts as code", () => {
  it("blanks strings, quoted identifiers and comments in one pass", () => {
    expect(codeOf(`SELECT 'a--b', "c'd", [e f], \`g\` -- h 'i\n/* j */ $k`)).toBe(
      // A line comment is blanked with the newline that ends it; the blank
      // still keeps what was on either side apart.
      "SELECT  ,  ,  ,      $k",
    );
  });
});

describe("databases", () => {
  it("lists the owner's named databases, and opens none to do it", () => {
    const databases = createMemoryDatabaseStore();
    sql({ mode: "exec", database: "tennis", statement: "CREATE TABLE t (n);" }, databases).run();
    sql({ mode: "exec", statement: "CREATE TABLE u (n);" }, databases).run();
    const { run } = sql({ mode: "databases" }, databases);
    const result = run();
    expect(result.count).toBe(1);
    expect(result.rows[0].name).toBe("tennis");
    expect(result.rows[0].bytes).toBeGreaterThan(0);
  });

  describe("on disk", () => {
    const roots: string[] = [];
    afterEach(() => {
      for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("finds named files and leaves out derived and reserved ones", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "hkp-db-list-"));
      roots.push(root);
      const databases = createFileDatabaseStore(root);
      sql({ mode: "exec", database: "tennis", statement: "CREATE TABLE t (n);" }, databases).run();
      sql({ mode: "exec", statement: "CREATE TABLE u (n);" }, databases).run();
      databases.openShared(SCOPE.owner).exec("CREATE TABLE q (n);");

      const listed = databases.list(SCOPE.owner);
      expect(listed.map((db) => db.name)).toEqual(["tennis"]);
      expect(listed[0].bytes).toBeGreaterThan(0);
      expect(databases.list("somebody-else")).toEqual([]);
      databases.closeAll();
    });
  });
});
