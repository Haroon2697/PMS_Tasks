/**
 * Charts.
 *
 * Built as plain inline SVG rather than with a charting library, so the mark
 * specs can be met exactly: thin marks, 4px rounded data-ends anchored to the
 * baseline, solid hairline gridlines, a 2px surface gap between adjacent fills,
 * selective direct labels rather than a number on every mark, and a hover
 * layer on every chart that plots anything.
 *
 * Colour rules followed here:
 *  - a single-series chart uses ONE colour (categorical slot 1) for every mark;
 *    bar length already encodes magnitude, so shading bars by value would
 *    double-encode it and burn the only free channel;
 *  - categorical hues are assigned by a stable entity key, never by position in
 *    the current list, so filtering never repaints the series that remain;
 *  - status colours (good/warning/serious/critical) are used only where the
 *    colour genuinely means a state, and always alongside a text label.
 *
 * There are no dual-axis charts anywhere in this application.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { num } from '../lib/format';

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

interface TooltipState {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string }[];
}

function useTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const show = useCallback(
    (e: { clientX: number; clientY: number }, title: string, rows: { label: string; value: string }[]) => {
      setTip({ x: e.clientX, y: e.clientY, title, rows });
    },
    [],
  );
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? (
    <div
      className="tooltip"
      style={{
        // Flip to the other side near the viewport edge so the tooltip is
        // never clipped by the window.
        left: Math.min(tip.x + 12, window.innerWidth - 292),
        top: Math.min(tip.y + 12, window.innerHeight - 110),
      }}
    >
      <div className="t-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div className="t-row" key={r.label}>
          <span>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { show, hide, node };
}

/* ------------------------------------------------------------------ */
/* Horizontal bar chart — one series                                   */
/* ------------------------------------------------------------------ */

export interface BarDatum {
  /** Stable identity key. Colour and ordering follow this, never the index. */
  key: string;
  label: string;
  value: number;
  /** Overrides the single-series colour where the colour means a STATE. */
  color?: string;
  /** Extra rows shown in the tooltip. */
  detail?: { label: string; value: string }[];
  /** Text drawn at the end of the bar. */
  valueLabel?: string;
}

export function HorizontalBars({
  data,
  unit,
  max,
  labelWidth = 150,
  barHeight = 18,
  gap = 8,
  reference,
  formatValue,
  onSelect,
  selectedKey,
}: {
  data: BarDatum[];
  unit: string;
  /** Fixed axis maximum; defaults to the largest value. */
  max?: number;
  labelWidth?: number;
  barHeight?: number;
  gap?: number;
  /** A vertical reference line, e.g. capacity or a target. */
  reference?: { value: number; label: string };
  formatValue?: (v: number) => string;
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
}) {
  const { show, hide, node } = useTooltip();
  const fmt = formatValue ?? ((v: number) => num(v, 2));

  const plotLeft = labelWidth + 8;
  const plotRight = 56; // room for the direct value label at the bar end
  const width = 720;
  const plotWidth = width - plotLeft - plotRight;
  const height = data.length * (barHeight + gap) + 26;

  const domainMax = Math.max(max ?? 0, ...data.map((d) => d.value), reference?.value ?? 0, 1e-9);
  const x = (v: number) => (v / domainMax) * plotWidth;

  const ticks = niceTicks(0, domainMax, 5);

  return (
    <div>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={`Bar chart, values in ${unit}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="gridline"
              x1={plotLeft + x(t)}
              x2={plotLeft + x(t)}
              y1={0}
              y2={height - 22}
            />
            <text x={plotLeft + x(t)} y={height - 8} textAnchor="middle">
              {num(t, t >= 10 ? 0 : 2)}
            </text>
          </g>
        ))}

        <line className="axis-line" x1={plotLeft} x2={plotLeft} y1={0} y2={height - 22} />

        {data.map((d, i) => {
          const y = i * (barHeight + gap);
          const w = Math.max(0, x(d.value));
          const selected = selectedKey === d.key;
          return (
            <g
              key={d.key}
              style={onSelect ? { cursor: 'pointer' } : undefined}
              onClick={onSelect ? () => onSelect(d.key) : undefined}
              onMouseMove={(e) =>
                show(e, d.label, [
                  { label: unit, value: fmt(d.value) },
                  ...(d.detail ?? []),
                ])
              }
              onMouseLeave={hide}
            >
              <text
                className="mark-label"
                x={labelWidth}
                y={y + barHeight / 2 + 4}
                textAnchor="end"
                style={selected ? { fontWeight: 650 } : undefined}
              >
                {truncate(d.label, 24)}
              </text>
              {/* Full-width hit target: easier to hover than the bar itself. */}
              <rect x={plotLeft} y={y} width={plotWidth} height={barHeight} fill="transparent" />
              <rect
                x={plotLeft}
                y={y}
                width={w}
                height={barHeight}
                rx={4}
                fill={d.color ?? 'var(--series-1)'}
              />
              <text className="value-label" x={plotLeft + w + 6} y={y + barHeight / 2 + 4}>
                {d.valueLabel ?? fmt(d.value)}
              </text>
            </g>
          );
        })}

        {reference ? (
          <g>
            <line
              x1={plotLeft + x(reference.value)}
              x2={plotLeft + x(reference.value)}
              y1={0}
              y2={height - 22}
              stroke="var(--status-critical)"
              strokeWidth={2}
            />
            <text
              x={plotLeft + x(reference.value)}
              y={height - 8}
              textAnchor="middle"
              fill="var(--status-critical)"
            >
              {reference.label}
            </text>
          </g>
        ) : null}
      </svg>
      {node}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grouped bars — two series (baseline vs scenario)                    */
/* ------------------------------------------------------------------ */

export function GroupedBars({
  data,
  seriesA,
  seriesB,
  unit,
  formatValue,
}: {
  data: { key: string; label: string; a: number; b: number }[];
  seriesA: string;
  seriesB: string;
  unit: string;
  formatValue?: (v: number) => string;
}) {
  const { show, hide, node } = useTooltip();
  const fmt = formatValue ?? ((v: number) => num(v, 2));

  const labelWidth = 160;
  const plotLeft = labelWidth + 8;
  const plotRight = 64;
  const width = 720;
  const plotWidth = width - plotLeft - plotRight;
  const barH = 11;
  const groupGap = 14;
  const rowH = barH * 2 + 2 + groupGap; // 2px surface gap between the pair
  const height = data.length * rowH + 26;

  const domainMax = Math.max(...data.flatMap((d) => [d.a, d.b]), 1e-9);
  const x = (v: number) => (Math.max(0, v) / domainMax) * plotWidth;
  const ticks = niceTicks(0, domainMax, 5);

  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMin meet" role="img"
        aria-label={`Grouped bar chart comparing ${seriesA} and ${seriesB}, in ${unit}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={plotLeft + x(t)} x2={plotLeft + x(t)} y1={0} y2={height - 22} />
            <text x={plotLeft + x(t)} y={height - 8} textAnchor="middle">
              {num(t, t >= 10 ? 0 : 2)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={plotLeft} x2={plotLeft} y1={0} y2={height - 22} />

        {data.map((d, i) => {
          const y = i * rowH;
          return (
            <g
              key={d.key}
              onMouseMove={(e) =>
                show(e, d.label, [
                  { label: seriesA, value: fmt(d.a) },
                  { label: seriesB, value: fmt(d.b) },
                  { label: 'Change', value: `${d.b - d.a >= 0 ? '+' : ''}${fmt(d.b - d.a)}` },
                ])
              }
              onMouseLeave={hide}
            >
              <text className="mark-label" x={labelWidth} y={y + barH + 2} textAnchor="end">
                {truncate(d.label, 26)}
              </text>
              <rect x={plotLeft} y={y} width={plotWidth} height={barH * 2 + 2} fill="transparent" />
              <rect x={plotLeft} y={y} width={x(d.a)} height={barH} rx={4} fill="var(--series-1)" />
              <rect
                x={plotLeft}
                y={y + barH + 2}
                width={x(d.b)}
                height={barH}
                rx={4}
                fill="var(--series-2)"
              />
              <text className="value-label" x={plotLeft + Math.max(x(d.a), x(d.b)) + 6} y={y + barH + 2}>
                {fmt(d.b)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span className="item">
          <span className="swatch" style={{ background: 'var(--series-1)' }} /> {seriesA}
        </span>
        <span className="item">
          <span className="swatch" style={{ background: 'var(--series-2)' }} /> {seriesB}
        </span>
      </div>
      {node}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Histogram                                                           */
/* ------------------------------------------------------------------ */

export function Histogram({
  values,
  bins = 24,
  unit,
  markers = [],
}: {
  values: number[];
  bins?: number;
  unit: string;
  /** Vertical annotations, e.g. mean / median / p95. */
  markers?: { value: number; label: string; color?: string }[];
}) {
  const { show, hide, node } = useTooltip();

  if (values.length === 0) {
    return <div className="empty-state">No completed vehicles to plot.</div>;
  }

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const binWidth = span / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor((v - lo) / binWidth));
    counts[i] = (counts[i] as number) + 1;
  }
  const maxCount = Math.max(...counts);

  const width = 720;
  const height = 210;
  const padL = 44;
  const padR = 12;
  const padT = 10;
  const padB = 36;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const x = (v: number) => padL + ((v - lo) / span) * plotW;
  const y = (c: number) => padT + plotH - (c / maxCount) * plotH;
  const yTicks = niceTicks(0, maxCount, 4);
  // 2px surface gap between adjacent bars.
  const barW = Math.max(1, plotW / bins - 2);

  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMin meet" role="img"
        aria-label={`Histogram of ${unit}`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end">
              {num(t, 0)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} />

        {counts.map((c, i) => {
          const binLo = lo + i * binWidth;
          const binHi = binLo + binWidth;
          const h = padT + plotH - y(c);
          return (
            <g
              key={i}
              onMouseMove={(e) =>
                show(e, `${num(binLo, 1)} – ${num(binHi, 1)} ${unit}`, [
                  { label: 'Vehicles', value: num(c, 0) },
                  { label: 'Share', value: `${((c / values.length) * 100).toFixed(1)}%` },
                ])
              }
              onMouseLeave={hide}
            >
              <rect x={x(binLo)} y={padT} width={Math.max(1, plotW / bins)} height={plotH} fill="transparent" />
              {c > 0 ? (
                <rect x={x(binLo) + 1} y={y(c)} width={barW} height={Math.max(1, h)} rx={2} fill="var(--series-1)" />
              ) : null}
            </g>
          );
        })}

        {markers.map((m) => (
          <g key={m.label}>
            <line
              x1={x(m.value)}
              x2={x(m.value)}
              y1={padT}
              y2={padT + plotH}
              stroke={m.color ?? 'var(--text-secondary)'}
              strokeWidth={2}
            />
            <text x={x(m.value)} y={padT - 1} textAnchor="middle" fill={m.color ?? 'var(--text-secondary)'}>
              {m.label}
            </text>
          </g>
        ))}

        <text x={padL} y={height - 8}>{num(lo, 0)}</text>
        <text x={width - padR} y={height - 8} textAnchor="end">
          {num(hi, 0)}
        </text>
        <text x={padL + plotW / 2} y={height - 8} textAnchor="middle">
          {unit}
        </text>
      </svg>
      {node}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Line chart with crosshair                                           */
/* ------------------------------------------------------------------ */

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

export function LineChart({
  series,
  xLabel,
  yLabel,
  height = 240,
  formatX = (v: number) => num(v, 0),
  formatY = (v: number) => num(v, 2),
}: {
  series: LineSeries[];
  xLabel: string;
  yLabel: string;
  height?: number;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
}) {
  const [cursor, setCursor] = useState<{ x: number; clientX: number; clientY: number } | null>(null);

  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <div className="empty-state">No data yet — run the simulation.</div>;

  const width = 720;
  const padL = 52;
  const padR = 14;
  const padT = 10;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  const yMax = Math.max(...all.map((p) => p.y), 1e-9);
  const xSpan = xMax - xMin || 1;

  const sx = (v: number) => padL + ((v - xMin) / xSpan) * plotW;
  const sy = (v: number) => padT + plotH - (v / yMax) * plotH;

  const yTicks = niceTicks(0, yMax, 4);
  const xTicks = niceTicks(xMin, xMax, 6);

  const nearest = cursor
    ? series.map((s) => {
        let best = s.points[0] as { x: number; y: number };
        let bestD = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p.x - cursor.x);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        return { series: s, point: best };
      })
    : [];

  return (
    <div>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={`Line chart of ${yLabel} against ${xLabel}`}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          if (px < padL || px > width - padR) {
            setCursor(null);
            return;
          }
          setCursor({
            x: xMin + ((px - padL) / plotW) * xSpan,
            clientX: e.clientX,
            clientY: e.clientY,
          });
        }}
        onMouseLeave={() => setCursor(null)}
      >
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line className="gridline" x1={padL} x2={width - padR} y1={sy(t)} y2={sy(t)} />
            <text x={padL - 6} y={sy(t) + 4} textAnchor="end">
              {formatY(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={height - 14} textAnchor="middle">
            {formatX(t)}
          </text>
        ))}
        <line className="axis-line" x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} />

        {series.map((s) => (
          <path
            key={s.key}
            className="chart-line"
            d={s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.y)}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {cursor ? (
          <g>
            <line
              x1={sx(cursor.x)}
              x2={sx(cursor.x)}
              y1={padT}
              y2={padT + plotH}
              stroke="var(--axis)"
              strokeWidth={1}
            />
            {nearest.map((nn) => (
              <circle
                key={nn.series.key}
                cx={sx(nn.point.x)}
                cy={sy(nn.point.y)}
                r={4}
                fill={nn.series.color}
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            ))}
          </g>
        ) : null}

        <text x={padL + plotW / 2} y={height - 2} textAnchor="middle">
          {xLabel}
        </text>
      </svg>

      {cursor ? (
        <div
          className="tooltip"
          style={{
            left: Math.min(cursor.clientX + 12, window.innerWidth - 292),
            top: Math.min(cursor.clientY + 12, window.innerHeight - 140),
          }}
        >
          <div className="t-title">
            {xLabel}: {formatX(cursor.x)}
          </div>
          {nearest.map((nn) => (
            <div className="t-row" key={nn.series.key}>
              <span>
                <span
                  className="swatch"
                  style={{
                    background: nn.series.color,
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    marginRight: 5,
                  }}
                />
                {nn.series.label}
              </span>
              <span>{formatY(nn.point.y)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {series.length >= 2 ? (
        <div className="legend">
          {series.map((s) => (
            <span className="item" key={s.key}>
              <span className="swatch" style={{ background: s.color }} /> {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stacked composition bar (one row, part-to-whole)                    */
/* ------------------------------------------------------------------ */

export function CompositionBar({
  segments,
  total,
  formatValue,
}: {
  segments: { key: string; label: string; value: number; color: string }[];
  total: number;
  formatValue: (v: number) => string;
}) {
  const { show, hide, node } = useTooltip();
  const width = 720;
  const height = 26;
  let cursorX = 0;

  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
        aria-label="Composition bar">
        {segments.map((s) => {
          const w = total > 0 ? (s.value / total) * width : 0;
          const x = cursorX;
          cursorX += w;
          if (w <= 0) return null;
          return (
            <rect
              key={s.key}
              // 2px surface gap between adjacent fills.
              x={x + 1}
              y={0}
              width={Math.max(0, w - 2)}
              height={height}
              rx={3}
              fill={s.color}
              onMouseMove={(e) =>
                show(e, s.label, [
                  { label: 'Amount', value: formatValue(s.value) },
                  { label: 'Share', value: `${((s.value / total) * 100).toFixed(1)}%` },
                ])
              }
              onMouseLeave={hide}
            />
          );
        })}
      </svg>
      {node}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline utilisation meter                                            */
/* ------------------------------------------------------------------ */

export function Meter({
  value,
  status,
  width = 74,
}: {
  /** 0..1, values above 1 are clamped for drawing but not for the label. */
  value: number;
  status: 'good' | 'warning' | 'serious' | 'critical';
  width?: number;
}) {
  const colors = {
    good: 'var(--series-1)',
    warning: 'var(--status-warning)',
    serious: 'var(--status-serious)',
    critical: 'var(--status-critical)',
  };
  const w = Math.max(0, Math.min(1, value)) * width;
  return (
    <svg width={width} height={8} className="chart" aria-hidden="true" style={{ display: 'inline-block' }}>
      <rect x={0} y={0} width={width} height={8} rx={3} fill="var(--surface-3)" />
      <rect x={0} y={0} width={w} height={8} rx={3} fill={colors[status]} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Human-friendly axis ticks at 1/2/5 x 10^n spacing. */
export function niceTicks(lo: number, hi: number, target: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo || 0];
  const raw = (hi - lo) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function ChartFrame({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div>
      {title ? <div className="small muted" style={{ marginBottom: 6 }}>{title}</div> : null}
      {children}
    </div>
  );
}
