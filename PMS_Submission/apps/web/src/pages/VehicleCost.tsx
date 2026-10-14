/**
 * Vehicle cost and BOM page — requirements 14, 65.
 *
 * The bill of materials is fully editable here, and every unit cost carries its
 * provenance badge. With every default marked PROJECT ASSUMPTION, the page's
 * banner says so plainly: these are internally consistent modelling values, not
 * prices from any real manufacturer.
 *
 * The per-vehicle table below the BOM is where the individual-entity modelling
 * pays off — two vehicles built to the same BOM cost different amounts because
 * they queued differently and one of them was reworked.
 */

import { useState } from 'react';
import { expandBom } from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice, ProvenanceBadge } from '../components/primitives';
import { VehicleInspector } from '../components/LiveFactory';
import { HorizontalBars } from '../components/charts';
import { minutes, money, num, pct } from '../lib/format';

export function VehicleCostPage({ navigate }: { navigate: (p: string) => void }) {
  const { model, setModel, run, preview } = useStore();
  const currency = model.cost.currency;
  const cost = run?.study.representative.cost ?? preview?.cost ?? null;
  const [modelId, setModelId] = useState(model.vehicleModels[0]?.id ?? '');
  const [inspect, setInspect] = useState<number | null>(null);

  const vehicleModel = model.vehicleModels.find((v) => v.id === modelId) ?? model.vehicleModels[0];
  if (!vehicleModel) return <EmptyState>No vehicle model defined.</EmptyState>;

  const bom = expandBom(model, vehicleModel);
  const allAssumed = vehicleModel.bom.every((c) => c.unitCost.provenance === 'PROJECT_ASSUMPTION');

  const setUnitCost = (componentId: string, value: number) => {
    setModel((m) => ({
      ...m,
      vehicleModels: m.vehicleModels.map((vm) =>
        vm.id !== vehicleModel.id
          ? vm
          : {
              ...vm,
              bom: vm.bom.map((c) =>
                c.id !== componentId
                  ? c
                  : { ...c, unitCost: { ...c.unitCost, value, provenance: 'USER_INPUT' as const } },
              ),
            },
      ),
    }));
  };

  const setQuantity = (componentId: string, value: number) => {
    setModel((m) => ({
      ...m,
      vehicleModels: m.vehicleModels.map((vm) =>
        vm.id !== vehicleModel.id
          ? vm
          : {
              ...vm,
              bom: vm.bom.map((c) => (c.id !== componentId ? c : { ...c, quantityPerVehicle: value })),
            },
      ),
    }));
  };

  const perVehicleLines = cost
    ? cost.lines.map((l) => ({
        key: l.id,
        label: l.label,
        value: l.perVehicle,
        valueLabel: money(l.perVehicle, currency, 0),
      }))
    : [];

  const tracedVehicles = cost?.vehicles ?? [];
  const inspectedVehicle =
    inspect !== null
      ? (run?.study.representative.simulation.traces.find((v) => v.id === inspect) ?? null)
      : null;

  return (
    <div className="stack">
      {allAssumed ? (
        <Notice kind="warn" title="Every component price here is a PROJECT ASSUMPTION">
          These values are internally consistent and produce a plausible vehicle, but none of them
          is sourced from a real manufacturer and none should be quoted as an industry figure.
          Replace any of them below and the badge changes to USER.
        </Notice>
      ) : null}

      <div className="grid cols-4">
        <Kpi
          label="Material cost per vehicle"
          value={money(bom.totalMaterialCost, currency, 2)}
          basis="derived"
          sub={`${bom.lines.length} BOM lines`}
        />
        <Kpi
          label="Total cost per vehicle"
          value={cost ? money(cost.costPerVehicle, currency, 2) : '—'}
          basis="simulated"
          metric={run?.study.cost.costPerVehicle}
          sub="material + conversion + overhead"
        />
        <Kpi
          label="Selling price"
          value={money(vehicleModel.sellingPrice.value, currency, 2)}
          basis="assumption"
          sub={<ProvenanceBadge provenance={vehicleModel.sellingPrice.provenance} />}
        />
        <Kpi
          label="Profit per vehicle"
          value={cost ? money(cost.profitPerVehicle, currency, 2) : '—'}
          basis="simulated"
          sub={cost ? `margin ${num(cost.marginPercent, 2)}%` : undefined}
          status={cost ? (cost.profitPerVehicle >= 0 ? 'good' : 'critical') : undefined}
        />
      </div>

      {model.vehicleModels.length > 1 ? (
        <div className="row">
          <label className="small">Vehicle model</label>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={{ width: 240 }}>
            {model.vehicleModels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <Card
        title={`Bill of materials — ${vehicleModel.name}`}
        hint="Component cost = quantity × (1 + scrap allowance) × unit cost. Editable; changes flow straight into the cost engine."
      >
        <DataTable
          rows={bom.lines}
          rowKey={(l) => l.componentId}
          columns={[
            { key: 'n', header: 'Component', align: 'left', render: (l) => l.name },
            {
              key: 'q',
              header: 'Qty',
              render: (l) => (
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={l.quantityPerVehicle}
                  style={{ width: 78 }}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v) && v >= 0) setQuantity(l.componentId, v);
                  }}
                />
              ),
              sortValue: (l) => l.quantityPerVehicle,
            },
            { key: 'u', header: 'Unit', align: 'left', render: (l) => l.unit },
            {
              key: 'uc',
              header: `Unit cost (${currency.code})`,
              render: (l) => (
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={l.unitCost}
                  style={{ width: 96 }}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v) && v >= 0) setUnitCost(l.componentId, v);
                  }}
                />
              ),
              sortValue: (l) => l.unitCost,
            },
            { key: 'sa', header: 'Scrap allowance', render: (l) => pct(l.scrapAllowance, 1), sortValue: (l) => l.scrapAllowance },
            { key: 'eq', header: 'Effective qty', render: (l) => num(l.effectiveQuantity, 3), sortValue: (l) => l.effectiveQuantity },
            {
              key: 't',
              header: `Total (${currency.code})`,
              render: (l) => money(l.totalCost, currency, 2),
              sortValue: (l) => l.totalCost,
            },
            {
              key: 'st',
              header: 'Consumed at',
              align: 'left',
              render: (l) =>
                model.stations.find((s) => s.id === l.consumedAtStationId)?.name ?? l.consumedAtStationId,
            },
            { key: 'sp', header: 'Supplier', align: 'left', render: (l) => l.supplier ?? '—' },
            {
              key: 'pr',
              header: 'Source',
              align: 'left',
              render: (l) => {
                const c = vehicleModel.bom.find((x) => x.id === l.componentId);
                return c ? <ProvenanceBadge provenance={c.unitCost.provenance} /> : null;
              },
            },
          ]}
          maxHeight={460}
        />
        <table className="data" style={{ marginTop: 8 }}>
          <tbody>
            <tr className="emphasis">
              <td className="left">Material cost per vehicle (production stations)</td>
              <td>{money(bom.totalMaterialCost, currency, 2)}</td>
            </tr>
            <tr>
              <td className="left">
                Rework material, charged per rework visit rather than per vehicle
              </td>
              <td>{money(bom.reworkMaterialPerVisit, currency, 2)}</td>
            </tr>
          </tbody>
        </table>
      </Card>

      {cost ? (
        <div className="grid cols-2">
          <Card title="Cost per vehicle by category" hint="Same nine lines, divided by finished vehicles.">
            <HorizontalBars
              unit={`${currency.code} per vehicle`}
              labelWidth={220}
              data={perVehicleLines}
              formatValue={(v) => money(v, currency, 0)}
            />
            <table className="data" style={{ marginTop: 8 }}>
              <tbody>
                <tr className="emphasis">
                  <td className="left">TOTAL MANUFACTURING COST</td>
                  <td>{money(cost.costPerVehicle, currency, 2)}</td>
                </tr>
                <tr>
                  <td className="left">Selling price</td>
                  <td>{money(vehicleModel.sellingPrice.value, currency, 2)}</td>
                </tr>
                <tr className="emphasis">
                  <td className="left">Gross contribution per vehicle</td>
                  <td className={cost.profitPerVehicle >= 0 ? 'num-pos' : 'num-neg'}>
                    {money(cost.profitPerVehicle, currency, 2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card
            title="Individual vehicles"
            hint="Costed from each vehicle's own route and resource usage. Click a row for its full history."
          >
            {tracedVehicles.length > 0 ? (
              <DataTable
                rows={tracedVehicles.slice(0, 300)}
                rowKey={(v) => String(v.vehicleId)}
                onRowClick={(v) => setInspect(v.vehicleId)}
                maxHeight={420}
                columns={[
                  { key: 't', header: 'Vehicle', align: 'left', render: (v) => v.tag },
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
                  {
                    key: 'c',
                    header: 'Cycle time',
                    render: (v) => (v.cycleTimeHours === null ? '—' : minutes(v.cycleTimeHours * 60)),
                    sortValue: (v) => v.cycleTimeHours ?? 0,
                  },
                  { key: 'm', header: 'Material', render: (v) => money(v.materialCost, currency, 0), sortValue: (v) => v.materialCost },
                  { key: 'l', header: 'Labour', render: (v) => money(v.laborCost, currency, 0), sortValue: (v) => v.laborCost },
                  {
                    key: 'r',
                    header: 'Rework',
                    render: (v) => (v.reworkCost > 0 ? money(v.reworkCost, currency, 0) : '—'),
                    sortValue: (v) => v.reworkCost,
                  },
                  {
                    key: 'tot',
                    header: 'Total',
                    render: (v) => money(v.totalCost, currency, 0),
                    sortValue: (v) => v.totalCost,
                  },
                ]}
                caption={`${tracedVehicles.length} traced vehicles. Reworked vehicles cost more than first-pass ones — the difference is real, not an average.`}
              />
            ) : (
              <EmptyState>
                No vehicle traces retained. Increase "Vehicle traces kept" on the Simulation page.{' '}
                <button className="btn sm" onClick={() => navigate('simulation')}>
                  Open Simulation
                </button>
              </EmptyState>
            )}
          </Card>
        </div>
      ) : (
        <EmptyState>
          Run the simulation to see per-vehicle costs.{' '}
          <button className="btn sm" onClick={() => navigate('simulation')}>
            Go to Simulation
          </button>
        </EmptyState>
      )}

      {inspectedVehicle ? (
        <VehicleInspector
          vehicle={inspectedVehicle}
          cost={cost?.vehicles.find((v) => v.vehicleId === inspectedVehicle.id)}
          currency={currency}
          onClose={() => setInspect(null)}
        />
      ) : null}
    </div>
  );
}
