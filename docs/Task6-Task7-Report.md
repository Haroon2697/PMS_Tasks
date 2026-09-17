# ProcessFlow — Tasks 6 & 7

**Cost Optimization · Process Discovery through Event Traces**
Automotive manufacturing queueing + process-mining system.

> Every figure in this report is computed by the system. None is typed in by hand.
> This iteration **extends** the existing application — Tasks 1–4 (manufacturing model,
> queue network, queueing mathematics, discrete-event simulation) were already in place
> and were not rebuilt. Verification: **228 automated tests, all passing.**

---

## Task 6 — Cost Optimization

### The cost model

Cost is not treated as salaries alone. Ten categories are modelled: **direct material** (BOM,
traced through each vehicle's actual route), **direct labour** (headcount × wage × hours, by
worker class, with overtime), **machine** (depreciation + consumables per operating hour),
**energy**, **maintenance** (preventive + corrective), **quality/inspection**, **rework**,
**scrap**, **overhead** and **waiting/WIP**.

The nine additive lines **partition** the total — an inspector's wages are in *quality*, not in
both *labour* and *quality*; rework material is in *rework*, not also in *material*. The
application proves it on screen: sum of lines **3,150,175.01** vs reported total
**3,150,175.01**, discrepancy **0.00000000**. Waiting cost and the full scrap loss sit
*outside* the total — waiting is an opportunity cost the plant never pays to build a vehicle,
and the full scrap loss overlaps labour and machine that were paid regardless.

Every parameter carries a provenance label — **PROJECT ASSUMPTION** or **SOURCE-BACKED** — and
is editable. All current defaults are project assumptions, and the system says so rather than
presenting them as industry data.

### Vehicle BOM and cost per vehicle

The BOM is configurable (20 components: steel, aluminium, paint, engine, transmission,
exhaust, seats, trim, glazing, harness, ECU, battery, tyres, wheels, brakes, suspension,
lighting, fluids, weld consumables, rework kit).

```
Component Cost     = Quantity × (1 + scrap allowance) × Unit Cost
Material / vehicle = Σ Component Cost = 12,703.86
```

Complete manufacturing cost over one 40-hour measurement window (212 vehicles completed).
Across 10 replications the mean cost per vehicle is **14,830.84** with a 95% confidence
interval of **14,690.29 – 14,971.40**; the single run below is shown because it is the one
whose line-by-line detail the application displays:

| Cost line | Total | Per vehicle | Share |
|---|---:|---:|---:|
| Direct material | 2,693,218.32 | **12,703.86** | 85.5% |
| Direct labour | 100,800.00 | 475.47 | 3.2% |
| Machine (depreciation + consumables) | 42,090.05 | 198.54 | 1.3% |
| Energy | 11,708.62 | 55.23 | 0.4% |
| Maintenance | 28,480.01 | 134.34 | 0.9% |
| Quality / inspection | 8,565.56 | 40.40 | 0.3% |
| Rework | 9,793.15 | 46.19 | 0.3% |
| Scrap (material written off) | 63,519.30 | 299.62 | 2.0% |
| Allocated overhead | 192,000.00 | 905.66 | 6.1% |
| **TOTAL** | **3,150,175.01** | **14,859.32** | 100% |

Reported separately: queue waiting cost **15,102.95**, total value destroyed by scrap
**68,445.78**. Energy use is **667.8 kWh/vehicle** (**56.76** at the configured tariff).

**Selecting an individual vehicle** shows its own breakdown. First-pass vehicle **V-55**:
180.8 min, **14,212.58**. Reworked vehicle **V-56**: 357.6 min, **15,207.80** — the same
material, but +230.27 labour, +92.39 machine, +29.96 energy, +109.44 maintenance and
533.15 of rework. It costs **995.22 more and takes twice as long**, computed from its actual
route rather than an average.

### Machine running cost

Each machine carries purchase price, useful life, salvage value, annual operating hours,
running and idle power, maintenance rate, consumables rate and optional MTBF/MTTR.

```
Depreciation / hour = (Purchase price − Salvage) / (Useful life × Annual operating hours)
Energy Cost         = Power (kW) × Operating Time (hours) × Electricity Price
```

Machine cost is strictly separate from labour, and maintenance is kept out of the machine line
so it is never double-counted.

### Cost optimization — change the configuration, re-run, compare

The user can change machines/servers, worker headcount, service rate, operating hours per day,
operating days per year, routing probabilities, prices and demand, then re-run. Nothing is
extrapolated: **both configurations are fully re-simulated.**

**Scenario: add a fourth paint booth** (Paint Shop is the bottleneck at 87.1% utilisation).

| Metric | Current | + 4th booth | Change | Significant? |
|---|---:|---:|---:|:--:|
| Throughput (veh/h) | 5.365 | 5.365 | 0.000 | no |
| Manufacturing time W (min) | 302.4 | 273.8 | **−28.6 (−9.5%)** | **yes** |
| Waiting time Wq (min) | 111.1 | 82.7 | **−28.3 (−25.5%)** | **yes** |
| Queue Lq (vehicles) | 9.87 | 7.49 | **−2.38 (−24.1%)** | **yes** |
| Cost per vehicle | 14,830.84 | 14,841.99 | +11.15 | no |
| Factory capacity (veh/h) | 6.429 | 7.200 | +0.771 | — |
| Bottleneck | Paint Shop | **Powertrain Installation** | moved | — |

"Significant?" is a Welch t-test on the replication means: a difference smaller than the
sampling noise is reported as *not significant* rather than as an improvement.

### ROI and payback

```
Revenue            = Completed Vehicles × Selling Price
Profit             = Revenue − Total Cost
Annual Net Benefit = Annual profit improvement − Additional annual operating cost
Payback Period     = Initial Investment / Annual Net Benefit
```

Annualised on the plant calendar — 250 days × 8 h = **2,000 production hours/year** — not on
8,760 calendar hours.

| | **A: booth at current demand (5.6 veh/h)** | **B: booth at +25% demand (7.0 veh/h)** |
|---|---:|---:|
| Initial investment | 2,400,000 | 2,400,000 |
| Additional annual operating cost | 180,000 | 180,000 |
| Stability without the booth | stable | **UNSTABLE** (7.0 > capacity 6.43) |
| Waiting time Wq | 111.1 → 82.7 min | 353.4 → 248.5 min (−29.7%) |
| Annual net benefit | **−83,330** | **+357,882** |
| ROI | −3.47% | **14.91% / year** |
| **Payback** | **NOT ACHIEVED** | **6.71 years (80.5 months)** |

The same investment fails in one case and pays back in the other, and the system produces both
answers from the simulation. In case A it refuses to report a payback that does not exist: at
5.6 veh/h against 6.43 veh/h of capacity, extra capacity buys **shorter queues, not more
vehicles**, so throughput is unchanged and there is no extra revenue to repay the capital.

---

## Task 7 — Process Discovery through Event Traces

```
Event Log  →  Process Discovery  →  Queue Model  →  Simulation  →  Results
```

### Input

CSV with case id, activity, start and completion time (`V001,Body Shop,08:00,08:15`). Column
names are matched by synonym (`case_id`, `task`, `begin`, `finish` all work); four time formats
are supported; clock times crossing midnight are unwrapped; every unusable row is listed with
its reason rather than discarded silently.

### What is derived from the traces

Activities · process order · routing probabilities · inter-arrival times · service times and
their variability · waiting times · activity frequency · repeated activities · rework loops ·
λ and μ per activity · bottleneck · path variants · observed utilisation. Routing comes from a
**directly-follows graph**; activity order from a breadth-first walk of it ignoring loop-backs.
Result on a **217-case, 2,009-event** log:

| Activity | Exec. | Visits/case | Service mean | CV | Servers (est.) | Utilisation |
|---|---:|---:|---:|---:|:--:|---:|
| Parts / Material Receiving | 217 | 1.000 | 8.23 | 0.978 | 2 | 32.1% |
| Body Manufacturing | 217 | 1.000 | 20.82 | 1.004 | 3 | 54.2% |
| Body Shop | 217 | 1.000 | 25.12 | 0.972 | 3 | 65.3% |
| **Paint Shop** | 217 | 1.000 | 29.62 | 1.054 | 3 | **77.0%** |
| Powertrain Installation | 217 | 1.000 | 23.69 | 1.122 | 3 | 61.6% |
| Interior Installation | 217 | 1.000 | 19.68 | 0.922 | 3 | 51.2% |
| Electrical Installation | 217 | 1.000 | 15.11 | 0.998 | 2 | 58.9% |
| Final Assembly | 217 | 1.000 | 29.59 | **0.738** | 4 | 57.7% |
| **Quality Inspection** | **245** | **1.129** | 10.67 | 0.930 | 2 | 47.0% |
| **Rework** | **28** | **0.129** | 48.30 | 0.969 | 1 | 48.6% |

λ = **5.439 cases/hour** (mean gap 11.03 min, CV 0.953 → fitted **M**). Observed cycle time:
mean 282.3 min, median 273.5, p95 435.3. **Feedback loop detected:** `Quality Inspection ⇄
Rework` in **12.4%** of cases — inspection runs 245 times for 217 cases, i.e. **1.129 visits
per case**. Discovered failure probability **11.43%**.

### What the log cannot determine — stated, not hidden

Two things are surfaced as **editable assumptions with the reason attached**:

1. **Number of servers.** No log records capacity. Estimated as *maximum observed concurrency*
   — the most executions running at the same instant. This is a **lower bound**: a four-bay
   station never fully busy looks like a two-bay station.
2. **Distribution family.** A log gives a sample, not a family. Fitted from the coefficient of
   variation: CV ≈ 0 → **D**, CV < 1 → **Erlang-k** with *k* = 1/CV², CV ≈ 1 → **M**, CV > 1 → **G**.

Also assumed and stated: **FIFO discipline** (a log records when work ran, not how it was
selected) and **all cost parameters**, inherited from the active model because a log has no prices.

### The discovered queue model

M/M/c is solved with **Erlang C**, never with the M/M/1 formulae; M/G/c is flagged approximate.

| Process | Kendall | c | λ (veh/h) | ρ | Lq | Wq (min) |
|---|:--:|:--:|---:|---:|---:|---:|
| Parts / Material Receiving | M/M/2 | 2 | 5.439 | 37.3% | 0.120 | 1.33 |
| Body Manufacturing | M/M/3 | 3 | 5.439 | 62.9% | 0.667 | 7.36 |
| Body Shop | M/M/3 | 3 | 5.439 | 75.9% | 1.834 | 20.23 |
| Paint Shop | M/M/3 | 3 | 5.439 | 89.5% | 6.896 | 76.07 |
| Powertrain Installation | M/M/3 | 3 | 5.439 | 71.6% | 1.301 | 14.35 |
| Interior Installation | M/M/3 | 3 | 5.439 | 59.5% | 0.511 | 5.64 |
| Electrical Installation | M/M/2 | 2 | 5.439 | 68.5% | 1.210 | 13.35 |
| Final Assembly | **M/E2/4** | 4 | 5.439 | 67.1% | 0.587 | 6.47 |
| Quality Inspection | M/M/2 | 2 | **6.141** | 54.6% | 0.464 | 4.54 |

Two details matter. **Final Assembly is M/E2/4, not M/M/4** — its CV of 0.738 is close to
1/√2, the signature of an Erlang-2 process, so the notation follows the data. **Quality
Inspection's λ = 6.141 exceeds the external arrival rate of 5.439**, because the rework loop
sends vehicles back through it; that rate is solved from the traffic equations, not assumed.

**Observed, analytical and simulated** figures are shown in three separately labelled column
groups, because they answer different questions — what the log recorded, what steady-state
theory predicts, and what a discrete-event run produces. The application explains why they
differ rather than implying one is "the" answer.

### Simulating the discovered model

The discovered model is an ordinary executable model, so it runs on the same simulator as any
hand-built one, with Start / Pause / Resume / Stop / Reset / Step-event / speed / seed /
duration controls and vehicles visibly moving through the mined queues.

Simulated: throughput **5.475 veh/h** (original 5.300), W **292.0 min**, Wq **102.3 min**,
L **26.16**, cost per vehicle **14,492.98** (original 14,859.32).

Every vehicle reports ID, arrival, processes visited, queue entry, service start and
completion, waiting, processing, rework, cycle time, cost and status — connecting Task 7 back
to Task 6:

> **Vehicle V-78** — took **3.0 hours** and cost **$14,263.97** to manufacture.
> 9 processes visited · 48.2 min waiting · 2.2 h processing · 0 rework · FINISHED.

### Validation — the round trip

Discovery is checked by a **round trip**: simulate a model whose parameters are known exactly,
export the event log it produces, re-discover a model from that log, and compare. All ten
activities were recovered in the correct order; the inspection failure probability (true 10%)
came back as **11.43%**; the arrival rate (true 5.6 veh/h) as **5.439**; Paint Shop's service
mean (true 28 min) as **29.62**; exponential stations returned CV 0.92–1.12 → fitted **M**, and
the Erlang-2 station CV 0.738 against a true 0.707 → fitted **E2**; the Inspection ⇄ Rework loop
was detected; the **server-count estimates matched the true counts exactly** (2,3,3,3,3,3,2,4,2,1);
and the rebuilt model reproduced throughput to within 3.3% (5.475 vs 5.300 veh/h).

---

## Integration, assumptions, and demonstration

**Integration.** These are not separate demos. **"Use this as the active model"** loads a
discovered process into the rest of ProcessFlow, after which Overview, Live Factory,
Manufacturing Cost, Bottleneck Analysis, Scenario Manager and Optimization all operate on the
mined process. New pages were added under a **Process Mining** group; no existing feature was
removed, and the only change to an existing screen was adding the cost breakdown to the vehicle
inspector.

**Assumptions and limitations.** Every numeric default is a **PROJECT ASSUMPTION** — none is
sourced from a real manufacturer. The values are internally consistent and produce a plausible
factory, which makes the model useful for comparing configurations against each other, not for
quoting as industry data. The line is compressed to ten stations, so labour cost per vehicle is
below published whole-plant figures. Transport time is zero and queues are unbounded, so no
station blocks its upstream neighbour. Analytical results assume servers never fail, so where
breakdowns are enabled the closed-form figures understate queues — and the application says so.
Discovery assumes a sequential process; overlapping activities in a case raise a warning.

**How to demonstrate.** *Task 6* — Manufacturing Cost → Vehicle Cost / BOM (select a vehicle,
see its full cost) → Scenario Manager (add a paint booth with its capital cost, run the
comparison, read throughput / W / Wq / L / Lq / utilisation / cost / profit / ROI / payback /
bottleneck) → raise demand, re-run, and watch the payback verdict flip. *Task 7* — Event Log
Import → Process Discovery → Discovered Model (λ, μ, Kendall, ρ, W, Wq, L, Lq) → Simulate →
Vehicle traces.
