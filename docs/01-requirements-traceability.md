# Requirements traceability matrix

Every numbered requirement from the brief, where it is implemented, and how it
is verified. "Test" names the automated test that proves it; "Manual" means it
is verified by using the application.

Test suite: `packages/engine/tests/` — 166 tests, all passing.

| # | Requirement | Implementation | Verification |
|---|---|---|---|
| 1 | Core objective — vehicle flows through a process network | `packages/engine/src/model/referenceModel.ts` (10 stations, inspection/rework loop, scrap sink) | `analytical.test.ts` › traffic equations; `simulation.test.ts` › "visits the stations in the order the routing specifies" |
| 2 | **Real DES with event calendar, deterministic on a seed** | `des/simulation.ts`, `des/eventQueue.ts` (binary min-heap keyed on (time, seq)), `rng.ts` (named substreams) | `simulation.test.ts` › "reproducibility" — identical results on repeat, different on a new seed, and stepping event-by-event equals running straight through |
| 3 | **Vehicle is a real entity with full history** | `des/vehicle.ts` — `Vehicle` with `visits[]`, per-station wait/processing/downtime, rework and inspection counts, resource usage | `simulation.test.ts` › "vehicle lifecycle"; visible in the UI via the vehicle inspector |
| 4 | Configurable manufacturing stations | `model/types.ts` `Station`; UI: Station panel | Manual — Network Model page |
| 5 | Per-process parameters (λ, μ, distribution, servers, workers, costs, probabilities) | `model/types.ts`; `components/StationPanel.tsx` | Manual; `cost.test.ts` › machine and labour rates |
| 6 | **Kendall notation matches the actual model** | `distributions.ts` `kendallSymbol()`; `analytical/queues.ts` derives the label from the configured distribution | `analytical.test.ts` › "Kendall notation follows the configured distribution" — asserts a deterministic station is labelled M/D/1, not M/M/1 |
| 7 | **External λ only at entry; internal rates derived** | `analytical/traffic.ts` — solves λ = r + Pᵀλ by Gaussian elimination with partial pivoting | `analytical.test.ts` › "derives internal rates rather than assigning lambda everywhere", "matches the closed form for a single rework loop" |
| 8 | **M/M/1, M/M/c (Erlang C), correct model per station** | `analytical/queues.ts` — `mm1`, `mmc` (Erlang B→C recursion), `mg1` (Pollaczek-Khinchine), `mgc` (Allen-Cunneen, flagged approximate) | `analytical.test.ts` › "M/M/c uses Erlang C, not the M/M/1 formulae" — explicitly asserts the two differ materially |
| 9 | **Stability check, ρ ≥ 1 → UNSTABLE** | `analytical/queues.ts` `UNSTABLE()` returns Infinity, never a number | `analytical.test.ts` › "stability" |
| 10 | **Little's Law; node vs system metrics distinct** | `analytical/queues.ts` `checkLittlesLaw`; `analytical/network.ts` (system W divides by λ_external) | `analytical.test.ts` › "keeps node and system metrics distinct"; UI: Queue Analytics → Little's Law tab checks it live on both analytical and simulated numbers |
| 11 | Simulation metrics (W, Wq, L, Lq, throughput, utilisation, idle/busy, completed/scrapped/reworked, WIP) | `des/simulation.ts` `StationSimResult`, `SystemSimResult` | `simulation.test.ts` throughout |
| 12 | **Cycle time: mean, median, p95, max, and its components** | `des/simulation.ts` `cycleTime`, `timeSplit`; `des/vehicle.ts` `timeBreakdown` | `simulation.test.ts` › "cycle-time distribution" — asserts the components sum to the mean |
| 13 | Comprehensive cost model, not just wages | `cost/costEngine.ts` — nine additive lines | `cost.test.ts` › "cost additivity" |
| 14 | **Bill of materials** | `model/types.ts` `BomComponent`; `cost/costEngine.ts` `expandBom` | `cost.test.ts` › "bill of materials" — qty × (1+allowance) × unit cost |
| 15 | **Cost per vehicle, all nine categories** | `cost/costEngine.ts` — strict partition, no double counting | `cost.test.ts` › "produces all nine required lines", "excludes inspection and rework stations from the production labour line" |
| 16 | Labour modelled separately, by role, with overtime and idle time | `cost/costEngine.ts` `stationLaborRatePerHour`; `WorkerCrew` | `cost.test.ts` › "applies an overtime premium only when the day exceeds the shift" |
| 17 | Machine cost distinct from labour | `MachineSpec`; `machineDepreciationPerHour` | `cost.test.ts` › "computes straight-line depreciation per operating hour" |
| 18 | Machine running cost (energy + maintenance + consumables + depreciation) | `cost/costEngine.ts` per-station computation | `cost.test.ts` › "keeps maintenance out of the machine line" |
| 19 | **Machine breakdowns (MTBF/MTTR), optional** | `des/simulation.ts` `onBreakdown` / `onRepairComplete`, preemptive-resume, failure clock on operating time | `simulation.test.ts` › "machine breakdowns" — asserts observed availability ≈ MTBF/(MTBF+MTTR) and that queues lengthen |
| 20 | **Energy cost** | `cost/costEngine.ts` — power×busy + idlePower×(idle+down), × price | `cost.test.ts` › "energy cost" — verifies the formula per station and linearity in price |
| 21 | Maintenance: preventive and corrective | `cost/costEngine.ts` maintenance line | `cost.test.ts` › "keeps maintenance out of the machine line" |
| 22 | **Rework cost, incremental** | Rework stations are their own cost bucket; rework material is a BOM line consumed at the rework station, charged per visit | `cost.test.ts` › "charges rework material once per rework visit, not per vehicle", "charges a reworked vehicle more than an identical first-pass vehicle" |
| 23 | **Scrap cost — only what was actually consumed** | `cost/costEngine.ts` traces each scrapped vehicle's visits; `scrapAnalysis` separates material (additive) from conversion (overlapping) | `cost.test.ts` › "charges scrapped vehicles only for material they actually consumed" |
| 24 | Inventory and WIP | `SystemSimResult.L`, `maxWIP`, `totalWipVehicleHours`; WIP holding cost | `simulation.test.ts`; UI Overview |
| 25 | **Waiting cost, kept out of manufacturing cost** | `cost/costEngine.ts` `waitingCost` reported separately | `cost.test.ts` › "waiting cost is kept out of manufacturing cost" |
| 26 | Overhead, fixed vs variable kept distinct | `CostConfig.overhead` with `perHour`/`perVehicle` modes and an itemised breakdown | `cost.test.ts` additivity; validator warns when the breakdown disagrees with the total |
| 27 | Factory-level cost totals | `CostResult.lines` + `totalManufacturingCost` | `cost.test.ts` |
| 28 | Unit economics | `CostResult` per-vehicle fields | `cost.test.ts` › "revenue, profit and margin" |
| 29 | Revenue = N × P, per vehicle model | `cost/costEngine.ts` sums each finished vehicle's model price | `cost.test.ts` › "does not count scrapped vehicles as revenue" |
| 30 | Profit, per vehicle / hour / year | `CostResult`, `finance/investment.ts` `annualise` | `cost.test.ts` › "profit = revenue − total manufacturing cost" |
| 31 | **ROI with an explicitly defined investment** | `finance/investment.ts` `appraiseIncremental` — returns `null` ROI when no capital is committed | `cost.test.ts` › "returns null ROI when no capital is committed", "does not double count the cost saving on top of the profit improvement" |
| 32 | **Payback period; "Not achieved" when benefit ≤ 0** | `finance/investment.ts` `paybackPeriod` | `cost.test.ts` › "payback period" — including "never returns a negative payback period" |
| 33 | What-if questions | `optimize/optimizer.ts`, `optimize/scenarios.ts`, `quickWhatIf` | `cost.test.ts` › optimiser; UI: Scenario Manager, Optimization |
| 34 | Optimisation objectives and constraints | `optimize/optimizer.ts` — 9 objectives, 8 constraint types | `cost.test.ts` › "ranks by the objective it was asked to optimise", "reports infeasibility instead of returning a violating configuration" |
| 35 | **Scenario comparison** | `optimize/scenarios.ts` `compareScenarios` with Welch t-test significance | `cost.test.ts` › "compares two scenarios and appraises the difference" |
| 36 | **Time-of-day demand that really changes the arrival process** | `des/simulation.ts` `rateAt` / `nextArrivalTime` — memoryless re-draw at block boundaries | `simulation.test.ts` › "time-of-day demand" — observed λ matches the time-weighted schedule mean |
| 37 | **Interactive network diagram** | `apps/web/src/components/NetworkDiagram.tsx` + `StationPanel.tsx` | Manual — verified in-browser; clicking a node opens its editor |
| 38 | **Live simulation with start/pause/resume/stop/reset/step/speed** | `components/LiveFactory.tsx` — owns a real `Simulation`, advances via `runUntil` | Manual — browser-verified: pause freezes the clock exactly, step advances one event |
| 39 | **Queue visualisation** | `LiveFactoryView` — queue chips, per-server busy/down state with progress, congestion label | Manual |
| 40 | Operations dashboard | `pages/Overview.tsx` | Manual |
| 41 | Cost dashboard with drill-down | `pages/Cost.tsx` — every line opens its formula and inputs | Manual |
| 42 | **Bottleneck dashboard, not threshold-based** | `analytical/bottleneck.ts` — λ_max = c·μ/V ranking, delay share, marginal server value | `cost.test.ts` › "identifies the capacity bottleneck from lambda_max, not a threshold", "values an extra server at a non-binding station at zero throughput gain" |
| 43 | **Analytical vs simulation with error and explanation** | `pages/Simulation.tsx` Compare tab; `analytical/network.ts` `nonPoissonStations` | `simulation.test.ts` › "network simulation vs analytical decomposition" |
| 44 | **Replications, confidence intervals** | `stats/replications.ts` — Student's t, independent derived seeds | `cost.test.ts` › "uses Student t, not the normal, for small samples", "refuses to invent an interval from a single observation" |
| 45 | **Warm-up period** | `des/simulation.ts` `WARMUP_END` resets all statistics | `simulation.test.ts` › "removes the empty-start bias, averaged over independent replications" |
| 46 | **Parameter provenance metadata** | `model/types.ts` `Param{value,unit,provenance,source,notes}`; `validation/validate.ts` `collectProvenance` | `cost.test.ts` › "records the provenance of every parameter"; UI: Model Validation → Parameter register |
| 47 | Research requirement | See `docs/02-model-and-assumptions.md` § Data provenance. **No parameter is claimed as sourced.** All defaults are marked `PROJECT_ASSUMPTION` | Enforced by the validator, which emits an explicit note when zero parameters are source-backed |
| 48 | **Transparent, traceable cost model** | `CostLine.formula` + `CostLine.inputs` + `verifyAdditivity()` | `cost.test.ts` › "the nine lines sum exactly to the reported total", "every line carries a formula and inputs" |
| 49 | Parameter editor | `pages/Misc.tsx` (SystemConfig), `components/StationPanel.tsx` | Manual |
| 50 | **Model validation report** | `validation/validate.ts` — checks + warnings | `cost.test.ts` › "model validation" |
| 51 | **Input validation with meaningful errors** | `validation/validate.ts` errors; `NumberField` inline validation | `cost.test.ts` › "rejects non-positive lambda and mu", "rejects server counts below 1", "rejects negative costs and invalid probabilities" |
| 52 | Explicit units everywhere | `Param.unit`; `lib/format.ts`; every table header names its unit | Manual |
| 53 | Currency selectable | `CurrencySettings`; Settings page | Manual — no silent conversion; the UI states this |
| 54 | **Report generation** | `report/report.ts` — all 17 sections, with generated (not boilerplate) Limitations | Manual — Reports page |
| 55 | **Export** | `report/exports.ts` — 10 CSV/JSON exports with units in headers | Manual |
| 56 | **Database persistence** | `apps/api/src/db.ts` (SQLite schema), `repository.ts` | Verified by exercising the API end-to-end |
| 57 | **Separated architecture** | `packages/engine` (no I/O), `apps/api` (no maths), `apps/web` (no maths) | Engine tests run with no HTTP, no DOM and no database |
| 58 | Automated tests | `packages/engine/tests/` — 166 tests | `npm test` |
| 59 | **Simulation validated against analytical results** | `simulation.test.ts` — M/M/1 (λ=2, μ=3 → L=2, Lq=4/3, W=1h, Wq=2/3h), M/M/c vs Erlang C, M/D/1 vs P-K | All passing within stated sampling tolerance |
| 60 | **No fake results** | `Kpi` requires a `basis` prop; unfinished vehicles have `null` cycle time; single-replication results say so; stale runs are flagged | Enforced by the type system (`basis` is required) |
| 61 | Professional UI | `apps/web/src/styles.css` — hairline rules, tabular figures, no gradients | Manual |
| 62 | 15-page structure | `apps/web/src/App.tsx` | All 15 verified rendering without error |
| 63 | Overview page | `pages/Overview.tsx` | Manual |
| 64 | Live factory page | `pages/Misc.tsx` → `LiveFactoryPage` | Manual |
| 65 | Vehicle cost / BOM page | `pages/VehicleCost.tsx` | Manual |
| 66 | Financial analysis with explanations | `pages/Financial.tsx` — every row shows its derivation | Manual |
| 67 | What-if analysis | `optimize/optimizer.ts` `quickWhatIf`; Scenario editor | `cost.test.ts` › scenarios |
| 68 | Optimisation example (add an inspection machine) | `pages/Optimization.tsx` — capital, opex, ΔWq, Δthroughput, ROI, payback, recommendation | `cost.test.ts` › optimiser |
| 69 | Decision-support questions | Bottleneck (where/why), `capacityLimit` (how many), cycle time (how long), cost engine (how much), appraisal (payback) | Covered by the above |
| 70 | Phased build | Built engine → cost → optimisation → API → UI, testing at each stage | Commit history |
| 71 | Don't over-engineer v1 | Mathematical core built and validated (166 tests) before any UI existed | — |
| 72 | **Final acceptance workflow** | See `docs/03-acceptance-walkthrough.md` | Each step traced to a page |
| 73 | Analysis before coding | This document; `docs/02-model-and-assumptions.md` | — |
| 74 | Priority order | Correctness first: the engine and its 166 tests were complete and green before the first UI file was written | — |

## Requirements not fully satisfied

**§47 (research-backed parameters) is deliberately unmet, and is reported as
unmet inside the application.** No numeric default in this model is backed by a
citable source; every one is marked `PROJECT_ASSUMPTION`, and the validator
emits a standing note saying so. Fabricating plausible-looking figures and
labelling them as industry data would have satisfied the letter of §47 while
violating §46 and §60, which are the stronger requirements. The parameter
register makes each value editable and re-labels it the moment you change it.

**§1 (approved network diagram) uses the brief's own stated topology.** The
approved diagram was not available. The topology in §1 of the brief is
implemented instead, and it is configuration rather than code — re-pointing the
model at a different network is an edit in the UI, not a change to the engine.
