// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Local SQLite database for Mue Studio (node:sqlite, DatabaseSync): data/mue.db.
 * The schema is created on first access; the example project is seeded when there is none.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded through getBuiltinModule so the bundler never sees the native module.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const globalForDb = globalThis as unknown as { __mueDb?: DatabaseSyncType };

export const DB_PATH = process.env.MUE_DB ?? path.join(process.cwd(), "data", "mue.db");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_example INTEGER NOT NULL DEFAULT 0,
  conventions TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS programs (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  program TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'new',
  explanation TEXT,
  java TEXT,
  java_hash TEXT,
  overrides TEXT,
  updated_at TEXT,
  PRIMARY KEY (project_id, program)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  program TEXT NOT NULL,
  java_hash TEXT,
  total INTEGER NOT NULL,
  identical INTEGER NOT NULL,
  mismatches INTEGER NOT NULL,
  warnings INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  program TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_prog ON reports(project_id, program, id);
CREATE INDEX IF NOT EXISTS idx_events_proj ON events(project_id, id);
`;

export function db(): DatabaseSyncType {
  if (globalForDb.__mueDb) return globalForDb.__mueDb;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec(SCHEMA);
  globalForDb.__mueDb = d;
  return d;
}

export const now = () => new Date().toISOString();
