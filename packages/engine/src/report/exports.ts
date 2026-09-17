/**
 * CSV exports — requirement 55.
 *
 * Flat, one-row-per-record files that open cleanly in a spreadsheet. Every
 * numeric column header carries its unit, because a column of numbers with no
 * unit is the easiest way for a correct model to produce a wrong conclusion
 * once the data leaves the application.
 */

import type { CostResult } from '../cost/costEngine.js';
import { expandBom } from '../cost/costEngine.js';
import { cycleTimeMinutes, type Vehicle } from '../des/vehicle.js';
import type { SystemModel } from '../model/types.js';
import type { ScenarioComparison } from '../optimize/scenarios.js';
import type { StudyResult } from '../stats/replications.js';
import { collectProvenance } from '../validation/validate.js';
import { solveNetwork } from '../analytical/network.js';

/** Quote a CSV field, escaping embedded quotes per RFC 4180. */
function q(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(headers: string[], rows: unknown[][]): string {
  return [headers.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n');
}

const num = (x: number | null | undefined, dp = 4): string =>
  x === null || x === undefined || Number.isNaN(x)
    ? ''
    : Number.isFinite(x)
      ? x.toFixed(dp)
      : 'Infinity';

/* ------------------------------------------------------------------ */

/** Queue metrics per station: analytical and simulated side by side. */
export function exportQueueMetricsCsv(model: SystemModel, study: StudyResult): string {
  const net = solveNetwork(model);
  return csv(
    [
      'station_id',
      'station_name',
      'kendall',
      'servers_c',
      'service_mean_minutes',
      'mu_per_hour_per_server',
      'visit_ratio',
      'lambda_analytical_per_hour',
      'lambda_simulated_per_hour',
      'rho_analytical',
      'utilization_simulated',
      'L_analytical_vehicles',
      'L_simulated_vehicles',
      'Lq_analytical_vehicles',
      'Lq_simulated_vehicles',
      'W_analytical_minutes',
      'W_simulated_minutes',
      'Wq_analytical_minutes',
      'Wq_simulated_minutes',
      'Wq_simulated_ci_low_minutes',
      'Wq_simulated_ci_high_minutes',
      'stable',
      'analytical_is_exact',
      'peak_queue_vehicles',
      'breakdowns',
      'downtime_fraction',
    ],
    net.stations.map((a) => {
      const s = study.stations.find((x) => x.stationId === a.stationId);
      const m = s?.metrics ?? {};
      return [
        a.stationId,
        a.stationName,
        a.kendall,
        a.c,
        num(a.serviceMinutes),
        num(60 / a.serviceMinutes),
        num(a.visitRatio),
        num(a.lambda),
        num(m.lambdaObserved?.mean),
        num(a.rho),
        num(m.utilization?.mean),
        num(a.L),
        num(m.L?.mean),
        num(a.Lq),
        num(m.Lq?.mean),
        num(a.WMinutes),
        num(m.WMinutes?.mean),
        num(a.WqMinutes),
        num(m.WqMinutes?.mean),
        num(m.WqMinutes?.ciLow),
        num(m.WqMinutes?.ciHigh),
        a.stable ? 'yes' : 'no',
        a.exact ? 'yes' : 'no',
        num(m.maxQueueLength?.mean, 1),
        num(m.breakdowns?.mean, 1),
        num(m.downtimeFraction?.mean),
      ];
    }),
  );
}

/** One row per vehicle: the full manufacturing history, summarised. */
export function exportVehicleTracesCsv(vehicles: Vehicle[], cost?: CostResult): string {
  const costById = new Map((cost?.vehicles ?? []).map((v) => [v.vehicleId, v]));
  return csv(
    [
      'vehicle_id',
      'tag',
      'vehicle_model',
      'status',
      'arrival_time_minutes',
      'completion_time_minutes',
      'cycle_time_minutes',
      'waiting_minutes',
      'processing_minutes',
      'downtime_minutes',
      'stations_visited',
      'rework_count',
      'inspection_count',
      'material_cost',
      'labor_cost',
      'machine_cost',
      'energy_cost',
      'maintenance_cost',
      'rework_cost',
      'overhead_cost',
      'total_cost',
      'route',
    ],
    vehicles.map((v) => {
      const c = costById.get(v.id);
      return [
        v.id,
        v.tag,
        v.modelId,
        v.status,
        num(v.arrivalTime, 3),
        num(v.completionTime, 3),
        num(cycleTimeMinutes(v), 3),
        num(v.totalWaitMinutes, 3),
        num(v.totalProcessingMinutes, 3),
        num(v.totalDowntimeMinutes, 3),
        v.visits.length,
        v.reworkCount,
        v.inspectionCount,
        num(c?.materialCost, 2),
        num(c?.laborCost, 2),
        num(c?.machineCost, 2),
        num(c?.energyCost, 2),
        num(c?.maintenanceCost, 2),
        num(c?.reworkCost, 2),
        num(c?.overheadCost, 2),
        num(c?.totalCost, 2),
        v.visits.map((x) => x.stationName).join(' > '),
      ];
    }),
  );
}

/** One row per station VISIT, for detailed queueing analysis in a spreadsheet. */
export function exportVisitsCsv(vehicles: Vehicle[]): string {
  const rows: unknown[][] = [];
  for (const v of vehicles) {
    for (const visit of v.visits) {
      rows.push([
        v.id,
        v.tag,
        visit.stationId,
        visit.stationName,
        visit.visitNumber,
        num(visit.enqueuedAt, 3),
        num(visit.serviceStartedAt, 3),
        num(visit.serviceEndedAt, 3),
        num(visit.waitMinutes, 3),
        num(visit.processingMinutes, 3),
        num(visit.downtimeMinutes, 3),
        visit.serverIndex ?? '',
        visit.outcome,
        visit.routedTo ?? '',
      ]);
    }
  }
  return csv(
    [
      'vehicle_id',
      'tag',
      'station_id',
      'station_name',
      'visit_number',
      'enqueued_at_minutes',
      'service_started_minutes',
      'service_ended_minutes',
      'wait_minutes',
      'processing_minutes',
      'downtime_minutes',
      'server_index',
      'outcome',
      'routed_to',
    ],
    rows,
  );
}

/** Cost breakdown, including the drill-down children of each line. */
export function exportCostBreakdownCsv(cost: CostResult): string {
  const rows: unknown[][] = [];
  for (const l of cost.lines) {
    rows.push([l.id, l.label, '', num(l.amount, 2), num(l.perVehicle, 2), l.formula]);
    for (const c of l.children ?? []) {
      rows.push([l.id, l.label, c.label, num(c.amount, 2), num(c.perVehicle, 2), c.formula]);
    }
  }
  rows.push(['TOTAL', 'Total manufacturing cost', '', num(cost.totalManufacturingCost, 2), num(cost.costPerVehicle, 2), 'Sum of the nine lines above']);
  rows.push(['revenue', 'Revenue', '', num(cost.revenue, 2), num(cost.revenuePerVehicle, 2), 'finished vehicles x selling price']);
  rows.push(['profit', 'Profit', '', num(cost.grossProfit, 2), num(cost.profitPerVehicle, 2), 'revenue - total manufacturing cost']);
  rows.push(['waiting', 'Queue waiting cost (NOT in total)', '', num(cost.waitingCost, 2), '', 'vehicle-hours waiting x waiting rate; an opportunity cost reported separately']);
  rows.push(['wip', 'WIP holding cost (NOT in total)', '', num(cost.wipHoldingCost, 2), '', 'vehicle-hours of WIP x holding rate']);
  rows.push(['scrap_value', 'Total value lost to scrap (OVERLAPS other lines)', '', num(cost.scrapAnalysis.totalValueLost, 2), '', cost.scrapAnalysis.note]);

  return csv(['line_id', 'line', 'sub_line', `amount_${cost.currencyCode}`, `per_vehicle_${cost.currencyCode}`, 'formula'], rows);
}

/** Per-station cost detail. */
export function exportStationCostCsv(cost: CostResult): string {
  return csv(
    [
      'station_id',
      'station_name',
      'cost_bucket',
      'busy_server_hours',
      'idle_server_hours',
      'down_server_hours',
      'labor_cost',
      'labor_idle_cost',
      'machine_depreciation',
      'machine_consumables',
      'energy_kwh',
      'energy_cost',
      'preventive_maintenance',
      'corrective_maintenance',
      'material_cost',
      'conversion_cost_per_server_minute',
    ],
    cost.stations.map((s) => [
      s.stationId,
      s.stationName,
      s.bucket,
      num(s.busyServerHours, 3),
      num(s.idleServerHours, 3),
      num(s.downServerHours, 3),
      num(s.laborCost, 2),
      num(s.laborIdleCost, 2),
      num(s.machineDepreciation, 2),
      num(s.machineConsumables, 2),
      num(s.energyKwh, 3),
      num(s.energyCost, 2),
      num(s.preventiveMaintenance, 2),
      num(s.correctiveMaintenance, 2),
      num(s.materialCost, 2),
      num(s.conversionCostPerServerMinute, 4),
    ]),
  );
}

/** Bill of materials for every vehicle model. */
export function exportBomCsv(model: SystemModel): string {
  const rows: unknown[][] = [];
  for (const vm of model.vehicleModels) {
    const bom = expandBom(model, vm);
    for (const l of bom.lines) {
      rows.push([
        vm.id,
        vm.name,
        l.componentId,
        l.name,
        num(l.quantityPerVehicle, 3),
        l.unit,
        num(l.unitCost, 4),
        num(l.scrapAllowance, 4),
        num(l.effectiveQuantity, 4),
        num(l.totalCost, 2),
        l.consumedAtStationId,
        l.supplier ?? '',
      ]);
    }
  }
  return csv(
    [
      'vehicle_model_id',
      'vehicle_model',
      'component_id',
      'component',
      'quantity_per_vehicle',
      'unit',
      'unit_cost',
      'scrap_allowance',
      'effective_quantity',
      'total_cost',
      'consumed_at_station',
      'supplier',
    ],
    rows,
  );
}

/** Replication-level results, so the statistics can be re-derived externally. */
export function exportReplicationsCsv(study: StudyResult): string {
  const keys = Object.keys(study.system);
  const costKeys = Object.keys(study.cost);
  const rows: unknown[][] = [];
  for (let i = 0; i < study.replications; i++) {
    rows.push([
      i,
      study.seeds[i],
      ...keys.map((k) => num(study.system[k]?.values[i])),
      ...costKeys.map((k) => num(study.cost[k]?.values[i], 2)),
    ]);
  }
  return csv(
    [
      'replication',
      'seed',
      ...keys.map((k) => `${k}_${study.system[k]?.unit.replace(/[^a-z0-9]+/gi, '_')}`),
      ...costKeys.map((k) => `cost_${k}`),
    ],
    rows,
  );
}

/** Summary statistics with confidence intervals. */
export function exportSummaryStatisticsCsv(study: StudyResult): string {
  const rows: unknown[][] = [];
  const add = (scope: string, m: { key: string; label: string; unit: string; n: number; mean: number; stdDev: number; stdError: number; ciLow: number; ciHigh: number; min: number; max: number }) =>
    rows.push([
      scope,
      m.key,
      m.label,
      m.unit,
      m.n,
      num(m.mean),
      num(m.stdDev),
      num(m.stdError),
      num(m.ciLow),
      num(m.ciHigh),
      num(m.min),
      num(m.max),
    ]);

  for (const m of Object.values(study.system)) add('system', m);
  for (const m of Object.values(study.cost)) add('cost', m);
  for (const s of study.stations) {
    for (const m of Object.values(s.metrics)) add(`station:${s.stationId}`, m);
  }

  return csv(
    ['scope', 'metric', 'label', 'unit', 'replications', 'mean', 'std_dev', 'std_error', 'ci_low_95', 'ci_high_95', 'min', 'max'],
    rows,
  );
}

/** Scenario comparison table. */
export function exportScenarioComparisonCsv(comparisons: ScenarioComparison[]): string {
  const rows: unknown[][] = [];
  for (const c of comparisons) {
    for (const r of c.rows) {
      rows.push([
        c.baseline.scenario.name,
        c.proposed.scenario.name,
        r.metric,
        r.label,
        r.unit,
        num(r.baseline),
        num(r.scenario),
        num(r.difference),
        num(r.percentChange, 2),
        r.significant ? 'yes' : 'no',
        r.higherIsBetter ? 'higher' : 'lower',
      ]);
    }
    const a = c.appraisal;
    rows.push([
      c.baseline.scenario.name,
      c.proposed.scenario.name,
      'initial_investment',
      'Initial investment',
      'currency',
      0,
      num(a.initialInvestment, 2),
      num(a.initialInvestment, 2),
      '',
      '',
      'lower',
    ]);
    rows.push([
      c.baseline.scenario.name,
      c.proposed.scenario.name,
      'annual_net_benefit',
      'Annual net benefit',
      'currency/year',
      0,
      num(a.annualNetBenefit, 2),
      num(a.annualNetBenefit, 2),
      '',
      '',
      'higher',
    ]);
    rows.push([
      c.baseline.scenario.name,
      c.proposed.scenario.name,
      'roi_percent',
      'ROI',
      '%/year',
      '',
      a.roiPercent === null ? 'not defined' : num(a.roiPercent, 2),
      '',
      '',
      '',
      'higher',
    ]);
    rows.push([
      c.baseline.scenario.name,
      c.proposed.scenario.name,
      'payback_years',
      'Payback period',
      'years',
      '',
      a.payback.achieved ? num(a.payback.years, 3) : 'NOT ACHIEVED',
      '',
      '',
      '',
      'lower',
    ]);
  }
  return csv(
    ['baseline', 'scenario', 'metric', 'label', 'unit', 'baseline_value', 'scenario_value', 'difference', 'percent_change', 'statistically_significant', 'better_direction'],
    rows,
  );
}

/** Every configurable parameter with its provenance (requirement 46). */
export function exportParametersCsv(model: SystemModel): string {
  const prov = collectProvenance(model);
  return csv(
    ['path', 'label', 'value', 'unit', 'provenance', 'source', 'notes'],
    prov.parameters.map((p) => [p.path, p.label, num(p.value, 6), p.unit, p.provenance, p.source ?? '', p.notes ?? '']),
  );
}

/** The whole model, for reload or archival. */
export function exportConfigurationJson(model: SystemModel): string {
  return JSON.stringify(model, null, 2);
}

export interface ExportBundle {
  filename: string;
  mimeType: string;
  content: string;
}

/** Everything requirement 55 asks for, as a set of named files. */
export function buildExportBundle(args: {
  model: SystemModel;
  study: StudyResult;
  cost: CostResult;
  vehicles: Vehicle[];
  comparisons?: ScenarioComparison[];
  report?: string;
}): ExportBundle[] {
  const base = args.model.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const out: ExportBundle[] = [
    { filename: `${base}-queue-metrics.csv`, mimeType: 'text/csv', content: exportQueueMetricsCsv(args.model, args.study) },
    { filename: `${base}-summary-statistics.csv`, mimeType: 'text/csv', content: exportSummaryStatisticsCsv(args.study) },
    { filename: `${base}-replications.csv`, mimeType: 'text/csv', content: exportReplicationsCsv(args.study) },
    { filename: `${base}-cost-breakdown.csv`, mimeType: 'text/csv', content: exportCostBreakdownCsv(args.cost) },
    { filename: `${base}-station-costs.csv`, mimeType: 'text/csv', content: exportStationCostCsv(args.cost) },
    { filename: `${base}-bom.csv`, mimeType: 'text/csv', content: exportBomCsv(args.model) },
    { filename: `${base}-parameters.csv`, mimeType: 'text/csv', content: exportParametersCsv(args.model) },
    { filename: `${base}-configuration.json`, mimeType: 'application/json', content: exportConfigurationJson(args.model) },
  ];
  if (args.vehicles.length) {
    out.push({ filename: `${base}-vehicle-traces.csv`, mimeType: 'text/csv', content: exportVehicleTracesCsv(args.vehicles, args.cost) });
    out.push({ filename: `${base}-station-visits.csv`, mimeType: 'text/csv', content: exportVisitsCsv(args.vehicles) });
  }
  if (args.comparisons?.length) {
    out.push({ filename: `${base}-scenario-comparison.csv`, mimeType: 'text/csv', content: exportScenarioComparisonCsv(args.comparisons) });
  }
  if (args.report) {
    out.push({ filename: `${base}-report.md`, mimeType: 'text/markdown', content: args.report });
  }
  return out;
}
