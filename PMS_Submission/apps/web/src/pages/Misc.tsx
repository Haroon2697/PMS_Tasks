/**
 * Model validation, reports/export, live factory, system configuration and
 * settings pages — requirements 36, 45, 46, 49, 50, 51, 53, 54, 55, 64.
 *
 * These five share a file because each is mostly a thin presentation of an
 * engine result rather than a screen with its own logic.
 */

import { useState } from 'react';
import {
  buildExportBundle,
  buildReferenceModel,
  collectProvenance,
  computeCosts,
  generateReport,
  runSimulation,
  runStudy,
  CURRENCIES,
  type CurrencyCode,
} from '@vmq/engine';
import { useStore } from '../state/store';
import { api, downloadFile } from '../lib/api';
import {
  Card,
  DataTable,
  EmptyState,
  Kpi,
  Notice,
  NumberField,
  ProvenanceBadge,
  SelectField,
  Tabs,
} from '../components/primitives';
import { LiveFactoryView, TransportControls, useLiveSimulation } from '../components/LiveFactory';
import { money, num, pct } from '../lib/format';

/* ------------------------------------------------------------------ */
/* Live factory — requirements 38, 64                                  */
/* ------------------------------------------------------------------ */

export function LiveFactoryPage() {
  const { model, bottleneck, validation } = useStore();
  const controller = useLiveSimulation(model, 30);

  if (!validation.runnable) {
    return (
      <Notice kind="error" title="Cannot run">
        Fix the validation errors before running the factory.
      </Notice>
    );
  }

  return (
    <div className="stack">
      <p className="page-intro">
        This is the simulation itself, not an animation of it. Every queue and every busy machine is
        read from the running discrete-event model, so pausing freezes the clock and "Step event"
        advances the event calendar by exactly one event.
      </p>
      <Card>
        <TransportControls controller={controller} />
      </Card>
      <LiveFactoryView
        model={model}
        controller={controller}
        bottleneckId={bottleneck.primaryBottleneckId}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Model validation — requirements 50, 51                              */
/* ------------------------------------------------------------------ */

export function ValidationPage() {
  const { model, validation } = useStore();
  const provenance = collectProvenance(model);

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Kpi
          label="Model status"
          value={validation.runnable ? 'Runnable' : 'Blocked'}
          basis="derived"
          small
          status={validation.errors.length ? 'critical' : validation.warnings.length ? 'warning' : 'good'}
          sub={`${validation.errors.length} errors, ${validation.warnings.length} warnings`}
        />
        <Kpi
          label="Stable queues"
          value={`${validation.summary.stableStations} / ${validation.summary.totalStations}`}
          basis="analytical"
          small
          sub="stations with ρ < 1"
        />
        <Kpi
          label="Factory capacity"
          value={num(validation.summary.factoryCapacityPerHour, 3)}
          unit="veh/h"
          basis="analytical"
          small
          sub={`constrained by ${validation.summary.bottleneckStationName ?? '—'}`}
        />
        <Kpi
          label="Parameters"
          value={num(provenance.parameters.length, 0)}
          basis="derived"
          small
          sub={`${provenance.sourced} sourced · ${provenance.assumptions} assumptions · ${provenance.userInput} user`}
        />
      </div>

      <Card title="Checks">
        <DataTable
          rows={validation.checks}
          rowKey={(c) => c.label}
          columns={[
            {
              key: 'r',
              header: 'Result',
              align: 'left',
              render: (c) =>
                c.passed ? (
                  <span className="status good">PASS</span>
                ) : (
                  <span className="status critical">FAIL</span>
                ),
            },
            { key: 'l', header: 'Check', align: 'left', render: (c) => c.label },
            { key: 'd', header: 'Detail', align: 'left', render: (c) => c.detail },
          ]}
        />
      </Card>

      {validation.errors.length > 0 ? (
        <Card title="Errors — the model cannot be simulated until these are fixed">
          <DataTable
            rows={validation.errors}
            rowKey={(e, ) => `${e.code}-${e.message.slice(0, 30)}`}
            columns={[
              { key: 'c', header: 'Code', align: 'left', render: (e) => <span className="mono small">{e.code}</span> },
              { key: 'm', header: 'Problem', align: 'left', render: (e) => e.message },
              { key: 'r', header: 'What to do', align: 'left', render: (e) => e.remedy ?? '—' },
            ]}
          />
        </Card>
      ) : null}

      {validation.warnings.length > 0 ? (
        <Card
          title="Warnings — the model runs, but these deserve attention"
          hint="A warning never blocks a run. Refusing to simulate on a modelling judgement would be as wrong as running silently on an error."
        >
          <DataTable
            rows={validation.warnings}
            rowKey={(e) => `${e.code}-${e.message.slice(0, 30)}`}
            columns={[
              { key: 'c', header: 'Code', align: 'left', render: (e) => <span className="mono small">{e.code}</span> },
              { key: 'm', header: 'Observation', align: 'left', render: (e) => e.message },
              { key: 'r', header: 'Suggestion', align: 'left', render: (e) => e.remedy ?? '—' },
            ]}
          />
        </Card>
      ) : null}

      {validation.info.length > 0 ? (
        <Card title="Notes">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {validation.info.map((i, idx) => (
              <li key={idx} style={{ marginBottom: 5 }}>
                {i.message}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card
        title="Parameter register"
        hint="Requirement 46: every configurable number, with its unit and where it came from."
      >
        <DataTable
          rows={provenance.parameters}
          rowKey={(p) => p.path}
          maxHeight={520}
          columns={[
            { key: 'l', header: 'Parameter', align: 'left', render: (p) => p.label },
            { key: 'v', header: 'Value', render: (p) => num(p.value, 4), sortValue: (p) => p.value },
            { key: 'u', header: 'Unit', align: 'left', render: (p) => p.unit },
            {
              key: 'p',
              header: 'Provenance',
              align: 'left',
              render: (p) => <ProvenanceBadge provenance={p.provenance as never} />,
              sortValue: (p) => p.provenance,
            },
            { key: 's', header: 'Source / notes', align: 'left', render: (p) => p.source ?? p.notes ?? '—' },
            { key: 'path', header: 'Path', align: 'left', render: (p) => <span className="mono small">{p.path}</span> },
          ]}
        />
      </Card>

      {(model.assumptions ?? []).length > 0 ? (
        <Card title="Stated modelling assumptions">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {(model.assumptions ?? []).map((a, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                {a}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reports and export — requirements 54, 55                            */
/* ------------------------------------------------------------------ */

export function ReportsPage() {
  const { model, run, online, notify } = useStore();
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [author, setAuthor] = useState('');
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    await new Promise((r) => setTimeout(r, 16));
    try {
      const study = run?.study ?? runStudy(model);
      const sim = runSimulation(model);
      const cost = computeCosts(model, sim);
      const md = generateReport({ model, study, cost, author: author || undefined });
      setReport(md);
      if (online) {
        try {
          await api.createReport(model.id, { title: `${model.name} — Simulation Report`, author });
          notify('Report generated and saved.');
        } catch {
          notify('Report generated (not saved — API unreachable).');
        }
      } else {
        notify('Report generated.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportAll = () => {
    const study = run?.study ?? runStudy(model);
    const sim = runSimulation(model);
    const cost = computeCosts(model, sim);
    const files = buildExportBundle({
      model,
      study,
      cost,
      vehicles: study.representative.simulation.traces,
      report: report ?? generateReport({ model, study, cost }),
    });
    for (const f of files) downloadFile(f.filename, f.content, f.mimeType);
    notify(`${files.length} files downloaded.`);
  };

  return (
    <div className="stack">
      <Card
        title="Generate report"
        hint="Requirement 54: executive summary, system description, network, queue parameters, mathematics, methodology, results, bottlenecks, cost, financials, assumptions, limitations and sources."
      >
        <div className="grid cols-3">
          <div className="field">
            <label>Author (optional)</label>
            <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={busy} onClick={() => void generate()}>
              {busy ? 'Generating…' : 'Generate report'}
            </button>
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={exportAll}>
              Export all data (CSV + JSON)
            </button>
          </div>
        </div>
        {!run ? (
          <Notice kind="info">
            No study has been run, so the report will run one now with the current settings.
          </Notice>
        ) : null}
        {error ? (
          <Notice kind="error" title="Report failed">
            {error}
          </Notice>
        ) : null}
      </Card>

      <Card
        title="Individual exports"
        hint="Requirement 55. Each file carries its units in the column headers."
      >
        <div className="row">
          {(
            [
              ['Queue metrics', 'queue'],
              ['Summary statistics', 'summary'],
              ['Replications', 'reps'],
              ['Cost breakdown', 'cost'],
              ['Station costs', 'stationcost'],
              ['Bill of materials', 'bom'],
              ['Parameters & provenance', 'params'],
              ['Vehicle traces', 'traces'],
              ['Station visits', 'visits'],
              ['Configuration (JSON)', 'config'],
            ] as const
          ).map(([label, key]) => (
            <button
              key={key}
              className="btn sm"
              onClick={() => {
                const study = run?.study ?? runStudy(model);
                const sim = runSimulation(model);
                const cost = computeCosts(model, sim);
                const files = buildExportBundle({
                  model,
                  study,
                  cost,
                  vehicles: study.representative.simulation.traces,
                });
                const pick: Record<string, string> = {
                  queue: 'queue-metrics',
                  summary: 'summary-statistics',
                  reps: 'replications',
                  cost: 'cost-breakdown',
                  stationcost: 'station-costs',
                  bom: 'bom',
                  params: 'parameters',
                  traces: 'vehicle-traces',
                  visits: 'station-visits',
                  config: 'configuration',
                };
                const f = files.find((x) => x.filename.includes(pick[key] as string));
                if (f) downloadFile(f.filename, f.content, f.mimeType);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {report ? (
        <Card
          title="Report"
          actions={
            <>
              <button
                className="btn sm"
                onClick={() => downloadFile(`${model.id}-report.md`, report, 'text/markdown')}
              >
                Download .md
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(report);
                  notify('Report copied to the clipboard.');
                }}
              >
                Copy
              </button>
            </>
          }
        >
          <pre
            className="mono small scroll-y"
            style={{
              maxHeight: 640,
              whiteSpace: 'pre-wrap',
              background: 'var(--surface-2)',
              padding: 12,
              borderRadius: 4,
              margin: 0,
            }}
          >
            {report}
          </pre>
        </Card>
      ) : (
        <EmptyState>No report generated yet.</EmptyState>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* System configuration — requirements 36, 49                          */
/* ------------------------------------------------------------------ */

export function SystemConfigPage({ navigate }: { navigate: (p: string) => void }) {
  const { model, setModel, analytical, capacity } = useStore();
  const currency = model.cost.currency;
  const [tab, setTab] = useState<'demand' | 'costs' | 'overhead'>('demand');

  const meanLambda = analytical.system.lambdaExternal;

  return (
    <div className="stack">
      <Card title="System">
        <div className="grid cols-3">
          <div className="field">
            <label>Name</label>
            <input
              type="text"
              value={model.name}
              onChange={(e) => setModel((m) => ({ ...m, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Description</label>
            <input
              type="text"
              value={model.description ?? ''}
              onChange={(e) => setModel((m) => ({ ...m, description: e.target.value }))}
            />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setModel(buildReferenceModel())}>
              Reset to the reference line
            </button>
          </div>
        </div>
      </Card>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'demand', label: 'Demand schedule' },
          { id: 'costs', label: 'Cost parameters' },
          { id: 'overhead', label: 'Overhead' },
        ]}
      />

      {tab === 'demand' ? (
        <Card
          title="Time-of-day demand"
          hint="Requirement 7: this is the only place an external arrival rate is defined. Requirement 36: the simulation genuinely changes its arrival process across these blocks."
        >
          <DataTable
            rows={model.arrivals.schedule.map((b, i) => ({ b, i }))}
            rowKey={(r) => String(r.i)}
            columns={[
              { key: 'l', header: 'Block', align: 'left', render: (r) => r.b.label ?? `Block ${r.i + 1}` },
              {
                key: 's',
                header: 'Start (min)',
                render: (r) => (
                  <input
                    type="number"
                    min={0}
                    step={30}
                    value={r.b.startMinute}
                    style={{ width: 84 }}
                    onChange={(e) =>
                      setModel((m) => ({
                        ...m,
                        arrivals: {
                          ...m.arrivals,
                          schedule: m.arrivals.schedule.map((x, i) =>
                            i === r.i ? { ...x, startMinute: Number(e.target.value) || 0 } : x,
                          ),
                        },
                      }))
                    }
                  />
                ),
              },
              {
                key: 'e',
                header: 'End (min)',
                render: (r) => (
                  <input
                    type="number"
                    min={0}
                    step={30}
                    value={r.b.endMinute}
                    style={{ width: 84 }}
                    onChange={(e) =>
                      setModel((m) => ({
                        ...m,
                        arrivals: {
                          ...m.arrivals,
                          schedule: m.arrivals.schedule.map((x, i) =>
                            i === r.i ? { ...x, endMinute: Number(e.target.value) || 0 } : x,
                          ),
                        },
                      }))
                    }
                  />
                ),
              },
              {
                key: 'lam',
                header: 'λ (vehicles/hour)',
                render: (r) => (
                  <input
                    type="number"
                    min={0.01}
                    step={0.1}
                    value={r.b.lambdaPerHour.value}
                    style={{ width: 96 }}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isNaN(v) || v <= 0) return;
                      setModel((m) => ({
                        ...m,
                        arrivals: {
                          ...m.arrivals,
                          schedule: m.arrivals.schedule.map((x, i) =>
                            i === r.i
                              ? { ...x, lambdaPerHour: { ...x.lambdaPerHour, value: v, provenance: 'USER_INPUT' } }
                              : x,
                          ),
                        },
                      }));
                    }}
                  />
                ),
              },
              {
                key: 'cap',
                header: 'vs capacity',
                render: (r) =>
                  r.b.lambdaPerHour.value > capacity.lambdaMaxPerHour ? (
                    <span className="status critical">exceeds capacity</span>
                  ) : (
                    <span className="status good">within capacity</span>
                  ),
              },
              {
                key: 'p',
                header: 'Source',
                align: 'left',
                render: (r) => <ProvenanceBadge provenance={r.b.lambdaPerHour.provenance} />,
              },
            ]}
            caption={`Time-weighted average λ = ${num(meanLambda, 3)} vehicles/hour against a factory capacity of ${num(capacity.lambdaMaxPerHour, 3)} vehicles/hour.`}
          />

          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn sm"
              onClick={() =>
                setModel((m) => {
                  const last = m.arrivals.schedule[m.arrivals.schedule.length - 1];
                  const start = last ? last.endMinute : 0;
                  return {
                    ...m,
                    arrivals: {
                      ...m.arrivals,
                      schedule: [
                        ...m.arrivals.schedule,
                        {
                          startMinute: start,
                          endMinute: start + 120,
                          lambdaPerHour: { value: 5, unit: 'vehicles/hour', provenance: 'USER_INPUT' },
                          label: 'New block',
                        },
                      ],
                    },
                  };
                })
              }
            >
              Add block
            </button>
            <button
              className="btn sm danger"
              disabled={model.arrivals.schedule.length <= 1}
              onClick={() =>
                setModel((m) => ({
                  ...m,
                  arrivals: { ...m.arrivals, schedule: m.arrivals.schedule.slice(0, -1) },
                }))
              }
            >
              Remove last
            </button>
            <SelectField
              label=""
              value={model.arrivals.interarrivalKind}
              options={[
                { value: 'exponential', label: 'Exponential inter-arrivals (Poisson, Kendall M)' },
                { value: 'constant', label: 'Deterministic inter-arrivals (Kendall D)' },
                { value: 'erlang', label: 'Erlang-2 inter-arrivals' },
                { value: 'lognormal', label: 'Lognormal inter-arrivals' },
              ]}
              onChange={(v) =>
                setModel((m) => ({ ...m, arrivals: { ...m.arrivals, interarrivalKind: v } }))
              }
            />
          </div>

          {meanLambda > capacity.lambdaMaxPerHour ? (
            <Notice kind="error" title="Average demand exceeds capacity">
              WIP will grow for as long as the run continues and the reported averages will depend
              on the run length.{' '}
              <button className="btn sm" onClick={() => navigate('bottleneck')}>
                See the constraint
              </button>
            </Notice>
          ) : null}
        </Card>
      ) : null}

      {tab === 'costs' ? (
        <Card title="Cost parameters" hint="Requirement 49. Every one carries its unit and provenance.">
          <div className="grid cols-3">
            <NumberField
              label="Electricity price"
              unit={`${currency.code}/kWh`}
              value={model.cost.electricityPricePerKwh.value}
              min={0}
              step={0.001}
              provenance={model.cost.electricityPricePerKwh.provenance}
              onChange={(v) =>
                setModel((m) => ({
                  ...m,
                  cost: {
                    ...m.cost,
                    electricityPricePerKwh: { ...m.cost.electricityPricePerKwh, value: v, provenance: 'USER_INPUT' },
                  },
                }))
              }
            />
            <NumberField
              label="Waiting cost"
              unit={`${currency.code}/vehicle-hour`}
              value={model.cost.waitingCostPerVehicleHour.value}
              min={0}
              provenance={model.cost.waitingCostPerVehicleHour.provenance}
              onChange={(v) =>
                setModel((m) => ({
                  ...m,
                  cost: {
                    ...m.cost,
                    waitingCostPerVehicleHour: { ...m.cost.waitingCostPerVehicleHour, value: v, provenance: 'USER_INPUT' },
                  },
                }))
              }
              hint="Reported separately from manufacturing cost."
            />
            <NumberField
              label="WIP holding cost"
              unit={`${currency.code}/vehicle-hour`}
              value={model.cost.wipHoldingCostPerVehicleHour.value}
              min={0}
              provenance={model.cost.wipHoldingCostPerVehicleHour.provenance}
              onChange={(v) =>
                setModel((m) => ({
                  ...m,
                  cost: {
                    ...m.cost,
                    wipHoldingCostPerVehicleHour: {
                      ...m.cost.wipHoldingCostPerVehicleHour,
                      value: v,
                      provenance: 'USER_INPUT',
                    },
                  },
                }))
              }
            />
            <NumberField
              label="Preventive maintenance"
              unit={`${currency.code}/machine-hour`}
              value={model.cost.preventiveMaintenancePerMachineHour.value}
              min={0}
              provenance={model.cost.preventiveMaintenancePerMachineHour.provenance}
              onChange={(v) =>
                setModel((m) => ({
                  ...m,
                  cost: {
                    ...m.cost,
                    preventiveMaintenancePerMachineHour: {
                      ...m.cost.preventiveMaintenancePerMachineHour,
                      value: v,
                      provenance: 'USER_INPUT',
                    },
                  },
                }))
              }
            />
            <SelectField
              label="Labour cost basis"
              value={model.cost.laborCostBasis}
              options={[
                { value: 'scheduled', label: 'Scheduled — crews paid for the whole shift' },
                { value: 'busy', label: 'Busy only — charge time spent servicing' },
              ]}
              onChange={(v) => setModel((m) => ({ ...m, cost: { ...m.cost, laborCostBasis: v } }))}
              hint="Scheduled is realistic for a manned line; idle labour is then reported separately."
            />
          </div>
        </Card>
      ) : null}

      {tab === 'overhead' ? (
        <Card
          title="Overhead"
          hint="Requirement 26: fixed and variable costs are kept distinct. Overhead is a period cost, so cost per vehicle falls as throughput rises."
        >
          <div className="grid cols-3">
            <SelectField
              label="Overhead basis"
              value={model.cost.overhead.mode}
              options={[
                { value: 'perHour', label: 'Fixed rate per hour' },
                { value: 'perVehicle', label: 'Allocated per vehicle' },
              ]}
              onChange={(v) =>
                setModel((m) => ({ ...m, cost: { ...m.cost, overhead: { ...m.cost.overhead, mode: v } } }))
              }
            />
            <NumberField
              label="Overhead rate"
              unit={model.cost.overhead.mode === 'perHour' ? `${currency.code}/hour` : `${currency.code}/vehicle`}
              value={model.cost.overhead.amount.value}
              min={0}
              provenance={model.cost.overhead.amount.provenance}
              onChange={(v) =>
                setModel((m) => ({
                  ...m,
                  cost: {
                    ...m.cost,
                    overhead: {
                      ...m.cost.overhead,
                      amount: { ...m.cost.overhead.amount, value: v, provenance: 'USER_INPUT' },
                    },
                  },
                }))
              }
            />
          </div>

          <DataTable
            rows={model.cost.overhead.breakdown}
            rowKey={(b) => b.id}
            columns={[
              { key: 'n', header: 'Item', align: 'left', render: (b) => b.name },
              {
                key: 'a',
                header: `Rate (${currency.code}/h)`,
                render: (b) => (
                  <input
                    type="number"
                    min={0}
                    step={10}
                    value={b.amount.value}
                    style={{ width: 100 }}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isNaN(v) || v < 0) return;
                      setModel((m) => ({
                        ...m,
                        cost: {
                          ...m.cost,
                          overhead: {
                            ...m.cost.overhead,
                            breakdown: m.cost.overhead.breakdown.map((x) =>
                              x.id === b.id
                                ? { ...x, amount: { ...x.amount, value: v, provenance: 'USER_INPUT' as const } }
                                : x,
                            ),
                          },
                        },
                      }));
                    }}
                  />
                ),
                sortValue: (b) => b.amount.value,
              },
              {
                key: 's',
                header: 'Share',
                render: (b) =>
                  pct(
                    b.amount.value /
                      Math.max(
                        1e-9,
                        model.cost.overhead.breakdown.reduce((a, x) => a + x.amount.value, 0),
                      ),
                  ),
              },
            ]}
            caption={`Breakdown total ${money(
              model.cost.overhead.breakdown.reduce((a, b) => a + b.amount.value, 0),
              currency,
              2,
            )} against a configured rate of ${money(model.cost.overhead.amount.value, currency, 2)}. The configured rate is what gets charged; the breakdown only feeds the cost-detail view.`}
          />
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings — requirement 53                                           */
/* ------------------------------------------------------------------ */

export function SettingsPage() {
  const { model, setModel, theme, setTheme, online, saveModel, loadSystem, notify } = useStore();
  const [systems, setSystems] = useState<{ id: string; name: string }[]>([]);

  return (
    <div className="stack">
      <Card title="Appearance">
        <div className="grid cols-3">
          <SelectField
            label="Theme"
            value={theme}
            options={[
              { value: 'system', label: 'Follow the system setting' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
          />
        </div>
      </Card>

      <Card
        title="Currency"
        hint="Requirement 53: the model stores one consistent currency. Changing the code relabels the figures; it does not convert them."
      >
        <div className="grid cols-3">
          <SelectField
            label="Currency"
            value={model.cost.currency.code}
            options={Object.entries(CURRENCIES).map(([code, meta]) => ({
              value: code as CurrencyCode,
              label: `${code} — ${meta.name}`,
            }))}
            onChange={(code) =>
              setModel((m) => ({
                ...m,
                cost: {
                  ...m.cost,
                  currency: {
                    ...m.cost.currency,
                    code: code as CurrencyCode,
                    symbol: CURRENCIES[code]?.symbol ?? code,
                  },
                },
              }))
            }
          />
          <div className="field">
            <label>Symbol</label>
            <input
              type="text"
              value={model.cost.currency.symbol}
              onChange={(e) =>
                setModel((m) => ({
                  ...m,
                  cost: { ...m.cost, currency: { ...m.cost.currency, symbol: e.target.value } },
                }))
              }
            />
          </div>
        </div>
        <Notice kind="warn" title="No conversion is applied">
          All monetary parameters keep their numeric values when you change the currency code. If
          the figures should be converted, edit them, and record the exchange rate and its date in
          the parameter notes so the report can cite them.
        </Notice>
      </Card>

      <Card
        title="Storage"
        hint="The engine runs in the browser. The API server stores systems, scenarios, runs and reports."
      >
        <div className="row">
          <span className={`status ${online ? 'good' : 'neutral'}`}>
            {online ? 'API server reachable' : 'API server not reachable'}
          </span>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" disabled={!online} onClick={() => void saveModel()}>
            Save this system
          </button>
          <button
            className="btn"
            disabled={!online}
            onClick={async () => {
              try {
                const list = await api.listSystems();
                setSystems(list.map((s) => ({ id: s.id, name: s.name })));
                notify(`${list.length} systems stored.`);
              } catch {
                notify('Could not list systems.');
              }
            }}
          >
            List stored systems
          </button>
        </div>
        {systems.length > 0 ? (
          <DataTable
            rows={systems}
            rowKey={(s) => s.id}
            columns={[
              { key: 'n', header: 'System', align: 'left', render: (s) => s.name },
              { key: 'i', header: 'ID', align: 'left', render: (s) => <span className="mono small">{s.id}</span> },
              {
                key: 'a',
                header: '',
                align: 'left',
                render: (s) => (
                  <button className="btn sm" onClick={() => void loadSystem(s.id)}>
                    Load
                  </button>
                ),
              },
            ]}
          />
        ) : null}
        {!online ? (
          <Notice kind="info">
            Start the API with <code className="mono">npm run dev:api</code> to persist systems,
            scenarios and runs. Everything else — simulation, analysis, optimisation, reports —
            works without it.
          </Notice>
        ) : null}
      </Card>
    </div>
  );
}
