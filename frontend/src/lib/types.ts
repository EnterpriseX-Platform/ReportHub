// Mirrors the backend DTOs (io.reporthub.reportstudio.dto).

export type EngineKey = "jasper" | "api" | "sql" | "composite" | "component" | "http" | "other" | "fetch";
export type StatusKey = "active" | "testing" | "draft" | "error";

export interface Category {
  id: string;
  ref: string;
  name: string;
  min: number;
  registered: number;
}

export interface Datasource {
  id: string;
  name: string;
  engine: string;
  host: string | null;
  schemaName: string | null;
  status: "healthy" | "degraded" | "down";
  latencyMs: number | null;
  pool: string | null;
  reportCount: number;
  hasJdbc: boolean;
}

export interface ReportSummary {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  categoryRef: string | null;
  engine: EngineKey;
  formats: string[];
  status: StatusKey;
  datasourceId: string | null;
  datasourceName: string | null;
  version: string;
  avgMs: number;
  runs: number;
  updatedAt: string;
}

export interface ReportDetail extends ReportSummary {
  categoryName: string | null;
  templatePath: string | null;
  ownerUnit: string | null;
  paramCount: number;
  configJson: string | null;
  outputFolder: string | null;
}

// --- parameter catalog (table-driven options + dependencies) ---

export interface ParamOption {
  value: string;
  label: string;
}

export interface ParamDef {
  id: number;
  name: string;
  label: string;
  type: "string" | "integer" | "boolean" | "enum" | "date";
  required: boolean;
  defaultValue: string | null;
  sourceType: "static" | "query" | "sql";
  staticOptions: ParamOption[];
  lookupTable: string | null;
  sourceSql: string | null;
  datasourceId: string | null;
  valueColumn: string | null;
  labelColumn: string | null;
  dependsOn: string | null;
  filterColumn: string | null;
  sortOrder: number;
  usedByReports: number;
  /** Per-report required override (only set when fetched for a specific report); null = inherit. */
  requiredOverride?: boolean | null;
}

export interface SaveParamInput {
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue?: string | null;
  sourceType: string;
  staticOptions?: ParamOption[];
  lookupTable?: string | null;
  sourceSql?: string | null;
  datasourceId?: string | null;
  valueColumn?: string | null;
  labelColumn?: string | null;
  dependsOn?: string | null;
  filterColumn?: string | null;
  sortOrder?: number;
}

// --- report config-screen update + versions ---

export interface UpdateReportInput {
  name?: string;
  categoryId?: string;
  engine?: string;
  formats?: string[];
  status?: string;
  datasourceId?: string;
  templatePath?: string;
  ownerUnit?: string;
  configJson?: string;
  outputFolder?: string;
  note?: string;
}

export interface VersionEntry {
  id: number;
  version: string;
  changeType: "config" | "template" | "both";
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  current: boolean;
}

// --- flow designer ---

export interface FlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: { kind: string; label: string; sub?: string };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
}

export interface FlowDoc {
  nodes: FlowNode[];
  edges: FlowEdge[];
  saved?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

// --- render units: 1 report = N units (engine + format + templates each) ---

export interface UnitFile {
  id: number;
  role: "main" | "subreport" | "resource";
  fileName: string;
  objectKey: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedAt: string;
  active: boolean;
}

export interface ReportUnit {
  id: number;
  name: string;
  engine: string;
  fmt: string | null;
  configJson: string | null;
  datasourceId: string | null;
  sortOrder: number;
  enabled: boolean;
  files: UnitFile[];
}

export interface SaveUnitInput {
  name: string;
  engine: string;
  fmt?: string | null;
  configJson?: string | null;
  datasourceId?: string | null;
  sortOrder?: number;
  enabled?: boolean;
}

// --- users / settings ---

export interface UserRow {
  id: number;
  username: string;
  role: "ADMIN" | "USER";
  displayName: string;
}

/** A global shared resource (logo/image/font) reused by every report. */
export interface SharedResource {
  name: string;
  sizeBytes: number;
  contentType?: string;
  thumbnail?: string | null;
}

// --- saved views + adhoc history + warehouse meta ---

export interface SavedViewRow {
  id: number;
  kind: "pivot" | "adhoc";
  name: string;
  dataset: string | null;
  payload: string;
  workspaceId: number | null;
  folder: string | null;
  shareToken: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface Workspace {
  id: number;
  name: string;
  createdBy: string | null;
  createdAt: string;
}

export interface AdhocHistoryRow {
  id: number;
  dataset: string;
  fields: string;
  filters: string;
  rowCount: number;
  createdBy: string;
  createdAt: string;
}

export interface AnalyticsMeta {
  factCount: number;
  fiscalYears: string[];
  regions: string[];
  categories: string[];
  channels: string[];
}

export interface DatasetDef {
  id: number;
  name: string;
  description: string | null;
  datasourceId: string | null;
  sqlText: string;
  captureMode: "live" | "captured";
  capturedAt: string | null;
  captureRows: number | null;
  createdBy: string | null;
  createdAt: string;
}

export interface DatasetColumn { name: string; kind: "dim" | "measure" }
export interface TableResult { columns: string[]; rows: (string | number | null)[][]; rowCount: number }

export interface DashboardRow {
  id: number;
  name: string;
  layoutJson: string;
  paramsJson: string | null;
  shareToken: string | null;
  workspaceId: number | null;
  folder: string | null;
  createdBy: string | null;
  updatedAt: string;
}

export type VizKind = "table" | "bar" | "line" | "heat";
export interface Widget {
  title: string;
  viz: VizKind;
  w?: number;
  kind: "pivot" | "adhoc" | "dataset";
  payload: unknown;
  datasetId?: number;
}

export interface WidgetData {
  title: string;
  viz: VizKind;
  w: number;
  kind?: string;
  filterField?: string;
  data?: unknown;
  error?: string;
}

export interface DashboardData {
  id: number;
  name: string;
  paramsJson: string;
  updatedAt: string;
  widgets: WidgetData[];
}

export interface DsTestResult {
  ok: boolean;
  latencyMs: number;
  status: string;
  message: string;
}

export interface PageResponse<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
}

export interface Job {
  id: string;
  reportCode: string;
  reportName: string;
  stage: "ingress" | "queue" | "worker" | "jasper" | "store";
  state: "queued" | "running" | "done" | "error";
  fmt: string;
  datasourceId: string | null;
  requestedBy: string | null;
  startedAt: string;
  progress: number;
  partition: number;
  priority: "high" | "normal" | "low";
  errorMessage: string | null;
}

export interface QueueStats {
  active: number;
  completedLastHour: number;
  avgWaitMs: number;
  consumerLag: number;
  pipeline: Record<string, number>;
}

export interface OutputFile {
  objectKey: string;
  reportCode: string;
  jobId: string | null;
  fmt: string;
  sizeBytes: number;
  createdBy: string | null;
  createdAt: string;
  params: string | null;
}

export interface RunResponse {
  jobId: string;
}

export interface PivotRowDto {
  label: string;
  depth: number;
  vals: Record<string, number>;
  rowTotal: number;
  isGroup: boolean;
}

export interface PivotResponse {
  colKeys: string[];
  rows: PivotRowDto[];
  colTotals: Record<string, number>;
  grand: number;
}

export interface PivotRequest {
  rows: string[];
  cols: string[];
  measure: string;
}

export interface AdhocFieldDto {
  key: string;
  label: string;
}

export interface AdhocDataset {
  id: string;
  name: string;
  dimensions: AdhocFieldDto[];
  measures: AdhocFieldDto[];
  filterOptions: {
    fiscalYears: string[];
    regions: string[];
    categories: string[];
    channels: string[];
  };
}

export interface AdhocRequest {
  dataset?: string;
  fields: string[];
  filters?: Record<string, string>;
}

export interface AdhocResult {
  columns: string[];
  rows: Record<string, string | number>[];
  totals: Record<string, number>;
  rowCount: number;
}

export interface LoginResponse {
  token: string;
  role: string;
  displayName: string;
}

export interface MeResponse {
  username: string;
  role: string;
  displayName: string;
}

export interface DashboardSummary {
  stats: {
    registered: number;
    required: number;
    datasources: number;
    runsToday: number;
    inQueue: number;
    avgRenderMs: number;
    successRate: number;
    failedToday: number;
  };
  categories: Category[];
  statusBreakdown: Record<string, number>;
  engineBreakdown: Record<string, number>;
  recentReports: ReportSummary[];
}

// --- Engine registry (installable engines) ---
export interface EngineInstance {
  id: number;
  name: string;
  kind: string;
  installMethod: string;
  baseUrl: string | null;
  componentFormat: string | null;
  artifactRef: string | null;
  enabled: boolean;
  hasToken: boolean;
  note: string | null;
  createdAt: string;
}

/** One engine-declared config field — drives the schema-rendered config forms. */
export interface EngineProp {
  key: string;
  label: string;
  type: "text" | "textarea" | "sql" | "password" | "url" | "select" | "number" | "bool" | string;
  required: boolean;
  placeholder: string | null;
  help: string | null;
  options: string[];
  storedIn: "UNIT_CONFIG_JSON" | "INSTANCE_COLUMN" | "INSTANCE_PROPS" | string;
}

/** Code-declared description of a registered engine (from GET /engines). */
export interface EngineDescriptor {
  kind: string;
  label: string;
  requiresInstance: boolean;
  builtin: boolean;
  instanceProps: EngineProp[];
  reportProps: EngineProp[];
}

export interface EngineList {
  installed: EngineInstance[];
  availableKinds: string[];
  descriptors: EngineDescriptor[];
}

export interface EngineTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  message: string;
}

// --- Repository (Database Tool) ---
export interface RepoTable { schema: string | null; name: string; type: string }
export interface RepoColumn { name: string; type: string; nullable: boolean; pk: boolean }
export interface RepoTableMeta { schema: string | null; name: string; columns: RepoColumn[]; primaryKey: string[] }
export interface RepoRows { columns: string[]; rows: (string | number | null)[][]; rowCount: number }
export interface RepoExecResult {
  kind: "select" | "update";
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  affected: number;
}

// --- Schedulers (scheduled SQL) ---
export interface Scheduler {
  id: number;
  name: string;
  description: string | null;
  datasourceId: string | null;
  sqlText: string;
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "running" | null;
  lastError: string | null;
  lastAffected: number | null;
  createdBy: string | null;
  createdAt: string;
}
export interface SchedulerRun {
  id: number;
  schedulerId: number;
  startedAt: string;
  finishedAt: string | null;
  status: "ok" | "error";
  trigger: "scheduled" | "manual";
  affected: number | null;
  message: string | null;
  runBy: string | null;
}
export interface SaveSchedulerInput {
  name: string;
  description?: string | null;
  datasourceId?: string | null;
  sqlText: string;
  cron: string;
  enabled?: boolean;
}

// --- Data Warehouse pipelines (source SELECT → target table) ---
export type LoadMode = "replace" | "append" | "upsert";
export interface WarehousePipeline {
  id: number;
  name: string;
  description: string | null;
  sourceDatasourceId: string | null;
  sourceSql: string;
  targetDatasourceId: string | null;
  targetTable: string;
  loadMode: LoadMode;
  keyColumns: string | null;
  autoCreate: boolean;
  cron: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "running" | null;
  lastError: string | null;
  lastRowsRead: number | null;
  lastRowsWritten: number | null;
  createdBy: string | null;
  createdAt: string;
}
export interface WarehouseRun {
  id: number;
  pipelineId: number;
  startedAt: string;
  finishedAt: string | null;
  status: "ok" | "error";
  trigger: "scheduled" | "manual";
  rowsRead: number | null;
  rowsWritten: number | null;
  message: string | null;
  runBy: string | null;
}
export interface SaveWarehouseInput {
  name: string;
  description?: string | null;
  sourceDatasourceId?: string | null;
  sourceSql: string;
  targetDatasourceId?: string | null;
  targetTable: string;
  loadMode: LoadMode;
  keyColumns?: string | null;
  autoCreate?: boolean;
  cron?: string | null;
  enabled?: boolean;
}
