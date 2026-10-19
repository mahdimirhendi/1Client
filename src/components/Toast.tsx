import { useEffect } from "react";
import { useToast } from "../lib/toast";

/** Short confirmations ("Copied 250 rows as JSON") at the bottom of the window, some with Undo. */
export function ToastHost() {
  const { toast, dismiss } = useToast();

  useEffect(() => {
    if (!toast) return;
    // Errors and toasts with a button stay longer, so there is time to read or click.
    const t = setTimeout(dismiss, toast.tone === "error" || toast.action ? 5000 : 1800);
    return () => clearTimeout(t);
  }, [toast, dismiss]);

  if (!toast) return null;
  return (
    <div key={toast.id} className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} onClick={dismiss}>
      <span className="toast-icon" aria-hidden>
        {toast.tone === "error" ? "!" : "✓"}
      </span>
      {toast.message}
      {toast.action && (
        <button
          className="toast-action"
          onClick={(e) => {
            e.stopPropagation();
            toast.action!.run();
            dismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
