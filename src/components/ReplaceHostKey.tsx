import { useState } from "react";
import { api } from "../api";
import { showToast } from "../lib/toast";
import type { AppError } from "../types";

/**
 * A server's SSH key changed. Pressing the button is the user's yes: the old key is removed with
 * `ssh-keygen -R`, the new one is kept, and `onReplaced` tries again. Renders nothing for other errors.
 */
export function ReplaceHostKey({ error, onReplaced }: { error: AppError; onReplaced: () => void }) {
  const [busy, setBusy] = useState(false);
  const { host, port, key, fingerprint } = error;
  if (error.kind !== "hostKeyChanged" || !host || !port || !key) return null;

  const replace = async () => {
    setBusy(true);
    try {
      await api.replaceHostKey(host, port, key);
      onReplaced();
    } catch (e) {
      showToast(`Couldn't replace the key: ${(e as AppError).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row gap8 replace-key">
      <span className="mono small">{fingerprint}</span>
      <button className="btn small" onClick={replace} disabled={busy}>
        Replace Key and Retry
      </button>
    </div>
  );
}
