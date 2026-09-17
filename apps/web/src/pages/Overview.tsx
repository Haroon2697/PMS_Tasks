/**
 * Overview — requirement 63.
 *
 * The factory at a glance. Every tile states whether its number is simulated,
 * analytical or an assumption, because the page mixes all three deliberately:
 * capacity and the bottleneck are exact properties of the configuration and are
 * always current, while throughput and cost come from the last run and go stale
 * the moment a parameter changes. When they are stale the page says so rather
 * than letting old numbers pose as current ones.
 */

import { useStore } from '../state/store';
import { Card, Kpi, Notice, DataTable, EmptyState } from '../components/primitives';
import { HorizontalBars, Meter } from '../components/charts';
import { minutes, money, moneyCompact, num, pct, utilisationStatus } from '../lib/format';

export function OverviewPage({ navigate }: { navigate: (p: string) => void }) {
  const { model, analytical, capacity, bottleneck, run, studyIsStale, preview, validation } = useStore();
  const currency = model.cost.currency;
  const study = run?.study;
  const cost = study?.representative.cost ?? preview?.cost ?? null;
  // Production figures fall back to the preview replication for the same reason
  // the economics tiles do: showing a dash while the cost tiles below are
  // populated would suggest the two came from different places. Both are
  // labelled SIM and the banner above says which run they came from.
  const sim = study ? null : (preview?.simulation ?? null);
  const simSystem = sim?.system ?? null;

  const bottleneckStation = model.stations.find((s) => s.id === bottleneck.primaryBottleneckId);
  const demand = analytical.system.lambdaExternal;
  const utilOfCapacity = capacity.lambdaMaxPerHour > 0 ? demand / capacity.lambdaMaxPerHour : 0;

  return (
    <div className="stack">
      {!validation.runnable ? (
        <Notice kind="error" title="The model cannot be simulated">
          {validation.errors.length} validation error
          {validation.errors.length === 1 ? '' : 's'} must be fixed first.{' '}
          <button className="btn sm" onClick={() => navigate('validation')}>
            Open the validation report
          </button>
        </Notice>
      ) : null}

      {studyIsStale ? (
        <Notice kind="warn" title="Simulated figures are out of date">
          The model has been edited since the last run, so the simulated numbers below describe a
          configuration that no longer exists. Analytical figures are always current.{' '}
          <button className="btn sm" onClick={() => navigate('simulation')}>
            Re-run the simulation
          </button>
        </Notice>
      ) : null}

      {!run ? (
        <Notice kind="info" title="No replication study has been run yet">
          Cost and throughput below come from a single preview replication, which has no confidence
          interval. Run a study for statistically meaningful results.{' '}
          <button className="btn sm" onClick={() => navigate('simulation')}>
            Go to Simulation
          </button>
        </Notice>
      ) : null}

      {/* ---- production ---- */}
      <Card title="Production" hint="Throughput and flow time for the current configuration.">
        <div className="grid cols-4">
          <Kpi
            label="Vehicles entered"
            value={study ? num(study.system.vehiclesEntered?.mean, 0) : num(simSystem?.vehiclesEntered, 0)}
            unit="veh"
            basis="simulated"
            metric={study?.system.vehiclesEntered}
            metricDp={0}
            sub={`per ${minutes(model.simulation.durationMinutes)} window`}
          />
          <Kpi
            label="Vehicles completed"
            value={study ? num(study.system.vehiclesCompleted?.mean, 0) : num(simSystem?.vehiclesCompleted, 0)}
            unit="veh"
            basis="simulated"
            metric={study?.system.vehiclesCompleted}
            metricDp={0}
            sub={`${num(study ? study.system.vehiclesScrapped?.mean : simSystem?.vehiclesScrapped, 1)} scrapped`}
          />
          <Kpi
            label="Throughput"
            value={study ? num(study.system.throughput?.mean, 3) : num(simSystem?.throughputPerHour, 3)}
            unit="veh/h"
            basis="simulated"
            metric={study?.system.throughput}
            metricDp={3}
            sub={`demand ${num(demand, 2)} veh/h`}
          />
          <Kpi
            label="Work in progress"
            value={study ? num(study.system.L?.mean, 2) : num(simSystem?.L, 2)}
            unit="veh"
            basis="simulated"
            metric={study?.system.L}
            sub={`peak ${num(study ? study.system.maxWIP?.mean : simSystem?.maxWIP, 0)} · analytical ${num(analytical.system.L, 2)}`}
          />
        </div>

        <div className="grid cols-4" style={{ marginTop: 12 }}>
          <Kpi
            label="Manufacturing time (W)"
            value={study ? num(study.system.WMinutes?.mean, 1) : num(simSystem?.WMinutes, 1)}
            unit="min"
            basis="simulated"
            metric={study?.system.WMinutes}
            metricDp={1}
            sub={`p95 ${num(study ? study.system.cycleP95?.mean : simSystem?.cycleTime.p95Minutes, 0)} min · analytical ${num(analytical.system.WMinutes, 0)}`}
          />
          <Kpi
            label="Waiting time (Wq)"
            value={study ? num(study.system.WqMinutes?.mean, 1) : num(simSystem?.WqMinutes, 1)}
            unit="min"
            basis="simulated"
            metric={study?.system.WqMinutes}
            metricDp={1}
            sub={`queueing only · analytical ${num(analytical.system.WqMinutes, 0)} min`}
          />
          <Kpi
            label="Factory utilisation"
            value={pct(study ? (study.system.factoryUtilization?.mean ?? 0) : (simSystem?.factoryUtilization ?? 0))}
            basis="simulated"
            sub="server-weighted mean across stations"
          />
          <Kpi
            label="Demand vs capacity"
            value={pct(utilOfCapacity)}
            basis="analytical"
            sub={`${num(demand, 2)} of ${num(capacity.lambdaMaxPerHour, 2)} veh/h`}
            status={utilisationStatus(utilOfCapacity)}
          />
        </div>
      </Card>

      {/* ---- economics ---- */}
      <Card
        title="Economics"
        hint={
          run
            ? 'Mean over the replication study.'
            : 'Single preview replication — no confidence interval.'
        }
      >
        <div className="grid cols-4">
          <Kpi
            label="Cost per vehicle"
            value={cost ? money(cost.costPerVehicle, currency, 0) : '—'}
            basis="simulated"
            metric={study?.cost.costPerVehicle}
            sub="material + conversion + overhead"
          />
          <Kpi
            label="Total manufacturing cost"
            value={cost ? moneyCompact(cost.totalManufacturingCost, currency) : '—'}
            basis="simulated"
            sub={cost ? `over ${num(cost.windowHours, 1)} h` : undefined}
          />
          <Kpi
            label="Revenue"
            value={cost ? moneyCompact(cost.revenue, currency) : '—'}
            basis="simulated"
            sub={cost ? `${num(cost.vehiclesFinished, 0)} vehicles sold` : undefined}
          />
          <Kpi
            label="Profit"
            value={cost ? moneyCompact(cost.grossProfit, currency) : '—'}
            basis="simulated"
            metric={study?.cost.grossProfit}
            metricDp={0}
            sub={cost ? `margin ${num(cost.marginPercent, 2)}%` : undefined}
            status={cost ? (cost.grossProfit >= 0 ? 'good' : 'critical') : undefined}
          />
        </div>
        <div className="grid cols-4" style={{ marginTop: 12 }}>
          <Kpi
            label="Profit per vehicle"
            value={cost ? money(cost.profitPerVehicle, currency, 0) : '—'}
            basis="simulated"
            metric={study?.cost.profitPerVehicle}
          />
          <Kpi
            label="Selling price"
            value={money(model.vehicleModels[0]?.sellingPrice.value ?? 0, currency, 0)}
            basis="assumption"
            sub={model.vehicleModels[0]?.name}
          />
          <Kpi
            label="Queue waiting cost"
            value={cost ? moneyCompact(cost.waitingCost, currency) : '—'}
            basis="simulated"
            sub="opportunity cost — outside manufacturing cost"
          />
          <Kpi
            label="Value lost to scrap"
            value={cost ? moneyCompact(cost.scrapAnalysis.totalValueLost, currency) : '—'}
            basis="simulated"
            sub={cost ? `${cost.scrapAnalysis.vehiclesScrapped} vehicles condemned` : undefined}
            status={cost && cost.scrapAnalysis.vehiclesScrapped > 0 ? 'warning' : undefined}
          />
        </div>
      </Card>

      {/* ---- bottleneck ---- */}
      <div className="grid cols-2">
        <Card
          title="Bottleneck"
          hint="Identified from capacity, not from a utilisation threshold."
          actions={
            <button className="btn sm" onClick={() => navigate('bottleneck')}>
              Full analysis
            </button>
          }
        >
          {bottleneckStation ? (
            <>
              <div className="grid cols-2">
                <Kpi
                  label="Primary constraint"
                  value={bottleneckStation.name}
                  basis="analytical"
                  small
                  sub={`max sustainable demand ${num(
                    bottleneck.stations.find((s) => s.stationId === bottleneckStation.id)
                      ?.lambdaMaxPerHour,
                    2,
                  )} veh/h`}
                />
                <Kpi
                  label="Factory capacity"
                  value={num(bottleneck.factoryCapacityPerHour, 2)}
                  unit="veh/h"
                  basis="analytical"
                  small
                  sub={`${num(bottleneck.factoryCapacityPerDay, 0)} per ${num(
                    model.investment.hoursPerDay.value,
                    0,
                  )}-hour day`}
                />
              </div>
              <div className="formula">
                {bottleneck.stations.find((s) => s.stationId === bottleneckStation.id)?.reasons[0]}
              </div>
            </>
          ) : (
            <EmptyState>No bottleneck could be identified.</EmptyState>
          )}
        </Card>

        <Card title="Station utilisation" hint="Analytical ρ at the average demand level.">
          {analytical.stations.length > 0 ? (
            <HorizontalBars
              unit="utilisation"
              max={1}
              labelWidth={158}
              barHeight={14}
              gap={5}
              formatValue={(v) => pct(v)}
              reference={{ value: 1, label: '100%' }}
              data={analytical.stations.map((s) => ({
                key: s.stationId,
                label: s.stationName,
                value: Math.min(s.rho, 1.2),
                valueLabel: pct(s.rho),
                // Colour means a STATE here (approaching/over capacity), so the
                // status palette is correct — and the percentage is printed
                // beside every bar, so colour never carries it alone.
                color: {
                  good: 'var(--series-1)',
                  warning: 'var(--status-warning)',
                  serious: 'var(--status-serious)',
                  critical: 'var(--status-critical)',
                }[utilisationStatus(s.rho)],
                detail: [
                  { label: 'Kendall', value: s.kendall },
                  { label: 'λ', value: `${num(s.lambda, 3)} veh/h` },
                  { label: 'Lq', value: num(s.Lq, 3) },
                ],
              }))}
            />
          ) : (
            <EmptyState>The network could not be solved.</EmptyState>
          )}
        </Card>
      </div>

      {/* ---- per-station summary ---- */}
      <Card
        title="Stations"
        hint="Analytical figures, current with the model. Click a row to open the network view."
      >
        <DataTable
          rows={analytical.stations}
          rowKey={(s) => s.stationId}
          onRowClick={() => navigate('network')}
          emphasiseRow={(s) => s.stationId === bottleneck.primaryBottleneckId}
          columns={[
            { key: 'name', header: 'Station', align: 'left', render: (s) => s.stationName, sortValue: (s) => s.stationName },
            { key: 'kendall', header: 'Kendall', align: 'left', render: (s) => s.kendall },
            { key: 'c', header: 'c', title: 'Parallel servers', render: (s) => s.c, sortValue: (s) => s.c },
            { key: 'lambda', header: 'λ (veh/h)', title: 'Derived arrival rate', render: (s) => num(s.lambda, 3), sortValue: (s) => s.lambda },
            { key: 'mu', header: 'μ (veh/h/srv)', title: 'Service rate per server', render: (s) => num(60 / s.serviceMinutes, 3) },
            {
              key: 'rho',
              header: 'ρ',
              title: 'Utilisation',
              render: (s) => (
                <span className="row nowrap" style={{ justifyContent: 'flex-end' }}>
                  <Meter value={s.rho} status={utilisationStatus(s.rho)} width={52} />
                  {pct(s.rho)}
                </span>
              ),
              sortValue: (s) => s.rho,
            },
            { key: 'lq', header: 'Lq (veh)', render: (s) => num(s.Lq, 3), sortValue: (s) => s.Lq },
            { key: 'wq', header: 'Wq (min)', render: (s) => num(s.WqMinutes, 2), sortValue: (s) => s.WqMinutes },
            {
              key: 'stable',
              header: 'Stability',
              align: 'left',
              render: (s) =>
                s.stable ? (
                  <span className="status good">Stable</span>
                ) : (
                  <span className="status critical">Unstable</span>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
