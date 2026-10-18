// Guess what comes next in a SQL statement, from the text before the cursor and the schema.
// Used for the gray inline suggestion (Tab accepts) and for context-aware completions.
//
// It is rule-based on purpose: fast, predictable, and it knows your tables, columns and
// foreign keys, so after `JOIN customers c` it suggests `ON o.customer_id = c.id`.

import type { TableInfo } from "../types";

export type SuggestionType = "keyword" | "table" | "column" | "join" | "snippet" | "value";

export interface Suggestion {
  /** Text inserted (for a partial word, the whole word; the caller replaces the typed prefix). */
  text: string;
  type: SuggestionType;
  detail?: string;
}

export interface Prediction {
  /** The partially typed word at the cursor ("" at a word boundary). */
  prefix: string;
  suggestions: Suggestion[];
}

interface Token {
  text: string;
  up: string;
  kind: "word" | "string" | "number" | "punct";
}

interface TableRef {
  table: TableInfo;
  alias?: string;
}

const TOKEN =
  /\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|[A-Za-z_][\w$]*(?:\.(?:[A-Za-z_][\w$]*|\*)?)*|\d+(?:\.\d+)?|[(),;=<>!*+\-/.%|]+|./g;

const RESERVED = new Set(
  `SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL ON USING GROUP ORDER BY HAVING LIMIT OFFSET
   UNION ALL EXCEPT INTERSECT AS AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS SET VALUES INTO INSERT UPDATE
   DELETE RETURNING WITH DISTINCT CASE WHEN THEN ELSE END ASC DESC TABLE CREATE ALTER DROP`.split(/\s+/),
);

const JOIN_WORDS = new Set(["JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "NATURAL"]);
const START = ["SELECT", "INSERT INTO", "UPDATE", "DELETE FROM", "WITH"];
const AFTER_FROM = ["WHERE", "JOIN", "LEFT JOIN", "ORDER BY", "GROUP BY", "LIMIT"];
const AFTER_CONDITION = ["AND", "OR", "ORDER BY", "GROUP BY", "LIMIT"];
const OPERATORS = ["= ", "IS NULL", "IS NOT NULL", "IN (", "LIKE '", "<> ", "> ", "< "];

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    if (/^\s/.test(t) || t.startsWith("--") || t.startsWith("/*")) continue;
    const kind = /^['"`]/.test(t)
      ? t.startsWith("'")
        ? "string"
        : "word"
      : /^\d/.test(t)
        ? "number"
        : /^[A-Za-z_]/.test(t)
          ? "word"
          : "punct";
    out.push({ text: t, up: t.toUpperCase(), kind });
  }
  return out;
}

const unquote = (s: string) => s.replace(/^[`"]|[`"]$/g, "");

function findTable(name: string, schema: TableInfo[]): TableInfo | undefined {
  const parts = unquote(name).split(".").map(unquote);
  const tbl = parts[parts.length - 1].toLowerCase();
  const sch = parts.length > 1 ? parts[0].toLowerCase() : null;
  return schema.find((t) => t.name.toLowerCase() === tbl && (!sch || t.schema.toLowerCase() === sch));
}

/** Tables named in the statement after FROM / JOIN / UPDATE / INTO, with their aliases. */
function tableRefs(tokens: Token[], schema: TableInfo[]): TableRef[] {
  const refs: TableRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const opensList = t.up === "FROM" || t.up === "JOIN" || t.up === "UPDATE" || t.up === "INTO";
    if (!opensList) continue;
    let j = i + 1;
    // FROM a x, b y
    while (j < tokens.length && tokens[j].kind === "word" && !RESERVED.has(tokens[j].up)) {
      const table = findTable(tokens[j].text, schema);
      let alias: string | undefined;
      let k = j + 1;
      if (tokens[k]?.up === "AS") k++;
      if (tokens[k]?.kind === "word" && !RESERVED.has(tokens[k].up)) {
        alias = unquote(tokens[k].text);
        k++;
      }
      if (table) refs.push({ table, alias });
      if (t.up === "FROM" && tokens[k]?.text === ",") j = k + 1;
      else break;
    }
  }
  return refs;
}

const refName = (r: TableRef) => r.alias ?? r.table.name;

function columnsOf(refs: TableRef[], qualify: boolean): Suggestion[] {
  const out: Suggestion[] = [];
  for (const r of refs) {
    for (const c of r.table.columns) {
      out.push({ text: qualify ? `${refName(r)}.${c.name}` : c.name, type: "column", detail: c.dataType });
    }
  }
  return out;
}

const singular = (s: string) =>
  s.endsWith("ies") ? s.slice(0, -3) + "y" : s.endsWith("sses") || s.endsWith("xes") ? s.slice(0, -2) : s.endsWith("s") ? s.slice(0, -1) : s;

/** Join conditions between the newly joined table and the ones before it, from foreign keys (or `<table>_id` naming). */
function joinConditions(joined: TableRef, others: TableRef[]): string[] {
  const conds: string[] = [];
  const a = refName(joined);
  const refersTo = (from: TableInfo, to: TableInfo) =>
    from.columns.flatMap((c) => {
      if (c.references) {
        const [, rt, rc] = c.references.split(".");
        if (rt === to.name) return [{ col: c.name, target: rc }];
        return [];
      }
      if (c.name.toLowerCase() === `${singular(to.name).toLowerCase()}_id`) {
        const pk = to.columns.find((x) => x.primaryKey)?.name ?? "id";
        return [{ col: c.name, target: pk }];
      }
      return [];
    });
  for (const o of others) {
    if (o === joined) continue;
    const b = refName(o);
    for (const r of refersTo(joined.table, o.table)) conds.push(`${a}.${r.col} = ${b}.${r.target}`);
    for (const r of refersTo(o.table, joined.table)) conds.push(`${b}.${r.col} = ${a}.${r.target}`);
  }
  return conds;
}

/** Tables related by a foreign key to any already in the statement come first. */
function rankTables(schema: TableInfo[], present: TableRef[]): Suggestion[] {
  const related = new Set<string>();
  for (const p of present) {
    for (const c of p.table.columns) if (c.references) related.add(c.references.split(".")[1]);
    for (const t of schema) {
      if (t.columns.some((c) => c.references?.split(".")[1] === p.table.name)) related.add(t.name);
    }
  }
  return [...schema]
    .sort((x, y) => Number(related.has(y.name)) - Number(related.has(x.name)) || x.name.localeCompare(y.name))
    .map((t) => ({ text: t.name, type: "table" as const, detail: related.has(t.name) ? "related" : t.kind }));
}

const kw = (words: string[]): Suggestion[] => words.map((w) => ({ text: w, type: "keyword" as const }));

/** Clause the cursor is in, from the last clause keyword before it. */
function clauseOf(tokens: Token[]): string {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const u = tokens[i].up;
    if (u === "BY" && (tokens[i - 1]?.up === "ORDER" || tokens[i - 1]?.up === "GROUP")) return `${tokens[i - 1].up} BY`;
    if (["SELECT", "FROM", "WHERE", "ON", "HAVING", "LIMIT", "SET", "VALUES", "UPDATE", "INTO", "DELETE"].includes(u)) return u;
    if (JOIN_WORDS.has(u)) return "JOIN";
  }
  return "";
}

/**
 * Suggestions for the cursor position. `before` is the statement text up to the cursor,
 * `whole` the full statement (tables named after the cursor still count).
 */
export function predict(before: string, whole: string, schema: TableInfo[]): Prediction {
  const partial = /[\w$.]+$/.exec(before)?.[0] ?? "";
  const atBoundary = partial === "";
  const tokens = tokenize(atBoundary ? before : before.slice(0, before.length - partial.length));
  const refs = tableRefs(tokenize(whole), schema);
  const qualify = refs.length > 1;
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  const clause = clauseOf(tokens);
  const lastIsName = last?.kind === "word" && !RESERVED.has(last.up);

  let s: Suggestion[] = [];

  if (!last) s = kw(START);
  else if (clause === "SELECT") {
    if (last.up === "SELECT" || last.up === "DISTINCT" || last.text === ",")
      s = [...(last.up === "SELECT" ? kw(["*", "DISTINCT"]) : []), ...columnsOf(refs, qualify)];
    else s = kw(["FROM", "AS"]);
  } else if (["FROM", "JOIN", "UPDATE", "INTO"].includes(last.up) || (JOIN_WORDS.has(last.up) && last.up !== "JOIN")) {
    s = JOIN_WORDS.has(last.up) && last.up !== "JOIN" ? kw(["JOIN"]) : rankTables(schema, refs);
  } else if (clause === "JOIN" && lastIsName) {
    const joined = refs.find((r) => r.alias === unquote(last.text) || r.table.name === unquote(last.text));
    const conds = joined ? joinConditions(joined, refs) : [];
    s = [...conds.map((c) => ({ text: `ON ${c}`, type: "join" as const })), ...kw(["ON", "AS"])];
  } else if (last.up === "ON") {
    const joined = [...refs].reverse()[0];
    s = joined ? joinConditions(joined, refs).map((c) => ({ text: c, type: "join" as const })) : [];
  } else if (clause === "FROM" && (lastIsName || last.text === ")")) s = kw(AFTER_FROM);
  else if (clause === "UPDATE" && lastIsName) s = kw(["SET"]);
  else if (clause === "DELETE") s = kw(["FROM"]);
  else if (last.up === "INSERT") s = kw(["INTO"]);
  else if (clause === "INTO" && lastIsName) {
    const t = refs[refs.length - 1]?.table;
    const cols = t?.columns.filter((c) => !c.primaryKey).map((c) => c.name) ?? [];
    s = cols.length ? [{ text: `(${cols.join(", ")}) VALUES (`, type: "snippet" }] : kw(["VALUES"]);
  } else if (last.up === "VALUES") s = [{ text: "(", type: "snippet" }];
  else if (clause === "SET") {
    if (last.up === "SET" || last.text === ",") s = columnsOf(refs, false).map((c) => ({ ...c, text: `${c.text} = ` }));
    else if (last.kind !== "punct") s = kw(["WHERE", ","]);
  } else if (["WHERE", "ON", "HAVING"].includes(clause)) {
    const completed = prev?.kind === "punct" && /^(=|<>|!=|<=|>=|<|>)$/.test(prev.text);
    if (["WHERE", "AND", "OR", "ON", "HAVING", "NOT", "("].includes(last.up)) s = columnsOf(refs, qualify);
    else if (completed && clause === "ON") s = kw(["WHERE", "JOIN", "LEFT JOIN", "AND", "ORDER BY", "LIMIT"]);
    else if (completed) s = kw(AFTER_CONDITION);
    else if (lastIsName) s = kw(OPERATORS);
    else if (last.kind === "string" || last.kind === "number" || ["NULL", ")"].includes(last.up)) s = kw(AFTER_CONDITION);
  } else if (clause === "ORDER BY") {
    if (last.up === "BY" || last.text === ",") s = columnsOf(refs, qualify);
    else if (last.up === "ASC" || last.up === "DESC") s = kw(["LIMIT", ","]);
    else s = kw(["DESC", "ASC", "LIMIT"]);
  } else if (clause === "GROUP BY") {
    s = last.up === "BY" || last.text === "," ? columnsOf(refs, qualify) : kw(["HAVING", "ORDER BY", "LIMIT"]);
  } else if (last.up === "LIMIT") s = [{ text: "100", type: "value" }];

  if (atBoundary) return { prefix: "", suggestions: s };

  // Typing a word: complete it from what fits here, then anything that matches.
  const p = partial.toLowerCase();
  let pool: Suggestion[];
  if (partial.includes(".")) {
    const alias = partial.slice(0, partial.lastIndexOf("."));
    const ref = refs.find((r) => (r.alias ?? r.table.name).toLowerCase() === alias.toLowerCase());
    pool = ref ? ref.table.columns.map((c) => ({ text: `${alias}.${c.name}`, type: "column" as const, detail: c.dataType })) : [];
  } else {
    pool = [
      ...s,
      ...columnsOf(refs, false),
      ...schema.map((t) => ({ text: t.name, type: "table" as const })),
      ...kw([...START, ...AFTER_FROM, ...AFTER_CONDITION, "SELECT", "FROM", "DISTINCT", "COUNT(*)", "AS", "DESC", "ASC", "NULL", "NOT"]),
    ];
  }
  const seen = new Set<string>();
  const matches = pool.filter((x) => {
    const key = x.text.toLowerCase();
    if (!key.startsWith(p) || key === p || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { prefix: partial, suggestions: matches };
}
