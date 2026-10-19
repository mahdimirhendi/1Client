// A small in-memory backend so the UI runs in a normal browser (`npm run dev`) for design work
// and screenshots. Never used inside the Tauri app. All data is made up.
import type { ColumnMeta, ConnectionProfile, QueryOutput, RowEdit, SessionInfo, TableInfo, TestReport } from "./types";

const profiles: ConnectionProfile[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "shop-api",
    engine: "postgres",
    environment: "production",
    host: "db.internal",
    port: 5432,
    user: "shop_rw",
    database: "shop_production",
    sslMode: "require",
    network: {
      mode: "bastion",
      hops: [
        { id: "a1", host: "bastion.example.com", port: 22, user: "me", auth: { kind: "agent" } },
        { id: "a2", host: "10.0.4.12", port: 22, user: "deploy", auth: { kind: "keyFile", path: "~/.ssh/app_ed25519" } },
      ],
    },
    confirmWrites: true,
    readOnly: false,
    lastUsedAt: Math.floor(Date.now() / 1000) - 600,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "analytics",
    engine: "postgres",
    environment: "staging",
    host: "analytics.staging.internal",
    port: 5432,
    user: "analyst",
    database: "warehouse",
    sslMode: "verifyFull",
    network: {
      mode: "sshTunnel",
      hops: [{ id: "b1", host: "jump.staging.example.com", port: 22, user: "me", auth: { kind: "agent" } }],
    },
    confirmWrites: false,
    readOnly: true,
    lastUsedAt: Math.floor(Date.now() / 1000) - 7200,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "wordpress",
    engine: "mysql",
    environment: "local",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    database: "wordpress",
    sslMode: "disable",
    network: { mode: "direct", hops: [] },
    confirmWrites: false,
    readOnly: false,
  },
];

// ---------- Tables ----------

type Cell = string | null;
interface MockTable {
  info: TableInfo;
  rows: Cell[][];
}

/** `name:type[:pk|:fk|:nn]` per column; `fk` columns reference `<table>.id`. */
function table(schema: string, name: string, cols: string[], rows: Cell[][], kind: "table" | "view" = "table"): MockTable {
  return {
    info: {
      schema,
      name,
      kind,
      columns: cols.map((c) => {
        const [n, t, k] = c.split(":");
        return {
          name: n,
          dataType: t,
          nullable: !k,
          primaryKey: k === "pk",
          foreignKey: k === "fk",
          references: k === "fk" ? `${schema}.${n.replace(/_id$/, "s")}.id` : null,
        };
      }),
    },
    rows,
  };
}

const COMPANIES = [
  "Nordlicht Logistik GmbH", "Atelier Brandt", "Kessler & Sohn", "Bluefin Analytics", "Ostrava Robotics", "Juniper Health",
  "Marlowe & Pike", "Tidewater Supply", "Lumen Studio", "Halvorsen Marine", "Cobalt Freight", "Rivera Foods",
  "Aster Labs", "Grünwald Bau AG", "Okapi Software", "Sundial Coffee", "Pinecrest Clinic", "Vireo Energy",
  "Mosaic Learning", "Kintsugi Design", "Fjord Outdoor", "Calder Insurance", "Saffron Kitchen", "Northwind Traders",
];
const TIERS = ["free", "pro", "enterprise"];
const STATUSES = ["paid", "paid", "shipped", "refunded", "pending"];

/** Deterministic pseudo-random numbers, so screenshots look the same every time. */
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (daysAgo: number) => {
  const d = new Date(Date.UTC(2026, 9, 18, 9, 30) - daysAgo * 86_400_000 - Math.floor(rand() * 36_000_000));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00`;
};

const customers: Cell[][] = COMPANIES.map((name, i) => {
  const slug = name.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0];
  return [String(1001 + i * 37), name, i % 5 === 3 ? null : `billing@${slug}.example`, TIERS[i % 3], stamp(30 + i * 17)];
});
const orders: Cell[][] = Array.from({ length: 260 }, (_, i) => [
  String(50_001 + i),
  customers[Math.floor(rand() * customers.length)][0],
  STATUSES[i % STATUSES.length],
  (20 + rand() * 1800).toFixed(2),
  stamp(Math.floor(rand() * 120)),
]);
const products: Cell[][] = ["Starter plan", "Pro plan", "Team seats", "Support add-on", "Data export", "SSO"].map((n, i) => [
  String(i + 1),
  `SKU-${100 + i * 11}`,
  n,
  (9 + i * 21.5).toFixed(2),
]);
const revenueByCustomer = (id: Cell) =>
  orders.filter((o) => o[1] === id && o[2] !== "refunded").reduce((sum, o) => sum + Number(o[3]), 0).toFixed(2);

const tables: MockTable[] = [
  table("mart", "customer_ltv", ["customer_id:int8", "orders:int8", "revenue:numeric"], customers.map((c) => [c[0], String(orders.filter((o) => o[1] === c[0]).length), revenueByCustomer(c[0])]), "view"),
  table("mart", "daily_revenue", ["day:date", "orders:int8", "revenue:numeric"], Array.from({ length: 30 }, (_, i) => [stamp(i).slice(0, 10), String(3 + (i * 7) % 11), (800 + rand() * 4000).toFixed(2)])),
  table("public", "customers", ["id:int8:pk", "name:text:nn", "email:text", "tier:text:nn", "created_at:timestamptz:nn"], customers),
  table("public", "orders", ["id:int8:pk", "customer_id:int8:fk", "status:text:nn", "total:numeric:nn", "placed_at:timestamptz:nn"], orders),
  table("public", "products", ["id:int8:pk", "sku:text:nn", "name:text:nn", "price:numeric:nn"], products),
];

/** Postgres type names as the server reports them for a result column. */
const PG_TYPE: Record<string, string> = { int8: "int8", text: "text", numeric: "numeric", timestamptz: "timestamptz", date: "date" };

/** Split a WHERE clause on AND / OR outside quoted strings. */
function splitWhere(where: string): { conds: string[]; any: boolean } {
  const strings: string[] = [];
  const masked = where.replace(/E?'(?:[^']|'')*'/g, (lit) => `\u0000${strings.push(lit) - 1}\u0000`);
  const conds = masked.split(/ (?:AND|OR) /).map((c) => c.replace(/\u0000(\d+)\u0000/g, (_, i) => strings[Number(i)]));
  return { conds, any: / OR /.test(masked) };
}

const unquote = (lit: string) => {
  const e = lit.startsWith("E");
  const body = lit.slice(e ? 2 : 1, -1).replace(/''/g, "'");
  return e ? body.replace(/\\\\/g, "\\") : body;
};

/** The conditions 1Client's filter bar generates (see `whereSql`), evaluated on one row. */
function matches(cond: string, row: Cell[], cols: string[]): boolean {
  const cell = (name: string) => row[cols.indexOf(name)];
  let m = /^["`](\w+)["`] IS (NOT )?NULL$/.exec(cond);
  if (m) return (cell(m[1]) === null) !== !!m[2];
  m = /^["`](\w+)["`] (NOT )?IN \((.*)\)$/.exec(cond);
  if (m) {
    const items = (m[3].match(/E?'(?:[^']|'')*'/g) ?? []).map(unquote);
    const v = cell(m[1]);
    return v !== null && items.includes(v) !== !!m[2];
  }
  m = /^(?:["`](\w+)["`]::text|CAST\(["`](\w+)["`] AS CHAR\)) (NOT )?I?LIKE (E?'.*') ESCAPE '!'$/.exec(cond);
  if (m) {
    const v = cell(m[1] ?? m[2]);
    if (v === null) return false;
    let re = "";
    const p = unquote(m[4]);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === "!") re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else re += p[i] === "%" ? ".*" : p[i] === "_" ? "." : p[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "is").test(v) !== !!m[3];
  }
  m = /^["`](\w+)["`] (=|<>|<=|>=|<|>) (E?'.*')$/.exec(cond);
  if (m) {
    const v = cell(m[1]);
    if (v === null) return false;
    const want = unquote(m[3]);
    const numeric = v !== "" && want !== "" && !isNaN(Number(v)) && !isNaN(Number(want));
    const c = numeric ? Number(v) - Number(want) : v.localeCompare(want);
    return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[m[2]]!;
  }
  return true;
}

/** `SELECT * FROM "schema"."table" [WHERE …] [ORDER BY "col" ASC|DESC …] LIMIT n`, as table tabs send it. */
function tableQuery(sql: string): QueryOutput | null {
  const m = /^\s*select \* from ["`](\w+)["`]\.["`](\w+)["`](?: where (.*?))?(?: order by ["`](\w+)["`](?: is null, ["`]\w+["`])? (asc|desc)(?: nulls last)?)? limit \d+;?\s*$/is.exec(sql);
  const t = m && tables.find((x) => x.info.schema === m[1] && x.info.name === m[2]);
  if (!m || !t) return null;
  const names = t.info.columns.map((c) => c.name);
  let rows = t.rows.map((r) => [...r]);
  if (m[3]) {
    const { conds, any } = splitWhere(m[3]);
    rows = rows.filter((r) => (any ? conds.some((c) => matches(c, r, names)) : conds.every((c) => matches(c, r, names))));
  }
  const col = m[4] ? names.indexOf(m[4]) : -1;
  if (col >= 0) {
    const numeric = /int|numeric/.test(t.info.columns[col].dataType);
    const sign = m[5].toLowerCase() === "desc" ? -1 : 1;
    rows = rows.sort((a, b) => {
      const [x, y] = [a[col], b[col]];
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return sign * (numeric ? Number(x) - Number(y) : x.localeCompare(y));
    });
  }
  const columns: ColumnMeta[] = t.info.columns.map((c) => ({
    name: c.name,
    typeName: PG_TYPE[c.dataType] ?? c.dataType,
    source: t.info.kind === "table" ? { schema: t.info.schema, table: t.info.name, column: c.name } : undefined,
  }));
  return { sets: [{ columns, rows: rows.slice(0, 200), rowCount: Math.min(rows.length, 200), truncated: false }], elapsedMs: 14 };
}

let environments = [
  { id: "local", name: "Local", color: "#8E8E93", confirmWrites: false },
  { id: "staging", name: "Staging", color: "#F08C00", confirmWrites: false },
  { id: "production", name: "Production", color: "#E5484D", confirmWrites: true },
  { id: "demo", name: "Customer demo", color: "#8E4EC6", confirmWrites: true },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await sleep(120);
  switch (cmd) {
    case "list_connections":
      return profiles as T;
    case "save_connection": {
      const p = args.profile as ConnectionProfile;
      const i = profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) profiles[i] = p;
      else profiles.push(p);
      return p as T;
    }
    case "delete_connection": {
      const i = profiles.findIndex((x) => x.id === args.id);
      if (i >= 0) profiles.splice(i, 1);
      return undefined as T;
    }
    case "test_connection": {
      const p = args.profile as ConnectionProfile;
      const hops = p.network.mode === "direct" ? [] : p.network.mode === "sshTunnel" ? p.network.hops.slice(0, 1) : p.network.hops;
      const steps: TestReport["steps"] = [];
      hops.forEach((h, i) => {
        steps.push({ label: i ? `Reach ${h.host}:${h.port} through ${hops[i - 1].host}` : `Reach ${h.host}:${h.port}`, status: "ok", ms: 40 });
        steps.push({ label: `Verify host key of ${h.host}`, status: "ok", ms: 30 });
        steps.push({ label: `Sign in as ${h.user}@${h.host}`, status: "ok", ms: 80 });
      });
      const engine = p.engine === "postgres" ? "PostgreSQL" : "MySQL";
      steps.push({ label: hops.length ? `Reach database ${p.host}:${p.port} from ${hops.at(-1)!.host}` : `Reach database ${p.host}:${p.port}`, status: "ok", ms: 12 });
      // In the mock, the password "wrong" fails sign-in so the failure view can be checked.
      const bad = (args.secrets as { dbPassword?: string } | undefined)?.dbPassword === "wrong";
      steps.push(
        bad
          ? { label: `Sign in to ${engine} as ${p.user}`, status: "failed", detail: `password authentication failed for user "${p.user}"`, hint: "Wrong user name or password." }
          : { label: `Sign in to ${engine} as ${p.user}`, status: "ok", detail: `${engine} 17.2` },
      );
      if (p.database) steps.push({ label: `Open database ${p.database}`, status: bad ? "skipped" : "ok" });
      return {
        ok: !bad,
        steps,
        serverVersion: bad ? null : `${engine} 17.2`,
        hops: hops.length,
        elapsedMs: 212,
        error: bad ? { kind: "database", message: "password authentication failed" } : null,
      } satisfies TestReport as T;
    }
    case "open_session": {
      const p = profiles.find((x) => x.id === args.profileId)!;
      return {
        sessionId: crypto.randomUUID(),
        profileId: p.id,
        serverVersion: p.engine === "postgres" ? "PostgreSQL 17.2" : "MySQL 8.4.3",
        hops: p.network.mode === "direct" ? 0 : p.network.mode === "sshTunnel" ? 1 : p.network.hops.length,
      } satisfies SessionInfo as T;
    }
    case "secret_references":
      return { dbPassword: "op://Private/shop-api/password", hops: {} } as T;
    case "list_environments":
      return environments as T;
    case "save_environments":
      environments = args.list as typeof environments;
      return environments as T;
    case "take_pending_links":
      return [] as T;
    case "introspect":
      return tables.map((t) => t.info) as T;
    case "run_query": {
      const sql = String(args.sql);
      const bad = sql.indexOf("totl");
      if (bad >= 0)
        throw {
          kind: "database",
          message: 'ERROR:  column "totl" does not exist',
          db: { engine: "postgres", code: null, sqlstate: "42703", severity: "ERROR", message: 'column "totl" does not exist', detail: null, hint: 'Perhaps you meant to reference the column "orders.total".', position: bad + 1 },
        };
      const fromTable = tableQuery(sql);
      if (fromTable) return fromTable as T;
      if (/^\s*(update|delete|insert)/i.test(sql)) {
        return { sets: [{ columns: [], rows: [], rowCount: 3, truncated: false }], elapsedMs: 9 } satisfies QueryOutput as T;
      }
      // Anything else: customers with their revenue, best first.
      const src = (column: string) => ({ schema: "public", table: "customers", column });
      const rows = customers
        .map((c) => [c[0], c[1], c[2], c[3], revenueByCustomer(c[0])])
        .sort((a, b) => Number(b[4]) - Number(a[4]));
      return {
        sets: [
          {
            columns: [
              { name: "id", typeName: "int8", source: src("id") },
              { name: "name", typeName: "text", source: src("name") },
              { name: "email", typeName: "text", source: src("email") },
              { name: "tier", typeName: "text", source: src("tier") },
              { name: "revenue", typeName: "numeric" },
            ],
            rows,
            rowCount: rows.length,
            truncated: false,
          },
        ],
        elapsedMs: 38,
      } satisfies QueryOutput as T;
    }
    case "preview_edits":
      return (args.edits as RowEdit[])
        .map(
          (e) =>
            `UPDATE "${e.schema}"."${e.table}" SET ${e.values.map((v) => `"${v.column}" = ${v.value === null ? "NULL" : `'${v.value.replace(/'/g, "''")}'`}`).join(", ")} WHERE ${e.key.map((k) => `"${k.column}" = '${k.value}'`).join(" AND ")};`,
        )
        .join("\n") as T;
    case "apply_edits": {
      for (const e of args.edits as RowEdit[]) {
        const t = tables.find((x) => x.info.schema === e.schema && x.info.name === e.table);
        const keyCol = t?.info.columns.findIndex((c) => c.name === e.key[0].column) ?? -1;
        const row = t?.rows.find((r) => r[keyCol] === e.key[0].value);
        if (!t || !row) throw { kind: "config", message: `Nothing was saved: the row in ${e.table} where ${e.key[0].column} = ${e.key[0].value} no longer exists.` };
        for (const v of e.values) row[t.info.columns.findIndex((c) => c.name === v.column)] = v.value;
      }
      return (args.edits as RowEdit[]).length as T;
    }
    default:
      return undefined as T;
  }
}
