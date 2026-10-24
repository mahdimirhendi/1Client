// A small in-memory backend so the UI runs in a normal browser (`npm run dev`) for design work
// and screenshots. Never used inside the Tauri app. All data is made up.
import type {
  AppError,
  Canvas,
  ColumnMeta,
  ConnectionProfile,
  HistoryEntry,
  QueryOutput,
  RowEdit,
  SavedQuery,
  SecretField,
  SessionInfo,
  TableInfo,
  TestReport,
} from "./types";

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

/** `name:type[:pk|:fk|:nn]` per column; `fk` columns reference `<table>.id`, `fk>schema.table.column` another column. */
function column(schema: string, spec: string): TableInfo["columns"][number] {
  const [n, t, k] = spec.split(":");
  const ref = k?.startsWith("fk>") ? k.slice(3) : k === "fk" ? `${schema}.${n.replace(/_id$/, "s")}.id` : null;
  return { name: n, dataType: t, nullable: !k, primaryKey: k === "pk", foreignKey: !!ref, references: ref };
}

function table(schema: string, name: string, cols: string[], rows: Cell[][], kind: "table" | "view" = "table"): MockTable {
  return { info: { schema, name, kind, columns: cols.map((c) => column(schema, c)) }, rows };
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
  table("public", "order_items", ["id:int8:pk", "order_id:int8:fk", "product_id:int8:fk", "quantity:int4:nn", "unit_price:numeric:nn"], []),
  table("public", "payments", ["id:int8:pk", "order_id:int8:fk", "method:text:nn", "amount:numeric:nn", "paid_at:timestamptz"], []),
  table("public", "refunds", ["id:int8:pk", "payment_id:int8:fk", "reason:text", "amount:numeric:nn", "created_at:timestamptz:nn"], []),
  table("public", "addresses", ["id:int8:pk", "customer_id:int8:fk", "line1:text:nn", "city:text:nn", "country:char(2):nn"], []),
  table("public", "shipments", ["id:int8:pk", "order_id:int8:fk", "address_id:int8:fk>public.addresses.id", "carrier:text", "shipped_at:timestamptz"], []),
];

// `?tables=300` adds that many made-up tables in an "app" schema (in groups linked by foreign keys),
// to try big diagrams.
const extra = Number(new URLSearchParams(globalThis.location?.search ?? "").get("tables")) || 0;
for (let i = 0; i < extra; i++) {
  const cols = ["id:int8:pk", "name:text:nn", "status:text", "created_at:timestamptz:nn", "updated_at:timestamptz"];
  if (i % 5) cols.splice(1, 0, `parent_id:int8:fk>app.t${String(i - (i % 5)).padStart(3, "0")}.id`);
  if (i % 7 === 3) cols.push("customer_id:int8:fk>public.customers.id");
  tables.push(table("app", `t${String(i).padStart(3, "0")}`, cols, []));
}

/** Schema changes typed in a query tab, so the live diagram can be tried: CREATE / DROP TABLE and ALTER TABLE ADD / DROP COLUMN. */
function runDdl(sql: string): QueryOutput | null {
  // [schema.]table, each part maybe quoted ("x" or `x`).
  const name = /^(?:["`]?(\w+)["`]?\.)?["`]?(\w+)["`]?/;
  const target = (text: string) => {
    const m = name.exec(text.trim());
    return m ? { schema: m[1] ?? "public", name: m[2], rest: text.trim().slice(m[0].length).trim() } : null;
  };
  const done = { sets: [{ columns: [], rows: [], rowCount: 0, truncated: false }], elapsedMs: 11 } satisfies QueryOutput;
  const text = sql.trim().replace(/;\s*$/, "");
  let m = /^drop\s+table\s+(?:if\s+exists\s+)?(.+)$/is.exec(text);
  if (m) {
    const t = target(m[1]);
    const i = t ? tables.findIndex((x) => x.info.schema === t.schema && x.info.name === t.name) : -1;
    if (i < 0) throw { kind: "database", message: `ERROR:  table "${t?.name}" does not exist` };
    tables.splice(i, 1);
    return done;
  }
  m = /^create\s+table\s+(?:if\s+not\s+exists\s+)?(.+)$/is.exec(text);
  if (m) {
    const t = target(m[1]);
    const body = t && /^\((.*)\)$/s.exec(t.rest)?.[1];
    if (!t || !body) throw { kind: "database", message: "ERROR:  syntax error in CREATE TABLE" };
    const cols = body.split(",").map((c) => {
      const [n, type = "text", ...more] = c.trim().split(/\s+/);
      const extra = more.join(" ").toLowerCase();
      const ref = /references\s+(?:(\w+)\.)?(\w+)\s*\((\w+)\)/.exec(extra);
      const key = extra.includes("primary key") ? "pk" : ref ? `fk>${ref[1] ?? t.schema}.${ref[2]}.${ref[3]}` : "";
      return column(t.schema, [n.replace(/["`]/g, ""), type, key].filter(Boolean).join(":"));
    });
    tables.push({ info: { schema: t.schema, name: t.name, kind: "table", columns: cols }, rows: [] });
    tables.sort((a, b) => a.info.schema.localeCompare(b.info.schema) || a.info.name.localeCompare(b.info.name));
    return done;
  }
  m = /^alter\s+table\s+(.+)$/is.exec(text);
  if (m) {
    const t = target(m[1]);
    const mt = t && findTable(t.schema, t.name);
    if (!t || !mt) throw { kind: "database", message: `ERROR:  relation "${t?.name}" does not exist` };
    const add = /^add\s+(?:column\s+)?["`]?(\w+)["`]?\s+(\S+)/i.exec(t.rest);
    const drop = /^drop\s+(?:column\s+)?["`]?(\w+)["`]?/i.exec(t.rest);
    if (add) {
      mt.info.columns.push(column(t.schema, `${add[1]}:${add[2]}`));
      mt.rows.forEach((r) => r.push(null));
    } else if (drop) {
      const i = mt.info.columns.findIndex((c) => c.name === drop[1]);
      if (i < 0) throw { kind: "database", message: `ERROR:  column "${drop[1]}" does not exist` };
      mt.info.columns.splice(i, 1);
      mt.rows.forEach((r) => r.splice(i, 1));
    } else throw { kind: "database", message: "ERROR:  only ADD COLUMN and DROP COLUMN are known to the demo backend" };
    return done;
  }
  return null;
}

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

const findTable = (schema: string, name: string) => tables.find((x) => x.info.schema === schema && x.info.name === name);

/** The rows of a table that match a WHERE clause from the filter bar. */
function filtered(t: MockTable, where: string | undefined): Cell[][] {
  const names = t.info.columns.map((c) => c.name);
  const rows = t.rows.map((r) => [...r]);
  if (!where) return rows;
  const { conds, any } = splitWhere(where);
  return rows.filter((r) => (any ? conds.some((c) => matches(c, r, names)) : conds.every((c) => matches(c, r, names))));
}

/**
 * The queries table tabs send: `SELECT * FROM "schema"."table" [WHERE …] [ORDER BY …] LIMIT n [OFFSET m]`,
 * and `SELECT count(*) FROM "schema"."table" [WHERE …]` for Count Rows.
 */
function tableQuery(sql: string): QueryOutput | null {
  const count = /^\s*select count\(\*\) from ["`](\w+)["`]\.["`](\w+)["`](?: where (.*?))?;?\s*$/is.exec(sql);
  const counted = count && findTable(count[1], count[2]);
  if (count && counted) {
    const n = String(filtered(counted, count[3]).length);
    return { sets: [{ columns: [{ name: "count", typeName: "int8" }], rows: [[n]], rowCount: 1, truncated: false }], elapsedMs: 6 };
  }
  const m = /^\s*select \* from ["`](\w+)["`]\.["`](\w+)["`](?: where (.*?))?(?: order by ["`](\w+)["`](?:(?: is null, ["`]\w+["`])? (asc|desc)(?: nulls last)?|(?:, ["`]\w+["`])*))? limit (\d+)(?: offset (\d+))?;?\s*$/is.exec(sql);
  const t = m && findTable(m[1], m[2]);
  if (!m || !t) return null;
  let rows = filtered(t, m[3]);
  const col = m[4] ? t.info.columns.findIndex((c) => c.name === m[4]) : -1;
  if (col >= 0) {
    const numeric = /int|numeric/.test(t.info.columns[col].dataType);
    const sign = m[5]?.toLowerCase() === "desc" ? -1 : 1;
    rows = rows.sort((a, b) => {
      const [x, y] = [a[col], b[col]];
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return sign * (numeric ? Number(x) - Number(y) : x.localeCompare(y));
    });
  }
  const offset = Number(m[7] ?? 0);
  rows = rows.slice(offset, offset + Number(m[6]));
  const columns: ColumnMeta[] = t.info.columns.map((c) => ({
    name: c.name,
    typeName: PG_TYPE[c.dataType] ?? c.dataType,
    source: t.info.kind === "table" ? { schema: t.info.schema, table: t.info.name, column: c.name } : undefined,
  }));
  return { sets: [{ columns, rows, rowCount: rows.length, truncated: false }], elapsedMs: 14 };
}

/** What the mock answers to SQL typed in a query tab. Throws like the backend on errors. */
function runSql(sql: string): QueryOutput {
  const bad = sql.indexOf("totl");
  if (bad >= 0)
    throw {
      kind: "database",
      message: 'ERROR:  column "totl" does not exist',
      db: { engine: "postgres", code: null, sqlstate: "42703", severity: "ERROR", message: 'column "totl" does not exist', detail: null, hint: 'Perhaps you meant to reference the column "orders.total".', position: bad + 1 },
    };
  const ddl = runDdl(sql);
  if (ddl) return ddl;
  const fromTable = tableQuery(sql);
  if (fromTable) return fromTable;
  if (/^\s*(update|delete|insert)/i.test(sql)) {
    return { sets: [{ columns: [], rows: [], rowCount: 3, truncated: false }], elapsedMs: 9 } satisfies QueryOutput;
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
  } satisfies QueryOutput;
}

// ---------- History and saved queries ----------

const SHOP = "11111111-1111-4111-8111-111111111111";
const minutesAgo = (m: number) => Date.now() - m * 60_000;
const sessions = new Map<string, string>();

let history: HistoryEntry[] = [
  [`SELECT status, count(*), sum(total)\nFROM orders\nGROUP BY status;`, 2880, 41, 4, null],
  [`SELECT * FROM orders WHERE placed_at > now() - interval '7 days';`, 1440, 63, 18, null],
  [`UPDATE orders SET status = 'shipped' WHERE id = 50231;`, 600, 12, 1, null],
  [`SELECT totl FROM orders;`, 180, 4, null, 'ERROR:  column "totl" does not exist'],
  [`SELECT c.name, count(o.id) AS orders\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.name\nORDER BY orders DESC\nLIMIT 10;`, 35, 57, 10, null],
  [`SELECT * FROM customers WHERE tier = 'enterprise';`, 6, 19, 8, null],
].map(([sql, ago, elapsedMs, rows, error], i) => ({
  id: `h${i}`,
  profileId: SHOP,
  sql: sql as string,
  ranAt: minutesAgo(ago as number),
  elapsedMs: elapsedMs as number,
  rows: rows as number | null,
  error: error as string | null,
}));

let saved: SavedQuery[] = [
  ["Top customers by revenue", `-- Top customers by revenue\nSELECT c.id, c.name, sum(o.total) AS revenue\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nWHERE o.status <> 'refunded'\nGROUP BY c.id\nORDER BY revenue DESC\nLIMIT 20;`],
  ["Orders this week", `SELECT * FROM orders\nWHERE placed_at > now() - interval '7 days'\nORDER BY placed_at DESC;`],
  ["Refunds by month", `SELECT date_trunc('month', placed_at) AS month, count(*), sum(total)\nFROM orders\nWHERE status = 'refunded'\nGROUP BY 1\nORDER BY 1;`],
].map(([name, sql], i) => ({ id: `s${i}`, profileId: SHOP, name, sql, updatedAt: minutesAgo(5000 - i) }));

let environments = [
  { id: "local", name: "Local", color: "#8E8E93", confirmWrites: false },
  { id: "staging", name: "Staging", color: "#F08C00", confirmWrites: false },
  { id: "production", name: "Production", color: "#E5484D", confirmWrites: true },
  { id: "demo", name: "Customer demo", color: "#8E4EC6", confirmWrites: true },
];

/** In the mock, an SSH host named rebuilt.example.com sends a new key until it is replaced. */
let rebuiltReplaced = false;
function keyChanged(p: ConnectionProfile): AppError | null {
  const hop = p.network.mode === "direct" ? undefined : p.network.hops.find((h) => h.host === "rebuilt.example.com");
  if (!hop || rebuiltReplaced) return null;
  const fingerprint = "SHA256:dGhlIHNlcnZlciB3YXMgcmVidWlsdA";
  return {
    kind: "hostKeyChanged",
    message: `${hop.host}:${hop.port} sent key ${fingerprint}, which does not match ~/.ssh/known_hosts line 12.`,
    step: `Verify host key of ${hop.host}`,
    hint: "If the server was rebuilt or reinstalled, replace the old key. If you don't know why it changed, don't connect: someone may be intercepting the connection.",
    host: hop.host,
    port: hop.port,
    fingerprint,
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKBxUWKEwcouxtksE8aGUUdx7FYOyBn4tUQlurbvM4/i",
  };
}

/** Diagram canvases by connection; none until a connection's diagram is first opened. */
const canvases = new Map<string, Canvas[]>();

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
      canvases.delete(String(args.id));
      return undefined as T;
    }
    case "test_connection": {
      const p = args.profile as ConnectionProfile;
      const hops = p.network.mode === "direct" ? [] : p.network.mode === "sshTunnel" ? p.network.hops.slice(0, 1) : p.network.hops;
      const changed = keyChanged(p);
      if (changed) {
        const steps: TestReport["steps"] = [
          { label: `Reach ${changed.host}:${changed.port}`, status: "ok", ms: 40 },
          { label: changed.step!, status: "failed", detail: changed.message, hint: changed.hint, ms: 30 },
        ];
        return { ok: false, steps, serverVersion: null, hops: hops.length, elapsedMs: 70, error: changed } satisfies TestReport as T;
      }
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
      const changed = keyChanged(p);
      if (changed) throw { ...changed, message: `${changed.step}: ${changed.message}` };
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, p.id);
      return {
        sessionId,
        profileId: p.id,
        serverVersion: p.engine === "postgres" ? "PostgreSQL 17.2" : "MySQL 8.4.3",
        hops: p.network.mode === "direct" ? 0 : p.network.mode === "sshTunnel" ? 1 : p.network.hops.length,
      } satisfies SessionInfo as T;
    }
    case "reveal_secret": {
      const field = args.field as SecretField;
      if (!profiles.some((p) => p.id === args.profileId)) return null as T;
      const stored: Record<SecretField["kind"], string | null> = {
        db: args.profileId === SHOP ? "op://Private/shop-api/password" : "local-dev-password",
        hopPassphrase: "correct horse battery staple",
        hopPassword: null,
      };
      return stored[field.kind] as T;
    }
    case "secret_references":
      // Only shop-api keeps a 1Password reference; the others have plain saved passwords.
      return (args.id === SHOP ? { dbPassword: "op://Private/shop-api/password", hops: {} } : { hops: {} }) as T;
    case "list_environments":
      return environments as T;
    case "save_environments":
      environments = args.list as typeof environments;
      return environments as T;
    case "replace_host_key":
      rebuiltReplaced = true;
      return undefined as T;
    case "take_pending_links":
    case "take_startup_problems":
      return [] as T;
    case "introspect":
      return structuredClone(tables.map((t) => t.info)) as T;
    case "list_canvases":
      return (canvases.has(String(args.profileId)) ? structuredClone(canvases.get(String(args.profileId))) : null) as T;
    case "save_canvas": {
      const profileId = String(args.profileId);
      if (!profiles.some((p) => p.id === profileId)) throw { kind: "config", message: "Save this connection to keep canvases for it" };
      const c = structuredClone(args.canvas as Canvas);
      c.name = c.name.trim();
      if (!c.name) throw { kind: "config", message: "Give the canvas a name" };
      if (c.scope.kind === "picked") c.autoAdd = false;
      const list = canvases.get(profileId) ?? [];
      const i = list.findIndex((x) => x.id === c.id);
      c.updatedAt = Date.now();
      c.createdAt = i >= 0 ? list[i].createdAt : c.updatedAt;
      if (i >= 0) list[i] = c;
      else list.push(c);
      canvases.set(profileId, list);
      return structuredClone(c) as T;
    }
    case "delete_canvas": {
      const profileId = String(args.profileId);
      canvases.set(profileId, (canvases.get(profileId) ?? []).filter((c) => c.id !== args.id));
      return undefined as T;
    }
    case "export_diagram": {
      // The app asks where to save; the demo keeps the file for checks and says where it would be.
      const { name, kind, data } = args as { name: string; kind: string; data: string };
      (window as unknown as { __lastExport?: unknown }).__lastExport = { name, kind, data };
      return `/Users/you/Desktop/${name}.${kind}` as T;
    }
    case "run_query": {
      const sql = String(args.sql);
      const profileId = sessions.get(String(args.sessionId)) ?? "";
      const remember = (rows: number | null, error: string | null, elapsedMs: number) => {
        if (!args.record || !profiles.some((p) => p.id === profileId)) return;
        history = history.filter((e) => !(e.profileId === profileId && e.sql === sql));
        history.push({ id: crypto.randomUUID(), profileId, sql, ranAt: Date.now(), elapsedMs, rows, error });
      };
      try {
        const out = runSql(sql);
        remember(out.sets.at(-1)?.rowCount ?? null, null, out.elapsedMs);
        return out as T;
      } catch (e) {
        remember(null, (e as { message: string }).message, 4);
        throw e;
      }
    }
    case "list_history":
      return history.filter((e) => e.profileId === args.profileId).reverse() as T;
    case "delete_history":
      history = history.filter((e) => e.id !== args.id);
      return undefined as T;
    case "clear_history":
      history = history.filter((e) => e.profileId !== args.profileId);
      return undefined as T;
    case "list_saved_queries":
      return saved.filter((q) => q.profileId === args.profileId).sort((a, b) => a.name.localeCompare(b.name)) as T;
    case "save_query": {
      const q = { ...(args.query as SavedQuery) };
      q.name = q.name.trim();
      if (!q.name) throw { kind: "config", message: "Give the query a name" };
      q.updatedAt = Date.now();
      saved = [...saved.filter((x) => x.id !== q.id), q];
      return q as T;
    }
    case "delete_saved_query":
      saved = saved.filter((q) => q.id !== args.id);
      return undefined as T;
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
