// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import type { Stage } from "@/lib/services";
import { STAGE_LABEL } from "@/lib/services";

export function StageChip({ stage }: { stage: Stage }) {
  return <span className={`chip s-${stage}`}>{STAGE_LABEL[stage]}</span>;
}

export function Flash({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return (
    <div className={`flash ${error ? "err" : "ok"}`} role={error ? "alert" : "status"}>
      <span aria-hidden="true">{error ? "✕" : "✓"}</span>
      <span>{error ?? ok}</span>
    </div>
  );
}

export function Crumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="row" style={{ gap: 8 }}>
          {i > 0 && <span className="sep">/</span>}
          {it.href ? <Link href={it.href}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function Empty({ glyph, title, children, action }: { glyph?: string; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {glyph && <div className="glyph">{glyph}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

const PATHS: Record<string, string> = {
  projects: "M3 7h18M3 12h18M3 17h12",
  plus: "M12 5v14M5 12h14",
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
};

export function Icon({ name, className = "ico" }: { name: keyof typeof PATHS | string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.projects} />
    </svg>
  );
}

export function fmtN(n: number) {
  return n.toLocaleString("en-US");
}

export function fmtWhen(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
