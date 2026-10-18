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

/** The query of a table tab. Sorting is done by the server so it covers the whole table, NULLs last. */
export function tableSql(engine: Engine, table: TableRef, sort?: Sort | null): string {
  const from = `${quoteIdent(engine, table.schema)}.${quoteIdent(engine, table.name)}`;
  let order = "";
  if (sort) {
    const col = quoteIdent(engine, sort.column);
    const dir = sort.dir.toUpperCase();
    // MySQL has no NULLS LAST; sorting on "IS NULL" first does the same.
    order = engine === "postgres" ? ` ORDER BY ${col} ${dir} NULLS LAST` : ` ORDER BY ${col} IS NULL, ${col} ${dir}`;
  }
  return `SELECT * FROM ${from}${order} LIMIT ${TABLE_ROWS};`;
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
