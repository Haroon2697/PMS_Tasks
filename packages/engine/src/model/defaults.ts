/**
 * Neutral defaults and small constructors for building models programmatically.
 *
 * Nothing here claims to describe a real factory. These are structural
 * defaults (zero costs, single shift, one exponential station) used by tests
 * and as the starting point when a user creates a blank system. The reference
 * manufacturing line with its documented assumptions lives in
 * `model/referenceModel.ts`.
 */

import type {
  CostConfig,
  CurrencySettings,
  InvestmentSpec,
  MachineSpec,
  SimulationConfig,
  Station,
  SystemModel,
  VehicleModel,
  WorkerCrew,
} from './types.js';
import { param, SINK_FINISHED } from './types.js';

export const CURRENCIES: Record<string, { symbol: string; name: string }> = {
  USD: { symbol: '$', name: 'US Dollar' },
  PKR: { symbol: 'Rs', name: 'Pakistani Rupee' },
  EUR: { symbol: '€', name: 'Euro' },
  GBP: { symbol: '£', name: 'Pound Sterling' },
  JPY: { symbol: '¥', name: 'Japanese Yen' },
  CNY: { symbol: '¥', name: 'Chinese Yuan' },
};

export function defaultCurrency(): CurrencySettings {
  return {
    code: 'USD',
    symbol: '$',
    rateFromBase: 1,
    rateSource: 'Base currency of the model; no conversion applied.',
  };
}

export function defaultCostConfig(): CostConfig {
  return {
    currency: defaultCurrency(),
    electricityPricePerKwh: param(0, 'currency/kWh', 'PROJECT_ASSUMPTION'),
    waitingCostPerVehicleHour: param(0, 'currency/vehicle-hour', 'PROJECT_ASSUMPTION'),
    wipHoldingCostPerVehicleHour: param(0, 'currency/vehicle-hour', 'PROJECT_ASSUMPTION'),
    laborCostBasis: 'scheduled',
    overhead: {
      mode: 'perHour',
      amount: param(0, 'currency/hour', 'PROJECT_ASSUMPTION'),
      breakdown: [],
    },
    preventiveMaintenancePerMachineHour: param(0, 'currency/machine-hour', 'PROJECT_ASSUMPTION'),
  };
}

export function defaultSimulationConfig(): SimulationConfig {
  return {
    seed: 12345,
    replications: 10,
    warmupMinutes: 60,
    durationMinutes: 8 * 60,
    terminationMode: 'hardStop',
    collectVehicleTraces: true,
    maxTraces: 500,
  };
}

export function defaultInvestment(): InvestmentSpec {
  return {
    initialInvestment: param(0, 'currency', 'USER_INPUT'),
    additionalAnnualOperatingCost: param(0, 'currency/year', 'USER_INPUT'),
    operatingDaysPerYear: param(250, 'days/year', 'PROJECT_ASSUMPTION', {
      notes: 'Five-day week, 50 working weeks. Change to match the plant calendar.',
    }),
    hoursPerDay: param(8, 'hours/day', 'PROJECT_ASSUMPTION', {
      notes: 'One production shift per day.',
    }),
    items: [],
  };
}

export function makeCrew(
  id: string,
  role: WorkerCrew['role'],
  count: number,
  wagePerHour: number,
): WorkerCrew {
  return {
    id,
    role,
    count,
    hourlyWage: param(wagePerHour, 'currency/hour', 'PROJECT_ASSUMPTION'),
    overtimeMultiplier: param(1.5, 'multiplier', 'PROJECT_ASSUMPTION'),
    shiftHours: param(8, 'hours/shift', 'PROJECT_ASSUMPTION'),
  };
}

export function makeMachine(
  id: string,
  name: string,
  opts: Partial<{
    purchasePrice: number;
    usefulLifeYears: number;
    salvageValue: number;
    annualOperatingHours: number;
    powerKw: number;
    idlePowerKw: number;
    maintenanceCostPerHour: number;
    consumablesCostPerHour: number;
    includeDepreciation: boolean;
    mtbfHours: number;
    mttrHours: number;
    repairCostPerHour: number;
    reliabilityEnabled: boolean;
  }> = {},
): MachineSpec {
  const spec: MachineSpec = {
    id,
    name,
    purchasePrice: param(opts.purchasePrice ?? 0, 'currency', 'PROJECT_ASSUMPTION'),
    usefulLifeYears: param(opts.usefulLifeYears ?? 10, 'years', 'PROJECT_ASSUMPTION'),
    salvageValue: param(opts.salvageValue ?? 0, 'currency', 'PROJECT_ASSUMPTION'),
    annualOperatingHours: param(opts.annualOperatingHours ?? 2000, 'hours/year', 'PROJECT_ASSUMPTION'),
    powerKw: param(opts.powerKw ?? 0, 'kW', 'PROJECT_ASSUMPTION'),
    idlePowerKw: param(opts.idlePowerKw ?? 0, 'kW', 'PROJECT_ASSUMPTION'),
    maintenanceCostPerHour: param(opts.maintenanceCostPerHour ?? 0, 'currency/hour', 'PROJECT_ASSUMPTION'),
    consumablesCostPerHour: param(opts.consumablesCostPerHour ?? 0, 'currency/hour', 'PROJECT_ASSUMPTION'),
    includeDepreciation: opts.includeDepreciation ?? true,
  };
  if (opts.reliabilityEnabled) {
    spec.reliability = {
      enabled: true,
      mtbfHours: param(opts.mtbfHours ?? 200, 'operating hours', 'PROJECT_ASSUMPTION'),
      mttrHours: param(opts.mttrHours ?? 2, 'hours', 'PROJECT_ASSUMPTION'),
      repairCostPerHour: param(opts.repairCostPerHour ?? 0, 'currency/hour', 'PROJECT_ASSUMPTION'),
      failureDist: 'exponential',
      repairDist: 'exponential',
    };
  }
  return spec;
}

/** A bare station: one exponential server, everything routed to FINISHED. */
export function makeStation(id: string, name: string, meanServiceMinutes: number, servers = 1): Station {
  return {
    id,
    name,
    kind: 'process',
    servers,
    queueDiscipline: 'FIFO',
    queueCapacity: null,
    service: { kind: 'exponential', mean: meanServiceMinutes },
    workers: [],
    routing: [{ to: SINK_FINISHED, probability: 1, label: 'Finished' }],
    scrapProbability: 0,
  };
}

export function makeVehicleModel(id: string, name: string, sellingPrice = 0): VehicleModel {
  return {
    id,
    name,
    bom: [],
    sellingPrice: param(sellingPrice, 'currency/vehicle', 'PROJECT_ASSUMPTION'),
  };
}

/**
 * Minimal single-station system, used as the analytical validation harness
 * (requirement 59): one M/M/c queue with everything else switched off.
 */
export function makeSingleStationModel(opts: {
  lambdaPerHour: number;
  meanServiceMinutes: number;
  servers?: number;
  seed?: number;
  warmupMinutes?: number;
  durationMinutes?: number;
}): SystemModel {
  const station = makeStation('s1', 'Station 1', opts.meanServiceMinutes, opts.servers ?? 1);
  station.kind = 'source';
  const sim = defaultSimulationConfig();
  sim.seed = opts.seed ?? 12345;
  sim.replications = 1;
  sim.warmupMinutes = opts.warmupMinutes ?? 5000;
  sim.durationMinutes = opts.durationMinutes ?? 1_200_000;
  sim.collectVehicleTraces = false;
  sim.maxTraces = 0;

  return {
    id: 'validation-single',
    name: 'Single-station validation model',
    description:
      'One queue in isolation, used to check the simulator against closed-form results.',
    stations: [station],
    arrivals: {
      entryStationId: 's1',
      schedule: [
        {
          startMinute: 0,
          endMinute: sim.warmupMinutes + sim.durationMinutes,
          lambdaPerHour: param(opts.lambdaPerHour, 'vehicles/hour', 'USER_INPUT'),
        },
      ],
      interarrivalKind: 'exponential',
      modelMix: [{ modelId: 'm1', share: 1 }],
    },
    vehicleModels: [makeVehicleModel('m1', 'Generic vehicle')],
    cost: defaultCostConfig(),
    simulation: sim,
    investment: defaultInvestment(),
  };
}
