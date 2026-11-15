// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, exact, className, children }: { href: string; exact?: boolean; className?: string; children: React.ReactNode }) {
  const path = usePathname();
  const on = exact ? path === href : path === href || path.startsWith(href + "/");
  return (
    <Link href={href} className={className} aria-current={on ? "page" : undefined}>
      {children}
    </Link>
  );
}
