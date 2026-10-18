import { useEffect, useRef, useState } from "react";
import { ENV_PALETTE } from "../lib/theme";
import { useApp } from "../store";
import type { EnvironmentDef } from "../types";
import { IconPlus } from "./Icons";

const ROW_H = 44;

const IconGrip = () => (
  <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden>
    {[2, 6, 10].flatMap((y) => [<circle key={`a${y}`} cx="2" cy={y} r="1.1" />, <circle key={`b${y}`} cx="6" cy={y} r="1.1" />])}
  </svg>
);

const IconTrash = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
    <path d="M2.5 3.5h9M5.5 3.5V2.2h3v1.3M3.7 3.5l.6 8.3h5.4l.6-8.3M6 6v3.8M8 6v3.8" />
  </svg>
);

/** Add, rename, recolor, reorder (drag the handle) and remove environment tags. */
export function EnvironmentsSheet() {
  const { environments, saveEnvironments, setEnvSheet } = useApp();
  const [list, setList] = useState<EnvironmentDef[]>(() => environments.map((e) => ({ ...e })));
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const patch = (id: string, p: Partial<EnvironmentDef>) => setList((l) => l.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const moveTo = (id: string, to: number) =>
    setList((l) => {
      const from = l.findIndex((e) => e.id === id);
      const j = Math.max(0, Math.min(l.length - 1, to));
      if (from < 0 || from === j) return l;
      const n = [...l];
      n.splice(j, 0, n.splice(from, 1)[0]);
      return n;
    });

  const add = () => {
    const used = new Set(list.map((e) => e.color));
    const color = ENV_PALETTE.find(([, hex]) => !used.has(hex))?.[1] ?? "#5B5BD6";
    const e: EnvironmentDef = { id: crypto.randomUUID(), name: "", color, confirmWrites: false };
    setList((l) => [...l, e]);
    setFocusId(e.id);
  };

  const save = async () => {
    const cleaned = list.map((e) => ({ ...e, name: e.name.trim() }));
    if (cleaned.some((e) => !e.name)) {
      setError("Every environment needs a name.");
      return;
    }
    try {
      await saveEnvironments(cleaned);
      setEnvSheet(false);
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    }
  };

  // Drag to reorder: follow the pointer and drop the row into the slot under it.
  const startDrag = (id: string, ev: React.PointerEvent) => {
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    setDragId(id);
  };
  const onDrag = (ev: React.PointerEvent) => {
    if (!dragId || !listRef.current) return;
    const top = listRef.current.getBoundingClientRect().top;
    moveTo(dragId, Math.floor((ev.clientY - top) / ROW_H));
  };

  const openPicker = (id: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPicker(picker?.id === id ? null : { id, x: r.left - 10, y: r.bottom + 8 });
  };
  const pickerEnv = list.find((e) => e.id === picker?.id);

  return (
    <div
      className="sheet-backdrop"
      style={{ zIndex: 30 }}
      onMouseDown={(e) => e.target === e.currentTarget && setEnvSheet(false)}
      onKeyDown={(e) => e.key === "Escape" && (picker ? setPicker(null) : setEnvSheet(false))}
    >
      <div className="sheet envs" role="dialog" aria-labelledby="envs-title">
        <div className="envs-head">
          <div id="envs-title" className="sheet-title">
            Environments
          </div>
          <div className="muted">Color-code connections so you always know where you are.</div>
        </div>

        <div className="envs-body">
          <div className="envs-cols">
            <span>Name</span>
            <span>Confirm writes</span>
          </div>
          <div className="group envs-list" ref={listRef}>
            {list.map((e, i) => (
              <div key={e.id} className={`envs-row ${dragId === e.id ? "dragging" : ""}`}>
                <button
                  className="envs-grip"
                  aria-label={`Reorder ${e.name}. Use the arrow keys to move.`}
                  onPointerDown={(ev) => startDrag(e.id, ev)}
                  onPointerMove={onDrag}
                  onPointerUp={() => setDragId(null)}
                  onPointerCancel={() => setDragId(null)}
                  onKeyDown={(ev) => {
                    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
                      ev.preventDefault();
                      moveTo(e.id, i + (ev.key === "ArrowUp" ? -1 : 1));
                    }
                  }}
                >
                  <IconGrip />
                </button>
                <button
                  className="envs-dot"
                  aria-label={`Color of ${e.name || "environment"}`}
                  aria-expanded={picker?.id === e.id}
                  style={{ background: e.color }}
                  onClick={(ev) => openPicker(e.id, ev.currentTarget)}
                />
                <input
                  className="envs-name"
                  aria-label="Environment name"
                  placeholder="Name"
                  value={e.name}
                  autoFocus={focusId === e.id}
                  onChange={(ev) => patch(e.id, { name: ev.target.value })}
                  onKeyDown={(ev) => ev.key === "Enter" && (ev.target as HTMLInputElement).blur()}
                />
                <button
                  type="button"
                  role="switch"
                  aria-checked={e.confirmWrites}
                  aria-label={`Confirm writes in ${e.name}`}
                  className={`switch ${e.confirmWrites ? "on" : ""}`}
                  onClick={() => patch(e.id, { confirmWrites: !e.confirmWrites })}
                >
                  <span />
                </button>
                <button
                  className="envs-remove"
                  aria-label={`Remove ${e.name}`}
                  title="Remove"
                  disabled={list.length === 1}
                  onClick={() => setList((l) => l.filter((x) => x.id !== e.id))}
                >
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
          <button className="envs-add" onClick={add}>
            <IconPlus size={11} /> Add Environment
          </button>
        </div>

        <div className="sheet-foot envs-foot">
          <div className="grow small">
            {error ? <span className="error-text">{error}</span> : <span className="muted">Removing one moves its connections to Local.</span>}
          </div>
          <button className="btn" onClick={() => setEnvSheet(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Done
          </button>
        </div>
      </div>

      {picker && pickerEnv && (
        <ColorPopover
          x={picker.x}
          y={picker.y}
          value={pickerEnv.color}
          onPick={(color, close) => {
            patch(pickerEnv.id, { color });
            if (close) setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function ColorPopover(props: { x: number; y: number; value: string; onPick(color: string, close: boolean): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".envs-dot")) props.onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  });
  const custom = !ENV_PALETTE.some(([, hex]) => hex === props.value);
  return (
    <div ref={ref} className="color-pop" role="dialog" aria-label="Color" style={{ left: props.x, top: props.y }}>
      {ENV_PALETTE.map(([name, hex]) => (
        <button
          key={hex}
          title={name}
          aria-label={name}
          className={`color-pop-swatch ${hex === props.value ? "on" : ""}`}
          style={{ background: hex, ["--ring" as string]: hex }}
          onClick={() => props.onPick(hex, true)}
        />
      ))}
      <label className={`color-pop-swatch custom ${custom ? "on" : ""}`} title="Custom color" style={{ ["--ring" as string]: props.value }}>
        <input type="color" aria-label="Custom color" value={props.value} onChange={(e) => props.onPick(e.target.value.toUpperCase(), false)} />
      </label>
    </div>
  );
}
