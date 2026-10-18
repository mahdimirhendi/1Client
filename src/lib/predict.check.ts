// Quick check of the SQL predictor: npm run check:predict
import assert from "node:assert/strict";
import { predict } from "./predict.ts";

const col = (name: string, dataType = "int8", extra: object = {}) => ({
  name, dataType, nullable: true, primaryKey: false, foreignKey: false, references: null, ...extra,
});
const schema = [
  { schema: "public", name: "customers", kind: "table", columns: [col("id", "int8", { primaryKey: true }), col("name", "text")] },
  { schema: "public", name: "orders", kind: "table", columns: [col("id", "int8", { primaryKey: true }), col("customer_id", "int8", { foreignKey: true, references: "public.customers.id" }), col("status", "text"), col("total", "numeric")] },
] as const;

const first = (sql: string) => predict(sql, sql, schema as never).suggestions[0]?.text;
assert.equal(first(""), "SELECT");
assert.equal(first("SELECT * FROM "), "customers");
assert.equal(first("SELECT * FROM orders o "), "WHERE");
assert.equal(first("SELECT * FROM orders o JOIN customers c "), "ON o.customer_id = c.id");
assert.equal(first("SELECT * FROM orders WHERE status "), "= ");
assert.equal(first("SELECT * FROM orders ORDER BY total "), "DESC");
assert.equal(first("UPDATE orders "), "SET");
assert.equal(first("INSERT INTO orders "), "(customer_id, status, total) VALUES (");
assert.equal(first("SELECT * FROM orders o WHERE o.st"), "o.status");
assert.equal(first("SELECT * FROM orders whe"), "WHERE");
console.log("predict: all checks passed");
