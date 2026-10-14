/**
 * Discovered process -> executable SystemModel — Task 7, step 3.
 *
 * This is the join between Task 7 and everything built before it. The output
 * is an ordinary `SystemModel`, so the discovered process immediately gets the
 * existing discrete-event simulator, the existing analytical queueing solver,
 * the existing cost engine, bottleneck analysis, scenarios, optimiser and
 * report generator — none of which know or care that the model came from a log
 * rather than from the parameter editor.
 *
 * THE COST MODEL IS INHERITED, NOT INVENTED. An event log contains no prices.
 * Wages, machine costs, energy, overhead and the bill of materials are carried
 * across from a reference model supplied by the caller, so a vehicle simulated
 * through the discovered process can still be costed (Task 6) and answer
 * "this vehicle took X minutes and cost Y to manufacture".
 *
 * Where a discovered activity has no counterpart in the reference model, its
 * crew and machine are scaled from the reference average rather than invented,
 * and every such substitution is reported in `notes` so it is visible rather
 * than buried.
 */

import type {
  BomComponent,
  Station,
  StationKind,
  SystemModel,
  VehicleModel,
  WorkerCrew,
} from '../model/types.js';
import { SINK_FINISHED, param } from '../model/types.js';
import { deepClone } from '../util/clone.js';
import type { DiscoveredProcess } from './discover.js';
import { fitDistribution } from './discover.js';

export interface ToModelOptions {
  /**
   * Model whose cost structure, currency and calendar are inherited. Normally
   * the system the user already has open.
   */
  reference: SystemModel;
  /** Per-activity server count, overriding the discovered estimate. */
  serverOverrides?: Record<string, number>;
  /** External arrival rate override, vehicles/hour. */
  lambdaPerHour?: number;
  id?: string;
  name?: string;
  /** Warm-up and measurement window for the generated model, minutes. */
  warmupMinutes?: number;
  durationMinutes?: number;
  seed?: number;
}

export interface DiscoveredModelResult {
  model: SystemModel;
  /** What had to be inferred, substituted or dropped, in plain language. */
  notes: string[];
  /** Activity id -> station id (they are the same, but this is the contract). */
  activityToStation: Record<string, string>;
}

/**
 * Classify an activity from its name so inspection and rework stations get the
 * right `kind`, which is what drives the cost engine's quality/rework buckets
 * and the FAIL/PASS labelling in the simulator.
 */
export function classifyActivity(name: string): StationKind {
  const n = name.toLowerCase();
  if (/\b(rework|repair|fix|correct|redo)\b/.test(n)) return 'rework';
  if (/\b(inspect|inspection|quality|qa|qc|test|check|audit|verify)\b/.test(n)) return 'inspection';
  return 'process';
}

/** Average crew cost per hour across the reference model, for substitutions. */
function referenceCrewTemplate(reference: SystemModel): { crew: WorkerCrew[]; ratePerHour: number } {
  const withCrew = reference.stations.filter((s) => s.workers.length > 0);
  if (withCrew.length === 0) return { crew: [], ratePerHour: 0 };
  const totalRate = withCrew.reduce(
    (a, s) => a + s.workers.reduce((b, w) => b + w.count * w.hourlyWage.value, 0),
    0,
  );
  const template = (withCrew[0] as Station).workers;
  return { crew: template, ratePerHour: totalRate / withCrew.length };
}

export function discoveredToSystemModel(
  discovered: DiscoveredProcess,
  options: ToModelOptions,
): DiscoveredModelResult {
  const notes: string[] = [];
  const reference = options.reference;
  const activityToStation: Record<string, string> = {};

  if (discovered.activities.length === 0) {
    throw new Error('The discovered process has no activities, so no model can be built from it.');
  }

  /* ---- entry point ---- */

  const entry = discovered.startActivities[0];
  if (!entry) {
    throw new Error('No case in the log has a first activity, so there is no entry point.');
  }
  if (discovered.startActivities.length > 1) {
    notes.push(
      `Cases in the log start at ${discovered.startActivities.length} different activities. ` +
        `"${entry.name}" is the most common (${entry.count} of ${discovered.caseCount} cases) and is ` +
        'used as the entry point; the rest are reached through routing.',
    );
  }

  /* ---- reference material for substitution ---- */

  const refByName = new Map<string, Station>();
  for (const s of reference.stations) refByName.set(normalise(s.name), s);
  const crewTemplate = referenceCrewTemplate(reference);
  const substituted: string[] = [];

  /* ---- stations ---- */

  const stations: Station[] = discovered.activities.map((a) => {
    activityToStation[a.id] = a.id;
    const servers = Math.max(
      1,
      options.serverOverrides?.[a.id] ?? Math.max(1, a.maxConcurrency),
    );
    const fit = fitDistribution(a.serviceMeanMinutes, a.serviceCV);
    const kind: StationKind = a.id === entry.id ? 'source' : classifyActivity(a.name);

    // Routing out of this activity: every observed successor, plus a
    // termination arc carrying the share of cases that ended here. Including
    // terminations is what makes the probabilities sum to exactly 1.
    const out = discovered.edges.filter((e) => e.from === a.id);
    const outCount = out.reduce((s, e) => s + e.count, 0) + a.endCount;
    const routing = out.map((e) => {
      const target = discovered.activities.find((x) => x.id === e.to);
      return {
        to: e.to,
        probability: outCount > 0 ? e.count / outCount : 0,
        label:
          e.isLoopBack && target
            ? `rework -> ${target.name}`
            : target
              ? `to ${target.name}`
              : e.to,
      };
    });
    if (a.endCount > 0) {
      routing.push({
        to: SINK_FINISHED,
        probability: outCount > 0 ? a.endCount / outCount : 1,
        label: 'complete',
      });
    }
    if (routing.length === 0) {
      routing.push({ to: SINK_FINISHED, probability: 1, label: 'complete' });
      notes.push(
        `"${a.name}" has no observed successor and never ends a case, which cannot happen in a ` +
          'consistent log. It has been routed to the finished sink so the model is solvable.',
      );
    }

    // Cost structure: match by name to the reference model where possible.
    const ref = refByName.get(normalise(a.name));
    if (!ref) substituted.push(a.name);

    const workers: WorkerCrew[] = ref
      ? deepClone(ref.workers)
      : crewTemplate.crew.map((w) => ({
          ...deepClone(w),
          id: `${a.id}_${w.id}`,
        }));

    const station: Station = {
      id: a.id,
      name: a.name,
      kind,
      description:
        `Discovered from the event log: ${a.executions} executions across ${a.cases} cases, ` +
        `mean service ${a.serviceMeanMinutes.toFixed(2)} min (CV ${a.serviceCV.toFixed(2)}). ` +
        fit.rationale,
      servers,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: fit.distribution,
      workers,
      routing,
      scrapProbability: 0,
    };
    if (ref?.machine) station.machine = deepClone(ref.machine);
    else if (reference.stations[0]?.machine) {
      const m = deepClone(reference.stations[0].machine);
      m.id = `${a.id}_machine`;
      m.name = `${a.name} equipment (cost inherited)`;
      if (m.reliability) m.reliability.enabled = false;
      station.machine = m;
    }
    return station;
  });

  if (substituted.length > 0) {
    notes.push(
      `${substituted.length} discovered activity name(s) (${substituted.join(', ')}) had no ` +
        'counterpart in the reference model, so their crew and machine costs were copied from the ' +
        'reference as a placeholder. Edit them before quoting any cost from this model — the ' +
        'timings are discovered, the prices are inherited.',
    );
  }

  /* ---- vehicle model / BOM remapping ---- */

  const stationIds = new Set(stations.map((s) => s.id));
  const firstStationId = (stations[0] as Station).id;
  const remapped: string[] = [];

  const vehicleModels: VehicleModel[] = reference.vehicleModels.map((vm) => {
    const bom: BomComponent[] = vm.bom.map((c) => {
      if (stationIds.has(c.consumedAtStationId)) return deepClone(c);
      // Try to match the original station's NAME to a discovered activity.
      const origName = reference.stations.find((s) => s.id === c.consumedAtStationId)?.name;
      const match = origName
        ? stations.find((s) => normalise(s.name) === normalise(origName))
        : undefined;
      const target = match?.id ?? firstStationId;
      if (!match) remapped.push(c.name);
      return { ...deepClone(c), consumedAtStationId: target };
    });
    return { ...deepClone(vm), bom };
  });

  if (remapped.length > 0) {
    notes.push(
      `${remapped.length} bill-of-materials line(s) were consumed at stations that do not exist in ` +
        `the discovered process, so they are issued at "${stations[0]?.name}" instead. Total material ` +
        'cost per vehicle is unchanged; only the station it is charged to has moved, which matters ' +
        'for the scrap calculation.',
    );
  }

  /* ---- arrivals ---- */

  const lambda = options.lambdaPerHour ?? discovered.interArrival.lambdaPerHour;
  if (!(lambda > 0)) {
    throw new Error(
      'The log has too few cases to estimate an arrival rate (at least two arrivals are needed). ' +
        'Set the arrival rate manually.',
    );
  }

  const warmup = options.warmupMinutes ?? Math.round(discovered.cycleTime.meanMinutes * 3);
  const duration =
    options.durationMinutes ?? Math.max(480, Math.round(discovered.observationWindowMinutes));

  const interarrivalKind =
    discovered.interArrival.symbol === 'D'
      ? 'constant'
      : discovered.interArrival.symbol.startsWith('E')
        ? 'erlang'
        : discovered.interArrival.symbol === 'G'
          ? 'lognormal'
          : 'exponential';

  /* ---- assemble ---- */

  const model: SystemModel = {
    id: options.id ?? `discovered-${Date.now().toString(36)}`,
    name: options.name ?? 'Discovered process',
    description:
      `Queueing model discovered from an event log of ${discovered.caseCount} cases and ` +
      `${discovered.eventCount} events spanning ${(discovered.observationWindowMinutes / 60).toFixed(1)} hours. ` +
      'Structure and timings come from the log; cost parameters are inherited from ' +
      `"${reference.name}".`,
    stations,
    arrivals: {
      entryStationId: entry.id,
      interarrivalKind,
      modelMix: vehicleModels.length
        ? [{ modelId: (vehicleModels[0] as VehicleModel).id, share: 1 }]
        : [],
      schedule: [
        {
          startMinute: 0,
          endMinute: warmup + duration,
          lambdaPerHour: param(lambda, 'vehicles/hour', 'DERIVED', {
            notes:
              `Estimated from ${discovered.interArrival.count} observed inter-arrival gaps with a ` +
              `mean of ${discovered.interArrival.meanMinutes.toFixed(2)} minutes.`,
          }),
          label: 'Observed arrival rate',
        },
      ],
    },
    vehicleModels,
    cost: deepClone(reference.cost),
    simulation: {
      seed: options.seed ?? reference.simulation.seed,
      replications: reference.simulation.replications,
      warmupMinutes: warmup,
      durationMinutes: duration,
      terminationMode: 'drain',
      collectVehicleTraces: true,
      maxTraces: 500,
    },
    investment: deepClone(reference.investment),
    assumptions: [
      'This model was DISCOVERED from an event log. Its activities, ordering, routing ' +
        'probabilities, service-time distributions and arrival rate are estimated from observed ' +
        'data, not configured by hand.',
      'Server counts are estimated as the maximum number of simultaneous executions observed per ' +
        'activity. That is a lower bound on real capacity, and it is editable.',
      'Service distribution families are fitted from the coefficient of variation of the observed ' +
        'durations, not assumed.',
      'Queue discipline is assumed FIFO: the log records when work ran, not how it was selected.',
      `Cost parameters — wages, machine costs, energy, overhead and the bill of materials — are ` +
        `inherited from "${reference.name}". An event log contains no prices.`,
      ...(reference.assumptions ?? []),
    ],
    sources: deepClone(reference.sources ?? []),
  };

  /* ---- solvability guard ---- */

  for (const s of model.stations) {
    const sum = s.routing.reduce((a, e) => a + e.probability, 0);
    if (Math.abs(sum - 1) > 1e-6 && s.routing.length > 0) {
      // Renormalise rather than ship a model the traffic equations will reject.
      for (const e of s.routing) e.probability /= sum;
      notes.push(
        `Routing probabilities out of "${s.name}" summed to ${sum.toFixed(4)} after edge filtering ` +
          'and were renormalised to 1.',
      );
    }
  }

  const reachesFinish = model.stations.some((s) =>
    s.routing.some((e) => e.to === SINK_FINISHED && e.probability > 0),
  );
  if (!reachesFinish) {
    const last = model.stations[model.stations.length - 1] as Station;
    last.routing = [{ to: SINK_FINISHED, probability: 1, label: 'complete (added)' }];
    notes.push(
      'No activity in the log ever ended a case, so the discovered network had no exit. An exit ' +
        `was added at "${last.name}" to make the model solvable.`,
    );
  }

  return { model, notes, activityToStation };
}

const normalise = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/* ------------------------------------------------------------------ */
/* Observed vs analytical comparison                                   */
/* ------------------------------------------------------------------ */

export interface ObservedVsAnalytical {
  activityId: string;
  name: string;
  kendall: string;
  servers: number;
  /** Straight from the log. */
  observed: {
    lambdaPerHour: number;
    muPerHour: number;
    utilization: number;
    waitMeanMinutes: number;
    serviceMeanMinutes: number;
    executions: number;
  };
  /** From the closed-form queueing model built on the discovered parameters. */
  analytical: {
    lambdaPerHour: number;
    rho: number;
    L: number;
    Lq: number;
    WMinutes: number;
    WqMinutes: number;
    stable: boolean;
    exact: boolean;
  };
  /** Difference between observed and analytical waiting time, minutes. */
  waitDifferenceMinutes: number;
}

/**
 * Put the log's own numbers next to what queueing theory predicts for the model
 * discovered from it.
 *
 * These columns answer different questions and are expected to differ. The
 * observed wait is what actually happened in a finite sample of a real process;
 * the analytical wait is the steady-state prediction for an idealised queue
 * with the fitted parameters. A large gap is informative — it usually means the
 * real arrivals were burstier than the fitted process, or that the server-count
 * estimate is too low.
 */
export function compareObservedToAnalytical(
  discovered: DiscoveredProcess,
  stations: {
    stationId: string;
    kendall: string;
    c: number;
    lambda: number;
    rho: number;
    L: number;
    Lq: number;
    WMinutes: number;
    WqMinutes: number;
    stable: boolean;
    exact: boolean;
  }[],
): ObservedVsAnalytical[] {
  const out: ObservedVsAnalytical[] = [];
  for (const a of discovered.activities) {
    const s = stations.find((x) => x.stationId === a.id);
    if (!s) continue;
    out.push({
      activityId: a.id,
      name: a.name,
      kendall: s.kendall,
      servers: s.c,
      observed: {
        lambdaPerHour: a.lambdaObservedPerHour,
        muPerHour: a.muObservedPerHour,
        utilization: a.utilizationObserved,
        waitMeanMinutes: a.observedWaitMeanMinutes,
        serviceMeanMinutes: a.serviceMeanMinutes,
        executions: a.executions,
      },
      analytical: {
        lambdaPerHour: s.lambda,
        rho: s.rho,
        L: s.L,
        Lq: s.Lq,
        WMinutes: s.WMinutes,
        WqMinutes: s.WqMinutes,
        stable: s.stable,
        exact: s.exact,
      },
      waitDifferenceMinutes: s.WqMinutes - a.observedWaitMeanMinutes,
    });
  }
  return out;
}
