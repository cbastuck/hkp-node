/**
 * Service Documentation
 * Service ID: smtp-email
 * Service Name: SMTP Email
 * Runtime: hkp-node
 * Modes: configured | envelope
 * Key Config: mode, host, port, username, password, tls, from, to, subject,
 *             allowedRecipients
 * IO: configured — in=string|any -> out=the same input, once it has been sent
 *     envelope   — in={to, subject, body, …} -> out=the message that was sent
 * Arrays: `to` may be a list of addresses
 * Binary: not accepted
 * MixedData: not native in runtime
 *
 * Two ways of being addressed, and the board says which.
 *
 * `configured` is a fixed destination: an alert sink, a daily digest, one
 * address written down once. The input is the body and nothing else.
 *
 * `envelope` is a reply: the recipient, subject and body all come from the
 * input, because they belong to whichever exchange this pass is about. Keeping
 * that behind a mode rather than letting the input win wherever it says
 * something is deliberate — a `to` field drifting down a pipeline must not be
 * able to redirect mail that was addressed by configuration.
 *
 * Sending is **awaited** in both. A send is not a notification that can be left
 * to happen: what follows it in a pipeline may file the message, mark a draft
 * as sent, or move a conversation on, and every one of those would be recording
 * something that had not happened yet — or had failed. A failed send produces
 * nothing, so the pipeline stops rather than continuing on that basis.
 */

import nodemailer, { Transporter } from "nodemailer";

import { normalizeMessageId, normalizeReferences } from "./imap-email";
import { resolveCredential } from "../secrets";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const smtpEmailDescriptor: ServiceRegistryEntry = {
  serviceId: "smtp-email",
  serviceName: "SMTP Email",
};

type SmtpMode = "configured" | "envelope";

/** What is handed to the transport, and what comes back out of this service. */
type Message = {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string[];
};

type SmtpEmailState = {
  mode: SmtpMode;
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  from: string;
  to: string;
  subject: string;
  allowedRecipients: string[];
  error: string;
};

/** Injectable so tests can drive the whole service without an SMTP server. */
export type TransportFactory = (
  options: nodemailer.TransportOptions | Record<string, unknown>,
) => Transporter;

export class SmtpEmailService implements HostedService {
  readonly serviceId = smtpEmailDescriptor.serviceId;
  readonly serviceName = smtpEmailDescriptor.serviceName;
  readonly uuid: string;

  private _state: SmtpEmailState = {
    mode: "configured",
    host: "",
    port: 587,
    username: "",
    password: "",
    tls: true,
    from: "",
    to: "",
    subject: "",
    allowedRecipients: [],
    error: "",
  };

  private _host: RuntimeHost | null = null;

  constructor(
    config: ServiceConfiguration,
    private readonly createTransport: TransportFactory = (options) =>
      nodemailer.createTransport(options as nodemailer.TransportOptions),
  ) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this._host = host;
  }

  getState(): JsonRecord {
    // Nothing to hide: `password` holds the reference it was configured with,
    // never a value, so what a board saves is what it already said.
    return {
      ...this._state,
      allowedRecipients: [...this._state.allowedRecipients],
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (config.mode === "configured" || config.mode === "envelope") {
      this._state.mode = config.mode;
    }
    if (typeof config.host === "string") {
      this._state.host = config.host;
    }
    if (typeof config.port === "number") {
      this._state.port = config.port;
    }
    if (typeof config.username === "string") {
      this._state.username = config.username;
    }
    // A `{{secret.<alias>}}` reference, kept as written and resolved when a
    // message is sent. Empty is a real value here — it clears the field —
    // because nothing masks this any more, so nothing round-trips as blank.
    if (typeof config.password === "string") {
      this._state.password = config.password;
    }
    if (typeof config.tls === "boolean") {
      this._state.tls = config.tls;
    }
    if (typeof config.from === "string") {
      this._state.from = config.from;
    }
    if (typeof config.to === "string") {
      this._state.to = config.to;
    }
    if (typeof config.subject === "string") {
      this._state.subject = config.subject;
    }
    if (Array.isArray(config.allowedRecipients)) {
      this._state.allowedRecipients = config.allowedRecipients
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    }
    return this.getState();
  }

  async process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (input === null || input === undefined) {
      return null;
    }

    const message =
      this._state.mode === "envelope"
        ? this.fromInput(input, notify)
        : this.fromConfiguration(input);
    if (!message) {
      return null;
    }

    const sent = await this.send(message, notify);
    if (!sent) {
      return null;
    }

    // `configured` is a step in a pipeline that is about something else, so it
    // hands on what it was given. `envelope` is the step the pipeline is about,
    // and what it produced is the message — in the shape `conversations`
    // ingests, so filing what was just sent needs nothing in between.
    return this._state.mode === "envelope" ? sent : input;
  }

  destroy(): void {}

  // ── Private ──────────────────────────────────────────────────────────────

  /** A fixed destination, with the input as the body. */
  private fromConfiguration(input: unknown): Message {
    return {
      from: this._state.from,
      to: this._state.to,
      subject: this._state.subject,
      body: typeof input === "string" ? input : JSON.stringify(input, null, 2),
      inReplyTo: "",
      references: [],
    };
  }

  /**
   * A message the pass is carrying.
   *
   * `inReplyTo` and `references` are not decoration. A reply that omits them
   * starts a new thread in the recipient's client, and when they answer it the
   * store has no message to match their `In-Reply-To` against — so one exchange
   * quietly becomes two conversations, days later and far from the cause.
   */
  private fromInput(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Message | null {
    const record = asRecord(input);
    const to = addresses(record.to);
    if (!to) {
      this.fail(notify, "envelope mode needs a recipient in its input ('to')");
      return null;
    }
    return {
      from: text(record.from) || this._state.from,
      to,
      subject: text(record.subject) || this._state.subject,
      body: text(record.body ?? record.text),
      inReplyTo: normalizeMessageId(record.inReplyTo),
      references: normalizeReferences(record.references),
    };
  }

  /** Hands the message to the transport, and says what was sent. */
  private async send(
    message: Message,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<JsonRecord | null> {
    if (
      !this._state.host ||
      !this._state.username ||
      !this._state.password.trim() ||
      !message.from ||
      !message.to
    ) {
      return this.fail(
        notify,
        "host, username, password, from and to are required",
      );
    }

    const refused = this.refusedRecipients(message.to);
    if (refused.length > 0) {
      // The address is data — it came out of a thread, and on this board the
      // action that sends was chosen by a model. What a person approved is the
      // text, not the destination.
      return this.fail(
        notify,
        `not sending to ${refused.join(", ")}: not in allowedRecipients`,
      );
    }

    // The password exists from here to the end of this send and nowhere else.
    // It is resolved against the server being dialled, so a credential bound
    // to one host cannot be sent to another by reconfiguring this service.
    const { value: password, problem } = resolveCredential(
      this._host?.secrets?.(),
      this._state.password,
      `${this._state.host}:${this._state.port}`,
    );
    if (problem) {
      return this.fail(notify, problem);
    }

    try {
      const transporter = this.createTransport({
        host: this._state.host,
        port: this._state.port,
        secure: this._state.tls,
        auth: { user: this._state.username, pass: password },
      });

      const info = await transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.body,
        ...(message.inReplyTo
          ? { inReplyTo: bracketed(message.inReplyTo) }
          : {}),
        ...(message.references.length > 0
          ? { references: message.references.map(bracketed) }
          : {}),
      });

      if (this._state.error) {
        this._state.error = "";
      }

      const sent: JsonRecord = {
        messageId: normalizeMessageId(info?.messageId),
        from: message.from,
        to: message.to,
        subject: message.subject,
        body: message.body,
        date: new Date().toISOString(),
        direction: "outbound",
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        ...(message.references.length > 0
          ? { references: message.references }
          : {}),
      };
      notify({ ...sent, error: "" });
      return sent;
    } catch (err) {
      return this.fail(notify, String(err));
    }
  }

  /**
   * The recipients this service is not allowed to write to.
   *
   * An empty `allowedRecipients` allows everything, which is what a board that
   * has not thought about it gets. An entry is either a whole address or a
   * domain written as `@example.com`.
   */
  private refusedRecipients(to: string): string[] {
    if (this._state.allowedRecipients.length === 0) {
      return [];
    }
    return to
      .split(",")
      .map((entry) => bareAddress(entry))
      .filter(Boolean)
      .filter(
        (address) =>
          !this._state.allowedRecipients.some((allowed) =>
            allowed.startsWith("@")
              ? address.endsWith(allowed)
              : address === allowed,
          ),
      );
  }

  private fail(
    notify: (payload: unknown, instanceId?: string) => void,
    message: string,
  ): null {
    this._state.error = message;
    notify({ error: message });
    this._host?.log("warn", "service.degraded", { message });
    return null;
  }
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One address, or several joined the way a header carries them. */
function addresses(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

/** `Name <a@b.c>` is an address with a label on it; the label is not the address. */
function bareAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled ? angled[1] : value).trim().toLowerCase();
}

/** Angle brackets are header syntax; they go back on at the boundary. */
function bracketed(id: string): string {
  return id.startsWith("<") ? id : `<${id}>`;
}
