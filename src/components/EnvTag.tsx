import { envColors, useDarkMode } from "../lib/theme";
import { useApp } from "../store";
import type { EnvironmentDef } from "../types";

const UNKNOWN: EnvironmentDef = { id: "", name: "Unknown", color: "#8E8E93", confirmWrites: false };

/** The environment definition for an id (falls back to a gray "Unknown"). */
export function useEnvironment(id: string): EnvironmentDef {
  const envs = useApp((s) => s.environments);
  return envs.find((e) => e.id === id) ?? { ...UNKNOWN, id, name: id || UNKNOWN.name };
}

export function EnvTag({ env }: { env: string }) {
  const def = useEnvironment(env);
  const c = envColors(def.color, useDarkMode());
  return (
    <span className="env-tag" style={{ color: c.fg, background: c.bg }}>
      {def.name.toUpperCase()}
    </span>
  );
}
