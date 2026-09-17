/**
 * Model and input validation — requirements 50 and 51.
 *
 * Two distinct jobs, deliberately kept apart:
 *
 *  ERRORS   are structural: the model cannot be simulated at all, or would
 *           produce meaningless numbers. Requirement 51 lists them — lambda or
 *           mu <= 0, servers < 1, negative costs or times, probabilities
 *           outside [0,1], routing that does not sum to 1. A model with errors
 *           must not be run.
 *
 *  WARNINGS are modelling judgements: the model is valid and will run, but
 *           something about it deserves attention — a station near saturation,
 *           a queue with no exit, an unsourced parameter driving a headline
 *           number. Requirement 50's example report is exactly this.
 *
 * Refusing to run on a warning would be as wrong as running silently on an
 * error, so the two never mix.
 */

import { distMean, kendallSymbol } from '../distributions.js';
import { solveNetwork } from '../analytical/network.js';
import { capacityLimit } from '../analytical/network.js';
import { meanExternalLambda } from '../analytical/traffic.js';
import { isSink, SINK_FINISHED, SINK_SCRAP, type SystemModel } from '../model/types.js';

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: Severity;
  /** Stable code so the UI can link an issue to the field that caused it. */
  code: string;
  message: string;
  /** Where the problem is, for deep-linking into the parameter editor. */
  path?: { stationId?: string; field?: string; componentId?: string };
  /** What the user should do about it. */
  remedy?: string;
}

export interface ValidationReport {
  valid: boolean;
  /** True when the model can be simulated (no errors). */
  runnable: boolean;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
  checks: { label: string; passed: boolean; detail: string }[];
  summary: {
    stationCount: number;
    stableStations: number;
    totalStations: number;
    externalLambda: number;
    factoryCapacityPerHour: number;
    bottleneckStationName: string | null;
    assumptionCount: number;
    sourcedCount: number;
  };
}

/* ------------------------------------------------------------------ */

export function validateModel(model: SystemModel): ValidationReport {
  const issues: ValidationIssue[] = [];
  const checks: ValidationReport['checks'] = [];

  const err = (code: string, message: string, path?: ValidationIssue['path'], remedy?: string) =>
    issues.push({ severity: 'error', code, message, path, remedy });
  const warn = (code: string, message: string, path?: ValidationIssue['path'], remedy?: string) =>
    issues.push({ severity: 'warning', code, message, path, remedy });
  const info = (code: string, message: string, path?: ValidationIssue['path']) =>
    issues.push({ severity: 'info', code, message, path });

  /* ---- structure ---- */

  if (model.stations.length === 0) {
    err('no-stations', 'The model has no production stations.', undefined, 'Add at least one station.');
  }

  const ids = new Set<string>();
  for (const s of model.stations) {
    if (ids.has(s.id)) {
      err('duplicate-station-id', `Two stations share the id "${s.id}".`, { stationId: s.id });
    }
    ids.add(s.id);
  }

  /* ---- arrivals (requirement 7) ---- */

  const entry = model.stations.find((s) => s.id === model.arrivals.entryStationId);
  if (!entry) {
    err(
      'bad-entry-station',
      `The arrival entry station "${model.arrivals.entryStationId}" does not exist.`,
      { field: 'arrivals.entryStationId' },
      'Point the arrival process at a station in the model.',
    );
  }
  checks.push({
    label: 'External arrival point defined',
    passed: !!entry,
    detail: entry
      ? `External lambda is defined only at ${entry.name}; every other station's arrival rate is derived from routing.`
      : 'No valid entry station.',
  });

  if (model.arrivals.schedule.length === 0) {
    err('no-demand', 'The demand schedule is empty, so no vehicles would ever arrive.', {
      field: 'arrivals.schedule',
    });
  }

  let previousEnd: number | null = null;
  for (const [i, b] of model.arrivals.schedule.entries()) {
    if (b.lambdaPerHour.value <= 0) {
      err(
        'lambda-non-positive',
        `Demand block ${i + 1} has lambda = ${b.lambdaPerHour.value} vehicles/hour. Arrival rate must be > 0.`,
        { field: `arrivals.schedule[${i}].lambdaPerHour` },
        'Set a positive arrival rate, or remove the block if the line is idle then.',
      );
    }
    if (b.endMinute <= b.startMinute) {
      err(
        'bad-demand-block',
        `Demand block ${i + 1} ends at minute ${b.endMinute}, which is not after its start at ${b.startMinute}.`,
        { field: `arrivals.schedule[${i}]` },
      );
    }
    if (previousEnd !== null && b.startMinute > previousEnd) {
      warn(
        'demand-gap',
        `There is a gap in the demand schedule between minute ${previousEnd} and ${b.startMinute}. ` +
          'No vehicles arrive during it.',
        { field: `arrivals.schedule[${i}]` },
        'Add a block covering the gap, or confirm the line is genuinely idle then.',
      );
    }
    if (previousEnd !== null && b.startMinute < previousEnd) {
      err(
        'demand-overlap',
        `Demand block ${i + 1} starts at minute ${b.startMinute}, overlapping the previous block which ` +
          `ends at ${previousEnd}. Overlapping blocks make the arrival rate ambiguous.`,
        { field: `arrivals.schedule[${i}]` },
      );
    }
    previousEnd = b.endMinute;
  }

  const mixTotal = model.arrivals.modelMix.reduce((a, m) => a + m.share, 0);
  if (Math.abs(mixTotal - 1) > 1e-6) {
    err(
      'model-mix-sum',
      `Vehicle model shares sum to ${mixTotal.toFixed(4)}, not 1.0.`,
      { field: 'arrivals.modelMix' },
      'Adjust the shares so they total 100%.',
    );
  }
  for (const m of model.arrivals.modelMix) {
    if (!model.vehicleModels.some((v) => v.id === m.modelId)) {
      err('unknown-model', `The arrival mix references unknown vehicle model "${m.modelId}".`, {
        field: 'arrivals.modelMix',
      });
    }
  }

  /* ---- per-station parameters (requirement 51) ---- */

  for (const s of model.stations) {
    const p = { stationId: s.id };

    if (!Number.isInteger(s.servers) || s.servers < 1) {
      err(
        'servers-invalid',
        `${s.name}: server count is ${s.servers}. It must be a whole number of at least 1.`,
        { ...p, field: 'servers' },
      );
    }
    const meanService = distMean(s.service);
    if (!(meanService > 0) || !Number.isFinite(meanService)) {
      err(
        'service-invalid',
        `${s.name}: mean service time is ${meanService}. Processing time must be positive and finite ` +
          '(so mu = 60 / mean service time is positive).',
        { ...p, field: 'service' },
      );
    }
    if (s.scrapProbability < 0 || s.scrapProbability > 1) {
      err(
        'scrap-probability',
        `${s.name}: scrap probability is ${s.scrapProbability}. Probabilities must lie in [0, 1].`,
        { ...p, field: 'scrapProbability' },
      );
    }
    if (s.queueCapacity !== null && (!Number.isInteger(s.queueCapacity) || s.queueCapacity < 0)) {
      err(
        'queue-capacity',
        `${s.name}: queue capacity is ${s.queueCapacity}. Use a non-negative whole number, or leave ` +
          'it unset for an unbounded queue.',
        { ...p, field: 'queueCapacity' },
      );
    }

    /* routing */
    let sum = 0;
    for (const e of s.routing) {
      if (e.probability < 0 || e.probability > 1) {
        err(
          'routing-probability',
          `${s.name} -> ${e.to}: routing probability ${e.probability} is outside [0, 1].`,
          { ...p, field: 'routing' },
        );
      }
      sum += e.probability;
      if (!isSink(e.to) && !ids.has(e.to)) {
        err('routing-unknown-target', `${s.name} routes to "${e.to}", which is not a station.`, {
          ...p,
          field: 'routing',
        });
      }
    }
    if (s.routing.length === 0) {
      warn(
        'no-routing',
        `${s.name} has no outgoing routes. Vehicles completing here are treated as finished.`,
        { ...p, field: 'routing' },
        'Add an explicit route to the finished sink to make the intent clear.',
      );
    } else if (Math.abs(sum - 1) > 1e-6) {
      err(
        'routing-sum',
        `${s.name}: routing probabilities sum to ${sum.toFixed(4)}, not 1.0. Every vehicle leaving a ` +
          'station must go somewhere, so the probabilities must total exactly 1.',
        { ...p, field: 'routing' },
        `Adjust the arcs so they total 1.0 (currently off by ${(sum - 1).toFixed(4)}).`,
      );
    }

    /* workers */
    for (const w of s.workers) {
      if (w.count < 0 || !Number.isInteger(w.count)) {
        err(`worker-count`, `${s.name} / ${w.role}: headcount ${w.count} must be a non-negative whole number.`, {
          ...p,
          field: 'workers',
        });
      }
      if (w.hourlyWage.value < 0) {
        err('negative-wage', `${s.name} / ${w.role}: hourly wage cannot be negative.`, {
          ...p,
          field: 'workers',
        });
      }
      if (w.shiftHours.value <= 0) {
        err('shift-hours', `${s.name} / ${w.role}: shift length must be positive.`, { ...p, field: 'workers' });
      }
      if (w.overtimeMultiplier.value < 1) {
        warn(
          'overtime-below-one',
          `${s.name} / ${w.role}: overtime multiplier is ${w.overtimeMultiplier.value}, below 1.0, which ` +
            'means overtime is paid at LESS than the straight-time rate.',
          { ...p, field: 'workers' },
        );
      }
    }
    if (s.workers.length === 0) {
      warn(
        'no-workers',
        `${s.name} has no workers assigned, so it contributes no labour cost.`,
        { ...p, field: 'workers' },
        'Assign a crew, or confirm the station is fully automated.',
      );
    }

    /* machine */
    const m = s.machine;
    if (m) {
      const negatives: [string, number][] = [
        ['purchase price', m.purchasePrice.value],
        ['salvage value', m.salvageValue.value],
        ['power', m.powerKw.value],
        ['idle power', m.idlePowerKw.value],
        ['maintenance cost/hour', m.maintenanceCostPerHour.value],
        ['consumables cost/hour', m.consumablesCostPerHour.value],
      ];
      for (const [label, value] of negatives) {
        if (value < 0) {
          err('negative-machine-cost', `${s.name} / ${m.name}: ${label} cannot be negative.`, {
            ...p,
            field: 'machine',
          });
        }
      }
      if (m.usefulLifeYears.value <= 0) {
        err('useful-life', `${s.name} / ${m.name}: useful life must be positive.`, { ...p, field: 'machine' });
      }
      if (m.annualOperatingHours.value <= 0 && m.includeDepreciation) {
        err(
          'annual-hours',
          `${s.name} / ${m.name}: annual operating hours must be positive when depreciation is included ` +
            '(it is the denominator of the hourly depreciation charge).',
          { ...p, field: 'machine' },
        );
      }
      if (m.salvageValue.value > m.purchasePrice.value) {
        warn(
          'salvage-exceeds-price',
          `${s.name} / ${m.name}: salvage value exceeds purchase price, giving negative depreciation.`,
          { ...p, field: 'machine' },
        );
      }
      if (m.idlePowerKw.value > m.powerKw.value && m.powerKw.value > 0) {
        warn(
          'idle-power-high',
          `${s.name} / ${m.name}: idle power draw (${m.idlePowerKw.value} kW) exceeds running power ` +
            `(${m.powerKw.value} kW).`,
          { ...p, field: 'machine' },
        );
      }
      const rel = m.reliability;
      if (rel?.enabled) {
        if (rel.mtbfHours.value <= 0) {
          err('mtbf', `${s.name} / ${m.name}: MTBF must be positive when reliability is enabled.`, {
            ...p,
            field: 'machine.reliability',
          });
        }
        if (rel.mttrHours.value < 0) {
          err('mttr', `${s.name} / ${m.name}: MTTR cannot be negative.`, { ...p, field: 'machine.reliability' });
        }
        const availability = rel.mtbfHours.value / (rel.mtbfHours.value + rel.mttrHours.value);
        if (availability < 0.8) {
          warn(
            'low-availability',
            `${s.name} / ${m.name}: availability is only ${(availability * 100).toFixed(1)}% ` +
              `(MTBF ${rel.mtbfHours.value}h, MTTR ${rel.mttrHours.value}h). Effective capacity is ` +
              'reduced by roughly that much.',
            { ...p, field: 'machine.reliability' },
          );
        }
      }
    }
  }

  /* ---- BOM (requirement 14) ---- */

  for (const vm of model.vehicleModels) {
    if (vm.sellingPrice.value < 0) {
      err('negative-price', `${vm.name}: selling price cannot be negative.`, { field: 'sellingPrice' });
    }
    if (vm.bom.length === 0) {
      warn(
        'empty-bom',
        `${vm.name} has no bill of materials, so its material cost is zero.`,
        { field: 'bom' },
        'Add the components consumed per vehicle.',
      );
    }
    for (const c of vm.bom) {
      if (c.quantityPerVehicle < 0) {
        err('negative-quantity', `${vm.name} / ${c.name}: quantity cannot be negative.`, {
          componentId: c.id,
        });
      }
      if (c.unitCost.value < 0) {
        err('negative-unit-cost', `${vm.name} / ${c.name}: unit cost cannot be negative.`, {
          componentId: c.id,
        });
      }
      if (c.scrapAllowance < 0 || c.scrapAllowance > 1) {
        err(
          'scrap-allowance',
          `${vm.name} / ${c.name}: scrap allowance ${c.scrapAllowance} is outside [0, 1].`,
          { componentId: c.id },
        );
      }
      if (!ids.has(c.consumedAtStationId)) {
        err(
          'bom-station',
          `${vm.name} / ${c.name} is consumed at "${c.consumedAtStationId}", which is not a station.`,
          { componentId: c.id },
        );
      }
    }
  }

  /* ---- cost configuration ---- */

  const c = model.cost;
  const costNegatives: [string, number][] = [
    ['electricity price', c.electricityPricePerKwh.value],
    ['waiting cost', c.waitingCostPerVehicleHour.value],
    ['WIP holding cost', c.wipHoldingCostPerVehicleHour.value],
    ['overhead', c.overhead.amount.value],
    ['preventive maintenance rate', c.preventiveMaintenancePerMachineHour.value],
  ];
  for (const [label, value] of costNegatives) {
    if (value < 0) err('negative-cost', `Cost parameter "${label}" cannot be negative.`, { field: label });
  }
  const breakdownSum = c.overhead.breakdown.reduce((a, b) => a + b.amount.value, 0);
  if (c.overhead.breakdown.length > 0 && Math.abs(breakdownSum - c.overhead.amount.value) > 0.01) {
    warn(
      'overhead-breakdown-mismatch',
      `The overhead breakdown sums to ${breakdownSum.toFixed(2)} but the total overhead rate is ` +
        `${c.overhead.amount.value.toFixed(2)}. The total is what gets charged; the breakdown is only ` +
        'used for the cost-detail view, so the two disagreeing makes the detail misleading.',
      { field: 'overhead' },
      'Adjust the breakdown items so they sum to the total rate.',
    );
  }

  /* ---- simulation configuration (requirements 44, 45) ---- */

  const sim = model.simulation;
  if (sim.durationMinutes <= 0) {
    err('duration', 'Simulation duration must be greater than zero.', { field: 'simulation.durationMinutes' });
  }
  if (sim.warmupMinutes < 0) {
    err('warmup-negative', 'Warm-up period cannot be negative.', { field: 'simulation.warmupMinutes' });
  }
  if (sim.replications < 1 || !Number.isInteger(sim.replications)) {
    err('replications', 'Replication count must be a whole number of at least 1.', {
      field: 'simulation.replications',
    });
  }
  if (sim.replications === 1) {
    warn(
      'single-replication',
      'Only one replication is configured, so no confidence interval can be produced and the results ' +
        'are a single sample path.',
      { field: 'simulation.replications' },
      'Use 10 or more replications before comparing scenarios.',
    );
  }
  if (sim.warmupMinutes === 0 && sim.durationMinutes > 0) {
    warn(
      'no-warmup',
      'No warm-up period is configured. The factory starts empty, which biases average WIP and ' +
        'waiting time downwards.',
      { field: 'simulation.warmupMinutes' },
      'Set a warm-up of at least a few times the expected cycle time.',
    );
  }

  /* ---- solvable? then stability (requirement 9) ---- */

  const hardErrors = issues.filter((i) => i.severity === 'error');
  let stableStations = 0;
  let externalLambda = 0;
  let factoryCapacityPerHour = 0;
  let bottleneckStationName: string | null = null;

  if (hardErrors.length === 0) {
    try {
      const net = solveNetwork(model);
      externalLambda = net.system.lambdaExternal;
      const cap = capacityLimit(model);
      factoryCapacityPerHour = cap.lambdaMaxPerHour;
      bottleneckStationName =
        model.stations.find((s) => s.id === cap.bindingStationId)?.name ?? null;

      for (const s of net.stations) {
        if (s.stable) stableStations++;
        if (!s.stable) {
          warn(
            'unstable-queue',
            `${s.stationName}: UNSTABLE QUEUE. rho = ${(s.rho * 100).toFixed(1)}% >= 100%, so arrivals ` +
              'meet or exceed capacity. No finite steady-state queue length or waiting time exists. ' +
              'The simulation will still run over a finite horizon, but its queue statistics reflect ' +
              'the horizon rather than a steady state.',
            { stationId: s.stationId, field: 'servers' },
            'Add servers, raise the service rate, or reduce demand.',
          );
        } else if (s.rho >= 0.9) {
          warn(
            'high-utilisation',
            `${s.stationName}: utilisation ${(s.rho * 100).toFixed(1)}%. Queue length rises very ` +
              'steeply in this region — a small increase in demand or any loss of capacity will ' +
              'produce a large increase in waiting time.',
            { stationId: s.stationId, field: 'servers' },
          );
        }
        const def = model.stations.find((x) => x.id === s.stationId);
        if (def?.queueCapacity != null && Number.isFinite(s.Lq) && s.Lq > def.queueCapacity * 0.7) {
          warn(
            'queue-near-capacity',
            `${s.stationName}: the average queue (${s.Lq.toFixed(1)}) is approaching the configured ` +
              `buffer capacity of ${def.queueCapacity}. Vehicles will be rejected once it fills, and ` +
              'the analytical figures above assume an unbounded queue so they overstate the queue ' +
              'that can actually form.',
            { stationId: s.stationId, field: 'queueCapacity' },
          );
        }
      }

      checks.push({
        label: 'Queue stability',
        passed: stableStations === net.stations.length,
        detail: `${stableStations}/${net.stations.length} stations have rho < 1.`,
      });
      checks.push({
        label: 'Traffic equations solvable',
        passed: true,
        detail:
          `Derived arrival rates from external lambda = ${externalLambda.toFixed(2)}/hour. ` +
          `Factory capacity ${factoryCapacityPerHour.toFixed(2)}/hour, constrained by ` +
          `${bottleneckStationName ?? 'n/a'}.`,
      });
      checks.push({
        label: 'Flow conservation',
        passed: !net.traffic.warnings.some((w) => w.includes('conservation')),
        detail: `Finished ${net.system.throughputFinished.toFixed(3)}/hour + scrap ` +
          `${net.system.throughputScrap.toFixed(3)}/hour = external ${externalLambda.toFixed(3)}/hour.`,
      });

      for (const w of net.warnings) info('analytical-note', w);

      if (externalLambda > factoryCapacityPerHour) {
        warn(
          'demand-exceeds-capacity',
          `Average demand (${externalLambda.toFixed(2)} vehicles/hour) exceeds factory capacity ` +
            `(${factoryCapacityPerHour.toFixed(2)} vehicles/hour). The factory cannot keep up, so WIP ` +
            'grows throughout the run and the reported averages depend on the run length.',
          { field: 'arrivals' },
        );
      }

      // Peak-period check: the schedule's highest block, not just the average.
      const peak = Math.max(...model.arrivals.schedule.map((b) => b.lambdaPerHour.value), 0);
      if (peak > factoryCapacityPerHour && externalLambda <= factoryCapacityPerHour) {
        warn(
          'peak-exceeds-capacity',
          `Peak demand (${peak.toFixed(2)} vehicles/hour) exceeds factory capacity ` +
            `(${factoryCapacityPerHour.toFixed(2)}/hour) even though average demand does not. A queue ` +
            'will build during the peak and drain afterwards; steady-state figures will not show this.',
          { field: 'arrivals.schedule' },
        );
      }
    } catch (e) {
      err(
        'network-unsolvable',
        `The traffic equations could not be solved: ${(e as Error).message}`,
        { field: 'routing' },
      );
      checks.push({ label: 'Traffic equations solvable', passed: false, detail: (e as Error).message });
    }
  }

  /* ---- reachability ---- */

  if (entry && hardErrors.length === 0) {
    const reachable = new Set<string>([entry.id]);
    const stack = [entry.id];
    while (stack.length) {
      const id = stack.pop() as string;
      const st = model.stations.find((s) => s.id === id);
      if (!st) continue;
      for (const e of st.routing) {
        if (e.probability > 0 && !isSink(e.to) && !reachable.has(e.to)) {
          reachable.add(e.to);
          stack.push(e.to);
        }
      }
    }
    for (const s of model.stations) {
      if (!reachable.has(s.id)) {
        warn(
          'unreachable-station',
          `${s.name} cannot be reached from the arrival point, so no vehicle will ever visit it. It ` +
            'still incurs labour, overhead and standby energy cost.',
          { stationId: s.id },
          'Route work to it, or remove it from the model.',
        );
      }
    }
    const reachesFinish = model.stations.some((s) =>
      s.routing.some((e) => e.to === SINK_FINISHED && e.probability > 0),
    );
    checks.push({
      label: 'Finished-vehicle exit exists',
      passed: reachesFinish,
      detail: reachesFinish
        ? 'At least one station routes to the finished-vehicle sink.'
        : 'No station routes to the finished-vehicle sink — no vehicle can ever complete.',
    });
    if (!reachesFinish) {
      err(
        'no-exit',
        'No station routes vehicles to the finished sink, so no vehicle can ever be completed.',
        { field: 'routing' },
      );
    }
  }

  /* ---- provenance (requirement 46) ---- */

  const provenance = collectProvenance(model);
  checks.push({
    label: 'Parameter provenance recorded',
    passed: true,
    detail:
      `${provenance.sourced} source-backed, ${provenance.assumptions} project assumptions, ` +
      `${provenance.userInput} user inputs. Every figure in the dashboard is traceable to one of these.`,
  });
  if (provenance.sourced === 0 && provenance.assumptions > 0) {
    info(
      'all-assumptions',
      `All ${provenance.assumptions} numeric parameters are PROJECT ASSUMPTIONS. No result from this ` +
        'model should be quoted as an industry figure. Replace parameters with sourced values and ' +
        'mark them SOURCE_BACKED to change this.',
    );
  }
  for (const s of model.sources ?? []) {
    if (!s.citation || s.citation.trim().length === 0) {
      warn('empty-citation', `Source "${s.id}" has no citation text.`);
    }
  }

  checks.push({
    label: 'Kendall notation matches configured distributions',
    passed: true,
    detail: model.stations
      .map((s) => `${s.name} = M/${kendallSymbol(s.service)}/${s.servers}`)
      .join('; '),
  });

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');

  return {
    valid: errors.length === 0 && warnings.length === 0,
    runnable: errors.length === 0,
    issues,
    errors,
    warnings,
    info: infos,
    checks,
    summary: {
      stationCount: model.stations.length,
      stableStations,
      totalStations: model.stations.length,
      externalLambda: externalLambda || meanExternalLambda(model).lambda,
      factoryCapacityPerHour,
      bottleneckStationName,
      assumptionCount: provenance.assumptions,
      sourcedCount: provenance.sourced,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Provenance census (requirement 46)                                  */
/* ------------------------------------------------------------------ */

export interface ProvenanceCensus {
  sourced: number;
  assumptions: number;
  userInput: number;
  derived: number;
  /** Every parameter, for the assumptions register in the report. */
  parameters: {
    path: string;
    label: string;
    value: number;
    unit: string;
    provenance: string;
    source?: string;
    notes?: string;
  }[];
}

/** Walk the model and collect every Param with its provenance. */
export function collectProvenance(model: SystemModel): ProvenanceCensus {
  const parameters: ProvenanceCensus['parameters'] = [];

  const add = (path: string, label: string, p: { value: number; unit: string; provenance: string; source?: string; notes?: string }) => {
    parameters.push({
      path,
      label,
      value: p.value,
      unit: p.unit,
      provenance: p.provenance,
      source: p.source,
      notes: p.notes,
    });
  };

  model.arrivals.schedule.forEach((b, i) => {
    add(`arrivals.schedule[${i}].lambdaPerHour`, b.label ?? `Demand block ${i + 1}`, b.lambdaPerHour);
  });

  for (const s of model.stations) {
    for (const w of s.workers) {
      add(`stations.${s.id}.workers.${w.id}.hourlyWage`, `${s.name} / ${w.role} wage`, w.hourlyWage);
      add(`stations.${s.id}.workers.${w.id}.shiftHours`, `${s.name} / ${w.role} shift`, w.shiftHours);
      add(
        `stations.${s.id}.workers.${w.id}.overtimeMultiplier`,
        `${s.name} / ${w.role} overtime`,
        w.overtimeMultiplier,
      );
    }
    const m = s.machine;
    if (m) {
      add(`stations.${s.id}.machine.purchasePrice`, `${s.name} / ${m.name} price`, m.purchasePrice);
      add(`stations.${s.id}.machine.usefulLifeYears`, `${s.name} / ${m.name} life`, m.usefulLifeYears);
      add(`stations.${s.id}.machine.salvageValue`, `${s.name} / ${m.name} salvage`, m.salvageValue);
      add(`stations.${s.id}.machine.annualOperatingHours`, `${s.name} / ${m.name} annual hours`, m.annualOperatingHours);
      add(`stations.${s.id}.machine.powerKw`, `${s.name} / ${m.name} power`, m.powerKw);
      add(`stations.${s.id}.machine.idlePowerKw`, `${s.name} / ${m.name} idle power`, m.idlePowerKw);
      add(`stations.${s.id}.machine.maintenanceCostPerHour`, `${s.name} / ${m.name} maintenance`, m.maintenanceCostPerHour);
      add(`stations.${s.id}.machine.consumablesCostPerHour`, `${s.name} / ${m.name} consumables`, m.consumablesCostPerHour);
      if (m.reliability) {
        add(`stations.${s.id}.machine.reliability.mtbfHours`, `${s.name} / ${m.name} MTBF`, m.reliability.mtbfHours);
        add(`stations.${s.id}.machine.reliability.mttrHours`, `${s.name} / ${m.name} MTTR`, m.reliability.mttrHours);
        add(
          `stations.${s.id}.machine.reliability.repairCostPerHour`,
          `${s.name} / ${m.name} repair cost`,
          m.reliability.repairCostPerHour,
        );
      }
    }
  }

  for (const vm of model.vehicleModels) {
    add(`vehicleModels.${vm.id}.sellingPrice`, `${vm.name} selling price`, vm.sellingPrice);
    for (const comp of vm.bom) {
      add(`vehicleModels.${vm.id}.bom.${comp.id}.unitCost`, `${vm.name} / ${comp.name}`, comp.unitCost);
    }
  }

  const c = model.cost;
  add('cost.electricityPricePerKwh', 'Electricity price', c.electricityPricePerKwh);
  add('cost.waitingCostPerVehicleHour', 'Waiting cost', c.waitingCostPerVehicleHour);
  add('cost.wipHoldingCostPerVehicleHour', 'WIP holding cost', c.wipHoldingCostPerVehicleHour);
  add('cost.overhead.amount', 'Overhead rate', c.overhead.amount);
  for (const b of c.overhead.breakdown) add(`cost.overhead.${b.id}`, b.name, b.amount);
  add('cost.preventiveMaintenancePerMachineHour', 'Preventive maintenance rate', c.preventiveMaintenancePerMachineHour);

  add('investment.operatingDaysPerYear', 'Operating days per year', model.investment.operatingDaysPerYear);
  add('investment.hoursPerDay', 'Production hours per day', model.investment.hoursPerDay);
  add('investment.initialInvestment', 'Initial investment', model.investment.initialInvestment);
  add(
    'investment.additionalAnnualOperatingCost',
    'Additional annual operating cost',
    model.investment.additionalAnnualOperatingCost,
  );

  return {
    sourced: parameters.filter((p) => p.provenance === 'SOURCE_BACKED').length,
    assumptions: parameters.filter((p) => p.provenance === 'PROJECT_ASSUMPTION').length,
    userInput: parameters.filter((p) => p.provenance === 'USER_INPUT').length,
    derived: parameters.filter((p) => p.provenance === 'DERIVED').length,
    parameters,
  };
}

/** Sinks are referenced by routing validation; re-exported for the UI. */
export const ROUTING_TARGETS = { SINK_FINISHED, SINK_SCRAP };
