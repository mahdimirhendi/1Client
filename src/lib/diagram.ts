// Diagram canvases: which tables a canvas shows, what changed in the database since the user last
// looked, and where tables go. Everything here is a pure function of a canvas and the live schema
// from `introspect()`, so a canvas never holds a copy of the schema. Storage: crates/core/src/diagrams.rs.
// Checked by `npm run check:diagram`.

import type { Canvas, CanvasScope, ColumnInfo, Point, TableInfo } from "../types";

/** Card geometry, shared by the canvas, the lines and the export. */
export const CARD_W = 230;
export const HEAD = 34;
export const ROW = 26;
export const GHOST_H = 118;
export const NOTE_W = 210;
export const NOTE_H = 100;
const GAP_X = 90;
const GAP_Y = 36;
const ORIGIN = 40;

/** Tables by `schema.table`. */
export type Schema = Map<string, TableInfo>;

export const keyOf = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;

export function indexSchema(tables: TableInfo[]): Schema {
  return new Map(tables.map((t) => [keyOf(t), t]));
}

/** `orders` for a table in the default schema (public, or the MySQL database), else `mart.orders`. */
export function displayName(key: string, defaultSchema: string): string {
  return key.startsWith(defaultSchema + ".") ? key.slice(defaultSchema.length + 1) : key;
}

/** Shorter names for the long PostgreSQL types, so they fit on a card. */
export function shortType(type: string): string {
  const t = type.toLowerCase();
  const short: Record<string, string> = {
    "character varying": "varchar",
    character: "char",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "time with time zone": "timetz",
    "time without time zone": "time",
    "double precision": "float8",
    "bit varying": "varbit",
  };
  return short[t] ?? type;
}

// ---------- Relationships ----------

/** A foreign key column and the column it references. */
export interface Link {
  from: string;
  column: string;
  to: string;
  toColumn: string;
}

/** `schema.table` and column of a reference `schema.table.column`. */
export function splitRef(ref: string): { table: string; column: string } | null {
  const first = ref.indexOf(".");
  const last = ref.lastIndexOf(".");
  return first > 0 && last > first ? { table: ref.slice(0, last), column: ref.slice(last + 1) } : null;
}

export function linksOf(schema: Schema): Link[] {
  const out: Link[] = [];
  for (const [key, t] of schema) {
    for (const c of t.columns) {
      const ref = c.foreignKey && c.references ? splitRef(c.references) : null;
      if (ref) out.push({ from: key, column: c.name, to: ref.table, toColumn: ref.column });
    }
  }
  return out;
}

// ---------- Scope ----------

/** `*` matches anything, `?` one character; case is ignored. */
export function globMatch(text: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i").test(text);
}

/** Comma-separated patterns, as typed. */
export const parsePatterns = (text: string) =>
  text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

/** A pattern with a dot (`mart.*`) is matched against `schema.table`, others against the table name. */
export function matchesPatterns(key: string, name: string, patterns: string[]): boolean {
  return patterns.some((p) => globMatch(p.includes(".") ? key : name, p));
}

/**
 * The tables a canvas is about: listed in its panel, and put on it when they are new (with auto-add).
 * For "Tables I pick" that is every table, to pick from.
 */
export function inScope(scope: CanvasScope, schema: Schema): Set<string> {
  switch (scope.kind) {
    case "all":
    case "picked":
      return new Set(schema.keys());
    case "pattern":
      return new Set([...schema].filter(([k, t]) => matchesPatterns(k, t.name, scope.patterns)).map(([k]) => k));
    case "neighbours":
      return neighbours(scope.root, scope.depth, schema);
  }
}

/** A table and the tables up to `depth` foreign keys away, in either direction. */
export function neighbours(root: string, depth: number, schema: Schema): Set<string> {
  if (!schema.has(root)) return new Set();
  const near = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    if (!schema.has(a) || !schema.has(b)) return;
    if (!near.has(a)) near.set(a, new Set());
    near.get(a)!.add(b);
  };
  for (const l of linksOf(schema)) {
    join(l.from, l.to);
    join(l.to, l.from);
  }
  const found = new Set([root]);
  let edge = [root];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const k of edge) for (const n of near.get(k) ?? []) if (!found.has(n)) (found.add(n), next.push(n));
    edge = next;
  }
  return found;
}

/** Short description of a scope for the panel: "Every table", "legal_*", "orders + 1 link". */
export function scopeLabel(scope: CanvasScope, defaultSchema: string): { title: string; chip?: string } {
  switch (scope.kind) {
    case "all":
      return { title: "Every table" };
    case "picked":
      return { title: "Tables I pick" };
    case "pattern":
      return { title: "Tables matching", chip: scope.patterns.join(", ") };
    case "neighbours":
      return {
        title: `Up to ${scope.depth} link${scope.depth > 1 ? "s" : ""} from`,
        chip: displayName(scope.root, defaultSchema),
      };
  }
}

// ---------- Live: what changed since the canvas was last seen ----------

/**
 * What changed that this canvas shows or offers: tables new in its scope (on it, or waiting in its
 * panel), and dropped tables and column changes of the tables on it. Changes to tables that are
 * hidden or were never put on it are not its business.
 */
export interface Changes {
  /** In scope (or on the canvas) and not seen before. */
  addedTables: string[];
  /** On the canvas, and gone from the database. */
  droppedTables: string[];
  /** Of tables on the canvas. */
  addedColumns: Record<string, string[]>;
  droppedColumns: Record<string, string[]>;
  count: number;
}

export const NO_CHANGES: Changes = { addedTables: [], droppedTables: [], addedColumns: {}, droppedColumns: {}, count: 0 };

/** The tables whose names and columns a canvas keeps track of: those in scope and those on it. */
export function tracked(canvas: Canvas, schema: Schema): Set<string> {
  const keys = inScope(canvas.scope, schema);
  for (const k of Object.keys(canvas.positions)) if (schema.has(k)) keys.add(k);
  return keys;
}

export function changesOf(canvas: Canvas, schema: Schema): Changes {
  const seen = canvas.seen;
  const addedTables = [...tracked(canvas, schema)].filter((k) => !(k in seen)).sort();
  const droppedTables: string[] = [];
  const addedColumns: Record<string, string[]> = {};
  const droppedColumns: Record<string, string[]> = {};
  const shown = new Set(shownTables(canvas));
  let count = addedTables.length;
  for (const [key, before] of Object.entries(seen)) {
    if (!shown.has(key)) continue;
    const t = schema.get(key);
    if (!t) {
      droppedTables.push(key);
      count++;
      continue;
    }
    const now = t.columns.map((c) => c.name);
    const added = now.filter((c) => !before.includes(c));
    const dropped = before.filter((c) => !now.includes(c));
    if (added.length) addedColumns[key] = added;
    if (dropped.length) droppedColumns[key] = dropped;
    count += added.length + dropped.length;
  }
  return { addedTables, droppedTables: droppedTables.sort(), addedColumns, droppedColumns, count };
}

/** The changes in a sentence each, for the "Updated from the database" banner. */
export function describeChanges(c: Changes, name: (key: string) => string, onCanvas: (key: string) => boolean): string[] {
  const list = (keys: string[]) => keys.map(name).join(", ");
  const out: string[] = [];
  const placed = c.addedTables.filter(onCanvas);
  const waiting = c.addedTables.filter((k) => !onCanvas(k));
  if (placed.length === 1) out.push(`${name(placed[0])} was added`);
  else if (placed.length) out.push(`${placed.length} tables were added (${list(placed)})`);
  if (waiting.length === 1) out.push(`${name(waiting[0])} is new; tick it in the panel to show it`);
  else if (waiting.length) out.push(`${waiting.length} new tables are listed in the panel (${list(waiting)})`);
  for (const [key, cols] of Object.entries(c.addedColumns)) {
    out.push(cols.length === 1 ? `${cols[0]} was added to ${name(key)}` : `${cols.length} columns were added to ${name(key)}`);
  }
  for (const [key, cols] of Object.entries(c.droppedColumns)) {
    out.push(cols.length === 1 ? `${cols[0]} was dropped from ${name(key)}` : `${cols.length} columns were dropped from ${name(key)}`);
  }
  if (c.droppedTables.length === 1) out.push(`${name(c.droppedTables[0])} was dropped`);
  else if (c.droppedTables.length) out.push(`${c.droppedTables.length} tables were dropped (${list(c.droppedTables)})`);
  return out;
}

/** "Got it": remember the database as it is now, and forget hidden things that no longer exist. */
export function acknowledge(canvas: Canvas, schema: Schema): Canvas {
  const seen: Record<string, string[]> = {};
  for (const k of [...tracked(canvas, schema)].sort()) seen[k] = schema.get(k)!.columns.map((c) => c.name);
  // A dropped table that is hidden goes; one still shown stays as a placeholder until it is removed.
  const goneHidden = canvas.hiddenTables.filter((k) => !schema.has(k));
  const positions = { ...canvas.positions };
  for (const k of goneHidden) delete positions[k];
  const hiddenColumns: Record<string, string[]> = {};
  for (const [key, cols] of Object.entries(canvas.hiddenColumns)) {
    const t = schema.get(key);
    const keep = t ? cols.filter((c) => t.columns.some((x) => x.name === c)) : key in positions ? cols : [];
    if (keep.length) hiddenColumns[key] = keep;
  }
  return { ...canvas, seen, positions, hiddenTables: canvas.hiddenTables.filter((k) => schema.has(k)), hiddenColumns };
}

/** Put tables that are new in the database on the canvas, when the canvas adds them by itself. */
export function addNewTables(canvas: Canvas, schema: Schema, changes: Changes): Canvas {
  if (!canvas.autoAdd || canvas.scope.kind === "picked") return canvas;
  const hidden = new Set(canvas.hiddenTables);
  const add = changes.addedTables.filter((k) => !(k in canvas.positions) && !hidden.has(k));
  return add.length ? { ...canvas, positions: { ...canvas.positions, ...placeNew(add, canvas, schema) } } : canvas;
}

// ---------- Cards ----------

export function visibleColumns(t: TableInfo, hidden: string[] | undefined): ColumnInfo[] {
  return hidden?.length ? t.columns.filter((c) => !hidden.includes(c.name)) : t.columns;
}

/** Header, one row per shown column, and the "N hidden columns" row. */
export function cardHeight(t: TableInfo | undefined, hidden: string[] | undefined): number {
  if (!t) return GHOST_H;
  const shown = visibleColumns(t, hidden).length;
  return HEAD + shown * ROW + (shown < t.columns.length ? ROW : 0);
}

/** Tables on the canvas and not hidden; those missing from the database are dropped placeholders. */
export function shownTables(canvas: Canvas): string[] {
  const hidden = new Set(canvas.hiddenTables);
  return Object.keys(canvas.positions).filter((k) => !hidden.has(k));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cardRect(key: string, canvas: Canvas, schema: Schema): Rect {
  const p = canvas.positions[key];
  return { x: p.x, y: p.y, w: CARD_W, h: cardHeight(schema.get(key), canvas.hiddenColumns[key]) };
}

/** Everything on the canvas: shown tables and notes. */
export function contentBounds(canvas: Canvas, schema: Schema): Rect | null {
  const rects = [
    ...shownTables(canvas).map((k) => cardRect(k, canvas, schema)),
    ...canvas.notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: NOTE_H })),
  ];
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/** Where a line meets a card: the middle of the column's row, or of the header when the column is hidden. */
function anchorY(key: string, column: string, canvas: Canvas, schema: Schema): number {
  const t = schema.get(key);
  const i = t ? visibleColumns(t, canvas.hiddenColumns[key]).findIndex((c) => c.name === column) : -1;
  return canvas.positions[key].y + (i >= 0 ? HEAD + i * ROW + ROW / 2 : HEAD / 2);
}

export interface Line {
  id: string;
  from: string;
  to: string;
  /** SVG path. */
  d: string;
  /** The dot at the referenced end. */
  end: Point;
}

/** A curve from the foreign key column to the column it references, for every link between shown tables. */
export function linesOf(canvas: Canvas, links: Link[], shown: Set<string>, schema: Schema): Line[] {
  const out: Line[] = [];
  for (const l of links) {
    if (!shown.has(l.from) || !shown.has(l.to)) continue;
    const s = canvas.positions[l.from];
    const t = canvas.positions[l.to];
    const y1 = anchorY(l.from, l.column, canvas, schema);
    const y2 = anchorY(l.to, l.toColumn, canvas, schema);
    let d: string;
    let ex: number;
    if (l.from === l.to) {
      // Points at itself (parent_id → id): a loop on the right.
      const x = s.x + CARD_W;
      d = `M${x},${y1} C${x + 48},${y1} ${x + 48},${y2} ${x},${y2}`;
      ex = x;
    } else if (Math.abs(s.x - t.x) < CARD_W) {
      // One above the other: out to the left and back.
      d = `M${s.x},${y1} C${s.x - 52},${y1} ${t.x - 52},${y2} ${t.x},${y2}`;
      ex = t.x;
    } else {
      const right = s.x < t.x;
      const x1 = right ? s.x + CARD_W : s.x;
      const x2 = right ? t.x : t.x + CARD_W;
      const b = Math.max(40, Math.abs(x2 - x1) / 2);
      d = `M${x1},${y1} C${right ? x1 + b : x1 - b},${y1} ${right ? x2 - b : x2 + b},${y2} ${x2},${y2}`;
      ex = x2;
    }
    out.push({ id: `${l.from}.${l.column}`, from: l.from, to: l.to, d, end: { x: ex, y: y2 } });
  }
  return out;
}

// ---------- Placing tables ----------

/**
 * Lay tables out by their foreign keys: tables that are referenced on the left, the tables that
 * reference them to their right. Linked groups are packed in rows; tables without links (and dropped
 * placeholders) go together in one block.
 */
export function autoLayout(keys: string[], canvas: Pick<Canvas, "hiddenColumns">, schema: Schema): Record<string, Point> {
  const height = (k: string) => cardHeight(schema.get(k), canvas.hiddenColumns[k]);
  const set = new Set(keys);
  const parents = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]));
  const children = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]));
  for (const l of linksOf(schema)) {
    if (l.from === l.to || !set.has(l.from) || !set.has(l.to)) continue;
    parents.get(l.from)!.add(l.to);
    children.get(l.to)!.add(l.from);
  }

  // Linked groups.
  const group = new Map<string, number>();
  const groups: string[][] = [];
  for (const k of [...keys].sort()) {
    if (group.has(k)) continue;
    const members: string[] = [];
    const todo = [k];
    group.set(k, groups.length);
    while (todo.length) {
      const n = todo.pop()!;
      members.push(n);
      for (const m of [...parents.get(n)!, ...children.get(n)!]) {
        if (!group.has(m)) (group.set(m, groups.length), todo.push(m));
      }
    }
    groups.push(members);
  }

  // Column of each table: one more than its furthest referenced table (cycles are cut).
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (k: string): number => {
    const known = layer.get(k);
    if (known !== undefined) return known;
    if (visiting.has(k)) return 0;
    visiting.add(k);
    let l = 0;
    for (const p of parents.get(k)!) l = Math.max(l, layerOf(p) + 1);
    visiting.delete(k);
    layer.set(k, l);
    return l;
  };

  const maxColumn = 1500;
  type Block = { w: number; h: number; place: Record<string, Point> };
  const blocks: Block[] = [];
  const loose: string[] = [];
  for (const members of groups) {
    if (members.length === 1) {
      loose.push(members[0]);
      continue;
    }
    const layers: string[][] = [];
    for (const k of members) (layers[layerOf(k)] ??= []).push(k);
    const order = new Map<string, number>();
    const place: Record<string, Point> = {};
    let x = 0;
    let h = 0;
    for (const col of layers.filter(Boolean)) {
      // Under the tables they reference, to keep lines short; the most referenced first in column 0.
      const center = (k: string) => {
        const ps = [...parents.get(k)!].filter((p) => order.has(p));
        return ps.length ? ps.reduce((s, p) => s + order.get(p)!, 0) / ps.length : -children.get(k)!.size;
      };
      col.sort((a, b) => center(a) - center(b) || a.localeCompare(b));
      let y = 0;
      col.forEach((k, i) => {
        const kh = height(k);
        if (y > 0 && y + kh > maxColumn) {
          x += CARD_W + GAP_X / 2;
          y = 0;
        }
        place[k] = { x, y };
        order.set(k, i);
        y += kh + GAP_Y;
        h = Math.max(h, y - GAP_Y);
      });
      x += CARD_W + GAP_X;
    }
    blocks.push({ w: x - GAP_X, h, place });
  }
  blocks.sort((a, b) => b.w * b.h - a.w * a.h);

  // Tables without links: columns of about equal height, by name.
  if (loose.length) {
    loose.sort();
    const cols = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(loose.length / 2))));
    const tops = Array<number>(cols).fill(0);
    const place: Record<string, Point> = {};
    for (const k of loose) {
      const c = tops.indexOf(Math.min(...tops));
      place[k] = { x: c * (CARD_W + GAP_X), y: tops[c] };
      tops[c] += height(k) + GAP_Y;
    }
    blocks.push({ w: cols * (CARD_W + GAP_X) - GAP_X, h: Math.max(...tops) - GAP_Y, place });
  }

  // Pack the blocks in rows.
  const area = blocks.reduce((s, b) => s + (b.w + GAP_X) * (b.h + GAP_Y), 0);
  const rowWidth = Math.max(1800, Math.sqrt(area) * 1.5);
  const out: Record<string, Point> = {};
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + GAP_X;
      rowH = 0;
    }
    for (const [k, p] of Object.entries(b.place)) out[k] = { x: ORIGIN + x + p.x, y: ORIGIN + y + p.y };
    x += b.w + GAP_X * 1.5;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

/**
 * Free spots for tables joining a canvas: the first gap big enough in a column of the existing
 * layout, or a new column to the right of it. Nothing already on the canvas moves.
 */
export function placeNew(keys: string[], canvas: Canvas, schema: Schema): Record<string, Point> {
  const taken: Rect[] = [
    ...Object.keys(canvas.positions).map((k) => cardRect(k, canvas, schema)),
    ...canvas.notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: NOTE_H })),
  ];
  const out: Record<string, Point> = {};
  if (!taken.length) {
    Object.assign(out, autoLayout(keys, canvas, schema));
    return out;
  }
  const left = Math.min(...taken.map((r) => r.x));
  const top = Math.min(...taken.map((r) => r.y));
  const right = Math.max(...taken.map((r) => r.x + r.w));
  const bottom = Math.max(...taken.map((r) => r.y + r.h));
  const step = CARD_W + GAP_X;
  for (const k of keys) {
    const h = cardHeight(schema.get(k), canvas.hiddenColumns[k]);
    let spot: Point | null = null;
    for (let x = left; x <= right + step && !spot; x += step) {
      const inColumn = taken.filter((r) => r.x < x + CARD_W + GAP_X / 2 && r.x + r.w > x - GAP_X / 2).sort((a, b) => a.y - b.y);
      let y = top;
      for (const r of inColumn) {
        if (r.y - GAP_Y >= y + h) break;
        y = Math.max(y, r.y + r.h + GAP_Y);
      }
      // Below the content is fine only in the new column on the right.
      if (y + h <= bottom || x > right) spot = { x, y };
    }
    spot ??= { x: right + GAP_X, y: top };
    out[k] = spot;
    taken.push({ x: spot.x, y: spot.y, w: CARD_W, h });
  }
  return out;
}

/** The free spot nearest to `near` for a box of `w` × `h`, looking outward in 40 px steps; `near` if there is none within `reach`. */
export function freeSpot(near: Point, w: number, h: number, canvas: Canvas, schema: Schema, reach = 800): Point {
  const taken = [
    ...shownTables(canvas).map((k) => cardRect(k, canvas, schema)),
    ...canvas.notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: NOTE_H })),
  ];
  const gap = 16;
  const free = (p: Point) => !taken.some((r) => p.x < r.x + r.w + gap && r.x < p.x + w + gap && p.y < r.y + r.h + gap && r.y < p.y + h + gap);
  const step = 40;
  for (let ring = 0; ring * step <= reach; ring++) {
    const spots: Point[] = [];
    for (let dx = -ring; dx <= ring; dx++)
      for (let dy = -ring; dy <= ring; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) spots.push({ x: near.x + dx * step, y: near.y + dy * step });
    spots.sort((a, b) => Math.hypot(a.x - near.x, a.y - near.y) - Math.hypot(b.x - near.x, b.y - near.y));
    const hit = spots.find(free);
    if (hit) return hit;
  }
  return near;
}

// ---------- New canvases ----------

export interface CanvasSpec {
  name: string;
  scope: CanvasScope;
  autoAdd: boolean;
  /** Start with only key columns shown. */
  keysOnly?: boolean;
}

/** Hide every column that isn't part of a primary or foreign key. */
export function keysOnly(keys: string[], schema: Schema): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of keys) {
    const rest = (schema.get(k)?.columns ?? []).filter((c) => !c.primaryKey && !c.foreignKey).map((c) => c.name);
    if (rest.length) out[k] = rest;
  }
  return out;
}

/** A new canvas with the tables in its scope laid out (none yet for "Tables I pick"). */
export function newCanvas(spec: CanvasSpec, schema: Schema, id: string): Canvas {
  const keys = spec.scope.kind === "picked" ? [] : [...inScope(spec.scope, schema)].sort();
  const hiddenColumns = spec.keysOnly ? keysOnly(keys, schema) : {};
  const base: Canvas = {
    id,
    name: spec.name.trim(),
    scope: spec.scope,
    autoAdd: spec.scope.kind !== "picked" && spec.autoAdd,
    zoom: 1,
    pan: { x: 0, y: 0 },
    positions: autoLayout(keys, { hiddenColumns }, schema),
    hiddenTables: [],
    hiddenColumns,
    notes: [],
    seen: {},
    createdAt: 0,
    updatedAt: 0,
  };
  return acknowledge(base, schema);
}

/**
 * Change what a canvas is about. Tables that leave the scope come off it, tables that join are
 * placed in free space; everything else keeps its place, and dropped placeholders stay.
 */
export function rescope(canvas: Canvas, spec: CanvasSpec, schema: Schema): Canvas {
  const scope = spec.scope;
  const next: Canvas = { ...canvas, name: spec.name.trim(), scope, autoAdd: scope.kind !== "picked" && spec.autoAdd };
  if (scope.kind !== "picked") {
    const keys = inScope(scope, schema);
    const positions: Record<string, Point> = {};
    for (const [k, p] of Object.entries(canvas.positions)) if (keys.has(k) || !schema.has(k)) positions[k] = p;
    next.positions = positions;
    next.hiddenTables = canvas.hiddenTables.filter((k) => k in positions);
    const add = [...keys].filter((k) => !(k in positions)).sort();
    next.positions = { ...positions, ...placeNew(add, next, schema) };
  }
  return acknowledge(next, schema);
}

/** Copy of a canvas under a new name and id. */
export function duplicate(canvas: Canvas, id: string, name: string): Canvas {
  return structuredClone({ ...canvas, id, name, createdAt: 0, updatedAt: 0 });
}
