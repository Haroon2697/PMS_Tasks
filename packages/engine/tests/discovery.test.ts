/**
 * Task 7 tests — event log parsing, process discovery, and the discovered model.
 *
 * The centrepiece is the ROUND TRIP: simulate a model whose parameters are
 * known exactly, export the event log it produced, discover a model back from
 * that log, and check the recovered structure and parameters against the
 * originals. If discovery could not recover a process it generated itself,
 * nothing it reports about a real log would be trustworthy.
 */

import { describe, expect, it } from 'vitest';
import {
  eventLogToCsv,
  parseEventLogCsv,
  parseTimestamp,
  splitCsvLine,
} from '../src/discovery/eventLog.js';
import {
  discoverProcess,
  fitDistribution,
  maxOverlap,
  slugify,
} from '../src/discovery/discover.js';
import {
  compareObservedToAnalytical,
  discoveredToSystemModel,
} from '../src/discovery/toModel.js';
import {
  eventLogCsvFromVehicles,
  eventLogFromVehicles,
} from '../src/discovery/fromSimulation.js';
import { computeCosts } from '../src/cost/costEngine.js';
import { runSimulation } from '../src/des/simulation.js';
import { solveNetwork } from '../src/analytical/network.js';
import { validateModel } from '../src/validation/validate.js';
import { buildReferenceModel } from '../src/model/referenceModel.js';
import { param } from '../src/model/types.js';

/* ------------------------------------------------------------------ */
/* CSV and timestamps                                                  */
/* ------------------------------------------------------------------ */

describe('CSV splitting', () => {
  it('handles quoted fields and escaped quotes', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
  });
});

describe('timestamp parsing', () => {
  it('parses clock times to minutes', () => {
    expect(parseTimestamp('08:00')?.minutes).toBe(480);
    expect(parseTimestamp('08:15')?.minutes).toBe(495);
    expect(parseTimestamp('08:15:30')?.minutes).toBeCloseTo(495.5, 6);
    expect(parseTimestamp('08:00')?.format).toBe('clock');
  });

  it('parses ISO datetimes', () => {
    const a = parseTimestamp('2026-01-05T08:00:00Z');
    const b = parseTimestamp('2026-01-05T09:00:00Z');
    expect(a).not.toBeNull();
    expect((b as { minutes: number }).minutes - (a as { minutes: number }).minutes).toBeCloseTo(60, 6);
  });

  it('distinguishes epoch seconds, epoch milliseconds and plain minutes', () => {
    expect(parseTimestamp('45')?.format).toBe('numeric-minutes');
    expect(parseTimestamp('1767600000')?.format).toBe('epoch-s');
    expect(parseTimestamp('1767600000000')?.format).toBe('epoch-ms');
  });

  it('rejects nonsense', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('lunchtime')).toBeNull();
    expect(parseTimestamp('99:99')).toBeNull();
  });
});

describe('event log parsing', () => {
  const CSV = `CaseID,Activity,Start,Complete
V001,Body Shop,08:00,08:15
V001,Paint,08:17,08:35
V001,Assembly,08:38,09:00
V002,Body Shop,08:05,08:20
V002,Paint,08:36,08:55`;

  it('parses the brief’s example format', () => {
    const log = parseEventLogCsv(CSV);
    expect(log.rows).toHaveLength(5);
    expect(log.caseIds).toEqual(['V001', 'V002']);
    expect(log.activityNames).toEqual(['Body Shop', 'Paint', 'Assembly']);
    expect(log.timeFormat).toBe('clock');
    // Times are normalised so the earliest event is 0.
    expect(log.rows[0]?.start).toBe(0);
    expect(log.rows[0]?.complete).toBe(15);
  });

  it('matches column names by synonym, not by exact spelling', () => {
    const log = parseEventLogCsv(`case_id;task;begin;finish
V1;Weld;08:00;08:10`);
    expect(log.columns.caseId).toBe('case_id');
    expect(log.columns.activity).toBe('task');
    expect(log.columns.start).toBe('begin');
    expect(log.columns.complete).toBe('finish');
    expect(log.rows).toHaveLength(1);
  });

  it('reports which columns it could not find rather than guessing', () => {
    expect(() => parseEventLogCsv('foo,bar\n1,2')).toThrow(/case id|activity|start/i);
  });

  it('skips unusable rows and reports each one', () => {
    const log = parseEventLogCsv(`CaseID,Activity,Start,Complete
V1,Weld,08:00,08:10
,Weld,08:00,08:10
V2,Weld,notatime,08:10
V3,Weld,09:00,08:00`);
    expect(log.rows).toHaveLength(1);
    expect(log.rejected).toHaveLength(3);
    expect(log.rejected.map((r) => r.reason).join(' ')).toMatch(/missing case id/);
    expect(log.rejected.map((r) => r.reason).join(' ')).toMatch(/unrecognised start/);
    expect(log.rejected.map((r) => r.reason).join(' ')).toMatch(/before start/);
  });

  it('unwraps clock times that cross midnight instead of going backwards', () => {
    const log = parseEventLogCsv(`CaseID,Activity,Start,Complete
V1,Night Shift,23:50,23:58
V1,Morning,00:10,00:20`);
    expect(log.rows).toHaveLength(2);
    const [a, b] = log.rows;
    expect(b!.start).toBeGreaterThan(a!.complete);
    expect(b!.start - a!.complete).toBeCloseTo(12, 6);
    expect(log.warnings.some((w) => w.includes('midnight'))).toBe(true);
  });

  it('flags an assumed service time when there is no completion column', () => {
    const log = parseEventLogCsv(
      `CaseID,Activity,Start\nV1,Weld,08:00\nV1,Paint,08:30`,
      { assumedServiceMinutes: 5 },
    );
    expect(log.columns.complete).toBeNull();
    expect(log.rows[0]?.complete).toBe(5);
    expect(log.warnings.some((w) => w.includes('ASSUMED'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Discovery primitives                                                */
/* ------------------------------------------------------------------ */

describe('server-count estimation by maximum concurrency', () => {
  it('counts the most overlapping intervals', () => {
    expect(maxOverlap([])).toBe(0);
    expect(maxOverlap([{ start: 0, complete: 10 }])).toBe(1);
    // Two overlapping, then a third that starts after the first ends.
    expect(
      maxOverlap([
        { start: 0, complete: 10 },
        { start: 5, complete: 15 },
        { start: 12, complete: 20 },
      ]),
    ).toBe(2);
    expect(
      maxOverlap([
        { start: 0, complete: 10 },
        { start: 1, complete: 10 },
        { start: 2, complete: 10 },
      ]),
    ).toBe(3);
  });

  it('does not count back-to-back work as concurrent', () => {
    expect(
      maxOverlap([
        { start: 0, complete: 10 },
        { start: 10, complete: 20 },
      ]),
    ).toBe(1);
  });
});

describe('distribution fitting from the coefficient of variation', () => {
  it('picks D for near-constant service', () => {
    const f = fitDistribution(20, 0.02);
    expect(f.symbol).toBe('D');
    expect(f.distribution.kind).toBe('constant');
  });

  it('picks M when CV is near 1', () => {
    const f = fitDistribution(20, 1.0);
    expect(f.symbol).toBe('M');
    expect(f.distribution.kind).toBe('exponential');
  });

  it('picks Erlang-k with k = 1/CV^2 when service is less variable', () => {
    const f = fitDistribution(20, 0.5); // 1/0.25 = 4
    expect(f.symbol).toBe('E4');
    expect(f.distribution).toMatchObject({ kind: 'erlang', k: 4, mean: 20 });
  });

  it('picks G when service is more variable than exponential', () => {
    const f = fitDistribution(20, 1.8);
    expect(f.symbol).toBe('G');
    expect(f.distribution.kind).toBe('lognormal');
  });

  it('always explains its choice', () => {
    for (const cv of [0.05, 0.5, 1, 2]) {
      expect(fitDistribution(10, cv).rationale.length).toBeGreaterThan(30);
    }
  });
});

describe('slugify', () => {
  it('produces stable station ids from activity names', () => {
    expect(slugify('Body Shop')).toBe('body_shop');
    expect(slugify('Quality Inspection')).toBe('quality_inspection');
    expect(slugify('  Paint / Coat  ')).toBe('paint_coat');
  });
});

/* ------------------------------------------------------------------ */
/* Discovery on a hand-built log                                       */
/* ------------------------------------------------------------------ */

describe('process discovery on a known log', () => {
  // Three cases; V002 goes round an inspection -> rework -> inspection loop.
  const CSV = `CaseID,Activity,Start,Complete
V001,Body Shop,08:00,08:20
V001,Paint,08:20,08:50
V001,Inspection,08:50,09:00
V002,Body Shop,08:10,08:30
V002,Paint,08:30,09:00
V002,Inspection,09:00,09:10
V002,Rework,09:10,09:30
V002,Inspection,09:30,09:40
V003,Body Shop,08:20,08:40
V003,Paint,08:40,09:10
V003,Inspection,09:10,09:20`;

  const log = parseEventLogCsv(CSV);
  const d = discoverProcess(log);

  it('finds the activities and orders them by position in the process', () => {
    expect(d.activities.map((a) => a.name)).toEqual([
      'Body Shop',
      'Paint',
      'Inspection',
      'Rework',
    ]);
  });

  it('counts executions and cases separately', () => {
    const insp = d.activities.find((a) => a.name === 'Inspection')!;
    expect(insp.executions).toBe(4); // V002 was inspected twice
    expect(insp.cases).toBe(3);
    expect(insp.visitsPerCase).toBeCloseTo(4 / 3, 6);
  });

  it('measures service times from the log', () => {
    const paint = d.activities.find((a) => a.name === 'Paint')!;
    expect(paint.serviceMeanMinutes).toBeCloseTo(30, 6);
    expect(paint.serviceCV).toBeCloseTo(0, 6);
    const body = d.activities.find((a) => a.name === 'Body Shop')!;
    expect(body.serviceMeanMinutes).toBeCloseTo(20, 6);
  });

  it('derives routing probabilities from the directly-follows graph', () => {
    // Inspection was executed 4 times: 3 ended the case, 1 went to Rework.
    const toRework = d.edges.find((e) => e.from === 'inspection' && e.to === 'rework')!;
    expect(toRework.count).toBe(1);
    expect(toRework.probability).toBeCloseTo(0.25, 6);
    const insp = d.activities.find((a) => a.id === 'inspection')!;
    expect(insp.endCount).toBe(3);
  });

  it('detects the inspection/rework feedback loop', () => {
    const loop = d.loops.find((l) => l.kind === 'cycle');
    expect(loop).toBeDefined();
    expect(loop!.activities.sort()).toEqual(['inspection', 'rework']);
    expect(loop!.cases).toBe(1);
    const reworkEdge = d.edges.find((e) => e.from === 'rework' && e.to === 'inspection');
    expect(reworkEdge?.isLoopBack).toBe(true);
  });

  it('identifies start and end activities', () => {
    expect(d.startActivities.map((s) => s.id)).toEqual(['body_shop']);
    expect(d.startActivities[0]?.count).toBe(3);
    expect(d.endActivities.map((s) => s.id)).toEqual(['inspection']);
  });

  it('measures waiting time as the gap between consecutive activities', () => {
    // V001 Paint starts at 08:20, Body Shop finished 08:20 -> 0 wait.
    // V002 Paint starts 08:30, Body Shop finished 08:30 -> 0 wait.
    const paint = d.activities.find((a) => a.id === 'paint')!;
    expect(paint.observedWaitMeanMinutes).toBeCloseTo(0, 6);
    expect(paint.waitObservations).toBe(3);
  });

  it('estimates inter-arrival time and lambda from case start times', () => {
    // Arrivals at 08:00, 08:10, 08:20 -> two gaps of 10 minutes.
    expect(d.interArrival.count).toBe(2);
    expect(d.interArrival.meanMinutes).toBeCloseTo(10, 6);
    expect(d.interArrival.lambdaPerHour).toBeCloseTo(6, 6);
  });

  it('computes per-activity lambda and mu from the observation window', () => {
    const body = d.activities.find((a) => a.id === 'body_shop')!;
    // Window: 08:00 to 09:40 = 100 minutes.
    expect(d.observationWindowMinutes).toBeCloseTo(100, 6);
    expect(body.lambdaObservedPerHour).toBeCloseTo(3 / (100 / 60), 6);
    expect(body.muObservedPerHour).toBeCloseTo(60 / 20, 6);
  });

  it('groups traces into variants', () => {
    expect(d.variants).toHaveLength(2);
    expect(d.variants[0]?.count).toBe(2); // the two straight-through cases
    expect(d.variants[0]?.share).toBeCloseTo(2 / 3, 6);
    expect(d.variants[1]?.sequence).toContain('Rework');
  });

  it('estimates server counts from observed concurrency', () => {
    // Body Shop ran 08:00-08:20, 08:10-08:30, 08:20-08:40 -> max 2 at once.
    const body = d.activities.find((a) => a.id === 'body_shop')!;
    expect(body.maxConcurrency).toBe(2);
  });

  it('records every inference as an explicit, editable assumption', () => {
    const serverAssumptions = d.assumptions.filter((a) => a.id.startsWith('servers:'));
    expect(serverAssumptions).toHaveLength(d.activities.length);
    for (const a of serverAssumptions) {
      expect(a.editable).toBe(true);
      expect(a.why).toMatch(/does not record capacity/i);
    }
    expect(d.assumptions.some((a) => a.id === 'queue-discipline')).toBe(true);
    expect(d.assumptions.some((a) => a.id === 'arrival-dist')).toBe(true);
  });

  it('computes the observed cycle time per case', () => {
    // V001: 08:00-09:00 = 60; V002: 08:10-09:40 = 90; V003: 08:20-09:20 = 60.
    expect(d.cycleTime.meanMinutes).toBeCloseTo(70, 6);
    expect(d.cycleTime.maxMinutes).toBeCloseTo(90, 6);
    expect(d.cycleTime.minMinutes).toBeCloseTo(60, 6);
  });

  it('warns that the sample is small rather than presenting it as solid', () => {
    expect(d.warnings.some((w) => w.includes('Only 3 cases'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Discovered model                                                    */
/* ------------------------------------------------------------------ */

describe('building an executable model from a discovered process', () => {
  const CSV = `CaseID,Activity,Start,Complete
V001,Body Shop,08:00,08:20
V001,Paint,08:20,08:50
V001,Inspection,08:50,09:00
V002,Body Shop,08:10,08:30
V002,Paint,08:30,09:00
V002,Inspection,09:00,09:10
V002,Rework,09:10,09:30
V002,Inspection,09:30,09:40
V003,Body Shop,08:20,08:40
V003,Paint,08:40,09:10
V003,Inspection,09:10,09:20`;

  const d = discoverProcess(parseEventLogCsv(CSV));
  const reference = buildReferenceModel();
  const { model, notes } = discoveredToSystemModel(d, { reference });

  it('produces a model that passes the existing validator', () => {
    const v = validateModel(model);
    expect(v.errors).toEqual([]);
    expect(v.runnable).toBe(true);
  });

  it('creates one station per discovered activity, with the fitted distribution', () => {
    expect(model.stations.map((s) => s.name)).toEqual([
      'Body Shop',
      'Paint',
      'Inspection',
      'Rework',
    ]);
    const paint = model.stations.find((s) => s.id === 'paint')!;
    // Paint was exactly 30 minutes every time -> deterministic.
    expect(paint.service).toEqual({ kind: 'constant', value: 30 });
  });

  it('classifies inspection and rework stations from their names', () => {
    expect(model.stations.find((s) => s.id === 'inspection')?.kind).toBe('inspection');
    expect(model.stations.find((s) => s.id === 'rework')?.kind).toBe('rework');
    expect(model.stations.find((s) => s.id === 'body_shop')?.kind).toBe('source');
  });

  it('routes with probabilities that sum to exactly 1 at every station', () => {
    for (const s of model.stations) {
      const sum = s.routing.reduce((a, e) => a + e.probability, 0);
      expect(sum).toBeCloseTo(1, 9);
    }
  });

  it('preserves the rework feedback loop as a routing arc', () => {
    const insp = model.stations.find((s) => s.id === 'inspection')!;
    expect(insp.routing.find((e) => e.to === 'rework')?.probability).toBeCloseTo(0.25, 6);
    expect(insp.routing.find((e) => e.to === '__FINISHED__')?.probability).toBeCloseTo(0.75, 6);
    const rework = model.stations.find((s) => s.id === 'rework')!;
    expect(rework.routing.find((e) => e.to === 'inspection')?.probability).toBeCloseTo(1, 6);
  });

  it('reproduces the rework loop in the traffic equations', () => {
    const net = solveNetwork(model);
    const insp = net.stations.find((s) => s.stationId === 'inspection')!;
    // p(fail) = 0.25 -> inspection is visited 1/(1-0.25) = 1.333 times per case.
    expect(insp.visitRatio).toBeCloseTo(1 / 0.75, 6);
  });

  it('uses the arrival rate estimated from the log', () => {
    expect(model.arrivals.entryStationId).toBe('body_shop');
    expect(model.arrivals.schedule[0]?.lambdaPerHour.value).toBeCloseTo(6, 6);
    expect(model.arrivals.schedule[0]?.lambdaPerHour.provenance).toBe('DERIVED');
  });

  it('inherits the cost model, because a log contains no prices', () => {
    expect(model.cost.electricityPricePerKwh.value).toBe(reference.cost.electricityPricePerKwh.value);
    expect(model.vehicleModels[0]?.sellingPrice.value).toBe(
      reference.vehicleModels[0]?.sellingPrice.value,
    );
    expect(notes.join(' ')).toMatch(/inherited|copied from the reference/i);
  });

  it('remaps BOM lines onto stations that exist in the discovered process', () => {
    const ids = new Set(model.stations.map((s) => s.id));
    for (const c of model.vehicleModels[0]!.bom) {
      expect(ids.has(c.consumedAtStationId)).toBe(true);
    }
  });

  it('keeps the total material cost unchanged when remapping', () => {
    const total = (m: typeof model) =>
      m.vehicleModels[0]!.bom.reduce(
        (a, c) => a + c.quantityPerVehicle * (1 + c.scrapAllowance) * c.unitCost.value,
        0,
      );
    expect(total(model)).toBeCloseTo(total(reference), 6);
  });

  it('records that the model was discovered, not configured', () => {
    expect(model.assumptions?.[0]).toMatch(/DISCOVERED from an event log/);
    expect(model.assumptions?.join(' ')).toMatch(/lower bound/i);
  });
});

/* ------------------------------------------------------------------ */
/* Simulating the discovered model, and costing it (Task 6 + 7)        */
/* ------------------------------------------------------------------ */

describe('the discovered model is executable and costable', () => {
  const CSV = `CaseID,Activity,Start,Complete
V001,Body Shop,08:00,08:20
V001,Paint,08:20,08:50
V001,Inspection,08:50,09:00
V002,Body Shop,08:10,08:30
V002,Paint,08:30,09:00
V002,Inspection,09:00,09:10
V002,Rework,09:10,09:30
V002,Inspection,09:30,09:40
V003,Body Shop,08:20,08:40
V003,Paint,08:40,09:10
V003,Inspection,09:10,09:20`;

  const d = discoverProcess(parseEventLogCsv(CSV));
  const { model } = discoveredToSystemModel(d, {
    reference: buildReferenceModel(),
    // Give the discovered stations enough capacity to be stable at the
    // observed arrival rate, so the run produces completed vehicles.
    serverOverrides: { body_shop: 3, paint: 4, inspection: 2, rework: 2 },
    warmupMinutes: 600,
    durationMinutes: 3000,
  });

  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);

  it('runs the discovered model through the existing simulator', () => {
    expect(sim.system.vehiclesCompleted).toBeGreaterThan(0);
    expect(sim.stations).toHaveLength(4);
    expect(sim.eventsProcessed).toBeGreaterThan(100);
  });

  it('produces vehicles that visited the discovered activities in order', () => {
    const v = sim.traces.find((x) => x.status === 'FINISHED' && x.reworkCount === 0);
    expect(v).toBeDefined();
    expect(v!.visits.map((x) => x.stationName)).toEqual(['Body Shop', 'Paint', 'Inspection']);
  });

  it('sends some vehicles round the discovered rework loop', () => {
    const reworked = sim.traces.find((x) => x.reworkCount > 0);
    expect(reworked).toBeDefined();
    const ids = reworked!.visits.map((x) => x.stationId);
    const first = ids.indexOf('inspection');
    expect(ids[first + 1]).toBe('rework');
    expect(ids[first + 2]).toBe('inspection');
  });

  it('costs a vehicle discovered in Task 7 using the Task 6 cost engine', () => {
    // The connecting requirement: "this vehicle took X minutes and cost Y".
    expect(cost.vehicles.length).toBeGreaterThan(0);
    const v = cost.vehicles.find((x) => x.status === 'FINISHED');
    expect(v).toBeDefined();
    expect(v!.cycleTimeHours).not.toBeNull();
    expect(v!.totalCost).toBeGreaterThan(0);
    expect(v!.materialCost).toBeGreaterThan(0);
    expect(v!.laborCost).toBeGreaterThan(0);
  });

  it('keeps the nine cost lines additive for a discovered model too', () => {
    const sum = cost.lines.reduce((a, l) => a + l.amount, 0);
    expect(sum).toBeCloseTo(cost.totalManufacturingCost, 6);
  });

  it('separates event-log observation from analytical prediction', () => {
    const net = solveNetwork(model);
    const rows = compareObservedToAnalytical(
      d,
      net.stations.map((s) => ({
        stationId: s.stationId,
        kendall: s.kendall,
        c: s.c,
        lambda: s.lambda,
        rho: s.rho,
        L: s.L,
        Lq: s.Lq,
        WMinutes: s.WMinutes,
        WqMinutes: s.WqMinutes,
        stable: s.stable,
        exact: s.exact,
      })),
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      // Both columns are populated and reported separately, never merged.
      expect(r.observed.executions).toBeGreaterThan(0);
      expect(Number.isFinite(r.analytical.rho)).toBe(true);
      expect(r.kendall).toMatch(/^M\/[MDGE]\d*\/\d+$/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Round trip: simulate -> export log -> rediscover                    */
/* ------------------------------------------------------------------ */

describe('round trip — discovery recovers a model it generated itself', () => {
  // A known model, run long enough to give discovery a solid sample.
  const original = buildReferenceModel();
  original.arrivals.schedule = [
    { startMinute: 0, endMinute: 200_000, lambdaPerHour: param(5, 'vehicles/hour', 'USER_INPUT') },
  ];
  original.simulation.warmupMinutes = 2_000;
  original.simulation.durationMinutes = 40_000;
  original.simulation.maxTraces = 4000;
  original.simulation.collectVehicleTraces = true;
  original.simulation.terminationMode = 'drain';
  // Breakdowns off: a repair stretches an activity's duration in the log, which
  // would show up as service-time variability rather than as downtime, since a
  // log has no way to express "the machine was broken".
  for (const s of original.stations) {
    if (s.machine?.reliability) s.machine.reliability.enabled = false;
  }

  const sim = runSimulation(original);
  const rows = eventLogFromVehicles(sim.traces);
  const csv = eventLogToCsv(rows);
  const reparsed = parseEventLogCsv(csv);
  const d = discoverProcess(reparsed);

  it('exports a usable event log from simulation traces', () => {
    expect(rows.length).toBeGreaterThan(1000);
    expect(csv.split('\r\n')[0]).toBe('CaseID,Activity,Start,Complete');
    expect(reparsed.rejected).toEqual([]);
    expect(reparsed.rows.length).toBe(rows.length);
  });

  it('recovers every activity in the original model', () => {
    const discoveredNames = new Set(d.activities.map((a) => a.name));
    for (const s of original.stations) {
      expect(discoveredNames.has(s.name)).toBe(true);
    }
  });

  it('recovers the process order', () => {
    const order = d.activities.map((a) => a.name);
    expect(order.indexOf('Body Shop')).toBeLessThan(order.indexOf('Paint Shop'));
    expect(order.indexOf('Paint Shop')).toBeLessThan(order.indexOf('Final Assembly'));
    expect(order.indexOf('Final Assembly')).toBeLessThan(order.indexOf('Quality Inspection'));
  });

  it('recovers the mean service time at every station', () => {
    for (const s of original.stations) {
      const a = d.activities.find((x) => x.name === s.name)!;
      const expected =
        s.service.kind === 'exponential'
          ? s.service.mean
          : s.service.kind === 'erlang'
            ? s.service.mean
            : 0;
      if (expected <= 0) continue;

      // The discovered mean is a sample mean, so the tolerance has to be the
      // sampling error of that sample rather than a flat percentage. Rework
      // runs a tenth as often as the main line, so its mean is estimated from
      // far fewer observations and is legitimately less precise. Three standard
      // errors is a ~99.7% interval.
      const standardError = a.serviceCV / Math.sqrt(a.executions);
      const tolerance = Math.max(0.02, 3 * standardError);
      const relative = Math.abs(a.serviceMeanMinutes - expected) / expected;
      expect(
        relative,
        `${s.name}: discovered ${a.serviceMeanMinutes.toFixed(2)} vs true ${expected} ` +
          `over ${a.executions} executions (tolerance ${(tolerance * 100).toFixed(1)}%)`,
      ).toBeLessThan(tolerance);
    }
  });

  it('recovers the inspection failure probability from the routing', () => {
    // The original routes 10% of inspections to rework.
    const toRework = d.edges.find((e) => e.from === 'quality_inspection' && e.to === 'rework')!;
    expect(toRework).toBeDefined();
    expect(Math.abs(toRework.probability - 0.1)).toBeLessThan(0.02);
  });

  it('recovers the arrival rate', () => {
    expect(Math.abs(d.interArrival.lambdaPerHour - 5) / 5).toBeLessThan(0.08);
  });

  it('recovers the exponential service distribution family', () => {
    // Paint Shop is exponential in the original, so its CV should be near 1
    // and the fitted family should be M.
    const paint = d.activities.find((a) => a.name === 'Paint Shop')!;
    expect(paint.serviceCV).toBeGreaterThan(0.85);
    expect(paint.serviceCV).toBeLessThan(1.15);
    expect(fitDistribution(paint.serviceMeanMinutes, paint.serviceCV).symbol).toBe('M');
  });

  it('recovers Erlang-2 at the station that was configured as Erlang-2', () => {
    // Final Assembly is Erlang-2 in the original: CV = 1/sqrt(2) = 0.707.
    const fa = d.activities.find((a) => a.name === 'Final Assembly')!;
    expect(Math.abs(fa.serviceCV - 1 / Math.SQRT2)).toBeLessThan(0.08);
    expect(fitDistribution(fa.serviceMeanMinutes, fa.serviceCV).symbol).toBe('E2');
  });

  it('detects the inspection/rework loop that the original model contains', () => {
    const loop = d.loops.find(
      (l) => l.kind === 'cycle' && l.activities.includes('rework') && l.activities.includes('quality_inspection'),
    );
    expect(loop).toBeDefined();
    expect(loop!.share).toBeGreaterThan(0.05);
  });

  it('estimates server counts at or below the true capacity', () => {
    // Max observed concurrency is a LOWER bound on the real server count.
    for (const s of original.stations) {
      const a = d.activities.find((x) => x.name === s.name)!;
      expect(a.maxConcurrency).toBeLessThanOrEqual(s.servers);
      expect(a.maxConcurrency).toBeGreaterThan(0);
    }
  });

  it('rebuilds a model whose throughput matches the original', () => {
    const { model: rebuilt } = discoveredToSystemModel(d, {
      reference: original,
      // Use the original's true server counts: the log can only give a lower
      // bound, and this test is about whether the PROCESS was recovered.
      serverOverrides: Object.fromEntries(
        original.stations.map((s) => [slugify(s.name), s.servers]),
      ),
      warmupMinutes: 2000,
      durationMinutes: 20_000,
    });
    expect(validateModel(rebuilt).runnable).toBe(true);

    const rerun = runSimulation(rebuilt);
    const rel =
      Math.abs(rerun.system.throughputPerHour - sim.system.throughputPerHour) /
      sim.system.throughputPerHour;
    expect(rel).toBeLessThan(0.1);
  });

  it('produces a CSV export helper that matches the row export', () => {
    expect(eventLogCsvFromVehicles(sim.traces.slice(0, 5))).toContain('CaseID,Activity,Start,Complete');
  });
});
