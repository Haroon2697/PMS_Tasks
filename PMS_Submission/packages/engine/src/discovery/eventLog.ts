/**
 * Event log parsing — Task 7, step 1 of Event Log -> Discovery -> Model -> Simulation.
 *
 * Reads a CSV event log of the form
 *
 *     CaseID,Activity,Start,Complete
 *     V001,Body Shop,08:00,08:15
 *
 * and turns it into typed rows with times normalised to MINUTES from a common
 * origin, which is the unit the rest of the engine already works in.
 *
 * Three things here are less trivial than they look, and each is handled
 * explicitly rather than assumed away:
 *
 *  1. COLUMN NAMES vary. Real logs say `case`, `case_id`, `Vehicle`, `Order`,
 *     `Resource`, `timestamp`... so headers are matched against a synonym list
 *     rather than required to be exact, and the resolved mapping is reported
 *     back so the user can see what was matched to what.
 *
 *  2. TIME FORMATS vary. A bare `08:15` has no date, so a log spanning
 *     midnight would otherwise appear to travel backwards in time. Bare
 *     clock times are therefore unwrapped per case: whenever a timestamp
 *     would go backwards within a case, a day is added.
 *
 *  3. BAD ROWS are normal. A row with a missing field or a completion before
 *     its start is reported as a numbered warning and skipped, rather than
 *     silently poisoning the discovered model.
 */

/** One activity instance: a case did an activity between two times. */
export interface EventRow {
  caseId: string;
  activity: string;
  /** Minutes from the log origin. */
  start: number;
  /** Minutes from the log origin. Always >= start. */
  complete: number;
  /** Optional resource/worker column, kept for display if present. */
  resource?: string;
  /** 1-based line number in the source file, for error messages. */
  line: number;
}

export type TimeFormat = 'clock' | 'datetime' | 'epoch-ms' | 'epoch-s' | 'numeric-minutes';

export interface ColumnMapping {
  caseId: string;
  activity: string;
  start: string;
  complete: string | null;
  resource: string | null;
}

export interface ParsedEventLog {
  rows: EventRow[];
  columns: ColumnMapping;
  timeFormat: TimeFormat;
  /** Human-readable description of what time 0 corresponds to. */
  originLabel: string;
  /** Rows that could not be used, with the reason. */
  rejected: { line: number; reason: string; raw: string }[];
  warnings: string[];
  /** Distinct case ids, in first-seen order. */
  caseIds: string[];
  /** Distinct activity names, in first-seen order. */
  activityNames: string[];
}

/* ------------------------------------------------------------------ */
/* Header matching                                                     */
/* ------------------------------------------------------------------ */

const SYNONYMS = {
  caseId: ['caseid', 'case', 'case_id', 'caseno', 'case id', 'vehicle', 'vehicleid', 'vehicle_id', 'job', 'jobid', 'order', 'orderid', 'instance', 'trace', 'traceid'],
  activity: ['activity', 'task', 'step', 'process', 'operation', 'station', 'event', 'action', 'activityname', 'concept:name'],
  start: ['start', 'starttime', 'start_time', 'start time', 'begin', 'begintime', 'starttimestamp', 'start_timestamp', 'from', 'arrival', 'servicestart'],
  complete: ['complete', 'completion', 'completetime', 'complete_time', 'complete time', 'end', 'endtime', 'end_time', 'finish', 'finishtime', 'completed', 'time:timestamp', 'to', 'serviceend'],
  resource: ['resource', 'worker', 'operator', 'server', 'machine', 'org:resource', 'performer'],
} as const;

const normaliseHeader = (h: string): string => h.trim().toLowerCase().replace(/^"|"$/g, '');

function matchColumn(headers: string[], candidates: readonly string[]): string | null {
  const normalised = headers.map(normaliseHeader);
  // Exact match on a synonym wins.
  for (const c of candidates) {
    const i = normalised.indexOf(c);
    if (i >= 0) return headers[i] as string;
  }
  // Otherwise accept a header that contains a synonym, longest synonym first
  // so "start_time" prefers `start` over a stray `time`.
  const byLength = [...candidates].sort((a, b) => b.length - a.length);
  for (const c of byLength) {
    const i = normalised.findIndex((h) => h.includes(c));
    if (i >= 0) return headers[i] as string;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* CSV splitting                                                       */
/* ------------------------------------------------------------------ */

/** Split one CSV line, honouring double-quoted fields with escaped quotes. */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Guess the delimiter from the header line. */
function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const n = splitCsvLine(headerLine, d).length;
    if (n > bestCount) {
      bestCount = n;
      best = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Time parsing                                                        */
/* ------------------------------------------------------------------ */

const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/;

/**
 * Parse one timestamp to minutes, plus which format it was.
 * Returns null when the value cannot be interpreted as a time at all.
 */
export function parseTimestamp(raw: string): { minutes: number; format: TimeFormat } | null {
  const v = raw.trim();
  if (v === '') return null;

  const clock = CLOCK_RE.exec(v);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    const s = clock[3] ? Number(clock[3]) : 0;
    if (h > 47 || m > 59 || s >= 60) return null;
    return { minutes: h * 60 + m + s / 60, format: 'clock' };
  }

  // ISO or other Date-parsable datetime.
  if (/[-/]/.test(v) || /T/.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return { minutes: t / 60000, format: 'datetime' };
  }

  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    // Heuristic on magnitude: epoch milliseconds and seconds are far larger
    // than any plausible "minutes since the log started".
    if (n > 1e12) return { minutes: n / 60000, format: 'epoch-ms' };
    if (n > 1e9) return { minutes: n / 60, format: 'epoch-s' };
    return { minutes: n, format: 'numeric-minutes' };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export interface ParseOptions {
  /**
   * Duration in minutes to assume when the log has no completion column, so
   * every activity is a single timestamp. Made explicit because it is a
   * fabricated value: with instant events there is no service time in the data.
   */
  assumedServiceMinutes?: number;
  /** Override the auto-detected column mapping. */
  columns?: Partial<ColumnMapping>;
}

export function parseEventLogCsv(text: string, options: ParseOptions = {}): ParsedEventLog {
  const warnings: string[] = [];
  const rejected: ParsedEventLog['rejected'] = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/, ''))
    .filter((l, i) => l.trim() !== '' || i === 0);

  if (lines.length < 2) {
    throw new Error(
      'The file needs a header row and at least one event row. Expected columns like ' +
        'CaseID, Activity, Start, Complete.',
    );
  }

  const headerLine = lines[0] as string;
  const delimiter = detectDelimiter(headerLine);
  const headers = splitCsvLine(headerLine, delimiter);

  const columns: ColumnMapping = {
    caseId: options.columns?.caseId ?? matchColumn(headers, SYNONYMS.caseId) ?? '',
    activity: options.columns?.activity ?? matchColumn(headers, SYNONYMS.activity) ?? '',
    start: options.columns?.start ?? matchColumn(headers, SYNONYMS.start) ?? '',
    complete: options.columns?.complete ?? matchColumn(headers, SYNONYMS.complete),
    resource: options.columns?.resource ?? matchColumn(headers, SYNONYMS.resource),
  };

  const missing: string[] = [];
  if (!columns.caseId) missing.push('case id');
  if (!columns.activity) missing.push('activity');
  if (!columns.start) missing.push('start time');
  if (missing.length) {
    throw new Error(
      `Could not find a column for: ${missing.join(', ')}. The file's headers are: ` +
        `${headers.join(', ')}. Rename them, or map them manually.`,
    );
  }

  if (!columns.complete) {
    warnings.push(
      'No completion-time column was found, so each event is a single instant and the log ' +
        `contains no service times. A service time of ${options.assumedServiceMinutes ?? 1} minute(s) ` +
        'is ASSUMED for every activity — change it, because every derived mu and utilisation ' +
        'depends on it.',
    );
  }

  const idx = (name: string | null) => (name === null ? -1 : headers.indexOf(name));
  const iCase = idx(columns.caseId);
  const iAct = idx(columns.activity);
  const iStart = idx(columns.start);
  const iComplete = idx(columns.complete);
  const iRes = idx(columns.resource);

  interface Raw {
    caseId: string;
    activity: string;
    startRaw: string;
    completeRaw: string;
    resource?: string;
    line: number;
  }

  const raws: Raw[] = [];
  const formats = new Set<TimeFormat>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line, delimiter);
    const caseId = (cells[iCase] ?? '').trim();
    const activity = (cells[iAct] ?? '').trim();
    const startRaw = (cells[iStart] ?? '').trim();
    const completeRaw = iComplete >= 0 ? (cells[iComplete] ?? '').trim() : '';

    if (!caseId || !activity || !startRaw) {
      rejected.push({
        line: i + 1,
        reason: !caseId ? 'missing case id' : !activity ? 'missing activity' : 'missing start time',
        raw: line,
      });
      continue;
    }
    const st = parseTimestamp(startRaw);
    if (!st) {
      rejected.push({ line: i + 1, reason: `unrecognised start time "${startRaw}"`, raw: line });
      continue;
    }
    formats.add(st.format);
    if (completeRaw) {
      const ct = parseTimestamp(completeRaw);
      if (!ct) {
        rejected.push({
          line: i + 1,
          reason: `unrecognised completion time "${completeRaw}"`,
          raw: line,
        });
        continue;
      }
      formats.add(ct.format);
    }

    const r: Raw = { caseId, activity, startRaw, completeRaw, line: i + 1 };
    if (iRes >= 0 && cells[iRes]) r.resource = (cells[iRes] as string).trim();
    raws.push(r);
  }

  if (raws.length === 0) {
    throw new Error(
      `No usable rows. ${rejected.length} row(s) were rejected; the first reason was: ` +
        `${rejected[0]?.reason ?? 'unknown'}.`,
    );
  }

  const timeFormat: TimeFormat = formats.has('datetime')
    ? 'datetime'
    : formats.has('epoch-ms')
      ? 'epoch-ms'
      : formats.has('epoch-s')
        ? 'epoch-s'
        : formats.has('clock')
          ? 'clock'
          : 'numeric-minutes';

  if (formats.size > 1) {
    warnings.push(
      `The log mixes time formats (${[...formats].join(', ')}). They were each parsed on their own ` +
        'terms and converted to minutes, but check the results — a mixed-format log is often a sign ' +
        'of an export problem.',
    );
  }

  /* ---- convert to minutes, unwrapping bare clock times per case ---- */

  const rows: EventRow[] = [];
  const perCaseOffset = new Map<string, number>();
  const perCaseLast = new Map<string, number>();
  const DAY = 1440;
  /** Longest activity accepted as having crossed midnight, rather than rejected. */
  const MAX_PLAUSIBLE_OVERNIGHT_MINUTES = 12 * 60;
  const assumedService = options.assumedServiceMinutes ?? 1;
  let unwrapped = 0;

  // Rows must be processed in file order for the unwrapping to be meaningful:
  // it assumes the log lists each case's events in the order they happened.
  for (const r of raws) {
    const st = parseTimestamp(r.startRaw) as { minutes: number; format: TimeFormat };
    let start = st.minutes;
    let complete = r.completeRaw
      ? (parseTimestamp(r.completeRaw) as { minutes: number }).minutes
      : start + assumedService;

    if (timeFormat === 'clock') {
      // A bare clock time wraps at midnight. Carry a per-case day offset and
      // bump it whenever time would otherwise run backwards.
      let offset = perCaseOffset.get(r.caseId) ?? 0;
      const last = perCaseLast.get(r.caseId);
      if (last !== undefined && start + offset < last - 1e-9) {
        offset += DAY;
        unwrapped++;
      }
      start += offset;
      complete += offset;
      if (complete < start) {
        // The activity itself may have crossed midnight — but only believe that
        // if the implied duration is plausible. A completion twelve hours or
        // more "after" its start is far more likely to be a data error than a
        // genuine overnight task, and silently turning it into a 23-hour
        // activity would corrupt every service-rate estimate downstream.
        const overnight = complete + DAY - start;
        if (overnight <= MAX_PLAUSIBLE_OVERNIGHT_MINUTES) complete += DAY;
      }
      perCaseOffset.set(r.caseId, offset);
      perCaseLast.set(r.caseId, Math.max(last ?? -Infinity, complete));
    }

    if (complete < start) {
      rejected.push({
        line: r.line,
        reason: `completion (${r.completeRaw}) is before start (${r.startRaw})`,
        raw: `${r.caseId},${r.activity},${r.startRaw},${r.completeRaw}`,
      });
      continue;
    }

    const row: EventRow = {
      caseId: r.caseId,
      activity: r.activity,
      start,
      complete,
      line: r.line,
    };
    if (r.resource) row.resource = r.resource;
    rows.push(row);
  }

  if (unwrapped > 0) {
    warnings.push(
      `${unwrapped} event(s) appeared to go backwards in time and were treated as crossing ` +
        'midnight into the next day. Bare clock times carry no date, so this is an inference — ' +
        'export the log with full timestamps to remove the ambiguity.',
    );
  }

  // Shift so the earliest event is time 0.
  const origin = Math.min(...rows.map((r) => r.start));
  for (const r of rows) {
    r.start -= origin;
    r.complete -= origin;
  }

  const caseIds: string[] = [];
  const activityNames: string[] = [];
  const seenCase = new Set<string>();
  const seenAct = new Set<string>();
  for (const r of rows) {
    if (!seenCase.has(r.caseId)) {
      seenCase.add(r.caseId);
      caseIds.push(r.caseId);
    }
    if (!seenAct.has(r.activity)) {
      seenAct.add(r.activity);
      activityNames.push(r.activity);
    }
  }

  if (rejected.length > 0) {
    warnings.push(
      `${rejected.length} of ${rejected.length + rows.length} rows were skipped. They are listed ` +
        'below so nothing is discarded silently.',
    );
  }

  const originLabel =
    timeFormat === 'datetime' || timeFormat === 'epoch-ms' || timeFormat === 'epoch-s'
      ? `time 0 = ${new Date(origin * 60000).toISOString()}`
      : timeFormat === 'clock'
        ? `time 0 = ${formatClockMinutes(origin)} on the first day in the log`
        : 'time 0 = the earliest value in the log';

  return {
    rows,
    columns,
    timeFormat,
    originLabel,
    rejected,
    warnings,
    caseIds,
    activityNames,
  };
}

function formatClockMinutes(m: number): string {
  const total = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const mm = Math.floor(total - h * 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Writing a log back out                                              */
/* ------------------------------------------------------------------ */

/**
 * Serialise rows back to CSV. Used to export an event log generated from a
 * simulation run, which is what makes the discovery pipeline verifiable: run
 * a known model, export its log, re-discover it, and check that the discovered
 * parameters match the ones you started with.
 */
export function eventLogToCsv(rows: EventRow[], opts: { dayStartMinutes?: number } = {}): string {
  const dayStart = opts.dayStartMinutes ?? 8 * 60;
  const span = rows.reduce((m, r) => Math.max(m, r.complete), 0) + dayStart;

  // A bare HH:MM:SS is only unambiguous inside a single day. Anything longer is
  // written as a full date-time, so re-importing the file cannot misplace an
  // event by a day.
  const multiDay = span >= 1440;
  const EPOCH = Date.UTC(2026, 0, 5); // an arbitrary Monday, for readable dates

  const fmt = (m: number) => {
    const t = dayStart + m;
    if (multiDay) {
      return new Date(EPOCH + t * 60000).toISOString().replace('T', ' ').slice(0, 19);
    }
    const h = Math.floor(t / 60);
    const mm = Math.floor(t - h * 60);
    const ss = Math.min(59, Math.round((t - h * 60 - mm) * 60));
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };
  const header = 'CaseID,Activity,Start,Complete';
  const body = rows.map((r) => `${r.caseId},${quote(r.activity)},${fmt(r.start)},${fmt(r.complete)}`);
  return [header, ...body].join('\r\n');
}

function quote(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
