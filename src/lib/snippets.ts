// Short words that expand into whole statements: type `sf` and press Tab for `SELECT * FROM`.
// Each placeholder is a field: type over it, and Tab moves on to the next one.

import { snippet, snippetCompletion, type Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

interface Snippet {
  name: string;
  sql: string;
  /** Begins a statement; the others continue one (`lj` after FROM …). */
  starts: boolean;
}

export const SNIPPETS: Snippet[] = [
  { name: "sf", sql: "SELECT * FROM ${table}", starts: true },
  { name: "sfw", sql: "SELECT * FROM ${table}\nWHERE ${condition}", starts: true },
  { name: "sc", sql: "SELECT count(*) FROM ${table}", starts: true },
  { name: "scg", sql: "SELECT ${column}, count(*)\nFROM ${table}\nGROUP BY ${column}\nORDER BY count(*) DESC", starts: true },
  { name: "sd", sql: "SELECT DISTINCT ${column} FROM ${table}", starts: true },
  { name: "ii", sql: "INSERT INTO ${table} (${columns})\nVALUES (${values})", starts: true },
  { name: "us", sql: "UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition}", starts: true },
  { name: "df", sql: "DELETE FROM ${table}\nWHERE ${condition}", starts: true },
  { name: "cte", sql: "WITH ${name} AS (\n  ${query}\n)\nSELECT * FROM ${name}", starts: true },
  { name: "lj", sql: "LEFT JOIN ${table} ON ${condition}", starts: false },
];

/** The statement with its placeholders as plain words, as shown next to the name. */
export const preview = (s: Snippet) => s.sql.replace(/\$\{(\w*)\}/g, "$1").replace(/\s*\n\s*/g, " ");

/** Snippets that fit here, for the completion popup. `atStart`: nothing but the typed word precedes them in the statement. */
export function snippetOptions(atStart: boolean): Completion[] {
  return SNIPPETS.filter((s) => s.starts === atStart).map((s) =>
    // Ranked above names that merely start with what was typed, below an exact name.
    snippetCompletion(s.sql, { label: s.name, detail: preview(s), type: "text", boost: 0 }),
  );
}

/** Tab right after a snippet's name: expand it. `atStart` as for `snippetOptions`. */
export function expandSnippet(view: EditorView, atStart: boolean): boolean {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const word = /\w+$/.exec(line.text.slice(0, pos - line.from))?.[0];
  const found = word && SNIPPETS.find((s) => s.name === word.toLowerCase() && s.starts === atStart);
  if (!found) return false;
  snippet(found.sql)(view, null, pos - word.length, pos);
  return true;
}
