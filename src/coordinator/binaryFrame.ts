/**
 * How a value that is not JSON crosses a coordinator's connections.
 *
 * The link to a runtime server and the bridge to a browser both carry JSON as
 * text frames. A value holding bytes travels as one **binary** frame instead:
 *
 *   [ 4 bytes: header length, big-endian ][ header: UTF-8 JSON ][ payload ]
 *
 * The header is the message that would have been sent as text, with the value
 * left out and a `binary` field in its place saying what the payload is. The
 * payload is the value's bytes and nothing else.
 *
 * A coordinator reads the header and forwards the payload untouched
 * (`BinaryPayload`). It never interprets the bytes, so it cannot corrupt them,
 * and a new shape is a change to the runtimes that produce and consume it.
 *
 * Three shapes, which are what the runtimes pass between services:
 *
 *   bytes            the payload is the value
 *   floatRingBuffer  the payload is little-endian float32 samples; `id` and
 *                    `ts` are in the header
 *   mixed            an object with bytes in its `binary` field; the header
 *                    carries the rest of the object, the payload those bytes
 *
 * Only what a runtime hands to the next one travels this way — `result` and
 * `processRuntime`. A notification or a log entry is for a person to read.
 */

export type BinaryShape =
  | { kind: "bytes" }
  | { kind: "floatRingBuffer"; id: number; ts: number }
  | { kind: "mixed"; json: Record<string, unknown> };

/** Bytes in transit, with what they are. Opaque to whoever forwards them. */
export class BinaryPayload {
  constructor(
    readonly shape: BinaryShape,
    readonly bytes: Uint8Array,
  ) {}
}

export type BinaryFrame = {
  /** The message, without its value and without `binary`. */
  header: Record<string, unknown>;
  payload: BinaryPayload;
};

const LENGTH_BYTES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readShape(value: unknown): BinaryShape | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "bytes") {
    return { kind: "bytes" };
  }
  if (value.kind === "floatRingBuffer") {
    return {
      kind: "floatRingBuffer",
      id: typeof value.id === "number" ? value.id : 0,
      ts: typeof value.ts === "number" ? value.ts : 0,
    };
  }
  if (value.kind === "mixed") {
    return { kind: "mixed", json: isRecord(value.json) ? value.json : {} };
  }
  return null;
}

export function encodeBinaryFrame(
  header: Record<string, unknown>,
  payload: BinaryPayload,
): Buffer {
  const head = Buffer.from(
    JSON.stringify({ ...header, binary: payload.shape }),
    "utf8",
  );
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(head.length, 0);
  return Buffer.concat([length, head, payload.bytes]);
}

/** Null for a frame that is not one of these; nothing is thrown at a peer. */
export function decodeBinaryFrame(raw: Uint8Array): BinaryFrame | null {
  const frame = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (frame.length < LENGTH_BYTES) {
    return null;
  }
  const headLength = frame.readUInt32BE(0);
  if (frame.length < LENGTH_BYTES + headLength) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      frame.toString("utf8", LENGTH_BYTES, LENGTH_BYTES + headLength),
    );
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { binary, ...header } = parsed;
  const shape = readShape(binary);
  if (!shape) {
    return null;
  }
  return {
    header,
    payload: new BinaryPayload(
      shape,
      frame.subarray(LENGTH_BYTES + headLength),
    ),
  };
}

/** What `ws` hands a message listener, as one buffer. */
export function frameBytes(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  return Buffer.from(raw);
}

// ── A runtime server's own values ───────────────────────────────────────────

const RING_BUFFER_TYPE = "FloatRingBuffer";

/**
 * The payload a pipeline value travels as, or null when it is JSON and
 * travels as text.
 *
 * hkp-node passes bytes between services as a `Uint8Array`, alone or in the
 * `binary` field of an object. It has no ring buffer of its own, so one that
 * arrives is held as `{ type: "FloatRingBuffer", id, ts, binary }` and leaves
 * as a ring buffer again, unchanged, if no service touched it.
 */
export function toBinaryPayload(value: unknown): BinaryPayload | null {
  if (value instanceof Uint8Array) {
    return new BinaryPayload({ kind: "bytes" }, value);
  }
  if (!isRecord(value) || !(value.binary instanceof Uint8Array)) {
    return null;
  }
  const { binary, ...json } = value;
  const keys = Object.keys(json);
  if (
    json.type === RING_BUFFER_TYPE &&
    typeof json.id === "number" &&
    typeof json.ts === "number" &&
    keys.length === 3
  ) {
    return new BinaryPayload(
      { kind: "floatRingBuffer", id: json.id, ts: json.ts },
      binary,
    );
  }
  return new BinaryPayload({ kind: "mixed", json }, binary);
}

/** The pipeline value a payload stands for; see `toBinaryPayload`. */
export function fromBinaryPayload(payload: BinaryPayload): unknown {
  // A copy with its own backing store: the frame it was cut from is the
  // socket's, and a service may keep what it is given.
  const bytes = new Uint8Array(payload.bytes);
  switch (payload.shape.kind) {
    case "bytes":
      return bytes;
    case "floatRingBuffer":
      return {
        type: RING_BUFFER_TYPE,
        id: payload.shape.id,
        ts: payload.shape.ts,
        binary: bytes,
      };
    case "mixed":
      return { ...payload.shape.json, binary: bytes };
  }
}
