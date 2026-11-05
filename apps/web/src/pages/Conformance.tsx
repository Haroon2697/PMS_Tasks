/**
 * Process Conformance — token replay and causal-footprint checking.
 *
 * This is not another algorithm-feature table. The log and each discovered
 * process are drawn on the same graph: edges that exist in both are conforming,
 * log-only edges are fitness defects, model-only edges are extra process
 * behaviour. Token replay colours each event in each case. The causal
 * footprint heatmap shows the Hamming mismatch cell by cell.
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
import { pct } from '../lib/format';

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
    description: 'Every vehicle follows Body Shop → Paint → Assembly → Dispatch. Log and model should overlay closely.',
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
    description: 'Some cars loop Inspection ⇄ Rework. Token replay and footprints diverge across Alpha vs Alpha+ vs IM.',
    traces: [
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Rework', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Dispatch'],
      ['Body Shop', 'Paint', 'Assembly', 'Inspection', 'Rework', 'Inspection', 'Rework', 'Inspection', 'Dispatch'],
    ],
  },
  {
    id: 'deviations',
    name: '3. Deviating log (skips, extras, order)',
    description: 'Same intended process, messy log: skipped Paint, repeated Paint, and a Dispatch-before-Paint case. Overlay should light up log-only edges.',
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
    name: '4. Concurrent chassis / wiring',
    description: 'Log interleaves Chassis and Wiring. Footprint should show ‖ in the log; models that force a sequence will conflict.',
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
  const [view, setView] = useState<'overlay' | 'replay' | 'footprint' | 'compare'>('overlay');
  const [selectedCase, setSelectedCase] = useState(0);

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
      console.error(err);
      return null;
    }
  }, [traces]);

  const profile = comparison?.profiles.find((p) => p.algorithmId === miner) ?? comparison?.profiles[0];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="page-intro" style={{ margin: 0 }}>
        <strong>Process conformance</strong> checks whether the event log and the discovered process
        tell the same story. Token replay walks each case on the Petri net. Causal-footprint
        conformance compares the log’s ordering matrix with the model’s. The graph below is the
        comparison: green edges are in both log and process, red are only in the log, dashed blue
        are only in the model.
      </p>

      <Card title="Log under test" hint="Same traces are discovered by Alpha, Alpha+ and Inductive Miner, then checked for conformance.">
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
              Active event log ({eventLog.caseIds.length} cases)
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
            Custom traces
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
              {useActiveLog ? `Active log: ${eventLogSource ?? 'imported'}` : PRESETS.find((p) => p.id === presetId)?.name}
            </div>
            <div className="muted">
              {useActiveLog
                ? `${eventLog?.rows.length} events · ${eventLog?.caseIds.length} cases`
                : PRESETS.find((p) => p.id === presetId)?.description}
            </div>
            <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
              {traces.slice(0, 3).map((t) => t.join(' → ')).join('   |   ')}
              {traces.length > 3 ? `  (+${traces.length - 3} more)` : ''}
            </div>
          </div>
        )}
      </Card>

      {!comparison || !profile ? (
        <EmptyState>No traces to check. Enter at least one case.</EmptyState>
      ) : (
        <>
          {comparison.warnings.length > 0 ? (
            <Notice kind="info" title="Sample size">
              {comparison.warnings.join(' ')}
            </Notice>
          ) : null}

          <div className="grid cols-4">
            <Kpi
              label="Token-replay fitness"
              value={pct(profile.token.fitness)}
              basis="derived"
              status={profile.token.fitness >= 0.9 ? 'good' : profile.token.fitness >= 0.7 ? 'warning' : 'critical'}
              sub={`${profile.token.fittingTraces}/${profile.token.totalTraces} traces fit · missing ${profile.token.missing} · remaining ${profile.token.remaining}`}
            />
            <Kpi
              label="Footprint similarity"
              value={pct(profile.footprint.similarity)}
              basis="derived"
              status={profile.footprint.similarity >= 0.9 ? 'good' : profile.footprint.similarity >= 0.7 ? 'warning' : 'serious'}
              sub={`${profile.footprint.mismatches} Hamming mismatches of ${profile.footprint.comparedCells} cells`}
            />
            <Kpi
              label="Footprint fitness / precision"
              value={`${pct(profile.footprint.fitness)} / ${pct(profile.footprint.precision)}`}
              basis="derived"
              sub="Log relations covered by the model  ·  model relations observed in the log"
            />
            <Kpi
              label="Overlay edges"
              value={`${profile.overlay.filter((e) => e.kind === 'both').length} both`}
              basis="derived"
              sub={`${profile.overlay.filter((e) => e.kind === 'log_only').length} log-only · ${profile.overlay.filter((e) => e.kind === 'model_only').length} model-only`}
            />
          </div>

          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {(
                [
                  ['alpha', 'Alpha (α)'],
                  ['alpha_plus', 'Alpha Plus (α⁺)'],
                  ['inductive_miner', 'Inductive Miner'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={`btn sm ${miner === id ? 'primary' : ''}`} onClick={() => setMiner(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className={`btn sm ${view === 'overlay' ? 'primary' : ''}`} onClick={() => setView('overlay')}>
                Log ⟷ process graph
              </button>
              <button className={`btn sm ${view === 'replay' ? 'primary' : ''}`} onClick={() => setView('replay')}>
                Token replay
              </button>
              <button className={`btn sm ${view === 'footprint' ? 'primary' : ''}`} onClick={() => setView('footprint')}>
                Causal footprint
              </button>
              <button className={`btn sm ${view === 'compare' ? 'primary' : ''}`} onClick={() => setView('compare')}>
                Three-miner scores
              </button>
            </div>
          </div>

          {view === 'overlay' && (
            <>
              <Card
                title={`Directly-follows overlay — log vs ${profile.algorithmName}`}
                hint="Nodes are activities. Edge colour is the comparison: both (conforming), log-only (the process cannot explain this succession), model-only (the process allows a succession the log never used)."
              >
                <OverlayGraph activities={profile.activities} edges={profile.overlay} traces={traces} />
                <div className="row" style={{ gap: 16, marginTop: 10, fontSize: 11, flexWrap: 'wrap' }}>
                  <span><span className="conf-swatch both" /> In log and in process</span>
                  <span><span className="conf-swatch log" /> In log only — fitness defect</span>
                  <span><span className="conf-swatch model" /> In process only — extra behaviour</span>
                </div>
              </Card>
              <div className="grid cols-2">
                <Card title="Log-only successions" hint="Observed in traces, missing from the Petri net DFG.">
                  <EdgeList edges={profile.overlay.filter((e) => e.kind === 'log_only')} empty="None — every logged succession is in the process." />
                </Card>
                <Card title="Model-only successions" hint="Allowed by the net, never seen in this log.">
                  <EdgeList edges={profile.overlay.filter((e) => e.kind === 'model_only')} empty="None — the process does not add unused routes on this sample." />
                </Card>
              </div>
            </>
          )}

          {view === 'replay' && (
            <ReplayPanel profile={profile} selectedCase={selectedCase} setSelectedCase={setSelectedCase} />
          )}

          {view === 'footprint' && <FootprintPanel profile={profile} />}

          {view === 'compare' && <ComparePanel profiles={comparison.profiles} />}

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => navigate('alphacompare')}>
                ← Discovery algorithms
              </button>
              <button className="btn" onClick={() => navigate('eventlog')}>
                Event log
              </button>
            </div>
            <span className="small muted">Token replay + causal footprint · log vs process graph</span>
          </div>
        </>
      )}
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
          {e.logCount > 0 ? <span className="muted"> · {e.logCount}× in log</span> : null}
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

function ReplayPanel({
  profile,
  selectedCase,
  setSelectedCase,
}: {
  profile: ConformanceProfile;
  selectedCase: number;
  setSelectedCase: (n: number) => void;
}) {
  const replay = profile.token.traces[Math.min(selectedCase, profile.token.traces.length - 1)];
  return (
    <>
      <Card
        title={`Token replay on ${profile.algorithmName}`}
        hint="Each case is fired on the Petri net. Green events consumed a token; red events had to invent a missing token; amber events are not in the model."
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Case</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Trace (coloured by replay)</th>
                <th style={{ padding: '6px 8px' }}>Fitness</th>
                <th style={{ padding: '6px 8px' }}>m / r</th>
              </tr>
            </thead>
            <tbody>
              {profile.token.traces.map((t) => (
                <tr
                  key={t.caseIndex}
                  onClick={() => setSelectedCase(t.caseIndex)}
                  style={{
                    cursor: 'pointer',
                    background: t.caseIndex === selectedCase ? 'color-mix(in srgb, var(--series-1) 10%, transparent)' : undefined,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <td style={{ padding: '8px' }}>#{t.caseIndex + 1}</td>
                  <td style={{ padding: '8px' }}>
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {t.steps.map((s, i) => (
                        <span key={i} className={`conf-event ${s.status}`}>
                          {s.activity}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ textAlign: 'center', padding: '8px', fontWeight: 600 }}>{pct(t.fitness)}</td>
                  <td style={{ textAlign: 'center', padding: '8px' }}>
                    {t.missing} / {t.remaining}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {replay ? (
        <Card title={`Case #${replay.caseIndex + 1} step log`} hint="Produced / consumed / missing / remaining follow the standard token-based fitness formula.">
          <div className="small muted" style={{ marginBottom: 8 }}>
            f = 0.5·(1 − {replay.missing}/{replay.consumed}) + 0.5·(1 − {replay.remaining}/{replay.produced}) = {pct(replay.fitness)}
            {replay.perfectlyFitting ? ' · perfectly fitting' : ''}
          </div>
          <DataTable
            rows={replay.steps}
            rowKey={(s) => `${s.index}_${s.activity}`}
            columns={[
              { key: 'i', header: '#', render: (s) => String(s.index + 1) },
              { key: 'a', header: 'Activity', align: 'left', render: (s) => s.activity },
              {
                key: 'st',
                header: 'Replay',
                align: 'left',
                render: (s) => (
                  <span className={`conf-event ${s.status}`}>
                    {s.status === 'ok' ? 'enabled' : s.status === 'missing' ? `missing ${s.missingInputs} token(s)` : 'not in model'}
                  </span>
                ),
              },
              {
                key: 'tau',
                header: 'Silent firings',
                align: 'left',
                render: (s) => (s.silentFirings.length ? s.silentFirings.join(', ') : '—'),
              },
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}

function FootprintPanel({ profile }: { profile: ConformanceProfile }) {
  const acts = profile.footprint.logFootprint.activities;
  return (
    <>
      <Card
        title="Causal footprint: log matrix vs process matrix"
        hint="Each cell is an Alpha-style relation (→ ‖ # ⟲). Orange cells differ. Hamming similarity is 1 − mismatches / n²."
      >
        <div className="grid cols-2">
          <div>
            <h4 style={{ margin: '0 0 6px', fontSize: 12 }}>Log footprint</h4>
            <FootprintHeat
              matrix={profile.footprint.logFootprint.relations}
              other={profile.footprint.modelFootprint.relations}
              activities={acts}
            />
          </div>
          <div>
            <h4 style={{ margin: '0 0 6px', fontSize: 12 }}>Process footprint (from Petri net DFG)</h4>
            <FootprintHeat
              matrix={profile.footprint.modelFootprint.relations}
              other={profile.footprint.logFootprint.relations}
              activities={acts}
            />
          </div>
        </div>
      </Card>
      <Card title="Mismatched relations" hint="Fitness defects: the log observed an order the process does not allow. Precision defects: the process allows an order the log never used. Conflicts: both sides are active but disagree (e.g. → vs ‖).">
        {profile.footprint.diffs.length === 0 ? (
          <div className="small muted">Log footprint and process footprint are identical on this sample.</div>
        ) : (
          <DataTable
            rows={profile.footprint.diffs}
            rowKey={(d) => `${d.a}_${d.b}_${d.kind}`}
            columns={[
              {
                key: 'k',
                header: 'Kind',
                align: 'left',
                render: (d) => <span className={`badge ${d.kind === 'fitness_defect' ? 'sim' : ''}`}>{d.kind.replace('_', ' ')}</span>,
              },
              {
                key: 'p',
                header: 'Pair',
                align: 'left',
                render: (d) => (
                  <code>
                    {d.a} × {d.b}
                  </code>
                ),
              },
              { key: 'l', header: 'Log', render: (d) => relSymbol(d.logRelation) },
              { key: 'm', header: 'Process', render: (d) => relSymbol(d.modelRelation) },
            ]}
          />
        )}
      </Card>
    </>
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
                      background: diff ? 'rgba(235, 104, 52, 0.18)' : undefined,
                      fontWeight: diff ? 700 : 400,
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

function ComparePanel({ profiles }: { profiles: ConformanceProfile[] }) {
  const metrics: { key: string; label: string; pick: (p: ConformanceProfile) => number }[] = [
    { key: 'tf', label: 'Token-replay fitness', pick: (p) => p.token.fitness },
    { key: 'fs', label: 'Footprint similarity', pick: (p) => p.footprint.similarity },
    { key: 'ff', label: 'Footprint fitness', pick: (p) => p.footprint.fitness },
    { key: 'fp', label: 'Footprint precision', pick: (p) => p.footprint.precision },
    { key: 'fit', label: 'Share of fitting traces', pick: (p) => (p.token.totalTraces ? p.token.fittingTraces / p.token.totalTraces : 0) },
  ];

  return (
    <Card
      title="Three miners on the same log"
      hint="Scores are computed from this log against each discovered Petri net — not copied from the algorithm comparison table."
    >
      <div style={{ overflowX: 'auto' }}>
        <svg width={Math.max(560, 80 + metrics.length * 140)} height={220} style={{ display: 'block' }}>
          {metrics.map((m, i) => {
            const x = 70 + i * 140;
            return (
              <g key={m.key}>
                <line x1={x - 20} y1={20} x2={x - 20} y2={160} stroke="var(--border)" />
                {[0, 0.5, 1].map((t) => (
                  <text key={t} x={x - 24} y={160 - t * 140 + 4} textAnchor="end" fontSize={9} fill="var(--text-muted)">
                    {t === 0 ? '0' : t === 1 ? '1' : '.5'}
                  </text>
                ))}
                {profiles.map((p, pi) => {
                  const v = m.pick(p);
                  const bw = 18;
                  const gap = 6;
                  const bx = x + pi * (bw + gap);
                  const h = v * 140;
                  const color = pi === 0 ? 'var(--status-critical)' : pi === 1 ? 'var(--series-1)' : 'var(--status-good)';
                  return <rect key={p.algorithmId} x={bx} y={160 - h} width={bw} height={h} rx={2} fill={color} />;
                })}
                <text x={x + 28} y={190} textAnchor="middle" fontSize={10} fill="var(--text-secondary)">
                  {m.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="row" style={{ gap: 16, fontSize: 11, marginBottom: 10 }}>
        <span><span className="conf-swatch log" /> Alpha</span>
        <span><span className="conf-swatch model" /> Alpha Plus</span>
        <span><span className="conf-swatch both" /> Inductive Miner</span>
      </div>
      <table className="table" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--surface-2)' }}>
            <th style={{ textAlign: 'left', padding: '8px 10px' }}>Miner</th>
            {metrics.map((m) => (
              <th key={m.key} style={{ padding: '8px 10px' }}>
                {m.label}
              </th>
            ))}
            <th style={{ padding: '8px 10px' }}>Sound</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => (
            <tr key={p.algorithmId} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 10px', fontWeight: 600 }}>{p.algorithmName}</td>
              {metrics.map((m) => (
                <td key={m.key} style={{ textAlign: 'center', padding: '8px 10px' }}>
                  {pct(m.pick(p))}
                </td>
              ))}
              <td style={{ textAlign: 'center', padding: '8px 10px' }}>{p.isSound ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
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
