import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useCanvases } from "../canvases";
import {
  NOTE_H,
  NOTE_W,
  autoLayout,
  cardRect,
  changesOf,
  contentBounds,
  describeChanges,
  displayName,
  freeSpot,
  indexSchema,
  keysOnly,
  linksOf,
  placeNew,
  shownTables,
  type Rect,
  type Schema,
} from "../lib/diagram";
import { diagramSvg, svgToPng } from "../lib/diagramExport";
import { defaultSchema } from "../lib/sql";
import { timeAgo } from "../lib/time";
import { showToast } from "../lib/toast";
import { useApp, type ConnTab } from "../store";
import type { AppError, Canvas, Point } from "../types";
import { AppearanceSwitch } from "./AppearanceSwitch";
import { CanvasPanel, type PanelHandlers } from "./CanvasPanel";
import { CanvasSurface, fitView, zoomAround, type CanvasHandlers, type View } from "./CanvasSurface";
import { openMenu } from "./ContextMenu";
import { IconCanvas, IconCheck, IconNote, IconPlus } from "./Icons";

export type DiagramCommand = "zoom-in" | "zoom-out" | "zoom-fit" | "find";
let activeCommand: ((cmd: DiagramCommand) => void) | null = null;
/** Menu items and shortcuts for the canvas on screen. */
export const diagramCommand = (cmd: DiagramCommand) => activeCommand?.(cmd);

const uid = () => crypto.randomUUID();

/** The diagram of a connection: its canvases on the left, the canvas in the middle, its tables on the right. */
export function Diagram({ conn }: { conn: ConnTab }) {
  const temporary = useApp((s) => !!s.temporary[conn.profile.id]);
  const saveTemporary = useApp((s) => s.saveTemporary);
  const refreshSchema = useApp((s) => s.refreshSchema);
  const entry = useCanvases((s) => s.byProfile[conn.profile.id]);
  const { ensure, setSheet, create } = useCanvases.getState();
  const schema = useMemo(() => indexSchema(conn.schema ?? []), [conn.schema]);
  const first = defaultSchema(conn.profile);

  // A connection seen in the diagram for the first time gets a canvas of the whole database.
  const list = entry?.list;
  useEffect(() => {
    if (entry && list === null) ensure(conn, temporary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, list, conn.schema, temporary]);

  const canvas = list?.find((c) => c.id === entry?.active) ?? list?.[0];
  const newCanvas = () => setSheet({ connId: conn.id, mode: "new" });

  let empty: React.ReactNode = null;
  if (temporary) {
    empty = (
      <Empty title="Canvases are kept with saved connections" text="This connection was opened from a link. Save it to arrange its tables on canvases.">
        <button className="btn primary" onClick={() => saveTemporary(conn.id)}>
          Save Connection
        </button>
      </Empty>
    );
  } else if (conn.schemaError && !conn.schema) {
    empty = (
      <Empty title="Couldn't read the tables" text={conn.schemaError.message}>
        <button className="btn" onClick={() => refreshSchema(conn.id)}>
          Try Again
        </button>
      </Empty>
    );
  } else if (!entry || !conn.schema || list === null) {
    empty = <Empty title="Reading the tables…" />;
  } else if (!canvas) {
    empty = (
      <Empty title="No canvases" text="A canvas shows the whole database or a part of it, arranged your way, with notes.">
        <button className="btn primary" onClick={newCanvas}>
          New Canvas…
        </button>
        <button className="btn" onClick={() => create(conn, { name: "Whole database", scope: { kind: "all" }, autoAdd: true })}>
          Whole Database
        </button>
      </Empty>
    );
  }

  return (
    <div className="body">
      <CanvasList conn={conn} list={list ?? []} active={canvas?.id} schema={schema} first={first} disabled={temporary || !conn.schema} />
      {empty || !canvas ? (
        <main className="diagram-main">{empty}</main>
      ) : (
        <CanvasView key={canvas.id} conn={conn} canvas={canvas} schema={schema} first={first} />
      )}
    </div>
  );
}

function Empty({ title, text, children }: { title: string; text?: string; children?: React.ReactNode }) {
  return (
    <div className="no-tabs">
      <div className="no-tabs-title">{title}</div>
      {text && <div className="muted diagram-empty-text">{text}</div>}
      {children && <div className="row gap8">{children}</div>}
    </div>
  );
}

function scopeMeta(c: Canvas, first: string): string {
  switch (c.scope.kind) {
    case "all":
      return " · all";
    case "pattern":
      return ` · ${c.scope.patterns.join(", ")}`;
    case "neighbours":
      return ` · near ${displayName(c.scope.root, first)}`;
    case "picked":
      return "";
  }
}

function CanvasList(p: { conn: ConnTab; list: Canvas[]; active?: string; schema: Schema; first: string; disabled: boolean }) {
  const { open, setSheet, duplicate, remove } = useCanvases.getState();
  const hasSchema = !!p.conn.schema;
  const counts = useMemo(
    () => new Map(p.list.map((c) => [c.id, hasSchema ? changesOf(c, p.schema).count : 0])),
    [p.list, p.schema, hasSchema],
  );
  return (
    <aside className="sidebar canvas-list" aria-label="Canvases">
      <div className="side-title">Canvases</div>
      <div className="cv-list" role="list">
        {p.list.map((c) => {
          const tables = shownTables(c).length;
          const notes = c.notes.length;
          const changes = counts.get(c.id) ?? 0;
          const on = c.id === p.active;
          return (
            <button
              key={c.id}
              role="listitem"
              aria-current={on}
              className={`cv ${on ? "on" : ""}`}
              onClick={() => open(p.conn, c.id)}
              onDoubleClick={() => setSheet({ connId: p.conn.id, mode: "edit", canvasId: c.id })}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "Edit Canvas…", action: () => setSheet({ connId: p.conn.id, mode: "edit", canvasId: c.id }) },
                  { label: "Duplicate", action: () => duplicate(p.conn, c.id) },
                  "separator",
                  { label: "Delete", action: () => remove(p.conn, c.id) },
                ])
              }
            >
              <span className="cv-row">
                <IconCanvas color={on ? "var(--accent)" : "var(--label-tertiary)"} />
                <span className="cv-name grow ellipsis">{c.name}</span>
                {changes > 0 && (
                  <span className="count-badge" title={`${changes} change${changes > 1 ? "s" : ""} in the database since you last looked`}>
                    {changes}
                  </span>
                )}
              </span>
              <span className="cv-meta ellipsis">
                {tables} table{tables === 1 ? "" : "s"}
                {notes > 0 && ` · ${notes} note${notes > 1 ? "s" : ""}`}
                {scopeMeta(c, p.first)}
              </span>
            </button>
          );
        })}
        <button className="add-link" disabled={p.disabled} onClick={() => setSheet({ connId: p.conn.id, mode: "new" })}>
          <IconPlus size={11} />
          New Canvas…
        </button>
      </div>
      <div className="grow" />
      <div className="live-card">
        <b>
          <span className="dot ok" />
          Live with the database
        </b>
        Canvases keep your layout, notes and hidden items. Tables and columns always come from the database as it is now.
      </div>
      <div className="sidebar-foot">
        <span className="dot ok" />
        <span className="grow">{p.conn.info.hops ? "Tunnel healthy" : "Connected"}</span>
        <AppearanceSwitch compact />
      </div>
    </aside>
  );
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function SaveState({ id }: { id: string }) {
  const s = useCanvases((st) => st.saves[id]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (s?.state === "saving") return <span className="save-state">Saving…</span>;
  if (s?.state === "failed")
    return (
      <span className="save-state error" title={s.error}>
        Couldn't save: {s.error}
      </span>
    );
  return (
    <span className="save-state">
      <IconCheck size={11} />
      {s?.at ? `Saved ${timeAgo(s.at)}` : "Saved"}
    </span>
  );
}

const overlapsAny = (r: Rect, others: Rect[]) =>
  others.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);

/** One canvas: its toolbar, the canvas itself and the "In this canvas" panel. */
function CanvasView({ conn, canvas, schema, first }: { conn: ConnTab; canvas: Canvas; schema: Schema; first: string }) {
  const fit = useCanvases((s) => s.fit);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [view, setView] = useState<View>({ zoom: canvas.zoom, pan: canvas.pan });
  const surfaceRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const size = useSize(surfaceRef);

  const links = useMemo(() => linksOf(schema), [schema]);
  const changes = useMemo(() => changesOf(canvas, schema), [canvas, schema]);
  const name = useCallback((k: string) => displayName(k, first), [first]);
  const changeText = useMemo(
    () => describeChanges(changes, name, (k) => k in canvas.positions && !canvas.hiddenTables.includes(k)),
    [changes, name, canvas.positions, canvas.hiddenTables],
  );
  const shownCount = useMemo(() => shownTables(canvas).length, [canvas]);

  const latest = useRef({ conn, canvas, schema, view, size });
  latest.current = { conn, canvas, schema, view, size };

  const update = useCallback(
    (change: (c: Canvas) => Canvas, opts?: { quiet?: boolean }) =>
      useCanvases.getState().update(latest.current.conn, canvas.id, change, opts),
    [canvas.id],
  );

  // Zoom and scroll are kept with the canvas, without "Saving…", once they settle.
  useEffect(() => {
    const c = latest.current.canvas;
    if (view.zoom === c.zoom && view.pan.x === c.pan.x && view.pan.y === c.pan.y) return;
    const t = setTimeout(() => update((x) => ({ ...x, zoom: view.zoom, pan: view.pan }), { quiet: true }), 400);
    return () => clearTimeout(t);
  }, [view, update]);
  useEffect(
    () => () => {
      const { canvas: c, view: v } = latest.current;
      if (v.zoom !== c.zoom || v.pan.x !== c.pan.x || v.pan.y !== c.pan.y) update((x) => ({ ...x, zoom: v.zoom, pan: v.pan }), { quiet: true });
    },
    [update],
  );

  // A canvas that was just made opens zoomed to fit.
  useEffect(() => {
    if (fit !== canvas.id || !size.w) return;
    setView(fitView(contentBounds(canvas, schema), size));
    useCanvases.getState().clearFit();
  }, [fit, canvas, schema, size]);

  /** Bring a table into view (centred) when it isn't. */
  const reveal = useCallback((key: string, c: Canvas) => {
    if (!(key in c.positions)) return;
    const { view: v, size: s, schema: sc } = latest.current;
    const r = cardRect(key, c, sc);
    const vw = s.w / v.zoom;
    const vh = s.h / v.zoom;
    const inside = r.x >= v.pan.x && r.y >= v.pan.y && r.x + r.w <= v.pan.x + vw && r.y + Math.min(r.h, vh) <= v.pan.y + vh;
    if (!inside) setView({ zoom: v.zoom, pan: { x: r.x + r.w / 2 - vw / 2, y: r.y + Math.min(r.h, vh * 0.8) / 2 - vh / 2 } });
  }, []);

  /** Show a table: where it was, or in free space when that is taken now (or it never had a place). */
  const showTable = useCallback(
    (key: string) => {
      const c = latest.current.canvas;
      const sc = latest.current.schema;
      const rest = shownTables(c).map((k) => cardRect(k, c, sc));
      const hidden = c.hiddenTables.filter((k) => k !== key);
      const keep = key in c.positions && !overlapsAny(cardRect(key, c, sc), rest);
      const without = { ...c, positions: { ...c.positions }, hiddenTables: hidden };
      delete without.positions[key];
      const at = keep ? c.positions[key] : placeNew([key], { ...without, hiddenTables: [] }, sc)[key];
      const next = { ...c, hiddenTables: hidden, positions: { ...c.positions, [key]: at } };
      update(() => next);
      setSelected(key);
      setExpanded(key);
      requestAnimationFrame(() => reveal(key, next));
    },
    [update, reveal],
  );

  const h: CanvasHandlers = useMemo(
    () => ({
      select(key) {
        setSelected(key);
        if (!key) return;
        setExpanded(key);
        // So ⌫ and Escape reach the canvas, even after a press that started a drag.
        surfaceRef.current?.focus({ preventScroll: true });
      },
      openTable(key) {
        const t = latest.current.schema.get(key);
        if (t) useApp.getState().openTable(latest.current.conn.id, t);
      },
      hideTable(key) {
        update((c) => ({ ...c, hiddenTables: [...new Set([...c.hiddenTables, key])] }));
        setSelected((s) => (s === key ? null : s));
        showToast(`Hid ${displayName(key, first)} from this canvas`, "ok", {
          label: "Undo",
          run: () => update((c) => ({ ...c, hiddenTables: c.hiddenTables.filter((k) => k !== key) })),
        });
      },
      hideColumn(key, column) {
        update((c) => ({ ...c, hiddenColumns: { ...c.hiddenColumns, [key]: [...new Set([...(c.hiddenColumns[key] ?? []), column])] } }));
      },
      showColumns(key) {
        update((c) => {
          const hiddenColumns = { ...c.hiddenColumns };
          delete hiddenColumns[key];
          return { ...c, hiddenColumns };
        });
      },
      keysOnly(key) {
        update((c) => {
          const hiddenColumns = { ...c.hiddenColumns };
          delete hiddenColumns[key];
          return { ...c, hiddenColumns: { ...hiddenColumns, ...keysOnly([key], latest.current.schema) } };
        });
      },
      moveTable(key, p) {
        update((c) => ({ ...c, positions: { ...c.positions, [key]: p } }));
      },
      removeGhost(key) {
        update((c) => {
          const positions = { ...c.positions };
          const hiddenColumns = { ...c.hiddenColumns };
          const seen = { ...c.seen };
          delete positions[key];
          delete hiddenColumns[key];
          delete seen[key];
          return { ...c, positions, hiddenColumns, seen, hiddenTables: c.hiddenTables.filter((k) => k !== key) };
        });
      },
      addNote(at?: Point) {
        const { view: v, size: s, canvas: c, schema: sc } = latest.current;
        // From the toolbar: in free space near the middle of the view, when there is some in view.
        const vw = s.w / v.zoom;
        const vh = s.h / v.zoom;
        const middle = { x: v.pan.x + vw / 2 - NOTE_W / 2, y: v.pan.y + vh / 2 - NOTE_H / 2 };
        const reach = Math.max(0, Math.min(vw, vh) / 2 - NOTE_W / 2);
        const p = at ?? freeSpot(middle, NOTE_W, NOTE_H, c, sc, reach);
        const id = uid();
        update((c) => ({ ...c, notes: [...c.notes, { id, x: Math.round(p.x), y: Math.round(p.y), w: NOTE_W, text: "" }] }));
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-note="${id}"] textarea`)?.focus());
      },
      moveNote(id, p) {
        update((c) => ({ ...c, notes: c.notes.map((n) => (n.id === id ? { ...n, ...p } : n)) }));
      },
      resizeNote(id, w) {
        update((c) => ({ ...c, notes: c.notes.map((n) => (n.id === id ? { ...n, w } : n)) }));
      },
      editNote(id, text) {
        update((c) => ({ ...c, notes: c.notes.map((n) => (n.id === id ? { ...n, text } : n)) }));
      },
      removeNote(id) {
        const note = latest.current.canvas.notes.find((n) => n.id === id);
        if (!note) return;
        update((c) => ({ ...c, notes: c.notes.filter((n) => n.id !== id) }));
        if (note.text.trim())
          showToast("Deleted the note", "ok", { label: "Undo", run: () => update((c) => ({ ...c, notes: [...c.notes, note] })) });
      },
      autoLayout() {
        const c = latest.current.canvas;
        const keys = shownTables(c);
        if (!keys.length) return;
        const before = Object.fromEntries(keys.map((k) => [k, c.positions[k]]));
        const next = { ...c, positions: { ...c.positions, ...autoLayout(keys, c, latest.current.schema) } };
        update(() => next);
        setView(fitView(contentBounds(next, latest.current.schema), latest.current.size));
        showToast(`Arranged ${keys.length} table${keys.length > 1 ? "s" : ""}`, "ok", {
          label: "Undo",
          // Only the tables that were arranged; anything placed since stays.
          run: () => update((x) => ({ ...x, positions: { ...x.positions, ...Object.fromEntries(Object.entries(before).filter(([k]) => k in x.positions)) } })),
        });
      },
      zoomToFit() {
        setView(fitView(contentBounds(latest.current.canvas, latest.current.schema), latest.current.size));
      },
      acknowledge() {
        useCanvases.getState().acknowledge(latest.current.conn, canvas.id);
      },
    }),
    [update, canvas.id, first],
  );

  // Stable, so the panel (one row per table) isn't drawn again while scrolling or zooming.
  const panel: PanelHandlers = useMemo(
    () => ({
      pick(k) {
        setSelected(k);
        setExpanded((e) => (e === k ? null : k));
        reveal(k, latest.current.canvas);
      },
      toggleTable: (k, show) => (show ? showTable(k) : h.hideTable(k)),
      toggleColumn(k, col) {
        update((c) => {
          const cur = c.hiddenColumns[k] ?? [];
          const next = cur.includes(col) ? cur.filter((x) => x !== col) : [...cur, col];
          const hiddenColumns = { ...c.hiddenColumns, [k]: next };
          if (!next.length) delete hiddenColumns[k];
          return { ...c, hiddenColumns };
        });
      },
      toggleAutoAdd() {
        update((c) => ({ ...c, autoAdd: !c.autoAdd }));
        // Turned on: new tables waiting in the panel go on the canvas now.
        useCanvases.getState().sync(latest.current.conn);
      },
      edit: () => useCanvases.getState().setSheet({ connId: latest.current.conn.id, mode: "edit", canvasId: canvas.id }),
    }),
    [update, reveal, showTable, h, canvas.id],
  );

  const zoomBy = useCallback((step: number) => {
    const s = latest.current.size;
    setView((v) => zoomAround(v, Math.round((v.zoom + step) * 10) / 10, s.w / 2, s.h / 2));
  }, []);

  useEffect(() => {
    activeCommand = (cmd) => {
      if (cmd === "zoom-in") zoomBy(0.1);
      else if (cmd === "zoom-out") zoomBy(-0.1);
      else if (cmd === "zoom-fit") h.zoomToFit();
      else filterRef.current?.focus();
    };
    return () => {
      activeCommand = null;
    };
  }, [zoomBy, h]);

  const exportAs = async (kind: "png" | "svg") => {
    const out = diagramSvg(canvas, schema, links, name);
    if (!out) return showToast("There is nothing on this canvas to export.", "error");
    try {
      const data = kind === "svg" ? out.svg : await svgToPng(out.svg, out.width, out.height);
      const path = await api.exportDiagram(canvas.name, kind, data);
      if (path) showToast(`Exported “${path.split("/").pop()}”`);
    } catch (e) {
      showToast(`Couldn't export: ${(e as AppError).message ?? String(e)}`, "error");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as Element).closest("input, textarea, select")) return;
    if (e.key === "Escape") setSelected(null);
    else if ((e.key === "Backspace" || e.key === "Delete") && selected && schema.has(selected)) {
      e.preventDefault();
      h.hideTable(selected);
    }
  };

  const emptyHint =
    canvas.scope.kind === "picked"
      ? "Tick tables in the panel on the right to put them on this canvas."
      : "Nothing on this canvas. Tick tables in the panel on the right to show them.";

  return (
    <>
      <main className="diagram-main" onKeyDown={onKeyDown}>
        <div className="canvas-bar">
          <span className="canvas-title ellipsis" title="Double-click to edit the canvas" onDoubleClick={() => useCanvases.getState().setSheet({ connId: conn.id, mode: "edit", canvasId: canvas.id })}>
            {canvas.name}
          </span>
          <SaveState id={canvas.id} />
          <div className="grow" />
          <button className="btn" onClick={() => h.addNote()}>
            <IconNote />
            Add Note
          </button>
          <button className="btn plain" onClick={h.autoLayout} disabled={!shownCount}>
            Auto Layout
          </button>
          <div className="zoom-control" role="group" aria-label="Zoom">
            <button aria-label="Zoom out" title="Zoom out (⌘−)" onClick={() => zoomBy(-0.1)}>
              −
            </button>
            <button className="zoom-value" title="Zoom to fit (⌘0)" onClick={h.zoomToFit}>
              {Math.round(view.zoom * 100)}%
            </button>
            <button aria-label="Zoom in" title="Zoom in (⌘+)" onClick={() => zoomBy(0.1)}>
              +
            </button>
          </div>
          <button
            className="btn plain"
            disabled={!shownCount && !canvas.notes.length}
            onClick={(e) =>
              openMenu(e, [
                { label: "Export as PNG…", action: () => exportAs("png") },
                { label: "Export as SVG…", action: () => exportAs("svg") },
              ])
            }
          >
            Export
          </button>
        </div>
        <CanvasSurface
          canvas={canvas}
          schema={schema}
          links={links}
          changes={changes}
          changeText={changeText}
          name={name}
          view={view}
          setView={setView}
          size={size}
          surfaceRef={surfaceRef}
          selected={selected}
          h={h}
          emptyHint={emptyHint}
        />
      </main>
      <CanvasPanel
        canvas={canvas}
        schema={schema}
        changes={changes}
        name={name}
        defaultSchema={first}
        selected={selected}
        expanded={expanded}
        filterRef={filterRef}
        on={panel}
      />
    </>
  );
}
