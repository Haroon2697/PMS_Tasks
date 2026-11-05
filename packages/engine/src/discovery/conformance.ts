/**
 * Process Conformance Checking — token replay and causal-footprint comparison.
 *
 * Two complementary techniques from van der Aalst's process-mining book:
 *
 *  1. Token-based replay (process conformance)
 *     Replay each log trace on the discovered Petri net. Missing tokens are
 *     log moves the model cannot make; remaining tokens are leftover marking.
 *     Fitness  f = 0.5·(1 − m/c) + 0.5·(1 − r/p)
 *
 *  2. Causal-footprint conformance
 *     Build the log footprint (Alpha-style ordering relations from directly-
 *     follows) and the model footprint (the same relations, but from the Petri
 *     net's visible-activity directly-follows graph after collapsing silent
 *     transitions). Hamming similarity of the two matrices is the footprint
 *     score; mismatches are classified as fitness defects (in log, not model)
 *     or precision defects (in model, not log).
 *
 * The public API also returns overlay-graph edges so the UI can draw log vs
 * process on the same canvas: both / log-only / model-only.
 */

import type { PetriNet, PetriTransition, OrderingRelation, FootprintMatrix } from './alphaAlgorithms.js';
import type { AlphaResult } from './alphaAlgorithms.js';
import type { InductiveMinerResult } from './inductiveMiner.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ConformanceAlgorithmId = 'alpha' | 'alpha_plus' | 'inductive_miner';

export type OverlayEdgeKind = 'both' | 'log_only' | 'model_only';

export interface OverlayEdge {
  from: string;
  to: string;
  logCount: number;
  modelPresent: boolean;
  kind: OverlayEdgeKind;
}

export interface ReplayStep {
  index: number;
  activity: string;
  status: 'ok' | 'missing' | 'not_in_model';
  silentFirings: string[];
  missingInputs: number;
}

export interface TraceReplay {
  caseIndex: number;
  variant: string;
  activities: string[];
  perfectlyFitting: boolean;
  produced: number;
  consumed: number;
  missing: number;
  remaining: number;
  fitness: number;
  steps: ReplayStep[];
}

export interface TokenConformance {
  method: 'token_replay';
  fitness: number;
  produced: number;
  consumed: number;
  missing: number;
  remaining: number;
  fittingTraces: number;
  totalTraces: number;
  traces: TraceReplay[];
}

export interface FootprintCellDiff {
  a: string;
  b: string;
  logRelation: OrderingRelation;
  modelRelation: OrderingRelation;
  /** fitness = log has a causal/parallel relation the model does not; precision = reverse */
  kind: 'match' | 'fitness_defect' | 'precision_defect' | 'conflict';
}

export interface CausalFootprintConformance {
  method: 'causal_footprint';
  /** 1 − Hamming(log, model) / n² */
  similarity: number;
  fitness: number;
  precision: number;
  comparedCells: number;
  mismatches: number;
  logFootprint: FootprintMatrix;
  modelFootprint: FootprintMatrix;
  diffs: FootprintCellDiff[];
}

export interface ConformanceProfile {
  algorithmId: ConformanceAlgorithmId;
  algorithmName: string;
  token: TokenConformance;
  footprint: CausalFootprintConformance;
  overlay: OverlayEdge[];
  activities: string[];
  isSound: boolean;
}

export interface ConformanceComparison {
  profiles: ConformanceProfile[];
  logDfg: Record<string, Record<string, number>>;
  activities: string[];
  traceCount: number;
  variantCount: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'act';
}

function isSilentTransition(t: PetriTransition): boolean {
  const label = t.label.trim();
  const name = t.name.trim().toLowerCase();
  if (label === 'τ' || label.startsWith('τ') || label.startsWith('∧')) return true;
  if (name === 'tau' || name.startsWith('par_') || name.startsWith('loop_')) return true;
  return false;
}

function variantKey(trace: string[]): string {
  return trace.join(' → ');
}

function uniqueActivities(traces: string[][]): string[] {
  const set = new Set<string>();
  for (const t of traces) for (const a of t) set.add(a);
  return [...set].sort();
}

function emptyMatrix(activities: string[]): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const a of activities) {
    m[a] = {};
    for (const b of activities) m[a]![b] = 0;
  }
  return m;
}

export function buildLogDfg(traces: string[][], activities: string[]): Record<string, Record<string, number>> {
  const counts = emptyMatrix(activities);
  for (const seq of traces) {
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i]!;
      const b = seq[i + 1]!;
      if (counts[a] && counts[a]![b] !== undefined) counts[a]![b]!++;
    }
  }
  return counts;
}

export function footprintFromDfg(
  activities: string[],
  succession: Record<string, Record<string, number>>,
): FootprintMatrix {
  const relations: Record<string, Record<string, OrderingRelation>> = {};
  for (const a of activities) {
    relations[a] = {};
    for (const b of activities) {
      const ab = succession[a]?.[b] ?? 0;
      const ba = succession[b]?.[a] ?? 0;
      if (a === b) {
        relations[a]![b] = ab > 0 ? 'L1L' : '#';
      } else if (ab > 0 && ba === 0) {
        relations[a]![b] = '->';
      } else if (ab === 0 && ba > 0) {
        relations[a]![b] = '<-';
      } else if (ab > 0 && ba > 0) {
        relations[a]![b] = '||';
      } else {
        relations[a]![b] = '#';
      }
    }
  }
  return { activities, relations, successionCounts: succession };
}

function classifyDiff(logRel: OrderingRelation, modelRel: OrderingRelation): FootprintCellDiff['kind'] {
  if (logRel === modelRel) return 'match';
  const logActive = logRel !== '#';
  const modelActive = modelRel !== '#';
  if (logActive && !modelActive) return 'fitness_defect';
  if (!logActive && modelActive) return 'precision_defect';
  return 'conflict';
}

/* ------------------------------------------------------------------ */
/* Model DFG from Petri net (visible activities, silent collapsed)     */
/* ------------------------------------------------------------------ */

function transitionGraph(net: PetriNet): Map<string, Set<string>> {
  const outgoing = new Map<string, Set<string>>();
  const placeInputs = new Map<string, string[]>();
  const placeOutputs = new Map<string, string[]>();

  for (const arc of net.arcs) {
    if (arc.kind === 't2p') {
      const list = placeInputs.get(arc.to) ?? [];
      list.push(arc.from);
      placeInputs.set(arc.to, list);
    } else {
      const list = placeOutputs.get(arc.from) ?? [];
      list.push(arc.to);
      placeOutputs.set(arc.from, list);
    }
  }

  for (const place of net.places) {
    const preds = placeInputs.get(place.id) ?? place.inputTransitions;
    const succs = placeOutputs.get(place.id) ?? place.outputTransitions;
    for (const p of preds) {
      if (!outgoing.has(p)) outgoing.set(p, new Set());
      for (const s of succs) outgoing.get(p)!.add(s);
    }
  }
  return outgoing;
}

export function modelVisibleDfg(net: PetriNet, activities: string[]): Record<string, Record<string, number>> {
  const counts = emptyMatrix(activities);
  const byId = new Map(net.transitions.map((t) => [t.id, t]));
  const graph = transitionGraph(net);

  const visibleIds = net.transitions.filter((t) => !isSilentTransition(t)).map((t) => t.id);

  const resolveLabel = (t: PetriTransition): string | null => {
    if (activities.includes(t.label)) return t.label;
    if (activities.includes(t.name)) return t.name;
    const slugHit = activities.find((a) => `t_${slug(a)}` === t.id);
    return slugHit ?? null;
  };

  for (const startId of visibleIds) {
    const start = byId.get(startId);
    if (!start) continue;
    const fromLabel = resolveLabel(start);
    if (!fromLabel || !counts[fromLabel]) continue;

    const seen = new Set<string>([startId]);
    const queue = [...(graph.get(startId) ?? [])];
    while (queue.length) {
      const nextId = queue.shift()!;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      const next = byId.get(nextId);
      if (!next) continue;
      if (isSilentTransition(next)) {
        for (const hop of graph.get(nextId) ?? []) queue.push(hop);
        continue;
      }
      const toLabel = resolveLabel(next);
      if (toLabel && counts[fromLabel]![toLabel] !== undefined) {
        counts[fromLabel]![toLabel]! += 1;
      }
    }
  }

  return counts;
}

/* ------------------------------------------------------------------ */
/* Token replay                                                        */
/* ------------------------------------------------------------------ */

function buildNetIndex(net: PetriNet) {
  const transitionsByName = new Map<string, PetriTransition>();
  for (const t of net.transitions) {
    transitionsByName.set(t.label.toLowerCase(), t);
    transitionsByName.set(t.name.toLowerCase(), t);
    transitionsByName.set(t.id.toLowerCase(), t);
  }

  const inputArcs = new Map<string, string[]>();
  const outputArcs = new Map<string, string[]>();
  for (const arc of net.arcs) {
    if (arc.kind === 'p2t') {
      const list = inputArcs.get(arc.to) ?? [];
      list.push(arc.from);
      inputArcs.set(arc.to, list);
    } else {
      const list = outputArcs.get(arc.from) ?? [];
      list.push(arc.to);
      outputArcs.set(arc.from, list);
    }
  }

  const startPlaces = net.places.filter((p) => p.kind === 'start').map((p) => p.id);
  const endPlaces = new Set(net.places.filter((p) => p.kind === 'end').map((p) => p.id));
  const silent = net.transitions.filter(isSilentTransition);

  return { transitionsByName, inputArcs, outputArcs, startPlaces, endPlaces, silent };
}

function enabled(tId: string, marking: Map<string, number>, inputArcs: Map<string, string[]>): boolean {
  const inputs = inputArcs.get(tId) ?? [];
  if (inputs.length === 0) return false;
  return inputs.every((p) => (marking.get(p) ?? 0) > 0);
}

function fire(tId: string, marking: Map<string, number>, inputArcs: Map<string, string[]>, outputArcs: Map<string, string[]>) {
  for (const p of inputArcs.get(tId) ?? []) {
    marking.set(p, (marking.get(p) ?? 0) - 1);
  }
  for (const p of outputArcs.get(tId) ?? []) {
    marking.set(p, (marking.get(p) ?? 0) + 1);
  }
}

function fireSilentGreedy(
  marking: Map<string, number>,
  silent: PetriTransition[],
  inputArcs: Map<string, string[]>,
  outputArcs: Map<string, string[]>,
  maxSteps = 24,
): string[] {
  const fired: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const next = silent.find((t) => enabled(t.id, marking, inputArcs));
    if (!next) break;
    fire(next.id, marking, inputArcs, outputArcs);
    fired.push(next.label || next.name);
  }
  return fired;
}

export function replayTokenConformance(traces: string[][], net: PetriNet): TokenConformance {
  const idx = buildNetIndex(net);
  const tracesOut: TraceReplay[] = [];

  let produced = 0;
  let consumed = 0;
  let missing = 0;
  let remaining = 0;
  let fittingTraces = 0;

  for (let caseIndex = 0; caseIndex < traces.length; caseIndex++) {
    const activities = traces[caseIndex]!;
    const marking = new Map<string, number>();
    let tProduced = 0;
    let tConsumed = 0;
    let tMissing = 0;
    const steps: ReplayStep[] = [];

    for (const sp of idx.startPlaces) {
      marking.set(sp, (marking.get(sp) ?? 0) + 1);
      tProduced++;
    }

    for (let i = 0; i < activities.length; i++) {
      const activity = activities[i]!;
      const silentBefore = fireSilentGreedy(marking, idx.silent, idx.inputArcs, idx.outputArcs);
      tProduced += silentBefore.length;
      tConsumed += silentBefore.length;

      const t =
        idx.transitionsByName.get(activity.toLowerCase()) ??
        idx.transitionsByName.get(`t_${slug(activity)}`);

      if (!t || isSilentTransition(t)) {
        tMissing++;
        tConsumed++;
        steps.push({
          index: i,
          activity,
          status: 'not_in_model',
          silentFirings: silentBefore,
          missingInputs: 1,
        });
        continue;
      }

      const inputs = idx.inputArcs.get(t.id) ?? [];
      let missingInputs = 0;
      for (const p of inputs) {
        const tokens = marking.get(p) ?? 0;
        if (tokens > 0) {
          marking.set(p, tokens - 1);
          tConsumed++;
        } else {
          missingInputs++;
          tMissing++;
          tConsumed++;
        }
      }
      for (const p of idx.outputArcs.get(t.id) ?? []) {
        marking.set(p, (marking.get(p) ?? 0) + 1);
        tProduced++;
      }

      steps.push({
        index: i,
        activity,
        status: missingInputs > 0 ? 'missing' : 'ok',
        silentFirings: silentBefore,
        missingInputs,
      });
    }

    fireSilentGreedy(marking, idx.silent, idx.inputArcs, idx.outputArcs);

    let tRemaining = 0;
    for (const [placeId, tokens] of marking) {
      if (idx.endPlaces.has(placeId)) {
        if (tokens > 1) tRemaining += tokens - 1;
        else if (tokens === 0) {
          tMissing++;
          tConsumed++;
        }
      } else if (tokens > 0) {
        tRemaining += tokens;
      }
    }

    const consumedPart = tConsumed > 0 ? 1 - tMissing / tConsumed : 1;
    const producedPart = tProduced > 0 ? 1 - tRemaining / tProduced : 1;
    const fitness = Math.max(0, Math.min(1, 0.5 * consumedPart + 0.5 * producedPart));
    const perfectlyFitting = tMissing === 0 && tRemaining === 0;

    if (perfectlyFitting) fittingTraces++;

    produced += tProduced;
    consumed += tConsumed;
    missing += tMissing;
    remaining += tRemaining;

    tracesOut.push({
      caseIndex,
      variant: variantKey(activities),
      activities,
      perfectlyFitting,
      produced: tProduced,
      consumed: tConsumed,
      missing: tMissing,
      remaining: tRemaining,
      fitness,
      steps,
    });
  }

  const consumedPart = consumed > 0 ? 1 - missing / consumed : 1;
  const producedPart = produced > 0 ? 1 - remaining / produced : 1;
  const fitness = Math.max(0, Math.min(1, 0.5 * consumedPart + 0.5 * producedPart));

  return {
    method: 'token_replay',
    fitness,
    produced,
    consumed,
    missing,
    remaining,
    fittingTraces,
    totalTraces: traces.length,
    traces: tracesOut,
  };
}

/* ------------------------------------------------------------------ */
/* Causal footprint                                                    */
/* ------------------------------------------------------------------ */

export function causalFootprintConformance(
  traces: string[][],
  net: PetriNet,
  activities: string[],
): CausalFootprintConformance {
  const logDfg = buildLogDfg(traces, activities);
  const modelDfg = modelVisibleDfg(net, activities);
  const logFootprint = footprintFromDfg(activities, logDfg);
  const modelFootprint = footprintFromDfg(activities, modelDfg);

  const diffs: FootprintCellDiff[] = [];
  let mismatches = 0;
  let fitnessDenom = 0;
  let fitnessNum = 0;
  let precisionDenom = 0;
  let precisionNum = 0;

  for (const a of activities) {
    for (const b of activities) {
      const logRelation = logFootprint.relations[a]?.[b] ?? '#';
      const modelRelation = modelFootprint.relations[a]?.[b] ?? '#';
      const kind = classifyDiff(logRelation, modelRelation);
      if (kind !== 'match') {
        mismatches++;
        diffs.push({ a, b, logRelation, modelRelation, kind });
      }
      if (logRelation !== '#') {
        fitnessDenom++;
        if (logRelation === modelRelation) fitnessNum++;
      }
      if (modelRelation !== '#') {
        precisionDenom++;
        if (logRelation === modelRelation) precisionNum++;
      }
    }
  }

  const comparedCells = activities.length * activities.length;
  const similarity = comparedCells > 0 ? 1 - mismatches / comparedCells : 1;
  const fitness = fitnessDenom > 0 ? fitnessNum / fitnessDenom : 1;
  const precision = precisionDenom > 0 ? precisionNum / precisionDenom : 1;

  diffs.sort((x, y) => {
    const order = { fitness_defect: 0, conflict: 1, precision_defect: 2, match: 3 };
    return order[x.kind] - order[y.kind] || x.a.localeCompare(y.a) || x.b.localeCompare(y.b);
  });

  return {
    method: 'causal_footprint',
    similarity,
    fitness,
    precision,
    comparedCells,
    mismatches,
    logFootprint,
    modelFootprint,
    diffs,
  };
}

export function buildOverlay(
  logDfg: Record<string, Record<string, number>>,
  modelDfg: Record<string, Record<string, number>>,
  activities: string[],
): OverlayEdge[] {
  const edges: OverlayEdge[] = [];
  for (const a of activities) {
    for (const b of activities) {
      const logCount = logDfg[a]?.[b] ?? 0;
      const modelPresent = (modelDfg[a]?.[b] ?? 0) > 0;
      if (logCount === 0 && !modelPresent) continue;
      const kind: OverlayEdgeKind =
        logCount > 0 && modelPresent ? 'both' : logCount > 0 ? 'log_only' : 'model_only';
      edges.push({ from: a, to: b, logCount, modelPresent, kind });
    }
  }
  return edges.sort((x, y) => y.logCount - x.logCount || x.from.localeCompare(y.from));
}

function profileFor(
  algorithmId: ConformanceAlgorithmId,
  algorithmName: string,
  traces: string[][],
  net: PetriNet,
  activities: string[],
  isSound: boolean,
): ConformanceProfile {
  const token = replayTokenConformance(traces, net);
  const footprint = causalFootprintConformance(traces, net, activities);
  const overlay = buildOverlay(footprint.logFootprint.successionCounts, footprint.modelFootprint.successionCounts, activities);
  return { algorithmId, algorithmName, token, footprint, overlay, activities, isSound };
}

/**
 * Compare Alpha, Alpha+ and Inductive Miner against the same event log using
 * token replay and causal-footprint conformance.
 */
export function compareConformance(
  traces: string[][],
  alpha: AlphaResult,
  alphaPlus: AlphaResult,
  inductive: InductiveMinerResult,
): ConformanceComparison {
  const activities = uniqueActivities(traces);
  const warnings: string[] = [];
  const variantCount = new Set(traces.map(variantKey)).size;

  if (traces.length === 0) {
    warnings.push('No traces to check.');
  }
  if (traces.length < 5) {
    warnings.push(`Only ${traces.length} traces — fitness is exact for this sample, not a population estimate.`);
  }

  const logDfg = buildLogDfg(traces, activities);

  const profiles = [
    profileFor('alpha', 'Alpha (α)', traces, alpha.petriNet, activities, alpha.petriNet.isSound),
    profileFor('alpha_plus', 'Alpha Plus (α⁺)', traces, alphaPlus.petriNet, activities, alphaPlus.petriNet.isSound),
    profileFor('inductive_miner', 'Inductive Miner (IM)', traces, inductive.petriNet, activities, inductive.petriNet.isSound),
  ];

  return {
    profiles,
    logDfg,
    activities,
    traceCount: traces.length,
    variantCount,
    warnings,
  };
}
