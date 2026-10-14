/**
 * Analytical queueing engine tests — requirements 58 and 59.
 *
 * The M/M/1 case from requirement 59 (lambda = 2/hr, mu = 3/hr => rho = 2/3,
 * L = 2, Lq = 4/3, W = 1 hr, Wq = 2/3 hr) is checked exactly, plus M/M/c
 * against published Erlang C values and M/D/1 against the Pollaczek-Khinchine
 * reduction.
 */

import { describe, expect, it } from 'vitest';
import {
  checkLittlesLaw,
  erlangB,
  erlangC,
  mg1,
  mm1,
  mmc,
  solveStation,
} from '../src/analytical/queues.js';
import { solveLinearSystem, solveTrafficEquations } from '../src/analytical/traffic.js';
import { capacityLimit, solveNetwork } from '../src/analytical/network.js';
import { distMean, distSCV, kendallSymbol } from '../src/distributions.js';
import { makeSingleStationModel } from '../src/model/defaults.js';
import { buildReferenceModel } from '../src/model/referenceModel.js';
import { param, SINK_FINISHED } from '../src/model/types.js';

describe('M/M/1 (requirement 59 validation case)', () => {
  const r = mm1(2, 3);

  it('reproduces the stated closed-form values exactly', () => {
    expect(r.rho).toBeCloseTo(2 / 3, 12);
    expect(r.L).toBeCloseTo(2, 12);
    expect(r.Lq).toBeCloseTo(4 / 3, 12);
    expect(r.W).toBeCloseTo(1, 12);
    expect(r.Wq).toBeCloseTo(2 / 3, 12);
    expect(r.stable).toBe(true);
    expect(r.exact).toBe(true);
    expect(r.kendall).toBe('M/M/1');
  });

  it('satisfies Little’s Law at the node level', () => {
    expect(checkLittlesLaw(2, r.W, r.L).holds).toBe(true);
    expect(checkLittlesLaw(2, r.Wq, r.Lq).holds).toBe(true);
  });

  it('reports P0 = 1 - rho', () => {
    expect(r.P0).toBeCloseTo(1 / 3, 12);
  });
});

describe('stability (requirement 9)', () => {
  it('flags rho >= 1 as unstable and does not report finite steady-state values', () => {
    const r = mm1(5, 4);
    expect(r.stable).toBe(false);
    expect(r.L).toBe(Infinity);
    expect(r.Lq).toBe(Infinity);
    expect(r.W).toBe(Infinity);
    expect(r.Wq).toBe(Infinity);
    expect(r.warnings[0]).toContain('UNSTABLE QUEUE');
  });

  it('flags rho exactly 1 as unstable', () => {
    expect(mm1(4, 4).stable).toBe(false);
    expect(mmc(8, 4, 2).stable).toBe(false);
  });
});

describe('Erlang B and Erlang C', () => {
  it('matches the Erlang B recursion for known values', () => {
    // B(1, a) = a/(1+a)
    expect(erlangB(1, 2)).toBeCloseTo(2 / 3, 12);
    // B(2, a) = (a^2/2) / (1 + a + a^2/2)
    const a = 2;
    expect(erlangB(2, a)).toBeCloseTo(a * a / 2 / (1 + a + (a * a) / 2), 12);
  });

  it('reduces to the M/M/1 waiting probability when c = 1', () => {
    // With c = 1, C(1,a) = a = rho.
    expect(erlangC(1, 0.5)).toBeCloseTo(0.5, 12);
  });

  it('returns 1 when the system is saturated', () => {
    expect(erlangC(2, 2)).toBe(1);
  });
});

describe('M/M/c uses Erlang C, not the M/M/1 formulae (requirement 8)', () => {
  it('matches a hand-computed M/M/2 case', () => {
    // lambda = 4/hr, mu = 3/hr/server, c = 2 => a = 4/3, rho = 2/3.
    const r = mmc(4, 3, 2);
    const a = 4 / 3;
    const rho = 2 / 3;
    // P0 = [1 + a + (a^2/2)(1/(1-rho))]^-1
    const P0 = 1 / (1 + a + ((a * a) / 2) * (1 / (1 - rho)));
    const Pwait = ((a * a) / 2) * (1 / (1 - rho)) * P0;
    const Lq = (Pwait * rho) / (1 - rho);

    expect(r.P0).toBeCloseTo(P0, 10);
    expect(r.Pwait).toBeCloseTo(Pwait, 10);
    expect(r.Lq).toBeCloseTo(Lq, 10);
    expect(r.L).toBeCloseTo(Lq + a, 10);
    expect(r.Wq).toBeCloseTo(Lq / 4, 10);
    expect(r.W).toBeCloseTo(Lq / 4 + 1 / 3, 10);
    expect(r.kendall).toBe('M/M/2');
  });

  it('differs materially from the (incorrect) M/M/1 treatment of the same load', () => {
    const correct = mmc(4, 3, 2);
    // The error requirement 8 warns about: using M/M/1 with mu scaled by c.
    const wrong = mm1(4, 6);
    expect(Math.abs(correct.Lq - wrong.Lq)).toBeGreaterThan(0.2);
  });

  it('satisfies Little’s Law', () => {
    const r = mmc(9, 2, 6);
    expect(checkLittlesLaw(9, r.W, r.L).holds).toBe(true);
    expect(checkLittlesLaw(9, r.Wq, r.Lq).holds).toBe(true);
  });

  it('is consistent with M/M/1 when c = 1', () => {
    const one = mmc(2, 3, 1);
    const ref = mm1(2, 3);
    expect(one.L).toBeCloseTo(ref.L, 12);
    expect(one.Lq).toBeCloseTo(ref.Lq, 12);
  });

  it('remains finite and stable for a large server count', () => {
    const r = mmc(95, 1, 100);
    expect(r.stable).toBe(true);
    expect(Number.isFinite(r.Lq)).toBe(true);
    expect(r.rho).toBeCloseTo(0.95, 12);
  });
});

describe('M/G/1 (Pollaczek-Khinchine)', () => {
  it('reduces to M/M/1 when Cs^2 = 1', () => {
    const pk = mg1(2, 3, 1);
    const ref = mm1(2, 3);
    expect(pk.Lq).toBeCloseTo(ref.Lq, 12);
    expect(pk.Wq).toBeCloseTo(ref.Wq, 12);
  });

  it('gives exactly half the M/M/1 queue for deterministic service (M/D/1)', () => {
    const md1 = mg1(2, 3, 0, 'M/D/1');
    const ref = mm1(2, 3);
    expect(md1.Lq).toBeCloseTo(ref.Lq / 2, 12);
  });
});

describe('Kendall notation follows the configured distribution (requirement 6)', () => {
  it('labels each family correctly', () => {
    expect(kendallSymbol({ kind: 'exponential', mean: 10 })).toBe('M');
    expect(kendallSymbol({ kind: 'constant', value: 10 })).toBe('D');
    expect(kendallSymbol({ kind: 'erlang', k: 3, mean: 10 })).toBe('E3');
    expect(kendallSymbol({ kind: 'lognormal', mean: 10, sd: 2 })).toBe('G');
    expect(kendallSymbol({ kind: 'gamma', shape: 2, scale: 5 })).toBe('E2');
    expect(kendallSymbol({ kind: 'gamma', shape: 2.5, scale: 5 })).toBe('G');
  });

  it('does not label a deterministic station as M/M/c', () => {
    const r = solveStation({ lambda: 2, service: { kind: 'constant', value: 20 }, c: 1 });
    expect(r.kendall).toBe('M/D/1');
    expect(r.Lq).toBeCloseTo(mm1(2, 3).Lq / 2, 10);
  });

  it('marks M/G/c results as approximations', () => {
    const r = solveStation({
      lambda: 4,
      service: { kind: 'lognormal', mean: 20, sd: 10 },
      c: 2,
    });
    expect(r.kendall).toBe('M/G/2');
    expect(r.exact).toBe(false);
    expect(r.method).toContain('APPROXIMATION');
  });
});

describe('distribution moments', () => {
  it('computes the SCV used by the P-K formula', () => {
    expect(distSCV({ kind: 'exponential', mean: 10 })).toBeCloseTo(1, 12);
    expect(distSCV({ kind: 'constant', value: 10 })).toBeCloseTo(0, 12);
    expect(distSCV({ kind: 'erlang', k: 4, mean: 10 })).toBeCloseTo(0.25, 12);
  });

  it('gets the Weibull mean right via the gamma function', () => {
    // Weibull(shape 2, scale 1) has mean sqrt(pi)/2.
    expect(distMean({ kind: 'weibull', shape: 2, scale: 1 })).toBeCloseTo(Math.sqrt(Math.PI) / 2, 8);
  });
});

describe('linear solver', () => {
  it('solves a small system exactly', () => {
    const x = solveLinearSystem(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(3, 12);
  });

  it('needs pivoting to handle a zero leading entry', () => {
    const x = solveLinearSystem(
      [
        [0, 1],
        [1, 0],
      ],
      [2, 3],
    );
    expect(x[0]).toBeCloseTo(3, 12);
    expect(x[1]).toBeCloseTo(2, 12);
  });
});

describe('traffic equations (requirement 7)', () => {
  it('derives internal rates rather than assigning lambda everywhere', () => {
    const model = buildReferenceModel();
    const t = solveTrafficEquations(model, 10);

    // External lambda applies at the entry station only.
    expect(t.lambdaExternal).toBe(10);

    // Inspection is visited more than once per vehicle because of the rework
    // loop, so its arrival rate MUST exceed the external rate.
    const inspection = t.lambdaByStation['inspection'] as number;
    expect(inspection).toBeGreaterThan(10);

    // Body shop sits before the loop and is visited exactly once.
    expect(t.visitRatios['body_shop']).toBeCloseTo(1, 10);
  });

  it('matches the closed form for a single rework loop', () => {
    // With fail probability p and rework returning to inspection with
    // certainty, inspection is visited 1/(1-p) times per vehicle.
    const model = buildReferenceModel();
    const inspect = model.stations.find((s) => s.id === 'inspection');
    if (!inspect) throw new Error('inspection station missing');
    const failEdge = inspect.routing.find((e) => e.to === 'rework');
    if (!failEdge) throw new Error('rework edge missing');
    const p = failEdge.probability;

    const t = solveTrafficEquations(model, 10);
    expect(t.visitRatios['inspection']).toBeCloseTo(1 / (1 - p), 8);
    expect(t.visitRatios['rework']).toBeCloseTo(p / (1 - p), 8);
  });

  it('conserves flow: external inflow equals finished plus scrap', () => {
    const model = buildReferenceModel();
    const t = solveTrafficEquations(model, 10);
    expect(t.throughputFinished + t.throughputScrap).toBeCloseTo(10, 6);
    expect(t.warnings.some((w) => w.includes('conservation'))).toBe(false);
  });

  it('warns when routing probabilities do not sum to 1', () => {
    const model = buildReferenceModel();
    const st = model.stations.find((s) => s.id === 'body_shop');
    if (!st) throw new Error('missing station');
    st.routing = [{ to: 'paint_shop', probability: 0.8 }];
    const t = solveTrafficEquations(model, 10);
    expect(t.warnings.some((w) => w.includes('sum to'))).toBe(true);
  });

  it('rejects an absorbing cycle with a clear message', () => {
    const model = makeSingleStationModel({ lambdaPerHour: 2, meanServiceMinutes: 20 });
    // Route the station entirely back to itself: flow can never leave.
    (model.stations[0] as (typeof model.stations)[number]).routing = [
      { to: 's1', probability: 1 },
    ];
    expect(() => solveTrafficEquations(model, 2)).toThrow(/singular|absorbing/i);
  });

  it('time-averages a varying demand schedule and says so', () => {
    const model = makeSingleStationModel({ lambdaPerHour: 6, meanServiceMinutes: 5 });
    model.arrivals.schedule = [
      { startMinute: 0, endMinute: 120, lambdaPerHour: param(6, 'vehicles/hour') },
      { startMinute: 120, endMinute: 240, lambdaPerHour: param(10, 'vehicles/hour') },
    ];
    const t = solveTrafficEquations(model);
    expect(t.lambdaExternal).toBeCloseTo(8, 10);
    expect(t.warnings.some((w) => w.includes('time-varying'))).toBe(true);
  });
});

describe('network solution (requirement 10)', () => {
  it('keeps node and system metrics distinct', () => {
    const model = buildReferenceModel();
    const net = solveNetwork(model, 6);

    // System L is the sum of node L values.
    const sumL = net.stations.reduce((a, s) => a + s.L, 0);
    expect(net.system.L).toBeCloseTo(sumL, 8);

    // System W divides by the EXTERNAL rate, not by the sum of node rates.
    expect(net.system.W).toBeCloseTo(net.system.L / 6, 8);

    const sumNodeLambda = net.stations.reduce((a, s) => a + s.lambda, 0);
    expect(sumNodeLambda).toBeGreaterThan(6);
    // Dividing by sum(lambda_j) would give a materially different, wrong answer.
    expect(net.system.L / sumNodeLambda).not.toBeCloseTo(net.system.W, 3);
  });

  it('identifies the highest-utilisation station as the bottleneck', () => {
    const model = buildReferenceModel();
    const net = solveNetwork(model, 6);
    const maxRho = Math.max(...net.stations.map((s) => s.rho));
    const bottleneck = net.stations.find((s) => s.stationId === net.system.bottleneckStationId);
    expect(bottleneck?.rho).toBeCloseTo(maxRho, 12);
  });

  it('reports the whole system as unstable when any node is', () => {
    const model = buildReferenceModel();
    const net = solveNetwork(model, 1000);
    expect(net.system.stable).toBe(false);
    expect(net.system.L).toBe(Infinity);
  });
});

describe('capacity limit (requirement 69)', () => {
  it('finds the binding station and the maximum sustainable demand', () => {
    const model = buildReferenceModel();
    const cap = capacityLimit(model);
    expect(cap.lambdaMaxPerHour).toBeGreaterThan(0);
    expect(cap.bindingStationId).not.toBeNull();

    // At exactly the limit the binding station has rho = 1 (unstable).
    const atLimit = solveNetwork(model, cap.lambdaMaxPerHour);
    const binding = atLimit.stations.find((s) => s.stationId === cap.bindingStationId);
    expect(binding?.rho).toBeCloseTo(1, 6);

    // Just below it, every station is stable.
    const below = solveNetwork(model, cap.lambdaMaxPerHour * 0.95);
    expect(below.system.stable).toBe(true);
  });
});

describe('degenerate inputs', () => {
  it('handles a station with no inbound flow without dividing by zero', () => {
    const r = solveStation({ lambda: 0, service: { kind: 'exponential', mean: 10 }, c: 2 });
    expect(r.L).toBe(0);
    expect(r.Wq).toBe(0);
    expect(r.stable).toBe(true);
  });

  it('rejects non-positive rates', () => {
    expect(() => mm1(0, 3)).toThrow();
    expect(() => mm1(2, 0)).toThrow();
    expect(() => mmc(2, 3, 0)).toThrow();
  });

  it('routes a single-station model straight to the finished sink', () => {
    const model = makeSingleStationModel({ lambdaPerHour: 2, meanServiceMinutes: 20 });
    expect((model.stations[0] as (typeof model.stations)[number]).routing[0]?.to).toBe(SINK_FINISHED);
    const net = solveNetwork(model);
    expect(net.system.throughputFinished).toBeCloseTo(2, 10);
  });
});
