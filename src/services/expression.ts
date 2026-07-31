/**
 * Expression evaluation for services that let a board author write small
 * dynamic terms — a Map template's `key=` rows, for example.
 *
 * An expression is a single JavaScript expression evaluated with the incoming
 * data bound to `params` and the helper functions below in scope. The browser
 * runtime evaluates the same sources (through expression-eval), so the helper
 * set is kept aligned: a template authored in the shared Map UI behaves the
 * same whichever runtime hosts the service. Helpers that need a browser (DOM,
 * vault, AudioContext) have no counterpart here and are left out.
 */
import { randomUUID } from "node:crypto";

export type CompiledExpression = (params: unknown) => unknown;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Format tokens understood by formatDate/parseDate, longest first so that
// e.g. "MMMM" is matched before "MM".
const TOKEN_PATTERN =
  /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function formatDate(date: Date, format: string): string {
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return format.replace(TOKEN_PATTERN, (token, escaped?: string) => {
    if (escaped !== undefined) {
      return escaped;
    }

    const hours12 = date.getHours() % 12 || 12;
    switch (token) {
      case "YYYY":
        return String(date.getFullYear());
      case "YY":
        return pad(date.getFullYear() % 100);
      case "MMMM":
        return MONTHS[date.getMonth()];
      case "MMM":
        return MONTHS[date.getMonth()].slice(0, 3);
      case "MM":
        return pad(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "DD":
        return pad(date.getDate());
      case "D":
        return String(date.getDate());
      case "dddd":
        return WEEKDAYS[date.getDay()];
      case "ddd":
        return WEEKDAYS[date.getDay()].slice(0, 3);
      case "HH":
        return pad(date.getHours());
      case "H":
        return String(date.getHours());
      case "hh":
        return pad(hours12);
      case "h":
        return String(hours12);
      case "mm":
        return pad(date.getMinutes());
      case "m":
        return String(date.getMinutes());
      case "ss":
        return pad(date.getSeconds());
      case "s":
        return String(date.getSeconds());
      case "A":
        return date.getHours() < 12 ? "AM" : "PM";
      case "a":
        return date.getHours() < 12 ? "am" : "pm";
      default:
        return token;
    }
  });
}

// Reads `value` according to the same token subset formatDate writes. Falls
// back to Date's own parsing (ISO strings, epoch millis) when the format
// describes nothing this understands.
function parseDate(value: string, format: string): Date {
  const captured: string[] = [];
  let pattern = "";
  let lastIndex = 0;

  const escapeLiteral = (text: string) =>
    text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const match of format.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    pattern += escapeLiteral(format.slice(lastIndex, start));
    lastIndex = start + match[0].length;

    if (match[1] !== undefined) {
      pattern += escapeLiteral(match[1]);
      continue;
    }

    const token = match[0];
    captured.push(token);
    switch (token) {
      case "YYYY":
        pattern += "(\\d{4})";
        break;
      case "MMMM":
      case "MMM":
      case "dddd":
      case "ddd":
        pattern += "([A-Za-z]+)";
        break;
      case "A":
      case "a":
        pattern += "([AaPp][Mm])";
        break;
      default:
        pattern += "(\\d{1,2})";
        break;
    }
  }
  pattern += escapeLiteral(format.slice(lastIndex));

  if (captured.length === 0) {
    return new Date(value);
  }

  const match = new RegExp(`^${pattern}$`).exec(String(value).trim());
  if (!match) {
    return new Date(value);
  }

  const parts = {
    year: 1970,
    month: 0,
    day: 1,
    hours: 0,
    minutes: 0,
    seconds: 0,
    pm: false,
    hours12: false,
  };

  captured.forEach((token, idx) => {
    const raw = match[idx + 1];
    switch (token) {
      case "YYYY":
        parts.year = Number(raw);
        break;
      case "YY":
        parts.year = 2000 + Number(raw);
        break;
      case "MMMM":
      case "MMM": {
        const month = MONTHS.findIndex((name) =>
          name.toLowerCase().startsWith(raw.toLowerCase()),
        );
        if (month >= 0) {
          parts.month = month;
        }
        break;
      }
      case "MM":
      case "M":
        parts.month = Number(raw) - 1;
        break;
      case "DD":
      case "D":
        parts.day = Number(raw);
        break;
      case "HH":
      case "H":
        parts.hours = Number(raw);
        break;
      case "hh":
      case "h":
        parts.hours = Number(raw);
        parts.hours12 = true;
        break;
      case "mm":
      case "m":
        parts.minutes = Number(raw);
        break;
      case "ss":
      case "s":
        parts.seconds = Number(raw);
        break;
      case "A":
      case "a":
        parts.pm = raw.toLowerCase() === "pm";
        break;
      default:
        break;
    }
  });

  if (parts.hours12) {
    parts.hours = (parts.hours % 12) + (parts.pm ? 12 : 0);
  }

  return new Date(
    parts.year,
    parts.month,
    parts.day,
    parts.hours,
    parts.minutes,
    parts.seconds,
  );
}

function uuidV7(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }

  const timestamp = Date.now();
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A predicate for find/filter is itself an expression string. It is compiled
// once per call and evaluated per element with `item`/`index` in scope, since
// the expression dialect has no lambdas.
function itemPredicate(predicate: string) {
  const evaluate = new Function(
    ...GLOBAL_NAMES,
    "item",
    "index",
    `"use strict"; return (${predicate});`,
  ) as (...args: unknown[]) => unknown;

  return (item: unknown, index: number) =>
    !!evaluate(...GLOBAL_VALUES, item, index);
}

export const globalScope: Record<string, unknown> = {
  print: console.log,
  log: console.log,
  round: Math.round,
  sin: Math.sin,
  min: Math.min,
  max: Math.max,
  rand: Math.random,
  number: (x: string | number) => Number(x),
  string: (x: number | string) => `${x}`,
  stringify: JSON.stringify,
  parse: (x: string | undefined) =>
    x !== undefined ? JSON.parse(x) : "<parse undefined>",
  concat: (...args: string[]) => args.join(""),
  reformatDate: (date: string, inputFormat: string, outputFormat: string) =>
    formatDate(parseDate(date, inputFormat), outputFormat),
  formatNow: (format: string) => formatDate(new Date(), format),
  find: (arr: unknown, predicate: string) =>
    Array.isArray(arr) ? arr.find(itemPredicate(predicate)) : undefined,
  filter: (arr: unknown, predicate: string) =>
    Array.isArray(arr) ? arr.filter(itemPredicate(predicate)) : [],
  isFuture: (ts: string | number | null | undefined) =>
    ts != null && new Date(ts).getTime() >= Date.now(),
  isPast: (ts: string | number | null | undefined) =>
    ts != null && new Date(ts).getTime() < Date.now(),
  encodeURI,
  slice: (arr: unknown[], offset: number, step: number, end: number) =>
    arr.slice(offset, end).filter((_, i) => i % step === 0),
  sum: (x: number[]) => (x && x.reduce ? x.reduce((acc, v) => acc + v, 0) : x),
  flatSum: (x: unknown[]) =>
    x && x.flat
      ? (x.flat() as number[]).reduce((acc: number, v: number) => acc + v, 0)
      : 0,
  at: (arr: unknown[], i: number) => arr[Math.abs(Math.round(i)) % arr.length],
  now: () => Date.now(),
  range: (n: number) =>
    Array.from({ length: Math.max(0, Math.round(n)) }, (_, i) => i),
  avg: (x: number[]) =>
    x && x.reduce ? x.reduce((acc, v) => acc + v, 0) / x.length : x,
  slug: (x: string | number) =>
    String(x)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, ""),
  uuid: {
    v4: randomUUID,
    v7: uuidV7,
  },
};

const GLOBAL_NAMES = Object.keys(globalScope);
const GLOBAL_VALUES = GLOBAL_NAMES.map((name) => globalScope[name]);

/**
 * Compiles an expression source into a callable. Non-string sources are
 * constants and are returned as-is; a source that does not parse throws when
 * called, so the caller decides how a broken term is reported.
 */
export function compileExpression(source: unknown): CompiledExpression {
  if (typeof source !== "string") {
    return () => source;
  }

  let evaluate: (...args: unknown[]) => unknown;
  try {
    evaluate = new Function(
      ...GLOBAL_NAMES,
      "params",
      `"use strict"; return (${source});`,
    ) as (...args: unknown[]) => unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return () => {
      throw new Error(`invalid expression '${source}': ${message}`);
    };
  }

  return (params: unknown) => evaluate(...GLOBAL_VALUES, params);
}
