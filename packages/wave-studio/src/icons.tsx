import type { CSSProperties } from "react";

/** Google Material Symbols (loaded in index.html). */
export function Icon({ name, className = "", style }: { name: string; className?: string; style?: CSSProperties }) {
  return (
    <span className={`ms-icon ${className}`.trim()} style={style} aria-hidden="true">
      {name}
    </span>
  );
}

export function WaveLogo({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" aria-hidden="true">
      <path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 5-3 5-3" />
      <path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 5-3 5-3" opacity="0.6" />
    </svg>
  );
}

export function TableRowIcon({ active }: { active?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={active ? "nav-table-icon active" : "nav-table-icon"} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 9v12" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.5 2v6h-6" />
      <path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}
