// Quick check of the SQL helpers (table filters, table queries, saved query names): npm run check:sql
import assert from "node:assert/strict";
import { countSql, defaultSchema, isWrite, queryName, sqlLiteral, tableSql, whereSql, type Filter } from "./sql.ts";

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

// Without a chosen sort, the primary key orders the rows, so pages are stable.
const keyed = { schema: "public", name: "order_items", key: ["order_id", "line"] };
assert.equal(tableSql("postgres", keyed, { page: 1 }), `SELECT * FROM "public"."order_items" ORDER BY "order_id", "line" LIMIT 200 OFFSET 200;`);
assert.equal(
  tableSql("postgres", keyed, { sort: { column: "qty", dir: "asc" } }),
  `SELECT * FROM "public"."order_items" ORDER BY "qty" ASC NULLS LAST LIMIT 200;`,
);

// Pages, and the count of what the filters match.
assert.equal(tableSql("postgres", table, { page: 2 }), `SELECT * FROM "public"."orders" LIMIT 200 OFFSET 400;`);
assert.equal(tableSql("postgres", table, { page: 0 }), `SELECT * FROM "public"."orders" LIMIT 200;`);
assert.equal(
  countSql("mysql", { schema: "shop", name: "orders" }, { filters: [f("status", "eq", "paid")], sort: { column: "id", dir: "asc" }, page: 3 }),
  "SELECT count(*) FROM `shop`.`orders` WHERE `status` = 'paid';",
);

// The schema listed first: public on PostgreSQL, the connection's database on MySQL.
assert.equal(defaultSchema({ engine: "postgres", database: "shop" }), "public");
assert.equal(defaultSchema({ engine: "mysql", database: "shop" }), "shop");

// Names offered when saving a query.
assert.equal(queryName("-- Top customers by revenue\nSELECT 1"), "Top customers by revenue");
assert.equal(queryName("  select *\n  from orders;"), "select *");
assert.equal(queryName("SELECT id, name,\nFROM t"), "SELECT id, name");
assert.equal(queryName("x".repeat(80)).length, 60);

// "Ask before running writes": anything that may change data asks, plain reads don't.
for (const w of [
  "UPDATE t SET a = 1",
  "  -- tidy up\n  delete from t",
  "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
  "EXPLAIN ANALYZE DELETE FROM t",
  "EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1",
  "COPY t FROM STDIN",
  "COPY (SELECT 1) TO PROGRAM 'rm -rf /'",
  "SELECT * INTO archive FROM t",
  "SELECT * FROM t INTO OUTFILE '/tmp/x'",
  "REFRESH MATERIALIZED VIEW mv",
  "LOAD DATA INFILE '/tmp/x' INTO TABLE t",
  "EXECUTE purge(1)",
  "SET PERSIST max_connections = 10",
  "OPTIMIZE TABLE t",
  "LOCK TABLE t",
]) assert.ok(isWrite(w), w);
for (const r of ["SELECT * FROM t", "EXPLAIN SELECT * FROM t", "EXPLAIN ANALYZE SELECT 1", "COPY t TO STDOUT", "WITH x AS (SELECT 1) SELECT * FROM x", "SHOW tables", "SET search_path = app"])
  assert.ok(!isWrite(r), r);

console.log("sql: all checks passed");
