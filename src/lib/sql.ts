import type { ConnectionProfile, Engine } from "../types";

export interface Statement {
  from: number;
  to: number;
  text: string;
}

/**
 * Split SQL into statements on `;`, ignoring semicolons inside quotes, comments
 * and PostgreSQL dollar-quoted bodies.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (raw.trim() && stripComments(raw).trim()) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ from: start + lead, to: end, text: raw.trim() });
    }
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && c !== '"') i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) {
          i++;
          break;
        } else i++;
      }
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end < 0 ? sql.length : end + m[0].length;
      } else i++;
    } else if (c === ";") {
      push(i);
      start = i + 1;
      i++;
    } else i++;
  }
  push(sql.length);
  return out;
}

function stripComments(s: string) {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The statement under the cursor, or the closest one before it. */
export function statementAt(sql: string, pos: number): Statement | null {
  const all = splitStatements(sql);
  let best: Statement | null = null;
  for (const s of all) {
    if (s.from <= pos) best = s;
    if (pos <= s.to + 1 && pos >= s.from) return s;
  }
  return best ?? all[0] ?? null;
}

const WRITE = /^(insert|update|delete|merge|replace|upsert|create|alter|drop|truncate|rename|grant|revoke|comment|call|do|vacuum|reindex|cluster|set\s+global)\b/i;

export function isWrite(statement: string): boolean {
  const s = stripComments(statement).trim();
  if (WRITE.test(s)) return true;
  // WITH ... UPDATE / DELETE / INSERT
  return /^with\b/i.test(s) && /\b(update|delete|insert)\b/i.test(s);
}

export function quoteIdent(engine: Engine, name: string): string {
  return engine === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"';
}

/** Rows loaded when a table is opened from the sidebar. */
export const TABLE_ROWS = 200;

export interface TableRef {
  schema: string;
  name: string;
}

export interface Sort {
  column: string;
  dir: "asc" | "desc";
}

export type FilterOp =
  | "eq"
  | "ne"
  | "lt"
  | "gt"
  | "le"
  | "ge"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "notIn"
  | "isNull"
  | "notNull";

export interface Filter {
  column: string;
  op: FilterOp;
  /** Ignored by `isNull` / `notNull`; a comma-separated list for `in` / `notIn`. */
  value: string;
}

/** Operators in the order the filter bar offers them. */
export const FILTER_OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: "eq", label: "=", needsValue: true },
  { op: "ne", label: "≠", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "gt", label: ">", needsValue: true },
  { op: "le", label: "≤", needsValue: true },
  { op: "ge", label: "≥", needsValue: true },
  { op: "contains", label: "contains", needsValue: true },
  { op: "notContains", label: "does not contain", needsValue: true },
  { op: "startsWith", label: "starts with", needsValue: true },
  { op: "endsWith", label: "ends with", needsValue: true },
  { op: "in", label: "in list", needsValue: true },
  { op: "notIn", label: "not in list", needsValue: true },
  { op: "isNull", label: "is NULL", needsValue: false },
  { op: "notNull", label: "is not NULL", needsValue: false },
];

export const needsValue = (op: FilterOp) => FILTER_OPS.find((o) => o.op === op)?.needsValue ?? true;

/** How a table tab is narrowed and ordered. All of it runs on the server, so it covers the whole table. */
export interface TableView {
  sort?: Sort;
  filters?: Filter[];
  /** `all`: every filter must match (AND); `any`: one is enough (OR). */
  match?: "all" | "any";
  /** A condition typed by hand, used instead of `filters` when set. */
  where?: string;
}

/** A string literal that means the same whatever the server settings are. */
export function sqlLiteral(engine: Engine, value: string): string {
  if (engine === "mysql") {
    // Doubled quotes work with and without NO_BACKSLASH_ESCAPES; backslashes must be doubled without it.
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  // E'' strings always treat backslash as an escape, so doubling it is correct either way.
  if (value.includes("\\")) return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "''")}'`;
}

const COMPARE: Partial<Record<FilterOp, string>> = { eq: "=", ne: "<>", lt: "<", gt: ">", le: "<=", ge: ">=" };

/** One condition, or null when it is incomplete (no column, or no value where one is needed). */
function condition(engine: Engine, f: Filter): string | null {
  if (!f.column || (needsValue(f.op) && f.value === "")) return null;
  const col = quoteIdent(engine, f.column);
  const lit = (v: string) => sqlLiteral(engine, v);
  const symbol = COMPARE[f.op];
  if (symbol) return `${col} ${symbol} ${lit(f.value)}`;
  switch (f.op) {
    case "isNull":
      return `${col} IS NULL`;
    case "notNull":
      return `${col} IS NOT NULL`;
    case "in":
    case "notIn": {
      const items = f.value.split(",").map((v) => v.trim()).filter(Boolean);
      return items.length ? `${col} ${f.op === "notIn" ? "NOT IN" : "IN"} (${items.map(lit).join(", ")})` : null;
    }
    default: {
      // Text matching on any type (numbers, dates, JSON…), ignoring case. `!` escapes %, _ and itself,
      // so the value is matched literally; it avoids backslash, whose meaning depends on server settings.
      const text = engine === "postgres" ? `${col}::text` : `CAST(${col} AS CHAR)`;
      const like = engine === "postgres" ? "ILIKE" : "LIKE";
      const v = f.value.replace(/[!%_]/g, "!$&");
      const pattern = f.op === "startsWith" ? `${v}%` : f.op === "endsWith" ? `%${v}` : `%${v}%`;
      return `${text} ${f.op === "notContains" ? "NOT " : ""}${like} ${lit(pattern)} ESCAPE '!'`;
    }
  }
}

/** The WHERE condition for a table tab's filters, or "" when none is complete. */
export function whereSql(engine: Engine, filters: Filter[] = [], match: TableView["match"] = "all"): string {
  return filters
    .map((f) => condition(engine, f))
    .filter((c): c is string => c !== null)
    .join(match === "any" ? " OR " : " AND ");
}

/** The query of a table tab: its filters (or hand-written condition), its sort (NULLs last), the row limit. */
export function tableSql(engine: Engine, table: TableRef, view: TableView = {}): string {
  const from = `${quoteIdent(engine, table.schema)}.${quoteIdent(engine, table.name)}`;
  const where = view.where?.trim() || whereSql(engine, view.filters, view.match);
  let order = "";
  if (view.sort) {
    const col = quoteIdent(engine, view.sort.column);
    const dir = view.sort.dir.toUpperCase();
    // MySQL has no NULLS LAST; sorting on "IS NULL" first does the same.
    order = engine === "postgres" ? ` ORDER BY ${col} ${dir} NULLS LAST` : ` ORDER BY ${col} IS NULL, ${col} ${dir}`;
  }
  return `SELECT * FROM ${from}${where ? ` WHERE ${where}` : ""}${order} LIMIT ${TABLE_ROWS};`;
}

/** A name to offer when saving a query: a leading `-- comment`, or else the first line of the SQL. */
export function queryName(sql: string): string {
  const first = sql.trim().split("\n")[0]?.trim() ?? "";
  const comment = /^--\s*(.+)$/.exec(first)?.[1];
  const name = (comment ?? first).replace(/[;,]+$/, "").replace(/\s+/g, " ").trim();
  return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

/** Fill a profile from `postgres://user:pass@host:5432/db?sslmode=require` or `mysql://…`. */
export function parseConnectionUrl(
  url: string,
): { profile: Partial<ConnectionProfile>; password?: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(":", "");
  const engine: Engine | null = /^postgres(ql)?$/.test(scheme) ? "postgres" : /^(mysql|mariadb)$/.test(scheme) ? "mysql" : null;
  if (!engine) return null;
  const ssl = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl-mode");
  const sslMode = ssl === "disable" ? "disable" : ssl === "require" ? "require" : ssl?.startsWith("verify") ? "verifyFull" : "prefer";
  return {
    profile: {
      engine,
      host: decodeURIComponent(u.hostname),
      port: u.port ? Number(u.port) : engine === "postgres" ? 5432 : 3306,
      user: decodeURIComponent(u.username),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
      sslMode,
      name: u.hostname,
    },
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}
