/**
 * Service Documentation
 * Service ID: sql
 * Service Name: SQL
 * Runtime: hkp-node
 * Modes: query | run | exec | databases | export | import
 * Key Config: statement, schema, mode, database
 * IO: in=JSON (the statement's named parameters) -> out=JSON
 *     query     -> { rows, count }
 *     run       -> { changes, lastInsertRowid }
 *     exec      -> { executed: true }
 *     databases -> { rows: [{ name, bytes }], count }   (in: ignored)
 *     export    -> the database as SQL text             (in: ignored)
 *     import    -> { executed: true }                   (in: SQL text)
 *
 * The generic half of the pair: it knows SQL and nothing else. Tables, columns
 * and meaning all belong to the board, which is what makes it usable for a
 * workflow this service has never heard of. A service that understands one
 * domain — conversations, say — is a second service over the same module
 * (`database.ts`), not a mode of this one.
 *
 * The tenant is the board's, and comes from the runtime's scope rather than
 * from configuration: no board can reach another owner's tables by asking.
 *
 * Which file inside that tenant is the board's to say. `database` names it,
 * and two services naming the same file share its tables — within one board,
 * which is the ordinary case, or deliberately across boards, which is
 * occasionally the point. Left empty the name is derived from the board's
 * title, which is what every board did before the field existed: convenient,
 * and the reason two boards that happen to share a title also share their
 * tables. A board that means to be alone with its data says so.
 *
 * **Parameters come from the input, named by the statement.** A statement
 * mentioning `$conversationId` is given the input's `conversationId`, and a
 * board writes no parameter list at all. Values are always bound, never
 * interpolated — a subject line containing a quote is a subject line, not a
 * syntax error, and not an injection.
 *
 * **A database can leave as SQL and arrive as SQL.** `export` hands on the
 * whole database as an SQLite dump and `import` runs one arriving as input —
 * the same format the browser's `sql` writes and reads (`sql-dump.ts`), which
 * is how tables built in a browser continue here. An import is text from
 * outside, possibly from a mount nobody signed in to, so it is refused
 * anything that reaches past the database's own file. `databases` lists the
 * owner's named databases.
 *
 * **What it hands onward is separate from what it did.** By default the result
 * travels, which is what a service asked a question wants. `emit: "input"`
 * passes the input through untouched instead, so several statements can act on
 * one request in turn: each names its parameters out of the same object, and
 * the last service in the chain still sees what the first was given. Without it
 * a second statement would be handed the first one's row count and find none of
 * the parameters it asked for. The result is still reported either way —
 * what a service says about itself is not what it passes on.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeScope,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { Database, DatabaseStore, SqlValue } from "./database";
import { codeOf, dumpDatabase, refuseImport } from "./sql-dump";

export const sqlDescriptor: ServiceRegistryEntry = {
  serviceId: "sql",
  serviceName: "SQL",
  version: "v1",
  capabilities: [],
};

type SqlMode = "query" | "run" | "exec" | "databases" | "export" | "import";

const MODES: SqlMode[] = ["query", "run", "exec", "databases", "export", "import"];

/** The modes that run the configured statement, and need one. */
const STATEMENT_MODES: SqlMode[] = ["query", "run"];

/** Whether the statement's result travels onward, or the input it ran on. */
type SqlEmit = "result" | "input";

const EMITS: SqlEmit[] = ["result", "input"];

/** `$name`, `:name` and `@name` are all named parameters to SQLite. */
const NAMED_PARAMETER = /[$:@]([A-Za-z_][A-Za-z0-9_]*)/g;

type Notify = (payload: unknown, instanceId?: string) => void;

/**
 * A value SQLite can store.
 *
 * Booleans and objects have no column type, and a board should not have to
 * convert them by hand on the way in — a JSON field arriving as an object is
 * far more often meant to be kept than to be an error.
 */
function bindable(value: unknown): SqlValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Runs SQL text that arrived as input — a dump, typically — against the
 * database, once `refuseImport` has agreed to it.
 *
 * A dump is one transaction, and a failure part way leaves it open, so it is
 * rolled back here: nothing of a dump that did not load stays behind. The dump
 * also turns foreign keys off for the connection, and every other statement
 * expects them on.
 */
function importInto(db: Database, input: unknown): void {
  const text =
    typeof input === "string"
      ? input
      : input instanceof Uint8Array
        ? new TextDecoder().decode(input)
        : null;
  if (text === null || !text.trim()) {
    throw new Error("an import needs SQL text as its input");
  }
  const refused = refuseImport(text);
  if (refused) {
    throw new Error(refused);
  }
  try {
    db.exec(text);
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // No transaction was open: the text did not begin one.
    }
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export class SqlService implements HostedService {
  readonly serviceId = sqlDescriptor.serviceId;
  readonly serviceName = sqlDescriptor.serviceName;
  readonly version = sqlDescriptor.version;
  readonly capabilities = sqlDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private mode: SqlMode = "query";
  private statement = "";
  private schema = "";
  private lastCount = 0;
  private lastError = "";
  /** Boards whose schema this instance has already applied. */
  private prepared = new Set<string>();
  /** The file this board keeps its tables in. Empty derives one; see docs. */
  private database = "";
  /** What travels onward: the statement's result, or the input it ran on. */
  private emit: SqlEmit = "result";

  constructor(
    config: ServiceConfiguration,
    private readonly databases: DatabaseStore,
  ) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  getState(): JsonRecord {
    return {
      mode: this.mode,
      emit: this.emit,
      database: this.database,
      statement: this.statement,
      schema: this.schema,
      lastCount: this.lastCount,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.mode === "string" && MODES.includes(config.mode as SqlMode)) {
      this.mode = config.mode as SqlMode;
    }
    if (typeof config.emit === "string" && EMITS.includes(config.emit as SqlEmit)) {
      this.emit = config.emit as SqlEmit;
    }
    if (typeof config.statement === "string") {
      this.statement = config.statement;
    }
    if (typeof config.schema === "string" && config.schema !== this.schema) {
      this.schema = config.schema;
      // A changed schema is a different set of tables to bring into being.
      this.prepared.clear();
    }
    if (typeof config.database === "string" && config.database !== this.database) {
      this.database = config.database.trim();
      // Another file is another set of tables, whatever this one already made.
      this.prepared.clear();
    }
    return this.getState();
  }

  /**
   * Runs the statement and hands onward whatever `emit` says travels.
   *
   * Unlike `store`, this returns rather than pushing: SQLite answers in the
   * same call, so there is nothing to wait for and no reason to stop the
   * pipeline and re-enter it.
   */
  process(input: unknown, notify: Notify): unknown {
    const scope = this.host?.scope();
    if (!scope) {
      return this.fail(notify, "sql has no runtime to scope its database to");
    }
    if (!this.statement.trim() && STATEMENT_MODES.includes(this.mode)) {
      return this.fail(notify, "sql has no statement to run");
    }

    if (this.mode === "databases") {
      // Opens nothing: listing the databases is not a reason to create one.
      try {
        const rows = this.databases.list(scope.owner);
        const result = { rows, count: rows.length };
        this.lastCount = rows.length;
        this.lastError = "";
        notify(result);
        return this.emit === "input" ? input : result;
      } catch (err) {
        return this.fail(notify, `databases failed: ${reason(err)}`);
      }
    }

    let db: Database;
    try {
      db = this.database
        ? this.databases.openNamed(scope.owner, this.database)
        : this.databases.open(scope);
      this.applySchema(db, scope);
    } catch (err) {
      return this.fail(notify, `could not open the board's database: ${reason(err)}`);
    }

    try {
      if (this.mode === "export") {
        const dump = dumpDatabase(db);
        this.lastError = "";
        // Reported as what was exported, not as the dump itself: the text
        // travels to the next service, and a panel has no use for a copy.
        notify({
          exported: this.database || scope.boardName,
          bytes: dump.length,
        });
        return this.emit === "input" ? input : dump;
      }
      const result = this.execute(db, input);
      this.lastError = "";
      // Reported either way: what the statement did is this service's own news,
      // and a panel showing it does not depend on the board choosing to pass it
      // on. Only what travels to the next service is `emit`'s to decide.
      notify(result);
      return this.emit === "input" ? input : result;
    } catch (err) {
      return this.fail(notify, `${this.mode} failed: ${reason(err)}`);
    }
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Creates the board's tables, once, before anything reads them.
   *
   * Not on configure: a service's first `configure` runs in its constructor,
   * before the runtime hands it a host — so at that moment there is no scope,
   * and no way to know which board's database the tables belong in.
   */
  private applySchema(db: Database, scope: RuntimeScope): void {
    const key = `${scope.owner} ${this.database || scope.boardName}`;
    if (!this.schema.trim() || this.prepared.has(key)) {
      return;
    }
    db.exec(this.schema);
    this.prepared.add(key);
  }

  private execute(db: Database, input: unknown): JsonRecord {
    if (this.mode === "exec") {
      db.exec(this.statement || this.schema);
      this.lastCount = 0;
      return { executed: true };
    }
    if (this.mode === "import") {
      importInto(db, input);
      this.lastCount = 0;
      return { executed: true };
    }

    const params = this.parameters(input);
    if (this.mode === "run") {
      const { changes, lastInsertRowid } = db.run(this.statement, params);
      this.lastCount = changes;
      return { changes, lastInsertRowid };
    }

    const rows = db.query(this.statement, params);
    this.lastCount = rows.length;
    return { rows, count: rows.length };
  }

  /**
   * The values the statement asks for, taken from the input by name.
   *
   * Only the names the statement mentions are bound: SQLite rejects a
   * parameter it was not asked for, so handing it a whole input object would
   * fail on every field the statement happens not to use.
   */
  private parameters(input: unknown): Record<string, SqlValue> {
    const record =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as JsonRecord)
        : {};
    const params: Record<string, SqlValue> = {};
    for (const match of codeOf(this.statement).matchAll(NAMED_PARAMETER)) {
      params[match[1]] = bindable(record[match[1]]);
    }
    return params;
  }

  /** Reports a failure and produces nothing, so the pipeline stops here. */
  private fail(notify: Notify, error: string): null {
    this.lastError = error;
    this.host?.log("error", "service.failed", { message: error });
    notify({ error });
    return null;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
