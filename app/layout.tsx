// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Public_Sans } from "next/font/google";
import Link from "next/link";
import { Icon } from "@/components/app/ui";
import { NavLink } from "@/components/app/NavLink";
import { getAi } from "@/lib/ai";
import { listProjects, ready } from "@/lib/services";
import "./globals.css";
import "./studio.css";

const sans = Public_Sans({ variable: "--font-public", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Mue Studio", template: "%s · Mue Studio" },
  description: "Local studio for Mue: understand COBOL, convert it to Java and prove both produce identical results.",
  icons: { icon: "/icon.svg" },
  robots: { index: false },
};

export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ready();
  const projects = listProjects();
  const ai = getAi().name;
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <header className="hdr">
            <div className="in">
              <Link href="/" className="brand" aria-label="Mue Studio home">
                <span className="mark" aria-hidden="true">M</span>
                <span>
                  <b>Mue Studio</b>
                  <small>COBOL to Java migration, with proof of equivalence</small>
                </span>
              </Link>
              <span className="sp" />
              <div className="meta">
                <span>Local installation · <b>no data leaves this machine</b></span>
                <span>Explanation engine: <b>{ai === "mock" ? "deterministic (offline)" : ai}</b></span>
              </div>
            </div>
          </header>
          <nav className="topnav" aria-label="Main navigation">
            <div className="in">
              <NavLink href="/" exact className="nav">
                Projects <span className="cnt">{projects.length}</span>
              </NavLink>
              {projects.slice(0, 5).map((p) => (
                <NavLink key={p.id} href={`/projects/${p.id}`} className="nav">
                  {p.name}
                </NavLink>
              ))}
              <span className="sp" />
              <NavLink href="/projects/new" className="nav">
                <Icon name="plus" /> New project
              </NavLink>
            </div>
          </nav>
          <main className="main" id="content">
            {children}
          </main>
          <footer className="ftr">
            <div className="in">
              <span>Mue Studio · open source under AGPL-3.0</span>
              <a href="https://github.com/tbsrgt/mue">Source code</a>
              <a href="https://github.com/tbsrgt/mue/blob/main/SECURITY.md">Report a vulnerability</a>
              <span className="sp" />
              <span>Results are verified by replaying recorded cases, not by the explanation engine.</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
