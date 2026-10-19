import { useState } from "react";
import { showToast } from "../lib/toast";
import { useApp, type SaveSheet } from "../store";
import type { AppError } from "../types";

/** Name a query to keep it with its connection, or rename a saved one. */
export function SaveQuerySheet({ sheet }: { sheet: SaveSheet }) {
  const { setSaveSheet, saveQuery } = useApp();
  const [name, setName] = useState(sheet.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const renaming = !!sheet.id;

  const close = () => setSaveSheet(null);
  const save = async () => {
    if (!name.trim()) return setError("Give the query a name.");
    setBusy(true);
    try {
      const q = await saveQuery(sheet.connId, { id: sheet.id, name, sql: sheet.sql }, sheet.docId);
      close();
      showToast(renaming ? `Renamed to “${q.name}”` : `Saved “${q.name}”`);
    } catch (e) {
      setError((e as AppError).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => e.key === "Escape" && close()}
    >
      <div className="sheet alert" role="dialog" aria-labelledby="save-query-title">
        <div id="save-query-title" className="sheet-title">
          {renaming ? "Rename Query" : "Save Query"}
        </div>
        <p className="muted">Saved queries stay with this connection. Double-click one in the sidebar to run it.</p>
        <input
          className="text-field"
          aria-label="Name"
          placeholder="Name"
          autoFocus
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <pre className="confirm-sql mono">{sheet.sql.trim()}</pre>
        {error && <div className="error-text small">{error}</div>}
        <div className="sheet-foot plain">
          <div className="grow" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {renaming ? "Rename" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
