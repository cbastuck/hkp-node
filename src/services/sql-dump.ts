/**
 * SQL text that moves a database between runtimes: writing a dump of one, and
 * deciding whether a dump may be run against another.
 *
 * Kept identical in hkp-frontend (src/runtime/browser/services/sql-dump.ts) and
 * hkp-node (src/services/sql-dump.ts): a dump written by either runtime's `sql`
 * is read by the other's, so the two must agree on the format. Change both.
 *
 * The format is an ordinary SQLite dump — what `sqlite3 file .dump` writes, and
 * what `sqlite3 file < dump.sql` reads — with one difference: every CREATE
 * says IF NOT EXISTS, so a dump loads into a database whose board has already
 * created its (empty) tables from its schema.
 */

/** What a dump needs of a database: the rows of a statement. */
export type DumpSource = {
  query(sql: string): Record<string, unknown>[];
};

/** A name as an SQL identifier: `we"ird` becomes `"we""ird"`. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Text as an SQL string literal: `it's` becomes `'it''s'`. */
function quoteText(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * A stored CREATE statement that tolerates what it creates already existing.
 *
 * SQLite keeps each CREATE as it was written, minus any IF NOT EXISTS, with
 * its leading keywords normalised — so the prefix is always one of these.
 */
function ifNotExists(sql: string): string {
  return sql.replace(
    /^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER|VIEW) /,
    (prefix) => `${prefix}IF NOT EXISTS `,
  );
}

/**
 * The whole database as SQL: its tables with their rows, then its indexes,
 * triggers and views, in one transaction — so loading it either brings in
 * everything or, on a conflict, nothing.
 *
 * Rows are written by SQLite itself (`quote()`), so every value comes back
 * exactly: text with its quotes and newlines, blobs as X'…', reals to the last
 * digit. Columns are named in each INSERT, which is what lets a table with
 * generated columns load.
 *
 * Throws on a virtual table: its contents live in tables of the module's
 * own, and a dump that recreated both would load the rows twice.
 */
export function dumpDatabase(db: DumpSource): string {
  const lines = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];

  const tables = db.query(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  ) as { name: string; sql: string }[];

  for (const { name, sql } of tables) {
    if (/^CREATE VIRTUAL TABLE/i.test(sql)) {
      throw new Error(
        `'${name}' is a virtual table, which a dump cannot carry`,
      );
    }
    lines.push(`${ifNotExists(sql)};`);
    lines.push(...insertsFor(db, name));
  }

  const sequence = db.query(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'",
  );
  if (sequence.length > 0) {
    // Where AUTOINCREMENT counts from, which a table's rows do not say: a row
    // deleted before the dump still used its id up.
    lines.push("DELETE FROM sqlite_sequence;");
    lines.push(...insertsFor(db, "sqlite_sequence"));
  }

  const rest = db.query(
    "SELECT sql FROM sqlite_schema WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  ) as { sql: string }[];
  for (const { sql } of rest) {
    lines.push(`${ifNotExists(sql)};`);
  }

  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

/** One INSERT per row of a table, as SQLite quotes its values. */
function insertsFor(db: DumpSource, table: string): string[] {
  const columns = (
    db.query(`SELECT name FROM pragma_table_info(${quoteText(table)})`) as {
      name: string;
    }[]
  ).map((column) => column.name);
  if (columns.length === 0) {
    return [];
  }
  const head = `INSERT INTO ${quoteIdentifier(table)}(${columns
    .map(quoteIdentifier)
    .join(",")}) VALUES(`;
  const values = columns
    .map((column) => `quote(${quoteIdentifier(column)})`)
    .join(" || ',' || ");
  const rows = db.query(
    `SELECT ${quoteText(head)} || ${values} || ');' AS line FROM ${quoteIdentifier(table)}`,
  ) as { line: string }[];
  return rows.map((row) => row.line);
}

/**
 * The statement with its string literals, quoted identifiers and comments
 * blanked out, so what remains is what SQLite reads as code.
 *
 * One pass, left to right, because the order decides what is what: a quote
 * inside a comment opens nothing, and `--` inside a string comments nothing
 * out. Blanking each kind separately gets that wrong — `-- don't` followed by
 * a statement and a later quote would blank the statement as if it were text.
 */
export function codeOf(sql: string): string {
  let out = "";
  let i = 0;
  const skipTo = (end: string, from: number): number => {
    const at = sql.indexOf(end, from);
    return at === -1 ? sql.length : at + end.length;
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      // Closed by the same character, which doubled stands for itself.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
      out += " ";
    } else if (c === "[") {
      i = skipTo("]", i + 1);
      out += " ";
    } else if (c === "-" && next === "-") {
      i = skipTo("\n", i + 2);
      out += " ";
    } else if (c === "/" && next === "*") {
      i = skipTo("*/", i + 2);
      out += " ";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Why SQL text may not be imported, or null when it may.
 *
 * An import runs text that arrived as data — on hkp-node possibly from a
 * mounted endpoint nobody signed in to — so it is held to what a dump needs.
 * A database is isolated by being its own file, and these are the statements
 * that reach past that file: ATTACH opens any other file the process can
 * read, VACUUM INTO writes one anywhere, load_extension runs native code, and
 * a PRAGMA other than foreign_keys changes how the connection behaves for
 * every statement after it.
 */
export function refuseImport(sql: string): string | null {
  const code = codeOf(sql);
  const reaching = code.match(/\b(ATTACH|DETACH|VACUUM|load_extension)\b/i);
  if (reaching) {
    return `an import may not use ${reaching[1].toUpperCase()}`;
  }
  for (const pragma of code.matchAll(
    /\bPRAGMA\s+(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)/gi,
  )) {
    if (pragma[1].toLowerCase() !== "foreign_keys") {
      return `an import may not set PRAGMA ${pragma[1]}`;
    }
  }
  return null;
}
