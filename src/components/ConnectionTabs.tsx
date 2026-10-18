import { useApp } from "../store";
import { envColors, useDarkMode } from "../lib/theme";
import { EngineBadge, IconClose } from "./Icons";

/** Top bar: one tab per open connection. Each keeps its own inner tabs. */
export function ConnectionTabs() {
  const { conns, activeConn, activateConn, closeConnection, setShowWelcome, environments } = useApp();
  const dark = useDarkMode();
  return (
    <nav className="conn-tabs" aria-label="Open connections">
      {conns.map((c) => {
        const on = c.id === activeConn;
        const env = environments.find((e) => e.id === c.profile.environment);
        const colors = envColors(env?.color ?? "#8E8E93", dark);
        return (
          <div key={c.id} className={`conn-tab ${on ? "on" : ""}`}>
            {on && <span className="conn-tab-stripe" style={{ background: colors.solid }} />}
            <button className="conn-tab-main" onClick={() => activateConn(c.id)}>
              <EngineBadge engine={c.profile.engine} size={18} />
              <span className="conn-tab-name">{c.profile.name}</span>
              <span className="conn-tab-env" style={{ color: colors.fg }}>
                {(env?.name ?? c.profile.environment).toUpperCase()}
              </span>
              <span className="muted small">
                {c.docs.length} tab{c.docs.length === 1 ? "" : "s"}
              </span>
            </button>
            <button className="tab-close" aria-label={`Close ${c.profile.name}`} onClick={() => closeConnection(c.id)}>
              <IconClose />
            </button>
          </div>
        );
      })}
      <button className="conn-tab-add" aria-label="Open another connection" onClick={() => setShowWelcome(true)}>
        +
      </button>
    </nav>
  );
}
