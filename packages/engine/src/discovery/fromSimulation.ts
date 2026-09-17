/**
 * Simulation -> event log.
 *
 * The inverse of discovery, and the reason the discovery pipeline can be
 * trusted: run a model whose parameters are known exactly, write out the event
 * log it produces, then re-discover a model from that log and check the
 * recovered routing probabilities, service times and arrival rate against the
 * ones you started with. That round trip is an automated test.
 *
 * It also gives the application a realistic sample log to demonstrate with —
 * one containing a genuine inspection/rework feedback loop — without shipping
 * a fabricated CSV.
 */

import type { Vehicle } from '../des/vehicle.js';
import type { EventRow } from './eventLog.js';
import { eventLogToCsv } from './eventLog.js';

export interface FromSimulationOptions {
  /** Cap the number of cases written. */
  maxCases?: number;
  /**
   * Include vehicles that were still in the factory when the run ended.
   * Off by default: a partial trace has no final activity, which would make
   * every such case look like it terminated at whatever station it was in.
   */
  includeUnfinished?: boolean;
  /** Prefix for case ids. */
  casePrefix?: string;
}

/**
 * Turn per-vehicle simulation traces into event-log rows.
 *
 * Only visits that actually reached service are written: a vehicle queued at a
 * station when the run ended never produced an activity instance, and inventing
 * one would put a fabricated row into the log.
 */
export function eventLogFromVehicles(
  vehicles: Vehicle[],
  options: FromSimulationOptions = {},
): EventRow[] {
  const rows: EventRow[] = [];
  let line = 2;
  let cases = 0;

  for (const v of vehicles) {
    if (!options.includeUnfinished && v.status === 'IN_SYSTEM') continue;
    if (options.maxCases !== undefined && cases >= options.maxCases) break;

    let wrote = false;
    for (const visit of v.visits) {
      if (visit.serviceStartedAt === null || visit.serviceEndedAt === null) continue;
      rows.push({
        caseId: options.casePrefix ? `${options.casePrefix}${v.id}` : v.tag,
        activity: visit.stationName,
        start: visit.serviceStartedAt,
        complete: visit.serviceEndedAt,
        line: line++,
      });
      wrote = true;
    }
    if (wrote) cases++;
  }

  rows.sort((a, b) => a.start - b.start || a.caseId.localeCompare(b.caseId));
  return rows;
}

/** Convenience: simulation traces straight to a CSV string. */
export function eventLogCsvFromVehicles(
  vehicles: Vehicle[],
  options: FromSimulationOptions = {},
): string {
  return eventLogToCsv(eventLogFromVehicles(vehicles, options));
}
