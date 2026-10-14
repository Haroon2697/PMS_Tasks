/**
 * Discrete-event simulation engine — requirements 2, 3, 11, 19, 36, 38, 45.
 *
 * This is a genuine next-event time-advance simulation. Simulation time jumps
 * from one scheduled event to the next via the event calendar; nothing is
 * stepped on a fixed tick and nothing is faked. The engine is incremental
 * (`step()` processes exactly one event), which is what lets the live factory
 * view in requirement 38 be driven by real simulation state rather than by an
 * animation pretending to be one.
 *
 * Event set (requirement 2): ARRIVAL, SERVICE_COMPLETE, BREAKDOWN,
 * REPAIR_COMPLETE, WARMUP_END, END_OF_HORIZON. Queue entry/exit, resource
 * acquisition, inspection, rework routing and scrap are state transitions
 * triggered by those events rather than separate calendar entries — they occur
 * at the same instant as the event that causes them, so giving them their own
 * calendar entries would add ordering ambiguity without adding fidelity.
 *
 * Determinism: every random draw comes from a named substream of the master
 * seed (see rng.ts), and simultaneous events fire in scheduling order (see
 * eventQueue.ts). The same model plus the same seed therefore reproduces
 * exactly.
 *
 * All simulation times are in MINUTES.
 */

import { sample, type Distribution } from '../distributions.js';
import { Rng, RngStreams } from '../rng.js';
import {
  SINK_FINISHED,
  SINK_SCRAP,
  isSink,
  type MachineSpec,
  type Station,
  type SystemModel,
} from '../model/types.js';
import { EventQueue, type SimEvent } from './eventQueue.js';
import {
  createVehicle,
  cycleTimeMinutes,
  resetVehicleIds,
  type StationVisit,
  type Vehicle,
} from './vehicle.js';

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

interface ServerRuntime {
  index: number;
  vehicle: Vehicle | null;
  visit: StationVisit | null;
  /** Currently processing a vehicle. */
  busy: boolean;
  /** Machine failed; unavailable until repaired. */
  down: boolean;
  /** Validity token for the event this server is waiting on. */
  token: number;
  /** Scheduled completion time of the in-progress service. */
  scheduledCompletion: number;
  /** Productive service minutes still owed when a breakdown interrupts. */
  remainingServiceMinutes: number;
  /** Operating minutes until this machine's next failure. */
  residualTTFMinutes: number;
  /** Simulation time this server last changed state. */
  lastChange: number;
  /** Time the current repair started, for downtime attribution. */
  downSince: number;
}

interface StationStats {
  /** Integral of (queue + in service) dt — divide by elapsed for L. */
  areaL: number;
  /** Integral of queue length dt — divide by elapsed for Lq. */
  areaLq: number;
  /** Server-minutes spent processing. */
  busyServerMinutes: number;
  /** Server-minutes spent idle and available. */
  idleServerMinutes: number;
  /** Server-minutes spent failed. */
  downServerMinutes: number;
  /** Entries to this station (including repeat visits after rework). */
  arrivals: number;
  /** Services completed here. */
  completions: number;
  /** Vehicles turned away because the queue was full. */
  rejections: number;
  /** Sum of queue waiting times, for Wq. */
  sumWaitMinutes: number;
  waitObservations: number;
  /** Sum of total time in station (wait + service), for W. */
  sumSojournMinutes: number;
  sojournObservations: number;
  maxQueueLength: number;
  breakdowns: number;
  repairMinutes: number;
  /** Productive processing minutes delivered (excludes downtime). */
  processingMinutes: number;
}

interface StationRuntime {
  def: Station;
  queue: Vehicle[];
  /** Planned service minutes, drawn at enqueue so SPT can order the queue. */
  plannedService: Map<number, number>;
  servers: ServerRuntime[];
  stats: StationStats;
  /** Simulation time the time-weighted accumulators were last advanced to. */
  lastUpdate: number;
}

function emptyStats(): StationStats {
  return {
    areaL: 0,
    areaLq: 0,
    busyServerMinutes: 0,
    idleServerMinutes: 0,
    downServerMinutes: 0,
    arrivals: 0,
    completions: 0,
    rejections: 0,
    sumWaitMinutes: 0,
    waitObservations: 0,
    sumSojournMinutes: 0,
    sojournObservations: 0,
    maxQueueLength: 0,
    breakdowns: 0,
    repairMinutes: 0,
    processingMinutes: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export interface StationSimResult {
  stationId: string;
  stationName: string;
  kind: string;
  servers: number;
  /** Observed arrival rate at this station, vehicles/hour. */
  lambdaObserved: number;
  /** Observed throughput (completions), vehicles/hour. */
  throughput: number;
  /** Time-average number in station. */
  L: number;
  /** Time-average queue length. */
  Lq: number;
  /** Mean time in station, hours. */
  W: number;
  /** Mean queue wait, hours. */
  Wq: number;
  WMinutes: number;
  WqMinutes: number;
  /** Fraction of available server time spent processing. */
  utilization: number;
  /** Fraction of total server time spent failed (requirement 19). */
  downtimeFraction: number;
  busyServerMinutes: number;
  idleServerMinutes: number;
  downServerMinutes: number;
  maxQueueLength: number;
  arrivals: number;
  completions: number;
  rejections: number;
  breakdowns: number;
  repairMinutes: number;
  processingMinutes: number;
}

export interface SystemSimResult {
  /** Length of the measurement window, minutes (excludes warm-up). */
  measurementMinutes: number;
  vehiclesEntered: number;
  vehiclesCompleted: number;
  vehiclesScrapped: number;
  vehiclesRejected: number;
  vehiclesReworked: number;
  /** Still in the factory when the run ended. */
  vehiclesInSystemAtEnd: number;
  /** Finished vehicles per hour. */
  throughputPerHour: number;
  /** Time-average WIP across the whole factory. */
  L: number;
  Lq: number;
  /** Mean total manufacturing time, hours. */
  W: number;
  Wq: number;
  WMinutes: number;
  WqMinutes: number;
  /** Cycle-time distribution over completed vehicles (requirement 12). */
  cycleTime: {
    count: number;
    meanMinutes: number;
    medianMinutes: number;
    p95Minutes: number;
    maxMinutes: number;
    minMinutes: number;
    stdDevMinutes: number;
  };
  /** Mean split of a finished vehicle's time (requirement 12). */
  timeSplit: {
    waitingMinutes: number;
    processingMinutes: number;
    downtimeMinutes: number;
    reworkMinutes: number;
    inspectionMinutes: number;
  };
  maxWIP: number;
  /** Total vehicle-hours spent waiting — priced by the cost engine (req 25). */
  totalWaitingVehicleHours: number;
  /** Total vehicle-hours of WIP — priced as holding cost (requirement 24). */
  totalWipVehicleHours: number;
  /** Mean server utilisation across stations, weighted by server count. */
  factoryUtilization: number;
}

export interface SimulationResult {
  seed: number;
  replication: number;
  stations: StationSimResult[];
  system: SystemSimResult;
  /** Per-vehicle records (requirement 3), subject to `maxTraces`. */
  traces: Vehicle[];
  /** Completed vehicles retained for the cost engine. */
  completedVehicles: Vehicle[];
  eventsProcessed: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Live state for the visualisation (requirements 38, 39)              */
/* ------------------------------------------------------------------ */

export interface LiveStationState {
  stationId: string;
  stationName: string;
  queueLength: number;
  /** Tags of the vehicles waiting, front of queue first. */
  queueVehicles: { id: number; tag: string; waitingSince: number }[];
  servers: {
    index: number;
    busy: boolean;
    down: boolean;
    vehicleTag: string | null;
    vehicleId: number | null;
    /** Fraction of the current service completed, 0..1. */
    progress: number;
  }[];
  busyServers: number;
  downServers: number;
  /** Running utilisation since the stats window opened. */
  utilization: number;
}

export interface LiveState {
  /** Current simulation clock, minutes. */
  now: number;
  phase: 'WARMUP' | 'MEASURING' | 'DRAINING' | 'FINISHED';
  stations: LiveStationState[];
  vehiclesEntered: number;
  vehiclesCompleted: number;
  vehiclesScrapped: number;
  wip: number;
  eventsProcessed: number;
  nextEventTime: number | null;
}

/* ------------------------------------------------------------------ */
/* The simulator                                                       */
/* ------------------------------------------------------------------ */

export class Simulation {
  readonly model: SystemModel;
  readonly seed: number;
  readonly replication: number;

  private readonly calendar = new EventQueue();
  private readonly streams: RngStreams;
  private readonly stations = new Map<string, StationRuntime>();
  private readonly vehiclesById = new Map<number, Vehicle>();

  /** Current simulation time, minutes. */
  now = 0;
  private readonly warmupMinutes: number;
  private readonly horizonMinutes: number;
  private statsStart = 0;
  /**
   * Time-weighted statistics close here and never accumulate past it. Without
   * this clamp, a `drain` run keeps adding queue-area after the horizon while
   * the measurement window stays fixed, which silently inflates L and Lq.
   */
  private readonly statsEnd: number;

  private arrivalsStopped = false;
  private finished = false;
  private eventsProcessed = 0;

  private vehiclesEntered = 0;
  private vehiclesCompleted = 0;
  private vehiclesScrapped = 0;
  private vehiclesRejected = 0;
  private vehiclesReworked = 0;
  private maxWIP = 0;
  private wip = 0;

  private readonly completed: Vehicle[] = [];
  private readonly traces: Vehicle[] = [];
  private readonly warnings: string[] = [];

  private readonly cycleMinutes: number;

  constructor(model: SystemModel, options: { replication?: number; seed?: number } = {}) {
    this.model = model;
    this.replication = options.replication ?? 0;
    this.seed =
      options.seed ??
      (this.replication > 0
        ? RngStreams.replicationSeed(model.simulation.seed, this.replication)
        : model.simulation.seed);
    this.streams = new RngStreams(this.seed);

    this.warmupMinutes = Math.max(0, model.simulation.warmupMinutes);
    this.horizonMinutes = this.warmupMinutes + Math.max(0, model.simulation.durationMinutes);
    this.statsEnd = this.horizonMinutes;

    const maxEnd = model.arrivals.schedule.reduce((m, b) => Math.max(m, b.endMinute), 0);
    this.cycleMinutes = maxEnd > 0 ? maxEnd : this.horizonMinutes;

    resetVehicleIds(1);
    this.initStations();
    this.initCalendar();
  }

  /* ---------------------------------------------------------------- */
  /* Setup                                                            */
  /* ---------------------------------------------------------------- */

  private initStations(): void {
    for (const def of this.model.stations) {
      const servers: ServerRuntime[] = [];
      for (let i = 0; i < def.servers; i++) {
        servers.push({
          index: i,
          vehicle: null,
          visit: null,
          busy: false,
          down: false,
          token: 0,
          scheduledCompletion: 0,
          remainingServiceMinutes: 0,
          residualTTFMinutes: this.drawTTF(def, i),
          lastChange: 0,
          downSince: 0,
        });
      }
      this.stations.set(def.id, {
        def,
        queue: [],
        plannedService: new Map(),
        servers,
        stats: emptyStats(),
        lastUpdate: 0,
      });
    }
  }

  private initCalendar(): void {
    if (this.warmupMinutes > 0) {
      this.calendar.schedule({ time: this.warmupMinutes, kind: 'WARMUP_END' });
    }
    this.calendar.schedule({ time: this.horizonMinutes, kind: 'END_OF_HORIZON' });
    const first = this.nextArrivalTime(0);
    if (first !== null && first <= this.horizonMinutes) {
      this.calendar.schedule({ time: first, kind: 'ARRIVAL' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Arrival process (requirements 7 and 36)                          */
  /* ---------------------------------------------------------------- */

  /** External arrival rate in force at time t, and the end of that block. */
  private rateAt(t: number): { rate: number; blockEnd: number } {
    const blocks = this.model.arrivals.schedule;
    if (blocks.length === 0) return { rate: 0, blockEnd: Infinity };

    const cycles = Math.floor(t / this.cycleMinutes);
    const offset = t - cycles * this.cycleMinutes;
    for (const b of blocks) {
      if (offset >= b.startMinute && offset < b.endMinute) {
        return {
          rate: b.lambdaPerHour.value,
          blockEnd: cycles * this.cycleMinutes + b.endMinute,
        };
      }
    }
    // Gap in the schedule: no arrivals until the next block starts.
    const next = blocks
      .map((b) => cycles * this.cycleMinutes + b.startMinute)
      .filter((s) => s > t)
      .sort((a, b) => a - b)[0];
    return { rate: 0, blockEnd: next ?? (cycles + 1) * this.cycleMinutes };
  }

  /**
   * Time of the next external arrival after `from`.
   *
   * Because the exponential is memoryless, re-drawing at a block boundary when
   * a draw would overshoot it yields exactly the correct piecewise-constant
   * Poisson process. For non-exponential inter-arrival families this boundary
   * re-draw is an approximation, and that is recorded as a warning.
   */
  private nextArrivalTime(from: number): number | null {
    const rng = this.streams.get('arrivals');
    const kind = this.model.arrivals.interarrivalKind;
    let t = from;
    for (let guard = 0; guard < 100000; guard++) {
      if (t > this.horizonMinutes) return null;
      const { rate, blockEnd } = this.rateAt(t);
      if (rate <= 0) {
        if (!Number.isFinite(blockEnd)) return null;
        t = blockEnd;
        continue;
      }
      const meanMinutes = 60 / rate;
      const dist = interarrivalDist(kind, meanMinutes);
      const dt = sample(dist, rng);
      if (t + dt <= blockEnd) return t + dt;
      t = blockEnd;
    }
    return null;
  }

  private pickModelId(): string {
    const mix = this.model.arrivals.modelMix;
    if (mix.length === 1) return (mix[0] as (typeof mix)[number]).modelId;
    const rng = this.streams.get('model-mix');
    const u = rng.next();
    let cum = 0;
    for (const m of mix) {
      cum += m.share;
      if (u < cum) return m.modelId;
    }
    return (mix[mix.length - 1] as (typeof mix)[number]).modelId;
  }

  /* ---------------------------------------------------------------- */
  /* Machine reliability (requirement 19)                             */
  /* ---------------------------------------------------------------- */

  private reliabilityOf(def: Station): MachineSpec['reliability'] | undefined {
    const rel = def.machine?.reliability;
    return rel && rel.enabled ? rel : undefined;
  }

  /** Operating minutes until the next failure for this machine. */
  private drawTTF(def: Station, serverIndex: number): number {
    const rel = this.reliabilityOf(def);
    if (!rel) return Infinity;
    const rng = this.streams.get(`failure:${def.id}:${serverIndex}`);
    const meanMinutes = rel.mtbfHours.value * 60;
    return sample(reliabilityDist(rel.failureDist, meanMinutes), rng);
  }

  private drawRepair(def: Station, serverIndex: number): number {
    const rel = this.reliabilityOf(def);
    if (!rel) return 0;
    const rng = this.streams.get(`repair:${def.id}:${serverIndex}`);
    const meanMinutes = rel.mttrHours.value * 60;
    return sample(reliabilityDist(rel.repairDist, meanMinutes), rng);
  }

  /* ---------------------------------------------------------------- */
  /* Time-weighted statistics                                          */
  /* ---------------------------------------------------------------- */

  /** True while the clock is inside the measurement window. */
  private inWindow(): boolean {
    return this.now >= this.warmupMinutes && this.now <= this.statsEnd;
  }

  /**
   * Advance a station's time-weighted accumulators to `now`, clamped to the
   * close of the measurement window.
   */
  private touch(st: StationRuntime): void {
    const t = Math.min(this.now, this.statsEnd);
    const dt = t - st.lastUpdate;
    if (dt <= 0) {
      st.lastUpdate = Math.max(st.lastUpdate, t);
      return;
    }
    const busy = st.servers.reduce((n, s) => n + (s.busy ? 1 : 0), 0);
    const inStation = st.queue.length + busy;
    st.stats.areaL += dt * inStation;
    st.stats.areaLq += dt * st.queue.length;
    for (const s of st.servers) {
      if (s.down) st.stats.downServerMinutes += dt;
      else if (s.busy) st.stats.busyServerMinutes += dt;
      else st.stats.idleServerMinutes += dt;
    }
    st.lastUpdate = t;
  }

  /**
   * System-level WIP area is NOT accumulated separately. Transport time
   * between stations is zero, so every vehicle in the factory is queued or in
   * service at exactly one station, and the system areas are the sums of the
   * station areas by construction. Deriving them avoids a second accumulator
   * that would have to be updated on every state change to stay correct.
   */
  private touchAll(): void {
    for (const st of this.stations.values()) this.touch(st);
  }

  private resetStatistics(): void {
    this.touchAll();
    for (const st of this.stations.values()) {
      st.stats = emptyStats();
      st.lastUpdate = this.now;
      st.stats.maxQueueLength = st.queue.length;
    }
    this.statsStart = this.now;
    this.vehiclesEntered = 0;
    this.vehiclesCompleted = 0;
    this.vehiclesScrapped = 0;
    this.vehiclesRejected = 0;
    this.vehiclesReworked = 0;
    this.maxWIP = this.wip;
    this.completed.length = 0;
    this.traces.length = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Event loop                                                        */
  /* ---------------------------------------------------------------- */

  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Process exactly one event. Returns the event processed, or null when the
   * run is over. This is what the "Step event" control in requirement 38 calls.
   */
  step(): SimEvent | null {
    if (this.finished) return null;
    const ev = this.calendar.pop();
    if (!ev) {
      this.endRun();
      return null;
    }
    this.now = Math.max(this.now, ev.time);
    this.eventsProcessed++;

    switch (ev.kind) {
      case 'ARRIVAL':
        this.onArrival();
        break;
      case 'SERVICE_COMPLETE':
        this.onServiceComplete(ev);
        break;
      case 'BREAKDOWN':
        this.onBreakdown(ev);
        break;
      case 'REPAIR_COMPLETE':
        this.onRepairComplete(ev);
        break;
      case 'WARMUP_END':
        this.resetStatistics();
        break;
      case 'END_OF_HORIZON':
        this.onEndOfHorizon();
        break;
    }
    return ev;
  }

  /** Run to completion. */
  run(): SimulationResult {
    let guard = 0;
    const limit = 50_000_000;
    while (!this.finished && guard++ < limit) {
      if (this.step() === null) break;
    }
    if (guard >= limit) {
      this.warnings.push('Simulation stopped after hitting the event-count safety limit.');
      this.endRun();
    }
    return this.result();
  }

  /** Run until the clock reaches `targetMinutes`, for the live view. */
  runUntil(targetMinutes: number): void {
    while (!this.finished) {
      const next = this.calendar.peekTime();
      if (next === null || next > targetMinutes) {
        this.now = Math.min(targetMinutes, this.horizonMinutes);
        this.touchAll();
        break;
      }
      this.step();
    }
  }

  private onEndOfHorizon(): void {
    if (this.model.simulation.terminationMode === 'drain') {
      // Stop injecting work and let the factory empty out. Statistics still
      // close at the horizon so the measurement window stays exactly as
      // configured; drain time only affects which vehicles finish.
      this.arrivalsStopped = true;
      this.touchAll();
      if (this.wip === 0) this.endRun();
    } else {
      this.endRun();
    }
  }

  private endRun(): void {
    if (this.finished) return;
    this.touchAll();
    // Anything still in the factory stays IN_SYSTEM. It is counted as WIP and
    // is deliberately NOT given a cycle time: inventing one would be a
    // fabricated number (requirement 60).
    this.finished = true;
  }

  /* ---------------------------------------------------------------- */
  /* Event handlers                                                    */
  /* ---------------------------------------------------------------- */

  private onArrival(): void {
    if (!this.arrivalsStopped) {
      const next = this.nextArrivalTime(this.now);
      if (next !== null && next <= this.horizonMinutes) {
        this.calendar.schedule({ time: next, kind: 'ARRIVAL' });
      }
    }
    if (this.now > this.horizonMinutes) return;

    const counted = this.inWindow();
    const vehicle = createVehicle(this.pickModelId(), this.now, counted);
    this.vehiclesById.set(vehicle.id, vehicle);
    if (counted) this.vehiclesEntered++;

    this.enterStation(vehicle, this.model.arrivals.entryStationId);
  }

  /** Queue entry: the transition that makes a vehicle join a station. */
  private enterStation(vehicle: Vehicle, stationId: string): void {
    const st = this.stations.get(stationId);
    if (!st) {
      this.warnings.push(`Routing referenced unknown station "${stationId}"; vehicle dropped.`);
      return;
    }
    this.touch(st);

    // Finite queue capacity: the vehicle is turned away rather than blocking
    // upstream. Default capacity is unbounded, so this only fires when the
    // user has deliberately constrained the buffer.
    if (st.def.queueCapacity !== null && st.queue.length >= st.def.queueCapacity) {
      st.stats.rejections++;
      vehicle.status = 'REJECTED';
      vehicle.completionTime = this.now;
      vehicle.currentState = 'DONE';
      vehicle.currentStationId = null;
      if (vehicle.countedInStatistics) this.vehiclesRejected++;
      this.recordTrace(vehicle);
      return;
    }

    const visitNumber = vehicle.visits.filter((v) => v.stationId === stationId).length + 1;
    const visit: StationVisit = {
      stationId,
      stationName: st.def.name,
      visitNumber,
      enqueuedAt: this.now,
      serviceStartedAt: null,
      serviceEndedAt: null,
      waitMinutes: 0,
      occupancyMinutes: 0,
      processingMinutes: 0,
      downtimeMinutes: 0,
      serverIndex: null,
      outcome: 'INCOMPLETE',
      routedTo: null,
    };
    vehicle.visits.push(visit);
    vehicle.currentStationId = stationId;
    vehicle.currentState = 'QUEUED';
    if (!vehicle.stationsEntered.includes(stationId)) vehicle.stationsEntered.push(stationId);

    if (vehicle.visits.length === 1) {
      this.wip++;
      if (this.wip > this.maxWIP) this.maxWIP = this.wip;
    }

    st.stats.arrivals++;
    // Draw the service time now rather than at service start: SPT needs to
    // know it to order the queue, and drawing at a single well-defined moment
    // keeps the per-station stream consumption reproducible.
    st.plannedService.set(vehicle.id, this.drawService(st.def));
    st.queue.push(vehicle);
    if (st.queue.length > st.stats.maxQueueLength) st.stats.maxQueueLength = st.queue.length;

    this.tryStartService(st);
  }

  private drawService(def: Station): number {
    const rng = this.streams.get(`service:${def.id}`);
    return sample(def.service, rng);
  }

  /** Resource acquisition: match waiting vehicles to free, working servers. */
  private tryStartService(st: StationRuntime): void {
    for (;;) {
      if (st.queue.length === 0) return;
      const server = st.servers.find((s) => !s.busy && !s.down);
      if (!server) return;

      const vehicle = this.dequeue(st);
      if (!vehicle) return;

      this.touch(st);
      const visit = currentVisit(vehicle, st.def.id);
      const wait = this.now - (visit?.enqueuedAt ?? this.now);
      if (visit) {
        visit.serviceStartedAt = this.now;
        visit.waitMinutes = wait;
        visit.serverIndex = server.index;
      }
      vehicle.currentState = 'IN_SERVICE';
      vehicle.totalWaitMinutes += wait;
      vehicle.waitMinutesByStation[st.def.id] =
        (vehicle.waitMinutesByStation[st.def.id] ?? 0) + wait;

      if (this.inWindow()) {
        st.stats.sumWaitMinutes += wait;
        st.stats.waitObservations++;
      }

      const serviceMinutes = st.plannedService.get(vehicle.id) ?? this.drawService(st.def);
      st.plannedService.delete(vehicle.id);

      server.busy = true;
      server.vehicle = vehicle;
      server.visit = visit ?? null;
      server.remainingServiceMinutes = serviceMinutes;
      server.token++;

      this.scheduleServiceEnd(st, server);
    }
  }

  /**
   * Schedule whichever comes first: the end of the remaining service, or the
   * machine failure that interrupts it. Failure clocks run on OPERATING time,
   * so `residualTTFMinutes` is only consumed while a machine is processing.
   */
  private scheduleServiceEnd(st: StationRuntime, server: ServerRuntime): void {
    const remaining = server.remainingServiceMinutes;
    if (server.residualTTFMinutes < remaining) {
      const t = this.now + server.residualTTFMinutes;
      server.scheduledCompletion = this.now + remaining;
      this.calendar.schedule({
        time: t,
        kind: 'BREAKDOWN',
        stationId: st.def.id,
        serverIndex: server.index,
        token: server.token,
      });
    } else {
      server.scheduledCompletion = this.now + remaining;
      this.calendar.schedule({
        time: server.scheduledCompletion,
        kind: 'SERVICE_COMPLETE',
        stationId: st.def.id,
        serverIndex: server.index,
        token: server.token,
      });
    }
  }

  private dequeue(st: StationRuntime): Vehicle | null {
    const q = st.queue;
    if (q.length === 0) return null;
    switch (st.def.queueDiscipline) {
      case 'FIFO':
        return q.shift() ?? null;
      case 'LIFO':
        return q.pop() ?? null;
      case 'SPT': {
        // Shortest processing time first, using the service time already drawn.
        let best = 0;
        let bestVal = Infinity;
        for (let i = 0; i < q.length; i++) {
          const v = st.plannedService.get((q[i] as Vehicle).id) ?? Infinity;
          if (v < bestVal) {
            bestVal = v;
            best = i;
          }
        }
        return q.splice(best, 1)[0] ?? null;
      }
      case 'PRIORITY': {
        // Reworked vehicles first (they are already late and hold WIP value),
        // FIFO within each class. This rule is a modelling choice, surfaced in
        // the station panel rather than hidden here.
        let best = -1;
        for (let i = 0; i < q.length; i++) {
          if ((q[i] as Vehicle).reworkCount > 0) {
            best = i;
            break;
          }
        }
        if (best < 0) return q.shift() ?? null;
        return q.splice(best, 1)[0] ?? null;
      }
    }
  }

  private onServiceComplete(ev: SimEvent): void {
    const st = this.stations.get(ev.stationId as string);
    if (!st) return;
    const server = st.servers[ev.serverIndex as number];
    if (!server || server.token !== ev.token || !server.busy) return; // superseded

    this.touch(st);
    const vehicle = server.vehicle as Vehicle;
    const visit = server.visit;

    const processing = server.remainingServiceMinutes;
    if (visit) {
      visit.serviceEndedAt = this.now;
      visit.processingMinutes += processing;
      visit.occupancyMinutes = this.now - (visit.serviceStartedAt ?? this.now);
    }
    vehicle.totalProcessingMinutes += processing;
    vehicle.serverMinutesByStation[st.def.id] =
      (vehicle.serverMinutesByStation[st.def.id] ?? 0) + processing;

    st.stats.completions++;
    st.stats.processingMinutes += processing;
    if (this.inWindow() && visit) {
      st.stats.sumSojournMinutes += this.now - visit.enqueuedAt;
      st.stats.sojournObservations++;
    }

    // Consume the machine's operating life.
    if (Number.isFinite(server.residualTTFMinutes)) {
      server.residualTTFMinutes -= processing;
    }

    // Release the server before routing, so a vehicle routed back to this same
    // station can be served by the server it just left.
    server.busy = false;
    server.vehicle = null;
    server.visit = null;
    server.remainingServiceMinutes = 0;
    server.lastChange = this.now;

    this.routeVehicle(vehicle, st, visit);
    this.tryStartService(st);
  }

  /** Inspection outcome, scrap and routing all resolve here. */
  private routeVehicle(vehicle: Vehicle, st: StationRuntime, visit: StationVisit | null): void {
    const def = st.def;
    if (def.kind === 'inspection') vehicle.inspectionCount++;

    // Station-level scrap, applied before routing.
    if (def.scrapProbability > 0) {
      const rng = this.streams.get(`scrap:${def.id}`);
      if (rng.bernoulli(def.scrapProbability)) {
        if (visit) {
          visit.outcome = 'SCRAP';
          visit.routedTo = SINK_SCRAP;
        }
        this.finishVehicle(vehicle, 'SCRAPPED');
        return;
      }
    }

    const dest = this.pickRoute(def);
    if (dest === null) {
      // No routing arcs: treat as the end of the line.
      if (visit) {
        visit.outcome = 'FINISHED';
        visit.routedTo = SINK_FINISHED;
      }
      this.finishVehicle(vehicle, 'FINISHED');
      return;
    }

    if (visit) visit.routedTo = dest;

    if (dest === SINK_FINISHED) {
      if (visit) visit.outcome = def.kind === 'inspection' ? 'PASS' : 'FINISHED';
      this.finishVehicle(vehicle, 'FINISHED');
      return;
    }
    if (dest === SINK_SCRAP) {
      if (visit) visit.outcome = 'SCRAP';
      this.finishVehicle(vehicle, 'SCRAPPED');
      return;
    }

    const destStation = this.stations.get(dest);
    const destIsRework = destStation?.def.kind === 'rework';
    if (visit) {
      if (def.kind === 'inspection') visit.outcome = destIsRework ? 'FAIL' : 'PASS';
      else visit.outcome = 'ROUTED';
    }
    if (destIsRework) {
      vehicle.reworkCount++;
      if (vehicle.countedInStatistics && vehicle.reworkCount === 1) this.vehiclesReworked++;
    }

    this.enterStation(vehicle, dest);
  }

  private pickRoute(def: Station): string | null {
    if (def.routing.length === 0) return null;
    if (def.routing.length === 1) return (def.routing[0] as (typeof def.routing)[number]).to;
    const rng = this.streams.get(`routing:${def.id}`);
    const u = rng.next();
    let cum = 0;
    for (const e of def.routing) {
      cum += e.probability;
      if (u < cum) return e.to;
    }
    return (def.routing[def.routing.length - 1] as (typeof def.routing)[number]).to;
  }

  private finishVehicle(vehicle: Vehicle, status: 'FINISHED' | 'SCRAPPED'): void {
    vehicle.status = status;
    vehicle.completionTime = this.now;
    vehicle.currentStationId = null;
    vehicle.currentState = 'DONE';
    this.wip = Math.max(0, this.wip - 1);

    if (vehicle.countedInStatistics) {
      // POPULATION CHOICE. Every count and every cost here is taken over one
      // population: the ARRIVAL COHORT, meaning the vehicles that entered the
      // factory during the measurement window, followed to completion however
      // long that takes (including into a drain period past the horizon).
      //
      // The obvious alternative — counting departures that fall inside the
      // window — is wrong for this engine for two reasons:
      //
      //  1. It would undercount. Vehicles that entered before the warm-up cut
      //     off are excluded from the cohort but would still be departing
      //     during the window, and the ones entering late in the window have
      //     not finished yet. Gating departures on the window as well as
      //     arrivals excludes both groups and reports a throughput far below
      //     the real one.
      //  2. It would make cost per vehicle incoherent. The cost engine prices
      //     this same `completed` array, so if throughput counted a different
      //     set of vehicles than cost did, revenue and cost per vehicle would
      //     be computed over mismatched populations.
      //
      // With `drain` termination the cohort finishes in full, so throughput is
      // unbiased. With `hardStop` some of it is censored, which is why the
      // result carries an explicit warning naming how many vehicles were cut off.
      if (status === 'FINISHED') this.vehiclesCompleted++;
      else this.vehiclesScrapped++;
      // Scrapped units are retained too: they carry sunk cost (requirement 23).
      this.completed.push(vehicle);
    }
    this.recordTrace(vehicle);
    this.vehiclesById.delete(vehicle.id);

    if (this.arrivalsStopped && this.wip === 0) this.endRun();
  }

  private recordTrace(vehicle: Vehicle): void {
    if (!this.model.simulation.collectVehicleTraces) return;
    if (!vehicle.countedInStatistics) return;
    if (this.traces.length >= this.model.simulation.maxTraces) return;
    this.traces.push(vehicle);
  }

  private onBreakdown(ev: SimEvent): void {
    const st = this.stations.get(ev.stationId as string);
    if (!st) return;
    const server = st.servers[ev.serverIndex as number];
    if (!server || server.token !== ev.token || server.down) return;

    this.touch(st);
    // The vehicle stays mounted on the failed machine; work already done is
    // preserved and the remainder resumes after repair (preemptive-resume).
    if (server.busy) {
      const done = Math.max(0, server.remainingServiceMinutes - (server.scheduledCompletion - this.now));
      server.remainingServiceMinutes -= done;
      if (server.visit) server.visit.processingMinutes += done;
      if (server.vehicle) {
        server.vehicle.totalProcessingMinutes += done;
        server.vehicle.serverMinutesByStation[st.def.id] =
          (server.vehicle.serverMinutesByStation[st.def.id] ?? 0) + done;
      }
      st.stats.processingMinutes += done;
    }

    server.down = true;
    server.downSince = this.now;
    server.token++;
    st.stats.breakdowns++;

    const repair = this.drawRepair(st.def, server.index);
    this.calendar.schedule({
      time: this.now + repair,
      kind: 'REPAIR_COMPLETE',
      stationId: st.def.id,
      serverIndex: server.index,
      token: server.token,
    });
  }

  private onRepairComplete(ev: SimEvent): void {
    const st = this.stations.get(ev.stationId as string);
    if (!st) return;
    const server = st.servers[ev.serverIndex as number];
    if (!server || server.token !== ev.token || !server.down) return;

    this.touch(st);
    const downMinutes = this.now - server.downSince;
    st.stats.repairMinutes += downMinutes;
    if (server.visit) server.visit.downtimeMinutes += downMinutes;
    if (server.vehicle) server.vehicle.totalDowntimeMinutes += downMinutes;

    server.down = false;
    server.residualTTFMinutes = this.drawTTF(st.def, server.index);
    server.token++;

    if (server.busy) {
      this.scheduleServiceEnd(st, server);
    } else {
      this.tryStartService(st);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Live state (requirements 38, 39)                                  */
  /* ---------------------------------------------------------------- */

  liveState(): LiveState {
    const stations: LiveStationState[] = [];
    for (const st of this.stations.values()) {
      const elapsed = Math.max(1e-9, this.now - st.lastUpdate + this.elapsedStats());
      const busyServers = st.servers.filter((s) => s.busy).length;
      const downServers = st.servers.filter((s) => s.down).length;
      stations.push({
        stationId: st.def.id,
        stationName: st.def.name,
        queueLength: st.queue.length,
        queueVehicles: st.queue.slice(0, 40).map((v) => ({
          id: v.id,
          tag: v.tag,
          waitingSince: currentVisit(v, st.def.id)?.enqueuedAt ?? this.now,
        })),
        servers: st.servers.map((s) => {
          const total = s.busy ? s.scheduledCompletion - (s.visit?.serviceStartedAt ?? this.now) : 0;
          const elapsedSvc = s.busy ? this.now - (s.visit?.serviceStartedAt ?? this.now) : 0;
          return {
            index: s.index,
            busy: s.busy,
            down: s.down,
            vehicleTag: s.vehicle?.tag ?? null,
            vehicleId: s.vehicle?.id ?? null,
            progress: total > 0 ? Math.min(1, Math.max(0, elapsedSvc / total)) : 0,
          };
        }),
        busyServers,
        downServers,
        utilization:
          st.stats.busyServerMinutes /
          Math.max(1e-9, st.stats.busyServerMinutes + st.stats.idleServerMinutes + st.stats.downServerMinutes),
      });
      void elapsed;
    }

    let phase: LiveState['phase'];
    if (this.finished) phase = 'FINISHED';
    else if (this.arrivalsStopped) phase = 'DRAINING';
    else if (this.now < this.warmupMinutes) phase = 'WARMUP';
    else phase = 'MEASURING';

    return {
      now: this.now,
      phase,
      stations,
      vehiclesEntered: this.vehiclesEntered,
      vehiclesCompleted: this.vehiclesCompleted,
      vehiclesScrapped: this.vehiclesScrapped,
      wip: this.wip,
      eventsProcessed: this.eventsProcessed,
      nextEventTime: this.calendar.peekTime(),
    };
  }

  /** Vehicle currently tracked by the simulation, for the inspector panel. */
  getVehicle(id: number): Vehicle | undefined {
    return this.vehiclesById.get(id) ?? this.traces.find((v) => v.id === id);
  }

  private elapsedStats(): number {
    return Math.max(0, this.now - this.statsStart);
  }

  /* ---------------------------------------------------------------- */
  /* Results                                                           */
  /* ---------------------------------------------------------------- */

  result(): SimulationResult {
    this.touchAll();
    const elapsed = Math.max(1e-9, Math.min(this.now, this.horizonMinutes) - this.statsStart);
    const elapsedHours = elapsed / 60;

    const stations: StationSimResult[] = [];
    let weightedUtil = 0;
    let totalServers = 0;
    let systemAreaL = 0;
    let systemAreaLq = 0;

    for (const st of this.stations.values()) {
      const s = st.stats;
      const serverMinutes = s.busyServerMinutes + s.idleServerMinutes + s.downServerMinutes;
      const utilization = serverMinutes > 0 ? s.busyServerMinutes / serverMinutes : 0;
      const L = s.areaL / elapsed;
      const Lq = s.areaLq / elapsed;
      systemAreaL += s.areaL;
      systemAreaLq += s.areaLq;
      const WqMinutes = s.waitObservations > 0 ? s.sumWaitMinutes / s.waitObservations : 0;
      const WMinutes = s.sojournObservations > 0 ? s.sumSojournMinutes / s.sojournObservations : 0;

      stations.push({
        stationId: st.def.id,
        stationName: st.def.name,
        kind: st.def.kind,
        servers: st.def.servers,
        lambdaObserved: s.arrivals / elapsedHours,
        throughput: s.completions / elapsedHours,
        L,
        Lq,
        W: WMinutes / 60,
        Wq: WqMinutes / 60,
        WMinutes,
        WqMinutes,
        utilization,
        downtimeFraction: serverMinutes > 0 ? s.downServerMinutes / serverMinutes : 0,
        busyServerMinutes: s.busyServerMinutes,
        idleServerMinutes: s.idleServerMinutes,
        downServerMinutes: s.downServerMinutes,
        maxQueueLength: s.maxQueueLength,
        arrivals: s.arrivals,
        completions: s.completions,
        rejections: s.rejections,
        breakdowns: s.breakdowns,
        repairMinutes: s.repairMinutes,
        processingMinutes: s.processingMinutes,
      });

      weightedUtil += utilization * st.def.servers;
      totalServers += st.def.servers;
    }

    // Cycle-time distribution over vehicles that FINISHED (requirement 12).
    const finished = this.completed.filter((v) => v.status === 'FINISHED');
    const cycles = finished
      .map((v) => cycleTimeMinutes(v))
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);

    const cycleStats = summarise(cycles);

    let waiting = 0;
    let processing = 0;
    let downtime = 0;
    let rework = 0;
    let inspection = 0;
    const kinds: Record<string, string> = {};
    for (const s of this.model.stations) kinds[s.id] = s.kind;
    for (const v of finished) {
      waiting += v.totalWaitMinutes;
      processing += v.totalProcessingMinutes;
      downtime += v.totalDowntimeMinutes;
      for (const visit of v.visits) {
        const k = kinds[visit.stationId];
        if (k === 'rework') rework += visit.processingMinutes;
        else if (k === 'inspection') inspection += visit.processingMinutes;
      }
    }
    const n = Math.max(1, finished.length);

    // Zero transport time means every vehicle in the factory sits at exactly
    // one station, so the system areas are the station areas summed.
    const L = systemAreaL / elapsed;
    const Lq = systemAreaLq / elapsed;
    const WMinutes = cycleStats.mean;
    const totalWaitingVehicleHours = systemAreaLq / 60;
    const totalWipVehicleHours = systemAreaL / 60;

    const system: SystemSimResult = {
      measurementMinutes: elapsed,
      vehiclesEntered: this.vehiclesEntered,
      vehiclesCompleted: this.vehiclesCompleted,
      vehiclesScrapped: this.vehiclesScrapped,
      vehiclesRejected: this.vehiclesRejected,
      vehiclesReworked: this.vehiclesReworked,
      vehiclesInSystemAtEnd: this.wip,
      throughputPerHour: this.vehiclesCompleted / elapsedHours,
      L,
      Lq,
      W: WMinutes / 60,
      Wq: finished.length > 0 ? waiting / n / 60 : 0,
      WMinutes,
      WqMinutes: finished.length > 0 ? waiting / n : 0,
      cycleTime: {
        count: cycles.length,
        meanMinutes: cycleStats.mean,
        medianMinutes: cycleStats.median,
        p95Minutes: cycleStats.p95,
        maxMinutes: cycleStats.max,
        minMinutes: cycleStats.min,
        stdDevMinutes: cycleStats.stdDev,
      },
      timeSplit: {
        waitingMinutes: waiting / n,
        processingMinutes: processing / n,
        downtimeMinutes: downtime / n,
        reworkMinutes: rework / n,
        inspectionMinutes: inspection / n,
      },
      maxWIP: this.maxWIP,
      totalWaitingVehicleHours,
      totalWipVehicleHours,
      factoryUtilization: totalServers > 0 ? weightedUtil / totalServers : 0,
    };

    const warnings = [...this.warnings];
    if (this.model.arrivals.interarrivalKind !== 'exponential' && this.model.arrivals.schedule.length > 1) {
      warnings.push(
        'A non-exponential inter-arrival distribution is combined with a time-varying demand ' +
          'schedule. Inter-arrival draws are re-started at each block boundary, which is exact ' +
          'only for the exponential case; treat block-transition behaviour as approximate.',
      );
    }
    if (system.vehiclesInSystemAtEnd > 0 && this.model.simulation.terminationMode === 'hardStop') {
      warnings.push(
        `${system.vehiclesInSystemAtEnd} vehicles were still in the factory when the horizon ended. ` +
          'They are counted in WIP but excluded from cycle-time statistics, which biases the ' +
          'reported mean downwards. Use "drain" termination or a longer horizon to reduce this.',
      );
    }

    return {
      seed: this.seed,
      replication: this.replication,
      stations,
      system,
      traces: this.traces,
      completedVehicles: this.completed,
      eventsProcessed: this.eventsProcessed,
      warnings,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function currentVisit(v: Vehicle, stationId: string): StationVisit | undefined {
  for (let i = v.visits.length - 1; i >= 0; i--) {
    const visit = v.visits[i] as StationVisit;
    if (visit.stationId === stationId) return visit;
  }
  return undefined;
}

/** Inter-arrival distribution with the given mean, in minutes. */
function interarrivalDist(kind: string, meanMinutes: number): Distribution {
  switch (kind) {
    case 'constant':
      return { kind: 'constant', value: meanMinutes };
    case 'erlang':
      return { kind: 'erlang', k: 2, mean: meanMinutes };
    case 'lognormal':
      return { kind: 'lognormal', mean: meanMinutes, sd: meanMinutes * 0.5 };
    default:
      return { kind: 'exponential', mean: meanMinutes };
  }
}

function reliabilityDist(kind: string, meanMinutes: number): Distribution {
  switch (kind) {
    case 'constant':
      return { kind: 'constant', value: meanMinutes };
    case 'erlang':
      return { kind: 'erlang', k: 2, mean: meanMinutes };
    case 'lognormal':
      return { kind: 'lognormal', mean: meanMinutes, sd: meanMinutes * 0.5 };
    case 'weibull':
      return { kind: 'weibull', shape: 2, scale: meanMinutes / 0.8862269254527579 };
    default:
      return { kind: 'exponential', mean: meanMinutes };
  }
}

/** Summary statistics over a SORTED array. */
function summarise(sorted: number[]): {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  stdDev: number;
} {
  const n = sorted.length;
  if (n === 0) return { mean: 0, median: 0, p95: 0, min: 0, max: 0, stdDev: 0 };
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    mean,
    median: percentileSorted(sorted, 0.5),
    p95: percentileSorted(sorted, 0.95),
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    stdDev: Math.sqrt(variance),
  };
}

/** Linear-interpolation percentile over a sorted array. */
export function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] as number;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] as number;
  const w = idx - lo;
  return (sorted[lo] as number) * (1 - w) + (sorted[hi] as number) * w;
}

/** Run one replication to completion. */
export function runSimulation(
  model: SystemModel,
  options: { replication?: number; seed?: number } = {},
): SimulationResult {
  return new Simulation(model, options).run();
}
