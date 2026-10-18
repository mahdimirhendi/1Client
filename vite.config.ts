import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { version } from "./package.json";

// Tauri expects a fixed port and fails if it is taken.
export default defineConfig({
  plugins: [react()],
  // package.json is the one place the version is set (tauri.conf.json reads it too).
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/target/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "safari15", sourcemap: !!process.env.TAURI_ENV_DEBUG, chunkSizeWarningLimit: 2000 },
});
