import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "ok" | "error";
}

/** One short message at a time, shown at the bottom of the window (see `ToastHost`). */
export const useToast = create<{ toast: Toast | null; dismiss(): void }>((set) => ({
  toast: null,
  dismiss: () => set({ toast: null }),
}));

let lastId = 0;

export function showToast(message: string, tone: Toast["tone"] = "ok") {
  useToast.setState({ toast: { id: ++lastId, message, tone } });
}
