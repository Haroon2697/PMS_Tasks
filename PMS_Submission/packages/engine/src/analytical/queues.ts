/**
 * Analytical (steady-state) queueing models — requirements 8, 9, 10.
 *
 * Scope and correctness rules enforced here:
 *  - M/M/c is solved with Erlang C, never with the M/M/1 formulae
 *    (requirement 8 states this explicitly).
 *  - Results are only reported as steady-state when rho < 1 (requirement 9).
 *  - Anything that is an approximation rather than an exact result is flagged
 *    with `exact: false` and names the approximation, so the UI can never
 *    present it as an exact figure (requirement 60).
 *
 * UNITS: lambda and mu are per HOUR; W and Wq are in HOURS; L and Lq are in
 * vehicles.
 *
 * References:
 *  - Gross, Shortle, Thompson & Harris, *Fundamentals of Queueing Theory*,
 *    4th ed., Wiley — M/M/1 (ch. 2), M/M/c and Erlang C (ch. 2.3),
 *    Pollaczek-Khinchine for M/G/1 (ch. 5.1).
 *  - Allen, *Probability, Statistics and Queueing Theory*, 2nd ed. —
 *    Allen-Cunneen approximation for G/G/c.
 */

import type { Distribution } from '../distributions.js';
import { distMean, distSCV, isMarkovian, kendallSymbol } from '../distributions.js';

export interface QueueResult {
  /** Model actually solved, e.g. 'M/M/2'. */
  kendall: string;
  /** Arrival rate, vehicles/hour. */
  lambda: number;
  /** Service rate per server, vehicles/hour/server. */
  mu: number;
  /** Number of servers. */
  c: number;
  /** Offered load a = lambda/mu (erlangs). */
  offeredLoad: number;
  /** Server utilisation rho = lambda/(c*mu). */
  rho: number;
  /** Expected number in system (vehicles). */
  L: number;
  /** Expected number in queue (vehicles). */
  Lq: number;
  /** Expected time in system (hours). */
  W: number;
  /** Expected time in queue (hours). */
  Wq: number;
  /** Probability the system is empty. */
  P0: number;
  /** Probability an arrival must wait (Erlang C for M/M/c). */
  Pwait: number;
  /** True when rho < 1 and the steady-state results below are meaningful. */
  stable: boolean;
  /** False when the numbers come from an approximation. */
  exact: boolean;
  /** Name of the formula used, for the report and the UI tooltip. */
  method: string;
  warnings: string[];
}

const UNSTABLE = (kendall: string, lambda: number, mu: number, c: number, method: string): QueueResult => ({
  kendall,
  lambda,
  mu,
  c,
  offeredLoad: mu > 0 ? lambda / mu : Infinity,
  rho: c > 0 && mu > 0 ? lambda / (c * mu) : Infinity,
  L: Infinity,
  Lq: Infinity,
  W: Infinity,
  Wq: Infinity,
  P0: 0,
  Pwait: 1,
  stable: false,
  exact: true,
  method,
  warnings: [
    'UNSTABLE QUEUE: rho >= 1. Arrivals meet or exceed service capacity, so the ' +
      'queue grows without bound and no finite steady-state L, Lq, W or Wq exists ' +
      'under these model assumptions. A finite-horizon simulation will still run, ' +
      'but its queue statistics reflect the horizon, not a steady state.',
  ],
});

/* ------------------------------------------------------------------ */
/* M/M/1                                                               */
/* ------------------------------------------------------------------ */

/**
 * M/M/1 (requirement 8):
 *   rho = lambda/mu,  L = rho/(1-rho),  Lq = rho^2/(1-rho),
 *   W = 1/(mu-lambda),  Wq = lambda/(mu(mu-lambda))
 */
export function mm1(lambda: number, mu: number): QueueResult {
  const kendall = 'M/M/1';
  const method = 'M/M/1 exact: rho = L/mu; L = rho/(1-rho); Lq = rho^2/(1-rho); W = 1/(mu-lambda); Wq = lambda/(mu(mu-lambda))';
  if (lambda <= 0 || mu <= 0) {
    throw new Error('mm1: lambda and mu must be > 0');
  }
  const rho = lambda / mu;
  if (rho >= 1) return UNSTABLE(kendall, lambda, mu, 1, method);

  const L = rho / (1 - rho);
  const Lq = (rho * rho) / (1 - rho);
  const W = 1 / (mu - lambda);
  const Wq = lambda / (mu * (mu - lambda));

  return {
    kendall,
    lambda,
    mu,
    c: 1,
    offeredLoad: rho,
    rho,
    L,
    Lq,
    W,
    Wq,
    P0: 1 - rho,
    Pwait: rho,
    stable: true,
    exact: true,
    method,
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* Erlang B / Erlang C                                                 */
/* ------------------------------------------------------------------ */

/**
 * Erlang B loss probability B(c, a), computed with the standard recursion
 *   B(0,a) = 1,  B(n,a) = a*B(n-1,a) / (n + a*B(n-1,a))
 * which avoids the overflow of evaluating a^c/c! directly for large c.
 */
export function erlangB(c: number, a: number): number {
  let b = 1;
  for (let n = 1; n <= c; n++) {
    b = (a * b) / (n + a * b);
  }
  return b;
}

/**
 * Erlang C — probability that an arriving customer has to wait in M/M/c.
 * Derived from Erlang B for numerical stability:
 *   C(c,a) = B(c,a) / (1 - rho*(1 - B(c,a))),  rho = a/c
 */
export function erlangC(c: number, a: number): number {
  const rho = a / c;
  if (rho >= 1) return 1;
  const b = erlangB(c, a);
  return b / (1 - rho * (1 - b));
}

/* ------------------------------------------------------------------ */
/* M/M/c                                                               */
/* ------------------------------------------------------------------ */

/**
 * M/M/c using the Erlang C formulation (requirement 8 forbids reusing the
 * M/M/1 formulae here):
 *   a = lambda/mu,  rho = a/c
 *   Pwait = C(c,a)
 *   Lq = Pwait * rho/(1-rho)
 *   Wq = Lq/lambda,  W = Wq + 1/mu,  L = lambda*W = Lq + a
 */
export function mmc(lambda: number, mu: number, c: number): QueueResult {
  const kendall = `M/M/${c}`;
  const method =
    'M/M/c exact (Erlang C): a = lambda/mu; rho = a/c; Pwait = C(c,a); ' +
    'Lq = Pwait*rho/(1-rho); Wq = Lq/lambda; W = Wq + 1/mu; L = lambda*W';

  if (lambda <= 0 || mu <= 0) throw new Error('mmc: lambda and mu must be > 0');
  if (!Number.isInteger(c) || c < 1) throw new Error('mmc: c must be an integer >= 1');
  if (c === 1) {
    const r = mm1(lambda, mu);
    // Keep the M/M/1 label: with c = 1 the exact M/M/1 result is what applies.
    return r;
  }

  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) return UNSTABLE(kendall, lambda, mu, c, method);

  const Pwait = erlangC(c, a);
  const Lq = (Pwait * rho) / (1 - rho);
  const Wq = Lq / lambda;
  const W = Wq + 1 / mu;
  const L = lambda * W;

  // P0 from the standard sum, evaluated with a running term to avoid c!.
  let sum = 0;
  let term = 1; // a^n/n!
  for (let n = 0; n < c; n++) {
    if (n > 0) term *= a / n;
    sum += term;
  }
  const termC = term * (a / c); // a^c/c!
  const P0 = 1 / (sum + termC / (1 - rho));

  return {
    kendall,
    lambda,
    mu,
    c,
    offeredLoad: a,
    rho,
    L,
    Lq,
    W,
    Wq,
    P0,
    Pwait,
    stable: true,
    exact: true,
    method,
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* M/G/1 — Pollaczek-Khinchine                                         */
/* ------------------------------------------------------------------ */

/**
 * M/G/1 via the Pollaczek-Khinchine mean-value formula:
 *   Lq = rho^2 (1 + Cs^2) / (2 (1 - rho))
 * where Cs^2 is the squared coefficient of variation of the service time.
 * With Cs^2 = 1 this reduces to M/M/1; with Cs^2 = 0 it gives M/D/1.
 */
export function mg1(lambda: number, mu: number, scv: number, kendallLabel = 'M/G/1'): QueueResult {
  const method =
    'M/G/1 exact (Pollaczek-Khinchine): Lq = rho^2 (1 + Cs^2) / (2(1-rho)); ' +
    'Wq = Lq/lambda; W = Wq + 1/mu; L = lambda*W';
  if (lambda <= 0 || mu <= 0) throw new Error('mg1: lambda and mu must be > 0');

  const rho = lambda / mu;
  if (rho >= 1) return UNSTABLE(kendallLabel, lambda, mu, 1, method);

  const Lq = (rho * rho * (1 + scv)) / (2 * (1 - rho));
  const Wq = Lq / lambda;
  const W = Wq + 1 / mu;
  const L = lambda * W;

  return {
    kendall: kendallLabel,
    lambda,
    mu,
    c: 1,
    offeredLoad: rho,
    rho,
    L,
    Lq,
    W,
    Wq,
    P0: 1 - rho,
    Pwait: rho,
    stable: true,
    exact: true,
    method,
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* M/G/c — Allen-Cunneen approximation                                 */
/* ------------------------------------------------------------------ */

/**
 * M/G/c has no closed form. The Allen-Cunneen approximation scales the exact
 * M/M/c queue length by the average of the arrival and service SCVs:
 *   Lq(M/G/c) ~= Lq(M/M/c) * (Ca^2 + Cs^2)/2
 * Returned with exact = false so it is always labelled as an approximation.
 */
export function mgc(lambda: number, mu: number, c: number, scvService: number, scvArrival = 1): QueueResult {
  const base = mmc(lambda, mu, c);
  const kendall = `M/G/${c}`;
  if (!base.stable) return { ...base, kendall, exact: false };

  const factor = (scvArrival + scvService) / 2;
  const Lq = base.Lq * factor;
  const Wq = Lq / lambda;
  const W = Wq + 1 / mu;
  const L = lambda * W;

  return {
    ...base,
    kendall,
    Lq,
    Wq,
    W,
    L,
    exact: false,
    method:
      'M/G/c APPROXIMATION (Allen-Cunneen): Lq ~= Lq(M/M/c) * (Ca^2 + Cs^2)/2. ' +
      'No exact closed form exists for M/G/c; treat as an estimate and prefer the simulation result.',
    warnings: [
      'M/G/c result is an approximation (Allen-Cunneen), not an exact steady-state solution.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export interface StationAnalyticInput {
  /** Effective arrival rate at this station, vehicles/hour (from traffic eqns). */
  lambda: number;
  /** Service-time distribution (minutes). */
  service: Distribution;
  /** Number of servers. */
  c: number;
  /** Squared CV of the arrival process. 1 for Poisson. */
  arrivalSCV?: number;
}

/**
 * Pick and apply the correct model for a station. The Kendall notation is
 * derived from the distributions actually configured, satisfying requirement 6
 * ("Do NOT label everything M/M/c simply because it is convenient").
 */
export function solveStation(input: StationAnalyticInput): QueueResult {
  const { lambda, service, c } = input;
  const meanMinutes = distMean(service);
  if (meanMinutes <= 0) throw new Error('solveStation: mean service time must be > 0');
  const mu = 60 / meanMinutes; // vehicles/hour/server
  const sSym = kendallSymbol(service);
  const arrivalSCV = input.arrivalSCV ?? 1;

  if (lambda <= 0) {
    // No flow reaches this station: report a well-defined empty queue rather
    // than dividing by zero.
    return {
      kendall: `M/${sSym}/${c}`,
      lambda: 0,
      mu,
      c,
      offeredLoad: 0,
      rho: 0,
      L: 0,
      Lq: 0,
      W: 0,
      Wq: 0,
      P0: 1,
      Pwait: 0,
      stable: true,
      exact: true,
      method: 'No arrivals routed to this station (lambda = 0); queue is empty by construction.',
      warnings: ['This station receives no flow under the current routing.'],
    };
  }

  if (isMarkovian(service)) {
    return c === 1 ? mm1(lambda, mu) : mmc(lambda, mu, c);
  }

  const scv = distSCV(service);
  if (c === 1) {
    return mg1(lambda, mu, scv, `M/${sSym}/1`);
  }
  return { ...mgc(lambda, mu, c, scv, arrivalSCV), kendall: `M/${sSym}/${c}` };
}

/* ------------------------------------------------------------------ */
/* Little's Law (requirement 10)                                       */
/* ------------------------------------------------------------------ */

export interface LittlesLawCheck {
  lambda: number;
  W: number;
  L: number;
  /** lambda * W — what Little's Law predicts. */
  predictedL: number;
  absoluteError: number;
  relativeError: number;
  holds: boolean;
}

/**
 * Verify L = lambda*W (and Lq = lambda*Wq) on a set of numbers. Used both as a
 * test oracle and as a live consistency check displayed in the UI.
 */
export function checkLittlesLaw(lambda: number, W: number, L: number, tolerance = 1e-6): LittlesLawCheck {
  const predictedL = lambda * W;
  const absoluteError = Math.abs(predictedL - L);
  const relativeError = L !== 0 ? absoluteError / Math.abs(L) : absoluteError;
  return {
    lambda,
    W,
    L,
    predictedL,
    absoluteError,
    relativeError,
    holds: absoluteError <= tolerance || relativeError <= tolerance,
  };
}

/** Convert a time expressed in hours to minutes. */
export const hoursToMinutes = (h: number): number => h * 60;
/** Convert a time expressed in minutes to hours. */
export const minutesToHours = (m: number): number => m / 60;
