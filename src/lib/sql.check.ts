// Quick check of the SQL helpers (table filters, table queries, saved query names): npm run check:sql
import assert from "node:assert/strict";
import { queryName, sqlLiteral, tableSql, whereSql, type Filter } from "./sql.ts";

const f = (column: string, op: Filter["op"], value = ""): Filter => ({ column, op, value });
const pg = (...filters: Filter[]) => whereSql("postgres", filters);
const my = (...filters: Filter[]) => whereSql("mysql", filters);

// Comparisons: values are always quoted literals; the server converts them to the column's type.
assert.equal(pg(f("id", "eq", "42")), `"id" = '42'`);
assert.equal(pg(f("total", "ge", "10.5")), `"total" >= '10.5'`);
assert.equal(my(f("id", "ne", "7")), "`id` <> '7'");

// Quotes and backslashes can't break out of the literal, whatever the server settings are.
assert.equal(sqlLiteral("postgres", "O'Brien"), `'O''Brien'`);
assert.equal(sqlLiteral("postgres", "a\\b'"), `E'a\\\\b'''`);
assert.equal(sqlLiteral("mysql", "a\\b'"), `'a\\\\b'''`);

// Text matching ignores case and works on any type; %, _ and ! in the value are literal.
assert.equal(pg(f("name", "contains", "50%_off!")), `"name"::text ILIKE '%50!%!_off!!%' ESCAPE '!'`);
assert.equal(my(f("name", "startsWith", "ab")), "CAST(`name` AS CHAR) LIKE 'ab%' ESCAPE '!'");
assert.equal(pg(f("email", "endsWith", ".example")), `"email"::text ILIKE '%.example' ESCAPE '!'`);
assert.equal(pg(f("email", "notContains", "test")), `"email"::text NOT ILIKE '%test%' ESCAPE '!'`);

// Lists, NULL checks, and quoted column names.
assert.equal(pg(f("id", "in", " 1, 2 ,,3 ")), `"id" IN ('1', '2', '3')`);
assert.equal(my(f("tier", "notIn", "free,pro")), "`tier` NOT IN ('free', 'pro')");
assert.equal(pg(f("note", "isNull", "ignored")), `"note" IS NULL`);
assert.equal(my(f("note", "notNull")), "`note` IS NOT NULL");
assert.equal(pg(f('we"ird', "eq", "x")), `"we""ird" = 'x'`);

// Incomplete rows are skipped; several rows join with AND or OR.
assert.equal(pg(f("id", "eq", ""), f("", "eq", "1"), f("id", "in", " , ")), "");
assert.equal(pg(f("id", "gt", "1"), f("note", "isNull")), `"id" > '1' AND "note" IS NULL`);
assert.equal(whereSql("postgres", [f("id", "eq", "1"), f("id", "eq", "2")], "any"), `"id" = '1' OR "id" = '2'`);

// The table query puts filters before the sort and the row limit.
const table = { schema: "public", name: "orders" };
assert.equal(tableSql("postgres", table), `SELECT * FROM "public"."orders" LIMIT 200;`);
assert.equal(
  tableSql("postgres", table, { filters: [f("status", "eq", "paid")], sort: { column: "total", dir: "desc" } }),
  `SELECT * FROM "public"."orders" WHERE "status" = 'paid' ORDER BY "total" DESC NULLS LAST LIMIT 200;`,
);
assert.equal(
  tableSql("mysql", { schema: "shop", name: "orders" }, { filters: [f("id", "lt", "5")], sort: { column: "id", dir: "asc" } }),
  "SELECT * FROM `shop`.`orders` WHERE `id` < '5' ORDER BY `id` IS NULL, `id` ASC LIMIT 200;",
);

// A hand-written condition replaces the filter rows.
assert.equal(
  tableSql("postgres", table, { where: " created_at > now() - interval '7 days' ", filters: [f("id", "eq", "1")] }),
  `SELECT * FROM "public"."orders" WHERE created_at > now() - interval '7 days' LIMIT 200;`,
);
assert.equal(tableSql("postgres", table, { where: "   " }), `SELECT * FROM "public"."orders" LIMIT 200;`);

// Names offered when saving a query.
assert.equal(queryName("-- Top customers by revenue\nSELECT 1"), "Top customers by revenue");
assert.equal(queryName("  select *\n  from orders;"), "select *");
assert.equal(queryName("SELECT id, name,\nFROM t"), "SELECT id, name");
assert.equal(queryName("x".repeat(80)).length, 60);

console.log("sql: all checks passed");
