import { useEffect, useMemo, useRef, useState } from "react";
import { FILTER_OPS, needsValue, whereSql, type Filter, type FilterOp, type TableView } from "../lib/sql";
import { useApp, type ConnTab, type DocTab } from "../store";
import { IconClose, IconPlus } from "./Icons";
import { exact } from "../lib/input";

type Match = NonNullable<TableView["match"]>;

const isComplete = (f: Filter) => !!f.column && (!needsValue(f.op) || f.value !== "");

const placeholder = (op: FilterOp) =>
  op === "in" || op === "notIn" ? "1, 2, 3" : op === "contains" || op === "notContains" || op.endsWith("With") ? "text" : "value";

/**
 * Filters of a table tab: column, operator and value per row, combined with AND (all) or OR (any),
 * or a condition typed by hand in SQL mode. They run on the server as a WHERE clause, so they
 * search the whole table. Enter applies, Escape goes back to what is applied.
 */
export function FilterBar({ conn, doc }: { conn: ConnTab; doc: DocTab }) {
  const setTableView = useApp((s) => s.setTableView);
  const view = doc.view;
  const applied = view?.filters;

  const columns = useMemo(() => {
    const t = conn.schema?.find((x) => x.schema === doc.table?.schema && x.name === doc.table?.name);
    return t ? t.columns.map((c) => c.name) : (doc.output?.sets[0]?.columns.map((c) => c.name) ?? []);
  }, [conn.schema, doc.table, doc.output]);

  const blank = (): Filter => ({ column: columns[0] ?? "", op: "eq", value: "" });
  const [rows, setRows] = useState<Filter[]>(() => (applied?.length ? applied : [blank()]));
  const [match, setMatch] = useState<Match>(view?.match ?? "all");
  const [sqlMode, setSqlMode] = useState(!!view?.where);
  const [where, setWhere] = useState(view?.where ?? "");
  const [notice, setNotice] = useState<string | null>(null);

  // Filters applied from elsewhere ("Filter by This Value") replace the draft; our own don't.
  const ours = useRef(applied);
  useEffect(() => {
    if (applied === ours.current) return;
    ours.current = applied;
    setRows(applied?.length ? applied : [blank()]);
    setMatch(view?.match ?? "all");
    setSqlMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  // A row added before the schema loaded gets the first column once it is known.
  useEffect(() => {
    if (columns.length) setRows((rs) => (rs.some((r) => !r.column) ? rs.map((r) => (r.column ? r : { ...r, column: columns[0] })) : rs));
  }, [columns]);

  /** Re-running would throw away unsaved edits in the grid, so filtering waits for them. */
  const blocked = () => {
    if (doc.dirty) setNotice("Save or discard your changes in the grid before filtering.");
    return !!doc.dirty;
  };

  const run = (next: TableView) => {
    setNotice(null);
    ours.current = next.filters;
    setTableView(conn.id, doc.id, { sort: view?.sort, ...next });
  };

  const apply = (next: Filter[] = rows, nextMatch: Match = match) => {
    if (blocked()) return;
    const filters = next.filter(isComplete);
    // With one filter or none, "any" means nothing; resetting it keeps a filter added later
    // (Filter by This Value) from being joined with OR without the toggle being visible.
    const m = filters.length > 1 ? nextMatch : "all";
    setMatch(m);
    run({ filters: filters.length ? filters : undefined, match: m });
  };

  const applyWhere = () => !blocked() && run({ where: where.trim() || undefined });

  const clear = () => {
    if (blocked()) return;
    setRows([blank()]);
    setWhere("");
    setMatch("all");
    run({});
  };

  const toggleSqlMode = () => {
    // Switching to SQL starts from the filters as SQL, so they can be adjusted by hand.
    if (!sqlMode) setWhere(view?.where ?? whereSql(conn.profile.engine, rows.filter(isComplete), match));
    setSqlMode(!sqlMode);
  };

  const patch = (i: number, p: Partial<Filter>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const remove = (i: number) => {
    // Removing an applied filter re-runs the query; with unsaved edits it waits like Apply.
    if (isComplete(rows[i]) && applied?.length && blocked()) return;
    const next = rows.filter((_, j) => j !== i);
    setRows(next.length ? next : [blank()]);
    if (isComplete(rows[i]) && applied?.length) apply(next);
  };

  const active = !!view?.where || !!applied?.length;
  const changed = sqlMode
    ? where.trim() !== (view?.where ?? "")
    : JSON.stringify(rows.filter(isComplete)) !== JSON.stringify(applied ?? []) || match !== (view?.match ?? "all");

  return (
    <div className={`filter-bar ${active ? "active" : ""}`} role="search" aria-label="Filter rows">
      <div className="filter-rows">
        {sqlMode ? (
          <div className="filter-row">
            <span className="filter-label mono">WHERE</span>
            <input
              {...exact}
              className="fill-field mono filter-where"
              aria-label="Condition in SQL"
              autoFocus
              placeholder={conn.profile.engine === "postgres" ? "created_at > now() - interval '7 days'" : "created_at > now() - interval 7 day"}
              value={where}
              onChange={(e) => setWhere(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyWhere();
                else if (e.key === "Escape") setWhere(view?.where ?? "");
              }}
            />
          </div>
        ) : (
          rows.map((r, i) => (
            <div key={i} className="filter-row">
              <span className="filter-label">{i === 0 ? "Filter" : match === "all" ? "and" : "or"}</span>
              <select className="popup filter-column" aria-label="Column" value={r.column} onChange={(e) => patch(i, { column: e.target.value })}>
                {!columns.includes(r.column) && <option value={r.column}>{r.column || "column"}</option>}
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select className="popup filter-op" aria-label="Operator" value={r.op} onChange={(e) => patch(i, { op: e.target.value as FilterOp })}>
                {FILTER_OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                {...exact}
                className="fill-field mono filter-value"
                aria-label="Value"
                disabled={!needsValue(r.op)}
                placeholder={needsValue(r.op) ? placeholder(r.op) : ""}
                value={needsValue(r.op) ? r.value : ""}
                onChange={(e) => patch(i, { value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") apply();
                  else if (e.key === "Escape") setRows(applied?.length ? applied : [blank()]);
                }}
              />
              <button className="filter-icon-btn" aria-label="Remove this filter" title="Remove" onClick={() => remove(i)}>
                <IconClose />
              </button>
              {i === rows.length - 1 && (
                <button className="filter-icon-btn" aria-label="Add a filter" title="Add a filter" onClick={() => setRows([...rows, blank()])}>
                  <IconPlus size={10} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="filter-actions">
        {notice && <span className="error-text small">{notice}</span>}
        {!sqlMode && rows.length > 1 && (
          <div className="segmented small" role="radiogroup" aria-label="Rows must match">
            {(["all", "any"] as Match[]).map((m) => (
              <button key={m} role="radio" aria-checked={match === m} className={match === m ? "on" : ""} onClick={() => setMatch(m)}>
                Match {m}
              </button>
            ))}
          </div>
        )}
        <button
          className={`btn small toggle ${sqlMode ? "on" : ""}`}
          aria-pressed={sqlMode}
          title={sqlMode ? "Back to column filters" : "Write the condition in SQL"}
          onClick={toggleSqlMode}
        >
          SQL
        </button>
        {active && (
          <button className="btn small" onClick={clear}>
            Clear
          </button>
        )}
        <button className={`btn small ${changed ? "primary" : ""}`} onClick={() => (sqlMode ? applyWhere() : apply())}>
          Apply
        </button>
      </div>
    </div>
  );
}
