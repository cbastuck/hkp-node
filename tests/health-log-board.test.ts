import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryDatabaseStore } from "../src/services/database";
import { SqlService } from "../src/services/sql";
import { RuntimeHost } from "../src/types";

/**
 * The health log board's own statements, run.
 *
 * Every writer on the board is handed every request and decides by its
 * `$operation` guard whether the request is its own, and the query at the end
 * redraws the facade from what is left. What is pinned here is the generated
 * history: that asking for it fills the log, that asking twice changes nothing,
 * and — the part a guard written wrong would break quietly — that a request for
 * anything else passes the generators without a single row appearing.
 *
 * The statements are read out of the board rather than repeated here — a copy
 * would pass while the board was broken.
 */

const BOARD = path.join(__dirname, "../../boards/health-log-demo-board.json");

type Service = { uuid: string; serviceId: string; state: Record<string, any> };

const board = JSON.parse(fs.readFileSync(BOARD, "utf8")) as {
  services: { health: Service[] };
  facade: { init: { serviceUuid: string; payload: Record<string, unknown> }[] };
};

const host = {
  processFrom: (_uuid: string, data: unknown) => data,
  notify: () => {},
  currentContext: () => null,
  log: () => {},
  forwardLog: () => {},
  logSettings: () => ({
    logging: false,
    logData: false,
    logLevel: "info" as const,
  }),
  scope: () => ({ owner: "tester", boardName: "Private Health Log" }),
  emitResult: () => {},
} as unknown as RuntimeHost;

type Row = Record<string, unknown>;

/**
 * The board's SQL services on one in-memory database, in the board's order.
 * A request enters at a service and runs through every one after it, which is
 * what a facade button processing that service does.
 *
 * Opened the way the facade opens it: its `init` reads the history before a
 * person can press anything, and that first read is what creates the tables —
 * the writers in the middle of the pipeline carry no schema of their own.
 */
function healthLog() {
  const databases = createMemoryDatabaseStore();
  const errors: string[] = [];
  const services = board.services.health
    .filter((svc) => svc.serviceId === "sql")
    .map((svc) => {
      const service = new SqlService(svc as never, databases);
      service.setHost(host);
      return { uuid: svc.uuid, service };
    });

  const send = (from: string, request: Row) => {
    const start = services.findIndex((svc) => svc.uuid === from);
    if (start < 0) {
      throw new Error(`the board has no sql service "${from}"`);
    }
    let carried: unknown = request;
    for (const { service } of services.slice(start)) {
      carried = service.process(carried, (said: any) => {
        if (said?.error) {
          errors.push(said.error);
        }
      });
    }
    return carried as { rows: Row[]; count: number };
  };

  for (const step of board.facade.init) {
    send(step.serviceUuid, step.payload);
  }

  return { send, errors };
}

const generate = { operation: "generate-fake-data" };
const starterRows = (rows: Row[]) =>
  rows.filter((row) => !String(row.eventId).startsWith("fake-"));
const fakeRows = (rows: Row[]) =>
  rows.filter((row) => String(row.eventId).startsWith("fake-"));

describe("the health log's generated history", () => {
  it("adds six months of measurements and journals when asked", () => {
    const { send, errors } = healthLog();
    const before = send("read-history", {});
    const after = send("fake-measurements", generate);

    expect(errors).toEqual([]);
    expect(starterRows(after.rows)).toHaveLength(before.count);

    const fake = fakeRows(after.rows);
    const count = (measurement: string) =>
      fake.filter((row) => row.measurement === measurement).length;
    // Two glucose readings and one weight a day, blood pressure every other.
    expect(count("Blood glucose")).toBe(360);
    expect(count("Weight")).toBe(180);
    expect(count("Systolic")).toBe(90);
    expect(count("Diastolic")).toBe(90);

    // Spread back from today rather than stacked on one day.
    const days = new Set(fake.map((row) => String(row.observedAt).slice(0, 10)));
    expect(days.size).toBe(180);
    // A journal every third day, joined onto that day's measurements.
    const journalDays = new Set(
      fake
        .filter((row) => typeof row.journal === "string")
        .map((row) => String(row.observedAt).slice(0, 10)),
    );
    expect(journalDays.size).toBeGreaterThanOrEqual(60);
  });

  it("changes nothing when asked a second time", () => {
    const { send, errors } = healthLog();
    const once = send("fake-measurements", generate);
    const twice = send("fake-measurements", generate);

    expect(errors).toEqual([]);
    expect(twice.count).toBe(once.count);
  });

  it("stays out of every request that is not for it", () => {
    const { send, errors } = healthLog();
    const before = send("read-history", {});

    // An ordinary entry passes both generators on its way to the query.
    const after = send("add-value", {
      operation: "add-value",
      eventId: "mine-1",
      observedAt: "2026-01-02T08:00:00Z",
      kind: "glucose",
      value: "118",
      unit: "mg/dL",
    });

    expect(errors).toEqual([]);
    expect(after.count).toBe(before.count + 1);
    expect(fakeRows(after.rows)).toEqual([]);
  });

  it("can be deleted like any other entry", () => {
    const { send, errors } = healthLog();
    const generated = send("fake-measurements", generate);

    const left = send("delete-entry", {
      operation: "delete",
      eventIds: JSON.stringify(["fake-bp-000", "fake-weight-000"]),
    });

    expect(errors).toEqual([]);
    // One blood-pressure event is two rows.
    expect(left.count).toBe(generated.count - 3);
  });
});
