# Tasks 6 and 7 — Cost Optimization, and Process Discovery from Event Traces

This iteration extends ProcessFlow. Tasks 1–4 (manufacturing model, queue
network, queueing mathematics, simulation) were already in place and were not
rebuilt.

---

## Task 6 — Cost Optimization

Most of Task 6 was already implemented in the existing cost engine. This
iteration audited it against the requirement and closed the gaps.

### Already present

| Requirement | Where |
|---|---|
| Material, labour, machine, energy, maintenance, quality, rework, scrap, waiting, overhead | `packages/engine/src/cost/costEngine.ts` — nine additive lines plus waiting/WIP reported separately |
| Configurable, marked Project Assumption vs Source-based | `Param{value, unit, provenance, source, notes}`; badges throughout the UI; full register on **Model Validation** |
| Vehicle BOM, `Component Cost = Quantity × Unit Cost` | `expandBom()`; editable on **Vehicle Cost / BOM** |
| Machine running cost, `Energy = Power × Time × Price` | per-station computation in the cost engine; machine cost kept strictly separate from labour |
| Change configuration → re-run → compare | **Scenario Manager**, **Optimization** |
| Throughput, W, Wq, L, Lq, utilisation, total cost, cost/vehicle, revenue, profit, ROI, payback, bottleneck | `compareScenarios()` rows + the appraisal block |
| ROI and payback, "Not achieved" when net benefit ≤ 0 | `finance/investment.ts` |

### Gaps closed in this iteration

1. **Per-vehicle cost breakdown.** The requirement says *"The user must be able
   to select a manufactured vehicle and see its complete cost breakdown."* The
   vehicle inspector previously showed only time. It now leads with the headline
   the brief asks for — **"this vehicle took X and cost Y"** — followed by a
   seven-line breakdown (material, labour, machine, energy, maintenance, rework,
   overhead) with each line's share and the basis it was attributed on.
   *`apps/web/src/components/LiveFactory.tsx` → `VehicleInspector`.*

2. **Operating hours and worker headcount as decisions.** The requirement lists
   *number of workers* and *operating hours* among the things a user may change.
   The engine supported worker edits but the scenario editor did not expose
   them, and operating hours were not a scenario edit at all. Added
   `operatingHours` and `operatingDays` edit kinds, and surfaced worker headcount
   in the editor. Operating hours change no queue — they change how the measured
   window annualises, and therefore revenue, ROI and payback.
   *`packages/engine/src/optimize/scenarios.ts`, `apps/web/src/pages/Scenarios.tsx`.*

### The accounting rule worth knowing

The nine cost lines **partition** the total — they do not overlap. An
inspector's wages are in *quality*, not in both *labour* and *quality*; rework
material is in *rework*, not in both *material* and *rework*. `verifyAdditivity()`
proves it and the **Manufacturing Cost** page shows the proof. Waiting cost and
the full value destroyed by scrap sit *outside* the total, because they either
overlap it or are not costs the plant pays to build a vehicle.

---

## Task 7 — Process Discovery through Event Traces

New in this iteration. Flow:

```
Event Log  →  Process Discovery  →  Queue Model  →  Simulation  →  Results
```

### Engine — `packages/engine/src/discovery/`

| File | Responsibility |
|---|---|
| `eventLog.ts` | CSV parsing: synonym-matched columns, four time formats, midnight unwrapping, per-row rejection reporting |
| `discover.ts` | The mining itself: activities, directly-follows graph, routing probabilities, loops, variants, inter-arrival and service statistics, server estimation, distribution fitting |
| `toModel.ts` | Discovered process → executable `SystemModel`, plus the observed/analytical comparison |
| `fromSimulation.ts` | Simulation traces → event log, which is what makes discovery testable |

### What is derived from the log

Activities · process order · routing probabilities · inter-arrival times ·
service times and their variability · waiting times · activity frequency ·
repeated activities · rework loops · λ per activity · μ per activity ·
bottleneck · path variants · observed utilisation.

### What the log genuinely cannot tell you

Two things, both surfaced as **editable assumptions with the reason attached**
rather than quietly defaulted:

- **Server count.** A log never records capacity. It is estimated as the
  *maximum observed concurrency* — the most executions of that activity running
  at the same instant. That is a **lower bound**: a station with four bays that
  never had more than two cars in it looks like a two-bay station. This is the
  single most important thing a user corrects after discovery, so it is editable
  directly in the assumptions table.

- **Distribution family.** A log gives a sample, not a family. The family is
  fitted from the coefficient of variation of the observed durations —
  CV ≈ 0 → **D**, CV < 1 → **Erlang-k** with *k = 1/CV²*, CV ≈ 1 → **M**,
  CV > 1 → **G**. Principled, but still an inference, and labelled as one.

Also assumed and stated: queue discipline (FIFO — a log records when work ran,
not how it was selected) and all **cost parameters**, which are inherited from
the active model because an event log contains no prices.

### Three kinds of number, never mixed

The **Discovered Model → Observed vs analytical vs simulated** tab puts them in
three labelled column groups:

- **Observed** — what the log recorded, one finite sample of the real process.
- **Analytical** — steady-state queueing theory on the fitted parameters
  (M/M/c via Erlang C, never the M/M/1 formulae; M/G/c flagged approximate).
- **Simulated** — a discrete-event run of the discovered model.

They are expected to differ, and the page says why: a large observed-vs-analytical
gap usually means the real arrivals were burstier than the fitted process, or
that the server estimate is too low.

### How Task 7 connects back to Task 6

The discovered model is an ordinary `SystemModel`, so it inherits the cost
engine. A vehicle simulated through a *discovered* process reports **"took 3.0 h,
cost $14,263.97"** with the same nine-line breakdown as any other vehicle.
**"Use this as the active model"** loads it into the rest of ProcessFlow, so
Overview, Live Factory, Manufacturing Cost, Bottleneck Analysis, Scenario
Manager and Optimization all begin operating on the mined process.

---

## Verification

`npm test` — **228 tests**, of which 62 are new for this iteration.

### The round trip

The strongest check on discovery is that it can recover a process it generated
itself. `tests/discovery.test.ts` runs the reference line with known parameters,
exports the event log it produced, re-discovers a model from that log, and
compares:

| Property | Result |
|---|---|
| Activity set and process order | recovered exactly |
| Mean service time per station | within sampling error (tolerance = 3 standard errors, scaled per station) |
| Inspection failure probability (true 10%) | recovered within 2 percentage points |
| Arrival rate | recovered within 8% |
| Exponential stations | CV ≈ 1 → fitted **M** |
| Erlang-2 station | CV ≈ 0.707 → fitted **E2** |
| Inspection/rework loop | detected |
| Server estimate | ≤ true server count at every station, as a lower bound must be |
| Throughput of the rebuilt model | within 10% of the original |

### Observed in the running application

Generating a log from the reference line (217 cases, 2,009 events) and mining it
back recovered all ten activities in the correct order, Quality Inspection at
**1.129 visits per case** (the rework loop), a CV of **0.738** at Final Assembly
against a true Erlang-2 value of 0.707, and **Paint Shop** as the highest-utilisation
activity — which is the real bottleneck of that model.

---

## New pages

Added under a **Process Mining** group in the existing navigation. No existing
page was changed except the vehicle inspector, which gained its cost breakdown.

| Page | Purpose |
|---|---|
| **Event Log Import** | Drag-drop / file / paste CSV; the brief's example; or generate a log from the current model. Reports the column mapping, time format, origin, and every rejected row with its reason. |
| **Process Discovery** | Activities, directly-follows graph, loops, variants, arrival process, observed utilisation and waiting time — and the editable assumptions table. |
| **Discovered Model** | The generated queue model with λ, μ, c, Kendall, ρ, W, Wq, L, Lq; the three-way comparison; a live simulation with full transport controls; and vehicle traces with costs. |
