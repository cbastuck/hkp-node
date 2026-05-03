/**
 * Service Documentation
 * Service ID: smtp-email
 * Service Name: SMTP Email
 * Runtime: hkp-node
 * Modes: transform (sends input as email body, passes input through)
 * Key Config: host, port, username, password, tls, from, to, subject
 * IO: in=string|any -> out=same input (pass-through after sending)
 */

import nodemailer from "nodemailer";
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

type SmtpEmailState = {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  from: string;
  to: string;
  subject: string;
  error: string;
};

export class SmtpEmailService implements HostedService {
  readonly serviceId = smtpEmailDescriptor.serviceId;
  readonly serviceName = smtpEmailDescriptor.serviceName;
  readonly uuid: string;

  private _state: SmtpEmailState = {
    host: "",
    port: 587,
    username: "",
    password: "",
    tls: true,
    from: "",
    to: "",
    subject: "",
    error: "",
  };

  private _host: RuntimeHost | null = null;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this._host = host;
  }

  getState(): JsonRecord {
    return { ...this._state };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.host === "string") {
      this._state.host = config.host;
    }
    if (typeof config.port === "number") {
      this._state.port = config.port;
    }
    if (typeof config.username === "string") {
      this._state.username = config.username;
    }
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
    return this.getState();
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    const text =
      typeof input === "string" ? input : JSON.stringify(input, null, 2);
    void this._send(text);
    return input;
  }

  destroy(): void {}

  // ── Private ──────────────────────────────────────────────────────────────

  private async _send(text: string): Promise<void> {
    if (
      !this._state.host ||
      !this._state.username ||
      !this._state.password ||
      !this._state.from ||
      !this._state.to
    ) {
      this._state.error =
        "host, username, password, from and to are required";
      this._notify({ error: this._state.error });
      return;
    }

    try {
      const transporter = nodemailer.createTransport({
        host: this._state.host,
        port: this._state.port,
        secure: this._state.tls,
        auth: {
          user: this._state.username,
          pass: this._state.password,
        },
      });

      await transporter.sendMail({
        from: this._state.from,
        to: this._state.to,
        subject: this._state.subject,
        text,
      });

      if (this._state.error) {
        this._state.error = "";
        this._notify({ error: "" });
      }
    } catch (err) {
      this._state.error = String(err);
      this._notify({ error: this._state.error });
    }
  }

  private _notify(payload: JsonRecord, instanceId: string = this.uuid): void {
    this._host?.notify(payload, instanceId);
  }
}
