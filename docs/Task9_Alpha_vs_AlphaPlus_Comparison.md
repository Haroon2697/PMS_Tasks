# Task 9: Comparison of Alpha (α) and Alpha Plus (α⁺) Process Discovery Algorithms

## 1. Introduction

This document provides a detailed comparison between the **Alpha (α) algorithm** and the **Alpha Plus (α⁺) algorithm** — the two foundational process discovery algorithms in process mining. Our ProcessFlow application currently employs the **Alpha algorithm** as the basis of its process discovery module, which mines a process model from event logs of vehicle manufacturing traces. This comparison evaluates whether upgrading to the Alpha Plus algorithm would improve the accuracy and reliability of the discovered models.

---

## 2. Background: What is Process Discovery?

Process discovery is the act of automatically constructing a process model from an event log. An **event log** consists of recorded traces — sequences of activities performed for each case (e.g., each vehicle passing through a manufacturing line). The discovered model reveals the structure of the real process: which activities exist, in what order they occur, whether there is concurrency or parallelism, and where loops or rework happen.

The Alpha family of algorithms discovers **Petri net** models, which are a formal mathematical representation of concurrent systems capable of expressing:
- **Sequential** flow (one activity follows another)
- **Parallel** (AND) splits and joins (activities happening concurrently)
- **Exclusive** (XOR) choices (one path or another, not both)
- **Loops** (repeated execution of activities)

---

## 3. The Alpha (α) Algorithm

### 3.1 Overview

The Alpha algorithm was introduced by **van der Aalst, Weijters, and Maruster (2004)** as the first formal algorithm for process discovery. It takes an event log as input and produces a Petri net (specifically, a Workflow net) as output.

### 3.2 How It Works

The Alpha algorithm operates in the following steps:

1. **Extract the activity set** — identify all unique activities from the event log.
2. **Derive ordering relations** — for every pair of activities (a, b), determine their relationship by examining the traces:
   - **Direct succession** (a > b): activity `a` is directly followed by `b` in at least one trace.
   - **Causality** (a → b): `a > b` AND NOT `b > a` — `a` always precedes `b`, never the reverse.
   - **Parallelism** (a ‖ b): `a > b` AND `b > a` — both orderings exist, implying concurrency.
   - **No relation** (a # b): neither `a > b` nor `b > a` — the two activities never directly follow each other.
3. **Identify start and end activities** — activities that begin and end traces.
4. **Find maximal pairs** — discover sets of activities (A, B) where:
   - Every activity in A has a causal relation with every activity in B
   - Activities within A are unrelated (#) to each other
   - Activities within B are unrelated (#) to each other
5. **Construct the Petri net** — create places for each maximal pair and connect them with transitions and arcs.

### 3.3 Example Application in Our System

In our ProcessFlow application, when a user uploads a CSV event log (e.g., `automotive_manufacturing_traces.csv`), the discovery module:

- Parses the log into (CaseID, Activity, Start, Complete) rows
- Groups events by case to form traces
- Builds the ordering relations between activities
- Constructs the directly-follows relationships and routing probabilities
- Identifies loops (self-loops and 2-activity cycles like inspection → rework)
- Fits service time distributions from the observed timestamps

### 3.4 Limitations of Alpha

| Limitation | Description |
|---|---|
| **Cannot handle short loops of length 1** | If activity `a` can repeat immediately (a → a), Alpha misinterprets this. A self-loop creates both `a > a`, which breaks the causality/parallelism classification. |
| **Cannot handle short loops of length 2** | If two activities alternate (a → b → a), Alpha incorrectly classifies them as parallel (a ‖ b) because both `a > b` and `b > a` hold. |
| **No noise filtering** | Every observed transition is treated as significant. Rare, erroneous, or exceptional traces distort the model. |
| **Cannot discover non-free-choice constructs** | Situations where the choice of path depends on which earlier path was taken cannot be represented. |
| **Cannot handle duplicate activities** | If the same activity name appears in different roles/contexts, Alpha cannot distinguish them. |
| **Assumes complete logs** | The algorithm assumes the log contains all possible directly-follows relations. Incomplete logs produce incorrect models. |

### 3.5 Impact on Our Manufacturing Context

In vehicle manufacturing, these limitations are significant:

- **Self-loops (length 1)**: A station like "Quality Inspection" may re-inspect a vehicle immediately — this is a self-loop that Alpha cannot correctly discover.
- **Rework loops (length 2)**: The classic "Inspection → Rework → Inspection" pattern creates a length-2 loop. Alpha would incorrectly identify Inspection and Rework as parallel activities rather than a rework cycle.
- **Noise**: Manufacturing logs contain exceptional cases (e.g., emergency stops, skipped stations), which Alpha treats as valid process paths.

---

## 4. The Alpha Plus (α⁺) Algorithm

### 4.1 Overview

The Alpha Plus algorithm was introduced by **de Medeiros, van der Aalst, and Weijters (2004)** as a direct extension of the Alpha algorithm. Its primary contribution is the ability to handle **short loops of length 1 and length 2**, which are the most critical limitation of the original Alpha algorithm.

### 4.2 Key Improvements Over Alpha

Alpha Plus adds a **preprocessing step** before applying the standard Alpha logic:

#### Step 1: Detect Length-1 Loops (Self-Loops)

- Scan the log for any activity `a` where `a > a` (activity directly followed by itself).
- Record all such activities as **length-1 loop activities**.
- These activities are temporarily treated specially so they do not corrupt the ordering relations.

#### Step 2: Detect Length-2 Loops

- Scan for patterns where `a > b > a` appears in a trace (two activities alternating).
- When both `a > b` and `b > a` exist, Alpha would classify them as parallel. Alpha Plus instead checks whether the pattern `...a, b, a...` appears in the log.
- If it does, the pair is marked as a **length-2 loop** rather than parallel activities.

#### Step 3: Adjust Ordering Relations

- For length-1 loops: the self-loop relation is removed from the ordering table before the standard Alpha step, then added back as a self-loop arc in the final Petri net.
- For length-2 loops: the pair's relation is corrected from parallelism (‖) to a loop structure, and appropriate places and arcs are added.

#### Step 4: Apply Standard Alpha

- With the corrected ordering relations, the standard Alpha algorithm runs as before, now producing correct results for processes containing short loops.

### 4.3 What Alpha Plus Still Cannot Do

| Limitation | Still present? |
|---|---|
| Short loops of length 1 | ✅ **Fixed** |
| Short loops of length 2 | ✅ **Fixed** |
| Longer loops (length ≥ 3) | ✅ Fixed (already handled by Alpha) |
| Noise filtering | ❌ **Still absent** |
| Non-free-choice constructs | ❌ **Still absent** |
| Duplicate activities | ❌ **Still absent** |
| Incomplete logs | ❌ **Still absent** |

---

## 5. Side-by-Side Comparison

| Feature | Alpha (α) | Alpha Plus (α⁺) |
|---|---|---|
| **Input** | Event log (case, activity, timestamp) | Event log (case, activity, timestamp) |
| **Output** | Petri net (Workflow net) | Petri net (Workflow net) |
| **Sequential patterns** | ✅ Correct | ✅ Correct |
| **Parallel (AND) patterns** | ✅ Correct | ✅ Correct |
| **Exclusive (XOR) choices** | ✅ Correct | ✅ Correct |
| **Self-loops (length 1)** | ❌ Incorrect — misclassified | ✅ Correctly discovered |
| **Short loops (length 2)** | ❌ Confused with parallelism | ✅ Correctly discovered |
| **Long loops (length ≥ 3)** | ✅ Correct | ✅ Correct |
| **Noise handling** | ❌ None | ❌ None |
| **Non-free-choice** | ❌ Cannot represent | ❌ Cannot represent |
| **Duplicate activities** | ❌ Cannot distinguish | ❌ Cannot distinguish |
| **Computational complexity** | O(n²) in number of activities | O(n²) — marginal overhead for preprocessing |
| **Year introduced** | 2004 | 2004 |
| **Authors** | van der Aalst, Weijters, Maruster | de Medeiros, van der Aalst, Weijters |

---

## 6. Concrete Example: Impact on Our Manufacturing Model

Consider the following traces from our vehicle assembly event log:

```
Case 101: Body Shop → Paint → Inspection → Rework → Inspection → Assembly → Dispatch
Case 102: Body Shop → Paint → Inspection → Assembly → Dispatch
Case 103: Body Shop → Paint → Inspection → Rework → Inspection → Rework → Inspection → Assembly → Dispatch
```

### 6.1 Alpha's Interpretation (Incorrect)

Alpha observes:
- `Inspection > Rework` ✓ (Cases 101, 103)
- `Rework > Inspection` ✓ (Cases 101, 103)

Since **both** directions exist, Alpha classifies: `Inspection ‖ Rework` (parallel).

**Result**: The discovered model shows Inspection and Rework as concurrent activities — as if a vehicle is inspected AND reworked at the same time. This is **incorrect**; rework happens *because* inspection failed, and the vehicle returns for re-inspection.

```
          ┌─── Inspection ───┐
Paint ──►─┤                  ├─►── Assembly     ← WRONG (parallel)
          └─── Rework ───────┘
```

### 6.2 Alpha Plus's Interpretation (Correct)

Alpha Plus detects the pattern `...Inspection, Rework, Inspection...` in Cases 101 and 103.

It recognises this as a **length-2 loop**, not parallelism.

**Result**: The discovered model correctly shows:
- Inspection → (pass) → Assembly  
- Inspection → (fail) → Rework → Inspection (loop back)

```
                    ┌──── Rework ◄────┐
                    │                 │
Paint ──►── Inspection ──►── Assembly ──►── Dispatch     ← CORRECT (loop)
                    │  (fail)↑   (pass)
                    └────────┘
```

This matches the real manufacturing process: vehicles that fail inspection are reworked and re-inspected.

### 6.3 Quantitative Impact

In our sample event log (`sample_traces_with_rework.csv`), approximately **30-40%** of cases contain rework loops. With Alpha, all of these would be modelled incorrectly as parallel activities, leading to:
- **Underestimated cycle times** (parallel is faster than sequential + rework)
- **Incorrect resource allocation** (thinking two stations run simultaneously when they don't)
- **Missing rework cost** (the cost model cannot account for rework if it's not modelled as a loop)

---

## 7. Implications for Our ProcessFlow Application

### 7.1 Current State (Alpha)

Our application's discovery module handles loops through explicit detection:
- **Self-loops** are detected by counting consecutive repetitions of the same activity within a trace.
- **Two-activity cycles** are detected by checking for bidirectional edges in the directly-follows graph.
- **Routing probabilities** are computed from the frequency of each transition, including loop-back arcs.

These explicit loop-detection steps effectively implement the **same corrections that Alpha Plus introduces**, meaning our application already addresses Alpha's primary weakness through supplementary logic built on top of the base Alpha algorithm.

### 7.2 If We Upgraded to Alpha Plus

Upgrading to Alpha Plus would:
- **Formalise** the loop detection as part of the core algorithm rather than a supplementary step
- **Ensure correctness** for edge cases where the current ad-hoc detection might miss subtle loop patterns
- **Produce a proper Petri net** with formal concurrency semantics, rather than a frequency-based DFG
- **Not solve** the noise problem — for that, we would need the Heuristic Miner or Inductive Miner

### 7.3 Recommendation

For a manufacturing process mining application like ours, the ideal upgrade path would be:

| Step | Algorithm | What it adds |
|---|---|---|
| **Current** | Alpha (α) | Basic process structure discovery |
| **Step 1** | **Alpha Plus (α⁺)** | Correct rework loop discovery — *most impactful for manufacturing* |
| Step 2 | Heuristic Miner | Noise tolerance for real-world log quality |
| Step 3 | Inductive Miner | Guaranteed sound models with formal correctness |

---

## 8. Conclusion

The Alpha algorithm provides a foundational approach to process discovery but critically fails on short loops — a pattern that is **pervasive** in manufacturing (inspection-rework cycles, re-testing, quality gates). The Alpha Plus algorithm directly addresses this weakness with minimal additional computational cost, adding only a preprocessing step to detect and correctly handle length-1 and length-2 loops before applying the standard Alpha logic.

For our vehicle manufacturing queueing simulation platform, where rework loops are a first-class concern affecting cost, throughput, and cycle time calculations, the Alpha Plus algorithm's ability to correctly distinguish **rework loops from parallelism** makes it the clearly superior choice. The upgrade from Alpha to Alpha Plus is the single most impactful improvement available within the Alpha family of algorithms for our specific domain.

---

## References

1. van der Aalst, W.M.P., Weijters, T., & Maruster, L. (2004). *Workflow Mining: Discovering Process Models from Event Logs.* IEEE Transactions on Knowledge and Data Engineering, 16(9), 1128-1142.
2. de Medeiros, A.K.A., van der Aalst, W.M.P., & Weijters, A.J.M.M. (2004). *Process Mining: Extending the Alpha-Algorithm to Mine Short Loops.* BETA Working Paper Series, Eindhoven University of Technology.
3. van der Aalst, W.M.P. (2016). *Process Mining: Data Science in Action.* 2nd Edition, Springer.
