// Mirrors the backend DTOs (io.reporthub.reportstudio.dto).

export type EngineKey = "jasper" | "api" | "sql" | "composite" | "component" | "http" | "other" | "fetch" | "docbuilder";
export type StatusKey = "active" | "testing" | "draft" | "error";

export interface Category {
  id: string;
  ref: string;
  name: string;
  min: number;
  registered: number;
  description?: string | null;
  sortOrder?: number | null;
}

export interface Datasource {
  id: string;
  name: string;
  engine: string;
  /** Non-admin callers get a limited view; connection fields may be absent. */
  host?: string | null;
  schemaName?: string | null;
  status: "healthy" | "degraded" | "down" | "unknown" | "not_configured";
  latencyMs?: number | null;
  pool?: string | null;
  reportCount?: number;
  hasJdbc?: boolean;
  isDefault?: boolean;
  inUse?: boolean;
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
  /** Gateway defaults; absent on servers that do not store them yet. */
  priority?: string | null;
  /** 1–1440 */
  timeoutMinutes?: number | null;
  queue?: string | null;
  templatePath: string | null;
  ownerUnit: string | null;
  paramCount: number;
  configJson: string | null;
  outputFolder: string | null;
  testData: boolean;
  /** CSV of portal role codes allowed to see this report from the portal; null = everyone. */
  allowedRoles: string | null;
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
  allowedRoles?: string;
  testData?: boolean;
  note?: string;
  priority?: string;
  /** 1–1440 */
  timeoutMinutes?: number;
  queue?: string;
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
  /** executed: false = this stage is not part of the real render pipeline */
  data: { kind: string; label: string; sub?: string; executed?: boolean };
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
  /** true when every stage in the flow is actually executed */
  executed?: boolean;
  notExecutedStages?: string[];
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
  /** "sql" = a saved SQL script from the Tables editor. */
  kind: "pivot" | "adhoc" | "sql";
  name: string;
  dataset: string | null;
  payload: string;
  workspaceId: number | null;
  folder: string | null;
  /** true = visible to everyone · false = visible only to its creator */
  isPublic: boolean;
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
  /** '/'-separated path for the dataset tree; null = ungrouped. */
  folder: string | null;
  datasourceId: string | null;
  sqlText: string;
  /** Numeric columns treated as dimensions (CSV); null = none. */
  dimensionColumns?: string | null;
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

export type VizKind = "table" | "bar" | "line" | "heat" | "kpi" | "donut" | "map" | "tree" | "treemap";
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
  /** Pipeline stage; the render stage carries the engine name (jasper, sql, docbuilder, ...). */
  stage: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  fmt: string;
  datasourceId: string | null;
  requestedBy: string | null;
  startedAt: string;
  progress: number;
  partition: number;
  priority: "high" | "normal" | "low";
  errorMessage: string | null;
  /** Non-fatal problem of a finished job (e.g. FileHub delivery failed). */
  warning?: string | null;
}

export interface PartitionStat {
  partition: number;
  lag: number;
}

export interface QueueStats {
  active: number;
  completedLastHour: number;
  avgWaitMs: number;
  consumerLag: number;
  pipeline: Record<string, number>;
  workerConcurrency: number;
  workersActive: number;
  workersQueued: number;
  partitions: PartitionStat[];
  failedLastHour?: number;
  cancelledLastHour?: number;
}

export interface OutputFile {
  objectKey: string;
  reportCode: string;
  reportName: string | null;
  /** Category name of the report; null when the report code is no longer registered. */
  categoryName: string | null;
  jobId: string | null;
  fmt: string;
  sizeBytes: number;
  createdBy: string | null;
  createdAt: string;
  params: string | null;
  /** null while nobody has confirmed they checked this file. */
  review: OutputReview | null;
  /** null = this file has not been shared */
  share: OutputShare | null;
  /** null = not published to FileHub */
  filehub?: FileHubRef | null;
}

export interface FileHubRef { connectorId: string; fileId: string; url: string; publishedAt: string }

/** One integration (connector) as listed by GET /integrations. Secrets come back as "••• set". */
export interface IntegrationItem {
  id: string;
  type: "database" | "iam" | "filehub" | "object-store" | "exporter" | "notify" | "engine";
  name: string;
  enabled: boolean;
  editable: boolean;
  scope: string;
  status: string;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  config: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  authMode?: string;
}
export interface IntegrationCategory { key: string; label: string; types: string[]; items: IntegrationItem[] }
export interface IntegrationTest { ok: boolean; status: number; message: string; ms?: number }
export interface FileHubTarget { id: string; name: string; folderPath: string }

/** One report in the Output Files folder rail; totals come from the database, not counted client-side. */
export interface OutputTreeRow {
  reportCode: string;
  /** null = this code is no longer in the report registry */
  reportName: string | null;
  /** null = no category */
  categoryName: string | null;
  files: number;
  sizeBytes: number;
  latestAt: string;
}

/** One page of the file list, with the total for the current filter. */
export interface OutputPage {
  items: OutputFile[];
  total: number;
}

/** Share link for a file; opens without login. A file has at most one link. */
export interface OutputShare {
  token: string;
  /** Absolute link when the server knows its public base; may be relative otherwise. */
  url: string;
  /** Path relative to the API base, e.g. /public/share/{token} */
  path?: string;
  /** null = never expires */
  expiresAt: string | null;
  sharedBy: string | null;
  sharedAt: string | null;
  hits: number;
}

export interface OutputReview {
  confirmedBy: string;
  confirmedAt: string;
  note: string | null;
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
  /** portal roles when signed in through the host portal; empty for a direct login. */
  portalRoles?: string[];
  /** local | iam | edge */
  source?: string;
  tenant?: string;
  admin?: boolean;
  roles?: string[];
  responsibilities?: string[];
  attributes?: Record<string, string>;
  /** IAM object code → granted actions (view/create/update/delete/execute/approve). */
  permissions?: Record<string, string[]>;
  authMode?: string;
}

export interface TenancyMine {
  tenant: { id: string; name: string };
  project: string;
  projects: { id: string; name: string }[];
}

export interface TenantRow { id: string; name: string; iamTenantId: string | null; active: boolean; createdAt: string }
export interface ProjectRow { tenantId: string; id: string; name: string; iamAppCode: string | null; active: boolean; createdAt: string }


export type AclObjectType = "REPORT" | "DATASOURCE" | "DATASET" | "REPO_TABLE" | "DASHBOARD" | "OUTPUT" | "DOCUMENT";
export type RowFilterObjectType = "REPORT" | "DATASET" | "REPO_TABLE";
export type AclPermission = "view" | "run" | "edit";
export type PrincipalType = "role" | "responsibility" | "user";

export interface AclGrant { principalType: PrincipalType; principalCode: string; permission: AclPermission }
export interface AclEntryRow extends AclGrant { id: number; objectType: AclObjectType; objectId: string; createdBy: string | null; createdAt: string }

export interface AccessMeta {
  objectTypes: AclObjectType[];
  permissions: AclPermission[];
  principalTypes: PrincipalType[];
  rowFilterTypes: RowFilterObjectType[];
  operators: string[];
  attributes: string[];
}

export interface RowFilterRuleInput {
  column: string;
  operator: string;
  valueExpr: string | null;
  valueType: "text" | "number";
  principalType: PrincipalType | null;
  principalCode: string | null;
  enabled: boolean;
}
export interface RowFilterRuleRow {
  id: number; objectType: RowFilterObjectType; objectId: string; columnName: string; operator: string;
  valueExpr: string | null; valueType: "text" | "number"; principalType: PrincipalType | null;
  principalCode: string | null; enabled: boolean;
}
export interface RowFilterPreviewInput {
  username: string; roles: string[]; responsibilities: string[]; attributes: Record<string, string>; sql?: string;
}
export interface RowFilterPreview { condition: string; binds: string[]; sql: string; filtered: boolean; denied: boolean; /** The real query with the filter applied, when the server provides it. */ effectiveSql?: string; params?: string[] }

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
    cancelledToday?: number;
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

/** A folder in the Tables screen sidebar; since V53 a real row, not text in repo_table.folder. */
export interface RepoFolder {
  id: number;
  menuKey: string | null;
  parentId: number | null;
  name: string;
  sortOrder: number;
}
export interface RepoColumn { name: string; type: string; nullable: boolean; pk: boolean }
export interface RepoTableMeta { schema: string | null; name: string; columns: RepoColumn[]; primaryKey: string[] }
export interface RepoRows {
  columns: string[];
  rows: (string | number | null)[][];
  /** rows on THIS page */
  rowCount: number;
  /** rows the filter matches in the whole table; -1 = not asked for / the count timed out */
  total: number;
}
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
  lastStatus: "ok" | "error" | "running" | "queued" | "cancelled" | null;
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
  /** '/'-separated path for the pipeline tree; null = ungrouped. */
  folder: string | null;
  sourceDatasourceId: string | null;
  sourceSql: string;
  /** Substituted into $YEAR4/$YEAR2 in sourceSql on a scheduled run; null = the caller supplies one. */
  fiscalYear: string | null;
  targetDatasourceId: string | null;
  /** Schema of the target table; null = the target connection's own schema. */
  targetSchema: string | null;
  targetTable: string;
  loadMode: LoadMode;
  /** delete (transactional) · truncate (fast, commits) · partition (TRUNCATE PARTITION by clearWhere) */
  clearMode: "delete" | "truncate" | "partition";
  keyColumns: string | null;
  clearWhere: string | null;
  /** Control-total column; when set, every run reconciles row count and sum against the source. null = no check. */
  controlColumn: string | null;
  /** Accepted tolerance on the sum (row counts must always match exactly). */
  controlTolerance: number | null;
  paramsJson: string | null;
  autoCreate: boolean;
  /** Widen an existing target with columns the query has and the table lacks. */
  addColumns: boolean;
  cron: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "running" | "queued" | "cancelled" | null;
  lastError: string | null;
  lastRowsRead: number | null;
  lastRowsWritten: number | null;
  createdBy: string | null;
  createdAt: string;
}
// --- Data checks: a SELECT that returns the rows that are WRONG; 0 rows = pass ---
export type CheckStatus = "pass" | "fail" | "error" | "running";
export interface DataCheck {
  id: number;
  name: string;
  description: string | null;
  folder: string | null;
  datasourceId: string | null;
  sqlText: string;
  fiscalYear: string | null;
  /** Fail when the row count exceeds this; 0 = the result must be empty. */
  maxRows: number;
  enabled: boolean;
  cron: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: CheckStatus | null;
  lastCount: number | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
}
export interface DataCheckRun {
  id: number;
  checkId: number;
  startedAt: string;
  finishedAt: string | null;
  /** "running" until the worker fills in the verdict — runs are started, not awaited. */
  status: CheckStatus;
  trigger: string;
  rowCount: number | null;
  message: string | null;
  runBy: string | null;
}
/** Source of a rule group: the table the rules read and the pipeline that fills it. */
export interface CheckGroupSource {
  table: string | null;
  datasourceId: string | null;
  pipelineName: string | null;
  pipelineLastRunAt: string | null;
  pipelineRows: number | null;
  rules: number;
  /** Condition shared by every rule in the group = the scope of data checked. */
  where: string[];
  /** Row count in that scope; null = not requested or not countable. */
  scopeRows: number | null;
  /** true = scope set by a user (editable) · false = inferred from the members' SQL */
  stored: boolean;
  /** Number of rules that reference $SCOPE, i.e. how many a scope edit actually affects. */
  usingScope: number;
}

/** Result of rewriting rules to use $SCOPE; one row per rule. */
export interface ScopeAdoptResult {
  id: number;
  name: string;
  /** true = rewritable/rewritten · false = skipped (see reason) */
  changed: boolean;
  reason: string;
  before: string;
  after: string | null;
}

/** One item that failed rules: how many, which ones, with supporting values. */
export interface CheckFinding {
  key: string;
  rules: string[];
  columns: Record<string, unknown>;
}

/** One check round of a group; running the whole group once = one round. */
export interface CheckRound {
  batchId: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  passed: number;
  failed: number;
  runBy: string | null;
}

export interface SaveCheckInput {
  name: string;
  description?: string | null;
  folder?: string | null;
  datasourceId?: string | null;
  sqlText: string;
  fiscalYear?: string | null;
  maxRows?: number;
  cron?: string | null;
  enabled?: boolean;
}

/** What is actually in the target right now — the last run's status can be days stale. */
export interface WarehouseTargetInfo {
  schema: string | null;
  table: string;
  exists: boolean;
  rowCount: number | null;
  error: string | null;
}
export interface WarehouseRun {
  id: number;
  pipelineId: number;
  startedAt: string;
  finishedAt: string | null;
  /** queued = waiting for a worker · running = loading · cancelled = stopped by a user */
  status: "ok" | "error" | "running" | "queued" | "cancelled";
  trigger: "scheduled" | "manual";
  rowsRead: number | null;
  rowsWritten: number | null;
  message: string | null;
  runBy: string | null;
  // ---- reconciliation (all null when the pipeline has no control-total column) ----
  srcRows: number | null;
  tgtRows: number | null;
  srcSum: number | null;
  tgtSum: number | null;
  reconStatus: "match" | "mismatch" | "error" | null;
  reconMessage: string | null;
}
/** One step of a pipeline; a pipeline is an ordered list of steps, even with a single step. */
export interface WarehouseStep {
  id: number | null;
  stepNo: number;
  /** load = load data into a table · sql = single statement · check = data-check set · assert = inline assertion */
  kind: string;
  label: string | null;
  /** This step's program, as JSON shaped by kind. */
  config: string | null;
  onFail: "stop" | "continue";
  varName: string | null;
}

/** Result of one step within one run. */
export interface WarehouseRunStep {
  id: number;
  stepNo: number;
  kind: string;
  label: string | null;
  status: "running" | "success" | "failed" | "skipped" | "cancelled";
  rowsRead: number | null;
  rowsWritten: number | null;
  affected: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StepType { type: string; label: string }

/** One run in a card's history strip; enough to draw a bar without fetching the full run. */
export interface RecentRun {
  pipelineId: number;
  status: string;
  /** Seconds taken; null = still running */
  seconds: number | null;
  rowsWritten: number | null;
  startedAt: string;
}

export interface SaveWarehouseInput {
  name: string;
  description?: string | null;
  folder?: string | null;
  sourceDatasourceId?: string | null;
  sourceSql: string;
  fiscalYear?: string | null;
  targetDatasourceId?: string | null;
  targetSchema?: string | null;
  targetTable: string;
  loadMode: LoadMode;
  clearMode?: "delete" | "truncate" | "partition";
  keyColumns?: string | null;
  clearWhere?: string | null;
  controlColumn?: string | null;
  controlTolerance?: number | null;
  paramsJson?: string | null;
  autoCreate?: boolean;
  addColumns?: boolean;
  cron?: string | null;
  enabled?: boolean;
}

/** A table an admin has put on a data screen (repo_table). */
export interface RepoTableEntry {
  id: number;
  menuKey: string | null;
  label: string;
  /** '/'-separated path grouping the tables one screen offers; null = ungrouped. */
  folder: string | null;
  datasourceId: string;
  schemaName: string | null;
  tableName: string;
  /** Fixed slice for this entry: COLUMN=value pairs separated by ';'. Admin-pinned, invisible to the user. */
  eqFilter: string | null;
  /** Column order on screen: a plain ordered list, or the legacy `COL[,COL]>AFTER_COL` form separated by ';' */
  columnOrder?: string | null;
  /** Columns hidden on screen and in exports (comma-separated); null = show all */
  hiddenColumns?: string | null;
  /** Export header labels when they differ from the column name: "COL=Label", comma-separated */
  columnLabels?: string | null;
  /**
   * CSV of columns the screen offers as user-selectable filters; null = none.
   *
   * Each entry is `COLUMN[:label[:nameSource]]` — the label replaces the raw column name on the
   * picker, and the third part says where the name beside each code comes from: a column of this
   * same table (`REGION_NAME`), or `SCHEMA.TABLE.CODE.NAME` for a table that holds codes only.
   *
   *   CATEGORY,REGION:Region:REGION_NAME,BRANCH:Branch:BRANCH_NAME
   *   BRANCH:Branch:CORE.BRANCH.BRANCH_CODE.BRANCH_NAME
   *
   * A bare column name still means what it always did, so older entries keep working untouched.
   */
  filterColumns: string | null;
  /** Columns identifying a row when the table has no primary key (CSV); null = use the real PK. */
  keyColumns: string | null;
  /** Column the optional year picker / export year filter uses; null = no year picker. */
  yearColumn?: string | null;
  sortOrder: number;
  active: boolean;
  folderId: number | null;
}

export type RepoTableEntryInput = Omit<RepoTableEntry, "id" | "active">;

// --- ETL chains: ordered steps run as one round -----------------------------

export type ChainStepKind = "pipeline" | "check" | "statement" | "sql" | "load" | "assert";
export type ChainRunStatus = "queued" | "running" | "success" | "failed" | "partial" | "cancelled";
export type ChainStepStatus = "running" | "success" | "failed" | "skipped";

/** From GET /etl-chains/step-types — the registry, so new executors appear without a UI change. */
export interface ChainStepType {
  type: string;
  label: string;
  /** ref = points at a saved pipeline/check/statement; inline = carries its own program. */
  mode: "ref" | "inline";
}

export interface EtlChainStep {
  id: number | null;
  stepNo: number;
  kind: string;
  pipelineId: number | null;
  checkId: number | null;
  schedulerId: number | null;
  /** Per-type program, as JSON, for inline steps. */
  config: string | null;
  label: string | null;
  varName: string | null;
  onFail: "stop" | "continue";
}

export interface EtlChain {
  id: number;
  name: string;
  description: string | null;
  folder: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  steps: EtlChainStep[];
}

export interface EtlChainRun {
  id: number;
  chainId: number;
  fiscalYear: string | null;
  roundNo: number;
  status: ChainRunStatus;
  startedAt: string;
  finishedAt: string | null;
  runBy: string | null;
  message: string | null;
  /** Run this one resumed from; null = a normal run */
  resumedFromRunId: number | null;
  /** First step this run actually executed (earlier steps = skipped, "passed in previous run") */
  startStepNo: number;
}

export interface EtlChainRunStep {
  id: number;
  stepNo: number;
  kind: string;
  refName: string | null;
  status: ChainStepStatus;
  rowsRead: number | null;
  rowsWritten: number | null;
  checkCount: number | null;
  checkPass: boolean | null;
  affected: number | null;
  warehouseRunId: number | null;
  dataCheckRunId: number | null;
  schedulerRunId: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SaveChainInput {
  name: string;
  description?: string | null;
  folder?: string | null;
  enabled?: boolean;
  steps: Array<Omit<EtlChainStep, "id" | "stepNo">>;
}

/** One choice in a repository filter picker: the code filtered on, plus its name if the registry named a source. */
export interface RepoOption {
  value: string;
  label: string | null;
}

/** One run of the free-form SQL box; history for both Ad-hoc (SQL tab) and Tables screens. */
export interface SqlRunLogRow {
  id: number;
  datasourceId: string | null;
  /** select · update · block · unknown */
  kind: string;
  sql: string;
  rowCount: number | null;
  affected: number | null;
  ms: number;
  /** ok · error */
  status: string;
  error: string | null;
  /** adhoc · tables */
  source: string | null;
  createdBy: string | null;
  createdAt: string;
}
