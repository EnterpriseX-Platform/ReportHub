"use client";

// Data Warehouse: define a pipeline that reads a source SELECT (with
// conditions) from any datasource and loads it into a target table — Replace / Append / Upsert by
// key, target auto-created from the result schema. Run manually or on a cron, with run history.
import {
  Button, Checkbox, ComboBox, IconButton, InlineNotification, StructuredListBody, StructuredListCell, StructuredListRow,
  StructuredListWrapper, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TextArea,
  TextInput, Tile, Toggle,
} from "@carbon/react";
import { Add, Checkmark, Close, Flash, Link as LinkIcon, Play, View } from "@carbon/icons-react";
import { PageHeader } from "@/components/ui";
import dp from "./P/datapipeline.module.scss";
import { usePerms } from "@/lib/perms";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { PipelineDetail } from "@/components/PipelineDetail";
import { Select } from "@/components/Select";
import { Modal } from "@/components/overlays";
import { SqlEditor } from "@/components/SqlEditor";
import { useToast } from "@/components/Toast";
import { OpsPanel, OpsEmpty } from "@/components/OpsPanel";
import { api } from "@/lib/api";
import { fiscalYearNow, usePortalYear } from "@/lib/portal-year";
import type {
  Datasource,
  LoadMode,
  StepType,
  TableResult,
  WarehousePipeline,
  WarehouseRun,
  WarehouseStep,
  WarehouseTargetInfo,
} from "@/lib/types";

const CRON_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Manual only, no schedule" },
  { value: "0 */15 * * * *", label: "Every 15 minutes" },
  { value: "0 0 * * * *", label: "Every hour" },
  { value: "0 0 2 * * *", label: "Every day at 02:00" },
  { value: "0 30 5 * * *", label: "Every day at 05:30" },
  { value: "0 0 2 * * MON", label: "Every Monday at 02:00" },
  { value: "0 0 1 1 * *", label: "1st of the month at 01:00" },
];
const MODES: { value: LoadMode; label: string; hint: string }[] = [
  { value: "replace", label: "Replace all", hint: "Clear the existing rows first, then load the whole set" },
  { value: "append", label: "Append", hint: "Keep every existing row and add the new ones" },
  { value: "upsert", label: "Upsert by key", hint: "Rows with a matching key are overwritten, the rest are inserted" },
];

/** One declared run parameter: `$NAME` in the SQL, asked for when the pipeline is run. */
type RunParam = { name: string; label?: string; default?: string };

function parseParams(json: string | null | undefined): RunParam[] {
  if (!json?.trim()) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === "string") : [];
  } catch { return []; }
}

/**
 * The fiscal year that is running today (start month configurable, see lib/portal-year).
 * Used as the default so Run is one click during the year being worked on.
 */
function currentFiscalYear(): string {
  return fiscalYearNow();
}

/** Accept the common 5-field cron (min hour dom mon dow); the scheduler runs 6-field (with seconds). */
function toSpringCron(c: string): string {
  const parts = c.trim().split(/\s+/);
  return parts.length === 5 ? `0 ${parts.join(" ")}` : parts.join(" ");
}

function dsLabel(id: string | null, dss: Datasource[]): string {
  return id ? (dss.find((d) => d.id === id)?.name ?? id) : "internal warehouse";
}

const NAV_KEY = "rs.datapipeline.navOpen";

export default function WarehousePage() {
  const { can } = usePerms();
  const toast = useToast();
  const [rows, setRows] = useState<WarehousePipeline[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [editing, setEditing] = useState<WarehousePipeline | "new" | null>(null);
  /** Pipeline whose details are open — shown as a popup, not expanded inline */
  const [detailId, setDetailId] = useState<number | null>(null);
  /** Bumped after a run is queued so the open detail reloads its history and follows the new run */
  const [runTick, setRunTick] = useState(0);
  const [query, setQuery] = useState("");
  /** Steps ticked for a batch run — the server runner is a single queue, so they are queued in order */
  const [picked, setPicked] = useState<Set<number | string>>(new Set());
  const [batchAsk, setBatchAsk] = useState(false);
  const [chainAsk, setChainAsk] = useState(false);
  const [stepTypes, setStepTypes] = useState<StepType[]>([]);
  /** Steps of each pipeline — loaded once when the screen opens, drawn as a mini chain on the card */
  const [stepsOf, setStepsOf] = useState<Record<number, WarehouseStep[]>>({});
  /** Latest run history of every pipeline, fetched once — drives the card bars */
  /** Two tabs on one screen: single pipelines and chains */


  // Natural sort by name within each group, so numbered steps (1, 2, 10) appear in run order
  /** Left navigation: "" = all groups, otherwise the folder name */
  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => { setNavOpen(localStorage.getItem(NAV_KEY) !== "0"); }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((v) => { localStorage.setItem(NAV_KEY, v ? "0" : "1"); return !v; });
  }, []);
  const shownRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((p) => !q || [p.name, p.targetTable, p.targetSchema, p.clearWhere, p.folder]
        .some((v) => (v ?? "").toLowerCase().includes(q)))
      .slice()
      .sort((a, b) => natCompare(a.name, b.name));
  }, [rows, query]);

  /** Items for the left nav — the dot colour shows the latest result (running / failed / paused) */
  const navItems = useMemo(() => shownRows.map((p) => {
    const live = p.lastStatus === "running" || p.lastStatus === "queued";
    const bad = p.lastStatus === "error";
    return {
      id: p.id, name: p.name, folder: p.folder, icon: "layers",
      mark: !p.enabled ? "var(--cds-text-placeholder)" : bad ? "var(--cds-support-error)" : live ? "var(--cds-support-warning)" : "var(--cds-support-success)",
      badge: live ? "running" : bad ? "failed" : !p.enabled ? "paused" : undefined,
      badgeColor: bad ? "var(--cds-support-error)" : live ? "var(--cds-support-warning)" : undefined,
      title: `${p.name}\ntarget ${p.targetSchema ? p.targetSchema + "." : ""}${p.targetTable}`,
    };
  }), [shownRows]);

  /** Picked items may be hidden by a group/search change — the action bar counts only visible ones */
  const pickedShown = useMemo(() => shownRows.filter((p) => picked.has(p.id)), [shownRows, picked]);
  const allShownPicked = shownRows.length > 0 && pickedShown.length === shownRows.length;

  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [runAsk, setRunAsk] = useState<WarehousePipeline | null>(null);
  const [delAsk, setDelAsk] = useState<WarehousePipeline | null>(null);
  const portalYear = usePortalYear();

  const reload = useCallback(() => {
    setLoadErr(null);
    api.warehousePipelines().then(setRows).catch((e) => setLoadErr(e instanceof Error ? e.message : "Failed to load"));
  }, []);
  useEffect(() => { reload(); api.datasources().then(setDss).catch(() => {}); }, [reload]);
  // Derived from the live list, so the detail sees new run stamps / edits instead of a stale copy
  const detail = useMemo(() => rows.find((r) => r.id === detailId) ?? null, [rows, detailId]);
  const setDetail = useCallback((p: WarehousePipeline | null) => {
    setDetailId(p?.id ?? null);
    // Keep the open pipeline in the address so a reload / shared link lands on it
    try {
      const u = new URL(window.location.href);
      if (p) u.searchParams.set("p", String(p.id)); else u.searchParams.delete("p");
      window.history.replaceState(window.history.state, "", u.toString());
    } catch { /* address is a convenience only */ }
  }, []);
  useEffect(() => {
    const v = Number(new URLSearchParams(window.location.search).get("p"));
    if (v) setDetailId(v);
  }, []);
  const reloadSteps = useCallback((id: number) => {
    api.warehouseSteps(id).then((st) => setStepsOf((m) => ({ ...m, [id]: st }))).catch(() => {});
  }, []);
  useEffect(() => { api.warehouseStepTypes().then(setStepTypes).catch(() => {}); }, []);
  // Load every pipeline's steps when the list changes — each card shows its own mini chain
  //
  // Fill in each card as its response arrives rather than Promise.all: browsers allow ~6 parallel
  // requests, so waiting for all of them would keep the whole list on "loading steps…" until the
  // slowest one returns
  useEffect(() => {
    let dead = false;
    for (const p of rows) {
      api.warehouseSteps(p.id)
        .catch(() => [] as WarehouseStep[])
        .then((st) => { if (!dead) setStepsOf((m) => ({ ...m, [p.id]: st })); });
    }
    return () => { dead = true; };
  }, [rows]);

  // A manual run now returns as soon as it is queued, so the row stays "running" until the worker
  // finishes. Poll only while something is actually running — no timer on an idle screen.
  const anyRunning = rows.some((p) => p.lastStatus === "running" || p.lastStatus === "queued");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [anyRunning, reload]);

  async function toggle(p: WarehousePipeline) {
    try { await api.toggleWarehousePipeline(p.id, !p.enabled); toast(p.enabled ? "Paused" : "Enabled", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
  }
  async function runNow(p: WarehousePipeline, year?: string, params?: Record<string, string>) {
    try {
      // whatever the Run dialog was left showing wins; it starts from the portal year, or today's
      await api.runWarehousePipeline(p.id, year || portalYear || undefined, params);
      // the load runs on the server; the row shows "running" and the poll above brings the result
      toast("Run started", "ok");
      setRunTick((t) => t + 1);
      reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Run failed", "error"); }
  }
  /**
   * Run several steps at once, in the order shown on screen.
   *
   * <p>Queued one at a time on purpose, not in parallel — the server runner is single-threaded and
   * queue order is run order; parallel requests would make the order depend on arrival time,
   * which matters for pipelines that must run in sequence.
   */
  async function runBatch(list: WarehousePipeline[], year: string) {
    let ok = 0;
    for (const p of list) {
      try { await api.runWarehousePipeline(p.id, year || undefined); ok++; }
      catch (e) {
        toast(`Stopped at "${p.name}" — ${e instanceof Error ? e.message : "Could not queue"} · ${ok} steps already queued`, "error");
        reload(); return;
      }
    }
    toast(`Queued ${ok} steps — they run one at a time in order; follow the progress in the Last run column`, "ok");
    setPicked(new Set());
    reload();
  }

  /** Turn the ticked steps into a chain — step order is the order shown on screen */
  async function saveAsChain(name: string, folder: string) {
    const list = shownRows.filter((p) => picked.has(p.id));
    try {
      await api.createChain({
        name: name.trim(), folder: folder.trim() || null, enabled: true,
        // on_fail=stop: later steps consume earlier results; continuing after a failure piles up bad data
        steps: list.map((p) => ({ kind: "pipeline", pipelineId: p.id, checkId: null, schedulerId: null,
                                  onFail: "stop", config: null, label: null, varName: null })),
      });
      toast(`Created the chain "${name.trim()}" from ${list.length} steps`, "ok");
      setPicked(new Set()); setChainAsk(false);
    } catch (e) { toast(e instanceof Error ? e.message : "Could not create the chain", "error"); }
  }

  async function remove(p: WarehousePipeline) {
    setDelAsk(null);
    try { await api.deleteWarehousePipeline(p.id); toast("Deleted", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  return (
    <div className="fade-in">
      <PageHeader title="Data Pipeline" sub="Load and transform data into tables, step by step, on demand or on a schedule"
                  actions={can("RH.PIPELINE", "create") && (
                    <Button kind="primary" renderIcon={Add} onClick={() => { setDetail(null); setEditing("new"); }}>New pipeline</Button>
                  )} />

      {loadErr && <InlineNotification kind="error" title="Load failed" subtitle={loadErr} hideCloseButton lowContrast style={{ marginBottom: 16, maxWidth: "none" }} />}

      {/* Same layout as Tables / SQL Editor / Datasets — list on the left, the selected item on the right */}
      <div className={"rh-ops rh-fill" + (navOpen ? "" : " rh-ops--rail-off") + (editing || detail ? " rh-ops--stack rh-ops--detail" : " rh-ops--stack")}>
        <OpsPanel
          items={navItems}
          selectedId={editing === "new" ? "__new__" : editing ? editing.id : detail?.id ?? null}
          onSelect={(it) => { setEditing(null); setDetail(rows.find((r) => r.id === Number(it.id)) ?? null); }}
          navOpen={navOpen} onToggleNav={toggleNav} storageKey="rs.datapipeline.shutFolders"
          placeholder="Find a pipeline"
          query={query} onQuery={setQuery}
          picked={picked}
          onPick={(id, on) => setPicked((cur) => { const n = new Set(cur); if (on) n.add(id); else n.delete(id); return n; })}
          tools={shownRows.length > 0 ? (
            <Button kind="ghost" size="sm" renderIcon={allShownPicked ? Close : Checkmark}
                    title={allShownPicked ? "Clear selection" : "Select every pipeline shown"}
                    onClick={() => setPicked((cur) => {
                      const next = new Set(cur);
                      if (allShownPicked) for (const p of shownRows) next.delete(p.id);
                      else for (const p of shownRows) next.add(p.id);
                      return next;
                    })}>
              {allShownPicked ? "Clear" : "Select all"}
            </Button>
          ) : undefined}
          foot={pickedShown.length > 0 ? (
            <span style={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              <Button kind="primary" size="sm" renderIcon={Play} onClick={() => setBatchAsk(true)}>
                Run {pickedShown.length} in order
              </Button>
              <IconButton kind="ghost" size="sm" label="Save as chain" onClick={() => setChainAsk(true)}><LinkIcon /></IconButton>
              <IconButton kind="ghost" size="sm" label="Clear selection" onClick={() => setPicked(new Set())}><Close /></IconButton>
            </span>
          ) : (
            <span className="cds--type-label-01 rh-dim">{shownRows.length === rows.length ? `${rows.length} pipelines` : `${shownRows.length} of ${rows.length} pipelines`}</span>
          )}
          emptyText="No pipelines yet"
        />

        <div className={dp.pane}>
          {editing ? (
            <PipelineEditor key={editing === "new" ? "new" : editing.id}
                            original={editing === "new" ? null : editing} datasources={dss} toast={toast}
                            portalYear={portalYear}
                            knownFolders={[...new Set(rows.map((r) => r.folder).filter(Boolean) as string[])].sort()}
                            onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
          ) : detail ? (
            <PipelineDetail key={detail.id} p={detail} steps={stepsOf[detail.id] ?? []} types={stepTypes}
                            datasources={dss} runTick={runTick}
                            onChanged={() => { reload(); reloadSteps(detail.id); }}
                            onRun={() => setRunAsk(detail)}
                            onEdit={() => setEditing(detail)} onToggle={() => toggle(detail)}
                            onDelete={() => setDelAsk(detail)}
                            onCancelled={() => { toast("Cancel requested", "ok"); reload(); }} />
          ) : (
            <OpsEmpty icon="layers" title="Select a pipeline" />
          )}
        </div>
      </div>

      {batchAsk && (
        <BatchRunDialog list={pickedShown}
                        defaultYear={portalYear || currentFiscalYear()}
                        onClose={() => setBatchAsk(false)}
                        onRun={(y) => { setBatchAsk(false); runBatch(pickedShown, y); }} />
      )}
      {chainAsk && (
        <SaveChainDialog count={pickedShown.length}
                         knownFolders={[...new Set(rows.map((r) => r.folder).filter(Boolean) as string[])].sort()}
                         onClose={() => setChainAsk(false)} onSave={saveAsChain} />
      )}
      {delAsk && (
        <Modal danger width={400} title={`Delete pipeline "${delAsk.name}"?`} onClose={() => setDelAsk(null)}
               foot={<>
                 <Button kind="secondary" onClick={() => setDelAsk(null)}>Cancel</Button>
                 <Button kind="danger" onClick={() => remove(delAsk)}>Delete</Button>
               </>}>
          <p className="cds--type-body-01">Its run history goes with it.</p>
        </Modal>
      )}
      {runAsk && (
        <RunDialog p={runAsk} defaultYear={portalYear || currentFiscalYear()}
                   onClose={() => setRunAsk(null)}
                   onRun={(y, prm) => { const t = runAsk; setRunAsk(null); runNow(t, y, prm); }} />
      )}
    </div>
  );
}

/**
 * Asked before every run: the fiscal year (defaulting to the one running today) and whatever
 * parameters the pipeline declares. The year used to be taken silently from the
 * portal, so running last year's load meant editing the pipeline first.
 */
/** Confirm before running many steps — show the order and what will be truncated first */
function BatchRunDialog({ list, defaultYear, onClose, onRun }: {
  list: WarehousePipeline[]; defaultYear: string; onClose: () => void; onRun: (year: string) => void;
}) {
  const [year, setYear] = useState(defaultYear);
  const needsYear = list.some((p) => /\$YEAR(?::?[24])?\b/.test((p.sourceSql ?? "") + (p.clearWhere ?? "")));
  const wipes = list.filter((p) => p.loadMode === "replace" && p.clearMode !== "delete");
  return (
    <Modal title={`Run ${list.length} steps in order`}
           sub="One step at a time, in this order"
           width={620} onClose={onClose}
           foot={<>
             <Button kind="secondary" onClick={onClose}>Cancel</Button>
             <Button kind="primary" renderIcon={Flash} disabled={needsYear && !year.trim()} onClick={() => onRun(year.trim())}>
               Queue all {list.length} steps
             </Button>
           </>}>
      {wipes.length > 0 && (
        <InlineNotification kind="warning" lowContrast hideCloseButton style={{ maxWidth: "none", marginBottom: 16 }}
                            title={`${wipes.length} steps clear their existing data with TRUNCATE before loading`}
                            subtitle="TRUNCATE commits immediately and cannot be undone — if a step fails midway, its part stays empty until a later run succeeds" />
      )}
      <TextInput id="batch-year" labelText="Fiscal year (used by every step in this batch)" className="rh-mono"
                 helperText={needsYear ? "Some steps use $YEAR4/$YEAR2 — required" : "No step uses the year"}
                 value={year} onChange={(e) => setYear(e.target.value)} placeholder="2026" />
      <div style={{ marginTop: 16, maxHeight: 300, overflowY: "auto" }}>
        <StructuredListWrapper isCondensed aria-label="Run order">
          <StructuredListBody>
            {list.map((p, i) => (
              <StructuredListRow key={p.id}>
                <StructuredListCell className="cds--type-code-01 rh-dim" style={{ width: 40 }}>{i + 1}</StructuredListCell>
                <StructuredListCell>{p.name}</StructuredListCell>
                <StructuredListCell className="cds--type-code-01 rh-dim">{p.clearWhere ?? ""}</StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      </div>
    </Modal>
  );
}

/** Name the chain to create from the selected steps */
function SaveChainDialog({ count, knownFolders, onClose, onSave }: {
  count: number; knownFolders: string[]; onClose: () => void; onSave: (name: string, folder: string) => void;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState(knownFolders[0] ?? "");
  return (
    <Modal title={`Save ${count} steps as a chain`}
           sub="Job chain"
           width={520} onClose={onClose}
           foot={<>
             <Button kind="secondary" onClick={onClose}>Cancel</Button>
             <Button kind="primary" renderIcon={Checkmark} disabled={!name.trim()} onClick={() => onSave(name, folder)}>
               Create chain
             </Button>
           </>}>
      <div style={{ display: "grid", gap: 16 }}>
        <TextInput id="chain-name" labelText="Chain name" value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="e.g. Nightly load — every step" autoFocus
                   helperText="Every step stops the whole chain when it fails" />
        <ComboBox id="chain-group" titleText="Group (optional)" allowCustomValue items={knownFolders} selectedItem={folder || null}
                  onChange={({ selectedItem, inputValue }: { selectedItem?: string | null; inputValue?: string | null }) => setFolder(selectedItem ?? inputValue ?? "")}
                  onInputChange={(t: string) => setFolder(t ?? "")} />
      </div>
    </Modal>
  );
}

function RunDialog({ p, defaultYear, onClose, onRun }: {
  p: WarehousePipeline; defaultYear: string; onClose: () => void;
  onRun: (year: string, params: Record<string, string>) => void;
}) {
  const declared = parseParams(p.paramsJson);
  const [year, setYear] = useState(p.fiscalYear || defaultYear);
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(declared.map((d) => [d.name, d.default ?? ""])));
  const needsYear = /\$YEAR(?::?[24])?\b/.test(p.sourceSql ?? "") || /\$YEAR(?::?[24])?\b/.test(p.clearWhere ?? "");
  return (
    <Modal title={`Run ${p.name}`} sub="Run pipeline"
           width={560} onClose={onClose}
           foot={<>
             <Button kind="secondary" onClick={onClose}>Cancel</Button>
             <Button kind="primary" renderIcon={Flash} disabled={needsYear && !year.trim()}
                     onClick={() => onRun(year.trim(), vals)}>
               Start load
             </Button>
           </>}>
      {/* What gets cleared before loading — TRUNCATE (table or partition) commits immediately and cannot
          be undone, so it must be visible before clicking */}
      {p.loadMode === "replace" && (
        <InlineNotification kind={p.clearMode === "delete" ? "info" : "warning"} lowContrast hideCloseButton
                            style={{ maxWidth: "none", marginBottom: 16 }}
                            title="Existing data is cleared before the load"
>
                              <div>
                                {p.clearWhere
                                  ? <>Only the scope <code>{p.clearWhere}</code> in <code>{p.targetSchema ? p.targetSchema + "." : ""}{p.targetTable}</code></>
                                  : <>The whole table <code>{p.targetSchema ? p.targetSchema + "." : ""}{p.targetTable}</code></>}
                              </div>
                              {p.clearMode !== "delete" && (
                                <div>Cleared with {p.clearMode === "partition" ? "TRUNCATE PARTITION" : "TRUNCATE"} — it commits immediately,
                                  so if the load fails after clearing, this part stays empty until a later run succeeds</div>
                              )}
                              {p.controlColumn && (
                                <div>When the load finishes, <code>{p.controlColumn}</code> is checked against the source automatically</div>
                              )}
        </InlineNotification>
      )}
      <TextInput id="run-year" labelText="Fiscal year" className="rh-mono"
                 helperText={needsYear ? "This SQL uses $YEAR4/$YEAR2 — required" : "This SQL does not use the year — optional"}
                 invalid={needsYear && !year.trim()}
                 invalidText="No fiscal year yet — this pipeline needs one, so running now will fail"
                 value={year} onChange={(e) => setYear(e.target.value)} placeholder="2026" />
      {declared.map((d) => (
        <div key={d.name} style={{ marginTop: 16 }}>
          <TextInput id={`run-p-${d.name}`} className="rh-mono"
                     labelText={<>{d.label?.trim() || d.name} <code>${d.name}</code></>}
                     value={vals[d.name] ?? ""}
                     onChange={(e) => setVals({ ...vals, [d.name]: e.target.value })} />
        </div>
      ))}
    </Modal>
  );
}

/**
 * Natural sort — "step 2.4" before "step 3.1", and "step 10" after "step 9"
 * (plain string sort gives 10 < 9). On this screen order is content: steps that run in sequence
 * must sit next to each other.
 */
function natCompare(a: string, b: string): number {
  const re = /(\d+(?:\.\d+)?)|(\D+)/g;
  const A = a.match(re) ?? [], B = b.match(re) ?? [];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    const nx = parseFloat(x), ny = parseFloat(y);
    if (!isNaN(nx) && !isNaN(ny)) { if (nx !== ny) return nx - ny; }
    else if (x !== y) return x.localeCompare(y, "th");
  }
  return A.length - B.length;
}

function PipelineEditor({ original, datasources, toast, portalYear, knownFolders, onClose, onSaved }: {
  original: WarehousePipeline | null; datasources: Datasource[]; toast: ReturnType<typeof useToast>;
  portalYear: string; knownFolders: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [folder, setFolder] = useState(original?.folder ?? "");
  const [sourceDatasourceId, setSourceDatasourceId] = useState(original?.sourceDatasourceId ?? "");
  const [sourceSql, setSourceSql] = useState(original?.sourceSql ?? "");
  const [fiscalYear, setFiscalYear] = useState(original?.fiscalYear ?? "");
  const [targetDatasourceId, setTargetDatasourceId] = useState(original?.targetDatasourceId ?? "");
  const [targetTable, setTargetTable] = useState(original?.targetTable ?? "");
  const [targetSchema, setTargetSchema] = useState(original?.targetSchema ?? "");
  const [loadMode, setLoadMode] = useState<LoadMode>(original?.loadMode ?? "replace");
  const [clearMode, setClearMode] = useState<"delete" | "truncate" | "partition">(original?.clearMode ?? "delete");
  const [controlColumn, setControlColumn] = useState(original?.controlColumn ?? "");
  const [controlTolerance, setControlTolerance] = useState(
    original?.controlTolerance != null ? String(original.controlTolerance) : "0");
  const [preview, setPreview] = useState<TableResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [keyColumns, setKeyColumns] = useState(original?.keyColumns ?? "");
  const [clearWhere, setClearWhere] = useState(original?.clearWhere ?? "");
  const [runParams, setRunParams] = useState<RunParam[]>(parseParams(original?.paramsJson));
  const [autoCreate, setAutoCreate] = useState(original?.autoCreate ?? true);
  const [addColumns, setAddColumns] = useState(original?.addColumns ?? false);
  const [cron, setCron] = useState(original?.cron ?? "");
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const presetValue = CRON_PRESETS.some((c) => c.value === cron) ? cron : "__custom";
  const dsOptions = [{ value: "", label: "Report Studio internal database" },
                     ...datasources.map((d) => ({ value: d.id, label: `${d.name}${d.hasJdbc ? " · live JDBC" : ""}` }))];

  async function save() {
    if (!name.trim()) { toast("A name is required", "error"); return; }
    if (!sourceSql.trim()) { toast("The SQL is required", "error"); return; }
    if (!targetTable.trim()) { toast("A target table is required", "error"); return; }
    if (loadMode === "upsert" && !keyColumns.trim()) { toast("Upsert mode needs the key columns", "error"); return; }
    if (fiscalYear.trim() && !/^\d{4}$/.test(fiscalYear.trim())) { toast("The fiscal year must be 4 digits", "error"); return; }
    if (controlTolerance.trim() && !Number.isFinite(Number(controlTolerance))) {
      toast("The accepted difference must be a number", "error"); return;
    }
    // a cron cannot read the portal, so a scheduled year-driven pipeline needs its own year
    if (cron && !fiscalYear.trim() && /\$YEAR(?::?[24])?\b/.test(sourceSql)) {
      toast("The SQL uses $YEAR4/$YEAR2 — a scheduled pipeline must also set a fiscal year", "error"); return;
    }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, folder: folder.trim() || null,
        sourceDatasourceId: sourceDatasourceId || null, sourceSql, fiscalYear: fiscalYear.trim() || null,
        targetDatasourceId: targetDatasourceId || null, targetSchema: targetSchema.trim() || null,
        targetTable: targetTable.trim(), loadMode, clearMode,
        keyColumns: keyColumns || null, clearWhere: clearWhere.trim() || null,
        controlColumn: controlColumn.trim() || null,
        controlTolerance: controlTolerance.trim() ? Number(controlTolerance) : 0,
        paramsJson: runParams.filter((r) => r.name.trim()).length
          ? JSON.stringify(runParams.filter((r) => r.name.trim())) : null,
        autoCreate, addColumns, cron: cron.trim() ? toSpringCron(cron) : null, enabled };
      if (original) await api.updateWarehousePipeline(original.id, body);
      else await api.createWarehousePipeline(body);
      toast("Saved", "ok");
      onSaved();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); setSaving(false); }
  }

  /** Run the source SELECT and show the first rows — nothing is written anywhere. */
  async function runPreview() {
    if (!sourceSql.trim()) { toast("Enter the SQL first", "error"); return; }
    setPreviewing(true);
    try {
      const y = fiscalYear.trim() || portalYear;
      setPreview(await api.warehousePreview({
        datasourceId: sourceDatasourceId || null, sql: sourceSql, year: y || undefined, limit: 100,
      }));
    } catch (e) {
      setPreview(null);
      toast(e instanceof Error ? e.message : "Preview failed", "error");
    } finally { setPreviewing(false); }
  }

  const mono = "rh-mono";
  return (
    <div className={dp.editor}>
      <div className={dp.head}>
        <h2 className="cds--type-heading-03 rh-ellipsis" style={{ margin: 0, flex: 1 }}>{original ? `Edit pipeline · ${original.name}` : "New pipeline"}</h2>
        <IconButton kind="ghost" label="Close" align="left" onClick={onClose}><Close /></IconButton>
      </div>

      <div className={dp.grid3}>
        <TextInput id="pl-name" labelText="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Load sales data into the warehouse" />
        {/* Free text with suggestions: an existing folder is one click, a new one is still just typing */}
        <ComboBox id="pl-group" titleText="Group" placeholder="Sales / Daily" allowCustomValue items={knownFolders}
                  selectedItem={folder || null}
                  onChange={({ selectedItem, inputValue }: { selectedItem?: string | null; inputValue?: string | null }) => setFolder(selectedItem ?? inputValue ?? "")}
                  onInputChange={(t: string) => setFolder(t ?? "")} />
        <TextInput id="pl-year" labelText="Fiscal year" className={mono} value={fiscalYear}
                   onChange={(e) => setFiscalYear(e.target.value)} placeholder="2026" maxLength={4} />
      </div>

      <TextArea id="pl-desc" labelText="Description" rows={2} value={description ?? ""}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description of what this pipeline does" />

      {/* Source */}
      <Tile className={dp.section}>
        <h3 className={"cds--type-heading-compact-01 " + dp.sectionTitle}><Icon name="datasource" size={16} />Where the data comes from</h3>
        <Select label="Source database" value={sourceDatasourceId} onChange={setSourceDatasourceId} placeholder="Report Studio internal database" options={dsOptions} />
        <div>
          <div className="cds--label">Source SQL (SELECT only · put conditions in WHERE)</div>
          <SqlEditor value={sourceSql} onChange={setSourceSql} height={232} vars={["$YEAR4", "$YEAR2"]}
                     placeholder={"SELECT id, code, amount, updated_date\nFROM source_table\nWHERE <year_column> = '$YEAR4'"} />
          <div className="cds--form__helper-text">Every column needs a name — use AS for expressions · $YEAR4 = 2026, $YEAR2 = 26</div>
        </div>

        {/* Look before writing: the same SELECT the load will run, nothing is written. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Button kind="tertiary" size="sm" renderIcon={View} onClick={runPreview} disabled={previewing}>Preview 100 rows</Button>
          <span className="cds--type-label-01 rh-dim">
            Nothing is written to the target{(fiscalYear.trim() || portalYear)
              ? ` · using year ${fiscalYear.trim() || portalYear}`
              : " · no year known yet, so SQL using $YEAR4/$YEAR2 will fail"}
          </span>
        </div>
        {preview && (
          <TableContainer title="Preview" description={`${preview.rowCount} rows · ${preview.columns.length} columns`} className={dp.preview}>
            <Table size="xs">
              <TableHead><TableRow>{preview.columns.map((c) => <TableHeader key={c}>{c}</TableHeader>)}</TableRow></TableHead>
              <TableBody>
                {preview.rows.slice(0, 100).map((r, i) => (
                  <TableRow key={i}>{r.map((v, j) => <TableCell key={j} className="cds--type-code-01">{v === null ? "—" : String(v)}</TableCell>)}</TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Tile>

      {/* Target */}
      <Tile className={dp.section}>
        <h3 className={"cds--type-heading-compact-01 " + dp.sectionTitle}><Icon name="store" size={16} />Where it is stored</h3>
        <div className={dp.grid2}>
          <Select label="Target database" value={targetDatasourceId} onChange={setTargetDatasourceId} placeholder="Report Studio internal database" options={dsOptions} />
          <div>
            <div className="cds--label">Target table (schema · table)</div>
            <div className={dp.table2}>
              <TextInput id="pl-tschema" labelText="Schema" hideLabel className={mono} value={targetSchema}
                         onChange={(e) => setTargetSchema(e.target.value)} placeholder="WAREHOUSE" />
              <TextInput id="pl-ttable" labelText="Table" hideLabel className={mono} value={targetTable}
                         onChange={(e) => setTargetTable(e.target.value)} placeholder="fact_sales" />
            </div>
          </div>
        </div>
        <div className={loadMode === "upsert" ? dp.grid2 : undefined}>
          <Select label="Load mode" value={loadMode} onChange={(v) => setLoadMode(v as LoadMode)}
                  options={MODES.map((m) => ({ value: m.value, label: m.label, sub: m.hint }))} />
          {loadMode === "upsert" && (
            <TextInput id="pl-keys" labelText="Key columns used to match duplicates (comma separated)" className={mono}
                       value={keyColumns ?? ""} onChange={(e) => setKeyColumns(e.target.value)} placeholder="id  or  fiscal_year,code" />
          )}
        </div>
        <div>
          <Checkbox id="pl-autocreate" checked={autoCreate} onChange={(_, { checked }) => setAutoCreate(checked)}
                    labelText="Create the target table automatically from the SQL result if it does not exist yet" />
          {/* Off by default — a typo in the SELECT would otherwise leave a stray column behind for good. */}
          <Checkbox id="pl-addcols" checked={addColumns} onChange={(_, { checked }) => setAddColumns(checked)}
                    labelText="If the target table already exists and the SQL has columns it does not, add those columns"
                    helperText="Adds only — existing columns are kept · off = the load reports which columns are missing" />
        </div>
        {/* Declared parameters: the Run dialog asks for these, and $NAME is substituted into the
            SQL and the scoped-clear predicate. The fiscal year is always offered. */}
        <div>
          <div className="cds--label">Parameters asked for when you press Run</div>
          {runParams.map((rp, i) => (
            <div key={i} className={dp.param}>
              <TextInput id={`pl-pn-${i}`} labelText="Name" hideLabel size="sm" className={mono} placeholder="STAGE"
                         value={rp.name}
                         onChange={(e) => setRunParams(runParams.map((x, j) => j === i ? { ...x, name: e.target.value.toUpperCase() } : x))} />
              <TextInput id={`pl-pl-${i}`} labelText="Label" hideLabel size="sm" placeholder="Label shown, e.g. Step"
                         value={rp.label ?? ""}
                         onChange={(e) => setRunParams(runParams.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
              <TextInput id={`pl-pd-${i}`} labelText="Default" hideLabel size="sm" className={mono} placeholder="Default value"
                         value={rp.default ?? ""}
                         onChange={(e) => setRunParams(runParams.map((x, j) => j === i ? { ...x, default: e.target.value } : x))} />
              <IconButton kind="ghost" size="sm" label="Remove" align="left"
                          onClick={() => setRunParams(runParams.filter((_, j) => j !== i))}><Close /></IconButton>
            </div>
          ))}
          <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setRunParams([...runParams, { name: "", label: "", default: "" }])}>
            Add parameter
          </Button>
          <div className="cds--form__helper-text">Reference them in the SQL as $NAME · the fiscal year is always offered</div>
        </div>
        {loadMode === "replace" && (
          <TextInput id="pl-clearwhere" className={mono}
                     labelText="Clear only the rows matching this condition (empty = clear the whole table)"
                     helperText="DELETE mode takes a WHERE condition · partition mode takes the partition key value, e.g. $YEAR2|N · $YEAR4 / $YEAR2 can be used"
                     value={clearWhere} onChange={(e) => setClearWhere(e.target.value)}
                     placeholder="<column> = '$YEAR4' AND <column> = '<value>'" />
        )}
        {loadMode === "replace" && (
          <Select label="How the target is cleared before loading" value={clearMode}
                  onChange={(v) => setClearMode(v as "delete" | "truncate" | "partition")}
                  note="Both TRUNCATE modes commit immediately"
                  options={[
                    { value: "delete", label: "DELETE", sub: "Safe and reversible (slow on big tables)" },
                    { value: "truncate", label: "TRUNCATE whole table", sub: "Fast, but commits immediately" },
                    { value: "partition", label: "TRUNCATE PARTITION", sub: "Clears only the partition from the condition above (~1s)" },
                  ]} />
        )}
        {loadMode === "replace" && (
          <div className={dp.grid21}>
            <TextInput id="pl-control" className={mono} labelText="Control total column (empty = no check)"
                       helperText="Compares row count + sum against the source after every load, within this pipeline's scope"
                       value={controlColumn} onChange={(e) => setControlColumn(e.target.value)} placeholder="AMOUNT" />
            <TextInput id="pl-tol" className={mono} labelText="Accepted difference (amount)" value={controlTolerance}
                       onChange={(e) => setControlTolerance(e.target.value)} placeholder="0" />
          </div>
        )}
      </Tile>

      {/* Schedule */}
      <div className={dp.grid2}>
        <Select label="Run automatically on a schedule" value={presetValue === "__custom" ? "" : presetValue} onChange={setCron}
                placeholder="Manual only" options={CRON_PRESETS} />
        <TextInput id="pl-cron" className={mono} labelText="Write the cron yourself (empty = manual only)"
                   helperText="sec min hour day month weekday"
                   value={cron ?? ""} onChange={(e) => setCron(e.target.value)} placeholder="min hour day month weekday · e.g. 0 2 * * *" />
      </div>

      <div className={dp.foot}>
        <Toggle id="pl-enabled" size="sm" labelText="Enabled (run automatically when scheduled)" hideLabel={false}
                labelA="Off" labelB="On" toggled={enabled} onToggle={(v) => setEnabled(v)} />
        <div style={{ marginLeft: "auto" }}>
          <Button kind="primary" renderIcon={Checkmark} disabled={saving} onClick={save}>Save pipeline</Button>
        </div>
      </div>
    </div>
  );
}
