/**
 * Domain model for the manufacturing system.
 *
 * Requirement 46/48: every configurable number carries its unit and its
 * provenance, so the UI can show where each figure came from and no value can
 * silently masquerade as an industry fact. Requirement 56: this model is the
 * thing that gets persisted — nothing is hardcoded into UI components.
 *
 * UNIT CONVENTIONS (requirement 52) — enforced by naming, not by guesswork:
 *   - simulation clock, service times, waiting times: MINUTES
 *   - lambda (arrival rate): vehicles/hour
 *   - mu (service rate): vehicles/hour/server
 *   - power: kW;  energy: kWh;  wages and machine rates: currency/hour
 *   - costs: major currency units (e.g. dollars, not cents)
 */

import type { Distribution, DistributionKind } from '../distributions.js';

/* ------------------------------------------------------------------ */
/* Parameter provenance (requirement 46)                               */
/* ------------------------------------------------------------------ */

export type Provenance =
  /** Backed by a citable external source; `source` must be populated. */
  | 'SOURCE_BACKED'
  /** A value chosen for the model. Not a claim about the real world. */
  | 'PROJECT_ASSUMPTION'
  /** Computed by the engine from other parameters; not directly editable. */
  | 'DERIVED'
  /** Entered by the user in this session. */
  | 'USER_INPUT';

/** A single configurable quantity with its unit and provenance. */
export interface Param {
  value: number;
  unit: string;
  provenance: Provenance;
  /** Citation. Required when provenance is SOURCE_BACKED. */
  source?: string;
  notes?: string;
}

export function param(
  value: number,
  unit: string,
  provenance: Provenance = 'PROJECT_ASSUMPTION',
  extra: { source?: string; notes?: string } = {},
): Param {
  return { value, unit, provenance, ...extra };
}

/* ------------------------------------------------------------------ */
/* Currency (requirement 53)                                           */
/* ------------------------------------------------------------------ */

export type CurrencyCode = 'USD' | 'PKR' | 'EUR' | 'GBP' | 'JPY' | 'CNY';

export interface CurrencySettings {
  code: CurrencyCode;
  symbol: string;
  /**
   * Multiplier from the model's base currency to `code`. The model stores ONE
   * consistent numeric currency; conversion is presentation-only and must
   * declare its rate source and date (requirement 53).
   */
  rateFromBase: number;
  rateSource?: string;
  rateDate?: string;
}

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

export type WorkerRole =
  | 'Operator'
  | 'Technician'
  | 'Inspector'
  | 'Supervisor'
  | 'Maintenance';

/** A crew of identical workers assigned to a station (requirement 16). */
export interface WorkerCrew {
  id: string;
  role: WorkerRole;
  /** Headcount on shift at this station. */
  count: number;
  hourlyWage: Param;
  /** Multiplier applied to hours beyond `shiftHours`. */
  overtimeMultiplier: Param;
  /** Paid shift length per day. */
  shiftHours: Param;
}

/**
 * Machine specification for a station (requirement 17).
 *
 * One machine backs each of the station's `servers`, which is how "2 paint
 * booths" maps onto c = 2. Costs below are PER MACHINE.
 */
export interface MachineSpec {
  id: string;
  name: string;
  purchasePrice: Param;
  usefulLifeYears: Param;
  salvageValue: Param;
  /** Hours the machine is expected to run per year — the depreciation base. */
  annualOperatingHours: Param;
  /** Electrical draw while processing a vehicle. */
  powerKw: Param;
  /** Electrical draw while powered but idle (requirement 20). */
  idlePowerKw: Param;
  /** Scheduled/preventive maintenance charged per operating hour. */
  maintenanceCostPerHour: Param;
  /** Tooling, lubricants, filters, etc. charged per operating hour. */
  consumablesCostPerHour: Param;
  /** Include straight-line depreciation in the per-hour machine cost. */
  includeDepreciation: boolean;
  /** Reliability model (requirement 19). Optional advanced feature. */
  reliability?: MachineReliability;
}

export interface MachineReliability {
  enabled: boolean;
  /** Mean time between failures, in operating hours. */
  mtbfHours: Param;
  /** Mean time to repair, in hours. */
  mttrHours: Param;
  /** Labour + parts charged for each corrective repair hour (requirement 21). */
  repairCostPerHour: Param;
  /** Distribution family for time-to-failure and repair draws. */
  failureDist: DistributionKind;
  repairDist: DistributionKind;
}

/* ------------------------------------------------------------------ */
/* Bill of materials (requirement 14)                                  */
/* ------------------------------------------------------------------ */

export interface BomComponent {
  id: string;
  name: string;
  /** Quantity consumed per vehicle, in `unit`. */
  quantityPerVehicle: number;
  unit: string;
  unitCost: Param;
  supplier?: string;
  /**
   * Fraction of material lost to process scrap, e.g. 0.03 = 3% extra issued.
   * Effective quantity = quantityPerVehicle * (1 + scrapAllowance).
   */
  scrapAllowance: number;
  /**
   * Station at which this component is consumed. Drives the scrap cost model
   * (requirement 23): only material already issued at stations the vehicle
   * actually reached is counted as lost.
   */
  consumedAtStationId: string;
}

export interface VehicleModel {
  id: string;
  name: string;
  bom: BomComponent[];
  sellingPrice: Param;
  notes?: string;
}

/* ------------------------------------------------------------------ */
/* Stations and routing                                                */
/* ------------------------------------------------------------------ */

export type QueueDiscipline = 'FIFO' | 'LIFO' | 'SPT' | 'PRIORITY';

export type StationKind =
  | 'process'
  | 'inspection'
  | 'rework'
  /** Entry point where external vehicles arrive (requirement 7). */
  | 'source';

/** Special routing destinations. */
export const SINK_FINISHED = '__FINISHED__';
export const SINK_SCRAP = '__SCRAP__';

/**
 * A routing arc. Probabilities out of a station must sum to 1 (requirement 51).
 *
 * Inspection failure is modelled as an ordinary probabilistic arc back to
 * Rework, which is exactly what makes the feedback loop appear in the traffic
 * equations (requirement 7).
 */
export interface RoutingEdge {
  to: string;
  probability: number;
  /** Shown on the network diagram edge, e.g. "PASS" / "FAIL - rework". */
  label?: string;
}

/**
 * A production process, modelled as a queue + c parallel servers
 * (requirement 4/5).
 */
export interface Station {
  id: string;
  name: string;
  kind: StationKind;

  /** c — number of parallel servers (machines/booths/bays). */
  servers: number;
  queueDiscipline: QueueDiscipline;
  /** Maximum vehicles waiting. null = unbounded. */
  queueCapacity: number | null;

  /** Service-time distribution, in minutes. Determines the Kendall symbol. */
  service: Distribution;

  workers: WorkerCrew[];
  machine?: MachineSpec;

  routing: RoutingEdge[];

  /**
   * Probability a vehicle is scrapped ON COMPLETING service here, applied
   * before routing. Used for process scrap distinct from inspection failure.
   */
  scrapProbability: number;

  /** Free-text description surfaced in the station detail panel. */
  description?: string;
}

/* ------------------------------------------------------------------ */
/* Arrivals (requirements 7 and 36)                                    */
/* ------------------------------------------------------------------ */

/** One block of the time-of-day demand schedule. */
export interface DemandBlock {
  /** Minutes from the start of the simulation clock. */
  startMinute: number;
  endMinute: number;
  /** External arrival rate for this block, vehicles/hour. */
  lambdaPerHour: Param;
  label?: string;
}

/**
 * The external arrival process. Requirement 7: lambda is defined ONLY here —
 * every internal station's arrival rate is derived from flow and routing.
 */
export interface ArrivalProcess {
  /** Station where external vehicles enter the system. */
  entryStationId: string;
  /** Piecewise-constant demand schedule; a single block = constant lambda. */
  schedule: DemandBlock[];
  /** Inter-arrival distribution family. 'exponential' gives Kendall M. */
  interarrivalKind: DistributionKind;
  /** Mix of vehicle models; shares must sum to 1. */
  modelMix: { modelId: string; share: number }[];
}

/* ------------------------------------------------------------------ */
/* Cost configuration (requirements 20, 21, 25, 26)                    */
/* ------------------------------------------------------------------ */

export type OverheadMode = 'perHour' | 'perVehicle';

/**
 * How labour is charged (requirement 16).
 *  - 'scheduled': crews are paid for the whole shift whether busy or idle.
 *    This is the realistic default for a manned production line.
 *  - 'busy': only time actually spent servicing vehicles is charged.
 * Mixing these up is the classic fixed-vs-variable error warned about in
 * requirement 26, so the choice is explicit rather than implied.
 */
export type LaborCostBasis = 'scheduled' | 'busy';

export interface CostConfig {
  currency: CurrencySettings;
  electricityPricePerKwh: Param;
  /** Cost of a vehicle-hour spent waiting in queue (requirement 25). */
  waitingCostPerVehicleHour: Param;
  /** Holding cost for a vehicle-hour of WIP (requirement 24). */
  wipHoldingCostPerVehicleHour: Param;
  laborCostBasis: LaborCostBasis;
  overhead: {
    mode: OverheadMode;
    /** currency/hour when mode = perHour, currency/vehicle when perVehicle. */
    amount: Param;
    breakdown: { id: string; name: string; amount: Param }[];
  };
  /** Preventive maintenance charged per machine-hour of availability. */
  preventiveMaintenancePerMachineHour: Param;
}

/* ------------------------------------------------------------------ */
/* Simulation configuration (requirements 44, 45)                      */
/* ------------------------------------------------------------------ */

export interface SimulationConfig {
  /** Master random seed. Same seed + same model = identical results. */
  seed: number;
  /** Independent replications (requirement 44). */
  replications: number;
  /** Warm-up period excluded from statistics (requirement 45), in minutes. */
  warmupMinutes: number;
  /** Measurement period after warm-up, in minutes. */
  durationMinutes: number;
  /** Stop injecting arrivals at end of horizon and drain, or hard-stop. */
  terminationMode: 'hardStop' | 'drain';
  /** Record the full per-vehicle trace (requirement 3). Memory-heavy at scale. */
  collectVehicleTraces: boolean;
  /** Maximum traces retained per replication when tracing is enabled. */
  maxTraces: number;
}

/* ------------------------------------------------------------------ */
/* Investment (requirements 31, 32)                                    */
/* ------------------------------------------------------------------ */

/**
 * The capital change a scenario represents relative to its baseline. ROI and
 * payback are undefined without an explicit investment (requirement 31), so
 * this is a required part of any scenario that claims them.
 */
export interface InvestmentSpec {
  /** One-off capital outlay for this configuration change. */
  initialInvestment: Param;
  /** Recurring operating cost the investment ADDS, currency/year. */
  additionalAnnualOperatingCost: Param;
  /** Operating days per year used to annualise simulated results. */
  operatingDaysPerYear: Param;
  /** Production hours per operating day. */
  hoursPerDay: Param;
  items: { id: string; name: string; amount: Param }[];
}

/* ------------------------------------------------------------------ */
/* The complete system model                                           */
/* ------------------------------------------------------------------ */

export interface SystemModel {
  id: string;
  name: string;
  description?: string;
  stations: Station[];
  arrivals: ArrivalProcess;
  vehicleModels: VehicleModel[];
  cost: CostConfig;
  simulation: SimulationConfig;
  investment: InvestmentSpec;
  /** Provenance notes shown in the report's Assumptions section. */
  assumptions?: string[];
  sources?: { id: string; citation: string; url?: string }[];
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function findStation(model: SystemModel, id: string): Station | undefined {
  return model.stations.find((s) => s.id === id);
}

export function isSink(id: string): boolean {
  return id === SINK_FINISHED || id === SINK_SCRAP;
}

/** Total headcount assigned to a station. */
export function stationHeadcount(station: Station): number {
  return station.workers.reduce((n, w) => n + w.count, 0);
}

/** Blended wage bill for a station, currency/hour at straight time. */
export function stationWagePerHour(station: Station): number {
  return station.workers.reduce((c, w) => c + w.count * w.hourlyWage.value, 0);
}
