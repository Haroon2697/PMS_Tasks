/**
 * Network model page — requirements 37 and 7.
 *
 * Shows the routing network with every node's live derived figures, and makes
 * the point requirement 7 insists on: external lambda is defined at exactly one
 * place, and every other station's arrival rate is SOLVED from the routing. The
 * visit-ratio table is the visible proof — inspection is visited more than once
 * per vehicle, and the number comes from the traffic equations rather than an
 * assumption.
 */

import { useState } from 'react';
import { useStore } from '../state/store';
import { NetworkDiagram } from '../components/NetworkDiagram';
import { StationPanel } from '../components/StationPanel';
import { Card, DataTable, Notice, Kpi } from '../components/primitives';
import { num, pct } from '../lib/format';

export function NetworkModelPage() {
  const { model, setModel, analytical, bottleneck } = useStore();
  const [selected, setSelected] = useState<string | null>(null);

  const traffic = analytical.traffic;
  const entryName =
    model.stations.find((s) => s.id === model.arrivals.entryStationId)?.name ?? '—';

  return (
    <div className="stack">
      <p className="page-intro">
        Click any station to edit its parameters. Every figure on a node is derived from the model
        and updates immediately — the Kendall notation follows the distribution you configure, and
        each station's λ is solved from upstream flow rather than assumed.
      </p>

      <div className="grid cols-4">
        <Kpi
          label="External arrival rate"
          value={num(traffic.lambdaExternal, 2)}
          unit="veh/h"
          basis="assumption"
          sub={`defined only at ${entryName}`}
          small
        />
        <Kpi
          label="Finished vehicles"
          value={num(traffic.throughputFinished, 3)}
          unit="veh/h"
          basis="analytical"
          sub="steady-state outflow"
          small
        />
        <Kpi
          label="Scrapped"
          value={num(traffic.throughputScrap, 3)}
          unit="veh/h"
          basis="analytical"
          sub={`${pct(traffic.lambdaExternal > 0 ? traffic.throughputScrap / traffic.lambdaExternal : 0, 2)} of input`}
          small
        />
        <Kpi
          label="Work content"
          value={num(analytical.system.totalServiceMinutesPerVehicle, 1)}
          unit="min/veh"
          basis="analytical"
          sub="sum of visits × service time — the floor on cycle time"
          small
        />
      </div>

      {analytical.warnings.length > 0 ? (
        <Notice kind="warn" title="Modelling notes">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {analytical.warnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Card
        title="Routing network"
        hint="Solid arcs are forward flow; the orange arc is the rework feedback loop; red is scrap."
      >
        <NetworkDiagram
          model={model}
          analytical={analytical.stations}
          selectedId={selected}
          onSelect={setSelected}
          bottleneckId={bottleneck.primaryBottleneckId}
        />
      </Card>

      <Card
        title="Traffic equations"
        hint="λ = r + Pᵀλ solved for the whole network. The feedback loop makes this a system that must be solved, not accumulated in order."
      >
        <DataTable
          rows={analytical.stations}
          rowKey={(s) => s.stationId}
          onRowClick={(s) => setSelected(s.stationId)}
          selectedKey={selected}
          columns={[
            { key: 'name', header: 'Station', align: 'left', render: (s) => s.stationName },
            {
              key: 'visits',
              header: 'Visits per vehicle (V)',
              title: 'Expected number of times one vehicle passes through this station',
              render: (s) => num(s.visitRatio, 4),
              sortValue: (s) => s.visitRatio,
            },
            {
              key: 'lambda',
              header: 'λ = V × λ_ext (veh/h)',
              render: (s) => num(s.lambda, 4),
              sortValue: (s) => s.lambda,
            },
            {
              key: 'capacity',
              header: 'Capacity c·μ (veh/h)',
              render: (s) => num(s.capacity, 3),
              sortValue: (s) => s.capacity,
            },
            {
              key: 'rho',
              header: 'ρ = λ / (c·μ)',
              render: (s) => pct(s.rho),
              sortValue: (s) => s.rho,
            },
            {
              key: 'why',
              header: 'Why V is what it is',
              align: 'left',
              render: (s) =>
                s.visitRatio > 1.0001 ? (
                  <span>Revisited via the rework loop</span>
                ) : s.visitRatio < 0.9999 ? (
                  <span>Only some vehicles are routed here</span>
                ) : (
                  <span className="muted">Visited once per vehicle</span>
                ),
            },
          ]}
          caption={`External λ = ${num(traffic.lambdaExternal, 3)} veh/h enters at ${entryName}. Every other rate on this table is derived, not configured.`}
        />
      </Card>

      {selected ? (
        <StationPanel
          model={model}
          stationId={selected}
          analytic={analytical.stations.find((s) => s.stationId === selected)}
          onClose={() => setSelected(null)}
          onChange={setModel}
        />
      ) : null}
    </div>
  );
}
