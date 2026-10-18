import { useEffect, useState } from "react";
import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type Appearance = "system" | "light" | "dark";
const KEY = "oneclient.appearance";

function saved(): Appearance {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Apply a choice: CSS tokens via `data-theme`, and the native window (title bar, menus). */
function apply(mode: Appearance) {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  if (isTauri()) invoke("set_appearance", { mode }).catch(() => {});
}

export const useAppearance = create<{ mode: Appearance; set(mode: Appearance): void }>((set) => ({
  mode: saved(),
  set(mode) {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* per-device setting; falls back to System */
    }
    apply(mode);
    set({ mode });
  },
}));

/** Call once at startup. */
export const initAppearance = () => apply(useAppearance.getState().mode);

const query = () => window.matchMedia?.("(prefers-color-scheme: dark)");

/** True when 1Client is drawn dark: picked Dark, or System while macOS is dark. Updates live. */
export function useDarkMode(): boolean {
  const mode = useAppearance((s) => s.mode);
  const [systemDark, setSystemDark] = useState(() => !!query()?.matches);
  useEffect(() => {
    const q = query();
    if (!q) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return mode === "dark" || (mode === "system" && systemDark);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);

function mix(hex: string, toward: [number, number, number], amount: number): string {
  const c = rgb(hex);
  return "#" + c.map((v, i) => Math.round(v * (1 - amount) + toward[i] * amount).toString(16).padStart(2, "0")).join("");
}

/**
 * Colors for an environment tag from its one base color: readable text (darker in light
 * mode, lighter in dark mode), a soft fill, and the solid stripe under connection tabs.
 */
export function envColors(hex: string, dark: boolean) {
  const [r, g, b] = rgb(hex);
  return {
    fg: dark ? mix(hex, [255, 255, 255], 0.35) : mix(hex, [0, 0, 0], 0.32),
    bg: `rgba(${r}, ${g}, ${b}, ${dark ? 0.24 : 0.14})`,
    solid: hex,
  };
}

/** Swatches offered for environments. Mid-tones that work on both light and dark backgrounds. */
export const ENV_PALETTE: [string, string][] = [
  ["Gray", "#8E8E93"],
  ["Red", "#E5484D"],
  ["Orange", "#F08C00"],
  ["Yellow", "#D4A800"],
  ["Green", "#30A46C"],
  ["Teal", "#12A594"],
  ["Blue", "#0090FF"],
  ["Indigo", "#5B5BD6"],
  ["Purple", "#8E4EC6"],
  ["Pink", "#D6409F"],
];
