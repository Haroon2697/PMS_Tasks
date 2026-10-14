/**
 * Application shell — requirement 62.
 *
 * A hash router rather than a routing library: there are fifteen static pages
 * and no nested or dynamic routes, so a dependency would add weight without
 * adding capability. Using the hash also means the built app opens correctly
 * from a file path or any static host without server rewrite rules.
 *
 * The status strip in the header is deliberate. An operations tool should say
 * at a glance whether what you are looking at is current: it shows the model's
 * validation state, whether the last run still matches the model, and whether
 * persistence is available.
 */

import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './state/store';
import { OverviewPage } from './pages/Overview';
import { NetworkModelPage } from './pages/NetworkModel';
import { SimulationPage } from './pages/Simulation';
import { QueueAnalyticsPage } from './pages/QueueAnalytics';
import { BottleneckPage } from './pages/Bottleneck';
import { CostPage } from './pages/Cost';
import { VehicleCostPage } from './pages/VehicleCost';
import { ScenariosPage } from './pages/Scenarios';
import { OptimizationPage } from './pages/Optimization';
import { FinancialPage } from './pages/Financial';
import { EventLogPage } from './pages/EventLog';
import { DiscoveryPage } from './pages/Discovery';
import { DiscoveredModelPage } from './pages/DiscoveredModel';
import {
  LiveFactoryPage,
  ReportsPage,
  SettingsPage,
  SystemConfigPage,
  ValidationPage,
} from './pages/Misc';

interface Route {
  id: string;
  label: string;
  group: string;
  title: string;
  intro?: string;
}

const ROUTES: Route[] = [
  { id: 'overview', label: 'Overview', group: 'Operations', title: 'Factory Overview' },
  { id: 'live', label: 'Live Factory', group: 'Operations', title: 'Live Factory' },
  { id: 'simulation', label: 'Simulation', group: 'Operations', title: 'Simulation' },

  { id: 'config', label: 'System Configuration', group: 'Model', title: 'System Configuration' },
  { id: 'network', label: 'Network Model', group: 'Model', title: 'Network Model' },
  { id: 'validation', label: 'Model Validation', group: 'Model', title: 'Model Validation' },

  { id: 'queues', label: 'Queue Analytics', group: 'Analysis', title: 'Queue Analytics' },
  { id: 'bottleneck', label: 'Bottleneck Analysis', group: 'Analysis', title: 'Bottleneck Analysis' },

  { id: 'cost', label: 'Manufacturing Cost', group: 'Economics', title: 'Manufacturing Cost' },
  { id: 'vehicle', label: 'Vehicle Cost / BOM', group: 'Economics', title: 'Vehicle Cost and Bill of Materials' },
  { id: 'financial', label: 'Financial Analysis', group: 'Economics', title: 'Financial Analysis' },

  { id: 'scenarios', label: 'Scenario Manager', group: 'Decisions', title: 'Scenario Manager' },
  { id: 'optimization', label: 'Optimization', group: 'Decisions', title: 'Cost Optimization' },

  { id: 'eventlog', label: 'Event Log Import', group: 'Process Mining', title: 'Event Log Import' },
  { id: 'discovery', label: 'Process Discovery', group: 'Process Mining', title: 'Process Discovery' },
  { id: 'discovered', label: 'Discovered Model', group: 'Process Mining', title: 'Discovered Queue Model' },

  { id: 'reports', label: 'Reports & Export', group: 'Output', title: 'Reports and Export' },
  { id: 'settings', label: 'Settings', group: 'Output', title: 'Settings' },
];

const GROUPS = [
  'Operations',
  'Model',
  'Analysis',
  'Economics',
  'Decisions',
  'Process Mining',
  'Output',
];

function useHashRoute(): [string, (id: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.replace('#', '') || 'overview');
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.replace('#', '') || 'overview');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = (id: string) => {
    window.location.hash = id;
    setRoute(id);
  };
  return [route, navigate];
}

function Shell() {
  const [route, navigate] = useHashRoute();
  const { model, validation, run, studyIsStale, online, lastError, clearError, toast, eventLog, discovered } =
    useStore();
  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[0]!;

  useEffect(() => {
    document.title = `${current.title} — ProcessFlow`;
  }, [current.title]);

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="nav-brand">
          <div className="mark">ProcessFlow</div>
          <div className="sub">Queueing · Simulation · Cost · Process Mining</div>
        </div>
        {GROUPS.map((g) => (
          <div className="nav-group" key={g}>
            <div className="nav-group-label">{g}</div>
            {ROUTES.filter((r) => r.group === g).map((r) => (
              <button
                key={r.id}
                className="nav-item"
                aria-current={r.id === route ? 'page' : undefined}
                onClick={() => navigate(r.id)}
              >
                {r.label}
                {r.id === 'validation' && validation.errors.length > 0 ? (
                  <span className="badge" style={{ color: 'var(--status-critical)' }}>
                    {validation.errors.length}
                  </span>
                ) : null}
                {r.id === 'validation' && validation.errors.length === 0 && validation.warnings.length > 0 ? (
                  <span className="badge">{validation.warnings.length}</span>
                ) : null}
                {r.id === 'eventlog' && eventLog ? (
                  <span className="badge sim">{eventLog.caseIds.length}</span>
                ) : null}
                {r.id === 'discovery' && discovered ? (
                  <span className="badge sim">{discovered.activities.length}</span>
                ) : null}
              </button>
            ))}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div className="nav-group" style={{ paddingBottom: 12 }}>
          <div className="nav-group-label">Model</div>
          <div style={{ padding: '0 14px' }} className="small muted">
            {model.name}
            <br />
            {model.stations.length} stations · seed {model.simulation.seed}
          </div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{current.title}</h1>
          <div className="spacer" />
          <span
            className={`status ${validation.errors.length ? 'critical' : validation.warnings.length ? 'warning' : 'good'}`}
            title={
              validation.errors.length
                ? 'The model has validation errors and cannot be simulated.'
                : validation.warnings.length
                  ? 'The model runs, with warnings.'
                  : 'The model passes every check.'
            }
          >
            {validation.errors.length
              ? `${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}`
              : validation.warnings.length
                ? `${validation.warnings.length} warning${validation.warnings.length === 1 ? '' : 's'}`
                : 'Model valid'}
          </span>
          <span
            className={`status ${!run ? 'neutral' : studyIsStale ? 'warning' : 'good'}`}
            title={
              !run
                ? 'No simulation has been run in this session.'
                : studyIsStale
                  ? 'The model has changed since the last run, so simulated figures are out of date.'
                  : 'Simulated figures match the current model.'
            }
          >
            {!run ? 'No run' : studyIsStale ? 'Run is stale' : 'Run current'}
          </span>
          <span className={`status ${online ? 'good' : 'neutral'}`} title={online ? 'Persistence available.' : 'Running without the API server; nothing can be saved.'}>
            {online ? 'Saved storage' : 'Local only'}
          </span>
        </header>

        <main className="content">
          {lastError ? (
            <div className="notice error" role="alert">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div className="n-title">Server error</div>
                  {lastError}
                </div>
                <button className="btn sm" onClick={clearError}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          <Page route={current.id} navigate={navigate} />
        </main>
      </div>

      {toast ? (
        <div
          className="tooltip"
          role="status"
          style={{ left: 'auto', right: 16, top: 'auto', bottom: 16, pointerEvents: 'none' }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function Page({ route, navigate }: { route: string; navigate: (id: string) => void }) {
  switch (route) {
    case 'overview':
      return <OverviewPage navigate={navigate} />;
    case 'live':
      return <LiveFactoryPage />;
    case 'simulation':
      return <SimulationPage />;
    case 'config':
      return <SystemConfigPage navigate={navigate} />;
    case 'network':
      return <NetworkModelPage />;
    case 'validation':
      return <ValidationPage />;
    case 'queues':
      return <QueueAnalyticsPage navigate={navigate} />;
    case 'bottleneck':
      return <BottleneckPage navigate={navigate} />;
    case 'cost':
      return <CostPage navigate={navigate} />;
    case 'vehicle':
      return <VehicleCostPage navigate={navigate} />;
    case 'financial':
      return <FinancialPage navigate={navigate} />;
    case 'scenarios':
      return <ScenariosPage />;
    case 'optimization':
      return <OptimizationPage />;
    case 'eventlog':
      return <EventLogPage navigate={navigate} />;
    case 'discovery':
      return <DiscoveryPage navigate={navigate} />;
    case 'discovered':
      return <DiscoveredModelPage navigate={navigate} />;
    case 'reports':
      return <ReportsPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <OverviewPage navigate={navigate} />;
  }
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
