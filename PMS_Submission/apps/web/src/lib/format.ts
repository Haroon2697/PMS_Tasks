/**
 * Number and unit formatting — requirement 52.
 *
 * Units are never left implicit. Every helper here either carries the unit in
 * its output or is paired with a `unit` prop at the call site, because a bare
 * number in an operations dashboard is the easiest way for a correct model to
 * produce a wrong decision.
 *
 * `n/a` is used deliberately for values that do not exist — an undefined ROI,
 * a cycle time for an unfinished vehicle — rather than 0, which would read as a
 * real measurement (requirement 60).
 */

import type { CurrencySettings } from '@vmq/engine';

export function num(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (!Number.isFinite(value)) return '∞';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

export function int(value: number | null | undefined): string {
  return num(value, 0);
}

export function pct(fraction: number | null | undefined, dp = 1): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return 'n/a';
  if (!Number.isFinite(fraction)) return '∞';
  return `${(fraction * 100).toFixed(dp)}%`;
}

export function money(value: number | null | undefined, currency: CurrencySettings, dp = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (!Number.isFinite(value)) return '∞';
  const sign = value < 0 ? '-' : '';
  return `${sign}${currency.symbol}${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

/** Compact money for tiles, e.g. $3.18M. Full precision stays in tables. */
export function moneyCompact(value: number | null | undefined, currency: CurrencySettings): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (!Number.isFinite(value)) return '∞';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${currency.symbol}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${currency.symbol}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}${currency.symbol}${(abs / 1e3).toFixed(1)}k`;
  return money(value, currency, abs >= 100 ? 0 : 2);
}

/** Minutes rendered as the most readable unit, always labelled. */
export function minutes(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (!Number.isFinite(value)) return '∞';
  if (Math.abs(value) >= 1440) return `${num(value / 1440, dp)} d`;
  if (Math.abs(value) >= 120) return `${num(value / 60, dp)} h`;
  return `${num(value, dp)} min`;
}

/** Simulation minutes as a wall-clock time, from an 08:00 shift start. */
export function clock(simMinutes: number, dayStartMinutes = 8 * 60): string {
  const t = dayStartMinutes + simMinutes;
  const day = Math.floor(t / 1440);
  const rem = t - day * 1440;
  const h = Math.floor(rem / 60);
  const m = Math.floor(rem - h * 60);
  const s = Math.floor((rem - h * 60 - m) * 60);
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return day > 0 ? `D${day + 1} ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** Signed value with an explicit + so a delta's direction is unmistakable. */
export function signed(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (!Number.isFinite(value)) return value > 0 ? '+∞' : '-∞';
  return `${value >= 0 ? '+' : ''}${num(value, dp)}`;
}

/**
 * Utilisation status. The thresholds are presentation only — they shade a
 * number the user can read exactly, and nothing in the engine branches on
 * them. Bottleneck identification is done from capacity in the engine
 * (requirement 42), never from a colour band.
 */
export function utilisationStatus(rho: number): 'good' | 'warning' | 'serious' | 'critical' {
  if (rho >= 1) return 'critical';
  if (rho >= 0.9) return 'serious';
  if (rho >= 0.75) return 'warning';
  return 'good';
}

export const SERIES_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const;

/**
 * Colour for a named entity, assigned by a stable key rather than by position
 * in the current list. Filtering a chart must not repaint the series that
 * remain, so the index comes from the full key list, not the visible subset.
 */
export function seriesColor(key: string, allKeys: readonly string[]): string {
  const i = allKeys.indexOf(key);
  return SERIES_VARS[(i < 0 ? 0 : i) % SERIES_VARS.length] as string;
}
