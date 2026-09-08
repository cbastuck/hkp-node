import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the listener does when the connection under it goes away.
 *
 * The interesting part is not IMAP itself but the lifecycle around it: a socket
 * that dies mid-IDLE (a closed laptop lid) must not take the process down, the
 * listener must come back on its own, and it must resume where it left off
 * rather than skipping the mail that arrived while it was gone.
 */

const fake = vi.hoisted(() => {
  /** The mailbox, as the server sees it. Shared by every connection. */
  const store: Array<{ uid: number }> = [];
  const clients: any[] = [];
  /** Set to refuse every further connection, as a server that is down does. */
  const state = { refuseConnections: false };
  return { store, clients, state };
});

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeImapFlow extends EventEmitter {
    options: any;
    usable = true;
    mailbox: any = null;
    connectCalls = 0;
    private _endIdle: (() => void) | null = null;

    createdAt = Date.now();

    constructor(options: any) {
      super();
      this.options = options;
      fake.clients.push(this);
    }

    async connect() {
      this.connectCalls += 1;
      if (fake.state.refuseConnections) {
        const err: NodeJS.ErrnoException = new Error("connect ECONNREFUSED");
        err.code = "ECONNREFUSED";
        throw err;
      }
    }

    async status() {
      const uidNext =
        fake.store.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
      return { uidNext, uidValidity: 42 };
    }

    async getMailboxLock() {
      this.mailbox = { path: "INBOX", exists: fake.store.length };
      // A command sent during IDLE ends the IDLE session, exactly as DONE does.
      this._endIdle?.();
      return { release: () => {} };
    }

    async idle() {
      return new Promise<void>((resolve) => {
        this._endIdle = () => {
          this._endIdle = null;
          resolve();
        };
      });
    }

    fetch(range: { uid: string }) {
      const from = parseInt(String(range.uid).split(":")[0], 10);
      const messages = fake.store.filter((m) => m.uid >= from);
      return (async function* () {
        for (const m of messages) {
          yield { uid: m.uid, envelope: { subject: `mail ${m.uid}` } };
        }
      })();
    }

    async logout() {
      this.close();
    }

    close() {
      if (!this.usable) {
        return;
      }
      this.usable = false;
      this._endIdle?.();
      this.emit("close");
    }

    // ── test controls ──────────────────────────────────────────────────────

    /** New mail lands in the mailbox and the server announces it. */
    deliver(uid: number) {
      fake.store.push({ uid });
      this.emit("exists", { path: "INBOX", count: fake.store.length });
    }

    /** The socket dies the way a suspended machine's does. */
    crash() {
      const err: NodeJS.ErrnoException = new Error("read ECONNRESET");
      err.code = "ECONNRESET";
      this.usable = false;
      this.emit("error", err);
      this._endIdle?.();
      this.emit("close");
    }
  }

  return { ImapFlow: FakeImapFlow };
});

// vi.mock is hoisted above this import, so the service sees the fake client.
import {
  ImapEmailService,
  normalizeMessageId,
  normalizeReferences,
} from "../src/services/imap-email";
import { SecretVault } from "../src/secrets";

const CONFIG = {
  host: "imap.example.com",
  port: 993,
  username: "user",
  password: "pass",
  mailbox: "INBOX",
};

type Harness = {
  service: InstanceType<typeof ImapEmailService>;
  /** Subjects handed to the rest of the board, in order. */
  pushed: string[];
  /** The runtime's secrets, as the service sees them. */
  vault: SecretVault;
};

function makeService(
  state: Record<string, unknown>,
  vault: SecretVault = new SecretVault(),
): Harness {
  const pushed: string[] = [];
  const service = new ImapEmailService({
    uuid: "imap-1",
    serviceId: "imap-email",
    state,
  } as never);
  service.setHost({
    processFrom: (_uuid: string, data: any) => {
      pushed.push(data.subject);
      return data;
    },
    notify: () => {},
    emitResult: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    secrets: () => vault,
  } as never);
  return { service, pushed, vault };
}

/** Let the connect/idle chain run to where it waits. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

const latest = () => fake.clients[fake.clients.length - 1];

describe("imap-email", () => {
  beforeEach(() => {
    fake.store.length = 0;
    fake.clients.length = 0;
    fake.state.refuseConnections = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at the end of the mailbox and pushes what arrives after", async () => {
    fake.store.push({ uid: 1 }, { uid: 2 });
    const { service, pushed } = makeService({ ...CONFIG, connect: true });
    await settle();

    // The mail that was already there is not news.
    expect(pushed).toEqual([]);

    latest().deliver(3);
    await settle();
    expect(pushed).toEqual(["mail 3"]);

    service.destroy();
  });

  it("survives a socket error and reconnects on its own", async () => {
    fake.store.push({ uid: 1 });
    const { service, pushed } = makeService({ ...CONFIG, connect: true });
    await settle();

    const first = latest();
    // Without a listener of ours, this event would end the process.
    expect(first.listenerCount("error")).toBeGreaterThan(0);
    first.crash();
    await settle();

    expect(service.getState()).toMatchObject({
      enabled: true,
      running: false,
      status: "reconnecting",
      error: "read ECONNRESET (ECONNRESET)",
    });

    // Mail that arrives while there is no connection.
    fake.store.push({ uid: 2 });

    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(fake.clients).toHaveLength(2);
    expect(latest().connectCalls).toBe(1);
    expect(service.getState()).toMatchObject({
      running: true,
      status: "connected",
    });
    // Resumed rather than re-anchored: the missed message is delivered, and
    // the one that was already read is not delivered twice.
    expect(pushed).toEqual(["mail 2"]);

    latest().deliver(3);
    await settle();
    expect(pushed).toEqual(["mail 2", "mail 3"]);

    service.destroy();
  });

  it("keeps retrying with a growing delay while the server stays down", async () => {
    const { service } = makeService({ ...CONFIG, connect: true });
    await settle();

    fake.state.refuseConnections = true;
    latest().crash();
    await settle();

    // Sit through several minutes of a server that will not answer.
    for (let elapsed = 0; elapsed < 400_000; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
    }

    const attempts = fake.clients.slice(1);
    expect(attempts.length).toBeGreaterThan(5);
    expect(service.getState()).toMatchObject({
      status: "reconnecting",
      // Every connection made, plus the one already scheduled.
      reconnectAttempts: attempts.length + 1,
      error: "connect ECONNREFUSED (ECONNREFUSED)",
    });

    // Doubling per attempt up to a minute, jittered by at most a fifth.
    let previous = fake.clients[0].createdAt;
    attempts.forEach((client: any, index: number) => {
      const expected = Math.min(60_000, 2_000 * 2 ** index);
      const gap = client.createdAt - previous;
      expect(gap).toBeGreaterThanOrEqual(expected * 0.8 - 1);
      expect(gap).toBeLessThanOrEqual(expected * 1.2 + 1);
      previous = client.createdAt;
    });

    // And when the server comes back, the next attempt simply succeeds.
    fake.state.refuseConnections = false;
    await vi.advanceTimersByTimeAsync(70_000);
    await settle();
    expect(service.getState()).toMatchObject({
      running: true,
      status: "connected",
      reconnectAttempts: 0,
    });

    service.destroy();
  });

  it("stops reconnecting once disconnected", async () => {
    const { service } = makeService({ ...CONFIG, connect: true });
    await settle();

    latest().crash();
    await settle();
    expect(service.getState()).toMatchObject({ status: "reconnecting" });

    service.configure({ connect: false });
    const clientCount = fake.clients.length;

    await vi.advanceTimersByTimeAsync(120_000);
    await settle();

    expect(fake.clients).toHaveLength(clientCount);
    expect(service.getState()).toMatchObject({
      enabled: false,
      running: false,
      status: "disconnected",
    });
  });

  it("connects itself when restored from a board that was listening", async () => {
    const { service } = makeService({ ...CONFIG, enabled: true });
    await settle();

    expect(fake.clients).toHaveLength(1);
    expect(service.getState()).toMatchObject({
      running: true,
      status: "connected",
    });

    service.destroy();
  });
});

describe("threading headers", () => {
  it("strips the angle brackets a header carries", () => {
    // The brackets are header syntax, not identity. Left on, the same message
    // compares unequal depending on which header it was read from.
    expect(normalizeMessageId("<abc@mail.example>")).toBe("abc@mail.example");
    expect(normalizeMessageId("abc@mail.example")).toBe("abc@mail.example");
    expect(normalizeMessageId("  <abc@x>  ")).toBe("abc@x");
    expect(normalizeMessageId(undefined)).toBe("");
  });

  it("reads a References chain oldest first, however it arrives", () => {
    // The parser gives an array for several and a bare string for one.
    expect(normalizeReferences(["<a@x>", "<b@y>"])).toEqual(["a@x", "b@y"]);
    expect(normalizeReferences("<a@x> <b@y>")).toEqual(["a@x", "b@y"]);
    expect(normalizeReferences("<only@x>")).toEqual(["only@x"]);
    expect(normalizeReferences(undefined)).toEqual([]);
  });

  it("drops empty entries rather than carrying blanks into a thread id", () => {
    expect(normalizeReferences(["<a@x>", "", "  ", "<b@y>"])).toEqual([
      "a@x",
      "b@y",
    ]);
  });
});

describe("imap-email credentials", () => {
  beforeEach(() => {
    fake.store.length = 0;
    fake.clients.length = 0;
    fake.state.refuseConnections = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The password the service holds is a name; the value belongs to the runtime.
   * What matters is that the name is what survives — a board saved from this
   * service says which secret it needs and not what it is.
   */
  it("connects with a value it never holds, and still reports the reference", async () => {
    const vault = new SecretVault();
    vault.replace({ "mail.pass": { value: "hunter2" } });
    const { service } = makeService(
      { ...CONFIG, password: "{{secret.mail.pass}}", connect: true },
      vault,
    );
    await settle();

    expect(latest().options.auth).toMatchObject({ user: "user", pass: "hunter2" });
    expect(service.getState()).toMatchObject({
      status: "connected",
      password: "{{secret.mail.pass}}",
    });
  });

  it("will not send a credential to a host it is not bound to", async () => {
    const vault = new SecretVault();
    vault.replace({
      "mail.pass": { value: "hunter2", audience: ["imap.gmail.com"] },
    });
    const { service } = makeService(
      { ...CONFIG, password: "{{secret.mail.pass}}", connect: true },
      vault,
    );
    await settle();

    expect(fake.clients).toHaveLength(0);
    expect(service.getState()).toMatchObject({
      status: "disconnected",
      error: "mail.pass may not be sent to imap.example.com",
    });
  });

  it("says which secret it is missing rather than sending its name", async () => {
    const { service } = makeService({
      ...CONFIG,
      password: "{{secret.absent}}",
      connect: true,
    });
    await settle();

    expect(fake.clients).toHaveLength(0);
    expect(service.getState()).toMatchObject({
      error: "no value stored for absent",
    });
  });
});
