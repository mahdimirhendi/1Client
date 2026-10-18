import type { Engine } from "../types";

type P = { size?: number; color?: string };

export const IconPlus = ({ size = 12, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round">
    <path d="M6 1.5v9M1.5 6h9" />
  </svg>
);

export const IconSearch = ({ size = 12, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 13 13" fill="none" stroke={color} strokeWidth="1.5">
    <circle cx="5.5" cy="5.5" r="4" />
    <path d="M8.5 8.5l3 3" />
  </svg>
);

export const IconTable = ({ size = 12, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 13 13" fill="none" stroke={color} strokeWidth="1.2">
    <rect x="1.5" y="2" width="10" height="9" rx="1.5" />
    <path d="M1.5 5h10M5 5v6" />
  </svg>
);

export const IconFile = ({ size = 12, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round">
    <path d="M3 1.5h5l3 3v8H3z" />
  </svg>
);

export const IconPlay = ({ size = 9, color = "currentColor" }: P) => (
  <svg width={size} height={size + 1} viewBox="0 0 9 10" fill={color}>
    <path d="M0 0l9 5-9 5z" />
  </svg>
);

export const IconDatabase = ({ size = 14, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.3">
    <ellipse cx="7" cy="3.5" rx="5" ry="2" />
    <path d="M2 3.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7" />
  </svg>
);

export const IconChevron = ({ open }: { open: boolean }) => (
  <svg width="8" height="8" viewBox="0 0 8 8" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s" }}>
    <path d="M2.5 1l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export const IconClose = ({ size = 8 }: P) => (
  <svg width={size} height={size} viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" />
  </svg>
);

export const IconCheck = ({ size = 12, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 6.2l2.4 2.4 4.6-5" />
  </svg>
);

export const AppIcon = ({ size = 96 }: P) => (
  <div className="app-icon" style={{ width: size, height: size, borderRadius: size * 0.23 }}>
    <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 56 56" fill="none" stroke="#9CCBFF" strokeWidth="3" strokeLinecap="round">
      <ellipse cx="28" cy="14" rx="17" ry="6" />
      <path d="M11 14v28c0 3.3 7.6 6 17 6s17-2.7 17-6V14" />
      <path d="M11 28c0 3.3 7.6 6 17 6s17-2.7 17-6" />
    </svg>
  </div>
);

export const EngineBadge = ({ engine, size = 22 }: { engine: Engine; size?: number }) => (
  <span
    className={`engine-badge engine-${engine}`}
    style={{ width: size, height: size, borderRadius: size * 0.27, fontSize: Math.max(9, size * 0.36) }}
  >
    {engine === "postgres" ? "PG" : "My"}
  </span>
);
