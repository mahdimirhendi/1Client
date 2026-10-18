import { isTauri } from "@tauri-apps/api/core";
import { showToast } from "./toast";

/** Clipboard through Tauri (no WebKit paste prompts), falling back to the browser API. */
export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    return writeText(text);
  }
  if (!navigator.clipboard) throw new Error("the clipboard is not available");
  await navigator.clipboard.writeText(text);
}

/** Copy and say so: "Copied 250 rows as JSON", or why it failed. */
export async function copyWithFeedback(text: string, what: string): Promise<void> {
  try {
    await copyText(text);
    showToast(`Copied ${what}`);
  } catch (e) {
    showToast(`Couldn't copy ${what}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export async function pasteText(): Promise<string> {
  if (isTauri()) {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await readText()) ?? "";
  }
  return (await navigator.clipboard?.readText()) ?? "";
}
