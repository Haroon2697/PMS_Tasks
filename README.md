# ProcessFlow — Automotive Manufacturing Queueing & Process Mining

A queueing-theory, discrete-event-simulation, manufacturing-cost, optimisation
and process-mining platform for a vehicle assembly line.

# PMS_Tasks

Built up over iterations, each extending the same product:

| Iteration | What it added |
|---|---|
| **Tasks 1-4** | Manufacturing model, queue network, queueing mathematics, discrete-event simulation |
| **Task 6** | Cost model, cost optimisation, ROI and payback |
| **Task 7** | Event log → process discovery → discovered queue model → simulation |

Everything the application displays comes from one of four places, and it always
says which: a **closed-form queueing solution**, a **discrete-event simulation
run**, a **stated assumption**, or a value **derived** from those. There are no
hardcoded KPIs and no animations pretending to be a simulation.

---

## Quick start

```bash
npm install          # workspaces: engine, api, web
npm run build:engine # the API and web app consume the built engine

npm run dev:api      # http://localhost:5177  — persistence (optional)
npm run dev:web      # http://localhost:5173  — the application

npm test             # 228 engine tests
```

The web app works **without** the API server — simulation, analysis, costing,
optimisation and report generation all run in the browser. The server adds
persistence for systems, scenarios, runs and reports.

---

## What is actually implemented

### A real discrete-event simulation

Next-event time advance over a binary-heap event calendar. Events: arrival,
service completion, machine breakdown, repair completion, warm-up end, end of
horizon. Vehicles are entities with a full per-station history — queue time,
processing time, downtime, rework loops, resource usage — recoverable for any
individual vehicle.

Deterministic on a seed. Each stochastic source draws from its own named
substream, so changing one station's parameters does not shift the random
numbers consumed elsewhere.

### A queueing-mathematics engine

- **M/M/1** closed form.
- **M/M/c** via **Erlang C** (computed from the Erlang B recursion, so it stays
  stable at large *c*). Never the M/M/1 formulae with a scaled μ.
- **M/G/1** via Pollaczek-Khinchine; **M/G/c** via Allen-Cunneen, explicitly
  flagged as an approximation.
- **Traffic equations** solved as a linear system, because the rework feedback
  loop makes the routing matrix cyclic.
- **Stability**: ρ ≥ 1 returns infinite queue metrics and an UNSTABLE label,
  never a finite-looking number.
- **Exactness tracking**: a node fed by a non-exponential station upstream does
  not see Poisson arrivals, so its closed-form result is marked approximate even
  though the node itself is M/M/c.

### A manufacturing cost engine

Nine cost lines that **partition** the total — `verifyAdditivity()` proves it,
and a test asserts it. An inspector's wages appear in *quality*, not in both
*labour* and *quality*; rework material appears in *rework*, not in both
*material* and *rework*. Waiting cost and the full value destroyed by scrap are
reported **outside** the total, because they overlap it or are not costs the
plant pays to build a vehicle.

Every line carries its formula in words and the inputs that produced it.

### Process discovery from event traces

Import a CSV event log — `CaseID, Activity, Start, Complete` — and the system
mines the process that produced it: activities, order, routing probabilities,
inter-arrival and service times, waiting times, repeated activities, rework
loops, per-activity λ and μ, and the bottleneck. The result becomes an
executable `SystemModel`, so a discovered process is solved by the same
analytical engine, run by the same simulator and priced by the same cost engine
as a hand-built one.

Two things a log genuinely cannot determine are surfaced as **editable
assumptions with the reason attached**, never quietly defaulted:

- **server count** — estimated as maximum observed concurrency, which is a
  *lower bound* on real capacity;
- **distribution family** — fitted from the coefficient of variation of the
  observed durations (CV ≈ 0 → D, CV < 1 → Erlang-k with k = 1/CV², CV ≈ 1 → M,
  CV > 1 → G).

Observed, analytical and simulated figures appear in three separately labelled
column groups, because they answer three different questions.

### Validated against known results

`npm test` runs 228 tests. The important ones check the simulator against
systems whose exact answers are known, and check that process discovery can
recover a model it generated itself:

| Case | Expected | Result |
|---|---|---|
| M/M/1, λ=2/h, μ=3/h | ρ=2/3, L=2, Lq=4/3, W=1h, Wq=2/3h | matched within sampling error |
| M/M/2, λ=4/h, μ=3/h | Erlang C solution | matched |
| M/D/1 | exactly half the M/M/1 queue | matched |
| Little's Law | L = λW on *measured* quantities | holds |
| MTBF/MTTR | observed availability | matched |
| **Discovery round trip** | simulate a known model, export its event log, re-discover it | activities, order, routing probabilities, rates, distribution families and the rework loop all recovered |

---

## Architecture

```
packages/engine/          Pure TypeScript. No I/O, no DOM, no HTTP, no database.
  rng.ts                  Seeded generator with named substreams
  distributions.ts        Distributions + their Kendall symbols and moments
  model/                  Domain types; the reference line
  analytical/             Queueing maths, traffic equations, bottlenecks
  des/                    Event calendar, vehicle entity, the simulator
  cost/                   BOM, labour, machine, energy, maintenance, scrap
  finance/                Annualisation, ROI, payback, NPV
  stats/                  Replications, confidence intervals, Welch t-test
  optimize/               Scenarios and the configuration optimiser
  validation/             Model + input validation, provenance census
  discovery/              Event-log parsing, process mining, discovered model
  report/                 Report generation and CSV export

apps/api/                 Express + SQLite. Validates, calls the engine, persists.
                          Contains no queueing maths and no cost formulas.

apps/web/                 React + Vite. Imports the engine directly and runs the
                          live simulation in the browser, so the animation is
                          driven by real simulation state.
```

The engine is testable with no HTTP, no DOM and no database — which is why the
228 tests run in about 40 seconds.

**Why the browser runs the engine:** the live factory view needs to step the
simulation event by event and stay synchronised with it. Round-tripping every
event through HTTP would make that impossible to keep smooth. The server owns
what the browser cannot: durable storage and long multi-replication studies.

---

## The honest caveats

**Every numeric default is a PROJECT ASSUMPTION.** No parameter in this model is
sourced from a real manufacturer, and the application says so on the Model
Validation page and in every generated report. They are internally consistent
and produce an instructive factory, which makes the model useful for comparing
configurations against each other — not for quoting as industry data. Replace
any value and it is re-labelled automatically.

**The approved network diagram was not available.** The topology implemented is
the one written out in §1 of the brief. It is configuration, not code.

Further detail: [`docs/02-model-and-assumptions.md`](docs/02-model-and-assumptions.md).

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/01-requirements-traceability.md`](docs/01-requirements-traceability.md) | All 74 requirements → implementation → test |
| [`docs/02-model-and-assumptions.md`](docs/02-model-and-assumptions.md) | Topology, mathematics, methodology, assumptions, limitations, references |
| [`docs/03-acceptance-walkthrough.md`](docs/03-acceptance-walkthrough.md) | The §72 acceptance workflow, step by step |
| [`docs/04-task6-task7.md`](docs/04-task6-task7.md) | **This iteration**: Task 6 cost optimisation and Task 7 process discovery |

---

## Pages

**Operations** — Overview, Live Factory, Simulation
**Model** — System Configuration, Network Model, Model Validation
**Analysis** — Queue Analytics, Bottleneck Analysis
**Economics** — Manufacturing Cost, Vehicle Cost / BOM, Financial Analysis
**Decisions** — Scenario Manager, Cost Optimization
**Process Mining** — Event Log Import, Process Discovery, Discovered Model
**Output** — Reports & Export, Settings

---

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/systems` | List stored systems |
| `POST` | `/api/systems/seed-reference` | Load the reference line |
| `GET` | `/api/systems/:id/analytical` | Closed-form network solution |
| `GET` | `/api/systems/:id/bottlenecks` | Bottleneck analysis |
| `GET` | `/api/systems/:id/validate` | Validation report |
| `POST` | `/api/systems/:id/run` | Replication study (persisted) |
| `GET` | `/api/runs/:runId/vehicles/:vehicleId` | One vehicle's full history |
| `POST` | `/api/systems/:id/compare` | Compare two scenarios |
| `POST` | `/api/systems/:id/optimize` | Configuration optimisation |
| `POST` | `/api/systems/:id/report` | Generate and store a report |
| `POST` | `/api/systems/:id/export` | CSV/JSON export bundle |

A study of the default model takes roughly 50 ms on the server.
