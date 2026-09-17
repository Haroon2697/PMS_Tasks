/**
 * Repositories — the only place that knows SQL.
 *
 * Requirement 57 separates persistence from the engine and from the API
 * surface. Route handlers call these functions and never touch the database
 * directly, so the storage choice can change without rewriting the API, and
 * the engine remains completely unaware that persistence exists.
 */

import type {
  Scenario,
  StudyResult,
  SystemModel,
  Vehicle,
  OptimizationRequest,
  OptimizationResult,
} from '@vmq/engine';
import { cycleTimeMinutes } from '@vmq/engine';
import type { Db } from './db.ts';
import { newId, nowIso } from './db.ts';

/* ------------------------------------------------------------------ */
/* Systems                                                             */
/* ------------------------------------------------------------------ */

export interface SystemSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  stationCount: number;
  currency: string;
  seed: number;
}

export function listSystems(db: Db): SystemSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, description, created_at, updated_at, station_count, currency, seed
       FROM systems ORDER BY updated_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    stationCount: r.station_count as number,
    currency: r.currency as string,
    seed: r.seed as number,
  }));
}

export function getSystem(db: Db, id: string): SystemModel | null {
  const row = db.prepare(`SELECT model_json FROM systems WHERE id = ?`).get(id) as
    | { model_json: string }
    | undefined;
  return row ? (JSON.parse(row.model_json) as SystemModel) : null;
}

export function saveSystem(db: Db, model: SystemModel): SystemModel {
  const exists = db.prepare(`SELECT 1 FROM systems WHERE id = ?`).get(model.id);
  const now = nowIso();
  if (exists) {
    db.prepare(
      `UPDATE systems SET name=?, description=?, updated_at=?, station_count=?, currency=?, seed=?, model_json=?
       WHERE id=?`,
    ).run(
      model.name,
      model.description ?? null,
      now,
      model.stations.length,
      model.cost.currency.code,
      model.simulation.seed,
      JSON.stringify(model),
      model.id,
    );
  } else {
    db.prepare(
      `INSERT INTO systems (id, name, description, created_at, updated_at, station_count, currency, seed, model_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      model.id,
      model.name,
      model.description ?? null,
      now,
      now,
      model.stations.length,
      model.cost.currency.code,
      model.simulation.seed,
      JSON.stringify(model),
    );
  }
  return model;
}

export function deleteSystem(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM systems WHERE id = ?`).run(id).changes > 0;
}

/** Duplicate a system under a new id, so a user can branch a configuration. */
export function cloneSystem(db: Db, id: string, name: string): SystemModel | null {
  const model = getSystem(db, id);
  if (!model) return null;
  const copy: SystemModel = { ...model, id: newId('sys'), name };
  return saveSystem(db, copy);
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

export interface StoredScenario extends Scenario {
  systemId: string;
  isBaseline: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToScenario(r: Record<string, unknown>): StoredScenario {
  return {
    id: r.id as string,
    systemId: r.system_id as string,
    name: r.name as string,
    description: (r.description as string) ?? undefined,
    edits: JSON.parse(r.edits_json as string),
    initialInvestment: r.initial_investment as number,
    additionalAnnualOperatingCost: r.additional_annual_opex as number,
    investmentItems: r.investment_items_json
      ? JSON.parse(r.investment_items_json as string)
      : undefined,
    isBaseline: (r.is_baseline as number) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function listScenarios(db: Db, systemId: string): StoredScenario[] {
  const rows = db
    .prepare(`SELECT * FROM scenarios WHERE system_id = ? ORDER BY is_baseline DESC, created_at ASC`)
    .all(systemId) as Record<string, unknown>[];
  return rows.map(rowToScenario);
}

export function getScenario(db: Db, id: string): StoredScenario | null {
  const r = db.prepare(`SELECT * FROM scenarios WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToScenario(r) : null;
}

export function saveScenario(
  db: Db,
  systemId: string,
  scenario: Scenario & { isBaseline?: boolean },
): StoredScenario {
  const now = nowIso();
  const exists = db.prepare(`SELECT created_at FROM scenarios WHERE id = ?`).get(scenario.id) as
    | { created_at: string }
    | undefined;

  if (exists) {
    db.prepare(
      `UPDATE scenarios SET name=?, description=?, updated_at=?, initial_investment=?,
       additional_annual_opex=?, is_baseline=?, edits_json=?, investment_items_json=?
       WHERE id=?`,
    ).run(
      scenario.name,
      scenario.description ?? null,
      now,
      scenario.initialInvestment,
      scenario.additionalAnnualOperatingCost,
      scenario.isBaseline ? 1 : 0,
      JSON.stringify(scenario.edits),
      scenario.investmentItems ? JSON.stringify(scenario.investmentItems) : null,
      scenario.id,
    );
  } else {
    db.prepare(
      `INSERT INTO scenarios (id, system_id, name, description, created_at, updated_at,
        initial_investment, additional_annual_opex, is_baseline, edits_json, investment_items_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      scenario.id,
      systemId,
      scenario.name,
      scenario.description ?? null,
      now,
      now,
      scenario.initialInvestment,
      scenario.additionalAnnualOperatingCost,
      scenario.isBaseline ? 1 : 0,
      JSON.stringify(scenario.edits),
      scenario.investmentItems ? JSON.stringify(scenario.investmentItems) : null,
    );
  }
  return getScenario(db, scenario.id) as StoredScenario;
}

export function deleteScenario(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM scenarios WHERE id = ?`).run(id).changes > 0;
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export interface RunSummary {
  id: string;
  systemId: string;
  scenarioId: string | null;
  createdAt: string;
  seed: number;
  replications: number;
  warmupMinutes: number;
  durationMinutes: number;
  throughputPerHour: number | null;
  vehiclesCompleted: number | null;
  wMinutes: number | null;
  wqMinutes: number | null;
  wip: number | null;
  costPerVehicle: number | null;
  totalCost: number | null;
  profit: number | null;
  bottleneckStation: string | null;
  durationMs: number | null;
}

function rowToRunSummary(r: Record<string, unknown>): RunSummary {
  return {
    id: r.id as string,
    systemId: r.system_id as string,
    scenarioId: (r.scenario_id as string) ?? null,
    createdAt: r.created_at as string,
    seed: r.seed as number,
    replications: r.replications as number,
    warmupMinutes: r.warmup_minutes as number,
    durationMinutes: r.duration_minutes as number,
    throughputPerHour: r.throughput_per_hour as number | null,
    vehiclesCompleted: r.vehicles_completed as number | null,
    wMinutes: r.w_minutes as number | null,
    wqMinutes: r.wq_minutes as number | null,
    wip: r.wip as number | null,
    costPerVehicle: r.cost_per_vehicle as number | null,
    totalCost: r.total_cost as number | null,
    profit: r.profit as number | null,
    bottleneckStation: (r.bottleneck_station as string) ?? null,
    durationMs: r.duration_ms as number | null,
  };
}

export function saveRun(
  db: Db,
  args: {
    systemId: string;
    scenarioId?: string | null;
    study: StudyResult;
    bottleneckStation: string | null;
    durationMs: number;
  },
): string {
  const id = newId('run');
  const s = args.study;

  db.prepare(
    `INSERT INTO runs (id, system_id, scenario_id, created_at, seed, replications,
      warmup_minutes, duration_minutes, throughput_per_hour, vehicles_completed,
      w_minutes, wq_minutes, wip, cost_per_vehicle, total_cost, profit,
      bottleneck_station, duration_ms, study_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    args.systemId,
    args.scenarioId ?? null,
    nowIso(),
    s.baseSeed,
    s.replications,
    s.warmupMinutes,
    s.durationMinutes,
    s.system.throughput?.mean ?? null,
    s.system.vehiclesCompleted?.mean ?? null,
    s.system.WMinutes?.mean ?? null,
    s.system.WqMinutes?.mean ?? null,
    s.system.L?.mean ?? null,
    s.cost.costPerVehicle?.mean ?? null,
    s.cost.totalManufacturingCost?.mean ?? null,
    s.cost.grossProfit?.mean ?? null,
    args.bottleneckStation,
    args.durationMs,
    JSON.stringify(stripTraces(s)),
  );

  saveTraces(db, id, s);
  return id;
}

/**
 * Traces are stored in their own table, so the study payload is kept small.
 * A study with 500 vehicle histories would otherwise be a multi-megabyte blob
 * that has to be parsed in full just to read a headline metric.
 */
function stripTraces(study: StudyResult): StudyResult {
  return {
    ...study,
    representative: {
      ...study.representative,
      simulation: { ...study.representative.simulation, traces: [], completedVehicles: [] },
      cost: { ...study.representative.cost, vehicles: [] },
    },
  };
}

function saveTraces(db: Db, runId: string, study: StudyResult): void {
  const traces = study.representative.simulation.traces;
  if (traces.length === 0) return;

  const costByVehicle = new Map(
    study.representative.cost.vehicles.map((v) => [v.vehicleId, v.totalCost]),
  );

  const insert = db.prepare(
    `INSERT INTO vehicle_traces (run_id, vehicle_id, tag, model_id, status, arrival_time,
      completion_time, cycle_minutes, rework_count, total_cost, vehicle_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertMany = db.transaction((rows: Vehicle[]) => {
    for (const v of rows) {
      insert.run(
        runId,
        v.id,
        v.tag,
        v.modelId,
        v.status,
        v.arrivalTime,
        v.completionTime,
        cycleTimeMinutes(v),
        v.reworkCount,
        costByVehicle.get(v.id) ?? null,
        JSON.stringify(v),
      );
    }
  });
  insertMany(traces);
}

export function listRuns(db: Db, systemId: string, limit = 50): RunSummary[] {
  const rows = db
    .prepare(`SELECT * FROM runs WHERE system_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(systemId, limit) as Record<string, unknown>[];
  return rows.map(rowToRunSummary);
}

export function getRun(db: Db, id: string): { summary: RunSummary; study: StudyResult } | null {
  const r = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    summary: rowToRunSummary(r),
    study: JSON.parse(r.study_json as string) as StudyResult,
  };
}

export function deleteRun(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM runs WHERE id = ?`).run(id).changes > 0;
}

export interface TraceRow {
  vehicleId: number;
  tag: string;
  modelId: string;
  status: string;
  arrivalTime: number;
  completionTime: number | null;
  cycleMinutes: number | null;
  reworkCount: number;
  totalCost: number | null;
}

export function listTraces(
  db: Db,
  runId: string,
  options: { limit?: number; offset?: number; status?: string; minCycle?: number } = {},
): { rows: TraceRow[]; total: number } {
  const clauses: string[] = ['run_id = ?'];
  const params: unknown[] = [runId];
  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.minCycle !== undefined) {
    clauses.push('cycle_minutes >= ?');
    params.push(options.minCycle);
  }
  const where = clauses.join(' AND ');

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM vehicle_traces WHERE ${where}`).get(...params) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT vehicle_id, tag, model_id, status, arrival_time, completion_time, cycle_minutes,
        rework_count, total_cost
       FROM vehicle_traces WHERE ${where}
       ORDER BY vehicle_id ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit ?? 100, options.offset ?? 0) as Record<string, unknown>[];

  return {
    total,
    rows: rows.map((r) => ({
      vehicleId: r.vehicle_id as number,
      tag: r.tag as string,
      modelId: r.model_id as string,
      status: r.status as string,
      arrivalTime: r.arrival_time as number,
      completionTime: r.completion_time as number | null,
      cycleMinutes: r.cycle_minutes as number | null,
      reworkCount: r.rework_count as number,
      totalCost: r.total_cost as number | null,
    })),
  };
}

/** Full history of one vehicle (requirement 72: "Inspect an individual vehicle"). */
export function getTrace(db: Db, runId: string, vehicleId: number): Vehicle | null {
  const r = db
    .prepare(`SELECT vehicle_json FROM vehicle_traces WHERE run_id = ? AND vehicle_id = ?`)
    .get(runId, vehicleId) as { vehicle_json: string } | undefined;
  return r ? (JSON.parse(r.vehicle_json) as Vehicle) : null;
}

/* ------------------------------------------------------------------ */
/* Reports and optimisations                                           */
/* ------------------------------------------------------------------ */

export function saveReport(
  db: Db,
  args: { systemId: string; runId?: string | null; title: string; format: string; content: string },
): string {
  const id = newId('rpt');
  db.prepare(
    `INSERT INTO reports (id, system_id, run_id, title, created_at, format, content)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, args.systemId, args.runId ?? null, args.title, nowIso(), args.format, args.content);
  return id;
}

export function listReports(db: Db, systemId: string) {
  return db
    .prepare(
      `SELECT id, title, created_at, format, run_id FROM reports WHERE system_id = ?
       ORDER BY created_at DESC`,
    )
    .all(systemId);
}

export function getReport(db: Db, id: string) {
  return db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as
    | { id: string; title: string; format: string; content: string; created_at: string }
    | undefined;
}

export function saveOptimization(
  db: Db,
  args: { systemId: string; request: OptimizationRequest; result: OptimizationResult },
): string {
  const id = newId('opt');
  db.prepare(
    `INSERT INTO optimizations (id, system_id, created_at, objective, request_json, result_json)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    id,
    args.systemId,
    nowIso(),
    args.request.objective,
    JSON.stringify(args.request),
    JSON.stringify(args.result),
  );
  return id;
}

export function listOptimizations(db: Db, systemId: string) {
  return db
    .prepare(
      `SELECT id, created_at, objective FROM optimizations WHERE system_id = ?
       ORDER BY created_at DESC LIMIT 50`,
    )
    .all(systemId);
}

export function getOptimization(db: Db, id: string) {
  const r = db.prepare(`SELECT * FROM optimizations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    systemId: r.system_id as string,
    createdAt: r.created_at as string,
    request: JSON.parse(r.request_json as string) as OptimizationRequest,
    result: JSON.parse(r.result_json as string) as OptimizationResult,
  };
}
