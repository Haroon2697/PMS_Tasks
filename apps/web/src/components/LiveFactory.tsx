/**
 * Live factory view — requirements 38, 39, 64.
 *
 * THE ANIMATION IS THE SIMULATION. This component owns a real `Simulation`
 * instance and advances it with `runUntil(targetMinutes)`; every queue chip and
 * every busy server on screen is read back from that instance's actual state
 * via `liveState()`. Nothing here is interpolated, faked or pre-generated — if
 * the simulation is paused, the picture is frozen because the clock is frozen,
 * and "Step event" processes exactly one event from the event calendar.
 *
 * The render loop is deliberately decoupled from the event loop: a
 * requestAnimationFrame tick advances simulated time by (real elapsed time x
 * speed) and lets the engine process however many events fall in that interval.
 * Simulation speed therefore changes how fast time passes, never how the model
 * behaves — at any speed the same seed produces the same run.
 */

import {
  Simulation,
  type CurrencySettings,
  type LiveState,
  type SystemModel,
  type Vehicle,
  type VehicleCost,
} from '@vmq/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clock, minutes, money, num, pct } from '../lib/format';
import { Card, DataTable, EmptyState, Kpi, Notice, SidePanel } from './primitives';

export interface LiveController {
  state: LiveState | null;
  running: boolean;
  speed: number;
  setSpeed: (s: number) => void;
  start: () => void;
  pause: () => void;
  stop: () => void;
  reset: () => void;
  stepEvent: () => void;
  inspect: (vehicleId: number) => Vehicle | undefined;
}

/**
 * Drive a simulation in real time.
 *
 * `speed` is simulated MINUTES per real SECOND, so 60 means one simulated hour
 * per second. The per-frame advance is capped so that a browser tab returning
 * from the background does not try to execute hours of events in one frame.
 */
export function useLiveSimulation(model: SystemModel | null, speed0 = 30): LiveController {
  const simRef = useRef<Simulation | null>(null);
  const [state, setState] = useState<LiveState | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(speed0);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // Returns null when there is no model to simulate. React hooks must run in a
  // fixed order, so a page whose model may not exist yet still calls this hook
  // unconditionally and simply gets an inert controller.
  const ensure = useCallback(() => {
    if (!model) return null;
    if (!simRef.current) simRef.current = new Simulation(model);
    return simRef.current;
  }, [model]);

  // A model change invalidates the running simulation: continuing would show a
  // factory that no longer matches the parameters on screen.
  useEffect(() => {
    simRef.current = null;
    setState(null);
    setRunning(false);
    lastTsRef.current = null;
  }, [model]);

  useEffect(() => {
    if (!running) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      return;
    }
    const sim = ensure();
    if (!sim) return;

    const tick = (ts: number) => {
      const last = lastTsRef.current ?? ts;
      lastTsRef.current = ts;
      const realSeconds = Math.min((ts - last) / 1000, 0.25); // cap background catch-up
      const advance = realSeconds * speedRef.current;
      sim.runUntil(sim.now + advance);
      setState(sim.liveState());
      if (sim.isFinished) {
        setRunning(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [running, ensure]);

  return {
    state,
    running,
    speed,
    setSpeed,
    start: () => {
      if (!ensure()) return;
      setRunning(true);
    },
    pause: () => setRunning(false),
    stop: () => {
      setRunning(false);
      const sim = simRef.current;
      if (sim) setState(sim.liveState());
    },
    reset: () => {
      setRunning(false);
      if (!model) {
        simRef.current = null;
        setState(null);
        return;
      }
      simRef.current = new Simulation(model);
      setState(simRef.current.liveState());
      lastTsRef.current = null;
    },
    stepEvent: () => {
      const sim = ensure();
      if (!sim) return;
      sim.step();
      setState(sim.liveState());
    },
    inspect: (id: number) => simRef.current?.getVehicle(id),
  };
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function LiveFactoryView({
  model,
  controller,
  bottleneckId,
}: {
  model: SystemModel;
  controller: LiveController;
  bottleneckId: string | null;
}) {
  const { state } = controller;
  const [inspected, setInspected] = useState<Vehicle | null>(null);

  if (!state) {
    return (
      <EmptyState>
        The simulation has not started. Press <strong>Start</strong> to run the factory — every
        vehicle you see will be a real entity moving through the event-driven model.
      </EmptyState>
    );
  }

  const phaseNote: Record<LiveState['phase'], string> = {
    WARMUP:
      'Warm-up. The factory is filling from empty; nothing in this period is counted in the statistics.',
    MEASURING: 'Measuring. Arrivals and departures in this window count towards the results.',
    DRAINING: 'Draining. Arrivals have stopped; the vehicles already on the line are finishing.',
    FINISHED: 'Run complete.',
  };

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Kpi
          label="Simulation clock"
          value={clock(state.now)}
          basis="simulated"
          sub={`${minutes(state.now)} elapsed · ${num(state.eventsProcessed, 0)} events processed`}
          small
        />
        <Kpi
          label="Vehicles entered"
          value={num(state.vehiclesEntered, 0)}
          unit="veh"
          basis="simulated"
          sub="Counted from the end of warm-up"
        />
        <Kpi
          label="Completed"
          value={num(state.vehiclesCompleted, 0)}
          unit="veh"
          basis="simulated"
          sub={`${num(state.vehiclesScrapped, 0)} scrapped`}
        />
        <Kpi
          label="Work in progress"
          value={num(state.wip, 0)}
          unit="veh"
          basis="simulated"
          sub="On the line right now"
        />
      </div>

      <Notice kind={state.phase === 'MEASURING' ? 'info' : 'warn'} title={`Phase: ${state.phase}`}>
        {phaseNote[state.phase]}
        {state.nextEventTime !== null ? (
          <> Next scheduled event at {clock(state.nextEventTime)}.</>
        ) : null}
      </Notice>

      <div className="grid auto">
        {state.stations.map((s) => {
          const def = model.stations.find((x) => x.id === s.stationId);
          const congestion =
            s.queueLength === 0
              ? 'clear'
              : s.queueLength < 5
                ? 'light'
                : s.queueLength < 12
                  ? 'building'
                  : 'congested';
          return (
            <div
              key={s.stationId}
              className={`live-station${s.stationId === bottleneckId ? ' bottleneck' : ''}`}
            >
              <div className="name">
                {s.stationName}
                {s.stationId === bottleneckId ? (
                  <span className="status critical">Bottleneck</span>
                ) : null}
              </div>
              <div className="meta">
                {s.busyServers}/{s.servers.length} busy
                {s.downServers > 0 ? ` · ${s.downServers} down` : ''} · utilisation{' '}
                {pct(s.utilization)}
              </div>

              <div className="servers">
                {s.servers.map((srv) => (
                  <div
                    key={srv.index}
                    className={`server-cell${srv.down ? ' down' : ''}`}
                    title={
                      srv.down
                        ? 'Machine failed — under repair'
                        : srv.busy
                          ? `Processing ${srv.vehicleTag} — ${pct(srv.progress, 0)} complete`
                          : 'Idle'
                    }
                  >
                    {srv.busy && !srv.down ? (
                      <div className="fill" style={{ width: `${srv.progress * 100}%` }} />
                    ) : null}
                    <span className="tag">
                      {srv.down ? 'DOWN' : srv.busy ? srv.vehicleTag : 'idle'}
                    </span>
                  </div>
                ))}
              </div>

              <div className="meta">
                Queue: {s.queueLength} vehicle{s.queueLength === 1 ? '' : 's'} · {congestion}
              </div>
              <div className="queue-strip">
                {s.queueVehicles.slice(0, 26).map((v) => (
                  <button
                    key={v.id}
                    className="queue-chip"
                    title={`${v.tag} — waiting ${minutes(state.now - v.waitingSince)}`}
                    aria-label={`Inspect ${v.tag}`}
                    onClick={() => {
                      const found = controller.inspect(v.id);
                      if (found) setInspected(found);
                    }}
                  />
                ))}
                {s.queueLength > 26 ? (
                  <span className="queue-more">+{s.queueLength - 26} more</span>
                ) : null}
                {s.queueLength === 0 ? <span className="queue-more">empty</span> : null}
              </div>

              {def ? (
                <div className="meta">
                  {def.queueCapacity !== null ? `Buffer ${def.queueCapacity} · ` : ''}
                  {def.queueDiscipline}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {inspected ? (
        <VehicleInspector vehicle={inspected} now={state.now} onClose={() => setInspected(null)} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Vehicle inspector — requirement 3 and 72                            */
/* ------------------------------------------------------------------ */

export function VehicleInspector({
  vehicle,
  now,
  onClose,
  cost,
  currency,
}: {
  vehicle: Vehicle;
  now?: number;
  onClose: () => void;
  /** This vehicle's costing, when a cost run is available. */
  cost?: VehicleCost | undefined;
  currency?: CurrencySettings | undefined;
}) {
  const total =
    vehicle.completionTime !== null ? vehicle.completionTime - vehicle.arrivalTime : null;

  return (
    <SidePanel title={`Vehicle ${vehicle.tag}`} onClose={onClose}>
      <div className="stack">
        {/*
          The headline the brief asks for in both Task 6 and Task 7: this
          vehicle took X minutes and cost Y to manufacture. Cost is only shown
          when a cost run actually produced one for this vehicle — an
          uncosted vehicle says so rather than showing a zero.
        */}
        {cost && currency ? (
          <div className="grid cols-2">
            <Kpi
              label="Time to manufacture"
              value={total !== null ? minutes(total) : 'still in system'}
              basis="simulated"
              small
              sub={`${vehicle.visits.length} station visits`}
            />
            <Kpi
              label="Cost to manufacture"
              value={money(cost.totalCost, currency, 2)}
              basis="simulated"
              small
              sub={vehicle.reworkCount > 0 ? `includes ${money(cost.reworkCost, currency, 0)} of rework` : 'first-pass build'}
            />
          </div>
        ) : null}
        <Card title="Identity and status">
          <table className="data">
            <tbody>
              <tr>
                <td className="left">Vehicle ID</td>
                <td>{vehicle.id}</td>
              </tr>
              <tr>
                <td className="left">Model</td>
                <td>{vehicle.modelId}</td>
              </tr>
              <tr>
                <td className="left">Arrived</td>
                <td>{clock(vehicle.arrivalTime)}</td>
              </tr>
              <tr>
                <td className="left">Completed</td>
                <td>{vehicle.completionTime !== null ? clock(vehicle.completionTime) : '—'}</td>
              </tr>
              <tr>
                <td className="left">Status</td>
                <td>
                  <span
                    className={`status ${
                      vehicle.status === 'FINISHED'
                        ? 'good'
                        : vehicle.status === 'SCRAPPED'
                          ? 'critical'
                          : vehicle.status === 'REJECTED'
                            ? 'serious'
                            : 'neutral'
                    }`}
                  >
                    {vehicle.status.replace('_', ' ')}
                  </span>
                </td>
              </tr>
              <tr>
                <td className="left">Currently</td>
                <td>
                  {vehicle.currentStationId
                    ? `${vehicle.currentState} at ${vehicle.currentStationId}`
                    : '—'}
                </td>
              </tr>
              <tr className="emphasis">
                <td className="left">Total manufacturing time</td>
                <td>
                  {total !== null ? (
                    minutes(total)
                  ) : (
                    <span className="muted" title="A cycle time for an unfinished vehicle would be a fabricated number.">
                      still in system
                    </span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="formula">
            Waiting {minutes(vehicle.totalWaitMinutes)} · processing{' '}
            {minutes(vehicle.totalProcessingMinutes)} · machine downtime{' '}
            {minutes(vehicle.totalDowntimeMinutes)} · reworked {vehicle.reworkCount} time
            {vehicle.reworkCount === 1 ? '' : 's'} · inspected {vehicle.inspectionCount} time
            {vehicle.inspectionCount === 1 ? '' : 's'}.
          </div>
        </Card>

        <Card
          title="Manufacturing history"
          hint="Every station this vehicle entered, in order, with the time it waited and the time it was worked on."
        >
          <DataTable
            rows={vehicle.visits}
            rowKey={(v) => `${v.stationId}-${v.visitNumber}`}
            columns={[
              { key: 'station', header: 'Station', align: 'left', render: (v) => v.stationName },
              { key: 'visit', header: 'Visit', render: (v) => v.visitNumber },
              { key: 'enq', header: 'Queued at', render: (v) => clock(v.enqueuedAt) },
              {
                key: 'wait',
                header: 'Queue',
                render: (v) => (v.serviceStartedAt === null ? '—' : num(v.waitMinutes, 1)),
              },
              {
                key: 'proc',
                header: 'Processing',
                render: (v) => (v.serviceEndedAt === null ? '—' : num(v.processingMinutes, 1)),
              },
              {
                key: 'down',
                header: 'Downtime',
                render: (v) => (v.downtimeMinutes > 0 ? num(v.downtimeMinutes, 1) : '—'),
              },
              {
                key: 'outcome',
                header: 'Outcome',
                align: 'left',
                render: (v) => (
                  <span
                    className={`status ${
                      v.outcome === 'PASS' || v.outcome === 'FINISHED'
                        ? 'good'
                        : v.outcome === 'FAIL'
                          ? 'serious'
                          : v.outcome === 'SCRAP'
                            ? 'critical'
                            : 'neutral'
                    }`}
                  >
                    {v.outcome}
                  </span>
                ),
              },
            ]}
            caption="Times in minutes."
          />
        </Card>

        {cost && currency ? (
          <Card
            title="Cost breakdown for this vehicle"
            hint="Conversion costs are attributed by the server-minutes this vehicle actually occupied, so a vehicle that queued differently or was reworked costs a different amount."
          >
            <DataTable
              rows={[
                { k: 'Direct material', v: cost.materialCost, note: 'BOM issued at the stations it passed through' },
                { k: 'Labour', v: cost.laborCost, note: 'share of crew cost for the time it occupied each station' },
                { k: 'Machine', v: cost.machineCost, note: 'depreciation and consumables over its operating minutes' },
                { k: 'Energy', v: cost.energyCost, note: 'power drawn while it was being processed' },
                { k: 'Maintenance', v: cost.maintenanceCost, note: 'preventive and corrective share' },
                { k: 'Rework', v: cost.reworkCost, note: vehicle.reworkCount > 0 ? `${vehicle.reworkCount} rework visit(s)` : 'none' },
                { k: 'Allocated overhead', v: cost.overheadCost, note: 'period cost divided across finished vehicles' },
              ]}
              rowKey={(r) => r.k}
              columns={[
                { key: 'k', header: 'Component', align: 'left', render: (r) => r.k },
                { key: 'v', header: currency.code, render: (r) => money(r.v, currency, 2) },
                {
                  key: 's',
                  header: 'Share',
                  render: (r) => pct(cost.totalCost > 0 ? r.v / cost.totalCost : 0, 1),
                },
                { key: 'n', header: 'Basis', align: 'left', render: (r) => r.note },
              ]}
            />
            <table className="data" style={{ marginTop: 8 }}>
              <tbody>
                <tr className="emphasis">
                  <td className="left">TOTAL MANUFACTURING COST</td>
                  <td>{money(cost.totalCost, currency, 2)}</td>
                </tr>
              </tbody>
            </table>
          </Card>
        ) : null}

        {now !== undefined && vehicle.completionTime === null ? (
          <Notice kind="info">
            This vehicle is still being manufactured. It has been in the factory for{' '}
            {minutes(now - vehicle.arrivalTime)} so far.
          </Notice>
        ) : null}
      </div>
    </SidePanel>
  );
}

/* ------------------------------------------------------------------ */
/* Transport controls                                                  */
/* ------------------------------------------------------------------ */

export function TransportControls({ controller }: { controller: LiveController }) {
  const { running, speed, setSpeed, start, pause, stop, reset, stepEvent, state } = controller;
  const finished = state?.phase === 'FINISHED';

  return (
    <div className="toolbar">
      {running ? (
        <button className="btn" onClick={pause}>
          Pause
        </button>
      ) : (
        <button className="btn primary" onClick={start} disabled={finished}>
          {state ? 'Resume' : 'Start'}
        </button>
      )}
      <button className="btn" onClick={stop} disabled={!state || !running}>
        Stop
      </button>
      <button className="btn" onClick={reset}>
        Reset
      </button>
      <button className="btn" onClick={stepEvent} disabled={running || finished}>
        Step event
      </button>

      <div className="field" style={{ minWidth: 220 }}>
        <label>
          Speed <span className="unit-hint">({speed} simulated minutes per real second)</span>
        </label>
        <input
          type="range"
          min={1}
          max={600}
          step={1}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
      </div>
      <span className="small muted">
        Speed changes how fast time passes, never how the model behaves.
      </span>
    </div>
  );
}
