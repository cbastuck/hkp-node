/**
 * An endpoint's stream: one answer that keeps coming, written to everyone
 * listening.
 *
 * The same arrangement as hkp-rt's (`common/stream_broadcast.h`,
 * `http_stream_listener.cpp`), and the same state, so a board describes a
 * stream the same way on either runtime:
 *
 * - **One stream, not one per listener.** Every listener gets the same chunks in
 *   the same order; a newcomer starts with the last `burstBytes` of it.
 * - **Nobody holds up the stream.** Each listener has its own bounded queue; one
 *   that falls more than `maxQueueBytes` behind loses its oldest unsent chunks,
 *   and one that stops reading for `stallTimeoutMs` is let go.
 * - **Chunks are the unit**, kept, replayed and dropped whole, so a stream whose
 *   chunks each start where a decoder can (whole MP3 frames) can be joined
 *   anywhere.
 */
import { IncomingMessage, ServerResponse } from "node:http";

import { JsonRecord } from "../types";

export type StreamConfig = {
  path: string;
  contentType: string;
  burstBytes: number;
  maxQueueBytes: number;
  stallTimeoutMs: number;
};

const DEFAULTS = {
  contentType: "application/octet-stream",
  burstBytes: 0,
  maxQueueBytes: 32 * 1024,
  stallTimeoutMs: 5000,
};

/** The stream a `stream` value declares, or null where it declares none. */
export function parseStreamConfig(value: unknown): StreamConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const declared = value as JsonRecord;
  if (typeof declared.path !== "string" || !declared.path) {
    return null;
  }
  const count = (key: string, fallback: number, least = 0): number => {
    const n = declared[key];
    return typeof n === "number" && Number.isInteger(n) && n >= least ? n : fallback;
  };
  return {
    // Compared against a request's path, which always starts with one.
    path: declared.path.startsWith("/") ? declared.path : `/${declared.path}`,
    contentType:
      typeof declared.contentType === "string" && declared.contentType
        ? declared.contentType
        : DEFAULTS.contentType,
    burstBytes: count("burstBytes", DEFAULTS.burstBytes),
    maxQueueBytes: count("maxQueueBytes", DEFAULTS.maxQueueBytes, 1),
    stallTimeoutMs: count("stallTimeoutMs", DEFAULTS.stallTimeoutMs, 1),
  };
}

/** What a board declared, as state reports it back. */
export function streamState(config: StreamConfig): JsonRecord {
  return {
    path: config.path,
    contentType: config.contentType,
    burstBytes: config.burstBytes,
    maxQueueBytes: config.maxQueueBytes,
    stallTimeoutMs: config.stallTimeoutMs,
  };
}

/**
 * The bounds of a `bytes=first-last` Range header, or null where it is absent,
 * open-ended or not of that form.
 */
export function boundedRange(header: string | undefined): [number, number] | null {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? "");
  if (!match) {
    return null;
  }
  const first = Number(match[1]);
  const last = Number(match[2]);
  return last >= first ? [first, last] : null;
}

/**
 * Answers a bounded Range request — WebKit asks for `bytes=0-1` before it plays
 * anything — with that many bytes from the start of `sample`, and closes.
 * Answered with the endless stream instead, the probe stays open for as long as
 * the player does and counts as a second listener.
 */
export function answerRangeProbe(
  res: ServerResponse,
  contentType: string,
  [first, last]: [number, number],
  sample: Buffer,
): void {
  const body = sample.subarray(0, Math.min(last - first + 1, sample.length));
  res.statusCode = 206;
  res.setHeader("content-type", contentType);
  res.setHeader("content-range", `bytes ${first}-${first + body.length - 1}/*`);
  res.setHeader("content-length", String(body.length));
  res.setHeader("cache-control", "no-cache, no-store");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("connection", "close");
  res.end(body);
}

/**
 * The chunks waiting to be written to one listener, dropping the oldest past
 * the bound: the listener hears a gap and lands back near the live edge rather
 * than drifting ever further behind. The newest is never dropped, so a chunk
 * larger than the bound still goes out.
 */
export class ChunkQueue {
  private chunks: Buffer[] = [];
  private held = 0;

  constructor(private readonly maxBytes: number) {}

  /** Answers how many chunks were dropped to make room. */
  push(chunk: Buffer): number {
    this.chunks.push(chunk);
    this.held += chunk.length;
    let dropped = 0;
    while (this.held > this.maxBytes && this.chunks.length > 1) {
      this.held -= this.chunks.shift()!.length;
      dropped += 1;
    }
    return dropped;
  }

  shift(): Buffer | undefined {
    const chunk = this.chunks.shift();
    if (chunk) {
      this.held -= chunk.length;
    }
    return chunk;
  }

  get bytes(): number {
    return this.held;
  }

  get size(): number {
    return this.chunks.length;
  }
}

/** One caller listening to the stream. */
export class StreamListener {
  private readonly queue: ChunkQueue;
  private readonly connectedAt = Date.now();
  // When the response started refusing more, while it still does.
  private stalledSince: number | null = null;
  private closed = false;
  bytesSent = 0;
  droppedChunks = 0;

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
    contentType: string,
    maxQueueBytes: number,
    private readonly stallTimeoutMs: number,
    private readonly onClosed: (listener: StreamListener) => void,
  ) {
    this.queue = new ChunkQueue(maxQueueBytes);
    res.statusCode = 200;
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-cache, no-store");
    res.setHeader("access-control-allow-origin", "*");
    // A reverse proxy in front of the server (nginx, and those that honour the
    // same header) would otherwise collect the stream into buffers before
    // passing it on — seconds of delay for a live stream.
    res.setHeader("x-accel-buffering", "no");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    res.on("drain", () => this.flush());
    res.on("close", () => this.finish());
  }

  deliver(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    if (this.res.writableNeedDrain) {
      // Not taking more. A caller that stops reading without hanging up — a
      // paused player, a parked request — is not listening, however long its
      // connection stays open.
      const now = Date.now();
      this.stalledSince ??= now;
      if (now - this.stalledSince > this.stallTimeoutMs) {
        this.close();
        return;
      }
      this.droppedChunks += this.queue.push(chunk);
      return;
    }
    this.stalledSince = null;
    this.droppedChunks += this.queue.push(chunk);
    this.flush();
  }

  private flush(): void {
    while (!this.closed && this.queue.size && !this.res.writableNeedDrain) {
      const chunk = this.queue.shift()!;
      this.bytesSent += chunk.length;
      this.res.write(chunk);
    }
    if (!this.res.writableNeedDrain) {
      this.stalledSince = null;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.res.destroy();
    this.finish();
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClosed(this);
  }

  describe(): JsonRecord {
    const forwarded = this.req.headers["x-forwarded-for"];
    const address = typeof forwarded === "string" && forwarded
      ? forwarded.split(",")[0].trim()
      : `${this.req.socket.remoteAddress ?? ""}:${this.req.socket.remotePort ?? ""}`;
    const description: JsonRecord = {
      address,
      userAgent: this.req.headers["user-agent"] ?? "",
      seconds: Math.round((Date.now() - this.connectedAt) / 100) / 10,
      bytesSent: this.bytesSent,
      droppedChunks: this.droppedChunks,
    };
    const range = this.req.headers.range;
    if (range) {
      description.range = range;
    }
    return description;
  }
}

/** One stream, written to everyone listening. */
export class StreamBroadcast {
  private listeners: StreamListener[] = [];
  private burst: Buffer[] = [];
  private burstHeld = 0;
  private burstBytes = 0;
  /** The newest chunk, which is what a Range probe is answered from. */
  last: Buffer | null = null;

  constructor(private readonly onListenersChanged: (count: number) => void) {}

  setBurstBytes(bytes: number): void {
    this.burstBytes = bytes;
    this.trimBurst();
  }

  join(listener: StreamListener): void {
    for (const chunk of this.burst) {
      listener.deliver(chunk);
    }
    this.listeners.push(listener);
    this.onListenersChanged(this.listeners.length);
  }

  leave(listener: StreamListener): void {
    const index = this.listeners.indexOf(listener);
    if (index === -1) {
      return;
    }
    this.listeners.splice(index, 1);
    this.onListenersChanged(this.listeners.length);
  }

  publish(chunk: Buffer): void {
    if (!chunk.length) {
      return;
    }
    this.last = chunk;
    if (this.burstBytes > 0) {
      this.burst.push(chunk);
      this.burstHeld += chunk.length;
      this.trimBurst();
    }
    // A copy of the list: a listener found stalled leaves during the loop.
    for (const listener of [...this.listeners]) {
      listener.deliver(chunk);
    }
  }

  /** Ends every listener's stream and forgets what was kept. */
  closeAll(): void {
    const listeners = this.listeners;
    this.listeners = [];
    this.burst = [];
    this.burstHeld = 0;
    this.last = null;
    for (const listener of listeners) {
      listener.close();
    }
    if (listeners.length) {
      this.onListenersChanged(0);
    }
  }

  get count(): number {
    return this.listeners.length;
  }

  details(): JsonRecord[] {
    return this.listeners.map((listener) => listener.describe());
  }

  private trimBurst(): void {
    while (this.burst.length && this.burstHeld > this.burstBytes) {
      this.burstHeld -= this.burst.shift()!.length;
    }
  }
}

/**
 * The bytes a value stands for on a stream, or null for anything that is not
 * bytes or text: what an endpoint's pass produces is streamed only when it is
 * something to send.
 */
export function streamBytes(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (value && typeof value === "object" && (value as JsonRecord).binary instanceof Uint8Array) {
    const binary = (value as JsonRecord).binary as Uint8Array;
    return Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  }
  return null;
}
