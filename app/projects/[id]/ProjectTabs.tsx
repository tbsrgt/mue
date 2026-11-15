// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function ProjectTabs({ id }: { id: number }) {
  const path = usePathname();
  const base = `/projects/${id}`;
  const tabs = [
    { href: base, label: "Dashboard", on: path === base || path.startsWith(base + "/programs") },
    { href: `${base}/system`, label: "System", on: path.startsWith(`${base}/system`) },
    { href: `${base}/files`, label: "Files", on: path.startsWith(`${base}/files`) },
    { href: `${base}/reports`, label: "Reports", on: path.startsWith(`${base}/reports`) },
    { href: `${base}/settings`, label: "Settings", on: path.startsWith(`${base}/settings`) },
  ];
  return (
    <nav className="ptabs" aria-label="Project sections">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} aria-current={t.on ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
