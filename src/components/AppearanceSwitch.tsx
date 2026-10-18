import { useAppearance, type Appearance } from "../lib/theme";

const icons: Record<Appearance, React.ReactNode> = {
  light: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="7" cy="7" r="2.6" />
      <path d="M7 1v1.4M7 11.6V13M1 7h1.4M11.6 7H13M2.8 2.8l1 1M10.2 10.2l1 1M2.8 11.2l1-1M10.2 3.8l1-1" />
    </svg>
  ),
  system: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="7" cy="7" r="5.4" />
      <path d="M7 1.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" stroke="none" />
    </svg>
  ),
  dark: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M11.8 8.6A5 5 0 0 1 5.4 2.2a5 5 0 1 0 6.4 6.4z" />
    </svg>
  ),
};

const labels: Record<Appearance, string> = { light: "Light", system: "Match macOS", dark: "Dark" };

/** Light / Match macOS / Dark. Also in View › Appearance. */
export function AppearanceSwitch({ compact = false }: { compact?: boolean }) {
  const { mode, set } = useAppearance();
  return (
    <div className={`appearance ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Appearance">
      {(["light", "system", "dark"] as Appearance[]).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} title={labels[m]} className={mode === m ? "on" : ""} onClick={() => set(m)}>
          {icons[m]}
          {!compact && <span>{m === "system" ? "Auto" : labels[m]}</span>}
        </button>
      ))}
    </div>
  );
}
