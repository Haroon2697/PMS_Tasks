/**
 * Bottleneck analysis — requirement 42.
 *
 * The page answers the two questions in requirement 69 that matter most —
 * "where is my bottleneck?" and "why is it a bottleneck?" — and it answers the
 * second one with numbers rather than a colour.
 *
 * Capacity bottleneck and delay bottleneck are shown separately, because they
 * can be different stations. Relieving the capacity constraint raises output;
 * relieving the delay constraint shortens the time a vehicle spends in the
 * factory. Collapsing them into one "the bottleneck" would hide the choice.
 */

import { useState } from 'react';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice } from '../components/primitives';
import { HorizontalBars, Meter } from '../components/charts';
import { money, num, pct, utilisationStatus } from '../lib/format';

export function BottleneckPage({ navigate }: { navigate: (p: string) => void }) {
  const { model, bottleneck, analytical, capacity } = useStore();
  const currency = model.cost.currency;
  const [selected, setSelected] = useState<string | null>(bottleneck.primaryBottleneckId);

  if (bottleneck.stations.length === 0) {
    return <EmptyState>The network could not be solved, so no bottleneck analysis is possible.</EmptyState>;
  }

  const primary = bottleneck.stations.find((s) => s.stationId === bottleneck.primaryBottleneckId);
  const secondary = bottleneck.stations.find((s) => s.stationId === bottleneck.secondaryBottleneckId);
  const delay = bottleneck.stations.find((s) => s.stationId === bottleneck.delayBottleneckId);
  const detail = bottleneck.stations.find((s) => s.stationId === selected) ?? primary;

  return (
    <div className="stack">
      <Notice kind="info" title="How the bottleneck is identified">
        Not by a utilisation threshold. The constraint is the station with the smallest maximum
        sustainable demand, λ_max = c × μ / V, where V is the visits per vehicle from the traffic
        equations. That definition does not depend on the current demand level at all — it is a
        property of the configuration.
      </Notice>

      <div className="grid cols-4">
        <Kpi
          label="Primary bottleneck"
          value={primary?.stationName ?? '—'}
          basis="analytical"
          small
          sub={primary ? `caps output at ${num(primary.lambdaMaxPerHour, 3)} veh/h` : undefined}
          status="critical"
        />
        <Kpi
          label="Next constraint"
          value={secondary?.stationName ?? '—'}
          basis="analytical"
          small
          sub={secondary ? `binds at ${num(secondary.lambdaMaxPerHour, 3)} veh/h` : undefined}
        />
        <Kpi
          label="Delay bottleneck"
          value={delay?.stationName ?? '—'}
          basis="analytical"
          small
          sub={delay ? `${pct(delay.delayShare)} of all waiting time` : undefined}
        />
        <Kpi
          label="Factory capacity"
          value={num(bottleneck.factoryCapacityPerHour, 3)}
          unit="veh/h"
          basis="analytical"
          sub={`${num(bottleneck.factoryCapacityPerDay, 1)} per ${num(model.investment.hoursPerDay.value, 0)}-hour day`}
          status={utilisationStatus(bottleneck.utilisationOfCapacity)}
        />
      </div>

      {bottleneck.warnings.length > 0 ? (
        <Notice kind="warn" title="Notes">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {bottleneck.warnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="grid cols-2">
        <Card
          title="Maximum sustainable demand per station"
          hint="The lowest bar is the constraint. The red line is the demand the factory actually faces."
        >
          <HorizontalBars
            unit="vehicles/hour of external demand"
            labelWidth={168}
            barHeight={15}
            gap={6}
            selectedKey={selected}
            onSelect={setSelected}
            formatValue={(v) => num(v, 2)}
            reference={{ value: bottleneck.lambdaPerHour, label: 'demand' }}
            data={[...bottleneck.stations]
              .sort((a, b) => a.lambdaMaxPerHour - b.lambdaMaxPerHour)
              .map((s) => ({
                key: s.stationId,
                label: s.stationName,
                value: Number.isFinite(s.lambdaMaxPerHour) ? s.lambdaMaxPerHour : 0,
                color:
                  s.capacityRank === 1 ? 'var(--status-critical)' : 'var(--series-1)',
                detail: [
                  { label: 'Capacity c·μ', value: `${num(s.capacity, 3)} veh/h` },
                  { label: 'Visits per vehicle', value: num(s.visitRatio, 3) },
                  { label: 'Slack', value: `${num(s.slackPerHour, 3)} veh/h` },
                ],
              }))}
          />
          <div className="legend">
            <span className="item">
              <span className="swatch" style={{ background: 'var(--status-critical)' }} /> Binding
              constraint
            </span>
            <span className="item">
              <span className="swatch" style={{ background: 'var(--series-1)' }} /> Has headroom
            </span>
          </div>
        </Card>

        <Card
          title="Share of waiting time"
          hint="Which station a vehicle actually spends its queueing time at. Shares sum to 100%."
        >
          <HorizontalBars
            unit="share of total waiting time per vehicle"
            labelWidth={168}
            barHeight={15}
            gap={6}
            max={1}
            selectedKey={selected}
            onSelect={setSelected}
            formatValue={(v) => pct(v)}
            data={[...bottleneck.stations]
              .sort((a, b) => b.delayShare - a.delayShare)
              .map((s) => ({
                key: s.stationId,
                label: s.stationName,
                value: s.delayShare,
                detail: [
                  { label: 'Wq', value: `${num(s.WqMinutes, 2)} min` },
                  { label: 'Visits', value: num(s.visitRatio, 3) },
                  {
                    label: 'Waiting cost',
                    value: `${money(s.waitingCostPerHour, currency, 2)}/h`,
                  },
                ],
              }))}
          />
        </Card>
      </div>

      <Card
        title="All stations, ranked by capacity constraint"
        hint="Click a row to see why that station is or is not the bottleneck."
      >
        <DataTable
          rows={[...bottleneck.stations].sort((a, b) => a.capacityRank - b.capacityRank)}
          rowKey={(s) => s.stationId}
          onRowClick={(s) => setSelected(s.stationId)}
          selectedKey={selected}
          emphasiseRow={(s) => s.capacityRank === 1}
          columns={[
            { key: 'r', header: 'Rank', render: (s) => s.capacityRank, sortValue: (s) => s.capacityRank },
            { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
            { key: 'c', header: 'Servers', render: (s) => s.servers },
            {
              key: 'u',
              header: 'Utilisation',
              render: (s) => (
                <span className="row nowrap" style={{ justifyContent: 'flex-end' }}>
                  <Meter value={s.rho} status={utilisationStatus(s.rho)} width={48} />
                  {pct(s.rho)}
                </span>
              ),
              sortValue: (s) => s.rho,
            },
            { key: 'cap', header: 'Capacity c·μ', render: (s) => num(s.capacity, 3), sortValue: (s) => s.capacity },
            { key: 'v', header: 'Visits/veh', render: (s) => num(s.visitRatio, 3) },
            {
              key: 'lm',
              header: 'λ_max (veh/h)',
              title: 'Maximum external demand this station alone could sustain',
              render: (s) => num(s.lambdaMaxPerHour, 3),
              sortValue: (s) => s.lambdaMaxPerHour,
            },
            { key: 'sl', header: 'Slack', render: (s) => num(s.slackPerHour, 3), sortValue: (s) => s.slackPerHour },
            { key: 'lq', header: 'Lq', render: (s) => num(s.Lq, 3), sortValue: (s) => s.Lq },
            { key: 'wq', header: 'Wq (min)', render: (s) => num(s.WqMinutes, 2), sortValue: (s) => s.WqMinutes },
            { key: 'ds', header: 'Delay share', render: (s) => pct(s.delayShare), sortValue: (s) => s.delayShare },
            {
              key: 'wc',
              header: 'Waiting cost/h',
              render: (s) => money(s.waitingCostPerHour, currency, 2),
              sortValue: (s) => s.waitingCostPerHour,
            },
            {
              key: 'gain',
              header: '+1 server buys',
              title: 'Increase in maximum factory throughput from one more server here',
              render: (s) =>
                s.throughputGainPerExtraServer > 1e-9 ? (
                  <span className="num-pos">+{num(s.throughputGainPerExtraServer, 3)} veh/h</span>
                ) : (
                  <span className="muted">nothing</span>
                ),
              sortValue: (s) => s.throughputGainPerExtraServer,
            },
          ]}
        />
      </Card>

      {detail ? (
        <Card title={`Why: ${detail.stationName}`} hint="Every statement below is derived from the model.">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {detail.reasons.map((r, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                {r}
              </li>
            ))}
          </ul>
          <div className="grid cols-4" style={{ marginTop: 12 }}>
            <Kpi label="Capacity rank" value={`#${detail.capacityRank}`} basis="analytical" small />
            <Kpi label="Delay rank" value={`#${detail.delayRank}`} basis="analytical" small />
            <Kpi
              label="Throughput gain per extra server"
              value={`+${num(detail.throughputGainPerExtraServer, 3)}`}
              unit="veh/h"
              basis="analytical"
              small
            />
            <Kpi
              label="Wq reduction per extra server"
              value={num(detail.wqReductionPerExtraServer, 2)}
              unit="min/veh"
              basis="analytical"
              small
              sub="across the whole route"
            />
          </div>
        </Card>
      ) : null}

      {bottleneck.reliefPreview ? (
        <Card
          title="If you relieve the constraint"
          hint="Computed by re-solving the network with one more server, not estimated."
          actions={
            <button className="btn sm" onClick={() => navigate('optimization')}>
              Optimise the configuration
            </button>
          }
        >
          <div className="grid cols-3">
            <Kpi
              label="New factory capacity"
              value={num(bottleneck.reliefPreview.newCapacityPerHour, 3)}
              unit="veh/h"
              basis="analytical"
              small
              sub={`from ${num(capacity.lambdaMaxPerHour, 3)} veh/h`}
            />
            <Kpi
              label="Capacity gained"
              value={`+${num(bottleneck.reliefPreview.capacityGainPerHour, 3)}`}
              unit="veh/h"
              basis="analytical"
              small
              sub={`+${num(
                bottleneck.reliefPreview.capacityGainPerHour * model.investment.hoursPerDay.value,
                1,
              )} vehicles per day`}
            />
            <Kpi
              label="Next constraint becomes"
              value={bottleneck.reliefPreview.nextConstraintName ?? '—'}
              basis="analytical"
              small
            />
          </div>
          <div className="formula">{bottleneck.reliefPreview.note}</div>
        </Card>
      ) : null}

      <Card title="Capacity arithmetic" hint="The full derivation behind the ranking.">
        <DataTable
          rows={capacity.perStation}
          rowKey={(s) => s.stationId}
          columns={[
            { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
            {
              key: 'c',
              header: 'Capacity c·μ (veh/h)',
              render: (s) => num(s.capacity, 4),
              sortValue: (s) => s.capacity,
            },
            { key: 'v', header: 'Visit ratio V', render: (s) => num(s.visitRatio, 4) },
            {
              key: 'lm',
              header: 'λ_max = c·μ / V',
              render: (s) => num(s.lambdaMax, 4),
              sortValue: (s) => s.lambdaMax,
            },
          ]}
          caption={`Factory capacity is the minimum of the last column: ${num(
            capacity.lambdaMaxPerHour,
            4,
          )} vehicles/hour. Current demand is ${num(analytical.system.lambdaExternal, 3)} veh/h.`}
        />
      </Card>
    </div>
  );
}
