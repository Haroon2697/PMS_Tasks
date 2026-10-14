/**
 * Discovered Model — Task 7, steps 3 to 6.
 *
 * The discovered process becomes an executable `SystemModel`, so it is solved
 * by the same analytical engine, run by the same discrete-event simulator and
 * priced by the same cost engine as a hand-built model. Nothing here is a
 * parallel implementation.
 *
 * THREE KINDS OF NUMBER, NEVER MIXED. The brief asks for event-log observations,
 * analytical queueing results and simulation results to be clearly
 * distinguished, so the comparison table puts them in three labelled column
 * groups and the page explains why they differ rather than implying one of them
 * is "the" answer:
 *
 *   OBSERVED   what the log recorded — a finite sample of the real process
 *   ANALYTICAL steady-state queueing theory applied to the fitted parameters
 *   SIMULATED  a discrete-event run of the discovered model
 */

import { useMemo, useState } from 'react';
import {
  compareObservedToAnalytical,
  computeCosts,
  runSimulation,
  solveNetwork,
  validateModel,
  type CurrencySettings,
  type SimulationResult,
} from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice, Tabs } from '../components/primitives';
import { NetworkDiagram } from '../components/NetworkDiagram';
import {
  LiveFactoryView,
  TransportControls,
  useLiveSimulation,
  VehicleInspector,
} from '../components/LiveFactory';
import { Meter } from '../components/charts';
import { minutes, money, num, pct, utilisationStatus } from '../lib/format';

type Tab = 'model' | 'compare' | 'simulate' | 'traces';

export function DiscoveredModelPage({ navigate }: { navigate: (p: string) => void }) {
  const { discovered, discoveredModel, adoptDiscoveredModel, discoveryError } = useStore();
  const [tab, setTab] = useState<Tab>('model');
  const [selected, setSelected] = useState<string | null>(null);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [busy, setBusy] = useState(false);

  const model = discoveredModel?.model ?? null;
  const notes = discoveredModel?.notes ?? [];

  const analytical = useMemo(() => (model ? safeSolve(model) : null), [model]);
  const validation = useMemo(() => (model ? validateModel(model) : null), [model]);
  const cost = useMemo(() => (model && sim ? computeCosts(model, sim) : null), [model, sim]);

  const live = useLiveSimulation(model);

  if (!discovered || !model) {
    return (
      <EmptyState>
        {discoveryError ? (
          <Notice kind="error" title="The model could not be built">
            {discoveryError}
          </Notice>
        ) : (
          <>
            Nothing discovered yet.{' '}
            <button className="btn sm" onClick={() => navigate('eventlog')}>
              Import an event log
            </button>
          </>
        )}
      </EmptyState>
    );
  }

  const runOnce = async () => {
    setBusy(true);
    await new Promise((r) => setTimeout(r, 16));
    try {
      setSim(runSimulation(model));
    } finally {
      setBusy(false);
    }
  };

  const currency = model.cost.currency;

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Kpi
          label="Stations"
          value={num(model.stations.length, 0)}
          basis="derived"
          sub="one per discovered activity"
        />
        <Kpi
          label="Arrival rate"
          value={num(model.arrivals.schedule[0]?.lambdaPerHour.value, 3)}
          unit="veh/h"
          basis="derived"
          sub="estimated from the log"
        />
        <Kpi
          label="Model status"
          value={validation?.runnable ? 'Runnable' : 'Blocked'}
          basis="derived"
          small
          status={
            validation?.errors.length
              ? 'critical'
              : validation?.warnings.length
                ? 'warning'
                : 'good'
          }
          sub={`${validation?.errors.length ?? 0} errors, ${validation?.warnings.length ?? 0} warnings`}
        />
        <Kpi
          label="System stable?"
          value={analytical?.system.stable ? 'Yes' : 'No'}
          basis="analytical"
          small
          status={analytical?.system.stable ? 'good' : 'critical'}
          sub={analytical?.system.stable ? 'every ρ < 1' : 'at least one queue is saturated'}
        />
      </div>

      {!analytical?.system.stable ? (
        <Notice kind="warn" title="The discovered model is not stable">
          At least one station has ρ ≥ 1 at the arrival rate estimated from the log. That is a normal
          outcome of discovery, and it usually means the server-count estimate is too low: the log
          only reveals the maximum concurrency it happened to observe, which is a lower bound on real
          capacity. Raise the server counts on the Process Discovery page.{' '}
          <button className="btn sm" onClick={() => navigate('discovery')}>
            Edit the assumptions
          </button>
        </Notice>
      ) : null}

      {notes.length > 0 ? (
        <Notice kind="info" title="How this model was assembled">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {notes.map((n, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {n}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="row">
        <button className="btn primary" onClick={adoptDiscoveredModel}>
          Use this as the active model
        </button>
        <span className="small muted">
          Loads it into the rest of ProcessFlow — Overview, Live Factory, Cost, Bottleneck,
          Scenarios and Optimization all start working on the discovered process.
        </span>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'model', label: 'Queue model' },
          { id: 'compare', label: 'Observed vs analytical vs simulated' },
          { id: 'simulate', label: 'Simulate' },
          { id: 'traces', label: 'Vehicle traces' },
        ]}
      />

      {tab === 'model' && analytical ? (
        <div className="stack">
          <Card
            title="Discovered network"
            hint="Generated from the directly-follows graph. Click a station to edit it."
          >
            <NetworkDiagram
              model={model}
              analytical={analytical.stations}
              selectedId={selected}
              onSelect={setSelected}
              bottleneckId={analytical.system.bottleneckStationId}
            />
          </Card>

          <Card
            title="Queueing model for every discovered process"
            hint="Kendall notation follows the distribution fitted to the observed durations; M/M/c is solved with Erlang C, never with the M/M/1 formulae."
          >
            <DataTable
              rows={analytical.stations}
              rowKey={(s) => s.stationId}
              onRowClick={(s) => setSelected(s.stationId)}
              selectedKey={selected}
              emphasiseRow={(s) => s.stationId === analytical.system.bottleneckStationId}
              columns={[
                { key: 'n', header: 'Process', align: 'left', render: (s) => s.stationName },
                { key: 'k', header: 'Kendall', align: 'left', render: (s) => <strong>{s.kendall}</strong> },
                { key: 'c', header: 'Servers c', render: (s) => s.c },
                { key: 'lam', header: 'λ (veh/h)', render: (s) => num(s.lambda, 3), sortValue: (s) => s.lambda },
                { key: 'mu', header: 'μ (veh/h/srv)', render: (s) => num(60 / s.serviceMinutes, 3) },
                {
                  key: 'rho',
                  header: 'ρ',
                  render: (s) => (
                    <span className="row nowrap" style={{ justifyContent: 'flex-end' }}>
                      <Meter value={s.rho} status={utilisationStatus(s.rho)} width={48} />
                      {pct(s.rho, 1)}
                    </span>
                  ),
                  sortValue: (s) => s.rho,
                },
                { key: 'L', header: 'L', render: (s) => num(s.L, 3), sortValue: (s) => s.L },
                { key: 'Lq', header: 'Lq', render: (s) => num(s.Lq, 3), sortValue: (s) => s.Lq },
                { key: 'W', header: 'W (min)', render: (s) => num(s.WMinutes, 2) },
                { key: 'Wq', header: 'Wq (min)', render: (s) => num(s.WqMinutes, 2), sortValue: (s) => s.WqMinutes },
                {
                  key: 'st',
                  header: 'Result',
                  align: 'left',
                  render: (s) =>
                    !s.stable ? (
                      <span className="status critical">UNSTABLE</span>
                    ) : s.exact ? (
                      <span className="status good">Exact</span>
                    ) : (
                      <span className="status warning">Approximation</span>
                    ),
                },
              ]}
              caption={`System: L = ${num(analytical.system.L, 2)} vehicles, W = ${num(analytical.system.WMinutes, 1)} min, computed as L / λ_external.`}
            />
          </Card>

          <Card title="Routing derived from the log">
            <DataTable
              rows={model.stations.flatMap((s) =>
                s.routing.map((e) => ({
                  from: s.name,
                  to:
                    e.to === '__FINISHED__'
                      ? 'Finished'
                      : e.to === '__SCRAP__'
                        ? 'Scrapped'
                        : (model.stations.find((x) => x.id === e.to)?.name ?? e.to),
                  p: e.probability,
                  label: e.label ?? '',
                  key: `${s.id}>${e.to}`,
                })),
              )}
              rowKey={(r) => r.key}
              columns={[
                { key: 'f', header: 'From', align: 'left', render: (r) => r.from },
                { key: 't', header: 'To', align: 'left', render: (r) => r.to },
                { key: 'p', header: 'Probability', render: (r) => pct(r.p, 2), sortValue: (r) => r.p },
                { key: 'l', header: 'Label', align: 'left', render: (r) => r.label },
              ]}
            />
          </Card>
        </div>
      ) : null}

      {tab === 'compare' && analytical ? (
        <ComparisonTab
          rows={compareObservedToAnalytical(
            discovered,
            analytical.stations.map((s) => ({
              stationId: s.stationId,
              kendall: s.kendall,
              c: s.c,
              lambda: s.lambda,
              rho: s.rho,
              L: s.L,
              Lq: s.Lq,
              WMinutes: s.WMinutes,
              WqMinutes: s.WqMinutes,
              stable: s.stable,
              exact: s.exact,
            })),
          )}
          sim={sim}
          observedCycleMinutes={discovered.cycleTime.meanMinutes}
        />
      ) : null}

      {tab === 'simulate' ? (
        <div className="stack">
          <Card
            title="Run the discovered model"
            hint="The same discrete-event engine used everywhere else in ProcessFlow. Nothing here is scripted."
          >
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button className="btn primary" disabled={busy} onClick={() => void runOnce()}>
                {busy ? 'Running…' : 'Run simulation'}
              </button>
              <span className="small muted">
                Seed {model.simulation.seed} · warm-up {minutes(model.simulation.warmupMinutes)} ·
                measure {minutes(model.simulation.durationMinutes)}
              </span>
            </div>
          </Card>

          {sim ? (
            <>
              <div className="grid cols-4">
                <Kpi label="Throughput" value={num(sim.system.throughputPerHour, 3)} unit="veh/h" basis="simulated" />
                <Kpi label="Completed" value={num(sim.system.vehiclesCompleted, 0)} unit="veh" basis="simulated" />
                <Kpi label="W" value={num(sim.system.WMinutes, 1)} unit="min" basis="simulated" />
                <Kpi label="Wq" value={num(sim.system.WqMinutes, 1)} unit="min" basis="simulated" />
                <Kpi label="L (WIP)" value={num(sim.system.L, 2)} unit="veh" basis="simulated" />
                <Kpi label="Lq" value={num(sim.system.Lq, 2)} unit="veh" basis="simulated" />
                <Kpi label="Reworked" value={num(sim.system.vehiclesReworked, 0)} unit="veh" basis="simulated" />
                <Kpi
                  label="Cost per vehicle"
                  value={cost ? money(cost.costPerVehicle, currency, 2) : '—'}
                  basis="simulated"
                  sub="cost model inherited from the active system"
                />
              </div>
              <Card title="Per-station simulation results">
                <DataTable
                  rows={sim.stations}
                  rowKey={(s) => s.stationId}
                  columns={[
                    { key: 'n', header: 'Process', align: 'left', render: (s) => s.stationName },
                    { key: 'u', header: 'Utilisation', render: (s) => pct(s.utilization), sortValue: (s) => s.utilization },
                    { key: 'l', header: 'λ observed', render: (s) => num(s.lambdaObserved, 3) },
                    { key: 'L', header: 'L', render: (s) => num(s.L, 3) },
                    { key: 'Lq', header: 'Lq', render: (s) => num(s.Lq, 3), sortValue: (s) => s.Lq },
                    { key: 'W', header: 'W (min)', render: (s) => num(s.WMinutes, 2) },
                    { key: 'Wq', header: 'Wq (min)', render: (s) => num(s.WqMinutes, 2) },
                    { key: 'q', header: 'Peak queue', render: (s) => num(s.maxQueueLength, 0) },
                  ]}
                />
              </Card>
            </>
          ) : (
            <Notice kind="info" title="No run yet">
              Press <strong>Run simulation</strong>. Nothing on this tab shows a number until the
              discovered model has actually been executed.
            </Notice>
          )}

          <Card
            title="Watch the discovered process run"
            hint="Vehicles moving through the queues that were mined from the log. Driven by real simulation state — pausing freezes the clock."
          >
            <TransportControls controller={live} />
          </Card>
          <LiveFactoryView
            model={model}
            controller={live}
            bottleneckId={analytical?.system.bottleneckStationId ?? null}
          />
        </div>
      ) : null}

      {tab === 'traces' ? (
        <TracesTab sim={sim} cost={cost} currency={currency} onRun={() => void runOnce()} busy={busy} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ComparisonTab({
  rows,
  sim,
  observedCycleMinutes,
}: {
  rows: ReturnType<typeof compareObservedToAnalytical>;
  sim: SimulationResult | null;
  observedCycleMinutes: number;
}) {
  return (
    <div className="stack">
      <Notice kind="info" title="Three different questions, three different answers">
        <strong>Observed</strong> is what the log recorded — one finite sample of the real process,
        including whatever was going on that day. <strong>Analytical</strong> is steady-state
        queueing theory applied to the fitted parameters, so it assumes the process runs forever
        under those conditions. <strong>Simulated</strong> executes the discovered model with random
        variation. They are expected to differ; a large gap between observed and analytical waiting
        time usually means the real arrivals were burstier than the fitted process, or that the
        server-count estimate is too low.
      </Notice>

      <Card title="Per-process comparison">
        <DataTable
          rows={rows}
          rowKey={(r) => r.activityId}
          columns={[
            { key: 'n', header: 'Process', align: 'left', render: (r) => r.name },
            { key: 'k', header: 'Kendall', align: 'left', render: (r) => r.kendall },
            { key: 'c', header: 'Servers', render: (r) => r.servers },
            { key: 'ol', header: 'λ observed', title: 'From the event log', render: (r) => num(r.observed.lambdaPerHour, 3) },
            { key: 'al', header: 'λ analytical', title: 'From the traffic equations', render: (r) => num(r.analytical.lambdaPerHour, 3) },
            { key: 'ou', header: 'ρ observed', render: (r) => pct(r.observed.utilization, 1) },
            { key: 'au', header: 'ρ analytical', render: (r) => pct(r.analytical.rho, 1) },
            {
              key: 'su',
              header: 'ρ simulated',
              render: (r) => {
                const s = sim?.stations.find((x) => x.stationId === r.activityId);
                return s ? pct(s.utilization, 1) : <span className="muted">—</span>;
              },
            },
            { key: 'ow', header: 'Wq observed (min)', render: (r) => num(r.observed.waitMeanMinutes, 2) },
            { key: 'aw', header: 'Wq analytical (min)', render: (r) => num(r.analytical.WqMinutes, 2) },
            {
              key: 'sw',
              header: 'Wq simulated (min)',
              render: (r) => {
                const s = sim?.stations.find((x) => x.stationId === r.activityId);
                return s ? num(s.WqMinutes, 2) : <span className="muted">—</span>;
              },
            },
            {
              key: 'd',
              header: 'Analytical − observed',
              render: (r) => (
                <span className={r.waitDifferenceMinutes > 0 ? 'num-neg' : 'num-pos'}>
                  {r.waitDifferenceMinutes >= 0 ? '+' : ''}
                  {num(r.waitDifferenceMinutes, 2)} min
                </span>
              ),
              sortValue: (r) => Math.abs(r.waitDifferenceMinutes),
            },
          ]}
        />
        {!sim ? (
          <div className="formula">
            The simulated columns fill in once you run the model on the Simulate tab.
          </div>
        ) : null}
      </Card>

      <Card title="Whole-case cycle time">
        <DataTable
          rows={[
            {
              k: 'Observed in the event log',
              v: observedCycleMinutes,
              n: 'Mean of (last completion − first start) per case',
            },
            {
              k: 'Simulated',
              v: sim?.system.cycleTime.meanMinutes ?? NaN,
              n: sim ? 'Mean over vehicles completed in the run' : 'Run the model to populate this',
            },
          ]}
          rowKey={(r) => r.k}
          columns={[
            { key: 'k', header: 'Basis', align: 'left', render: (r) => r.k },
            { key: 'v', header: 'Minutes', render: (r) => (Number.isNaN(r.v) ? '—' : num(r.v, 2)) },
            { key: 'n', header: 'How it is measured', align: 'left', render: (r) => r.n },
          ]}
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TracesTab({
  sim,
  cost,
  currency,
  onRun,
  busy,
}: {
  sim: SimulationResult | null;
  cost: ReturnType<typeof computeCosts> | null;
  currency: CurrencySettings;
  onRun: () => void;
  busy: boolean;
}) {
  const [inspect, setInspect] = useState<number | null>(null);

  if (!sim) {
    return (
      <EmptyState>
        No simulation run yet.{' '}
        <button className="btn sm" disabled={busy} onClick={onRun}>
          {busy ? 'Running…' : 'Run the discovered model'}
        </button>
      </EmptyState>
    );
  }

  const vehicle = inspect !== null ? sim.traces.find((v) => v.id === inspect) : undefined;
  const vehicleCost =
    inspect !== null ? cost?.vehicles.find((v) => v.vehicleId === inspect) : undefined;

  return (
    <div className="stack">
      <Card
        title="Vehicle traces through the discovered process"
        hint="Click any vehicle for its full history: every process visited, when it queued, when it was served, and what it cost."
      >
        <DataTable
          rows={sim.traces.slice(0, 400)}
          rowKey={(v) => String(v.id)}
          onRowClick={(v) => setInspect(v.id)}
          selectedKey={inspect !== null ? String(inspect) : null}
          maxHeight={460}
          columns={[
            { key: 't', header: 'Vehicle', align: 'left', render: (v) => v.tag },
            { key: 'a', header: 'Arrived (min)', render: (v) => num(v.arrivalTime, 1), sortValue: (v) => v.arrivalTime },
            { key: 'p', header: 'Processes', render: (v) => v.visits.length, sortValue: (v) => v.visits.length },
            {
              key: 'r',
              header: 'Rework',
              render: (v) => (v.reworkCount > 0 ? num(v.reworkCount, 0) : '—'),
              sortValue: (v) => v.reworkCount,
            },
            { key: 'w', header: 'Waiting (min)', render: (v) => num(v.totalWaitMinutes, 1), sortValue: (v) => v.totalWaitMinutes },
            {
              key: 'pr',
              header: 'Processing (min)',
              render: (v) => num(v.totalProcessingMinutes, 1),
              sortValue: (v) => v.totalProcessingMinutes,
            },
            {
              key: 'c',
              header: 'Cycle time (min)',
              render: (v) =>
                v.completionTime === null ? (
                  <span className="muted">in system</span>
                ) : (
                  num(v.completionTime - v.arrivalTime, 1)
                ),
              sortValue: (v) => (v.completionTime === null ? 0 : v.completionTime - v.arrivalTime),
            },
            {
              key: 'cost',
              header: 'Cost',
              render: (v) => {
                const c = cost?.vehicles.find((x) => x.vehicleId === v.id);
                return c ? money(c.totalCost, currency, 0) : <span className="muted">—</span>;
              },
              sortValue: (v) => cost?.vehicles.find((x) => x.vehicleId === v.id)?.totalCost ?? 0,
            },
            {
              key: 's',
              header: 'Status',
              align: 'left',
              render: (v) => (
                <span
                  className={`status ${
                    v.status === 'FINISHED' ? 'good' : v.status === 'SCRAPPED' ? 'critical' : 'neutral'
                  }`}
                >
                  {v.status}
                </span>
              ),
            },
          ]}
          caption={
            sim.traces.length > 400
              ? `Showing the first 400 of ${sim.traces.length} traced vehicles.`
              : `${sim.traces.length} traced vehicles.`
          }
        />
      </Card>

      {vehicle ? (
        <VehicleInspector
          vehicle={vehicle}
          cost={vehicleCost}
          currency={currency}
          onClose={() => setInspect(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function safeSolve(model: Parameters<typeof solveNetwork>[0]) {
  try {
    return solveNetwork(model);
  } catch {
    return null;
  }
}
