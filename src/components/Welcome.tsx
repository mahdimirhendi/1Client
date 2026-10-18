import { AppearanceSwitch } from "./AppearanceSwitch";
import { useMemo, useState } from "react";
import { useApp } from "../store";
import { AppIcon, EngineBadge, IconPlus, IconSearch } from "./Icons";
import { EnvTag } from "./EnvTag";

function describe(p: ReturnType<typeof useApp.getState>["profiles"][number]) {
  const engine = p.engine === "postgres" ? "PostgreSQL" : "MySQL";
  const hops = p.network.mode === "direct" ? [] : p.network.mode === "sshTunnel" ? p.network.hops.slice(0, 1) : p.network.hops;
  const via = hops.length ? ` via ${hops[0].host}${hops.length > 1 ? ` +${hops.length - 1}` : ""}` : `:${p.port}`;
  return `${engine} · ${p.host}${via}`;
}

function ago(ts?: number | null) {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Welcome() {
  const { profiles, openConnection, setSheet, connecting, connectError, conns, setShowWelcome, deleteProfile } = useApp();
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(
    () => profiles.filter((p) => `${p.name} ${p.host}`.toLowerCase().includes(q.toLowerCase())),
    [profiles, q],
  );

  return (
    <div className="welcome">
      <div className="welcome-left" data-tauri-drag-region>
        <div className="welcome-brand" data-tauri-drag-region>
          <AppIcon />
          <div className="welcome-name">1Client</div>
          <div className="muted">Version 0.1.0</div>
        </div>
        <div className="welcome-actions">
          <button className="welcome-action" onClick={() => setSheet({ mode: "new" })}>
            <span className="welcome-action-icon primary">
              <IconPlus size={14} color="#fff" />
            </span>
            <span className="grow">New Connection…</span>
            <span className="muted">⌘N</span>
          </button>
          {conns.length > 0 && (
            <button className="welcome-action" onClick={() => setShowWelcome(false)}>
              <span className="welcome-action-icon" />
              <span className="grow">Back to open connections</span>
            </button>
          )}
        </div>
        <div className="welcome-appearance">
          <span className="muted small">Appearance</span>
          <AppearanceSwitch />
        </div>
      </div>

      <div className="welcome-right">
        <div className="welcome-head" data-tauri-drag-region>
          <div className="welcome-title">Connections</div>
          <label className="search-field" style={{ width: 220 }}>
            <IconSearch color="var(--label-secondary)" />
            <input aria-label="Search connections" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>

        {connectError && (
          <div className="banner error">
            <b>Couldn’t connect.</b> {connectError.message}
            {connectError.hint && <div className="banner-hint">{connectError.hint}</div>}
          </div>
        )}

        <div className="welcome-list">
          {list.length === 0 && (
            <div className="empty">
              {profiles.length === 0 ? "No saved connections yet. Create one to get started." : "Nothing matches."}
            </div>
          )}
          {list.map((p) => (
            <div
              key={p.id}
              className={`conn-row ${selected === p.id ? "selected" : ""}`}
              onClick={() => setSelected(p.id)}
              onDoubleClick={() => openConnection(p.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && openConnection(p.id)}
            >
              <EngineBadge engine={p.engine} size={34} />
              <div className="grow min0">
                <div className="row gap8">
                  <span className="strong">{p.name}</span>
                  <EnvTag env={p.environment} />
                </div>
                <div className="muted small ellipsis">{describe(p)}</div>
              </div>
              {connecting === p.id ? (
                <span className="muted small">Connecting…</span>
              ) : (
                <div className="conn-row-actions">
                  <button className="btn small" onClick={(e) => (e.stopPropagation(), setSheet({ mode: "edit", profile: p }))}>
                    Edit
                  </button>
                  <button
                    className={`btn small ${armedDelete === p.id ? "danger" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (armedDelete === p.id) deleteProfile(p.id);
                      else setArmedDelete(p.id);
                    }}
                    onBlur={() => setArmedDelete(null)}
                  >
                    {armedDelete === p.id ? "Confirm Delete" : "Delete"}
                  </button>
                  <button className="btn small primary" onClick={(e) => (e.stopPropagation(), openConnection(p.id))}>
                    Connect
                  </button>
                </div>
              )}
              <span className="muted small when">{ago(p.lastUsedAt)}</span>
            </div>
          ))}
        </div>
        <div className="welcome-foot muted small">Double-click a connection to open it in a new tab</div>
      </div>
    </div>
  );
}
