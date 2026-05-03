/**
 * Service Documentation
 * Service ID: telegram-sender
 * Service Name: Telegram Sender
 * Runtime: hkp-node
 * Modes: transform (sends input text to a Telegram chat, then passes input through)
 * Key Config: botToken, chatId
 * IO: in=string|any -> out=same input (pass-through after sending)
 */

import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const telegramSenderDescriptor: ServiceRegistryEntry = {
  serviceId: "telegram-sender",
  serviceName: "Telegram Sender",
};

type TelegramSenderState = {
  botToken: string;
  chatId: string;
  error: string;
};

export class TelegramSenderService implements HostedService {
  readonly serviceId = telegramSenderDescriptor.serviceId;
  readonly serviceName = telegramSenderDescriptor.serviceName;
  readonly uuid: string;

  private _state: TelegramSenderState = {
    botToken: "",
    chatId: "",
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
    if (typeof config.botToken === "string") {
      this._state.botToken = config.botToken;
    }
    if (typeof config.chatId === "string") {
      this._state.chatId = config.chatId;
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
    if (!this._state.botToken || !this._state.chatId) {
      this._state.error = "botToken and chatId are required";
      this._notify({ error: this._state.error });
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this._state.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this._state.chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { ok: boolean; description?: string };
      if (!body.ok) {
        throw new Error(body.description ?? "sendMessage failed");
      }
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
