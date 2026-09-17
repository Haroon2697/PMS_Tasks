# Acceptance walkthrough (§72)

The brief lists 31 steps that must all work. Each is mapped to where it is done
and what you should see.

| # | Step | Where | What happens |
|---|---|---|---|
| 1 | Open the application | `http://localhost:5173` | Loads with the reference line already in memory — no setup needed |
| 2 | Select the manufacturing system | Settings → Storage → *List stored systems* → *Load* | Or keep the built-in reference line |
| 3 | See the network | **Network Model** | 10 stations, routing arcs with probabilities, rework loop drawn in orange, scrap in red |
| 4 | Edit λ | **System Configuration** → Demand schedule | Five time-of-day blocks; the caption recomputes the time-weighted mean and compares it with capacity |
| 5 | Edit μ | Network Model → click a station → *Mean service time* | The Kendall label, ρ, Lq and Wq at the top of the panel update as you type |
| 6 | Edit server count | Same panel → *Servers (c)* | M/M/2 becomes M/M/3 and the Erlang C solution follows |
| 7 | Edit worker count | Same panel → Workers table | Crew cost per hour recomputes |
| 8 | Edit machine cost | Same panel → Machine | The depreciation formula below the fields shows the new per-hour charge |
| 9 | Edit energy cost | System Configuration → Cost parameters → Electricity price | Feeds the energy line on the cost page |
| 10 | Edit material / BOM cost | **Vehicle Cost / BOM** | Quantity and unit cost are editable inline; the badge flips to USER |
| 11 | Validate the model | **Model Validation** | 7 checks, plus errors/warnings with remedies, plus the full parameter register |
| 12 | Run analytical calculations | Always current — no button | Every analytical figure recomputes from the model on every edit |
| 13 | Run the DES | **Simulation** → *Run simulation* | 10 replications; typically under a second |
| 14 | Watch vehicles move | **Live Factory** → *Start* | Real entities: V-266, V-267… move through stations |
| 15 | Pause / resume | Live Factory transport bar | Pause freezes the clock exactly; *Step event* advances one calendar event |
| 16 | Inspect an individual vehicle | Live Factory → click a queue chip | Opens the vehicle inspector |
| 17 | See its complete history | Inspector → Manufacturing history | Station, visit number, queued-at, queue time, processing, downtime, outcome |
| 18 | See queue lengths | Live Factory, Network Model, Queue Analytics | Live chips; analytical Lq; simulated Lq with CI |
| 19 | See W and Wq | Overview, Queue Analytics, Simulation | Node and system level kept distinct |
| 20 | See L and Lq | Same | Analytical and simulated side by side |
| 21 | See utilisation | Overview, Network, Queue Analytics | Meter plus the exact percentage |
| 22 | See throughput | Overview, Simulation | With a 95% confidence interval after a study |
| 23 | See manufacturing cost | **Manufacturing Cost** | Nine lines with an additivity proof at the bottom |
| 24 | See cost per vehicle | Cost, Vehicle Cost, Financial | Same number, three contexts |
| 25 | See the cost breakdown | Cost → click any line | Formula in words + the inputs that produced it |
| 26 | See bottlenecks | **Bottleneck Analysis** | Capacity bottleneck and delay bottleneck reported separately, each with reasons |
| 27 | Create a new scenario | **Scenario Manager** → *New scenario* | Stores edits, not a model copy |
| 28 | Add a machine | Scenario editor → Change type *Server count* → Paint Shop = 4 | With its capital cost and added opex |
| 29 | Run the simulation again | Scenario Manager → *Run comparison* | Both configurations are re-simulated |
| 30 | Compare scenarios | Comparison table | Every metric with Δ, %Δ and whether the difference survives a Welch t-test |
| 31 | Investment, savings, ROI, payback | Comparison → appraisal tiles + *How the appraisal was computed* | ROI is `null` without capital; payback says NOT ACHIEVED when net benefit ≤ 0 |
| 32 | See the recommended configuration | **Optimization** → *Run optimisation* | Analytical screen → simulated confirmation → ranked table → *Apply this configuration* |
| 33 | Export results | **Reports & Export** | Report (.md) plus 10 CSV/JSON exports |

## Worked example: "What happens if I add a paint booth?"

1. **Bottleneck Analysis** — Paint Shop is rank 1, λ_max = 6.43 veh/h against
   demand of 5.60. The relief preview says a fourth booth raises capacity to
   about 8.57 veh/h and moves the constraint to Final Assembly.
2. **Scenario Manager** — new scenario "Add a paint booth": Paint Shop servers
   = 4, capital 2,400,000, added opex 180,000/year.
3. **Run comparison** against the baseline.
4. Read the result: Wq falls sharply, the bottleneck moves, and the appraisal
   states ROI and payback — or says *NOT ACHIEVED* if the extra capacity earns
   nothing because demand, not capacity, is the binding constraint.

That last case is the interesting one and the model handles it honestly: at 5.60
veh/h against 6.43 veh/h of capacity, extra capacity buys **shorter queues, not
more vehicles**, so the benefit is a waiting-cost saving rather than extra
revenue — and the appraisal shows exactly that.
