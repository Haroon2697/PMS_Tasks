/**
 * Shared UI primitives.
 *
 * The important one is `<Kpi>`: every displayed metric must declare where it
 * came from (requirement 60), so `basis` is a REQUIRED prop. There is no way to
 * render a headline number in this application without saying whether it is
 * simulated, analytical or an assumption.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { MetricSummary, Provenance } from '@vmq/engine';
import { num } from '../lib/format';

/* ------------------------------------------------------------------ */
/* Basis badge                                                         */
/* ------------------------------------------------------------------ */

export type Basis = 'simulated' | 'analytical' | 'assumption' | 'derived';

const BASIS_META: Record<Basis, { label: string; cls: string; title: string }> = {
  simulated: {
    label: 'SIM',
    cls: 'sim',
    title:
      'SIMULATED — measured from a discrete-event simulation run. Carries sampling error; a ' +
      'confidence interval is shown where replications allow one.',
  },
  analytical: {
    label: 'ANALYTIC',
    cls: 'analytic',
    title:
      'ANALYTICAL — computed in closed form from the queueing model. Exact under its assumptions ' +
      '(Poisson arrivals, no machine failures), which the simulation does not share.',
  },
  assumption: {
    label: 'ASSUMED',
    cls: 'assumption',
    title:
      'ASSUMPTION — a value configured in the model, not a measurement. Change it in the parameter ' +
      'editor.',
  },
  derived: {
    label: 'DERIVED',
    cls: 'assumption',
    title: 'DERIVED — computed from other parameters rather than entered directly.',
  },
};

export function BasisBadge({ basis }: { basis: Basis }) {
  const m = BASIS_META[basis];
  return (
    <span className={`badge ${m.cls}`} title={m.title}>
      {m.label}
    </span>
  );
}

const PROVENANCE_META: Record<Provenance, { label: string; cls: string; title: string }> = {
  SOURCE_BACKED: {
    label: 'SOURCED',
    cls: 'sourced',
    title: 'Backed by a citable external source, shown in the parameter register.',
  },
  PROJECT_ASSUMPTION: {
    label: 'ASSUMPTION',
    cls: 'assumption',
    title:
      'A PROJECT ASSUMPTION: a value chosen for this model. It is not a claim about any real ' +
      'manufacturer and must not be quoted as an industry figure.',
  },
  USER_INPUT: { label: 'USER', cls: 'user', title: 'Entered by you in this session.' },
  DERIVED: { label: 'DERIVED', cls: 'assumption', title: 'Computed by the engine from other parameters.' },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const m = PROVENANCE_META[provenance];
  return (
    <span className={`badge ${m.cls}`} title={m.title}>
      {m.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* KPI tile                                                            */
/* ------------------------------------------------------------------ */

export function Kpi({
  label,
  value,
  unit,
  basis,
  sub,
  metric,
  metricDp = 2,
  status,
  small,
  title,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Required: no number is shown without declaring its origin. */
  basis: Basis;
  sub?: ReactNode;
  /** When given, the 95% interval is printed beneath the value. */
  metric?: MetricSummary | undefined;
  metricDp?: number;
  status?: 'good' | 'warning' | 'serious' | 'critical' | 'neutral';
  small?: boolean;
  title?: string;
}) {
  return (
    <div className="kpi" title={title}>
      <div className="label">
        <span>{label}</span>
        <BasisBadge basis={basis} />
      </div>
      <div className={`value${small ? ' small' : ''}`}>
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {metric && Number.isFinite(metric.halfWidth) ? (
        <div className="ci" title={`95% confidence interval over ${metric.n} replications`}>
          95% CI {num(metric.ciLow, metricDp)} – {num(metric.ciHigh, metricDp)}
        </div>
      ) : null}
      {metric && !Number.isFinite(metric.halfWidth) ? (
        <div className="ci">Single replication — no interval</div>
      ) : null}
      {sub ? <div className="sub">{sub}</div> : null}
      {status ? <div className={`status ${status}`}>{statusWord(status)}</div> : null}
    </div>
  );
}

function statusWord(s: string): string {
  switch (s) {
    case 'good':
      return 'Within limits';
    case 'warning':
      return 'Elevated';
    case 'serious':
      return 'Near capacity';
    case 'critical':
      return 'Over capacity';
    default:
      return '—';
  }
}

/* ------------------------------------------------------------------ */
/* Cards, notices                                                      */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  hint,
  children,
  actions,
  className,
}: {
  title?: string;
  hint?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {title || actions ? (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            {title ? <h2>{title}</h2> : null}
            {hint ? <p className="hint">{hint}</p> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Notice({
  kind = 'info',
  title,
  children,
}: {
  kind?: 'info' | 'warn' | 'error';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {title ? <div className="n-title">{title}</div> : null}
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Header tooltip — used to spell out units and definitions. */
  title?: string;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  /** Sort value; omit to make the column unsortable. */
  sortValue?: (row: T) => number | string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  selectedKey,
  emphasiseRow,
  maxHeight,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: ReactNode;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  emphasiseRow?: (row: T) => boolean;
  maxHeight?: number;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const sorted = (() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sort.dir;
      return String(va).localeCompare(String(vb)) * sort.dir;
    });
  })();

  return (
    <div className="table-wrap scroll-y" style={maxHeight ? { maxHeight } : undefined}>
      <table className="data">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.align === 'left' ? 'left' : undefined}
                title={c.title}
                aria-sort={
                  sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
                }
                style={c.sortValue ? { cursor: 'pointer' } : undefined}
                onClick={
                  c.sortValue
                    ? () =>
                        setSort((s) =>
                          s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: -1 },
                        )
                    : undefined
                }
              >
                {c.header}
                {sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const k = rowKey(row);
            return (
              <tr
                key={k}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={[
                  selectedKey === k ? 'is-selected' : '',
                  emphasiseRow?.(row) ? 'emphasis' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'left' ? 'left' : undefined}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <EmptyState>No rows.</EmptyState> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export function NumberField({
  label,
  unit,
  value,
  onChange,
  min,
  max,
  step = 'any',
  provenance,
  hint,
  integer,
  disabled,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
  provenance?: Provenance;
  hint?: string;
  integer?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const lastCommitted = useRef(value);

  // Keep the field in step when the model changes elsewhere (e.g. a scenario
  // is applied), without clobbering what the user is currently typing.
  useEffect(() => {
    if (value !== lastCommitted.current) {
      lastCommitted.current = value;
      setDraft(String(value));
      setError(null);
    }
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || Number.isNaN(parsed)) {
      setError('Enter a number.');
      return;
    }
    if (integer && !Number.isInteger(parsed)) {
      setError('Must be a whole number.');
      return;
    }
    if (min !== undefined && parsed < min) {
      setError(`Must be at least ${min}.`);
      return;
    }
    if (max !== undefined && parsed > max) {
      setError(`Must be at most ${max}.`);
      return;
    }
    setError(null);
    lastCommitted.current = parsed;
    onChange(parsed);
  };

  return (
    <div className="field">
      <label>
        <span>{label}</span>
        <span className="unit-hint">({unit})</span>
        {provenance ? <ProvenanceBadge provenance={provenance} /> : null}
      </label>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-invalid={error ? 'true' : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => {
          if (error) {
            setDraft(String(lastCommitted.current));
            setError(null);
          }
        }}
      />
      {error ? <div className="field-error">{error}</div> : null}
      {hint && !error ? <div className="small muted">{hint}</div> : null}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <div className="small muted">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Side panel                                                          */
/* ------------------------------------------------------------------ */

export function SidePanel({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="panel-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="side-panel" role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <div style={{ flex: 1 }} />
          {actions}
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          className="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
