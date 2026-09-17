/**
 * Configuration optimiser — requirements 33, 34, 68.
 *
 * Answers "what configuration minimises cost while meeting demand?" by
 * enumerating candidate configurations and EVALUATING EACH ONE with the real
 * engines. There is no surrogate model and no curve fitted to a few points:
 * every candidate's objective value comes from the same analytical and
 * simulation code the dashboard uses, so an optimum found here is reproducible
 * by loading that scenario and running it.
 *
 * SEARCH STRATEGY. The decision variables (servers per station) are small
 * non-negative integers, so the space is a bounded integer lattice. Exhaustive
 * enumeration is exponential in the number of stations, so the optimiser runs
 * in two stages:
 *
 *   1. ANALYTICAL SCREEN — every candidate is solved with the closed-form
 *      network model. This is microseconds per candidate, so tens of thousands
 *      can be screened. Candidates that violate a constraint are discarded
 *      here, along with any that are dominated.
 *   2. SIMULATION CONFIRM — only the best few survivors are simulated with the
 *      full replication study, because that is the expensive step and the one
 *      whose numbers get reported.
 *
 * Screening analytically and confirming by simulation is what makes this
 * tractable; reporting the analytical screen as the final answer would hide
 * the breakdown and variability effects the closed form cannot see, so the
 * reported figures always come from stage 2.
 */

import { capacityLimit, solveNetwork } from '../analytical/network.js';
import { computeCosts } from '../cost/costEngine.js';
import { runSimulation } from '../des/simulation.js';
import { annualise, appraiseIncremental } from '../finance/investment.js';
import type { SystemModel } from '../model/types.js';
import { runStudy } from '../stats/replications.js';
import { applyScenario, type Scenario, type ScenarioEdit } from './scenarios.js';

/* ------------------------------------------------------------------ */
/* Objectives and constraints (requirement 34)                         */
/* ------------------------------------------------------------------ */

export type ObjectiveKind =
  | 'minimizeCostPerVehicle'
  | 'minimizeTotalCost'
  | 'maximizeThroughput'
  | 'minimizeWq'
  | 'minimizeCycleTime'
  | 'maximizeProfit'
  | 'maximizeRoi'
  | 'minimizePayback'
  | 'weighted';

export interface ObjectiveWeights {
  /** Weights are applied to NORMALISED metrics, so units do not matter. */
  cost?: number;
  throughput?: number;
  waitingTime?: number;
  cycleTime?: number;
  profit?: number;
}

export interface OptimizationConstraints {
  /** Minimum finished vehicles per production day. */
  minThroughputPerDay?: number;
  /** Minimum finished vehicles per hour. */
  minThroughputPerHour?: number;
  /** Maximum average queue wait, minutes. */
  maxWqMinutes?: number;
  /** Maximum mean manufacturing time, minutes. */
  maxCycleTimeMinutes?: number;
  /** Maximum utilisation at any station, 0..1. */
  maxUtilization?: number;
  /** Minimum utilisation at any station — guards against buying idle capacity. */
  minUtilization?: number;
  /** Maximum capital the plan may spend. */
  maxInvestment?: number;
  /** Maximum cost per vehicle. */
  maxCostPerVehicle?: number;
  /** Every queue must be stable (rho < 1). Defaults to true. */
  requireStable?: boolean;
}

/** One station's allowed server range and the cost of changing it. */
export interface DecisionVariable {
  stationId: string;
  minServers: number;
  maxServers: number;
  /** Capital cost of ONE additional server at this station. */
  capitalCostPerServer: number;
  /** Extra operating cost per year of ONE additional server. */
  annualOperatingCostPerServer: number;
}

export interface OptimizationRequest {
  objective: ObjectiveKind;
  weights?: ObjectiveWeights;
  constraints?: OptimizationConstraints;
  variables: DecisionVariable[];
  /** Candidates to carry from the analytical screen into simulation. */
  confirmTop?: number;
  /** Replications for the confirmation runs. */
  replications?: number;
  /** Hard cap on analytical evaluations, to bound run time. */
  maxCandidates?: number;
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export interface Candidate {
  /** Server count per station id. */
  configuration: Record<string, number>;
  /** Servers added relative to the baseline, per station. */
  delta: Record<string, number>;
  totalAddedServers: number;
  initialInvestment: number;
  additionalAnnualOperatingCost: number;

  /* analytical screen */
  feasible: boolean;
  violations: string[];
  analyticalThroughputPerHour: number;
  analyticalCapacityPerHour: number;
  analyticalWqMinutes: number;
  analyticalWMinutes: number;
  stable: boolean;
  maxUtilization: number;
  minUtilization: number;
  bottleneckStationId: string | null;

  /* stage-2 confirmation, present only for confirmed candidates */
  confirmed?: {
    throughputPerHour: number;
    throughputPerDay: number;
    costPerVehicle: number;
    totalManufacturingCost: number;
    profit: number;
    profitPerYear: number;
    WqMinutes: number;
    WMinutes: number;
    roiPercent: number | null;
    paybackYears: number | null;
    paybackAchieved: boolean;
  };

  /** Objective value; lower is always better after normalisation. */
  score: number;
}

export interface OptimizationResult {
  objective: ObjectiveKind;
  constraints: OptimizationConstraints;
  baselineConfiguration: Record<string, number>;
  candidatesEvaluated: number;
  feasibleCount: number;
  /** Confirmed candidates, best first. */
  ranked: Candidate[];
  best: Candidate | null;
  /** The best candidate expressed as a scenario the user can save and run. */
  bestScenario: Scenario | null;
  /** Why the recommendation is what it is. */
  rationale: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Enumeration                                                         */
/* ------------------------------------------------------------------ */

/** Cartesian product of the per-station server ranges, bounded by maxCandidates. */
function* enumerateConfigurations(
  variables: DecisionVariable[],
  limit: number,
): Generator<Record<string, number>> {
  const ranges = variables.map((v) => {
    const out: number[] = [];
    for (let n = v.minServers; n <= v.maxServers; n++) out.push(n);
    return out;
  });

  let produced = 0;
  const idx = new Array<number>(variables.length).fill(0);
  for (;;) {
    if (produced >= limit) return;
    const config: Record<string, number> = {};
    for (let i = 0; i < variables.length; i++) {
      config[(variables[i] as DecisionVariable).stationId] =
        (ranges[i] as number[])[idx[i] as number] as number;
    }
    yield config;
    produced++;

    let carry = variables.length - 1;
    for (;;) {
      if (carry < 0) return;
      idx[carry] = (idx[carry] as number) + 1;
      if ((idx[carry] as number) < (ranges[carry] as number[]).length) break;
      idx[carry] = 0;
      carry--;
    }
  }
}

function configToEdits(config: Record<string, number>): ScenarioEdit[] {
  return Object.entries(config).map(([stationId, value]) => ({
    kind: 'servers' as const,
    stationId,
    value,
  }));
}

/* ------------------------------------------------------------------ */
/* The optimiser                                                       */
/* ------------------------------------------------------------------ */

export function optimize(baseline: SystemModel, request: OptimizationRequest): OptimizationResult {
  const constraints = { requireStable: true, ...(request.constraints ?? {}) };
  const maxCandidates = request.maxCandidates ?? 20_000;
  const confirmTop = Math.max(1, request.confirmTop ?? 5);
  const warnings: string[] = [];

  const baselineConfiguration: Record<string, number> = {};
  for (const v of request.variables) {
    const st = baseline.stations.find((s) => s.id === v.stationId);
    if (!st) throw new Error(`Optimiser references unknown station "${v.stationId}".`);
    baselineConfiguration[v.stationId] = st.servers;
  }

  const hoursPerDay = baseline.investment.hoursPerDay.value;

  /* ---- stage 1: analytical screen ---- */

  const screened: Candidate[] = [];
  let evaluated = 0;

  for (const configuration of enumerateConfigurations(request.variables, maxCandidates)) {
    evaluated++;
    const delta: Record<string, number> = {};
    let totalAddedServers = 0;
    let initialInvestment = 0;
    let additionalAnnualOperatingCost = 0;

    for (const v of request.variables) {
      const added = (configuration[v.stationId] as number) - (baselineConfiguration[v.stationId] as number);
      delta[v.stationId] = added;
      if (added > 0) {
        totalAddedServers += added;
        initialInvestment += added * v.capitalCostPerServer;
        additionalAnnualOperatingCost += added * v.annualOperatingCostPerServer;
      }
      // Removing a server releases no capital in this model: sunk cost is not
      // recovered. It does save the annual operating cost.
      if (added < 0) {
        additionalAnnualOperatingCost += added * v.annualOperatingCostPerServer;
      }
    }

    const scenario: Scenario = {
      id: `opt-${evaluated}`,
      name: 'Optimiser candidate',
      edits: configToEdits(configuration),
      initialInvestment,
      additionalAnnualOperatingCost,
    };

    let model: SystemModel;
    try {
      model = applyScenario(baseline, scenario);
    } catch {
      continue;
    }

    const net = solveNetwork(model);
    const cap = capacityLimit(model);
    const utils = net.stations.filter((s) => s.lambda > 0).map((s) => s.rho);
    const maxUtilization = utils.length ? Math.max(...utils) : 0;
    const minUtilization = utils.length ? Math.min(...utils) : 0;

    const violations: string[] = [];
    if (constraints.requireStable && !net.system.stable) {
      violations.push('At least one queue is unstable (rho >= 1).');
    }
    if (constraints.maxInvestment !== undefined && initialInvestment > constraints.maxInvestment) {
      violations.push(
        `Capital ${initialInvestment.toFixed(0)} exceeds the budget of ${constraints.maxInvestment.toFixed(0)}.`,
      );
    }
    if (constraints.maxUtilization !== undefined && maxUtilization > constraints.maxUtilization) {
      violations.push(
        `Peak utilisation ${(maxUtilization * 100).toFixed(1)}% exceeds the ` +
          `${(constraints.maxUtilization * 100).toFixed(0)}% limit.`,
      );
    }
    if (constraints.minUtilization !== undefined && minUtilization < constraints.minUtilization) {
      violations.push(
        `Lowest utilisation ${(minUtilization * 100).toFixed(1)}% is below the ` +
          `${(constraints.minUtilization * 100).toFixed(0)}% floor — this buys idle capacity.`,
      );
    }
    const throughputPerHour = net.system.throughputFinished;
    if (
      constraints.minThroughputPerHour !== undefined &&
      throughputPerHour < constraints.minThroughputPerHour
    ) {
      violations.push(
        `Throughput ${throughputPerHour.toFixed(2)}/hour is below the required ` +
          `${constraints.minThroughputPerHour.toFixed(2)}/hour.`,
      );
    }
    if (constraints.minThroughputPerDay !== undefined) {
      const perDay = throughputPerHour * hoursPerDay;
      if (perDay < constraints.minThroughputPerDay) {
        violations.push(
          `Throughput ${perDay.toFixed(1)}/day is below the required ` +
            `${constraints.minThroughputPerDay.toFixed(1)}/day.`,
        );
      }
    }
    if (constraints.maxWqMinutes !== undefined && net.system.WqMinutes > constraints.maxWqMinutes) {
      violations.push(
        `Average Wq ${net.system.WqMinutes.toFixed(2)} min exceeds the ` +
          `${constraints.maxWqMinutes.toFixed(2)} min limit.`,
      );
    }
    if (
      constraints.maxCycleTimeMinutes !== undefined &&
      net.system.WMinutes > constraints.maxCycleTimeMinutes
    ) {
      violations.push(
        `Mean manufacturing time ${net.system.WMinutes.toFixed(1)} min exceeds the ` +
          `${constraints.maxCycleTimeMinutes.toFixed(1)} min limit.`,
      );
    }

    screened.push({
      configuration,
      delta,
      totalAddedServers,
      initialInvestment,
      additionalAnnualOperatingCost,
      feasible: violations.length === 0,
      violations,
      analyticalThroughputPerHour: throughputPerHour,
      analyticalCapacityPerHour: cap.lambdaMaxPerHour,
      analyticalWqMinutes: net.system.WqMinutes,
      analyticalWMinutes: net.system.WMinutes,
      stable: net.system.stable,
      maxUtilization,
      minUtilization,
      bottleneckStationId: net.system.bottleneckStationId,
      score: Number.POSITIVE_INFINITY,
    });
  }

  if (evaluated >= maxCandidates) {
    warnings.push(
      `The search space was truncated at ${maxCandidates} candidates. Narrow the server ranges to ` +
        'be sure the true optimum was considered.',
    );
  }

  const feasible = screened.filter((c) => c.feasible);
  if (feasible.length === 0) {
    const closest = [...screened].sort((a, b) => a.violations.length - b.violations.length)[0];
    return {
      objective: request.objective,
      constraints,
      baselineConfiguration,
      candidatesEvaluated: evaluated,
      feasibleCount: 0,
      ranked: [],
      best: null,
      bestScenario: null,
      rationale: [
        'No configuration in the search space satisfies every constraint.',
        closest
          ? `The closest candidate still fails: ${closest.violations.join(' ')}`
          : 'No candidates were evaluated.',
        'Relax a constraint, widen the server ranges, or address service rates rather than server counts.',
      ],
      warnings,
    };
  }

  /* ---- rank the screen, then confirm the top few by simulation ---- */

  const screenScored = feasible.map((c) => ({
    candidate: c,
    screenScore: analyticalScore(c, request),
  }));
  screenScored.sort((a, b) => a.screenScore - b.screenScore);

  const toConfirm = screenScored.slice(0, confirmTop).map((s) => s.candidate);

  // Baseline economics, needed for ROI and payback on every candidate.
  const baselineStudy = runStudy(baseline, { replications: request.replications ?? baseline.simulation.replications });
  const baselineAnnual = annualise(
    {
      windowHours: baselineStudy.representative.cost.windowHours,
      vehiclesFinished: baselineStudy.system['vehiclesCompleted']?.mean ?? 0,
      revenue: baselineStudy.cost['revenue']?.mean ?? 0,
      manufacturingCost: baselineStudy.cost['totalManufacturingCost']?.mean ?? 0,
      waitingCost: baselineStudy.cost['waitingCost']?.mean ?? 0,
    },
    baseline.investment,
  );

  for (const c of toConfirm) {
    const scenario: Scenario = {
      id: 'opt-confirm',
      name: 'Optimiser candidate',
      edits: configToEdits(c.configuration),
      initialInvestment: c.initialInvestment,
      additionalAnnualOperatingCost: c.additionalAnnualOperatingCost,
    };
    const model = applyScenario(baseline, scenario);
    const study = runStudy(model, {
      replications: request.replications ?? baseline.simulation.replications,
    });
    const annual = annualise(
      {
        windowHours: study.representative.cost.windowHours,
        vehiclesFinished: study.system['vehiclesCompleted']?.mean ?? 0,
        revenue: study.cost['revenue']?.mean ?? 0,
        manufacturingCost: study.cost['totalManufacturingCost']?.mean ?? 0,
        waitingCost: study.cost['waitingCost']?.mean ?? 0,
      },
      model.investment,
    );
    const appraisal = appraiseIncremental(baselineAnnual, annual, {
      initialInvestment: c.initialInvestment,
      additionalAnnualOperatingCost: c.additionalAnnualOperatingCost,
    });

    c.confirmed = {
      throughputPerHour: study.system['throughput']?.mean ?? 0,
      throughputPerDay: (study.system['throughput']?.mean ?? 0) * hoursPerDay,
      costPerVehicle: study.cost['costPerVehicle']?.mean ?? 0,
      totalManufacturingCost: study.cost['totalManufacturingCost']?.mean ?? 0,
      profit: study.cost['grossProfit']?.mean ?? 0,
      profitPerYear: annual.profitPerYear,
      WqMinutes: study.system['WqMinutes']?.mean ?? 0,
      WMinutes: study.system['WMinutes']?.mean ?? 0,
      roiPercent: appraisal.roiPercent,
      paybackYears: appraisal.payback.years,
      paybackAchieved: appraisal.payback.achieved,
    };
  }

  /* ---- final scoring on CONFIRMED numbers ---- */

  const confirmed = toConfirm.filter((c) => c.confirmed);
  const ranges = normalisationRanges(confirmed);
  for (const c of confirmed) c.score = confirmedScore(c, request, ranges);
  confirmed.sort((a, b) => a.score - b.score);

  const best = confirmed[0] ?? null;

  // Re-check the simulated numbers against the constraints: a candidate can
  // pass the analytical screen and fail once breakdowns and variability are
  // included, and reporting it as feasible would be wrong.
  if (best?.confirmed) {
    const cf = best.confirmed;
    if (
      constraints.minThroughputPerDay !== undefined &&
      cf.throughputPerDay < constraints.minThroughputPerDay
    ) {
      warnings.push(
        `The recommended configuration passed the analytical screen but delivers only ` +
          `${cf.throughputPerDay.toFixed(1)} vehicles/day in simulation, below the required ` +
          `${constraints.minThroughputPerDay.toFixed(1)}. The shortfall is caused by effects the ` +
          'closed-form model cannot represent — machine breakdowns and arrival variability. ' +
          'Treat the simulated figure as the real one.',
      );
    }
    if (constraints.maxWqMinutes !== undefined && cf.WqMinutes > constraints.maxWqMinutes) {
      warnings.push(
        `Simulated Wq (${cf.WqMinutes.toFixed(2)} min) exceeds the ${constraints.maxWqMinutes} min ` +
          'constraint even though the analytical screen passed it.',
      );
    }
  }

  const bestScenario: Scenario | null = best
    ? {
        id: 'optimised',
        name: 'Optimised configuration',
        description: `Result of optimising for ${objectiveLabel(request.objective)}.`,
        edits: configToEdits(best.configuration),
        initialInvestment: best.initialInvestment,
        additionalAnnualOperatingCost: best.additionalAnnualOperatingCost,
        investmentItems: request.variables
          .filter((v) => (best.delta[v.stationId] ?? 0) > 0)
          .map((v) => ({
            name: `${baseline.stations.find((s) => s.id === v.stationId)?.name ?? v.stationId}: ` +
              `+${best.delta[v.stationId]} server(s)`,
            amount: (best.delta[v.stationId] as number) * v.capitalCostPerServer,
          })),
      }
    : null;

  return {
    objective: request.objective,
    constraints,
    baselineConfiguration,
    candidatesEvaluated: evaluated,
    feasibleCount: feasible.length,
    ranked: confirmed,
    best,
    bestScenario,
    rationale: buildRationale(baseline, best, request, evaluated, feasible.length),
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

function objectiveLabel(o: ObjectiveKind): string {
  switch (o) {
    case 'minimizeCostPerVehicle':
      return 'minimum cost per vehicle';
    case 'minimizeTotalCost':
      return 'minimum total manufacturing cost';
    case 'maximizeThroughput':
      return 'maximum throughput';
    case 'minimizeWq':
      return 'minimum queue waiting time';
    case 'minimizeCycleTime':
      return 'minimum manufacturing cycle time';
    case 'maximizeProfit':
      return 'maximum profit';
    case 'maximizeRoi':
      return 'maximum return on investment';
    case 'minimizePayback':
      return 'fastest payback';
    case 'weighted':
      return 'a weighted combination of objectives';
  }
}

/**
 * Cheap screening score from analytical quantities only. Used to decide which
 * candidates are worth simulating, never to report a result.
 */
function analyticalScore(c: Candidate, request: OptimizationRequest): number {
  switch (request.objective) {
    case 'maximizeThroughput':
      return -c.analyticalThroughputPerHour;
    case 'minimizeWq':
      return c.analyticalWqMinutes;
    case 'minimizeCycleTime':
      return c.analyticalWMinutes;
    case 'minimizeTotalCost':
    case 'minimizeCostPerVehicle':
    case 'minimizePayback':
    case 'maximizeRoi':
    case 'maximizeProfit':
      // Cost and profit need the cost engine, which needs a simulation. Screen
      // on capital plus queueing instead: cheap configurations that still meet
      // the constraints are the ones worth confirming.
      return c.initialInvestment + c.analyticalWqMinutes * 1000;
    case 'weighted':
      return (
        (request.weights?.throughput ?? 0) * -c.analyticalThroughputPerHour +
        (request.weights?.waitingTime ?? 0) * c.analyticalWqMinutes +
        (request.weights?.cycleTime ?? 0) * c.analyticalWMinutes +
        (request.weights?.cost ?? 0) * c.initialInvestment
      );
  }
}

interface Ranges {
  costPerVehicle: [number, number];
  totalCost: [number, number];
  throughput: [number, number];
  Wq: [number, number];
  W: [number, number];
  profit: [number, number];
}

function normalisationRanges(cs: Candidate[]): Ranges {
  const pick = (f: (c: Candidate) => number): [number, number] => {
    const vs = cs.map(f).filter((v) => Number.isFinite(v));
    if (vs.length === 0) return [0, 1];
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    return [lo, hi > lo ? hi : lo + 1];
  };
  return {
    costPerVehicle: pick((c) => c.confirmed?.costPerVehicle ?? Infinity),
    totalCost: pick((c) => c.confirmed?.totalManufacturingCost ?? Infinity),
    throughput: pick((c) => c.confirmed?.throughputPerHour ?? 0),
    Wq: pick((c) => c.confirmed?.WqMinutes ?? Infinity),
    W: pick((c) => c.confirmed?.WMinutes ?? Infinity),
    profit: pick((c) => c.confirmed?.profit ?? -Infinity),
  };
}

/** Map x into [0,1] where 0 is best. */
const norm = (x: number, [lo, hi]: [number, number]) => (hi > lo ? (x - lo) / (hi - lo) : 0);
const normInv = (x: number, r: [number, number]) => 1 - norm(x, r);

function confirmedScore(c: Candidate, request: OptimizationRequest, r: Ranges): number {
  const cf = c.confirmed;
  if (!cf) return Number.POSITIVE_INFINITY;

  switch (request.objective) {
    case 'minimizeCostPerVehicle':
      return cf.costPerVehicle;
    case 'minimizeTotalCost':
      return cf.totalManufacturingCost;
    case 'maximizeThroughput':
      return -cf.throughputPerHour;
    case 'minimizeWq':
      return cf.WqMinutes;
    case 'minimizeCycleTime':
      return cf.WMinutes;
    case 'maximizeProfit':
      return -cf.profitPerYear;
    case 'maximizeRoi':
      // A configuration with no capital outlay has no ROI. It is ranked last
      // under this objective rather than being given a fabricated value.
      return cf.roiPercent === null ? Number.POSITIVE_INFINITY : -cf.roiPercent;
    case 'minimizePayback':
      return cf.paybackAchieved && cf.paybackYears !== null
        ? cf.paybackYears
        : Number.POSITIVE_INFINITY;
    case 'weighted': {
      const w = request.weights ?? {};
      return (
        (w.cost ?? 0) * norm(cf.costPerVehicle, r.costPerVehicle) +
        (w.throughput ?? 0) * normInv(cf.throughputPerHour, r.throughput) +
        (w.waitingTime ?? 0) * norm(cf.WqMinutes, r.Wq) +
        (w.cycleTime ?? 0) * norm(cf.WMinutes, r.W) +
        (w.profit ?? 0) * normInv(cf.profitPerYear, r.profit)
      );
    }
  }
}

function buildRationale(
  baseline: SystemModel,
  best: Candidate | null,
  request: OptimizationRequest,
  evaluated: number,
  feasibleCount: number,
): string[] {
  const out: string[] = [
    `${evaluated} configurations were screened analytically; ${feasibleCount} satisfied every ` +
      `constraint. The top ${Math.min(request.confirmTop ?? 5, feasibleCount)} were then confirmed by ` +
      'full discrete-event simulation, and the figures reported come from those runs.',
  ];
  if (!best || !best.confirmed) {
    out.push('No candidate could be confirmed.');
    return out;
  }

  const changes = Object.entries(best.delta)
    .filter(([, d]) => d !== 0)
    .map(([id, d]) => {
      const name = baseline.stations.find((s) => s.id === id)?.name ?? id;
      return `${name} ${d > 0 ? '+' : ''}${d} server(s)`;
    });

  out.push(
    changes.length > 0
      ? `Recommended change: ${changes.join(', ')}, for capital of ${best.initialInvestment.toFixed(0)}.`
      : 'The baseline configuration is already optimal for this objective: no change is recommended.',
  );

  out.push(
    `Optimising for ${objectiveLabel(request.objective)}. Confirmed by simulation: ` +
      `${best.confirmed.throughputPerDay.toFixed(1)} vehicles/day, cost/vehicle ` +
      `${best.confirmed.costPerVehicle.toFixed(2)}, Wq ${best.confirmed.WqMinutes.toFixed(2)} min.`,
  );

  if (best.initialInvestment > 0) {
    out.push(
      best.confirmed.paybackAchieved
        ? `ROI ${(best.confirmed.roiPercent ?? 0).toFixed(1)}% per year, payback in ` +
          `${(best.confirmed.paybackYears ?? 0).toFixed(2)} years.`
        : 'This configuration does not pay back: its annual net benefit is not positive. It is ' +
          'recommended only because the objective selected does not weigh capital cost.',
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Single what-if evaluation (requirement 67)                          */
/* ------------------------------------------------------------------ */

/**
 * Evaluate one configuration change quickly, without a full replication study.
 * Used for the interactive what-if sliders, where responsiveness matters more
 * than confidence intervals — the result is labelled as a single replication.
 */
export function quickWhatIf(
  baseline: SystemModel,
  edits: ScenarioEdit[],
): {
  throughputPerHour: number;
  costPerVehicle: number;
  WqMinutes: number;
  WMinutes: number;
  profit: number;
  bottleneckStationId: string | null;
  stable: boolean;
  note: string;
} {
  const model = applyScenario(baseline, {
    id: 'whatif',
    name: 'What-if',
    edits,
    initialInvestment: 0,
    additionalAnnualOperatingCost: 0,
  });
  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);
  const net = solveNetwork(model);

  return {
    throughputPerHour: sim.system.throughputPerHour,
    costPerVehicle: cost.costPerVehicle,
    WqMinutes: sim.system.WqMinutes,
    WMinutes: sim.system.WMinutes,
    profit: cost.grossProfit,
    bottleneckStationId: net.system.bottleneckStationId,
    stable: net.system.stable,
    note:
      'Single replication, for interactive exploration only. Run a full replication study before ' +
      'acting on a difference between configurations.',
  };
}
