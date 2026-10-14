/**
 * Financial analysis — requirements 28, 29, 30, 31, 32, 66.
 *
 * Requirement 66 asks for "a clear explanation of how every value was
 * calculated", so every figure on this page is accompanied by its derivation
 * rather than just its result.
 *
 * Two rules are enforced visibly here: ROI is undefined without a stated
 * investment, and an investment whose annual net benefit is not positive has NO
 * payback period — it is reported as "NOT ACHIEVED", never as a negative number
 * of years that a reader might mistake for a fast return.
 */

import { useState } from 'react';
import { annualise, appraiseIncremental, discountedPayback, netPresentValue } from '@vmq/engine';
import { useStore } from '../state/store';
import { Card, DataTable, EmptyState, Kpi, Notice, NumberField } from '../components/primitives';
import { money, moneyCompact, num, pct } from '../lib/format';

export function FinancialPage({ navigate }: { navigate: (p: string) => void }) {
  const { model, setModel, run, preview } = useStore();
  const currency = model.cost.currency;
  const cost = run?.study.representative.cost ?? preview?.cost ?? null;

  const [discountRate, setDiscountRate] = useState(0.1);
  const [horizonYears, setHorizonYears] = useState(10);
  const [annualSavings, setAnnualSavings] = useState(0);

  if (!cost) {
    return (
      <EmptyState>
        Financial analysis needs simulated production figures.{' '}
        <button className="btn sm" onClick={() => navigate('simulation')}>
          Run the simulation
        </button>
      </EmptyState>
    );
  }

  const annual = annualise(
    {
      windowHours: cost.windowHours,
      vehiclesFinished: cost.vehiclesFinished,
      revenue: cost.revenue,
      manufacturingCost: cost.totalManufacturingCost,
      waitingCost: cost.waitingCost,
    },
    model.investment,
  );

  const investment = model.investment.initialInvestment.value;
  const addedOpex = model.investment.additionalAnnualOperatingCost.value;

  // The appraisal compares the current configuration against a hypothetical
  // baseline that is worse by `annualSavings`. That framing keeps ROI honest:
  // a benefit has to be entered explicitly, never inferred from the run.
  const hypotheticalBaseline = {
    ...annual,
    profitPerYear: annual.profitPerYear - annualSavings,
  };
  const appraisal = appraiseIncremental(hypotheticalBaseline, annual, {
    initialInvestment: investment,
    additionalAnnualOperatingCost: addedOpex,
  });

  const npv =
    investment > 0 ? netPresentValue(investment, appraisal.annualNetBenefit, horizonYears, discountRate) : null;
  const dpb =
    investment > 0 ? discountedPayback(investment, appraisal.annualNetBenefit, discountRate) : null;

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Kpi
          label="Revenue per year"
          value={moneyCompact(annual.revenuePerYear, currency)}
          basis="simulated"
          sub={`${num(annual.vehiclesPerYear, 0)} vehicles`}
        />
        <Kpi
          label="Manufacturing cost per year"
          value={moneyCompact(annual.manufacturingCostPerYear, currency)}
          basis="simulated"
        />
        <Kpi
          label="Profit per year"
          value={moneyCompact(annual.profitPerYear, currency)}
          basis="simulated"
          status={annual.profitPerYear >= 0 ? 'good' : 'critical'}
        />
        <Kpi
          label="Margin"
          value={`${num(cost.marginPercent, 2)}%`}
          basis="simulated"
          sub={`${money(cost.profitPerVehicle, currency, 0)} per vehicle`}
        />
      </div>

      <Card
        title="Unit economics"
        hint="Requirement 28. Every row shows the arithmetic, not just the answer."
      >
        <DataTable
          rows={[
            {
              k: 'Manufacturing cost per vehicle',
              v: cost.costPerVehicle,
              f: `Total manufacturing cost ${money(cost.totalManufacturingCost, currency, 0)} ÷ ${num(cost.vehiclesFinished, 0)} finished vehicles`,
            },
            {
              k: 'Selling price per vehicle',
              v: cost.revenuePerVehicle,
              f: 'Configured on the Vehicle Cost page — a project assumption, not a market price',
            },
            {
              k: 'Gross contribution per vehicle',
              v: cost.profitPerVehicle,
              f: 'Selling price − manufacturing cost per vehicle',
            },
            {
              k: 'Margin',
              v: cost.marginPercent,
              f: 'Profit ÷ revenue × 100',
              suffix: '%',
            },
          ]}
          rowKey={(r) => r.k}
          emphasiseRow={(r) => r.k.startsWith('Gross')}
          columns={[
            { key: 'k', header: 'Measure', align: 'left', render: (r) => r.k },
            {
              key: 'v',
              header: 'Value',
              render: (r) => (r.suffix === '%' ? `${num(r.v, 2)}%` : money(r.v, currency, 2)),
            },
            { key: 'f', header: 'How it was calculated', align: 'left', render: (r) => r.f },
          ]}
        />
      </Card>

      <Card
        title="Annualisation"
        hint="Simulated results cover a short window. They are scaled to a year by the plant calendar, not by 8,760 hours."
      >
        <div className="grid cols-3">
          <NumberField
            label="Operating days per year"
            unit="days"
            value={model.investment.operatingDaysPerYear.value}
            min={1}
            max={366}
            step={1}
            integer
            provenance={model.investment.operatingDaysPerYear.provenance}
            onChange={(v) =>
              setModel((m) => ({
                ...m,
                investment: {
                  ...m.investment,
                  operatingDaysPerYear: { ...m.investment.operatingDaysPerYear, value: v, provenance: 'USER_INPUT' },
                },
              }))
            }
          />
          <NumberField
            label="Production hours per day"
            unit="hours"
            value={model.investment.hoursPerDay.value}
            min={0.5}
            max={24}
            step={0.5}
            provenance={model.investment.hoursPerDay.provenance}
            onChange={(v) =>
              setModel((m) => ({
                ...m,
                investment: {
                  ...m.investment,
                  hoursPerDay: { ...m.investment.hoursPerDay, value: v, provenance: 'USER_INPUT' },
                },
              }))
            }
          />
          <Kpi
            label="Production hours per year"
            value={num(annual.annualProductionHours, 0)}
            unit="h"
            basis="derived"
            small
            sub="days × hours per day"
          />
        </div>

        <DataTable
          rows={[
            { k: 'Vehicles', w: cost.vehiclesFinished, y: annual.vehiclesPerYear, u: 'vehicles' },
            { k: 'Revenue', w: cost.revenue, y: annual.revenuePerYear, u: currency.code },
            {
              k: 'Manufacturing cost',
              w: cost.totalManufacturingCost,
              y: annual.manufacturingCostPerYear,
              u: currency.code,
            },
            { k: 'Profit', w: cost.grossProfit, y: annual.profitPerYear, u: currency.code },
            {
              k: 'Waiting cost (outside manufacturing cost)',
              w: cost.waitingCost,
              y: annual.waitingCostPerYear,
              u: currency.code,
            },
          ]}
          rowKey={(r) => r.k}
          columns={[
            { key: 'k', header: 'Measure', align: 'left', render: (r) => r.k },
            { key: 'u', header: 'Unit', align: 'left', render: (r) => r.u },
            {
              key: 'w',
              header: `Per window (${num(cost.windowHours, 1)} h)`,
              render: (r) => num(r.w, 2),
            },
            { key: 'y', header: 'Per year', render: (r) => num(r.y, 0) },
          ]}
          caption={`Scale factor = ${num(annual.annualProductionHours, 0)} production hours per year ÷ ${num(cost.windowHours, 2)} measured hours = ${num(annual.annualProductionHours / Math.max(1e-9, cost.windowHours), 2)}×`}
        />
      </Card>

      <Card
        title="Investment appraisal"
        hint="Requirement 31: ROI needs a defined investment. Enter one, plus the annual benefit the change produces."
      >
        <div className="grid cols-4">
          <NumberField
            label="Initial investment"
            unit={currency.code}
            value={investment}
            min={0}
            provenance={model.investment.initialInvestment.provenance}
            onChange={(v) =>
              setModel((m) => ({
                ...m,
                investment: {
                  ...m.investment,
                  initialInvestment: { ...m.investment.initialInvestment, value: v, provenance: 'USER_INPUT' },
                },
              }))
            }
            hint="Capital outlay for the change being appraised."
          />
          <NumberField
            label="Additional annual operating cost"
            unit={`${currency.code}/year`}
            value={addedOpex}
            min={0}
            onChange={(v) =>
              setModel((m) => ({
                ...m,
                investment: {
                  ...m.investment,
                  additionalAnnualOperatingCost: {
                    ...m.investment.additionalAnnualOperatingCost,
                    value: v,
                    provenance: 'USER_INPUT',
                  },
                },
              }))
            }
            hint="Extra cost the investment adds each year."
          />
          <NumberField
            label="Annual profit improvement"
            unit={`${currency.code}/year`}
            value={annualSavings}
            min={0}
            onChange={setAnnualSavings}
            hint="What the change is worth per year. Use the Scenario Manager to measure this instead of estimating it."
          />
          <Kpi
            label="Annual net benefit"
            value={money(appraisal.annualNetBenefit, currency, 0)}
            basis="derived"
            small
            sub="improvement − added operating cost"
            status={appraisal.annualNetBenefit > 0 ? 'good' : 'critical'}
          />
        </div>

        <div className="grid cols-3" style={{ marginTop: 12 }}>
          <Kpi
            label="ROI"
            value={appraisal.roiPercent === null ? 'Not defined' : `${num(appraisal.roiPercent, 2)}%`}
            basis="derived"
            sub={
              appraisal.roiPercent === null
                ? 'No capital was committed, so there is no denominator.'
                : 'net benefit ÷ initial investment, per year'
            }
          />
          <Kpi
            label="Payback period"
            value={appraisal.payback.achieved ? `${num(appraisal.payback.years, 2)} years` : 'NOT ACHIEVED'}
            basis="derived"
            sub={
              appraisal.payback.achieved
                ? `${num(appraisal.payback.months, 1)} months`
                : 'the investment never recovers its cost'
            }
            status={
              investment === 0 ? 'neutral' : appraisal.payback.achieved ? 'good' : 'critical'
            }
          />
          <Kpi
            label="Discounted payback"
            value={dpb === null ? 'n/a' : `${num(dpb, 2)} years`}
            basis="derived"
            sub={`at ${pct(discountRate, 1)} discount rate`}
          />
        </div>

        {!appraisal.payback.achieved && investment > 0 ? (
          <Notice kind="error" title="Payback: NOT ACHIEVED">
            {appraisal.payback.message}
          </Notice>
        ) : null}

        <Card title="Workings" hint="Requirement 66.">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {appraisal.workings.map((w, i) => (
              <li key={i} style={{ marginBottom: 5 }}>
                {w}
              </li>
            ))}
          </ul>
        </Card>
      </Card>

      <Card
        title="Discounted cash flow"
        hint="Simple payback ignores the time value of money and everything after the payback date. NPV does not."
      >
        <div className="grid cols-3">
          <NumberField
            label="Discount rate"
            unit="fraction per year"
            value={discountRate}
            min={0}
            max={1}
            step={0.005}
            onChange={setDiscountRate}
          />
          <NumberField
            label="Appraisal horizon"
            unit="years"
            value={horizonYears}
            min={1}
            max={40}
            step={1}
            integer
            onChange={setHorizonYears}
          />
          <Kpi
            label="Net present value"
            value={npv === null ? 'n/a' : moneyCompact(npv, currency)}
            basis="derived"
            small
            sub={npv === null ? 'no investment entered' : npv > 0 ? 'value-creating' : 'value-destroying'}
            status={npv === null ? 'neutral' : npv > 0 ? 'good' : 'critical'}
          />
        </div>
        {investment > 0 ? (
          <DataTable
            rows={Array.from({ length: horizonYears }, (_, i) => {
              const year = i + 1;
              const pv = appraisal.annualNetBenefit / Math.pow(1 + discountRate, year);
              return { year, nominal: appraisal.annualNetBenefit, pv };
            })}
            rowKey={(r) => String(r.year)}
            maxHeight={280}
            columns={[
              { key: 'y', header: 'Year', render: (r) => r.year },
              { key: 'n', header: `Net benefit (${currency.code})`, render: (r) => money(r.nominal, currency, 0) },
              { key: 'p', header: `Present value (${currency.code})`, render: (r) => money(r.pv, currency, 0) },
            ]}
            caption={`Initial outlay ${money(investment, currency, 0)} at year 0.`}
          />
        ) : (
          <EmptyState>Enter an initial investment to see the cash-flow schedule.</EmptyState>
        )}
      </Card>

      <Card title="Cost structure" hint="Where the money goes, per vehicle.">
        <DataTable
          rows={cost.lines}
          rowKey={(l) => l.id}
          columns={[
            { key: 'l', header: 'Cost line', align: 'left', render: (l) => l.label },
            { key: 'p', header: `Per vehicle (${currency.code})`, render: (l) => money(l.perVehicle, currency, 2), sortValue: (l) => l.perVehicle },
            {
              key: 's',
              header: 'Share of cost',
              render: (l) => pct(cost.totalManufacturingCost > 0 ? l.amount / cost.totalManufacturingCost : 0, 2),
              sortValue: (l) => l.amount,
            },
            {
              key: 'r',
              header: 'Share of selling price',
              render: (l) => pct(cost.revenuePerVehicle > 0 ? l.perVehicle / cost.revenuePerVehicle : 0, 2),
            },
          ]}
        />
        <table className="data" style={{ marginTop: 8 }}>
          <tbody>
            <tr className="emphasis">
              <td className="left">Total cost per vehicle</td>
              <td>{money(cost.costPerVehicle, currency, 2)}</td>
              <td>{pct(cost.revenuePerVehicle > 0 ? cost.costPerVehicle / cost.revenuePerVehicle : 0, 2)} of price</td>
            </tr>
            <tr className="emphasis">
              <td className="left">Profit per vehicle</td>
              <td className={cost.profitPerVehicle >= 0 ? 'num-pos' : 'num-neg'}>
                {money(cost.profitPerVehicle, currency, 2)}
              </td>
              <td>{num(cost.marginPercent, 2)}% margin</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}
