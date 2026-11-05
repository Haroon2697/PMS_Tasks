import { describe, expect, it } from 'vitest';
import { compareAlphaAlgorithms } from '../src/discovery/alphaAlgorithms.js';
import { runInductiveMiner } from '../src/discovery/inductiveMiner.js';
import {
  causalFootprintConformance,
  compareConformance,
  footprintFromDfg,
  replayTokenConformance,
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
    }
  });

  it('marks log-only overlay edges for a skip deviation', () => {
    const { alpha, alphaPlus } = compareAlphaAlgorithms(LINEAR);
    const inductive = runInductiveMiner(LINEAR);
    const result = compareConformance(DEVIATING, alpha, alphaPlus, inductive);
    const overlay = result.profiles[1]!.overlay;
    expect(overlay.some((e) => e.kind === 'log_only')).toBe(true);
  });
});
