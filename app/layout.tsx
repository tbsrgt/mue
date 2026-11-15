// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import Link from "next/link";
import { Icon } from "@/components/app/ui";
import { NavLink } from "@/components/app/NavLink";
import { getAi } from "@/lib/ai";
import { listProjects, ready } from "@/lib/services";
import "./globals.css";
import "./studio.css";

const sans = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });
const cond = IBM_Plex_Sans_Condensed({ variable: "--font-plex-cond", subsets: ["latin"], weight: ["500", "600", "700"], display: "swap" });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Mue Studio", template: "%s · Mue Studio" },
  description: "Local studio for Mue: understand COBOL, convert it to Java and prove both produce identical results.",
  icons: { icon: "/icon.svg" },
  robots: { index: false },
};

export const viewport: Viewport = { themeColor: "#07100d", colorScheme: "dark" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ready();
  const projects = listProjects();
  const ai = getAi().name;
  return (
    <html lang="en" className={`${sans.variable} ${cond.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <aside className="side" aria-label="Studio navigation">
            <Link href="/" className="brand" aria-label="Mue Studio home">
              <span className="mark">M</span>
              <b>Mue</b>
            </Link>
            <span className="navlbl">Migration</span>
            <NavLink href="/" exact className="nav">
              <Icon name="projects" /> Projects <span className="cnt">{projects.length}</span>
            </NavLink>
            {projects.slice(0, 6).map((p) => (
              <NavLink key={p.id} href={`/projects/${p.id}`} className="nav">
                <Icon name="dashboard" /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              </NavLink>
            ))}
            <NavLink href="/projects/new" className="nav">
              <Icon name="plus" /> New project
            </NavLink>
            <div className="foot">
              <span className="badge"><i /> Runs locally · no data leaves this machine</span>
              <span className="badge amber"><i /> AI: {ai === "mock" ? "deterministic mock" : ai}</span>
            </div>
          </aside>
          <main className="main" id="content">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
