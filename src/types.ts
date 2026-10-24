// Mirrors crates/core/src/model.rs. Keep the two in sync.

export type Engine = "postgres" | "mysql";
/** Id of an EnvironmentDef ("local", "staging", "production" or a custom one). */
export type Environment = string;

export interface EnvironmentDef {
  id: string;
  name: string;
  /** #RRGGBB */
  color: string;
  confirmWrites: boolean;
}
export type SslMode = "disable" | "prefer" | "require" | "verifyFull";
export type NetworkMode = "direct" | "sshTunnel" | "bastion";

export type SshAuth =
  | { kind: "agent"; socket?: string | null }
  | { kind: "keyFile"; path: string }
  | { kind: "password" };

export interface SshHop {
  id: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: Engine;
  environment: Environment;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  network: { mode: NetworkMode; hops: SshHop[] };
  confirmWrites: boolean;
  readOnly: boolean;
  lastUsedAt?: number | null;
}

/** One saved secret of a connection, for the show-password button. */
export type SecretField = { kind: "db" } | { kind: "hopPassword"; hopId: string } | { kind: "hopPassphrase"; hopId: string };

/** `undefined` keeps the saved value, `""` deletes it. */
export interface SecretsInput {
  dbPassword?: string;
  hops?: Record<string, { password?: string; keyPassphrase?: string }>;
}

export interface ColumnMeta {
  name: string;
  typeName: string | null;
  /** The table column the value comes from, when the server reports it. Needed for editing. */
  source?: { schema: string; table: string; column: string };
}

/** One column and its value (`null` is SQL NULL). */
export interface CellValue {
  column: string;
  value: string | null;
}

/** New values for one row, found by its primary key. */
export interface RowEdit {
  schema: string;
  table: string;
  key: CellValue[];
  values: CellValue[];
}

export interface ResultSet {
  columns: ColumnMeta[];
  rows: (string | null)[][];
  rowCount: number | null;
  truncated: boolean;
}

export interface QueryOutput {
  sets: ResultSet[];
  elapsedMs: number;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey: boolean;
  /** For foreign keys: referenced `schema.table.column`. */
  references?: string | null;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: ColumnInfo[];
}

/** A query run from a query tab, kept per connection. Mirrors crates/core/src/queries.rs. */
export interface HistoryEntry {
  id: string;
  profileId: string;
  sql: string;
  /** Unix time in milliseconds. */
  ranAt: number;
  elapsedMs: number;
  /** Rows returned or changed by the last statement, when it succeeded. */
  rows: number | null;
  /** What went wrong, when it failed. */
  error: string | null;
}

export interface SavedQuery {
  id: string;
  profileId: string;
  name: string;
  sql: string;
  /** Unix time in milliseconds of the last save. */
  updatedAt: number;
}

export interface SessionInfo {
  sessionId: string;
  profileId: string;
  serverVersion: string;
  /** The database the session is in ("" on MySQL when none is chosen). */
  database: string;
  hops: number;
}

export interface TestStep {
  label: string;
  status: "ok" | "failed" | "skipped";
  detail?: string | null;
  hint?: string | null;
  ms?: number | null;
}

export interface TestReport {
  ok: boolean;
  steps: TestStep[];
  serverVersion: string | null;
  hops: number;
  elapsedMs: number;
  error: AppError | null;
}

/** What the database server reported for a failed statement. */
export interface DbError {
  engine: "postgres" | "mysql";
  /** MySQL error number, e.g. 1054. */
  code: number | null;
  /** SQLSTATE, e.g. 42S22 or 42703. */
  sqlstate: string | null;
  severity: string | null;
  message: string;
  detail: string | null;
  hint: string | null;
  /** 1-based character position in the statement that was sent (Postgres). */
  position: number | null;
}

export interface AppError {
  kind: string;
  message: string;
  /** Statement errors: everything the server sent. */
  db?: DbError;
  /** Connect failures: the step that failed and what to try. */
  step?: string;
  hint?: string | null;
  host?: string;
  port?: number;
  fingerprint?: string;
  key?: string;
}

// ---------- Diagram canvases. Mirrors crates/core/src/diagrams.rs. ----------

export interface Point {
  x: number;
  y: number;
}

/** Which tables a canvas is about. Tables are named `schema.table`. */
export type CanvasScope =
  | { kind: "all" }
  | { kind: "pattern"; patterns: string[] }
  | { kind: "picked" }
  | { kind: "neighbours"; root: string; depth: number };

export interface CanvasNote {
  id: string;
  x: number;
  y: number;
  /** Width; the height follows the text. */
  w: number;
  text: string;
}

/** What the user chose and arranged. The tables and columns themselves always come from the database. */
export interface Canvas {
  id: string;
  name: string;
  scope: CanvasScope;
  /** Put tables that are new in the database and in scope on the canvas by themselves. */
  autoAdd: boolean;
  zoom: number;
  /** Canvas point shown at the top left of the view. */
  pan: Point;
  /** Where each table sits, by `schema.table`. A table is on the canvas when it has a position. */
  positions: Record<string, Point>;
  /** On the canvas but hidden; they keep their position. */
  hiddenTables: string[];
  hiddenColumns: Record<string, string[]>;
  notes: CanvasNote[];
  /** Column names of each table as the user last acknowledged them (for "what changed"). */
  seen: Record<string, string[]>;
  createdAt: number;
  updatedAt: number;
}
