import { useMemo, useState } from "react";
import { defaultSchema } from "../lib/sql";
import { useApp, type ConnTab } from "../store";
import type { TableInfo } from "../types";
import { AppearanceSwitch } from "./AppearanceSwitch";
import { IconChevron, IconSearch, IconTable } from "./Icons";
import { HistoryList, SavedList } from "./QueryLists";

const COLLAPSED_KEY = "oneclient.collapsedSchemas.";
const PANEL_KEY = "oneclient.sidebarPanel";

type Panel = "tables" | "saved" | "history";
const PANELS: [Panel, string][] = [
  ["tables", "Tables"],
  ["saved", "Saved"],
  ["history", "History"],
];
const FILTER_LABEL: Record<Panel, string> = { tables: "Filter tables", saved: "Filter saved queries", history: "Filter history" };

/** The panel shown last time, on this device. */
function rememberedPanel(): Panel {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    return v === "saved" || v === "history" ? v : "tables";
  } catch {
    return "tables";
  }
}

/** Collapsed schema groups, remembered per saved connection. */
function useCollapsedSchemas(profileId: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY + profileId) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (schema: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (!next.delete(schema)) next.add(schema);
      try {
        localStorage.setItem(COLLAPSED_KEY + profileId, JSON.stringify([...next]));
      } catch {
        /* per-device convenience only */
      }
      return next;
    });
  return { collapsed, toggle };
}

export function Sidebar({ conn }: { conn: ConnTab }) {
  const { openTable, refreshSchema } = useApp();
  const [panel, setPanel] = useState<Panel>(rememberedPanel);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { collapsed, toggle } = useCollapsedSchemas(conn.profile.id);

  const showPanel = (p: Panel) => {
    setPanel(p);
    setFilter("");
    try {
      localStorage.setItem(PANEL_KEY, p);
    } catch {
      /* per-device convenience only */
    }
  };

  // Tables grouped by schema: the default one first (public on PostgreSQL), then the others in the
  // order the server listed them (alphabetical).
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const map = new Map<string, TableInfo[]>();
    for (const t of conn.schema ?? []) {
      if (f && !t.name.toLowerCase().includes(f)) continue;
      const list = map.get(t.schema);
      if (list) list.push(t);
      else map.set(t.schema, [t]);
    }
    const first = defaultSchema(conn.profile);
    return [...map.entries()].sort(([a], [b]) => Number(b === first) - Number(a === first));
  }, [conn.schema, conn.profile, filter]);

  return (
    <aside className="sidebar">
      <div className="sidebar-panels">
        <div className="segmented small" role="tablist" aria-label="Sidebar">
          {PANELS.map(([p, label]) => (
            <button key={p} role="tab" aria-selected={panel === p} className={panel === p ? "on" : ""} onClick={() => showPanel(p)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="sidebar-top">
        <label className="search-field">
          <IconSearch size={11} color="var(--label-secondary)" />
          <input aria-label={FILTER_LABEL[panel]} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {panel === "tables" && (
          <button className="btn tiny" title="Reload schema" onClick={() => refreshSchema(conn.id)}>
            ↻
          </button>
        )}
      </div>

      {panel === "saved" && (
        <div className="tree">
          <SavedList conn={conn} filter={filter} />
        </div>
      )}
      {panel === "history" && (
        <div className="tree">
          <HistoryList conn={conn} filter={filter} />
        </div>
      )}
      <div className="tree" hidden={panel !== "tables"}>
        {!conn.schema && !conn.schemaError && <div className="muted small pad">Loading schema…</div>}
        {conn.schemaError && <div className="error-text small pad">{conn.schemaError.message}</div>}
        {conn.schema && groups.length === 0 && (
          <div className="muted small pad">{filter ? "No table matches." : "No tables."}</div>
        )}
        {groups.map(([schema, tables]) => {
          // While filtering, every group with a match is shown open.
          const expanded = !!filter.trim() || !collapsed.has(schema);
          return (
            <div key={schema} role="group" aria-label={`Schema ${schema}`}>
              <button className="tree-section" aria-expanded={expanded} onClick={() => toggle(schema)}>
                <IconChevron open={expanded} />
                <span className="grow ellipsis">{schema}</span>
                <span className="tree-count">{tables.length}</span>
              </button>
              {expanded && (
                <div className="tree-group">
                  {tables.map((t) => {
                    const key = `${t.schema}.${t.name}`;
                    const isOpen = !!open[key];
                    return (
                      <div key={key}>
                        <div className="tree-row" onDoubleClick={() => openTable(conn.id, t)} title={`${key} · double-click to open`}>
                          <button
                            className="tree-chev"
                            aria-label={isOpen ? "Collapse" : "Expand"}
                            onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
                          >
                            <IconChevron open={isOpen} />
                          </button>
                          <IconTable color={t.kind === "view" ? "var(--label-tertiary)" : "var(--engine-postgres)"} />
                          <span className="grow ellipsis">{t.name}</span>
                        </div>
                        {isOpen &&
                          t.columns.map((c) => (
                            <div key={c.name} className="tree-row tree-col">
                              <span className={`key-tag ${c.primaryKey ? "pk" : c.foreignKey ? "fk" : ""}`}>
                                {c.primaryKey ? "PK" : c.foreignKey ? "FK" : "·"}
                              </span>
                              <span className="grow ellipsis">{c.name}</span>
                              <span className="mono muted tiny-text">{c.dataType}</span>
                            </div>
                          ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <span className="dot ok" />
        <span className="grow">{conn.info.hops ? "Tunnel healthy" : "Connected"}</span>
        <AppearanceSwitch compact />
      </div>
    </aside>
  );
}
