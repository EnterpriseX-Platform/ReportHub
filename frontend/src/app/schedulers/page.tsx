"use client";

// Schedulers: run an INSERT/UPDATE/DELETE/MERGE against a datasource on a cron
// schedule. Enable/disable, run manually, and see the success/error history of each run.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { Datasource, Scheduler, SchedulerRun } from "@/lib/types";

const CRON_PRESETS: { value: string; label: string }[] = [
  { value: "0 */5 * * * *", label: "Every 5 minutes" },
  { value: "0 */15 * * * *", label: "Every 15 minutes" },
  { value: "0 0 * * * *", label: "Hourly (on the hour)" },
  { value: "0 0 2 * * *", label: "Daily at 02:00" },
  { value: "0 0 6 * * *", label: "Daily at 06:00" },
  { value: "0 30 0 * * *", label: "Daily at 00:30" },
  { value: "0 0 2 * * MON", label: "Weekly · Monday 02:00" },
  { value: "0 0 1 1 * *", label: "Monthly · 1st at 01:00" },
];

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  return ts.replace("T", " ").slice(0, 16);
}

export default function SchedulersPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Scheduler[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [editing, setEditing] = useState<Scheduler | "new" | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadErr(null);
    api.schedulers().then(setRows).catch((e) => setLoadErr(e instanceof Error ? e.message : "Load failed"));
  }, []);
  useEffect(() => { reload(); api.datasources().then(setDss).catch(() => {}); }, [reload]);

  async function toggle(s: Scheduler) {
    try { await api.toggleScheduler(s.id, !s.enabled); toast(s.enabled ? "Disabled" : "Enabled", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
  }
  async function runNow(s: Scheduler) {
    try { const r = await api.runScheduler(s.id); toast(r.status === "ok" ? `Ran · ${r.affected} row(s)` : `Error: ${r.message}`, r.status === "ok" ? "ok" : "error"); reload(); if (expanded === s.id) setExpanded(null); }
    catch (e) { toast(e instanceof Error ? e.message : "Run failed", "error"); }
  }
  async function remove(s: Scheduler) {
    if (!window.confirm(`Delete scheduler "${s.name}"?`)) return;
    try { await api.deleteScheduler(s.id); toast("Deleted", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Schedulers</h1>
          <div className="page-sub">Run INSERT/UPDATE/DELETE on a schedule — build data into a table automatically</div>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" size={16} />New scheduler</button>
        </div>
      </div>

      {loadErr && <div className="card card-pad" style={{ marginBottom: 14, color: "var(--red)", fontSize: 13 }}>{loadErr}</div>}

      {editing ? (
        <SchedulerEditor original={editing === "new" ? null : editing} datasources={dss} toast={toast}
                         onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 36 }} /><th>Name</th><th>Datasource</th><th>Schedule</th>
              <th>Last run</th><th>Next run</th><th style={{ width: 200 }} />
            </tr></thead>
            <tbody>
              {rows.map((s) => (
                <ScheduleRows key={s.id} s={s} dss={dss} expanded={expanded === s.id}
                              onExpand={() => setExpanded(expanded === s.id ? null : s.id)}
                              onToggle={() => toggle(s)} onRun={() => runNow(s)}
                              onEdit={() => setEditing(s)} onDelete={() => remove(s)} />
              ))}
              {rows.length === 0 && <tr><td colSpan={7}><div className="empty">No schedulers yet — create one to run SQL on a timer</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScheduleRows({ s, dss, expanded, onExpand, onToggle, onRun, onEdit, onDelete }: {
  s: Scheduler; dss: Datasource[]; expanded: boolean; onExpand: () => void;
  onToggle: () => void; onRun: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const dsName = s.datasourceId ? (dss.find((d) => d.id === s.datasourceId)?.name ?? s.datasourceId) : "Internal warehouse";
  const preset = CRON_PRESETS.find((p) => p.value === s.cron);
  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={onExpand}>
        <td onClick={(e) => e.stopPropagation()}>
          <button className={"toggle" + (s.enabled ? " on" : "")} onClick={onToggle} title={s.enabled ? "Enabled — click to pause" : "Disabled — click to enable"}
                  style={{ width: 34, height: 19, borderRadius: 12, border: "none", cursor: "pointer", position: "relative",
                           background: s.enabled ? "var(--green)" : "var(--line-strong, var(--line))" }}>
            <span style={{ position: "absolute", top: 2, left: s.enabled ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
          </button>
        </td>
        <td className="strong">{s.name}<div style={{ fontSize: 10.5, color: "var(--ink-4)", fontWeight: 400 }}>{s.description ?? ""}</div></td>
        <td>{s.datasourceId ? <span className="chip blue" style={{ height: 19 }}>{dsName}</span> : <span className="tag-pill">internal warehouse</span>}</td>
        <td><span className="mono" style={{ fontSize: 11.5 }}>{s.cron}</span><div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{preset?.label ?? "custom"}</div></td>
        <td>
          {s.lastStatus === "ok" && <span className="chip green" style={{ height: 19 }}>ok{s.lastAffected != null ? ` · ${s.lastAffected}` : ""}</span>}
          {s.lastStatus === "error" && <span className="chip red" style={{ height: 19 }} title={s.lastError ?? ""}>error</span>}
          {!s.lastStatus && <span style={{ color: "var(--ink-4)", fontSize: 12 }}>never</span>}
          <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{fmt(s.lastRunAt)}</div>
        </td>
        <td style={{ fontSize: 12 }}>{s.enabled ? fmt(s.nextRunAt) : <span style={{ color: "var(--ink-4)" }}>paused</span>}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button className="btn sm" title="Run now" onClick={onRun}><Icon name="play" size={13} />Run</button>
            <button className="btn sm ghost" title="History" onClick={onExpand}><Icon name="history" size={13} /></button>
            <button className="btn sm ghost" onClick={onEdit}><Icon name="edit" size={13} /></button>
            <button className="btn sm ghost" onClick={onDelete}><Icon name="x" size={13} /></button>
          </div>
        </td>
      </tr>
      {expanded && <tr><td colSpan={7} style={{ padding: 0, background: "var(--surface-2)" }}><RunHistory schedulerId={s.id} /></td></tr>}
    </>
  );
}

function RunHistory({ schedulerId }: { schedulerId: number }) {
  const [runs, setRuns] = useState<SchedulerRun[] | null>(null);
  useEffect(() => { api.schedulerRuns(schedulerId).then(setRuns).catch(() => setRuns([])); }, [schedulerId]);
  if (!runs) return <div className="empty" style={{ padding: 18 }}><span className="spin" /></div>;
  if (runs.length === 0) return <div className="empty" style={{ padding: 16, fontSize: 12 }}>No runs yet</div>;
  return (
    <div style={{ padding: "8px 14px" }}>
      <table className="tbl" style={{ background: "transparent" }}>
        <thead><tr><th>When</th><th>Trigger</th><th>Status</th><th>Rows</th><th>Message</th><th>By</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} style={{ cursor: "default" }}>
              <td style={{ fontSize: 12 }}>{fmt(r.startedAt)}</td>
              <td><span className="chip" style={{ height: 18 }}>{r.trigger}</span></td>
              <td>{r.status === "ok" ? <span className="chip green" style={{ height: 18 }}>ok</span> : <span className="chip red" style={{ height: 18 }}>error</span>}</td>
              <td className="num mono" style={{ fontSize: 12 }}>{r.affected ?? "—"}</td>
              <td style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 420, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.message ?? ""}>{r.message ?? ""}</td>
              <td style={{ fontSize: 12 }}>{r.runBy ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchedulerEditor({ original, datasources, toast, onClose, onSaved }: {
  original: Scheduler | null; datasources: Datasource[]; toast: ReturnType<typeof useToast>;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [datasourceId, setDatasourceId] = useState(original?.datasourceId ?? "");
  const [sql, setSql] = useState(original?.sqlText ?? "");
  const [cron, setCron] = useState(original?.cron ?? "0 0 2 * * *");
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const presetValue = CRON_PRESETS.some((p) => p.value === cron) ? cron : "";

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    if (!sql.trim()) { toast("SQL is required", "error"); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, datasourceId: datasourceId || null, sqlText: sql, cron: cron.trim(), enabled };
      if (original) await api.updateScheduler(original.id, body);
      else await api.createScheduler(body);
      toast("Scheduler saved", "ok");
      onSaved();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); setSaving(false); }
  }

  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <b style={{ fontSize: 14 }}>{original ? `Edit scheduler · ${original.name}` : "New scheduler"}</b>
        <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={onClose}><Icon name="x" size={14} />Close</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div className="field"><label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Build external system staging" /></div>
        <div className="field"><label>Description</label>
          <input className="input" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="field"><label>Target datasource</label>
          <Select value={datasourceId} onChange={setDatasourceId} placeholder="Internal warehouse"
                  options={[{ value: "", label: "Internal warehouse (SIT Postgres)" },
                            ...datasources.map((d) => ({ value: d.id, label: `${d.name}${d.hasJdbc ? " · live JDBC" : ""}` }))]} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
        <div className="field"><label>Schedule (preset)</label>
          <Select value={presetValue} onChange={setCron} placeholder="Custom — type a cron below"
                  options={[{ value: "", label: "Custom (type a cron below)" }, ...CRON_PRESETS]} />
        </div>
        <div className="field"><label style={{ display: "flex" }}>Cron expression
          <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>sec min hour day month weekday</span></label>
          <input className="input mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 0 2 * * *" /></div>
      </div>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center" }}>SQL statement (INSERT / UPDATE / DELETE / MERGE)
          <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>single statement · runs against the target datasource</span></label>
        <textarea className="input mono" style={{ height: 170, paddingTop: 10, resize: "vertical", fontSize: 12.5, lineHeight: 1.7, tabSize: 2 }}
                  value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false}
                  placeholder={"INSERT INTO staging_to_warehouse (...)\nSELECT ... FROM ..."} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (run automatically on schedule)
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn primary" disabled={saving} onClick={save}>{saving ? <span className="spin" /> : <Icon name="check" size={15} />}Save scheduler</button>
        </div>
      </div>
    </div>
  );
}
