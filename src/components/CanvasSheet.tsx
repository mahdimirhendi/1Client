import { useMemo, useState } from "react";
import { useCanvases, type CanvasSheet as SheetState } from "../canvases";
import { displayName, indexSchema, inScope, parsePatterns } from "../lib/diagram";
import { defaultSchema } from "../lib/sql";
import { useApp } from "../store";
import type { CanvasScope } from "../types";
import { exact } from "../lib/input";

type Kind = CanvasScope["kind"];

const SCOPES: [Kind, string, string][] = [
  ["all", "Whole database", "Every table, now and in the future."],
  ["pattern", "Tables matching a pattern", "By name, for example legal_* or *_audit. Separate several with commas."],
  ["picked", "Tables I pick", "Tick tables in the panel. You can add more later."],
  ["neighbours", "A table and its neighbours", "Start from one table and follow its foreign keys."],
];

/** "Legal" for `legal_*`: a name to use when none is typed. */
function suggestName(kind: Kind, patterns: string[], root: string, name: (k: string) => string): string {
  if (kind === "all") return "Whole database";
  if (kind === "picked") return "My tables";
  if (kind === "neighbours") return root ? `${name(root)} and neighbours` : "Neighbours";
  const words = (patterns[0] ?? "").replace(/^.*\./, "").replace(/[*?]/g, " ").replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Tables";
}

/** New Canvas, or Edit Canvas (name and scope) for an existing one. */
export function CanvasSheet({ sheet }: { sheet: SheetState }) {
  const conn = useApp((s) => s.conns.find((c) => c.id === sheet.connId));
  const { byProfile, setSheet, create, edit } = useCanvases();
  const existing = sheet.mode === "edit" ? byProfile[conn?.profile.id ?? ""]?.list?.find((c) => c.id === sheet.canvasId) : undefined;
  const schema = useMemo(() => indexSchema(conn?.schema ?? []), [conn?.schema]);
  const first = conn ? defaultSchema(conn.profile) : "";
  const name = (k: string) => displayName(k, first);
  const tables = useMemo(
    () => [...schema.keys()].sort((a, b) => Number(b.startsWith(first + ".")) - Number(a.startsWith(first + ".")) || a.localeCompare(b)),
    [schema, first],
  );

  const scope = existing?.scope;
  const [title, setTitle] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<Kind>(scope?.kind ?? "pattern");
  const [pattern, setPattern] = useState(scope?.kind === "pattern" ? scope.patterns.join(", ") : "");
  const [root, setRoot] = useState(scope?.kind === "neighbours" ? scope.root : (sheet.mode === "new" && sheet.root) || tables[0] || "");
  const [depth, setDepth] = useState(scope?.kind === "neighbours" ? scope.depth : 1);
  const [autoAdd, setAutoAdd] = useState(existing?.autoAdd ?? true);
  const [keysOnly, setKeysOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!conn) return null;
  const close = () => setSheet(null);
  const patterns = parsePatterns(pattern);
  const next: CanvasScope =
    kind === "pattern" ? { kind, patterns } : kind === "neighbours" ? { kind, root, depth } : { kind };
  const count = kind === "picked" ? 0 : inScope(next, schema).size;
  const suggestion = suggestName(kind, patterns, root, name);

  const submit = () => {
    if (kind === "pattern" && !patterns.length) return setError("Enter a pattern, for example legal_*.");
    if (kind === "neighbours" && !schema.has(root)) return setError("Pick the table to start from.");
    const spec = { name: title.trim() || suggestion, scope: next, autoAdd, keysOnly };
    if (existing) edit(conn, existing.id, spec);
    else create(conn, spec);
    close();
  };

  const hint = !autoAdd
    ? "New tables are listed in the panel, unchecked."
    : kind === "all"
      ? "Tables created later are placed on this canvas for you."
      : kind === "pattern"
        ? `New tables matching ${patterns.join(", ") || "the pattern"} are placed here for you.`
        : `New tables that link to ${root ? name(root) : "the table"} are placed here for you.`;

  const footer =
    kind === "picked"
      ? existing
        ? "Keeps the tables on it now"
        : "Starts empty: tick tables in the panel to add them"
      : `${existing ? "Shows" : "Starts with"} ${count} table${count === 1 ? "" : "s"}${existing ? "" : " · laid out automatically"}`;

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => e.key === "Escape" && close()}
    >
      <div className="sheet canvas-sheet" role="dialog" aria-labelledby="canvas-sheet-title">
        <div className="canvas-sheet-head">
          <div id="canvas-sheet-title" className="sheet-title">
            {existing ? "Edit Canvas" : "New Canvas"}
          </div>
          <div className="muted">
            A saved view of {conn.profile.database || conn.profile.name}. Tables and columns stay in sync with the database.
          </div>
        </div>
        <div className="canvas-sheet-body">
          <label className="field-row">
            <span>Name</span>
            <input
              {...exact}
              className="fill-field grow"
              aria-label="Canvas name"
              autoFocus
              placeholder={suggestion}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
          <div className="scopes" role="radiogroup" aria-label="What the canvas shows">
            {SCOPES.map(([k, t, d]) => (
              <div
                key={k}
                className={`scope ${kind === k ? "on" : ""}`}
                role="radio"
                aria-checked={kind === k}
                tabIndex={0}
                onClick={() => (setKind(k), setError(null))}
                onKeyDown={(e) => (e.key === " " || e.key === "Enter") && e.target === e.currentTarget && setKind(k)}
              >
                <span className="radio" />
                <span className="scope-text">
                  <b>{t}</b>
                  <small>{d}</small>
                  {kind === k && k === "pattern" && (
                    <span className="scope-extra">
                      <input
                        {...exact}
                        className="fill-field mono"
                        aria-label="Table name pattern"
                        placeholder="billing_*"
                        autoFocus={!existing}
                        value={pattern}
                        onChange={(e) => (setPattern(e.target.value), setError(null))}
                        onKeyDown={(e) => e.key === "Enter" && submit()}
                      />
                      <span>
                        {patterns.length ? `matches ${count} table${count === 1 ? "" : "s"} now` : "case is ignored; * matches anything"}
                      </span>
                    </span>
                  )}
                  {kind === k && k === "neighbours" && (
                    <span className="scope-extra">
                      <select className="popup scope-root" aria-label="Start from" value={root} onChange={(e) => setRoot(e.target.value)}>
                        {tables.map((t) => (
                          <option key={t} value={t}>
                            {name(t)}
                          </option>
                        ))}
                      </select>
                      and tables up to
                      <span className="segmented small" role="radiogroup" aria-label="Links away">
                        {[1, 2].map((n) => (
                          <button key={n} role="radio" aria-checked={depth === n} className={depth === n ? "on" : ""} onClick={() => setDepth(n)}>
                            {n}
                          </button>
                        ))}
                      </span>
                      link{depth > 1 ? "s" : ""} away
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          {kind !== "picked" && (
            <button className="switch-row" role="switch" aria-checked={autoAdd} onClick={() => setAutoAdd(!autoAdd)}>
              <span className="grow">
                <span className="switch-title">Add new matching tables automatically</span>
                <span className="hint">{hint}</span>
              </span>
              <span className={`switch ${autoAdd ? "on" : ""}`}>
                <span />
              </span>
            </button>
          )}
          {!existing && kind !== "picked" && (
            <div className="field-row">
              <span>Columns</span>
              <span className="segmented small" role="radiogroup" aria-label="Columns">
                <button role="radio" aria-checked={!keysOnly} className={!keysOnly ? "on" : ""} onClick={() => setKeysOnly(false)}>
                  All columns
                </button>
                <button role="radio" aria-checked={keysOnly} className={keysOnly ? "on" : ""} onClick={() => setKeysOnly(true)}>
                  Keys only
                </button>
              </span>
            </div>
          )}
          {error && <div className="error-text small">{error}</div>}
        </div>
        <div className="sheet-foot">
          <span className="grow hint">{footer}</span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {existing ? "Save" : "Create Canvas"}
          </button>
        </div>
      </div>
    </div>
  );
}
