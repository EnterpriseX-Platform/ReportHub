// Thin fetch wrapper around the Spring Boot backend.
// Works on both server and client components (NEXT_PUBLIC_ vars are inlined for both).

import type {
  AdhocDataset,
  DashboardData,
  DashboardRow,
  DatasetColumn,
  DatasetDef,
  TableResult,
  AdhocHistoryRow,
  AdhocRequest,
  AdhocResult,
  AnalyticsMeta,
  Category,
  DashboardSummary,
  Datasource,
  DsTestResult,
  EngineInstance,
  EngineList,
  EngineTestResult,
  FlowDoc,
  Job,
  LoginResponse,
  MeResponse,
  OutputFile,
  PageResponse,
  ParamDef,
  ParamOption,
  PivotRequest,
  PivotResponse,
  QueueStats,
  ReportDetail,
  ReportSummary,
  ReportUnit,
  RepoTable,
  RepoTableMeta,
  RepoRows,
  RepoExecResult,
  Scheduler,
  SchedulerRun,
  SaveSchedulerInput,
  WarehousePipeline,
  WarehouseRun,
  SaveWarehouseInput,
  RunResponse,
  SaveUnitInput,
  SaveParamInput,
  SavedViewRow,
  Workspace,
  UpdateReportInput,
  UserRow,
  SharedResource,
  VersionEntry,
} from "./types";

// API base resolution:
//  - absolute NEXT_PUBLIC_API_BASE (e.g. dev http://localhost:8080/api) → used as-is
//  - relative (e.g. /reportstudio/api) → same-origin on the client (works on any host/IP),
//    and API_INTERNAL_BASE (the in-cluster service URL incl. context-path) during SSR.
const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080/api";
function base(): string {
  if (/^https?:\/\//.test(RAW_API_BASE)) return RAW_API_BASE;
  if (typeof window !== "undefined") return window.location.origin + RAW_API_BASE;
  return process.env.API_INTERNAL_BASE ?? "http://localhost:8080/api";
}
const TOKEN_KEY = "rs.token";

// --- auth token (client-only; persisted in localStorage) ------------------

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** On 401: drop the stale token and let AppShell route to /login. */
function handleUnauthorized(res: Response) {
  if (res.status === 401 && typeof window !== "undefined") {
    setToken(null);
    window.dispatchEvent(new CustomEvent("rs-unauthorized"));
  }
}

// --- core helpers ---------------------------------------------------------

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(base() + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { cache: "no-store", headers: { ...authHeaders() } });
  if (!res.ok) {
    handleUnauthorized(res);
    throw new Error(`API ${res.status} ${res.statusText} for ${url.pathname}`);
  }
  return res.json() as Promise<T>;
}

async function readError(res: Response): Promise<string> {
  handleUnauthorized(res);
  let msg = `API ${res.status}`;
  try {
    const j = await res.json();
    msg = j.message || j.error || msg;
  } catch {
    /* ignore */
  }
  return msg;
}

// Base64-encode a JSON string for transport. UAT Cloudflare WAF 403s raw JSON bodies
// containing SQL function names like SUBSTR/ASCII/CHAR/BENCHMARK/SUBSTRING followed by
// "(" — false-positive SQLi flag on legitimate Oracle queries saved as configJson.
// Base64 hides those keywords; backend Base64BodyDecodeFilter restores the JSON.
function encodeBody(text: string): string {
  // Handles Thai/UTF-8 safely: TextEncoder→bytes→base64 via btoa over latin1.
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(base() + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(text ? { "X-Body-Encoding": "base64" } : {}),
      ...authHeaders(),
    },
    body: text ? encodeBody(text) : undefined,
  });
  if (!res.ok) throw new Error(await readError(res));
  // Some POSTs (retry) may return an empty body on success.
  const respText = await res.text();
  return (respText ? JSON.parse(respText) : undefined) as T;
}

// NOTE: writes go out as POST + X-HTTP-Method-Override, never raw PUT/PATCH/DELETE.
// The UAT edge (Cloudflare) blocks those methods with a 403 block page before they
// reach the app; the backend HttpMethodOverrideFilter restores the real method.
// They MUST carry a Content-Type + JSON body — Cloudflare also 403s a bodyless POST
// to these paths (verified 2026-06-15), so we always send at least "{}".
async function put<T>(path: string, body?: unknown): Promise<T> {
  const text = body === undefined ? "{}" : JSON.stringify(body);
  const res = await fetch(base() + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HTTP-Method-Override": "PUT",
      "X-Body-Encoding": "base64",
      ...authHeaders(),
    },
    body: encodeBody(text),
  });
  if (!res.ok) throw new Error(await readError(res));
  const respText = await res.text();
  return (respText ? JSON.parse(respText) : undefined) as T;
}

async function del(path: string): Promise<void> {
  const res = await fetch(base() + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HTTP-Method-Override": "DELETE",
      "X-Body-Encoding": "base64",
      ...authHeaders(),
    },
    body: encodeBody("{}"),
  });
  if (!res.ok) throw new Error(await readError(res));
}

/** POST that expects a binary (xlsx) response and triggers a browser download. */
async function postBlob(path: string, body: unknown, filename: string): Promise<void> {
  const res = await fetch(base() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  const blob = await res.blob();
  saveAs(blob, filename);
}

/** Save a Blob to disk via an anchor click (no external dependency). */
export function saveAs(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a File as base64 (without the data: URL prefix) for JSON uploads. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Gzip a File then base64-encode it. The UAT edge (Cloudflare) WAF DECODES base64 inside
 * a JSON body and runs SQLi rules on the decoded bytes — so a .jrxml containing
 * `SELECT … FROM … WHERE …` is 403'd even when raw-base64-wrapped (verified 2026-06-25).
 * Gzipping first turns the file into compressed binary noise; Cloudflare doesn't decompress
 * gzip in transit, so the SQL strings disappear from any inspection layer. The server
 * gunzips when it sees `encoding: "gzip"` (see UnitController.decodeUploadContent).
 *
 * Uses the standard CompressionStream API (Chrome 80+, Firefox 113+, Safari 16.4+).
 * Returns null when CompressionStream isn't available — callers fall back to plain base64.
 */
async function fileToGzipBase64(file: File): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CS: unknown = (globalThis as any).CompressionStream;
  if (typeof CS !== "function") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = file.stream().pipeThrough(new (CS as any)("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Convert to base64 in chunks to avoid call-stack overflow on big files.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  return btoa(bin);
}

/** Pack file content for a `contentBase64` upload, preferring gzip when available. */
async function fileUploadPayload(file: File): Promise<{ contentBase64: string; encoding?: "gzip" }> {
  const gz = await fileToGzipBase64(file);
  if (gz) return { contentBase64: gz, encoding: "gzip" };
  // Fallback (very old browser or worker without CompressionStream): plain base64.
  return { contentBase64: await fileToBase64(file) };
}

/** Download a GET endpoint (e.g. a stored output) as a file. */
async function downloadGet(path: string, filename: string): Promise<void> {
  const res = await fetch(base() + path, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(await readError(res));
  const blob = await res.blob();
  saveAs(blob, filename);
}

export interface CreateReportInput {
  code: string;
  name: string;
  categoryId: string;
  engine: string;
  formats: string[];
  datasourceId?: string;
  templatePath?: string;
  ownerUnit?: string;
  paramCount?: number;
  note?: string;
}

export interface ReportQuery {
  category?: string;
  status?: string;
  engine?: string;
  datasource?: string;
  q?: string;
  page?: number;
  size?: number;
  sort?: string;
}

export interface RunReportInput {
  format?: string;
  params?: Record<string, unknown>;
  priority?: string;
}

export interface InstallEngineInput {
  name: string;
  kind: string;
  installMethod?: string;
  baseUrl?: string;
  authToken?: string;
  componentFormat?: string;
  artifactRef?: string;
  note?: string;
  enabled?: boolean;
}

/** Full URL for a stored output download (used in <a href> links). */
export function outputDownloadUrl(objectKey: string): string {
  return `${base()}/outputs/${encodeURIComponent(objectKey)}/download`;
}

export const api = {
  // --- catalog / reports ---
  dashboard: () => get<DashboardSummary>("/dashboard/summary"),
  categories: () => get<Category[]>("/categories"),
  datasources: () => get<Datasource[]>("/datasources"),
  reports: (query: ReportQuery = {}) =>
    get<PageResponse<ReportSummary>>("/reports", query as Record<string, string | number | undefined>),
  report: (code: string) => get<ReportDetail>(`/reports/${encodeURIComponent(code)}`),
  createReport: (body: CreateReportInput) => post<ReportDetail>("/reports", body),

  // --- run / jobs / queue ---
  runReport: (code: string, body: RunReportInput = {}) =>
    post<RunResponse>(`/reports/${encodeURIComponent(code)}/run`, body),
  job: (id: string) => get<Job>(`/jobs/${encodeURIComponent(id)}`),
  retryJob: (id: string) => post<RunResponse>(`/jobs/${encodeURIComponent(id)}/retry`),
  cancelJob: (id: string) => post<Job>(`/jobs/${encodeURIComponent(id)}/cancel`),
  jobs: (query: { state?: string; limit?: number } = {}) => get<Job[]>("/jobs", query),
  queueStats: () => get<QueueStats>("/queue/stats"),

  // --- outputs ---
  outputs: () => get<OutputFile[]>("/outputs"),
  downloadOutput: (objectKey: string, filename?: string) =>
    downloadGet(`/outputs/download?key=${encodeURIComponent(objectKey)}`,
      filename ?? objectKey.split("/").pop() ?? objectKey),

  // --- analytics workbench (pivot) ---
  pivot: (body: PivotRequest) => post<PivotResponse>("/analytics/pivot", body),
  exportPivot: (body: PivotRequest, filename = "pivot.xlsx") =>
    postBlob("/analytics/export", body, filename),

  // --- ad-hoc query ---
  adhocDatasets: () => get<AdhocDataset[]>("/adhoc/datasets"),
  adhocRun: (body: AdhocRequest) => post<AdhocResult>("/adhoc/run", body),
  adhocExport: (body: AdhocRequest, filename = "adhoc.xlsx") =>
    postBlob("/adhoc/export", body, filename),

  // --- engine registry (install engines: url / jar / lib / service) ---
  engines: () => get<EngineList>("/engines"),
  installEngine: (body: InstallEngineInput) => post<EngineInstance>("/engines", body),
  updateEngine: (id: number, body: InstallEngineInput) => put<EngineInstance>(`/engines/${id}`, body),
  deleteEngine: (id: number) => del(`/engines/${id}`),
  testEngine: (id: number) => post<EngineTestResult>(`/engines/${id}/test`, undefined),

  // --- parameter catalog (table-driven options + cascade) ---
  parameters: () => get<ParamDef[]>("/parameters"),
  paramLookupTables: () => get<string[]>("/parameters/lookup-tables"),
  paramTableColumns: (table: string) => get<string[]>(`/parameters/lookup-tables/${encodeURIComponent(table)}/columns`),
  previewParamOptions: (body: SaveParamInput, parent?: string) =>
    post<ParamOption[]>(`/parameters/preview-options${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`, body),
  createParameter: (body: SaveParamInput) => post<ParamDef>("/parameters", body),
  updateParameter: (id: number, body: SaveParamInput) => put<ParamDef>(`/parameters/${id}`, body),
  deleteParameter: (id: number) => del(`/parameters/${id}`),
  paramOptions: (name: string, parent?: string) =>
    get<ParamOption[]>(`/parameters/${encodeURIComponent(name)}/options`, { parent }),
  reportParameters: (code: string) => get<ParamDef[]>(`/reports/${encodeURIComponent(code)}/parameters`),
  assignReportParameters: (code: string, items: { name: string; requiredOverride: boolean | null }[]) =>
    put<ParamDef[]>(`/reports/${encodeURIComponent(code)}/parameters`, items),

  // --- report config screen + versions ---
  updateReport: (code: string, body: UpdateReportInput) =>
    put<ReportDetail>(`/reports/${encodeURIComponent(code)}`, body),
  deleteReport: (code: string) => del(`/reports/${encodeURIComponent(code)}`),

  // --- shared resources (Settings): global logos/images/fonts reused by every report ---
  sharedResources: () => get<SharedResource[]>("/resources"),
  uploadSharedResource: async (file: File) => {
    const pack = await fileUploadPayload(file);
    return post<SharedResource>("/resources", { fileName: file.name, ...pack });
  },
  resourceUsage: (name: string) => get<string[]>(`/resources/${encodeURIComponent(name)}/usage`),
  deleteSharedResource: (name: string, force = false) =>
    del(`/resources/${encodeURIComponent(name)}${force ? "?force=true" : ""}`),

  // --- engine plugins (drop-in JARs implementing the ReportEngine SPI) ---
  enginePlugins: () => get<string[]>("/engines/plugins"),
  uploadEnginePlugin: async (file: File) => {
    const pack = await fileUploadPayload(file);
    return post<{ jar: string; jars: string[]; availableKinds: string[] }>(
      "/engines/plugins", { fileName: file.name, ...pack });
  },

  reportVersions: (code: string) => get<VersionEntry[]>(`/reports/${encodeURIComponent(code)}/versions`),
  reportJobs: (code: string, limit = 10) => get<Job[]>("/jobs", { report: code, limit }),

  // --- render units (1 report = N units; one run executes them all) ---
  reportUnits: (code: string) => get<ReportUnit[]>(`/reports/${encodeURIComponent(code)}/units`),
  createUnit: (code: string, body: SaveUnitInput) =>
    post<ReportUnit>(`/reports/${encodeURIComponent(code)}/units`, body),
  updateUnit: (code: string, id: number, body: SaveUnitInput) =>
    put<ReportUnit>(`/reports/${encodeURIComponent(code)}/units/${id}`, body),
  deleteUnit: (code: string, id: number) => del(`/reports/${encodeURIComponent(code)}/units/${id}`),
  uploadUnitFile: async (code: string, id: number, file: File, role: "main" | "subreport" | "resource") => {
    // Send the file gzipped-then-base64'd inside a JSON body. The UAT edge (Cloudflare) WAF
    // 403s any upload whose decoded content contains a `SELECT ... FROM ... WHERE` (false-positive
    // SQLi) — and the WAF DOES decode base64 inside JSON, so raw base64 isn't enough (verified
    // 2026-06-25 on a real BPP02-01-RPT02.jrxml: raw base64 → 403, gzip+base64 → 201). The server
    // gunzips when it sees encoding: "gzip" (see UnitController.decodeUploadContent).
    const pack = await fileUploadPayload(file);
    return post<unknown>(
      `/reports/${encodeURIComponent(code)}/units/${id}/files/base64`,
      { fileName: file.name, role, ...pack });
  },
  deleteUnitFile: (code: string, id: number, fileId: number) =>
    del(`/reports/${encodeURIComponent(code)}/units/${id}/files/${fileId}`),
  activateUnitFile: (code: string, id: number, fileId: number) =>
    post<import("./types").UnitFile>(`/reports/${encodeURIComponent(code)}/units/${id}/files/${fileId}/activate`, undefined),
  downloadUnitFile: (code: string, id: number, fileId: number, filename: string) =>
    downloadGet(`/reports/${encodeURIComponent(code)}/units/${id}/files/${fileId}/download`, filename),

  // --- flow designer ---
  reportFlow: (code: string) => get<FlowDoc>(`/reports/${encodeURIComponent(code)}/flow`),
  saveReportFlow: (code: string, doc: { nodes: unknown[]; edges: unknown[] }) =>
    put<{ ok: boolean }>(`/reports/${encodeURIComponent(code)}/flow`, doc),

  // --- users (Settings) ---
  users: () => get<UserRow[]>("/users"),
  createUser: (body: { username: string; password: string; role: string; displayName: string }) =>
    post<UserRow>("/users", body),
  updateUser: (username: string, body: { role: string; displayName: string }) =>
    put<UserRow>(`/users/${encodeURIComponent(username)}`, body),
  resetPassword: (username: string, password: string) =>
    post<UserRow>(`/users/${encodeURIComponent(username)}/password`, { password }),
  deleteUser: (username: string) => del(`/users/${encodeURIComponent(username)}`),

  // --- analytics extras (real meta / history / saved views) ---
  analyticsMeta: () => get<AnalyticsMeta>("/analytics/meta"),
  adhocHistory: () => get<AdhocHistoryRow[]>("/adhoc/history"),
  savedViews: (kind: "pivot" | "adhoc", workspace?: number) =>
    get<SavedViewRow[]>("/views", { kind, workspace }),
  saveView: (body: { kind: string; name: string; dataset?: string; payload: string; workspaceId?: number; folder?: string }) =>
    post<SavedViewRow>("/views", body),
  deleteView: (id: number) => del(`/views/${id}`),
  shareView: (id: number) => post<SavedViewRow>(`/views/${id}/share`),
  unshareView: (id: number) => del(`/views/${id}/share`),
  exportView: (id: number, format: "csv" | "xlsx" | "json", filename: string) =>
    downloadGet(`/views/${encodeURIComponent(id)}/export?format=${format}`, filename),

  // --- workspaces (group views + dashboards) ---
  workspaces: () => get<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) => post<Workspace>("/workspaces", { name }),

  // --- datasets (SQL query editor) ---
  datasets: () => get<DatasetDef[]>("/datasets"),
  createDataset: (body: { name: string; description?: string; datasourceId?: string | null; sqlText: string }) =>
    post<DatasetDef>("/datasets", body),
  updateDataset: (id: number, body: { name: string; description?: string; datasourceId?: string | null; sqlText: string }) =>
    put<DatasetDef>(`/datasets/${id}`, body),
  deleteDataset: (id: number) => del(`/datasets/${id}`),
  captureDataset: (id: number) => post<DatasetDef>(`/datasets/${id}/capture`),
  uncaptureDataset: (id: number) => {
    // DELETE that returns the updated dataset
    return fetch(`${base()}/datasets/${id}/capture`, { method: "DELETE", headers: { ...authHeaders() } })
      .then(async (r) => { if (!r.ok) throw new Error(await readError(r)); return r.json() as Promise<DatasetDef>; });
  },
  previewDataset: (body: { datasourceId?: string | null; sql: string }) =>
    post<TableResult>("/datasets/preview", body),
  datasetFields: (id: number) => get<DatasetColumn[]>(`/datasets/${id}/fields`),
  datasetDistinct: (id: number, field: string) => get<string[]>(`/datasets/${id}/distinct`, { field }),
  datasetAggregate: (id: number, body: { dims: string[]; measures: string[]; filters?: Record<string, string> }) =>
    post<TableResult>(`/datasets/${id}/aggregate`, body),

  // --- dashboards (BI widgets + public share) ---
  dashboards: () => get<DashboardRow[]>("/dashboards"),
  createDashboard: (body: { name: string; layoutJson: string; paramsJson?: string; workspaceId?: number; folder?: string }) =>
    post<DashboardRow>("/dashboards", body),
  updateDashboard: (id: number, body: { name: string; layoutJson: string; paramsJson?: string; workspaceId?: number; folder?: string }) =>
    put<DashboardRow>(`/dashboards/${id}`, body),
  deleteDashboard: (id: number) => del(`/dashboards/${id}`),
  shareDashboard: (id: number) => post<DashboardRow>(`/dashboards/${id}/share`),
  unshareDashboard: (id: number) => del(`/dashboards/${id}/share`),
  dashboardData: (id: number, filters?: Record<string, string>) =>
    get<DashboardData>(`/dashboards/${id}/data`, filters),
  publicDashboard: (token: string) => get<DashboardData>(`/public/dash/${encodeURIComponent(token)}`),

  // --- datasources (real probe + create) ---
  testDatasource: (id: string) => post<DsTestResult>(`/datasources/${encodeURIComponent(id)}/test`),
  createDatasource: (body: { id: string; name: string; engine: string; host?: string; schemaName?: string; pool?: string; jdbcUrl?: string; dbUser?: string; dbPassword?: string }) =>
    post<Datasource>("/datasources", body),

  // --- repository (Database Tool: browse + edit table data, run SQL) ---
  repoTables: (datasourceId?: string | null) =>
    get<RepoTable[]>("/repository/tables", { datasourceId: datasourceId ?? undefined }),
  repoTableMeta: (table: string, datasourceId?: string | null, schema?: string | null) =>
    get<RepoTableMeta>(`/repository/tables/${encodeURIComponent(table)}/meta`,
      { datasourceId: datasourceId ?? undefined, schema: schema ?? undefined }),
  repoRows: (table: string, opts: { datasourceId?: string | null; schema?: string | null; limit?: number; offset?: number } = {}) =>
    get<RepoRows>(`/repository/tables/${encodeURIComponent(table)}/rows`,
      { datasourceId: opts.datasourceId ?? undefined, schema: opts.schema ?? undefined, limit: opts.limit, offset: opts.offset }),
  repoInsert: (table: string, body: { datasourceId?: string | null; schema?: string | null; values: Record<string, unknown> }) =>
    post<{ affected: number }>(`/repository/tables/${encodeURIComponent(table)}/rows`, body),
  repoUpdate: (table: string, body: { datasourceId?: string | null; schema?: string | null; set: Record<string, unknown>; key: Record<string, unknown> }) =>
    post<{ affected: number }>(`/repository/tables/${encodeURIComponent(table)}/rows/update`, body),
  repoDelete: (table: string, body: { datasourceId?: string | null; schema?: string | null; key: Record<string, unknown> }) =>
    post<{ affected: number }>(`/repository/tables/${encodeURIComponent(table)}/rows/delete`, body),
  repoExecute: (body: { datasourceId?: string | null; sql: string }) =>
    post<RepoExecResult>("/repository/execute", body),

  // --- schedulers (scheduled SQL → table) ---
  schedulers: () => get<Scheduler[]>("/schedulers"),
  scheduler: (id: number) => get<Scheduler>(`/schedulers/${id}`),
  createScheduler: (body: SaveSchedulerInput) => post<Scheduler>("/schedulers", body),
  updateScheduler: (id: number, body: SaveSchedulerInput) => put<Scheduler>(`/schedulers/${id}`, body),
  toggleScheduler: (id: number, enabled: boolean) => post<Scheduler>(`/schedulers/${id}/toggle`, { enabled }),
  runScheduler: (id: number) => post<SchedulerRun>(`/schedulers/${id}/run`, {}),
  schedulerRuns: (id: number, limit = 30) => get<SchedulerRun[]>(`/schedulers/${id}/runs`, { limit }),
  deleteScheduler: (id: number) => del(`/schedulers/${id}`),

  // --- data warehouse pipelines (source SELECT → target table) ---
  warehousePipelines: () => get<WarehousePipeline[]>("/warehouse/pipelines"),
  warehousePipeline: (id: number) => get<WarehousePipeline>(`/warehouse/pipelines/${id}`),
  createWarehousePipeline: (body: SaveWarehouseInput) => post<WarehousePipeline>("/warehouse/pipelines", body),
  updateWarehousePipeline: (id: number, body: SaveWarehouseInput) => put<WarehousePipeline>(`/warehouse/pipelines/${id}`, body),
  toggleWarehousePipeline: (id: number, enabled: boolean) => post<WarehousePipeline>(`/warehouse/pipelines/${id}/toggle`, { enabled }),
  runWarehousePipeline: (id: number) => post<WarehouseRun>(`/warehouse/pipelines/${id}/run`, {}),
  warehouseRuns: (id: number, limit = 30) => get<WarehouseRun[]>(`/warehouse/pipelines/${id}/runs`, { limit }),
  deleteWarehousePipeline: (id: number) => del(`/warehouse/pipelines/${id}`),

  // --- auth ---
  login: (username: string, password: string) =>
    post<LoginResponse>("/auth/login", { username, password }),
  me: () => get<MeResponse>("/auth/me"),
};

/** Public data-product URL for a shared view (CSV/XLSX/JSON, no auth needed). */
export function publicViewUrl(token: string, format: "csv" | "xlsx" | "json"): string {
  return `${base()}/public/view/${encodeURIComponent(token)}?format=${format}`;
}

/** Fetch a stored output as a Blob (with auth) — for inline PDF preview. */
export async function fetchOutputBlob(objectKey: string): Promise<Blob> {
  const res = await fetch(`${base()}/outputs/download?key=${encodeURIComponent(objectKey)}`, {
    headers: { ...authHeaders() },
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.blob();
}
