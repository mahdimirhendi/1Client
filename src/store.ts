import { create } from "zustand";
import { api } from "./api";
import { isWrite, splitStatements, tableSql, type Sort, type TableRef } from "./lib/sql";
import type { AppError, ConnectionProfile, EnvironmentDef, QueryOutput, RowEdit, SessionInfo, TableInfo } from "./types";

/** A tab inside a connection: a query, or a table opened from the sidebar. */
export interface DocTab {
  id: string;
  kind: "query" | "table";
  title: string;
  sql: string;
  running: boolean;
  output?: QueryOutput;
  error?: AppError;
  /** Statement that produced `output`, for the results header. */
  lastRun?: string;
  /** SQL editor visible. Query tabs start with it open, table tabs closed. */
  showEditor: boolean;
  /** Table tabs: the table shown, so sorting can be done by the server. */
  table?: TableRef;
  /** Table tabs: the ORDER BY of the current query. */
  sort?: Sort;
}

/** A top-level tab: one open connection with its own inner tabs. */
export interface ConnTab {
  id: string; // session id
  profile: ConnectionProfile;
  info: SessionInfo;
  /** May be empty: closing the last tab leaves the connection open. */
  docs: DocTab[];
  /** Id of the shown tab, "" when there is none. */
  activeDoc: string;
  schema?: TableInfo[];
  schemaError?: AppError;
}

export type Sheet = { mode: "new" } | { mode: "edit"; profile: ConnectionProfile } | null;

export interface PendingWrite {
  connId: string;
  docId: string;
  sql: string;
  /** Runs instead of `sql` when confirmed (saving grid edits). */
  onConfirm?: () => void;
  onCancel?: () => void;
}

/** Result of saving grid edits. */
export type SaveResult = { ok: true } | { ok: false; cancelled?: boolean; error?: string };

interface State {
  profiles: ConnectionProfile[];
  conns: ConnTab[];
  activeConn: string | null;
  showWelcome: boolean;
  sheet: Sheet;
  connecting: string | null;
  connectError: AppError | null;
  pendingWrite: PendingWrite | null;
  environments: EnvironmentDef[];
  envSheet: boolean;
  /** Connections opened from links, not saved. Keyed by profile id. */
  temporary: Record<string, ConnectionProfile>;

  loadProfiles(): Promise<void>;
  loadEnvironments(): Promise<void>;
  saveEnvironments(list: EnvironmentDef[]): Promise<void>;
  setEnvSheet(open: boolean): void;
  deleteProfile(id: string): Promise<void>;
  setSheet(sheet: Sheet): void;
  setShowWelcome(v: boolean): void;
  openConnection(profileId: string): Promise<void>;
  receiveLinks(): Promise<void>;
  saveTemporary(connId: string): Promise<void>;
  toggleEditor(connId: string, docId: string): void;
  closeConnection(connId: string): Promise<void>;
  activateConn(connId: string): void;
  refreshSchema(connId: string): Promise<void>;

  newQuery(connId: string, sql?: string): void;
  openTable(connId: string, table: TableInfo): void;
  closeDoc(connId: string, docId: string): void;
  activateDoc(connId: string, docId: string): void;
  /** ⌘1 to ⌘8 show that tab, ⌘9 the last one (like browsers). */
  activateDocAt(connId: string, n: number): void;
  /** Next (+1) or previous (-1) tab, wrapping around. */
  cycleDoc(connId: string, step: 1 | -1): void;
  /** Sort a table tab on the server, or `null` for the table's own order. */
  sortTable(connId: string, docId: string, sort: Sort | null): void;
  setSql(connId: string, docId: string, sql: string): void;
  run(connId: string, docId: string, sql: string, confirmed?: boolean): Promise<void>;
  setPendingWrite(p: PendingWrite | null): void;
  /** Save edited cells of a result. Asks first when the connection confirms writes. */
  saveEdits(connId: string, docId: string, setIdx: number, edits: RowEdit[], changes: [number, number, string | null][]): Promise<SaveResult>;
}

const uid = () => crypto.randomUUID();

/** "Query N" with the lowest N that no open query tab of the connection uses. */
function nextQueryTitle(docs: DocTab[]): string {
  const used = new Set(docs.filter((d) => d.kind === "query").map((d) => Number(/^Query (\d+)$/.exec(d.title)?.[1])));
  let n = 1;
  while (used.has(n)) n++;
  return `Query ${n}`;
}

function queryDoc(docs: DocTab[], sql = ""): DocTab {
  return { id: uid(), kind: "query", title: nextQueryTitle(docs), sql, running: false, showEditor: true };
}

/** The schema a connection works in by default; its tables are shown without a schema prefix. */
function defaultSchema(profile: ConnectionProfile): string {
  return profile.engine === "postgres" ? "public" : profile.database;
}

function patchDoc(conns: ConnTab[], connId: string, docId: string, patch: Partial<DocTab>): ConnTab[] {
  return conns.map((c) =>
    c.id !== connId ? c : { ...c, docs: c.docs.map((d) => (d.id === docId ? { ...d, ...patch } : d)) },
  );
}

export const useApp = create<State>((set, get) => ({
  profiles: [],
  conns: [],
  activeConn: null,
  showWelcome: true,
  sheet: null,
  connecting: null,
  connectError: null,
  pendingWrite: null,
  temporary: {},
  environments: [],
  envSheet: false,

  async loadProfiles() {
    set({ profiles: await api.listConnections() });
  },

  async loadEnvironments() {
    set({ environments: await api.listEnvironments() });
  },

  async saveEnvironments(list) {
    const environments = await api.saveEnvironments(list);
    set({ environments });
    // Connections in a removed environment were moved to Local by the backend.
    await get().loadProfiles();
    const byId = new Map(get().profiles.map((p) => [p.id, p]));
    set((s) => ({ conns: s.conns.map((c) => ({ ...c, profile: byId.get(c.profile.id) ?? c.profile })) }));
  },

  setEnvSheet(open) {
    set({ envSheet: open });
  },

  async deleteProfile(id) {
    await api.deleteConnection(id);
    await get().loadProfiles();
  },

  setSheet(sheet) {
    set({ sheet });
  },

  setShowWelcome(v) {
    set({ showWelcome: v });
  },

  async openConnection(profileId) {
    const profile = get().profiles.find((p) => p.id === profileId) ?? get().temporary[profileId];
    if (!profile) return;
    set({ connecting: profileId, connectError: null });
    try {
      const info = await api.openSession(profileId);
      const first = queryDoc([]);
      const tab: ConnTab = { id: info.sessionId, profile, info, docs: [first], activeDoc: first.id };
      set((s) => ({ conns: [...s.conns, tab], activeConn: tab.id, showWelcome: false, connecting: null }));
      get().refreshSchema(tab.id);
      get().loadProfiles();
    } catch (e) {
      set({ connecting: null, connectError: e as AppError });
    }
  },

  async receiveLinks() {
    const events = await api.takePendingLinks().catch(() => []);
    for (const ev of events) {
      if (ev.error || !ev.profile) {
        set({ connectError: { kind: "config", message: ev.error ?? "The link could not be opened" }, showWelcome: true });
        continue;
      }
      const p = ev.profile;
      // Same database already open: just show that tab.
      const existing = get().conns.find((c) => sameTarget(c.profile, p));
      if (existing) {
        get().activateConn(existing.id);
        continue;
      }
      set((s) => ({ temporary: { ...s.temporary, [p.id]: p } }));
      await get().openConnection(p.id);
    }
  },

  async saveTemporary(connId) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn || !get().temporary[conn.profile.id]) return;
    const saved = await api.saveTempConnection(conn.profile.id);
    set((s) => {
      const temporary = { ...s.temporary };
      delete temporary[saved.id];
      return { temporary };
    });
    await get().loadProfiles();
  },

  toggleEditor(connId, docId) {
    const doc = get().conns.find((c) => c.id === connId)?.docs.find((d) => d.id === docId);
    if (doc) set((s) => ({ conns: patchDoc(s.conns, connId, docId, { showEditor: !doc.showEditor }) }));
  },

  async closeConnection(connId) {
    await api.closeSession(connId).catch(() => {});
    set((s) => {
      const conns = s.conns.filter((c) => c.id !== connId);
      const activeConn = s.activeConn === connId ? (conns.at(-1)?.id ?? null) : s.activeConn;
      return { conns, activeConn, showWelcome: conns.length === 0 ? true : s.showWelcome };
    });
  },

  activateConn(connId) {
    set({ activeConn: connId, showWelcome: false });
  },

  async refreshSchema(connId) {
    try {
      const schema = await api.introspect(connId);
      set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, schema, schemaError: undefined } : c)) }));
    } catch (e) {
      set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, schemaError: e as AppError } : c)) }));
    }
  },

  newQuery(connId, sql = "") {
    set((s) => ({
      conns: s.conns.map((c) => {
        if (c.id !== connId) return c;
        const doc = queryDoc(c.docs, sql);
        return { ...c, docs: [...c.docs, doc], activeDoc: doc.id };
      }),
    }));
  },

  openTable(connId, table) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn) return;
    const existing = conn.docs.find((d) => d.table?.schema === table.schema && d.table.name === table.name);
    if (existing) return get().activateDoc(connId, existing.id);
    const ref = { schema: table.schema, name: table.name };
    const sql = tableSql(conn.profile.engine, ref);
    // Same-named tables in other schemas (public.orders, mart.orders) get the schema in their title.
    const title = table.schema === defaultSchema(conn.profile) ? table.name : `${table.schema}.${table.name}`;
    const doc: DocTab = { id: uid(), kind: "table", title, sql, running: false, showEditor: false, table: ref };
    set((s) => ({
      conns: s.conns.map((c) => (c.id === connId ? { ...c, docs: [...c.docs, doc], activeDoc: doc.id } : c)),
    }));
    get().run(connId, doc.id, sql, true);
  },

  closeDoc(connId, docId) {
    set((s) => ({
      conns: s.conns.map((c) => {
        const i = c.docs.findIndex((d) => d.id === docId);
        if (c.id !== connId || i < 0) return c;
        const docs = c.docs.filter((d) => d.id !== docId);
        // Like a browser: closing the shown tab shows the one to its right, or else to its left.
        const activeDoc = c.activeDoc !== docId ? c.activeDoc : (docs[Math.min(i, docs.length - 1)]?.id ?? "");
        return { ...c, docs, activeDoc };
      }),
    }));
  },

  activateDoc(connId, docId) {
    set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, activeDoc: docId } : c)) }));
  },

  activateDocAt(connId, n) {
    const docs = get().conns.find((c) => c.id === connId)?.docs ?? [];
    const doc = n === 9 ? docs.at(-1) : docs[n - 1];
    if (doc) get().activateDoc(connId, doc.id);
  },

  cycleDoc(connId, step) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn || conn.docs.length === 0) return;
    const i = conn.docs.findIndex((d) => d.id === conn.activeDoc);
    const next = conn.docs[(i + step + conn.docs.length) % conn.docs.length];
    get().activateDoc(connId, next.id);
  },

  sortTable(connId, docId, sort) {
    const conn = get().conns.find((c) => c.id === connId);
    const doc = conn?.docs.find((d) => d.id === docId);
    if (!conn || !doc?.table) return;
    const sql = tableSql(conn.profile.engine, doc.table, sort);
    set((s) => ({ conns: patchDoc(s.conns, connId, docId, { sort: sort ?? undefined, sql }) }));
    get().run(connId, docId, sql, true);
  },

  setSql(connId, docId, sql) {
    set((s) => ({ conns: patchDoc(s.conns, connId, docId, { sql }) }));
  },

  async run(connId, docId, sql, confirmed = false) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn || !sql.trim()) return;
    if (!confirmed && conn.profile.confirmWrites && splitStatements(sql).some((s) => isWrite(s.text))) {
      set({ pendingWrite: { connId, docId, sql } });
      return;
    }
    set((s) => ({ conns: patchDoc(s.conns, connId, docId, { running: true, error: undefined }) }));
    try {
      const output = await api.runQuery(connId, sql);
      set((s) => ({ conns: patchDoc(s.conns, connId, docId, { running: false, output, lastRun: sql }) }));
      if (splitStatements(sql).some((s) => /^\s*(create|alter|drop|rename)\b/i.test(s.text))) get().refreshSchema(connId);
    } catch (e) {
      set((s) => ({ conns: patchDoc(s.conns, connId, docId, { running: false, error: e as AppError, lastRun: sql }) }));
    }
  },

  setPendingWrite(p) {
    set({ pendingWrite: p });
  },

  async saveEdits(connId, docId, setIdx, edits, changes) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn || edits.length === 0) return { ok: true };
    const apply = async (): Promise<SaveResult> => {
      try {
        await api.applyEdits(connId, edits);
      } catch (e) {
        return { ok: false, error: (e as AppError).message ?? String(e) };
      }
      // Show the saved values without running the query again (keeps row order and scroll).
      set((s) => ({
        conns: s.conns.map((c) =>
          c.id !== connId
            ? c
            : {
                ...c,
                docs: c.docs.map((d) => {
                  if (d.id !== docId || !d.output) return d;
                  const sets = d.output.sets.map((rs, i) => {
                    if (i !== setIdx) return rs;
                    const rows = rs.rows.map((r) => r);
                    for (const [r, ci, v] of changes) {
                      rows[r] = rows[r] === rs.rows[r] ? [...rs.rows[r]] : rows[r];
                      rows[r][ci] = v;
                    }
                    return { ...rs, rows };
                  });
                  return { ...d, output: { ...d.output, sets } };
                }),
              },
        ),
      }));
      return { ok: true };
    };
    if (!conn.profile.confirmWrites) return apply();
    const sql = await api.previewEdits(connId, edits).catch(() => "");
    return new Promise<SaveResult>((resolve) => {
      set({
        pendingWrite: {
          connId,
          docId,
          sql,
          onConfirm: () => apply().then(resolve),
          onCancel: () => resolve({ ok: false, cancelled: true }),
        },
      });
    });
  },
}));

/** Same engine, user, host, port, database and SSH route. */
function sameTarget(a: ConnectionProfile, b: ConnectionProfile): boolean {
  const key = (p: ConnectionProfile) =>
    [
      p.engine,
      p.user,
      p.host.toLowerCase(),
      p.port,
      p.database,
      p.network.mode === "direct" ? "" : p.network.hops.map((h) => `${h.user}@${h.host}:${h.port}`).join(">"),
    ].join("|");
  return key(a) === key(b);
}
