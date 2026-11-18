"use client";

// ETL chains — put existing pieces in order, run them as one round, keep every round.
//
// Left panel lists the chains in folders, right side is the one you picked: its steps, and the
// rounds it has run. Same left-right layout as the Tables screen.
//
// The step palette comes from GET /etl-chains/step-types, not a list written here — a new executor
// on the backend shows up in this screen on its own.
import { usePerms } from "@/lib/perms";
import { localTime } from "@/lib/format";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Button, ButtonSet, ComboBox, IconButton, InlineNotification, MenuButton, MenuItem, MenuItemGroup, NumberInput,
  Table, TableBody, TableCell, TableContainer, TableExpandHeader, TableExpandRow, TableExpandedRow, TableHead,
  TableHeader, TableRow, Tag, TextArea, TextInput, Tile, TreeNode, TreeView,
} from "@carbon/react";
import { Add, Checkmark, ChevronDown, ChevronUp, Close, Play, TrashCan } from "@carbon/icons-react";
import { PageHeader } from "@/components/ui";
import cx from "@/components/P/chains.module.scss";
import { Select } from "@/components/Select";
import { Modal, SlideOver } from "@/components/overlays";
import { FlowLine, durationOf, fmtDuration, type Station, type StationStatus } from "@/components/flowline/FlowLine";
import { useToast } from "@/components/Toast";
import { SqlEditor } from "@/components/SqlEditor";
import { api } from "@/lib/api";
import { byFolder, usePortalYear } from "@/lib/portal-year";
import type {
  ChainStepType, DataCheck, Datasource, EtlChain, EtlChainRun, EtlChainRunStep,
  EtlChainStep, Scheduler, WarehousePipeline,
} from "@/lib/types";

function fmt(ts: string | null | undefined): string {
  return ts ? localTime(ts) : "—";
}

function RoundChip({ status }: { status: string }) {
  const map: Record<string, ["green" | "red" | "warm-gray" | "blue" | "gray", string]> = {
    success: ["green", "All passed"],
    failed: ["red", "Failed"],
    partial: ["warm-gray", "Partly passed"],
    running: ["blue", "Running"],
    queued: ["gray", "Queued"],
    cancelled: ["gray", "Cancelled"],
  };
  const [type, text] = map[status] ?? ["gray", status];
  return <Tag size="sm" type={type}>{text}</Tag>;
}

function StepChip({ status }: { status: string }) {
  if (status === "success") return <Tag size="sm" type="green">Passed</Tag>;
  if (status === "failed") return <Tag size="sm" type="red">Failed</Tag>;
  if (status === "skipped") return <Tag size="sm" type="gray">Skipped</Tag>;
  return <Tag size="sm" type="blue">Running</Tag>;
}

/** What each inline step type asks for. Keyed by executor type, so it stays next to the backend. */
const INLINE_FIELDS: Record<string, { key: string; label: string; kind: "sql" | "text" | "num" | "ds"; hint?: string }[]> = {
  sql: [
    { key: "datasourceId", label: "Database", kind: "ds" },
    { key: "sql", label: "Statement", kind: "sql", hint: "INSERT / UPDATE / DELETE / MERGE, or a PL/SQL block (BEGIN … END;) · use $YEAR4 for the year" },
  ],
  load: [
    { key: "sourceDatasourceId", label: "Source database", kind: "ds" },
    { key: "sourceSql", label: "Source SELECT", kind: "sql", hint: "Use $YEAR4 / $YEAR2 for the fiscal year picked above" },
    { key: "targetDatasourceId", label: "Target database", kind: "ds" },
    { key: "targetSchema", label: "Target schema", kind: "text" },
    { key: "targetTable", label: "Target table", kind: "text" },
    { key: "keyColumns", label: "Key columns (for upsert)", kind: "text" },
  ],
  assert: [
    { key: "datasourceId", label: "Database", kind: "ds" },
    { key: "sql", label: "SELECT of failing rows", kind: "sql", hint: "No rows returned = pass · read values from earlier steps with {{name.field}}" },
    { key: "maxRows", label: "Failing rows allowed", kind: "num" },
  ],
};

export function ChainsPanel({ embedded = false }: { embedded?: boolean }) {
  const { can } = usePerms();
  const toast = useToast();
  const portalYear = usePortalYear();

  const [chains, setChains] = useState<EtlChain[]>([]);
  const [current, setCurrent] = useState<EtlChain | null>(null);
  const [stepTypes, setStepTypes] = useState<ChainStepType[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [pipes, setPipes] = useState<WarehousePipeline[]>([]);
  const [checks, setChecks] = useState<DataCheck[]>([]);
  const [stmts, setStmts] = useState<Scheduler[]>([]);
  const [runs, setRuns] = useState<EtlChainRun[]>([]);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [runSteps, setRunSteps] = useState<Record<number, EtlChainRunStep[]>>({});
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Run replayed on the flow line; null = follow the newest */
  const [flowRun, setFlowRun] = useState<number | null>(null);
  const [flowSteps, setFlowSteps] = useState<EtlChainRunStep[]>([]);
  const [station, setStation] = useState<string | null>(null);

  const reload = useCallback(async (keepId?: number) => {
    try {
      const rows = await api.chains();
      setChains(rows);
      const pick = keepId ? rows.find((c) => c.id === keepId) : undefined;
      setCurrent((cur) => pick ?? rows.find((c) => c.id === cur?.id) ?? rows[0] ?? null);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : "Load failed"); }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api.chainStepTypes().then(setStepTypes).catch(() => {});
    api.datasources().then(setDss).catch(() => {});
    api.warehousePipelines().then(setPipes).catch(() => {});
    api.checks().then(setChecks).catch(() => {});
    api.schedulers().then(setStmts).catch(() => {});
  }, []);

  const loadRuns = useCallback((id: number) => {
    api.chainRuns(id).then(setRuns).catch(() => setRuns([]));
  }, []);
  useEffect(() => { if (current) loadRuns(current.id); else setRuns([]); }, [current, loadRuns]);

  // A round runs on a worker, so the list has to be refreshed while one is in flight rather than
  // leaving the user staring at "Running" forever.
  useEffect(() => {
    if (!current || !runs.some((r) => r.status === "running" || r.status === "queued")) return;
    const t = setInterval(() => loadRuns(current.id), 3000);
    return () => clearInterval(t);
  }, [current, runs, loadRuns]);

  // Opening a row lets the effect below load its steps (it runs whenever openRun changes);
  // loading here too would fire twice per click.
  function toggleRun(runId: number) {
    setOpenRun((cur) => (cur === runId ? null : runId));
  }
  // Refresh the open run's steps whenever the run list moves — while a run is in flight the backend
  // writes a running row per step, so the screen shows which step it is on.
  useEffect(() => {
    if (openRun == null) return;
    api.chainRunSteps(openRun).then((s) => setRunSteps((m) => ({ ...m, [openRun]: s }))).catch(() => {});
  }, [runs, openRun]);

  useEffect(() => { setFlowRun(null); setStation(null); }, [current?.id]);
  const shownRun = runs.find((r) => r.id === flowRun) ?? runs[0] ?? null;
  const shownLive = !!shownRun && (shownRun.status === "running" || shownRun.status === "queued");
  useEffect(() => {
    if (!shownRun) { setFlowSteps([]); return; }
    let dead = false;
    const pull = () => api.chainRunSteps(shownRun.id).then((x) => { if (!dead) setFlowSteps(x); }).catch(() => {});
    pull();
    if (!shownLive) return () => { dead = true; };
    const t = setInterval(pull, 1000);
    return () => { dead = true; clearInterval(t); };
  }, [shownRun?.id, shownRun?.status, shownLive]); // eslint-disable-line react-hooks/exhaustive-deps
  // Faster run-list polling while the line is animating, so finished stations land promptly
  useEffect(() => {
    if (!current || !shownLive) return;
    const t = setInterval(() => loadRuns(current.id), 1500);
    return () => clearInterval(t);
  }, [current, shownLive, loadRuns]);

  const stations = useMemo<Station[]>(() => {
    if (!current) return [];
    const byNo = new Map(flowSteps.map((r) => [r.stepNo, r]));
    let carry: number | null | undefined = null;
    return current.steps.map((s) => {
      const rec = byNo.get(s.stepNo);
      const typeLabel = stepTypes.find((t) => t.type === s.kind)?.label ?? s.kind;
      const ref = s.kind === "pipeline" ? pipes.find((p) => p.id === s.pipelineId)?.name
        : s.kind === "check" ? checks.find((c) => c.id === s.checkId)?.name
          : s.kind === "statement" ? stmts.find((x) => x.id === s.schedulerId)?.name : undefined;
      let cfg: Record<string, unknown> = {};
      try { cfg = s.config ? JSON.parse(s.config) : {}; } catch { /* shown without config lines */ }
      const lines: Array<[string, string]> = [["type", typeLabel]];
      const sql = String(cfg.sql ?? cfg.sourceSql ?? "").replace(/\s+/g, " ").trim();
      if (sql) lines.push(["sql", sql.slice(0, 60)]);
      if (cfg.targetTable) lines.push(["target", String(cfg.targetTable)]);
      if (s.onFail === "continue") lines.push(["on fail", "continue"]);
      if (rec?.status === "success" && s.kind !== "assert" && s.kind !== "check") {
        carry = rec.rowsWritten ?? rec.affected ?? rec.rowsRead ?? carry;
      }
      const status: StationStatus = rec ? rec.status as StationStatus : shownLive ? "queued" : "idle";
      return {
        id: `s${s.stepNo}`, kind: s.kind, caption: s.kind === "pipeline" ? "Pipeline" : typeLabel.split(" (")[0],
        title: s.label ?? rec?.refName ?? ref ?? typeLabel, lines, status, passRows: carry,
        durationMs: rec && rec.status !== "running" ? durationOf(rec.startedAt, rec.finishedAt) : null,
        message: rec?.message,
      };
    });
  }, [current, flowSteps, shownLive, stepTypes, pipes, checks, stmts]);

  async function runChain() {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await api.runChain(current.id, portalYear || undefined);
      toast(`Started run ${r.roundNo}${r.fiscalYear ? ` for FY ${r.fiscalYear}` : ""}`, "ok");
      loadRuns(current.id);
    } catch (e) { toast(e instanceof Error ? e.message : "Run failed", "error"); }
    finally { setBusy(false); }
  }

  async function saveSteps(steps: EtlChainStep[]) {
    if (!current) return;
    try {
      await api.updateChain(current.id, {
        name: current.name, description: current.description, folder: current.folder,
        enabled: current.enabled,
        steps: steps.map((s) => ({
          kind: s.kind, pipelineId: s.pipelineId, checkId: s.checkId, schedulerId: s.schedulerId,
          config: s.config, label: s.label, varName: s.varName, onFail: s.onFail,
        })),
      });
      toast("Saved", "ok");
      reload(current.id);
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
  }

  async function removeChain() {
    if (!current) return;
    setConfirmDelete(false);
    try { await api.deleteChain(current.id); toast("Deleted", "ok"); setCurrent(null); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  const groups = useMemo(() => Array.from(byFolder(chains, (c) => c.folder).entries()), [chains]);
  // running before queued — "Cancel running round" must target the one actually running, not the newest queued
  const activeRun = runs.find((r) => r.status === "running") ?? runs.find((r) => r.status === "queued");
  const running = !!activeRun;

  async function resumeRun(runId: number) {
    try {
      const r = await api.resumeChainRun(runId);
      toast(`Started run ${r.roundNo}, resuming from step ${r.startStepNo}`, "ok");
      if (current) loadRuns(current.id);
    } catch (e) { toast(e instanceof Error ? e.message : "Resume failed", "error"); }
  }

  async function cancelActive() {
    if (!activeRun) return;
    try {
      await api.cancelChainRun(activeRun.id);
      toast("Cancellation requested — the pending steps will stop", "ok");
      if (current) loadRuns(current.id);
    } catch (e) { toast(e instanceof Error ? e.message : "Cancel failed", "error"); }
  }

  const actions = (
    <>
      {can("RH.PIPELINE", "create") && (<Button kind="tertiary" renderIcon={Add} onClick={() => setCreating(true)}>New chain</Button>)}
      {current && running && (
        <Button kind="danger" renderIcon={Close} onClick={cancelActive}>Cancel current run</Button>
      )}
      {current && (
        <Button kind="primary" renderIcon={Play} disabled={busy || running} onClick={runChain}>
          Run chain{portalYear ? ` for FY ${portalYear}` : ""}
        </Button>
      )}
    </>
  );

  return (
    <div className={embedded ? undefined : "fade-in"}>
      {embedded
        ? <div className="rh-page-header__actions" style={{ justifyContent: "flex-end", marginBottom: 16 }}>{actions}</div>
        : <PageHeader title="Job Chains" sub="Put existing jobs in order and run them in one go · each pass is kept as a run, split by fiscal year" actions={actions} />}

      <div className={cx.chains}>
        {/* chains, grouped by folder */}
        <Tile style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)" }}>
            <h3 className="cds--type-heading-compact-01" style={{ margin: 0 }}>All chains</h3>
            <span className="cds--type-label-01 rh-dim" style={{ marginLeft: "auto" }}>{chains.length}</span>
          </div>
          {err && <InlineNotification kind="error" title="Load failed" subtitle={err} hideCloseButton lowContrast />}
          {!err && chains.length === 0 && (
            <div className="cds--type-label-01 rh-dim" style={{ padding: 16 }}>None yet</div>
          )}
          {chains.length > 0 && (
            <TreeView label="Chains" hideLabel size="sm"
                      selected={current ? [`c:${current.id}`] : []} active={current ? `c:${current.id}` : undefined}
                      onSelect={(_e: unknown, node?: { id?: string | number }) => {
                        const id = String(node?.id ?? "");
                        if (!id.startsWith("c:")) return;
                        const c = chains.find((x) => `c:${x.id}` === id);
                        if (c) setCurrent(c);
                      }}>
              {groups.map(([folder, items]) => {
                const nodes = items.map((c) => (
                  <TreeNode key={c.id} id={`c:${c.id}`} label={
                    <span style={{ display: "flex", gap: 8, minWidth: 0, color: c.enabled ? undefined : "var(--cds-text-disabled)" }}>
                      <span className="rh-ellipsis" style={{ flex: 1, minWidth: 0 }}>{c.name}</span>
                      <span className="cds--type-label-01 rh-dim">{c.steps.length}</span>
                    </span>
                  } />
                ));
                return folder
                  ? <TreeNode key={`f:${folder}`} id={`f:${folder}`} label={folder} defaultIsExpanded>{nodes}</TreeNode>
                  : <Fragment key="_">{nodes}</Fragment>;
              })}
            </TreeView>
          )}
        </Tile>

        {/* the selected chain */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, minWidth: 0 }}>
          {!current && (
            <Tile className="cds--type-body-compact-01 rh-dim">Pick a chain on the left, or create a new one</Tile>
          )}
          {current && (
            <>
              <Tile style={{ padding: 0, display: "flex", flexDirection: "column", height: 420 }}>
                <div className="cds--type-body-compact-01" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)" }}>
                  {shownRun ? <><RoundChip status={shownRun.status} />
                    <span className="rh-dim" style={{ flex: 1, minWidth: 0 }}>
                      {shownRun.fiscalYear ? `FY ${shownRun.fiscalYear} · ` : ""}Run {shownRun.roundNo} · {fmt(shownRun.startedAt)}{shownRun.message ? ` · ${shownRun.message}` : ""}
                    </span>
                    {flowRun != null && flowRun !== runs[0]?.id && (
                      <Button kind="ghost" size="sm" onClick={() => setFlowRun(null)}>Show latest</Button>
                    )}</>
                    : <span className="rh-dim">Never run</span>}
                </div>
                <FlowLine stations={stations} selectedId={station} onSelect={setStation} />
              </Tile>

              <StepEditor key={current.id} chain={current} stepTypes={stepTypes} dss={dss}
                          pipes={pipes} checks={checks} stmts={stmts}
                          onSave={saveSteps} onDelete={() => setConfirmDelete(true)} />

              <TableContainer title="Run history" description={runs.length ? `${runs.length} runs` : "Never run"}>
                {runs.length > 0 && (
                  <div style={{ overflowX: "auto" }}>
                  <Table size="md">
                    <TableHead><TableRow>
                      <TableExpandHeader aria-label="Expand" />
                      <TableHeader>Run</TableHeader><TableHeader>Status</TableHeader><TableHeader>Started</TableHeader>
                      <TableHeader>Finished</TableHeader><TableHeader>By</TableHeader><TableHeader>Summary</TableHeader>
                    </TableRow></TableHead>
                    <TableBody>
                      {runs.map((r) => (
                        <Fragment key={r.id}>
                          <TableExpandRow isExpanded={openRun === r.id} onExpand={() => toggleRun(r.id)} aria-label="Show steps"
                                          {...({ onClick: (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("button")) return; toggleRun(r.id); setFlowRun(r.id); },
                                                 style: { cursor: "pointer" } } as object)}>
                            <TableCell><b>{r.fiscalYear ? `FY ${r.fiscalYear} · ` : ""}Run {r.roundNo}</b></TableCell>
                            <TableCell><RoundChip status={r.status} /></TableCell>
                            <TableCell className="rh-dim">{fmt(r.startedAt)}</TableCell>
                            <TableCell className="rh-dim">{fmt(r.finishedAt)}</TableCell>
                            <TableCell className="rh-dim">{r.runBy ?? "—"}</TableCell>
                            <TableCell>
                              {r.resumedFromRunId != null &&
                                <Tag size="sm" type="outline" title={`Resumed from the previous run, starting at step ${r.startStepNo}`}>from step {r.startStepNo}</Tag>}
                              {r.message ?? "—"}
                              {(r.status === "failed" || r.status === "partial" || r.status === "cancelled") && !running && (
                                <Button kind="ghost" size="sm" renderIcon={Play} style={{ marginLeft: 8 }}
                                        title="Start a new run from the first step of this run that did not pass"
                                        onClick={(e) => { e.stopPropagation(); resumeRun(r.id); }}>
                                  Resume
                                </Button>
                              )}
                            </TableCell>
                          </TableExpandRow>
                          {openRun === r.id && (
                            <TableExpandedRow colSpan={7}>
                              <Table size="sm">
                                <TableHead><TableRow>
                                  <TableHeader>Step</TableHeader><TableHeader>Job</TableHeader><TableHeader>Status</TableHeader>
                                  <TableHeader>Read</TableHeader><TableHeader>Written</TableHeader><TableHeader>Details</TableHeader>
                                </TableRow></TableHead>
                                <TableBody>
                                  {(runSteps[r.id] ?? []).map((s) => (
                                    <TableRow key={s.id}>
                                      <TableCell className="cds--type-code-01">{s.stepNo}</TableCell>
                                      <TableCell>{s.refName ?? s.kind}</TableCell>
                                      <TableCell><StepChip status={s.status} /></TableCell>
                                      <TableCell className="cds--type-code-01">{s.rowsRead ?? s.checkCount ?? "—"}</TableCell>
                                      <TableCell className="cds--type-code-01">{s.rowsWritten ?? s.affected ?? "—"}</TableCell>
                                      <TableCell className="rh-dim">{s.message ?? "—"}</TableCell>
                                    </TableRow>
                                  ))}
                                  {(runSteps[r.id] ?? []).length === 0 && (
                                    <TableRow><TableCell colSpan={6} className="rh-dim">No per-step results yet</TableCell></TableRow>
                                  )}
                                </TableBody>
                              </Table>
                            </TableExpandedRow>
                          )}
                        </Fragment>
                      ))}
                    </TableBody>
                  </Table>
                  </div>
                )}
              </TableContainer>
            </>
          )}
        </div>
      </div>

      {creating && (
        <NewChain onClose={() => setCreating(false)}
                  onCreated={(c) => { setCreating(false); reload(c.id); }}
                  folders={chains.map((c) => c.folder ?? "")} />
      )}
      {station && current && (() => {
        const s = current.steps.find((x) => `s${x.stepNo}` === station);
        const st = stations.find((x) => x.id === station);
        const rec = flowSteps.find((r) => `s${r.stepNo}` === station);
        if (!s || !st) return null;
        let cfg: Record<string, unknown> = {};
        try { cfg = s.config ? JSON.parse(s.config) : {}; } catch { /* none */ }
        const canResume = !!shownRun && rec?.status === "failed" && !running
          && (shownRun.status === "failed" || shownRun.status === "partial" || shownRun.status === "cancelled");
        return (
          <SlideOver width={600} title={st.title} sub={`Step ${s.stepNo} · ${st.caption}`} onClose={() => setStation(null)}
                     foot={canResume ? (
                       <ButtonSet className="rh-foot-set">
                         <Button kind="secondary" onClick={() => setStation(null)}>Close</Button>
                         <Button kind="primary" renderIcon={Play} onClick={() => { setStation(null); setFlowRun(null); resumeRun(shownRun!.id); }}>
                           Resume from this step
                         </Button>
                       </ButtonSet>
                     ) : undefined}>
            <div style={{ display: "grid", gap: 24 }}>
              {typeof cfg.sql === "string" && (
                <div><div className="cds--label">SQL</div><SqlEditor value={cfg.sql} onChange={() => {}} readOnly height={180} /></div>
              )}
              {typeof cfg.sourceSql === "string" && (
                <div><div className="cds--label">Source SELECT</div><SqlEditor value={cfg.sourceSql} onChange={() => {}} readOnly height={180} /></div>
              )}
              <section>
                <h4 className="cds--type-heading-compact-01" style={{ margin: "0 0 8px" }}>
                  Last log {shownRun && <span className="cds--type-label-01 rh-dim">· run {shownRun.roundNo}</span>}
                </h4>
                {rec ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <StepChip status={rec.status} />
                      <span className="cds--type-code-01 rh-dim">
                        {fmt(rec.startedAt)} · {fmtDuration(durationOf(rec.startedAt, rec.finishedAt)) || "—"}
                        {" · in "}{rec.rowsRead ?? rec.checkCount ?? "—"}{" · out "}{rec.rowsWritten ?? rec.affected ?? "—"}
                      </span>
                    </div>
                    {rec.message && <pre className="cds--type-code-01" style={{ margin: 0, padding: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--cds-layer-02)" }}>{rec.message}</pre>}
                  </div>
                ) : <div className="cds--type-body-compact-01 rh-dim">Not run in the selected run</div>}
              </section>
            </div>
          </SlideOver>
        );
      })()}
      {confirmDelete && current && (
        <Modal danger width={400} title={`Delete chain "${current.name}"?`} onClose={() => setConfirmDelete(false)}
               foot={<>
                 <Button kind="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                 <Button kind="danger" onClick={removeChain}>Delete</Button>
               </>}>
          <p className="cds--type-body-01">Its entire run history goes with it.</p>
        </Modal>
      )}
    </div>
  );
}

function NewChain({ onClose, onCreated, folders }: {
  onClose: () => void; onCreated: (c: EtlChain) => void; folders: string[];
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [description, setDescription] = useState("");
  const known = Array.from(new Set(folders.filter(Boolean)));

  async function save() {
    if (!name.trim()) { toast("Name the chain first", "error"); return; }
    try {
      const c = await api.createChain({ name: name.trim(), folder: folder.trim() || null,
                                        description: description.trim() || null, steps: [] });
      onCreated(c);
    } catch (e) { toast(e instanceof Error ? e.message : "Create failed", "error"); }
  }

  return (
    <Modal title="New chain" onClose={onClose} foot={
      <>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" onClick={save}>Create</Button>
      </>
    }>
      <div style={{ display: "grid", gap: 16 }}>
        <TextInput id="chain-name" labelText="Chain name" value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="e.g. Build the seed data, then check it" autoFocus />
        <ComboBox id="chain-folder" titleText="Folder (grouping)" placeholder="Optional" allowCustomValue
                  items={known} selectedItem={folder || null}
                  onChange={({ selectedItem, inputValue }: { selectedItem?: string | null; inputValue?: string | null }) => setFolder(selectedItem ?? inputValue ?? "")}
                  onInputChange={(t: string) => setFolder(t ?? "")} />
        <TextInput id="chain-desc" labelText="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </div>
    </Modal>
  );
}

function StepEditor({ chain, stepTypes, dss, pipes, checks, stmts, onSave, onDelete }: {
  chain: EtlChain;
  stepTypes: ChainStepType[];
  dss: Datasource[];
  pipes: WarehousePipeline[];
  checks: DataCheck[];
  stmts: Scheduler[];
  onSave: (steps: EtlChainStep[]) => void;
  onDelete: () => void;
}) {
  const [steps, setSteps] = useState<EtlChainStep[]>(chain.steps);
    const dirty = JSON.stringify(steps) !== JSON.stringify(chain.steps);

  function add(kind: string) {
    setSteps((s) => [...s, {
      id: null, stepNo: s.length + 1, kind,
      pipelineId: null, checkId: null, schedulerId: null,
      config: INLINE_FIELDS[kind] ? "{}" : null,
      label: null, varName: null, onFail: "stop",
    }]);
  }
  function patch(i: number, p: Partial<EtlChainStep>) {
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }
  function patchConfig(i: number, key: string, value: string) {
    setSteps((s) => s.map((x, j) => {
      if (j !== i) return x;
      let cfg: Record<string, unknown> = {};
      try { cfg = x.config ? JSON.parse(x.config) : {}; } catch { cfg = {}; }
      if (value === "") delete cfg[key]; else cfg[key] = value;
      return { ...x, config: JSON.stringify(cfg) };
    }));
  }
  function cfgOf(s: EtlChainStep): Record<string, string> {
    try { return s.config ? JSON.parse(s.config) : {}; } catch { return {}; }
  }
  function move(i: number, by: number) {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    setSteps((s) => { const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c.map((x, k) => ({ ...x, stepNo: k + 1 })); });
  }
  function drop(i: number) {
    setSteps((s) => s.filter((_, j) => j !== i).map((x, k) => ({ ...x, stepNo: k + 1 })));
  }

  const dsOptions = [{ value: "", label: "Report Studio internal database" },
                     ...dss.map((d) => ({ value: d.id, label: d.name }))];

  return (
    <Tile style={{ padding: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)", flexWrap: "wrap" }}>
        <h3 className="cds--type-heading-compact-02" style={{ margin: 0 }}>{chain.name}</h3>
        {chain.description && <span className="cds--type-label-01 rh-dim">{chain.description}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 1 }}>
          {dirty && <Button kind="ghost" size="sm" onClick={() => setSteps(chain.steps)}>Revert</Button>}
          {dirty && <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={() => onSave(steps)}>Save steps</Button>}
          <IconButton kind="ghost" size="sm" label="Delete chain" align="bottom-end" onClick={onDelete}><TrashCan /></IconButton>
        </div>
      </div>

      {steps.length === 0 && (
        <div className="cds--type-body-compact-01 rh-dim" style={{ padding: 16 }}>No steps yet</div>
      )}

      {steps.map((s, i) => {
        const inline = INLINE_FIELDS[s.kind];
        const typeLabel = stepTypes.find((t) => t.type === s.kind)?.label ?? s.kind;
        const cfg = cfgOf(s);
        return (
          <div key={i} style={{ padding: "12px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="cds--type-code-01 rh-dim" style={{ minWidth: 20 }}>{i + 1}.</span>
              <b className="cds--type-heading-compact-01">{typeLabel}</b>
              <div style={{ width: 240 }}>
                <TextInput id={`step-label-${i}`} size="sm" labelText="Step name" hideLabel
                           value={s.label ?? ""} placeholder="Step name (optional)"
                           onChange={(e) => patch(i, { label: e.target.value || null })} />
              </div>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 260 }}>
                  <Select compact prefix="If it fails" value={s.onFail} onChange={(v) => patch(i, { onFail: v as "stop" | "continue" })}
                          options={[{ value: "stop", label: "Stop the chain" }, { value: "continue", label: "Continue" }]} />
                </div>
                <IconButton kind="ghost" size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp /></IconButton>
                <IconButton kind="ghost" size="sm" label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ChevronDown /></IconButton>
                <IconButton kind="ghost" size="sm" label="Delete this step" align="bottom-end" onClick={() => drop(i)}><Close /></IconButton>
              </div>
            </div>
            {/* referential kinds: pick the saved thing */}
            {s.kind === "pipeline" && (
              <div style={{ marginTop: 8, maxWidth: 460 }}>
                <Select value={s.pipelineId ? String(s.pipelineId) : ""} searchable placeholder="Pick a pipeline"
                        onChange={(v) => patch(i, { pipelineId: v ? Number(v) : null })}
                        options={pipes.map((p) => ({ value: String(p.id), label: p.name }))} />
              </div>
            )}
            {s.kind === "check" && (
              <div style={{ marginTop: 8, maxWidth: 460 }}>
                <Select value={s.checkId ? String(s.checkId) : ""} searchable placeholder="Pick a data check"
                        onChange={(v) => patch(i, { checkId: v ? Number(v) : null })}
                        options={checks.map((c) => ({ value: String(c.id), label: c.name }))} />
              </div>
            )}
            {s.kind === "statement" && (
              <div style={{ marginTop: 8, maxWidth: 460 }}>
                <Select value={s.schedulerId ? String(s.schedulerId) : ""} searchable placeholder="Pick a SQL statement"
                        onChange={(v) => patch(i, { schedulerId: v ? Number(v) : null })}
                        options={stmts.map((x) => ({ value: String(x.id), label: x.name }))} />
              </div>
            )}

            {/* inline kinds: the program lives here */}
            {inline && (
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                {inline.map((f) => (
                  <div key={f.key}>
                    {f.kind === "ds" ? (
                      <div style={{ maxWidth: 460 }}>
                        <Select label={f.label} value={cfg[f.key] ?? ""} onChange={(v) => patchConfig(i, f.key, v)} options={dsOptions} />
                      </div>
                    ) : f.kind === "sql" ? (
                      <TextArea id={`step-${i}-${f.key}`} labelText={f.label} helperText={f.hint} rows={4} className="rh-mono"
                                value={cfg[f.key] ?? ""} onChange={(e) => patchConfig(i, f.key, e.target.value)} />
                    ) : f.kind === "num" ? (
                      <div style={{ maxWidth: 320 }}>
                        <NumberInput id={`step-${i}-${f.key}`} label={f.label} helperText={f.hint} hideSteppers allowEmpty
                                     value={cfg[f.key] ?? ""}
                                     onChange={(_e, { value }) => patchConfig(i, f.key, value === "" || value == null || Number.isNaN(value) ? "" : String(value))} />
                      </div>
                    ) : (
                      <div style={{ maxWidth: 320 }}>
                        <TextInput id={`step-${i}-${f.key}`} labelText={f.label} helperText={f.hint}
                                   value={cfg[f.key] ?? ""} onChange={(e) => patchConfig(i, f.key, e.target.value)} />
                      </div>
                    )}
                  </div>
                ))}
                <div>
                  <div style={{ maxWidth: 320 }}>
                    <TextInput id={`step-${i}-var`} labelText="Result name" helperText={"Later steps refer to it as {{name.field}}"}
                               value={s.varName ?? ""} placeholder="Optional"
                               onChange={(e) => patch(i, { varName: e.target.value || null })} />
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ padding: "12px 16px" }}>
        <MenuButton label="Add step" kind="tertiary" size="sm" menuAlignment="bottom-start">
          <MenuItemGroup label="Write the program right in this step">
            {stepTypes.filter((t) => t.mode === "inline").map((t) => (
              <MenuItem key={t.type} label={t.label} onClick={() => add(t.type)} />
            ))}
          </MenuItemGroup>
          <MenuItemGroup label="Or use something already saved">
            {stepTypes.filter((t) => t.mode === "ref").map((t) => (
              <MenuItem key={t.type} label={t.label} onClick={() => add(t.type)} />
            ))}
          </MenuItemGroup>
        </MenuButton>
      </div>
    </Tile>
  );
}
