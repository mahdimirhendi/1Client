import { useApp, type ConnTab } from "../store";
import { IconClose, IconFile, IconTable } from "./Icons";

/** Inner bar: queries and tables of the active connection. */
export function DocTabs({ conn }: { conn: ConnTab }) {
  const { activateDoc, closeDoc, newQuery } = useApp();
  return (
    <div className="doc-tabs" role="tablist">
      {conn.docs.map((d) => {
        const on = d.id === conn.activeDoc;
        return (
          <div key={d.id} className={`doc-tab ${on ? "on" : ""}`}>
            <button role="tab" aria-selected={on} className="doc-tab-main" onClick={() => activateDoc(conn.id, d.id)}>
              {d.kind === "table" ? (
                <IconTable color={on ? "var(--accent)" : "var(--label-secondary)"} />
              ) : (
                <IconFile color={on ? "var(--accent)" : "var(--label-secondary)"} />
              )}
              <span>{d.title}</span>
              {d.running && <span className="spinner" aria-label="Running" />}
            </button>
            <button className="tab-close" aria-label={`Close ${d.title}`} onClick={() => closeDoc(conn.id, d.id)}>
              <IconClose />
            </button>
          </div>
        );
      })}
      <button className="doc-tab-add" aria-label="New query" title="New query (⌘T)" onClick={() => newQuery(conn.id)}>
        +
      </button>
    </div>
  );
}
