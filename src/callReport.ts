/**
 * What a call report says of the value a service was called with, or produced.
 *
 * Every call is bracketed by a pair of reports (`call-process`,
 * `call-process-finished`), and each carries the value — what the flow
 * inspector shows of the call. That value travels wherever the reports do: to
 * every client watching the runtime and, on a deployed board, to its
 * coordinator, whose frame limit drops a message above 64 MiB and closes the
 * connection a little above that. A value that never leaves its runtime would
 * still leave it as a report, once for every service it passes through.
 *
 * So a report carries a value only up to `CALL_REPORT_LIMIT`. Above it, a
 * description takes its place — what it is, how large, and how it begins —
 * which the inspector shows and will not run again. The same limit, and the
 * same description, in every runtime: `call_report.py` in hkp-python,
 * `call_report.h` in hkp-rt, and this file in hkp-node (`src/callReport.ts`)
 * and hkp-frontend (`src/runtime/callReport.ts`), kept identical.
 *
 * Measuring stops once the limit is passed, so a value of a hundred megabytes
 * costs no more to judge than one of five. A size counted only that far is said
 * to be not `exact`.
 */

/** The most a report carries of one value: 5 MiB. */
export const CALL_REPORT_LIMIT = 5 * 1024 * 1024;

/** How much of a value too large to report its description begins with. */
export const PREVIEW_LENGTH = 1024;

/** What stands in a report for a value too large to carry. */
export type TooLarge = {
  __hkpTooLarge: {
    type: "string" | "json" | "binary";
    /** At least this many bytes; all of them when `exact`. */
    bytes: number;
    exact: boolean;
    /** How it begins, as text; none for bytes. */
    preview?: string;
  };
};

/** Whether a reported value is the description of one too large to carry. */
export function isTooLarge(value: unknown): value is TooLarge {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "__hkpTooLarge")
  );
}

/** `value` as a report may carry it: itself, or its description. */
export function reportedValue(
  value: unknown,
  limit: number = CALL_REPORT_LIMIT,
): unknown {
  if (typeof value === "string") {
    const bytes = utf8LengthUpTo(value, limit);
    // A text longer than the limit in characters is not counted in bytes.
    return bytes > limit
      ? tooLarge("string", bytes, value.length <= limit, head(value))
      : value;
  }
  if (isBinary(value)) {
    const bytes = value.byteLength;
    return bytes > limit ? tooLarge("binary", bytes, true) : value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }
  const bytes = sizeUpTo(value, limit);
  return bytes > limit ? tooLarge("json", bytes, false, preview(value)) : value;
}

function tooLarge(
  type: TooLarge["__hkpTooLarge"]["type"],
  bytes: number,
  exact: boolean,
  preview?: string,
): TooLarge {
  return {
    __hkpTooLarge: {
      type,
      bytes,
      exact,
      ...(preview !== undefined ? { preview } : {}),
    },
  };
}

function isBinary(value: unknown): value is ArrayBufferView | ArrayBuffer {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/**
 * Whether `value` is data written as an object literal, rather than an
 * instance of something. Only those are looked inside: an instance may hold a
 * whole graph of references — back to its app, in a cycle — none of which is
 * the value a service passed on.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Counted, and shown, as this much and no more: see `isPlainObject`. */
const OPAQUE_SIZE = 16;

/**
 * The UTF-8 length of `text`, counted no further than `budget`: a text with
 * more characters than that is past it already, whatever they encode to, and
 * is answered with its character count.
 */
function utf8LengthUpTo(text: string, budget: number): number {
  if (text.length > budget) {
    return text.length;
  }
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair: one character of four bytes.
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * What `value` takes as compact JSON, near enough, counted until it passes
 * `budget`. A container's own brackets and commas are counted before what is
 * in it, so a list of a million items is past a small budget without one of
 * them being visited.
 */
function sizeUpTo(value: unknown, budget: number): number {
  let total = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0 && total <= budget) {
    const next = pending.pop();
    if (typeof next === "string") {
      total += utf8LengthUpTo(next, budget - total) + 2;
    } else if (typeof next === "number" || typeof next === "bigint") {
      total += String(next).length;
    } else if (typeof next === "boolean") {
      total += next ? 4 : 5;
    } else if (next === null || next === undefined) {
      total += 4;
    } else if (isBinary(next)) {
      total += next.byteLength;
    } else if (Array.isArray(next)) {
      total += 2 + Math.max(0, next.length - 1);
      if (total > budget) {
        break;
      }
      for (const item of next) {
        pending.push(item);
      }
    } else if (isPlainObject(next)) {
      total += 2;
      for (const key in next) {
        if (!Object.prototype.hasOwnProperty.call(next, key)) {
          continue;
        }
        total += utf8LengthUpTo(key, budget - total) + 4;
        if (total > budget) {
          break;
        }
        pending.push(next[key]);
      }
    } else {
      total += OPAQUE_SIZE;
    }
  }
  return total;
}

/** The beginning of `text`, never ending on half a surrogate pair. */
function head(text: string, length: number = PREVIEW_LENGTH): string {
  if (text.length <= length) {
    return text;
  }
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

/**
 * How `value` begins, as compact JSON of at most `PREVIEW_LENGTH` characters
 * and an ellipsis — written only that far, never the whole of it.
 */
function preview(value: unknown): string {
  let out = "";
  // False once the preview is full: nothing more is written, not even the
  // brackets that would close what was begun.
  const write = (item: unknown): boolean => {
    if (out.length >= PREVIEW_LENGTH) {
      return false;
    }
    if (typeof item === "string") {
      out += JSON.stringify(head(item, PREVIEW_LENGTH - out.length));
    } else if (isBinary(item)) {
      out += `"<${item.byteLength} bytes>"`;
    } else if (Array.isArray(item)) {
      out += "[";
      for (let i = 0; i < item.length; i++) {
        if (i > 0) {
          out += ",";
        }
        if (!write(item[i])) {
          return false;
        }
      }
      out += "]";
    } else if (isPlainObject(item)) {
      out += "{";
      let first = true;
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) {
          continue;
        }
        out += `${first ? "" : ","}${JSON.stringify(key)}:`;
        first = false;
        if (!write(item[key])) {
          return false;
        }
      }
      out += "}";
    } else if (item !== null && typeof item === "object") {
      out += `"<${item.constructor?.name ?? "object"}>"`;
    } else {
      out += JSON.stringify(item) ?? "null";
    }
    return out.length < PREVIEW_LENGTH;
  };
  const complete = write(value);
  return complete ? out : `${head(out)}…`;
}
