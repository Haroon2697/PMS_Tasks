/**
 * Simulation report generation — requirement 54.
 *
 * Produces the full report in the order requirement 54 specifies. Two rules
 * govern what goes in it:
 *
 *  - Every figure is labelled with its origin: ANALYTICAL (closed form),
 *    SIMULATED (mean over replications, with its confidence interval), or
 *    ASSUMPTION (a configured input). Requirement 60 forbids presenting any of
 *    the three as another.
 *
 *  - The Limitations section is generated from what the model actually does,
 *    not from a fixed paragraph. If a station is unstable, if a queue is
 *    non-Poisson, if breakdowns are enabled while the analytical figures
 *    ignore them — the report says so, because those are precisely the things
 *    a reader would otherwise take on trust.
 */

import { analyseBottlenecks } from '../analytical/bottleneck.js';
import { capacityLimit, solveNetwork } from '../analytical/network.js';
import type { CostResult } from '../cost/costEngine.js';
import { expandBom, verifyAdditivity } from '../cost/costEngine.js';
import { describeDistribution, kendallSymbol } from '../distributions.js';
import type { IncrementalAppraisal } from '../finance/investment.js';
import { annualise } from '../finance/investment.js';
import type { SystemModel } from '../model/types.js';
import { SINK_FINISHED, SINK_SCRAP } from '../model/types.js';
import type { ScenarioComparison } from '../optimize/scenarios.js';
import type { OptimizationResult } from '../optimize/optimizer.js';
import type { MetricSummary, StudyResult } from '../stats/replications.js';
import { collectProvenance, validateModel } from '../validation/validate.js';

export interface ReportInput {
  model: SystemModel;
  study: StudyResult;
  cost: CostResult;
  comparisons?: ScenarioComparison[];
  optimization?: OptimizationResult;
  appraisal?: IncrementalAppraisal;
  generatedAt?: string;
  author?: string;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

const n = (x: number | undefined | null, dp = 2): string =>
  x === undefined || x === null || Number.isNaN(x)
    ? 'n/a'
    : !Number.isFinite(x)
      ? 'infinite'
      : x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const pct = (x: number, dp = 1): string => (Number.isFinite(x) ? `${(x * 100).toFixed(dp)}%` : 'n/a');

/** Format a simulated metric as "mean [CI low, CI high]". */
function ci(m: MetricSummary | undefined, dp = 2): string {
  if (!m) return 'n/a';
  if (!Number.isFinite(m.halfWidth)) return `${n(m.mean, dp)} (single replication, no interval)`;
  return `${n(m.mean, dp)}  [95% CI ${n(m.ciLow, dp)} – ${n(m.ciHigh, dp)}]`;
}

const table = (headers: string[], rows: (string | number)[][]): string => {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
};

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export function generateReport(input: ReportInput): string {
  const { model, study, cost } = input;
  const sym = model.cost.currency.symbol;
  const net = solveNetwork(model);
  const bottleneck = analyseBottlenecks(model, undefined, net);
  const validation = validateModel(model);
  const provenance = collectProvenance(model);
  const cap = capacityLimit(model);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const out: string[] = [];
  const h1 = (t: string) => out.push(`\n# ${t}\n`);
  const h2 = (t: string) => out.push(`\n## ${t}\n`);
  const h3 = (t: string) => out.push(`\n### ${t}\n`);
  const p = (t: string) => out.push(`${t}\n`);

  /* -------- title -------- */
  out.push(`# Manufacturing Simulation Report — ${model.name}\n`);
  p(`**Generated:** ${generatedAt}`);
  if (input.author) p(`**Author:** ${input.author}`);
  p(
    `**Model:** ${model.id} · **Seed:** ${study.baseSeed} · **Replications:** ${study.replications} · ` +
      `**Warm-up:** ${n(study.warmupMinutes, 0)} min · **Measurement:** ${n(study.durationMinutes, 0)} min`,
  );
  p(
    '> Every number below is labelled **ANALYTICAL** (closed-form queueing result), **SIMULATED** ' +
      '(mean over independent replications, with a 95% confidence interval) or **ASSUMPTION** ' +
      '(a configured input). They are not interchangeable and are never mixed in a single figure.',
  );

  /* -------- 1. executive summary -------- */
  h2('1. Executive Summary');
  const thr = study.system.throughput;
  const cpv = study.cost.costPerVehicle;
  const profit = study.cost.grossProfit;
  const bottleneckName =
    model.stations.find((s) => s.id === bottleneck.primaryBottleneckId)?.name ?? 'none identified';

  p(
    `The line was simulated over ${n(study.durationMinutes / 60, 1)} production hours after a ` +
      `${n(study.warmupMinutes / 60, 1)}-hour warm-up, replicated ${study.replications} times.`,
  );
  p(
    table(
      ['Measure', 'Value', 'Basis'],
      [
        ['Throughput', `${ci(thr, 3)} vehicles/hour`, 'SIMULATED'],
        [
          'Vehicles completed per run',
          ci(study.system.vehiclesCompleted, 1),
          'SIMULATED',
        ],
        ['Manufacturing time (W)', `${ci(study.system.WMinutes, 1)} min`, 'SIMULATED'],
        ['Waiting time (Wq)', `${ci(study.system.WqMinutes, 1)} min`, 'SIMULATED'],
        ['Work in progress (L)', ci(study.system.L, 2), 'SIMULATED'],
        ['Cost per vehicle', `${sym}${ci(cpv, 2)}`, 'SIMULATED'],
        ['Profit per vehicle', `${sym}${ci(study.cost.profitPerVehicle, 2)}`, 'SIMULATED'],
        ['Margin', `${n(study.cost.marginPercent?.mean, 2)}%`, 'SIMULATED'],
        ['Factory capacity', `${n(cap.lambdaMaxPerHour, 2)} vehicles/hour`, 'ANALYTICAL'],
        ['Primary bottleneck', bottleneckName, 'ANALYTICAL'],
        [
          'Demand (time-weighted average)',
          `${n(net.system.lambdaExternal, 2)} vehicles/hour`,
          'ASSUMPTION',
        ],
      ],
    ),
  );

  const headroom = cap.lambdaMaxPerHour - net.system.lambdaExternal;
  p(
    headroom > 0
      ? `The factory has **${n(headroom, 2)} vehicles/hour of spare capacity** at the average demand ` +
          `level, constrained by ${bottleneckName}.`
      : `**Demand exceeds capacity by ${n(-headroom, 2)} vehicles/hour.** The line cannot keep up, so ` +
          'work in progress grows for as long as the run continues.',
  );

  /* -------- 2. system description -------- */
  h2('2. System Description');
  p(model.description ?? 'No description recorded.');
  p(
    `The system comprises ${model.stations.length} stations. External vehicles enter at ` +
      `**${model.stations.find((s) => s.id === model.arrivals.entryStationId)?.name}**, which is the ` +
      'only point where an external arrival rate is defined; every other station\'s arrival rate is ' +
      'derived from upstream flow and routing probabilities.',
  );

  h3('2.1 Network Diagram');
  p('```');
  for (const s of model.stations) {
    const arcs = s.routing
      .map((e) => {
        const target =
          e.to === SINK_FINISHED
            ? 'FINISHED VEHICLE'
            : e.to === SINK_SCRAP
              ? 'SCRAP'
              : (model.stations.find((x) => x.id === e.to)?.name ?? e.to);
        return `${(e.probability * 100).toFixed(1)}% -> ${target}${e.label ? ` (${e.label})` : ''}`;
      })
      .join('\n      ');
    out.push(`${s.name}  [${kendallSymbol(s.service)} service, c=${s.servers}]\n      ${arcs}`);
  }
  p('```');

  /* -------- 3. queue parameters -------- */
  h2('3. Queue Parameters and Kendall Notation');
  p(
    table(
      ['Station', 'Kendall', 'Servers c', 'Service time', 'mu (veh/h/server)', 'Visits/vehicle', 'lambda (veh/h)', 'Capacity c·mu'],
      net.stations.map((s) => {
        const def = model.stations.find((x) => x.id === s.stationId)!;
        return [
          s.stationName,
          `**${s.kendall}**`,
          s.c,
          describeDistribution(def.service),
          n(60 / s.serviceMinutes, 3),
          n(s.visitRatio, 3),
          n(s.lambda, 3),
          n(s.capacity, 3),
        ];
      }),
    ),
  );
  p(
    'The Kendall symbol for each station is derived from the distribution actually configured for ' +
      'it, not assigned by convention: M = exponential, D = deterministic, E_k = Erlang-k, ' +
      'G = general.',
  );

  /* -------- 4. mathematical model -------- */
  h2('4. Mathematical Model');
  h3('4.1 Traffic Equations');
  p(
    'Internal arrival rates are obtained by solving `lambda = r + P^T lambda`, where `r` holds the ' +
      'external arrivals and `P` is the routing matrix. The inspection to rework arc makes this ' +
      'system cyclic, so it is solved rather than accumulated in topological order.',
  );
  p(
    table(
      ['Station', 'Visit ratio V', 'Derivation'],
      net.stations.map((s) => [
        s.stationName,
        n(s.visitRatio, 4),
        s.visitRatio > 1.0001
          ? 'Above 1 because the rework loop returns vehicles here'
          : 'Visited once per vehicle',
      ]),
    ),
  );

  h3('4.2 Per-station Results');
  p(
    table(
      ['Station', 'rho', 'L', 'Lq', 'W (min)', 'Wq (min)', 'Stable', 'Exact'],
      net.stations.map((s) => [
        s.stationName,
        pct(s.rho),
        n(s.L, 3),
        n(s.Lq, 3),
        n(s.WMinutes, 2),
        n(s.WqMinutes, 2),
        s.stable ? 'yes' : '**NO**',
        s.exact ? 'exact' : 'approximation',
      ]),
    ),
  );
  p(`Method used per station: ${net.stations.map((s) => `${s.stationName}: ${s.method}`).join(' · ')}`);

  h3('4.3 System-level Results (ANALYTICAL)');
  p(
    table(
      ['Measure', 'Value', 'Formula'],
      [
        ['L (system)', n(net.system.L, 3), 'sum of node L'],
        ['Lq (system)', n(net.system.Lq, 3), 'sum of node Lq'],
        ['W (system)', `${n(net.system.WMinutes, 2)} min`, 'L / lambda_external'],
        ['Wq (system)', `${n(net.system.WqMinutes, 2)} min`, 'Lq / lambda_external'],
        [
          'Work content per vehicle',
          `${n(net.system.totalServiceMinutesPerVehicle, 2)} min`,
          'sum of visits x mean service time',
        ],
      ],
    ),
  );
  p(
    '> System W divides by the **external** arrival rate, not by the sum of node arrival rates. ' +
      'Dividing by the latter would count a reworked vehicle as several vehicles and understate ' +
      'the time each one actually spends in the factory.',
  );

  /* -------- 5. methodology -------- */
  h2('5. Simulation Methodology');
  p(
    `A next-event discrete-event simulation advances the clock from one scheduled event to the next ` +
      `using a priority-queue event calendar. Events: vehicle arrival, service completion, machine ` +
      `breakdown, repair completion, warm-up end and end of horizon.`,
  );
  p(
    table(
      ['Setting', 'Value'],
      [
        ['Random seed', study.baseSeed],
        ['Replications', study.replications],
        ['Warm-up period', `${n(study.warmupMinutes, 0)} min`],
        ['Measurement period', `${n(study.durationMinutes, 0)} min`],
        ['Termination', model.simulation.terminationMode],
        ['Seeds used', study.seeds.join(', ')],
      ],
    ),
  );
  p(
    'Runs are reproducible: the same model and seed produce identical results. Each stochastic ' +
      'source draws from its own named substream, so changing one station\'s parameters does not ' +
      'shift the random numbers consumed elsewhere.',
  );

  /* -------- 6. simulation results -------- */
  h2('6. Simulation Results (SIMULATED)');
  p(
    table(
      ['Metric', 'Mean', '95% CI', 'Std dev', 'Min', 'Max', 'Unit'],
      Object.values(study.system).map((m) => [
        m.label,
        n(m.mean, 3),
        Number.isFinite(m.halfWidth) ? `${n(m.ciLow, 3)} – ${n(m.ciHigh, 3)}` : 'n/a',
        n(m.stdDev, 3),
        n(m.min, 3),
        n(m.max, 3),
        m.unit,
      ]),
    ),
  );

  h3('6.1 Manufacturing Time Distribution');
  const c = study.representative.simulation.system.cycleTime;
  p(
    table(
      ['Statistic', 'Value (min)'],
      [
        ['Mean', n(c.meanMinutes, 2)],
        ['Median', n(c.medianMinutes, 2)],
        ['95th percentile', n(c.p95Minutes, 2)],
        ['Maximum', n(c.maxMinutes, 2)],
        ['Minimum', n(c.minMinutes, 2)],
        ['Standard deviation', n(c.stdDevMinutes, 2)],
        ['Observations', c.count],
      ],
    ),
  );
  const ts = study.representative.simulation.system.timeSplit;
  p(
    'Split of the mean manufacturing time: ' +
      `waiting ${n(ts.waitingMinutes, 1)} min, processing ${n(ts.processingMinutes, 1)} min, ` +
      `machine downtime ${n(ts.downtimeMinutes, 1)} min (of which rework processing ` +
      `${n(ts.reworkMinutes, 1)} min and inspection ${n(ts.inspectionMinutes, 1)} min).`,
  );

  h3('6.2 Per-station Results');
  p(
    table(
      ['Station', 'Utilisation', 'L', 'Lq', 'W (min)', 'Wq (min)', 'Peak queue', 'Breakdowns'],
      study.stations.map((s) => [
        s.stationName,
        pct(s.metrics.utilization?.mean ?? 0),
        n(s.metrics.L?.mean, 3),
        n(s.metrics.Lq?.mean, 3),
        n(s.metrics.WMinutes?.mean, 2),
        n(s.metrics.WqMinutes?.mean, 2),
        n(s.metrics.maxQueueLength?.mean, 1),
        n(s.metrics.breakdowns?.mean, 1),
      ]),
    ),
  );

  /* -------- 7. analytical vs simulation -------- */
  h2('7. Analytical vs Simulation Comparison');
  p(
    table(
      ['Station', 'Metric', 'Analytical', 'Simulated', 'Abs error', '% error', 'Note'],
      net.stations.flatMap((a) => {
        const s = study.stations.find((x) => x.stationId === a.stationId);
        if (!s) return [];
        const rows: (string | number)[][] = [];
        const add = (label: string, an: number, si: number) => {
          const abs = Math.abs(si - an);
          rows.push([
            a.stationName,
            label,
            n(an, 4),
            n(si, 4),
            n(abs, 4),
            Number.isFinite(an) && an !== 0 ? `${((abs / Math.abs(an)) * 100).toFixed(2)}%` : 'n/a',
            a.exact ? 'exact closed form' : 'decomposition approximation',
          ]);
        };
        add('Utilisation', a.rho, s.metrics.utilization?.mean ?? 0);
        add('Lq', a.Lq, s.metrics.Lq?.mean ?? 0);
        add('Wq (min)', a.WqMinutes, s.metrics.WqMinutes?.mean ?? 0);
        return rows;
      }),
    ),
  );
  p(
    'Differences between the two columns are expected and have identifiable causes: (a) the ' +
      'simulation estimates from a finite sample, so each figure carries sampling error that grows ' +
      'sharply as utilisation approaches 1; (b) the closed-form models assume servers never fail, ' +
      'so where machine reliability is enabled the analytical figures understate queues; and ' +
      '(c) stations downstream of a non-exponential station do not receive Poisson arrivals, so ' +
      'their closed-form results are approximations.',
  );

  /* -------- 8. bottleneck -------- */
  h2('8. Bottleneck Analysis');
  p(
    `**Primary bottleneck: ${bottleneckName}.** Factory capacity is ` +
      `${n(bottleneck.factoryCapacityPerHour, 3)} vehicles/hour ` +
      `(${n(bottleneck.factoryCapacityPerDay, 1)} per ${n(model.investment.hoursPerDay.value, 0)}-hour day).`,
  );
  p(
    table(
      ['Rank', 'Station', 'rho', 'Max sustainable demand', 'Slack', 'Delay share', 'Gain from +1 server'],
      [...bottleneck.stations]
        .sort((a, b) => a.capacityRank - b.capacityRank)
        .map((s) => [
          s.capacityRank,
          s.stationName,
          pct(s.rho),
          `${n(s.lambdaMaxPerHour, 3)} veh/h`,
          `${n(s.slackPerHour, 3)} veh/h`,
          pct(s.delayShare),
          `+${n(s.throughputGainPerExtraServer, 3)} veh/h`,
        ]),
    ),
  );
  h3('8.1 Why');
  for (const s of [...bottleneck.stations].sort((a, b) => a.capacityRank - b.capacityRank).slice(0, 3)) {
    p(`**${s.stationName}**`);
    for (const r of s.reasons) p(`- ${r}`);
  }
  if (bottleneck.reliefPreview) p(`\n${bottleneck.reliefPreview.note}`);

  /* -------- 9. cost -------- */
  h2('9. Manufacturing Cost');
  p(
    `Costs below cover the ${n(cost.windowHours, 2)}-hour measurement window, during which ` +
      `${cost.vehiclesFinished} vehicles were finished and ${cost.vehiclesScrapped} scrapped.`,
  );
  p(
    table(
      ['Cost line', `Total (${sym})`, `Per vehicle (${sym})`, 'Share'],
      cost.lines.map((l) => [
        l.label,
        n(l.amount, 2),
        n(l.perVehicle, 2),
        pct(cost.totalManufacturingCost > 0 ? l.amount / cost.totalManufacturingCost : 0),
      ]),
    ),
  );
  const additivity = verifyAdditivity(cost);
  p(
    `**Total manufacturing cost: ${sym}${n(cost.totalManufacturingCost, 2)}** ` +
      `(${sym}${n(cost.costPerVehicle, 2)} per vehicle). The nine lines above partition the total ` +
      `exactly — sum of lines ${sym}${n(additivity.sumOfLines, 2)}, discrepancy ` +
      `${n(additivity.discrepancy, 6)} — so no cost is counted twice.`,
  );
  h3('9.1 How Each Line Is Calculated');
  for (const l of cost.lines) p(`- **${l.label}**: ${l.formula}`);

  h3('9.2 Costs Reported Outside Manufacturing Cost');
  p(
    table(
      ['Item', `Value (${sym})`, 'Why it is separate'],
      [
        [
          'Queue waiting cost',
          n(cost.waitingCost, 2),
          'An opportunity cost of delay, not a cost the plant pays. Adding it to manufacturing cost would overstate what a vehicle costs to build.',
        ],
        [
          'WIP holding cost',
          n(cost.wipHoldingCost, 2),
          'Carrying cost of inventory on the line; a financing cost rather than a conversion cost.',
        ],
        [
          'Total value lost to scrap',
          n(cost.scrapAnalysis.totalValueLost, 2),
          'Overlaps the labour, machine and energy lines: those period costs were paid whether or not the vehicle survived. Only the material component is additive.',
        ],
      ],
    ),
  );

  /* -------- 10. BOM -------- */
  h2('10. Vehicle Cost and Bill of Materials');
  for (const vm of model.vehicleModels) {
    const bom = expandBom(model, vm);
    h3(`10.x ${vm.name}`);
    p(
      table(
        ['Component', 'Qty', 'Unit', `Unit cost (${sym})`, 'Scrap allowance', 'Effective qty', `Total (${sym})`, 'Consumed at', 'Supplier'],
        bom.lines.map((l) => [
          l.name,
          n(l.quantityPerVehicle, 2),
          l.unit,
          n(l.unitCost, 2),
          pct(l.scrapAllowance),
          n(l.effectiveQuantity, 2),
          n(l.totalCost, 2),
          model.stations.find((s) => s.id === l.consumedAtStationId)?.name ?? l.consumedAtStationId,
          l.supplier ?? '—',
        ]),
      ),
    );
    p(
      `**Material cost per vehicle: ${sym}${n(bom.totalMaterialCost, 2)}** ` +
        `(component cost = quantity x (1 + scrap allowance) x unit cost). ` +
        `Rework material, charged per rework visit rather than per vehicle: ` +
        `${sym}${n(bom.reworkMaterialPerVisit, 2)}.`,
    );
    p(`**Selling price: ${sym}${n(vm.sellingPrice.value, 2)}** — ${vm.sellingPrice.provenance}.`);
  }

  /* -------- 11. financial -------- */
  h2('11. Financial Analysis');
  const annual = annualise(
    {
      windowHours: cost.windowHours,
      vehiclesFinished: cost.vehiclesFinished,
      revenue: cost.revenue,
      manufacturingCost: cost.totalManufacturingCost,
      waitingCost: cost.waitingCost,
    },
    model.investment,
  );
  p(
    table(
      ['Measure', 'Per window', 'Per year', 'Basis'],
      [
        ['Vehicles', n(cost.vehiclesFinished, 0), n(annual.vehiclesPerYear, 0), 'SIMULATED'],
        ['Revenue', `${sym}${n(cost.revenue, 2)}`, `${sym}${n(annual.revenuePerYear, 0)}`, 'SIMULATED'],
        [
          'Manufacturing cost',
          `${sym}${n(cost.totalManufacturingCost, 2)}`,
          `${sym}${n(annual.manufacturingCostPerYear, 0)}`,
          'SIMULATED',
        ],
        ['Profit', `${sym}${n(cost.grossProfit, 2)}`, `${sym}${n(annual.profitPerYear, 0)}`, 'SIMULATED'],
        ['Cost per vehicle', `${sym}${n(cost.costPerVehicle, 2)}`, '—', 'SIMULATED'],
        ['Profit per vehicle', `${sym}${n(cost.profitPerVehicle, 2)}`, '—', 'SIMULATED'],
        ['Margin', `${n(cost.marginPercent, 2)}%`, '—', 'SIMULATED'],
      ],
    ),
  );
  p(
    `Annualised on the plant calendar: ${n(model.investment.operatingDaysPerYear.value, 0)} operating ` +
      `days x ${n(model.investment.hoursPerDay.value, 1)} production hours = ` +
      `${n(annual.annualProductionHours, 0)} hours/year (ASSUMPTION).`,
  );

  if (input.appraisal) {
    h3('11.1 Investment Appraisal');
    const a = input.appraisal;
    p(
      table(
        ['Item', 'Value'],
        [
          ['Initial investment', `${sym}${n(a.initialInvestment, 2)}`],
          ['Additional annual operating cost', `${sym}${n(a.additionalAnnualOperatingCost, 2)}`],
          ['Additional vehicles per year', n(a.additionalVehiclesPerYear, 1)],
          ['Annual gross benefit', `${sym}${n(a.annualGrossBenefit, 2)}`],
          ['**Annual net benefit**', `**${sym}${n(a.annualNetBenefit, 2)}**`],
          ['ROI', a.roiPercent === null ? 'not defined (no investment)' : `${n(a.roiPercent, 2)}% per year`],
          [
            '**Payback period**',
            a.payback.achieved
              ? `**${n(a.payback.years, 2)} years (${n(a.payback.months, 1)} months)**`
              : '**NOT ACHIEVED**',
          ],
        ],
      ),
    );
    h3('11.2 Workings');
    for (const w of a.workings) p(`- ${w}`);
  }

  /* -------- 12. scenarios -------- */
  if (input.comparisons?.length) {
    h2('12. Scenario Comparison');
    for (const cmp of input.comparisons) {
      h3(`${cmp.baseline.scenario.name} vs ${cmp.proposed.scenario.name}`);
      if (cmp.proposed.edits.length) p(`Changes: ${cmp.proposed.edits.join('; ')}`);
      p(
        table(
          ['Metric', 'Baseline', 'Scenario', 'Change', '% change', 'Significant?'],
          cmp.rows.map((r) => [
            r.label,
            n(r.baseline, 3),
            n(r.scenario, 3),
            n(r.difference, 3),
            `${n(r.percentChange, 2)}%`,
            r.significant ? 'yes' : 'no — within sampling noise',
          ]),
        ),
      );
      p(`**Recommendation:** ${cmp.recommendation}`);
      for (const w of cmp.warnings) p(`> ${w}`);
    }
  }

  /* -------- 13. optimisation -------- */
  if (input.optimization) {
    h2('13. Optimisation Recommendation');
    const o = input.optimization;
    p(`Objective: **${o.objective}**. ${o.candidatesEvaluated} configurations evaluated, ${o.feasibleCount} feasible.`);
    for (const r of o.rationale) p(`- ${r}`);
    if (o.ranked.length) {
      p(
        table(
          ['Rank', 'Configuration', `Capital (${sym})`, 'Throughput/day', `Cost/vehicle (${sym})`, 'Wq (min)', 'ROI', 'Payback'],
          o.ranked.map((cnd, i) => [
            i + 1,
            Object.entries(cnd.configuration)
              .map(([k, v]) => `${model.stations.find((s) => s.id === k)?.name ?? k}=${v}`)
              .join(', '),
            n(cnd.initialInvestment, 0),
            n(cnd.confirmed?.throughputPerDay, 1),
            n(cnd.confirmed?.costPerVehicle, 2),
            n(cnd.confirmed?.WqMinutes, 2),
            cnd.confirmed?.roiPercent === null || cnd.confirmed?.roiPercent === undefined
              ? 'n/a'
              : `${n(cnd.confirmed.roiPercent, 1)}%`,
            cnd.confirmed?.paybackAchieved ? `${n(cnd.confirmed.paybackYears, 2)} yr` : 'not achieved',
          ]),
        ),
      );
    }
  }

  /* -------- 14. assumptions -------- */
  h2('14. Assumptions and Parameter Provenance');
  p(
    `${provenance.sourced} parameters are source-backed, ${provenance.assumptions} are project ` +
      `assumptions and ${provenance.userInput} were entered by the user.`,
  );
  if (provenance.sourced === 0) {
    p(
      '> **Every numeric parameter in this model is a PROJECT ASSUMPTION.** The figures are ' +
        'internally consistent and suitable for comparing configurations against each other, but ' +
        'none of them is a measured value from any real manufacturer and none should be quoted as ' +
        'an industry figure.',
    );
  }
  for (const a of model.assumptions ?? []) p(`- ${a}`);

  h3('14.1 Parameter Register');
  p(
    table(
      ['Parameter', 'Value', 'Unit', 'Provenance', 'Source / notes'],
      provenance.parameters.map((x) => [
        x.label,
        n(x.value, 4),
        x.unit,
        x.provenance,
        x.source ?? x.notes ?? '—',
      ]),
    ),
  );

  /* -------- 15. validation -------- */
  h2('15. Model Validation');
  p(
    table(
      ['Check', 'Result', 'Detail'],
      validation.checks.map((ch) => [ch.label, ch.passed ? 'PASS' : 'FAIL', ch.detail]),
    ),
  );
  if (validation.errors.length) {
    h3('15.1 Errors');
    for (const e of validation.errors) p(`- **${e.code}**: ${e.message}`);
  }
  if (validation.warnings.length) {
    h3('15.2 Warnings');
    for (const w of validation.warnings) p(`- **${w.code}**: ${w.message}`);
  }

  /* -------- 16. limitations -------- */
  h2('16. Limitations');
  for (const l of buildLimitations(model, study, net, cost)) p(`- ${l}`);

  /* -------- 17. sources -------- */
  h2('17. Sources');
  if ((model.sources ?? []).length === 0) {
    p(
      'No external sources are cited, because no parameter in this model is source-backed. ' +
        'The queueing and simulation methods used are standard and are described in:',
    );
  }
  for (const s of model.sources ?? []) p(`- ${s.citation}${s.url ? ` — ${s.url}` : ''}`);
  p('- Gross, Shortle, Thompson & Harris, *Fundamentals of Queueing Theory*, 4th ed., Wiley.');
  p('- Law, *Simulation Modeling and Analysis*, 5th ed., McGraw-Hill.');
  p('- Jackson, "Jobshop-like Queueing Systems", *Management Science* 10(1), 1963.');
  p('- Marsaglia & Tsang, "A Simple Method for Generating Gamma Variables", *ACM TOMS* 26(3), 2000.');

  return out.join('\n');
}

/**
 * Limitations derived from what this specific model does, rather than a fixed
 * paragraph. These are the caveats a reader could not otherwise infer from the
 * numbers.
 */
export function buildLimitations(
  model: SystemModel,
  study: StudyResult,
  net: ReturnType<typeof solveNetwork>,
  cost: CostResult,
): string[] {
  const out: string[] = [];

  if (study.replications === 1) {
    out.push(
      'Only one replication was run, so the results carry no confidence interval and represent a ' +
        'single sample path.',
    );
  } else {
    const t = study.system.throughput;
    if (t && Number.isFinite(t.relativeHalfWidth)) {
      out.push(
        `Throughput is estimated to within +/-${(t.relativeHalfWidth * 100).toFixed(1)}% at 95% ` +
          'confidence. Differences smaller than that between configurations are not distinguishable ' +
          'from sampling noise.',
      );
    }
  }

  const unstable = net.stations.filter((s) => !s.stable);
  if (unstable.length) {
    out.push(
      `${unstable.map((s) => s.stationName).join(', ')} ${unstable.length === 1 ? 'is' : 'are'} ` +
        'unstable (rho >= 1). Steady-state queueing results do not exist for these stations, and ' +
        'their simulated averages depend on the run length rather than describing a sustainable state.',
    );
  }

  const approx = net.stations.filter((s) => !s.exact);
  if (approx.length) {
    out.push(
      `Analytical results for ${approx.map((s) => s.stationName).join(', ')} are approximations: ` +
        'a non-exponential station upstream means their arrivals are not Poisson, so the ' +
        'closed-form M/M/c result does not apply exactly. The simulated figures are authoritative ' +
        'for these stations.',
    );
  }

  const unreliable = model.stations.filter((s) => s.machine?.reliability?.enabled);
  if (unreliable.length) {
    out.push(
      `Machine breakdowns are modelled at ${unreliable.map((s) => s.name).join(', ')}, but the ` +
        'closed-form models have no failing servers. The analytical columns therefore describe a ' +
        'factory whose machines never break and understate queues relative to the simulation.',
    );
  }

  out.push(
    'Transport time between stations is zero: a vehicle joins the next station\'s queue at the ' +
      'instant it leaves the previous one. Conveyor time would add a constant to cycle time without ' +
      'changing queueing behaviour.',
  );

  const bounded = model.stations.filter((s) => s.queueCapacity !== null);
  out.push(
    bounded.length
      ? `Buffers are finite at ${bounded.map((s) => s.name).join(', ')}; excess arrivals are rejected ` +
          'rather than blocking the upstream station, so upstream blocking is not represented.'
      : 'All queues are unbounded, so no station ever blocks its upstream neighbour. A real line with ' +
          'finite buffers would show blocking that this model does not.',
  );

  if (model.cost.laborCostBasis === 'scheduled') {
    out.push(
      'Labour is charged on a scheduled basis: crews are paid for the whole window whether busy or ' +
        'idle. Cost per vehicle therefore falls as throughput rises, and a short measurement window ' +
        'spreads the same wage bill over fewer vehicles.',
    );
  }

  if (model.arrivals.schedule.length > 1) {
    out.push(
      'Demand varies by time of day. Analytical results use the time-weighted average arrival rate ' +
        'and describe an average-case steady state; peak-period behaviour is visible only in the ' +
        'simulation.',
    );
  }

  const inSystem = study.representative.simulation.system.vehiclesInSystemAtEnd;
  if (inSystem > 0) {
    out.push(
      `${inSystem} vehicles were still in the factory when the horizon ended. They count towards WIP ` +
        'but have no cycle time, which biases the reported mean manufacturing time downwards.',
    );
  }

  if (cost.vehiclesFinished > 0 && cost.vehiclesFinished < 30) {
    out.push(
      `Only ${cost.vehiclesFinished} vehicles were completed per replication, so per-vehicle cost ` +
        'and cycle-time percentiles are estimated from a small sample. Lengthen the measurement ' +
        'window for stable percentiles.',
    );
  }

  return out;
}
