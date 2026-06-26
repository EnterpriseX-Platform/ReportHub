"use client";

// Data Warehouse (pull data from a real source into a target): define a pipeline that reads a source SELECT (with
// conditions) from any datasource and loads it into a target table — Replace / Append / Upsert by
// key, target auto-created from the result schema. Run manually or on a cron, with run history.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { Datasource, LoadMode, WarehousePipeline, WarehouseRun } from "@/lib/types";

const CRON_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Manual only (no schedule)" },
  { value: "0 */15 * * * *", label: "Every 15 minutes" },
  { value: "0 0 * * * *", label: "Hourly (on the hour)" },
  { value: "0 0 2 * * *", label: "Daily at 02:00" },
  { value: "0 30 5 * * *", label: "Daily at 05:30" },
  { value: "0 0 2 * * MON", label: "Weekly · Monday 02:00" },
  { value: "0 0 1 1 * *", label: "Monthly · 1st at 01:00" },
];
const MODES: { value: LoadMode; label: string; hint: string }[] = [
  { value: "replace", label: "Replace", hint: "clear the target then insert all rows" },
  { value: "append", label: "Append", hint: "insert rows, keep what's there" },
  { value: "upsert", label: "Upsert by key", hint: "clear matching keys then insert (merge)" },
];

function fmt(ts: string | null | undefined): string {
  return ts ? ts.replace("T", " ").slice(0, 16) : "—";
}
function dsLabel(id: string | null, dss: Datasource[]): string {
  return id ? (dss.find((d) => d.id === id)?.name ?? id) : "internal warehouse";
}

export default function WarehousePage() {
  const toast = useToast();
  const [rows, setRows] = useState<WarehousePipeline[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [editing, setEditing] = useState<WarehousePipeline | "new" | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadErr(null);
    api.warehousePipelines().then(setRows).catch((e) => setLoadErr(e instanceof Error ? e.message : "Load failed"));
  }, []);
  useEffect(() => { reload(); api.datasources().then(setDss).catch(() => {}); }, [reload]);

  async function toggle(p: WarehousePipeline) {
    try { await api.toggleWarehousePipeline(p.id, !p.enabled); toast(p.enabled ? "Disabled" : "Enabled", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
  }
  async function runNow(p: WarehousePipeline) {
    toast("Running…", "ok");
    try {
      const r = await api.runWarehousePipeline(p.id);
      toast(r.status === "ok" ? `Loaded · ${r.rowsRead}→${r.rowsWritten} rows` : `Error: ${r.message}`, r.status === "ok" ? "ok" : "error");
      reload(); if (expanded === p.id) setExpanded(null);
    } catch (e) { toast(e instanceof Error ? e.message : "Run failed", "error"); }
  }
  async function remove(p: WarehousePipeline) {
    if (!window.confirm(`Delete pipeline "${p.name}"?`)) return;
    try { await api.deleteWarehousePipeline(p.id); toast("Deleted", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Data Warehouse</h1>
          <div className="page-sub">Pull data from a source datasource into a warehouse table — on conditions, on a schedule</div>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" size={16} />New pipeline</button>
        </div>
      </div>

      {loadErr && <div className="card card-pad" style={{ marginBottom: 14, color: "var(--red)", fontSize: 13 }}>{loadErr}</div>}

      {editing ? (
        <PipelineEditor original={editing === "new" ? null : editing} datasources={dss} toast={toast}
                        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 36 }} /><th>Name</th><th>Source → Target</th><th>Mode</th>
              <th>Schedule</th><th>Last run</th><th>Next run</th><th style={{ width: 200 }} />
            </tr></thead>
            <tbody>
              {rows.map((p) => (
                <PipelineRows key={p.id} p={p} dss={dss} expanded={expanded === p.id}
                              onExpand={() => setExpanded(expanded === p.id ? null : p.id)}
                              onToggle={() => toggle(p)} onRun={() => runNow(p)}
                              onEdit={() => setEditing(p)} onDelete={() => remove(p)} />
              ))}
              {rows.length === 0 && <tr><td colSpan={8}><div className="empty">No pipelines yet — create one to load data from a source into the warehouse</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PipelineRows({ p, dss, expanded, onExpand, onToggle, onRun, onEdit, onDelete }: {
  p: WarehousePipeline; dss: Datasource[]; expanded: boolean; onExpand: () => void;
  onToggle: () => void; onRun: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const preset = CRON_PRESETS.find((c) => c.value === (p.cron ?? ""));
  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={onExpand}>
        <td onClick={(e) => e.stopPropagation()}>
          <button onClick={onToggle} title={p.enabled ? "Enabled — click to pause" : "Disabled — click to enable"}
                  style={{ width: 34, height: 19, borderRadius: 12, border: "none", cursor: "pointer", position: "relative",
                           background: p.enabled ? "var(--green)" : "var(--line-strong, var(--line))" }}>
            <span style={{ position: "absolute", top: 2, left: p.enabled ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
          </button>
        </td>
        <td className="strong">{p.name}<div style={{ fontSize: 10.5, color: "var(--ink-4)", fontWeight: 400 }}>{p.description ?? ""}</div></td>
        <td style={{ fontSize: 12 }}>
          <span className="chip blue" style={{ height: 19 }}>{dsLabel(p.sourceDatasourceId, dss)}</span>
          <Icon name="arrowRight" size={12} style={{ margin: "0 5px", verticalAlign: "middle", color: "var(--ink-4)" }} />
          <span className="chip" style={{ height: 19 }}>{dsLabel(p.targetDatasourceId, dss)}<b style={{ marginLeft: 4 }}>.{p.targetTable}</b></span>
        </td>
        <td><span className="chip" style={{ height: 19, textTransform: "capitalize" }}>{p.loadMode}</span>{p.loadMode === "upsert" && p.keyColumns && <div style={{ fontSize: 10, color: "var(--ink-4)" }}>key: {p.keyColumns}</div>}</td>
        <td>{p.cron ? <><span className="mono" style={{ fontSize: 11 }}>{p.cron}</span><div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{preset?.label ?? "custom"}</div></> : <span style={{ color: "var(--ink-4)", fontSize: 12 }}>manual</span>}</td>
        <td>
          {p.lastStatus === "ok" && <span className="chip green" style={{ height: 19 }}>ok · {p.lastRowsRead}→{p.lastRowsWritten}</span>}
          {p.lastStatus === "error" && <span className="chip red" style={{ height: 19 }} title={p.lastError ?? ""}>error</span>}
          {!p.lastStatus && <span style={{ color: "var(--ink-4)", fontSize: 12 }}>never</span>}
          <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{fmt(p.lastRunAt)}</div>
        </td>
        <td style={{ fontSize: 12 }}>{!p.cron ? <span style={{ color: "var(--ink-4)" }}>—</span> : p.enabled ? fmt(p.nextRunAt) : <span style={{ color: "var(--ink-4)" }}>paused</span>}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button className="btn sm" title="Run now" onClick={onRun}><Icon name="bolt" size={13} />Run</button>
            <button className="btn sm ghost" title="History" onClick={onExpand}><Icon name="history" size={13} /></button>
            <button className="btn sm ghost" onClick={onEdit}><Icon name="edit" size={13} /></button>
            <button className="btn sm ghost" onClick={onDelete}><Icon name="x" size={13} /></button>
          </div>
        </td>
      </tr>
      {expanded && <tr><td colSpan={8} style={{ padding: 0, background: "var(--surface-2)" }}><RunHistory pipelineId={p.id} /></td></tr>}
    </>
  );
}

function RunHistory({ pipelineId }: { pipelineId: number }) {
  const [runs, setRuns] = useState<WarehouseRun[] | null>(null);
  useEffect(() => { api.warehouseRuns(pipelineId).then(setRuns).catch(() => setRuns([])); }, [pipelineId]);
  if (!runs) return <div className="empty" style={{ padding: 18 }}><span className="spin" /></div>;
  if (runs.length === 0) return <div className="empty" style={{ padding: 16, fontSize: 12 }}>No runs yet</div>;
  return (
    <div style={{ padding: "8px 14px" }}>
      <table className="tbl" style={{ background: "transparent" }}>
        <thead><tr><th>When</th><th>Trigger</th><th>Status</th><th>Read</th><th>Written</th><th>Message</th><th>By</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} style={{ cursor: "default" }}>
              <td style={{ fontSize: 12 }}>{fmt(r.startedAt)}</td>
              <td><span className="chip" style={{ height: 18 }}>{r.trigger}</span></td>
              <td>{r.status === "ok" ? <span className="chip green" style={{ height: 18 }}>ok</span> : <span className="chip red" style={{ height: 18 }}>error</span>}</td>
              <td className="num mono" style={{ fontSize: 12 }}>{r.rowsRead ?? "—"}</td>
              <td className="num mono" style={{ fontSize: 12 }}>{r.rowsWritten ?? "—"}</td>
              <td style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 380, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.message ?? ""}>{r.message ?? ""}</td>
              <td style={{ fontSize: 12 }}>{r.runBy ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PipelineEditor({ original, datasources, toast, onClose, onSaved }: {
  original: WarehousePipeline | null; datasources: Datasource[]; toast: ReturnType<typeof useToast>;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [sourceDatasourceId, setSourceDatasourceId] = useState(original?.sourceDatasourceId ?? "");
  const [sourceSql, setSourceSql] = useState(original?.sourceSql ?? "");
  const [targetDatasourceId, setTargetDatasourceId] = useState(original?.targetDatasourceId ?? "");
  const [targetTable, setTargetTable] = useState(original?.targetTable ?? "");
  const [loadMode, setLoadMode] = useState<LoadMode>(original?.loadMode ?? "replace");
  const [keyColumns, setKeyColumns] = useState(original?.keyColumns ?? "");
  const [autoCreate, setAutoCreate] = useState(original?.autoCreate ?? true);
  const [cron, setCron] = useState(original?.cron ?? "");
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const presetValue = CRON_PRESETS.some((c) => c.value === cron) ? cron : "__custom";
  const dsOptions = [{ value: "", label: "Internal warehouse (SIT Postgres)" },
                     ...datasources.map((d) => ({ value: d.id, label: `${d.name}${d.hasJdbc ? " · live JDBC" : ""}` }))];

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    if (!sourceSql.trim()) { toast("Source SQL is required", "error"); return; }
    if (!targetTable.trim()) { toast("Target table is required", "error"); return; }
    if (loadMode === "upsert" && !keyColumns.trim()) { toast("Upsert needs key column(s)", "error"); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, sourceDatasourceId: sourceDatasourceId || null, sourceSql,
        targetDatasourceId: targetDatasourceId || null, targetTable: targetTable.trim(), loadMode,
        keyColumns: keyColumns || null, autoCreate, cron: cron || null, enabled };
      if (original) await api.updateWarehousePipeline(original.id, body);
      else await api.createWarehousePipeline(body);
      toast("Pipeline saved", "ok");
      onSaved();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); setSaving(false); }
  }

  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <b style={{ fontSize: 14 }}>{original ? `Edit pipeline · ${original.name}` : "New pipeline"}</b>
        <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={onClose}><Icon name="x" size={14} />Close</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field"><label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="external system → BIS staging" /></div>
        <div className="field"><label>Description</label>
          <input className="input" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>

      {/* Source */}
      <div className="card" style={{ boxShadow: "none", padding: 12, background: "var(--surface-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
          <Icon name="datasource" size={15} style={{ color: "var(--accent)" }} /><b style={{ fontSize: 12.5 }}>Source</b>
        </div>
        <div className="field" style={{ marginBottom: 10 }}><label>Source datasource</label>
          <Select value={sourceDatasourceId} onChange={setSourceDatasourceId} placeholder="Internal warehouse" options={dsOptions} /></div>
        <div className="field">
          <label style={{ display: "flex" }}>Source query (SELECT only — conditions go in WHERE)
            <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>columns must be named (use AS for expressions)</span></label>
          <textarea className="input mono" style={{ height: 150, paddingTop: 10, resize: "vertical", fontSize: 12.5, lineHeight: 1.7, tabSize: 2 }}
                    value={sourceSql} onChange={(e) => setSourceSql(e.target.value)} spellCheck={false}
                    placeholder={"SELECT id, code, amount, updated_date\nFROM source_table\nWHERE fiscal_year = 2025"} />
        </div>
      </div>

      {/* Target */}
      <div className="card" style={{ boxShadow: "none", padding: 12, background: "var(--surface-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
          <Icon name="store" size={15} style={{ color: "var(--accent)" }} /><b style={{ fontSize: 12.5 }}>Target</b>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field"><label>Target datasource</label>
            <Select value={targetDatasourceId} onChange={setTargetDatasourceId} placeholder="Internal warehouse" options={dsOptions} /></div>
          <div className="field"><label>Target table</label>
            <input className="input mono" value={targetTable} onChange={(e) => setTargetTable(e.target.value)} placeholder="staging_to_warehouse" /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: loadMode === "upsert" ? "1fr 1fr" : "1fr", gap: 12, marginTop: 10, alignItems: "end" }}>
          <div className="field"><label>Load mode</label>
            <Select value={loadMode} onChange={(v) => setLoadMode(v as LoadMode)}
                    options={MODES.map((m) => ({ value: m.value, label: `${m.label} — ${m.hint}` }))} /></div>
          {loadMode === "upsert" && (
            <div className="field"><label>Key column(s) — comma separated</label>
              <input className="input mono" value={keyColumns ?? ""} onChange={(e) => setKeyColumns(e.target.value)} placeholder="id  or  fiscal_year,code" /></div>
          )}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, cursor: "pointer", marginTop: 10 }}>
          <input type="checkbox" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} />
          Auto-create the target table from the query result if it doesn&apos;t exist
        </label>
      </div>

      {/* Schedule */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
        <div className="field"><label>Schedule</label>
          <Select value={presetValue === "__custom" ? "" : presetValue} onChange={setCron} placeholder="Manual only"
                  options={CRON_PRESETS} /></div>
        <div className="field"><label style={{ display: "flex" }}>Cron (optional — blank = manual only)
          <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>sec min hour day month weekday</span></label>
          <input className="input mono" value={cron ?? ""} onChange={(e) => setCron(e.target.value)} placeholder="(manual)" /></div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (run automatically when scheduled)
        </label>
        <div style={{ marginLeft: "auto" }}>
          <button className="btn primary" disabled={saving} onClick={save}>{saving ? <span className="spin" /> : <Icon name="check" size={15} />}Save pipeline</button>
        </div>
      </div>
    </div>
  );
}
