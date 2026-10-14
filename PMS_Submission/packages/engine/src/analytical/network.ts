/**
 * Network-level analytical solution — requirements 8, 9, 10.
 *
 * Combines the traffic equations (derived per-station lambda) with the
 * per-station queueing model, then aggregates to whole-system metrics.
 *
 * Requirement 10 insists node-level and system-level metrics be kept distinct,
 * and the distinction is not cosmetic:
 *
 *   NODE:    L_j = lambda_j * W_j     using the station's OWN arrival rate,
 *                                     which includes repeat visits.
 *   SYSTEM:  L   = sum_j L_j
 *            W   = L / lambda_external
 *
 * The system-level W divides by the EXTERNAL arrival rate, not by the sum of
 * node arrival rates. Using sum(lambda_j) there would count a reworked vehicle
 * as several vehicles and understate the time each one actually spends in the
 * factory.
 *
 * Decomposition caveat: exact product-form (Jackson) results require Poisson
 * external arrivals, exponential service and unlimited queues. Where a station
 * is non-exponential the network is solved by decomposition — each node solved
 * in isolation with its derived lambda — which is an approximation. That is
 * flagged rather than hidden.
 */

import { distMean, isMarkovian, kendallSymbol } from '../distributions.js';
import { SINK_FINISHED, SINK_SCRAP, type SystemModel } from '../model/types.js';
import { solveStation, type QueueResult } from './queues.js';
import { solveTrafficEquations, type TrafficSolution } from './traffic.js';

export interface StationAnalytic extends QueueResult {
  stationId: string;
  stationName: string;
  /** Expected visits per vehicle, from the traffic equations. */
  visitRatio: number;
  /** Total service capacity, c*mu, vehicles/hour. */
  capacity: number;
  /** Service time per visit, minutes. */
  serviceMinutes: number;
  /** Wq expressed in minutes, for the UI. */
  WqMinutes: number;
  /** W expressed in minutes, for the UI. */
  WMinutes: number;
}

export interface SystemAnalytic {
  lambdaExternal: number;
  throughputFinished: number;
  throughputScrap: number;
  /** Sum of node L. Vehicles in the factory (WIP) in steady state. */
  L: number;
  Lq: number;
  /** L / lambda_external, in hours. Time one vehicle spends in the factory. */
  W: number;
  Wq: number;
  WMinutes: number;
  WqMinutes: number;
  /** Sum over stations of visitRatio * serviceMinutes — pure work content. */
  totalServiceMinutesPerVehicle: number;
  /** Every station stable (rho < 1). */
  stable: boolean;
  /** Station with the highest utilisation — the capacity-constraining resource. */
  bottleneckStationId: string | null;
  /** True when any node was solved by approximation rather than exactly. */
  containsApproximations: boolean;
}

export interface NetworkAnalytic {
  stations: StationAnalytic[];
  system: SystemAnalytic;
  traffic: TrafficSolution;
  warnings: string[];
  /** Whether service rates were de-rated for machine availability. */
  availabilityAdjusted: boolean;
}

export interface NetworkOptions {
  /**
   * De-rate each station's service rate by its machine availability
   * A = MTBF/(MTBF+MTTR).
   *
   * The closed-form queueing models have no notion of a server that fails, so
   * by default an analytical result DESCRIBES A FACTORY WHOSE MACHINES NEVER
   * BREAK. Where reliability is enabled, the simulation will show materially
   * longer queues than the analytical model — not because either is wrong, but
   * because they are answering different questions. Turning this on closes
   * most of that gap by charging the lost capacity to the service rate, though
   * it still cannot reproduce the queue built up during an individual outage,
   * so it remains an approximation.
   */
  adjustForAvailability?: boolean;
}

/**
 * Which stations can be solved EXACTLY by the closed-form models.
 *
 * A node-level M/M/c result is exact only if the node actually sees Poisson
 * arrivals. Burke's theorem gives that for a network of exponential-service
 * stations fed by a Poisson stream — and Jackson's theorem extends it to
 * Markovian routing with feedback. But the moment ONE station has a
 * non-exponential service time, its departure stream stops being Poisson, and
 * every station downstream of it inherits a non-Poisson input. Those nodes are
 * then solved by decomposition, which is an approximation even though the node
 * itself is M/M/c.
 *
 * Concretely in the reference line: Final Assembly is Erlang-2, whose output is
 * SMOOTHER than Poisson, so Quality Inspection downstream queues noticeably
 * less than its M/M/2 formula predicts. Marking such a node "exact" would
 * present an approximation as a fact, which requirement 60 forbids.
 *
 * Returns the set of station ids whose arrival process cannot be assumed
 * Poisson.
 */
export function nonPoissonStations(model: SystemModel): Set<string> {
  const contaminated = new Set<string>();

  // A non-exponential inter-arrival process contaminates the entry point.
  if (model.arrivals.interarrivalKind !== 'exponential') {
    contaminated.add(model.arrivals.entryStationId);
  }

  // Seed with the successors of every non-exponential station, then propagate
  // downstream to a fixed point (the routing graph has cycles, so a single
  // pass is not enough).
  const frontier: string[] = [];
  for (const st of model.stations) {
    if (!isMarkovian(st.service)) {
      for (const e of st.routing) {
        if (e.probability > 0) frontier.push(e.to);
      }
    }
  }
  for (const id of contaminated) frontier.push(id);

  while (frontier.length > 0) {
    const id = frontier.pop() as string;
    if (id === SINK_FINISHED || id === SINK_SCRAP) continue;
    if (contaminated.has(id)) continue;
    contaminated.add(id);
    const st = model.stations.find((s) => s.id === id);
    if (!st) continue;
    for (const e of st.routing) {
      if (e.probability > 0) frontier.push(e.to);
    }
  }

  return contaminated;
}

/** Machine availability A = MTBF / (MTBF + MTTR); 1 when reliability is off. */
export function stationAvailability(st: SystemModel['stations'][number]): number {
  const rel = st.machine?.reliability;
  if (!rel || !rel.enabled) return 1;
  const mtbf = rel.mtbfHours.value;
  const mttr = rel.mttrHours.value;
  if (mtbf <= 0) return 1;
  return mtbf / (mtbf + mttr);
}

/**
 * Solve the whole network analytically.
 *
 * @param externalLambda override the schedule's time-average lambda, used by
 *        what-if analysis to evaluate a demand level directly.
 */
export function solveNetwork(
  model: SystemModel,
  externalLambda?: number,
  options: NetworkOptions = {},
): NetworkAnalytic {
  const traffic = solveTrafficEquations(model, externalLambda);
  const warnings = [...traffic.warnings];
  const adjust = options.adjustForAvailability ?? false;

  const unreliable = model.stations.filter((s) => stationAvailability(s) < 1);
  if (unreliable.length > 0) {
    warnings.push(
      adjust
        ? `Service rates at ${unreliable.map((s) => s.name).join(', ')} have been de-rated by ` +
            'machine availability A = MTBF/(MTBF+MTTR). This is an approximation: it charges the ' +
            'lost capacity to the service rate but cannot represent the queue that builds up ' +
            'during an individual outage, so the simulation will still show somewhat longer queues.'
        : `Machine reliability is enabled at ${unreliable.map((s) => s.name).join(', ')}, but the ` +
            'closed-form queueing models assume servers never fail. These analytical results ' +
            'therefore describe a factory with no breakdowns and will UNDERSTATE queues and ' +
            'waiting times relative to the simulation. Enable availability adjustment, or read ' +
            'the simulation figures, when comparing the two.',
    );
  }

  const nonPoisson = nonPoissonStations(model);
  if (nonPoisson.size > 0) {
    const names = model.stations
      .filter((s) => nonPoisson.has(s.id))
      .map((s) => s.name)
      .join(', ');
    warnings.push(
      `Arrivals at ${names} are not Poisson, because a non-exponential station lies upstream. ` +
        'Their queueing results come from decomposition and are approximations, even where the ' +
        'station itself is M/M/c. A smoother-than-Poisson input makes the true queue SHORTER ' +
        'than the formula predicts; a burstier one makes it longer.',
    );
  }

  const stations: StationAnalytic[] = model.stations.map((st) => {
    const lambda = traffic.lambdaByStation[st.id] ?? 0;
    const availability = adjust ? stationAvailability(st) : 1;
    // De-rating capacity is equivalent to stretching the mean service time.
    const service =
      availability < 1 ? scaleServiceTime(st.service, 1 / availability) : st.service;
    const res = solveStation({ lambda, service, c: st.servers });
    const serviceMinutes = distMean(service);
    const mu = 60 / serviceMinutes;
    for (const w of res.warnings) warnings.push(`${st.name}: ${w}`);

    // A node is exact only if its own service is exponential AND its arrival
    // process is genuinely Poisson.
    const arrivalsPoisson = !nonPoisson.has(st.id);
    const exact = res.exact && arrivalsPoisson;
    const method = arrivalsPoisson
      ? res.method
      : `${res.method} -- APPROXIMATION: arrivals here are not Poisson (a non-exponential ` +
        'station lies upstream), so this is a decomposition estimate. Prefer the simulated value.';

    return {
      ...res,
      exact,
      method,
      stationId: st.id,
      stationName: st.name,
      visitRatio: traffic.visitRatios[st.id] ?? 0,
      capacity: st.servers * mu,
      serviceMinutes,
      WqMinutes: res.Wq * 60,
      WMinutes: res.W * 60,
    };
  });

  const allStable = stations.every((s) => s.stable);
  const L = allStable ? stations.reduce((a, s) => a + s.L, 0) : Infinity;
  const Lq = allStable ? stations.reduce((a, s) => a + s.Lq, 0) : Infinity;
  const lambdaExternal = traffic.lambdaExternal;
  const W = allStable && lambdaExternal > 0 ? L / lambdaExternal : Infinity;
  const Wq = allStable && lambdaExternal > 0 ? Lq / lambdaExternal : Infinity;

  const totalServiceMinutesPerVehicle = stations.reduce(
    (a, s) => a + s.visitRatio * s.serviceMinutes,
    0,
  );

  // Bottleneck = highest utilisation. Ties broken by larger queue.
  let bottleneckStationId: string | null = null;
  let bestRho = -1;
  for (const s of stations) {
    if (s.lambda <= 0) continue;
    if (s.rho > bestRho + 1e-12) {
      bestRho = s.rho;
      bottleneckStationId = s.stationId;
    }
  }

  const containsApproximations = stations.some((s) => !s.exact);
  if (containsApproximations) {
    warnings.push(
      'At least one station uses a non-exponential service distribution, so the network is ' +
        'solved by decomposition (each node in isolation). Those node results are ' +
        'approximations; the discrete-event simulation is the authoritative figure for them.',
    );
  }

  const nonMarkov = model.stations.filter((s) => !isMarkovian(s.service));
  if (nonMarkov.length > 0) {
    warnings.push(
      `Kendall notation reflects the configured distributions: ` +
        nonMarkov
          .map((s) => `${s.name} = M/${kendallSymbol(s.service)}/${s.servers}`)
          .join(', ') +
        '.',
    );
  }

  if (!allStable) {
    warnings.push(
      'One or more queues are unstable (rho >= 1). System-level L, Lq, W and Wq are not ' +
        'finite under the steady-state model and are reported as infinite rather than as numbers.',
    );
  }

  return {
    stations,
    system: {
      lambdaExternal,
      throughputFinished: traffic.throughputFinished,
      throughputScrap: traffic.throughputScrap,
      L,
      Lq,
      W,
      Wq,
      WMinutes: W * 60,
      WqMinutes: Wq * 60,
      totalServiceMinutesPerVehicle,
      stable: allStable,
      bottleneckStationId,
      containsApproximations,
    },
    traffic,
    warnings,
    availabilityAdjusted: adjust && unreliable.length > 0,
  };
}

/** Scale a distribution's mean by `factor`, preserving its shape and SCV. */
function scaleServiceTime(d: SystemModel['stations'][number]['service'], factor: number) {
  switch (d.kind) {
    case 'exponential':
      return { ...d, mean: d.mean * factor };
    case 'constant':
      return { ...d, value: d.value * factor };
    case 'erlang':
      return { ...d, mean: d.mean * factor };
    case 'uniform':
      return { ...d, min: d.min * factor, max: d.max * factor };
    case 'triangular':
      return { ...d, min: d.min * factor, mode: d.mode * factor, max: d.max * factor };
    case 'normal':
      return { ...d, mean: d.mean * factor, sd: d.sd * factor };
    case 'lognormal':
      return { ...d, mean: d.mean * factor, sd: d.sd * factor };
    case 'gamma':
      return { ...d, scale: d.scale * factor };
    case 'weibull':
      return { ...d, scale: d.scale * factor };
  }
}

/**
 * Maximum external lambda the network can sustain, found by locating the
 * station whose capacity binds first.
 *
 * Because every lambda_j scales linearly with the external rate (the traffic
 * equations are linear), the critical rate is
 *
 *     lambda_max = min_j ( c_j * mu_j / V_j )
 *
 * where V_j is the visit ratio. This is the factory's theoretical maximum
 * throughput and the number requirement 69 ("how many vehicles can my factory
 * produce?") asks for.
 */
export function capacityLimit(model: SystemModel): {
  lambdaMaxPerHour: number;
  bindingStationId: string | null;
  perStation: { stationId: string; stationName: string; lambdaMax: number; visitRatio: number; capacity: number }[];
} {
  // Solve at a reference rate of 1/hour to read off the visit ratios.
  const ref = solveTrafficEquations(model, 1);
  const perStation = model.stations.map((st) => {
    const v = ref.visitRatios[st.id] ?? 0;
    const mu = 60 / distMean(st.service);
    const capacity = st.servers * mu;
    return {
      stationId: st.id,
      stationName: st.name,
      visitRatio: v,
      capacity,
      lambdaMax: v > 0 ? capacity / v : Infinity,
    };
  });

  let lambdaMaxPerHour = Infinity;
  let bindingStationId: string | null = null;
  for (const s of perStation) {
    if (s.lambdaMax < lambdaMaxPerHour) {
      lambdaMaxPerHour = s.lambdaMax;
      bindingStationId = s.stationId;
    }
  }
  return { lambdaMaxPerHour, bindingStationId, perStation };
}
