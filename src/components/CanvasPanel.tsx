import { memo, useMemo, useState } from "react";
import { inScope, scopeLabel, shortType, shownTables, type Changes, type Schema } from "../lib/diagram";
import type { Canvas } from "../types";
import { IconCheck, IconSearch } from "./Icons";

interface PanelProps {
  canvas: Canvas;
  schema: Schema;
  changes: Changes;
  name: (key: string) => string;
  defaultSchema: string;
  selected: string | null;
  expanded: string | null;
  filterRef: React.RefObject<HTMLInputElement | null>;
  on: PanelHandlers;
}

export interface PanelHandlers {
  /** Select a table, show or hide its columns here, and bring it into view. */
  pick(key: string): void;
  toggleTable(key: string, show: boolean): void;
  toggleColumn(key: string, column: string): void;
  toggleAutoAdd(): void;
  edit(): void;
}

function Check({ on, small }: { on: boolean; small?: boolean }) {
  return (
    <span className={`check ${on ? "on" : ""} ${small ? "small" : ""}`} aria-hidden>
      {on && <IconCheck size={small ? 8 : 9} color="#fff" />}
    </span>
  );
}

/** "In this canvas": the tables of the canvas's scope with a checkbox each, and the canvas's rules. */
export const CanvasPanel = memo(function CanvasPanel(p: PanelProps) {
  const { canvas, schema } = p;
  const [filter, setFilter] = useState("");

  // In scope, plus anything on the canvas that no longer is (dropped, or no longer linked). The
  // default schema first, like the sidebar.
  const rows = useMemo(() => {
    const keys = inScope(canvas.scope, schema);
    for (const k of Object.keys(canvas.positions)) keys.add(k);
    const first = p.defaultSchema + ".";
    return [...keys].sort((a, b) => Number(b.startsWith(first)) - Number(a.startsWith(first)) || a.localeCompare(b));
  }, [canvas.scope, canvas.positions, schema, p.defaultSchema]);
  const shown = useMemo(() => new Set(shownTables(canvas)), [canvas]);
  const fresh = useMemo(() => new Set(p.changes.addedTables), [p.changes]);
  const f = filter.trim().toLowerCase();
  const list = f ? rows.filter((k) => k.toLowerCase().includes(f)) : rows;
  const inScopeCount = rows.filter((k) => schema.has(k)).length;
  const onCount = rows.filter((k) => shown.has(k) && schema.has(k)).length;
  const label = scopeLabel(canvas.scope, p.defaultSchema);

  return (
    <aside className="canvas-panel" aria-label="In this canvas">
      <div className="panel-head">
        <b>In this canvas</b>
        <span>
          {onCount} of {inScopeCount} table{inScopeCount === 1 ? "" : "s"}
        </span>
      </div>
      <label className="search-field panel-search">
        <IconSearch size={11} color="var(--label-secondary)" />
        <input
          ref={p.filterRef}
          aria-label="Filter tables"
          placeholder="Filter tables"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
        />
      </label>
      <div className="layers" role="list">
        {list.length === 0 && <div className="sidebar-note">{f ? "No table matches." : "No tables in this canvas's scope."}</div>}
        {list.map((k) => {
          const t = schema.get(k);
          const on = shown.has(k);
          const open = on && !!t && p.expanded === k;
          const hidden = canvas.hiddenColumns[k] ?? [];
          return (
            <div key={k} role="listitem">
              <div className={`layer-row ${on ? "" : "off"} ${p.selected === k ? "sel" : ""}`}>
                <button
                  className="check-btn"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={`Show ${p.name(k)}`}
                  onClick={() => p.on.toggleTable(k, !on)}
                >
                  <Check on={on} />
                </button>
                <button className="layer-name" onClick={() => p.on.pick(k)} title={k}>
                  <span className="ellipsis">{p.name(k)}</span>
                  {fresh.has(k) && <span className="new-tag">NEW</span>}
                </button>
                <span className="layer-meta">
                  {!t ? "dropped" : on ? `${t.columns.length - hidden.filter((c) => t.columns.some((x) => x.name === c)).length}/${t.columns.length}` : "hidden"}
                </span>
              </div>
              {open && (
                <div className="layer-cols" role="group" aria-label={`Columns of ${p.name(k)}`}>
                  {t.columns.map((c) => {
                    const vis = !hidden.includes(c.name);
                    return (
                      <button
                        key={c.name}
                        className={`layer-col ${vis ? "" : "off"}`}
                        role="checkbox"
                        aria-checked={vis}
                        onClick={() => p.on.toggleColumn(k, c.name)}
                      >
                        <Check on={vis} small />
                        <span className="grow ellipsis">{c.name}</span>
                        <span className="mono ellipsis">{shortType(c.dataType)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="canvas-rules">
        <div className="rules-title">What this canvas shows</div>
        <div className="rules-scope">
          <span className="grow">{label.title}</span>
          {label.chip && <span className="chip mono ellipsis">{label.chip}</span>}
        </div>
        {canvas.scope.kind !== "picked" && (
          <button className="switch-row" role="switch" aria-checked={canvas.autoAdd} onClick={p.on.toggleAutoAdd}>
            <span className="grow">Add new matching tables automatically</span>
            <span className={`switch ${canvas.autoAdd ? "on" : ""}`}>
              <span />
            </span>
          </button>
        )}
        <div className="hint">New columns always appear. Dropped tables are marked, never silently removed.</div>
        <button className="link-btn" onClick={p.on.edit}>
          Edit Canvas…
        </button>
      </div>
    </aside>
  );
});
