/**
 * Process discovery — Task 7, step 2.
 *
 * Takes a parsed event log and derives the structure and parameters of the
 * queueing network that produced it. This is real process mining: the routing
 * comes from a directly-follows graph built from the traces, and every rate is
 * estimated from observed timestamps.
 *
 * WHAT THE LOG CAN AND CANNOT TELL YOU
 * ------------------------------------
 * A log of (case, activity, start, complete) determines a great deal —
 * activity set, ordering, service times, waiting times, routing frequencies,
 * arrival rate, loops — but it genuinely does NOT determine everything a
 * queueing model needs. Two things in particular:
 *
 *  - **Number of servers.** The log never says how many bays a station has.
 *    It is ESTIMATED as the maximum number of executions of that activity
 *    observed running at the same time, which is a lower bound on capacity
 *    (a station with four bays that never had more than two cars in it at once
 *    looks like a two-bay station). This is surfaced as an editable assumption
 *    rather than presented as a discovered fact.
 *
 *  - **Distribution family.** The log gives a sample, not a family. The
 *    coefficient of variation of the observed service times is used to pick a
 *    family (CV ~ 0 -> D, CV ~ 1 -> M, CV < 1 -> Erlang-k, CV > 1 -> general),
 *    which is a principled fit rather than a default, but it is still an
 *    inference and is labelled as one.
 *
 * Everything the discovery infers rather than measures is returned in
 * `assumptions`, each with the reason it had to be assumed.
 */

import { distMean, type Distribution } from '../distributions.js';
import type { EventRow, ParsedEventLog } from './eventLog.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One case's events, ordered in time. */
export interface Trace {
  caseId: string;
  events: EventRow[];
  /** First start. */
  arrival: number;
  /** Last completion. */
  completion: number;
  /** completion - arrival. */
  cycleMinutes: number;
  /** Sum of (start - previous complete), clamped at 0. */
  waitingMinutes: number;
  /** Sum of (complete - start). */
  processingMinutes: number;
  /** Activity names in order, e.g. ['Body Shop','Paint','Inspection']. */
  sequence: string[];
  /** Activities that occur more than once in this trace. */
  repeated: string[];
}

export interface ActivityStats {
  name: string;
  /** Stable id derived from the name, used as the station id. */
  id: string;
  /** Number of times this activity was executed across all cases. */
  executions: number;
  /** Number of distinct cases that performed it at least once. */
  cases: number;

  serviceMeanMinutes: number;
  serviceSdMinutes: number;
  /** sd / mean — drives the fitted distribution family. */
  serviceCV: number;
  serviceMinMinutes: number;
  serviceMedianMinutes: number;
  serviceMaxMinutes: number;

  /** Maximum simultaneous executions observed — the server-count estimate. */
  maxConcurrency: number;

  /** Mean queueing delay before this activity, where observable. */
  observedWaitMeanMinutes: number;
  observedWaitMaxMinutes: number;
  /** How many of the executions had an observable preceding activity. */
  waitObservations: number;

  /** executions / observation window, vehicles/hour. */
  lambdaObservedPerHour: number;
  /** 60 / mean service time, vehicles/hour/server. */
  muObservedPerHour: number;
  /** Busy server-time / (servers x window). */
  utilizationObserved: number;

  /** Mean number of times one case visits this activity. */
  visitsPerCase: number;
  /** Times this activity was the first in a trace. */
  startCount: number;
  /** Times this activity was the last in a trace. */
  endCount: number;
  /** Executions immediately following another execution of the same activity. */
  selfLoops: number;
}

export interface DfgEdge {
  from: string;
  to: string;
  count: number;
  /** count / total outflow from `from`, including terminations. */
  probability: number;
  /** Mean gap between the predecessor completing and the successor starting. */
  meanGapMinutes: number;
  /** True when this arc returns to an activity seen earlier in the trace. */
  isLoopBack: boolean;
}

export interface DiscoveredLoop {
  /** Activities in the cycle, in order. */
  activities: string[];
  kind: 'self' | 'cycle';
  /** Cases that went round it at least once. */
  cases: number;
  /** Total traversals. */
  count: number;
  /** Share of cases affected. */
  share: number;
}

export interface Variant {
  sequence: string[];
  count: number;
  share: number;
}

export interface DiscoveryAssumption {
  id: string;
  label: string;
  value: number | string;
  unit: string;
  /** Why the log could not determine it. */
  why: string;
  /** Whether the UI should offer it for editing. */
  editable: boolean;
  /** Which activity it belongs to, if any. */
  activityId?: string;
}

export interface InterArrivalStats {
  count: number;
  meanMinutes: number;
  sdMinutes: number;
  cv: number;
  lambdaPerHour: number;
  /** Kendall symbol fitted from the CV. */
  symbol: string;
}

export interface DiscoveredProcess {
  activities: ActivityStats[];
  edges: DfgEdge[];
  traces: Trace[];
  variants: Variant[];
  loops: DiscoveredLoop[];
  interArrival: InterArrivalStats;

  /** Activity ids that traces begin at, with counts. */
  startActivities: { id: string; name: string; count: number }[];
  endActivities: { id: string; name: string; count: number }[];

  caseCount: number;
  eventCount: number;
  /** First start to last completion, minutes. */
  observationWindowMinutes: number;

  cycleTime: {
    meanMinutes: number;
    medianMinutes: number;
    p95Minutes: number;
    minMinutes: number;
    maxMinutes: number;
  };

  /** Activity with the highest observed utilisation. */
  bottleneckActivityId: string | null;
  /** Activity where cases wait longest in total. */
  delayActivityId: string | null;

  assumptions: DiscoveryAssumption[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Stable, readable station id from an activity name. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'activity';
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) * (hi - idx) + (sorted[hi] as number) * (idx - lo);
}

/**
 * Maximum number of intervals overlapping at any instant — a sweep line over
 * start/end points. This is the server-count estimator.
 */
export function maxOverlap(intervals: { start: number; complete: number }[]): number {
  if (intervals.length === 0) return 0;
  const points: { t: number; delta: number }[] = [];
  for (const i of intervals) {
    points.push({ t: i.start, delta: 1 });
    // Ends are processed before starts at the same instant, so an activity
    // that finishes exactly as the next begins does not count as concurrent.
    points.push({ t: i.complete, delta: -1 });
  }
  points.sort((a, b) => (a.t === b.t ? a.delta - b.delta : a.t - b.t));
  let current = 0;
  let max = 0;
  for (const p of points) {
    current += p.delta;
    if (current > max) max = current;
  }
  return max;
}

/**
 * Fit a distribution family to an observed sample via its coefficient of
 * variation. Returns the distribution and the Kendall symbol it implies.
 *
 * The bands are the standard ones: a CV near 1 is the signature of an
 * exponential, a CV near 0 of a constant, and 1/CV^2 is the method-of-moments
 * estimate of an Erlang's phase count.
 */
export function fitDistribution(
  meanMinutes: number,
  cv: number,
): { distribution: Distribution; symbol: string; rationale: string } {
  if (!(meanMinutes > 0)) {
    return {
      distribution: { kind: 'constant', value: Math.max(meanMinutes, 0.01) },
      symbol: 'D',
      rationale: 'Mean service time is zero or negative in the log; treated as deterministic.',
    };
  }
  if (cv < 0.15) {
    return {
      distribution: { kind: 'constant', value: meanMinutes },
      symbol: 'D',
      rationale: `Observed CV ${cv.toFixed(3)} is close to 0, so service times are effectively constant (Kendall D).`,
    };
  }
  if (cv < 0.85) {
    const k = Math.max(2, Math.min(20, Math.round(1 / (cv * cv))));
    return {
      distribution: { kind: 'erlang', k, mean: meanMinutes },
      symbol: `E${k}`,
      rationale:
        `Observed CV ${cv.toFixed(3)} is below 1, so service is less variable than exponential. ` +
        `Erlang-${k} fitted by method of moments (k = 1/CV^2).`,
    };
  }
  if (cv <= 1.15) {
    return {
      distribution: { kind: 'exponential', mean: meanMinutes },
      symbol: 'M',
      rationale: `Observed CV ${cv.toFixed(3)} is close to 1, the signature of an exponential service time (Kendall M).`,
    };
  }
  return {
    distribution: { kind: 'lognormal', mean: meanMinutes, sd: cv * meanMinutes },
    symbol: 'G',
    rationale:
      `Observed CV ${cv.toFixed(3)} exceeds 1, so service is more variable than exponential. ` +
      'A lognormal with the observed mean and CV is fitted (Kendall G).',
  };
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export interface DiscoverOptions {
  /** Override the estimated server count per activity id. */
  serverOverrides?: Record<string, number>;
  /**
   * Drop directly-follows arcs seen fewer than this many times. Filters noise
   * out of the routing without changing the activity set.
   */
  minEdgeCount?: number;
}

export function discoverProcess(
  log: ParsedEventLog,
  options: DiscoverOptions = {},
): DiscoveredProcess {
  const warnings = [...log.warnings];
  const assumptions: DiscoveryAssumption[] = [];
  const minEdgeCount = options.minEdgeCount ?? 1;

  if (log.rows.length === 0) throw new Error('The event log has no usable rows.');

  /* ---- traces ---- */

  const byCase = new Map<string, EventRow[]>();
  for (const r of log.rows) {
    const list = byCase.get(r.caseId);
    if (list) list.push(r);
    else byCase.set(r.caseId, [r]);
  }

  const traces: Trace[] = [];
  for (const [caseId, rawEvents] of byCase) {
    // Order by start, then by completion, so simultaneous starts are still
    // deterministic.
    const events = [...rawEvents].sort((a, b) =>
      a.start === b.start ? a.complete - b.complete : a.start - b.start,
    );
    const arrival = events[0]?.start ?? 0;
    const completion = events.reduce((m, e) => Math.max(m, e.complete), arrival);

    let waiting = 0;
    for (let i = 1; i < events.length; i++) {
      const gap = (events[i] as EventRow).start - (events[i - 1] as EventRow).complete;
      if (gap > 0) waiting += gap;
    }
    const processing = events.reduce((a, e) => a + (e.complete - e.start), 0);

    const sequence = events.map((e) => e.activity);
    const counts = new Map<string, number>();
    for (const a of sequence) counts.set(a, (counts.get(a) ?? 0) + 1);
    const repeated = [...counts.entries()].filter(([, n]) => n > 1).map(([a]) => a);

    traces.push({
      caseId,
      events,
      arrival,
      completion,
      cycleMinutes: completion - arrival,
      waitingMinutes: waiting,
      processingMinutes: processing,
      sequence,
      repeated,
    });
  }
  traces.sort((a, b) => a.arrival - b.arrival);

  const windowStart = Math.min(...log.rows.map((r) => r.start));
  const windowEnd = Math.max(...log.rows.map((r) => r.complete));
  const observationWindowMinutes = Math.max(1e-9, windowEnd - windowStart);
  const windowHours = observationWindowMinutes / 60;

  /* ---- per-activity statistics ---- */

  const activityRows = new Map<string, EventRow[]>();
  for (const r of log.rows) {
    const list = activityRows.get(r.activity);
    if (list) list.push(r);
    else activityRows.set(r.activity, [r]);
  }

  // Waiting time before each execution, and self-loop counts.
  const waitsByActivity = new Map<string, number[]>();
  const selfLoopByActivity = new Map<string, number>();
  const startCount = new Map<string, number>();
  const endCount = new Map<string, number>();

  for (const t of traces) {
    for (let i = 0; i < t.events.length; i++) {
      const e = t.events[i] as EventRow;
      if (i === 0) {
        startCount.set(e.activity, (startCount.get(e.activity) ?? 0) + 1);
      } else {
        const prev = t.events[i - 1] as EventRow;
        const gap = e.start - prev.complete;
        const list = waitsByActivity.get(e.activity) ?? [];
        list.push(Math.max(0, gap));
        waitsByActivity.set(e.activity, list);
        if (gap < -1e-9) {
          // Overlapping activities within one case means the log records
          // parallel work, which a sequential queueing model cannot represent.
          const key = 'overlap';
          if (!warnings.some((w) => w.startsWith('Some cases have overlapping'))) {
            warnings.push(
              'Some cases have overlapping activities — one starts before the previous finishes. ' +
                'The discovered model is sequential, so those overlaps are treated as zero waiting ' +
                'time. If the real process runs steps in parallel, the discovered cycle time will ' +
                'be longer than reality.',
            );
          }
          void key;
        }
        if (prev.activity === e.activity) {
          selfLoopByActivity.set(e.activity, (selfLoopByActivity.get(e.activity) ?? 0) + 1);
        }
      }
    }
    const last = t.events[t.events.length - 1] as EventRow;
    endCount.set(last.activity, (endCount.get(last.activity) ?? 0) + 1);
  }

  const activities: ActivityStats[] = [];
  for (const [name, rows] of activityRows) {
    const id = slugify(name);
    const durations = rows.map((r) => r.complete - r.start);
    const sorted = [...durations].sort((a, b) => a - b);
    const m = mean(durations);
    const s = sd(durations);
    const cv = m > 0 ? s / m : 0;

    const estimated = maxOverlap(rows);
    const servers = options.serverOverrides?.[id] ?? Math.max(1, estimated);

    const waits = waitsByActivity.get(name) ?? [];
    const busyMinutes = durations.reduce((a, b) => a + b, 0);
    const casesWithActivity = new Set(rows.map((r) => r.caseId)).size;

    activities.push({
      name,
      id,
      executions: rows.length,
      cases: casesWithActivity,
      serviceMeanMinutes: m,
      serviceSdMinutes: s,
      serviceCV: cv,
      serviceMinMinutes: sorted[0] ?? 0,
      serviceMedianMinutes: percentile(sorted, 0.5),
      serviceMaxMinutes: sorted[sorted.length - 1] ?? 0,
      maxConcurrency: estimated,
      observedWaitMeanMinutes: mean(waits),
      observedWaitMaxMinutes: waits.length ? Math.max(...waits) : 0,
      waitObservations: waits.length,
      lambdaObservedPerHour: rows.length / windowHours,
      muObservedPerHour: m > 0 ? 60 / m : 0,
      utilizationObserved: busyMinutes / (servers * observationWindowMinutes),
      visitsPerCase: rows.length / traces.length,
      startCount: startCount.get(name) ?? 0,
      endCount: endCount.get(name) ?? 0,
      selfLoops: selfLoopByActivity.get(name) ?? 0,
    });
  }

  /* ---- directly-follows graph ---- */

  const edgeCounts = new Map<string, { from: string; to: string; count: number; gaps: number[]; loopBack: number }>();
  for (const t of traces) {
    const seenSoFar = new Set<string>();
    seenSoFar.add(t.sequence[0] as string);
    for (let i = 1; i < t.events.length; i++) {
      const prev = t.events[i - 1] as EventRow;
      const cur = t.events[i] as EventRow;
      const from = slugify(prev.activity);
      const to = slugify(cur.activity);
      const key = `${from}>>${to}`;
      const entry = edgeCounts.get(key) ?? { from, to, count: 0, gaps: [], loopBack: 0 };
      entry.count++;
      entry.gaps.push(cur.start - prev.complete);
      // Returning to an activity already seen in this trace is a loop-back.
      if (seenSoFar.has(cur.activity)) entry.loopBack++;
      edgeCounts.set(key, entry);
      seenSoFar.add(cur.activity);
    }
  }

  const outflow = new Map<string, number>();
  for (const e of edgeCounts.values()) {
    if (e.count < minEdgeCount) continue;
    outflow.set(e.from, (outflow.get(e.from) ?? 0) + e.count);
  }
  // Terminations count as outflow too: a case that ends at an activity has
  // left the system from there, and the routing probabilities must include it
  // or they will not sum to 1.
  for (const a of activities) {
    if (a.endCount > 0) outflow.set(a.id, (outflow.get(a.id) ?? 0) + a.endCount);
  }

  const edges: DfgEdge[] = [];
  let filtered = 0;
  for (const e of edgeCounts.values()) {
    if (e.count < minEdgeCount) {
      filtered++;
      continue;
    }
    const total = outflow.get(e.from) ?? e.count;
    edges.push({
      from: e.from,
      to: e.to,
      count: e.count,
      probability: total > 0 ? e.count / total : 0,
      meanGapMinutes: mean(e.gaps),
      isLoopBack: e.loopBack > e.count / 2,
    });
  }
  edges.sort((a, b) => b.count - a.count);

  // Order activities by their depth in the process, walking forward from the
  // start activities and ignoring loop-back arcs. Ordering by average position
  // in the trace would be wrong here: a rework step sits late in the traces
  // that contain it, but it belongs AFTER the inspection that routes to it, and
  // only a graph walk gets that right.
  orderActivitiesByFlow(activities, edges, startCount);

  if (filtered > 0) {
    warnings.push(
      `${filtered} rare transition(s) occurring fewer than ${minEdgeCount} times were filtered out ` +
        'of the routing as noise. Lower the threshold to keep them.',
    );
  }

  /* ---- loops ---- */

  const loops: DiscoveredLoop[] = [];
  for (const a of activities) {
    if (a.selfLoops > 0) {
      const casesAffected = traces.filter((t) => {
        for (let i = 1; i < t.sequence.length; i++) {
          if (t.sequence[i] === a.name && t.sequence[i - 1] === a.name) return true;
        }
        return false;
      }).length;
      loops.push({
        activities: [a.id],
        kind: 'self',
        cases: casesAffected,
        count: a.selfLoops,
        share: casesAffected / traces.length,
      });
    }
  }
  // Two-activity cycles: A -> B and B -> A both present. This is the classic
  // inspection -> rework -> inspection signature.
  const edgeSet = new Set(edges.map((e) => `${e.from}>>${e.to}`));
  const seenPair = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const back = `${e.to}>>${e.from}`;
    if (!edgeSet.has(back)) continue;
    const key = [e.from, e.to].sort().join('|');
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    const nameA = activities.find((a) => a.id === e.from)?.name;
    const nameB = activities.find((a) => a.id === e.to)?.name;
    const casesAffected = traces.filter((t) => {
      for (let i = 1; i < t.sequence.length; i++) {
        if (
          (t.sequence[i - 1] === nameA && t.sequence[i] === nameB) ||
          (t.sequence[i - 1] === nameB && t.sequence[i] === nameA)
        ) {
          const later = t.sequence.slice(i + 1);
          if (later.includes(nameA as string) || later.includes(nameB as string)) return true;
        }
      }
      return false;
    }).length;
    const backEdge = edges.find((x) => x.from === e.to && x.to === e.from);
    loops.push({
      activities: [e.from, e.to],
      kind: 'cycle',
      cases: casesAffected,
      count: Math.min(e.count, backEdge?.count ?? 0),
      share: casesAffected / traces.length,
    });
  }

  /* ---- variants ---- */

  const variantMap = new Map<string, number>();
  for (const t of traces) {
    const key = t.sequence.join(' > ');
    variantMap.set(key, (variantMap.get(key) ?? 0) + 1);
  }
  const variants: Variant[] = [...variantMap.entries()]
    .map(([k, count]) => ({ sequence: k.split(' > '), count, share: count / traces.length }))
    .sort((a, b) => b.count - a.count);

  /* ---- inter-arrival ---- */

  const arrivals = traces.map((t) => t.arrival).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < arrivals.length; i++) {
    gaps.push((arrivals[i] as number) - (arrivals[i - 1] as number));
  }
  const iaMean = mean(gaps);
  const iaSd = sd(gaps);
  const iaCv = iaMean > 0 ? iaSd / iaMean : 0;
  const interArrival: InterArrivalStats = {
    count: gaps.length,
    meanMinutes: iaMean,
    sdMinutes: iaSd,
    cv: iaCv,
    // Arrival rate over the window. Using (n-1) gaps over the arrival span is
    // the maximum-likelihood rate for a Poisson process.
    lambdaPerHour: iaMean > 0 ? 60 / iaMean : 0,
    symbol: fitDistribution(Math.max(iaMean, 1e-9), iaCv).symbol,
  };

  /* ---- cycle time ---- */

  const cycles = traces.map((t) => t.cycleMinutes).sort((a, b) => a - b);
  const cycleTime = {
    meanMinutes: mean(cycles),
    medianMinutes: percentile(cycles, 0.5),
    p95Minutes: percentile(cycles, 0.95),
    minMinutes: cycles[0] ?? 0,
    maxMinutes: cycles[cycles.length - 1] ?? 0,
  };

  /* ---- bottlenecks ---- */

  let bottleneckActivityId: string | null = null;
  let bestUtil = -1;
  for (const a of activities) {
    if (a.utilizationObserved > bestUtil) {
      bestUtil = a.utilizationObserved;
      bottleneckActivityId = a.id;
    }
  }
  let delayActivityId: string | null = null;
  let worstDelay = -1;
  for (const a of activities) {
    const totalWait = a.observedWaitMeanMinutes * a.visitsPerCase;
    if (totalWait > worstDelay) {
      worstDelay = totalWait;
      delayActivityId = a.id;
    }
  }

  /* ---- assumptions the log could not determine ---- */

  for (const a of activities) {
    assumptions.push({
      id: `servers:${a.id}`,
      label: `${a.name} — number of servers`,
      value: options.serverOverrides?.[a.id] ?? Math.max(1, a.maxConcurrency),
      unit: 'parallel servers',
      why:
        `The log does not record capacity. Estimated from the maximum number of ${a.name} ` +
        `executions observed running simultaneously (${a.maxConcurrency}). This is a LOWER BOUND: ` +
        'a station with spare capacity that was never all in use at once looks smaller than it is.',
      editable: true,
      activityId: a.id,
    });
    const fit = fitDistribution(a.serviceMeanMinutes, a.serviceCV);
    assumptions.push({
      id: `dist:${a.id}`,
      label: `${a.name} — service distribution`,
      value: fit.symbol,
      unit: 'Kendall symbol',
      why: fit.rationale,
      editable: true,
      activityId: a.id,
    });
  }
  assumptions.push({
    id: 'arrival-dist',
    label: 'Arrival process',
    value: interArrival.symbol,
    unit: 'Kendall symbol',
    why:
      `Fitted from the coefficient of variation of the ${interArrival.count} observed inter-arrival ` +
      `gaps (CV = ${interArrival.cv.toFixed(3)}). A CV near 1 indicates a Poisson arrival process.`,
    editable: true,
  });
  assumptions.push({
    id: 'queue-discipline',
    label: 'Queue discipline',
    value: 'FIFO',
    unit: 'discipline',
    why:
      'The log records when each activity ran but not the order cases were selected from the ' +
      'queue, so first-in-first-out is assumed. Change it if the real line prioritises differently.',
    editable: true,
  });

  /* ---- quality warnings ---- */

  if (traces.length < 30) {
    warnings.push(
      `Only ${traces.length} cases are in the log. Rates and distributions estimated from so few ` +
        'observations are imprecise — treat the discovered model as indicative until more data is available.',
    );
  }
  const singleEvent = traces.filter((t) => t.events.length === 1).length;
  if (singleEvent > 0) {
    warnings.push(
      `${singleEvent} case(s) contain only one event, so they contribute no routing information ` +
        'and no waiting time.',
    );
  }
  if (activities.some((a) => a.serviceMeanMinutes <= 0)) {
    warnings.push(
      'At least one activity has a zero-length duration in the log, which makes its service rate ' +
        'infinite. Check whether the export lost its completion timestamps.',
    );
  }
  const startsSpread = [...startCount.values()].length;
  if (startsSpread > 1) {
    warnings.push(
      `Cases begin at ${startsSpread} different activities. The most frequent one is used as the ` +
        'model entry point; the others are reachable only through routing, so some cases in the log ' +
        'may not be reproducible by the model.',
    );
  }
  if (traces.length > 0 && variants.length / traces.length > 0.8 && traces.length > 10) {
    warnings.push(
      `${variants.length} distinct path variants across ${traces.length} cases — the process is ` +
        'highly variable, so a single routing model is a coarse summary of it.',
    );
  }

  const startActivities = activities
    .filter((a) => a.startCount > 0)
    .map((a) => ({ id: a.id, name: a.name, count: a.startCount }))
    .sort((x, y) => y.count - x.count);
  const endActivities = activities
    .filter((a) => a.endCount > 0)
    .map((a) => ({ id: a.id, name: a.name, count: a.endCount }))
    .sort((x, y) => y.count - x.count);

  return {
    activities,
    edges,
    traces,
    variants,
    loops,
    interArrival,
    startActivities,
    endActivities,
    caseCount: traces.length,
    eventCount: log.rows.length,
    observationWindowMinutes,
    cycleTime,
    bottleneckActivityId,
    delayActivityId,
    assumptions,
    warnings,
  };
}

/** Mean service time implied by a fitted distribution — for display. */
export const fittedMean = (d: Distribution): number => distMean(d);


/**
 * Sort activities into process order: breadth-first depth from the start
 * activities along forward (non-loop-back) arcs, with unreachable activities
 * placed last and ties broken by how often the activity occurs.
 */
function orderActivitiesByFlow(
  activities: ActivityStats[],
  edges: DfgEdge[],
  startCount: Map<string, number>,
): void {
  const depth = new Map<string, number>();
  const frontier: string[] = [];

  for (const a of activities) {
    if ((startCount.get(a.name) ?? 0) > 0) {
      depth.set(a.id, 0);
      frontier.push(a.id);
    }
  }
  // A log where no activity ever starts a case cannot be walked; fall back to
  // the first activity so the ordering is still deterministic.
  if (frontier.length === 0 && activities[0]) {
    depth.set(activities[0].id, 0);
    frontier.push(activities[0].id);
  }

  const forward = edges.filter((e) => !e.isLoopBack && e.from !== e.to);
  while (frontier.length > 0) {
    const id = frontier.shift() as string;
    const d = depth.get(id) as number;
    for (const e of forward) {
      if (e.from !== id) continue;
      const existing = depth.get(e.to);
      if (existing === undefined || existing > d + 1) {
        depth.set(e.to, d + 1);
        frontier.push(e.to);
      }
    }
  }

  const maxDepth = Math.max(0, ...[...depth.values()]);
  activities.sort((a, b) => {
    const da = depth.get(a.id) ?? maxDepth + 1;
    const db = depth.get(b.id) ?? maxDepth + 1;
    return da === db ? b.executions - a.executions : da - db;
  });
}
