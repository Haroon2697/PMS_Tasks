/**
 * Persistence layer — requirement 56.
 *
 * SQLite via better-sqlite3: a real relational store, synchronous (which suits
 * a single-process analytical tool), and a single file that can be copied,
 * inspected and version-controlled alongside a submission.
 *
 * SCHEMA SHAPE. Systems, scenarios and results are stored with their
 * structured columns AND a JSON payload:
 *
 *   - Columns carry the fields that are QUERIED or SORTED — name, timestamps,
 *     seed, throughput, cost per vehicle. These are indexed and typed.
 *   - The JSON payload carries the full object graph. A `SystemModel` is a
 *     deep tree (stations -> crews, machines, routing arcs; vehicle models ->
 *     BOM lines) whose shape the engine owns. Shredding it across a dozen
 *     tables would mean every change to an engine type became a migration, and
 *     would buy nothing: the application always loads a model whole.
 *
 * The rule this keeps: the engine's types stay the single source of truth for
 * model structure, and the database never silently reshapes them. What gets
 * promoted to a column is exactly what the UI needs to list and sort without
 * deserialising every row.
 *
 * Requirement 56 also says results, vehicle histories and reports must
 * persist, so simulation runs store their summary metrics as columns and the
 * full result — including per-vehicle traces — as JSON.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DbOptions {
  /** File path, or ':memory:' for an ephemeral store (used by tests). */
  file: string;
}

export type Db = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A manufacturing system: stations, routing, BOM, costs, simulation settings.
CREATE TABLE IF NOT EXISTS systems (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- Denormalised for the system list, so it can be rendered without parsing
  -- every model.
  station_count INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  model_json    TEXT NOT NULL
);

-- A named set of edits against a system (requirement 35).
CREATE TABLE IF NOT EXISTS scenarios (
  id                         TEXT PRIMARY KEY,
  system_id                  TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  name                       TEXT NOT NULL,
  description                TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  initial_investment         REAL NOT NULL DEFAULT 0,
  additional_annual_opex     REAL NOT NULL DEFAULT 0,
  is_baseline                INTEGER NOT NULL DEFAULT 0,
  edits_json                 TEXT NOT NULL,
  investment_items_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scenarios_system ON scenarios(system_id);

-- One replication study (requirement 44). Headline metrics are columns so the
-- run history can be listed and compared without loading every payload.
CREATE TABLE IF NOT EXISTS runs (
  id                   TEXT PRIMARY KEY,
  system_id            TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  scenario_id          TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  seed                 INTEGER NOT NULL,
  replications         INTEGER NOT NULL,
  warmup_minutes       REAL NOT NULL,
  duration_minutes     REAL NOT NULL,
  throughput_per_hour  REAL,
  vehicles_completed   REAL,
  w_minutes            REAL,
  wq_minutes           REAL,
  wip                  REAL,
  cost_per_vehicle     REAL,
  total_cost           REAL,
  profit               REAL,
  bottleneck_station   TEXT,
  duration_ms          INTEGER,
  study_json           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_system ON runs(system_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_scenario ON runs(scenario_id);

-- Per-vehicle histories (requirement 3 and 56). Stored separately from the
-- study payload so a run's traces can be paged without loading the whole study.
CREATE TABLE IF NOT EXISTS vehicle_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  vehicle_id    INTEGER NOT NULL,
  tag           TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  arrival_time  REAL NOT NULL,
  completion_time REAL,
  cycle_minutes REAL,
  rework_count  INTEGER NOT NULL,
  total_cost    REAL,
  vehicle_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_run ON vehicle_traces(run_id, cycle_minutes DESC);
CREATE INDEX IF NOT EXISTS idx_traces_lookup ON vehicle_traces(run_id, vehicle_id);

-- Generated reports (requirement 54).
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  system_id   TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  format      TEXT NOT NULL,
  content     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_system ON reports(system_id, created_at DESC);

-- Optimisation studies (requirement 33).
CREATE TABLE IF NOT EXISTS optimizations (
  id          TEXT PRIMARY KEY,
  system_id   TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  objective   TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opt_system ON optimizations(system_id, created_at DESC);
`;

export function openDb(options: DbOptions): Db {
  if (options.file !== ':memory:') {
    mkdirSync(dirname(options.file), { recursive: true });
  }
  const db = new Database(options.file);
  db.exec(SCHEMA);
  return db;
}

export const nowIso = (): string => new Date().toISOString();

/**
 * Identifier generator. Uses a timestamp prefix so ids sort chronologically,
 * which makes run histories readable in raw SQL without a join.
 */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}
