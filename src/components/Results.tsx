import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { copyWithFeedback } from "../lib/clipboard";
import { buildRowEdits, cellKey, editableColumns, type Changes } from "../lib/edit";
import { NUMERIC_TYPE, sortedRows, type SortDir } from "../lib/sort";
import { countSql, TABLE_ROWS, tableSql, type Filter } from "../lib/sql";
import { showToast } from "../lib/toast";
import { useApp, type ConnTab, type DocTab } from "../store";
import type { AppError, ResultSet } from "../types";
import { openMenu } from "./ContextMenu";
import { ReplaceHostKey } from "./ReplaceHostKey";
import { exact } from "../lib/input";

type View = "table" | "json";
const VIEW_KEY = "oneclient.resultsView";
const savedView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === "json" ? "json" : "table";
  } catch {
    return "table";
  }
};

/** Table or JSON, shared by all tabs and the View menu. */
export const useResultsView = create<{ view: View; setView(v: View): void }>((set) => ({
  view: savedView(),
  setView(view) {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* per-device convenience only */
    }
    set({ view });
  },
}));

const BOOL = /^(bool|boolean)$/;
const JSONISH = /^(json|jsonb)$/;

/** A row as an object, with numbers, booleans and JSON columns typed. */
function rowObject(set: ResultSet, row: (string | null)[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  set.columns.forEach((c, i) => {
    const v = row[i];
    const t = (c.typeName ?? "").toLowerCase();
    let out: unknown = v;
    if (v !== null) {
      if (NUMERIC_TYPE.test(t) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v) && Number.isSafeInteger(Math.trunc(Number(v)))) out = Number(v);
      else if (BOOL.test(t)) out = v === "t" || v === "true" || v === "1";
      else if (JSONISH.test(t)) {
        try {
          out = JSON.parse(v);
        } catch {
          out = v;
        }
      }
    }
    o[c.name] = out;
  });
  return o;
}

export function Results({ conn, doc }: { conn: ConnTab; doc: DocTab }) {
  const [setIdx, setSetIdx] = useState(0);
  const { view, setView: chooseView } = useResultsView();
  const sets = doc.output?.sets ?? [];
  const idx = Math.min(setIdx, Math.max(0, sets.length - 1));
  const current = sets[idx];

  return (
    <section className="results">
      <div className="results-bar">
        {sets.length > 1 ? (
          <div className="segmented">
            {sets.map((_, i) => (
              <button
                key={i}
                className={i === idx ? "on" : ""}
                onClick={() =>
                  i !== idx && doc.dirty ? showToast("Save or discard your changes before showing another result.", "error") : setSetIdx(i)
                }
              >
                Result {i + 1}
              </button>
            ))}
          </div>
        ) : (
          <div className="results-title">Results</div>
        )}
        <div className="grow" />
        <div className="muted small">{summary(doc, current)}</div>
        {current && current.columns.length > 0 && (
          <div className="segmented small" role="tablist" aria-label="Result view">
            <button role="tab" aria-selected={view === "table"} className={view === "table" ? "on" : ""} onClick={() => chooseView("table")}>
              Table
            </button>
            <button role="tab" aria-selected={view === "json"} className={view === "json" ? "on" : ""} onClick={() => chooseView("json")}>
              JSON
            </button>
          </div>
        )}
      </div>

      {doc.error ? (
        <ErrorView
          error={doc.error}
          sql={doc.lastRun}
          onRetry={() => doc.lastRun && useApp.getState().run(conn.id, doc.id, doc.lastRun, doc.kind === "table")}
        />
      ) : !current ? (
        <div className="empty">{doc.running ? "Running…" : "Run a statement with ⌘↵ to see results here."}</div>
      ) : current.columns.length === 0 ? (
        <div className="empty">
          {current.rowCount ?? 0} row{current.rowCount === 1 ? "" : "s"} affected
        </div>
      ) : view === "json" ? (
        <JsonView set={current} />
      ) : (
        <>
          <Grid conn={conn} doc={doc} set={current} setIdx={idx} />
          {isTableView(conn, doc) && <TablePager conn={conn} doc={doc} shown={current.rows.length} />}
        </>
      )}
    </section>
  );
}

/** A table tab still running its own query: filtering, sorting and paging happen on the server. */
const isTableView = (conn: ConnTab, doc: DocTab) =>
  !!doc.table && doc.sql === tableSql(conn.profile.engine, doc.table, doc.view);

/** Pages of a table tab, `TABLE_ROWS` at a time from the server, and the row count on request. */
function TablePager({ conn, doc, shown }: { conn: ConnTab; doc: DocTab; shown: number }) {
  const { setTableView, countTable } = useApp();
  const page = doc.view?.page ?? 0;
  const first = page * TABLE_ROWS;
  // A count made for other filters says nothing about these.
  const count = doc.count?.sql === countSql(conn.profile.engine, doc.table!, doc.view) ? doc.count : undefined;
  const total = count?.rows ?? null;
  const lastPage = total === null ? null : Math.max(0, Math.ceil(total / TABLE_ROWS) - 1);
  const hasNext = lastPage === null ? shown === TABLE_ROWS : page < lastPage;

  const go = (p: number) => {
    if (doc.dirty) return showToast("Save or discard your changes before changing pages.", "error");
    setTableView(conn.id, doc.id, { ...doc.view, page: p || undefined });
  };

  return (
    <div className="pager table-pager">
      {count ? (
        <span className="muted small">{total === null ? "Counting…" : `${total.toLocaleString()} row${total === 1 ? "" : "s"}`}</span>
      ) : (
        <button className="btn small" title="Count the rows that match the filters" onClick={() => countTable(conn.id, doc.id)}>
          Count Rows
        </button>
      )}
      <div className="grow" />
      <span className="muted small">
        {shown ? `Rows ${(first + 1).toLocaleString()}–${(first + shown).toLocaleString()}` : page ? "No rows on this page" : "No rows"}
        {total !== null && shown ? ` of ${total.toLocaleString()}` : ""}
      </span>
      <div className="pager-nav">
        <button className="btn small" aria-label="First page" disabled={page === 0} onClick={() => go(0)}>
          «
        </button>
        <button className="btn small" aria-label="Previous page" disabled={page === 0} onClick={() => go(page - 1)}>
          ‹
        </button>
        <span className="small pager-count">{page + 1}</span>
        <button className="btn small" aria-label="Next page" disabled={!hasNext} onClick={() => go(page + 1)}>
          ›
        </button>
        {lastPage !== null && (
          <button className="btn small" aria-label="Last page" disabled={page >= lastPage} onClick={() => go(lastPage)}>
            »
          </button>
        )}
      </div>
    </div>
  );
}

function summary(doc: DocTab, set?: ResultSet) {
  if (doc.running) return "Running…";
  if (!doc.output || !set) return "";
  const n = set.columns.length ? set.rows.length : (set.rowCount ?? 0);
  const label = set.columns.length ? `${n.toLocaleString()} row${n === 1 ? "" : "s"}` : `${n} affected`;
  return `${label}${set.truncated ? " (first 10,000 shown)" : ""} · ${doc.output.elapsedMs} ms`;
}

const ROW_H = 28;

/** A sort of the loaded rows. The name guards against a re-run that moved the column. */
type LocalSort = { col: number; name: string; dir: SortDir };

/** A cell being edited. `isNull` is the NULL checkbox; `draft` is kept while it is ticked. */
type Editing = { r: number; c: number; draft: string; isNull: boolean };

function Grid({ conn, doc, set, setIdx }: { conn: ConnTab; doc: DocTab; set: ResultSet; setIdx: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const saveEdits = useApp((s) => s.saveEdits);
  const setTableView = useApp((s) => s.setTableView);
  const setEdits = useApp((s) => s.setEdits);
  // Rows are addressed by their index in `set.rows` everywhere (selection, edits); sorting
  // only changes the order they are shown in.
  const [sel, setSel] = useState<[number, number] | null>(null);
  // Unsaved edits made on this result before the grid was last shown come back.
  const [changes, setChanges] = useState<Changes>(() => (doc.edits?.set === set ? doc.edits.changes : new Map()));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Shown in the edit bar: why saving (or sorting) didn't work. */
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [localSort, setLocalSort] = useState<LocalSort | null>(null);

  const cols = useMemo(() => editableColumns(set, conn.schema, conn.profile), [set, conn.schema, conn.profile]);

  // A table tab still running its own query is filtered and sorted by the server, so both cover
  // the whole table and not just the loaded rows. Any other result sorts the rows it has.
  const serverView = isTableView(conn, doc);
  /** Row numbers continue across the pages of a table tab (page 2 starts at 201). */
  const firstRow = serverView ? (doc.view?.page ?? 0) * TABLE_ROWS : 0;

  /** Display position → row index. */
  const order = useMemo(() => {
    const s = !serverView && localSort && set.columns[localSort.col]?.name === localSort.name ? localSort : null;
    return s ? sortedRows(set, s.col, s.dir) : set.rows.map((_, i) => i);
  }, [set, localSort, serverView]);
  /** Row index → display position. */
  const position = useMemo(() => {
    const p: number[] = [];
    order.forEach((r, i) => (p[r] = i));
    return p;
  }, [order]);

  const sortDir = (ci: number): SortDir | null => {
    const name = set.columns[ci].name;
    if (serverView) return doc.view?.sort?.column === name ? doc.view.sort.dir : null;
    return localSort?.col === ci && localSort.name === name ? localSort.dir : null;
  };

  /** Click on a header: ascending, then descending, then back to the original order. */
  const toggleSort = (ci: number) => {
    const cur = sortDir(ci);
    const dir: SortDir | null = cur === null ? "asc" : cur === "asc" ? "desc" : null;
    const name = set.columns[ci].name;
    if (!serverView) return setLocalSort(dir ? { col: ci, name, dir } : null);
    if (changes.size) return setEditError("Save or discard your changes before sorting the table.");
    setTableView(conn.id, doc.id, { ...doc.view, sort: dir ? { column: name, dir } : undefined, page: undefined });
  };

  /** Show only the rows where this column has (or, with `exclude`, doesn't have) this value. */
  const filterBy = (ci: number, v: string | null, exclude = false) => {
    if (changes.size) return setEditError("Save or discard your changes before filtering the table.");
    const op = v === null ? (exclude ? "notNull" : "isNull") : exclude ? "ne" : "eq";
    const filter: Filter = { column: set.columns[ci].name, op, value: v ?? "" };
    // Added to the column filters, so a condition typed in SQL mode makes way for them.
    setTableView(conn.id, doc.id, { ...doc.view, where: undefined, filters: [...(doc.view?.filters ?? []), filter], page: undefined });
  };

  // Unsaved edits are kept with the tab: the filter bar and the pager wait for them, and they are
  // still here when the grid is shown again.
  useEffect(() => {
    setEdits(conn.id, doc.id, changes.size ? { set, changes } : undefined);
  }, [changes, set, conn.id, doc.id, setEdits]);

  // A new result (saved edits, another result of the same run) starts clean; the selection stays if
  // it still fits.
  const shownSet = useRef(set);
  useEffect(() => {
    if (shownSet.current === set) return;
    shownSet.current = set;
    setChanges(new Map());
    setEditing(null);
    setEditError(null);
    setSel((s) => (s && s[0] < set.rows.length && s[1] < set.columns.length ? s : null));
  }, [set]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const widths = useMemo(
    () =>
      set.columns.map((c, ci) => {
        let max = Math.max(c.name.length, (c.typeName ?? "").length);
        for (let r = 0; r < Math.min(set.rows.length, 200); r++) max = Math.max(max, (set.rows[r][ci] ?? "NULL").length);
        return Math.min(360, Math.max(80, max * 7.4 + 24));
      }),
    [set],
  );
  const template = `48px ${widths.map((w) => `${w}px`).join(" ")}`;
  const total = 48 + widths.reduce((a, b) => a + b, 0);

  const rows = useVirtualizer({
    count: order.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const value = (r: number, c: number) => {
    const k = cellKey(r, c);
    return changes.has(k) ? changes.get(k)! : set.rows[r][c];
  };

  /** Start editing a cell, or say why it can't be edited. */
  const startEdit = (r: number, c: number, initial?: string) => {
    const col = cols[c];
    if (col.reason) {
      setNotice(col.reason);
      return;
    }
    const v = value(r, c);
    if (v !== null && /^0x[0-9a-f]*…$/.test(v)) {
      setNotice("Binary values can't be edited in the grid.");
      return;
    }
    setSel([r, c]);
    // Typing on a cell starts with that key; opening a NULL cell starts with NULL ticked.
    setEditing({ r, c, draft: initial ?? v ?? "", isNull: initial === undefined && v === null });
  };

  const setCell = (r: number, c: number, v: string | null) => {
    setChanges((m) => {
      const n = new Map(m);
      if (v === set.rows[r][c]) n.delete(cellKey(r, c));
      else n.set(cellKey(r, c), v);
      return n;
    });
    setEditError(null);
  };

  const setNull = (r: number, c: number) => {
    if (cols[c].reason) setNotice(cols[c].reason!);
    else if (!cols[c].nullable) setNotice(`${cols[c].column} can't be NULL (the column is NOT NULL).`);
    else setCell(r, c, null);
  };

  const commit = () => {
    if (!editing) return;
    const { r, c, draft, isNull } = editing;
    setCell(r, c, isNull ? null : draft);
    setEditing(null);
    scroller.current?.focus();
  };

  /** Move the selection by rows and columns as they are shown (sorted or not). */
  const move = (dr: number, dc: number) => {
    if (!order.length) return;
    const [r, c] = sel ?? [order[0], 0];
    const i = Math.max(0, Math.min(order.length - 1, position[r] + dr));
    const nc = Math.max(0, Math.min(set.columns.length - 1, c + dc));
    setSel([order[i], nc]);
    rows.scrollToIndex(i);
  };

  const save = async () => {
    if (!changes.size || saving) return;
    setSaving(true);
    const edits = buildRowEdits(set, cols, changes);
    const list = [...changes].map(([k, v]) => {
      const [r, c] = k.split(":").map(Number);
      return [r, c, v] as [number, number, string | null];
    });
    const res = await saveEdits(conn.id, doc.id, setIdx, edits, list);
    setSaving(false);
    if (res.ok) setChanges(new Map());
    else if (res.error) setEditError(res.error);
    scroller.current?.focus();
  };

  const discard = () => {
    setChanges(new Map());
    setEditError(null);
  };

  return (
    <div className="grid-wrap">
      <div
        className="grid-scroll"
        ref={scroller}
        tabIndex={0}
        onKeyDown={(e) => {
          if (editing) return;
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save();
          } else if (mod && e.key.toLowerCase() === "c" && sel) {
            e.preventDefault();
            copyWithFeedback(value(sel[0], sel[1]) ?? "NULL", "value");
          } else if (mod && (e.key === "Backspace" || e.key === "Delete") && sel) {
            e.preventDefault();
            setNull(sel[0], sel[1]);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0, e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0);
          } else if (e.key === "Tab" && sel && !mod) {
            e.preventDefault();
            move(0, e.shiftKey ? -1 : 1);
          } else if ((e.key === "Enter" || e.key === "F2") && sel) {
            e.preventDefault();
            startEdit(sel[0], sel[1]);
          } else if (e.key === "Escape") {
            setSel(null);
          } else if (sel && !mod && !e.altKey && e.key.length === 1 && !cols[sel[1]].reason) {
            // Typing on a selected cell replaces its value, like a spreadsheet.
            e.preventDefault();
            startEdit(sel[0], sel[1], e.key);
          }
        }}
      >
        <div style={{ width: total, minWidth: "100%" }}>
          <div className="grid-head" style={{ gridTemplateColumns: template }}>
            <div />
            {set.columns.map((c, i) => {
              const dir = sortDir(i);
              const about = cols[i].reason ? `Read-only: ${cols[i].reason}` : `${cols[i].table}.${cols[i].column}`;
              const next = dir === null ? "ascending" : dir === "asc" ? "descending" : "the original order";
              return (
                <button
                  key={i}
                  className={`grid-hcell ${NUMERIC_TYPE.test(c.typeName ?? "") ? "num" : ""}`}
                  title={`${about}\nClick to sort ${next}`}
                  aria-label={`${c.name}${dir ? `, sorted ${dir === "asc" ? "ascending" : "descending"}` : ""}. Sort ${next}`}
                  onClick={() => toggleSort(i)}
                >
                  <span className="grid-hname">
                    <span className="strong ellipsis">{c.name}</span>
                    {dir && <span className="sort-arrow">{dir === "asc" ? "▲" : "▼"}</span>}
                  </span>
                  <span className="mono type ellipsis">{c.typeName ?? ""}</span>
                </button>
              );
            })}
          </div>
          <div style={{ height: rows.getTotalSize(), position: "relative" }}>
            {rows.getVirtualItems().map((vr) => {
              const r = order[vr.index];
              return (
                <div
                  key={vr.key}
                  className={`grid-row ${vr.index % 2 ? "alt" : ""}`}
                  style={{ gridTemplateColumns: template, transform: `translateY(${vr.start}px)` }}
                >
                  <div className="grid-num">{firstRow + vr.index + 1}</div>
                  {set.columns.map((col, ci) => {
                    const v = value(r, ci);
                    const selected = sel?.[0] === r && sel?.[1] === ci;
                    const changed = changes.has(cellKey(r, ci));
                    const isEditing = editing?.r === r && editing.c === ci;
                    const ce = cols[ci];
                    return (
                      <div
                        key={ci}
                        className={`grid-cell ${NUMERIC_TYPE.test(col.typeName ?? "") ? "num" : ""} ${selected ? "sel" : ""} ${changed ? "changed" : ""} ${isEditing ? "editing" : ""}`}
                        onClick={() => setSel([r, ci])}
                        onDoubleClick={() => startEdit(r, ci)}
                        onContextMenu={(e) => {
                          setSel([r, ci]);
                          const row = set.rows[r].map((_, i) => value(r, i));
                          openMenu(e, [
                            ...(ce.reason
                              ? []
                              : [
                                  { label: "Edit Value", shortcut: "↩", action: () => startEdit(r, ci) },
                                  ...(ce.nullable && v !== null ? [{ label: "Set to NULL", shortcut: "⌘⌫", action: () => setCell(r, ci, null) }] : []),
                                  ...(changed ? [{ label: "Revert Change", action: () => setCell(r, ci, set.rows[r][ci]) }] : []),
                                  "separator" as const,
                                ]),
                            ...(serverView
                              ? [
                                  { label: "Filter by This Value", action: () => filterBy(ci, v) },
                                  { label: "Exclude This Value", action: () => filterBy(ci, v, true) },
                                  "separator" as const,
                                ]
                              : []),
                            { label: "Copy Value", shortcut: "⌘C", action: () => copyWithFeedback(v ?? "NULL", "value") },
                            { label: "Copy Row", action: () => copyWithFeedback(row.map((x) => x ?? "NULL").join("\t"), "row") },
                            {
                              label: "Copy Row as JSON",
                              action: () => copyWithFeedback(JSON.stringify(rowObject(set, row), null, 2), "row as JSON"),
                            },
                            { label: "Copy Column Name", action: () => copyWithFeedback(col.name, "column name") },
                          ]);
                        }}
                        title={isEditing ? undefined : (v ?? "NULL")}
                      >
                        {isEditing ? (
                          <>
                            <input
                              {...exact}
                              className="cell-input"
                              autoFocus
                              placeholder={editing.isNull ? "NULL" : undefined}
                              value={editing.isNull ? "" : editing.draft}
                              onFocus={(e) => editing.draft.length > 1 && e.currentTarget.select()}
                              onChange={(e) => setEditing({ ...editing, draft: e.target.value, isNull: false })}
                              onBlur={commit}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commit();
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  setEditing(null);
                                  scroller.current?.focus();
                                } else if (e.key === "Tab") {
                                  e.preventDefault();
                                  commit();
                                  move(0, e.shiftKey ? -1 : 1);
                                }
                              }}
                            />
                            {ce.nullable && (
                              // Clicking it must not take focus from the input: that would end the edit.
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={editing.isNull}
                                tabIndex={-1}
                                className={`cell-null ${editing.isNull ? "on" : ""}`}
                                title="Set this value to NULL"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setEditing({ ...editing, isNull: !editing.isNull })}
                              >
                                <span className="cell-null-box" aria-hidden>
                                  {editing.isNull ? "✓" : ""}
                                </span>
                                NULL
                              </button>
                            )}
                          </>
                        ) : v === null ? (
                          <span className="null-pill">NULL</span>
                        ) : (
                          v
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {notice && !changes.size && (
        <div className="grid-notice" role="status">
          <span>{notice}</span>
          <button className="link-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {changes.size > 0 && (
        <div className="edit-bar" role="status">
          <span className="edit-dot" />
          <span className={editError ? "error-text ellipsis" : "ellipsis"} title={editError ?? undefined}>
            {editError ?? `${changes.size} unsaved change${changes.size === 1 ? "" : "s"}`}
          </span>
          <div className="grow" />
          <button className="btn small" onClick={discard} disabled={saving}>
            Discard
          </button>
          <button className="btn small primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"} <span className="kbd-hint">⌘S</span>
          </button>
        </div>
      )}
    </div>
  );
}

const PAGE_SIZES = [50, 100, 250, 500];

const rowsLabel = (n: number) => `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;

/** Rows as pretty JSON, a page at a time. Copy takes the page or every row. */
function JsonView({ set }: { set: ResultSet }) {
  const [size, setSize] = useState(100);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(set.rows.length / size));
  const p = Math.min(page, pages - 1);
  const first = p * size;
  const last = Math.min(set.rows.length, first + size);
  useEffect(() => {
    setPage(0);
  }, [set]);

  const text = useMemo(
    () => JSON.stringify(set.rows.slice(first, last).map((r) => rowObject(set, r)), null, 2),
    [set, first, last],
  );
  const lines = useMemo(() => text.split("\n"), [text]);
  const pre = useRef<HTMLPreElement>(null);
  // Braces matter: newer engines return a Promise from scrollTo, and an effect may only return a cleanup.
  useEffect(() => {
    pre.current?.scrollTo(0, 0);
  }, [p, size]);

  return (
    <div className="json-view">
      <pre className="json-pre" ref={pre}>
        {lines.map((l, i) => (
          <JsonLine key={i} line={l} />
        ))}
      </pre>
      <div className="pager">
        <button className="btn small" onClick={() => copyWithFeedback(text, `${rowsLabel(last - first)} as JSON`)}>
          Copy Page
        </button>
        <button
          className="btn small"
          onClick={() =>
            copyWithFeedback(JSON.stringify(set.rows.map((r) => rowObject(set, r)), null, 2), `${rowsLabel(set.rows.length)} as JSON`)
          }
        >
          Copy All
        </button>
        <div className="grow" />
        <span className="muted small">
          Rows {(first + 1).toLocaleString()}–{last.toLocaleString()} of {set.rows.length.toLocaleString()}
        </span>
        <select
          className="pager-size"
          aria-label="Rows per page"
          value={size}
          onChange={(e) => {
            setSize(Number(e.target.value));
            setPage(0);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
        <div className="pager-nav">
          <button className="btn small" aria-label="First page" disabled={p === 0} onClick={() => setPage(0)}>
            «
          </button>
          <button className="btn small" aria-label="Previous page" disabled={p === 0} onClick={() => setPage(p - 1)}>
            ‹
          </button>
          <span className="small pager-count">
            {p + 1} / {pages}
          </span>
          <button className="btn small" aria-label="Next page" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
            ›
          </button>
          <button className="btn small" aria-label="Last page" disabled={p >= pages - 1} onClick={() => setPage(pages - 1)}>
            »
          </button>
        </div>
      </div>
    </div>
  );
}

/** The server's error as it sent it: code, SQLSTATE, message, detail, hint, and where. */
function ErrorView({ error, sql, onRetry }: { error: AppError; sql?: string; onRetry: () => void }) {
  const db = error.db;
  const code = db
    ? db.engine === "mysql"
      ? `ERROR ${db.code ?? ""}${db.sqlstate ? ` (${db.sqlstate})` : ""}`
      : `${db.severity ?? "ERROR"} ${db.sqlstate ?? ""}`
    : null;
  // Postgres position → line and caret under the statement that was sent.
  let where: { line: number; col: number; text: string } | null = null;
  if (db?.position && sql) {
    const chars = [...sql];
    const before = chars.slice(0, db.position - 1).join("");
    const lineNo = before.split("\n").length;
    const col = before.length - before.lastIndexOf("\n");
    where = { line: lineNo, col, text: sql.split("\n")[lineNo - 1] ?? "" };
  }
  const full = [
    db ? `${code}: ${db.message}` : error.message,
    db?.detail && `DETAIL: ${db.detail}`,
    (db?.hint ?? error.hint) && `HINT: ${db?.hint ?? error.hint}`,
    where && `LINE ${where.line}: ${where.text}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="result-error" role="alert">
      <span className="error-dot">!</span>
      <div className="min0 grow">
        {code && <div className="error-code mono">{code.trim()}</div>}
        <div className="strong error-message">{db ? db.message : error.message}</div>
        {db?.detail && (
          <div className="error-field">
            <span>Detail</span> {db.detail}
          </div>
        )}
        {(db?.hint ?? error.hint) && (
          <div className="error-field">
            <span>Hint</span> {db?.hint ?? error.hint}
          </div>
        )}
        <ReplaceHostKey error={error} onReplaced={onRetry} />
        {where ? (
          <pre className="error-where mono">
            {`LINE ${where.line}: ${where.text}\n${" ".repeat(`LINE ${where.line}: `.length + where.col - 1)}^`}
          </pre>
        ) : (
          sql && <pre className="error-where mono muted">{sql.slice(0, 400)}</pre>
        )}
      </div>
      <button className="btn small" onClick={() => copyWithFeedback(full, "error")}>
        Copy Error
      </button>
    </div>
  );
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function JsonLine({ line }: { line: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(JSON_TOKEN)) {
    if (m.index! > last) parts.push(line.slice(last, m.index));
    const cls = m[1] ? (m[2] ? "j-key" : "j-str") : m[3] ? "j-lit" : "j-num";
    parts.push(
      <span key={m.index} className={cls}>
        {m[1] ?? m[0]}
      </span>,
    );
    if (m[2]) parts.push(m[2]);
    last = m.index! + m[0].length;
  }
  parts.push(line.slice(last));
  return <div>{parts}</div>;
}
