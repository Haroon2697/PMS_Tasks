/**
 * Deterministic pseudo-random number generation.
 *
 * Requirement 2: "The simulation must be deterministic when a fixed random seed
 * is used." Every stochastic draw in the engine goes through this module.
 *
 * Design note — independent substreams:
 * A single global stream makes results fragile: adding one machine breakdown
 * draw shifts every subsequent service time, so two scenarios that differ in
 * one parameter become statistically incomparable for reasons unrelated to the
 * change. We therefore derive a named substream per stochastic source
 * (per-station service, per-station routing, arrivals, breakdowns, ...). This
 * is the standard "common random numbers" variance-reduction setup
 * (Law, *Simulation Modeling and Analysis*, 5th ed., ch. 11).
 *
 * Generator: mulberry32 — a 32-bit counter-based generator with a 2^32 period
 * per stream. Period is ample here because each substream is consumed
 * independently and a run draws far fewer than 2^32 variates. Substream seeds
 * are derived with the cyrb128 string hash so stream names map to
 * well-separated seeds.
 */

/** cyrb128 string hash -> four 32-bit seeds. Public-domain construction. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

/** A single deterministic uniform(0,1) stream. */
export class Rng {
  private state: number;
  /** Number of variates drawn — useful for tracing/debugging reproducibility. */
  public draws = 0;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform on [0,1). */
  next(): number {
    this.draws++;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Uniform on (0,1) — excludes 0, which is required by generators that take
   * log(u) (exponential, Weibull, Box-Muller).
   */
  nextOpen(): number {
    let u = this.next();
    while (u <= 0) u = this.next();
    return u;
  }

  /** Uniform on [lo, hi). */
  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Integer on [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Bernoulli trial with success probability p. */
  bernoulli(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }
}

/**
 * Factory handing out reproducible named substreams from one master seed.
 *
 * `streams.get('service:paint_shop')` always yields the same sequence for a
 * given master seed and name, regardless of what other streams exist or the
 * order in which they were created.
 */
export class RngStreams {
  private readonly cache = new Map<string, Rng>();

  /** The master seed every substream is derived from. */
  readonly masterSeed: number;

  constructor(masterSeed: number) {
    this.masterSeed = masterSeed;
  }

  get(name: string): Rng {
    let rng = this.cache.get(name);
    if (!rng) {
      const [h] = cyrb128(`${this.masterSeed >>> 0}::${name}`);
      rng = new Rng(h);
      this.cache.set(name, rng);
    }
    return rng;
  }

  /**
   * Seed for replication `r` of a run. Replications must be independent, so
   * each gets its own master seed derived from the base seed.
   */
  static replicationSeed(baseSeed: number, replication: number): number {
    const [h] = cyrb128(`${baseSeed >>> 0}::rep::${replication}`);
    return h;
  }
}
