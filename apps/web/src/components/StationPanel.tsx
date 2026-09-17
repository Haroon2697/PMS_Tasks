/**
 * Station configuration panel — requirements 37 and 49.
 *
 * Opens when a node is clicked. Every parameter that affects the station is
 * editable here, and each edit writes straight into the model, so the Kendall
 * notation, utilisation and queueing figures at the top of the panel update as
 * you type — there is no "apply" step that could leave the displayed maths
 * describing a different configuration than the one on screen.
 *
 * Edits mark their parameter USER_INPUT so the provenance register records
 * which figures you changed and which came with the model.
 */

import {
  describeDistribution,
  distMean,
  kendallSymbol,
  type Distribution,
  type DistributionKind,
  type QueueDiscipline,
  type Station,
  type StationAnalytic,
  type SystemModel,
  type WorkerRole,
} from '@vmq/engine';
import { num, pct, utilisationStatus } from '../lib/format';
import { Card, DataTable, NumberField, SelectField, SidePanel, Notice } from './primitives';
import { Meter } from './charts';

const DISTRIBUTIONS: { value: DistributionKind; label: string }[] = [
  { value: 'exponential', label: 'Exponential — Kendall M' },
  { value: 'constant', label: 'Deterministic — Kendall D' },
  { value: 'erlang', label: 'Erlang-k — Kendall E_k' },
  { value: 'lognormal', label: 'Lognormal — Kendall G' },
  { value: 'uniform', label: 'Uniform — Kendall G' },
  { value: 'triangular', label: 'Triangular — Kendall G' },
  { value: 'gamma', label: 'Gamma — Kendall E_k or G' },
  { value: 'weibull', label: 'Weibull — Kendall G' },
];

const DISCIPLINES: { value: QueueDiscipline; label: string }[] = [
  { value: 'FIFO', label: 'FIFO — first in, first out' },
  { value: 'LIFO', label: 'LIFO — last in, first out' },
  { value: 'SPT', label: 'SPT — shortest processing time first' },
  { value: 'PRIORITY', label: 'Priority — reworked vehicles first' },
];

const ROLES: WorkerRole[] = ['Operator', 'Technician', 'Inspector', 'Supervisor', 'Maintenance'];

/** Rebuild a distribution of a new family, preserving the current mean. */
function changeFamily(current: Distribution, kind: DistributionKind): Distribution {
  const mean = distMean(current) || 10;
  switch (kind) {
    case 'normal':
      return { kind: 'normal', mean, sd: mean * 0.3 };
    case 'exponential':
      return { kind: 'exponential', mean };
    case 'constant':
      return { kind: 'constant', value: mean };
    case 'erlang':
      return { kind: 'erlang', k: 2, mean };
    case 'lognormal':
      return { kind: 'lognormal', mean, sd: mean * 0.5 };
    case 'uniform':
      return { kind: 'uniform', min: mean * 0.6, max: mean * 1.4 };
    case 'triangular':
      return { kind: 'triangular', min: mean * 0.6, mode: mean, max: mean * 1.4 };
    case 'gamma':
      return { kind: 'gamma', shape: 2, scale: mean / 2 };
    case 'weibull':
      return { kind: 'weibull', shape: 2, scale: mean / 0.8862269254527579 };
  }
}

export function StationPanel({
  model,
  stationId,
  analytic,
  onClose,
  onChange,
}: {
  model: SystemModel;
  stationId: string;
  analytic: StationAnalytic | undefined;
  onClose: () => void;
  onChange: (next: SystemModel) => void;
}) {
  const station = model.stations.find((s) => s.id === stationId);
  if (!station) return null;

  /** Apply a mutation to this station, producing a new model. */
  const update = (fn: (s: Station) => void) => {
    const next: SystemModel = {
      ...model,
      stations: model.stations.map((s) => {
        if (s.id !== stationId) return s;
        const copy: Station = JSON.parse(JSON.stringify(s));
        fn(copy);
        return copy;
      }),
    };
    onChange(next);
  };

  const mean = distMean(station.service);
  const mu = mean > 0 ? 60 / mean : 0;
  const rho = analytic?.rho ?? 0;
  const routingSum = station.routing.reduce((a, e) => a + e.probability, 0);

  return (
    <SidePanel title={station.name} onClose={onClose}>
      <div className="stack">
        {/* ---- live derived summary ---- */}
        <Card
          title="Current state"
          hint="Analytical, recomputed as you edit. Simulated figures come from a run."
        >
          <table className="data">
            <tbody>
              <tr>
                <td className="left">Kendall notation</td>
                <td>
                  <strong>{analytic?.kendall ?? `M/${kendallSymbol(station.service)}/${station.servers}`}</strong>
                </td>
              </tr>
              <tr>
                <td className="left">Service time</td>
                <td>{describeDistribution(station.service)}</td>
              </tr>
              <tr>
                <td className="left">μ (per server)</td>
                <td>{num(mu, 3)} veh/h</td>
              </tr>
              <tr>
                <td className="left">λ (derived from routing)</td>
                <td>{num(analytic?.lambda, 3)} veh/h</td>
              </tr>
              <tr>
                <td className="left">Visits per vehicle</td>
                <td>{num(analytic?.visitRatio, 3)}</td>
              </tr>
              <tr>
                <td className="left">Capacity c·μ</td>
                <td>{num(analytic?.capacity, 3)} veh/h</td>
              </tr>
              <tr>
                <td className="left">Utilisation ρ</td>
                <td>
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Meter value={rho} status={utilisationStatus(rho)} />
                    {pct(rho)}
                  </span>
                </td>
              </tr>
              <tr>
                <td className="left">Lq / Wq</td>
                <td>
                  {num(analytic?.Lq, 3)} veh · {num(analytic?.WqMinutes, 2)} min
                </td>
              </tr>
            </tbody>
          </table>
          {analytic && !analytic.exact ? (
            <div className="formula">{analytic.method}</div>
          ) : null}
        </Card>

        {/* ---- queue parameters ---- */}
        <Card title="Queue and service">
          <div className="grid cols-2">
            <NumberField
              label="Servers (c)"
              unit="parallel machines/bays"
              value={station.servers}
              min={1}
              step={1}
              integer
              onChange={(v) => update((s) => void (s.servers = v))}
              hint="Each server is backed by one machine."
            />
            <NumberField
              label="Mean service time"
              unit="minutes/vehicle"
              value={mean}
              min={0.01}
              onChange={(v) =>
                update((s) => {
                  s.service = scaleMean(s.service, v);
                })
              }
              hint={`μ = 60 / mean = ${num(mean > 0 ? 60 / mean : 0, 3)} veh/h/server`}
            />
            <SelectField
              label="Service distribution"
              value={station.service.kind}
              options={DISTRIBUTIONS}
              onChange={(v) => update((s) => void (s.service = changeFamily(s.service, v)))}
              hint="Changes the Kendall notation and which analytical model applies."
            />
            <SelectField
              label="Queue discipline"
              value={station.queueDiscipline}
              options={DISCIPLINES}
              onChange={(v) => update((s) => void (s.queueDiscipline = v))}
            />
            <NumberField
              label="Queue capacity"
              unit="vehicles; 0 = unbounded"
              value={station.queueCapacity ?? 0}
              min={0}
              step={1}
              integer
              onChange={(v) => update((s) => void (s.queueCapacity = v === 0 ? null : v))}
              hint={
                station.queueCapacity === null
                  ? 'Unbounded: no vehicle is ever turned away.'
                  : 'Arrivals beyond this are rejected rather than blocking upstream.'
              }
            />
            <NumberField
              label="Scrap probability"
              unit="fraction, 0–1"
              value={station.scrapProbability}
              min={0}
              max={1}
              step={0.001}
              onChange={(v) => update((s) => void (s.scrapProbability = v))}
              hint="Applied on completing service here, before routing."
            />
          </div>
          {station.service.kind === 'erlang' ? (
            <div style={{ marginTop: 8, maxWidth: 240 }}>
              <NumberField
                label="Erlang phases (k)"
                unit="phases"
                value={station.service.k}
                min={1}
                step={1}
                integer
                onChange={(v) =>
                  update((s) => {
                    if (s.service.kind === 'erlang') s.service.k = v;
                  })
                }
                hint="Higher k means less variable service. k=1 is exponential."
              />
            </div>
          ) : null}
          {station.service.kind === 'lognormal' ? (
            <div style={{ marginTop: 8, maxWidth: 240 }}>
              <NumberField
                label="Service time std. deviation"
                unit="minutes"
                value={station.service.sd}
                min={0.001}
                onChange={(v) =>
                  update((s) => {
                    if (s.service.kind === 'lognormal') s.service.sd = v;
                  })
                }
              />
            </div>
          ) : null}
        </Card>

        {/* ---- routing ---- */}
        <Card
          title="Routing"
          hint="Probabilities must sum to 1. Editing one re-normalises the others."
        >
          {Math.abs(routingSum - 1) > 1e-6 ? (
            <Notice kind="error" title="Routing probabilities do not sum to 1">
              They currently total {num(routingSum, 4)}. Downstream arrival rates will be wrong
              until this is corrected.
            </Notice>
          ) : null}
          <DataTable
            rows={station.routing}
            rowKey={(r) => r.to}
            columns={[
              {
                key: 'to',
                header: 'Destination',
                align: 'left',
                render: (r) =>
                  r.to === '__FINISHED__'
                    ? 'Finished vehicle'
                    : r.to === '__SCRAP__'
                      ? 'Scrapped'
                      : (model.stations.find((s) => s.id === r.to)?.name ?? r.to),
              },
              { key: 'label', header: 'Label', align: 'left', render: (r) => r.label ?? '—' },
              {
                key: 'p',
                header: 'Probability',
                render: (r) => (
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={r.probability}
                    style={{ width: 88 }}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isNaN(v) || v < 0 || v > 1) return;
                      update((s) => {
                        const arc = s.routing.find((x) => x.to === r.to);
                        if (!arc) return;
                        const others = s.routing.filter((x) => x.to !== r.to);
                        const otherTotal = others.reduce((a, x) => a + x.probability, 0);
                        arc.probability = v;
                        const remaining = 1 - v;
                        if (otherTotal > 0) {
                          for (const o of others) o.probability = (o.probability / otherTotal) * remaining;
                        } else if (others.length > 0) {
                          for (const o of others) o.probability = remaining / others.length;
                        }
                      });
                    }}
                  />
                ),
              },
            ]}
          />
        </Card>

        {/* ---- workers ---- */}
        <Card title="Workers" hint="Labour is charged on the basis set in Settings.">
          <DataTable
            rows={station.workers}
            rowKey={(w) => w.id}
            columns={[
              {
                key: 'role',
                header: 'Role',
                align: 'left',
                render: (w) => (
                  <select
                    value={w.role}
                    onChange={(e) =>
                      update((s) => {
                        const c = s.workers.find((x) => x.id === w.id);
                        if (c) c.role = e.target.value as WorkerRole;
                      })
                    }
                    style={{ width: 130 }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ),
              },
              {
                key: 'count',
                header: 'Headcount',
                render: (w) => (
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={w.count}
                    style={{ width: 72 }}
                    onChange={(e) =>
                      update((s) => {
                        const c = s.workers.find((x) => x.id === w.id);
                        if (c) c.count = Math.max(0, Math.round(Number(e.target.value) || 0));
                      })
                    }
                  />
                ),
              },
              {
                key: 'wage',
                header: 'Wage /h',
                render: (w) => (
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={w.hourlyWage.value}
                    style={{ width: 86 }}
                    onChange={(e) =>
                      update((s) => {
                        const c = s.workers.find((x) => x.id === w.id);
                        if (c) {
                          c.hourlyWage = {
                            ...c.hourlyWage,
                            value: Math.max(0, Number(e.target.value) || 0),
                            provenance: 'USER_INPUT',
                          };
                        }
                      })
                    }
                  />
                ),
              },
              {
                key: 'cost',
                header: 'Crew cost /h',
                render: (w) => num(w.count * w.hourlyWage.value, 2),
              },
            ]}
            caption={`Total wage bill: ${num(
              station.workers.reduce((a, w) => a + w.count * w.hourlyWage.value, 0),
              2,
            )} per hour`}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn sm"
              onClick={() =>
                update((s) =>
                  s.workers.push({
                    id: `crew-${Date.now().toString(36)}`,
                    role: 'Operator',
                    count: 1,
                    hourlyWage: { value: 25, unit: 'currency/hour', provenance: 'USER_INPUT' },
                    overtimeMultiplier: { value: 1.5, unit: 'multiplier', provenance: 'USER_INPUT' },
                    shiftHours: { value: 8, unit: 'hours/shift', provenance: 'USER_INPUT' },
                  }),
                )
              }
            >
              Add crew
            </button>
            {station.workers.length > 0 ? (
              <button
                className="btn sm danger"
                onClick={() => update((s) => void s.workers.pop())}
              >
                Remove last crew
              </button>
            ) : null}
          </div>
        </Card>

        {/* ---- machine ---- */}
        {station.machine ? (
          <Card title={`Machine — ${station.machine.name}`} hint="Costs are per machine.">
            <div className="grid cols-2">
              <NumberField
                label="Purchase price"
                unit="currency"
                value={station.machine.purchasePrice.value}
                min={0}
                provenance={station.machine.purchasePrice.provenance}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.purchasePrice = { ...s.machine.purchasePrice, value: v, provenance: 'USER_INPUT' };
                  })
                }
              />
              <NumberField
                label="Useful life"
                unit="years"
                value={station.machine.usefulLifeYears.value}
                min={0.1}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.usefulLifeYears = { ...s.machine.usefulLifeYears, value: v, provenance: 'USER_INPUT' };
                  })
                }
              />
              <NumberField
                label="Salvage value"
                unit="currency"
                value={station.machine.salvageValue.value}
                min={0}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.salvageValue = { ...s.machine.salvageValue, value: v, provenance: 'USER_INPUT' };
                  })
                }
              />
              <NumberField
                label="Annual operating hours"
                unit="hours/year"
                value={station.machine.annualOperatingHours.value}
                min={1}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.annualOperatingHours = { ...s.machine.annualOperatingHours, value: v, provenance: 'USER_INPUT' };
                  })
                }
                hint="Denominator of the hourly depreciation charge."
              />
              <NumberField
                label="Power while running"
                unit="kW"
                value={station.machine.powerKw.value}
                min={0}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.powerKw = { ...s.machine.powerKw, value: v, provenance: 'USER_INPUT' };
                  })
                }
              />
              <NumberField
                label="Power while idle"
                unit="kW"
                value={station.machine.idlePowerKw.value}
                min={0}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.idlePowerKw = { ...s.machine.idlePowerKw, value: v, provenance: 'USER_INPUT' };
                  })
                }
              />
              <NumberField
                label="Maintenance"
                unit="currency/operating hour"
                value={station.machine.maintenanceCostPerHour.value}
                min={0}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.maintenanceCostPerHour = { ...s.machine.maintenanceCostPerHour, value: v, provenance: 'USER_INPUT' };
                  })
                }
              />
              <NumberField
                label="Consumables"
                unit="currency/operating hour"
                value={station.machine.consumablesCostPerHour.value}
                min={0}
                onChange={(v) =>
                  update((s) => {
                    if (s.machine) s.machine.consumablesCostPerHour = { ...s.machine.consumablesCostPerHour, value: v, provenance: 'USER_INPUT' };
                  })
                }
              />
            </div>

            <div className="formula">
              Depreciation = (price − salvage) / (life × annual hours) ={' '}
              {num(
                (station.machine.purchasePrice.value - station.machine.salvageValue.value) /
                  Math.max(1e-9, station.machine.usefulLifeYears.value * station.machine.annualOperatingHours.value),
                2,
              )}{' '}
              per operating hour.
            </div>

            <details className="expander" open={!!station.machine.reliability?.enabled}>
              <summary>Reliability (breakdowns)</summary>
              <div style={{ marginTop: 8 }}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={!!station.machine.reliability?.enabled}
                    onChange={(e) =>
                      update((s) => {
                        if (!s.machine) return;
                        if (!s.machine.reliability) {
                          s.machine.reliability = {
                            enabled: e.target.checked,
                            mtbfHours: { value: 200, unit: 'operating hours', provenance: 'USER_INPUT' },
                            mttrHours: { value: 2, unit: 'hours', provenance: 'USER_INPUT' },
                            repairCostPerHour: { value: 150, unit: 'currency/hour', provenance: 'USER_INPUT' },
                            failureDist: 'exponential',
                            repairDist: 'exponential',
                          };
                        } else {
                          s.machine.reliability.enabled = e.target.checked;
                        }
                      })
                    }
                  />
                  Simulate machine breakdowns at this station
                </label>
                {station.machine.reliability ? (
                  <>
                    <div className="grid cols-3" style={{ marginTop: 8 }}>
                      <NumberField
                        label="MTBF"
                        unit="operating hours"
                        value={station.machine.reliability.mtbfHours.value}
                        min={0.1}
                        onChange={(v) =>
                          update((s) => {
                            const r = s.machine?.reliability;
                            if (r) r.mtbfHours = { ...r.mtbfHours, value: v, provenance: 'USER_INPUT' };
                          })
                        }
                      />
                      <NumberField
                        label="MTTR"
                        unit="hours"
                        value={station.machine.reliability.mttrHours.value}
                        min={0}
                        onChange={(v) =>
                          update((s) => {
                            const r = s.machine?.reliability;
                            if (r) r.mttrHours = { ...r.mttrHours, value: v, provenance: 'USER_INPUT' };
                          })
                        }
                      />
                      <NumberField
                        label="Repair cost"
                        unit="currency/hour"
                        value={station.machine.reliability.repairCostPerHour.value}
                        min={0}
                        onChange={(v) =>
                          update((s) => {
                            const r = s.machine?.reliability;
                            if (r) r.repairCostPerHour = { ...r.repairCostPerHour, value: v, provenance: 'USER_INPUT' };
                          })
                        }
                      />
                    </div>
                    <div className="formula">
                      Availability A = MTBF / (MTBF + MTTR) ={' '}
                      {pct(
                        station.machine.reliability.mtbfHours.value /
                          (station.machine.reliability.mtbfHours.value +
                            station.machine.reliability.mttrHours.value),
                        2,
                      )}
                      . The closed-form queueing models assume servers never fail, so with
                      breakdowns enabled the simulation will show longer queues than the
                      analytical figures above.
                    </div>
                  </>
                ) : null}
              </div>
            </details>
          </Card>
        ) : null}
      </div>
    </SidePanel>
  );
}

/** Rescale a distribution to a new mean, preserving its shape. */
function scaleMean(d: Distribution, mean: number): Distribution {
  switch (d.kind) {
    case 'exponential':
    case 'erlang':
      return { ...d, mean };
    case 'constant':
      return { ...d, value: mean };
    case 'normal':
    case 'lognormal':
      return { ...d, mean, sd: d.sd * (mean / (d.mean || mean)) };
    case 'uniform': {
      const f = mean / (((d.min + d.max) / 2) || mean);
      return { ...d, min: d.min * f, max: d.max * f };
    }
    case 'triangular': {
      const f = mean / (((d.min + d.mode + d.max) / 3) || mean);
      return { ...d, min: d.min * f, mode: d.mode * f, max: d.max * f };
    }
    case 'gamma':
      return { ...d, scale: mean / d.shape };
    case 'weibull': {
      const current = distMean(d) || mean;
      return { ...d, scale: d.scale * (mean / current) };
    }
  }
}
