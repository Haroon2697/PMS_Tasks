/**
 * HTTP API — requirement 57 (separation of frontend, API, engines, persistence).
 *
 * The server is a thin layer: it validates inputs, calls the engine, and
 * persists results. It contains no queueing mathematics, no simulation logic
 * and no cost formulas — those live in @vmq/engine, where they are unit
 * tested without any HTTP involved.
 *
 * DIVISION OF WORK WITH THE BROWSER. The engine is dependency-free TypeScript,
 * so the web app imports it directly and runs the LIVE simulation locally. That
 * is deliberate: requirement 38 needs the animation to be driven by real
 * simulation state, stepping event by event, and round-tripping every event
 * through HTTP would make that impossible to keep smooth or synchronised. The
 * server owns what the browser cannot: durable storage, and long multi-
 * replication studies that would otherwise block the UI thread.
 */

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  analyseBottlenecks,
  applyScenario,
  buildExportBundle,
  buildReferenceModel,
  capacityLimit,
  compareScenarios,
  computeCosts,
  evaluateScenario,
  expandBom,
  generateReport,
  optimize,
  quickWhatIf,
  runSimulation,
  runStudy,
  solveNetwork,
  validateModel,
  type Scenario,
  type SystemModel,
} from '@vmq/engine';
import { openDb, newId, type Db } from './db.ts';
import * as repo from './repository.ts';

const PORT = Number(process.env.PORT ?? 5177);
const DB_FILE = process.env.VMQ_DB ?? './data/vmq.sqlite';

const db: Db = openDb({ file: DB_FILE });
const app = express();

app.use(cors());
app.use(express.json({ limit: '32mb' }));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Wrap an async handler so thrown errors reach the error middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = fn(req, res);
      if (r instanceof Promise) r.catch(next);
    } catch (e) {
      next(e);
    }
  };

/** Load a system or send 404. Returns null when it has already responded. */
function requireSystem(req: Request, res: Response): SystemModel | null {
  const model = repo.getSystem(db, req.params.id as string);
  if (!model) {
    res.status(404).json({ error: `System "${req.params.id}" not found.` });
    return null;
  }
  return model;
}

/**
 * Apply a scenario to a system if one is requested.
 *
 * Every analysis endpoint accepts `?scenario=<id>` so the same route serves
 * both the baseline and any saved scenario, rather than duplicating routes.
 */
function withScenario(model: SystemModel, scenarioId: unknown): SystemModel {
  if (typeof scenarioId !== 'string' || scenarioId === '') return model;
  const stored = repo.getScenario(db, scenarioId);
  if (!stored) throw new HttpError(404, `Scenario "${scenarioId}" not found.`);
  return applyScenario(model, stored);
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Systems                                                             */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, database: DB_FILE, systems: repo.listSystems(db).length });
});

app.get('/api/systems', wrap((_req, res) => {
  res.json(repo.listSystems(db));
}));

app.get('/api/systems/:id', wrap((req, res) => {
  const model = requireSystem(req, res);
  if (model) res.json(model);
}));

app.post('/api/systems', wrap((req, res) => {
  const model = req.body as SystemModel;
  if (!model?.id || !model?.name || !Array.isArray(model.stations)) {
    throw new HttpError(400, 'Body must be a SystemModel with id, name and stations.');
  }
  // Refuse to persist a structurally broken model: storing something that
  // cannot be simulated turns a validation error into a corrupt record.
  const validation = validateModel(model);
  if (!validation.runnable) {
    res.status(422).json({
      error: 'Model has validation errors and was not saved.',
      errors: validation.errors,
    });
    return;
  }
  res.status(201).json(repo.saveSystem(db, model));
}));

app.put('/api/systems/:id', wrap((req, res) => {
  const model = { ...(req.body as SystemModel), id: req.params.id as string };
  const validation = validateModel(model);
  if (!validation.runnable) {
    res.status(422).json({
      error: 'Model has validation errors and was not saved.',
      errors: validation.errors,
    });
    return;
  }
  res.json(repo.saveSystem(db, model));
}));

app.delete('/api/systems/:id', wrap((req, res) => {
  res.json({ deleted: repo.deleteSystem(db, req.params.id as string) });
}));

app.post('/api/systems/:id/clone', wrap((req, res) => {
  const name = (req.body?.name as string) ?? 'Copy';
  const copy = repo.cloneSystem(db, req.params.id as string, name);
  if (!copy) {
    res.status(404).json({ error: 'System not found.' });
    return;
  }
  res.status(201).json(copy);
}));

/** Seed the store with the reference line, for a first run. */
app.post('/api/systems/seed-reference', wrap((_req, res) => {
  const model = buildReferenceModel();
  const saved = repo.saveSystem(db, model);
  repo.saveScenario(db, saved.id, {
    id: newId('scn'),
    name: 'Baseline — current factory',
    description: 'The configuration as modelled, with no changes.',
    edits: [],
    initialInvestment: 0,
    additionalAnnualOperatingCost: 0,
    isBaseline: true,
  });
  res.status(201).json(saved);
}));

/* ------------------------------------------------------------------ */
/* Validation and analysis                                             */
/* ------------------------------------------------------------------ */

app.get('/api/systems/:id/validate', wrap((req, res) => {
  const model = requireSystem(req, res);
  if (!model) return;
  res.json(validateModel(withScenario(model, req.query.scenario)));
}));

/** Analytical solution — requirement 8. */
app.get('/api/systems/:id/analytical', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;
  const model = withScenario(base, req.query.scenario);
  const lambda = req.query.lambda ? Number(req.query.lambda) : undefined;
  const adjust = req.query.adjustAvailability === 'true';
  const net = solveNetwork(model, lambda, { adjustForAvailability: adjust });
  res.json({
    network: net,
    capacity: capacityLimit(model),
  });
}));

/** Bottleneck analysis — requirement 42. */
app.get('/api/systems/:id/bottlenecks', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;
  const model = withScenario(base, req.query.scenario);
  const lambda = req.query.lambda ? Number(req.query.lambda) : undefined;
  res.json(analyseBottlenecks(model, lambda));
}));

/** Bill of materials — requirement 14. */
app.get('/api/systems/:id/bom', wrap((req, res) => {
  const model = requireSystem(req, res);
  if (!model) return;
  res.json(model.vehicleModels.map((vm) => expandBom(model, vm)));
}));

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run a replication study and persist it.
 *
 * Synchronous on purpose: a study of the default model takes well under a
 * second, and a job queue would add failure modes and polling for no benefit
 * at this scale. Long studies are bounded by the caps below rather than moved
 * to a background worker.
 */
app.post('/api/systems/:id/run', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;

  const scenarioId = (req.body?.scenarioId as string) ?? null;
  const model = withScenario(base, scenarioId ?? undefined);

  const validation = validateModel(model);
  if (!validation.runnable) {
    res.status(422).json({
      error: 'Model cannot be simulated: it has validation errors.',
      errors: validation.errors,
    });
    return;
  }

  const replications = Number(req.body?.replications ?? model.simulation.replications);
  if (!Number.isInteger(replications) || replications < 1 || replications > 200) {
    throw new HttpError(400, 'replications must be a whole number between 1 and 200.');
  }
  const totalMinutes = (model.simulation.warmupMinutes + model.simulation.durationMinutes) * replications;
  if (totalMinutes > 50_000_000) {
    throw new HttpError(
      400,
      `That study would simulate ${Math.round(totalMinutes).toLocaleString()} minutes of factory ` +
        'time, which would block the server. Reduce the duration or the replication count.',
    );
  }

  const started = Date.now();
  const study = runStudy(model, { replications });
  const durationMs = Date.now() - started;

  const bottleneck = analyseBottlenecks(model);
  const bottleneckName =
    model.stations.find((s) => s.id === bottleneck.primaryBottleneckId)?.name ?? null;

  const runId = repo.saveRun(db, {
    systemId: base.id,
    scenarioId,
    study,
    bottleneckStation: bottleneckName,
    durationMs,
  });

  res.status(201).json({
    runId,
    durationMs,
    study,
    validation: { warnings: validation.warnings, info: validation.info },
    bottleneck,
  });
}));

/** Single replication, for a quick look. Not persisted. */
app.post('/api/systems/:id/simulate-once', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;
  const model = withScenario(base, req.body?.scenarioId);
  const sim = runSimulation(model);
  res.json({
    simulation: { ...sim, traces: sim.traces.slice(0, 200), completedVehicles: [] },
    cost: computeCosts(model, sim),
    note: 'Single replication with the model seed. No confidence interval; not persisted.',
  });
}));

app.get('/api/systems/:id/runs', wrap((req, res) => {
  res.json(repo.listRuns(db, req.params.id as string, Number(req.query.limit ?? 50)));
}));

app.get('/api/runs/:runId', wrap((req, res) => {
  const r = repo.getRun(db, req.params.runId as string);
  if (!r) {
    res.status(404).json({ error: 'Run not found.' });
    return;
  }
  res.json(r);
}));

app.delete('/api/runs/:runId', wrap((req, res) => {
  res.json({ deleted: repo.deleteRun(db, req.params.runId as string) });
}));

/** Vehicle traces for a run — requirement 3. */
app.get('/api/runs/:runId/vehicles', wrap((req, res) => {
  res.json(
    repo.listTraces(db, req.params.runId as string, {
      limit: Math.min(Number(req.query.limit ?? 100), 1000),
      offset: Number(req.query.offset ?? 0),
      status: req.query.status as string | undefined,
      minCycle: req.query.minCycle ? Number(req.query.minCycle) : undefined,
    }),
  );
}));

/** One vehicle's complete manufacturing history — requirement 72. */
app.get('/api/runs/:runId/vehicles/:vehicleId', wrap((req, res) => {
  const v = repo.getTrace(db, req.params.runId as string, Number(req.params.vehicleId));
  if (!v) {
    res.status(404).json({ error: 'Vehicle not found in this run.' });
    return;
  }
  res.json(v);
}));

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

app.get('/api/systems/:id/scenarios', wrap((req, res) => {
  res.json(repo.listScenarios(db, req.params.id as string));
}));

app.post('/api/systems/:id/scenarios', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;
  const body = req.body as Scenario & { isBaseline?: boolean };
  const scenario: Scenario & { isBaseline?: boolean } = {
    ...body,
    id: body.id || newId('scn'),
    edits: body.edits ?? [],
    initialInvestment: Number(body.initialInvestment ?? 0),
    additionalAnnualOperatingCost: Number(body.additionalAnnualOperatingCost ?? 0),
  };
  // Reject edits that do not apply cleanly, rather than storing a scenario
  // that will fail every time it is opened.
  applyScenario(base, scenario);
  res.status(201).json(repo.saveScenario(db, base.id, scenario));
}));

app.put('/api/scenarios/:scenarioId', wrap((req, res) => {
  const existing = repo.getScenario(db, req.params.scenarioId as string);
  if (!existing) {
    res.status(404).json({ error: 'Scenario not found.' });
    return;
  }
  const base = repo.getSystem(db, existing.systemId);
  if (!base) {
    res.status(404).json({ error: 'Parent system not found.' });
    return;
  }
  const scenario = { ...existing, ...(req.body as Scenario), id: existing.id };
  applyScenario(base, scenario);
  res.json(repo.saveScenario(db, existing.systemId, scenario));
}));

app.delete('/api/scenarios/:scenarioId', wrap((req, res) => {
  res.json({ deleted: repo.deleteScenario(db, req.params.scenarioId as string) });
}));

/** Resolve a scenario to the full model it produces, for the editor to show. */
app.get('/api/scenarios/:scenarioId/model', wrap((req, res) => {
  const stored = repo.getScenario(db, req.params.scenarioId as string);
  if (!stored) {
    res.status(404).json({ error: 'Scenario not found.' });
    return;
  }
  const base = repo.getSystem(db, stored.systemId);
  if (!base) {
    res.status(404).json({ error: 'Parent system not found.' });
    return;
  }
  res.json(applyScenario(base, stored));
}));

/** Compare two scenarios — requirement 35. */
app.post('/api/systems/:id/compare', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;

  const baselineId = req.body?.baselineScenarioId as string | undefined;
  const proposedId = req.body?.proposedScenarioId as string | undefined;
  const replications = req.body?.replications ? Number(req.body.replications) : undefined;

  const loadScenario = (id: string | undefined, fallbackName: string): Scenario => {
    if (!id) {
      return {
        id: 'inline-baseline',
        name: fallbackName,
        edits: [],
        initialInvestment: 0,
        additionalAnnualOperatingCost: 0,
      };
    }
    const s = repo.getScenario(db, id);
    if (!s) throw new HttpError(404, `Scenario "${id}" not found.`);
    return s;
  };

  const baselineScenario = loadScenario(baselineId, 'Baseline');
  const proposedScenario = proposedId
    ? loadScenario(proposedId, 'Proposed')
    : (req.body?.proposed as Scenario);
  if (!proposedScenario) {
    throw new HttpError(400, 'Provide proposedScenarioId or an inline `proposed` scenario.');
  }

  const a = evaluateScenario(base, baselineScenario, replications ? { replications } : {});
  const b = evaluateScenario(base, proposedScenario, replications ? { replications } : {});
  res.json(compareScenarios(a, b));
}));

/** Interactive what-if — requirement 67. */
app.post('/api/systems/:id/what-if', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;
  const edits = req.body?.edits ?? [];
  if (!Array.isArray(edits)) throw new HttpError(400, '`edits` must be an array of scenario edits.');
  res.json(quickWhatIf(base, edits));
}));

/* ------------------------------------------------------------------ */
/* Optimisation                                                        */
/* ------------------------------------------------------------------ */

app.post('/api/systems/:id/optimize', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;
  const request = req.body;
  if (!request?.objective || !Array.isArray(request.variables) || request.variables.length === 0) {
    throw new HttpError(400, 'Body must include an objective and at least one decision variable.');
  }
  const started = Date.now();
  const result = optimize(base, request);
  const id = repo.saveOptimization(db, { systemId: base.id, request, result });
  res.status(201).json({ id, durationMs: Date.now() - started, result });
}));

app.get('/api/systems/:id/optimizations', wrap((req, res) => {
  res.json(repo.listOptimizations(db, req.params.id as string));
}));

app.get('/api/optimizations/:optId', wrap((req, res) => {
  const o = repo.getOptimization(db, req.params.optId as string);
  if (!o) {
    res.status(404).json({ error: 'Optimisation not found.' });
    return;
  }
  res.json(o);
}));

/* ------------------------------------------------------------------ */
/* Reports and exports                                                 */
/* ------------------------------------------------------------------ */

/** Generate and persist a report — requirement 54. */
app.post('/api/systems/:id/report', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;

  const runId = req.body?.runId as string | undefined;
  let model = withScenario(base, req.body?.scenarioId);
  let study;
  if (runId) {
    const stored = repo.getRun(db, runId);
    if (!stored) throw new HttpError(404, `Run "${runId}" not found.`);
    study = stored.study;
  } else {
    study = runStudy(model);
  }

  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);
  const content = generateReport({
    model,
    study,
    cost,
    author: req.body?.author as string | undefined,
  });

  const id = repo.saveReport(db, {
    systemId: base.id,
    runId: runId ?? null,
    title: req.body?.title ?? `${model.name} — Simulation Report`,
    format: 'markdown',
    content,
  });
  res.status(201).json({ id, content });
}));

app.get('/api/systems/:id/reports', wrap((req, res) => {
  res.json(repo.listReports(db, req.params.id as string));
}));

app.get('/api/reports/:reportId', wrap((req, res) => {
  const r = repo.getReport(db, req.params.reportId as string);
  if (!r) {
    res.status(404).json({ error: 'Report not found.' });
    return;
  }
  if (req.query.download === 'true') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${r.id}.md"`);
    res.send(r.content);
    return;
  }
  res.json(r);
}));

/** Export bundle — requirement 55. */
app.post('/api/systems/:id/export', wrap((req, res) => {
  const base = requireSystem(req, res);
  if (!base) return;
  const model = withScenario(base, req.body?.scenarioId);

  let study;
  let vehicles = [] as ReturnType<typeof runSimulation>['traces'];
  if (req.body?.runId) {
    const stored = repo.getRun(db, req.body.runId as string);
    if (!stored) throw new HttpError(404, 'Run not found.');
    study = stored.study;
    const t = repo.listTraces(db, req.body.runId as string, { limit: 1000 });
    vehicles = t.rows
      .map((r) => repo.getTrace(db, req.body.runId as string, r.vehicleId))
      .filter((v): v is NonNullable<typeof v> => v !== null);
  } else {
    study = runStudy(model);
    vehicles = study.representative.simulation.traces;
  }

  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);
  const report = generateReport({ model, study, cost });
  const files = buildExportBundle({ model, study, cost, vehicles, report });
  res.json({ files });
}));

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`VMQ API listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
  const systems = repo.listSystems(db);
  if (systems.length === 0) {
    console.log('No systems stored. POST /api/systems/seed-reference to load the reference line.');
  } else {
    console.log(`${systems.length} system(s) stored.`);
  }
});

export { app, db };
