// Thin fetch wrapper around the Spring Boot backend.
// Works on both server and client components (NEXT_PUBLIC_ vars are inlined for both).

import type {
  IntegrationCategory, IntegrationItem, IntegrationTest, FileHubTarget, FileHubRef,
  ChainStepType,
  EtlChain,
  EtlChainRun,
  EtlChainRunStep,
  SaveChainInput,
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
  TenancyMine,
  TenantRow,
  ProjectRow,
  AccessMeta,
  AclObjectType,
  AclEntryRow,
  AclGrant,
  RowFilterObjectType,
  RowFilterRuleRow,
  RowFilterRuleInput,
  RowFilterPreviewInput,
  RowFilterPreview,
  OutputFile,
  OutputShare,
  OutputReview,
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
  RepoFolder,
  RepoOption,
  RepoTableEntry,
  RepoTableEntryInput,
  RepoTableMeta,
  RepoRows,
  RepoExecResult,
  Scheduler,
  SchedulerRun,
  SaveSchedulerInput,
  DataCheck,
  DataCheckRun,
  SaveCheckInput,
  RecentRun,
  StepType,
  WarehousePipeline,
  WarehouseRun,
  WarehouseRunStep,
  WarehouseStep,
  WarehouseTargetInfo,
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
  SqlRunLogRow, OutputTreeRow, OutputPage, CheckGroupSource, CheckRound, CheckFinding, ScopeAdoptResult,} from "./types";

/** Shown whenever the browser cannot reach the API at all (fetch rejects with a TypeError). */
export const NETWORK_ERROR = "Can't reach the server";
const NET_RE = /failed to fetch|networkerror|load failed|network request failed/i;

/** All API calls go through this: a network failure becomes one plain sentence instead of "Failed to fetch". */
const fetch: typeof globalThis.fetch = async (input, init) => {
  try {
    return await globalThis.fetch(input, init);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    if (e instanceof TypeError || NET_RE.test((e as Error)?.message ?? "")) throw new Error(NETWORK_ERROR);
    throw e;
  }
};

/** User-facing text for a caught error (network failures already arrive as NETWORK_ERROR). */
export function errMsg(e: unknown, fallback = "Something went wrong"): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!m) return fallback;
  return NET_RE.test(m) ? NETWORK_ERROR : m;
}

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

// --- auth token (client-only) ---------------------------------------------
// Primary store is localStorage (persists across tab-close/restart and is shared
// across tabs), MIRRORED into sessionStorage. When Report Studio shares this origin's
// localStorage with a host app, that app's logout may call localStorage.clear()
// — which would otherwise wipe rs.token and force a re-login. sessionStorage is a
// separate area that clear() does not touch, so when localStorage has been cleared
// out from under us we recover the token from the mirror (and repopulate localStorage).

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const ls = window.localStorage.getItem(TOKEN_KEY);
    if (ls) return ls;
    // localStorage was cleared (e.g. by /app's logout) — recover from the mirror.
    const ss = window.sessionStorage.getItem(TOKEN_KEY);
    if (ss) {
      try { window.localStorage.setItem(TOKEN_KEY, ss); } catch { /* ignore */ }
      return ss;
    }
    return null;
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token);
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } else {
      // Real sign-out / 401: clear BOTH so the token isn't resurrected from the mirror.
      window.localStorage.removeItem(TOKEN_KEY);
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* ignore */
  }
}

// --- current project (tenant comes from the signed-in identity) -------------
const PROJECT_KEY = "rs.project";

export function getProject(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PROJECT_KEY) || window.sessionStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setProject(project: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (project) {
      window.localStorage.setItem(PROJECT_KEY, project);
      window.sessionStorage.setItem(PROJECT_KEY, project);
    } else {
      window.localStorage.removeItem(PROJECT_KEY);
      window.sessionStorage.removeItem(PROJECT_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** Auth + project headers. Identity calls (/auth/*) never carry X-Project: a stale one must not lock anyone out. */
function authHeaders(path?: string): Record<string, string> {
  const t = getToken();
  const h: Record<string, string> = t ? { Authorization: `Bearer ${t}` } : {};
  const p = getProject();
  if (p && !(path && path.startsWith("/auth"))) h["X-Project"] = p;
  return h;
}

/**
 * The backend answers a request for an unknown/deactivated project with the default project and an
 * X-Project-Fallback header; forget the remembered project so the switcher and later calls follow.
 */
function noteProjectFallback(res: Response) {
  if (typeof window === "undefined") return;
  const fb = res.headers.get("X-Project-Fallback");
  if (fb) {
    setProject(null);
    window.dispatchEvent(new CustomEvent("rs-project-fallback", { detail: fb }));
  }
}

/** On 401: drop the stale token and let AppShell route to /login. */
function handleUnauthorized(res: Response) {
  if (res.status === 401 && typeof window !== "undefined") {
    setToken(null);
    window.dispatchEvent(new CustomEvent("rs-unauthorized"));
  }
}

// --- sliding session ------------------------------------------------------
// The backend JWT has a fixed TTL and there is no server-side session, so without
// renewal an actively-working user is kicked to /login when the token's exp passes.

/** Decode a JWT's iat/exp claims (epoch seconds) without verifying the signature. */
function tokenClaims(token: string): { iat: number; exp: number } | null {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
    return typeof json.iat === "number" && typeof json.exp === "number"
      ? { iat: json.iat, exp: json.exp }
      : null;
  } catch {
    return null;
  }
}

let refreshInFlight = false;
let lastRefreshCheck = 0;

/**
 * Piggybacks on successful API traffic (fire-and-forget from get/post/put): once the
 * token is past half its lifetime, swap it for a fresh one via POST /auth/refresh.
 * Active users therefore never hit the hard TTL, while an idle browser still expires
 * naturally. Failures are ignored on purpose — if the token is truly dead, the next
 * real call gets a 401 and handleUnauthorized routes to /login as before.
 */
function maybeRefreshToken(path: string): void {
  if (typeof window === "undefined" || path.startsWith("/auth")) return;
  const now = Date.now();
  if (refreshInFlight || now - lastRefreshCheck < 60_000) return;
  lastRefreshCheck = now;
  const token = getToken();
  if (!token) return;
  const claims = tokenClaims(token);
  if (!claims) return;
  const nowSec = now / 1000;
  if (nowSec >= claims.exp || nowSec - claims.iat < (claims.exp - claims.iat) / 2) return;
  refreshInFlight = true;
  fetch(base() + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Body-Encoding": "base64", ...authHeaders("/auth/refresh") },
    body: encodeBody("{}"),
  })
    .then(async (res) => {
      if (!res.ok) return;
      const j = (await res.json()) as LoginResponse;
      if (j?.token) setToken(j.token);
    })
    .catch(() => { /* ignore — next real call handles auth state */ })
    .finally(() => {
      refreshInFlight = false;
    });
}

// --- core helpers ---------------------------------------------------------

async function get<T>(path: string, params?: Record<string, string | number | string[] | undefined>): Promise<T> {
  const url = new URL(base() + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      // Arrays repeat the key (?eq=A=1&eq=B=2); String(array) would collapse them into one
      // comma-joined value and the server would read it as a single malformed pair.
      if (Array.isArray(v)) v.forEach((one) => url.searchParams.append(k, String(one)));
      else url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { cache: "no-store", headers: { ...authHeaders(path) } });
  if (!res.ok) {
    throw await apiError(res);
  }
  noteProjectFallback(res);
  maybeRefreshToken(path);
  return res.json() as Promise<T>;
}

/** GET a plain-text body (e.g. a job's captured run log) rather than JSON. */
async function getText(path: string): Promise<string> {
  const res = await fetch(base() + path, { cache: "no-store", headers: { ...authHeaders() } });
  if (!res.ok) {
    throw await apiError(res);
  }
  return res.text();
}

/** Error carrying the HTTP status and, for validation failures, the per-field messages. */
export class ApiError extends Error {
  status: number;
  fields: Record<string, string>;
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
  }
}

/** Per-field messages from a validation error ({message, fields:{...}}); empty for anything else. */
export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError ? e.fields : {};
}

/** HTTP status of a failed call, or 0 when unknown. */
export function errorStatus(e: unknown): number {
  return e instanceof ApiError ? e.status : 0;
}

async function apiError(res: Response): Promise<ApiError> {
  handleUnauthorized(res);
  noteProjectFallback(res);
  let msg = `API ${res.status}`;
  let fields: Record<string, string> = {};
  try {
    const j = await res.json();
    msg = j.message || j.error || msg;
    if (j.fields && typeof j.fields === "object") fields = j.fields as Record<string, string>;
    // older backends answered an unknown project with 400 "Unknown project: …"
    if (res.status === 400 && typeof msg === "string" && msg.startsWith("Unknown project") && typeof window !== "undefined") {
      setProject(null);
      window.dispatchEvent(new CustomEvent("rs-project-fallback", { detail: null }));
    }
  } catch {
    /* ignore */
  }
  if (res.status === 504 && msg === `API 504`) msg = "The server took too long to respond (504). Try again in a moment.";
  return new ApiError(msg, res.status, fields);
}

// Base64-encode a JSON string for transport. Some WAFs reject raw JSON bodies
// containing SQL function names like SUBSTR/ASCII/CHAR/BENCHMARK/SUBSTRING followed by
// "(" — a false-positive SQLi flag on legitimate SQL saved as configJson.
// Base64 hides those keywords; backend Base64BodyDecodeFilter restores the JSON.
function encodeBody(text: string): string {
  // Handles Thai/UTF-8 safely: TextEncoder→bytes→base64 via btoa over latin1.
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  return btoa(bin);
}

/**
 * Gzip a JSON body then base64 it.
 *
 * Plain base64 is not always enough: some WAFs base64-decode bodies and re-run their SQLi rules
 * on the result. Gzip first avoids that. Same approach as the file-upload path.
 *
 * Returns null when CompressionStream is unavailable so callers fall back to plain base64 —
 * that still covers the SUBSTR(/ASCII( false positives this started out solving.
 */
async function gzipBody(text: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CS: unknown = (globalThis as any).CompressionStream;
  if (typeof CS !== "function") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = new Blob([text]).stream().pipeThrough(new (CS as any)("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return bytesToBase64(new Uint8Array(buf));
  } catch {
    return null;
  }
}

/** Headers + body for a write, gzipped when the browser can do it. */
async function packBody(text: string): Promise<{ enc: string; body: string }> {
  const gz = await gzipBody(text);
  return gz ? { enc: "gzip+base64", body: gz } : { enc: "base64", body: encodeBody(text) };
}

async function post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const packed = text ? await packBody(text) : null;
  let res: Response;
  try {
    res = await fetchPost(path, packed, timeoutMs);
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ApiError("The server did not answer in time. Try again.", 0);
    }
    throw e;
  }
  if (!res.ok) throw await apiError(res);
  noteProjectFallback(res);
  maybeRefreshToken(path);
  // Some POSTs (retry) may return an empty body on success.
  const respText = await res.text();
  return (respText ? JSON.parse(respText) : undefined) as T;
}

function fetchPost(path: string, packed: { enc: string; body: string } | null, timeoutMs?: number): Promise<Response> {
  return fetch(base() + path, {
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(packed ? { "X-Body-Encoding": packed.enc } : {}),
      ...authHeaders(path),
    },
    body: packed ? packed.body : undefined,
  });
}

// NOTE: writes go out as POST + X-HTTP-Method-Override, never raw PUT/PATCH/DELETE.
// Some reverse proxies / WAFs block those methods with a 403 before they
// reach the app; the backend HttpMethodOverrideFilter restores the real method.
// They MUST carry a Content-Type + JSON body — some WAFs also reject a bodyless POST,
// so we always send at least "{}".
async function put<T>(path: string, body?: unknown): Promise<T> {
  const text = body === undefined ? "{}" : JSON.stringify(body);
  const packed = await packBody(text);
  const res = await fetch(base() + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HTTP-Method-Override": "PUT",
      "X-Body-Encoding": packed.enc,
      ...authHeaders(path),
    },
    body: packed.body,
  });
  if (!res.ok) throw await apiError(res);
  noteProjectFallback(res);
  maybeRefreshToken(path);
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
      ...authHeaders(path),
    },
    body: encodeBody("{}"),
  });
  if (!res.ok) throw await apiError(res);
  noteProjectFallback(res);
}

/** POST that expects a binary (xlsx) response and triggers a browser download. */
async function postBlob(path: string, body: unknown, filename: string): Promise<void> {
  const res = await fetch(base() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res);
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
 * Gzip a File then base64-encode it. Some WAFs decode base64 inside a JSON body and run
 * SQLi rules on the decoded bytes, so a .jrxml containing `SELECT … FROM … WHERE …` can be
 * rejected even when base64-wrapped. Gzipping first avoids that. The server
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

/**
 * Download a GET endpoint (e.g. a stored output) as a file.
 *
 * The blob is saved under the server's Content-Disposition filename when it sends one, and only
 * falls back to the caller's guess otherwise. Building the name here means guessing at the
 * server's clock: the browser stamps UTC, so an export made early in the morning in a UTC+ time zone
 * could land under yesterday's date.
 */
async function downloadGet(path: string, filename: string): Promise<void> {
  const res = await fetch(base() + path, { headers: { ...authHeaders() } });
  if (!res.ok) throw await apiError(res);
  const blob = await res.blob();
  saveAs(blob, filenameFrom(res) ?? filename);
}

/** RFC 5987 `filename*` first (it carries the charset), then a plain quoted `filename`. */
function filenameFrom(res: Response): string | null {
  const cd = res.headers.get("content-disposition");
  if (!cd) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : null;
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
  testData?: boolean;
  note?: string;
  /** Gateway defaults from the wizard's last step. */
  priority?: string;
  /** 1–1440 */
  timeoutMinutes?: number;
  queue?: string;
}

export interface CategoryInput { id?: string; name: string; description?: string | null; sortOrder?: number | null }

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
  /** Optional text stamped across the output (blank = none). */
  watermark?: string;
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
  const p = getProject();
  return `${base()}/outputs/${encodeURIComponent(objectKey)}/download${p ? `?project=${encodeURIComponent(p)}` : ""}`;
}

/** How many distinct values a filter picker loads at once. The server caps at 500. */
export const OPT_LIMIT = 200;

/**
 * Every screen query goes through the server-side queue: submit, then poll for the result.
 *
 * Why: a CDN/edge proxy in front of the app cuts requests idle for more than ~50 seconds and
 * returns its own "520" HTML page, so a heavy query (e.g. a pipeline source that takes minutes)
 * can never succeed in a single request. Callers are unchanged; this function hides the polling.
 *
 * Not an opt-in per screen on purpose: a screen that picks "wait inline" runs into the 520 again.
 */
async function runQueued<T>(submitPath: string, resultPath: string, body: unknown): Promise<T> {
  const { id } = await post<{ id: string; status: string }>(submitPath, body);
  const startedAt = Date.now();
  for (;;) {
    const job = await get<{ status: string; result: T; error: string | null; ms: number | null }>(
      `${resultPath}/${encodeURIComponent(id)}`);
    if (job.status === "ok") return job.result;
    if (job.status === "error") throw new Error(job.error || "Query failed");
    // Poll often at first (most queries finish fast), then back off.
    const waited = Date.now() - startedAt;
    await new Promise((r) => setTimeout(r, waited < 10_000 ? 700 : waited < 60_000 ? 1_500 : 3_000));
  }
}

export const api = {
  // --- catalog / reports ---
  dashboard: () => get<DashboardSummary>("/dashboard/summary"),
  categories: () => get<Category[]>("/categories"),
  createCategory: (body: CategoryInput) => post<Category>("/categories", body),
  updateCategory: (id: string, body: CategoryInput) => put<Category>(`/categories/${encodeURIComponent(id)}`, body),
  deleteCategory: (id: string) => del(`/categories/${encodeURIComponent(id)}`),
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
  jobLog: (id: string) => getText(`/jobs/${encodeURIComponent(id)}/log`),

  // --- outputs ---
  outputs: () => get<OutputFile[]>("/outputs"),
  /** Per-report totals for the Output Files folder rail (a few hundred rows, not every file). */
  outputsTree: () => get<OutputTreeRow[]>("/outputs/tree"),
  /** One page of the file list; report = comma-separated report codes (empty = all). */
  outputsPage: (opts: { report?: string; q?: string; limit?: number; offset?: number } = {}) =>
    get<OutputPage>("/outputs/page", {
      report: opts.report || undefined, q: opts.q || undefined,
      limit: opts.limit ?? 100, offset: opts.offset ?? 0,
    }),
  /** Create or reissue a share link; no days = never expires; reissuing revokes the old link. */
  /** The key goes in a query param, not the path: objectKey contains '/', which Tomcat
   *     rejects with 400 when encoded in a path (same as downloadOutput). */
  shareOutput: (objectKey: string, days: number | null) =>
    post<OutputShare>(`/outputs/share?key=${encodeURIComponent(objectKey)}`, { days }),
  unshareOutput: (objectKey: string) => del(`/outputs/share?key=${encodeURIComponent(objectKey)}`),
  /** Email a download link; user-triggered, never sent automatically on render. */
  emailOutputShare: (objectKey: string, body: { to: string; cc?: string; note?: string; days?: number }) =>
    post<{ to: string; url: string; expiresAt: string | null; notifiedOnScreen: number }>(
      `/outputs/share/email?key=${encodeURIComponent(objectKey)}`, body),
  downloadOutput: (objectKey: string, filename?: string) =>
    downloadGet(`/outputs/download?key=${encodeURIComponent(objectKey)}`,
      filename ?? objectKey.split("/").pop() ?? objectKey),
  /** Mark a rendered file as checked. Re-confirming just refreshes who and when. */
  confirmOutput: (objectKey: string, note?: string) =>
    post<OutputReview>("/outputs/confirm", { objectKey, note: note ?? null }),
  unconfirmOutput: (objectKey: string) =>
    del(`/outputs/confirm?key=${encodeURIComponent(objectKey)}`),

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
  deleteEnginePlugin: (jar: string) => del(`/engines/plugins/${encodeURIComponent(jar)}`),
  reloadEnginePlugins: () =>
    post<{ jar: string | null; jars: string[]; availableKinds: string[] }>("/engines/plugins/reload", undefined),

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
    // Send the file gzipped-then-base64'd inside a JSON body. Some WAFs reject uploads whose
    // decoded content contains `SELECT ... FROM ... WHERE` (false-positive SQLi), and may decode
    // base64 inside JSON, so raw base64 isn't always enough. The server
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
    put<{ ok: boolean; executed?: boolean; notExecutedStages?: string[] }>(`/reports/${encodeURIComponent(code)}/flow`, doc),

  // --- users (Settings) ---
  users: () => get<UserRow[]>("/users"),
  createUser: (body: { username: string; password: string; role: string; displayName: string }) =>
    post<UserRow>("/users", body, 20_000),
  updateUser: (username: string, body: { role: string; displayName: string }) =>
    put<UserRow>(`/users/${encodeURIComponent(username)}`, body),
  resetPassword: (username: string, password: string) =>
    post<UserRow>(`/users/${encodeURIComponent(username)}/password`, { password }, 20_000),
  deleteUser: (username: string) => del(`/users/${encodeURIComponent(username)}`),

  // --- analytics extras (real meta / history / saved views) ---
  analyticsMeta: () => get<AnalyticsMeta>("/analytics/meta"),
  adhocHistory: () => get<AdhocHistoryRow[]>("/adhoc/history"),
  savedViews: (kind: "pivot" | "adhoc" | "sql", workspace?: number) =>
    get<SavedViewRow[]>("/views", { kind, workspace }),
  /**
   * workspaceId = 0 means "not selected" (getSharedWorkspace returns 0 on empty localStorage).
   *    Never send it: it violates saved_view's foreign key (500). Drop it and let the backend pick
   *    the default. Affects every SaveDestination screen (SQL Editor, Workbench, Dashboards, Ad-hoc, Tables).
   */
  saveView: (body: { kind: string; name: string; dataset?: string; payload: string; workspaceId?: number; folder?: string; isPublic?: boolean }) =>
    post<SavedViewRow>("/views", { ...body, workspaceId: body.workspaceId && body.workspaceId > 0 ? body.workspaceId : undefined }),
  /** Update a saved view in place (POST always creates a new one; they are not interchangeable). */
  updateView: (id: number, body: { name?: string; dataset?: string; payload?: string; workspaceId?: number; folder?: string; isPublic?: boolean }) =>
    put<SavedViewRow>(`/views/${id}`, { ...body, workspaceId: body.workspaceId && body.workspaceId > 0 ? body.workspaceId : undefined }),
  deleteView: (id: number) => del(`/views/${id}`),
  /** Move into/out of a folder; empty folder = top level. */
  moveView: (id: number, folder: string | null) =>
    post<SavedViewRow>(`/views/${id}/move`, { folder: folder ?? "" }),
  setViewVisibility: (id: number, isPublic: boolean) =>
    post<SavedViewRow>(`/views/${id}/visibility`, { isPublic }),
  shareView: (id: number) => post<SavedViewRow>(`/views/${id}/share`),
  unshareView: (id: number) => del(`/views/${id}/share`),
  exportView: (id: number, format: "csv" | "xlsx" | "json", filename: string) =>
    downloadGet(`/views/${encodeURIComponent(id)}/export?format=${format}`, filename),

  // --- workspaces (group views + dashboards) ---
  workspaces: () => get<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) => post<Workspace>("/workspaces", { name }),

  // --- datasets (SQL query editor) ---
  datasets: () => get<DatasetDef[]>("/datasets"),
  createDataset: (body: { name: string; description?: string; datasourceId?: string | null; sqlText: string; folder?: string | null; dimensionColumns?: string | null }) =>
    post<DatasetDef>("/datasets", body),
  updateDataset: (id: number, body: { name: string; description?: string; folder?: string | null; datasourceId?: string | null; sqlText: string; dimensionColumns?: string | null }) =>
    put<DatasetDef>(`/datasets/${id}`, body),
  deleteDataset: (id: number) => del(`/datasets/${id}`),
  captureDataset: (id: number) => post<DatasetDef>(`/datasets/${id}/capture`),
  uncaptureDataset: (id: number) => {
    // DELETE that returns the updated dataset
    return fetch(`${base()}/datasets/${id}/capture`, { method: "DELETE", headers: { ...authHeaders() } })
      .then(async (r) => { if (!r.ok) throw await apiError(r); return r.json() as Promise<DatasetDef>; });
  },
  /** Non-admins must send datasourceId; datasetId when previewing an existing dataset. */
  previewDataset: (body: { datasourceId?: string | null; sql: string; datasetId?: number | null }) =>
    post<TableResult>("/datasets/preview", body),
  datasetFields: (id: number) => get<DatasetColumn[]>(`/datasets/${id}/fields`),
  datasetDistinct: (id: number, field: string) => get<string[]>(`/datasets/${id}/distinct`, { field }),
  /** Export a dataset result to Excel, using the same server-side aggregate as Run. */
  datasetExport: (id: number, body: { dims: string[]; measures: string[]; filters: Record<string, string> },
                  filename: string) =>
    postBlob(`/datasets/${id}/export`, body, filename),
  datasetAggregate: (id: number, body: { dims: string[]; measures: string[]; filters?: Record<string, string>; agg?: AggFn }) =>
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

  // --- datasources (real probe + create + default + delete) ---
  testDatasource: (id: string) => post<DsTestResult>(`/datasources/${encodeURIComponent(id)}/test`),
  createDatasource: (body: { id: string; name: string; engine: string; host?: string; schemaName?: string; pool?: string; jdbcUrl?: string; dbUser?: string; dbPassword?: string }) =>
    post<Datasource>("/datasources", body),
  // Edit an existing datasource (e.g. fill a missing jdbcUrl). dbPassword blank = keep the stored one.
  updateDatasource: (id: string, body: { name: string; engine: string; host?: string; schemaName?: string; jdbcUrl?: string; dbUser?: string; dbPassword?: string }) =>
    put<Datasource>(`/datasources/${encodeURIComponent(id)}`, body),
  setDefaultDatasource: (id: string) => post<Datasource[]>(`/datasources/${encodeURIComponent(id)}/default`, undefined),
  deleteDatasource: (id: string) => del(`/datasources/${encodeURIComponent(id)}`),

  // --- repository (Database Tool: browse + edit table data, run SQL) ---
  repoTables: (datasourceId?: string | null) =>
    get<RepoTable[]>("/repository/tables", { datasourceId: datasourceId ?? undefined }),
  repoTableMeta: (table: string, datasourceId?: string | null, schema?: string | null) =>
    get<RepoTableMeta>(`/repository/tables/${encodeURIComponent(table)}/meta`,
      { datasourceId: datasourceId ?? undefined, schema: schema ?? undefined }),
  // `eq` is a repeatable COLUMN=value restriction — a screen pinned to one slice of a table
  // (e.g. a branch registry = BRANCH with a fixed PARENT_ID) passes what its registry entry stores.
  // eq goes out as ONE param with ';'-separated pairs, never repeated. A reverse proxy in front of
  // the app 403s any request that repeats a query-parameter name, so two filters sent as
  // two eq params never reach the app; the backend splits this back apart.
  /** `withTotal` also counts the filtered set — ask on the first page of a filter, not on every click. */
  repoRows: (table: string, opts: { datasourceId?: string | null; schema?: string | null; limit?: number; offset?: number; eq?: string[]; withTotal?: boolean; withRowId?: boolean;
                                   /** Column-header funnel filters as one JSON value (the edge 403s repeated param names) */
                                   filters?: string;
                                   /** Column sort, "COL,asc" or "COL,desc" */
                                   sort?: string } = {}) =>
    get<RepoRows>(`/repository/tables/${encodeURIComponent(table)}/rows`, {
      sort: opts.sort || undefined,
      datasourceId: opts.datasourceId ?? undefined,
      schema: opts.schema ?? undefined,
      limit: opts.limit,
      offset: opts.offset,
      eq: opts.eq && opts.eq.length ? opts.eq.join(";") : undefined,
      filters: opts.filters || undefined,
      withTotal: opts.withTotal ? "true" : undefined,
      // Request ROWID only for tables keyed by ROWID, not on every screen.
      withRowId: opts.withRowId ? "true" : undefined,
    }),
  /**
   * Values to offer in a filter picker for one column of a data screen. Capped, so a column with
   * thousands of distinct values (a branch list has thousands) stays a fast dropdown — pass `q` to search the
   * whole column server-side instead of only the slice already loaded.
   */
  /**
   * Filter-picker values. `labelSource` names where the text beside the code comes from — a column
   * of the same table, or `SCHEMA.TABLE.CODE.NAME` for a lookup; omit it for code-only.
   */
  repoDistinct: (table: string, column: string,
                 opts: { datasourceId?: string | null; schema?: string | null; q?: string; labelSource?: string | null; eq?: string[]; optionsFrom?: string | null;
                         /** Filters from other column funnels, so the value list narrows to the current filter */
                         filters?: string } = {}) =>
    get<RepoOption[]>(`/repository/tables/${encodeURIComponent(table)}/distinct`, {
      column, labelSource: opts.labelSource || undefined,
      datasourceId: opts.datasourceId ?? undefined, schema: opts.schema ?? undefined,
      q: opts.q || undefined, limit: OPT_LIMIT,
      // Small lookup table holding this column's possible values; when set, the data table is not touched.
      optionsFrom: opts.optionsFrom || undefined,
      // The screen's current filters: on a list-partitioned fact table these turn a full scan into
      // a single-partition read. Packed with ';' into one param, same reason as repoRows.
      eq: opts.eq && opts.eq.length ? opts.eq.join(";") : undefined,
      filters: opts.filters || undefined,
    }),
  /**
   * Queue an export on the real export pipeline (engine sql) and return the job id without waiting.
   * Large tables must go this way: writing the file on the request thread stalls until the edge
   * may cut it off while the DB query keeps running. `year` is required for tables with a year
   * column, otherwise the server refuses.
   */
  repoExportJob: (table: string, format: "txt" | "csv" | "xlsx",
                  opts: { datasourceId?: string | null; schema?: string | null; eq?: string[]; year?: string;
                          /** Configured year column the year applies to */
                          yearColumn?: string;
                          /** Column order on screen; the file follows the same order */
                          columns?: string[];
                          /** Column-header filters; the file honours them */
                          filters?: string;
                          /** File header labels when they differ from the column name: "COL=Label", separated by ; */
                          labels?: string;
                          /** Human name for the export job (shown in the queue / output list) */
                          label?: string;
                          /** Column sort, "COL,asc" or "COL,desc" — same as the grid */
                          sort?: string } = {}) => {
    const p = new URLSearchParams();
    p.set("format", format);
    if (opts.sort) p.set("sort", opts.sort);
    if (opts.datasourceId) p.set("datasourceId", opts.datasourceId);
    if (opts.schema) p.set("schema", opts.schema);
    if (opts.year) p.set("year", opts.year);
    if (opts.yearColumn) p.set("yearColumn", opts.yearColumn);
    if (opts.eq && opts.eq.length) p.set("eq", opts.eq.join(";"));
    if (opts.columns && opts.columns.length) p.set("columns", opts.columns.join(","));
    if (opts.filters) p.set("filters", opts.filters);
    if (opts.labels) p.set("labels", opts.labels);
    if (opts.label) p.set("label", opts.label);
    return post<{ jobId: string; sql: string }>(`/repository/tables/${encodeURIComponent(table)}/export-job?${p}`, {});
  },
  /**
   * Whole filtered table as a file. eq pairs pre-joined with ';' into ONE param — the generic
   * get() helper repeats array params, which the the WAF edge 403s. Server caps at 50,000 rows.
   */
  repoExport: (table: string, format: "txt" | "csv" | "xlsx",
               opts: { datasourceId?: string | null; schema?: string | null; eq?: string[] } = {}) => {
    const p = new URLSearchParams();
    p.set("format", format);
    if (opts.datasourceId) p.set("datasourceId", opts.datasourceId);
    if (opts.schema) p.set("schema", opts.schema);
    if (opts.eq && opts.eq.length) p.set("eq", opts.eq.join(";"));
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return downloadGet(`/repository/tables/${encodeURIComponent(table)}/export?${p}`,
        `${table}_${stamp}.${format}`);
  },
  /**
   * Download the file of a finished queued job directly, so users don't have to find it on the
   * Output Files screen (otherwise an export looks like it did nothing).
   */
  jobOutput: (jobId: string, filename: string) =>
    downloadGet(`/jobs/${encodeURIComponent(jobId)}/output/download`, filename),
  repoRegistry: (menu?: string | null) =>
    get<RepoTableEntry[]>("/repository/registry", { menu: menu ?? undefined }),
  repoRegistryAdd: (body: RepoTableEntryInput) => post<RepoTableEntry>("/repository/registry", body),
  repoRegistryUpdate: (id: number, body: RepoTableEntryInput) => put<RepoTableEntry>(`/repository/registry/${id}`, body),
  repoRegistryRemove: (id: number) => del(`/repository/registry/${id}`),
  repoFolders: (menu?: string | null) =>
    get<RepoFolder[]>("/repository/folders", { menu: menu ?? undefined }),
  repoFolderAdd: (body: { menuKey: string | null; parentId: number | null; name: string }) =>
    post<RepoFolder>("/repository/folders", body),
  repoFolderUpdate: (id: number, body: { menuKey: string | null; parentId: number | null; name: string; sortOrder?: number }) =>
    put<RepoFolder>(`/repository/folders/${id}`, body),
  /** Write the order of a whole level at once; send ids in the desired order. */
  repoFolderReorder: (ids: number[]) => put<RepoFolder[]>("/repository/folders/reorder", { ids }),
  repoFolderRemove: (id: number) => del(`/repository/folders/${id}`),
  repoInsert: (table: string, body: { datasourceId?: string | null; schema?: string | null; values: Record<string, unknown> }) =>
    post<{ affected: number }>(`/repository/tables/${encodeURIComponent(table)}/rows`, body),
  repoUpdate: (table: string, body: { datasourceId?: string | null; schema?: string | null; set: Record<string, unknown>; key: Record<string, unknown> }) =>
    post<{ affected: number }>(`/repository/tables/${encodeURIComponent(table)}/rows/update`, body),
  repoDelete: (table: string, body: { datasourceId?: string | null; schema?: string | null; key: Record<string, unknown> }) =>
    post<{ affected: number }>(`/repository/tables/${encodeURIComponent(table)}/rows/delete`, body),
  /** Export the result of typed SQL without saving it first; the server reruns it and writes the
      full result, not just the rows loaded on screen (Ad-hoc, SQL tab). */
  exportSqlResult: (body: { datasourceId?: string | null; sql: string;
                            /** Header filters open on screen, so the file matches what is shown */
                            filters?: Record<string, { values: string[]; contains: string }>;
                            variables?: Record<string, string> },
                    format: "csv" | "xlsx", filename: string) =>
    postBlob(`/repository/execute/export?format=${format}`, body, filename),
  /** Recent runs from the free-form SQL box (successful and failed). */
  sqlRunHistory: (limit = 30, mine = false) =>
    get<SqlRunLogRow[]>("/repository/execute/history", { limit, mine: mine ? "true" : undefined }),
  /** variables: values for $NAME / :name variables found in the SQL */
  repoExecute: (body: { datasourceId?: string | null; sql: string; source?: string; variables?: Record<string, string> }) =>
    runQueued<RepoExecResult>("/repository/execute", "/repository/execute/result", body),

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
  // year: what the portal is set to — the server needs it for $YEAR4/$YEAR2 in the source SQL
  runWarehousePipeline: (id: number, year?: string, params?: Record<string, string>) =>
    post<WarehouseRun>(`/warehouse/pipelines/${id}/run${year ? `?year=${encodeURIComponent(year)}` : ""}`,
                       params ?? {}),
  /** Latest runs of every pipeline in one request, for the cards' history strips. */
  warehouseRecentRuns: (perPipeline = 12) =>
    get<RecentRun[]>("/warehouse/runs/recent", { perPipeline }),
  warehouseStepTypes: () => get<StepType[]>("/warehouse/step-types"),
  warehouseSteps: (id: number) => get<WarehouseStep[]>(`/warehouse/pipelines/${id}/steps`),
  saveWarehouseSteps: (id: number, steps: WarehouseStep[]) =>
    put<WarehouseStep[]>(`/warehouse/pipelines/${id}/steps`, steps),
  warehouseRunSteps: (runId: number) => get<WarehouseRunStep[]>(`/warehouse/runs/${runId}/steps`),
  warehouseRuns: (id: number, limit = 30) => get<WarehouseRun[]>(`/warehouse/pipelines/${id}/runs`, { limit }),
  /** Cancel a job: queued ones are withdrawn, running ones are stopped down to the DB statement. */
  cancelWarehouseRun: (runId: number) => post<WarehouseRun>(`/warehouse/runs/${runId}/cancel`, {}),
  // Look before writing: what the source SQL returns, year already substituted.
  warehousePreview: (body: { datasourceId?: string | null; sql: string; year?: string; limit?: number }) =>
    runQueued<TableResult>("/warehouse/preview", "/warehouse/preview/result", body),
  warehouseTarget: (id: number) => get<WarehouseTargetInfo>(`/warehouse/pipelines/${id}/target`),

  // --- data checks (SELECT the wrong rows; 0 rows = pass) ---
  checks: () => get<DataCheck[]>("/checks"),
  createCheck: (body: SaveCheckInput) => post<DataCheck>("/checks", body),
  updateCheck: (id: number, body: SaveCheckInput) => put<DataCheck>(`/checks/${id}`, body),
  toggleCheck: (id: number, enabled: boolean) => post<DataCheck>(`/checks/${id}/toggle`, { enabled }),
  runCheck: (id: number, year?: string) =>
    post<DataCheckRun>(`/checks/${id}/run${year ? `?year=${encodeURIComponent(year)}` : ""}`, {}),
  /** Run several checks in one request; returns once all are queued, without waiting.
   *  Select by ids, or a whole group by folder (null = ungrouped). */
  runChecksBatch: (body: { ids?: number[]; folder?: string | null }, year?: string) =>
    post<DataCheckRun[]>(`/checks/run${year ? `?year=${encodeURIComponent(year)}` : ""}`, body),
  /** Move a check into/out of a group; sends only the group name so nobody's SQL is overwritten. */
  setCheckFolder: (id: number, folder: string | null) =>
    post<DataCheck>(`/checks/${id}/folder`, { folder }),
  /** Rename a group; every member moves with it. */
  renameCheckFolder: (from: string, to: string) =>
    post<{ moved: number }>("/checks/folder/rename", { from, to }),
  /** Group source: the table the rules read, the pipeline that fills it, and its freshness. */
  checkGroupSource: (folder: string, opts: { year?: string; withRows?: boolean } = {}) =>
    get<CheckGroupSource>("/checks/group/source",
      { folder, year: opts.year || undefined, withRows: opts.withRows ? "true" : undefined }),
  /** Export the per-item result table as shown: .csv / .xlsx / .txt (server-side). */
  exportFindings: (body: { columns: string[]; rows: string[][]; filename: string },
                   format: "csv" | "xlsx" | "txt", filename: string) =>
    postBlob(`/checks/findings/export?format=${format}`, body, filename),
  /** Set the group scope; source may be a table name or a full SELECT. */
  saveCheckScope: (folder: string, body: { source: string; conditions: string[] }) =>
    put<CheckGroupSource>(`/checks/group/scope?folder=${encodeURIComponent(folder)}`, body),
  /** Rewrite every rule in the group to use $SCOPE; apply=false = dry run. */
  adoptCheckScope: (folder: string, apply: boolean) =>
    post<ScopeAdoptResult[]>(
      `/checks/group/scope/adopt?folder=${encodeURIComponent(folder)}&apply=${apply ? "true" : "false"}`, {}),
  /** Clear the manual scope and infer it from the members' SQL again. */
  clearCheckScope: (folder: string) =>
    del(`/checks/group/scope?folder=${encodeURIComponent(folder)}`),
  /** Check-round history of a group, newest first. */
  checkGroupRounds: (folder: string, limit = 20) => get<CheckRound[]>("/checks/group/rounds", { folder, limit }),
  /** Per-rule results of one round. */
  checkRoundRuns: (batchId: string) => get<DataCheckRun[]>(`/checks/group/rounds/${encodeURIComponent(batchId)}`),
  /** Per-item results of a group: every failing rule, grouped by the offending item. */
  /** batchId = failures of that round (as stored at run time); empty = latest result per rule. */
  checkGroupFindings: (folder: string, year?: string, batchId?: string) =>
    get<CheckFinding[]>("/checks/group/findings",
      { folder, year: year || undefined, batchId: batchId || undefined }),
  checkRuns: (id: number, limit = 30) => get<DataCheckRun[]>(`/checks/${id}/runs`, { limit }),
  /** The rows behind a failure — re-run on demand, never stored. */
  checkRows: (id: number, year?: string, limit = 100) =>
    get<TableResult>(`/checks/${id}/rows`, { year, limit }),
  deleteCheck: (id: number) => del(`/checks/${id}`),

  // --- ETL chains (ordered steps, one round per run) ---
  chainStepTypes: () => get<ChainStepType[]>("/etl-chains/step-types"),
  chains: () => get<EtlChain[]>("/etl-chains"),
  chain: (id: number) => get<EtlChain>(`/etl-chains/${id}`),
  createChain: (body: SaveChainInput) => post<EtlChain>("/etl-chains", body),
  updateChain: (id: number, body: SaveChainInput) => put<EtlChain>(`/etl-chains/${id}`, body),
  deleteChain: (id: number) => del(`/etl-chains/${id}`),
  /** 202 — the round is opened and the steps run on a worker; poll chainRuns for the outcome. */
  runChain: (id: number, year?: string) => post<EtlChainRun>(`/etl-chains/${id}/run`, { year: year ?? null }),
  chainRuns: (id: number, limit = 50) => get<EtlChainRun[]>(`/etl-chains/${id}/runs`, { limit }),
  chainRunSteps: (runId: number) => get<EtlChainRunStep[]>(`/etl-chains/runs/${runId}/steps`),
  /** Cancel the whole run: stops before the next step and stops any pipeline step still running in the DB. */
  cancelChainRun: (runId: number) => post<EtlChainRun>(`/etl-chains/runs/${runId}/cancel`, {}),
  /** Start a new run from this run's first unpassed step; passed steps are skipped with a recorded reason. */
  resumeChainRun: (runId: number) => post<EtlChainRun>(`/etl-chains/runs/${runId}/resume`, {}),
  deleteWarehousePipeline: (id: number) => del(`/warehouse/pipelines/${id}`),

  // --- auth ---
  login: (username: string, password: string) =>
    post<LoginResponse>("/auth/login", { username, password }),
  me: () => get<MeResponse>("/auth/me"),

  // --- tenants / projects ---
  tenancyMine: () => get<TenancyMine>("/tenancy/mine"),
  tenants: () => get<TenantRow[]>("/tenancy/tenants"),
  createTenant: (body: { id: string; name: string; iamTenantId?: string }) => post<TenantRow>("/tenancy/tenants", body),
  updateTenant: (id: string, body: { name?: string; iamTenantId?: string; active?: boolean }) =>
    put<TenantRow>(`/tenancy/tenants/${encodeURIComponent(id)}`, body),
  projects: (tenantId: string) => get<ProjectRow[]>(`/tenancy/tenants/${encodeURIComponent(tenantId)}/projects`),
  createProject: (tenantId: string, body: { id: string; name: string; iamAppCode?: string }) =>
    post<ProjectRow>(`/tenancy/tenants/${encodeURIComponent(tenantId)}/projects`, body),
  updateProject: (tenantId: string, id: string, body: { name?: string; iamAppCode?: string; active?: boolean }) =>
    put<ProjectRow>(`/tenancy/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(id)}`, body),

  // --- integrations ---
  integrations: () => get<{ categories: IntegrationCategory[] }>("/integrations"),
  saveIntegration: (id: string, body: { name?: string; enabled?: boolean; config: Record<string, unknown> }) =>
    put<IntegrationItem>(`/integrations/${encodeURIComponent(id)}`, body),
  createIntegration: (body: { type: string; id?: string; name: string; enabled?: boolean; config: Record<string, unknown> }) =>
    post<IntegrationItem>("/integrations", body),
  deleteIntegration: (id: string) => del(`/integrations/${encodeURIComponent(id)}`),
  /** config = typed (unsaved) values; omitted = test the saved values and record the result. */
  testIntegration: (id: string, config?: Record<string, unknown>) =>
    post<IntegrationTest>(`/integrations/${encodeURIComponent(id)}/test`, config ? { config } : {}),
  fileHubTargets: () => get<FileHubTarget[]>("/integrations/targets/filehub"),
  publishOutputToFileHub: (objectKey: string, connectorId?: string) =>
    post<FileHubRef>(`/outputs/filehub?key=${encodeURIComponent(objectKey)}`, { connectorId }),
  publishOutputsToFileHub: (keys: string[], connectorId?: string) =>
    post<{ objectKey: string; ok: boolean; filehub: FileHubRef | null; error: string | null }[]>("/outputs/filehub/bulk", { keys, connectorId }),
  reportDelivery: (code: string) => get<{ connectorId: string | null; path: string | null; example: string }>(`/reports/${encodeURIComponent(code)}/delivery`),
  saveReportDelivery: (code: string, body: { connectorId: string | null; path: string | null }) =>
    put<{ connectorId: string | null; path: string | null; example: string }>(`/reports/${encodeURIComponent(code)}/delivery`, body),

  // --- IAM ---
  /** Ends the server session; failures are ignored so sign-out always completes locally. */
  logout: () => post<unknown>("/auth/logout", {}).catch(() => undefined),
  exportIamObjects: (appCode = "RH") => downloadGet(`/iam/objects/export?appCode=${encodeURIComponent(appCode)}`, "reporthub-iam-objects.json"),

  // --- access: object ACL (level 2) and row filters (level 3) ---
  accessMeta: () => get<AccessMeta>("/acl/meta"),
  acl: (type: AclObjectType, id: string) => get<AclEntryRow[]>(`/acl/${type}/${encodeURIComponent(id)}`),
  saveAcl: (type: AclObjectType, id: string, grants: AclGrant[]) =>
    put<AclEntryRow[]>(`/acl/${type}/${encodeURIComponent(id)}`, grants),
  rowFilters: (type: RowFilterObjectType, id: string) => get<RowFilterRuleRow[]>(`/row-filters/${type}/${encodeURIComponent(id)}`),
  saveRowFilters: (type: RowFilterObjectType, id: string, rules: RowFilterRuleInput[]) =>
    put<RowFilterRuleRow[]>(`/row-filters/${type}/${encodeURIComponent(id)}`, rules),
  previewRowFilters: (type: RowFilterObjectType, id: string, body: RowFilterPreviewInput) =>
    post<RowFilterPreview>(`/row-filters/${type}/${encodeURIComponent(id)}/preview`, body),
};

export type AggFn = "sum" | "avg" | "min" | "max" | "count";

/** Absolute share link: the server's url when absolute, else API base + path. */
export function shareLink(share: { url?: string | null; path?: string | null }): string {
  if (share.url && /^https?:\/\//i.test(share.url)) return share.url;
  if (share.path) return base() + share.path;
  if (share.url) return share.url.startsWith("/") && typeof window !== "undefined" ? window.location.origin + share.url : share.url;
  return "";
}

/** Public data-product URL for a shared view (CSV/XLSX/JSON, no auth needed). */
export function publicViewUrl(token: string, format: "csv" | "xlsx" | "json"): string {
  return `${base()}/public/view/${encodeURIComponent(token)}?format=${format}`;
}

/** Fetch a stored output as a Blob (with auth) — for inline PDF preview. */
export async function fetchOutputBlob(objectKey: string): Promise<Blob> {
  const res = await fetch(`${base()}/outputs/download?key=${encodeURIComponent(objectKey)}`, {
    headers: { ...authHeaders() },
  });
  if (!res.ok) throw await apiError(res);
  return res.blob();
}

// --- built-in Documents ------------------------------------------------------
import type { DocContent, DocSummary, DocRecord, DocAsset, BlockData, PrintPayload } from "./document/types";

/** Absolute URL for a backend path (used for <img src> of public document assets). */
export function apiUrl(path: string): string {
  return base() + path;
}

export const docApi = {
  list: () => get<DocSummary[]>("/documents"),
  get: (id: number) => get<DocRecord>(`/documents/${id}`),
  create: (body: { title: string; description?: string; folder?: string; content: DocContent }) =>
    post<DocRecord>("/documents", body),
  save: (id: number, body: { title: string; description?: string | null; folder?: string | null; content: DocContent; revision?: number }) =>
    put<DocRecord>(`/documents/${id}`, body),
  copy: (id: number) => post<DocRecord>(`/documents/${id}/copy`, {}),
  remove: (id: number) => del(`/documents/${id}`),
  /** Resolve bound table data for (possibly unsaved) editor content. */
  dataFor: (content: DocContent, params: Record<string, string>) =>
    post<Record<string, BlockData>>("/documents/data", { content, params }),
  exportPdf: (id: number, params: Record<string, string>, filename: string) =>
    postBlob(`/documents/${id}/pdf`, { params }, filename),
  publishToFileHub: (id: number, params: Record<string, string> = {}, connectorId?: string) =>
    post<DocSummary>(`/documents/${id}/filehub`, { params, connectorId }),
  assets: (id: number) => get<DocAsset[]>(`/documents/${id}/assets`),
  upload: async (id: number, file: File): Promise<DocAsset> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${base()}/documents/${id}/assets`, { method: "POST", headers: { ...authHeaders() }, body: fd });
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as DocAsset;
  },
  /** Unauthenticated read used by the print page (exporter), guarded by the signed print token. */
  print: async (id: string, query: string): Promise<PrintPayload> => {
    const res = await fetch(`${base()}/public/documents/${encodeURIComponent(id)}/print?${query}`);
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as PrintPayload;
  },
};
