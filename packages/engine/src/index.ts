/**
 * @vmq/engine — the computational core of the platform.
 *
 * Requirement 57 requires the simulation engine, the queueing mathematics
 * engine and the manufacturing cost engine to be separable and independently
 * testable. They live in sibling folders here, depend on each other in one
 * direction only, and have no knowledge of HTTP, React or any database:
 *
 *   distributions / rng     no dependencies
 *   model                   types and defaults only
 *   analytical              -> model, distributions          (closed-form maths)
 *   des                     -> model, distributions, rng     (simulation)
 *   cost                    -> model, des                    (prices DES output)
 *   finance                 -> model                         (ROI, payback)
 *   stats                   -> des, cost                     (replications, CI)
 *   optimize                -> all of the above
 *   validation              -> model, analytical
 *
 * Nothing in this package reads or writes files, so every function here can be
 * called from the API server, from a test, or directly in the browser.
 */

/* Randomness and distributions */
export { Rng, RngStreams } from './rng.js';
export {
  sample,
  distMean,
  distVariance,
  distSCV,
  kendallSymbol,
  isMarkovian,
  describeDistribution,
  serviceDistFromRate,
  serviceRatePerHour,
  type Distribution,
  type DistributionKind,
} from './distributions.js';

/* Domain model */
export * from './model/types.js';
export {
  CURRENCIES,
  defaultCostConfig,
  defaultCurrency,
  defaultInvestment,
  defaultSimulationConfig,
  makeCrew,
  makeMachine,
  makeSingleStationModel,
  makeStation,
  makeVehicleModel,
} from './model/defaults.js';
export { buildReferenceModel, REFERENCE_MODEL_ID } from './model/referenceModel.js';

/* Analytical queueing */
export {
  mm1,
  mmc,
  mg1,
  mgc,
  erlangB,
  erlangC,
  solveStation,
  checkLittlesLaw,
  hoursToMinutes,
  minutesToHours,
  type QueueResult,
  type LittlesLawCheck,
} from './analytical/queues.js';
export {
  solveTrafficEquations,
  solveLinearSystem,
  meanExternalLambda,
  type TrafficSolution,
} from './analytical/traffic.js';
export {
  solveNetwork,
  capacityLimit,
  nonPoissonStations,
  stationAvailability,
  type NetworkAnalytic,
  type NetworkOptions,
  type StationAnalytic,
  type SystemAnalytic,
} from './analytical/network.js';
export {
  analyseBottlenecks,
  marginalServerEffect,
  totalWaitPerVehicle,
  theoreticalMinimumCycleMinutes,
  type BottleneckAnalysis,
  type BottleneckStation,
} from './analytical/bottleneck.js';

/* Discrete-event simulation */
export {
  Simulation,
  runSimulation,
  percentileSorted,
  type LiveState,
  type LiveStationState,
  type SimulationResult,
  type StationSimResult,
  type SystemSimResult,
} from './des/simulation.js';
export { EventQueue, type SimEvent, type EventKind } from './des/eventQueue.js';
export {
  createVehicle,
  cycleTimeMinutes,
  timeBreakdown,
  formatClock,
  resetVehicleIds,
  type StationVisit,
  type TimeBreakdown,
  type Vehicle,
  type VehicleStatus,
  type VisitOutcome,
} from './des/vehicle.js';

/* Cost */
export {
  computeCosts,
  expandBom,
  machineDepreciationPerHour,
  stationLaborRatePerHour,
  verifyAdditivity,
  type BomLine,
  type BomSummary,
  type CostLine,
  type CostResult,
  type StationCost,
  type VehicleCost,
} from './cost/costEngine.js';

/* Finance */
export {
  annualise,
  appraiseIncremental,
  paybackPeriod,
  netPresentValue,
  discountedPayback,
  type AnnualEconomics,
  type IncrementalAppraisal,
  type PaybackResult,
} from './finance/investment.js';

/* Statistics */
export {
  runStudy,
  summariseMetric,
  compareMetrics,
  replicationsForPrecision,
  tCritical,
  type MetricSummary,
  type StationMetrics,
  type StudyResult,
  type StudyOptions,
} from './stats/replications.js';

/* Scenarios and optimisation */
export {
  applyScenario,
  compareScenarios,
  describeEdit,
  evaluateScenario,
  type Scenario,
  type ScenarioComparison,
  type ScenarioComparisonRow,
  type ScenarioEdit,
  type ScenarioResult,
} from './optimize/scenarios.js';
export {
  optimize,
  quickWhatIf,
  type Candidate,
  type DecisionVariable,
  type ObjectiveKind,
  type ObjectiveWeights,
  type OptimizationConstraints,
  type OptimizationRequest,
  type OptimizationResult,
} from './optimize/optimizer.js';

/* Validation */
export {
  validateModel,
  collectProvenance,
  type ProvenanceCensus,
  type Severity,
  type ValidationIssue,
  type ValidationReport,
} from './validation/validate.js';

/* Reporting and export */
export { generateReport, buildLimitations, type ReportInput } from './report/report.js';
export {
  buildExportBundle,
  exportBomCsv,
  exportConfigurationJson,
  exportCostBreakdownCsv,
  exportParametersCsv,
  exportQueueMetricsCsv,
  exportReplicationsCsv,
  exportScenarioComparisonCsv,
  exportStationCostCsv,
  exportSummaryStatisticsCsv,
  exportVehicleTracesCsv,
  exportVisitsCsv,
  type ExportBundle,
} from './report/exports.js';

/* Utilities */
export { deepClone } from './util/clone.js';

/* Task 7 — event logs, process discovery and the discovered model */
export {
  parseEventLogCsv,
  eventLogToCsv,
  parseTimestamp,
  splitCsvLine,
  type ColumnMapping,
  type EventRow,
  type ParsedEventLog,
  type ParseOptions,
  type TimeFormat,
} from './discovery/eventLog.js';
export {
  discoverProcess,
  fitDistribution,
  maxOverlap,
  slugify,
  type ActivityStats,
  type DfgEdge,
  type DiscoveredLoop,
  type DiscoveredProcess,
  type DiscoveryAssumption,
  type DiscoverOptions,
  type InterArrivalStats,
  type Trace,
  type Variant,
} from './discovery/discover.js';
export {
  classifyActivity,
  compareObservedToAnalytical,
  discoveredToSystemModel,
  type DiscoveredModelResult,
  type ObservedVsAnalytical,
  type ToModelOptions,
} from './discovery/toModel.js';
export {
  eventLogFromVehicles,
  eventLogCsvFromVehicles,
  type FromSimulationOptions,
} from './discovery/fromSimulation.js';
