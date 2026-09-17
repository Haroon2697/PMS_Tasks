# ProcessFlow — How to Use It, and How to Demo It

A practical guide. Every step below was clicked through and verified.

---

## 1. Starting the app

Open a terminal in the `NEW2` folder:

```bash
npm install            # first time only
npm run build:engine   # first time, and after any engine change

npm run dev:api        # terminal 1 → http://localhost:5177   (saving; optional)
npm run dev:web        # terminal 2 → http://localhost:5173   (the app)
```

Open **http://localhost:5173** in your browser.

> The app works **without** the API server. Simulation, costing, discovery and reports all
> run in the browser. The API only adds saving of systems, scenarios and runs.
> If it is off you will see *"Local only"* in the top-right — that is fine for a demo.

**Before the demo:** run `npm test` once and let them see **228 tests pass**. It takes 40 seconds
and it is the strongest opening you have.

---

## 2. The screen

Left side = menu, grouped into 7 sections. Top-right = three status lights:

| Light | Meaning |
|---|---|
| `Model valid` / `N warnings` | Is the model OK to run? |
| `No run` / `Run current` / `Run is stale` | Do the simulated numbers still match the model? |
| `Saved storage` / `Local only` | Is the API server running? |

**"Run is stale"** appears when you change something after a run. It is deliberate — the app
will not show you old numbers pretending they are current.

### What each page is for

| Group | Page | Use it to… |
|---|---|---|
| Operations | **Overview** | See the whole factory at a glance |
| | **Live Factory** | Watch cars move through the line |
| | **Simulation** | Run the model, see results + confidence intervals |
| Model | **System Configuration** | Set **λ (demand)**, prices, overhead |
| | **Network Model** | See the network; **click a station to set c, μ, routing** |
| | **Model Validation** | Errors, warnings, and every parameter's source |
| Analysis | **Queue Analytics** | λ, μ, ρ, W, Wq, L, Lq per queue + Little's Law |
| | **Bottleneck Analysis** | Where the bottleneck is **and why** |
| Economics | **Manufacturing Cost** | The 9 cost lines and how each is calculated |
| | **Vehicle Cost / BOM** | The bill of materials; cost of one car |
| | **Financial Analysis** | Revenue, profit, ROI, payback |
| Decisions | **Scenario Manager** | Compare two configurations |
| | **Cost Optimization** | Let the system search for the best configuration |
| Process Mining | **Event Log Import** | Upload the CSV (Task 7) |
| | **Process Discovery** | What was mined from the file |
| | **Discovered Model** | The queue model built from the data + simulate it |
| Output | **Reports & Export** | Generate the report, download CSVs |

---

## 3. The three things you will be asked to do

### Change λ (arrival rate)

`System Configuration` → **Demand schedule** tab → type in any **λ** box.

There are 5 time blocks. This is the **only** place λ is entered. The caption under the table
recalculates immediately:

> `Time-weighted average λ = 5.600 veh/h against a factory capacity of 6.429 veh/h`

Change block 1 from 5 to 9 and it becomes `6.400`. If λ goes above capacity, a red warning
appears saying the factory cannot keep up.

### Change c (number of servers) for a queue

`Network Model` → **click any station box** → panel opens on the right → **Servers (c)**.

Everything updates as you type. Set Paint Shop from 3 to 5 and watch the top of the panel:

```
Kendall notation   M/M/3   →   M/M/5
Utilisation ρ      99.6%   →   59.7%
```

In the same panel you can also change **mean service time (μ)**, the **distribution**, the
**queue discipline**, **workers**, **machine cost**, **power**, and **MTBF/MTTR**.

### Run the simulation

`Simulation` → set seed / replications / warm-up / duration → **Run simulation**.

Takes about 1 second. Three tabs appear: **Results**, **Analytical vs simulation**,
**Replications**.

---

## 4. DEMO SCRIPT — Task 6 (Cost Optimization) · about 6 minutes

### Step 1 — Show that cost is more than salaries *(1 min)*

Go to **Manufacturing Cost**.

> "Cost is not just wages. There are nine categories, and they add up exactly to the total."

Point at the table (material, labour, machine, energy, maintenance, quality, rework, scrap,
overhead) and then at the line underneath:

> `Additivity check: sum of lines 3,150,175.01 vs reported total 3,150,175.01 — discrepancy 0.00000000`

> "The inspector's wages are in *quality*, not counted again in *labour*. Nothing is
> double-counted, and the app proves it rather than claiming it."

**Click any cost line** → a panel opens with the formula in words and the numbers that fed it.

### Step 2 — Cost of one specific car *(1 min)*

Go to **Vehicle Cost / BOM**.

> "This is the bill of materials — 20 components. Component cost = quantity × (1 + scrap
> allowance) × unit cost. Every price is marked **ASSUMPTION**, because I did not invent
> real industry prices."

Scroll down to **Individual vehicles** → **click one row**.

> "This car took *X* minutes and cost *Y*. And a car that needed rework costs about **995 more**
> and takes **twice as long** — because the cost follows its actual route, not an average."

### Step 3 — Change the configuration and compare *(3 min)*

Go to **Scenario Manager** → **New scenario**.

1. Name: `Add a 4th paint booth`
2. Initial investment: `2400000`
3. Additional annual operating cost: `180000`
4. Change type: **Machines / servers** → Station: **Paint Shop** → New value: `4`
5. Click **Add change** → the row appears: *Paint Shop: 4 servers*
6. Click **Save scenario**

Then in **Compare two scenarios**: Baseline = `Current factory`, Proposed =
`Add a 4th paint booth` → **Run comparison**.

> "Both configurations are fully re-simulated. Nothing is estimated."

Read the table out:

| Metric | Current | + 4th booth | Significant? |
|---|---:|---:|:--:|
| Waiting time Wq | 111.1 min | 82.7 min | **yes (−25.5%)** |
| Manufacturing time W | 302.4 min | 273.8 min | **yes (−9.5%)** |
| Throughput | 5.365 | 5.365 | no |
| Bottleneck | Paint Shop | **Powertrain** | moved |

> "Notice the **Significant?** column — that is a statistical test. A change smaller than the
> random noise is reported as *not significant*, not as an improvement."

### Step 4 — The best moment: ROI and payback *(1 min)*

Point at the four tiles:

```
Capital required     $2,400,000
Annual net benefit   -$83,330
ROI                  -3.5% per year
Payback              NOT ACHIEVED
```

> "The system says **do not buy it** — and it explains why. We already produce enough cars.
> A fourth booth only makes the queue shorter, not longer production. No extra cars sold
> means no extra money to repay the 2.4 million. So the payback is *not achieved*, and the
> app refuses to print a payback period that does not exist."

**Then flip it.** Make two more scenarios:

- `Demand +25%` → one change: **Scale demand** = `1.25`
- `Demand +25% + booth` → two changes: **Scale demand** = `1.25`, and **Machines / servers**,
  Paint Shop = `4`. Investment `2400000`, opex `180000`.

Compare those two:

```
Without the booth    UNSTABLE  (demand 7.0 > capacity 6.43)
Annual net benefit   +$357,882
ROI                  14.91% per year
Payback              6.71 years (80.5 months)
```

> "Same machine, same price — but now it pays back. Because now the factory genuinely cannot
> keep up without it. The system worked out both answers from the simulation."

**Optional:** `Cost Optimization` → give Paint Shop a range of 3–5 servers, pick an objective,
press **Run optimisation** → it searches configurations itself and recommends one.

---

## 5. DEMO SCRIPT — Task 7 (Process Discovery) · about 5 minutes

### Step 1 — Load an event log *(1 min)*

Go to **Event Log Import**.

Three ways — for a demo the third is best:
- **Choose a file** — upload your own CSV
- **Load the example from the brief** — the small 4-station example
- **Generate from the current model** ← *use this*

> "I will generate a log from the factory, so afterwards we can check whether the discovery
> got the right answer — because we already know what the real answer is."

Click **Generate from the current model**. You get roughly:

```
Cases 217    Events 2,009    Activities 10    Span 1.9 d
```

Scroll down and show **How the file was interpreted** (which column matched which field, time
format, time origin) and the parsed events table.

> "It does not just display the CSV. And if any row is broken, it lists it with the reason —
> nothing is dropped silently."

### Step 2 — Discover the process *(2 min)*

Click **Discover the process →**.

Show the **Discovered activities** table:

> "It found the stations by itself, and put them in the right order — from the data, not from
> me. Look at **Quality Inspection**: 245 executions for only 217 cars. That is **1.129 visits
> per car**. That is the rework loop, found from the data."

Scroll to **Loops and rework**:

> `Quality Inspection ⇄ Rework — 12.4% of cases`

Scroll to **Assumptions — what the log could NOT determine**:

> "This is the honest part. A log **never** records how many machines a station has. So the
> system estimates it from how many cars were being worked on at the same moment — and it tells
> you that is a **lower bound**, and lets you change it right here."

### Step 3 — The discovered queue model *(1 min)*

Click **Build the queueing model →**.

Show the network diagram, then the queue table:

| Process | Kendall | c | λ | ρ | Lq | Wq |
|---|:--:|:--:|---:|---:|---:|---:|
| Paint Shop | M/M/3 | 3 | 5.439 | 89.5% | 6.896 | 76.07 |
| Final Assembly | **M/E2/4** | 4 | 5.439 | 67.1% | 0.587 | 6.47 |
| Quality Inspection | M/M/2 | 2 | **6.141** | 54.6% | 0.464 | 4.54 |

Two things to point out:

> "**Final Assembly is M/E2/4, not M/M/4.** The system measured the variability in the data and
> found it matches an Erlang-2 process, so the notation follows the data."

> "**Quality Inspection's λ is 6.141 — higher than the 5.439 arriving at the factory.** That is
> the rework loop sending cars back through it. That number is solved from the traffic
> equations, not typed in."

Open the **Observed vs analytical vs simulated** tab:

> "Three separate columns, because they answer three different questions: what the log
> recorded, what queueing theory predicts, and what the simulation produces."

### Step 4 — Simulate what was discovered *(1 min)*

**Simulate** tab → **Run simulation** → results appear. Then press **Start** and let the cars
move.

> "This is not an animation. It is the real simulation — if I press **Pause** the clock stops,
> and **Step event** moves forward by exactly one event."

**Vehicle traces** tab → **click any car**:

> **"Vehicle V-78 — took 3.0 hours and cost $14,263.97 to manufacture."**

> "And this is where the two tasks join. This car went through a process that was *discovered
> from data*, but it is priced by the Task 6 cost engine. Full history, full cost breakdown."

### Step 5 — Close the loop *(30 s)*

Click **Use this as the active model**.

> "Now the discovered factory becomes the live model. Overview, Cost, Bottleneck, Scenarios —
> everything now works on the process that was mined from the file. It is one product, not two
> separate demos."

---

## 6. Questions they may ask

**"Are these real prices?"**
No, and the app says so. Every value is labelled **PROJECT ASSUMPTION**. Model Validation lists
all ~120 parameters with their source. Making up prices and calling them industry data would be
worse than admitting they are assumptions.

**"Is the simulation real?"**
Yes. It is a next-event discrete-event simulation with an event calendar. Same seed = identical
results. Pause freezes the clock; Step event advances exactly one event. `npm test` checks it
against textbook answers: M/M/1 with λ=2, μ=3 gives L=2, Lq=4/3, W=1h, Wq=2/3h.

**"Why is the analytical number different from the simulated one?"**
Three reasons, and the app names which applies to each station: sampling error of a finite run;
machine breakdowns, which the closed-form formulas cannot represent at all; and stations whose
arrivals are not Poisson because a non-exponential station sits upstream.

**"How do you know the discovery is correct?"**
Round trip. I simulate a factory whose parameters I already know, export its log, re-discover it,
and compare. The server counts came back exactly right, the rework rate as 11.43% against a true
10%, and the Erlang-2 station was identified correctly.

**"Did you use M/M/1 formulas for M/M/c?"**
No. M/M/c uses Erlang C. There is a test that specifically proves the two give different answers
for the same load.

---

## 7. If something goes wrong

| Problem | Fix |
|---|---|
| Page is blank | Check `npm run dev:web` is still running; refresh |
| `Local only` in the corner | The API is not running. Harmless for a demo — everything still works |
| "Run is stale" | You changed something after running. Just run again |
| Discovered model says **UNSTABLE** | Normal. The server estimate is a lower bound — go to **Process Discovery** and raise the server counts |
| Engine change not showing | Run `npm run build:engine`, then refresh |
| Want to start over | **System Configuration** → *Reset to the reference line* |

---

## 8. Two-minute version (if they are in a hurry)

1. **Manufacturing Cost** — "nine cost categories, they add up exactly, here is the proof."
2. **Vehicle Cost / BOM** → click a car — "this car took X and cost Y."
3. **Scenario Manager** → run the saved comparison — "add a booth: waiting time drops 25%,
   but **payback NOT ACHIEVED**, and here is why."
4. **Event Log Import** → *Generate from the current model* → **Process Discovery** —
   "it found the stations, the order, and the rework loop from the data alone."
5. **Discovered Model** → **Vehicle traces** → click a car — "discovered process, Task 6 cost."
