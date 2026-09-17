/**
 * Manufacturing cost page — requirements 41, 48, 27.
 *
 * Every line is clickable and opens its own derivation: the formula in words,
 * the inputs that fed it, and the per-station detail behind it. Requirement 48
 * asks for every dollar to be traceable, which means the page has to show the
 * arithmetic, not just the answer.
 *
 * The additivity check at the bottom is deliberately visible. The nine lines
 * partition the total, and the page proves it rather than asserting it.
 */

import { useState } from 'react';
import { verifyAdditivity, type CostLine } from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice, SidePanel } from '../components/primitives';
import { CompositionBar, HorizontalBars } from '../components/charts';
import { money, moneyCompact, num, pct } from '../lib/format';

export function CostPage({ navigate }: { navigate: (p: string) => void }) {
  const { model, run, preview, studyIsStale } = useStore();
  const currency = model.cost.currency;
  const cost = run?.study.representative.cost ?? preview?.cost ?? null;
  const [open, setOpen] = useState<CostLine | null>(null);

  if (!cost) {
    return (
      <EmptyState>
        Costs are computed from a simulation run. Run the simulation to populate this page.{' '}
        <button className="btn sm" onClick={() => navigate('simulation')}>
          Go to Simulation
        </button>
      </EmptyState>
    );
  }

  const additivity = verifyAdditivity(cost);
  const total = cost.totalManufacturingCost;

  // One series, one colour: bar length already encodes the magnitude, so
  // shading each bar by value would double-encode it.
  const bars = cost.lines.map((l) => ({
    key: l.id,
    label: l.label,
    value: l.amount,
    valueLabel: moneyCompact(l.amount, currency),
    detail: [
      { label: 'Per vehicle', value: money(l.perVehicle, currency) },
      { label: 'Share of total', value: pct(total > 0 ? l.amount / total : 0) },
    ],
  }));

  return (
    <div className="stack">
      {!run ? (
        <Notice kind="info" title="Preview figures">
          These come from a single preview replication and have no confidence interval. Run a
          replication study for statistically meaningful costs.
        </Notice>
      ) : studyIsStale ? (
        <Notice kind="warn" title="Stale">
          The model changed after this run. Re-run the simulation.
        </Notice>
      ) : null}

      <div className="grid cols-4">
        <Kpi
          label="Cost per vehicle"
          value={money(cost.costPerVehicle, currency, 2)}
          basis="simulated"
          metric={run?.study.cost.costPerVehicle}
          sub={`${num(cost.vehiclesFinished, 0)} vehicles finished`}
        />
        <Kpi
          label="Total manufacturing cost"
          value={moneyCompact(total, currency)}
          basis="simulated"
          sub={`over ${num(cost.windowHours, 2)} production hours`}
        />
        <Kpi
          label="Energy per vehicle"
          value={money(cost.energy.costPerVehicle, currency)}
          basis="simulated"
          sub={`${num(cost.energy.kwhPerVehicle, 1)} kWh at ${money(cost.energy.pricePerKwh, currency, 3)}/kWh`}
        />
        <Kpi
          label="Rework cost"
          value={moneyCompact(cost.reworkAnalysis.totalCost, currency)}
          basis="simulated"
          sub={`${cost.reworkAnalysis.reworkVisits} rework visits · ${money(
            cost.reworkAnalysis.perReworkVisit,
            currency,
          )} each`}
        />
      </div>

      <Card
        title="Cost composition"
        hint="The nine lines partition the total. Click any line for its derivation."
      >
        <CompositionBar
          total={total}
          formatValue={(v) => money(v, currency)}
          segments={cost.lines.map((l, i) => ({
            key: l.id,
            label: l.label,
            value: l.amount,
            // A composition bar of nine nominal parts cannot carry nine
            // distinguishable hues, so magnitude is encoded on one blue ramp
            // and identity comes from the table below and the tooltip.
            color: ['var(--seq-700)', 'var(--seq-550)', 'var(--seq-400)', 'var(--seq-250)', 'var(--seq-100)'][
              i % 5
            ] as string,
          }))}
        />
        <div style={{ marginTop: 14 }}>
          <HorizontalBars
            unit={`${currency.code} over the window`}
            labelWidth={230}
            data={bars}
            formatValue={(v) => money(v, currency, 0)}
            onSelect={(key) => setOpen(cost.lines.find((l) => l.id === key) ?? null)}
          />
        </div>
      </Card>

      <Card title="Cost lines" hint="Click a row to see exactly how it was calculated.">
        <DataTable
          rows={cost.lines}
          rowKey={(l) => l.id}
          onRowClick={(l) => setOpen(l)}
          columns={[
            { key: 'l', header: 'Line', align: 'left', render: (l) => l.label },
            { key: 'a', header: `Total (${currency.code})`, render: (l) => money(l.amount, currency, 2), sortValue: (l) => l.amount },
            { key: 'p', header: `Per vehicle (${currency.code})`, render: (l) => money(l.perVehicle, currency, 2), sortValue: (l) => l.perVehicle },
            { key: 's', header: 'Share', render: (l) => pct(total > 0 ? l.amount / total : 0, 2), sortValue: (l) => l.amount },
          ]}
        />
        <table className="data" style={{ marginTop: 8 }}>
          <tbody>
            <tr className="emphasis">
              <td className="left">Total manufacturing cost</td>
              <td>{money(total, currency, 2)}</td>
              <td>{money(cost.costPerVehicle, currency, 2)} per vehicle</td>
            </tr>
          </tbody>
        </table>
        <div className="formula">
          Additivity check: the nine lines sum to {money(additivity.sumOfLines, currency, 2)} against
          a reported total of {money(additivity.reportedTotal, currency, 2)} — a discrepancy of{' '}
          {num(additivity.discrepancy, 8)}.{' '}
          {additivity.ok
            ? 'They partition the total exactly, so no cost is double counted.'
            : 'They do NOT agree, which means a cost is being counted twice or dropped.'}
        </div>
      </Card>

      <div className="grid cols-2">
        <Card
          title="Costs reported outside manufacturing cost"
          hint="Requirement 25: these are decision-support figures, not costs the plant pays to build a vehicle."
        >
          <DataTable
            rows={[
              {
                k: 'Queue waiting cost',
                v: cost.waitingCost,
                why: 'Opportunity cost of vehicle-hours spent queueing: tied-up capital and delayed revenue. Adding it to manufacturing cost would overstate what a vehicle costs to build.',
              },
              {
                k: 'WIP holding cost',
                v: cost.wipHoldingCost,
                why: 'Carrying cost of inventory on the line — a financing cost rather than a conversion cost.',
              },
              {
                k: 'Total value lost to scrap',
                v: cost.scrapAnalysis.totalValueLost,
                why: cost.scrapAnalysis.note,
              },
            ]}
            rowKey={(r) => r.k}
            columns={[
              { key: 'k', header: 'Item', align: 'left', render: (r) => r.k },
              { key: 'v', header: currency.code, render: (r) => money(r.v, currency, 2) },
            ]}
          />
          <details className="expander" open>
            <summary>Why these sit outside the total</summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li style={{ marginBottom: 6 }}>
                <strong>Waiting cost</strong> — {cost.waitingCost > 0 ? money(cost.waitingCost, currency, 0) : 'zero'}:
                priced at {money(model.cost.waitingCostPerVehicleHour.value, currency)} per
                vehicle-hour waiting.
              </li>
              <li>
                <strong>Scrap</strong> — {cost.scrapAnalysis.vehiclesScrapped} vehicles condemned,
                destroying {money(cost.scrapAnalysis.materialLost, currency, 0)} of material and{' '}
                {money(cost.scrapAnalysis.conversionLost, currency, 0)} of conversion work already
                performed.
              </li>
            </ul>
          </details>
        </Card>

        <Card title="Per-station cost" hint="Which stations consume the money.">
          <DataTable
            rows={cost.stations}
            rowKey={(s) => s.stationId}
            maxHeight={340}
            columns={[
              { key: 'n', header: 'Station', align: 'left', render: (s) => s.stationName },
              { key: 'b', header: 'Bucket', align: 'left', render: (s) => s.bucket },
              { key: 'lab', header: 'Labour', render: (s) => money(s.laborCost, currency, 0), sortValue: (s) => s.laborCost },
              { key: 'idle', header: 'of which idle', render: (s) => money(s.laborIdleCost, currency, 0), sortValue: (s) => s.laborIdleCost },
              {
                key: 'mach',
                header: 'Machine',
                render: (s) => money(s.machineDepreciation + s.machineConsumables, currency, 0),
                sortValue: (s) => s.machineDepreciation + s.machineConsumables,
              },
              { key: 'en', header: 'Energy', render: (s) => money(s.energyCost, currency, 0), sortValue: (s) => s.energyCost },
              { key: 'kwh', header: 'kWh', render: (s) => num(s.energyKwh, 0), sortValue: (s) => s.energyKwh },
              {
                key: 'mnt',
                header: 'Maintenance',
                render: (s) => money(s.preventiveMaintenance + s.correctiveMaintenance, currency, 0),
                sortValue: (s) => s.preventiveMaintenance + s.correctiveMaintenance,
              },
              { key: 'mat', header: 'Material', render: (s) => money(s.materialCost, currency, 0), sortValue: (s) => s.materialCost },
              { key: 'bh', header: 'Busy hours', render: (s) => num(s.busyServerHours, 1), sortValue: (s) => s.busyServerHours },
            ]}
          />
        </Card>
      </div>

      {open ? (
        <CostLineDetail
          line={open}
          currency={currency}
          vehicles={cost.vehiclesFinished}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function CostLineDetail({
  line,
  currency,
  vehicles,
  onClose,
}: {
  line: CostLine;
  currency: { code: string; symbol: string };
  vehicles: number;
  onClose: () => void;
}) {
  const cur = currency as unknown as Parameters<typeof money>[1];
  return (
    <SidePanel title={line.label} onClose={onClose}>
      <div className="stack">
        <div className="grid cols-2">
          <Kpi label="Total" value={money(line.amount, cur, 2)} basis="simulated" small />
          <Kpi
            label="Per vehicle"
            value={money(line.perVehicle, cur, 2)}
            basis="simulated"
            small
            sub={`${num(vehicles, 0)} finished vehicles`}
          />
        </div>

        <Card title="How this is calculated">
          <div className="formula">{line.formula}</div>
        </Card>

        {line.inputs.length > 0 ? (
          <Card title="Inputs">
            <DataTable
              rows={line.inputs}
              rowKey={(i) => i.label}
              columns={[
                { key: 'l', header: 'Input', align: 'left', render: (i) => i.label },
                {
                  key: 'v',
                  header: 'Value',
                  render: (i) => (i.unit === 'currency' ? money(i.value, cur, 2) : num(i.value, 3)),
                },
                { key: 'u', header: 'Unit', align: 'left', render: (i) => i.unit },
              ]}
            />
          </Card>
        ) : null}

        {line.children && line.children.length > 0 ? (
          <Card title="Breakdown">
            <DataTable
              rows={line.children}
              rowKey={(c) => c.id}
              columns={[
                { key: 'l', header: 'Component', align: 'left', render: (c) => c.label },
                { key: 'a', header: currency.code, render: (c) => money(c.amount, cur, 2), sortValue: (c) => c.amount },
                { key: 'p', header: 'Per vehicle', render: (c) => money(c.perVehicle, cur, 2) },
              ]}
            />
            {line.children.some((c) => c.inputs.length > 0) ? (
              <details className="expander">
                <summary>Component inputs</summary>
                {line.children.map((c) =>
                  c.inputs.length ? (
                    <div key={c.id} style={{ marginTop: 8 }}>
                      <div className="small" style={{ fontWeight: 600 }}>
                        {c.label}
                      </div>
                      <DataTable
                        rows={c.inputs}
                        rowKey={(i) => `${c.id}-${i.label}`}
                        columns={[
                          { key: 'l', header: 'Input', align: 'left', render: (i) => i.label },
                          { key: 'v', header: 'Value', render: (i) => num(i.value, 2) },
                        ]}
                      />
                    </div>
                  ) : null,
                )}
              </details>
            ) : null}
          </Card>
        ) : null}
      </div>
    </SidePanel>
  );
}
