import { invoke, isTauri } from "@tauri-apps/api/core";
import { mockInvoke } from "./mock";
import type {
  AppError,
  Canvas,
  ConnectionProfile,
  EnvironmentDef,
  HistoryEntry,
  QueryOutput,
  RowEdit,
  SavedQuery,
  SecretField,
  SecretsInput,
  SessionInfo,
  TableInfo,
  TestReport,
} from "./types";

/** In a plain browser (`npm run dev` without Tauri) a mock backend answers, so the UI can be built anywhere. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return isTauri() ? await invoke<T>(cmd, args) : await mockInvoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as Partial<AppError>;
    return { kind: o.kind ?? "unknown", ...o, message: String(o.message) } as AppError;
  }
  return { kind: "unknown", message: String(e) };
}

export const api = {
  listConnections: () => call<ConnectionProfile[]>("list_connections"),
  listEnvironments: () => call<EnvironmentDef[]>("list_environments"),
  saveEnvironments: (list: EnvironmentDef[]) => call<EnvironmentDef[]>("save_environments", { list }),
  saveConnection: (profile: ConnectionProfile, secrets?: SecretsInput) =>
    call<ConnectionProfile>("save_connection", { profile, secrets }),
  deleteConnection: (id: string) => call<void>("delete_connection", { id }),
  testConnection: (profile: ConnectionProfile, secrets?: SecretsInput) =>
    call<TestReport>("test_connection", { profile, secrets }),
  trustHostKey: (host: string, port: number, key: string) => call<void>("trust_host_key", { host, port, key }),
  openSession: (profileId: string) => call<SessionInfo>("open_session", { profileId }),
  secretReferences: (id: string) => call<SecretsInput>("secret_references", { id }),
  /** One saved password, only when the user asks to see it. */
  revealSecret: (profileId: string, field: SecretField) => call<string | null>("reveal_secret", { profileId, field }),
  closeSession: (sessionId: string) => call<void>("close_session", { sessionId }),
  /** Saved data that could not be read at launch (it was kept aside), to tell the user once. */
  takeStartupProblems: () => call<string[]>("take_startup_problems"),
  takePendingLinks: () => call<{ profile: ConnectionProfile | null; error: string | null }[]>("take_pending_links"),
  saveTempConnection: (id: string) => call<ConnectionProfile>("save_temp_connection", { id }),
  /** `record` keeps the run in the connection's history (query tabs). */
  runQuery: (sessionId: string, sql: string, record = false) => call<QueryOutput>("run_query", { sessionId, sql, record }),
  listHistory: (profileId: string) => call<HistoryEntry[]>("list_history", { profileId }),
  deleteHistory: (id: string) => call<void>("delete_history", { id }),
  clearHistory: (profileId: string) => call<void>("clear_history", { profileId }),
  listSavedQueries: (profileId: string) => call<SavedQuery[]>("list_saved_queries", { profileId }),
  saveQuery: (query: SavedQuery) => call<SavedQuery>("save_query", { query }),
  deleteSavedQuery: (id: string) => call<void>("delete_saved_query", { id }),
  /** `null` when the connection never had a canvas. */
  listCanvases: (profileId: string) => call<Canvas[] | null>("list_canvases", { profileId }),
  saveCanvas: (profileId: string, canvas: Canvas) => call<Canvas>("save_canvas", { profileId, canvas }),
  deleteCanvas: (profileId: string, id: string) => call<void>("delete_canvas", { profileId, id }),
  /** Asks where to save; `data` is SVG text or a base64 PNG. Returns the path, or null when cancelled. */
  exportDiagram: (name: string, kind: "png" | "svg", data: string) =>
    call<string | null>("export_diagram", { name, kind, data }),
  introspect: (sessionId: string) => call<TableInfo[]>("introspect", { sessionId }),
  applyEdits: (sessionId: string, edits: RowEdit[]) => call<number>("apply_edits", { sessionId, edits }),
  previewEdits: (sessionId: string, edits: RowEdit[]) => call<string>("preview_edits", { sessionId, edits }),
};

/** Run `onLink` whenever another app hands 1Client a connection link. */
export async function onLinksPending(onLink: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("links-pending", () => onLink());
}

/** Menu bar items (macOS) arrive as their id: "new-connection", "run-all", "appearance:dark", ... */
export async function onMenu(handler: (id: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("menu", (e) => handler(e.payload));
}

export async function pickKeyFile(): Promise<string | null> {
  if (!isTauri()) return "~/.ssh/id_ed25519";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, title: "Choose a private key" });
  return typeof picked === "string" ? picked : null;
}
