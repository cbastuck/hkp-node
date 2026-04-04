import {
  JsonRecord,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const timerDescriptor: ServiceRegistryEntry = {
  serviceId: "timer",
  serviceName: "Timer",
};

function durationMs(value: number, unit: string): number {
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      return value * 1_000; // fallback: treat as seconds
  }
}

export class TimerService {
  readonly serviceId = timerDescriptor.serviceId;
  readonly serviceName = timerDescriptor.serviceName;
  readonly uuid: string;

  private _periodic = false;
  private _periodicValue = 1;
  private _periodicUnit = "s";
  private _oneShotDelay = 0;
  private _oneShotDelayUnit = "ms";
  private _running = false;
  private _counter = 0;
  private _conditionUntilTriggerCount: number | undefined;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _host: RuntimeHost | undefined;

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
    return {
      periodic: this._periodic,
      periodicValue: this._periodicValue,
      periodicUnit: this._periodicUnit,
      oneShotDelay: this._oneShotDelay,
      oneShotDelayUnit: this._oneShotDelayUnit,
      running: this._running,
      counter: this._counter,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    const {
      periodicValue,
      periodicUnit,
      periodic,
      oneShotDelay,
      oneShotDelayUnit,
      immediate,
      counter,
      running,
      until,
      stop,
      start,
      restart,
    } = config as Record<string, any>;

    let doStop: boolean = !!(
      stop ||
      restart ||
      (this._running && running !== undefined && !running)
    );
    let doStart: boolean = !!(start || restart);

    const silentRestartWhileRunning = () => {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = undefined;
      }
      doStart = true;
    };

    if (periodicValue !== undefined) {
      this._periodicValue = periodicValue;
      this._notify({ periodicValue });
      if (!doStart && running) {
        doStart = true;
      } else if (this._running) {
        silentRestartWhileRunning();
      }
    }

    if (periodicUnit !== undefined) {
      this._periodicUnit = periodicUnit;
      this._notify({ periodicUnit });
      if (!doStart && running) {
        doStart = true;
      } else if (this._running) {
        silentRestartWhileRunning();
      }
    }

    if (periodic !== undefined) {
      this._periodic = periodic;
      this._notify({ periodic });
      if (!doStart && running) {
        doStart = true;
      }
    }

    if (oneShotDelay !== undefined) {
      this._oneShotDelay = oneShotDelay;
      this._notify({ oneShotDelay, periodic: false });
    }

    if (counter !== undefined) {
      this._counter = counter;
    }

    if (until !== undefined) {
      const { triggerCount } = until as Record<string, unknown>;
      this._conditionUntilTriggerCount = Number(triggerCount);
    }

    if (oneShotDelayUnit !== undefined) {
      this._oneShotDelayUnit = oneShotDelayUnit;
      this._notify({ oneShotDelayUnit });
    }

    if (doStop) {
      this._clearTimer();
    }

    if (doStart) {
      if (this._periodic) {
        this._clearTimer();
        const ms = durationMs(this._periodicValue, this._periodicUnit);
        this._timer = setInterval(() => this._tick(), ms);
        if (immediate) {
          setTimeout(() => this._tick(), 1);
        }
      } else {
        if (this._timer) {
          this._clearTimer();
        }
        const ms = immediate
          ? 1
          : durationMs(this._oneShotDelay, this._oneShotDelayUnit);
        setTimeout(() => this._tick(), ms);
      }
    }

    this._running = !!this._timer;
    this._notify({ running: this._running });
    return this.getState();
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    // Periodic timers drive themselves — passthrough.
    // One-shot: schedule a delayed fire and return input immediately.
    if (!this._periodic) {
      const ms = durationMs(this._oneShotDelay, this._oneShotDelayUnit);
      setTimeout(() => this._tickWithInput(input), ms);
    }
    return input;
  }

  destroy(): void {
    this._clearTimer();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _tick(): void {
    if (
      this._conditionUntilTriggerCount !== undefined &&
      this._counter >= this._conditionUntilTriggerCount
    ) {
      this._clearTimer();
      return;
    }
    const triggerCount = ++this._counter;
    this._notify({ counter: triggerCount });
    if (this._host) {
      const result = this._host.processFrom(
        this.uuid,
        { triggerCount },
        (n: RuntimeNotification) =>
          this._notify(n.payload as JsonRecord, n.instanceId),
      );
      this._host.emitResult(result);
    }
  }

  private _tickWithInput(input: unknown): void {
    const triggerCount = ++this._counter;
    this._notify({ counter: triggerCount });
    if (this._host) {
      const merged =
        typeof input === "object" && input !== null
          ? { ...(input as object), triggerCount }
          : { triggerCount };
      const result = this._host.processFrom(
        this.uuid,
        merged,
        (n: RuntimeNotification) =>
          this._notify(n.payload as JsonRecord, n.instanceId),
      );
      this._host.emitResult(result);
    }
  }

  private _clearTimer(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
      this._counter = 0;
      this._running = false;
      this._notify({ running: false, count: this._counter });
    }
  }

  private _notify(payload: JsonRecord, instanceId: string = this.uuid): void {
    this._host?.notify(payload, instanceId);
  }
}
