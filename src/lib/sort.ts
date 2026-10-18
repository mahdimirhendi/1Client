import type { ResultSet } from "../types";

export type SortDir = "asc" | "desc";

/** Type names the grid treats as numbers (right-aligned, sorted numerically). */
export const NUMERIC_TYPE = /^(int|integer|bigint|smallint|tinyint|mediumint|int2|int4|int8|numeric|decimal|float|float4|float8|double|real|money|oid|year)\b/;
const DATE_TYPE = /^(date|datetime|timestamp|timestamptz)/;
const TIME_TYPE = /^(time|timetz)/;
const BOOL_TYPE = /^(bool|boolean)$/;

type Kind = "number" | "date" | "time" | "bool" | "text";

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
// 2026-03-09, 2026-03-09 14:05:07, 2026-03-09T14:05:07.123+01, ...Z, ...-05:30
const DATE_TIME =
  /^(\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
// 14:05:07, -26:03:04.5 (MySQL TIME can exceed 24 h), 14:05:07+02
const TIME = /^(-)?(\d+):(\d{2})(?::(\d{2})(\.\d+)?)?([+-]\d{2}(?::?\d{2})?)?$/;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** How a column sorts: from the server's type name, or from its values when there is none. */
function kindOf(set: ResultSet, col: number): Kind {
  const t = (set.columns[col]?.typeName ?? "").toLowerCase();
  if (t) {
    if (BOOL_TYPE.test(t)) return "bool";
    if (NUMERIC_TYPE.test(t)) return "number";
    if (DATE_TYPE.test(t)) return "date";
    if (TIME_TYPE.test(t)) return "time";
    return "text";
  }
  const sample = set.rows.slice(0, 200).map((r) => r[col]).filter((v): v is string => v !== null);
  if (sample.length && sample.every((v) => DECIMAL.test(v))) return "number";
  if (sample.length && sample.every((v) => DATE_TIME.test(v))) return "date";
  return "text";
}

function offsetMinutes(tz: string | undefined): number {
  if (!tz || tz.toUpperCase() === "Z") return 0;
  const sign = tz.startsWith("-") ? -1 : 1;
  const digits = tz.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
}

/** Milliseconds since 1970 UTC, or null when the text is not a date the servers print. */
function dateKey(v: string): number | null {
  const lower = v.trim().toLowerCase();
  if (lower === "infinity") return Infinity;
  if (lower === "-infinity") return -Infinity;
  const m = DATE_TIME.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", tz] = m;
  const date = new Date(Date.UTC(2000, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  date.setUTCFullYear(Number(y));
  return date.getTime() + Number(`0${frac}`) * 1000 - offsetMinutes(tz) * 60_000;
}

/** Seconds, or null. */
function timeKey(v: string): number | null {
  const m = TIME.exec(v.trim());
  if (!m) return null;
  const [, neg, h, mi, s = "0", frac = "", tz] = m;
  const secs = Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(`0${frac}`) - offsetMinutes(tz) * 60;
  return neg ? -secs : secs;
}

/** Integers compare exactly as bigint (int8 can exceed 2^53); decimals as numbers. */
function numberKey(v: string): number | bigint | null {
  const s = v.trim();
  if (INTEGER.test(s)) return BigInt(s);
  return DECIMAL.test(s) ? Number(s) : null;
}

function boolKey(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (s === "t" || s === "true" || s === "1") return 1;
  if (s === "f" || s === "false" || s === "0") return 0;
  return null;
}

/** 0: a typed value, 1: text that didn't parse as the column's type, 2: NULL. */
type Key = { rank: 0 | 1 | 2; v: number | bigint | string };

function keyOf(kind: Kind, v: string | null): Key {
  if (v === null) return { rank: 2, v: "" };
  const typed =
    kind === "number" ? numberKey(v) : kind === "date" ? dateKey(v) : kind === "time" ? timeKey(v) : kind === "bool" ? boolKey(v) : null;
  if (typed !== null) return { rank: 0, v: typed };
  return { rank: kind === "text" ? 0 : 1, v };
}

function compareValues(a: Key["v"], b: Key["v"]): number {
  if (typeof a === "string" && typeof b === "string") return collator.compare(a, b);
  if (typeof a === "string" || typeof b === "string") return typeof a === "string" ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Row indexes of `set` ordered by one column. Numbers, dates, times and booleans compare by
 * value, text alphabetically with numbers in it compared as numbers ("item2" before "item10").
 * NULLs always come last, and equal values keep their original order.
 */
export function sortedRows(set: ResultSet, col: number, dir: SortDir): number[] {
  const kind = kindOf(set, col);
  const keys = set.rows.map((row) => keyOf(kind, row[col]));
  const sign = dir === "asc" ? 1 : -1;
  return set.rows
    .map((_, i) => i)
    .sort((a, b) => {
      const ka = keys[a];
      const kb = keys[b];
      if (ka.rank !== kb.rank) return ka.rank - kb.rank;
      if (ka.rank === 2) return 0;
      return sign * compareValues(ka.v, kb.v);
    });
}
