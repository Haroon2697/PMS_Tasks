/**
 * The vehicle entity — requirement 3 ("Do not treat the vehicle merely as a
 * number").
 *
 * Each vehicle carries its own queue history, service history, rework history
 * and resource consumption. Those records are what the cost engine later turns
 * into a per-vehicle cost, and what the UI shows when the user inspects one
 * vehicle (requirement 72). Nothing here is aggregated: aggregation happens in
 * the statistics layer, so an individual vehicle's story is always recoverable.
 *
 * All times are simulation MINUTES from the start of the run.
 */

export type VehicleStatus =
  /** Still moving through the factory when the run ended. */
  | 'IN_SYSTEM'
  /** Passed inspection and left as a finished vehicle. */
  | 'FINISHED'
  /** Removed from the line as scrap. */
  | 'SCRAPPED'
  /** Turned away because a finite queue was full. */
  | 'REJECTED';

export type VisitOutcome =
  /** Routed onward normally. */
  | 'ROUTED'
  /** Inspection passed. */
  | 'PASS'
  /** Inspection failed; routed to rework. */
  | 'FAIL'
  /** Scrapped at this station. */
  | 'SCRAP'
  /** Left the system as a finished vehicle from here. */
  | 'FINISHED'
  /** Run ended while the vehicle was still here. */
  | 'INCOMPLETE';

/** One pass of one vehicle through one station. */
export interface StationVisit {
  stationId: string;
  stationName: string;
  /** 1 for the first visit, 2 for the second (i.e. after rework), ... */
  visitNumber: number;
  /** Time the vehicle joined this station's queue. */
  enqueuedAt: number;
  /** Time service began. null while still waiting. */
  serviceStartedAt: number | null;
  /** Time service finished. null while in service or still waiting. */
  serviceEndedAt: number | null;
  /** serviceStartedAt - enqueuedAt. */
  waitMinutes: number;
  /**
   * Time actually occupying the server, INCLUDING any repair downtime the
   * vehicle sat through while mounted on a failed machine.
   */
  occupancyMinutes: number;
  /** Productive processing time, excluding downtime. */
  processingMinutes: number;
  /** Time lost to a machine failure during this visit (requirement 19). */
  downtimeMinutes: number;
  /** Which parallel server handled it. */
  serverIndex: number | null;
  outcome: VisitOutcome;
  /** Where it went next; null when it left the system. */
  routedTo: string | null;
}

export interface Vehicle {
  id: number;
  /** Display tag, e.g. "V-1042". */
  tag: string;
  /** Which vehicle model (drives BOM and selling price). */
  modelId: string;

  arrivalTime: number;
  completionTime: number | null;
  status: VehicleStatus;

  /** Station the vehicle is at right now, or null once it has left. */
  currentStationId: string | null;
  /** Coarse state for the live view. */
  currentState: 'QUEUED' | 'IN_SERVICE' | 'BLOCKED' | 'DONE';

  visits: StationVisit[];

  /** Number of times it was sent to rework (requirement 3). */
  reworkCount: number;
  /** Number of times it was inspected. */
  inspectionCount: number;

  /** Sum of waitMinutes across all visits. */
  totalWaitMinutes: number;
  /** Sum of processingMinutes across all visits. */
  totalProcessingMinutes: number;
  /** Sum of downtimeMinutes across all visits. */
  totalDowntimeMinutes: number;

  /**
   * Server-minutes consumed per station, keyed by station id. This is the
   * usage record the cost engine charges machine, energy and labour against
   * (requirements 16-20); the DES records usage, the cost engine prices it.
   */
  serverMinutesByStation: Record<string, number>;
  /** Minutes waiting in queue per station — drives the waiting cost. */
  waitMinutesByStation: Record<string, number>;
  /** Stations whose material was issued to this vehicle (requirement 23). */
  stationsEntered: string[];

  /** True once the vehicle arrived after the warm-up cut-off. */
  countedInStatistics: boolean;
}

let nextId = 1;

/** Reset the id counter. Called at the start of every replication. */
export function resetVehicleIds(startAt = 1): void {
  nextId = startAt;
}

export function createVehicle(modelId: string, arrivalTime: number, counted: boolean): Vehicle {
  const id = nextId++;
  return {
    id,
    tag: `V-${id}`,
    modelId,
    arrivalTime,
    completionTime: null,
    status: 'IN_SYSTEM',
    currentStationId: null,
    currentState: 'QUEUED',
    visits: [],
    reworkCount: 0,
    inspectionCount: 0,
    totalWaitMinutes: 0,
    totalProcessingMinutes: 0,
    totalDowntimeMinutes: 0,
    serverMinutesByStation: {},
    waitMinutesByStation: {},
    stationsEntered: [],
    countedInStatistics: counted,
  };
}

/**
 * Total manufacturing time (requirement 12):
 *   cycle time = completion time - entry time
 * Returns null while the vehicle is still in the system, because a cycle time
 * for an unfinished vehicle would be a fabricated number (requirement 60).
 */
export function cycleTimeMinutes(v: Vehicle): number | null {
  return v.completionTime === null ? null : v.completionTime - v.arrivalTime;
}

/**
 * Breakdown of a finished vehicle's time, per requirement 12. The components
 * sum to the cycle time up to floating-point error.
 */
export interface TimeBreakdown {
  totalMinutes: number;
  waitingMinutes: number;
  processingMinutes: number;
  downtimeMinutes: number;
  /** Processing time spent specifically at rework stations. */
  reworkMinutes: number;
  /** Processing time spent specifically at inspection stations. */
  inspectionMinutes: number;
  /** Residual: total minus the accounted components. Should be ~0. */
  unaccountedMinutes: number;
}

export function timeBreakdown(
  v: Vehicle,
  stationKinds: Record<string, string>,
): TimeBreakdown | null {
  const total = cycleTimeMinutes(v);
  if (total === null) return null;

  let reworkMinutes = 0;
  let inspectionMinutes = 0;
  for (const visit of v.visits) {
    const kind = stationKinds[visit.stationId];
    if (kind === 'rework') reworkMinutes += visit.processingMinutes;
    else if (kind === 'inspection') inspectionMinutes += visit.processingMinutes;
  }

  const accounted = v.totalWaitMinutes + v.totalProcessingMinutes + v.totalDowntimeMinutes;
  return {
    totalMinutes: total,
    waitingMinutes: v.totalWaitMinutes,
    processingMinutes: v.totalProcessingMinutes,
    downtimeMinutes: v.totalDowntimeMinutes,
    reworkMinutes,
    inspectionMinutes,
    unaccountedMinutes: total - accounted,
  };
}

/** Format simulation minutes as a clock time offset from a start-of-day. */
export function formatClock(minutes: number, dayStartMinutes = 8 * 60): string {
  const t = dayStartMinutes + minutes;
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
