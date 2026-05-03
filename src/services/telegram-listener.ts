/**
 * Service Documentation
 * Service ID: telegram-listener
 * Service Name: Telegram Listener
 * Runtime: hkp-node
 * Modes: listen (source — long-polls Telegram Bot API, pushes each incoming text message downstream)
 * Key Config: botToken, allowedChatId
 * IO: in=any (pass-through) -> out=TelegramMessage pushed on new text
 */

import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const telegramListenerDescriptor: ServiceRegistryEntry = {
  serviceId: "telegram-listener",
  serviceName: "Telegram Listener",
};

type TelegramState = {
  botToken: string;
  allowedChatId: string;
  running: boolean;
  error: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
  };
};

export class TelegramListenerService implements HostedService {
  readonly serviceId = telegramListenerDescriptor.serviceId;
  readonly serviceName = telegramListenerDescriptor.serviceName;
  readonly uuid: string;

  private _state: TelegramState = {
    botToken: "",
    allowedChatId: "",
    running: false,
    error: "",
  };

  private _host: RuntimeHost | null = null;
  private _stopping = false;
  private _offset = 0;

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
    if (typeof config.allowedChatId === "string") {
      this._state.allowedChatId = config.allowedChatId;
    }

    if (config.connect === true) {
      void this._start();
    } else if (config.disconnect === true) {
      this._stop();
    }

    return this.getState();
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    return input;
  }

  destroy(): void {
    this._stop();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _start(): Promise<void> {
    this._stop();
    if (!this._state.botToken) {
      this._state.error = "botToken is required";
      this._notify({ error: this._state.error });
      return;
    }

    this._stopping = false;
    this._offset = 0;
    this._state.error = "";

    // Verify token and drain pending updates before going live.
    try {
      await this._getMe();
      await this._drainUpdates();
    } catch (err) {
      this._state.running = false;
      this._state.error = String(err);
      this._notify({ running: false, error: this._state.error });
      return;
    }

    this._state.running = true;
    this._notify({ running: true, error: "" });
    void this._pollLoop();
  }

  private _stop(): void {
    this._stopping = true;
    this._state.running = false;
    this._notify({ running: false });
  }

  private async _getMe(): Promise<void> {
    const res = await this._call("getMe", {});
    if (!res.ok) {
      throw new Error(res.description ?? "Telegram API error");
    }
  }

  /** Consume all buffered updates without pushing them, so only new ones fire. */
  private async _drainUpdates(): Promise<void> {
    const updates = await this._fetchUpdates(0);
    if (updates.length > 0) {
      this._offset = updates[updates.length - 1].update_id + 1;
    }
  }

  private async _pollLoop(): Promise<void> {
    while (!this._stopping) {
      try {
        const updates = await this._fetchUpdates(this._offset);
        for (const u of updates) {
          this._offset = u.update_id + 1;
          this._handleUpdate(u);
        }
      } catch (err) {
        if (this._stopping) return;
        this._state.error = String(err);
        this._notify({ error: this._state.error });
        await this._sleep(10_000);
      }
    }
  }

  private async _fetchUpdates(offset: number): Promise<TelegramUpdate[]> {
    const res = await this._call("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message"],
    });
    if (!res.ok) {
      throw new Error(res.description ?? "getUpdates failed");
    }
    return res.result as TelegramUpdate[];
  }

  private _handleUpdate(u: TelegramUpdate): void {
    const msg = u.message;
    if (!msg?.text) return;

    const chatId = String(msg.chat.id);
    if (this._state.allowedChatId && chatId !== this._state.allowedChatId) return;

    const from =
      msg.from?.username
        ? `@${msg.from.username}`
        : msg.from?.first_name ?? "unknown";

    const payload: JsonRecord = {
      text: msg.text,
      from,
      chatId,
      messageId: msg.message_id,
      date: new Date(msg.date * 1000).toISOString(),
    };

    this._push(payload);
  }

  private async _call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    const url = `https://api.telegram.org/bot${this._state.botToken}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(35_000),
    });
    return response.json();
  }

  private _push(data: unknown): void {
    if (!this._host) return;
    const result = this._host.processFrom(
      this.uuid,
      data,
      (n: RuntimeNotification) =>
        this._notify(n.payload as JsonRecord, n.instanceId),
    );
    this._host.emitResult(result);
  }

  private _notify(payload: JsonRecord, instanceId: string = this.uuid): void {
    this._host?.notify(payload, instanceId);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (typeof (t as any).unref === "function") (t as any).unref();
    });
  }
}
