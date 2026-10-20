// Quick check of diagram canvases (scope, schema changes, layout, lines): npm run check:diagram
import assert from "node:assert/strict";
import type { Canvas, TableInfo } from "../types";
import {
  acknowledge,
  addNewTables,
  autoLayout,
  cardRect,
  changesOf,
  describeChanges,
  globMatch,
  indexSchema,
  inScope,
  linesOf,
  linksOf,
  newCanvas,
  parsePatterns,
  placeNew,
  rescope,
  shownTables,
  type Rect,
  type Schema,
} from "./diagram.ts";

/** `name:type[:pk][:fk>schema.table.column]` per column. */
function table(schema: string, name: string, ...cols: string[]): TableInfo {
  return {
    schema,
    name,
    kind: "table",
    columns: cols.map((c) => {
      const [n, type, ...flags] = c.split(":");
      const ref = flags.find((f) => f.startsWith("fk>"))?.slice(3) ?? null;
      return { name: n, dataType: type, nullable: true, primaryKey: flags.includes("pk"), foreignKey: !!ref, references: ref };
    }),
  };
}

const base = [
  table("public", "legal_document", "id:uuid:pk", "slug:text", "title:text", "created_at:timestamptz"),
  table("public", "legal_document_version", "id:uuid:pk", "document_id:uuid:fk>public.legal_document.id", "version:int4"),
  table("public", "legal_document_text", "version_id:uuid:pk:fk>public.legal_document_version.id", "locale:text:pk", "body:text"),
  table("public", "wifi_credential", "id:uuid:pk", "password_enc:bytea"),
  table("public", "wifi_device", "id:uuid:pk", "credential_id:uuid:fk>public.wifi_credential.id", "mac:text"),
  table("public", "category", "id:int4:pk", "parent_id:int4:fk>public.category.id", "name:text"),
  table("mart", "doc_stats", "day:date", "published:int8"),
];
const schema = indexSchema(base);
const with_ = (tables: TableInfo[]): Schema => indexSchema(tables);

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function assertNoOverlap(c: Canvas, s: Schema) {
  const rects = shownTables(c).map((k) => [k, cardRect(k, c, s)] as const);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      assert.ok(!overlaps(rects[i][1], rects[j][1]), `${rects[i][0]} overlaps ${rects[j][0]}`);
}

// Patterns: `*` and `?`, case ignored; with a dot they include the schema.
assert.ok(globMatch("legal_document", "legal_*"));
assert.ok(globMatch("Wifi_Device", "wifi_?evice"));
assert.ok(!globMatch("my_legal_document", "legal_*"));
assert.ok(!globMatch("legalXdocument", "legal.document"), "a dot is a dot, not any character");
assert.deepEqual(parsePatterns(" legal_*, ,*_audit "), ["legal_*", "*_audit"]);
const pattern = (...patterns: string[]) => [...inScope({ kind: "pattern", patterns }, schema)].sort();
assert.deepEqual(pattern("legal_*"), ["public.legal_document", "public.legal_document_text", "public.legal_document_version"]);
assert.deepEqual(pattern("mart.*"), ["mart.doc_stats"]);
assert.deepEqual(pattern("*_stats", "wifi_*"), ["mart.doc_stats", "public.wifi_credential", "public.wifi_device"]);

// Neighbours follow foreign keys both ways, up to the depth.
const near = (root: string, depth: number) => [...inScope({ kind: "neighbours", root, depth }, schema)].sort();
assert.deepEqual(near("public.legal_document_version", 1), [
  "public.legal_document",
  "public.legal_document_text",
  "public.legal_document_version",
]);
assert.deepEqual(near("public.legal_document_text", 1), ["public.legal_document_text", "public.legal_document_version"]);
assert.equal(near("public.legal_document_text", 2).length, 3);
assert.deepEqual(near("public.gone", 2), []);
assert.equal(inScope({ kind: "all" }, schema).size, base.length);

// A new canvas lays out its scope without overlaps and starts with nothing to report.
const legal = newCanvas({ name: " Legal ", scope: { kind: "pattern", patterns: ["legal_*"] }, autoAdd: true }, schema, "c1");
assert.equal(legal.name, "Legal");
assert.equal(Object.keys(legal.positions).length, 3);
assert.equal(changesOf(legal, schema).count, 0);
assertNoOverlap(legal, schema);
// Referenced tables sit left of the tables that reference them.
assert.ok(legal.positions["public.legal_document"].x < legal.positions["public.legal_document_version"].x);
assert.ok(legal.positions["public.legal_document_version"].x < legal.positions["public.legal_document_text"].x);

const picked = newCanvas({ name: "Mine", scope: { kind: "picked" }, autoAdd: true }, schema, "c2");
assert.deepEqual(picked.positions, {}, "you pick the tables after creating it");
assert.equal(picked.autoAdd, false);

const keys = newCanvas({ name: "Keys", scope: { kind: "all" }, autoAdd: true, keysOnly: true }, schema, "c3");
assert.deepEqual(keys.hiddenColumns["public.legal_document"], ["slug", "title", "created_at"]);
assert.deepEqual(keys.hiddenColumns["public.legal_document_text"], ["body"], "both key columns stay");

// The database changes: a column added and one dropped, a matching table added, one dropped, and an
// unrelated table added (outside the pattern, so not this canvas's business).
const changed = with_([
  table("public", "legal_document", "id:uuid:pk", "slug:text", "title:text"),
  table("public", "legal_document_version", "id:uuid:pk", "document_id:uuid:fk>public.legal_document.id", "version:int4", "published_by:text"),
  table("public", "legal_document_deleted", "document_id:uuid:pk:fk>public.legal_document.id", "reason:text"),
  ...base.slice(3),
  table("public", "portal_event", "id:int8:pk"),
]);
const c = changesOf(legal, changed);
assert.deepEqual(c.addedTables, ["public.legal_document_deleted"]);
assert.deepEqual(c.droppedTables, ["public.legal_document_text"]);
assert.deepEqual(c.addedColumns, { "public.legal_document_version": ["published_by"] });
assert.deepEqual(c.droppedColumns, { "public.legal_document": ["created_at"] });
assert.equal(c.count, 4);
const name = (k: string) => k.replace(/^public\./, "");
assert.deepEqual(
  describeChanges(c, name, () => true),
  [
    "legal_document_deleted was added",
    "published_by was added to legal_document_version",
    "created_at was dropped from legal_document",
    "legal_document_text was dropped",
  ],
);
assert.equal(describeChanges(c, name, () => false)[0], "legal_document_deleted is new; tick it in the panel to show it");

// Changes to tables that aren't on the canvas are not its business; new tables in scope are.
const mine = { ...newCanvas({ name: "Mine", scope: { kind: "picked" }, autoAdd: false }, schema, "c6") };
mine.positions = { "public.legal_document": { x: 40, y: 40 } };
const mineChanges = changesOf(acknowledge(mine, schema), changed);
assert.deepEqual(mineChanges.addedTables, ["public.legal_document_deleted", "public.portal_event"]);
assert.deepEqual(mineChanges.droppedTables, [], "legal_document_text was never on it");
assert.deepEqual(mineChanges.addedColumns, {}, "legal_document_version isn't on it");
assert.deepEqual(mineChanges.droppedColumns, { "public.legal_document": ["created_at"] });
const hiddenOne = changesOf({ ...legal, hiddenTables: ["public.legal_document_text"] }, changed);
assert.deepEqual(hiddenOne.droppedTables, [], "a hidden table that is dropped goes quietly");

// With auto-add the new table is placed in free space; without, it waits in the panel.
const grown = addNewTables(legal, changed, c);
assert.ok("public.legal_document_deleted" in grown.positions);
assert.ok(!("public.portal_event" in grown.positions));
assertNoOverlap({ ...grown, positions: Object.fromEntries(Object.entries(grown.positions).filter(([k]) => changed.has(k))) }, changed);
assert.ok(!("public.legal_document_deleted" in addNewTables({ ...legal, autoAdd: false }, changed, c).positions));
// A table the user hid is never put back.
const hid = addNewTables({ ...legal, hiddenTables: ["public.legal_document_deleted"] }, changed, c);
assert.ok(!("public.legal_document_deleted" in hid.positions));

// "Got it" remembers the database as it is now. The dropped table stays as a placeholder until it is
// removed; hidden things that are gone are forgotten.
const seen = acknowledge(
  { ...grown, hiddenColumns: { "public.legal_document": ["created_at", "title"] }, hiddenTables: [] },
  changed,
);
assert.equal(changesOf(seen, changed).count, 0);
assert.ok("public.legal_document_text" in seen.positions, "dropped tables are never removed silently");
assert.deepEqual(seen.hiddenColumns, { "public.legal_document": ["title"] });
const hiddenGone = acknowledge({ ...legal, hiddenTables: ["public.legal_document_text"] }, changed);
assert.ok(!("public.legal_document_text" in hiddenGone.positions) && hiddenGone.hiddenTables.length === 0);

// Lines run from the foreign key row to the referenced row; a hidden column starts at the header.
const links = linksOf(schema);
const shown = new Set(shownTables(legal));
const lines = linesOf(legal, links, shown, schema);
assert.deepEqual(lines.map((l) => l.id).sort(), ["public.legal_document_text.version_id", "public.legal_document_version.document_id"]);
const v = legal.positions["public.legal_document_version"];
assert.ok(lines.find((l) => l.from === "public.legal_document_version")!.d.includes(`,${v.y + 34 + 26 + 13} `));
const hiddenFk = linesOf({ ...legal, hiddenColumns: { "public.legal_document_version": ["document_id"] } }, links, shown, schema);
assert.ok(hiddenFk.find((l) => l.from === "public.legal_document_version")!.d.includes(`,${v.y + 17} `));
const self = newCanvas({ name: "Tree", scope: { kind: "pattern", patterns: ["category"] }, autoAdd: false }, schema, "c4");
const loop = linesOf(self, links, new Set(shownTables(self)), schema)[0];
assert.equal(loop.end.x, self.positions["public.category"].x + 230, "a self reference loops on the right");

// Changing the scope: tables that leave come off, new ones are placed, placeholders stay.
const wifi = rescope(grown, { name: "Wi-Fi", scope: { kind: "pattern", patterns: ["wifi_*"] }, autoAdd: true }, changed);
assert.deepEqual(Object.keys(wifi.positions).sort(), ["public.legal_document_text", "public.wifi_credential", "public.wifi_device"]);
assert.equal(changesOf(wifi, changed).count, 0);
assertNoOverlap({ ...wifi, positions: { "public.wifi_credential": wifi.positions["public.wifi_credential"], "public.wifi_device": wifi.positions["public.wifi_device"] } }, changed);

// Free space never overlaps anything already there.
const spots = placeNew(["public.portal_event", "public.category", "mart.doc_stats"], legal, schema);
assertNoOverlap({ ...legal, positions: { ...legal.positions, ...spots } }, schema);

// Big databases: 400 tables in chains and on their own lay out quickly, without overlaps.
const big: TableInfo[] = [];
for (let i = 0; i < 400; i++) {
  const cols = ["id:int8:pk", "name:text", "created_at:timestamptz"];
  if (i % 3) cols.push(`parent_id:int8:fk>app.t${i - (i % 3)}.id`);
  big.push(table("app", `t${i}`, ...cols));
}
const bigSchema = indexSchema(big);
const started = performance.now();
const whole = newCanvas({ name: "All", scope: { kind: "all" }, autoAdd: true }, bigSchema, "c5");
const ms = performance.now() - started;
assert.equal(Object.keys(whole.positions).length, 400);
assertNoOverlap(whole, bigSchema);
assert.ok(ms < 1000, `layout took ${ms.toFixed(0)} ms`);
const more = placeNew(["app.t1", "app.t2"], { ...whole, positions: autoLayout(["app.t0"], whole, bigSchema) }, bigSchema);
assert.equal(Object.keys(more).length, 2);

console.log("diagram checks passed");
