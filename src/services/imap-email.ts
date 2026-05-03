/**
 * Service Documentation
 * Service ID: imap-email
 * Service Name: IMAP Email
 * Runtime: hkp-node
 * Modes: listen (source — uses IMAP IDLE to push new emails downstream in real-time)
 * Key Config: host, port, username, password, tls, mailbox
 * IO: in=any (pass-through) -> out=EmailEnvelope pushed on new mail
 */

import { ImapFlow, MailboxObject } from "imapflow";
import { simpleParser } from "mailparser";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const imapEmailDescriptor: ServiceRegistryEntry = {
  serviceId: "imap-email",
  serviceName: "IMAP Email",
};

type ImapEmailState = {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  mailbox: string;
  running: boolean;
  error: string;
};

export class ImapEmailService implements HostedService {
  readonly serviceId = imapEmailDescriptor.serviceId;
  readonly serviceName = imapEmailDescriptor.serviceName;
  readonly uuid: string;

  private state: ImapEmailState = {
    host: "",
    port: 993,
    username: "",
    password: "",
    tls: true,
    mailbox: "INBOX",
    running: false,
    error: "",
  };

  private client: ImapFlow | null = null;
  private runtimeHost: RuntimeHost | null = null;
  private lastSeenUid = 0;
  private _stopping = false;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.runtimeHost = host;
  }

  getState(): JsonRecord {
    return { ...this.state };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.host === "string") {
      this.state.host = config.host;
    }
    if (typeof config.port === "number") {
      this.state.port = config.port;
    }
    if (typeof config.username === "string") {
      this.state.username = config.username;
    }
    if (typeof config.password === "string") {
      this.state.password = config.password;
    }
    if (typeof config.tls === "boolean") {
      this.state.tls = config.tls;
    }
    if (typeof config.mailbox === "string") {
      this.state.mailbox = config.mailbox;
    }

    if (config.connect === true) {
      void this._connect();
    } else if (config.disconnect === true) {
      void this._disconnect();
    }

    return this.getState();
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    // Pass-through — this service is a source that pushes emails via host.processFrom().
    return input;
  }

  destroy(): void {
    void this._disconnect();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _connect(): Promise<void> {
    await this._disconnect();

    if (!this.state.host || !this.state.username || !this.state.password) {
      this.state.error = "host, username and password are required";
      this._notify({ error: this.state.error });
      return;
    }

    this._stopping = false;
    this.state.error = "";

    this.client = new ImapFlow({
      host: this.state.host,
      port: this.state.port,
      secure: this.state.tls,
      auth: {
        user: this.state.username,
        pass: this.state.password,
      },
    });

    try {
      await this.client.connect();

      // Snapshot UIDNEXT immediately so any email arriving between connect and
      // the first IDLE cycle is not silently skipped.
      const status = await this.client.status(this.state.mailbox, {
        uidNext: true,
      });
      this.lastSeenUid = (status.uidNext ?? 1) - 1;

      this.state.running = true;
      this._notify({ running: true, error: "" });
      void this._idleLoop();
    } catch (err) {
      this.state.running = false;
      this.state.error = String(err);
      this._notify({ running: false, error: this.state.error });
      this.client = null;
    }
  }

  private async _disconnect(): Promise<void> {
    this._stopping = true;
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        await c.logout();
      } catch {
        // ignore logout errors during teardown
      }
    }
    this.state.running = false;
    this._notify({ running: false });
  }

  private async _idleLoop(): Promise<void> {
    if (!this.client) return;

    // Open the mailbox so it is selected before IDLE starts.
    const initLock = await this.client.getMailboxLock(this.state.mailbox);
    initLock.release();

    while (!this._stopping && this.client) {
      // fetchPromise is set by the 'exists' handler so we can await it after
      // idle() resolves (idle() resolves as a side-effect of getMailboxLock()
      // sending DONE, which happens inside _fetchUnderLock()).
      let fetchPromise: Promise<void> | null = null;

      const onExists = () => {
        fetchPromise = this._fetchUnderLock();
      };

      this.client.once("exists", onExists);

      try {
        // idle() blocks until the server terminates the IDLE session.
        // Calling getMailboxLock() from onExists sends DONE, which causes
        // the server to end IDLE and idle() to resolve here.
        await this.client.idle();
      } catch (err) {
        this.client.off("exists", onExists);
        if (this._stopping) return;
        this.state.error = String(err);
        this._notify({ error: this.state.error });
        await this._sleep(10_000);
        continue;
      }

      this.client.off("exists", onExists);

      // Wait for the fetch triggered by EXISTS (or do a catch-up fetch on
      // the 29-minute IDLE timeout when no EXISTS was received).
      if (fetchPromise) {
        await fetchPromise;
      } else if (!this._stopping && this.client) {
        await this._fetchUnderLock();
      }
    }
  }

  private async _fetchUnderLock(): Promise<void> {
    if (!this.client || this._stopping) return;
    try {
      const lock = await this.client.getMailboxLock(this.state.mailbox);
      try {
        await this._fetchNew();
      } finally {
        lock.release();
      }
    } catch (err) {
      if (!this._stopping) {
        this.state.error = String(err);
        this._notify({ error: this.state.error });
      }
    }
  }

  private async _fetchNew(): Promise<void> {
    if (!this.client) return;

    const mailbox = this.client.mailbox as MailboxObject | null;
    if (!mailbox?.exists) return;

    for await (const msg of this.client.fetch(
      { uid: `${this.lastSeenUid + 1}:*` },
      { envelope: true, uid: true, source: true },
    )) {
      if (msg.uid <= this.lastSeenUid) continue;
      this.lastSeenUid = msg.uid;

      let text = "";
      if (msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
          text = parsed.text ?? parsed.textAsHtml ?? "";
        } catch {
          // ignore parse errors — email still forwarded without body
        }
      }

      const email: JsonRecord = {
        messageId: msg.envelope?.messageId ?? "",
        subject: msg.envelope?.subject ?? "",
        from:
          msg.envelope?.from?.map((a) => a.address ?? a.name).join(", ") ?? "",
        to: msg.envelope?.to?.map((a) => a.address ?? a.name).join(", ") ?? "",
        date: msg.envelope?.date?.toISOString() ?? "",
        uid: msg.uid,
        text,
      };

      this._push(email);
    }
  }

  private _push(data: unknown): void {
    if (!this.runtimeHost) return;
    const result = this.runtimeHost.processFrom(
      this.uuid,
      data,
      (n: RuntimeNotification) =>
        this._notify(n.payload as JsonRecord, n.instanceId),
    );
    this.runtimeHost.emitResult(result);
  }

  private _notify(payload: JsonRecord, instanceId: string = this.uuid): void {
    this.runtimeHost?.notify(payload, instanceId);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}
