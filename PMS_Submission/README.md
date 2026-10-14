# ProcessFlow — Vehicle Manufacturing Queue & Simulation Platform

An industrial queueing-theory, discrete-event simulation, manufacturing-cost, optimization, and process-mining platform for vehicle assembly lines.

---

## 1. Prerequisites & System Requirements

Before running the application, ensure the following are installed on your machine:

- **Node.js**: `v20.x` or higher (tested and verified on Node `v24.x`).
- **npm**: `v9.x` or higher.
- **Operating System**: Windows, macOS, or Linux.

---

## 2. Dependencies & Project Architecture

This project is organized as an **npm workspace monorepo** consisting of three interconnected packages:

### Workspace Architecture
```text
.
├── packages/
│   └── engine/             # Core simulation, queueing mathematics & cost engine
├── apps/
│   ├── api/                # Express & SQLite persistence server (port 5177)
│   └── web/                # React & Vite frontend application (port 5173)
├── sample_event_logs/      # Sample CSV logs for process discovery testing
├── package.json            # Root workspace configuration
└── README.md               # App instructions & documentation
```

### Required Dependencies Breakdown

1. **`@vmq/engine`** (Core Computational Engine):
   - **Type**: Dependency-free TypeScript package.
   - **Runtime Dependencies**: None (all analytical queueing formulas, discrete-event event calendars, cost models, and mining algorithms run in pure TypeScript).
   - **Dev Dependencies**:
     - `typescript` (`^5.6.3`): Static typing and compilation.
     - `vitest` (`^2.1.8`): Fast unit testing suite.

2. **`@vmq/api`** (Backend Persistence Service):
   - **Runtime Dependencies**:
     - `express` (`^4.21.2`): HTTP web server.
     - `better-sqlite3` (`^13.0.3`): Synchronous embedded SQLite database.
     - `cors` (`^2.8.5`): Cross-Origin Resource Sharing middleware.
     - `@vmq/engine`: Local workspace dependency.
   - **Dev Dependencies**:
     - `@types/express`, `@types/better-sqlite3`, `@types/cors`, `@types/node`, `typescript`.

3. **`@vmq/web`** (Frontend Dashboard & Visualizer):
   - **Runtime Dependencies**:
     - `react` (`^18.3.1`): Reactive UI component library.
     - `react-dom` (`^18.3.1`): React DOM renderer.
     - `@vmq/engine`: Local workspace dependency (the engine runs in-browser for zero-latency live animations).
   - **Dev Dependencies**:
     - `vite` (`^6.0.5`): Fast development server and bundler.
     - `@vitejs/plugin-react` (`^4.3.4`): Vite React plugin.
     - `@types/react`, `@types/react-dom`, `typescript`.

---

## 3. Step-by-Step Installation & Setup

### Step 1: Install Dependencies
From the root directory of the project, install all workspace dependencies:

```bash
npm install
```
*(On Windows PowerShell, if scripts are restricted, run `npm.cmd install`)*

### Step 2: Build the Core Engine
The API server and Web application consume the compiled engine package. Build the engine with:

```bash
npm run build:engine
```
*(Or `npm.cmd run build:engine`)*

---

## 4. Running the Application

You can run the web application standalone or run both the web client and the backend API server.

### Option A: Running the Web Application (Recommended / Full UI)
The web application includes the full client-side simulation, costing engine, queueing models, and process discovery tools:

```bash
npm run dev:web
```
- Open your browser and navigate to: **`http://localhost:5173`**

### Option B: Running the Backend Persistence API (Optional)
The backend API server provides persistent storage (SQLite) for scenarios, systems, and multi-replication study runs:

In a separate terminal, run:
```bash
npm run dev:api
```
- The API server will listen at: **`http://localhost:5177`**
- Health endpoint: `http://localhost:5177/api/health`

*(Note: The Vite dev server automatically proxies `/api` requests to `http://localhost:5177` when running).*

---

## 5. Running Automated Tests

To run the complete automated test suite (228 unit and integration tests covering queueing mathematics, simulation calendar, costing additivity, and process discovery):

```bash
npm test
```
*(Or `npm.cmd test`)*

---

## 6. How to Test Key Features in the App

1. **Dashboard & Live Discrete-Event Simulation**:
   - Navigate to the **Simulation** tab.
   - Adjust simulation parameters (Warmup time, Horizon duration, Seed).
   - Click **Run Simulation** or **Step Event** to watch live vehicle entities transition across stations and rework loops.
2. **Queueing Theory Mathematics**:
   - Inspect stations for analytical metrics: M/M/1, M/M/c (Erlang-C), M/G/1 (Pollaczek-Khinchine), and M/G/c (Allen-Cunneen).
   - Observe stability tracking ($\rho \ge 1$ flags UNSTABLE queues).
3. **Cost Modeling & Scenarios**:
   - Navigate to the **Cost** and **Scenarios** tabs.
   - Inspect the nine-line additive cost breakdown (labor, maintenance, energy, scrap, rework, overhead).
   - Test what-if parameter modifications to evaluate financial payback and ROI.
4. **Process Discovery from Event Logs**:
   - Navigate to the **Event Log** tab.
   - Upload one of the provided sample CSV traces from the `sample_event_logs/` folder:
     - `sample_event_logs/automotive_manufacturing_traces.csv`
     - `sample_event_logs/sample_traces_with_rework.csv`
   - Alternatively, generate synthetic traces from the baseline model.
   - View discovered routing probabilities, bottlenecks, fitted distribution families (D, Erlang-k, M, G), and convert into an executable model for immediate simulation.

---

## 7. Troubleshooting & Notes

- **Windows ExecutionPolicy**:
  If PowerShell shows `npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled on this system`, use `npm.cmd` instead (e.g., `npm.cmd run dev:web`).
- **Default Ports**:
  - Web UI: `5173`
  - Backend API: `5177`
  Ensure these ports are free before starting the dev servers.
