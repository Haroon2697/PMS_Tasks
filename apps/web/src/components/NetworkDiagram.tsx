/**
 * Interactive network diagram — requirement 37.
 *
 * Each node shows the station's name, Kendall notation, server count, derived
 * lambda, mu, utilisation, queue length, Wq and cost per hour. Clicking a node
 * opens its configuration panel. Edges carry their routing probability, and the
 * rework and scrap arcs are drawn distinctly because they are what make the
 * network a network rather than a line.
 *
 * LAYOUT. Positions are computed, not hardcoded, so the diagram still reads
 * correctly when the user adds or removes stations. Nodes are assigned a level
 * by breadth-first search from the entry point along FORWARD edges only; back
 * edges (the rework return) are excluded from level assignment and then drawn
 * as curves beneath the row, which is what keeps the feedback loop visible
 * instead of tangled in the main flow. Levels wrap into rows, snaking so the
 * flow reads left-to-right then right-to-left.
 */

import { SINK_FINISHED, SINK_SCRAP, type StationAnalytic, type SystemModel } from '@vmq/engine';
import { useMemo } from 'react';
import { num, pct, utilisationStatus } from '../lib/format';

const NODE_W = 184;
const NODE_H = 104;
const COL_GAP = 64;
const ROW_GAP = 74;
const COLS = 4;

interface Placed {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  level: number;
  isSink: boolean;
}

function layout(model: SystemModel): { nodes: Placed[]; width: number; height: number } {
  const level = new Map<string, number>();
  const entry = model.arrivals.entryStationId;
  const queue: string[] = [entry];
  level.set(entry, 0);

  // Forward BFS. A node keeps the SMALLEST level that reaches it, so the
  // rework return arc cannot push inspection further down the chain.
  while (queue.length) {
    const id = queue.shift() as string;
    const st = model.stations.find((s) => s.id === id);
    if (!st) continue;
    const lv = level.get(id) as number;
    for (const e of st.routing) {
      if (e.probability <= 0) continue;
      if (e.to === SINK_FINISHED || e.to === SINK_SCRAP) continue;
      const existing = level.get(e.to);
      if (existing === undefined) {
        level.set(e.to, lv + 1);
        queue.push(e.to);
      }
    }
  }

  // Unreachable stations still need a place on the canvas.
  let maxLevel = 0;
  for (const v of level.values()) maxLevel = Math.max(maxLevel, v);
  for (const s of model.stations) {
    if (!level.has(s.id)) level.set(s.id, ++maxLevel);
  }

  const ordered = [...model.stations].sort(
    (a, b) => (level.get(a.id) as number) - (level.get(b.id) as number),
  );

  const hasFinished = model.stations.some((s) =>
    s.routing.some((e) => e.to === SINK_FINISHED && e.probability > 0),
  );
  const hasScrap =
    model.stations.some((s) => s.routing.some((e) => e.to === SINK_SCRAP && e.probability > 0)) ||
    model.stations.some((s) => s.scrapProbability > 0);

  const nodes: Placed[] = [];
  ordered.forEach((s, i) => {
    const row = Math.floor(i / COLS);
    const colRaw = i % COLS;
    const col = row % 2 === 0 ? colRaw : COLS - 1 - colRaw; // snake
    nodes.push({
      id: s.id,
      name: s.name,
      kind: s.kind,
      x: col * (NODE_W + COL_GAP),
      y: row * (NODE_H + ROW_GAP),
      level: level.get(s.id) as number,
      isSink: false,
    });
  });

  let sinkIndex = ordered.length;
  const addSink = (id: string, name: string) => {
    const row = Math.floor(sinkIndex / COLS);
    const colRaw = sinkIndex % COLS;
    const col = row % 2 === 0 ? colRaw : COLS - 1 - colRaw;
    nodes.push({
      id,
      name,
      kind: 'sink',
      x: col * (NODE_W + COL_GAP),
      y: row * (NODE_H + ROW_GAP),
      level: maxLevel + 1,
      isSink: true,
    });
    sinkIndex++;
  };
  if (hasFinished) addSink(SINK_FINISHED, 'Finished Vehicle');
  if (hasScrap) addSink(SINK_SCRAP, 'Scrapped');

  const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_W;
  const maxY = Math.max(...nodes.map((n) => n.y)) + NODE_H;
  return { nodes, width: maxX + 24, height: maxY + 40 };
}

export function NetworkDiagram({
  model,
  analytical,
  selectedId,
  onSelect,
  bottleneckId,
}: {
  model: SystemModel;
  analytical: StationAnalytic[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  bottleneckId: string | null;
}) {
  const { nodes, width, height } = useMemo(() => layout(model), [model]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const analyticById = new Map(analytical.map((a) => [a.stationId, a]));

  const edges: {
    from: Placed;
    to: Placed;
    probability: number;
    label: string;
    kind: 'forward' | 'back' | 'scrap';
  }[] = [];

  for (const st of model.stations) {
    const from = byId.get(st.id);
    if (!from) continue;
    for (const e of st.routing) {
      if (e.probability <= 0) continue;
      const to = byId.get(e.to);
      if (!to) continue;
      const kind =
        e.to === SINK_SCRAP ? 'scrap' : to.level <= from.level && !to.isSink ? 'back' : 'forward';
      edges.push({
        from,
        to,
        probability: e.probability,
        label: e.label ?? '',
        kind,
      });
    }
  }

  return (
    <div className="network-wrap">
      <svg
        className="chart"
        viewBox={`-12 -24 ${width + 24} ${height + 32}`}
        style={{ minWidth: Math.min(width, 1400) }}
        role="img"
        aria-label="Manufacturing network diagram"
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--axis)" />
          </marker>
          <marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--status-serious)" />
          </marker>
          <marker id="arrow-scrap" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--status-critical)" />
          </marker>
        </defs>

        {edges.map((e, i) => {
          const path = edgePath(e.from, e.to, e.kind);
          const mid = edgeMidpoint(e.from, e.to, e.kind);
          return (
            <g key={`${e.from.id}-${e.to.id}-${i}`}>
              <path
                className={`edge${e.kind === 'back' ? ' rework' : e.kind === 'scrap' ? ' scrap' : ''}`}
                d={path}
                markerEnd={`url(#${e.kind === 'back' ? 'arrow-back' : e.kind === 'scrap' ? 'arrow-scrap' : 'arrow'})`}
              />
              {/*
                A same-row arc has only the column gap to write in, and a label
                like "100% · to powertrain" is far wider than that — it would be
                clipped by the node boxes drawn on top. Horizontal arcs
                therefore show the probability alone, with the full text in the
                hover title; arcs that travel between rows have the room.
              */}
              <text className="edge-label" x={mid.x} y={mid.y} textAnchor="middle">
                <title>
                  {pct(e.probability, 0)}
                  {e.label ? ` · ${e.label}` : ''}
                </title>
                {pct(e.probability, 0)}
                {e.kind !== 'forward' || Math.abs(e.from.y - e.to.y) > 1
                  ? e.label
                    ? ` · ${e.label}`
                    : ''
                  : ''}
              </text>
            </g>
          );
        })}

        {nodes.map((n) => {
          if (n.isSink) return <SinkNode key={n.id} node={n} />;
          const st = model.stations.find((s) => s.id === n.id);
          const a = analyticById.get(n.id);
          if (!st) return null;
          return (
            <StationNode
              key={n.id}
              node={n}
              kendall={a?.kendall ?? '—'}
              servers={st.servers}
              lambda={a?.lambda ?? 0}
              mu={a ? 60 / a.serviceMinutes : 0}
              rho={a?.rho ?? 0}
              lq={a?.Lq ?? 0}
              wq={a?.WqMinutes ?? 0}
              stable={a?.stable ?? true}
              isBottleneck={n.id === bottleneckId}
              selected={selectedId === n.id}
              onSelect={onSelect}
            />
          );
        })}
      </svg>
    </div>
  );
}

function StationNode({
  node,
  kendall,
  servers,
  lambda,
  mu,
  rho,
  lq,
  wq,
  stable,
  isBottleneck,
  selected,
  onSelect,
}: {
  node: Placed;
  kendall: string;
  servers: number;
  lambda: number;
  mu: number;
  rho: number;
  lq: number;
  wq: number;
  stable: boolean;
  isBottleneck: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const status = utilisationStatus(rho);
  const statusColor = {
    good: 'var(--series-1)',
    warning: 'var(--status-warning)',
    serious: 'var(--status-serious)',
    critical: 'var(--status-critical)',
  }[status];

  return (
    <g
      className={`node-box${selected ? ' selected' : ''}`}
      transform={`translate(${node.x},${node.y})`}
      onClick={() => onSelect(node.id)}
      role="button"
      tabIndex={0}
      aria-label={`${node.name}, ${kendall}, utilisation ${pct(rho)}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <rect
        className="body"
        width={NODE_W}
        height={NODE_H}
        rx={4}
        style={isBottleneck ? { stroke: 'var(--status-critical)', strokeWidth: 2 } : undefined}
      />
      <text className="title" x={9} y={16}>
        {node.name.length > 24 ? `${node.name.slice(0, 23)}…` : node.name}
      </text>
      <text className="meta" x={9} y={31}>
        {kendall} · c={servers}
      </text>
      <text className="meta" x={9} y={45}>
        λ {num(lambda, 2)}/h · μ {num(mu, 2)}/h
      </text>
      <text className="meta" x={9} y={59}>
        Lq {num(lq, 2)} · Wq {num(wq, 1)} min
      </text>

      <rect className="util-track" x={9} y={68} width={NODE_W - 18} height={7} rx={3} />
      <rect
        x={9}
        y={68}
        width={Math.max(0, Math.min(1, rho)) * (NODE_W - 18)}
        height={7}
        rx={3}
        fill={statusColor}
      />
      <text className="meta" x={9} y={91}>
        ρ {pct(rho)}
      </text>
      {isBottleneck ? (
        <text className="meta" x={NODE_W - 9} y={91} textAnchor="end" fill="var(--status-critical)">
          ▲ BOTTLENECK
        </text>
      ) : !stable ? (
        <text className="meta" x={NODE_W - 9} y={91} textAnchor="end" fill="var(--status-critical)">
          ▲ UNSTABLE
        </text>
      ) : null}
    </g>
  );
}

function SinkNode({ node }: { node: Placed }) {
  const scrap = node.id === SINK_SCRAP;
  return (
    <g transform={`translate(${node.x},${node.y})`}>
      <rect
        width={NODE_W}
        height={44}
        rx={4}
        fill="var(--surface-2)"
        stroke={scrap ? 'var(--status-critical)' : 'var(--status-good)'}
        strokeWidth={1.5}
      />
      <text
        x={NODE_W / 2}
        y={27}
        textAnchor="middle"
        style={{ fontWeight: 600, fontSize: 12 }}
        fill={scrap ? 'var(--status-critical)' : 'var(--status-good-text)'}
      >
        {node.name}
      </text>
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Edge geometry                                                       */
/* ------------------------------------------------------------------ */

function anchors(from: Placed, to: Placed) {
  const fh = from.isSink ? 44 : NODE_H;
  const th = to.isSink ? 44 : NODE_H;
  const fc = { x: from.x + NODE_W / 2, y: from.y + fh / 2 };
  const tc = { x: to.x + NODE_W / 2, y: to.y + th / 2 };
  return { fc, tc, fh, th };
}

function edgePath(from: Placed, to: Placed, kind: 'forward' | 'back' | 'scrap'): string {
  const { fc, tc, fh, th } = anchors(from, to);

  if (kind === 'back') {
    // Route the feedback arc below both nodes so it never crosses the main flow.
    const dip = Math.max(from.y + fh, to.y + th) + 34;
    return `M ${fc.x} ${from.y + fh} C ${fc.x} ${dip}, ${tc.x} ${dip}, ${tc.x} ${to.y + th}`;
  }

  const sameRow = Math.abs(from.y - to.y) < 1;
  if (sameRow) {
    const goingRight = tc.x > fc.x;
    const x1 = goingRight ? from.x + NODE_W : from.x;
    const x2 = goingRight ? to.x : to.x + NODE_W;

    // An arc that skips a column would otherwise be drawn straight THROUGH the
    // node sitting between its endpoints — which is what the inspection-to-sink
    // arcs do when Rework sits between them. Route those over the top of the
    // row instead, so no arc is ever hidden behind a box.
    if (skipsAColumn(from, to)) {
      const lift = from.y - 26;
      return `M ${fc.x} ${from.y} C ${fc.x} ${lift}, ${tc.x} ${lift}, ${tc.x} ${to.y}`;
    }
    return `M ${x1} ${fc.y} L ${x2} ${tc.y}`;
  }

  // Different rows: leave the bottom of the source, enter the top of the target.
  const y1 = from.y + fh;
  const y2 = to.y;
  const midY = (y1 + y2) / 2;
  return `M ${fc.x} ${y1} C ${fc.x} ${midY}, ${tc.x} ${midY}, ${tc.x} ${y2}`;
}

function edgeMidpoint(from: Placed, to: Placed, kind: 'forward' | 'back' | 'scrap') {
  const { fc, tc, fh, th } = anchors(from, to);
  if (kind === 'back') {
    return { x: (fc.x + tc.x) / 2, y: Math.max(from.y + fh, to.y + th) + 46 };
  }
  const sameRow = Math.abs(from.y - to.y) < 1;
  if (sameRow) {
    if (skipsAColumn(from, to)) return { x: (fc.x + tc.x) / 2, y: from.y - 30 };
    return { x: (fc.x + tc.x) / 2, y: fc.y - 7 };
  }
  return { x: (fc.x + tc.x) / 2, y: (from.y + fh + to.y) / 2 + 4 };
}

/** True when a same-row arc passes over at least one intervening node. */
function skipsAColumn(from: Placed, to: Placed): boolean {
  return Math.abs(to.x - from.x) > NODE_W + COL_GAP + 1;
}
