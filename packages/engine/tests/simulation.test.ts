/**
 * Discrete-event simulation tests — requirements 2, 3, 11, 19, 45, 58, 59.
 *
 * Requirement 59 is the important one: the simulator is checked against systems
 * whose exact answers are known. If the DES could not reproduce M/M/1 and
 * M/M/c to within sampling error, nothing built on top of it would mean
 * anything.
 *
 * These runs are long on purpose. Queueing statistics converge slowly, and a
 * short run would either produce a flaky test or force a tolerance so loose it
 * would pass even if the engine were wrong.
 */

import { describe, expect, it } from 'vitest';
import { Simulation, runSimulation } from '../src/des/simulation.js';
import { mm1, mmc } from '../src/analytical/queues.js';
import { solveNetwork } from '../src/analytical/network.js';
import { makeSingleStationModel } from '../src/model/defaults.js';
import { buildReferenceModel } from '../src/model/referenceModel.js';
import { cycleTimeMinutes } from '../src/des/vehicle.js';
import { param } from '../src/model/types.js';
import { Rng, RngStreams } from '../src/rng.js';
import { distMean, sample } from '../src/distributions.js';

/** Relative error helper. */
const relErr = (sim: number, exact: number) => Math.abs(sim - exact) / Math.abs(exact);

describe('RNG determinism (requirement 2)', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different sequences for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    expect(same).toBeLessThan(5);
  });

  it('gives each named substream an independent, stable sequence', () => {
    const s1 = new RngStreams(12345);
    const s2 = new RngStreams(12345);
    // Creation ORDER must not matter.
    const b2 = s2.get('service:paint').next();
    void s2.get('arrivals').next();
    const b1 = s1.get('service:paint').next();
    expect(b1).toBe(b2);
  });

  it('keeps uniforms strictly inside [0,1) and nextOpen above 0', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10000; i++) {
      const u = r.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(r.nextOpen()).toBeGreaterThan(0);
    }
  });
});

describe('sampled distributions match their stated moments', () => {
  const cases = [
    { name: 'exponential', d: { kind: 'exponential', mean: 10 } as const },
    { name: 'erlang-3', d: { kind: 'erlang', k: 3, mean: 10 } as const },
    { name: 'lognormal', d: { kind: 'lognormal', mean: 10, sd: 4 } as const },
    { name: 'uniform', d: { kind: 'uniform', min: 5, max: 15 } as const },
    { name: 'triangular', d: { kind: 'triangular', min: 4, mode: 9, max: 17 } as const },
    { name: 'gamma', d: { kind: 'gamma', shape: 2.5, scale: 4 } as const },
    { name: 'weibull', d: { kind: 'weibull', shape: 1.8, scale: 11 } as const },
    { name: 'constant', d: { kind: 'constant', value: 10 } as const },
  ];

  for (const { name, d } of cases) {
    it(`${name}: sample mean converges to the theoretical mean`, () => {
      const rng = new Rng(999);
      const n = 200_000;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const x = sample(d, rng);
        expect(x).toBeGreaterThanOrEqual(0);
        sum += x;
      }
      expect(relErr(sum / n, distMean(d))).toBeLessThan(0.02);
    });
  }
});

describe('M/M/1 simulation vs closed form (requirement 59)', () => {
  // lambda = 2/hr, mu = 3/hr  =>  rho = 2/3, L = 2, Lq = 4/3, W = 1 hr, Wq = 2/3 hr
  const model = makeSingleStationModel({
    lambdaPerHour: 2,
    meanServiceMinutes: 20,
    servers: 1,
    seed: 12345,
    warmupMinutes: 20_000,
    durationMinutes: 3_000_000, // 50,000 simulated hours
  });
  model.simulation.terminationMode = 'drain';
  const result = runSimulation(model);
  const exact = mm1(2, 3);
  const st = result.stations[0];

  it('reproduces utilisation', () => {
    expect(st).toBeDefined();
    expect(relErr(st!.utilization, exact.rho)).toBeLessThan(0.02);
  });

  it('reproduces L and Lq', () => {
    expect(relErr(st!.L, exact.L)).toBeLessThan(0.05);
    expect(relErr(st!.Lq, exact.Lq)).toBeLessThan(0.06);
  });

  it('reproduces W and Wq', () => {
    expect(relErr(st!.W, exact.W)).toBeLessThan(0.05);
    expect(relErr(st!.Wq, exact.Wq)).toBeLessThan(0.06);
  });

  it('observes the configured arrival rate', () => {
    expect(relErr(st!.lambdaObserved, 2)).toBeLessThan(0.02);
  });

  it('satisfies Little’s Law on the SIMULATED numbers', () => {
    // L = lambda * W, using quantities measured independently by the simulator:
    // L from the time-weighted area, W from per-vehicle sojourn times.
    expect(relErr(st!.L, st!.lambdaObserved * st!.W)).toBeLessThan(0.05);
    expect(relErr(st!.Lq, st!.lambdaObserved * st!.Wq)).toBeLessThan(0.06);
  });
});

describe('M/M/c simulation vs Erlang C (requirement 59)', () => {
  // lambda = 4/hr, mu = 3/hr/server, c = 2  =>  rho = 2/3
  const model = makeSingleStationModel({
    lambdaPerHour: 4,
    meanServiceMinutes: 20,
    servers: 2,
    seed: 777,
    warmupMinutes: 20_000,
    durationMinutes: 3_000_000,
  });
  model.simulation.terminationMode = 'drain';
  const result = runSimulation(model);
  const exact = mmc(4, 3, 2);
  const st = result.stations[0];

  it('reproduces utilisation', () => {
    expect(relErr(st!.utilization, exact.rho)).toBeLessThan(0.02);
  });

  it('reproduces Lq and Wq from the Erlang C solution', () => {
    expect(relErr(st!.Lq, exact.Lq)).toBeLessThan(0.07);
    expect(relErr(st!.Wq, exact.Wq)).toBeLessThan(0.07);
  });

  it('reproduces L and W', () => {
    expect(relErr(st!.L, exact.L)).toBeLessThan(0.05);
    expect(relErr(st!.W, exact.W)).toBeLessThan(0.05);
  });
});

describe('M/D/1 simulation vs Pollaczek-Khinchine', () => {
  const model = makeSingleStationModel({
    lambdaPerHour: 2,
    meanServiceMinutes: 20,
    servers: 1,
    seed: 4242,
    warmupMinutes: 20_000,
    durationMinutes: 2_000_000,
  });
  (model.stations[0] as (typeof model.stations)[number]).service = { kind: 'constant', value: 20 };
  model.simulation.terminationMode = 'drain';
  const result = runSimulation(model);
  const exactLq = mm1(2, 3).Lq / 2; // Cs^2 = 0 halves the M/M/1 queue
  const st = result.stations[0];

  it('halves the M/M/1 queue length', () => {
    expect(relErr(st!.Lq, exactLq)).toBeLessThan(0.08);
  });

  it('keeps utilisation unchanged, since only variability differs', () => {
    expect(relErr(st!.utilization, 2 / 3)).toBeLessThan(0.02);
  });
});

describe('reproducibility (requirement 2)', () => {
  it('two runs with the same seed give identical results', () => {
    const a = runSimulation(buildReferenceModel());
    const b = runSimulation(buildReferenceModel());
    expect(b.system.vehiclesCompleted).toBe(a.system.vehiclesCompleted);
    expect(b.system.cycleTime.meanMinutes).toBe(a.system.cycleTime.meanMinutes);
    expect(b.eventsProcessed).toBe(a.eventsProcessed);
    for (let i = 0; i < a.stations.length; i++) {
      expect(b.stations[i]!.utilization).toBe(a.stations[i]!.utilization);
      expect(b.stations[i]!.Lq).toBe(a.stations[i]!.Lq);
    }
  });

  it('a different seed gives a different sample path', () => {
    const a = runSimulation(buildReferenceModel());
    const m = buildReferenceModel();
    m.simulation.seed = 999_111;
    const b = runSimulation(m);
    expect(b.system.cycleTime.meanMinutes).not.toBe(a.system.cycleTime.meanMinutes);
  });

  it('stepping one event at a time gives the same result as running straight through', () => {
    const straight = runSimulation(buildReferenceModel());
    const sim = new Simulation(buildReferenceModel());
    let guard = 0;
    while (!sim.isFinished && guard++ < 10_000_000) {
      if (sim.step() === null) break;
    }
    const stepped = sim.result();
    expect(stepped.system.vehiclesCompleted).toBe(straight.system.vehiclesCompleted);
    expect(stepped.eventsProcessed).toBe(straight.eventsProcessed);
  });
});

describe('vehicle lifecycle (requirement 3)', () => {
  const model = buildReferenceModel();
  model.simulation.collectVehicleTraces = true;
  model.simulation.maxTraces = 2000;
  // One 8-hour shift completes only ~45 vehicles, so at a 10% failure rate a
  // single shift can plausibly contain zero reworked vehicles. The lifecycle
  // assertions below need the rework path to actually be exercised, so this
  // runs long enough for that to be certain rather than likely.
  model.simulation.durationMinutes = 20_000;
  const result = runSimulation(model);

  it('records a full per-vehicle history', () => {
    const v = result.traces.find((x) => x.status === 'FINISHED');
    expect(v).toBeDefined();
    expect(v!.visits.length).toBeGreaterThan(5);
    expect(v!.arrivalTime).toBeGreaterThanOrEqual(0);
    expect(v!.completionTime).not.toBeNull();
    for (const visit of v!.visits) {
      expect(visit.waitMinutes).toBeGreaterThanOrEqual(0);
      expect(visit.processingMinutes).toBeGreaterThanOrEqual(0);
      expect(visit.enqueuedAt).toBeGreaterThanOrEqual(0);
    }
  });

  it('cycle time equals completion minus arrival, and the components sum to it', () => {
    for (const v of result.traces.filter((x) => x.status === 'FINISHED').slice(0, 200)) {
      const total = cycleTimeMinutes(v) as number;
      expect(total).toBeCloseTo((v.completionTime as number) - v.arrivalTime, 9);
      const accounted =
        v.totalWaitMinutes + v.totalProcessingMinutes + v.totalDowntimeMinutes;
      // Zero transport time means the parts must account for the whole cycle.
      expect(Math.abs(total - accounted)).toBeLessThan(1e-6);
    }
  });

  it('visits the stations in the order the routing specifies', () => {
    const v = result.traces.find((x) => x.status === 'FINISHED' && x.reworkCount === 0);
    expect(v).toBeDefined();
    expect(v!.visits.map((x) => x.stationId)).toEqual([
      'parts_receiving',
      'body_manufacturing',
      'body_shop',
      'paint_shop',
      'powertrain',
      'interior',
      'electrical',
      'final_assembly',
      'inspection',
    ]);
  });

  it('sends reworked vehicles back to inspection', () => {
    const v = result.traces.find((x) => x.reworkCount > 0 && x.status === 'FINISHED');
    expect(v).toBeDefined();
    const ids = v!.visits.map((x) => x.stationId);
    const firstInspection = ids.indexOf('inspection');
    expect(ids[firstInspection + 1]).toBe('rework');
    expect(ids[firstInspection + 2]).toBe('inspection');
    expect(v!.inspectionCount).toBeGreaterThanOrEqual(2);
    // The failing inspection visit is labelled FAIL, the last one PASS.
    expect(v!.visits[firstInspection]!.outcome).toBe('FAIL');
    expect(v!.visits[v!.visits.length - 1]!.outcome).toBe('PASS');
  });

  it('never gives an unfinished vehicle a cycle time', () => {
    const inSystem = result.traces.filter((v) => v.status === 'IN_SYSTEM');
    for (const v of inSystem) expect(cycleTimeMinutes(v)).toBeNull();
  });
});

describe('rework and scrap routing observed frequencies', () => {
  const model = buildReferenceModel();
  model.simulation.warmupMinutes = 600;
  model.simulation.durationMinutes = 400_000;
  model.simulation.collectVehicleTraces = false;
  const result = runSimulation(model);

  it('inspection fail rate matches the configured routing probability', () => {
    const insp = result.stations.find((s) => s.stationId === 'inspection');
    const rw = result.stations.find((s) => s.stationId === 'rework');
    expect(insp).toBeDefined();
    const observedFail = rw!.arrivals / insp!.completions;
    expect(relErr(observedFail, 0.1)).toBeLessThan(0.05);
  });

  it('scrap rate matches the configured probability', () => {
    const insp = result.stations.find((s) => s.stationId === 'inspection');
    const observedScrap = result.system.vehiclesScrapped / insp!.completions;
    expect(relErr(observedScrap, 0.02)).toBeLessThan(0.12);
  });

  it('completed plus scrapped accounts for everything that left the system', () => {
    const left = result.system.vehiclesCompleted + result.system.vehiclesScrapped;
    const entered = result.system.vehiclesEntered;
    // Entered - left = still in the factory, within the drain tolerance.
    expect(left).toBeLessThanOrEqual(entered + 1);
    expect(entered - left).toBeLessThan(entered * 0.01);
  });
});

describe('network simulation vs analytical decomposition (requirement 43)', () => {
  // Constant demand so the steady-state comparison is apples to apples, and
  // machine reliability switched OFF because the closed-form models have no
  // notion of a server that fails. Comparing a simulation WITH breakdowns
  // against an analytical model WITHOUT them measures the modelling gap, not
  // the simulator's accuracy; that gap is asserted separately below.
  const model = buildReferenceModel();
  model.arrivals.schedule = [
    { startMinute: 0, endMinute: 5_000_000, lambdaPerHour: param(6, 'vehicles/hour', 'USER_INPUT') },
  ];
  model.simulation.warmupMinutes = 20_000;
  model.simulation.durationMinutes = 1_000_000;
  model.simulation.collectVehicleTraces = false;
  model.simulation.terminationMode = 'hardStop';
  for (const st of model.stations) {
    if (st.machine?.reliability) st.machine.reliability.enabled = false;
  }
  const sim = runSimulation(model);
  const analytic = solveNetwork(model, 6);

  it('matches derived per-station arrival rates', () => {
    for (const a of analytic.stations) {
      const s = sim.stations.find((x) => x.stationId === a.stationId);
      expect(s).toBeDefined();
      expect(relErr(s!.lambdaObserved, a.lambda)).toBeLessThan(0.03);
    }
  });

  it('matches utilisation at every exponential station', () => {
    for (const a of analytic.stations) {
      const s = sim.stations.find((x) => x.stationId === a.stationId);
      expect(relErr(s!.utilization, a.rho)).toBeLessThan(0.04);
    }
  });

  it('matches Lq at the exactly-solvable stations', () => {
    for (const a of analytic.stations.filter((x) => x.exact && x.Lq > 0.05)) {
      const s = sim.stations.find((x) => x.stationId === a.stationId);
      // Tolerance widens with utilisation: the variance of a time-average
      // queue length grows roughly like (1-rho)^-4, so a station at rho = 0.93
      // is far noisier over a finite run than one at rho = 0.4. These bounds
      // are the sampling error of the run length above, not slack for bias.
      const tol = a.rho > 0.9 ? 0.25 : a.rho > 0.75 ? 0.15 : 0.1;
      expect(relErr(s!.Lq, a.Lq)).toBeLessThan(tol);
    }
  });

  it('matches system-level L against the sum of analytical node L', () => {
    expect(relErr(sim.system.L, analytic.system.L)).toBeLessThan(0.2);
  });

  it('satisfies Little’s Law across the whole system on simulated numbers', () => {
    // System W uses the EXTERNAL rate, not the sum of node rates.
    const lambdaExternal = 6;
    expect(relErr(sim.system.L, lambdaExternal * sim.system.W)).toBeLessThan(0.2);
  });

  it('marks stations downstream of the Erlang-2 station as approximate, not exact', () => {
    const insp = analytic.stations.find((x) => x.stationId === 'inspection');
    const rw = analytic.stations.find((x) => x.stationId === 'rework');
    const paint = analytic.stations.find((x) => x.stationId === 'paint_shop');
    // Inspection is M/M/2 by its own service time, but it is fed by the
    // Erlang-2 final assembly, so its arrivals are not Poisson.
    expect(insp!.kendall).toBe('M/M/2');
    expect(insp!.exact).toBe(false);
    expect(rw!.exact).toBe(false);
    // Paint sits upstream of the Erlang-2 station and is genuinely exact.
    expect(paint!.exact).toBe(true);
    expect(analytic.warnings.some((w) => w.includes('not Poisson'))).toBe(true);
  });

  it('shows the smoother-than-Poisson input shortening the inspection queue', () => {
    // Erlang-2 output is less variable than Poisson, so the true queue at
    // inspection is SHORTER than its M/M/2 formula predicts. This is the
    // decomposition error the warning describes, measured.
    const a = analytic.stations.find((x) => x.stationId === 'inspection');
    const s = sim.stations.find((x) => x.stationId === 'inspection');
    expect(s!.Lq).toBeLessThan(a!.Lq);
    expect(relErr(s!.Lq, a!.Lq)).toBeLessThan(0.25);
  });

  it('confirms Erlang-2 final assembly queues less than an exponential one would', () => {
    const s = sim.stations.find((x) => x.stationId === 'final_assembly');
    const asIfExponential = mmc(6, 2, 4); // mu = 60/30 = 2/hr/server
    expect(s!.Lq).toBeLessThan(asIfExponential.Lq);
  });
});

describe('warm-up period (requirement 45)', () => {
  it('removes the empty-start bias, averaged over independent replications', () => {
    // A single sample path proves nothing here: at high utilisation the
    // time-average queue length wanders enormously, and one run can easily
    // show the bias with the wrong sign. The claim being tested is about the
    // EXPECTED value, so it is tested across independent replications.
    const build = (warmupMinutes: number, seed: number) => {
      const m = makeSingleStationModel({
        lambdaPerHour: 2.7,
        meanServiceMinutes: 20, // mu = 3/hr, rho = 0.9
        servers: 1,
        seed,
        warmupMinutes,
        durationMinutes: 4_000,
      });
      m.simulation.terminationMode = 'hardStop';
      return m;
    };

    const reps = 24;
    let coldSum = 0;
    let warmSum = 0;
    for (let i = 0; i < reps; i++) {
      const seed = 1000 + i * 7919;
      coldSum += runSimulation(build(0, seed)).system.L;
      warmSum += runSimulation(build(12_000, seed)).system.L;
    }
    const cold = coldSum / reps;
    const warm = warmSum / reps;
    const exact = mm1(2.7, 3).L; // = 9

    // Starting empty drags the average down; the warmed estimate sits closer
    // to the true steady-state value.
    expect(warm).toBeGreaterThan(cold);
    expect(Math.abs(warm - exact)).toBeLessThan(Math.abs(cold - exact));
  });

  it('counts only arrivals inside the measurement window', () => {
    const m = makeSingleStationModel({
      lambdaPerHour: 6,
      meanServiceMinutes: 5,
      servers: 2,
      seed: 4711,
      warmupMinutes: 30_000,
      durationMinutes: 30_000,
    });
    m.simulation.terminationMode = 'hardStop';
    const r = runSimulation(m);
    // 6/hr over 500 measured hours = ~3000, NOT the ~6000 of the full horizon.
    expect(r.system.vehiclesEntered).toBeGreaterThan(2700);
    expect(r.system.vehiclesEntered).toBeLessThan(3300);
  });

  it('reports the measurement window, not the whole horizon', () => {
    const m = buildReferenceModel();
    m.simulation.warmupMinutes = 120;
    m.simulation.durationMinutes = 480;
    const r = runSimulation(m);
    expect(r.system.measurementMinutes).toBeCloseTo(480, 6);
  });
});

describe('machine breakdowns (requirement 19)', () => {
  it('reduces throughput and shows downtime when reliability is enabled', () => {
    const withFailures = buildReferenceModel();
    withFailures.arrivals.schedule = [
      { startMinute: 0, endMinute: 1_000_000, lambdaPerHour: param(5, 'vehicles/hour', 'USER_INPUT') },
    ];
    withFailures.simulation.warmupMinutes = 5000;
    withFailures.simulation.durationMinutes = 200_000;
    withFailures.simulation.collectVehicleTraces = false;

    const withoutFailures = structuredClone(withFailures);
    for (const s of withoutFailures.stations) {
      if (s.machine?.reliability) s.machine.reliability.enabled = false;
    }

    const a = runSimulation(withFailures);
    const b = runSimulation(withoutFailures);

    const paintA = a.stations.find((s) => s.stationId === 'paint_shop');
    const paintB = b.stations.find((s) => s.stationId === 'paint_shop');

    expect(paintA!.breakdowns).toBeGreaterThan(0);
    expect(paintA!.downServerMinutes).toBeGreaterThan(0);
    expect(paintB!.breakdowns).toBe(0);
    expect(paintB!.downServerMinutes).toBe(0);

    // Lost capacity has to show up as a longer queue.
    expect(paintA!.Lq).toBeGreaterThan(paintB!.Lq);
    expect(a.system.cycleTime.meanMinutes).toBeGreaterThan(b.system.cycleTime.meanMinutes);
  });

  it('observed availability is close to MTBF/(MTBF+MTTR)', () => {
    const m = makeSingleStationModel({
      lambdaPerHour: 2.4,
      meanServiceMinutes: 20,
      servers: 1,
      seed: 31337,
      warmupMinutes: 20_000,
      durationMinutes: 2_000_000,
    });
    const st = m.stations[0] as (typeof m.stations)[number];
    st.machine = {
      id: 'mx',
      name: 'Test machine',
      purchasePrice: param(0, 'currency'),
      usefulLifeYears: param(10, 'years'),
      salvageValue: param(0, 'currency'),
      annualOperatingHours: param(2000, 'hours/year'),
      powerKw: param(0, 'kW'),
      idlePowerKw: param(0, 'kW'),
      maintenanceCostPerHour: param(0, 'currency/hour'),
      consumablesCostPerHour: param(0, 'currency/hour'),
      includeDepreciation: false,
      reliability: {
        enabled: true,
        mtbfHours: param(10, 'operating hours'),
        mttrHours: param(1, 'hours'),
        repairCostPerHour: param(0, 'currency/hour'),
        failureDist: 'exponential',
        repairDist: 'exponential',
      },
    };
    m.simulation.terminationMode = 'drain';
    const r = runSimulation(m);
    const s = r.stations[0]!;

    // Failures are clocked on OPERATING time: expected repair time per hour of
    // processing is MTTR/MTBF, so down-minutes should be ~1/10 of busy-minutes.
    const ratio = s.downServerMinutes / s.busyServerMinutes;
    expect(ratio).toBeGreaterThan(0.07);
    expect(ratio).toBeLessThan(0.14);
    expect(s.breakdowns).toBeGreaterThan(100);
  });
});

describe('queue capacity and rejections', () => {
  it('turns arrivals away when a finite buffer is full', () => {
    const m = makeSingleStationModel({
      lambdaPerHour: 6,
      meanServiceMinutes: 20,
      servers: 1,
      seed: 5,
      warmupMinutes: 1000,
      durationMinutes: 100_000,
    });
    (m.stations[0] as (typeof m.stations)[number]).queueCapacity = 3;
    const r = runSimulation(m);
    expect(r.system.vehiclesRejected).toBeGreaterThan(0);
    expect(r.stations[0]!.maxQueueLength).toBeLessThanOrEqual(3);
    // A loss system stays stable even though lambda > mu.
    expect(r.stations[0]!.utilization).toBeLessThanOrEqual(1);
  });
});

describe('queue disciplines', () => {
  const build = (discipline: 'FIFO' | 'LIFO' | 'SPT') => {
    const m = makeSingleStationModel({
      lambdaPerHour: 2.7,
      meanServiceMinutes: 20,
      servers: 1,
      seed: 24680,
      warmupMinutes: 10_000,
      durationMinutes: 500_000,
    });
    (m.stations[0] as (typeof m.stations)[number]).queueDiscipline = discipline;
    m.simulation.terminationMode = 'drain';
    return runSimulation(m);
  };

  it('leaves mean Wq unchanged for FIFO vs LIFO (work-conserving, non-preemptive)', () => {
    const fifo = build('FIFO');
    const lifo = build('LIFO');
    expect(relErr(lifo.stations[0]!.Wq, fifo.stations[0]!.Wq)).toBeLessThan(0.12);
  });

  it('reduces mean Wq under shortest-processing-time first', () => {
    const fifo = build('FIFO');
    const spt = build('SPT');
    expect(spt.stations[0]!.Wq).toBeLessThan(fifo.stations[0]!.Wq);
  });
});

describe('time-of-day demand (requirement 36)', () => {
  it('actually changes the arrival process across the schedule', () => {
    const m = buildReferenceModel();
    m.simulation.warmupMinutes = 0;
    m.simulation.durationMinutes = 600 * 200; // 200 repeats of the 10-hour cycle
    m.simulation.collectVehicleTraces = false;
    const r = runSimulation(m);

    // Time-weighted mean of the schedule: (5+7+4+7+5)/5 = 5.6 vehicles/hour.
    const entry = r.stations.find((s) => s.stationId === 'parts_receiving');
    expect(relErr(entry!.lambdaObserved, 5.6)).toBeLessThan(0.03);
  });

  it('produces a heavier queue during the peak block than the trough block', () => {
    const peak = buildReferenceModel();
    peak.arrivals.schedule = [
      { startMinute: 0, endMinute: 100_000, lambdaPerHour: param(7, 'vehicles/hour', 'USER_INPUT') },
    ];
    const trough = buildReferenceModel();
    trough.arrivals.schedule = [
      { startMinute: 0, endMinute: 100_000, lambdaPerHour: param(4, 'vehicles/hour', 'USER_INPUT') },
    ];
    for (const m of [peak, trough]) {
      m.simulation.warmupMinutes = 2000;
      m.simulation.durationMinutes = 60_000;
      m.simulation.collectVehicleTraces = false;
    }
    const a = runSimulation(peak);
    const b = runSimulation(trough);
    expect(a.system.L).toBeGreaterThan(b.system.L);
    expect(a.system.cycleTime.meanMinutes).toBeGreaterThan(b.system.cycleTime.meanMinutes);
  });
});

describe('live state drives the visualisation from real simulation state', () => {
  it('advances the clock and exposes queues and servers', () => {
    const sim = new Simulation(buildReferenceModel());
    sim.runUntil(240);
    const live = sim.liveState();
    expect(live.now).toBeGreaterThan(0);
    expect(live.now).toBeLessThanOrEqual(240);
    expect(live.stations.length).toBe(10);
    // Vehicles are on the line even though none is counted yet: at t = 240 the
    // run is still inside the 600-minute warm-up, and `vehiclesEntered` counts
    // only arrivals inside the measurement window.
    expect(live.phase).toBe('WARMUP');
    expect(live.wip).toBeGreaterThan(0);
    expect(live.vehiclesEntered).toBe(0);
    expect(live.stations.some((s) => s.busyServers > 0 || s.queueLength > 0)).toBe(true);
    for (const s of live.stations) {
      expect(s.servers.length).toBeGreaterThanOrEqual(1);
      for (const srv of s.servers) {
        expect(srv.progress).toBeGreaterThanOrEqual(0);
        expect(srv.progress).toBeLessThanOrEqual(1);
      }
    }
  });

  it('starts counting arrivals once the measurement window opens', () => {
    const sim = new Simulation(buildReferenceModel());
    sim.runUntil(900); // past the 600-minute warm-up
    const live = sim.liveState();
    expect(live.phase).toBe('MEASURING');
    expect(live.vehiclesEntered).toBeGreaterThan(0);
  });

  it('reports the warm-up phase before switching to measuring', () => {
    const m = buildReferenceModel();
    m.simulation.warmupMinutes = 200;
    m.simulation.durationMinutes = 2000;
    const sim = new Simulation(m);
    sim.runUntil(100);
    expect(sim.liveState().phase).toBe('WARMUP');
    sim.runUntil(300);
    expect(['MEASURING', 'DRAINING', 'FINISHED']).toContain(sim.liveState().phase);
  });
});

describe('cycle-time distribution (requirement 12)', () => {
  const r = runSimulation(buildReferenceModel());

  it('reports mean, median, p95 and max in a consistent order', () => {
    const c = r.system.cycleTime;
    expect(c.count).toBeGreaterThan(0);
    expect(c.minMinutes).toBeLessThanOrEqual(c.medianMinutes);
    expect(c.medianMinutes).toBeLessThanOrEqual(c.p95Minutes);
    expect(c.p95Minutes).toBeLessThanOrEqual(c.maxMinutes);
    expect(c.meanMinutes).toBeGreaterThan(0);
  });

  it('splits the mean cycle time into waiting, processing and downtime', () => {
    const s = r.system.timeSplit;
    const sum = s.waitingMinutes + s.processingMinutes + s.downtimeMinutes;
    expect(sum).toBeCloseTo(r.system.cycleTime.meanMinutes, 6);
  });
});
