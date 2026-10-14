/**
 * Investment appraisal — requirements 31 and 32.
 *
 * The two rules this file exists to enforce:
 *
 *  1. ROI is undefined without an explicit investment. Requirement 31 forbids
 *     "a vague ROI formula without defining the investment", so every function
 *     here takes the capital outlay as a required input and returns null
 *     rather than inventing a denominator.
 *
 *  2. An investment that never recovers its cost has NO payback period.
 *     Requirement 32 is explicit: if annual net benefit <= 0, payback is
 *     "Not achieved". Dividing by a negative benefit yields a negative number
 *     of years, which looks like a fast payback if rendered carelessly — that
 *     is exactly the error being guarded against here.
 *
 * ANNUALISATION. Simulation results cover a measurement window of minutes.
 * They are scaled to a year by the plant calendar
 * (operating days/year x production hours/day), not by multiplying the window
 * out to 8,760 hours, because a plant that runs one shift a day does not
 * produce around the clock.
 */

import type { InvestmentSpec } from '../model/types.js';

/** One scenario's operating economics, normalised to a year. */
export interface AnnualEconomics {
  /** Hours of production per year. */
  annualProductionHours: number;
  vehiclesPerYear: number;
  revenuePerYear: number;
  manufacturingCostPerYear: number;
  profitPerYear: number;
  /** Waiting cost, reported separately from manufacturing cost. */
  waitingCostPerYear: number;
  costPerVehicle: number;
  profitPerVehicle: number;
}

/**
 * Scale a measurement window to a year using the plant calendar.
 */
export function annualise(
  perWindow: {
    windowHours: number;
    vehiclesFinished: number;
    revenue: number;
    manufacturingCost: number;
    waitingCost: number;
  },
  investment: InvestmentSpec,
): AnnualEconomics {
  const annualProductionHours =
    investment.operatingDaysPerYear.value * investment.hoursPerDay.value;
  const scale = perWindow.windowHours > 0 ? annualProductionHours / perWindow.windowHours : 0;

  const vehiclesPerYear = perWindow.vehiclesFinished * scale;
  const revenuePerYear = perWindow.revenue * scale;
  const manufacturingCostPerYear = perWindow.manufacturingCost * scale;
  const waitingCostPerYear = perWindow.waitingCost * scale;

  return {
    annualProductionHours,
    vehiclesPerYear,
    revenuePerYear,
    manufacturingCostPerYear,
    profitPerYear: revenuePerYear - manufacturingCostPerYear,
    waitingCostPerYear,
    costPerVehicle:
      perWindow.vehiclesFinished > 0 ? perWindow.manufacturingCost / perWindow.vehiclesFinished : 0,
    profitPerVehicle:
      perWindow.vehiclesFinished > 0
        ? (perWindow.revenue - perWindow.manufacturingCost) / perWindow.vehiclesFinished
        : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Incremental appraisal                                               */
/* ------------------------------------------------------------------ */

export interface PaybackResult {
  /** Years to recover the outlay, or null when it is never recovered. */
  years: number | null;
  months: number | null;
  achieved: boolean;
  /** Shown verbatim in the UI when `achieved` is false. */
  message: string;
}

/**
 * Payback period (requirement 32):
 *
 *   annual net benefit = annual savings - additional annual operating cost
 *   payback years      = initial investment / annual net benefit
 *
 * Returns "Not achieved" when the net benefit is zero or negative.
 */
export function paybackPeriod(
  initialInvestment: number,
  annualNetBenefit: number,
): PaybackResult {
  if (initialInvestment <= 0) {
    return {
      years: 0,
      months: 0,
      achieved: true,
      message:
        'No capital outlay, so there is nothing to pay back. Any net benefit is immediate.',
    };
  }
  if (annualNetBenefit <= 0) {
    return {
      years: null,
      months: null,
      achieved: false,
      message:
        'Payback: NOT ACHIEVED. The annual net benefit is zero or negative, so the investment ' +
        'never recovers its cost and no payback period exists. (Dividing by a negative benefit ' +
        'would produce a negative number of years, which must not be presented as a fast payback.)',
    };
  }
  const years = initialInvestment / annualNetBenefit;
  return {
    years,
    months: years * 12,
    achieved: true,
    message: `Recovered in ${years.toFixed(2)} years (${(years * 12).toFixed(1)} months).`,
  };
}

export interface IncrementalAppraisal {
  /* The two states being compared. */
  baseline: AnnualEconomics;
  proposed: AnnualEconomics;

  /* Capital and operating deltas. */
  initialInvestment: number;
  additionalAnnualOperatingCost: number;

  /** Extra throughput the change buys, vehicles/year. */
  additionalVehiclesPerYear: number;
  /** Extra revenue from that throughput, currency/year. */
  additionalRevenuePerYear: number;
  /**
   * Reduction in annual manufacturing cost. Negative means the proposal costs
   * MORE to run, which is normal when capacity is added.
   */
  manufacturingCostSavingPerYear: number;
  /** Reduction in annual waiting cost — a real benefit, tracked separately. */
  waitingCostSavingPerYear: number;
  /** Change in cost per vehicle. Negative = cheaper per unit. */
  costPerVehicleChange: number;

  /** Total annual benefit before the extra operating cost. */
  annualGrossBenefit: number;
  /** annualGrossBenefit - additionalAnnualOperatingCost */
  annualNetBenefit: number;

  /** netBenefit / investment, as a percentage. null when there is no outlay. */
  roiPercent: number | null;
  /** Simple ROI over the asset's assumed life. */
  payback: PaybackResult;

  /** Plain-language derivation for the report (requirement 66). */
  workings: string[];
}

export interface AppraisalOptions {
  /**
   * Whether reduced waiting cost counts as a benefit. It is an opportunity
   * cost rather than cash, so it is included by default but can be excluded
   * for a strictly cash-based appraisal.
   */
  includeWaitingCostBenefit?: boolean;
}

/**
 * Compare a proposed configuration against a baseline and appraise the change.
 *
 * The benefit has three components, all of which matter and any of which can be
 * negative:
 *   - extra PROFIT on extra volume (more vehicles sold),
 *   - lower manufacturing cost on the volume already produced,
 *   - lower waiting/WIP cost.
 *
 * Adding capacity usually RAISES total manufacturing cost while LOWERING cost
 * per vehicle. Appraising on total cost alone would reject every capacity
 * investment, so the profit-based formulation below is what is used.
 */
export function appraiseIncremental(
  baseline: AnnualEconomics,
  proposed: AnnualEconomics,
  spec: {
    initialInvestment: number;
    additionalAnnualOperatingCost: number;
  },
  options: AppraisalOptions = {},
): IncrementalAppraisal {
  const includeWaiting = options.includeWaitingCostBenefit ?? true;

  const additionalVehiclesPerYear = proposed.vehiclesPerYear - baseline.vehiclesPerYear;
  const additionalRevenuePerYear = proposed.revenuePerYear - baseline.revenuePerYear;
  const manufacturingCostSavingPerYear =
    baseline.manufacturingCostPerYear - proposed.manufacturingCostPerYear;
  const waitingCostSavingPerYear = baseline.waitingCostPerYear - proposed.waitingCostPerYear;
  const costPerVehicleChange = proposed.costPerVehicle - baseline.costPerVehicle;

  // Profit improvement already nets revenue against manufacturing cost, so
  // adding the cost saving on top of it would double count.
  const profitImprovement = proposed.profitPerYear - baseline.profitPerYear;
  const annualGrossBenefit = profitImprovement + (includeWaiting ? waitingCostSavingPerYear : 0);
  const annualNetBenefit = annualGrossBenefit - spec.additionalAnnualOperatingCost;

  const roiPercent =
    spec.initialInvestment > 0 ? (annualNetBenefit / spec.initialInvestment) * 100 : null;

  const payback = paybackPeriod(spec.initialInvestment, annualNetBenefit);

  const workings = [
    `Annual production hours = operating days/year x hours/day = ${baseline.annualProductionHours.toFixed(0)} h.`,
    `Baseline: ${baseline.vehiclesPerYear.toFixed(0)} vehicles/year, profit ${baseline.profitPerYear.toFixed(0)}/year, ` +
      `cost/vehicle ${baseline.costPerVehicle.toFixed(2)}.`,
    `Proposed: ${proposed.vehiclesPerYear.toFixed(0)} vehicles/year, profit ${proposed.profitPerYear.toFixed(0)}/year, ` +
      `cost/vehicle ${proposed.costPerVehicle.toFixed(2)}.`,
    `Profit improvement = ${proposed.profitPerYear.toFixed(0)} - ${baseline.profitPerYear.toFixed(0)} = ${profitImprovement.toFixed(0)}/year.`,
    includeWaiting
      ? `Waiting cost saving = ${baseline.waitingCostPerYear.toFixed(0)} - ${proposed.waitingCostPerYear.toFixed(0)} = ${waitingCostSavingPerYear.toFixed(0)}/year (opportunity cost, not cash).`
      : 'Waiting cost saving excluded from the benefit (cash-only appraisal).',
    `Annual gross benefit = ${annualGrossBenefit.toFixed(0)}/year.`,
    `Less additional annual operating cost ${spec.additionalAnnualOperatingCost.toFixed(0)} => ` +
      `annual NET benefit = ${annualNetBenefit.toFixed(0)}/year.`,
    spec.initialInvestment > 0
      ? `ROI = net benefit / initial investment = ${annualNetBenefit.toFixed(0)} / ${spec.initialInvestment.toFixed(0)} = ${(roiPercent as number).toFixed(2)}% per year.`
      : 'ROI is not defined: no capital investment was specified for this change.',
    payback.message,
  ];

  return {
    baseline,
    proposed,
    initialInvestment: spec.initialInvestment,
    additionalAnnualOperatingCost: spec.additionalAnnualOperatingCost,
    additionalVehiclesPerYear,
    additionalRevenuePerYear,
    manufacturingCostSavingPerYear,
    waitingCostSavingPerYear,
    costPerVehicleChange,
    annualGrossBenefit,
    annualNetBenefit,
    roiPercent,
    payback,
    workings,
  };
}

/**
 * Net present value of a constant annual net benefit over `years`, at
 * `discountRate` (e.g. 0.10). Offered alongside simple payback because simple
 * payback ignores the time value of money and anything after the payback date.
 */
export function netPresentValue(
  initialInvestment: number,
  annualNetBenefit: number,
  years: number,
  discountRate: number,
): number {
  if (discountRate <= -1) throw new Error('netPresentValue: discount rate must be > -1');
  let npv = -initialInvestment;
  for (let t = 1; t <= years; t++) {
    npv += annualNetBenefit / Math.pow(1 + discountRate, t);
  }
  return npv;
}

/**
 * Discounted payback: the year in which cumulative discounted benefit first
 * covers the outlay. Returns null when it never does within `maxYears`.
 */
export function discountedPayback(
  initialInvestment: number,
  annualNetBenefit: number,
  discountRate: number,
  maxYears = 50,
): number | null {
  if (initialInvestment <= 0) return 0;
  if (annualNetBenefit <= 0) return null;
  let cumulative = 0;
  for (let t = 1; t <= maxYears; t++) {
    const pv = annualNetBenefit / Math.pow(1 + discountRate, t);
    if (cumulative + pv >= initialInvestment) {
      const shortfall = initialInvestment - cumulative;
      return t - 1 + shortfall / pv;
    }
    cumulative += pv;
  }
  return null;
}
