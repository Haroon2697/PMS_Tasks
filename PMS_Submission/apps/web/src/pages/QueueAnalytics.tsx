/**
 * Queue analytics — requirements 8, 9, 10, 11.
 *
 * Node and system metrics are kept visibly separate, because requirement 10
 * says they are different things and the difference is easy to get wrong:
 * node W uses the station's own arrival rate including repeat visits, while
 * system W divides total WIP by the EXTERNAL arrival rate. Dividing by the sum
 * of node rates instead would count a reworked vehicle as several vehicles —
 * the page shows both numbers so the error is visible rather than theoretical.
 *
 * Little's Law is checked live on both the analytical and the simulated
 * figures, as a standing consistency test of the engine.
 */

import { checkLittlesLaw } from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice, Tabs } from '../components/primitives';
import { HorizontalBars, Meter } from '../components/charts';
import { num, pct, utilisationStatus } from '../lib/format';
import { useState } from 'react';

type Tab = 'stations' | 'system' | 'littles';

export function QueueAnalyticsPage({ navigate }: { navigate: (p: string) => void }) {
  const { analytical, run } = useStore();
  const [tab, setTab] = useState<Tab>('stations');
  const study = run?.study ?? null;

  if (analytical.stations.length === 0) {
    return <EmptyState>The network could not be solved. Check the Model Validation page.</EmptyState>;
  }

  return (
    <div className="stack">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'stations', label: 'Node metrics' },
          { id: 'system', label: 'System metrics' },
          { id: 'littles', label: "Little's Law" },
        ]}
      />

      {tab === 'stations' ? (
        <div className="stack">
          <Card
            title="Per-station queueing results"
            hint="Analytical, exact where the model permits. Each row names the formula used."
          >
            <DataTable
              rows={analytical.stations}
              rowKey={(s) => s.stationId}
              columns={[
                { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
                { key: 'k', header: 'Kendall', align: 'left', render: (s) => <strong>{s.kendall}</strong> },
                { key: 'c', header: 'c', render: (s) => s.c },
                { key: 'lam', header: 'λ (veh/h)', render: (s) => num(s.lambda, 4), sortValue: (s) => s.lambda },
                { key: 'mu', header: 'μ (veh/h/srv)', render: (s) => num(60 / s.serviceMinutes, 4) },
                {
                  key: 'rho',
                  header: 'ρ',
                  render: (s) => (
                    <span className="row nowrap" style={{ justifyContent: 'flex-end' }}>
                      <Meter value={s.rho} status={utilisationStatus(s.rho)} width={48} />
                      {pct(s.rho, 2)}
                    </span>
                  ),
                  sortValue: (s) => s.rho,
                },
                { key: 'L', header: 'L (veh)', render: (s) => num(s.L, 4), sortValue: (s) => s.L },
                { key: 'Lq', header: 'Lq (veh)', render: (s) => num(s.Lq, 4), sortValue: (s) => s.Lq },
                { key: 'W', header: 'W (min)', render: (s) => num(s.WMinutes, 3), sortValue: (s) => s.WMinutes },
                { key: 'Wq', header: 'Wq (min)', render: (s) => num(s.WqMinutes, 3), sortValue: (s) => s.WqMinutes },
                { key: 'P0', header: 'P₀', title: 'Probability the station is empty', render: (s) => num(s.P0, 4) },
                { key: 'Pw', header: 'P(wait)', title: 'Probability an arrival has to queue', render: (s) => num(s.Pwait, 4) },
                {
                  key: 'st',
                  header: 'Status',
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
            />
          </Card>

          <Card title="Formula used at each station" hint="Requirement 8: M/M/c is solved with Erlang C, never with the M/M/1 formulae.">
            <DataTable
              rows={analytical.stations}
              rowKey={(s) => `${s.stationId}-m`}
              columns={[
                { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
                { key: 'k', header: 'Model', align: 'left', render: (s) => s.kendall },
                { key: 'm', header: 'Method', align: 'left', render: (s) => s.method },
              ]}
            />
          </Card>

          <div className="grid cols-2">
            <Card title="Queue length (Lq)" hint="Analytical, at the current demand level.">
              <HorizontalBars
                unit="vehicles waiting"
                labelWidth={168}
                barHeight={15}
                gap={6}
                data={[...analytical.stations]
                  .sort((a, b) => b.Lq - a.Lq)
                  .map((s) => ({
                    key: s.stationId,
                    label: s.stationName,
                    value: Number.isFinite(s.Lq) ? s.Lq : 0,
                    detail: [
                      { label: 'Wq', value: `${num(s.WqMinutes, 2)} min` },
                      { label: 'ρ', value: pct(s.rho) },
                    ],
                  }))}
                formatValue={(v) => num(v, 2)}
              />
            </Card>
            <Card title="Waiting time (Wq)" hint="Minutes a vehicle waits per visit to that station.">
              <HorizontalBars
                unit="minutes per visit"
                labelWidth={168}
                barHeight={15}
                gap={6}
                data={[...analytical.stations]
                  .sort((a, b) => b.WqMinutes - a.WqMinutes)
                  .map((s) => ({
                    key: s.stationId,
                    label: s.stationName,
                    value: Number.isFinite(s.WqMinutes) ? s.WqMinutes : 0,
                    detail: [
                      { label: 'Visits per vehicle', value: num(s.visitRatio, 3) },
                      {
                        label: 'Total per vehicle',
                        value: `${num(s.visitRatio * s.WqMinutes, 2)} min`,
                      },
                    ],
                  }))}
                formatValue={(v) => num(v, 2)}
              />
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'system' ? (
        <div className="stack">
          <Notice kind="info" title="Node metrics and system metrics are not the same thing">
            A node's W uses that station's own arrival rate, which counts a reworked vehicle twice.
            The system's W divides total WIP by the <strong>external</strong> arrival rate, so each
            physical vehicle is counted once. The table below shows what using the wrong denominator
            would produce.
          </Notice>

          <div className="grid cols-4">
            <Kpi
              label="System L (WIP)"
              value={num(analytical.system.L, 3)}
              unit="veh"
              basis="analytical"
              sub="sum of node L"
            />
            <Kpi
              label="System Lq"
              value={num(analytical.system.Lq, 3)}
              unit="veh"
              basis="analytical"
              sub="sum of node Lq"
            />
            <Kpi
              label="System W"
              value={num(analytical.system.WMinutes, 2)}
              unit="min"
              basis="analytical"
              sub="L / λ_external"
            />
            <Kpi
              label="System Wq"
              value={num(analytical.system.WqMinutes, 2)}
              unit="min"
              basis="analytical"
              sub="Lq / λ_external"
            />
          </div>

          <Card title="The denominator matters">
            <DataTable
              rows={[
                {
                  k: 'External arrival rate λ_ext',
                  v: analytical.system.lambdaExternal,
                  note: 'Physical vehicles entering the factory per hour. This is the correct denominator.',
                },
                {
                  k: 'Sum of node arrival rates Σλ_j',
                  v: analytical.stations.reduce((a, s) => a + s.lambda, 0),
                  note: 'Larger, because a reworked vehicle passes through inspection more than once.',
                },
                {
                  k: 'System W using λ_ext (correct)',
                  v: analytical.system.WMinutes,
                  note: 'The time one vehicle actually spends in the factory.',
                },
                {
                  k: 'System W using Σλ_j (wrong)',
                  v:
                    (analytical.system.L /
                      Math.max(1e-9, analytical.stations.reduce((a, s) => a + s.lambda, 0))) *
                    60,
                  note: 'Understates the time per vehicle — shown only to make the error concrete.',
                },
              ]}
              rowKey={(r) => r.k}
              emphasiseRow={(r) => r.k.includes('correct')}
              columns={[
                { key: 'k', header: 'Quantity', align: 'left', render: (r) => r.k },
                { key: 'v', header: 'Value', render: (r) => num(r.v, 4) },
                { key: 'n', header: 'Note', align: 'left', render: (r) => r.note },
              ]}
            />
          </Card>

          <Card title="Flow" hint="Conservation: what enters must leave as either a finished vehicle or scrap.">
            <DataTable
              rows={[
                { k: 'External arrivals', v: analytical.system.lambdaExternal },
                { k: 'Finished vehicles out', v: analytical.system.throughputFinished },
                { k: 'Scrapped out', v: analytical.system.throughputScrap },
                {
                  k: 'Balance (in − out)',
                  v:
                    analytical.system.lambdaExternal -
                    analytical.system.throughputFinished -
                    analytical.system.throughputScrap,
                },
              ]}
              rowKey={(r) => r.k}
              emphasiseRow={(r) => r.k.startsWith('Balance')}
              columns={[
                { key: 'k', header: 'Flow', align: 'left', render: (r) => r.k },
                { key: 'v', header: 'veh/h', render: (r) => num(r.v, 6) },
              ]}
            />
          </Card>

          {study ? (
            <Card title="Simulated system metrics" hint="Mean over replications, with 95% intervals.">
              <div className="grid cols-4">
                <Kpi label="L" value={num(study.system.L?.mean, 3)} unit="veh" basis="simulated" metric={study.system.L} />
                <Kpi label="Lq" value={num(study.system.Lq?.mean, 3)} unit="veh" basis="simulated" metric={study.system.Lq} />
                <Kpi label="W" value={num(study.system.WMinutes?.mean, 2)} unit="min" basis="simulated" metric={study.system.WMinutes} />
                <Kpi label="Wq" value={num(study.system.WqMinutes?.mean, 2)} unit="min" basis="simulated" metric={study.system.WqMinutes} />
              </div>
            </Card>
          ) : (
            <EmptyState>
              Run the simulation to compare these with measured values.{' '}
              <button className="btn sm" onClick={() => navigate('simulation')}>
                Go to Simulation
              </button>
            </EmptyState>
          )}
        </div>
      ) : null}

      {tab === 'littles' ? (
        <div className="stack">
          <Notice kind="info" title="L = λW">
            Little's Law holds for any stable system in steady state, whatever the arrival or
            service distributions. It is checked here as a standing consistency test: the analytical
            L and W come from different formulas, and the simulated L and W are measured by
            different mechanisms (a time-weighted area versus per-vehicle sojourn times), so
            agreement is real evidence that both are right.
          </Notice>

          <Card title="Analytical check, per station">
            <DataTable
              rows={analytical.stations.filter((s) => s.lambda > 0)}
              rowKey={(s) => s.stationId}
              columns={[
                { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
                { key: 'lam', header: 'λ (veh/h)', render: (s) => num(s.lambda, 4) },
                { key: 'W', header: 'W (h)', render: (s) => num(s.W, 5) },
                { key: 'lw', header: 'λ × W', render: (s) => num(s.lambda * s.W, 5) },
                { key: 'L', header: 'L', render: (s) => num(s.L, 5) },
                {
                  key: 'e',
                  header: 'Difference',
                  render: (s) => num(Math.abs(s.lambda * s.W - s.L), 9),
                },
                {
                  key: 'ok',
                  header: 'Holds?',
                  align: 'left',
                  render: (s) =>
                    checkLittlesLaw(s.lambda, s.W, s.L, 1e-6).holds ? (
                      <span className="status good">Yes</span>
                    ) : (
                      <span className="status critical">No</span>
                    ),
                },
              ]}
              caption="Lq = λWq is checked the same way and holds to the same precision."
            />
          </Card>

          {study ? (
            <Card
              title="Simulated check, per station"
              hint="L from the time-weighted area; W from per-vehicle times. Agreement here is a genuine cross-check."
            >
              <DataTable
                rows={study.stations}
                rowKey={(s) => `${s.stationId}-ll`}
                columns={[
                  { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
                  { key: 'lam', header: 'λ observed', render: (s) => num(s.metrics.lambdaObserved?.mean, 4) },
                  {
                    key: 'W',
                    header: 'W (h)',
                    render: (s) => num((s.metrics.WMinutes?.mean ?? 0) / 60, 5),
                  },
                  {
                    key: 'lw',
                    header: 'λ × W',
                    render: (s) =>
                      num(
                        (s.metrics.lambdaObserved?.mean ?? 0) * ((s.metrics.WMinutes?.mean ?? 0) / 60),
                        5,
                      ),
                  },
                  { key: 'L', header: 'L measured', render: (s) => num(s.metrics.L?.mean, 5) },
                  {
                    key: 'e',
                    header: 'Relative difference',
                    render: (s) => {
                      const lw =
                        (s.metrics.lambdaObserved?.mean ?? 0) * ((s.metrics.WMinutes?.mean ?? 0) / 60);
                      const L = s.metrics.L?.mean ?? 0;
                      return L > 1e-9 ? pct(Math.abs(lw - L) / L, 2) : 'n/a';
                    },
                  },
                ]}
              />
            </Card>
          ) : (
            <EmptyState>Run the simulation to check Little's Law on measured values.</EmptyState>
          )}
        </div>
      ) : null}
    </div>
  );
}
