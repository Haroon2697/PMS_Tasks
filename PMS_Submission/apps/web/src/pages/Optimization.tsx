/**
 * Optimisation — requirements 33, 34, 68.
 *
 * The user names an objective and its constraints, sets a range of server
 * counts per station, and the optimiser enumerates configurations, screens them
 * analytically, then confirms the best few with full replication studies. The
 * reported figures always come from the confirmation runs, never from the
 * screen, so the recommendation is reproducible by loading that configuration
 * and running it.
 */

import { useState } from 'react';
import { optimize, type DecisionVariable, type ObjectiveKind, type OptimizationResult } from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, Kpi, Notice, NumberField, SelectField } from '../components/primitives';
import { money, num, pct } from '../lib/format';

const OBJECTIVES: { value: ObjectiveKind; label: string }[] = [
  { value: 'minimizeCostPerVehicle', label: 'Minimise cost per vehicle' },
  { value: 'minimizeTotalCost', label: 'Minimise total manufacturing cost' },
  { value: 'maximizeThroughput', label: 'Maximise throughput' },
  { value: 'minimizeWq', label: 'Minimise queue waiting time' },
  { value: 'minimizeCycleTime', label: 'Minimise manufacturing cycle time' },
  { value: 'maximizeProfit', label: 'Maximise profit' },
  { value: 'maximizeRoi', label: 'Maximise return on investment' },
  { value: 'minimizePayback', label: 'Minimise payback period' },
  { value: 'weighted', label: 'Weighted combination' },
];

export function OptimizationPage() {
  const { model, notify } = useStore();
  const currency = model.cost.currency;

  const [objective, setObjective] = useState<ObjectiveKind>('minimizeCostPerVehicle');
  const [variables, setVariables] = useState<DecisionVariable[]>(() =>
    model.stations.slice(0, 3).map((s) => ({
      stationId: s.id,
      minServers: s.servers,
      maxServers: s.servers + 2,
      capitalCostPerServer: s.machine?.purchasePrice.value ?? 250_000,
      annualOperatingCostPerServer: Math.round((s.machine?.purchasePrice.value ?? 250_000) * 0.075),
    })),
  );
  const [minThroughputPerDay, setMinThroughputPerDay] = useState(0);
  const [maxWq, setMaxWq] = useState(0);
  const [maxUtil, setMaxUtil] = useState(0);
  const [maxInvestment, setMaxInvestment] = useState(0);
  const [replications, setReplications] = useState(5);
  const [confirmTop, setConfirmTop] = useState(4);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const combos = variables.reduce((a, v) => a * Math.max(1, v.maxServers - v.minServers + 1), 1);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    await new Promise((r) => setTimeout(r, 16));
    try {
      const res = optimize(model, {
        objective,
        variables,
        confirmTop,
        replications,
        constraints: {
          requireStable: true,
          ...(minThroughputPerDay > 0 ? { minThroughputPerDay } : {}),
          ...(maxWq > 0 ? { maxWqMinutes: maxWq } : {}),
          ...(maxUtil > 0 ? { maxUtilization: maxUtil } : {}),
          ...(maxInvestment > 0 ? { maxInvestment } : {}),
        },
      });
      setResult(res);
      notify(`Evaluated ${res.candidatesEvaluated} configurations.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setVar = (i: number, patch: Partial<DecisionVariable>) =>
    setVariables((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));

  return (
    <div className="stack">
      <Notice kind="info" title="How the search works">
        Every candidate is screened with the closed-form network model, which is fast enough for
        thousands of configurations. The best {confirmTop} are then confirmed with full replication
        studies, and only those simulated numbers are reported — because the analytical screen
        cannot see machine breakdowns or arrival variability.
      </Notice>

      <Card title="Objective and constraints">
        <div className="grid cols-3">
          <SelectField
            label="Objective"
            value={objective}
            options={OBJECTIVES}
            onChange={(v) => setObjective(v)}
          />
          <NumberField
            label="Replications per confirmation"
            unit="runs"
            value={replications}
            min={1}
            max={50}
            step={1}
            integer
            onChange={setReplications}
          />
          <NumberField
            label="Candidates to confirm"
            unit="configurations"
            value={confirmTop}
            min={1}
            max={12}
            step={1}
            integer
            onChange={setConfirmTop}
          />
        </div>

        <h3 style={{ fontSize: 12, marginTop: 14 }}>Constraints — leave at 0 to ignore</h3>
        <div className="grid cols-4">
          <NumberField
            label="Minimum throughput"
            unit="vehicles/day"
            value={minThroughputPerDay}
            min={0}
            onChange={setMinThroughputPerDay}
          />
          <NumberField label="Maximum Wq" unit="minutes" value={maxWq} min={0} onChange={setMaxWq} />
          <NumberField
            label="Maximum utilisation"
            unit="fraction 0–1"
            value={maxUtil}
            min={0}
            max={1}
            step={0.01}
            onChange={setMaxUtil}
          />
          <NumberField
            label="Capital budget"
            unit={currency.code}
            value={maxInvestment}
            min={0}
            onChange={setMaxInvestment}
          />
        </div>
      </Card>

      <Card
        title="Decision variables"
        hint="Which stations may change, and what a server costs there."
        actions={
          <button
            className="btn sm"
            onClick={() => {
              const used = new Set(variables.map((v) => v.stationId));
              const next = model.stations.find((s) => !used.has(s.id));
              if (!next) return;
              setVariables((vs) => [
                ...vs,
                {
                  stationId: next.id,
                  minServers: next.servers,
                  maxServers: next.servers + 2,
                  capitalCostPerServer: next.machine?.purchasePrice.value ?? 250_000,
                  annualOperatingCostPerServer: Math.round(
                    (next.machine?.purchasePrice.value ?? 250_000) * 0.075,
                  ),
                },
              ]);
            }}
          >
            Add station
          </button>
        }
      >
        <DataTable
          rows={variables.map((v, i) => ({ v, i }))}
          rowKey={(r) => r.v.stationId}
          columns={[
            {
              key: 's',
              header: 'Station',
              align: 'left',
              render: (r) => model.stations.find((s) => s.id === r.v.stationId)?.name ?? r.v.stationId,
            },
            {
              key: 'cur',
              header: 'Current',
              render: (r) => model.stations.find((s) => s.id === r.v.stationId)?.servers ?? 0,
            },
            {
              key: 'min',
              header: 'Min servers',
              render: (r) => (
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={r.v.minServers}
                  style={{ width: 72 }}
                  onChange={(e) => setVar(r.i, { minServers: Math.max(1, Number(e.target.value) || 1) })}
                />
              ),
            },
            {
              key: 'max',
              header: 'Max servers',
              render: (r) => (
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={r.v.maxServers}
                  style={{ width: 72 }}
                  onChange={(e) => setVar(r.i, { maxServers: Math.max(1, Number(e.target.value) || 1) })}
                />
              ),
            },
            {
              key: 'cap',
              header: `Capital per server (${currency.code})`,
              render: (r) => (
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={r.v.capitalCostPerServer}
                  style={{ width: 118 }}
                  onChange={(e) => setVar(r.i, { capitalCostPerServer: Math.max(0, Number(e.target.value) || 0) })}
                />
              ),
            },
            {
              key: 'opex',
              header: `Opex per server (${currency.code}/yr)`,
              render: (r) => (
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={r.v.annualOperatingCostPerServer}
                  style={{ width: 118 }}
                  onChange={(e) =>
                    setVar(r.i, { annualOperatingCostPerServer: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              ),
            },
            {
              key: 'x',
              header: '',
              align: 'left',
              render: (r) => (
                <button
                  className="btn sm danger"
                  onClick={() => setVariables((vs) => vs.filter((_, i) => i !== r.i))}
                >
                  Remove
                </button>
              ),
            },
          ]}
          caption={`${combos} configurations in the search space. ${confirmTop} will be confirmed by simulation.`}
        />

        <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
          <button className="btn primary" disabled={busy || variables.length === 0} onClick={() => void run()}>
            {busy ? 'Optimising…' : 'Run optimisation'}
          </button>
          {combos > 5000 ? (
            <span className="small" style={{ color: 'var(--status-warning)' }}>
              {combos} candidates — the analytical screen is fast but this will take a moment.
            </span>
          ) : null}
        </div>
        {error ? (
          <Notice kind="error" title="Optimisation failed">
            {error}
          </Notice>
        ) : null}
      </Card>

      {result ? <OptimizationResultView result={result} /> : null}
    </div>
  );
}

function OptimizationResultView({ result }: { result: OptimizationResult }) {
  const { model, setModel, notify } = useStore();
  const currency = model.cost.currency;
  const best = result.best;

  return (
    <div className="stack">
      <Card title="Recommendation">
        {!best ? (
          <Notice kind="error" title="No feasible configuration">
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {result.rationale.map((r, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {r}
                </li>
              ))}
            </ul>
          </Notice>
        ) : (
          <>
            <div className="grid cols-4">
              <Kpi
                label="Throughput"
                value={num(best.confirmed?.throughputPerDay, 1)}
                unit="veh/day"
                basis="simulated"
                small
              />
              <Kpi
                label="Cost per vehicle"
                value={money(best.confirmed?.costPerVehicle ?? 0, currency, 2)}
                basis="simulated"
                small
              />
              <Kpi
                label="Capital"
                value={money(best.initialInvestment, currency, 0)}
                basis="assumption"
                small
                sub={`+${best.totalAddedServers} server(s)`}
              />
              <Kpi
                label="Payback"
                value={
                  best.confirmed?.paybackAchieved
                    ? `${num(best.confirmed.paybackYears, 2)} yr`
                    : best.initialInvestment === 0
                      ? 'no capital'
                      : 'NOT ACHIEVED'
                }
                basis="simulated"
                small
                status={
                  best.initialInvestment === 0
                    ? 'neutral'
                    : best.confirmed?.paybackAchieved
                      ? 'good'
                      : 'critical'
                }
              />
            </div>

            <ul style={{ margin: '12px 0 0', paddingLeft: 18 }}>
              {result.rationale.map((r, i) => (
                <li key={i} style={{ marginBottom: 5 }}>
                  {r}
                </li>
              ))}
            </ul>

            <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
              <button
                className="btn primary"
                onClick={() => {
                  setModel((m) => ({
                    ...m,
                    stations: m.stations.map((s) =>
                      best.configuration[s.id] !== undefined
                        ? { ...s, servers: best.configuration[s.id] as number }
                        : s,
                    ),
                    investment: {
                      ...m.investment,
                      initialInvestment: {
                        ...m.investment.initialInvestment,
                        value: best.initialInvestment,
                        provenance: 'USER_INPUT',
                      },
                      additionalAnnualOperatingCost: {
                        ...m.investment.additionalAnnualOperatingCost,
                        value: best.additionalAnnualOperatingCost,
                        provenance: 'USER_INPUT',
                      },
                    },
                  }));
                  notify('Recommended configuration applied to the model.');
                }}
              >
                Apply this configuration
              </button>
              <span className="small muted">
                Applying it changes the model; re-run the simulation to confirm.
              </span>
            </div>
          </>
        )}
      </Card>

      {result.warnings.length > 0 ? (
        <Notice kind="warn" title="Warnings">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {result.warnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {result.ranked.length > 0 ? (
        <Card
          title="Confirmed candidates"
          hint="These figures come from full replication studies, not the analytical screen."
        >
          <DataTable
            rows={result.ranked.map((c, i) => ({ c, rank: i + 1 }))}
            rowKey={(r) => JSON.stringify(r.c.configuration)}
            emphasiseRow={(r) => r.rank === 1}
            columns={[
              { key: 'r', header: 'Rank', render: (r) => r.rank },
              {
                key: 'cfg',
                header: 'Configuration',
                align: 'left',
                render: (r) =>
                  Object.entries(r.c.configuration)
                    .map(
                      ([k, v]) =>
                        `${model.stations.find((s) => s.id === k)?.name ?? k} = ${v}${
                          (r.c.delta[k] ?? 0) !== 0 ? ` (${r.c.delta[k]! > 0 ? '+' : ''}${r.c.delta[k]})` : ''
                        }`,
                    )
                    .join(', '),
              },
              {
                key: 'cap',
                header: `Capital (${currency.code})`,
                render: (r) => money(r.c.initialInvestment, currency, 0),
                sortValue: (r) => r.c.initialInvestment,
              },
              {
                key: 'thr',
                header: 'Throughput (veh/day)',
                render: (r) => num(r.c.confirmed?.throughputPerDay, 2),
                sortValue: (r) => r.c.confirmed?.throughputPerDay ?? 0,
              },
              {
                key: 'cpv',
                header: 'Cost/vehicle',
                render: (r) => money(r.c.confirmed?.costPerVehicle ?? 0, currency, 2),
                sortValue: (r) => r.c.confirmed?.costPerVehicle ?? 0,
              },
              {
                key: 'wq',
                header: 'Wq (min)',
                render: (r) => num(r.c.confirmed?.WqMinutes, 2),
                sortValue: (r) => r.c.confirmed?.WqMinutes ?? 0,
              },
              {
                key: 'prof',
                header: `Profit/yr (${currency.code})`,
                render: (r) => money(r.c.confirmed?.profitPerYear ?? 0, currency, 0),
                sortValue: (r) => r.c.confirmed?.profitPerYear ?? 0,
              },
              {
                key: 'roi',
                header: 'ROI',
                render: (r) =>
                  r.c.confirmed?.roiPercent === null || r.c.confirmed?.roiPercent === undefined ? (
                    <span className="muted" title="No capital committed, so ROI is undefined.">
                      n/a
                    </span>
                  ) : (
                    `${num(r.c.confirmed.roiPercent, 1)}%`
                  ),
                sortValue: (r) => r.c.confirmed?.roiPercent ?? -Infinity,
              },
              {
                key: 'pb',
                header: 'Payback',
                render: (r) =>
                  r.c.confirmed?.paybackAchieved ? (
                    `${num(r.c.confirmed.paybackYears, 2)} yr`
                  ) : r.c.initialInvestment === 0 ? (
                    <span className="muted">no capital</span>
                  ) : (
                    <span className="num-neg">not achieved</span>
                  ),
              },
              {
                key: 'u',
                header: 'Peak ρ',
                render: (r) => pct(r.c.maxUtilization),
                sortValue: (r) => r.c.maxUtilization,
              },
            ]}
            caption={`${result.candidatesEvaluated} configurations screened, ${result.feasibleCount} feasible.`}
          />
        </Card>
      ) : null}
    </div>
  );
}
