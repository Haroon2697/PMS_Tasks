import { describe, expect, it } from 'vitest';
import {
  runInductiveMiner,
  discoverProcessTree,
  formatProcessTree,
  processTreeToPetriNet,
} from '../src/discovery/inductiveMiner.js';

describe('Task 10: Inductive Miner Algorithm', () => {
  it('discovers a strict sequence cut (->) on linear workflows', () => {
    const traces = [
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
    ];

    const result = runInductiveMiner(traces);

    expect(result.tree.type).toBe('operator');
    expect(result.tree.operator).toBe('->');
    expect(result.tree.children.length).toBe(4);
    expect(result.tree.children.map((c) => c.label)).toEqual([
      'Body Shop',
      'Paint',
      'Assembly',
      'Dispatch',
    ]);
    expect(result.treeString).toBe(
      "→( 'Body Shop', 'Paint', 'Assembly', 'Dispatch' )",
    );
    expect(result.metrics.isSound).toBe(true);
    expect(result.metrics.operatorCounts['->']).toBe(1);
  });

  it('discovers an exclusive choice cut (x) between disconnected process variants', () => {
    const traces = [
      ['Sedan Order', 'Sedan Assembly', 'Sedan Delivery'],
      ['Sedan Order', 'Sedan Assembly', 'Sedan Delivery'],
      ['Truck Order', 'Truck Assembly', 'Truck Delivery'],
      ['Truck Order', 'Truck Assembly', 'Truck Delivery'],
    ];

    const result = runInductiveMiner(traces);

    expect(result.tree.type).toBe('operator');
    expect(result.tree.operator).toBe('x');
    expect(result.tree.children.length).toBe(2);

    // Each branch is a sequence
    expect(result.tree.children.every((c) => c.operator === '->')).toBe(true);
    expect(result.metrics.isSound).toBe(true);
    expect(result.discoveryLog.some((e) => e.ruleApplied.name.includes('Choice'))).toBe(true);
  });

  it('discovers true concurrency with parallel cut (^)', () => {
    const traces = [
      ['Chassis', 'Electronics'],
      ['Electronics', 'Chassis'],
    ];

    const result = runInductiveMiner(traces);

    expect(result.tree.type).toBe('operator');
    expect(result.tree.operator).toBe('^');
    expect(result.tree.children.map((c) => c.label).sort()).toEqual(['Chassis', 'Electronics']);
    expect(result.treeString).toContain('∧(');
    expect(result.metrics.isSound).toBe(true);
  });

  it('discovers nested sequence containing a parallel block', () => {
    const traces = [
      ['Start', 'TaskA', 'TaskB', 'End'],
      ['Start', 'TaskB', 'TaskA', 'End'],
    ];

    const result = runInductiveMiner(traces);

    expect(result.tree.type).toBe('operator');
    expect(result.tree.operator).toBe('->');
    // Start -> (TaskA ^ TaskB) -> End
    expect(result.tree.children[0]?.label).toBe('Start');
    expect(result.tree.children[result.tree.children.length - 1]?.label).toBe('End');

    const parChild = result.tree.children.find((c) => c.operator === '^');
    expect(parChild).toBeDefined();
    expect(parChild?.children.map((c) => c.label).sort()).toEqual(['TaskA', 'TaskB']);
  });

  it('discovers loop cuts (⟳) on rework cycles', () => {
    const traces = [
      ['Inspection', 'Approval'],
      ['Inspection', 'Rework', 'Inspection', 'Approval'],
      ['Inspection', 'Rework', 'Inspection', 'Rework', 'Inspection', 'Approval'],
    ];

    const result = runInductiveMiner(traces);

    // Root should be a sequence or loop
    expect(result.treeString).toContain('⟳');
    expect(result.metrics.operatorCounts['loop']).toBeGreaterThanOrEqual(1);
    expect(result.metrics.isSound).toBe(true);
    expect(result.petriNet.isSound).toBe(true);
  });

  it('evaluates Fall-Through 1: Empty tree -> silent tau leaf (τ)', () => {
    const emptyResult = runInductiveMiner([]);
    expect(emptyResult.tree.type).toBe('tau');
    expect(emptyResult.tree.label).toBe('τ');
    expect(emptyResult.treeString).toBe('τ');

    const blankResult = runInductiveMiner([[], []]);
    expect(blankResult.tree.type).toBe('tau');
  });

  it('evaluates Fall-Through 2: One activity per tree', () => {
    // Single execution
    const single = runInductiveMiner([['Welding'], ['Welding']]);
    expect(single.tree.type).toBe('activity');
    expect(single.tree.label).toBe('Welding');
    expect(single.treeString).toBe("'Welding'");

    // Self-repetition
    const selfRep = runInductiveMiner([['Welding', 'Welding']]);
    expect(selfRep.tree.operator).toBe('loop');
    expect(selfRep.treeString).toContain('⟳(');
  });

  it('evaluates Fall-Through 3: Activity concurrent', () => {
    // Logging occurs interleaved with everything in a cyclic or dense sublog
    const traces = [
      ['Log', 'Step1', 'Step2', 'Log'],
      ['Step1', 'Log', 'Step2'],
      ['Step1', 'Step2', 'Log'],
      ['Log', 'Step2', 'Step1'],
    ];

    const result = runInductiveMiner(traces);
    expect(result.treeString).toBeDefined();
    expect(result.metrics.isSound).toBe(true);
  });

  it('evaluates Fall-Through 5: Flower model on highly entangled logs', () => {
    // Complete clique with arbitrary orderings where no cut is possible
    const traces = [
      ['A', 'B', 'C', 'A'],
      ['C', 'B', 'A', 'C'],
      ['B', 'A', 'C', 'B'],
      ['A', 'C', 'B'],
    ];

    const result = runInductiveMiner(traces);
    expect(result.treeString).toBeDefined();
    expect(result.metrics.isSound).toBe(true);
    expect(result.metrics.blockStructured).toBe(true);
  });

  it('converts process tree into a guaranteed sound Petri Net', () => {
    const traces = [
      ['Body Shop', 'Paint', 'Assembly'],
      ['Body Shop', 'Paint', 'Buffing', 'Assembly'],
    ];

    const result = runInductiveMiner(traces);
    const net = result.petriNet;

    expect(net.places.length).toBeGreaterThan(0);
    expect(net.transitions.length).toBeGreaterThan(0);
    expect(net.arcs.length).toBeGreaterThan(0);
    expect(net.isSound).toBe(true);
    expect(net.soundnessNotes.length).toBeGreaterThan(0);
  });

  it('handles realistic automotive manufacturing traces robustly', () => {
    const traces = [
      ['Body Shop', 'Paint', 'Inspection', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Inspection', 'Rework', 'Inspection', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
    ];

    const result = runInductiveMiner(traces);

    expect(result.activities).toContain('Body Shop');
    expect(result.activities).toContain('Dispatch');
    expect(result.startActivities).toEqual(['Body Shop']);
    expect(result.endActivities).toEqual(['Dispatch']);
    expect(result.metrics.isSound).toBe(true);
    expect(result.discoveryLog.length).toBeGreaterThan(0);
  });

  it('terminates cleanly on large or cyclic logs without infinite recursion', () => {
    const longTrace: string[] = [];
    for (let i = 0; i < 50; i++) {
      longTrace.push('StationA', 'StationB', 'StationC');
    }

    const result = runInductiveMiner([longTrace]);
    expect(result.metrics.isSound).toBe(true);
    expect(result.metrics.treeDepth).toBeLessThanOrEqual(20);
  });
});
