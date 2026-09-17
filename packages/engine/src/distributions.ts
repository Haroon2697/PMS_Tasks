/**
 * Service / inter-arrival time distributions.
 *
 * Requirement 6: the Kendall notation shown in the UI must correspond to the
 * model actually simulated, so each distribution reports its own Kendall
 * symbol rather than the caller labelling everything "M".
 *
 * Every distribution exposes its theoretical mean and variance so the
 * analytical engine can pick the right formula (M/M/c vs M/G/1 vs M/D/1) from
 * the same objects the simulator draws from. That is what keeps the analytical
 * and simulated models describing the same system.
 *
 * All times are in MINUTES unless a call site states otherwise.
 */

import type { Rng } from './rng.js';

export type Distribution =
  /** Exponential. Kendall symbol M (Markovian / memoryless). */
  | { kind: 'exponential'; mean: number }
  /** Degenerate / deterministic. Kendall symbol D. */
  | { kind: 'constant'; value: number }
  /** Erlang-k: sum of k exponentials, each of mean `mean`/k. Kendall E_k. */
  | { kind: 'erlang'; k: number; mean: number }
  /** Uniform on [min, max]. Kendall G. */
  | { kind: 'uniform'; min: number; max: number }
  /** Triangular(min, mode, max). Kendall G. */
  | { kind: 'triangular'; min: number; mode: number; max: number }
  /** Normal, truncated at 0 by resampling. Kendall G. */
  | { kind: 'normal'; mean: number; sd: number }
  /** Lognormal parameterised by the mean and sd OF THE DISTRIBUTION. Kendall G. */
  | { kind: 'lognormal'; mean: number; sd: number }
  /** Gamma(shape, scale). Kendall E_k when shape is a positive integer, else G. */
  | { kind: 'gamma'; shape: number; scale: number }
  /** Weibull(shape, scale). Kendall G. */
  | { kind: 'weibull'; shape: number; scale: number };

export type DistributionKind = Distribution['kind'];

/* ------------------------------------------------------------------ */
/* Moments                                                             */
/* ------------------------------------------------------------------ */

/** Theoretical mean E[X]. */
export function distMean(d: Distribution): number {
  switch (d.kind) {
    case 'exponential':
      return d.mean;
    case 'constant':
      return d.value;
    case 'erlang':
      return d.mean;
    case 'uniform':
      return (d.min + d.max) / 2;
    case 'triangular':
      return (d.min + d.mode + d.max) / 3;
    case 'normal':
      return d.mean;
    case 'lognormal':
      return d.mean;
    case 'gamma':
      return d.shape * d.scale;
    case 'weibull':
      return d.scale * gammaFn(1 + 1 / d.shape);
  }
}

/** Theoretical variance Var[X]. */
export function distVariance(d: Distribution): number {
  switch (d.kind) {
    case 'exponential':
      return d.mean * d.mean;
    case 'constant':
      return 0;
    case 'erlang': {
      // k phases each of mean m/k => variance k*(m/k)^2 = m^2/k
      return (d.mean * d.mean) / d.k;
    }
    case 'uniform':
      return (d.max - d.min) ** 2 / 12;
    case 'triangular': {
      const { min: a, mode: c, max: b } = d;
      return (a * a + b * b + c * c - a * b - a * c - b * c) / 18;
    }
    case 'normal':
      return d.sd * d.sd;
    case 'lognormal':
      return d.sd * d.sd;
    case 'gamma':
      return d.shape * d.scale * d.scale;
    case 'weibull': {
      const g1 = gammaFn(1 + 1 / d.shape);
      const g2 = gammaFn(1 + 2 / d.shape);
      return d.scale * d.scale * (g2 - g1 * g1);
    }
  }
}

/** Squared coefficient of variation, C^2 = Var/E^2. Drives M/G/1 results. */
export function distSCV(d: Distribution): number {
  const m = distMean(d);
  if (m <= 0) return 0;
  return distVariance(d) / (m * m);
}

/* ------------------------------------------------------------------ */
/* Kendall symbols (requirement 6)                                     */
/* ------------------------------------------------------------------ */

/**
 * The Kendall arrival/service symbol for this distribution.
 * M = Markovian (exponential), D = deterministic, E_k = Erlang-k, G = general.
 */
export function kendallSymbol(d: Distribution): string {
  switch (d.kind) {
    case 'exponential':
      return 'M';
    case 'constant':
      return 'D';
    case 'erlang':
      return `E${d.k}`;
    case 'gamma':
      // Gamma with integer shape IS Erlang; anything else is general.
      return Number.isInteger(d.shape) && d.shape >= 1 ? `E${d.shape}` : 'G';
    default:
      return 'G';
  }
}

/** True when the distribution is memoryless, i.e. the M/M/c formulae apply. */
export function isMarkovian(d: Distribution): boolean {
  return d.kind === 'exponential';
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

/** Draw one variate. Never returns a negative time. */
export function sample(d: Distribution, rng: Rng): number {
  switch (d.kind) {
    case 'exponential':
      return -d.mean * Math.log(rng.nextOpen());

    case 'constant':
      return d.value;

    case 'erlang': {
      // Sum of k exponentials with mean m/k (convolution method).
      const phaseMean = d.mean / d.k;
      let s = 0;
      for (let i = 0; i < d.k; i++) s += -phaseMean * Math.log(rng.nextOpen());
      return s;
    }

    case 'uniform':
      return rng.uniform(d.min, d.max);

    case 'triangular': {
      const { min: a, mode: c, max: b } = d;
      const u = rng.next();
      const fc = (c - a) / (b - a);
      return u < fc
        ? a + Math.sqrt(u * (b - a) * (c - a))
        : b - Math.sqrt((1 - u) * (b - a) * (b - c));
    }

    case 'normal': {
      // Truncate at 0 by resampling; a service time cannot be negative.
      for (let i = 0; i < 100; i++) {
        const x = d.mean + d.sd * standardNormal(rng);
        if (x >= 0) return x;
      }
      return 0;
    }

    case 'lognormal': {
      // Convert mean/sd of X into the mu/sigma of ln X.
      const { mean: m, sd: s } = d;
      const varX = s * s;
      const sigma2 = Math.log(1 + varX / (m * m));
      const mu = Math.log(m) - sigma2 / 2;
      return Math.exp(mu + Math.sqrt(sigma2) * standardNormal(rng));
    }

    case 'gamma':
      return gammaSample(d.shape, d.scale, rng);

    case 'weibull':
      return d.scale * Math.pow(-Math.log(rng.nextOpen()), 1 / d.shape);
  }
}

/**
 * Standard normal via Box-Muller.
 *
 * The second variate of the pair is deliberately discarded rather than cached:
 * caching makes the number of draws depend on call history, which breaks the
 * per-stream reproducibility guarantee this engine relies on.
 */
function standardNormal(rng: Rng): number {
  const u1 = rng.nextOpen();
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma variate, Marsaglia & Tsang (2000), "A Simple Method for Generating
 * Gamma Variables", ACM TOMS 26(3).
 */
function gammaSample(shape: number, scale: number, rng: Rng): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    const u = rng.nextOpen();
    return gammaSample(shape + 1, scale, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.nextOpen();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Lanczos approximation of the gamma function (used for Weibull moments). */
function gammaFn(z: number): number {
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  let x = p[0] as number;
  for (let i = 1; i < g + 2; i++) x += (p[i] as number) / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/**
 * Build a service-time distribution from a service RATE expressed in
 * vehicles/hour/server, returning a distribution in MINUTES.
 *
 * mu = 4 veh/hour/server  =>  mean service time = 60/4 = 15 min/vehicle.
 */
export function serviceDistFromRate(
  muPerHour: number,
  kind: DistributionKind = 'exponential',
  opts: { scv?: number; erlangK?: number } = {},
): Distribution {
  const meanMinutes = 60 / muPerHour;
  switch (kind) {
    case 'exponential':
      return { kind: 'exponential', mean: meanMinutes };
    case 'constant':
      return { kind: 'constant', value: meanMinutes };
    case 'erlang':
      return { kind: 'erlang', k: opts.erlangK ?? 2, mean: meanMinutes };
    case 'lognormal':
      return {
        kind: 'lognormal',
        mean: meanMinutes,
        sd: meanMinutes * Math.sqrt(opts.scv ?? 0.25),
      };
    default:
      return { kind: 'exponential', mean: meanMinutes };
  }
}

/** Mean service RATE in vehicles/hour/server implied by a time distribution. */
export function serviceRatePerHour(d: Distribution): number {
  const meanMinutes = distMean(d);
  return meanMinutes > 0 ? 60 / meanMinutes : Infinity;
}

/** Human-readable description for tooltips and reports. */
export function describeDistribution(d: Distribution): string {
  switch (d.kind) {
    case 'exponential':
      return `Exponential(mean = ${d.mean.toFixed(2)} min)`;
    case 'constant':
      return `Deterministic(${d.value.toFixed(2)} min)`;
    case 'erlang':
      return `Erlang(k = ${d.k}, mean = ${d.mean.toFixed(2)} min)`;
    case 'uniform':
      return `Uniform(${d.min.toFixed(2)}, ${d.max.toFixed(2)} min)`;
    case 'triangular':
      return `Triangular(${d.min.toFixed(2)}, ${d.mode.toFixed(2)}, ${d.max.toFixed(2)} min)`;
    case 'normal':
      return `Normal(mean = ${d.mean.toFixed(2)}, sd = ${d.sd.toFixed(2)} min, truncated at 0)`;
    case 'lognormal':
      return `Lognormal(mean = ${d.mean.toFixed(2)}, sd = ${d.sd.toFixed(2)} min)`;
    case 'gamma':
      return `Gamma(shape = ${d.shape}, scale = ${d.scale.toFixed(2)})`;
    case 'weibull':
      return `Weibull(shape = ${d.shape}, scale = ${d.scale.toFixed(2)})`;
  }
}
