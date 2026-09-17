/**
 * Traffic equations for the open queueing network — requirement 7.
 *
 * The rule this file exists to enforce: external lambda is defined ONLY at the
 * entry point. Every other station's arrival rate is DERIVED from upstream
 * flow and routing probabilities. Assigning the external rate to each station
 * independently is the error requirement 7 calls out, and it is impossible to
 * express here because the only external input is the source vector r.
 *
 * For an open Jackson-type network the total arrival rate at station j is
 *
 *     lambda_j = r_j + sum_i lambda_i * p_ij
 *
 * where r_j is external arrivals at j and p_ij is the routing probability from
 * i to j. In matrix form with P the routing matrix,
 *
 *     lambda = r + P^T lambda      =>     (I - P^T) lambda = r
 *
 * The inspection -> rework -> inspection feedback loop makes P^T non-triangular,
 * so this genuinely has to be SOLVED, not accumulated in topological order.
 * Gaussian elimination with partial pivoting is used; the system is small
 * (one unknown per station) so an O(n^3) dense solve is far cheaper than any
 * iterative alternative.
 *
 * Reference: Jackson, "Jobshop-like Queueing Systems", Management Science 10(1),
 * 1963; Gross et al., *Fundamentals of Queueing Theory* 4th ed., ch. 4.
 *
 * UNITS: all rates are vehicles/hour.
 */

import { SINK_FINISHED, SINK_SCRAP, isSink, type SystemModel } from '../model/types.js';

export interface TrafficSolution {
  /** Effective arrival rate at each station, vehicles/hour, keyed by station id. */
  lambdaByStation: Record<string, number>;
  /**
   * Visit ratio V_j = lambda_j / lambda_external: the expected number of times
   * one vehicle visits station j. V > 1 means the feedback loop sends vehicles
   * back (e.g. inspection is visited 1/(1-p_fail) times on average).
   */
  visitRatios: Record<string, number>;
  /** Total external arrival rate injected into the network. */
  lambdaExternal: number;
  /** Rate at which vehicles leave as finished goods, vehicles/hour. */
  throughputFinished: number;
  /** Rate at which vehicles leave as scrap, vehicles/hour. */
  throughputScrap: number;
  warnings: string[];
}

/**
 * Solve A x = b by Gaussian elimination with partial pivoting.
 * `a` is modified in place.
 */
export function solveLinearSystem(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: pick the row with the largest magnitude in this column.
    let pivot = col;
    let best = Math.abs((m[col] as number[])[col] as number);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs((m[r] as number[])[col] as number);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) {
      throw new Error(
        `Traffic equations are singular at column ${col}. This usually means a ` +
          `group of stations routes only among themselves with probability 1, so ` +
          `flow entering it never leaves (an absorbing cycle). Check that every ` +
          `cycle has an exit arc with probability > 0.`,
      );
    }
    if (pivot !== col) {
      const tmp = m[col] as number[];
      m[col] = m[pivot] as number[];
      m[pivot] = tmp;
    }

    const prow = m[col] as number[];
    const pval = prow[col] as number;
    for (let r = col + 1; r < n; r++) {
      const row = m[r] as number[];
      const factor = (row[col] as number) / pval;
      if (factor === 0) continue;
      for (let cc = col; cc <= n; cc++) {
        row[cc] = (row[cc] as number) - factor * (prow[cc] as number);
      }
    }
  }

  // Back substitution.
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = m[r] as number[];
    let s = row[n] as number;
    for (let cc = r + 1; cc < n; cc++) s -= (row[cc] as number) * (x[cc] as number);
    x[r] = s / (row[r] as number);
  }
  return x;
}

/**
 * Time-average external arrival rate implied by the demand schedule
 * (requirement 36). The analytical model is a steady-state model, so a
 * time-varying lambda has to be collapsed to its time-weighted mean — and the
 * caller is warned that it has been, because a steady-state answer for a
 * non-stationary arrival process is only an average-case approximation.
 */
export function meanExternalLambda(model: SystemModel): { lambda: number; varying: boolean } {
  const blocks = model.arrivals.schedule;
  if (blocks.length === 0) return { lambda: 0, varying: false };
  if (blocks.length === 1) {
    return { lambda: (blocks[0] as (typeof blocks)[number]).lambdaPerHour.value, varying: false };
  }
  let weighted = 0;
  let total = 0;
  let first: number | null = null;
  let varying = false;
  for (const b of blocks) {
    const span = Math.max(0, b.endMinute - b.startMinute);
    weighted += b.lambdaPerHour.value * span;
    total += span;
    if (first === null) first = b.lambdaPerHour.value;
    else if (Math.abs(b.lambdaPerHour.value - first) > 1e-12) varying = true;
  }
  return { lambda: total > 0 ? weighted / total : 0, varying };
}

/**
 * Solve the network's traffic equations.
 *
 * `externalLambda` defaults to the time-average of the demand schedule.
 */
export function solveTrafficEquations(model: SystemModel, externalLambda?: number): TrafficSolution {
  const warnings: string[] = [];
  const stations = model.stations;
  const index = new Map<string, number>();
  stations.forEach((s, i) => index.set(s.id, i));
  const n = stations.length;

  const { lambda: meanLambda, varying } = meanExternalLambda(model);
  const lambdaExternal = externalLambda ?? meanLambda;
  if (varying && externalLambda === undefined) {
    warnings.push(
      'The demand schedule is time-varying. Analytical results use the ' +
        'time-weighted average lambda and describe an average-case steady state only; ' +
        'peak-period behaviour must be read from the simulation.',
    );
  }

  // Build r (external arrivals) — non-zero at the entry station only.
  const r = new Array<number>(n).fill(0);
  const entryIdx = index.get(model.arrivals.entryStationId);
  if (entryIdx === undefined) {
    throw new Error(
      `Arrival entry station "${model.arrivals.entryStationId}" is not a station in this model.`,
    );
  }
  r[entryIdx] = lambdaExternal;

  // Build (I - P^T).
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) (A[i] as number[])[i] = 1;

  for (let i = 0; i < n; i++) {
    const st = stations[i] as (typeof stations)[number];
    // Scrap at the station itself diverts a share of the outflow before routing.
    const survive = 1 - st.scrapProbability;
    let sum = 0;
    for (const edge of st.routing) {
      sum += edge.probability;
      if (isSink(edge.to)) continue;
      const j = index.get(edge.to);
      if (j === undefined) {
        throw new Error(`Station "${st.id}" routes to unknown destination "${edge.to}".`);
      }
      // lambda_j gets p_ij * survive * lambda_i  =>  row j, column i.
      (A[j] as number[])[i] = ((A[j] as number[])[i] as number) - edge.probability * survive;
    }
    if (st.routing.length > 0 && Math.abs(sum - 1) > 1e-6) {
      warnings.push(
        `Routing probabilities out of "${st.name}" sum to ${sum.toFixed(4)}, not 1.0. ` +
          'Derived arrival rates downstream will be wrong until this is corrected.',
      );
    }
  }

  const lambdas = solveLinearSystem(A, r);

  const lambdaByStation: Record<string, number> = {};
  const visitRatios: Record<string, number> = {};
  stations.forEach((s, i) => {
    const v = lambdas[i] as number;
    const clean = Math.abs(v) < 1e-12 ? 0 : v;
    lambdaByStation[s.id] = clean;
    visitRatios[s.id] = lambdaExternal > 0 ? clean / lambdaExternal : 0;
    if (clean < -1e-9) {
      warnings.push(
        `Derived arrival rate at "${s.name}" is negative (${clean.toFixed(4)}/hour), which is ` +
          'physically impossible and indicates an inconsistent routing specification.',
      );
    }
  });

  // Outflows to the two sinks.
  let throughputFinished = 0;
  let throughputScrap = 0;
  stations.forEach((s, i) => {
    const li = lambdas[i] as number;
    throughputScrap += li * s.scrapProbability;
    const survive = 1 - s.scrapProbability;
    for (const e of s.routing) {
      if (e.to === SINK_FINISHED) throughputFinished += li * e.probability * survive;
      else if (e.to === SINK_SCRAP) throughputScrap += li * e.probability * survive;
    }
  });

  // Conservation check: what goes in must come out.
  const outflow = throughputFinished + throughputScrap;
  if (lambdaExternal > 0 && Math.abs(outflow - lambdaExternal) / lambdaExternal > 1e-4) {
    warnings.push(
      `Flow conservation check failed: external inflow ${lambdaExternal.toFixed(4)}/hour but ` +
        `total outflow (finished + scrap) ${outflow.toFixed(4)}/hour. The routing network ` +
        'either loses or creates vehicles.',
    );
  }

  return {
    lambdaByStation,
    visitRatios,
    lambdaExternal,
    throughputFinished,
    throughputScrap,
    warnings,
  };
}

/** Destination ids used by routing, including the two sinks. */
export const ROUTING_SINKS = [SINK_FINISHED, SINK_SCRAP] as const;
