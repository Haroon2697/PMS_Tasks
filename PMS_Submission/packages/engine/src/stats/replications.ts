/**
 * Replication statistics and confidence intervals — requirement 44.
 *
 * A single simulation run is one sample path. Reporting its numbers as "the
 * answer" would present sampling noise as fact, which requirement 60 forbids.
 * The engine therefore runs independent replications — each with its own
 * derived seed — and reports mean, standard deviation and a confidence
 * interval for every metric.
 *
 * The interval uses Student's t, not the normal, because the number of
 * replications is small (typically 10-30). With n = 10 the t multiplier is
 * 2.262 against the normal's 1.96, so using the normal would understate the
 * interval by about 15%.
 *
 * Replications are independent by construction: each gets a distinct master
 * seed derived from the base seed, so the usual i.i.d. assumption behind the
 * t-interval genuinely holds. (This is the "independent replications" method;
 * it does NOT apply to batch means taken from one run, where the batches are
 * correlated.)
 */

import { computeCosts, type CostResult } from '../cost/costEngine.js';
import { runSimulation, type SimulationResult } from '../des/simulation.js';
import type { SystemModel } from '../model/types.js';
import { RngStreams } from '../rng.js';

/* ------------------------------------------------------------------ */
/* Student's t critical values                                         */
/* ------------------------------------------------------------------ */

/** Two-sided 95% t critical values for df = 1..30. */
const T95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
  15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042,
};

/** Two-sided 99% t critical values for df = 1..30. */
const T99: Record<number, number> = {
  1: 63.657, 2: 9.925, 3: 5.841, 4: 4.604, 5: 4.032, 6: 3.707, 7: 3.499,
  8: 3.355, 9: 3.25, 10: 3.169, 11: 3.106, 12: 3.055, 13: 3.012, 14: 2.977,
  15: 2.947, 16: 2.921, 17: 2.898, 18: 2.878, 19: 2.861, 20: 2.845, 21: 2.831,
  22: 2.819, 23: 2.807, 24: 2.797, 25: 2.787, 26: 2.779, 27: 2.771, 28: 2.763,
  29: 2.756, 30: 2.75,
};

/**
 * Two-sided t critical value. Beyond df = 30 the t distribution is close
 * enough to the normal that the normal quantile is used, with a small
 * Cornish-Fisher style correction that keeps the transition smooth.
 */
export function tCritical(df: number, confidence: 0.95 | 0.99 = 0.95): number {
  if (df < 1) return NaN;
  const table = confidence === 0.99 ? T99 : T95;
  const exact = table[Math.floor(df)];
  if (exact !== undefined) return exact;
  const z = confidence === 0.99 ? 2.5758293035489004 : 1.959963984540054;
  return z * (1 + (z * z + 1) / (4 * df));
}

/* ------------------------------------------------------------------ */
/* Summary of one metric across replications                           */
/* ------------------------------------------------------------------ */

export interface MetricSummary {
  key: string;
  label: string;
  unit: string;
  /** One observation per replication. */
  values: number[];
  n: number;
  mean: number;
  /** Sample standard deviation (n-1 denominator). */
  stdDev: number;
  /** stdDev / sqrt(n). */
  stdError: number;
  confidence: number;
  /** t * stdError. */
  halfWidth: number;
  ciLow: number;
  ciHigh: number;
  /** halfWidth / |mean| — how precise the estimate is, as a fraction. */
  relativeHalfWidth: number;
  min: number;
  max: number;
}

export function summariseMetric(
  key: string,
  label: string,
  unit: string,
  values: number[],
  confidence: 0.95 | 0.99 = 0.95,
): MetricSummary {
  const n = values.length;
  const clean = values.filter((v) => Number.isFinite(v));
  const mean = clean.length > 0 ? clean.reduce((a, b) => a + b, 0) / clean.length : 0;
  const variance =
    clean.length > 1
      ? clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const stdError = clean.length > 0 ? stdDev / Math.sqrt(clean.length) : 0;
  // A single replication gives a point estimate and no interval — reporting a
  // zero-width interval would falsely imply perfect precision.
  const halfWidth = clean.length > 1 ? tCritical(clean.length - 1, confidence) * stdError : NaN;

  return {
    key,
    label,
    unit,
    values,
    n,
    mean,
    stdDev,
    stdError,
    confidence,
    halfWidth,
    ciLow: Number.isFinite(halfWidth) ? mean - halfWidth : NaN,
    ciHigh: Number.isFinite(halfWidth) ? mean + halfWidth : NaN,
    relativeHalfWidth:
      Number.isFinite(halfWidth) && Math.abs(mean) > 1e-12 ? halfWidth / Math.abs(mean) : NaN,
    min: clean.length > 0 ? Math.min(...clean) : 0,
    max: clean.length > 0 ? Math.max(...clean) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Running a study                                                     */
/* ------------------------------------------------------------------ */

export interface StationMetrics {
  stationId: string;
  stationName: string;
  metrics: Record<string, MetricSummary>;
}

export interface StudyResult {
  modelId: string;
  modelName: string;
  baseSeed: number;
  replications: number;
  seeds: number[];
  warmupMinutes: number;
  durationMinutes: number;
  /** System-level metrics across replications. */
  system: Record<string, MetricSummary>;
  /** Per-station metrics across replications. */
  stations: StationMetrics[];
  /** Cost metrics across replications. */
  cost: Record<string, MetricSummary>;
  /**
   * The first replication in full, kept so the UI can show vehicle traces and
   * an individual run's detail. Its numbers are ONE sample path and are
   * labelled as such wherever they appear alongside the study means.
   */
  representative: { simulation: SimulationResult; cost: CostResult };
  warnings: string[];
}

const SYSTEM_METRICS: {
  key: string;
  label: string;
  unit: string;
  pick: (r: SimulationResult) => number;
}[] = [
  { key: 'throughput', label: 'Throughput', unit: 'vehicles/hour', pick: (r) => r.system.throughputPerHour },
  { key: 'vehiclesCompleted', label: 'Vehicles completed', unit: 'vehicles', pick: (r) => r.system.vehiclesCompleted },
  { key: 'vehiclesEntered', label: 'Vehicles entered', unit: 'vehicles', pick: (r) => r.system.vehiclesEntered },
  { key: 'vehiclesScrapped', label: 'Vehicles scrapped', unit: 'vehicles', pick: (r) => r.system.vehiclesScrapped },
  { key: 'vehiclesReworked', label: 'Vehicles reworked', unit: 'vehicles', pick: (r) => r.system.vehiclesReworked },
  { key: 'L', label: 'Average WIP (L)', unit: 'vehicles', pick: (r) => r.system.L },
  { key: 'Lq', label: 'Average waiting (Lq)', unit: 'vehicles', pick: (r) => r.system.Lq },
  { key: 'WMinutes', label: 'Average manufacturing time (W)', unit: 'minutes', pick: (r) => r.system.WMinutes },
  { key: 'WqMinutes', label: 'Average waiting time (Wq)', unit: 'minutes', pick: (r) => r.system.WqMinutes },
  { key: 'cycleMedian', label: 'Median manufacturing time', unit: 'minutes', pick: (r) => r.system.cycleTime.medianMinutes },
  { key: 'cycleP95', label: '95th percentile manufacturing time', unit: 'minutes', pick: (r) => r.system.cycleTime.p95Minutes },
  { key: 'cycleMax', label: 'Maximum manufacturing time', unit: 'minutes', pick: (r) => r.system.cycleTime.maxMinutes },
  { key: 'maxWIP', label: 'Peak WIP', unit: 'vehicles', pick: (r) => r.system.maxWIP },
  { key: 'factoryUtilization', label: 'Factory utilisation', unit: 'fraction', pick: (r) => r.system.factoryUtilization },
];

const STATION_METRICS: {
  key: string;
  label: string;
  unit: string;
  pick: (s: SimulationResult['stations'][number]) => number;
}[] = [
  { key: 'utilization', label: 'Utilisation', unit: 'fraction', pick: (s) => s.utilization },
  { key: 'L', label: 'L', unit: 'vehicles', pick: (s) => s.L },
  { key: 'Lq', label: 'Lq', unit: 'vehicles', pick: (s) => s.Lq },
  { key: 'WMinutes', label: 'W', unit: 'minutes', pick: (s) => s.WMinutes },
  { key: 'WqMinutes', label: 'Wq', unit: 'minutes', pick: (s) => s.WqMinutes },
  { key: 'lambdaObserved', label: 'Arrival rate', unit: 'vehicles/hour', pick: (s) => s.lambdaObserved },
  { key: 'throughput', label: 'Throughput', unit: 'vehicles/hour', pick: (s) => s.throughput },
  { key: 'maxQueueLength', label: 'Peak queue', unit: 'vehicles', pick: (s) => s.maxQueueLength },
  { key: 'breakdowns', label: 'Breakdowns', unit: 'events', pick: (s) => s.breakdowns },
  { key: 'downtimeFraction', label: 'Downtime', unit: 'fraction', pick: (s) => s.downtimeFraction },
];

const COST_METRICS: {
  key: string;
  label: string;
  unit: string;
  pick: (c: CostResult) => number;
}[] = [
  { key: 'totalManufacturingCost', label: 'Total manufacturing cost', unit: 'currency', pick: (c) => c.totalManufacturingCost },
  { key: 'costPerVehicle', label: 'Cost per vehicle', unit: 'currency/vehicle', pick: (c) => c.costPerVehicle },
  { key: 'revenue', label: 'Revenue', unit: 'currency', pick: (c) => c.revenue },
  { key: 'grossProfit', label: 'Profit', unit: 'currency', pick: (c) => c.grossProfit },
  { key: 'profitPerVehicle', label: 'Profit per vehicle', unit: 'currency/vehicle', pick: (c) => c.profitPerVehicle },
  { key: 'marginPercent', label: 'Margin', unit: '%', pick: (c) => c.marginPercent },
  { key: 'waitingCost', label: 'Waiting cost', unit: 'currency', pick: (c) => c.waitingCost },
  { key: 'wipHoldingCost', label: 'WIP holding cost', unit: 'currency', pick: (c) => c.wipHoldingCost },
  { key: 'energyKwh', label: 'Energy consumed', unit: 'kWh', pick: (c) => c.energy.totalKwh },
  { key: 'reworkCost', label: 'Rework cost', unit: 'currency', pick: (c) => c.reworkAnalysis.totalCost },
  { key: 'scrapValueLost', label: 'Value lost to scrap', unit: 'currency', pick: (c) => c.scrapAnalysis.totalValueLost },
];

export interface StudyOptions {
  confidence?: 0.95 | 0.99;
  /** Override the model's replication count. */
  replications?: number;
  /** Called after each replication, for progress reporting. */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Run a full replication study and summarise it.
 *
 * Replication 0 uses the model's seed directly so a single-replication study
 * reproduces exactly what the interactive live run shows; replications 1..n-1
 * use derived seeds.
 */
export function runStudy(model: SystemModel, options: StudyOptions = {}): StudyResult {
  const confidence = options.confidence ?? 0.95;
  const replications = Math.max(1, options.replications ?? model.simulation.replications);

  const runs: SimulationResult[] = [];
  const costs: CostResult[] = [];
  const seeds: number[] = [];

  for (let i = 0; i < replications; i++) {
    const seed =
      i === 0 ? model.simulation.seed : RngStreams.replicationSeed(model.simulation.seed, i);
    seeds.push(seed);
    const sim = runSimulation(model, { replication: i, seed });
    runs.push(sim);
    costs.push(computeCosts(model, sim));
    options.onProgress?.(i + 1, replications);
  }

  const system: Record<string, MetricSummary> = {};
  for (const m of SYSTEM_METRICS) {
    system[m.key] = summariseMetric(m.key, m.label, m.unit, runs.map(m.pick), confidence);
  }

  const cost: Record<string, MetricSummary> = {};
  for (const m of COST_METRICS) {
    cost[m.key] = summariseMetric(m.key, m.label, m.unit, costs.map(m.pick), confidence);
  }

  const stations: StationMetrics[] = model.stations.map((def) => {
    const metrics: Record<string, MetricSummary> = {};
    for (const m of STATION_METRICS) {
      const values = runs.map((r) => {
        const s = r.stations.find((x) => x.stationId === def.id);
        return s ? m.pick(s) : 0;
      });
      metrics[m.key] = summariseMetric(m.key, m.label, m.unit, values, confidence);
    }
    return { stationId: def.id, stationName: def.name, metrics };
  });

  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    for (const w of r.warnings) {
      if (!seen.has(w)) {
        seen.add(w);
        warnings.push(w);
      }
    }
  }
  for (const w of costs[0]?.warnings ?? []) if (!seen.has(w)) warnings.push(w);

  if (replications === 1) {
    warnings.push(
      'Only one replication was run, so no confidence interval can be computed. The figures are ' +
        'a single sample path, not an estimate with known precision. Increase the replication ' +
        'count before drawing conclusions from small differences.',
    );
  } else {
    const tp = system['throughput'];
    if (tp && Number.isFinite(tp.relativeHalfWidth) && tp.relativeHalfWidth > 0.05) {
      warnings.push(
        `The 95% confidence interval on throughput is +/-${(tp.relativeHalfWidth * 100).toFixed(1)}% ` +
          'of the mean. Differences between scenarios smaller than this are not statistically ' +
          'distinguishable — increase replications or run length before acting on them.',
      );
    }
  }

  return {
    modelId: model.id,
    modelName: model.name,
    baseSeed: model.simulation.seed,
    replications,
    seeds,
    warmupMinutes: model.simulation.warmupMinutes,
    durationMinutes: model.simulation.durationMinutes,
    system,
    stations,
    cost,
    representative: { simulation: runs[0] as SimulationResult, cost: costs[0] as CostResult },
    warnings,
  };
}

/**
 * Replications needed to reach a target relative precision, extrapolated from
 * a pilot study:  n_required = n_pilot * (current half-width / target)^2
 *
 * The square comes from half-width scaling as 1/sqrt(n): halving the interval
 * costs four times the runs.
 */
export function replicationsForPrecision(
  pilot: MetricSummary,
  targetRelativeHalfWidth: number,
): number | null {
  if (!Number.isFinite(pilot.relativeHalfWidth) || targetRelativeHalfWidth <= 0) return null;
  if (pilot.relativeHalfWidth <= targetRelativeHalfWidth) return pilot.n;
  return Math.ceil(pilot.n * (pilot.relativeHalfWidth / targetRelativeHalfWidth) ** 2);
}

/**
 * Welch's t-test for the difference between two scenarios' metrics.
 *
 * Requirement 35 compares scenarios; without a significance test a user can
 * easily read a difference that is pure sampling noise as a real improvement.
 * Welch's version is used rather than Student's because the two scenarios
 * generally have different variances.
 */
export function compareMetrics(
  a: MetricSummary,
  b: MetricSummary,
  confidence: 0.95 | 0.99 = 0.95,
): {
  difference: number;
  percentChange: number;
  halfWidth: number;
  ciLow: number;
  ciHigh: number;
  significant: boolean;
  note: string;
} {
  const difference = b.mean - a.mean;
  const va = a.stdDev ** 2 / Math.max(1, a.n);
  const vb = b.stdDev ** 2 / Math.max(1, b.n);
  const se = Math.sqrt(va + vb);

  // Welch-Satterthwaite degrees of freedom.
  const df =
    se > 0
      ? (va + vb) ** 2 /
        (va ** 2 / Math.max(1, a.n - 1) + vb ** 2 / Math.max(1, b.n - 1))
      : 1;
  const halfWidth = se > 0 ? tCritical(Math.max(1, df), confidence) * se : 0;
  const significant = se > 0 ? Math.abs(difference) > halfWidth : false;

  return {
    difference,
    percentChange: Math.abs(a.mean) > 1e-12 ? (difference / Math.abs(a.mean)) * 100 : 0,
    halfWidth,
    ciLow: difference - halfWidth,
    ciHigh: difference + halfWidth,
    significant,
    note: significant
      ? `The difference is statistically significant at the ${(confidence * 100).toFixed(0)}% level.`
      : `The difference is NOT statistically significant at the ${(confidence * 100).toFixed(0)}% level: ` +
        'the confidence interval for the change includes zero, so this may be sampling noise rather ' +
        'than a real effect.',
  };
}
