/**
 * Application state.
 *
 * ONE MODEL, DERIVED EVERYTHING. The store holds exactly one authoritative
 * object — the `SystemModel` — plus which scenario is selected and the most
 * recent study. Validation, the analytical solution, the capacity limit and the
 * bottleneck analysis are all DERIVED from that model with `useMemo` and are
 * never stored, so they cannot drift out of step with the parameters on screen.
 * Editing a station's server count instantly and necessarily updates every
 * analytical figure in the application.
 *
 * Simulated results are the exception: they are stored, because they come from
 * an explicit run the user asked for. That asymmetry is the point — an
 * analytical number is always current, a simulated number is always from a
 * named run, and the UI labels each accordingly (requirement 60). When the
 * model changes after a run, `studyIsStale` goes true and the UI says so
 * rather than showing the old numbers as if they still described the model.
 */

import {
  analyseBottlenecks,
  buildReferenceModel,
  capacityLimit,
  computeCosts,
  discoverProcess,
  discoveredToSystemModel,
  parseEventLogCsv,
  runSimulation,
  solveNetwork,
  validateModel,
  type BottleneckAnalysis,
  type CostResult,
  type DiscoveredProcess,
  type NetworkAnalytic,
  type ParsedEventLog,
  type Scenario,
  type SimulationResult,
  type StudyResult,
  type SystemModel,
  type ValidationReport,
} from '@vmq/engine';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, type StoredScenario } from '../lib/api';

export interface RunRecord {
  id: string | null;
  study: StudyResult;
  /** Model snapshot the study was produced from, for staleness detection. */
  modelFingerprint: string;
  at: string;
  persisted: boolean;
}

interface StoreValue {
  model: SystemModel;
  setModel: (next: SystemModel | ((prev: SystemModel) => SystemModel)) => void;

  /* Derived — always current with `model`. */
  validation: ValidationReport;
  analytical: NetworkAnalytic;
  capacity: ReturnType<typeof capacityLimit>;
  bottleneck: BottleneckAnalysis;
  /**
   * Single-replication preview, so every page has real figures before a study
   * is run. Always labelled as one replication wherever it is shown.
   */
  preview: { cost: CostResult; simulation: SimulationResult } | null;

  /* Simulated — from an explicit run. */
  run: RunRecord | null;
  studyIsStale: boolean;
  setRun: (r: RunRecord | null) => void;

  /* Persistence */
  online: boolean;
  scenarios: StoredScenario[];
  refreshScenarios: () => Promise<void>;
  saveScenario: (s: Scenario & { isBaseline?: boolean }) => Promise<void>;
  removeScenario: (id: string) => Promise<void>;
  saveModel: () => Promise<void>;
  loadSystem: (id: string) => Promise<void>;
  lastError: string | null;
  clearError: () => void;
  notify: (message: string) => void;
  toast: string | null;

  theme: 'light' | 'dark' | 'system';
  setTheme: (t: 'light' | 'dark' | 'system') => void;

  /* ---- Task 7: event log -> discovery -> model ---- */
  /** The imported event log, or null before one is loaded. */
  eventLog: ParsedEventLog | null;
  /** Name of the file or source the log came from. */
  eventLogSource: string | null;
  /** The mined process, derived from the log. */
  discovered: DiscoveredProcess | null;
  /**
   * Server counts the user has overridden. The log can only give a lower bound
   * on capacity, so this is the main thing a person corrects after discovery.
   */
  discoveredServers: Record<string, number>;
  /**
   * The executable model built from the discovered process. Derived, so editing
   * a server count rebuilds it and every figure on the page follows.
   */
  discoveredModel: { model: SystemModel; notes: string[] } | null;
  discoveryError: string | null;
  loadEventLog: (csv: string, source: string) => void;
  setDiscoveredServers: (activityId: string, servers: number) => void;
  clearEventLog: () => void;
  /** Make the discovered model the active model, so every page works on it. */
  adoptDiscoveredModel: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

/**
 * A cheap fingerprint of everything that affects results. Used only to detect
 * that a stored study no longer describes the current model.
 */
function fingerprint(m: SystemModel): string {
  return JSON.stringify({
    stations: m.stations.map((s) => [
      s.id,
      s.servers,
      s.service,
      s.queueDiscipline,
      s.queueCapacity,
      s.scrapProbability,
      s.routing,
      s.workers.map((w) => [w.count, w.hourlyWage.value, w.shiftHours.value]),
      s.machine
        ? [
            s.machine.powerKw.value,
            s.machine.idlePowerKw.value,
            s.machine.purchasePrice.value,
            s.machine.maintenanceCostPerHour.value,
            s.machine.consumablesCostPerHour.value,
            s.machine.reliability?.enabled,
            s.machine.reliability?.mtbfHours.value,
            s.machine.reliability?.mttrHours.value,
          ]
        : null,
    ]),
    arrivals: m.arrivals,
    cost: m.cost,
    sim: m.simulation,
    models: m.vehicleModels.map((v) => [v.sellingPrice.value, v.bom.map((b) => [b.quantityPerVehicle, b.unitCost.value, b.scrapAllowance])]),
    investment: m.investment,
  });
}

const THEME_KEY = 'vmq.theme';

export function StoreProvider({ children }: { children: ReactNode }) {
  const [model, setModelState] = useState<SystemModel>(() => buildReferenceModel());
  const [run, setRun] = useState<RunRecord | null>(null);
  const [scenarios, setScenarios] = useState<StoredScenario[]>([]);
  const [online, setOnline] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setThemeState] = useState<'light' | 'dark' | 'system'>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as 'light' | 'dark' | 'system') ?? 'system';
    } catch {
      return 'system';
    }
  });

  const [eventLog, setEventLog] = useState<ParsedEventLog | null>(null);
  const [eventLogSource, setEventLogSource] = useState<string | null>(null);
  const [discoveredServers, setDiscoveredServersState] = useState<Record<string, number>>({});
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const setModel = useCallback((next: SystemModel | ((prev: SystemModel) => SystemModel)) => {
    setModelState((prev) => (typeof next === 'function' ? next(prev) : next));
  }, []);

  /* ---- theme ---- */
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable (private window); the theme still applies for this session */
    }
  }, [theme]);

  /* ---- server availability ---- */
  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then(() => {
        if (!cancelled) setOnline(true);
      })
      .catch(() => {
        if (!cancelled) setOnline(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- derived analysis ---- */

  const validation = useMemo(() => validateModel(model), [model]);

  const analytical = useMemo(() => {
    try {
      return solveNetwork(model);
    } catch (e) {
      // A structurally broken model (e.g. an absorbing routing cycle) cannot be
      // solved. Rather than crash the page, return an empty solution — the
      // validation report already explains exactly what is wrong.
      return {
        stations: [],
        system: {
          lambdaExternal: 0,
          throughputFinished: 0,
          throughputScrap: 0,
          L: NaN,
          Lq: NaN,
          W: NaN,
          Wq: NaN,
          WMinutes: NaN,
          WqMinutes: NaN,
          totalServiceMinutesPerVehicle: 0,
          stable: false,
          bottleneckStationId: null,
          containsApproximations: false,
        },
        traffic: {
          lambdaByStation: {},
          visitRatios: {},
          lambdaExternal: 0,
          throughputFinished: 0,
          throughputScrap: 0,
          warnings: [],
        },
        warnings: [(e as Error).message],
        availabilityAdjusted: false,
      } as NetworkAnalytic;
    }
  }, [model]);

  const capacity = useMemo(() => {
    try {
      return capacityLimit(model);
    } catch {
      return { lambdaMaxPerHour: NaN, bindingStationId: null, perStation: [] };
    }
  }, [model]);

  const bottleneck = useMemo(() => {
    try {
      return analyseBottlenecks(model, undefined, analytical);
    } catch (e) {
      return {
        primaryBottleneckId: null,
        secondaryBottleneckId: null,
        delayBottleneckId: null,
        factoryCapacityPerHour: NaN,
        factoryCapacityPerDay: NaN,
        lambdaPerHour: 0,
        utilisationOfCapacity: 0,
        stations: [],
        reliefPreview: null,
        warnings: [(e as Error).message],
      } as BottleneckAnalysis;
    }
  }, [model, analytical]);

  /**
   * A single-replication preview so cost and BOM pages are populated before the
   * user runs a study. It is explicitly labelled as one replication wherever it
   * appears, and any full study supersedes it.
   */
  const preview = useMemo(() => {
    if (!validation.runnable) return null;
    try {
      const sim = runSimulation(model);
      return { cost: computeCosts(model, sim), simulation: sim };
    } catch {
      return null;
    }
  }, [model, validation.runnable]);

  /* ---- Task 7 derivations ---- */

  // Discovery is derived from the log, and the executable model is derived from
  // the discovery plus the user's server corrections. Nothing is stored that
  // could fall out of step with the log on screen.
  const discovered = useMemo(() => {
    if (!eventLog) return null;
    try {
      return discoverProcess(eventLog);
    } catch (e) {
      setDiscoveryError((e as Error).message);
      return null;
    }
  }, [eventLog]);

  const discoveredModel = useMemo(() => {
    if (!discovered) return null;
    try {
      const built = discoveredToSystemModel(discovered, {
        reference: model,
        serverOverrides: discoveredServers,
        name: `Discovered — ${eventLogSource ?? 'event log'}`,
      });
      return { model: built.model, notes: built.notes };
    } catch (e) {
      setDiscoveryError((e as Error).message);
      return null;
    }
  }, [discovered, discoveredServers, model, eventLogSource]);

  const loadEventLog = useCallback((csv: string, source: string) => {
    setDiscoveryError(null);
    try {
      const parsed = parseEventLogCsv(csv);
      setEventLog(parsed);
      setEventLogSource(source);
      setDiscoveredServersState({});
      notify(`Loaded ${parsed.rows.length} events across ${parsed.caseIds.length} cases.`);
    } catch (e) {
      setEventLog(null);
      setEventLogSource(null);
      setDiscoveryError((e as Error).message);
    }
  }, [notify]);

  const setDiscoveredServers = useCallback((activityId: string, servers: number) => {
    setDiscoveredServersState((prev) => ({ ...prev, [activityId]: Math.max(1, Math.round(servers)) }));
  }, []);

  const clearEventLog = useCallback(() => {
    setEventLog(null);
    setEventLogSource(null);
    setDiscoveredServersState({});
    setDiscoveryError(null);
  }, []);

  const adoptDiscoveredModel = useCallback(() => {
    if (!discoveredModel) return;
    setModelState(discoveredModel.model);
    setRun(null);
    notify('The discovered model is now the active system. Every page is using it.');
  }, [discoveredModel, notify]);

  const currentFingerprint = useMemo(() => fingerprint(model), [model]);
  const studyIsStale = run !== null && run.modelFingerprint !== currentFingerprint;

  /* ---- persistence ---- */

  const handle = useCallback(
    async (fn: () => Promise<void>, successMessage?: string) => {
      try {
        await fn();
        setLastError(null);
        if (successMessage) notify(successMessage);
      } catch (e) {
        setLastError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [notify],
  );

  const refreshScenarios = useCallback(async () => {
    await handle(async () => {
      setScenarios(await api.listScenarios(model.id));
    });
  }, [handle, model.id]);

  useEffect(() => {
    if (online) void refreshScenarios();
  }, [online, refreshScenarios]);

  const saveScenario = useCallback(
    async (s: Scenario & { isBaseline?: boolean }) => {
      await handle(async () => {
        await api.createScenario(model.id, s);
        setScenarios(await api.listScenarios(model.id));
      }, `Scenario "${s.name}" saved.`);
    },
    [handle, model.id],
  );

  const removeScenario = useCallback(
    async (id: string) => {
      await handle(async () => {
        await api.deleteScenario(id);
        setScenarios(await api.listScenarios(model.id));
      }, 'Scenario deleted.');
    },
    [handle, model.id],
  );

  const saveModel = useCallback(async () => {
    await handle(async () => {
      const existing = await api.listSystems();
      if (existing.some((s) => s.id === model.id)) await api.updateSystem(model);
      else await api.createSystem(model);
    }, 'System saved.');
  }, [handle, model]);

  const loadSystem = useCallback(
    async (id: string) => {
      await handle(async () => {
        const loaded = await api.getSystem(id);
        setModelState(loaded);
        setRun(null);
      }, 'System loaded.');
    },
    [handle],
  );

  const value: StoreValue = {
    model,
    setModel,
    validation,
    analytical,
    capacity,
    bottleneck,
    preview,
    run,
    studyIsStale,
    setRun,
    online,
    scenarios,
    refreshScenarios,
    saveScenario,
    removeScenario,
    saveModel,
    loadSystem,
    lastError,
    clearError: () => setLastError(null),
    notify,
    toast,
    theme,
    setTheme: setThemeState,
    eventLog,
    eventLogSource,
    discovered,
    discoveredServers,
    discoveredModel,
    discoveryError,
    loadEventLog,
    setDiscoveredServers,
    clearEventLog,
    adoptDiscoveredModel,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore must be used inside <StoreProvider>.');
  return v;
}

/** Fingerprint helper exposed so a run can record the model it came from. */
export { fingerprint };
