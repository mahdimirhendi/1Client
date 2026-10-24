import { useRef, useState } from "react";
import { api } from "../api";
import { showToast } from "../lib/toast";
import { useApp, type ConnTab, type DocTab } from "../store";
import type { AppError } from "../types";
import { ConnectionTabs } from "./ConnectionTabs";
import { openMenuBelow, type MenuItem } from "./ContextMenu";
import { Diagram } from "./Diagram";
import { DocTabs } from "./DocTabs";
import { FilterBar } from "./FilterBar";
import { IconChevron, IconDatabase, IconPlay } from "./Icons";
import { QueryEditor, runActive, useEditorStatus } from "./QueryEditor";
import { Results } from "./Results";
import { Sidebar } from "./Sidebar";

const SPLIT_KEY = "oneclient.editorHeight";

function savedSplit(): number {
  try {
    return Number(localStorage.getItem(SPLIT_KEY)) || 0.45;
  } catch {
    return 0.45;
  }
}

export function Workspace() {
  const { conns, activeConn } = useApp();
  const [split, setSplit] = useState(savedSplit);
  const main = useRef<HTMLElement>(null);
  const conn = conns.find((c) => c.id === activeConn) ?? conns[0];
  if (!conn) return null;
  const doc = conn.docs.find((d) => d.id === conn.activeDoc) ?? conn.docs[0];

  const startDrag = (e: React.PointerEvent) => {
    const el = main.current;
    if (!el) return;
    e.preventDefault();
    const box = el.getBoundingClientRect();
    const top = box.top + 34; // below the inner tab bar
    const move = (ev: PointerEvent) => {
      const frac = Math.min(0.85, Math.max(0.12, (ev.clientY - top) / (box.bottom - top)));
      setSplit(frac);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSplit((f) => {
        try {
          localStorage.setItem(SPLIT_KEY, String(f));
        } catch {
          /* per-device convenience only */
        }
        return f;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="window">
      <Toolbar conn={conn} doc={doc} />
      <ConnectionTabs />
      {conn.view === "diagram" ? (
        <Diagram conn={conn} />
      ) : (
        <div className="body">
          <Sidebar conn={conn} />
          <main className="main" ref={main}>
            <DocTabs conn={conn} />
            {!doc ? (
              <NoTabs connId={conn.id} />
            ) : (
              <>
                {doc.showEditor && (
                  <>
                    <div className="editor-pane" style={{ flex: `0 0 ${split * 100}%` }}>
                      <QueryEditor key={`${conn.id}:${doc.id}`} conn={conn} doc={doc} />
                    </div>
                    <div className="splitter" role="separator" aria-orientation="horizontal" onPointerDown={startDrag} />
                  </>
                )}
                {doc.table && <FilterBar key={`filters:${conn.id}:${doc.id}`} conn={conn} doc={doc} />}
                <Results key={`${conn.id}:${doc.id}`} conn={conn} doc={doc} />
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

/** Every tab of the connection is closed; the connection itself stays open. */
function NoTabs({ connId }: { connId: string }) {
  const newQuery = useApp((s) => s.newQuery);
  return (
    <div className="no-tabs">
      <div className="no-tabs-title">No open tabs</div>
      <div className="muted">Start a query, or double-click a table in the sidebar to browse it.</div>
      <button className="btn primary" onClick={() => newQuery(connId)}>
        New Query <span className="kbd">⌘T</span>
      </button>
    </div>
  );
}

/** The database the tab is in; click to pick another one on the same server. */
function DatabaseSwitcher({ conn }: { conn: ConnTab }) {
  const [opening, setOpening] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const mysql = conn.profile.engine === "mysql";

  const switchTo = async (database: string) => {
    setOpening(database);
    await useApp.getState().useDatabase(conn.id, database);
    setOpening(null);
  };
  const pick = async (button: HTMLElement) => {
    if (listing || opening !== null) return;
    setListing(true);
    try {
      const names = await api.sessionDatabases(conn.id);
      const items: MenuItem[] = names.map((n) => ({ label: n, checked: n === conn.database, action: () => switchTo(n) }));
      // MySQL can also work without a default database; the sidebar then shows all of them.
      if (mysql) items.unshift({ label: "All databases", checked: !conn.database, action: () => switchTo("") }, "separator");
      openMenuBelow(button, items, names.length > 10);
    } catch (e) {
      showToast(`Couldn't list the databases: ${(e as AppError).message}`, "error");
    } finally {
      setListing(false);
    }
  };

  const shown = opening ?? conn.database;
  return (
    <button
      className="db-switcher"
      title="Switch to another database on this server"
      aria-label={`Database ${shown || "none"}. Switch database`}
      aria-busy={listing || opening !== null}
      onClick={(e) => pick(e.currentTarget)}
    >
      <IconDatabase color="var(--label-secondary)" />
      <span className={opening !== null ? "muted" : undefined}>{opening !== null ? `Opening ${shown || "all databases"}…` : shown || "All databases"}</span>
      <IconChevron open />
    </button>
  );
}

function Toolbar({ conn, doc }: { conn: ConnTab; doc?: DocTab }) {
  const { toggleEditor, run, temporary, saveTemporary, setView, refreshSchema } = useApp();
  const diagram = conn.view === "diagram";
  const hasSelection = useEditorStatus((s) => s.selected > 0);
  const isTemporary = !!temporary[conn.profile.id];
  const hops = conn.info.hops;
  const firstHop = conn.profile.network.hops[0]?.host;
  // With the editor hidden (a table tab), Run re-runs the tab's query, which works as Refresh.
  const runNow = (mode: "statement" | "all") => {
    if (doc?.showEditor) runActive(mode);
    else if (doc) run(conn.id, doc.id, doc.sql);
  };

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="traffic-space" data-tauri-drag-region />
      <div className="toolbar-db">
        <DatabaseSwitcher conn={conn} />
        <span className="muted">·</span>
        <span className="muted">{conn.info.serverVersion}</span>
      </div>
      {hops > 0 && (
        <div className="pill ok">
          <span className="dot ok" />
          via {firstHop} · {hops} hop{hops > 1 ? "s" : ""}
        </div>
      )}
      {conn.profile.readOnly && <div className="pill">Read-only</div>}
      {isTemporary && (
        <button className="btn small" title="Opened from a link. Save it to keep it in your connections." onClick={() => saveTemporary(conn.id)}>
          Save Connection
        </button>
      )}
      <div className="grow" data-tauri-drag-region />
      <div className="segmented" role="tablist" aria-label="Show">
        <button role="tab" aria-selected={!diagram} className={diagram ? "" : "on"} onClick={() => setView(conn.id, "query")}>
          Query
        </button>
        <button
          role="tab"
          aria-selected={diagram}
          className={diagram ? "on" : ""}
          title="Diagram of the tables (⇧⌘D)"
          onClick={() => setView(conn.id, "diagram")}
        >
          Diagram
        </button>
      </div>
      {diagram && (
        <button className="btn" title="Read the tables again (⌘R)" onClick={() => refreshSchema(conn.id)}>
          ↻ Refresh <span className="kbd muted">⌘R</span>
        </button>
      )}
      {doc && !diagram && (
        <>
          <button
            className={`btn toggle ${doc.showEditor ? "on" : ""}`}
            aria-pressed={doc.showEditor}
            title={doc.showEditor ? "Hide SQL editor (⌘E)" : "Show SQL editor (⌘E)"}
            onClick={() => toggleEditor(conn.id, doc.id)}
          >
            <svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="0.65" y="0.65" width="12.7" height="10.7" rx="2" />
              <path d="M0.65 5.5h12.7" />
            </svg>
            SQL
          </button>
          {doc.showEditor ? (
            <>
              <button className="btn primary run-btn" onClick={() => runNow("statement")}>
                <IconPlay color="#fff" /> {hasSelection ? "Run Selection" : "Run Statement"} <span className="kbd">⌘↵</span>
              </button>
              <button className="btn" onClick={() => runNow("all")}>
                Run All <span className="kbd muted">⇧⌘↵</span>
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => runNow("all")} disabled={doc.running}>
              ↻ Refresh <span className="kbd muted">⌘R</span>
            </button>
          )}
        </>
      )}
    </header>
  );
}
