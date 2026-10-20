import { create } from "zustand";
import { api } from "./api";
import { useCanvases } from "./canvases";
import {
  countSql,
  defaultSchema,
  isWrite,
  queryName,
  splitStatements,
  tableSql,
  type TableRef,
  type TableView,
} from "./lib/sql";
import { showToast } from "./lib/toast";
import type {
  AppError,
  ConnectionProfile,
  EnvironmentDef,
  HistoryEntry,
  QueryOutput,
  RowEdit,
  SavedQuery,
  SessionInfo,
  TableInfo,
} from "./types";

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
  /** Table tabs: the table shown, so filtering and sorting can be done by the server. */
  table?: TableRef;
  /** Table tabs: the filters, sort and page of the current query. */
  view?: TableView;
  /** Table tabs: rows matching the filters, for the count query in `sql` (`rows` is null while counting). */
  count?: { sql: string; rows: number | null };
  /** The grid has edits that are not saved yet. */
  dirty?: boolean;
  /** Query tabs opened from (or saved as) a saved query: ⌘S updates that query. */
  savedId?: string;
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
  /** Queries run on this connection, newest first. */
  history?: HistoryEntry[];
  /** Saved queries of this connection, by name. */
  saved?: SavedQuery[];
  /** What the window shows: query and table tabs, or the diagram canvases. */
  view: "query" | "diagram";
}

export type Sheet = { mode: "new" } | { mode: "edit"; profile: ConnectionProfile } | null;

/** The "Save Query" dialog, for a tab's SQL (`docId`) or SQL from the history. `id` renames or updates. */
export interface SaveSheet {
  connId: string;
  sql: string;
  name: string;
  docId?: string;
  id?: string;
}

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
  saveSheet: SaveSheet | null;

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
  /** Show the query tabs or the diagram. The diagram reads the schema again, so it is up to date. */
  setView(connId: string, view: ConnTab["view"]): void;

  newQuery(connId: string, sql?: string): void;
  openTable(connId: string, table: TableInfo): void;
  closeDoc(connId: string, docId: string): void;
  activateDoc(connId: string, docId: string): void;
  /** ⌘1 to ⌘8 show that tab, ⌘9 the last one (like browsers). */
  activateDocAt(connId: string, n: number): void;
  /** Next (+1) or previous (-1) tab, wrapping around. */
  cycleDoc(connId: string, step: 1 | -1): void;
  /** Filter and sort a table tab on the server, and run its new query. */
  setTableView(connId: string, docId: string, view: TableView): void;
  setDirty(connId: string, docId: string, dirty: boolean): void;
  /** Count the rows a table tab's filters match (only on request: it can be slow on big tables). */
  countTable(connId: string, docId: string): Promise<void>;

  loadHistory(connId: string): Promise<void>;
  loadSaved(connId: string): Promise<void>;
  /** Open SQL in a query tab (the tab of a saved query when it is open already), and run it if asked. */
  openQuery(connId: string, sql: string, opts?: { title?: string; savedId?: string; run?: boolean }): void;
  /** ⌘S in a query tab: update the saved query it belongs to, or ask for a name. */
  saveDoc(connId: string, docId: string): void;
  setSaveSheet(sheet: SaveSheet | null): void;
  /** Add or update a saved query; `docId` links that tab to it. Throws the server's error. */
  saveQuery(connId: string, query: { id?: string; name: string; sql: string }, docId?: string): Promise<SavedQuery>;
  deleteSavedQuery(connId: string, id: string): Promise<void>;
  deleteHistory(connId: string, id: string): Promise<void>;
  clearHistory(connId: string): Promise<void>;
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

const byName = (a: SavedQuery, b: SavedQuery) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });


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
  saveSheet: null,
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
    useCanvases.getState().forget(id);
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
      const tab: ConnTab = { id: info.sessionId, profile, info, docs: [first], activeDoc: first.id, view: "query" };
      set((s) => ({ conns: [...s.conns, tab], activeConn: tab.id, showWelcome: false, connecting: null }));
      get().refreshSchema(tab.id);
      get().loadHistory(tab.id);
      get().loadSaved(tab.id);
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
    const closing = get().conns.find((c) => c.id === connId);
    if (closing) useCanvases.getState().flush(closing.profile.id);
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
      const conn = get().conns.find((c) => c.id === connId);
      if (conn) useCanvases.getState().sync(conn);
    } catch (e) {
      set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, schemaError: e as AppError } : c)) }));
    }
  },

  setView(connId, view) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn || conn.view === view) return;
    set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, view } : c)) }));
    if (view === "diagram") {
      useCanvases.getState().load(conn);
      get().refreshSchema(connId);
    }
  },

  newQuery(connId, sql = "") {
    set((s) => ({
      conns: s.conns.map((c) => {
        if (c.id !== connId) return c;
        const doc = queryDoc(c.docs, sql);
        return { ...c, docs: [...c.docs, doc], activeDoc: doc.id, view: "query" };
      }),
    }));
  },

  openTable(connId, table) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn) return;
    const existing = conn.docs.find((d) => d.table?.schema === table.schema && d.table.name === table.name);
    if (existing) return get().activateDoc(connId, existing.id);
    const key = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const ref: TableRef = { schema: table.schema, name: table.name, ...(key.length ? { key } : {}) };
    const sql = tableSql(conn.profile.engine, ref);
    // Same-named tables in other schemas (public.orders, mart.orders) get the schema in their title.
    const title = table.schema === defaultSchema(conn.profile) ? table.name : `${table.schema}.${table.name}`;
    const doc: DocTab = { id: uid(), kind: "table", title, sql, running: false, showEditor: false, table: ref };
    set((s) => ({
      conns: s.conns.map((c) => (c.id === connId ? { ...c, docs: [...c.docs, doc], activeDoc: doc.id, view: "query" } : c)),
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
    set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, activeDoc: docId, view: "query" } : c)) }));
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

  setTableView(connId, docId, view) {
    const conn = get().conns.find((c) => c.id === connId);
    const doc = conn?.docs.find((d) => d.id === docId);
    if (!conn || !doc?.table) return;
    const sql = tableSql(conn.profile.engine, doc.table, view);
    set((s) => ({ conns: patchDoc(s.conns, connId, docId, { view, sql }) }));
    get().run(connId, docId, sql, true);
  },

  async countTable(connId, docId) {
    const conn = get().conns.find((c) => c.id === connId);
    const doc = conn?.docs.find((d) => d.id === docId);
    if (!conn || !doc?.table) return;
    const sql = countSql(conn.profile.engine, doc.table, doc.view);
    set((s) => ({ conns: patchDoc(s.conns, connId, docId, { count: { sql, rows: null } }) }));
    try {
      const out = await api.runQuery(connId, sql);
      const rows = Number(out.sets[0]?.rows[0]?.[0]);
      set((s) => ({ conns: patchDoc(s.conns, connId, docId, { count: Number.isFinite(rows) ? { sql, rows } : undefined }) }));
    } catch (e) {
      set((s) => ({ conns: patchDoc(s.conns, connId, docId, { count: undefined }) }));
      showToast(`Couldn't count the rows: ${(e as AppError).message}`, "error");
    }
  },

  setDirty(connId, docId, dirty) {
    const doc = get().conns.find((c) => c.id === connId)?.docs.find((d) => d.id === docId);
    if (doc && !!doc.dirty !== dirty) set((s) => ({ conns: patchDoc(s.conns, connId, docId, { dirty }) }));
  },

  setSql(connId, docId, sql) {
    set((s) => ({ conns: patchDoc(s.conns, connId, docId, { sql }) }));
  },

  async run(connId, docId, sql, confirmed = false) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn || !sql.trim()) return;
    // What runs from a query tab goes into the history; browsing a table doesn't.
    const record = conn.docs.find((d) => d.id === docId)?.kind === "query";
    if (!confirmed && conn.profile.confirmWrites && splitStatements(sql).some((s) => isWrite(s.text))) {
      set({ pendingWrite: { connId, docId, sql } });
      return;
    }
    set((s) => ({ conns: patchDoc(s.conns, connId, docId, { running: true, error: undefined }) }));
    try {
      const output = await api.runQuery(connId, sql, record);
      set((s) => ({ conns: patchDoc(s.conns, connId, docId, { running: false, output, lastRun: sql }) }));
      if (splitStatements(sql).some((s) => /^\s*(create|alter|drop|rename)\b/i.test(s.text))) get().refreshSchema(connId);
    } catch (e) {
      set((s) => ({ conns: patchDoc(s.conns, connId, docId, { running: false, error: e as AppError, lastRun: sql }) }));
    }
    if (record) get().loadHistory(connId);
  },

  async loadHistory(connId) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn) return;
    const history = await api.listHistory(conn.profile.id).catch(() => conn.history ?? []);
    set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, history } : c)) }));
  },

  async loadSaved(connId) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn) return;
    const saved = await api.listSavedQueries(conn.profile.id).catch(() => conn.saved ?? []);
    set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, saved } : c)) }));
  },

  openQuery(connId, sql, opts = {}) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn) return;
    const open = opts.savedId ? conn.docs.find((d) => d.savedId === opts.savedId) : undefined;
    const doc = open ?? { ...queryDoc(conn.docs, sql), ...(opts.title ? { title: opts.title } : {}), savedId: opts.savedId };
    set((s) => ({
      conns: s.conns.map((c) =>
        c.id !== connId ? c : { ...c, docs: open ? c.docs : [...c.docs, doc], activeDoc: doc.id, view: "query" },
      ),
    }));
    if (opts.run) get().run(connId, doc.id, doc.sql);
  },

  saveDoc(connId, docId) {
    const conn = get().conns.find((c) => c.id === connId);
    const doc = conn?.docs.find((d) => d.id === docId);
    if (!conn || !doc) return;
    if (!doc.sql.trim()) return showToast("Write some SQL first, then save it.", "error");
    const linked = conn.saved?.find((q) => q.id === doc.savedId);
    if (!linked) return set({ saveSheet: { connId, docId, sql: doc.sql, name: queryName(doc.sql) } });
    get()
      .saveQuery(connId, { id: linked.id, name: linked.name, sql: doc.sql }, docId)
      .then((q) => showToast(`Saved “${q.name}”`))
      .catch((e: AppError) => showToast(`Couldn't save: ${e.message}`, "error"));
  },

  setSaveSheet(saveSheet) {
    set({ saveSheet });
  },

  async saveQuery(connId, query, docId) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn) throw { kind: "noSession", message: "This connection is closed" } satisfies AppError;
    const saved = await api.saveQuery({
      id: query.id ?? uid(),
      profileId: conn.profile.id,
      name: query.name,
      sql: query.sql,
      updatedAt: 0,
    });
    set((s) => ({
      conns: s.conns.map((c) =>
        c.id !== connId
          ? c
          : {
              ...c,
              saved: [...(c.saved ?? []).filter((q) => q.id !== saved.id), saved].sort(byName),
              // The saving tab, and any tab already showing this query, take its name.
              docs: c.docs.map((d) => (d.id === docId || d.savedId === saved.id ? { ...d, savedId: saved.id, title: saved.name } : d)),
            },
      ),
    }));
    return saved;
  },

  async deleteSavedQuery(connId, id) {
    const conn = get().conns.find((c) => c.id === connId);
    const query = conn?.saved?.find((q) => q.id === id);
    if (!conn || !query) return;
    await api.deleteSavedQuery(id);
    set((s) => ({
      conns: s.conns.map((c) =>
        c.id !== connId
          ? c
          : {
              ...c,
              saved: (c.saved ?? []).filter((q) => q.id !== id),
              docs: c.docs.map((d) => (d.savedId === id ? { ...d, savedId: undefined } : d)),
            },
      ),
    }));
    showToast(`Deleted “${query.name}”`, "ok", {
      label: "Undo",
      run: () => get().saveQuery(connId, query).catch((e: AppError) => showToast(`Couldn't restore: ${e.message}`, "error")),
    });
  },

  async deleteHistory(connId, id) {
    await api.deleteHistory(id);
    set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, history: c.history?.filter((e) => e.id !== id) } : c)) }));
  },

  async clearHistory(connId) {
    const conn = get().conns.find((c) => c.id === connId);
    if (!conn) return;
    await api.clearHistory(conn.profile.id);
    set((s) => ({ conns: s.conns.map((c) => (c.id === connId ? { ...c, history: [] } : c)) }));
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
