import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  cardHeight,
  cardRect,
  contentBounds,
  linesOf,
  shortType,
  shownTables,
  visibleColumns,
  type Changes,
  type Line,
  type Link,
  type Rect,
  type Schema,
} from "../lib/diagram";
import type { Canvas, CanvasNote, Point, TableInfo } from "../types";
import { openMenu } from "./ContextMenu";
import { IconEyeOff, IconRefresh, IconTable } from "./Icons";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

/** Zoom, and the canvas point at the top left of the view. */
export interface View {
  zoom: number;
  pan: Point;
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Zoom to `zoom`, keeping the canvas point under (cx, cy) of the view where it is. */
export function zoomAround(v: View, zoom: number, cx: number, cy: number): View {
  const z = clampZoom(zoom);
  return { zoom: z, pan: { x: v.pan.x + cx / v.zoom - cx / z, y: v.pan.y + cy / v.zoom - cy / z } };
}

/** Everything in view, at 100 % at most. */
export function fitView(bounds: Rect | null, size: { w: number; h: number }): View {
  if (!bounds || !size.w || !size.h) return { zoom: 1, pan: { x: 0, y: 0 } };
  const zoom = clampZoom(Math.min(1, (size.w - 80) / bounds.w, (size.h - 100) / bounds.h));
  return { zoom, pan: { x: bounds.x + bounds.w / 2 - size.w / 2 / zoom, y: bounds.y + bounds.h / 2 - size.h / 2 / zoom } };
}

/** What the canvas asks its owner to do. */
export interface CanvasHandlers {
  select(key: string | null): void;
  openTable(key: string): void;
  hideTable(key: string): void;
  hideColumn(key: string, column: string): void;
  showColumns(key: string): void;
  keysOnly(key: string): void;
  moveTable(key: string, p: Point): void;
  removeGhost(key: string): void;
  addNote(at?: Point): void;
  moveNote(id: string, p: Point): void;
  resizeNote(id: string, w: number): void;
  editNote(id: string, text: string): void;
  removeNote(id: string): void;
  autoLayout(): void;
  zoomToFit(): void;
  acknowledge(): void;
}

interface SurfaceProps {
  canvas: Canvas;
  schema: Schema;
  links: Link[];
  changes: Changes;
  /** Banner sentences, when something changed. */
  changeText: string[];
  name: (key: string) => string;
  view: View;
  setView: (change: (v: View) => View) => void;
  size: { w: number; h: number };
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  selected: string | null;
  h: CanvasHandlers;
  emptyHint: string;
}

/** Something being dragged: its new top left corner on the canvas. */
type Drag =
  | { kind: "table"; id: string; x: number; y: number }
  | { kind: "note"; id: string; x: number; y: number }
  | { kind: "resize"; id: string; w: number };

const isControl = (t: EventTarget | null) => t instanceof Element && !!t.closest("button, textarea, input, select");

/**
 * Follow the pointer from a press until it is released; `onMove` gets the distance in canvas units.
 * A press that doesn't move (3 px) is a click: `onEnd(false)`.
 */
function track(e: React.PointerEvent, zoom: number, onMove: (dx: number, dy: number) => void, onEnd: (moved: boolean) => void) {
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  let frame = 0;
  let last = { dx: 0, dy: 0 };
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    last = { dx: (ev.clientX - sx) / zoom, dy: (ev.clientY - sy) / zoom };
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      onMove(last.dx, last.dy);
    });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    cancelAnimationFrame(frame);
    if (moved) onMove(last.dx, last.dy);
    onEnd(moved);
    document.body.classList.remove("canvas-grabbing");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/**
 * The canvas: tables as cards with their columns, foreign key lines, notes and dropped placeholders.
 * Drag a header to move a table, drag the background to scroll, pinch or ⌘-scroll to zoom. Only what
 * is in view is drawn, and moving one card leaves the others alone.
 */
export function CanvasSurface(p: SurfaceProps) {
  const { canvas, schema, view, size, selected, h } = p;
  const [drag, setDrag] = useState<Drag | null>(null);

  // The canvas as drawn right now: with the card or note being dragged where the pointer is.
  const live = useMemo(() => {
    if (!drag) return canvas;
    if (drag.kind === "table") return { ...canvas, positions: { ...canvas.positions, [drag.id]: { x: drag.x, y: drag.y } } };
    const moved = drag.kind === "note" ? { x: drag.x, y: drag.y } : { w: drag.w };
    return { ...canvas, notes: canvas.notes.map((n) => (n.id === drag.id ? { ...n, ...moved } : n)) };
  }, [canvas, drag]);

  const latest = useRef({ live, view, h, setView: p.setView, setDrag });
  latest.current = { live, view, h, setView: p.setView, setDrag };

  const shown = useMemo(() => shownTables(live), [live]);
  const shownSet = useMemo(() => new Set(shown), [shown]);
  const lines = useMemo(() => linesOf(live, p.links, shownSet, schema), [live, p.links, shownSet, schema]);

  // Only cards and lines near the view are drawn.
  const margin = 240 / view.zoom;
  const area: Rect = {
    x: view.pan.x - margin,
    y: view.pan.y - margin,
    w: size.w / view.zoom + 2 * margin,
    h: size.h / view.zoom + 2 * margin,
  };
  const inView = (r: Rect) => r.x < area.x + area.w && r.x + r.w > area.x && r.y < area.y + area.h && r.y + r.h > area.y;
  const cards = shown.filter((k) => (drag?.kind === "table" && drag.id === k) || inView(cardRect(k, live, schema)));
  const visibleLines = lines.filter((l) => {
    const a = live.positions[l.from];
    const x = Math.min(a.x, l.end.x) - 60;
    const y = Math.min(a.y, l.end.y);
    return inView({ x, y, w: Math.abs(a.x - l.end.x) + 300, h: Math.abs(a.y - l.end.y) + cardHeight(schema.get(l.from), live.hiddenColumns[l.from]) });
  });

  // Stable handlers for the memoized cards, reading the latest state.
  const ev = useMemo(
    () => ({
      grabTable(e: React.PointerEvent, key: string) {
        if (e.button !== 0 || isControl(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const { live: c, view: v, h: handlers } = latest.current;
        handlers.select(key);
        const start = c.positions[key];
        document.body.classList.add("canvas-grabbing");
        let at = start;
        track(
          e,
          v.zoom,
          (dx, dy) => {
            at = { x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
            latest.current.setDrag({ kind: "table", id: key, x: at.x, y: at.y });
          },
          (moved) => {
            if (moved) latest.current.h.moveTable(key, at);
            latest.current.setDrag(null);
          },
        );
      },
      pressCard(e: React.PointerEvent, key: string) {
        if (e.button !== 0 || isControl(e.target)) return;
        e.stopPropagation();
        latest.current.h.select(key);
      },
      cardMenu(e: React.MouseEvent, key: string) {
        const { live: c, h: handlers } = latest.current;
        const t = schema.get(key);
        handlers.select(key);
        if (!t) return openMenu(e, [{ label: "Remove from Canvas", action: () => handlers.removeGhost(key) }]);
        const hidden = c.hiddenColumns[key]?.length ?? 0;
        openMenu(e, [
          { label: "Open Table", action: () => handlers.openTable(key) },
          "separator",
          { label: "Show All Columns", disabled: !hidden, action: () => handlers.showColumns(key) },
          { label: "Show Only Key Columns", action: () => handlers.keysOnly(key) },
          "separator",
          { label: "Hide from Canvas", action: () => handlers.hideTable(key) },
        ]);
      },
      grabNote(e: React.PointerEvent, id: string) {
        if (e.button !== 0 || isControl(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const n = latest.current.live.notes.find((x) => x.id === id)!;
        document.body.classList.add("canvas-grabbing");
        let at = { x: n.x, y: n.y };
        track(
          e,
          latest.current.view.zoom,
          (dx, dy) => {
            at = { x: Math.round(n.x + dx), y: Math.round(n.y + dy) };
            latest.current.setDrag({ kind: "note", id, x: at.x, y: at.y });
          },
          (moved) => {
            if (moved) latest.current.h.moveNote(id, at);
            latest.current.setDrag(null);
          },
        );
      },
      resizeNote(e: React.PointerEvent, id: string) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const n = latest.current.live.notes.find((x) => x.id === id)!;
        let w = n.w;
        track(
          e,
          latest.current.view.zoom,
          (dx) => {
            w = Math.round(Math.min(640, Math.max(140, n.w + dx)));
            latest.current.setDrag({ kind: "resize", id, w });
          },
          (moved) => {
            if (moved) latest.current.h.resizeNote(id, w);
            latest.current.setDrag(null);
          },
        );
      },
    }),
    [schema],
  );

  // Dragging the background scrolls; a click on it clears the selection.
  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || isControl(e.target) || (e.target as Element).closest(".tcard, .cnote, .tcard-ghost, .minimap, .canvas-banner"))
      return;
    const start = view.pan;
    const zoom = view.zoom;
    document.body.classList.add("canvas-grabbing");
    track(
      e,
      zoom,
      (dx, dy) => p.setView((v) => ({ ...v, pan: { x: start.x - dx, y: start.y - dy } })),
      (moved) => !moved && h.select(null),
    );
  };

  const onBackgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as Element).closest(".tcard, .cnote, .tcard-ghost, .minimap, .canvas-banner")) return;
    const r = p.surfaceRef.current!.getBoundingClientRect();
    const at = { x: view.pan.x + (e.clientX - r.left) / view.zoom, y: view.pan.y + (e.clientY - r.top) / view.zoom };
    openMenu(e, [
      { label: "Add Note Here", action: () => h.addNote(at) },
      "separator",
      { label: "Auto Layout", disabled: shown.length === 0, action: () => h.autoLayout() },
      { label: "Zoom to Fit", shortcut: "⌘0", action: () => h.zoomToFit() },
    ]);
  };

  // Scroll to move around, ⌘-scroll or pinch to zoom. Not passive, so the page itself never zooms.
  useEffect(() => {
    const el = p.surfaceRef.current;
    if (!el) return;
    // WebKit reports a trackpad pinch as gesture events (and may also send ⌃-scroll for it).
    let base = 1;
    let pinching = false;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (pinching && e.ctrlKey) return;
      const r = el.getBoundingClientRect();
      const { setView } = latest.current;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.01);
        setView((v) => zoomAround(v, v.zoom * factor, e.clientX - r.left, e.clientY - r.top));
      } else {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
        setView((v) => ({ ...v, pan: { x: v.pan.x + (e.deltaX * unit) / v.zoom, y: v.pan.y + (e.deltaY * unit) / v.zoom } }));
      }
    };
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinching = true;
      base = latest.current.view.zoom;
    };
    const onGestureEnd = () => {
      pinching = false;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      const r = el.getBoundingClientRect();
      latest.current.setView((v) => zoomAround(v, base * g.scale, g.clientX - r.left, g.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [p.surfaceRef]);

  const grid = 20 * view.zoom * (view.zoom < 0.5 ? 2 : 1);
  const newTables = useMemo(() => new Set(p.changes.addedTables), [p.changes]);

  return (
    <div
      ref={p.surfaceRef}
      className="canvas-surface"
      tabIndex={-1}
      aria-label={`Canvas ${canvas.name}`}
      onPointerDown={onBackgroundDown}
      onContextMenu={onBackgroundMenu}
      style={{
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${-view.pan.x * view.zoom}px ${-view.pan.y * view.zoom}px`,
      }}
    >
      <div
        className="canvas-layer"
        style={{ transform: `translate(${-view.pan.x * view.zoom}px, ${-view.pan.y * view.zoom}px) scale(${view.zoom})` }}
      >
        <svg className="canvas-lines" width="1" height="1" aria-hidden>
          {/* The selected table's lines last, so they are drawn on top. */}
          {visibleLines
            .filter((l) => l.from !== selected && l.to !== selected)
            .map((l) => (
              <RelLine key={l.id} line={l} hot={false} />
            ))}
          {visibleLines
            .filter((l) => l.from === selected || l.to === selected)
            .map((l) => (
              <RelLine key={l.id} line={l} hot />
            ))}
        </svg>
        {cards.map((k) => {
          const t = schema.get(k);
          const pos = live.positions[k];
          return t ? (
            <TableCard
              key={k}
              id={k}
              table={t}
              name={p.name(k)}
              x={pos.x}
              y={pos.y}
              hidden={live.hiddenColumns[k]}
              selected={selected === k}
              isNew={newTables.has(k)}
              newColumns={p.changes.addedColumns[k]}
              h={h}
              ev={ev}
            />
          ) : (
            <Ghost key={k} id={k} name={p.name(k)} x={pos.x} y={pos.y} h={h} ev={ev} />
          );
        })}
        {live.notes.map((n) => (
          <NoteCard key={n.id} note={n} h={h} ev={ev} />
        ))}
      </div>
      {p.changeText.length > 0 && (
        <div className="canvas-banner" role="status" title={p.changeText.join("\n")}>
          <IconRefresh color="var(--accent)" />
          <span className="grow min0">
            <b>Updated from the database.</b> {p.changeText.slice(0, 3).join(" · ")}
            {p.changeText.length > 3 && ` · and ${p.changeText.length - 3} more`}
          </span>
          <button className="btn small" onClick={h.acknowledge}>
            Got it
          </button>
        </div>
      )}
      {shown.length === 0 && canvas.notes.length === 0 && <div className="canvas-empty">{p.emptyHint}</div>}
      <Minimap canvas={canvas} schema={schema} selected={selected} view={view} size={size} setView={p.setView} />
    </div>
  );
}

type Ev = {
  grabTable(e: React.PointerEvent, key: string): void;
  pressCard(e: React.PointerEvent, key: string): void;
  cardMenu(e: React.MouseEvent, key: string): void;
  grabNote(e: React.PointerEvent, id: string): void;
  resizeNote(e: React.PointerEvent, id: string): void;
};

const RelLine = memo(function RelLine({ line, hot }: { line: Line; hot: boolean }) {
  return (
    <g className={hot ? "rel hot" : "rel"}>
      <path d={line.d} />
      <circle cx={line.end.x} cy={line.end.y} r={3} />
    </g>
  );
});

interface CardProps {
  id: string;
  table: TableInfo;
  name: string;
  x: number;
  y: number;
  hidden: string[] | undefined;
  selected: boolean;
  isNew: boolean;
  newColumns: string[] | undefined;
  h: CanvasHandlers;
  ev: Ev;
}

const TableCard = memo(function TableCard({ id, table, name, x, y, hidden, selected, isNew, newColumns, h, ev }: CardProps) {
  const cols = visibleColumns(table, hidden);
  const hiddenCount = table.columns.length - cols.length;
  const isView = table.kind === "view";
  return (
    <div
      className={`tcard ${selected ? "sel" : ""}`}
      style={{ left: x, top: y }}
      data-table={id}
      onPointerDown={(e) => ev.pressCard(e, id)}
      onContextMenu={(e) => ev.cardMenu(e, id)}
    >
      <div
        className="tcard-head"
        title={`${id}${isView ? " (view)" : ""} · double-click to open`}
        onPointerDown={(e) => ev.grabTable(e, id)}
        onDoubleClick={(e) => !isControl(e.target) && h.openTable(id)}
      >
        <IconTable color={selected ? "var(--accent)" : "var(--label-tertiary)"} />
        <span className="tcard-name">{name}</span>
        {isView && <span className="tcard-kind">view</span>}
        {isNew && <span className="new-tag">NEW</span>}
        <button className="tcard-eye" aria-label={`Hide ${name} from this canvas`} title="Hide from this canvas" onClick={() => h.hideTable(id)}>
          <IconEyeOff size={14} />
        </button>
      </div>
      {cols.map((c) => (
        <div key={c.name} className={`tcard-col ${c.foreignKey ? "fk" : ""} ${c.primaryKey ? "pk" : ""}`}>
          <span className={`key-tag ${c.primaryKey ? "pk" : c.foreignKey ? "fk" : ""}`}>{c.primaryKey ? "PK" : c.foreignKey ? "FK" : "·"}</span>
          <span className="tcard-col-name" title={c.name}>
            {c.name}
          </span>
          {newColumns?.includes(c.name) && <span className="new-tag">NEW</span>}
          <span className="tcard-type mono" title={c.dataType + (c.nullable ? "" : " not null")}>
            {shortType(c.dataType)}
          </span>
          <button className="tcard-eye" aria-label={`Hide column ${c.name}`} title="Hide column" onClick={() => h.hideColumn(id, c.name)}>
            <IconEyeOff size={12} />
          </button>
        </div>
      ))}
      {hiddenCount > 0 && (
        <button className="tcard-hidden" onClick={() => h.showColumns(id)}>
          <IconEyeOff size={12} />
          {hiddenCount} hidden column{hiddenCount > 1 ? "s" : ""} · Show
        </button>
      )}
    </div>
  );
});

const Ghost = memo(function Ghost({ id, name, x, y, h, ev }: { id: string; name: string; x: number; y: number; h: CanvasHandlers; ev: Ev }) {
  return (
    <div
      className="tcard-ghost"
      style={{ left: x, top: y }}
      data-table={id}
      onPointerDown={(e) => ev.grabTable(e, id)}
      onContextMenu={(e) => ev.cardMenu(e, id)}
    >
      <b>{name}</b>
      <div>Dropped from the database. It stays here until you remove it.</div>
      <button className="btn small" onClick={() => h.removeGhost(id)}>
        Remove from Canvas
      </button>
    </div>
  );
});

const NoteCard = memo(function NoteCard({ note, h, ev }: { note: CanvasNote; h: CanvasHandlers; ev: Ev }) {
  const text = useRef<HTMLTextAreaElement>(null);
  // The note grows with its text.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [note.text, note.w]);
  return (
    <div className="cnote" style={{ left: note.x, top: note.y, width: note.w }} data-note={note.id}>
      <div className="cnote-head" onPointerDown={(e) => ev.grabNote(e, note.id)}>
        <span>NOTE</span>
        <button aria-label="Delete note" title="Delete note" onClick={() => h.removeNote(note.id)}>
          ×
        </button>
      </div>
      <textarea
        ref={text}
        value={note.text}
        rows={3}
        spellCheck
        placeholder="Write a note…"
        aria-label="Note"
        onChange={(e) => h.editNote(note.id, e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
      />
      <div className="cnote-resize" title="Drag to resize" onPointerDown={(e) => ev.resizeNote(e, note.id)} />
    </div>
  );
});

const MINI_W = 168;
const MINI_H = 112;

/** The whole canvas in small, with the part in view; click or drag in it to go somewhere. Hidden while everything is in view. */
function Minimap(p: {
  canvas: Canvas;
  schema: Schema;
  selected: string | null;
  view: View;
  size: { w: number; h: number };
  setView: SurfaceProps["setView"];
}) {
  const content = useMemo(() => contentBounds(p.canvas, p.schema), [p.canvas, p.schema]);
  if (!content || !p.size.w) return null;
  const vw = p.size.w / p.view.zoom;
  const vh = p.size.h / p.view.zoom;
  const inView =
    content.x >= p.view.pan.x &&
    content.y >= p.view.pan.y &&
    content.x + content.w <= p.view.pan.x + vw &&
    content.y + content.h <= p.view.pan.y + vh;
  if (inView) return null;
  const x0 = Math.min(content.x, p.view.pan.x);
  const y0 = Math.min(content.y, p.view.pan.y);
  const x1 = Math.max(content.x + content.w, p.view.pan.x + vw);
  const y1 = Math.max(content.y + content.h, p.view.pan.y + vh);
  const scale = Math.min((MINI_W - 12) / (x1 - x0), (MINI_H - 12) / (y1 - y0));

  const go = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => {
      const cx = x0 + (ev.clientX - r.left - 6) / scale;
      const cy = y0 + (ev.clientY - r.top - 6) / scale;
      p.setView((v) => ({ ...v, pan: { x: cx - p.size.w / 2 / v.zoom, y: cy - p.size.h / 2 / v.zoom } }));
    };
    e.preventDefault();
    e.stopPropagation();
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="minimap" aria-hidden onPointerDown={go}>
      <MinimapItems canvas={p.canvas} schema={p.schema} selected={p.selected} x0={x0} y0={y0} scale={scale} />
      <div
        className="minimap-view"
        style={{ left: 6 + (p.view.pan.x - x0) * scale, top: 6 + (p.view.pan.y - y0) * scale, width: vw * scale, height: vh * scale }}
      />
    </div>
  );
}

/** The tables and notes of the minimap; drawn again only when they or the minimap's scale change. */
const MinimapItems = memo(function MinimapItems(p: { canvas: Canvas; schema: Schema; selected: string | null; x0: number; y0: number; scale: number }) {
  const { x0, y0, scale } = p;
  return (
    <>
      {shownTables(p.canvas).map((k) => {
        const r = cardRect(k, p.canvas, p.schema);
        return (
          <div
            key={k}
            className={k === p.selected ? "sel" : ""}
            style={{ left: 6 + (r.x - x0) * scale, top: 6 + (r.y - y0) * scale, width: Math.max(2, r.w * scale), height: Math.max(2, r.h * scale) }}
          />
        );
      })}
      {p.canvas.notes.map((n) => (
        <div
          key={n.id}
          className="note"
          style={{ left: 6 + (n.x - x0) * scale, top: 6 + (n.y - y0) * scale, width: Math.max(2, n.w * scale), height: Math.max(2, 80 * scale) }}
        />
      ))}
    </>
  );
});
