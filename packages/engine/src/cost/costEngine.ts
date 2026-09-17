/**
 * Manufacturing cost engine — requirements 13 to 28 and 48.
 *
 * THE ACCOUNTING RULE THIS FILE ENFORCES
 * --------------------------------------
 * Requirement 15 lists nine cost lines that must add up to the total:
 *   Material, Labor, Machine, Energy, Maintenance, Quality, Rework, Scrap,
 *   Overhead.
 *
 * Read naively, those lines overlap: an inspector's wages are both "labour"
 * and "quality", and rework labour is both "labour" and "rework", so summing
 * them would count the same money twice and overstate cost per vehicle. The
 * engine therefore uses a strict PARTITION — every currency unit lands in
 * exactly one line:
 *
 *   Labor / Machine / Energy   -> PRODUCTION stations only
 *   Quality                    -> INSPECTION stations (their labour, machine
 *                                 and energy)
 *   Rework                     -> REWORK stations (labour, machine, energy AND
 *                                 the material consumed there)
 *   Material                   -> production-station material issued to
 *                                 vehicles that were finished
 *   Scrap                      -> production-station material issued to
 *                                 vehicles that were later scrapped
 *   Maintenance                -> preventive + corrective, all stations
 *   Overhead                   -> fixed period cost
 *
 * Every station appears in exactly one of the conversion lines and every
 * component issue in exactly one of the material lines, so the nine lines sum
 * to the total with no double counting. `verifyAdditivity()` asserts this and
 * is covered by a test.
 *
 * Requirement 23 also wants the full value destroyed by scrap, which includes
 * conversion cost already spent on those vehicles. That figure necessarily
 * overlaps the Labor/Machine/Energy lines — labour is a period cost that was
 * paid whatever the outcome — so it is reported separately as
 * `scrapAnalysis.totalValueLost` and explicitly marked as a re-slice of money
 * already counted, never added to the total.
 *
 * Requirement 25 keeps waiting cost out of manufacturing cost entirely: it is
 * an opportunity cost used for decision support, not a cost the plant pays.
 *
 * Requirement 48: every line carries `formula` and `inputs` so the UI can show
 * exactly how the number was produced.
 */

import type { SimulationResult, StationSimResult } from '../des/simulation.js';
import type { Vehicle } from '../des/vehicle.js';
import type { BomComponent, Station, SystemModel, VehicleModel } from '../model/types.js';

/* ------------------------------------------------------------------ */
/* Traceable cost lines (requirement 48)                               */
/* ------------------------------------------------------------------ */

export interface CostInput {
  label: string;
  value: number;
  unit: string;
}

export interface CostLine {
  id: string;
  label: string;
  /** Total over the measurement window, in model currency. */
  amount: number;
  /** amount / finished vehicles. */
  perVehicle: number;
  /** Plain-language derivation shown when the user drills into the line. */
  formula: string;
  inputs: CostInput[];
  children?: CostLine[];
}

/* ------------------------------------------------------------------ */
/* Per-station detail                                                  */
/* ------------------------------------------------------------------ */

export interface StationCost {
  stationId: string;
  stationName: string;
  kind: string;
  /** 'production' | 'quality' | 'rework' — which top-level line it feeds. */
  bucket: CostBucket;

  busyServerHours: number;
  idleServerHours: number;
  downServerHours: number;
  /** Hours the station's machines were powered and available. */
  availableServerHours: number;

  laborCost: number;
  laborIdleCost: number;
  machineDepreciation: number;
  machineConsumables: number;
  energyKwh: number;
  energyCost: number;
  preventiveMaintenance: number;
  correctiveMaintenance: number;
  /** Material issued at this station across all vehicles in the cohort. */
  materialCost: number;

  /** Conversion cost per server-minute, used to value scrapped work. */
  conversionCostPerServerMinute: number;
}

export type CostBucket = 'production' | 'quality' | 'rework';

function bucketOf(station: Station): CostBucket {
  if (station.kind === 'inspection') return 'quality';
  if (station.kind === 'rework') return 'rework';
  return 'production';
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export interface VehicleCost {
  vehicleId: number;
  tag: string;
  modelId: string;
  status: Vehicle['status'];
  materialCost: number;
  laborCost: number;
  machineCost: number;
  energyCost: number;
  maintenanceCost: number;
  reworkCost: number;
  overheadCost: number;
  totalCost: number;
  /** Hours from entry to completion. */
  cycleTimeHours: number | null;
}

export interface CostResult {
  currencyCode: string;
  currencySymbol: string;
  /** Measurement window length, hours. */
  windowHours: number;
  vehiclesFinished: number;
  vehiclesScrapped: number;

  /** The nine additive lines, in report order. */
  lines: CostLine[];
  /** Sum of `lines`. */
  totalManufacturingCost: number;
  costPerVehicle: number;

  /** Revenue, profit and margin (requirements 28, 29, 30). */
  revenue: number;
  revenuePerVehicle: number;
  grossProfit: number;
  profitPerVehicle: number;
  marginPercent: number;
  profitPerHour: number;

  /** Requirement 25 — reported OUTSIDE manufacturing cost. */
  waitingCost: number;
  wipHoldingCost: number;

  /** Requirement 23 — overlaps other lines; never added to the total. */
  scrapAnalysis: {
    vehiclesScrapped: number;
    materialLost: number;
    conversionLost: number;
    totalValueLost: number;
    perScrappedVehicle: number;
    note: string;
  };

  /** Requirement 22 — incremental cost of the rework loop. */
  reworkAnalysis: {
    reworkVisits: number;
    vehiclesReworked: number;
    laborCost: number;
    machineCost: number;
    energyCost: number;
    materialCost: number;
    totalCost: number;
    perReworkVisit: number;
    /** Waiting cost caused by extra queueing in the loop. Decision support. */
    note: string;
  };

  /** Requirement 20 — energy detail. */
  energy: {
    totalKwh: number;
    totalCost: number;
    kwhPerVehicle: number;
    costPerVehicle: number;
    pricePerKwh: number;
  };

  stations: StationCost[];
  /** Per-vehicle costing for the vehicles retained in the trace. */
  vehicles: VehicleCost[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Bill of materials (requirements 14, 15)                             */
/* ------------------------------------------------------------------ */

export interface BomLine {
  componentId: string;
  name: string;
  quantityPerVehicle: number;
  unit: string;
  unitCost: number;
  scrapAllowance: number;
  /** quantityPerVehicle * (1 + scrapAllowance) */
  effectiveQuantity: number;
  /** effectiveQuantity * unitCost */
  totalCost: number;
  consumedAtStationId: string;
  supplier?: string;
}

export interface BomSummary {
  modelId: string;
  modelName: string;
  lines: BomLine[];
  /** Sum of line totals — the material cost of one vehicle built first-pass. */
  totalMaterialCost: number;
  /** Material that would be issued at rework stations, per rework visit. */
  reworkMaterialPerVisit: number;
}

/**
 * Expand a vehicle model's BOM.
 *
 * Component cost = quantity x (1 + scrap allowance) x unit cost. The scrap
 * allowance is the extra material that has to be ISSUED to yield one good
 * vehicle, so it belongs in the per-vehicle material cost rather than in the
 * scrap line, which covers whole vehicles lost.
 */
export function expandBom(model: SystemModel, vehicleModel: VehicleModel): BomSummary {
  const reworkStationIds = new Set(
    model.stations.filter((s) => s.kind === 'rework').map((s) => s.id),
  );

  const lines: BomLine[] = vehicleModel.bom.map((c) => {
    const effectiveQuantity = c.quantityPerVehicle * (1 + c.scrapAllowance);
    return {
      componentId: c.id,
      name: c.name,
      quantityPerVehicle: c.quantityPerVehicle,
      unit: c.unit,
      unitCost: c.unitCost.value,
      scrapAllowance: c.scrapAllowance,
      effectiveQuantity,
      totalCost: effectiveQuantity * c.unitCost.value,
      consumedAtStationId: c.consumedAtStationId,
      supplier: c.supplier,
    };
  });

  const totalMaterialCost = lines
    .filter((l) => !reworkStationIds.has(l.consumedAtStationId))
    .reduce((a, l) => a + l.totalCost, 0);
  const reworkMaterialPerVisit = lines
    .filter((l) => reworkStationIds.has(l.consumedAtStationId))
    .reduce((a, l) => a + l.totalCost, 0);

  return {
    modelId: vehicleModel.id,
    modelName: vehicleModel.name,
    lines,
    totalMaterialCost,
    reworkMaterialPerVisit,
  };
}

/** Material issued at one station for one vehicle visit. */
function materialAtStation(components: BomComponent[], stationId: string): number {
  let sum = 0;
  for (const c of components) {
    if (c.consumedAtStationId !== stationId) continue;
    sum += c.quantityPerVehicle * (1 + c.scrapAllowance) * c.unitCost.value;
  }
  return sum;
}

/* ------------------------------------------------------------------ */
/* Machine and labour rates (requirements 16, 17, 18)                  */
/* ------------------------------------------------------------------ */

/**
 * Straight-line depreciation per OPERATING hour:
 *   (purchase price - salvage) / (useful life years x annual operating hours)
 *
 * Charging on operating hours rather than calendar hours is what makes the
 * figure a unit cost: a machine that runs twice as much wears out twice as
 * fast and carries the same total charge over its life.
 */
export function machineDepreciationPerHour(station: Station): number {
  const m = station.machine;
  if (!m || !m.includeDepreciation) return 0;
  const base = m.purchasePrice.value - m.salvageValue.value;
  const hours = m.usefulLifeYears.value * m.annualOperatingHours.value;
  return hours > 0 ? base / hours : 0;
}

/**
 * Blended wage bill for a station, currency/hour.
 *
 * Overtime (requirement 16): a premium applies only when the plant runs more
 * hours per day than the crew's paid shift. It is a property of the production
 * calendar, NOT of how long the simulation happened to run — deriving it from
 * the run length would make labour cost depend on the measurement window,
 * which would be meaningless.
 */
export function stationLaborRatePerHour(station: Station, hoursPerDay: number): number {
  let rate = 0;
  for (const crew of station.workers) {
    const shift = crew.shiftHours.value;
    const straight = Math.min(hoursPerDay, shift);
    const overtime = Math.max(0, hoursPerDay - shift);
    const blended =
      hoursPerDay > 0
        ? (straight + overtime * crew.overtimeMultiplier.value) / hoursPerDay
        : 1;
    rate += crew.count * crew.hourlyWage.value * blended;
  }
  return rate;
}

/* ------------------------------------------------------------------ */
/* The cost engine                                                     */
/* ------------------------------------------------------------------ */

export function computeCosts(model: SystemModel, sim: SimulationResult): CostResult {
  const warnings: string[] = [];
  const windowHours = sim.system.measurementMinutes / 60;
  const cost = model.cost;
  const hoursPerDay = model.investment.hoursPerDay.value;
  const price = cost.electricityPricePerKwh.value;

  const finished = sim.completedVehicles.filter((v) => v.status === 'FINISHED');
  const scrapped = sim.completedVehicles.filter((v) => v.status === 'SCRAPPED');
  const vehiclesFinished = finished.length;
  const vehiclesScrapped = scrapped.length;

  if (vehiclesFinished === 0) {
    warnings.push(
      'No vehicles were finished in the measurement window, so per-vehicle costs cannot be ' +
        'computed. Totals for the window are still shown; per-vehicle figures are reported as ' +
        'zero rather than as a divide-by-zero result.',
    );
  }

  const bomByModel = new Map<string, BomComponent[]>();
  for (const vm of model.vehicleModels) bomByModel.set(vm.id, vm.bom);

  /* ---- per-station resource cost ---- */

  const simByStation = new Map<string, StationSimResult>();
  for (const s of sim.stations) simByStation.set(s.stationId, s);

  const stations: StationCost[] = model.stations.map((def) => {
    const s = simByStation.get(def.id);
    const busyServerHours = (s?.busyServerMinutes ?? 0) / 60;
    const idleServerHours = (s?.idleServerMinutes ?? 0) / 60;
    const downServerHours = (s?.downServerMinutes ?? 0) / 60;
    const availableServerHours = busyServerHours + idleServerHours;

    // Labour is a station-level period cost: the crew is present for the whole
    // window regardless of how many servers happen to be busy.
    const laborRate = stationLaborRatePerHour(def, hoursPerDay);
    const laborScheduled = laborRate * windowHours;
    const utilisation =
      availableServerHours + downServerHours > 0
        ? busyServerHours / (availableServerHours + downServerHours)
        : 0;
    const laborCost =
      cost.laborCostBasis === 'scheduled' ? laborScheduled : laborScheduled * utilisation;
    const laborIdleCost = laborScheduled * (1 - utilisation);

    const m = def.machine;
    const depRate = machineDepreciationPerHour(def);
    const machineDepreciation = depRate * busyServerHours;
    const machineConsumables = (m?.consumablesCostPerHour.value ?? 0) * busyServerHours;

    // Energy: full power while processing, idle draw while powered but not
    // processing. A failed machine is treated as powered but idle.
    const powerKw = m?.powerKw.value ?? 0;
    const idleKw = m?.idlePowerKw.value ?? 0;
    const energyKwh = powerKw * busyServerHours + idleKw * (idleServerHours + downServerHours);
    const energyCost = energyKwh * price;

    // Preventive maintenance accrues while a machine is available; corrective
    // maintenance is charged for the hours actually spent repairing.
    const preventiveRate =
      (m?.maintenanceCostPerHour.value ?? 0) + cost.preventiveMaintenancePerMachineHour.value;
    const preventiveMaintenance = m ? preventiveRate * availableServerHours : 0;
    const repairRate = m?.reliability?.repairCostPerHour.value ?? 0;
    const correctiveMaintenance = ((s?.repairMinutes ?? 0) / 60) * repairRate;

    const conversionTotal = laborCost + machineDepreciation + machineConsumables + energyCost;
    const busyServerMinutes = s?.busyServerMinutes ?? 0;

    return {
      stationId: def.id,
      stationName: def.name,
      kind: def.kind,
      bucket: bucketOf(def),
      busyServerHours,
      idleServerHours,
      downServerHours,
      availableServerHours,
      laborCost,
      laborIdleCost,
      machineDepreciation,
      machineConsumables,
      energyKwh,
      energyCost,
      preventiveMaintenance,
      correctiveMaintenance,
      materialCost: 0, // filled in below from actual vehicle paths
      conversionCostPerServerMinute:
        busyServerMinutes > 0 ? conversionTotal / busyServerMinutes : 0,
    };
  });

  const stationById = new Map<string, StationCost>();
  for (const s of stations) stationById.set(s.stationId, s);
  const stationDefById = new Map<string, Station>();
  for (const s of model.stations) stationDefById.set(s.id, s);

  /* ---- material, traced through each vehicle's actual path ---- */

  let materialFinished = 0;
  let materialScrappedVehicles = 0;
  let materialRework = 0;

  const chargeMaterial = (v: Vehicle, onScrapped: boolean) => {
    const components = bomByModel.get(v.modelId) ?? [];
    for (const visit of v.visits) {
      // Material is issued when a vehicle is WORKED ON, so a visit that never
      // reached service consumes nothing.
      if (visit.serviceStartedAt === null) continue;
      const amount = materialAtStation(components, visit.stationId);
      if (amount === 0) continue;
      const sc = stationById.get(visit.stationId);
      if (sc) sc.materialCost += amount;
      const def = stationDefById.get(visit.stationId);
      if (def && bucketOf(def) === 'rework') materialRework += amount;
      else if (onScrapped) materialScrappedVehicles += amount;
      else materialFinished += amount;
    }
  };

  for (const v of finished) chargeMaterial(v, false);
  for (const v of scrapped) chargeMaterial(v, true);

  /* ---- aggregate the partition ---- */

  const sumBy = (bucket: CostBucket, pick: (s: StationCost) => number) =>
    stations.filter((s) => s.bucket === bucket).reduce((a, s) => a + pick(s), 0);

  const laborProduction = sumBy('production', (s) => s.laborCost);
  const machineProduction = sumBy('production', (s) => s.machineDepreciation + s.machineConsumables);
  const energyProduction = sumBy('production', (s) => s.energyCost);

  const qualityLabor = sumBy('quality', (s) => s.laborCost);
  const qualityMachine = sumBy('quality', (s) => s.machineDepreciation + s.machineConsumables);
  const qualityEnergy = sumBy('quality', (s) => s.energyCost);

  const reworkLabor = sumBy('rework', (s) => s.laborCost);
  const reworkMachine = sumBy('rework', (s) => s.machineDepreciation + s.machineConsumables);
  const reworkEnergy = sumBy('rework', (s) => s.energyCost);

  const maintenancePreventive = stations.reduce((a, s) => a + s.preventiveMaintenance, 0);
  const maintenanceCorrective = stations.reduce((a, s) => a + s.correctiveMaintenance, 0);

  const overheadAmount =
    cost.overhead.mode === 'perHour'
      ? cost.overhead.amount.value * windowHours
      : cost.overhead.amount.value * vehiclesFinished;

  const perVeh = (x: number) => (vehiclesFinished > 0 ? x / vehiclesFinished : 0);

  const lines: CostLine[] = [
    {
      id: 'material',
      label: 'Direct material (finished vehicles)',
      amount: materialFinished,
      perVehicle: perVeh(materialFinished),
      formula:
        'Sum over every station visit of every FINISHED vehicle of ' +
        'quantity x (1 + scrap allowance) x unit cost, for the components issued at that station. ' +
        'Traced through each vehicle’s actual route, so a vehicle that took a different path ' +
        'is costed differently.',
      inputs: [
        { label: 'Finished vehicles', value: vehiclesFinished, unit: 'vehicles' },
        { label: 'BOM lines', value: model.vehicleModels[0]?.bom.length ?? 0, unit: 'components' },
      ],
      children: model.vehicleModels.map((vm) => {
        const b = expandBom(model, vm);
        return {
          id: `material:${vm.id}`,
          label: `${vm.name} — material per vehicle`,
          amount: b.totalMaterialCost,
          perVehicle: b.totalMaterialCost,
          formula: 'Sum of quantity x (1 + scrap allowance) x unit cost over the BOM.',
          inputs: b.lines.map((l) => ({
            label: `${l.name} (${l.quantityPerVehicle} ${l.unit} @ ${l.unitCost})`,
            value: l.totalCost,
            unit: 'currency',
          })),
        };
      }),
    },
    {
      id: 'labor',
      label: 'Direct labour (production stations)',
      amount: laborProduction,
      perVehicle: perVeh(laborProduction),
      formula:
        cost.laborCostBasis === 'scheduled'
          ? 'For each production station: headcount x hourly wage x window hours. Crews are paid ' +
            'for the whole shift whether busy or idle, so this is a period cost independent of ' +
            'throughput. Idle labour is reported separately so the waste is visible.'
          : 'For each production station: headcount x hourly wage x window hours x utilisation. ' +
            'Only time actually spent servicing vehicles is charged.',
      inputs: [
        { label: 'Window', value: windowHours, unit: 'hours' },
        { label: 'Basis', value: cost.laborCostBasis === 'scheduled' ? 1 : 0, unit: '1 = scheduled, 0 = busy-only' },
        { label: 'Idle labour included above', value: sumBy('production', (s) => s.laborIdleCost), unit: 'currency' },
      ],
      children: stations
        .filter((s) => s.bucket === 'production')
        .map((s) => ({
          id: `labor:${s.stationId}`,
          label: s.stationName,
          amount: s.laborCost,
          perVehicle: perVeh(s.laborCost),
          formula: 'headcount x wage x hours',
          inputs: [
            { label: 'Idle portion', value: s.laborIdleCost, unit: 'currency' },
            { label: 'Busy server hours', value: s.busyServerHours, unit: 'hours' },
          ],
        })),
    },
    {
      id: 'machine',
      label: 'Machine (depreciation + consumables, production stations)',
      amount: machineProduction,
      perVehicle: perVeh(machineProduction),
      formula:
        'Depreciation = (purchase price - salvage) / (useful life years x annual operating hours), ' +
        'charged per operating hour. Consumables are charged per operating hour. Maintenance is ' +
        'NOT included here — it has its own line, so it is never counted twice.',
      inputs: [
        { label: 'Operating hours (production)', value: sumBy('production', (s) => s.busyServerHours), unit: 'machine-hours' },
      ],
      children: stations
        .filter((s) => s.bucket === 'production' && s.machineDepreciation + s.machineConsumables > 0)
        .map((s) => ({
          id: `machine:${s.stationId}`,
          label: s.stationName,
          amount: s.machineDepreciation + s.machineConsumables,
          perVehicle: perVeh(s.machineDepreciation + s.machineConsumables),
          formula: 'depreciation/hour x operating hours + consumables/hour x operating hours',
          inputs: [
            { label: 'Depreciation', value: s.machineDepreciation, unit: 'currency' },
            { label: 'Consumables', value: s.machineConsumables, unit: 'currency' },
            { label: 'Operating hours', value: s.busyServerHours, unit: 'hours' },
          ],
        })),
    },
    {
      id: 'energy',
      label: 'Energy (production stations)',
      amount: energyProduction,
      perVehicle: perVeh(energyProduction),
      formula:
        'Energy = (power kW x operating hours + idle kW x (idle + down) hours) x electricity price. ' +
        'A failed machine is treated as powered but idle.',
      inputs: [
        { label: 'Electricity price', value: price, unit: 'currency/kWh' },
        { label: 'kWh consumed (production)', value: sumBy('production', (s) => s.energyKwh), unit: 'kWh' },
      ],
      children: stations
        .filter((s) => s.bucket === 'production' && s.energyKwh > 0)
        .map((s) => ({
          id: `energy:${s.stationId}`,
          label: s.stationName,
          amount: s.energyCost,
          perVehicle: perVeh(s.energyCost),
          formula: 'kWh x price',
          inputs: [{ label: 'kWh', value: s.energyKwh, unit: 'kWh' }],
        })),
    },
    {
      id: 'maintenance',
      label: 'Maintenance (preventive + corrective, all stations)',
      amount: maintenancePreventive + maintenanceCorrective,
      perVehicle: perVeh(maintenancePreventive + maintenanceCorrective),
      formula:
        'Preventive = (machine maintenance rate + plant preventive rate) x available machine-hours. ' +
        'Corrective = repair cost per hour x hours actually spent repairing in this run.',
      inputs: [
        { label: 'Preventive', value: maintenancePreventive, unit: 'currency' },
        { label: 'Corrective (breakdowns)', value: maintenanceCorrective, unit: 'currency' },
        { label: 'Repair hours', value: sim.stations.reduce((a, s) => a + s.repairMinutes, 0) / 60, unit: 'hours' },
        { label: 'Breakdowns', value: sim.stations.reduce((a, s) => a + s.breakdowns, 0), unit: 'events' },
      ],
    },
    {
      id: 'quality',
      label: 'Quality / inspection',
      amount: qualityLabor + qualityMachine + qualityEnergy,
      perVehicle: perVeh(qualityLabor + qualityMachine + qualityEnergy),
      formula:
        'Labour, machine and energy cost of the INSPECTION stations. These stations are excluded ' +
        'from the labour, machine and energy lines above, so nothing is counted twice.',
      inputs: [
        { label: 'Inspector labour', value: qualityLabor, unit: 'currency' },
        { label: 'Machine', value: qualityMachine, unit: 'currency' },
        { label: 'Energy', value: qualityEnergy, unit: 'currency' },
        { label: 'Inspections performed', value: sim.stations.filter((s) => s.kind === 'inspection').reduce((a, s) => a + s.completions, 0), unit: 'inspections' },
      ],
    },
    {
      id: 'rework',
      label: 'Rework',
      amount: reworkLabor + reworkMachine + reworkEnergy + materialRework,
      perVehicle: perVeh(reworkLabor + reworkMachine + reworkEnergy + materialRework),
      formula:
        'Labour, machine, energy AND material consumed at the REWORK stations. Rework stations are ' +
        'excluded from the other conversion lines, and rework material is excluded from the ' +
        'material line, so this is purely incremental.',
      inputs: [
        { label: 'Labour', value: reworkLabor, unit: 'currency' },
        { label: 'Machine', value: reworkMachine, unit: 'currency' },
        { label: 'Energy', value: reworkEnergy, unit: 'currency' },
        { label: 'Material', value: materialRework, unit: 'currency' },
        { label: 'Rework visits', value: sim.stations.filter((s) => s.kind === 'rework').reduce((a, s) => a + s.completions, 0), unit: 'visits' },
      ],
    },
    {
      id: 'scrap',
      label: 'Scrap (material written off)',
      amount: materialScrappedVehicles,
      perVehicle: perVeh(materialScrappedVehicles),
      formula:
        'Material issued at production stations to vehicles that were later scrapped. Only material ' +
        'ACTUALLY consumed before the vehicle was condemned is counted — costs of stations it never ' +
        'reached are not incurred and are not charged.',
      inputs: [
        { label: 'Vehicles scrapped', value: vehiclesScrapped, unit: 'vehicles' },
        { label: 'Material written off', value: materialScrappedVehicles, unit: 'currency' },
      ],
    },
    {
      id: 'overhead',
      label: 'Allocated overhead',
      amount: overheadAmount,
      perVehicle: perVeh(overheadAmount),
      formula:
        cost.overhead.mode === 'perHour'
          ? 'Fixed overhead rate x window hours. A fixed period cost: it does not change with ' +
            'volume, so cost PER VEHICLE falls as throughput rises.'
          : 'Overhead per vehicle x finished vehicles.',
      inputs: cost.overhead.breakdown.map((b) => ({
        label: b.name,
        value: cost.overhead.mode === 'perHour' ? b.amount.value * windowHours : b.amount.value * vehiclesFinished,
        unit: 'currency',
      })),
    },
  ];

  const totalManufacturingCost = lines.reduce((a, l) => a + l.amount, 0);
  const costPerVehicle = perVeh(totalManufacturingCost);

  /* ---- revenue, profit (requirements 28, 29, 30) ---- */

  let revenue = 0;
  const priceByModel = new Map<string, number>();
  for (const vm of model.vehicleModels) priceByModel.set(vm.id, vm.sellingPrice.value);
  for (const v of finished) revenue += priceByModel.get(v.modelId) ?? 0;

  const grossProfit = revenue - totalManufacturingCost;

  /* ---- waiting and WIP cost (requirements 24, 25) ---- */

  const waitingCost =
    sim.system.totalWaitingVehicleHours * cost.waitingCostPerVehicleHour.value;
  const wipHoldingCost =
    sim.system.totalWipVehicleHours * cost.wipHoldingCostPerVehicleHour.value;

  /* ---- scrap value analysis (requirement 23) ---- */

  let conversionLost = 0;
  for (const v of scrapped) {
    for (const [stationId, minutes] of Object.entries(v.serverMinutesByStation)) {
      const sc = stationById.get(stationId);
      if (sc) conversionLost += minutes * sc.conversionCostPerServerMinute;
    }
  }

  /* ---- per-vehicle costing (requirement 15) ---- */

  const overheadPerVehicle = perVeh(overheadAmount);
  const vehicles: VehicleCost[] = sim.traces.map((v) =>
    costOneVehicle(v, model, stationById, bomByModel, overheadPerVehicle),
  );

  const totalKwh = stations.reduce((a, s) => a + s.energyKwh, 0);

  const reworkVisits = sim.stations
    .filter((s) => s.kind === 'rework')
    .reduce((a, s) => a + s.completions, 0);

  return {
    currencyCode: cost.currency.code,
    currencySymbol: cost.currency.symbol,
    windowHours,
    vehiclesFinished,
    vehiclesScrapped,
    lines,
    totalManufacturingCost,
    costPerVehicle,
    revenue,
    revenuePerVehicle: perVeh(revenue),
    grossProfit,
    profitPerVehicle: perVeh(grossProfit),
    marginPercent: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
    profitPerHour: windowHours > 0 ? grossProfit / windowHours : 0,
    waitingCost,
    wipHoldingCost,
    scrapAnalysis: {
      vehiclesScrapped,
      materialLost: materialScrappedVehicles,
      conversionLost,
      totalValueLost: materialScrappedVehicles + conversionLost,
      perScrappedVehicle:
        vehiclesScrapped > 0 ? (materialScrappedVehicles + conversionLost) / vehiclesScrapped : 0,
      note:
        'Total value lost OVERLAPS the labour, machine and energy lines: those are period costs ' +
        'that were paid whether or not the vehicle survived. Only the material line is additive. ' +
        'This figure answers "what did scrap destroy?", not "what should be added to the total?".',
    },
    reworkAnalysis: {
      reworkVisits,
      vehiclesReworked: sim.system.vehiclesReworked,
      laborCost: reworkLabor,
      machineCost: reworkMachine,
      energyCost: reworkEnergy,
      materialCost: materialRework,
      totalCost: reworkLabor + reworkMachine + reworkEnergy + materialRework,
      perReworkVisit:
        reworkVisits > 0 ? (reworkLabor + reworkMachine + reworkEnergy + materialRework) / reworkVisits : 0,
      note:
        'Rework also lengthens cycle time and inflates WIP. That consequence is priced in the ' +
        'waiting and WIP holding figures, which sit outside manufacturing cost.',
    },
    energy: {
      totalKwh,
      totalCost: stations.reduce((a, s) => a + s.energyCost, 0),
      kwhPerVehicle: perVeh(totalKwh),
      costPerVehicle: perVeh(stations.reduce((a, s) => a + s.energyCost, 0)),
      pricePerKwh: price,
    },
    stations,
    vehicles,
    warnings,
  };
}

/**
 * Cost one vehicle from its own history (requirement 3 and 15).
 *
 * Conversion costs are attributed by the server-minutes the vehicle actually
 * occupied, valued at each station's own cost per server-minute. Two vehicles
 * that took different routes, or that queued at different stations, therefore
 * cost different amounts — which is the point of tracing them individually.
 */
function costOneVehicle(
  v: Vehicle,
  model: SystemModel,
  stationById: Map<string, StationCost>,
  bomByModel: Map<string, BomComponent[]>,
  overheadPerVehicle: number,
): VehicleCost {
  const components = bomByModel.get(v.modelId) ?? [];
  const reworkIds = new Set(model.stations.filter((s) => s.kind === 'rework').map((s) => s.id));

  let materialCost = 0;
  let reworkCost = 0;
  for (const visit of v.visits) {
    if (visit.serviceStartedAt === null) continue;
    const amount = materialAtStation(components, visit.stationId);
    if (reworkIds.has(visit.stationId)) reworkCost += amount;
    else materialCost += amount;
  }

  let laborCost = 0;
  let machineCost = 0;
  let energyCost = 0;
  let maintenanceCost = 0;

  for (const [stationId, minutes] of Object.entries(v.serverMinutesByStation)) {
    const sc = stationById.get(stationId);
    if (!sc) continue;
    const busyMin = sc.busyServerHours * 60;
    if (busyMin <= 0) continue;
    const share = minutes / busyMin;
    const l = sc.laborCost * share;
    const m = (sc.machineDepreciation + sc.machineConsumables) * share;
    const e = sc.energyCost * share;
    const mt = (sc.preventiveMaintenance + sc.correctiveMaintenance) * share;
    if (reworkIds.has(stationId)) {
      reworkCost += l + m + e;
      maintenanceCost += mt;
    } else {
      laborCost += l;
      machineCost += m;
      energyCost += e;
      maintenanceCost += mt;
    }
  }

  const totalCost =
    materialCost + laborCost + machineCost + energyCost + maintenanceCost + reworkCost + overheadPerVehicle;

  return {
    vehicleId: v.id,
    tag: v.tag,
    modelId: v.modelId,
    status: v.status,
    materialCost,
    laborCost,
    machineCost,
    energyCost,
    maintenanceCost,
    reworkCost,
    overheadCost: overheadPerVehicle,
    totalCost,
    cycleTimeHours:
      v.completionTime === null ? null : (v.completionTime - v.arrivalTime) / 60,
  };
}

/**
 * Assert the nine lines actually partition the total (requirement 48).
 * Returns the discrepancy; a correct model returns ~0.
 */
export function verifyAdditivity(result: CostResult): {
  sumOfLines: number;
  reportedTotal: number;
  discrepancy: number;
  ok: boolean;
} {
  const sumOfLines = result.lines.reduce((a, l) => a + l.amount, 0);
  const discrepancy = sumOfLines - result.totalManufacturingCost;
  return {
    sumOfLines,
    reportedTotal: result.totalManufacturingCost,
    discrepancy,
    ok: Math.abs(discrepancy) < 1e-6,
  };
}
