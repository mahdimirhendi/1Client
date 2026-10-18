import { useApp } from "../store";
import { EnvTag, useEnvironment } from "./EnvTag";

/** Shown when a connection has "Ask before running writes" on and the SQL changes data or schema. */
export function ConfirmWrite() {
  const { pendingWrite, setPendingWrite, run, conns } = useApp();
  const conn = conns.find((c) => c.id === pendingWrite?.connId);
  const env = useEnvironment(conn?.profile.environment ?? "");
  if (!pendingWrite || !conn) return null;

  const go = () => {
    setPendingWrite(null);
    if (pendingWrite.onConfirm) pendingWrite.onConfirm();
    else run(pendingWrite.connId, pendingWrite.docId, pendingWrite.sql, true);
  };
  const cancel = () => {
    setPendingWrite(null);
    pendingWrite.onCancel?.();
  };

  return (
    <div className="sheet-backdrop" onKeyDown={(e) => e.key === "Escape" && cancel()}>
      <div className="sheet alert" role="alertdialog" aria-labelledby="confirm-title">
        <div className="row gap8">
          <div id="confirm-title" className="sheet-title">
            {pendingWrite.onConfirm ? "Save changes to" : "Run this on"} {conn.profile.name}?
          </div>
          <EnvTag env={conn.profile.environment} />
        </div>
        <p className="muted">{pendingWrite.onConfirm ? "These statements will run in one transaction." : "This statement changes data or schema."}</p>
        <pre className="confirm-sql mono">{pendingWrite.sql.trim()}</pre>
        <div className="sheet-foot plain">
          <div className="grow" />
          <button className="btn" onClick={cancel} autoFocus>
            Cancel
          </button>
          <button className={`btn ${env.confirmWrites ? "danger-fill" : "primary"}`} onClick={go}>
            {pendingWrite.onConfirm ? "Save" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
