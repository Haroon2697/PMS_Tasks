/**
 * Simulation page — requirements 43, 44, 45.
 *
 * Runs the replication study and puts the analytical and simulated answers side
 * by side with their error. The comparison table is the heart of the page: it
 * does not just print two columns and leave the reader to wonder why they
 * differ, it names the reason for each station — sampling error, a station
 * whose arrivals are not Poisson, or machine breakdowns that the closed-form
 * model cannot represent at all.
 */

import { useState } from 'react';
import { runStudy, theoreticalMinimumCycleMinutes, type StudyResult } from '@vmq/engine';
import { useStore, fingerprint } from '../state/store';
import { api } from '../lib/api';
import { Card, DataTable, Kpi, Notice, NumberField, SelectField, Tabs } from '../components/primitives';
import { Histogram } from '../components/charts';
import { num, pct } from '../lib/format';

type Tab = 'results' | 'compare' | 'replications';

export function SimulationPage() {
  const { model, setModel, validation, run, setRun, studyIsStale, online, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('results');
  const [error, setError] = useState<string | null>(null);

  const study = run?.study ?? null;

  const execute = async (persist: boolean) => {
    setBusy(true);
    setError(null);
    // Yield a frame so the button's disabled state paints before the engine
    // occupies the main thread.
    await new Promise((r) => setTimeout(r, 16));
    try {
      if (persist && online) {
        const res = await api.run(model.id, { replications: model.simulation.replications });
        setRun({
          id: res.runId,
          study: res.study,
          modelFingerprint: fingerprint(model),
          at: new Date().toISOString(),
          persisted: true,
        });
        notify(`Run saved (${res.durationMs} ms).`);
      } else {
        const started = performance.now();
        const s: StudyResult = runStudy(model);
        setRun({
          id: null,
          study: s,
          modelFingerprint: fingerprint(model),
          at: new Date().toISOString(),
          persisted: false,
        });
        notify(`Run complete in ${Math.round(performance.now() - started)} ms (not saved).`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const horizonHours =
    (model.simulation.warmupMinutes + model.simulation.durationMinutes) / 60;
  const totalSimulatedHours = horizonHours * model.simulation.replications;

  return (
    <div className="stack">
      <Card
        title="Run configuration"
        hint="Requirement 45: the warm-up period is excluded from all statistics. Requirement 44: replications give the confidence intervals."
      >
        <div className="grid cols-4">
          <NumberField
            label="Random seed"
            unit="integer"
            value={model.simulation.seed}
            min={0}
            step={1}
            integer
            onChange={(v) =>
              setModel((m) => ({ ...m, simulation: { ...m.simulation, seed: v } }))
            }
            hint="Same seed + same model = identical results."
          />
          <NumberField
            label="Replications"
            unit="independent runs"
            value={model.simulation.replications}
            min={1}
            max={200}
            step={1}
            integer
            onChange={(v) =>
              setModel((m) => ({ ...m, simulation: { ...m.simulation, replications: v } }))
            }
            hint="10 or more before comparing scenarios."
          />
          <NumberField
            label="Warm-up period"
            unit="minutes"
            value={model.simulation.warmupMinutes}
            min={0}
            onChange={(v) =>
              setModel((m) => ({ ...m, simulation: { ...m.simulation, warmupMinutes: v } }))
            }
            hint="Discarded. Should exceed a few mean cycle times."
          />
          <NumberField
            label="Measurement period"
            unit="minutes"
            value={model.simulation.durationMinutes}
            min={1}
            onChange={(v) =>
              setModel((m) => ({ ...m, simulation: { ...m.simulation, durationMinutes: v } }))
            }
          />
          <SelectField
            label="Termination"
            value={model.simulation.terminationMode}
            options={[
              { value: 'drain', label: 'Drain — stop arrivals, finish the line' },
              { value: 'hardStop', label: 'Hard stop — cut off at the horizon' },
            ]}
            onChange={(v) =>
              setModel((m) => ({ ...m, simulation: { ...m.simulation, terminationMode: v } }))
            }
            hint="Drain avoids censoring cycle times."
          />
          <NumberField
            label="Vehicle traces kept"
            unit="vehicles per run"
            value={model.simulation.maxTraces}
            min={0}
            step={50}
            integer
            onChange={(v) =>
              setModel((m) => ({
                ...m,
                simulation: { ...m.simulation, maxTraces: v, collectVehicleTraces: v > 0 },
              }))
            }
            hint="Full per-vehicle histories for the inspector."
          />
        </div>

        <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
          <button
            className="btn primary"
            disabled={busy || !validation.runnable}
            onClick={() => void execute(false)}
          >
            {busy ? 'Running…' : 'Run simulation'}
          </button>
          <button
            className="btn"
            disabled={busy || !validation.runnable || !online}
            onClick={() => void execute(true)}
            title={online ? 'Run on the server and save to the run history' : 'API server not reachable'}
          >
            Run and save
          </button>
          <span className="small muted">
            {model.simulation.replications} replications ×{' '}
            {num(horizonHours, 1)} h horizon = {num(totalSimulatedHours, 0)} simulated hours
          </span>
        </div>

        {!validation.runnable ? (
          <Notice kind="error" title="Cannot run">
            The model has {validation.errors.length} validation error
            {validation.errors.length === 1 ? '' : 's'}. Fix them on the Model Validation page first.
          </Notice>
        ) : null}
        {error ? (
          <Notice kind="error" title="Run failed">
            {error}
          </Notice>
        ) : null}
      </Card>

      {!study ? (
        <Notice kind="info" title="No results yet">
          Press <strong>Run simulation</strong>. Until then, nothing on this page shows simulated
          numbers — an empty result is reported as empty rather than filled with placeholders.
        </Notice>
      ) : (
        <>
          {studyIsStale ? (
            <Notice kind="warn" title="These results are stale">
              The model has changed since this run. Re-run before drawing conclusions.
            </Notice>
          ) : null}

          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'results', label: 'Results' },
              { id: 'compare', label: 'Analytical vs simulation' },
              { id: 'replications', label: 'Replications' },
            ]}
          />

          {tab === 'results' ? <ResultsTab study={study} /> : null}
          {tab === 'compare' ? <CompareTab study={study} /> : null}
          {tab === 'replications' ? <ReplicationsTab study={study} /> : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ResultsTab({ study }: { study: StudyResult }) {
  const { model } = useStore();
  const rep = study.representative.simulation;
  const cycle = rep.system.cycleTime;

  // Cycle times of the representative replication, for the distribution.
  const cycleValues = study.representative.simulation.completedVehicles.length
    ? study.representative.simulation.completedVehicles
        .filter((v) => v.status === 'FINISHED' && v.completionTime !== null)
        .map((v) => (v.completionTime as number) - v.arrivalTime)
    : study.representative.simulation.traces
        .filter((v) => v.status === 'FINISHED' && v.completionTime !== null)
        .map((v) => (v.completionTime as number) - v.arrivalTime);

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Kpi label="Throughput" value={num(study.system.throughput?.mean, 3)} unit="veh/h" basis="simulated" metric={study.system.throughput} metricDp={3} />
        <Kpi label="Completed" value={num(study.system.vehiclesCompleted?.mean, 1)} unit="veh" basis="simulated" metric={study.system.vehiclesCompleted} metricDp={1} />
        <Kpi label="Reworked" value={num(study.system.vehiclesReworked?.mean, 1)} unit="veh" basis="simulated" metric={study.system.vehiclesReworked} metricDp={1} />
        <Kpi label="Scrapped" value={num(study.system.vehiclesScrapped?.mean, 1)} unit="veh" basis="simulated" metric={study.system.vehiclesScrapped} metricDp={1} />
        <Kpi label="W (mean)" value={num(study.system.WMinutes?.mean, 1)} unit="min" basis="simulated" metric={study.system.WMinutes} metricDp={1} />
        <Kpi label="Wq (mean)" value={num(study.system.WqMinutes?.mean, 1)} unit="min" basis="simulated" metric={study.system.WqMinutes} metricDp={1} />
        <Kpi label="L (WIP)" value={num(study.system.L?.mean, 2)} unit="veh" basis="simulated" metric={study.system.L} />
        <Kpi label="Lq" value={num(study.system.Lq?.mean, 2)} unit="veh" basis="simulated" metric={study.system.Lq} />
      </div>

      <div className="grid cols-2">
        <Card
          title="Manufacturing time distribution"
          hint="Requirement 12: the average alone hides the tail. One replication shown."
        >
          <Histogram
            values={cycleValues}
            unit="minutes"
            markers={[
              { value: cycle.medianMinutes, label: 'median', color: 'var(--series-3)' },
              { value: cycle.p95Minutes, label: 'p95', color: 'var(--status-serious)' },
            ]}
          />
          <DataTable
            rows={[
              { k: 'Mean', v: cycle.meanMinutes },
              { k: 'Median', v: cycle.medianMinutes },
              { k: '95th percentile', v: cycle.p95Minutes },
              { k: 'Maximum', v: cycle.maxMinutes },
              { k: 'Minimum', v: cycle.minMinutes },
              { k: 'Standard deviation', v: cycle.stdDevMinutes },
            ]}
            rowKey={(r) => r.k}
            columns={[
              { key: 'k', header: 'Statistic', align: 'left', render: (r) => r.k },
              { key: 'v', header: 'Minutes', render: (r) => num(r.v, 2) },
              { key: 'h', header: 'Hours', render: (r) => num(r.v / 60, 2) },
            ]}
            caption={`${cycle.count} finished vehicles in the representative replication.`}
          />
        </Card>

        <Card
          title="Where the time goes"
          hint="Requirement 12: the mean cycle time split into its components. They sum to the total."
        >
          <DataTable
            rows={[
              { k: 'Waiting in queues', v: rep.system.timeSplit.waitingMinutes },
              { k: 'Processing', v: rep.system.timeSplit.processingMinutes },
              { k: 'Machine downtime', v: rep.system.timeSplit.downtimeMinutes },
            ]}
            rowKey={(r) => r.k}
            columns={[
              { key: 'k', header: 'Component', align: 'left', render: (r) => r.k },
              { key: 'v', header: 'Minutes', render: (r) => num(r.v, 2) },
              {
                key: 'p',
                header: 'Share',
                render: (r) => pct(r.v / Math.max(1e-9, cycle.meanMinutes)),
              },
            ]}
            emphasiseRow={() => false}
          />
          <div className="formula">
            Of which rework processing {num(rep.system.timeSplit.reworkMinutes, 1)} min and
            inspection {num(rep.system.timeSplit.inspectionMinutes, 1)} min. Theoretical minimum
            (pure work content at every station a vehicle visits, with zero queueing) is{' '}
            {num(theoreticalMinimumCycleMinutes(model), 1)} min — the gap to{' '}
            {num(cycle.meanMinutes, 1)} min is queueing and machine downtime.
          </div>
        </Card>
      </div>

      <Card title="Per-station results" hint="Mean over replications, with 95% intervals on Wq.">
        <DataTable
          rows={study.stations}
          rowKey={(s) => s.stationId}
          columns={[
            { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
            { key: 'u', header: 'Utilisation', render: (s) => pct(s.metrics.utilization?.mean ?? 0), sortValue: (s) => s.metrics.utilization?.mean ?? 0 },
            { key: 'lam', header: 'λ observed', render: (s) => num(s.metrics.lambdaObserved?.mean, 3) },
            { key: 'thr', header: 'Throughput', render: (s) => num(s.metrics.throughput?.mean, 3) },
            { key: 'L', header: 'L', render: (s) => num(s.metrics.L?.mean, 3) },
            { key: 'Lq', header: 'Lq', render: (s) => num(s.metrics.Lq?.mean, 3), sortValue: (s) => s.metrics.Lq?.mean ?? 0 },
            { key: 'W', header: 'W (min)', render: (s) => num(s.metrics.WMinutes?.mean, 2) },
            {
              key: 'Wq',
              header: 'Wq (min) [95% CI]',
              render: (s) => {
                const m = s.metrics.WqMinutes;
                if (!m) return 'n/a';
                return Number.isFinite(m.halfWidth)
                  ? `${num(m.mean, 2)} [${num(m.ciLow, 2)}–${num(m.ciHigh, 2)}]`
                  : num(m.mean, 2);
              },
              sortValue: (s) => s.metrics.WqMinutes?.mean ?? 0,
            },
            { key: 'pq', header: 'Peak queue', render: (s) => num(s.metrics.maxQueueLength?.mean, 1) },
            { key: 'bd', header: 'Breakdowns', render: (s) => num(s.metrics.breakdowns?.mean, 1) },
            { key: 'dt', header: 'Downtime', render: (s) => pct(s.metrics.downtimeFraction?.mean ?? 0, 2) },
          ]}
        />
      </Card>

      {study.warnings.length > 0 ? (
        <Notice kind="warn" title="Run warnings">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {study.warnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CompareTab({ study }: { study: StudyResult }) {
  const { model, analytical } = useStore();

  const rows = analytical.stations.map((a) => {
    const s = study.stations.find((x) => x.stationId === a.stationId);
    const simRho = s?.metrics.utilization?.mean ?? 0;
    const simLq = s?.metrics.Lq?.mean ?? 0;
    const simWq = s?.metrics.WqMinutes?.mean ?? 0;
    const def = model.stations.find((x) => x.id === a.stationId);
    const breakdowns = !!def?.machine?.reliability?.enabled;

    let reason: string;
    if (!a.exact) {
      reason =
        'Arrivals here are not Poisson (a non-exponential station lies upstream), so the closed form is a decomposition estimate.';
    } else if (breakdowns) {
      reason =
        'Machine breakdowns are simulated here but the closed-form model has no failing servers, so it understates the queue.';
    } else if (a.rho > 0.85) {
      reason =
        'High utilisation: the variance of a time-averaged queue grows very steeply as ρ approaches 1, so a finite run is noisy.';
    } else {
      reason = 'Sampling error of a finite run.';
    }

    return {
      id: a.stationId,
      name: a.stationName,
      kendall: a.kendall,
      exact: a.exact,
      anRho: a.rho,
      simRho,
      anLq: a.Lq,
      simLq,
      anWq: a.WqMinutes,
      simWq,
      reason,
    };
  });

  const relErr = (sim: number, an: number) =>
    Number.isFinite(an) && Math.abs(an) > 1e-9 ? Math.abs(sim - an) / Math.abs(an) : NaN;

  return (
    <div className="stack">
      <Notice kind="info" title="Why the two columns differ">
        Analytical results are exact solutions to an idealised model: Poisson arrivals, servers
        that never fail, unbounded queues. The simulation relaxes all three. Neither column is
        "the right one" — they answer different questions, and the last column names which
        difference applies at each station.
      </Notice>

      <Card title="Analytical vs simulated" hint="Requirement 43. Errors shown as absolute and relative.">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            { key: 'n', header: 'Station', align: 'left', render: (r) => r.name },
            { key: 'k', header: 'Kendall', align: 'left', render: (r) => r.kendall },
            { key: 'ar', header: 'ρ analytic', render: (r) => pct(r.anRho, 2) },
            { key: 'sr', header: 'ρ simulated', render: (r) => pct(r.simRho, 2) },
            {
              key: 'er',
              header: 'ρ error',
              render: (r) => `${num(Math.abs(r.simRho - r.anRho) * 100, 2)} pp`,
              sortValue: (r) => Math.abs(r.simRho - r.anRho),
            },
            { key: 'al', header: 'Lq analytic', render: (r) => num(r.anLq, 3) },
            { key: 'sl', header: 'Lq simulated', render: (r) => num(r.simLq, 3) },
            {
              key: 'el',
              header: 'Lq % error',
              render: (r) => (Number.isNaN(relErr(r.simLq, r.anLq)) ? 'n/a' : pct(relErr(r.simLq, r.anLq), 1)),
              sortValue: (r) => relErr(r.simLq, r.anLq) || 0,
            },
            { key: 'aw', header: 'Wq analytic (min)', render: (r) => num(r.anWq, 2) },
            { key: 'sw', header: 'Wq simulated (min)', render: (r) => num(r.simWq, 2) },
            {
              key: 'x',
              header: 'Closed form',
              align: 'left',
              render: (r) =>
                r.exact ? (
                  <span className="status good">Exact</span>
                ) : (
                  <span className="status warning">Approximation</span>
                ),
            },
          ]}
        />
      </Card>

      <Card title="Explanation per station">
        <DataTable
          rows={rows}
          rowKey={(r) => `${r.id}-why`}
          columns={[
            { key: 'n', header: 'Station', align: 'left', render: (r) => r.name },
            { key: 'why', header: 'Dominant source of difference', align: 'left', render: (r) => r.reason },
          ]}
        />
      </Card>

      <Card title="System level">
        <DataTable
          rows={[
            {
              k: 'L (WIP)',
              an: analytical.system.L,
              sim: study.system.L?.mean ?? 0,
              unit: 'vehicles',
            },
            {
              k: 'Lq',
              an: analytical.system.Lq,
              sim: study.system.Lq?.mean ?? 0,
              unit: 'vehicles',
            },
            {
              k: 'W',
              an: analytical.system.WMinutes,
              sim: study.system.WMinutes?.mean ?? 0,
              unit: 'minutes',
            },
            {
              k: 'Throughput',
              an: analytical.system.throughputFinished,
              sim: study.system.throughput?.mean ?? 0,
              unit: 'veh/h',
            },
          ]}
          rowKey={(r) => r.k}
          columns={[
            { key: 'k', header: 'Metric', align: 'left', render: (r) => r.k },
            { key: 'u', header: 'Unit', align: 'left', render: (r) => r.unit },
            { key: 'an', header: 'Analytical', render: (r) => num(r.an, 3) },
            { key: 'sim', header: 'Simulated', render: (r) => num(r.sim, 3) },
            { key: 'abs', header: 'Absolute error', render: (r) => num(Math.abs(r.sim - r.an), 3) },
            {
              key: 'rel',
              header: 'Relative error',
              render: (r) => (Number.isFinite(r.an) && r.an !== 0 ? pct(Math.abs(r.sim - r.an) / Math.abs(r.an), 2) : 'n/a'),
            },
          ]}
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReplicationsTab({ study }: { study: StudyResult }) {
  const metrics = ['throughput', 'vehiclesCompleted', 'WMinutes', 'WqMinutes', 'L', 'cycleP95'];
  const rows = Array.from({ length: study.replications }, (_, i) => ({
    i,
    seed: study.seeds[i] ?? 0,
    values: metrics.map((k) => study.system[k]?.values[i] ?? NaN),
    cost: study.cost.costPerVehicle?.values[i] ?? NaN,
  }));

  return (
    <div className="stack">
      <Notice kind="info" title="Why replications matter">
        Each replication is an independent run with its own derived seed. The spread across them is
        the sampling error in every headline figure — a difference between two scenarios smaller
        than this spread is not evidence of anything.
      </Notice>

      <Card title="Per-replication results">
        <DataTable
          rows={rows}
          rowKey={(r) => String(r.i)}
          columns={[
            { key: 'i', header: 'Rep', render: (r) => r.i },
            { key: 's', header: 'Seed', render: (r) => r.seed },
            ...metrics.map((k, idx) => ({
              key: k,
              header: study.system[k]?.label ?? k,
              title: study.system[k]?.unit,
              render: (r: (typeof rows)[number]) => num(r.values[idx], 3),
              sortValue: (r: (typeof rows)[number]) => r.values[idx] ?? 0,
            })),
            { key: 'c', header: 'Cost/vehicle', render: (r) => num(r.cost, 2) },
          ]}
        />
      </Card>

      <Card title="Summary statistics" hint="Student's t interval — appropriate for a small number of replications.">
        <DataTable
          rows={[...Object.values(study.system), ...Object.values(study.cost)]}
          rowKey={(m) => m.key + m.label}
          columns={[
            { key: 'l', header: 'Metric', align: 'left', render: (m) => m.label },
            { key: 'u', header: 'Unit', align: 'left', render: (m) => m.unit },
            { key: 'n', header: 'n', render: (m) => m.n },
            { key: 'mean', header: 'Mean', render: (m) => num(m.mean, 3) },
            { key: 'sd', header: 'Std dev', render: (m) => num(m.stdDev, 3) },
            { key: 'se', header: 'Std error', render: (m) => num(m.stdError, 4) },
            {
              key: 'ci',
              header: '95% CI',
              render: (m) =>
                Number.isFinite(m.halfWidth) ? `${num(m.ciLow, 3)} – ${num(m.ciHigh, 3)}` : 'n/a',
            },
            {
              key: 'rh',
              header: 'Precision (± of mean)',
              render: (m) => (Number.isFinite(m.relativeHalfWidth) ? pct(m.relativeHalfWidth, 2) : 'n/a'),
              sortValue: (m) => m.relativeHalfWidth || 0,
            },
            { key: 'min', header: 'Min', render: (m) => num(m.min, 3) },
            { key: 'max', header: 'Max', render: (m) => num(m.max, 3) },
          ]}
          maxHeight={460}
        />
      </Card>
    </div>
  );
}
