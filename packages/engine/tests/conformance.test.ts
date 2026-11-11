import { describe, expect, it } from 'vitest';
import { compareAlphaAlgorithms, runAlphaAlgorithm, runAlphaPlusAlgorithm } from '../src/discovery/alphaAlgorithms.js';
import { runInductiveMiner } from '../src/discovery/inductiveMiner.js';
import {
  causalFootprintConformance,
  compareConformance,
  compareThreeWayFootprints,
  computeFitnessDistribution,
  footprintFromDfg,
  replayTokenConformance,
  summarizeDeviations,
} from '../src/discovery/conformance.js';

const LINEAR = [
  ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
  ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
  ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
];

const REWORK = [
  ['Body Shop', 'Paint', 'Inspection', 'Dispatch'],
  ['Body Shop', 'Paint', 'Inspection', 'Rework', 'Inspection', 'Dispatch'],
  ['Body Shop', 'Paint', 'Inspection', 'Rework', 'Inspection', 'Rework', 'Inspection', 'Dispatch'],
];

const DEVIATING = [
  ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
  ['Body Shop', 'Assembly', 'Dispatch'], // skipped Paint
  ['Body Shop', 'Paint', 'Paint', 'Assembly', 'Dispatch'], // extra repeat
  ['Body Shop', 'Dispatch', 'Paint', 'Assembly'], // wrong order
];

const PARALLEL = [
  ['Start', 'Chassis', 'Wiring', 'End'],
  ['Start', 'Wiring', 'Chassis', 'End'],
  ['Start', 'Chassis', 'Wiring', 'End'],
  ['Start', 'Wiring', 'Chassis', 'End'],
];

const SELF_LOOP = [
  ['Prep', 'Polish', 'Polish', 'Done'],
  ['Prep', 'Polish', 'Done'],
  ['Prep', 'Polish', 'Polish', 'Polish', 'Done'],
];

describe('Process conformance (token replay)', () => {
  it('replays a linear log on Alpha with high fitness', () => {
    const { alpha } = compareAlphaAlgorithms(LINEAR);
    const token = replayTokenConformance(LINEAR, alpha.petriNet);
    expect(token.totalTraces).toBe(3);
    expect(token.fitness).toBeGreaterThan(0.85);
    expect(token.traces.every((t) => t.steps.length === 4)).toBe(true);
  });

  it('records per-step deviations on a log the model cannot follow', () => {
    const { alphaPlus } = compareAlphaAlgorithms(LINEAR);
    const token = replayTokenConformance(DEVIATING, alphaPlus.petriNet);
    expect(token.fitness).toBeLessThan(1);
    const skipped = token.traces[1]!;
    expect(skipped.perfectlyFitting).toBe(false);
    expect(skipped.steps.some((s) => s.status !== 'ok')).toBe(true);
  });

  it('correctly handles valid traces with 100% fitting tokens on Inductive Miner', () => {
    const inductive = runInductiveMiner(LINEAR);
    const token = replayTokenConformance(LINEAR, inductive.petriNet);
    expect(token.totalTraces).toBe(3);
    expect(token.fitness).toBeCloseTo(1.0, 1);
    expect(token.missing).toBe(0);
    expect(token.remaining).toBe(0);
    expect(token.fittingTraces).toBe(3);
  });

  it('identifies unmodeled activities as not_in_model status', () => {
    const { alpha } = compareAlphaAlgorithms(LINEAR);
    const foreignTrace = [['Body Shop', 'Unknown Station', 'Dispatch']];
    const token = replayTokenConformance(foreignTrace, alpha.petriNet);
    const unkStep = token.traces[0]!.steps.find((s) => s.activity === 'Unknown Station');
    expect(unkStep).toBeDefined();
    expect(unkStep!.status).toBe('not_in_model');
    expect(token.missing).toBeGreaterThan(0);
  });

  it('handles length-1 self-loops in Alpha Plus without crashing', () => {
    const alphaPlus = runAlphaPlusAlgorithm(SELF_LOOP);
    const token = replayTokenConformance(SELF_LOOP, alphaPlus.petriNet);
    expect(token.totalTraces).toBe(3);
    expect(token.traces.length).toBe(3);
    // Token replay produces valid steps for repeated activity
    const repeated = token.traces[0]!;
    const polishSteps = repeated.steps.filter((s) => s.activity === 'Polish');
    expect(polishSteps.length).toBe(2);
  });

  it('handles length-2 rework loops and evaluates loop iterations', () => {
    const inductive = runInductiveMiner(REWORK);
    const token = replayTokenConformance(REWORK, inductive.petriNet);
    expect(token.totalTraces).toBe(3);
    expect(token.fitness).toBeGreaterThan(0.7);
    // Case 2 has 2 rework cycles: Inspection, Rework, Inspection, Rework, Inspection
    const multiLoop = token.traces[2]!;
    expect(multiLoop.activities.length).toBe(8);
  });

  it('handles parallel activities with concurrent interleaving', () => {
    const inductive = runInductiveMiner(PARALLEL);
    const token = replayTokenConformance(PARALLEL, inductive.petriNet);
    expect(token.totalTraces).toBe(4);
    expect(token.fitness).toBeGreaterThan(0.85);
  });

  it('computes deviation summaries with activity ranking', () => {
    const { alpha } = compareAlphaAlgorithms(LINEAR);
    const token = replayTokenConformance(DEVIATING, alpha.petriNet);
    const summary = summarizeDeviations(token);

    expect(summary.frequentActivities.length).toBeGreaterThan(0);
    expect(summary.totalDeviations).toBeGreaterThan(0);
    expect(summary.totalMissingTokens).toBe(token.missing);
    expect(summary.totalRemainingTokens).toBe(token.remaining);
    expect(summary.perfectTracesCount).toBe(token.fittingTraces);
    expect(summary.imperfectTracesCount).toBe(token.totalTraces - token.fittingTraces);
  });

  it('computes trace fitness distributions across standard bins', () => {
    const { alpha } = compareAlphaAlgorithms(LINEAR);
    const token = replayTokenConformance(DEVIATING, alpha.petriNet);
    const bins = computeFitnessDistribution(token.traces);

    expect(bins).toHaveLength(5);
    const sumCount = bins.reduce((sum, b) => sum + b.count, 0);
    expect(sumCount).toBe(token.traces.length);
    const sumPct = bins.reduce((sum, b) => sum + b.percentage, 0);
    expect(sumPct).toBeCloseTo(1.0, 3);
  });

  it('handles empty trace log gracefully', () => {
    const { alpha } = compareAlphaAlgorithms(LINEAR);
    const emptyResult = replayTokenConformance([], alpha.petriNet);
    expect(emptyResult.fitness).toBe(1);
    expect(emptyResult.totalTraces).toBe(0);
    expect(emptyResult.produced).toBe(0);
    expect(emptyResult.consumed).toBe(0);
    expect(emptyResult.traces).toHaveLength(0);
  });
});

describe('Causal footprint conformance', () => {
  it('scores a linear log against its own Alpha net near 1', () => {
    const { alpha } = compareAlphaAlgorithms(LINEAR);
    const acts = ['Assembly', 'Body Shop', 'Dispatch', 'Paint'];
    const fp = causalFootprintConformance(LINEAR, alpha.petriNet, acts);
    expect(fp.method).toBe('causal_footprint');
    expect(fp.similarity).toBeGreaterThan(0.5);
    expect(fp.logFootprint.relations['Body Shop']!['Paint']).toBe('->');
  });

  it('classifies log-only vs model-only relation mismatches', () => {
    const matrix = footprintFromDfg(
      ['A', 'B'],
      {
        A: { A: 0, B: 2 },
        B: { A: 0, B: 0 },
      },
    );
    expect(matrix.relations['A']!['B']).toBe('->');
    expect(matrix.relations['B']!['A']).toBe('<-');
    expect(matrix.relations['A']!['A']).toBe('#');
  });

  it('flags footprint differences when the log skips a station', () => {
    const { alphaPlus } = compareAlphaAlgorithms(LINEAR);
    const acts = ['Assembly', 'Body Shop', 'Dispatch', 'Paint'];
    const fp = causalFootprintConformance(DEVIATING, alphaPlus.petriNet, acts);
    expect(fp.mismatches).toBeGreaterThan(0);
    expect(fp.diffs.some((d) => d.kind !== 'match')).toBe(true);
  });

  it('compares footprints across all 3 algorithms with 3-way matrix', () => {
    const { alpha, alphaPlus } = compareAlphaAlgorithms(REWORK);
    const inductive = runInductiveMiner(REWORK);
    const acts = ['Body Shop', 'Dispatch', 'Inspection', 'Paint', 'Rework'];

    const fpLog = footprintFromDfg(acts, {
      'Body Shop': { 'Body Shop': 0, Paint: 3, Inspection: 0, Rework: 0, Dispatch: 0 },
      Paint: { 'Body Shop': 0, Paint: 0, Inspection: 3, Rework: 0, Dispatch: 0 },
      Inspection: { 'Body Shop': 0, Paint: 0, Inspection: 0, Rework: 3, Dispatch: 3 },
      Rework: { 'Body Shop': 0, Paint: 0, Inspection: 3, Rework: 0, Dispatch: 0 },
      Dispatch: { 'Body Shop': 0, Paint: 0, Inspection: 0, Rework: 0, Dispatch: 0 },
    });

    const fpAlpha = causalFootprintConformance(REWORK, alpha.petriNet, acts).modelFootprint;
    const fpAlphaPlus = causalFootprintConformance(REWORK, alphaPlus.petriNet, acts).modelFootprint;
    const fpInductive = causalFootprintConformance(REWORK, inductive.petriNet, acts).modelFootprint;

    const cmp = compareThreeWayFootprints(acts, fpLog, fpAlpha, fpAlphaPlus, fpInductive);

    expect(cmp.activities).toEqual(acts);
    expect(cmp.cells).toHaveLength(acts.length * acts.length);
    expect(cmp.summary.totalPairs).toBe(acts.length * acts.length);
    expect(cmp.summary.alphaSimilarity).toBeGreaterThanOrEqual(0);
    expect(cmp.summary.alphaPlusSimilarity).toBeGreaterThanOrEqual(0);
    expect(cmp.summary.inductiveSimilarity).toBeGreaterThanOrEqual(0);
  });
});

describe('Three-way conformance comparison', () => {
  it('compares Alpha, Alpha+ and Inductive Miner on the same rework log', () => {
    const { alpha, alphaPlus } = compareAlphaAlgorithms(REWORK);
    const inductive = runInductiveMiner(REWORK);
    const result = compareConformance(REWORK, alpha, alphaPlus, inductive);

    expect(result.profiles).toHaveLength(3);
    expect(result.profiles.map((p) => p.algorithmId)).toEqual([
      'alpha',
      'alpha_plus',
      'inductive_miner',
    ]);
    expect(result.traceCount).toBe(3);
    expect(result.activities.length).toBeGreaterThan(3);

    for (const p of result.profiles) {
      expect(p.token.fitness).toBeGreaterThanOrEqual(0);
      expect(p.token.fitness).toBeLessThanOrEqual(1);
      expect(p.footprint.similarity).toBeGreaterThanOrEqual(0);
      expect(p.footprint.similarity).toBeLessThanOrEqual(1);
      expect(p.overlay.length).toBeGreaterThan(0);
      expect(p.overlay.some((e) => e.kind === 'both' || e.kind === 'log_only' || e.kind === 'model_only')).toBe(
        true,
      );
      expect(p.deviations).toBeDefined();
      expect(p.fitnessDistribution).toHaveLength(5);
      expect(p.complexity.places).toBeGreaterThan(0);
      expect(p.complexity.transitions).toBeGreaterThan(0);
    }

    expect(result.footprint3Way).toBeDefined();
    expect(result.footprint3Way.cells.length).toBeGreaterThan(0);
    expect(result.evaluation).toBeDefined();
    expect(result.evaluation!.profiles).toHaveLength(3);
  });

  it('marks log-only overlay edges for a skip deviation', () => {
    const { alpha, alphaPlus } = compareAlphaAlgorithms(LINEAR);
    const inductive = runInductiveMiner(LINEAR);
    const result = compareConformance(DEVIATING, alpha, alphaPlus, inductive);
    const overlay = result.profiles[1]!.overlay;
    expect(overlay.some((e) => e.kind === 'log_only')).toBe(true);
  });

  it('handles empty trace list in compareConformance', () => {
    const { alpha, alphaPlus } = compareAlphaAlgorithms(LINEAR);
    const inductive = runInductiveMiner(LINEAR);
    const result = compareConformance([], alpha, alphaPlus, inductive);

    expect(result.traceCount).toBe(0);
    expect(result.warnings).toContain('No traces to check.');
    expect(result.profiles).toHaveLength(3);
  });
});
