/**
 * API client.
 *
 * The browser runs the engine itself for anything interactive — validation,
 * the analytical solution, the live simulation — so these calls are limited to
 * what only the server can do: persistence, and studies large enough to be
 * worth keeping off the UI thread.
 *
 * Every call returns a typed result or throws with the server's own message,
 * so failures surface as the actual reason rather than a generic error.
 */

import type {
  OptimizationRequest,
  OptimizationResult,
  Scenario,
  StudyResult,
  SystemModel,
  Vehicle,
} from '@vmq/engine';

const BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      0,
      'Cannot reach the API server. Start it with `npm run dev:api` — the app still works ' +
        'offline for simulation and analysis, but nothing can be saved or loaded.',
    );
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let detail: unknown;
    try {
      const body = await res.json();
      message = (body as { error?: string }).error ?? message;
      detail = body;
    } catch {
      /* response had no JSON body; keep the status line */
    }
    throw new ApiError(res.status, message, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface SystemSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  stationCount: number;
  currency: string;
  seed: number;
}

export interface RunSummary {
  id: string;
  systemId: string;
  scenarioId: string | null;
  createdAt: string;
  seed: number;
  replications: number;
  warmupMinutes: number;
  durationMinutes: number;
  throughputPerHour: number | null;
  vehiclesCompleted: number | null;
  wMinutes: number | null;
  wqMinutes: number | null;
  wip: number | null;
  costPerVehicle: number | null;
  totalCost: number | null;
  profit: number | null;
  bottleneckStation: string | null;
  durationMs: number | null;
}

export interface StoredScenario extends Scenario {
  systemId: string;
  isBaseline: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TraceRow {
  vehicleId: number;
  tag: string;
  modelId: string;
  status: string;
  arrivalTime: number;
  completionTime: number | null;
  cycleMinutes: number | null;
  reworkCount: number;
  totalCost: number | null;
}

export const api = {
  health: () => request<{ ok: boolean; database: string; systems: number }>('/health'),

  /* Systems */
  listSystems: () => request<SystemSummary[]>('/systems'),
  getSystem: (id: string) => request<SystemModel>(`/systems/${id}`),
  createSystem: (model: SystemModel) =>
    request<SystemModel>('/systems', { method: 'POST', body: JSON.stringify(model) }),
  updateSystem: (model: SystemModel) =>
    request<SystemModel>(`/systems/${model.id}`, { method: 'PUT', body: JSON.stringify(model) }),
  deleteSystem: (id: string) => request<{ deleted: boolean }>(`/systems/${id}`, { method: 'DELETE' }),
  cloneSystem: (id: string, name: string) =>
    request<SystemModel>(`/systems/${id}/clone`, { method: 'POST', body: JSON.stringify({ name }) }),
  seedReference: () => request<SystemModel>('/systems/seed-reference', { method: 'POST' }),

  /* Runs */
  run: (systemId: string, body: { replications?: number; scenarioId?: string | null }) =>
    request<{ runId: string; durationMs: number; study: StudyResult }>(`/systems/${systemId}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listRuns: (systemId: string) => request<RunSummary[]>(`/systems/${systemId}/runs`),
  getRun: (runId: string) => request<{ summary: RunSummary; study: StudyResult }>(`/runs/${runId}`),
  deleteRun: (runId: string) => request<{ deleted: boolean }>(`/runs/${runId}`, { method: 'DELETE' }),
  listTraces: (runId: string, params: { limit?: number; offset?: number; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    if (params.status) q.set('status', params.status);
    return request<{ rows: TraceRow[]; total: number }>(`/runs/${runId}/vehicles?${q}`);
  },
  getTrace: (runId: string, vehicleId: number) =>
    request<Vehicle>(`/runs/${runId}/vehicles/${vehicleId}`),

  /* Scenarios */
  listScenarios: (systemId: string) => request<StoredScenario[]>(`/systems/${systemId}/scenarios`),
  createScenario: (systemId: string, scenario: Scenario & { isBaseline?: boolean }) =>
    request<StoredScenario>(`/systems/${systemId}/scenarios`, {
      method: 'POST',
      body: JSON.stringify(scenario),
    }),
  updateScenario: (scenario: Scenario) =>
    request<StoredScenario>(`/scenarios/${scenario.id}`, {
      method: 'PUT',
      body: JSON.stringify(scenario),
    }),
  deleteScenario: (id: string) => request<{ deleted: boolean }>(`/scenarios/${id}`, { method: 'DELETE' }),

  /* Optimisation */
  optimize: (systemId: string, req: OptimizationRequest) =>
    request<{ id: string; durationMs: number; result: OptimizationResult }>(
      `/systems/${systemId}/optimize`,
      { method: 'POST', body: JSON.stringify(req) },
    ),
  listOptimizations: (systemId: string) =>
    request<{ id: string; created_at: string; objective: string }[]>(
      `/systems/${systemId}/optimizations`,
    ),

  /* Reports and exports */
  createReport: (systemId: string, body: { runId?: string; title?: string; author?: string }) =>
    request<{ id: string; content: string }>(`/systems/${systemId}/report`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listReports: (systemId: string) =>
    request<{ id: string; title: string; created_at: string; format: string; run_id: string | null }[]>(
      `/systems/${systemId}/reports`,
    ),
  getReport: (id: string) =>
    request<{ id: string; title: string; format: string; content: string; created_at: string }>(
      `/reports/${id}`,
    ),
  exportBundle: (systemId: string, body: { runId?: string; scenarioId?: string }) =>
    request<{ files: { filename: string; mimeType: string; content: string }[] }>(
      `/systems/${systemId}/export`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

/** Trigger a browser download of generated text content. */
export function downloadFile(filename: string, content: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick: revoking synchronously can cancel the download in
  // some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
