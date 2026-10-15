import { describe, expect, it } from 'vitest';
import {
  runAlphaAlgorithm,
  runAlphaPlusAlgorithm,
  compareAlphaAlgorithms,
} from '../src/discovery/alphaAlgorithms.js';

describe('Alpha and Alpha Plus Algorithms', () => {
  it('correctly discovers a simple linear workflow without loops', () => {
    const traces = [
      ['A', 'B', 'C', 'D'],
      ['A', 'B', 'C', 'D'],
    ];

    const alpha = runAlphaAlgorithm(traces);
    const alphaPlus = runAlphaPlusAlgorithm(traces);

    expect(alpha.activities).toEqual(['A', 'B', 'C', 'D']);
    expect(alpha.startActivities).toEqual(['A']);
    expect(alpha.endActivities).toEqual(['D']);

    // A -> B -> C -> D
    expect(alpha.footprint.relations['A']!['B']).toBe('->');
    expect(alpha.footprint.relations['B']!['C']).toBe('->');
    expect(alpha.footprint.relations['C']!['D']).toBe('->');
    expect(alpha.footprint.relations['A']!['D']).toBe('#');

    // Both should match on linear log
    expect(alphaPlus.footprint.relations['A']!['B']).toBe('->');
    expect(alphaPlus.footprint.relations['B']!['C']).toBe('->');
    expect(alphaPlus.footprint.relations['C']!['D']).toBe('->');
  });

  it('demonstrates Alpha flaw on Length-2 rework loop vs Alpha Plus fix', () => {
    // Classic automotive rework pattern:
    // Inspection -> Rework -> Inspection
    const traces = [
      ['BodyShop', 'Paint', 'Inspection', 'Assembly', 'Dispatch'],
      ['BodyShop', 'Paint', 'Inspection', 'Rework', 'Inspection', 'Assembly', 'Dispatch'],
    ];

    const alpha = runAlphaAlgorithm(traces);
    const alphaPlus = runAlphaPlusAlgorithm(traces);

    // In Alpha: Inspection > Rework and Rework > Inspection both hold!
    // Therefore Alpha incorrectly classifies Inspection || Rework (PARALLELISM)!
    expect(alpha.footprint.relations['Inspection']!['Rework']).toBe('||');
    expect(alpha.footprint.relations['Rework']!['Inspection']).toBe('||');
    expect(alpha.diagnostics.hasShortLoopFlaw).toBe(true);
    expect(alpha.petriNet.isSound).toBe(false);

    // In Alpha Plus: Length-2 loop is identified and resolved
    expect(alphaPlus.length2Loops.length).toBeGreaterThan(0);
    expect(alphaPlus.footprint.relations['Inspection']!['Rework']).toBe('L2L');
    expect(alphaPlus.footprint.relations['Rework']!['Inspection']).toBe('L2L');
    expect(alphaPlus.diagnostics.hasShortLoopFlaw).toBe(false);
    expect(alphaPlus.petriNet.isSound).toBe(true);

    // Check Petri Net places in Alpha Plus has rework loop places
    const loopPlaces = alphaPlus.petriNet.places.filter((p) => p.kind === 'loop2');
    expect(loopPlaces.length).toBeGreaterThan(0);
  });

  it('demonstrates Alpha flaw on Length-1 self-loops vs Alpha Plus fix', () => {
    const traces = [
      ['A', 'B', 'B', 'C'],
      ['A', 'B', 'C'],
    ];

    const alpha = runAlphaAlgorithm(traces);
    const alphaPlus = runAlphaPlusAlgorithm(traces);

    expect(alpha.length1Loops).toContain('B');
    expect(alpha.diagnostics.hasShortLoopFlaw).toBe(true);

    expect(alphaPlus.length1Loops).toContain('B');
    const selfLoopPlaces = alphaPlus.petriNet.places.filter((p) => p.kind === 'loop1');
    expect(selfLoopPlaces.length).toBe(1);
    expect(selfLoopPlaces[0]?.label).toContain('p_self(B)');
  });

  it('produces a detailed side-by-side comparison report', () => {
    const traces = [
      ['BodyShop', 'Paint', 'Inspection', 'Assembly'],
      ['BodyShop', 'Paint', 'Inspection', 'Rework', 'Inspection', 'Assembly'],
    ];

    const comparison = compareAlphaAlgorithms(traces);

    expect(comparison.differences.length).toBeGreaterThan(0);
    const relationDiff = comparison.differences.find((d) => d.type === 'relation');
    expect(relationDiff).toBeDefined();
    expect(relationDiff?.alphaValue).toBe('||');
    expect(relationDiff?.alphaPlusValue).toBe('L2L');

    expect(comparison.cycleTimeComparison.alphaAssumedMode).toContain('Parallel');
    expect(comparison.summary.verdict).toContain('Alpha Plus is strictly superior');
  });
});
