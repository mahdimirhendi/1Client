import { create } from "zustand";

export interface ToastAction {
  label: string;
  run(): void;
}

export interface Toast {
  id: number;
  message: string;
  tone: "ok" | "error";
  /** A button in the toast, such as Undo. */
  action?: ToastAction;
}

/** One short message at a time, shown at the bottom of the window (see `ToastHost`). */
export const useToast = create<{ toast: Toast | null; dismiss(): void }>((set) => ({
  toast: null,
  dismiss: () => set({ toast: null }),
}));

let lastId = 0;

export function showToast(message: string, tone: Toast["tone"] = "ok", action?: ToastAction) {
  useToast.setState({ toast: { id: ++lastId, message, tone, action } });
}
