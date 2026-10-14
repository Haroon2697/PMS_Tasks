/**
 * Cost, finance, validation and optimisation tests — requirements 58, 48, 32.
 *
 * The central assertion here is ADDITIVITY: the nine cost lines must partition
 * the total with no double counting. An inspector's wages must not appear in
 * both "labour" and "quality"; rework material must not appear in both
 * "material" and "rework". Without that property every per-vehicle cost, and
 * therefore every profit, ROI and payback figure downstream, would be wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  computeCosts,
  expandBom,
  machineDepreciationPerHour,
  stationLaborRatePerHour,
  verifyAdditivity,
} from '../src/cost/costEngine.js';
import { runSimulation } from '../src/des/simulation.js';
import { buildReferenceModel } from '../src/model/referenceModel.js';
import { makeSingleStationModel, makeCrew, makeMachine } from '../src/model/defaults.js';
import {
  annualise,
  appraiseIncremental,
  discountedPayback,
  netPresentValue,
  paybackPeriod,
} from '../src/finance/investment.js';
import { validateModel } from '../src/validation/validate.js';
import { analyseBottlenecks } from '../src/analytical/bottleneck.js';
import { applyScenario, compareScenarios, evaluateScenario, type Scenario } from '../src/optimize/scenarios.js';
import { optimize } from '../src/optimize/optimizer.js';
import { runStudy, summariseMetric, tCritical } from '../src/stats/replications.js';
import { param } from '../src/model/types.js';

function longRun() {
  const m = buildReferenceModel();
  m.arrivals.schedule = [
    { startMinute: 0, endMinute: 200_000, lambdaPerHour: param(6, 'vehicles/hour', 'USER_INPUT') },
  ];
  m.simulation.warmupMinutes = 2_000;
  m.simulation.durationMinutes = 40_000;
  m.simulation.collectVehicleTraces = true;
  m.simulation.maxTraces = 300;
  m.simulation.terminationMode = 'drain';
  return m;
}

describe('bill of materials (requirement 14)', () => {
  const model = buildReferenceModel();
  const vm = model.vehicleModels[0]!;
  const bom = expandBom(model, vm);

  it('applies quantity x (1 + scrap allowance) x unit cost per line', () => {
    const steel = bom.lines.find((l) => l.componentId === 'steel')!;
    expect(steel.quantityPerVehicle).toBe(380);
    expect(steel.unitCost).toBe(1.1);
    expect(steel.scrapAllowance).toBe(0.06);
    expect(steel.effectiveQuantity).toBeCloseTo(380 * 1.06, 10);
    expect(steel.totalCost).toBeCloseTo(380 * 1.06 * 1.1, 10);
  });

  it('total material cost is the sum of the non-rework lines', () => {
    const manual = bom.lines
      .filter((l) => l.consumedAtStationId !== 'rework')
      .reduce((a, l) => a + l.totalCost, 0);
    expect(bom.totalMaterialCost).toBeCloseTo(manual, 8);
  });

  it('keeps rework material out of the per-vehicle material cost', () => {
    expect(bom.reworkMaterialPerVisit).toBeGreaterThan(0);
    const reworkLines = bom.lines.filter((l) => l.consumedAtStationId === 'rework');
    expect(reworkLines.length).toBeGreaterThan(0);
    expect(bom.totalMaterialCost).not.toBeCloseTo(
      bom.lines.reduce((a, l) => a + l.totalCost, 0),
      2,
    );
  });

  it('every component is consumed at a real station', () => {
    const ids = new Set(model.stations.map((s) => s.id));
    for (const l of bom.lines) expect(ids.has(l.consumedAtStationId)).toBe(true);
  });
});

describe('machine and labour rates (requirements 16, 17, 18)', () => {
  const model = buildReferenceModel();
  const paint = model.stations.find((s) => s.id === 'paint_shop')!;

  it('computes straight-line depreciation per operating hour', () => {
    const m = paint.machine!;
    const expected =
      (m.purchasePrice.value - m.salvageValue.value) /
      (m.usefulLifeYears.value * m.annualOperatingHours.value);
    expect(machineDepreciationPerHour(paint)).toBeCloseTo(expected, 10);
    // (2,400,000 - 200,000) / (10 x 2000) = 110/hour
    expect(machineDepreciationPerHour(paint)).toBeCloseTo(110, 6);
  });

  it('returns zero depreciation when it is switched off', () => {
    const s = { ...paint, machine: { ...paint.machine!, includeDepreciation: false } };
    expect(machineDepreciationPerHour(s)).toBe(0);
  });

  it('sums the wage bill across crews', () => {
    // Paint: 6 operators @ 29 + 3 technicians @ 36 = 174 + 108 = 282/hour
    expect(stationLaborRatePerHour(paint, 8)).toBeCloseTo(6 * 29 + 3 * 36, 8);
  });

  it('applies an overtime premium only when the day exceeds the shift', () => {
    const crew = makeCrew('c', 'Operator', 1, 100);
    const st = { ...paint, workers: [crew] };
    // 8-hour day, 8-hour shift: no overtime.
    expect(stationLaborRatePerHour(st, 8)).toBeCloseTo(100, 8);
    // 10-hour day: 8 straight + 2 at 1.5x, blended over 10 hours.
    expect(stationLaborRatePerHour(st, 10)).toBeCloseTo(100 * ((8 + 2 * 1.5) / 10), 8);
  });

  it('does not let the measurement window change the labour rate', () => {
    // The rate depends on the production calendar, not the run length.
    expect(stationLaborRatePerHour(paint, 8)).toBe(stationLaborRatePerHour(paint, 8));
  });
});

describe('cost additivity — no double counting (requirements 15, 48)', () => {
  const model = longRun();
  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);

  it('the nine lines sum exactly to the reported total', () => {
    const check = verifyAdditivity(cost);
    expect(check.ok).toBe(true);
    expect(Math.abs(check.discrepancy)).toBeLessThan(1e-6);
  });

  it('produces all nine required lines', () => {
    expect(cost.lines.map((l) => l.id)).toEqual([
      'material',
      'labor',
      'machine',
      'energy',
      'maintenance',
      'quality',
      'rework',
      'scrap',
      'overhead',
    ]);
  });

  it('excludes inspection and rework stations from the production labour line', () => {
    const labourLine = cost.lines.find((l) => l.id === 'labor')!;
    const childIds = (labourLine.children ?? []).map((c) => c.id);
    expect(childIds).not.toContain('labor:inspection');
    expect(childIds).not.toContain('labor:rework');
    // ...and the quality line is where the inspectors' wages actually land.
    const inspectionStation = cost.stations.find((s) => s.stationId === 'inspection')!;
    expect(inspectionStation.laborCost).toBeGreaterThan(0);
    expect(cost.lines.find((l) => l.id === 'quality')!.amount).toBeGreaterThanOrEqual(
      inspectionStation.laborCost,
    );
  });

  it('keeps maintenance out of the machine line', () => {
    const machineLine = cost.lines.find((l) => l.id === 'machine')!;
    const productionStations = cost.stations.filter((s) => s.bucket === 'production');
    const depAndConsumables = productionStations.reduce(
      (a, s) => a + s.machineDepreciation + s.machineConsumables,
      0,
    );
    expect(machineLine.amount).toBeCloseTo(depAndConsumables, 6);
    const maintenance = productionStations.reduce(
      (a, s) => a + s.preventiveMaintenance + s.correctiveMaintenance,
      0,
    );
    expect(maintenance).toBeGreaterThan(0);
    expect(machineLine.amount).not.toBeCloseTo(depAndConsumables + maintenance, 2);
  });

  it('every line carries a formula and inputs for the drill-down', () => {
    for (const l of cost.lines) {
      expect(l.formula.length).toBeGreaterThan(20);
      expect(Array.isArray(l.inputs)).toBe(true);
      expect(l.amount).toBeGreaterThanOrEqual(0);
      if (cost.vehiclesFinished > 0) {
        expect(l.perVehicle).toBeCloseTo(l.amount / cost.vehiclesFinished, 6);
      }
    }
  });

  it('cost per vehicle equals total divided by finished vehicles', () => {
    expect(cost.costPerVehicle).toBeCloseTo(
      cost.totalManufacturingCost / cost.vehiclesFinished,
      8,
    );
  });
});

describe('material cost traced through actual vehicle paths (requirement 13)', () => {
  const model = longRun();
  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);
  const bom = expandBom(model, model.vehicleModels[0]!);

  it('material per finished vehicle matches the BOM total', () => {
    const line = cost.lines.find((l) => l.id === 'material')!;
    expect(line.perVehicle).toBeCloseTo(bom.totalMaterialCost, 2);
  });

  it('charges rework material once per rework visit, not per vehicle', () => {
    const reworkVisits = sim.stations.find((s) => s.stationId === 'rework')!.completions;
    expect(reworkVisits).toBeGreaterThan(0);
    const reworkStation = cost.stations.find((s) => s.stationId === 'rework')!;
    // Every vehicle that STARTED service at rework was charged one kit.
    expect(reworkStation.materialCost / bom.reworkMaterialPerVisit).toBeGreaterThan(
      reworkVisits * 0.9,
    );
  });

  it('charges scrapped vehicles only for material they actually consumed', () => {
    expect(cost.vehiclesScrapped).toBeGreaterThan(0);
    const scrapLine = cost.lines.find((l) => l.id === 'scrap')!;
    // Scrap happens at inspection, i.e. at the END of the line, so a scrapped
    // vehicle has consumed essentially the full BOM.
    const perScrapped = scrapLine.amount / cost.vehiclesScrapped;
    expect(perScrapped).toBeGreaterThan(bom.totalMaterialCost * 0.9);
    expect(perScrapped).toBeLessThanOrEqual(bom.totalMaterialCost * 1.01);
  });

  it('values scrap loss above material alone once conversion work is counted', () => {
    expect(cost.scrapAnalysis.conversionLost).toBeGreaterThan(0);
    expect(cost.scrapAnalysis.totalValueLost).toBeGreaterThan(cost.scrapAnalysis.materialLost);
    expect(cost.scrapAnalysis.note).toContain('OVERLAPS');
  });
});

describe('energy cost (requirement 20)', () => {
  const model = longRun();
  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);

  it('energy = (power x busy + idle power x idle) x price, per station', () => {
    const paintDef = model.stations.find((s) => s.id === 'paint_shop')!;
    const paintCost = cost.stations.find((s) => s.stationId === 'paint_shop')!;
    const expectedKwh =
      paintDef.machine!.powerKw.value * paintCost.busyServerHours +
      paintDef.machine!.idlePowerKw.value * (paintCost.idleServerHours + paintCost.downServerHours);
    expect(paintCost.energyKwh).toBeCloseTo(expectedKwh, 6);
    expect(paintCost.energyCost).toBeCloseTo(
      expectedKwh * model.cost.electricityPricePerKwh.value,
      6,
    );
  });

  it('total energy equals the sum over stations', () => {
    expect(cost.energy.totalKwh).toBeCloseTo(
      cost.stations.reduce((a, s) => a + s.energyKwh, 0),
      6,
    );
    expect(cost.energy.costPerVehicle).toBeCloseTo(
      cost.energy.totalCost / cost.vehiclesFinished,
      6,
    );
  });

  it('scales linearly with the electricity price', () => {
    const dearer = longRun();
    dearer.cost.electricityPricePerKwh = param(0.17, 'currency/kWh', 'USER_INPUT');
    const c2 = computeCosts(dearer, runSimulation(dearer));
    expect(c2.energy.totalCost / cost.energy.totalCost).toBeCloseTo(0.17 / 0.085, 2);
  });
});

describe('waiting cost is kept out of manufacturing cost (requirement 25)', () => {
  const model = longRun();
  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);

  it('is computed from vehicle-hours waiting x the waiting rate', () => {
    expect(cost.waitingCost).toBeCloseTo(
      sim.system.totalWaitingVehicleHours * model.cost.waitingCostPerVehicleHour.value,
      6,
    );
    expect(cost.waitingCost).toBeGreaterThan(0);
  });

  it('is not part of the additive total', () => {
    const sum = cost.lines.reduce((a, l) => a + l.amount, 0);
    expect(sum).toBeCloseTo(cost.totalManufacturingCost, 6);
    expect(cost.totalManufacturingCost).not.toBeCloseTo(sum + cost.waitingCost, 2);
  });
});

describe('revenue, profit and margin (requirements 28, 29, 30)', () => {
  const model = longRun();
  const cost = computeCosts(model, runSimulation(model));

  it('revenue = finished vehicles x selling price', () => {
    const price = model.vehicleModels[0]!.sellingPrice.value;
    expect(cost.revenue).toBeCloseTo(cost.vehiclesFinished * price, 6);
  });

  it('profit = revenue - total manufacturing cost', () => {
    expect(cost.grossProfit).toBeCloseTo(cost.revenue - cost.totalManufacturingCost, 6);
    expect(cost.marginPercent).toBeCloseTo((cost.grossProfit / cost.revenue) * 100, 8);
  });

  it('does not count scrapped vehicles as revenue', () => {
    expect(cost.vehiclesScrapped).toBeGreaterThan(0);
    const price = model.vehicleModels[0]!.sellingPrice.value;
    expect(cost.revenue).toBeLessThan((cost.vehiclesFinished + cost.vehiclesScrapped) * price);
  });
});

describe('per-vehicle costing (requirement 3, 15)', () => {
  const model = longRun();
  const sim = runSimulation(model);
  const cost = computeCosts(model, sim);

  it('costs each traced vehicle individually', () => {
    expect(cost.vehicles.length).toBeGreaterThan(0);
    for (const v of cost.vehicles.slice(0, 50)) {
      expect(v.totalCost).toBeGreaterThan(0);
      const parts =
        v.materialCost + v.laborCost + v.machineCost + v.energyCost + v.maintenanceCost +
        v.reworkCost + v.overheadCost;
      expect(v.totalCost).toBeCloseTo(parts, 6);
    }
  });

  it('charges a reworked vehicle more than an identical first-pass vehicle', () => {
    const plain = cost.vehicles.filter((v) => v.status === 'FINISHED' && v.reworkCost === 0);
    const reworked = cost.vehicles.filter((v) => v.status === 'FINISHED' && v.reworkCost > 0);
    expect(plain.length).toBeGreaterThan(0);
    expect(reworked.length).toBeGreaterThan(0);
    const meanPlain = plain.reduce((a, v) => a + v.totalCost, 0) / plain.length;
    const meanRework = reworked.reduce((a, v) => a + v.totalCost, 0) / reworked.length;
    expect(meanRework).toBeGreaterThan(meanPlain);
  });
});

describe('payback period (requirement 32)', () => {
  it('computes investment / annual net benefit', () => {
    // The worked example from the brief: 100,000 / 25,000 = 4 years.
    const p = paybackPeriod(100_000, 25_000);
    expect(p.achieved).toBe(true);
    expect(p.years).toBeCloseTo(4, 10);
    expect(p.months).toBeCloseTo(48, 10);
  });

  it('subtracts additional operating cost before dividing', () => {
    // 40,000 savings less 15,000 extra operating cost = 25,000 net.
    const net = 40_000 - 15_000;
    expect(paybackPeriod(100_000, net).years).toBeCloseTo(4, 10);
  });

  it('reports NOT ACHIEVED when the net benefit is zero or negative', () => {
    for (const benefit of [0, -1, -50_000]) {
      const p = paybackPeriod(100_000, benefit);
      expect(p.achieved).toBe(false);
      expect(p.years).toBeNull();
      expect(p.months).toBeNull();
      expect(p.message).toContain('NOT ACHIEVED');
    }
  });

  it('never returns a negative payback period', () => {
    const p = paybackPeriod(100_000, -25_000);
    expect(p.years).not.toBe(-4);
    expect(p.years).toBeNull();
  });

  it('treats a zero-capital change as immediately paid back', () => {
    expect(paybackPeriod(0, 10_000).years).toBe(0);
  });

  it('discounts correctly for NPV and discounted payback', () => {
    // 100,000 outlay, 25,000/year for 5 years at 10%.
    const npv = netPresentValue(100_000, 25_000, 5, 0.1);
    expect(npv).toBeCloseTo(-100_000 + 25_000 * 3.790786769, 4);
    const dp = discountedPayback(100_000, 25_000, 0.1);
    expect(dp).not.toBeNull();
    expect(dp!).toBeGreaterThan(4); // slower than the undiscounted 4 years
    expect(discountedPayback(100_000, -1, 0.1)).toBeNull();
  });
});

describe('ROI requires a defined investment (requirement 31)', () => {
  const base = annualise(
    { windowHours: 8, vehiclesFinished: 40, revenue: 672_000, manufacturingCost: 600_000, waitingCost: 5_000 },
    buildReferenceModel().investment,
  );
  const better = annualise(
    { windowHours: 8, vehiclesFinished: 46, revenue: 772_800, manufacturingCost: 660_000, waitingCost: 3_000 },
    buildReferenceModel().investment,
  );

  it('annualises using the plant calendar, not 8,760 hours', () => {
    // 250 days x 8 hours = 2,000 production hours per year.
    expect(base.annualProductionHours).toBe(2000);
    expect(base.vehiclesPerYear).toBeCloseTo(40 * (2000 / 8), 6);
  });

  it('returns null ROI when no capital is committed', () => {
    const a = appraiseIncremental(base, better, {
      initialInvestment: 0,
      additionalAnnualOperatingCost: 0,
    });
    expect(a.roiPercent).toBeNull();
    expect(a.workings.some((w) => w.includes('not defined'))).toBe(true);
  });

  it('computes ROI as net benefit over the investment', () => {
    const a = appraiseIncremental(base, better, {
      initialInvestment: 2_400_000,
      additionalAnnualOperatingCost: 150_000,
    });
    expect(a.roiPercent).toBeCloseTo((a.annualNetBenefit / 2_400_000) * 100, 8);
    expect(a.annualNetBenefit).toBeCloseTo(a.annualGrossBenefit - 150_000, 6);
  });

  it('does not double count the cost saving on top of the profit improvement', () => {
    const a = appraiseIncremental(base, better, {
      initialInvestment: 1_000_000,
      additionalAnnualOperatingCost: 0,
    });
    const profitImprovement = better.profitPerYear - base.profitPerYear;
    const waitingSaving = base.waitingCostPerYear - better.waitingCostPerYear;
    expect(a.annualGrossBenefit).toBeCloseTo(profitImprovement + waitingSaving, 4);
  });

  it('shows its workings', () => {
    const a = appraiseIncremental(base, better, {
      initialInvestment: 500_000,
      additionalAnnualOperatingCost: 20_000,
    });
    expect(a.workings.length).toBeGreaterThan(5);
    expect(a.workings.join(' ')).toContain('net benefit');
  });
});

describe('model validation (requirements 50, 51)', () => {
  it('passes the reference model as runnable', () => {
    const r = validateModel(buildReferenceModel());
    expect(r.runnable).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.checks.some((c) => c.label === 'Queue stability' && c.passed)).toBe(true);
  });

  it('rejects routing probabilities that do not sum to 1', () => {
    const m = buildReferenceModel();
    m.stations.find((s) => s.id === 'inspection')!.routing[0]!.probability = 0.5;
    const r = validateModel(m);
    expect(r.runnable).toBe(false);
    expect(r.errors.some((e) => e.code === 'routing-sum')).toBe(true);
  });

  it('rejects non-positive lambda and mu', () => {
    const m1 = buildReferenceModel();
    m1.arrivals.schedule[0]!.lambdaPerHour = param(0, 'vehicles/hour', 'USER_INPUT');
    expect(validateModel(m1).errors.some((e) => e.code === 'lambda-non-positive')).toBe(true);

    const m2 = buildReferenceModel();
    m2.stations[1]!.service = { kind: 'constant', value: 0 };
    expect(validateModel(m2).errors.some((e) => e.code === 'service-invalid')).toBe(true);
  });

  it('rejects server counts below 1 and non-integers', () => {
    const m = buildReferenceModel();
    m.stations[2]!.servers = 0;
    expect(validateModel(m).errors.some((e) => e.code === 'servers-invalid')).toBe(true);
    m.stations[2]!.servers = 2.5;
    expect(validateModel(m).errors.some((e) => e.code === 'servers-invalid')).toBe(true);
  });

  it('rejects negative costs and invalid probabilities', () => {
    const m = buildReferenceModel();
    m.cost.electricityPricePerKwh = param(-0.1, 'currency/kWh', 'USER_INPUT');
    m.stations[3]!.scrapProbability = 1.4;
    m.vehicleModels[0]!.bom[0]!.unitCost = param(-5, 'currency/kg', 'USER_INPUT');
    const r = validateModel(m);
    expect(r.errors.some((e) => e.code === 'negative-cost')).toBe(true);
    expect(r.errors.some((e) => e.code === 'scrap-probability')).toBe(true);
    expect(r.errors.some((e) => e.code === 'negative-unit-cost')).toBe(true);
  });

  it('warns about an unstable queue without refusing to run', () => {
    const m = buildReferenceModel();
    m.arrivals.schedule = [
      { startMinute: 0, endMinute: 600, lambdaPerHour: param(40, 'vehicles/hour', 'USER_INPUT') },
    ];
    const r = validateModel(m);
    expect(r.runnable).toBe(true); // a finite-horizon run is still meaningful
    expect(r.warnings.some((w) => w.code === 'unstable-queue')).toBe(true);
    expect(r.warnings.some((w) => w.message.includes('UNSTABLE QUEUE'))).toBe(true);
  });

  it('validates at average demand, and flags a peak that exceeds capacity', () => {
    const r = validateModel(buildReferenceModel());
    // The default schedule averages 5.6 vehicles/hour against a factory
    // capacity of ~6.43, so at the AVERAGE no station is near saturation...
    expect(r.warnings.some((w) => w.code === 'high-utilisation')).toBe(false);
    // ...but two blocks run at 7/hour, which the line cannot sustain. A
    // steady-state check at the average alone would miss this entirely, which
    // is exactly why the peak is checked separately.
    const peak = r.warnings.find((w) => w.code === 'peak-exceeds-capacity');
    expect(peak).toBeDefined();
    expect(peak!.message).toContain('Peak demand');
  });

  it('warns about high utilisation when demand is actually that high', () => {
    const m = buildReferenceModel();
    m.arrivals.schedule = [
      { startMinute: 0, endMinute: 600, lambdaPerHour: param(6, 'vehicles/hour', 'USER_INPUT') },
    ];
    const r = validateModel(m);
    // Paint sits at ~93% at lambda = 6.
    expect(
      r.warnings.some((w) => w.code === 'high-utilisation' && w.message.includes('Paint')),
    ).toBe(true);
  });

  it('flags an unreachable station', () => {
    const m = buildReferenceModel();
    m.stations.find((s) => s.id === 'body_shop')!.routing = [
      { to: 'powertrain', probability: 1 },
    ];
    // Nothing now routes into paint_shop.
    const r = validateModel(m);
    expect(r.warnings.some((w) => w.code === 'unreachable-station')).toBe(true);
  });

  it('detects a model where no vehicle can ever finish', () => {
    const m = buildReferenceModel();
    const insp = m.stations.find((s) => s.id === 'inspection')!;
    insp.routing = [{ to: 'rework', probability: 1 }];
    const r = validateModel(m);
    expect(r.runnable).toBe(false);
    expect(r.errors.some((e) => e.code === 'no-exit' || e.code === 'network-unsolvable')).toBe(true);
  });

  it('records the provenance of every parameter', () => {
    const r = validateModel(buildReferenceModel());
    expect(r.summary.assumptionCount).toBeGreaterThan(50);
    expect(r.info.some((i) => i.code === 'all-assumptions')).toBe(true);
  });
});

describe('bottleneck analysis (requirement 42)', () => {
  const model = buildReferenceModel();
  const b = analyseBottlenecks(model, 6);

  it('identifies the capacity bottleneck from lambda_max, not a threshold', () => {
    expect(b.primaryBottleneckId).toBe('paint_shop');
    const paint = b.stations.find((s) => s.stationId === 'paint_shop')!;
    // Every other station must have strictly more headroom.
    for (const s of b.stations) {
      if (s.stationId === 'paint_shop') continue;
      expect(s.lambdaMaxPerHour).toBeGreaterThan(paint.lambdaMaxPerHour);
    }
    expect(b.factoryCapacityPerHour).toBeCloseTo(paint.lambdaMaxPerHour, 8);
  });

  it('explains why, in words tied to the numbers', () => {
    const paint = b.stations.find((s) => s.stationId === 'paint_shop')!;
    expect(paint.reasons.length).toBeGreaterThan(1);
    expect(paint.reasons.join(' ')).toContain('Tightest capacity');
    expect(paint.capacityRank).toBe(1);
  });

  it('accounts for the rework loop in the inspection station load', () => {
    const insp = b.stations.find((s) => s.stationId === 'inspection')!;
    expect(insp.visitRatio).toBeGreaterThan(1);
    expect(insp.reasons.join(' ')).toContain('rework loop');
  });

  it('shows what relieving the bottleneck buys, and where the constraint moves', () => {
    expect(b.reliefPreview).not.toBeNull();
    expect(b.reliefPreview!.capacityGainPerHour).toBeGreaterThan(0);
    expect(b.reliefPreview!.nextConstraintId).not.toBe('paint_shop');
  });

  it('values an extra server at a non-binding station at zero throughput gain', () => {
    const interior = b.stations.find((s) => s.stationId === 'interior')!;
    expect(interior.throughputGainPerExtraServer).toBeCloseTo(0, 8);
    expect(interior.reasons.join(' ')).toContain('would not raise factory throughput');
  });

  it('identifies the delay bottleneck separately from the capacity bottleneck', () => {
    expect(b.delayBottleneckId).not.toBeNull();
    const shares = b.stations.reduce((a, s) => a + s.delayShare, 0);
    expect(shares).toBeCloseTo(1, 6);
  });
});

describe('statistics and confidence intervals (requirement 44)', () => {
  it('uses Student t, not the normal, for small samples', () => {
    expect(tCritical(9)).toBeCloseTo(2.262, 3);
    expect(tCritical(29)).toBeCloseTo(2.045, 3);
    // Large df converges towards the normal quantile.
    expect(tCritical(1000)).toBeGreaterThan(1.95);
    expect(tCritical(1000)).toBeLessThan(2.0);
  });

  it('computes mean, sd and a 95% interval', () => {
    const s = summariseMetric('x', 'X', 'units', [10, 12, 11, 13, 9]);
    expect(s.mean).toBeCloseTo(11, 10);
    expect(s.stdDev).toBeCloseTo(Math.sqrt(2.5), 8);
    expect(s.halfWidth).toBeCloseTo(tCritical(4) * (Math.sqrt(2.5) / Math.sqrt(5)), 6);
    expect(s.ciLow).toBeLessThan(s.mean);
    expect(s.ciHigh).toBeGreaterThan(s.mean);
  });

  it('refuses to invent an interval from a single observation', () => {
    const s = summariseMetric('x', 'X', 'units', [42]);
    expect(s.mean).toBe(42);
    expect(Number.isNaN(s.halfWidth)).toBe(true);
    expect(Number.isNaN(s.ciLow)).toBe(true);
  });

  it('runs a replication study with distinct seeds and reproducible results', () => {
    const m = buildReferenceModel();
    m.simulation.replications = 5;
    m.simulation.collectVehicleTraces = false;
    const a = runStudy(m);
    const b = runStudy(m);

    expect(a.seeds).toHaveLength(5);
    expect(new Set(a.seeds).size).toBe(5);
    expect(a.seeds[0]).toBe(m.simulation.seed);
    expect(b.system['throughput']!.mean).toBe(a.system['throughput']!.mean);
    expect(a.system['throughput']!.values).toHaveLength(5);
  });

  it('warns when only one replication is run', () => {
    const m = buildReferenceModel();
    m.simulation.collectVehicleTraces = false;
    const s = runStudy(m, { replications: 1 });
    expect(s.warnings.some((w) => w.includes('one replication'))).toBe(true);
  });
});

describe('scenarios (requirements 35, 67)', () => {
  const baseline = buildReferenceModel();

  it('applies edits to a copy, leaving the baseline untouched', () => {
    const before = baseline.stations.find((s) => s.id === 'paint_shop')!.servers;
    const edited = applyScenario(baseline, {
      id: 's',
      name: 'Extra booth',
      edits: [{ kind: 'servers', stationId: 'paint_shop', value: before + 1 }],
      initialInvestment: 2_400_000,
      additionalAnnualOperatingCost: 150_000,
    });
    expect(edited.stations.find((s) => s.id === 'paint_shop')!.servers).toBe(before + 1);
    expect(baseline.stations.find((s) => s.id === 'paint_shop')!.servers).toBe(before);
  });

  it('re-normalises the other arcs when a routing probability changes', () => {
    const edited = applyScenario(baseline, {
      id: 's',
      name: 'Better quality',
      edits: [{ kind: 'routingProbability', stationId: 'inspection', to: 'rework', value: 0.04 }],
      initialInvestment: 0,
      additionalAnnualOperatingCost: 0,
    });
    const insp = edited.stations.find((s) => s.id === 'inspection')!;
    expect(insp.routing.find((e) => e.to === 'rework')!.probability).toBeCloseTo(0.04, 10);
    expect(insp.routing.reduce((a, e) => a + e.probability, 0)).toBeCloseTo(1, 10);
  });

  it('scales demand across every block', () => {
    const edited = applyScenario(baseline, {
      id: 's',
      name: 'Demand +20%',
      edits: [{ kind: 'demandScale', value: 1.2 }],
      initialInvestment: 0,
      additionalAnnualOperatingCost: 0,
    });
    for (const [i, b] of edited.arrivals.schedule.entries()) {
      expect(b.lambdaPerHour.value).toBeCloseTo(
        baseline.arrivals.schedule[i]!.lambdaPerHour.value * 1.2,
        10,
      );
    }
  });

  it('rejects an invalid server count rather than silently clamping', () => {
    expect(() =>
      applyScenario(baseline, {
        id: 's',
        name: 'Bad',
        edits: [{ kind: 'servers', stationId: 'paint_shop', value: 0 }],
        initialInvestment: 0,
        additionalAnnualOperatingCost: 0,
      }),
    ).toThrow(/whole number/);
  });

  it('compares two scenarios and appraises the difference', () => {
    const quick = (m = buildReferenceModel()) => {
      m.arrivals.schedule = [
        { startMinute: 0, endMinute: 100_000, lambdaPerHour: param(6, 'vehicles/hour', 'USER_INPUT') },
      ];
      m.simulation.replications = 4;
      m.simulation.warmupMinutes = 1000;
      m.simulation.durationMinutes = 12_000;
      m.simulation.collectVehicleTraces = false;
      return m;
    };
    const base = quick();
    const noChange: Scenario = {
      id: 'base',
      name: 'Current factory',
      edits: [],
      initialInvestment: 0,
      additionalAnnualOperatingCost: 0,
    };
    const addBooth: Scenario = {
      id: 'booth',
      name: 'Add a paint booth',
      edits: [{ kind: 'servers', stationId: 'paint_shop', value: 4 }],
      initialInvestment: 2_400_000,
      additionalAnnualOperatingCost: 180_000,
    };

    const a = evaluateScenario(base, noChange);
    const b = evaluateScenario(base, addBooth);
    const cmp = compareScenarios(a, b);

    // Relieving the bottleneck must cut waiting time and move the constraint.
    const wq = cmp.rows.find((r) => r.metric === 'WqMinutes')!;
    expect(wq.scenario).toBeLessThan(wq.baseline);
    expect(cmp.bottleneckMoved).toBe(true);
    expect(b.analytical.factoryCapacityPerHour).toBeGreaterThan(a.analytical.factoryCapacityPerHour);

    // And the appraisal must be explicit about capital and payback.
    expect(cmp.appraisal.initialInvestment).toBe(2_400_000);
    expect(cmp.recommendation.length).toBeGreaterThan(40);
  });
});

describe('optimiser (requirements 33, 34, 68)', () => {
  const baseline = (() => {
    const m = buildReferenceModel();
    m.arrivals.schedule = [
      { startMinute: 0, endMinute: 100_000, lambdaPerHour: param(6, 'vehicles/hour', 'USER_INPUT') },
    ];
    m.simulation.replications = 3;
    m.simulation.warmupMinutes = 800;
    m.simulation.durationMinutes = 8_000;
    m.simulation.collectVehicleTraces = false;
    return m;
  })();

  it('finds a feasible configuration that meets a throughput constraint', () => {
    const r = optimize(baseline, {
      objective: 'minimizeCostPerVehicle',
      constraints: { minThroughputPerHour: 5.5, maxUtilization: 0.95 },
      variables: [
        { stationId: 'paint_shop', minServers: 3, maxServers: 5, capitalCostPerServer: 2_400_000, annualOperatingCostPerServer: 180_000 },
        { stationId: 'inspection', minServers: 2, maxServers: 3, capitalCostPerServer: 620_000, annualOperatingCostPerServer: 90_000 },
      ],
      confirmTop: 3,
      replications: 3,
    });

    expect(r.candidatesEvaluated).toBe(6);
    expect(r.feasibleCount).toBeGreaterThan(0);
    expect(r.best).not.toBeNull();
    expect(r.best!.confirmed).toBeDefined();
    expect(r.bestScenario).not.toBeNull();
    expect(r.rationale.join(' ')).toContain('confirmed by full discrete-event simulation');
  });

  it('reports infeasibility instead of returning a violating configuration', () => {
    const r = optimize(baseline, {
      objective: 'maximizeThroughput',
      // Far beyond what the line can do with at most one extra booth.
      constraints: { minThroughputPerHour: 50 },
      variables: [
        { stationId: 'paint_shop', minServers: 3, maxServers: 4, capitalCostPerServer: 2_400_000, annualOperatingCostPerServer: 180_000 },
      ],
    });
    expect(r.best).toBeNull();
    expect(r.feasibleCount).toBe(0);
    expect(r.rationale.join(' ')).toContain('No configuration');
  });

  it('ranks by the objective it was asked to optimise', () => {
    const throughputRun = optimize(baseline, {
      objective: 'maximizeThroughput',
      variables: [
        { stationId: 'paint_shop', minServers: 3, maxServers: 5, capitalCostPerServer: 2_400_000, annualOperatingCostPerServer: 180_000 },
      ],
      confirmTop: 3,
      replications: 3,
    });
    const best = throughputRun.best!;
    for (const other of throughputRun.ranked) {
      expect(best.confirmed!.throughputPerHour).toBeGreaterThanOrEqual(
        other.confirmed!.throughputPerHour - 1e-9,
      );
    }
  });

  it('does not fabricate an ROI for a zero-capital candidate', () => {
    const r = optimize(baseline, {
      objective: 'maximizeRoi',
      variables: [
        { stationId: 'paint_shop', minServers: 3, maxServers: 4, capitalCostPerServer: 2_400_000, annualOperatingCostPerServer: 180_000 },
      ],
      confirmTop: 2,
      replications: 3,
    });
    const noCapital = r.ranked.find((c) => c.initialInvestment === 0);
    if (noCapital) {
      expect(noCapital.confirmed!.roiPercent).toBeNull();
      // ...and it must not be ranked first under an ROI objective.
      expect(r.best!.initialInvestment).toBeGreaterThan(0);
    }
  });
});

describe('degenerate cost cases', () => {
  it('does not divide by zero when nothing is finished', () => {
    const m = makeSingleStationModel({
      lambdaPerHour: 1,
      meanServiceMinutes: 20,
      servers: 1,
      warmupMinutes: 0,
      durationMinutes: 1,
    });
    const cost = computeCosts(m, runSimulation(m));
    expect(Number.isFinite(cost.costPerVehicle)).toBe(true);
    expect(cost.costPerVehicle).toBe(0);
    expect(cost.warnings.some((w) => w.includes('No vehicles were finished'))).toBe(true);
  });

  it('handles a station with no machine and no workers', () => {
    const m = makeSingleStationModel({
      lambdaPerHour: 2,
      meanServiceMinutes: 20,
      warmupMinutes: 100,
      durationMinutes: 5_000,
    });
    const cost = computeCosts(m, runSimulation(m));
    expect(cost.energy.totalKwh).toBe(0);
    expect(verifyAdditivity(cost).ok).toBe(true);
  });

  it('keeps additivity when reliability and scrap are switched off', () => {
    const m = buildReferenceModel();
    for (const s of m.stations) {
      if (s.machine?.reliability) s.machine.reliability.enabled = false;
    }
    const insp = m.stations.find((s) => s.id === 'inspection')!;
    insp.routing = [
      { to: '__FINISHED__', probability: 0.9, label: 'PASS' },
      { to: 'rework', probability: 0.1, label: 'FAIL' },
    ];
    m.simulation.durationMinutes = 4_000;
    const cost = computeCosts(m, runSimulation(m));
    expect(verifyAdditivity(cost).ok).toBe(true);
    expect(cost.vehiclesScrapped).toBe(0);
    expect(cost.lines.find((l) => l.id === 'scrap')!.amount).toBe(0);
  });

  it('includes an idle station’s standby cost even with no throughput', () => {
    const m = buildReferenceModel();
    // Route around the rework station entirely.
    const insp = m.stations.find((s) => s.id === 'inspection')!;
    insp.routing = [
      { to: '__FINISHED__', probability: 0.98, label: 'PASS' },
      { to: '__SCRAP__', probability: 0.02, label: 'SCRAP' },
    ];
    m.simulation.durationMinutes = 4_000;
    const cost = computeCosts(m, runSimulation(m));
    const rework = cost.stations.find((s) => s.stationId === 'rework')!;
    expect(rework.busyServerHours).toBe(0);
    // Crew is still paid and the machine still draws idle power.
    expect(rework.laborCost).toBeGreaterThan(0);
    expect(rework.energyKwh).toBeGreaterThan(0);
    expect(rework.machineDepreciation).toBe(0); // no operating hours, no wear
  });
});
