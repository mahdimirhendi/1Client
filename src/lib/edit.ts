import type { ConnectionProfile, ResultSet, RowEdit, TableInfo } from "../types";

/** Whether a result column can be edited, and how to find its row. */
export interface ColumnEdit {
  /** Set when the column can't be edited: shown to the user. */
  reason?: string;
  schema: string;
  table: string;
  column: string;
  nullable: boolean;
  /** Result column indexes of the table's primary key, in key order. */
  key: number[];
  keyNames: string[];
}

/**
 * Work out which columns of a result can be edited. A column is editable when the server
 * says which table column it comes from, that table is known, has a primary key, and every
 * key column is also in the result (so each row can be found again).
 */
export function editableColumns(set: ResultSet, schema: TableInfo[] | undefined, profile: ConnectionProfile): ColumnEdit[] {
  return set.columns.map((c) => {
    const base = { schema: "", table: "", column: c.name, nullable: true, key: [], keyNames: [] };
    if (profile.readOnly) return { ...base, reason: "This connection is read-only. Turn off “Read-only session” in its settings to edit." };
    const src = c.source;
    if (!src) return { ...base, reason: `“${c.name}” is calculated or comes from a view, so it can't be edited.` };
    const where = { ...base, schema: src.schema, table: src.table, column: src.column };
    const table = schema?.find((t) => t.name === src.table && t.schema === src.schema);
    if (!table) return { ...where, reason: `Table ${src.table} isn't in the loaded schema yet. Refresh the sidebar and try again.` };
    const info = table.columns.find((x) => x.name === src.column);
    const pk = table.columns.filter((x) => x.primaryKey).map((x) => x.name);
    if (pk.length === 0) return { ...where, reason: `${src.table} has no primary key, so its rows can't be found again to save changes.` };
    const key = pk.map((name) =>
      set.columns.findIndex((rc) => rc.source?.table === src.table && rc.source.schema === src.schema && rc.source.column === name),
    );
    const missing = pk.filter((_, i) => key[i] < 0);
    if (missing.length) return { ...where, reason: `Add ${missing.join(", ")} (the primary key of ${src.table}) to the query to edit it.` };
    return { ...where, nullable: info?.nullable ?? true, key, keyNames: pk };
  });
}

/** "row:col" → new value. */
export type Changes = Map<string, string | null>;
export const cellKey = (r: number, c: number) => `${r}:${c}`;

/** One UPDATE per row and table, keyed by the row's current primary key values. */
export function buildRowEdits(set: ResultSet, cols: ColumnEdit[], changes: Changes): RowEdit[] {
  const byRow = new Map<string, RowEdit>();
  for (const [k, value] of changes) {
    const [r, c] = k.split(":").map(Number);
    const col = cols[c];
    if (col.reason) continue;
    const id = `${r}|${col.schema}|${col.table}`;
    let e = byRow.get(id);
    if (!e) {
      e = {
        schema: col.schema,
        table: col.table,
        key: col.key.map((ki, i) => ({ column: col.keyNames[i], value: set.rows[r][ki] })),
        values: [],
      };
      byRow.set(id, e);
    }
    e.values.push({ column: col.column, value });
  }
  return [...byRow.values()];
}
