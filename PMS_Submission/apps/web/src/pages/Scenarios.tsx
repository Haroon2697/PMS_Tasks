/**
 * Scenario manager — requirements 35, 67, 68.
 *
 * A scenario is a named set of EDITS, not a copy of the model, so changing a
 * shared parameter (an electricity price, a wage) propagates to every scenario
 * and a comparison never silently contrasts two models that differ in ways
 * nobody intended.
 *
 * Every comparison is produced by actually re-running both configurations. The
 * significance column matters as much as the difference column: a 2% throughput
 * gain that sits inside the confidence interval is not evidence of anything,
 * and the table says so rather than leaving the reader to assume.
 */

import { useState } from 'react';
import {
  compareScenarios,
  evaluateScenario,
  type Scenario,
  type ScenarioComparison,
  type ScenarioEdit,
} from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice, NumberField, SelectField } from '../components/primitives';
import { GroupedBars } from '../components/charts';
import { money, num, pct, signed } from '../lib/format';

interface LocalScenario extends Scenario {
  isBaseline?: boolean;
}

const BASELINE: LocalScenario = {
  id: 'baseline',
  name: 'Baseline — current factory',
  description: 'The configuration exactly as it stands, with no changes.',
  edits: [],
  initialInvestment: 0,
  additionalAnnualOperatingCost: 0,
  isBaseline: true,
};

export function ScenariosPage() {
  const { model, online, scenarios, saveScenario, removeScenario, notify } = useStore();
  const currency = model.cost.currency;

  const [local, setLocal] = useState<LocalScenario[]>([]);
  const [draft, setDraft] = useState<LocalScenario | null>(null);
  const [comparison, setComparison] = useState<ScenarioComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [replications, setReplications] = useState(Math.max(5, model.simulation.replications));
  const [error, setError] = useState<string | null>(null);

  const all: LocalScenario[] = [
    BASELINE,
    ...scenarios.filter((s) => !s.isBaseline),
    ...local,
  ];
  const [leftId, setLeftId] = useState('baseline');
  const [rightId, setRightId] = useState<string>('');

  const runComparison = async () => {
    const left = all.find((s) => s.id === leftId);
    const right = all.find((s) => s.id === rightId);
    if (!left || !right) return;
    setBusy(true);
    setError(null);
    await new Promise((r) => setTimeout(r, 16));
    try {
      const a = evaluateScenario(model, left, { replications });
      const b = evaluateScenario(model, right, { replications });
      setComparison(compareScenarios(a, b));
      notify('Comparison complete.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card
        title="Scenarios"
        hint="Each scenario stores only what it changes, so shared parameters stay shared."
        actions={
          <button
            className="btn"
            onClick={() =>
              setDraft({
                id: `scn-${Date.now().toString(36)}`,
                name: 'New scenario',
                edits: [],
                initialInvestment: 0,
                additionalAnnualOperatingCost: 0,
              })
            }
          >
            New scenario
          </button>
        }
      >
        <DataTable
          rows={all}
          rowKey={(s) => s.id}
          columns={[
            { key: 'n', header: 'Scenario', align: 'left', render: (s) => s.name },
            {
              key: 'e',
              header: 'Changes',
              align: 'left',
              render: (s) =>
                s.edits.length === 0 ? (
                  <span className="muted">none — the baseline</span>
                ) : (
                  <span>{s.edits.map((e) => describeEditLocal(e, model)).join('; ')}</span>
                ),
            },
            {
              key: 'i',
              header: `Capital (${currency.code})`,
              render: (s) => money(s.initialInvestment, currency, 0),
              sortValue: (s) => s.initialInvestment,
            },
            {
              key: 'o',
              header: `Added opex (${currency.code}/yr)`,
              render: (s) => money(s.additionalAnnualOperatingCost, currency, 0),
            },
            {
              key: 'a',
              header: 'Actions',
              align: 'left',
              render: (s) =>
                s.isBaseline ? (
                  <span className="muted small">built in</span>
                ) : (
                  <span className="row">
                    <button className="btn sm" onClick={() => setDraft(s)}>
                      Edit
                    </button>
                    {online && 'systemId' in s ? (
                      <button className="btn sm danger" onClick={() => void removeScenario(s.id)}>
                        Delete
                      </button>
                    ) : (
                      <button
                        className="btn sm danger"
                        onClick={() => setLocal((l) => l.filter((x) => x.id !== s.id))}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                ),
            },
          ]}
        />
        {!online ? (
          <Notice kind="info">
            The API server is not reachable, so scenarios exist only for this session. Start it with
            <code className="mono"> npm run dev:api </code> to save them.
          </Notice>
        ) : null}
      </Card>

      <Card title="Compare two scenarios" hint="Both are re-simulated; nothing is extrapolated.">
        <div className="grid cols-4">
          <SelectField
            label="Baseline"
            value={leftId}
            options={all.map((s) => ({ value: s.id, label: s.name }))}
            onChange={setLeftId}
          />
          <SelectField
            label="Proposed"
            value={rightId}
            options={[{ value: '', label: 'Select a scenario…' }, ...all.filter((s) => s.id !== leftId).map((s) => ({ value: s.id, label: s.name }))]}
            onChange={setRightId}
          />
          <NumberField
            label="Replications each"
            unit="runs"
            value={replications}
            min={1}
            max={100}
            step={1}
            integer
            onChange={setReplications}
            hint="More replications, tighter intervals."
          />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={busy || !rightId} onClick={() => void runComparison()}>
              {busy ? 'Running…' : 'Run comparison'}
            </button>
          </div>
        </div>
        {error ? (
          <Notice kind="error" title="Comparison failed">
            {error}
          </Notice>
        ) : null}
      </Card>

      {comparison ? <ComparisonView comparison={comparison} /> : null}

      {draft ? (
        <ScenarioEditor
          draft={draft}
          onCancel={() => setDraft(null)}
          onSave={(s) => {
            if (online) void saveScenario(s);
            else setLocal((l) => [...l.filter((x) => x.id !== s.id), s]);
            setDraft(null);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ComparisonView({ comparison }: { comparison: ScenarioComparison }) {
  const { model } = useStore();
  const currency = model.cost.currency;
  const a = comparison.appraisal;

  const chartRows = comparison.rows
    .filter((r) => ['throughput', 'WqMinutes', 'WMinutes', 'L', 'costPerVehicle'].includes(r.metric))
    .map((r) => ({ key: r.metric, label: `${r.label} (${r.unit})`, a: r.baseline, b: r.scenario }));

  return (
    <div className="stack">
      <Card
        title={`${comparison.baseline.scenario.name} vs ${comparison.proposed.scenario.name}`}
        hint={comparison.proposed.edits.join('; ') || 'No configuration changes.'}
      >
        <div className="grid cols-4">
          <Kpi
            label="Capital required"
            value={money(a.initialInvestment, currency, 0)}
            basis="assumption"
            small
          />
          <Kpi
            label="Annual net benefit"
            value={money(a.annualNetBenefit, currency, 0)}
            basis="simulated"
            small
            status={a.annualNetBenefit > 0 ? 'good' : 'critical'}
          />
          <Kpi
            label="ROI"
            value={a.roiPercent === null ? 'not defined' : `${num(a.roiPercent, 1)}%`}
            basis="simulated"
            small
            sub={a.roiPercent === null ? 'no capital committed' : 'per year'}
          />
          <Kpi
            label="Payback"
            value={a.payback.achieved ? `${num(a.payback.years, 2)} yr` : 'NOT ACHIEVED'}
            basis="simulated"
            small
            sub={a.payback.achieved ? `${num(a.payback.months, 0)} months` : 'never recovers its cost'}
            status={a.payback.achieved ? 'good' : 'critical'}
          />
        </div>

        <Notice kind={a.payback.achieved || a.initialInvestment === 0 ? 'info' : 'warn'} title="Recommendation">
          {comparison.recommendation}
        </Notice>

        {comparison.warnings.map((w, i) => (
          <Notice key={i} kind="warn">
            {w}
          </Notice>
        ))}
      </Card>

      <Card title="Key metrics" hint="Two series, direct-labelled with the proposed value.">
        <GroupedBars
          data={chartRows}
          seriesA={comparison.baseline.scenario.name}
          seriesB={comparison.proposed.scenario.name}
          unit="metric value"
          formatValue={(v) => num(v, 2)}
        />
      </Card>

      <Card title="Full comparison" hint="Significance is a Welch t-test on the replication means.">
        <DataTable
          rows={comparison.rows}
          rowKey={(r) => r.metric}
          columns={[
            { key: 'l', header: 'Metric', align: 'left', render: (r) => r.label },
            { key: 'u', header: 'Unit', align: 'left', render: (r) => r.unit },
            { key: 'b', header: 'Baseline', render: (r) => num(r.baseline, 3) },
            { key: 's', header: 'Scenario', render: (r) => num(r.scenario, 3) },
            {
              key: 'd',
              header: 'Change',
              render: (r) => {
                const better = r.higherIsBetter ? r.difference > 0 : r.difference < 0;
                if (Math.abs(r.difference) < 1e-9) return <span className="muted">no change</span>;
                return <span className={better ? 'num-pos' : 'num-neg'}>{signed(r.difference, 3)}</span>;
              },
              sortValue: (r) => r.difference,
            },
            {
              key: 'p',
              header: '% change',
              render: (r) => (Math.abs(r.percentChange) < 1e-9 ? '—' : `${signed(r.percentChange, 2)}%`),
            },
            {
              key: 'sig',
              header: 'Significant?',
              align: 'left',
              render: (r) =>
                r.significant ? (
                  <span className="status good">Yes</span>
                ) : (
                  <span className="status neutral" title={r.note}>
                    Within noise
                  </span>
                ),
            },
            {
              key: 'dir',
              header: 'Better when',
              align: 'left',
              render: (r) => (r.higherIsBetter ? 'higher' : 'lower'),
            },
          ]}
        />
      </Card>

      <Card title="How the appraisal was computed" hint="Requirement 31: the investment is stated, never implied.">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {a.workings.map((w, i) => (
            <li key={i} style={{ marginBottom: 5 }}>
              {w}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Constraint">
        <DataTable
          rows={[
            {
              k: 'Bottleneck (baseline)',
              v: comparison.baseline.analytical.bottleneckStationName ?? '—',
            },
            {
              k: 'Bottleneck (scenario)',
              v: comparison.proposed.analytical.bottleneckStationName ?? '—',
            },
            {
              k: 'Factory capacity (baseline)',
              v: `${num(comparison.baseline.analytical.factoryCapacityPerHour, 3)} veh/h`,
            },
            {
              k: 'Factory capacity (scenario)',
              v: `${num(comparison.proposed.analytical.factoryCapacityPerHour, 3)} veh/h`,
            },
          ]}
          rowKey={(r) => r.k}
          columns={[
            { key: 'k', header: 'Property', align: 'left', render: (r) => r.k },
            { key: 'v', header: 'Value', align: 'left', render: (r) => r.v },
          ]}
          caption={
            comparison.bottleneckMoved
              ? 'The constraint moved. Further investment at the old bottleneck will now buy much less.'
              : 'The constraint did not move, so the ceiling on output is unchanged.'
          }
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ScenarioEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: LocalScenario;
  onSave: (s: LocalScenario) => void;
  onCancel: () => void;
}) {
  const { model } = useStore();
  const currency = model.cost.currency;
  const [s, setS] = useState<LocalScenario>(draft);

  const addEdit = (edit: ScenarioEdit) => setS((x) => ({ ...x, edits: [...x.edits, edit] }));
  const removeEdit = (i: number) =>
    setS((x) => ({ ...x, edits: x.edits.filter((_, idx) => idx !== i) }));

  const [kind, setKind] = useState<
    | 'servers'
    | 'serviceMean'
    | 'workerCount'
    | 'routingProbability'
    | 'demandScale'
    | 'sellingPrice'
    | 'electricityPrice'
    | 'operatingHours'
    | 'operatingDays'
  >('servers');
  const [stationId, setStationId] = useState(model.stations[0]?.id ?? '');
  const [value, setValue] = useState(1);
  const [toId, setToId] = useState('');
  const [crewId, setCrewId] = useState('');

  const station = model.stations.find((x) => x.id === stationId);
  const needsStation =
    kind === 'servers' ||
    kind === 'serviceMean' ||
    kind === 'routingProbability' ||
    kind === 'workerCount';

  return (
    <Card
      title="Scenario editor"
      actions={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(s)}>
            Save scenario
          </button>
        </>
      }
    >
      <div className="grid cols-3">
        <div className="field">
          <label>Name</label>
          <input type="text" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        </div>
        <NumberField
          label="Initial investment"
          unit={currency.code}
          value={s.initialInvestment}
          min={0}
          onChange={(v) => setS({ ...s, initialInvestment: v })}
          hint="Required for ROI and payback to be defined."
        />
        <NumberField
          label="Additional annual operating cost"
          unit={`${currency.code}/year`}
          value={s.additionalAnnualOperatingCost}
          min={0}
          onChange={(v) => setS({ ...s, additionalAnnualOperatingCost: v })}
        />
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label>Description</label>
        <input
          type="text"
          value={s.description ?? ''}
          onChange={(e) => setS({ ...s, description: e.target.value })}
        />
      </div>

      <h3 style={{ marginTop: 14, fontSize: 12 }}>Changes</h3>
      {s.edits.length === 0 ? (
        <EmptyState>No changes yet. This scenario is identical to the baseline.</EmptyState>
      ) : (
        <DataTable
          rows={s.edits.map((e, i) => ({ e, i }))}
          rowKey={(r) => String(r.i)}
          columns={[
            { key: 'd', header: 'Change', align: 'left', render: (r) => describeEditLocal(r.e, model) },
            {
              key: 'x',
              header: '',
              align: 'left',
              render: (r) => (
                <button className="btn sm danger" onClick={() => removeEdit(r.i)}>
                  Remove
                </button>
              ),
            },
          ]}
        />
      )}

      <div className="grid cols-4" style={{ marginTop: 10, alignItems: 'end' }}>
        <SelectField
          label="Change type"
          value={kind}
          options={[
            { value: 'servers', label: 'Machines / servers' },
            { value: 'serviceMean', label: 'Mean service time (capacity)' },
            { value: 'workerCount', label: 'Worker headcount' },
            { value: 'routingProbability', label: 'Routing probability' },
            { value: 'demandScale', label: 'Scale demand' },
            { value: 'operatingHours', label: 'Production hours per day' },
            { value: 'operatingDays', label: 'Operating days per year' },
            { value: 'sellingPrice', label: 'Selling price' },
            { value: 'electricityPrice', label: 'Electricity price' },
          ]}
          onChange={(v) => setKind(v)}
        />
        {needsStation ? (
          <SelectField
            label="Station"
            value={stationId}
            options={model.stations.map((x) => ({ value: x.id, label: x.name }))}
            onChange={(v) => {
              setStationId(v);
              setCrewId('');
            }}
          />
        ) : (
          <div />
        )}
        {kind === 'workerCount' ? (
          <SelectField
            label="Crew"
            value={crewId || (station?.workers[0]?.id ?? '')}
            options={(station?.workers ?? []).map((w) => ({
              value: w.id,
              label: `${w.role} (${w.count} now)`,
            }))}
            onChange={(v) => setCrewId(v)}
          />
        ) : null}
        {kind === 'routingProbability' ? (
          <SelectField
            label="Destination"
            value={toId}
            options={[
              { value: '', label: 'Select…' },
              ...(station?.routing ?? []).map((e) => ({
                value: e.to,
                label:
                  e.to === '__FINISHED__'
                    ? 'Finished'
                    : e.to === '__SCRAP__'
                      ? 'Scrap'
                      : (model.stations.find((x) => x.id === e.to)?.name ?? e.to),
              })),
            ]}
            onChange={(v) => setToId(v)}
          />
        ) : (
          <NumberField
            label="New value"
            unit={
              kind === 'servers'
                ? 'servers'
                : kind === 'workerCount'
                  ? 'workers'
                  : kind === 'serviceMean'
                    ? 'minutes'
                    : kind === 'demandScale'
                      ? 'multiplier'
                      : kind === 'operatingHours'
                        ? 'hours/day'
                        : kind === 'operatingDays'
                          ? 'days/year'
                          : kind === 'sellingPrice'
                            ? currency.code
                            : `${currency.code}/kWh`
            }
            value={value}
            min={0}
            step={
              kind === 'servers' || kind === 'workerCount' || kind === 'operatingDays' ? 1 : 'any'
            }
            integer={
              kind === 'servers' || kind === 'workerCount' || kind === 'operatingDays'
            }
            onChange={setValue}
          />
        )}
        {kind === 'routingProbability' ? (
          <NumberField
            label="Probability"
            unit="0–1"
            value={value}
            min={0}
            max={1}
            step={0.01}
            onChange={setValue}
          />
        ) : null}
        <button
          className="btn"
          onClick={() => {
            if (kind === 'servers')
              addEdit({ kind: 'servers', stationId, value: Math.max(1, Math.round(value)) });
            else if (kind === 'serviceMean') addEdit({ kind: 'serviceMean', stationId, value });
            else if (kind === 'workerCount') {
              const cid = crewId || station?.workers[0]?.id;
              if (cid) {
                addEdit({
                  kind: 'workerCount',
                  stationId,
                  crewId: cid,
                  value: Math.max(0, Math.round(value)),
                });
              }
            } else if (kind === 'routingProbability' && toId)
              addEdit({ kind: 'routingProbability', stationId, to: toId, value });
            else if (kind === 'demandScale') addEdit({ kind: 'demandScale', value });
            else if (kind === 'operatingHours') addEdit({ kind: 'operatingHours', value });
            else if (kind === 'operatingDays')
              addEdit({ kind: 'operatingDays', value: Math.round(value) });
            else if (kind === 'sellingPrice')
              addEdit({ kind: 'sellingPrice', modelId: model.vehicleModels[0]?.id ?? '', value });
            else if (kind === 'electricityPrice') addEdit({ kind: 'electricityPrice', value });
          }}
        >
          Add change
        </button>
      </div>
    </Card>
  );
}

function describeEditLocal(e: ScenarioEdit, model: { stations: { id: string; name: string }[] }): string {
  const name = (id: string) => model.stations.find((s) => s.id === id)?.name ?? id;
  switch (e.kind) {
    case 'servers':
      return `${name(e.stationId)}: ${e.value} servers`;
    case 'serviceMean':
      return `${name(e.stationId)}: mean service ${e.value} min`;
    case 'serviceRate':
      return `${name(e.stationId)}: μ = ${e.value}/h`;
    case 'routingProbability':
      return `${name(e.stationId)} → ${e.to}: p = ${pct(e.value, 1)}`;
    case 'demandScale':
      return `Demand × ${e.value}`;
    case 'demandFlat':
      return `Demand flat at ${e.value}/h`;
    case 'sellingPrice':
      return `Selling price ${e.value}`;
    case 'electricityPrice':
      return `Electricity ${e.value}/kWh`;
    case 'scrapProbability':
      return `${name(e.stationId)}: scrap ${pct(e.value, 2)}`;
    case 'workerCount':
      return `${name(e.stationId)} / ${e.crewId}: ${e.value} workers`;
    case 'wage':
      return `${name(e.stationId)} / ${e.crewId}: wage ${e.value}/h`;
    case 'reliability':
      return `${name(e.stationId)}: breakdowns ${e.enabled ? 'on' : 'off'}`;
    case 'mtbf':
      return `${name(e.stationId)}: MTBF ${e.value} h`;
    case 'mttr':
      return `${name(e.stationId)}: MTTR ${e.value} h`;
    case 'machinePower':
      return `${name(e.stationId)}: ${e.value} kW`;
    case 'materialCost':
      return `${e.componentId}: unit cost ${e.value}`;
    case 'overheadRate':
      return `Overhead ${e.value}/h`;
    case 'operatingHours':
      return `Production hours/day -> ${e.value}`;
    case 'operatingDays':
      return `Operating days/year -> ${e.value}`;
  }
}
