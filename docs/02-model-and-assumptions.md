# The model, its mathematics, and its assumptions

## 1. Network topology

The brief (§1) specifies the flow, and the model implements it exactly:

```
Parts / Material Receiving        M/M/2    8 min
  → Body Manufacturing            M/M/3   22 min
  → Body Shop                     M/M/3   24 min
  → Paint Shop                    M/M/3   28 min   ← bottleneck
  → Powertrain Installation       M/M/3   25 min
  → Interior Installation         M/M/3   20 min
  → Electrical Installation       M/M/2   16 min
  → Final Assembly                M/E2/4  30 min
  → Quality Inspection            M/M/2   12 min
        ├─ 88%  → Finished Vehicle
        ├─ 10%  → Rework  M/M/1  35 min  → back to Quality Inspection
        └─  2%  → Scrapped
```

The brief states the topology must follow the project's approved network
diagram "once provided". That diagram was not available, so the brief's own
stated flow is used. **The topology is data, not code**: stations, arcs and
probabilities are all editable in the UI, so adopting the approved diagram is a
configuration change.

## 2. Mathematics

### 2.1 Traffic equations (§7)

External λ is defined at exactly one place — the entry station. Everything else
is solved:

```
λ = r + Pᵀλ      ⟹      (I − Pᵀ) λ = r
```

`r` holds external arrivals; `P` is the routing matrix. The inspection → rework
→ inspection loop makes `P` cyclic, so this is genuinely solved (Gaussian
elimination with partial pivoting), not accumulated in topological order.

The closed-form consequence, which the tests assert: with fail probability *p*,
inspection is visited `1/(1−p)` times per vehicle and rework `p/(1−p)` times.
At *p* = 0.10 that is 1.111 and 0.111 — which is why inspection's λ (6.22/h)
exceeds the external rate (5.60/h).

### 2.2 Queueing models (§8)

| Configuration | Model used | Exact? |
|---|---|---|
| Exponential service, c = 1 | M/M/1 closed form | Yes |
| Exponential service, c > 1 | **Erlang C**, computed from the Erlang B recursion for numerical stability | Yes |
| General service, c = 1 | Pollaczek-Khinchine: `Lq = ρ²(1+Cs²) / 2(1−ρ)` | Yes |
| General service, c > 1 | Allen-Cunneen approximation | **No** — flagged |

M/M/c is never solved with the M/M/1 formulae; a test asserts the two give
materially different answers for the same load.

### 2.3 When a closed-form result is NOT exact

A node's M/M/c result is exact only if its arrivals are genuinely Poisson.
Burke's theorem gives that for exponential-service stations fed by a Poisson
stream, and Jackson's theorem extends it to Markovian routing with feedback.
But one non-exponential station breaks it for everything downstream.

In this model Final Assembly is Erlang-2, so **Quality Inspection and Rework are
M/M/c by their own service times but do not see Poisson arrivals**. The engine
detects this (`nonPoissonStations()`) and marks them `exact: false`. Measured:
inspection's true Lq is about 13% *shorter* than its M/M/2 formula predicts,
because Erlang-2 output is smoother than Poisson.

### 2.4 Node vs system metrics (§10)

```
NODE:    L_j = λ_j · W_j        λ_j includes repeat visits
SYSTEM:  L   = Σ L_j
         W   = L / λ_external   ← the EXTERNAL rate, not Σλ_j
```

Dividing by Σλ_j would count a reworked vehicle as several vehicles. The Queue
Analytics page shows both numbers side by side so the error is concrete rather
than theoretical.

## 3. Simulation methodology

Next-event time advance. The clock jumps from one scheduled event to the next
via a binary min-heap event calendar; nothing is stepped on a fixed tick.

Events: `ARRIVAL`, `SERVICE_COMPLETE`, `BREAKDOWN`, `REPAIR_COMPLETE`,
`WARMUP_END`, `END_OF_HORIZON`. Queue entry/exit, resource acquisition,
inspection, rework routing and scrap are state transitions at the same instant
as the event that causes them.

**Determinism.** Every draw comes from a named substream derived from the master
seed (`service:paint_shop`, `routing:inspection`, `failure:paint_shop:1`, …), so
changing one station's parameters does not shift the random numbers consumed
elsewhere — the common-random-numbers setup. Simultaneous events fire in
scheduling order. Same model + same seed ⟹ identical results, asserted by test.

**Measurement window.** Time-weighted statistics (L, Lq, utilisation) accumulate
only within `[warmup, warmup+duration]` and are clamped at the horizon.
Throughput and cost are computed over the **arrival cohort** — vehicles that
entered during the window, followed to completion however long it takes. This
avoids two errors: counting departures that belong to pre-warm-up arrivals, and
censoring vehicles that finish during a drain.

## 4. Data provenance (§46, §47, §60)

> **Every numeric default in this model is a PROJECT ASSUMPTION.**
> None is sourced from any real manufacturer. None should be quoted as an
> industry figure.

They are internally consistent and produce an instructive factory — a plausible
bottleneck, a realistic rework loop, a positive but not absurd margin — which is
what makes the model useful for *comparing configurations against each other*.
They are not a description of any real plant.

The application enforces this rather than just documenting it:

- every `Param` carries `{value, unit, provenance, source?, notes?}`;
- the Model Validation page lists all ~120 parameters with their provenance;
- the validator emits a standing note while zero parameters are source-backed;
- editing any parameter re-labels it `USER_INPUT`;
- the generated report reproduces the whole register and repeats the warning.

To make a parameter defensible: replace its value, set `provenance:
'SOURCE_BACKED'` and fill in `source`. The badge and the report change
automatically.

### Modelling assumptions recorded in the model

1. The line is compressed to ten stations. A real vehicle plant has hundreds of
   workstations and a few thousand operators, so labour cost per vehicle here is
   **lower** than published whole-plant figures.
2. Service is exponential except Final Assembly (Erlang-2), because paced line
   work has lower variability than a memoryless service time.
3. Transport time between stations is zero — a vehicle joins the next queue at
   the instant it leaves the previous station. Conveyor time would add a
   constant to cycle time without changing queueing behaviour.
4. Queues are unbounded by default, so no station blocks its upstream
   neighbour. Setting a finite buffer turns excess arrivals into rejections
   rather than modelling blocking.
5. Machine failure is preemptive-resume: work already done is preserved.
6. MTBF is measured in **operating** hours, so a machine only ages while
   processing.
7. Labour is charged on a scheduled basis — crews are paid for the shift whether
   busy or idle — and idle labour cost is reported separately.

## 5. Known limitations

- **No upstream blocking.** Finite buffers reject rather than block.
- **No transport/conveyor time.**
- **No shift patterns or breaks** — the line runs continuously within its
  horizon.
- **No labour flexibility** — crews are fixed to stations.
- **Analytical results assume machines never fail.** Where reliability is
  enabled, closed-form figures understate queues. `solveNetwork(..., {
  adjustForAvailability: true })` de-rates μ by A = MTBF/(MTBF+MTTR) to close
  most of the gap, and says that it remains an approximation.
- **A single vehicle model** in the default configuration, though the engine
  supports a mix with per-model BOM and price.

## 6. References

- Gross, Shortle, Thompson & Harris, *Fundamentals of Queueing Theory*, 4th ed.,
  Wiley — M/M/1 (ch. 2), M/M/c and Erlang C (ch. 2.3), Pollaczek-Khinchine
  (ch. 5.1).
- Law, *Simulation Modeling and Analysis*, 5th ed., McGraw-Hill — next-event
  time advance, warm-up, independent replications, common random numbers.
- Jackson, "Jobshop-like Queueing Systems", *Management Science* 10(1), 1963.
- Allen, *Probability, Statistics and Queueing Theory*, 2nd ed. — Allen-Cunneen
  approximation.
- Marsaglia & Tsang, "A Simple Method for Generating Gamma Variables",
  *ACM TOMS* 26(3), 2000.

These are cited for **method**, not for parameter values.
