import { useState } from "react";
import { copyWithFeedback } from "../lib/clipboard";
import { timeAgo } from "../lib/time";
import { queryName } from "../lib/sql";
import { useApp, type ConnTab } from "../store";
import type { HistoryEntry, SavedQuery } from "../types";
import { openMenu } from "./ContextMenu";

/** SQL on one line for a list, leaving out a leading `-- comment` (it is usually the name). */
function preview(sql: string): string {
  const lines = sql.trim().split("\n");
  const body = lines[0]?.trim().startsWith("--") && lines.length > 1 ? lines.slice(1) : lines;
  return body.join(" ").replace(/\s+/g, " ").trim();
}

const matches = (filter: string, ...texts: string[]) => {
  const f = filter.trim().toLowerCase();
  return !f || texts.some((t) => t.toLowerCase().includes(f));
};

/** The connection's saved queries. Double-click or Enter runs one in its own tab. */
export function SavedList({ conn, filter }: { conn: ConnTab; filter: string }) {
  const { openQuery, setSaveSheet, deleteSavedQuery } = useApp();
  if (!conn.saved) return <div className="sidebar-note">Loading…</div>;
  const list = conn.saved.filter((q) => matches(filter, q.name, q.sql));
  if (list.length === 0) {
    return (
      <div className="sidebar-note">
        {conn.saved.length ? "No saved query matches." : "No saved queries yet. Press ⌘S in a query tab to keep its SQL here."}
      </div>
    );
  }

  const run = (q: SavedQuery) => openQuery(conn.id, q.sql, { title: q.name, savedId: q.id, run: true });
  return (
    <div className="query-list" role="list" aria-label="Saved queries">
      {list.map((q) => (
        <div
          key={q.id}
          className="query-item"
          role="listitem"
          tabIndex={0}
          title={`${q.sql}\n\nDouble-click to run`}
          onDoubleClick={() => run(q)}
          onKeyDown={(e) => e.key === "Enter" && run(q)}
          onContextMenu={(e) =>
            openMenu(e, [
              { label: "Run", shortcut: "↩", action: () => run(q) },
              { label: "Open Without Running", action: () => openQuery(conn.id, q.sql, { title: q.name, savedId: q.id }) },
              "separator",
              { label: "Rename…", action: () => setSaveSheet({ connId: conn.id, id: q.id, name: q.name, sql: q.sql }) },
              { label: "Copy SQL", action: () => copyWithFeedback(q.sql, "SQL") },
              "separator",
              { label: "Delete", action: () => deleteSavedQuery(conn.id, q.id) },
            ])
          }
        >
          <span className="query-name ellipsis">{q.name}</span>
          <span className="query-sql mono">{preview(q.sql)}</span>
        </div>
      ))}
    </div>
  );
}

/** What ran on this connection, newest first. Double-click or Enter runs a query again in a new tab. */
export function HistoryList({ conn, filter }: { conn: ConnTab; filter: string }) {
  const { openQuery, setSaveSheet, deleteHistory, clearHistory } = useApp();
  const [armClear, setArmClear] = useState(false);
  if (!conn.history) return <div className="sidebar-note">Loading…</div>;
  const list = conn.history.filter((e) => matches(filter, e.sql));
  if (list.length === 0) {
    return (
      <div className="sidebar-note">
        {conn.history.length ? "Nothing in the history matches." : "Queries you run in a query tab show up here."}
      </div>
    );
  }

  const run = (e: HistoryEntry) => openQuery(conn.id, e.sql, { run: true });
  const outcome = (e: HistoryEntry) =>
    e.error ? "failed" : e.rows === null ? "" : `${e.rows.toLocaleString()} row${e.rows === 1 ? "" : "s"}`;
  return (
    <>
      <div className="query-list" role="list" aria-label="Query history">
        {list.map((e) => (
          <div
            key={e.id}
            className={`query-item ${e.error ? "failed" : ""}`}
            role="listitem"
            tabIndex={0}
            title={`${e.sql}${e.error ? `\n\n${e.error}` : ""}\n\nDouble-click to run again`}
            onDoubleClick={() => run(e)}
            onKeyDown={(ev) => ev.key === "Enter" && run(e)}
            onContextMenu={(ev) =>
              openMenu(ev, [
                { label: "Run Again", shortcut: "↩", action: () => run(e) },
                { label: "Open Without Running", action: () => openQuery(conn.id, e.sql) },
                "separator",
                { label: "Save Query…", action: () => setSaveSheet({ connId: conn.id, name: queryName(e.sql), sql: e.sql }) },
                { label: "Copy SQL", action: () => copyWithFeedback(e.sql, "SQL") },
                "separator",
                { label: "Remove from History", action: () => deleteHistory(conn.id, e.id) },
              ])
            }
          >
            <span className="query-sql mono clamp2">{preview(e.sql)}</span>
            <span className="query-meta">
              {[timeAgo(e.ranAt), `${e.elapsedMs.toLocaleString()} ms`, outcome(e)].filter(Boolean).join(" · ")}
            </span>
          </div>
        ))}
      </div>
      <button
        className={`btn small query-clear ${armClear ? "danger" : ""}`}
        onClick={() => (armClear ? clearHistory(conn.id) : setArmClear(true))}
        onBlur={() => setArmClear(false)}
      >
        {armClear ? "Confirm Clear History" : "Clear History"}
      </button>
    </>
  );
}
