// Quick check of result sorting: npm run check:sort
import assert from "node:assert/strict";
import { sortedRows } from "./sort.ts";

const set = (typeName: string | null, values: (string | null)[]) => ({
  columns: [{ name: "v", typeName }],
  rows: values.map((v) => [v]),
  rowCount: values.length,
  truncated: false,
});
const sorted = (typeName: string | null, values: (string | null)[], dir: "asc" | "desc" = "asc") =>
  sortedRows(set(typeName, values), 0, dir).map((i) => values[i]);

// Numbers by value, not as text; int8 beyond 2^53 stays exact; NULL last both ways.
assert.deepEqual(sorted("int8", ["10", "9", null, "-3", "100"]), ["-3", "9", "10", "100", null]);
assert.deepEqual(sorted("int8", ["9007199254740993", "9007199254740992"]), ["9007199254740992", "9007199254740993"]);
assert.deepEqual(sorted("numeric", ["2.5", "10.25", "-1"], "desc"), ["10.25", "2.5", "-1"]);
assert.deepEqual(sorted("numeric", ["1", null, "3"], "desc"), ["3", "1", null]);

// Text alphabetically, ignoring case, with numbers inside compared as numbers.
assert.deepEqual(sorted("text", ["banana", "Apple", "cherry", "apple"]), ["Apple", "apple", "banana", "cherry"]);
assert.deepEqual(sorted("varchar", ["item10", "item2", "item1"]), ["item1", "item2", "item10"]);

// Dates and timestamps in time order, time zones included (as Postgres and MySQL print them).
assert.deepEqual(sorted("date", ["2026-03-09", "2025-12-31", "2026-01-15"]), ["2025-12-31", "2026-01-15", "2026-03-09"]);
assert.deepEqual(
  sorted("timestamptz", ["2026-03-29 03:30:00+02", "2026-03-29 02:00:00+00", "infinity", "2026-03-29 01:45:00+00"]),
  ["2026-03-29 03:30:00+02", "2026-03-29 01:45:00+00", "2026-03-29 02:00:00+00", "infinity"],
);
assert.deepEqual(sorted("datetime", ["2026-01-02 10:00:00.5", "2026-01-02 10:00:00", "2026-01-02 09:59:59"], "desc"), [
  "2026-01-02 10:00:00.5",
  "2026-01-02 10:00:00",
  "2026-01-02 09:59:59",
]);
assert.deepEqual(sorted("time", ["-26:03:04", "10:00:00", "09:30:00"]), ["-26:03:04", "09:30:00", "10:00:00"]);

// Booleans, and values that don't parse as the column's type go after the ones that do.
assert.deepEqual(sorted("bool", ["t", "f", null, "t"]), ["f", "t", "t", null]);
assert.deepEqual(sorted("money", ["$5.00", "3", "1"]), ["1", "3", "$5.00"]);

// No type name (multi-statement results): the values decide.
assert.deepEqual(sorted(null, ["10", "9", "100"]), ["9", "10", "100"]);
assert.deepEqual(sorted(null, ["b", "a", "10"]), ["10", "a", "b"]);

// Equal values keep their original order.
const pairs = set("text", ["b", "a", "b", "a"]);
assert.deepEqual(sortedRows(pairs, 0, "asc"), [1, 3, 0, 2]);

console.log("sort: all checks passed");
