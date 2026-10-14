/**
 * Scenarios and what-if analysis — requirements 33, 35, 67, 68.
 *
 * A scenario is a NAMED SET OF EDITS to a baseline model, not a copy of it.
 * Storing edits rather than whole models matters: when the baseline's
 * electricity price changes, every scenario inherits it automatically, so a
 * comparison never silently contrasts two models that differ in ways nobody
 * intended. Requirement 35's whole purpose is comparing like with like.
 *
 * Every scenario is evaluated by actually re-running the simulation and the
 * cost engine — never by scaling the baseline's numbers.
 */

import { computeCosts } from '../cost/costEngine.js';
import { analyseBottlenecks } from '../analytical/bottleneck.js';
import { capacityLimit, solveNetwork } from '../analytical/network.js';
import {
  annualise,
  appraiseIncremental,
  type AnnualEconomics,
  type IncrementalAppraisal,
} from '../finance/investment.js';
import type { SystemModel } from '../model/types.js';
import { compareMetrics, runStudy, type StudyResult } from '../stats/replications.js';
import { deepClone } from '../util/clone.js';

/* ------------------------------------------------------------------ */
/* Scenario definition                                                 */
/* ------------------------------------------------------------------ */

/** A single edit applied to the baseline model. */
export type ScenarioEdit =
  /** Change a station's server count (add a paint booth, an inspector, ...). */
  | { kind: 'servers'; stationId: string; value: number }
  /** Change a station's mean service time, minutes (a faster machine). */
  | { kind: 'serviceMean'; stationId: string; value: number }
  /** Change a station's service rate mu, vehicles/hour/server. */
  | { kind: 'serviceRate'; stationId: string; value: number }
  /** Change headcount for one crew. */
  | { kind: 'workerCount'; stationId: string; crewId: string; value: number }
  /** Change a crew's hourly wage. */
  | { kind: 'wage'; stationId: string; crewId: string; value: number }
  /** Change the probability on a routing arc (e.g. inspection failure rate). */
  | { kind: 'routingProbability'; stationId: string; to: string; value: number }
  /** Change a station's scrap probability. */
  | { kind: 'scrapProbability'; stationId: string; value: number }
  /** Scale every demand block by a factor (demand +20%). */
  | { kind: 'demandScale'; value: number }
  /** Set a flat external arrival rate, replacing the schedule. */
  | { kind: 'demandFlat'; value: number }
  /** Change the selling price of a vehicle model. */
  | { kind: 'sellingPrice'; modelId: string; value: number }
  /** Change a BOM component's unit cost. */
  | { kind: 'materialCost'; modelId: string; componentId: string; value: number }
  /** Change the electricity price. */
  | { kind: 'electricityPrice'; value: number }
  /** Enable or disable machine reliability at a station. */
  | { kind: 'reliability'; stationId: string; enabled: boolean }
  /** Change MTBF at a station, operating hours. */
  | { kind: 'mtbf'; stationId: string; value: number }
  /** Change MTTR at a station, hours. */
  | { kind: 'mttr'; stationId: string; value: number }
  /** Change a station's machine power draw, kW. */
  | { kind: 'machinePower'; stationId: string; value: number }
  /** Change the fixed overhead rate. */
  | { kind: 'overheadRate'; value: number }
  /**
   * Change production hours per day. This is a calendar decision rather than a
   * station parameter: it does not alter any queue, but it changes how the
   * measured window annualises, and therefore revenue, cost per year, ROI and
   * payback (Task 6 lists operating hours as a decision the user can vary).
   */
  | { kind: 'operatingHours'; value: number }
  /** Change operating days per year. */
  | { kind: 'operatingDays'; value: number };

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  edits: ScenarioEdit[];
  /** Capital cost of this configuration relative to the baseline. */
  initialInvestment: number;
  /** Extra operating cost per year this configuration adds. */
  additionalAnnualOperatingCost: number;
  /** Itemised capital, for the financial report. */
  investmentItems?: { name: string; amount: number }[];
}

/** Human-readable description of an edit, for the scenario diff view. */
export function describeEdit(edit: ScenarioEdit, model: SystemModel): string {
  const stationName = (id: string) => model.stations.find((s) => s.id === id)?.name ?? id;
  switch (edit.kind) {
    case 'servers':
      return `${stationName(edit.stationId)}: servers -> ${edit.value}`;
    case 'serviceMean':
      return `${stationName(edit.stationId)}: mean service time -> ${edit.value} min`;
    case 'serviceRate':
      return `${stationName(edit.stationId)}: mu -> ${edit.value} vehicles/hour/server`;
    case 'workerCount':
      return `${stationName(edit.stationId)} / ${edit.crewId}: headcount -> ${edit.value}`;
    case 'wage':
      return `${stationName(edit.stationId)} / ${edit.crewId}: wage -> ${edit.value}/hour`;
    case 'routingProbability':
      return `${stationName(edit.stationId)} -> ${edit.to}: probability -> ${edit.value}`;
    case 'scrapProbability':
      return `${stationName(edit.stationId)}: scrap probability -> ${edit.value}`;
    case 'demandScale':
      return `Demand scaled by ${edit.value}x`;
    case 'demandFlat':
      return `Demand set to a flat ${edit.value} vehicles/hour`;
    case 'sellingPrice':
      return `${edit.modelId}: selling price -> ${edit.value}`;
    case 'materialCost':
      return `${edit.modelId} / ${edit.componentId}: unit cost -> ${edit.value}`;
    case 'electricityPrice':
      return `Electricity price -> ${edit.value}/kWh`;
    case 'reliability':
      return `${stationName(edit.stationId)}: machine reliability ${edit.enabled ? 'enabled' : 'disabled'}`;
    case 'mtbf':
      return `${stationName(edit.stationId)}: MTBF -> ${edit.value} operating hours`;
    case 'mttr':
      return `${stationName(edit.stationId)}: MTTR -> ${edit.value} hours`;
    case 'machinePower':
      return `${stationName(edit.stationId)}: machine power -> ${edit.value} kW`;
    case 'overheadRate':
      return `Overhead rate -> ${edit.value}/hour`;
    case 'operatingHours':
      return `Production hours per day -> ${edit.value}`;
    case 'operatingDays':
      return `Operating days per year -> ${edit.value}`;
  }
}

/**
 * Apply a scenario's edits to a copy of the baseline.
 *
 * Every edit marks the parameter it touches as USER_INPUT so the provenance
 * view shows which figures the scenario changed and which it inherited.
 */
export function applyScenario(baseline: SystemModel, scenario: Scenario): SystemModel {
  const m = deepClone(baseline);
  m.id = `${baseline.id}::${scenario.id}`;
  m.name = scenario.name;

  const station = (id: string) => {
    const s = m.stations.find((x) => x.id === id);
    if (!s) throw new Error(`Scenario "${scenario.name}" edits unknown station "${id}".`);
    return s;
  };

  for (const edit of scenario.edits) {
    switch (edit.kind) {
      case 'servers': {
        if (!Number.isInteger(edit.value) || edit.value < 1) {
          throw new Error(`Scenario "${scenario.name}": server count must be a whole number >= 1.`);
        }
        station(edit.stationId).servers = edit.value;
        break;
      }
      case 'serviceMean': {
        if (edit.value <= 0) throw new Error('Mean service time must be positive.');
        setServiceMean(station(edit.stationId), edit.value);
        break;
      }
      case 'serviceRate': {
        if (edit.value <= 0) throw new Error('Service rate must be positive.');
        setServiceMean(station(edit.stationId), 60 / edit.value);
        break;
      }
      case 'workerCount': {
        const crew = station(edit.stationId).workers.find((w) => w.id === edit.crewId);
        if (crew) crew.count = edit.value;
        break;
      }
      case 'wage': {
        const crew = station(edit.stationId).workers.find((w) => w.id === edit.crewId);
        if (crew) {
          crew.hourlyWage = { ...crew.hourlyWage, value: edit.value, provenance: 'USER_INPUT' };
        }
        break;
      }
      case 'routingProbability': {
        const st = station(edit.stationId);
        const arc = st.routing.find((e) => e.to === edit.to);
        if (!arc) throw new Error(`No routing arc ${edit.stationId} -> ${edit.to}.`);
        const others = st.routing.filter((e) => e !== arc);
        const otherTotal = others.reduce((a, e) => a + e.probability, 0);
        arc.probability = edit.value;
        // Re-normalise the remaining arcs so the station still sums to 1,
        // preserving their relative proportions. Leaving them alone would
        // silently break flow conservation.
        const remaining = 1 - edit.value;
        if (otherTotal > 0) {
          for (const e of others) e.probability = (e.probability / otherTotal) * remaining;
        } else if (others.length > 0) {
          for (const e of others) e.probability = remaining / others.length;
        }
        break;
      }
      case 'scrapProbability':
        station(edit.stationId).scrapProbability = edit.value;
        break;
      case 'demandScale': {
        for (const b of m.arrivals.schedule) {
          b.lambdaPerHour = {
            ...b.lambdaPerHour,
            value: b.lambdaPerHour.value * edit.value,
            provenance: 'USER_INPUT',
          };
        }
        break;
      }
      case 'demandFlat': {
        const end = m.simulation.warmupMinutes + m.simulation.durationMinutes;
        m.arrivals.schedule = [
          {
            startMinute: 0,
            endMinute: Math.max(end, 1),
            lambdaPerHour: {
              value: edit.value,
              unit: 'vehicles/hour',
              provenance: 'USER_INPUT',
              notes: 'Flat demand set by scenario.',
            },
            label: 'Flat demand',
          },
        ];
        break;
      }
      case 'sellingPrice': {
        const vm = m.vehicleModels.find((v) => v.id === edit.modelId);
        if (vm) vm.sellingPrice = { ...vm.sellingPrice, value: edit.value, provenance: 'USER_INPUT' };
        break;
      }
      case 'materialCost': {
        const vm = m.vehicleModels.find((v) => v.id === edit.modelId);
        const comp = vm?.bom.find((c) => c.id === edit.componentId);
        if (comp) comp.unitCost = { ...comp.unitCost, value: edit.value, provenance: 'USER_INPUT' };
        break;
      }
      case 'electricityPrice':
        m.cost.electricityPricePerKwh = {
          ...m.cost.electricityPricePerKwh,
          value: edit.value,
          provenance: 'USER_INPUT',
        };
        break;
      case 'reliability': {
        const rel = station(edit.stationId).machine?.reliability;
        if (rel) rel.enabled = edit.enabled;
        break;
      }
      case 'mtbf': {
        const rel = station(edit.stationId).machine?.reliability;
        if (rel) rel.mtbfHours = { ...rel.mtbfHours, value: edit.value, provenance: 'USER_INPUT' };
        break;
      }
      case 'mttr': {
        const rel = station(edit.stationId).machine?.reliability;
        if (rel) rel.mttrHours = { ...rel.mttrHours, value: edit.value, provenance: 'USER_INPUT' };
        break;
      }
      case 'machinePower': {
        const mach = station(edit.stationId).machine;
        if (mach) mach.powerKw = { ...mach.powerKw, value: edit.value, provenance: 'USER_INPUT' };
        break;
      }
      case 'overheadRate':
        m.cost.overhead.amount = {
          ...m.cost.overhead.amount,
          value: edit.value,
          provenance: 'USER_INPUT',
        };
        break;
      case 'operatingHours': {
        if (edit.value <= 0 || edit.value > 24) {
          throw new Error('Production hours per day must be between 0 and 24.');
        }
        m.investment.hoursPerDay = {
          ...m.investment.hoursPerDay,
          value: edit.value,
          provenance: 'USER_INPUT',
        };
        break;
      }
      case 'operatingDays': {
        if (edit.value <= 0 || edit.value > 366) {
          throw new Error('Operating days per year must be between 0 and 366.');
        }
        m.investment.operatingDaysPerYear = {
          ...m.investment.operatingDaysPerYear,
          value: edit.value,
          provenance: 'USER_INPUT',
        };
        break;
      }
    }
  }

  m.investment = {
    ...m.investment,
    initialInvestment: {
      ...m.investment.initialInvestment,
      value: scenario.initialInvestment,
      provenance: 'USER_INPUT',
    },
    additionalAnnualOperatingCost: {
      ...m.investment.additionalAnnualOperatingCost,
      value: scenario.additionalAnnualOperatingCost,
      provenance: 'USER_INPUT',
    },
    items: (scenario.investmentItems ?? []).map((i, idx) => ({
      id: `inv-${idx}`,
      name: i.name,
      amount: { value: i.amount, unit: 'currency', provenance: 'USER_INPUT' as const },
    })),
  };

  return m;
}

/** Rescale a distribution to a new mean, preserving its shape. */
function setServiceMean(station: SystemModel['stations'][number], meanMinutes: number): void {
  const d = station.service;
  switch (d.kind) {
    case 'exponential':
    case 'erlang':
      station.service = { ...d, mean: meanMinutes };
      break;
    case 'normal':
    case 'lognormal':
      // Scale the standard deviation too, so the coefficient of variation is
      // preserved: a faster machine should not also become more predictable
      // unless the user says so.
      station.service = { ...d, mean: meanMinutes, sd: d.sd * (meanMinutes / d.mean) };
      break;
    case 'constant':
      station.service = { ...d, value: meanMinutes };
      break;
    case 'uniform': {
      const f = meanMinutes / ((d.min + d.max) / 2);
      station.service = { ...d, min: d.min * f, max: d.max * f };
      break;
    }
    case 'triangular': {
      const f = meanMinutes / ((d.min + d.mode + d.max) / 3);
      station.service = { ...d, min: d.min * f, mode: d.mode * f, max: d.max * f };
      break;
    }
    case 'gamma':
      station.service = { ...d, scale: meanMinutes / d.shape };
      break;
    case 'weibull': {
      const f = meanMinutes / (d.scale * gammaApprox(1 + 1 / d.shape));
      station.service = { ...d, scale: d.scale * f };
      break;
    }
  }
}

function gammaApprox(z: number): number {
  // Stirling-based Lanczos, sufficient for rescaling a Weibull mean.
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaApprox(1 - z));
  z -= 1;
  let x = p[0] as number;
  for (let i = 1; i < g + 2; i++) x += (p[i] as number) / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface ScenarioResult {
  scenario: Scenario;
  model: SystemModel;
  study: StudyResult;
  annual: AnnualEconomics;
  /** Analytical view of the same configuration. */
  analytical: {
    bottleneckStationId: string | null;
    bottleneckStationName: string | null;
    factoryCapacityPerHour: number;
    stable: boolean;
    WqMinutes: number;
  };
  edits: string[];
}

export function evaluateScenario(
  baseline: SystemModel,
  scenario: Scenario,
  options: { replications?: number } = {},
): ScenarioResult {
  const model = applyScenario(baseline, scenario);
  const study = runStudy(model, options.replications ? { replications: options.replications } : {});

  const windowHours = study.representative.cost.windowHours;
  const annual = annualise(
    {
      windowHours,
      vehiclesFinished: meanOf(study, 'vehiclesCompleted'),
      revenue: meanOfCost(study, 'revenue'),
      manufacturingCost: meanOfCost(study, 'totalManufacturingCost'),
      waitingCost: meanOfCost(study, 'waitingCost'),
    },
    model.investment,
  );

  const net = solveNetwork(model);
  const bottleneck = analyseBottlenecks(model, undefined, net);

  return {
    scenario,
    model,
    study,
    annual,
    analytical: {
      bottleneckStationId: bottleneck.primaryBottleneckId,
      bottleneckStationName:
        model.stations.find((s) => s.id === bottleneck.primaryBottleneckId)?.name ?? null,
      factoryCapacityPerHour: capacityLimit(model).lambdaMaxPerHour,
      stable: net.system.stable,
      WqMinutes: net.system.WqMinutes,
    },
    edits: scenario.edits.map((e) => describeEdit(e, baseline)),
  };
}

const meanOf = (s: StudyResult, key: string) => s.system[key]?.mean ?? 0;
const meanOfCost = (s: StudyResult, key: string) => s.cost[key]?.mean ?? 0;

/* ------------------------------------------------------------------ */
/* Comparison (requirement 35)                                         */
/* ------------------------------------------------------------------ */

export interface ScenarioComparisonRow {
  metric: string;
  label: string;
  unit: string;
  baseline: number;
  scenario: number;
  difference: number;
  percentChange: number;
  /** Whether the difference survives a Welch t-test. */
  significant: boolean;
  note: string;
  /** Whether an increase in this metric is good. */
  higherIsBetter: boolean;
}

export interface ScenarioComparison {
  baseline: ScenarioResult;
  proposed: ScenarioResult;
  rows: ScenarioComparisonRow[];
  appraisal: IncrementalAppraisal;
  bottleneckMoved: boolean;
  recommendation: string;
  warnings: string[];
}

const COMPARISON_METRICS: {
  key: string;
  source: 'system' | 'cost';
  label: string;
  unit: string;
  higherIsBetter: boolean;
}[] = [
  { key: 'throughput', source: 'system', label: 'Throughput', unit: 'vehicles/hour', higherIsBetter: true },
  { key: 'vehiclesCompleted', source: 'system', label: 'Vehicles completed', unit: 'vehicles', higherIsBetter: true },
  { key: 'WMinutes', source: 'system', label: 'Manufacturing time (W)', unit: 'minutes', higherIsBetter: false },
  { key: 'WqMinutes', source: 'system', label: 'Waiting time (Wq)', unit: 'minutes', higherIsBetter: false },
  { key: 'L', source: 'system', label: 'WIP (L)', unit: 'vehicles', higherIsBetter: false },
  { key: 'Lq', source: 'system', label: 'Queueing (Lq)', unit: 'vehicles', higherIsBetter: false },
  { key: 'cycleP95', source: 'system', label: '95th percentile cycle time', unit: 'minutes', higherIsBetter: false },
  { key: 'factoryUtilization', source: 'system', label: 'Factory utilisation', unit: 'fraction', higherIsBetter: true },
  { key: 'vehiclesScrapped', source: 'system', label: 'Scrapped', unit: 'vehicles', higherIsBetter: false },
  { key: 'totalManufacturingCost', source: 'cost', label: 'Total manufacturing cost', unit: 'currency', higherIsBetter: false },
  { key: 'costPerVehicle', source: 'cost', label: 'Cost per vehicle', unit: 'currency/vehicle', higherIsBetter: false },
  { key: 'revenue', source: 'cost', label: 'Revenue', unit: 'currency', higherIsBetter: true },
  { key: 'grossProfit', source: 'cost', label: 'Profit', unit: 'currency', higherIsBetter: true },
  { key: 'profitPerVehicle', source: 'cost', label: 'Profit per vehicle', unit: 'currency/vehicle', higherIsBetter: true },
  { key: 'marginPercent', source: 'cost', label: 'Margin', unit: '%', higherIsBetter: true },
  { key: 'waitingCost', source: 'cost', label: 'Waiting cost', unit: 'currency', higherIsBetter: false },
  { key: 'energyKwh', source: 'cost', label: 'Energy consumed', unit: 'kWh', higherIsBetter: false },
  { key: 'reworkCost', source: 'cost', label: 'Rework cost', unit: 'currency', higherIsBetter: false },
];

export function compareScenarios(
  baseline: ScenarioResult,
  proposed: ScenarioResult,
): ScenarioComparison {
  const rows: ScenarioComparisonRow[] = [];
  for (const m of COMPARISON_METRICS) {
    const a = m.source === 'system' ? baseline.study.system[m.key] : baseline.study.cost[m.key];
    const b = m.source === 'system' ? proposed.study.system[m.key] : proposed.study.cost[m.key];
    if (!a || !b) continue;
    const cmp = compareMetrics(a, b);
    rows.push({
      metric: m.key,
      label: m.label,
      unit: m.unit,
      baseline: a.mean,
      scenario: b.mean,
      difference: cmp.difference,
      percentChange: cmp.percentChange,
      significant: cmp.significant,
      note: cmp.note,
      higherIsBetter: m.higherIsBetter,
    });
  }

  const appraisal = appraiseIncremental(
    baseline.annual,
    proposed.annual,
    {
      initialInvestment: proposed.scenario.initialInvestment,
      additionalAnnualOperatingCost: proposed.scenario.additionalAnnualOperatingCost,
    },
  );

  const bottleneckMoved =
    baseline.analytical.bottleneckStationId !== proposed.analytical.bottleneckStationId;

  const warnings: string[] = [];
  const throughputRow = rows.find((r) => r.metric === 'throughput');
  if (throughputRow && !throughputRow.significant && Math.abs(throughputRow.percentChange) > 0.5) {
    warnings.push(
      `The ${throughputRow.percentChange.toFixed(1)}% throughput difference is not statistically ` +
        'significant at 95% confidence. Increase the replication count before treating it as real.',
    );
  }
  if (!proposed.analytical.stable) {
    warnings.push(
      'The proposed configuration has at least one unstable queue (rho >= 1). Its simulated ' +
        'averages depend on the run length rather than describing a sustainable steady state.',
    );
  }

  return {
    baseline,
    proposed,
    rows,
    appraisal,
    bottleneckMoved,
    recommendation: buildRecommendation(baseline, proposed, appraisal, bottleneckMoved),
    warnings,
  };
}

function buildRecommendation(
  baseline: ScenarioResult,
  proposed: ScenarioResult,
  appraisal: IncrementalAppraisal,
  bottleneckMoved: boolean,
): string {
  const parts: string[] = [];

  if (appraisal.initialInvestment <= 0) {
    parts.push(
      'This change requires no capital, so it should be judged on its operating effect alone: ' +
        `annual profit changes by ${appraisal.annualNetBenefit.toFixed(0)}.`,
    );
  } else if (!appraisal.payback.achieved) {
    parts.push(
      `NOT RECOMMENDED on these figures. The investment of ${appraisal.initialInvestment.toFixed(0)} ` +
        `produces an annual net benefit of ${appraisal.annualNetBenefit.toFixed(0)}, which is not ` +
        'positive, so it never pays back.',
    );
  } else {
    const years = appraisal.payback.years as number;
    const verdict =
      years <= 2 ? 'STRONGLY RECOMMENDED' : years <= 5 ? 'RECOMMENDED' : 'MARGINAL';
    parts.push(
      `${verdict}: ${appraisal.initialInvestment.toFixed(0)} of capital returns ` +
        `${appraisal.annualNetBenefit.toFixed(0)}/year, an ROI of ` +
        `${(appraisal.roiPercent as number).toFixed(1)}% and payback in ${years.toFixed(2)} years.`,
    );
  }

  const dThroughput =
    proposed.study.system['throughput']!.mean - baseline.study.system['throughput']!.mean;
  const dCostPerVehicle =
    proposed.study.cost['costPerVehicle']!.mean - baseline.study.cost['costPerVehicle']!.mean;

  parts.push(
    `Throughput moves by ${dThroughput >= 0 ? '+' : ''}${dThroughput.toFixed(3)} vehicles/hour and ` +
      `cost per vehicle by ${dCostPerVehicle >= 0 ? '+' : ''}${dCostPerVehicle.toFixed(2)}.`,
  );

  if (bottleneckMoved) {
    parts.push(
      `The constraint moves from ${baseline.analytical.bottleneckStationName} to ` +
        `${proposed.analytical.bottleneckStationName}. Further investment at ` +
        `${baseline.analytical.bottleneckStationName} will now buy much less.`,
    );
  } else if (proposed.analytical.bottleneckStationName) {
    parts.push(
      `${proposed.analytical.bottleneckStationName} remains the binding constraint, so the ceiling ` +
        'on output has not moved.',
    );
  }

  return parts.join(' ');
}
