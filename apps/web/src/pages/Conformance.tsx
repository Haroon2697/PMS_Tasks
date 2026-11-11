/**
 * Process Conformance Checking Dashboard — Task: Conformance Checking.
 *
 * Implements two distinct formal conformance checking techniques:
 *  1. Token-Based Replay (Rozinat & van der Aalst):
 *     Replays log traces through discovered Petri nets (Alpha, Alpha+, Inductive Miner).
 *     Computes produced (p), consumed (c), missing (m), and remaining (r) tokens.
 *     Calculates trace-level and log-level fitness: f = 0.5*(1 - m/c) + 0.5*(1 - r/p).
 *     Pinpoints root-cause deviations, silent firings, and problematic activities.
 *
 *  2. Causal Footprint Conformance (van der Aalst):
 *     Extracts ordering relations (->, <-, ||, #, loops) from log and discovered models.
 *     Builds footprint matrices and compares across all three algorithms.
 *     Classifies mismatches into fitness defects, precision defects, and conflicts.
 *
 *  3. Interactive Conformance Dashboard:
 *     Multi-algorithm fitness comparison, missing vs remaining token balances,
 *     trace fitness distribution histogram, model complexity, and root-cause deviation reports.
 */

import { useMemo, useState } from 'react';
import {
  compareAlphaAlgorithms,
  compareConformance,
  runInductiveMiner,
  type ConformanceAlgorithmId,
  type ConformanceProfile,
  type OrderingRelation,
  type OverlayEdge,
} from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice } from '../components/primitives';
import { num, pct } from '../lib/format';

interface Preset {
  id: string;
  name: string;
  description: string;
  traces: string[][];
}

const PRESETS: Preset[] = [
  {
    id: 'happy_path',
    name: '1. Happy-path assembly',
    description: 'Every vehicle follows Body Shop → Paint → Assembly → Dispatch. 100% conforming with 0 missing/remaining tokens.',
    traces: [
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
    ],
  },
  {
    id: 'rework',
    name: '2. Inspection–rework loop',
    description: 'Quality rework loop. Alpha misclassifies Inspection ↔ Rework as parallel; Alpha+ and Inductive Miner handle it correctly.',
    traces: [
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Rework', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Rework', 'Inspection', 'Rework', 'Inspection', 'Dispatch'],
    ],
  },
  {
    id: 'deviations',
    name: '3. Deviating log (skips, repeats, out-of-order)',
    description: 'Complex real-world deviations: skipped Paint, double Paint, and out-of-order Dispatch. Highlights missing tokens and deviation causes.',
    traces: [
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Paint', 'Paint', 'Assembly', 'Dispatch'],
      ['Body Shop', 'Dispatch', 'Paint', 'Assembly'],
      ['Body Shop', 'Paint', 'Assembly', 'Dispatch'],
    ],
  },
  {
    id: 'concurrency',
    name: '4. Concurrent sub-assemblies (Chassis ^ Wiring)',
    description: 'Log interleaves Chassis and Wiring in parallel. Causal footprint shows Chassis ‖ Wiring; models that serialize them produce deviations.',
    traces: [
      ['Body Shop', 'Chassis', 'Wiring', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Wiring', 'Chassis', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Chassis', 'Wiring', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Wiring', 'Chassis', 'Inspection', 'Rework', 'Inspection', 'Dispatch'],
    ],
  },
];

export function ConformancePage({ navigate }: { navigate: (p: string) => void }) {
  const { eventLog, eventLogSource } = useStore();
  const [presetId, setPresetId] = useState('deviations');
  const [useCustom, setUseCustom] = useState(false);
  const [useActiveLog, setUseActiveLog] = useState(false);
  const [customText, setCustomText] = useState(
    'Body Shop, Paint, Assembly, Dispatch\nBody Shop, Assembly, Dispatch\nBody Shop, Dispatch, Paint, Assembly',
  );
  const [miner, setMiner] = useState<ConformanceAlgorithmId>('alpha_plus');
  const [view, setView] = useState<'dashboard' | 'replay' | 'footprint' | 'overlay'>('dashboard');
  const [selectedCase, setSelectedCase] = useState(0);
  const [traceFilter, setTraceFilter] = useState<'all' | 'perfect' | 'deviating'>('all');
  const [footprintFilter, setFootprintFilter] = useState<'all' | 'mismatches' | 'causality' | 'parallel' | 'loops'>('all');
  const [footprintSubView, setFootprintSubView] = useState<'3way' | 'selected'>('3way');

  const traces = useMemo(() => {
    if (useActiveLog && eventLog && eventLog.rows.length > 0) {
      const byCase = new Map<string, string[]>();
      for (const r of eventLog.rows) {
        const list = byCase.get(r.caseId) ?? [];
        list.push(r.activity);
        byCase.set(r.caseId, list);
      }
      return Array.from(byCase.values());
    }
    if (useCustom) {
      return customText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/[,\->>]+/).map((s) => s.trim()).filter(Boolean));
    }
    return (PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!).traces;
  }, [useActiveLog, eventLog, useCustom, customText, presetId]);

  const comparison = useMemo(() => {
    if (traces.length === 0 || traces.every((t) => t.length === 0)) return null;
    try {
      const { alpha, alphaPlus } = compareAlphaAlgorithms(traces);
      const inductive = runInductiveMiner(traces);
      return compareConformance(traces, alpha, alphaPlus, inductive);
    } catch (err) {
      console.error('Conformance calculation error:', err);
      return null;
    }
  }, [traces]);

  const profile = comparison?.profiles.find((p) => p.algorithmId === miner) ?? comparison?.profiles[0];

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* Intro Header */}
      <div>
        <p className="page-intro" style={{ margin: '0 0 6px' }}>
          <strong>Process Conformance Checking</strong> — Rigorous validation of discovered process models against
          real event logs using two complementary techniques: <strong>Petri Net Token Replay</strong> and{' '}
          <strong>Causal Footprint Matrix Analysis</strong>.
        </p>
        <span className="small muted">
          Token replay executes traces step-by-step on the Petri net, calculating produced (p), consumed (c), missing (m),
          and remaining (r) tokens. Causal footprint analysis computes directly-follows relations (→, ←, ‖, #, loops)
          and identifies fitness defects, precision defects, and structural conflicts.
        </span>
      </div>

      {/* Preset selection bar */}
      <Card title="Event Log Under Test" hint="Select a benchmark automotive manufacturing scenario, active imported event log, or custom traces.">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`btn sm ${!useCustom && !useActiveLog && presetId === p.id ? 'primary' : ''}`}
              onClick={() => {
                setPresetId(p.id);
                setUseCustom(false);
                setUseActiveLog(false);
                setSelectedCase(0);
              }}
            >
              {p.name}
            </button>
          ))}
          {eventLog ? (
            <button
              className={`btn sm ${useActiveLog ? 'primary' : ''}`}
              onClick={() => {
                setUseActiveLog(true);
                setUseCustom(false);
                setSelectedCase(0);
              }}
            >
              📂 Active Event Log ({eventLog.caseIds.length} cases)
            </button>
          ) : null}
          <button
            className={`btn sm ${useCustom ? 'primary' : ''}`}
            onClick={() => {
              setUseCustom(true);
              setUseActiveLog(false);
              setSelectedCase(0);
            }}
          >
            ✍️ Custom Trace Playground
          </button>
        </div>

        {useCustom ? (
          <textarea
            rows={4}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            style={{
              width: '100%',
              fontFamily: 'monospace',
              fontSize: 12,
              padding: '8px 10px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border-strong)',
              background: 'var(--surface-2)',
              color: 'var(--text-primary)',
            }}
          />
        ) : (
          <div style={{ padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 'var(--radius)', fontSize: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {useActiveLog ? `Active Log: ${eventLogSource ?? 'Imported'}` : PRESETS.find((p) => p.id === presetId)?.name}
            </div>
            <div className="muted">
              {useActiveLog
                ? `${eventLog?.rows.length} events · ${eventLog?.caseIds.length} cases`
                : PRESETS.find((p) => p.id === presetId)?.description}
            </div>
            <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
              Sample Traces: {traces.slice(0, 3).map((t) => t.join(' → ')).join('   |   ')}
              {traces.length > 3 ? `  (+${traces.length - 3} more)` : ''}
            </div>
          </div>
        )}
      </Card>

      {!comparison || !profile ? (
        <EmptyState>No valid trace data to analyze. Please adjust your input or import an event log.</EmptyState>
      ) : (
        <>
          {comparison.warnings.length > 0 ? (
            <Notice kind="info" title="Sample Size & Confidence">
              {comparison.warnings.join(' ')}
            </Notice>
          ) : null}

          {/* Top KPI Cards for Selected Model */}
          <div className="grid cols-4">
            <Kpi
              label={`${profile.algorithmName} Replay Fitness`}
              value={pct(profile.token.fitness)}
              basis="derived"
              status={profile.token.fitness >= 0.9 ? 'good' : profile.token.fitness >= 0.7 ? 'warning' : 'critical'}
              sub={`${profile.token.fittingTraces}/${profile.token.totalTraces} traces fit perfectly · missing: ${profile.token.missing}, remaining: ${profile.token.remaining}`}
            />
            <Kpi
              label="Causal Footprint Similarity"
              value={pct(profile.footprint.similarity)}
              basis="derived"
              status={profile.footprint.similarity >= 0.9 ? 'good' : profile.footprint.similarity >= 0.7 ? 'warning' : 'serious'}
              sub={`${profile.footprint.mismatches} mismatches out of ${profile.footprint.comparedCells} relation cells`}
            />
            <Kpi
              label="Footprint Fitness & Precision"
              value={`${pct(profile.footprint.fitness)} / ${pct(profile.footprint.precision)}`}
              basis="derived"
              sub="Fitness: log covered by model · Precision: model observed in log"
            />
            <Kpi
              label="Model Complexity & Soundness"
              value={`${profile.complexity.places}P / ${profile.complexity.transitions}T / ${profile.complexity.arcs}A`}
              basis="derived"
              status={profile.isSound ? 'good' : 'warning'}
              sub={profile.isSound ? '100% Sound Workflow Net (0 deadlocks)' : 'Potential deadlock or short-loop flaw'}
            />
          </div>

          {/* Navigation Bar */}
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="small muted" style={{ alignSelf: 'center', marginRight: 4 }}>Select Model:</span>
              {(
                [
                  ['alpha', 'Alpha (α)'],
                  ['alpha_plus', 'Alpha Plus (α⁺)'],
                  ['inductive_miner', 'Inductive Miner (IM)'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={`btn sm ${miner === id ? 'primary' : ''}`}
                  onClick={() => setMiner(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button
                className={`btn sm ${view === 'dashboard' ? 'primary' : ''}`}
                onClick={() => setView('dashboard')}
              >
                📊 Conformance Dashboard
              </button>
              <button
                className={`btn sm ${view === 'footprint' ? 'primary' : ''}`}
                onClick={() => setView('footprint')}
              >
                👣 Causal Footprint Analysis
              </button>
              <button
                className={`btn sm ${view === 'replay' ? 'primary' : ''}`}
                onClick={() => setView('replay')}
              >
                ⚙️ Token Replay Deep-Dive
              </button>
              <button
                className={`btn sm ${view === 'overlay' ? 'primary' : ''}`}
                onClick={() => setView('overlay')}
              >
                🕸️ Graph Overlay (Log ⟷ Model)
              </button>
            </div>
          </div>

          {/* ============================================================== */}
          {/* VIEW 1: CONFORMANCE DASHBOARD                                   */}
          {/* ============================================================== */}
          {view === 'dashboard' && (
            <DashboardPanel
              comparison={comparison}
              selectedMiner={miner}
              onSelectMiner={setMiner}
              onInspectReplay={() => setView('replay')}
              onInspectFootprint={() => setView('footprint')}
            />
          )}

          {/* ============================================================== */}
          {/* VIEW 2: CAUSAL FOOTPRINT ANALYSIS                              */}
          {/* ============================================================== */}
          {view === 'footprint' && (
            <FootprintPanel
              profile={profile}
              comparison={comparison}
              subView={footprintSubView}
              setSubView={setFootprintSubView}
              filter={footprintFilter}
              setFilter={setFootprintFilter}
            />
          )}

          {/* ============================================================== */}
          {/* VIEW 3: TOKEN REPLAY DEEP-DIVE                                 */}
          {/* ============================================================== */}
          {view === 'replay' && (
            <ReplayPanel
              profile={profile}
              selectedCase={selectedCase}
              setSelectedCase={setSelectedCase}
              traceFilter={traceFilter}
              setTraceFilter={setTraceFilter}
            />
          )}

          {/* ============================================================== */}
          {/* VIEW 4: GRAPH OVERLAY                                          */}
          {/* ============================================================== */}
          {view === 'overlay' && (
            <OverlayPanel profile={profile} traces={traces} />
          )}

          {/* Page Footer Navigation */}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => navigate('alphacompare')}>
                ← 3-Way Discovery Comparison (Alpha, Alpha+, IM)
              </button>
              <button className="btn" onClick={() => navigate('eventlog')}>
                Event Log Import
              </button>
            </div>
            <span className="small muted">
              ProcessFlow Conformance Suite · Token Replay & Causal Footprints
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================== */
/* 1. DASHBOARD PANEL                                                 */
/* ================================================================== */

function DashboardPanel({
  comparison,
  selectedMiner,
  onSelectMiner,
  onInspectReplay,
  onInspectFootprint,
}: {
  comparison: NonNullable<ReturnType<typeof compareConformance>>;
  selectedMiner: ConformanceAlgorithmId;
  onSelectMiner: (id: ConformanceAlgorithmId) => void;
  onInspectReplay: () => void;
  onInspectFootprint: () => void;
}) {
  const currentProfile = comparison.profiles.find((p) => p.algorithmId === selectedMiner) ?? comparison.profiles[0]!;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* 2-Column Graphs: Fitness Comparison & Token Balance */}
      <div className="grid cols-2">
        <Card
          title="1. Conformance & Quality Scores Across 3 Algorithms"
          hint="Calculated from actual event log traces replayed against each discovered Petri net."
        >
          <MultiMetricBarChart profiles={comparison.profiles} />
          <div className="row" style={{ gap: 16, marginTop: 12, fontSize: 11, justifyContent: 'center' }}>
            <span><span className="conf-swatch log" /> Alpha (α)</span>
            <span><span className="conf-swatch model" /> Alpha Plus (α⁺)</span>
            <span><span className="conf-swatch both" /> Inductive Miner (IM)</span>
          </div>
        </Card>

        <Card
          title="2. Token Balance: Missing vs Remaining Tokens"
          hint="Missing tokens (m) = unmodeled steps; Remaining tokens (r) = deadlocked or incomplete executions."
        >
          <TokenBalanceChart profiles={comparison.profiles} />
          <div className="row" style={{ gap: 14, marginTop: 12, fontSize: 11, justifyContent: 'center' }}>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--series-1)', borderRadius: 2, marginRight: 4 }} /> Produced (p)</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--status-good)', borderRadius: 2, marginRight: 4 }} /> Consumed (c)</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--status-critical)', borderRadius: 2, marginRight: 4 }} /> Missing (m)</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--series-2)', borderRadius: 2, marginRight: 4 }} /> Remaining (r)</span>
          </div>
        </Card>
      </div>

      {/* 2-Column Graphs: Trace Fitness Distribution & Model Complexity */}
      <div className="grid cols-2">
        <Card
          title={`3. Trace Fitness Distribution — ${currentProfile.algorithmName}`}
          hint="Histogram showing proportion of cases replaying cleanly vs those requiring missing token insertions."
        >
          <div style={{ marginBottom: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {comparison.profiles.map((p) => (
              <button
                key={p.algorithmId}
                className={`btn sm ${selectedMiner === p.algorithmId ? 'primary' : ''}`}
                style={{ fontSize: 10, padding: '2px 6px' }}
                onClick={() => onSelectMiner(p.algorithmId)}
              >
                {p.algorithmName}
              </button>
            ))}
          </div>
          <FitnessDistributionHistogram bins={currentProfile.fitnessDistribution} />
          <div className="small muted" style={{ marginTop: 8, textAlign: 'center' }}>
            {currentProfile.token.fittingTraces} of {currentProfile.token.totalTraces} traces fit with 100% precision.
          </div>
        </Card>

        <Card
          title="4. Discovered Model Structural Complexity"
          hint="Model size comparison: fewer places and transitions with higher fitness indicates superior structural simplicity."
        >
          <ComplexityBarChart profiles={comparison.profiles} />
          <div style={{ marginTop: 10, overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Algorithm</th>
                  <th style={{ padding: '4px 6px' }}>Places</th>
                  <th style={{ padding: '4px 6px' }}>Transitions</th>
                  <th style={{ padding: '4px 6px' }}>Arcs</th>
                  <th style={{ padding: '4px 6px' }}>Arc Density</th>
                  <th style={{ padding: '4px 6px' }}>Soundness</th>
                </tr>
              </thead>
              <tbody>
                {comparison.profiles.map((p) => (
                  <tr key={p.algorithmId} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px', fontWeight: 600 }}>{p.algorithmName}</td>
                    <td style={{ textAlign: 'center', padding: '6px' }}>{p.complexity.places}</td>
                    <td style={{ textAlign: 'center', padding: '6px' }}>{p.complexity.transitions}</td>
                    <td style={{ textAlign: 'center', padding: '6px' }}>{p.complexity.arcs}</td>
                    <td style={{ textAlign: 'center', padding: '6px' }}>{num(p.complexity.arcDensity, 2)}</td>
                    <td style={{ textAlign: 'center', padding: '6px' }}>
                      <span className={`badge ${p.isSound ? 'sim' : 'risk'}`}>
                        {p.isSound ? 'Sound' : 'Unsound'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Root-Cause Deviation Report */}
      <Card
        title={`5. Root-Cause Deviation Report: Problematic Activities (${currentProfile.algorithmName})`}
        hint="Activities where the token replay algorithm encountered missing inputs or non-modeled behavior."
      >
        {currentProfile.deviations.frequentActivities.length === 0 ? (
          <div className="small muted">No deviations observed; every activity fired with valid tokens.</div>
        ) : (
          <DataTable
            rows={currentProfile.deviations.frequentActivities}
            rowKey={(r) => r.activity}
            columns={[
              {
                key: 'act',
                header: 'Activity',
                align: 'left',
                render: (r) => <strong>{r.activity}</strong>,
              },
              {
                key: 'occ',
                header: 'Total Occurrences',
                render: (r) => String(r.totalOccurrences),
              },
              {
                key: 'ok',
                header: 'Conforming Firings',
                render: (r) => (
                  <span style={{ color: 'var(--status-good-text)', fontWeight: 600 }}>
                    {r.okFirings} ({pct(r.totalOccurrences > 0 ? r.okFirings / r.totalOccurrences : 1)})
                  </span>
                ),
              },
              {
                key: 'miss',
                header: 'Missing Tokens Inserted',
                render: (r) => (
                  <span style={{ color: r.missingTokenCount > 0 ? 'var(--status-critical)' : 'inherit', fontWeight: r.missingTokenCount > 0 ? 700 : 400 }}>
                    {r.missingTokenCount}
                  </span>
                ),
              },
              {
                key: 'unseen',
                header: 'Not In Model',
                render: (r) => (
                  <span style={{ color: r.notInModelCount > 0 ? 'var(--series-2)' : 'inherit' }}>
                    {r.notInModelCount}
                  </span>
                ),
              },
              {
                key: 'rate',
                header: 'Deviation Rate',
                render: (r) => (
                  <span className={`badge ${r.deviationRate > 0 ? (r.deviationRate > 0.4 ? 'risk' : 'warn') : 'sim'}`}>
                    {pct(r.deviationRate)}
                  </span>
                ),
              },
              {
                key: 'diag',
                header: 'Process Engineering Diagnosis',
                align: 'left',
                render: (r) => (
                  <span className="small muted">
                    {r.notInModelCount > 0
                      ? 'Activity omitted from model (filtered or disconnected).'
                      : r.missingTokenCount > 0
                      ? 'Station executed before upstream prerequisites produced tokens (e.g. skip/bypass or out-of-order execution).'
                      : 'Fully conforming across all traces.'}
                  </span>
                ),
              },
            ]}
          />
        )}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <button className="btn sm" onClick={onInspectReplay}>
            Inspect Individual Traces in Step Debugger →
          </button>
          <button className="btn sm" onClick={onInspectFootprint}>
            View 3-Way Causal Footprint Matrix →
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ================================================================== */
/* 2. CAUSAL FOOTPRINT PANEL                                          */
/* ================================================================== */

function FootprintPanel({
  profile,
  comparison,
  subView,
  setSubView,
  filter,
  setFilter,
}: {
  profile: ConformanceProfile;
  comparison: NonNullable<ReturnType<typeof compareConformance>>;
  subView: '3way' | 'selected';
  setSubView: (v: '3way' | 'selected') => void;
  filter: 'all' | 'mismatches' | 'causality' | 'parallel' | 'loops';
  setFilter: (f: 'all' | 'mismatches' | 'causality' | 'parallel' | 'loops') => void;
}) {
  const acts = comparison.activities;
  const fp3Way = comparison.footprint3Way;

  // Filter 3-way cells
  const filteredCells = useMemo(() => {
    return fp3Way.cells.filter((c) => {
      if (filter === 'mismatches') return !c.allMatch;
      if (filter === 'causality') return c.logRel === '->' || c.logRel === '<-';
      if (filter === 'parallel') return c.logRel === '||';
      if (filter === 'loops') return c.logRel === 'L1L' || c.logRel === 'L2L';
      return true;
    });
  }, [fp3Way, filter]);

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* Subview Selector */}
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          <button
            className={`btn sm ${subView === '3way' ? 'primary' : ''}`}
            onClick={() => setSubView('3way')}
          >
            🌐 3-Way Footprint Relationship Matrix (Log vs α vs α⁺ vs IM)
          </button>
          <button
            className={`btn sm ${subView === 'selected' ? 'primary' : ''}`}
            onClick={() => setSubView('selected')}
          >
            🔥 Heatmap Comparison: Log vs {profile.algorithmName}
          </button>
        </div>

        {subView === '3way' && (
          <div className="row" style={{ gap: 6 }}>
            <span className="small muted" style={{ alignSelf: 'center' }}>Filter:</span>
            {(
              [
                ['all', 'All Pairs'],
                ['mismatches', '⚠️ Disagreements Only'],
                ['causality', 'Causality (→, ←)'],
                ['parallel', 'Parallel (‖)'],
                ['loops', 'Loops (⟲, ⇄)'],
              ] as const
            ).map(([f, label]) => (
              <button
                key={f}
                className={`btn sm ${filter === f ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setFilter(f)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {subView === '3way' ? (
        <>
          {/* 3-Way Summary KPIs */}
          <div className="grid cols-4">
            <Kpi
              label="Analyzed Activity Pairs"
              value={`${fp3Way.summary.totalPairs} pairs`}
              basis="derived"
              sub={`${acts.length} distinct activities in event log`}
            />
            <Kpi
              label="Full 3-Way Agreement"
              value={`${fp3Way.summary.allMatchCount} / ${fp3Way.summary.totalPairs}`}
              basis="derived"
              status={fp3Way.summary.allMatchCount === fp3Way.summary.totalPairs ? 'good' : 'warning'}
              sub={`${pct(fp3Way.summary.totalPairs > 0 ? fp3Way.summary.allMatchCount / fp3Way.summary.totalPairs : 1)} universal consensus`}
            />
            <Kpi
              label="Alpha (α) Footprint Similarity"
              value={pct(fp3Way.summary.alphaSimilarity)}
              basis="derived"
              status={fp3Way.summary.alphaSimilarity >= 0.85 ? 'good' : 'critical'}
              sub={`${fp3Way.summary.alphaMatchCount} matching log relations`}
            />
            <Kpi
              label="IM Footprint Similarity"
              value={pct(fp3Way.summary.inductiveSimilarity)}
              basis="derived"
              status="good"
              sub={`${fp3Way.summary.inductiveMatchCount} matching log relations`}
            />
          </div>

          {/* 3-Way Unified Matrix Table */}
          <Card
            title="3-Way Causal Footprint Matrix (Log vs Alpha vs Alpha+ vs Inductive Miner)"
            hint="Compares the extracted behavioral relation for every activity pair (A, B) across the log and all 3 discovered models."
          >
            <div style={{ overflowX: 'auto', maxHeight: 480 }}>
              <table className="table" style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 2 }}>
                  <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px' }}>From (A)</th>
                    <th style={{ padding: '6px 8px' }}>To (B)</th>
                    <th style={{ padding: '6px 8px', color: 'var(--text-primary)', fontWeight: 700 }}>Log Relation</th>
                    <th style={{ padding: '6px 8px', color: 'var(--status-critical)' }}>Alpha (α)</th>
                    <th style={{ padding: '6px 8px', color: 'var(--series-1)' }}>Alpha Plus (α⁺)</th>
                    <th style={{ padding: '6px 8px', color: 'var(--status-good-text)' }}>Inductive Miner (IM)</th>
                    <th style={{ padding: '6px 8px' }}>Consensus</th>
                    <th style={{ padding: '6px 8px' }}>Evaluation</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCells.map((c) => (
                    <tr
                      key={`${c.a}_${c.b}`}
                      style={{
                        borderBottom: '1px solid var(--border)',
                        background: !c.allMatch ? 'rgba(235, 104, 52, 0.08)' : undefined,
                      }}
                    >
                      <td style={{ padding: '5px 8px', fontWeight: 600 }}>{c.a}</td>
                      <td style={{ padding: '5px 8px', fontWeight: 600 }}>{c.b}</td>
                      <td style={{ padding: '5px 8px' }}>
                        <span className="badge" style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                          {relSymbol(c.logRel)} ({c.logRel})
                        </span>
                      </td>
                      <td style={{ padding: '5px 8px' }}>
                        <span style={{ color: c.alphaMatches ? 'var(--status-good-text)' : 'var(--status-critical)', fontWeight: 600 }}>
                          {relSymbol(c.alphaRel)} {c.alphaMatches ? '✓' : '✗'}
                        </span>
                      </td>
                      <td style={{ padding: '5px 8px' }}>
                        <span style={{ color: c.alphaPlusMatches ? 'var(--status-good-text)' : 'var(--series-1)', fontWeight: 600 }}>
                          {relSymbol(c.alphaPlusRel)} {c.alphaPlusMatches ? '✓' : '✗'}
                        </span>
                      </td>
                      <td style={{ padding: '5px 8px' }}>
                        <span style={{ color: c.inductiveMatches ? 'var(--status-good-text)' : 'var(--status-critical)', fontWeight: 600 }}>
                          {relSymbol(c.inductiveRel)} {c.inductiveMatches ? '✓' : '✗'}
                        </span>
                      </td>
                      <td style={{ padding: '5px 8px' }}>
                        <span className={`badge ${c.allMatch ? 'sim' : c.agreementScore >= 2 ? 'warn' : 'risk'}`}>
                          {c.agreementScore}/3 Match
                        </span>
                      </td>
                      <td style={{ padding: '5px 8px', fontSize: 10, color: 'var(--text-secondary)' }}>
                        {c.allMatch
                          ? 'Universal agreement'
                          : !c.alphaMatches && c.alphaRel === '||' && (c.logRel === 'L2L' || c.logRel === '->')
                          ? 'Alpha short-loop flaw (misclassified rework as parallel ‖)'
                          : !c.alphaMatches && c.logRel === 'L1L'
                          ? 'Alpha omitted self-loop'
                          : 'Structural ordering mismatch'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <>
          {/* Side-by-Side Footprint Heatmaps */}
          <Card
            title={`Causal Footprint Heatmap: Event Log vs ${profile.algorithmName}`}
            hint="Orange cells highlight Hamming mismatches between observed log ordering and discovered model ordering."
          >
            <div className="grid cols-2">
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: 12 }}>Observed Event Log Footprint</h4>
                <FootprintHeat
                  matrix={profile.footprint.logFootprint.relations}
                  other={profile.footprint.modelFootprint.relations}
                  activities={acts}
                />
              </div>
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: 12 }}>{profile.algorithmName} Model Footprint</h4>
                <FootprintHeat
                  matrix={profile.footprint.modelFootprint.relations}
                  other={profile.footprint.logFootprint.relations}
                  activities={acts}
                />
              </div>
            </div>
            <div className="row" style={{ gap: 16, marginTop: 10, fontSize: 11 }}>
              <span>→ Causality</span>
              <span>← Reverse causality</span>
              <span>‖ Concurrency / Parallelism</span>
              <span># Independence / No succession</span>
              <span>⟲ Length-1 Self-loop</span>
              <span>⇄ Length-2 Rework loop</span>
              <span style={{ marginLeft: 'auto', color: 'var(--status-warning)' }}>■ Orange = Relationship Mismatch</span>
            </div>
          </Card>

          {/* Mismatches Breakdown Table */}
          <Card
            title={`Mismatched Footprint Relations (${profile.footprint.diffs.length} Defects)`}
            hint="Classified into Fitness Defects (in log, not model), Precision Defects (in model, not log), and Ordering Conflicts."
          >
            {profile.footprint.diffs.length === 0 ? (
              <div className="small muted">Event log and discovered model have 100% identical footprint matrices.</div>
            ) : (
              <DataTable
                rows={profile.footprint.diffs}
                rowKey={(d) => `${d.a}_${d.b}_${d.kind}`}
                columns={[
                  {
                    key: 'k',
                    header: 'Defect Classification',
                    align: 'left',
                    render: (d) => (
                      <span className={`badge ${d.kind === 'fitness_defect' ? 'risk' : d.kind === 'precision_defect' ? 'warn' : 'sim'}`}>
                        {d.kind === 'fitness_defect'
                          ? 'Fitness Defect (Missing in Model)'
                          : d.kind === 'precision_defect'
                          ? 'Precision Defect (Overgeneralization)'
                          : 'Ordering Conflict'}
                      </span>
                    ),
                  },
                  {
                    key: 'p',
                    header: 'Activity Pair',
                    align: 'left',
                    render: (d) => (
                      <code>
                        {d.a} × {d.b}
                      </code>
                    ),
                  },
                  {
                    key: 'l',
                    header: 'Log Relation',
                    render: (d) => (
                      <span style={{ fontWeight: 700 }}>
                        {relSymbol(d.logRelation)} ({d.logRelation})
                      </span>
                    ),
                  },
                  {
                    key: 'm',
                    header: 'Model Relation',
                    render: (d) => (
                      <span style={{ fontWeight: 700, color: 'var(--status-critical)' }}>
                        {relSymbol(d.modelRelation)} ({d.modelRelation})
                      </span>
                    ),
                  },
                  {
                    key: 'exp',
                    header: 'Impact on Conformance',
                    align: 'left',
                    render: (d) => (
                      <span className="small muted">
                        {d.kind === 'fitness_defect'
                          ? 'The real process visited these stations in this sequence, but the Petri net blocks this path.'
                          : 'The Petri net permits an execution sequence that was never observed in recorded factory data.'}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/* ================================================================== */
/* 3. REPLAY PANEL                                                    */
/* ================================================================== */

function ReplayPanel({
  profile,
  selectedCase,
  setSelectedCase,
  traceFilter,
  setTraceFilter,
}: {
  profile: ConformanceProfile;
  selectedCase: number;
  setSelectedCase: (n: number) => void;
  traceFilter: 'all' | 'perfect' | 'deviating';
  setTraceFilter: (f: 'all' | 'perfect' | 'deviating') => void;
}) {
  const traces = profile.token.traces;
  const filteredTraces = useMemo(() => {
    if (traceFilter === 'perfect') return traces.filter((t) => t.perfectlyFitting);
    if (traceFilter === 'deviating') return traces.filter((t) => !t.perfectlyFitting);
    return traces;
  }, [traces, traceFilter]);

  const selectedTrace = traces.find((t) => t.caseIndex === selectedCase) ?? traces[0];

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* Replay Summary Cards */}
      <div className="grid cols-4">
        <Kpi
          label="Replay Fitness f"
          value={pct(profile.token.fitness)}
          basis="derived"
          status={profile.token.fitness >= 0.9 ? 'good' : profile.token.fitness >= 0.7 ? 'warning' : 'critical'}
          sub={`f = 0.5·(1 − ${profile.token.missing}/${profile.token.consumed}) + 0.5·(1 − ${profile.token.remaining}/${profile.token.produced})`}
        />
        <Kpi
          label="Produced / Consumed"
          value={`${profile.token.produced} / ${profile.token.consumed}`}
          basis="derived"
          sub="Produced on outputs · Consumed from inputs"
        />
        <Kpi
          label="Missing Tokens (m)"
          value={String(profile.token.missing)}
          basis="derived"
          status={profile.token.missing === 0 ? 'good' : 'critical'}
          sub="Tokens artificially inserted to proceed"
        />
        <Kpi
          label="Remaining Tokens (r)"
          value={String(profile.token.remaining)}
          basis="derived"
          status={profile.token.remaining === 0 ? 'good' : 'warning'}
          sub="Leftover tokens at trace completion"
        />
      </div>

      {/* Filter and Trace Table */}
      <Card
        title={`Petri Net Token Replay Log (${filteredTraces.length} Traces on ${profile.algorithmName})`}
        hint="Click any case to inspect step-by-step token production, consumption, and missing inputs."
      >
        <div className="row" style={{ gap: 6, marginBottom: 12 }}>
          <span className="small muted" style={{ alignSelf: 'center', marginRight: 4 }}>Filter:</span>
          {(
            [
              ['all', `All (${traces.length})`],
              ['perfect', `Perfect Fit (${profile.token.fittingTraces})`],
              ['deviating', `Deviating (${traces.length - profile.token.fittingTraces})`],
            ] as const
          ).map(([f, label]) => (
            <button
              key={f}
              className={`btn sm ${traceFilter === f ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => setTraceFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ overflowX: 'auto', maxHeight: 360 }}>
          <table className="table" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 1 }}>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Case #</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Replayed Trace Activities</th>
                <th style={{ padding: '6px 8px' }}>Fitness f</th>
                <th style={{ padding: '6px 8px' }}>Missing (m)</th>
                <th style={{ padding: '6px 8px' }}>Remaining (r)</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredTraces.map((t) => (
                <tr
                  key={t.caseIndex}
                  onClick={() => setSelectedCase(t.caseIndex)}
                  style={{
                    cursor: 'pointer',
                    background: t.caseIndex === selectedCase ? 'color-mix(in srgb, var(--series-1) 12%, transparent)' : undefined,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <td style={{ padding: '8px', fontWeight: 600 }}>Case #{t.caseIndex + 1}</td>
                  <td style={{ padding: '8px' }}>
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {t.steps.map((s, i) => (
                        <span key={i} className={`conf-event ${s.status}`}>
                          {s.activity}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ textAlign: 'center', padding: '8px', fontWeight: 700 }}>{pct(t.fitness)}</td>
                  <td style={{ textAlign: 'center', padding: '8px', color: t.missing > 0 ? 'var(--status-critical)' : 'inherit' }}>
                    {t.missing}
                  </td>
                  <td style={{ textAlign: 'center', padding: '8px', color: t.remaining > 0 ? 'var(--series-2)' : 'inherit' }}>
                    {t.remaining}
                  </td>
                  <td style={{ textAlign: 'center', padding: '8px' }}>
                    <span className={`badge ${t.perfectlyFitting ? 'sim' : 'risk'}`}>
                      {t.perfectlyFitting ? 'Fit' : 'Deviation'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Selected Trace Step-by-Step Inspector */}
      {selectedTrace && (
        <Card
          title={`Step Debugger: Case #${selectedTrace.caseIndex + 1} on ${profile.algorithmName}`}
          hint="Inspects token consumption, missing token artificial insertions, and silent transitions."
        >
          <div className="notice info" style={{ marginBottom: 12 }}>
            <strong>Trace Fitness Equation:</strong>{' '}
            <code>
              f = 0.5·(1 − {selectedTrace.missing}/{selectedTrace.consumed}) + 0.5·(1 − {selectedTrace.remaining}/{selectedTrace.produced}) ={' '}
              {pct(selectedTrace.fitness)}
            </code>
            {selectedTrace.perfectlyFitting && ' — Perfectly conforming execution.'}
          </div>

          <DataTable
            rows={selectedTrace.steps}
            rowKey={(s) => `${s.index}_${s.activity}`}
            columns={[
              { key: 'i', header: 'Step', render: (s) => String(s.index + 1) },
              { key: 'a', header: 'Activity', align: 'left', render: (s) => <strong>{s.activity}</strong> },
              {
                key: 'st',
                header: 'Token Replay Status',
                align: 'left',
                render: (s) => (
                  <span className={`conf-event ${s.status}`}>
                    {s.status === 'ok'
                      ? '✓ Enabled & Fired'
                      : s.status === 'missing'
                      ? `⚠️ Missing ${s.missingInputs} Token(s)`
                      : '❌ Not In Model'}
                  </span>
                ),
              },
              {
                key: 'tau',
                header: 'Silent (τ) Firings Preceding Event',
                align: 'left',
                render: (s) => (s.silentFirings.length > 0 ? s.silentFirings.join(' → ') : '—'),
              },
              {
                key: 'expl',
                header: 'Petri Net Action',
                align: 'left',
                render: (s) => (
                  <span className="small muted">
                    {s.status === 'ok'
                      ? 'All input places contained tokens. Tokens decremented, output tokens created.'
                      : s.status === 'missing'
                      ? `Required token(s) absent from input places. Artificially inserted ${s.missingInputs} token(s) to continue replay.`
                      : 'Activity does not correspond to any visible transition in the discovered Petri net.'}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

/* ================================================================== */
/* 4. OVERLAY PANEL                                                   */
/* ================================================================== */

function OverlayPanel({
  profile,
  traces,
}: {
  profile: ConformanceProfile;
  traces: string[][];
}) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title={`Directly-Follows Overlay Graph: Event Log vs ${profile.algorithmName}`}
        hint="Green edges are observed in both log and model. Red dotted edges occur only in the log (fitness defect). Blue dashed edges occur only in the model (unobserved path)."
      >
        <OverlayGraph activities={profile.activities} edges={profile.overlay} traces={traces} />
        <div className="row" style={{ gap: 16, marginTop: 10, fontSize: 11, flexWrap: 'wrap', justifyContent: 'center' }}>
          <span><span className="conf-swatch both" /> In log and in process (Conforming)</span>
          <span><span className="conf-swatch log" /> In log only — Fitness defect</span>
          <span><span className="conf-swatch model" /> In process only — Unobserved model behavior</span>
        </div>
      </Card>

      <div className="grid cols-2">
        <Card title="Log-Only Successions (Fitness Defects)" hint="Observed in trace logs, but missing from Petri net visible transitions.">
          <EdgeList edges={profile.overlay.filter((e) => e.kind === 'log_only')} empty="None — every logged succession is supported by the process." />
        </Card>
        <Card title="Model-Only Successions (Precision Overshoots)" hint="Permitted by the Petri net, but never observed in this event log.">
          <EdgeList edges={profile.overlay.filter((e) => e.kind === 'model_only')} empty="None — the process does not add unobserved paths on this sample." />
        </Card>
      </div>
    </div>
  );
}

/* ================================================================== */
/* SVG CHARTS & VISUALS                                               */
/* ================================================================== */

function MultiMetricBarChart({ profiles }: { profiles: ConformanceProfile[] }) {
  const metrics = [
    { key: 'tf', label: 'Token Fitness', pick: (p: ConformanceProfile) => p.token.fitness },
    { key: 'fs', label: 'Footprint Sim.', pick: (p: ConformanceProfile) => p.footprint.similarity },
    { key: 'fp', label: 'Footprint Prec.', pick: (p: ConformanceProfile) => p.footprint.precision },
    { key: 'fit', label: 'Fitting Traces', pick: (p: ConformanceProfile) => (p.token.totalTraces ? p.token.fittingTraces / p.token.totalTraces : 0) },
  ];

  const barW = 16;
  const gap = 5;
  const groupW = profiles.length * barW + (profiles.length - 1) * gap;
  const groupSpacing = 120;
  const chartH = 150;
  const baseY = 170;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(520, 60 + metrics.length * groupSpacing)} height={210} style={{ display: 'block', margin: '0 auto' }}>
        {[0, 0.25, 0.5, 0.75, 1.0].map((tick) => {
          const y = baseY - tick * chartH;
          return (
            <g key={tick}>
              <line x1={45} y1={y} x2={500} y2={y} stroke="var(--border)" strokeDasharray={tick === 0 ? undefined : '2 2'} />
              <text x={38} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-muted)">
                {pct(tick)}
              </text>
            </g>
          );
        })}

        {metrics.map((m, gi) => {
          const gx = 65 + gi * groupSpacing;
          return (
            <g key={m.key}>
              {profiles.map((p, pi) => {
                const val = m.pick(p);
                const h = Math.max(2, val * chartH);
                const bx = gx + pi * (barW + gap);
                const color = pi === 0 ? 'var(--status-critical)' : pi === 1 ? 'var(--series-1)' : 'var(--status-good)';
                return (
                  <g key={p.algorithmId}>
                    <rect x={bx} y={baseY - h} width={barW} height={h} rx={2} fill={color} />
                    <text x={bx + barW / 2} y={baseY - h - 4} textAnchor="middle" fontSize={8} fill="var(--text-secondary)">
                      {pct(val)}
                    </text>
                  </g>
                );
              })}
              <text x={gx + groupW / 2} y={baseY + 18} textAnchor="middle" fontSize={10} fill="var(--text-primary)" fontWeight={600}>
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function TokenBalanceChart({ profiles }: { profiles: ConformanceProfile[] }) {
  const maxToken = Math.max(
    ...profiles.flatMap((p) => [p.token.produced, p.token.consumed, p.token.missing, p.token.remaining]),
    10,
  );

  const barW = 12;
  const gap = 4;
  const seriesCount = 4;
  const groupW = seriesCount * barW + (seriesCount - 1) * gap;
  const groupSpacing = 130;
  const chartH = 140;
  const baseY = 160;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(480, 50 + profiles.length * groupSpacing)} height={200} style={{ display: 'block', margin: '0 auto' }}>
        {[0, 0.5, 1].map((f) => {
          const val = Math.round(f * maxToken);
          const y = baseY - f * chartH;
          return (
            <g key={f}>
              <line x1={40} y1={y} x2={460} y2={y} stroke="var(--border)" strokeDasharray={f === 0 ? undefined : '2 2'} />
              <text x={34} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-muted)">
                {val}
              </text>
            </g>
          );
        })}

        {profiles.map((p, pi) => {
          const gx = 65 + pi * groupSpacing;
          const series = [
            { key: 'p', label: 'Produced', val: p.token.produced, color: 'var(--series-1)' },
            { key: 'c', label: 'Consumed', val: p.token.consumed, color: 'var(--status-good)' },
            { key: 'm', label: 'Missing', val: p.token.missing, color: 'var(--status-critical)' },
            { key: 'r', label: 'Remaining', val: p.token.remaining, color: 'var(--series-2)' },
          ];

          return (
            <g key={p.algorithmId}>
              {series.map((s, si) => {
                const h = (s.val / maxToken) * chartH;
                const bx = gx + si * (barW + gap);
                return (
                  <g key={s.key}>
                    <rect x={bx} y={baseY - h} width={barW} height={Math.max(2, h)} rx={2} fill={s.color} />
                    <text x={bx + barW / 2} y={baseY - h - 3} textAnchor="middle" fontSize={8} fill="var(--text-secondary)">
                      {s.val}
                    </text>
                  </g>
                );
              })}
              <text x={gx + groupW / 2} y={baseY + 18} textAnchor="middle" fontSize={10} fill="var(--text-primary)" fontWeight={600}>
                {p.algorithmName}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function FitnessDistributionHistogram({ bins }: { bins: ConformanceProfile['fitnessDistribution'] }) {
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const chartH = 120;
  const baseY = 140;
  const barW = 42;
  const gap = 16;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(380, 50 + bins.length * (barW + gap))} height={180} style={{ display: 'block', margin: '0 auto' }}>
        {[0, 0.5, 1].map((f) => {
          const val = Math.round(f * maxCount);
          const y = baseY - f * chartH;
          return (
            <g key={f}>
              <line x1={35} y1={y} x2={350} y2={y} stroke="var(--border)" strokeDasharray={f === 0 ? undefined : '2 2'} />
              <text x={30} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-muted)">
                {val}
              </text>
            </g>
          );
        })}

        {bins.map((b, i) => {
          const bx = 45 + i * (barW + gap);
          const h = (b.count / maxCount) * chartH;
          const color =
            i === 0
              ? 'var(--status-good)'
              : i === 1
              ? 'var(--series-1)'
              : i === 2
              ? 'var(--series-2)'
              : 'var(--status-critical)';

          return (
            <g key={b.range}>
              <rect x={bx} y={baseY - h} width={barW} height={Math.max(2, h)} rx={3} fill={color} />
              <text x={bx + barW / 2} y={baseY - h - 4} textAnchor="middle" fontSize={9} fill="var(--text-primary)" fontWeight={600}>
                {b.count}
              </text>
              <text x={bx + barW / 2} y={baseY + 15} textAnchor="middle" fontSize={9} fill="var(--text-secondary)">
                {b.range}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ComplexityBarChart({ profiles }: { profiles: ConformanceProfile[] }) {
  const maxCount = Math.max(...profiles.flatMap((p) => [p.complexity.places, p.complexity.transitions, p.complexity.arcs]), 10);
  const chartH = 100;
  const baseY = 115;
  const barW = 12;
  const gap = 4;
  const seriesCount = 3;
  const groupW = seriesCount * barW + (seriesCount - 1) * gap;
  const groupSpacing = 110;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(380, 40 + profiles.length * groupSpacing)} height={150} style={{ display: 'block', margin: '0 auto' }}>
        {profiles.map((p, pi) => {
          const gx = 50 + pi * groupSpacing;
          const stats = [
            { key: 'p', label: 'P', val: p.complexity.places, color: 'var(--series-1)' },
            { key: 't', label: 'T', val: p.complexity.transitions, color: 'var(--status-good)' },
            { key: 'a', label: 'A', val: p.complexity.arcs, color: 'var(--series-2)' },
          ];

          return (
            <g key={p.algorithmId}>
              {stats.map((s, si) => {
                const h = (s.val / maxCount) * chartH;
                const bx = gx + si * (barW + gap);
                return (
                  <g key={s.key}>
                    <rect x={bx} y={baseY - h} width={barW} height={Math.max(2, h)} rx={2} fill={s.color} />
                    <text x={bx + barW / 2} y={baseY - h - 3} textAnchor="middle" fontSize={8} fill="var(--text-secondary)">
                      {s.val}
                    </text>
                  </g>
                );
              })}
              <text x={gx + groupW / 2} y={baseY + 16} textAnchor="middle" fontSize={9} fill="var(--text-primary)" fontWeight={600}>
                {p.algorithmName}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="row" style={{ gap: 12, justifyContent: 'center', fontSize: 10 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--series-1)', borderRadius: 2, marginRight: 3 }} /> Places (P)</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--status-good)', borderRadius: 2, marginRight: 3 }} /> Transitions (T)</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--series-2)', borderRadius: 2, marginRight: 3 }} /> Arcs (A)</span>
      </div>
    </div>
  );
}

function FootprintHeat({
  matrix,
  other,
  activities,
}: {
  matrix: Record<string, Record<string, OrderingRelation>>;
  other: Record<string, Record<string, OrderingRelation>>;
  activities: string[];
}) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
      <table className="data" style={{ fontSize: 11, fontFamily: 'monospace', borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ background: 'var(--surface-2)' }}>
            <th style={{ padding: '6px 8px', textAlign: 'left' }}> </th>
            {activities.map((a) => (
              <th key={a} title={a} style={{ padding: '6px 4px' }}>
                {a.slice(0, 3)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {activities.map((row) => (
            <tr key={row}>
              <td style={{ padding: '4px 8px', fontWeight: 600 }} title={row}>
                {row.slice(0, 8)}
              </td>
              {activities.map((col) => {
                const rel = matrix[row]?.[col] ?? '#';
                const diff = (other[row]?.[col] ?? '#') !== rel;
                return (
                  <td
                    key={col}
                    title={`${row} ${rel} ${col}`}
                    style={{
                      textAlign: 'center',
                      padding: '4px 2px',
                      background: diff ? 'rgba(235, 104, 52, 0.22)' : undefined,
                      fontWeight: diff ? 700 : 400,
                      color: diff ? 'var(--status-warning)' : undefined,
                    }}
                  >
                    {relSymbol(rel)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EdgeList({ edges, empty }: { edges: OverlayEdge[]; empty: string }) {
  if (edges.length === 0) return <div className="small muted">{empty}</div>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
      {edges.slice(0, 24).map((e) => (
        <li key={`${e.from}->${e.to}`}>
          <code>
            {e.from} → {e.to}
          </code>
          {e.logCount > 0 ? <span className="muted"> · {e.logCount}× in event log</span> : null}
        </li>
      ))}
    </ul>
  );
}

function OverlayGraph({
  activities,
  edges,
  traces,
}: {
  activities: string[];
  edges: OverlayEdge[];
  traces: string[][];
}) {
  const layout = useMemo(() => layoutActivities(activities, traces), [activities, traces]);
  const width = Math.max(640, layout.width);
  const height = Math.max(280, layout.height);

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface-2)' }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        <defs>
          <marker id="arr-both" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--status-good)" />
          </marker>
          <marker id="arr-log" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--status-critical)" />
          </marker>
          <marker id="arr-model" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--series-1)" />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = layout.pos.get(e.from);
          const b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const self = e.from === e.to;
          const stroke =
            e.kind === 'both' ? 'var(--status-good)' : e.kind === 'log_only' ? 'var(--status-critical)' : 'var(--series-1)';
          const marker =
            e.kind === 'both' ? 'url(#arr-both)' : e.kind === 'log_only' ? 'url(#arr-log)' : 'url(#arr-model)';
          const dash = e.kind === 'model_only' ? '6 4' : e.kind === 'log_only' ? '2 3' : undefined;
          const widthStroke = e.kind === 'both' ? 2.4 : 2;
          if (self) {
            return (
              <path
                key={`${e.from}-self`}
                d={`M ${a.x + 18} ${a.y - 16} C ${a.x + 40} ${a.y - 52}, ${a.x - 40} ${a.y - 52}, ${a.x - 18} ${a.y - 16}`}
                fill="none"
                stroke={stroke}
                strokeWidth={widthStroke}
                strokeDasharray={dash}
                markerEnd={marker}
              />
            );
          }
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = dx / len;
          const ny = dy / len;
          const x1 = a.x + nx * 36;
          const y1 = a.y + ny * 18;
          const x2 = b.x - nx * 36;
          const y2 = b.y - ny * 18;
          const curve = e.kind === 'model_only' ? 18 : e.kind === 'log_only' ? -14 : 0;
          const cx = (x1 + x2) / 2 + (-ny) * curve;
          const cy = (y1 + y2) / 2 + nx * curve;
          return (
            <g key={`${e.from}->${e.to}-${e.kind}`}>
              <path
                d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                fill="none"
                stroke={stroke}
                strokeWidth={widthStroke}
                strokeDasharray={dash}
                markerEnd={marker}
              />
              {e.logCount > 0 ? (
                <text x={cx} y={cy - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                  {e.logCount}
                </text>
              ) : null}
            </g>
          );
        })}
        {activities.map((act) => {
          const p = layout.pos.get(act);
          if (!p) return null;
          return (
            <g key={act}>
              <rect x={p.x - 48} y={p.y - 16} width={96} height={32} rx={6} fill="var(--surface-1)" stroke="var(--border-strong)" />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fill="var(--text-primary)">
                {act.length > 14 ? `${act.slice(0, 13)}…` : act}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function layoutActivities(activities: string[], traces: string[][]) {
  const firstIndex = new Map<string, number>();
  for (const t of traces) {
    t.forEach((a, i) => {
      const prev = firstIndex.get(a);
      if (prev === undefined || i < prev) firstIndex.set(a, i);
    });
  }
  const colGap = 150;
  const rowGap = 90;
  const cols = Math.max(3, Math.min(5, activities.length));
  const pos = new Map<string, { x: number; y: number }>();
  const ordered = [...activities].sort((a, b) => (firstIndex.get(a) ?? 99) - (firstIndex.get(b) ?? 99) || a.localeCompare(b));
  ordered.forEach((act, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    pos.set(act, { x: 80 + col * colGap, y: 70 + row * rowGap });
  });
  const rows = Math.ceil(ordered.length / cols);
  return { pos, width: 80 + cols * colGap, height: 90 + rows * rowGap };
}

function relSymbol(rel: OrderingRelation): string {
  switch (rel) {
    case '->':
      return '→';
    case '<-':
      return '←';
    case '||':
      return '‖';
    case 'L1L':
      return '⟲';
    case 'L2L':
      return '⇄';
    default:
      return '#';
  }
}
