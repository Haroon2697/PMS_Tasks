/**
 * Bottleneck analysis — requirement 42.
 *
 * Requirement 42 forbids identifying bottlenecks "using arbitrary hardcoded
 * thresholds alone" — no "utilisation > 85% means bottleneck". Every judgement
 * here is derived from the model:
 *
 *  1. CAPACITY (the primary test). The bottleneck is the station whose
 *     capacity binds first as demand scales up:
 *         lambda_max(j) = c_j * mu_j / V_j
 *     with V_j the visit ratio from the traffic equations. The station with
 *     the smallest lambda_max caps the whole factory's output. This is the
 *     theory-of-constraints definition and it does not depend on the demand
 *     level at all.
 *
 *  2. DELAY CONTRIBUTION. Which station accounts for the largest share of the
 *     time a vehicle spends waiting — the constraint the customer feels.
 *
 *  3. MARGINAL VALUE. What actually happens if one server is added: the real
 *     test of whether relieving a station helps. Computed by re-solving the
 *     network, not estimated.
 *
 * Capacity bottleneck and delay bottleneck can be different stations, and when
 * they are, that is the most useful thing the analysis can tell you — so both
 * are reported rather than collapsed into one "the bottleneck is X".
 */

import { distMean } from '../distributions.js';
import type { SystemModel } from '../model/types.js';
import { capacityLimit, solveNetwork, type NetworkAnalytic } from './network.js';
import { deepClone } from '../util/clone.js';

export interface BottleneckStation {
  stationId: string;
  stationName: string;
  servers: number;
  /** Utilisation at the demand level analysed. */
  rho: number;
  /** c * mu, vehicles/hour. */
  capacity: number;
  /** Expected visits per vehicle. */
  visitRatio: number;
  /** Maximum external demand this station alone could sustain. */
  lambdaMaxPerHour: number;
  /** lambdaMax - current lambda, in external vehicles/hour. */
  slackPerHour: number;
  /** Mean queue wait, minutes. */
  WqMinutes: number;
  /** Average number waiting. */
  Lq: number;
  /** This station's share of the total waiting time per vehicle, 0..1. */
  delayShare: number;
  /** Waiting cost attributable to this station over one production hour. */
  waitingCostPerHour: number;
  /** Rank by capacity constraint: 1 = tightest. */
  capacityRank: number;
  /** Rank by delay contribution: 1 = largest. */
  delayRank: number;
  /** Extra throughput from adding one server here, vehicles/hour. */
  throughputGainPerExtraServer: number;
  /** Reduction in system Wq from adding one server here, minutes. */
  wqReductionPerExtraServer: number;
  /** Plain-language explanation shown in the UI (requirement 42). */
  reasons: string[];
}

export interface BottleneckAnalysis {
  /** Station that caps factory throughput. */
  primaryBottleneckId: string | null;
  /** Next station to bind once the primary is relieved. */
  secondaryBottleneckId: string | null;
  /** Station contributing the most waiting time. */
  delayBottleneckId: string | null;
  /** Maximum sustainable external demand, vehicles/hour. */
  factoryCapacityPerHour: number;
  /** Factory capacity expressed per production day. */
  factoryCapacityPerDay: number;
  /** Demand level this analysis was run at. */
  lambdaPerHour: number;
  /** Headroom before the factory saturates, as a fraction of capacity. */
  utilisationOfCapacity: number;
  stations: BottleneckStation[];
  /** What relieving the primary bottleneck would buy. */
  reliefPreview: {
    stationId: string;
    stationName: string;
    newCapacityPerHour: number;
    capacityGainPerHour: number;
    nextConstraintId: string | null;
    nextConstraintName: string | null;
    note: string;
  } | null;
  warnings: string[];
}

/**
 * Analyse bottlenecks at a given demand level.
 *
 * @param lambdaPerHour demand to evaluate at; defaults to the schedule mean.
 */
export function analyseBottlenecks(
  model: SystemModel,
  lambdaPerHour?: number,
  net?: NetworkAnalytic,
): BottleneckAnalysis {
  const analysis = net ?? solveNetwork(model, lambdaPerHour);
  const lambda = analysis.system.lambdaExternal;
  const cap = capacityLimit(model);
  const warnings = [...analysis.warnings];

  // Total waiting time per vehicle = sum over stations of visits x Wq.
  const totalWaitPerVehicle = analysis.stations.reduce(
    (a, s) => a + (Number.isFinite(s.WqMinutes) ? s.visitRatio * s.WqMinutes : 0),
    0,
  );

  const waitingRate = model.cost.waitingCostPerVehicleHour.value;

  const byCapacity = [...cap.perStation].sort((a, b) => a.lambdaMax - b.lambdaMax);
  const capacityRankOf = new Map<string, number>();
  byCapacity.forEach((s, i) => capacityRankOf.set(s.stationId, i + 1));

  const rows: Omit<BottleneckStation, 'delayRank'>[] = analysis.stations.map((s) => {
    const def = model.stations.find((x) => x.id === s.stationId);
    const capRow = cap.perStation.find((x) => x.stationId === s.stationId);
    const lambdaMax = capRow?.lambdaMax ?? Infinity;
    const delayContribution = Number.isFinite(s.WqMinutes) ? s.visitRatio * s.WqMinutes : 0;
    const delayShare = totalWaitPerVehicle > 0 ? delayContribution / totalWaitPerVehicle : 0;

    // Marginal value of one more server, computed by actually re-solving.
    const marginal = marginalServerEffect(model, s.stationId, lambda, analysis);

    const reasons: string[] = [];
    const rank = capacityRankOf.get(s.stationId) ?? 999;
    if (rank === 1) {
      reasons.push(
        `Tightest capacity in the network: it can sustain only ${lambdaMax.toFixed(2)} vehicles/hour ` +
          `of external demand (c x mu / visits = ${s.c} x ${(60 / s.serviceMinutes).toFixed(2)} / ` +
          `${s.visitRatio.toFixed(3)}). No other station can be the throughput constraint while ` +
          'this one is the lowest.',
      );
    }
    if (s.rho >= 1) {
      reasons.push(
        `Utilisation is ${(s.rho * 100).toFixed(1)}% — at or above 100%. Work arrives faster than ` +
          'it can be processed, so the queue grows without bound and this station alone determines ' +
          'output.',
      );
    } else if (s.rho > 0) {
      reasons.push(
        `Utilisation ${(s.rho * 100).toFixed(1)}%: the station is busy ${(s.rho * 100).toFixed(1)}% ` +
          `of available server time, leaving ${(lambdaMax - lambda).toFixed(2)} vehicles/hour of ` +
          'demand headroom before it saturates.',
      );
    }
    if (delayShare > 0.2) {
      reasons.push(
        `Accounts for ${(delayShare * 100).toFixed(1)}% of the total time a vehicle spends waiting ` +
          `(${delayContribution.toFixed(1)} of ${totalWaitPerVehicle.toFixed(1)} minutes per vehicle).`,
      );
    }
    if (s.visitRatio > 1.001) {
      reasons.push(
        `Each vehicle passes through here ${s.visitRatio.toFixed(3)} times on average because of the ` +
          'rework loop, so its effective load is higher than the external arrival rate suggests.',
      );
    }
    if (marginal.throughputGain > 1e-6) {
      reasons.push(
        `Adding one server would raise maximum factory throughput by ` +
          `${marginal.throughputGain.toFixed(2)} vehicles/hour.`,
      );
    } else if (rank !== 1) {
      reasons.push(
        'Adding a server here would not raise factory throughput: another station binds first.',
      );
    }

    return {
      stationId: s.stationId,
      stationName: s.stationName,
      servers: s.c,
      rho: s.rho,
      capacity: s.capacity,
      visitRatio: s.visitRatio,
      lambdaMaxPerHour: lambdaMax,
      slackPerHour: lambdaMax - lambda,
      WqMinutes: s.WqMinutes,
      Lq: s.Lq,
      delayShare,
      // Vehicle-hours waiting per production hour = Lq; priced at the waiting rate.
      waitingCostPerHour: Number.isFinite(s.Lq) ? s.Lq * waitingRate : Infinity,
      capacityRank: rank,
      throughputGainPerExtraServer: marginal.throughputGain,
      wqReductionPerExtraServer: marginal.wqReduction,
      reasons,
      ...(def ? {} : {}),
    };
  });

  const byDelay = [...rows].sort((a, b) => b.delayShare - a.delayShare);
  const delayRankOf = new Map<string, number>();
  byDelay.forEach((s, i) => delayRankOf.set(s.stationId, i + 1));

  const stations: BottleneckStation[] = rows.map((r) => ({
    ...r,
    delayRank: delayRankOf.get(r.stationId) ?? 999,
  }));

  const primary = byCapacity[0] ?? null;
  const secondary = byCapacity[1] ?? null;
  const delayTop = byDelay[0] ?? null;

  const annualHours = model.investment.hoursPerDay.value;

  let reliefPreview: BottleneckAnalysis['reliefPreview'] = null;
  if (primary) {
    const relieved = deepClone(model);
    const st = relieved.stations.find((s) => s.id === primary.stationId);
    if (st) {
      st.servers += 1;
      const newCap = capacityLimit(relieved);
      const nextId = newCap.bindingStationId;
      const nextName = relieved.stations.find((s) => s.id === nextId)?.name ?? null;
      reliefPreview = {
        stationId: primary.stationId,
        stationName: primary.stationName,
        newCapacityPerHour: newCap.lambdaMaxPerHour,
        capacityGainPerHour: newCap.lambdaMaxPerHour - cap.lambdaMaxPerHour,
        nextConstraintId: nextId,
        nextConstraintName: nextName,
        note:
          nextId === primary.stationId
            ? `Even with an extra server, ${primary.stationName} remains the constraint. More than ` +
              'one additional server is needed to move the bottleneck.'
            : `Adding one server at ${primary.stationName} raises factory capacity from ` +
              `${cap.lambdaMaxPerHour.toFixed(2)} to ${newCap.lambdaMaxPerHour.toFixed(2)} vehicles/hour, ` +
              `after which ${nextName ?? 'another station'} becomes the binding constraint. Capacity ` +
              'improvement always moves the constraint rather than removing it.',
      };
    }
  }

  if (delayTop && primary && delayTop.stationId !== primary.stationId) {
    warnings.push(
      `The capacity bottleneck (${primary.stationName}) and the delay bottleneck ` +
        `(${delayTop.stationName}) are different stations. Adding capacity at ${primary.stationName} ` +
        `raises maximum output; reducing waiting time for vehicles means addressing ` +
        `${delayTop.stationName}. Decide which problem you are solving before investing.`,
    );
  }

  return {
    primaryBottleneckId: primary?.stationId ?? null,
    secondaryBottleneckId: secondary?.stationId ?? null,
    delayBottleneckId: delayTop?.stationId ?? null,
    factoryCapacityPerHour: cap.lambdaMaxPerHour,
    factoryCapacityPerDay: cap.lambdaMaxPerHour * annualHours,
    lambdaPerHour: lambda,
    utilisationOfCapacity: cap.lambdaMaxPerHour > 0 ? lambda / cap.lambdaMaxPerHour : 0,
    stations,
    reliefPreview,
    warnings,
  };
}

/**
 * Effect of adding exactly one server at a station: the change in maximum
 * sustainable throughput and in total waiting time per vehicle.
 *
 * Computed by re-solving the network with the extra server rather than by any
 * rule of thumb, so the answer accounts for the fact that relieving a
 * non-binding station buys nothing.
 */
export function marginalServerEffect(
  model: SystemModel,
  stationId: string,
  lambdaPerHour: number,
  baseline?: NetworkAnalytic,
): { throughputGain: number; wqReduction: number } {
  const base = baseline ?? solveNetwork(model, lambdaPerHour);
  const baseCap = capacityLimit(model);

  const modified = deepClone(model);
  const st = modified.stations.find((s) => s.id === stationId);
  if (!st) return { throughputGain: 0, wqReduction: 0 };
  st.servers += 1;

  const newCap = capacityLimit(modified);
  const throughputGain = newCap.lambdaMaxPerHour - baseCap.lambdaMaxPerHour;

  const baseWq = totalWaitPerVehicle(base);
  const newNet = solveNetwork(modified, lambdaPerHour);
  const newWq = totalWaitPerVehicle(newNet);
  const wqReduction =
    Number.isFinite(baseWq) && Number.isFinite(newWq) ? baseWq - newWq : Infinity;

  return { throughputGain, wqReduction };
}

/** Total minutes a vehicle spends queueing across the whole route. */
export function totalWaitPerVehicle(net: NetworkAnalytic): number {
  let sum = 0;
  for (const s of net.stations) {
    if (!Number.isFinite(s.WqMinutes)) return Infinity;
    sum += s.visitRatio * s.WqMinutes;
  }
  return sum;
}

/** Work content per vehicle, minutes — the floor on cycle time. */
export function theoreticalMinimumCycleMinutes(model: SystemModel): number {
  const net = solveNetwork(model);
  let sum = 0;
  for (const s of net.stations) {
    sum += s.visitRatio * distMean(model.stations.find((x) => x.id === s.stationId)!.service);
  }
  return sum;
}
