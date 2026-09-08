/**
 * Service Documentation
 * Service ID: sql
 * Service Name: SQL
 * Runtime: hkp-node
 * Modes: query | run | exec
 * Key Config: statement, schema, mode
 * IO: in=JSON (the statement's named parameters) -> out=JSON
 *     query -> { rows, count }
 *     run   -> { changes, lastInsertRowid }
 *     exec  -> { executed: true }
 *
 * The generic half of the pair: it knows SQL and nothing else. Tables, columns
 * and meaning all belong to the board, which is what makes it usable for a
 * workflow this service has never heard of. A service that understands one
 * domain — conversations, say — is a second service over the same module
 * (`database.ts`), not a mode of this one.
 *
 * The database is the board's, chosen by the runtime's scope rather than by
 * configuration, so a board cannot widen its reach by asking. Two `sql`
 * services on one board see the same tables without being told to; two boards
 * never do.
 *
 * **Parameters come from the input, named by the statement.** A statement
 * mentioning `$conversationId` is given the input's `conversationId`, and a
 * board writes no parameter list at all. Values are always bound, never
 * interpolated — a subject line containing a quote is a subject line, not a
 * syntax error, and not an injection.
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

export const sqlDescriptor: ServiceRegistryEntry = {
  serviceId: "sql",
  serviceName: "SQL",
  version: "v1",
  capabilities: [],
};

type SqlMode = "query" | "run" | "exec";

const MODES: SqlMode[] = ["query", "run", "exec"];

/** `$name`, `:name` and `@name` are all named parameters to SQLite. */
const NAMED_PARAMETER = /[$:@]([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The statement with its literals and comments blanked out.
 *
 * A parameter is only a parameter in code. `'a@x'` is an email address, and
 * scanning the raw text would read `@x` as a parameter, bind a value SQLite
 * never asked for, and fail the statement — on precisely the data this service
 * exists to hold.
 */
function code(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

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
    if (typeof config.statement === "string") {
      this.statement = config.statement;
    }
    if (typeof config.schema === "string" && config.schema !== this.schema) {
      this.schema = config.schema;
      // A changed schema is a different set of tables to bring into being.
      this.prepared.clear();
    }
    return this.getState();
  }

  /**
   * Runs the statement and returns what it produced.
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
    if (!this.statement.trim() && this.mode !== "exec") {
      return this.fail(notify, "sql has no statement to run");
    }

    let db: Database;
    try {
      db = this.databases.open(scope);
      this.applySchema(db, scope);
    } catch (err) {
      return this.fail(notify, `could not open the board's database: ${reason(err)}`);
    }

    try {
      const result = this.execute(db, input);
      this.lastError = "";
      notify(result);
      return result;
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
    const key = `${scope.owner} ${scope.boardName}`;
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
    for (const match of code(this.statement).matchAll(NAMED_PARAMETER)) {
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
