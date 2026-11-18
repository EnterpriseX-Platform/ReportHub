"use client";

// Detail of one pipeline: a production line (Source → steps → Target) with the run history beside it.
// Selecting a run replays its result on the line; a run in flight is polled and animates live.
// Clicking a station opens a side panel to view / edit it and read its last log.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, ButtonSet, IconButton, InlineNotification, MenuButton, MenuItem, NumberInput, StructuredListBody,
  StructuredListCell, StructuredListRow, StructuredListWrapper, Tag, TextInput,
} from "@carbon/react";
import { Close, Edit, Flash, Pause, Play, TrashCan } from "@carbon/icons-react";
import { Skeleton } from "@/components/ui";
import { usePerms } from "@/lib/perms";
import { localTime } from "@/lib/format";
import { api } from "@/lib/api";
import { Select } from "@/components/Select";
import { SlideOver } from "@/components/overlays";
import { SqlEditor } from "@/components/SqlEditor";
import { useToast } from "@/components/Toast";
import { FlowLine, durationOf, fmtDuration, type Station, type StationStatus } from "@/components/flowline/FlowLine";
import ln from "@/components/flowline/line.module.scss";
import type {
  Datasource, SaveWarehouseInput, StepType, WarehousePipeline, WarehouseRun, WarehouseRunStep, WarehouseStep,
} from "@/lib/types";

/** Step numbers the backend records for the pipeline's own Source and Target stations. */
const SRC_NO = 0, TGT_NO = 9999;

const RUN_TAG: Record<string, ["green" | "red" | "blue" | "gray" | "cool-gray", string]> = {
  ok: ["green", "Succeeded"], error: ["red", "Failed"], running: ["blue", "Running"],
  queued: ["cool-gray", "Queued"], cancelled: ["gray", "Cancelled"],
};
const CAPTION: Record<string, string> = { sql: "SQL step", assert: "Assert", load: "Load", check: "Check" };

/** Human-readable name of a step — an explicit label wins, otherwise the type name */
export function stepTitle(s: WarehouseStep, types: StepType[]): string {
  if (s.label?.trim()) return s.label.trim();
  try {
    const c = JSON.parse(s.config || "{}");
    if (s.kind === "load" && c.targetTable) return `Load into ${c.targetSchema ? c.targetSchema + "." : ""}${c.targetTable}`;
  } catch { /* bad config: fall back to the type name */ }
  return types.find((t) => t.type === s.kind)?.label ?? s.kind;
}

function cfgOf(s: WarehouseStep): Record<string, unknown> {
  try { return JSON.parse(s.config || "{}"); } catch { return {}; }
}
/** One readable line from a SQL text: what it reads/changes, not the first 40 characters of it */
function sqlGist(sql: string | null | undefined): string {
  const t = (sql ?? "").replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  const verb = t.split(" ")[0].toUpperCase();
  const obj = /\b(?:from|into|update|table)\s+([\w."$]+)/i.exec(t)?.[1];
  return obj ? `${verb} … ${obj}` : t.slice(0, 48);
}
function modeText(p: WarehousePipeline): string {
  if (p.loadMode === "replace") return p.clearMode === "truncate" ? "truncate + load" : "replace";
  return p.loadMode;
}
function ago(ts: string): string {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
const live = (r: WarehouseRun | null | undefined) => !!r && (r.status === "running" || r.status === "queued");

function toInput(p: WarehousePipeline, patch: Partial<SaveWarehouseInput>): SaveWarehouseInput {
  return {
    name: p.name, description: p.description, folder: p.folder, sourceDatasourceId: p.sourceDatasourceId,
    sourceSql: p.sourceSql, fiscalYear: p.fiscalYear, targetDatasourceId: p.targetDatasourceId,
    targetSchema: p.targetSchema, targetTable: p.targetTable, loadMode: p.loadMode, clearMode: p.clearMode,
    keyColumns: p.keyColumns, clearWhere: p.clearWhere, controlColumn: p.controlColumn,
    controlTolerance: p.controlTolerance, paramsJson: p.paramsJson, autoCreate: p.autoCreate,
    addColumns: p.addColumns, cron: p.cron, enabled: p.enabled, ...patch,
  };
}

export function PipelineDetail({ p, steps, types, datasources, runTick, onRun, onCancelled, onEdit, onToggle, onDelete, onChanged }: {
  p: WarehousePipeline; steps: WarehouseStep[]; types: StepType[]; datasources: Datasource[];
  /** Bumped by the page after it queued a run — reload and follow the new run */
  runTick: number;
  onRun: () => void; onCancelled: () => void;
  onEdit: () => void; onToggle: () => void; onDelete: () => void;
  /** Pipeline or its steps were saved from the station panel */
  onChanged: () => void;
}) {
  const { can } = usePerms();
  const toast = useToast();
  const [runs, setRuns] = useState<WarehouseRun[] | null>(null);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  /** true = the user chose a run; otherwise the newest run is followed */
  const pinned = useRef(false);
  const [runSteps, setRunSteps] = useState<WarehouseRunStep[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api.warehouseRuns(p.id, 40).then((r) => {
      setRuns(r); setRunsErr(null);
      setPick((cur) => (pinned.current && cur != null && r.some((x) => x.id === cur) ? cur : r[0]?.id ?? null));
    }).catch((e) => { setRunsErr(e instanceof Error ? e.message : "Could not load runs"); setRuns((cur) => cur ?? []); });
  }, [p.id]);
  useEffect(load, [load]);
  // A run was just queued from the page: follow it (this was the "Never run" bug — the list was never reloaded)
  useEffect(() => {
    if (runTick === 0) return;
    pinned.current = false;
    load();
  }, [runTick, load]);
  // The page's own list also learns about scheduled runs; reload when its last-run stamp moves
  useEffect(load, [p.lastRunAt, p.lastStatus, load]);

  const current = runs?.find((r) => r.id === pick) ?? null;
  const anyLive = !!runs?.some(live);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [anyLive, load]);

  useEffect(() => {
    if (pick == null) { setRunSteps([]); return; }
    let dead = false;
    const pull = () => api.warehouseRunSteps(pick).then((x) => { if (!dead) setRunSteps(x); }).catch(() => {});
    pull();
    if (live(current)) {
      const t = setInterval(pull, 1000);
      return () => { dead = true; clearInterval(t); };
    }
    return () => { dead = true; };
  }, [pick, current?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const dsName = useCallback((id: string | null) => (id ? datasources.find((d) => d.id === id)?.name ?? id : "Internal warehouse"),
    [datasources]);
  const target = `${p.targetSchema ? p.targetSchema + "." : ""}${p.targetTable}`;
  const ownLoad = steps.some((x) => x.kind === "load");

  const stations = useMemo<Station[]>(() => {
    const byNo = new Map(runSteps.map((r) => [r.stepNo, r]));
    const running = live(current);
    const finishedOk = current?.status === "ok";
    const legacy = !!current && !running && runSteps.length === 0; // scheduled / older runs: run-level result only
    const state = (rec: WarehouseRunStep | undefined, legacyStatus?: StationStatus): Partial<Station> => {
      if (rec) {
        return {
          status: rec.status as StationStatus,
          durationMs: rec.status === "running" ? null : durationOf(rec.startedAt, rec.finishedAt),
          message: rec.message,
        };
      }
      if (running) return { status: "queued" };
      if (legacy && legacyStatus) return { status: legacyStatus };
      return { status: "idle" };
    };
    const out: Station[] = [];
    let carry: number | null | undefined = null;
    if (!ownLoad) {
      const rec = byNo.get(SRC_NO);
      const st = state(rec, finishedOk ? "success" : current?.status === "error" ? "failed" : undefined);
      carry = rec ? rec.rowsWritten ?? rec.rowsRead : legacy ? current?.rowsRead : null;
      out.push({
        id: "src", kind: "source", caption: "Source", title: dsName(p.sourceDatasourceId),
        lines: [["query", sqlGist(p.sourceSql)], ...(p.fiscalYear ? [["year", p.fiscalYear] as [string, string]] : [])],
        passRows: carry, ...st,
        message: st.message ?? (legacy && current?.status === "error" ? current.message : null),
        durationMs: st.durationMs ?? (legacy ? durationOf(current?.startedAt, current?.finishedAt) : null),
      });
    }
    for (const s of steps) {
      const rec = byNo.get(s.stepNo);
      const c = cfgOf(s);
      const lines: Array<[string, string]> = [["sql", sqlGist(String(c.sql ?? c.sourceSql ?? ""))]];
      if (s.kind === "assert") lines.push(["allow", `${Number(c.maxRows ?? 0)} bad rows`]);
      if (s.onFail === "continue") lines.push(["on fail", "continue"]);
      if (rec?.status === "success" && s.kind !== "assert" && rec.rowsWritten != null) carry = rec.rowsWritten;
      out.push({
        id: `s${s.stepNo}`, kind: s.kind, caption: CAPTION[s.kind] ?? s.kind, title: stepTitle(s, types), lines,
        passRows: carry, ...state(rec, legacy && finishedOk ? "success" : undefined),
      });
    }
    if (!ownLoad) {
      const rec = byNo.get(TGT_NO);
      out.push({
        id: "tgt", kind: "target", caption: "Target", title: target,
        lines: [["mode", modeText(p)], ...(p.keyColumns ? [["key", p.keyColumns] as [string, string]] : []),
                ["into", dsName(p.targetDatasourceId)]],
        ...state(rec, finishedOk ? "success" : current?.status === "error" ? "skipped" : undefined),
      });
    }
    return out;
  }, [steps, runSteps, current, p, types, ownLoad, dsName, target]);

  async function cancel(runId: number) {
    try { await api.cancelWarehouseRun(runId); onCancelled(); load(); } catch { /* button stays; can retry */ }
  }

  // ---- station panel ------------------------------------------------------
  const [draft, setDraft] = useState<WarehouseStep | null>(null);
  const [srcSql, setSrcSql] = useState(""); const [srcDs, setSrcDs] = useState("");
  const [tgt, setTgt] = useState({ schema: "", table: "", mode: "replace", keys: "" });
  const [saving, setSaving] = useState(false);
  const dsOptions = [{ value: "", label: "Internal warehouse" }, ...datasources.map((d) => ({ value: d.id, label: d.name }))];

  function openStation(id: string) {
    setOpen(id);
    if (id === "src") { setSrcSql(p.sourceSql); setSrcDs(p.sourceDatasourceId ?? ""); }
    else if (id === "tgt") {
      setTgt({ schema: p.targetSchema ?? "", table: p.targetTable,
               mode: p.loadMode === "replace" && p.clearMode === "truncate" ? "truncate" : p.loadMode, keys: p.keyColumns ?? "" });
    } else if (id.startsWith("new:")) {
      setDraft({ id: null, stepNo: steps.length + 1, kind: id.slice(4), label: null,
                 config: JSON.stringify(id.slice(4) === "assert" ? { sql: "", maxRows: 0 } : { sql: "" }),
                 onFail: "stop", varName: null });
    } else {
      setDraft(steps.find((s) => `s${s.stepNo}` === id) ?? null);
    }
  }

  async function savePipeline(patch: Partial<SaveWarehouseInput>) {
    setSaving(true);
    try { await api.updateWarehousePipeline(p.id, toInput(p, patch)); toast("Saved", "ok"); setOpen(null); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
    finally { setSaving(false); }
  }
  async function saveSteps(next: WarehouseStep[]) {
    setSaving(true);
    try {
      await api.saveWarehouseSteps(p.id, next.map((s, i) => ({ ...s, stepNo: i + 1 })));
      toast("Steps saved", "ok"); setOpen(null); onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
    finally { setSaving(false); }
  }
  function patchDraft(key: string, v: unknown) {
    setDraft((d) => d && ({ ...d, config: JSON.stringify({ ...cfgOf(d), [key]: v }) }));
  }

  const isNew = open?.startsWith("new:");
  const st = stations.find((x) => x.id === open);
  const logRec = open === "src" ? runSteps.find((r) => r.stepNo === SRC_NO)
    : open === "tgt" ? runSteps.find((r) => r.stepNo === TGT_NO)
      : runSteps.find((r) => `s${r.stepNo}` === open);
  const canEdit = can("RH.PIPELINE", "update");

  return (
    <div className={ln.root}>
      <div className={ln.bar}>
        <div className={ln.titles}>
          <h2 className="cds--type-heading-03 rh-ellipsis" style={{ margin: 0 }}>{p.name}</h2>
          <div className="cds--type-label-01 rh-dim">
            {steps.length} {steps.length === 1 ? "step" : "steps"} · {target} · {modeText(p)}
            {!p.enabled && " · paused"}
          </div>
        </div>
        <div className={ln.actions}>
          {canEdit && (
            <MenuButton label="Add step" kind="ghost" size="md" menuAlignment="bottom-end">
              {types.filter((t) => t.type !== "load").map((t) => (
                <MenuItem key={t.type} label={t.label} onClick={() => openStation(`new:${t.type}`)} />
              ))}
            </MenuButton>
          )}
          <Button kind="ghost" renderIcon={p.enabled ? Pause : Play} onClick={onToggle}>{p.enabled ? "Pause" : "Resume"}</Button>
          {canEdit && <Button kind="ghost" renderIcon={Edit} onClick={onEdit}>Edit</Button>}
          {can("RH.PIPELINE", "delete") && (
            <IconButton kind="ghost" label="Delete pipeline" align="bottom-end" onClick={onDelete}><TrashCan /></IconButton>
          )}
          <Button kind="primary" renderIcon={Flash} onClick={onRun} disabled={anyLive}>Run now</Button>
        </div>
      </div>

      <div className={ln.body}>
        <nav className={ln.runs} aria-label="Run history">
          <h3 className={`cds--type-heading-compact-01 ${ln.runsHead}`}>
            Run history {runs && runs.length > 0 && <span className="cds--type-label-01 rh-dim">{runs.length}</span>}
          </h3>
          {runs === null && <div style={{ padding: 16 }}><Skeleton /></div>}
          {runsErr && <InlineNotification kind="error" lowContrast hideCloseButton title="Runs" subtitle={runsErr} />}
          {runs?.length === 0 && !runsErr && <div className="cds--type-label-01 rh-dim" style={{ padding: "0 16px 16px" }}>Never run</div>}
          {runs?.map((r) => {
            const [type, text] = RUN_TAG[r.status] ?? ["gray", r.status];
            return (
              <button key={r.id} type="button" className={`${ln.run} ${r.id === pick ? ln.runOn : ""}`}
                      aria-pressed={r.id === pick}
                      onClick={() => { pinned.current = r.id !== runs[0]?.id; setPick(r.id); }}>
                <Tag size="sm" type={type}>{text}</Tag>
                <span className="cds--type-label-01 rh-dim" style={{ alignSelf: "center" }}>#{r.id} · {r.trigger}</span>
                <span className={ln.runMeta}>
                  {ago(r.startedAt)}{r.finishedAt ? ` · ${fmtDuration(durationOf(r.startedAt, r.finishedAt))}` : ""}
                  {r.rowsWritten != null ? ` · ${r.rowsWritten.toLocaleString()} rows` : ""}
                </span>
              </button>
            );
          })}
        </nav>

        <div className={ln.main}>
          {current && (
            <div className={ln.summary}>
              <span style={{ flex: 1, minWidth: 0 }}>
                Run #{current.id} · {localTime(current.startedAt)}{current.message ? ` · ${current.message}` : ""}
                {current.reconMessage && <> · <span style={{ color: current.reconStatus === "match" ? "var(--cds-support-success)" : "var(--cds-support-error)" }}>{current.reconMessage}</span></>}
              </span>
              {live(current) && (
                <Button kind="danger--ghost" size="sm" renderIcon={Close} onClick={() => cancel(current.id)}>Cancel run</Button>
              )}
            </div>
          )}
          <FlowLine stations={stations} selectedId={open} onSelect={openStation} />
        </div>
      </div>

      {open && (open === "src" || open === "tgt" || draft) && (
        <SlideOver width={640} onClose={() => { setOpen(null); setDraft(null); }}
                   title={open === "src" ? "Source" : open === "tgt" ? `Target · ${target}` : isNew ? `New ${CAPTION[draft!.kind] ?? draft!.kind}` : st?.title ?? "Step"}
                   sub={open === "src" ? dsName(p.sourceDatasourceId) : open === "tgt" ? modeText(p) : st?.caption}
                   foot={canEdit ? (
                     <ButtonSet className="rh-foot-set">
                       {draft && !isNew
                         ? <Button kind="danger--ghost" renderIcon={TrashCan} disabled={saving}
                                   onClick={() => saveSteps(steps.filter((s) => s.stepNo !== draft.stepNo))}>Remove step</Button>
                         : <Button kind="secondary" onClick={() => { setOpen(null); setDraft(null); }}>Cancel</Button>}
                       <Button kind="primary" disabled={saving} onClick={() => {
                         if (open === "src") savePipeline({ sourceSql: srcSql, sourceDatasourceId: srcDs || null });
                         else if (open === "tgt") savePipeline({
                           targetSchema: tgt.schema.trim() || null, targetTable: tgt.table.trim(),
                           loadMode: (tgt.mode === "truncate" ? "replace" : tgt.mode) as SaveWarehouseInput["loadMode"],
                           clearMode: tgt.mode === "truncate" ? "truncate" : tgt.mode === "replace" ? "delete" : p.clearMode,
                           keyColumns: tgt.keys.trim() || null,
                         });
                         else if (draft) saveSteps(isNew ? [...steps, draft] : steps.map((s) => (s.stepNo === draft.stepNo ? draft : s)));
                       }}>Save</Button>
                     </ButtonSet>
                   ) : undefined}>
          <div className={ln.panel}>
            {open === "src" && (
              <>
                <Select label="Connection" value={srcDs} onChange={setSrcDs} options={dsOptions} disabled={!canEdit} />
                <div>
                  <div className="cds--label">Source query</div>
                  <SqlEditor value={srcSql} onChange={setSrcSql} height={220} readOnly={!canEdit} vars={["$YEAR4"]} />
                </div>
              </>
            )}
            {open === "tgt" && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16 }}>
                  <TextInput id="fl-tgt-schema" labelText="Schema" value={tgt.schema} disabled={!canEdit}
                             onChange={(e) => setTgt({ ...tgt, schema: e.target.value })} />
                  <TextInput id="fl-tgt-table" labelText="Table" value={tgt.table} disabled={!canEdit}
                             onChange={(e) => setTgt({ ...tgt, table: e.target.value })} />
                </div>
                <Select label="Mode" value={tgt.mode} onChange={(v) => setTgt({ ...tgt, mode: v })} disabled={!canEdit}
                        options={[{ value: "replace", label: "Replace" }, { value: "truncate", label: "Truncate, then load" },
                                  { value: "append", label: "Append" }, { value: "upsert", label: "Upsert by key" }]} />
                {tgt.mode === "upsert" && (
                  <TextInput id="fl-tgt-keys" labelText="Key columns" value={tgt.keys} disabled={!canEdit}
                             onChange={(e) => setTgt({ ...tgt, keys: e.target.value })} />
                )}
              </>
            )}
            {draft && (
              <>
                <TextInput id="fl-step-label" labelText="Name" value={draft.label ?? ""} disabled={!canEdit}
                           onChange={(e) => setDraft({ ...draft, label: e.target.value || null })} />
                <Select label="Connection" value={String(cfgOf(draft).datasourceId ?? "")} disabled={!canEdit}
                        onChange={(v) => patchDraft("datasourceId", v || null)} options={dsOptions} />
                <div>
                  <div className="cds--label">{draft.kind === "assert" ? "Query returning the failing rows" : "SQL"}</div>
                  <SqlEditor value={String(cfgOf(draft).sql ?? "")} onChange={(v) => patchDraft("sql", v)} height={220}
                             readOnly={!canEdit} vars={["$YEAR4"]} />
                </div>
                {draft.kind === "assert" && (
                  <NumberInput id="fl-step-max" label="Failing rows allowed" min={0} hideSteppers disabled={!canEdit}
                               value={Number(cfgOf(draft).maxRows ?? 0)}
                               onChange={(_e, { value }) => patchDraft("maxRows", Number(value) || 0)} />
                )}
                <Select label="If it fails" value={draft.onFail} disabled={!canEdit}
                        onChange={(v) => setDraft({ ...draft, onFail: v as "stop" | "continue" })}
                        options={[{ value: "stop", label: "Stop the pipeline" }, { value: "continue", label: "Continue" }]} />
              </>
            )}
            {!isNew && (
              <section>
                <h4 className="cds--type-heading-compact-01" style={{ margin: "0 0 8px" }}>
                  Last log {current && <span className="cds--type-label-01 rh-dim">· run #{current.id}</span>}
                </h4>
                {logRec ? (
                  <>
                    <StructuredListWrapper isCondensed aria-label="Station result">
                      <StructuredListBody>
                        <StructuredListRow><StructuredListCell noWrap>Status</StructuredListCell><StructuredListCell>{logRec.status}</StructuredListCell></StructuredListRow>
                        <StructuredListRow><StructuredListCell noWrap>Started</StructuredListCell><StructuredListCell>{localTime(logRec.startedAt, true)}</StructuredListCell></StructuredListRow>
                        <StructuredListRow><StructuredListCell noWrap>Duration</StructuredListCell><StructuredListCell>{fmtDuration(durationOf(logRec.startedAt, logRec.finishedAt)) || "—"}</StructuredListCell></StructuredListRow>
                        <StructuredListRow><StructuredListCell noWrap>Rows in / out</StructuredListCell><StructuredListCell>{logRec.rowsRead ?? "—"} / {logRec.rowsWritten ?? "—"}</StructuredListCell></StructuredListRow>
                      </StructuredListBody>
                    </StructuredListWrapper>
                    {logRec.message && <pre className={ln.log}>{logRec.message}</pre>}
                  </>
                ) : (
                  <div className="cds--type-body-compact-01 rh-dim">{current ? current.message ?? "No record for this station in the selected run" : "Never run"}</div>
                )}
              </section>
            )}
          </div>
        </SlideOver>
      )}
    </div>
  );
}
