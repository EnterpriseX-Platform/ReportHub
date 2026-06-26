"use client";

// Dataset builder: define a SELECT against a datasource, preview it, save it.
// Saved datasets feed the Ad-hoc builder and dashboard widgets.
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { DatasetDef, Datasource, TableResult } from "@/lib/types";

export default function DatasetsPage() {
  return (
    <Suspense fallback={<div className="empty"><span className="spin" /></div>}>
      <Datasets />
    </Suspense>
  );
}

function Datasets() {
  const search = useSearchParams();
  const toast = useToast();
  const [rows, setRows] = useState<DatasetDef[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [editing, setEditing] = useState<DatasetDef | null | "new">(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Retries twice before surfacing an inline error — a deploy/rollout can blip the API.
  const reload = useCallback((attempt = 0) => {
    setLoadErr(null);
    api.datasets().then(setRows).catch((e) => {
      if (attempt < 2) { setTimeout(() => reload(attempt + 1), 1500 * (attempt + 1)); return; }
      setLoadErr(e instanceof Error ? e.message : "Load failed");
    });
  }, []);
  useEffect(() => { reload(); api.datasources().then(setDss).catch(() => {}); }, [reload]);
  // bridge from /datasources: "New dataset" lands here with the connection preselected
  useEffect(() => {
    if (search.get("datasource")) setEditing("new");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(d: DatasetDef) {
    if (!window.confirm(`Delete dataset ${d.name}?`)) return;
    try { await api.deleteDataset(d.id); reload(); } catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Datasets</h1>
          <div className="page-sub">Define reusable datasets with a SQL editor — they power the Ad-hoc builder and dashboards</div>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" size={16} />New dataset</button>
        </div>
      </div>

      {loadErr && (
        <div className="card card-pad" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <Icon name="alert" size={18} style={{ color: "var(--red)" }} />
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 13 }}>Could not load datasets</b>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{loadErr} — the API may be restarting (deploy in progress)</div>
          </div>
          <button className="btn sm" onClick={() => reload()}><Icon name="refresh" size={13} />Retry</button>
        </div>
      )}

      {editing ? (
        <DatasetEditor original={editing === "new" ? null : editing} datasources={dss}
                       initialDatasourceId={search.get("datasource") ?? undefined}
                       onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Mode</th><th>Datasource</th><th>SQL</th><th>By</th><th style={{ width: 170 }} /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} style={{ cursor: "pointer" }} onClick={() => setEditing(d)}>
                  <td className="strong">{d.name}<div style={{ fontSize: 10.5, color: "var(--ink-4)", fontWeight: 400 }}>{d.description ?? ""}</div></td>
                  <td>
                    {d.captureMode === "captured"
                      ? <span className="chip green" style={{ height: 19 }} title={d.capturedAt ?? ""}>captured · {d.captureRows?.toLocaleString()} rows</span>
                      : <span className="chip blue" style={{ height: 19 }}>live</span>}
                    {d.captureMode === "captured" && <div style={{ fontSize: 9.5, color: "var(--ink-4)", marginTop: 2 }}>{d.capturedAt?.replace("T", " ").slice(0, 16)}</div>}
                  </td>
                  <td>{d.datasourceId ? <span className="chip blue" style={{ height: 19 }}>{d.datasourceId}</span> : <span className="tag-pill">internal warehouse</span>}</td>
                  <td><span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", maxWidth: 320, display: "inline-block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.sqlText}</span></td>
                  <td style={{ fontSize: 12 }}>{d.createdBy ?? "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <CaptureButton d={d} onChanged={reload} />
                      <Link className="btn sm ghost" title="Explore this dataset in the Ad-hoc Builder" href={`/adhoc?dataset=custom-${d.id}`} onClick={(e) => e.stopPropagation()}><Icon name="adhoc" size={13} /></Link>
                      <button className="btn sm ghost" onClick={() => setEditing(d)}><Icon name="edit" size={13} /></button>
                      <button className="btn sm ghost" onClick={() => remove(d)}><Icon name="x" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6}><div className="empty">No datasets yet — create one with the SQL editor</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Capture = materialize the source query into a local snapshot table (fast, offline from source). */
function CaptureButton({ d, onChanged }: { d: DatasetDef; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      if (d.captureMode === "captured") {
        await api.captureDataset(d.id);          // re-capture (refresh snapshot)
        toast(`Snapshot refreshed for ${d.name}`, "ok");
      } else {
        const res = await api.captureDataset(d.id);
        toast(`Captured ${res.captureRows?.toLocaleString()} rows from the source`, "ok");
      }
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Capture failed", "error");
    } finally { setBusy(false); }
  }
  async function revert() {
    try { await api.uncaptureDataset(d.id); toast("Back to live mode", "ok"); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
  }
  return (
    <>
      <button className="btn sm" disabled={busy} title={d.captureMode === "captured" ? "Refresh snapshot from source" : "Capture: snapshot the query result into the warehouse"} onClick={run}>
        {busy ? <span className="spin" /> : <Icon name="bolt" size={13} />}{d.captureMode === "captured" ? "Refresh" : "Capture"}
      </button>
      {d.captureMode === "captured" && (
        <button className="btn sm ghost" title="Drop snapshot, query live again" onClick={revert}><Icon name="refresh" size={13} /></button>
      )}
    </>
  );
}

function DatasetEditor({ original, datasources, initialDatasourceId, onClose, onSaved }: {
  original: DatasetDef | null; datasources: Datasource[]; initialDatasourceId?: string; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [datasourceId, setDatasourceId] = useState(original?.datasourceId ?? initialDatasourceId ?? "");
  const [sql, setSql] = useState(original?.sqlText ?? "SELECT region, fiscal_year, target, sales, profit\nFROM fact");
  const [preview, setPreview] = useState<TableResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);

  async function runPreview() {
    setRunning(true);
    try {
      const res = await api.previewDataset({ datasourceId: datasourceId || null, sql });
      setPreview(res);
      toast(`Preview OK · ${res.rowCount} rows`, "ok");
    } catch (e) {
      setPreview(null);
      toast(e instanceof Error ? e.message : "Preview failed", "error");
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, datasourceId: datasourceId || null, sqlText: sql };
      if (original) await api.updateDataset(original.id, body);
      else await api.createDataset(body);
      toast("Dataset saved", "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
      setSaving(false);
    }
  }

  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <b style={{ fontSize: 14 }}>{original ? `Edit dataset · ${original.name}` : "New dataset"}</b>
        <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={onClose}><Icon name="x" size={14} />Close</button>
      </div>
      <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div className="field"><label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Records by region" /></div>
        <div className="field"><label>Description</label>
          <input className="input" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="field"><label>Datasource</label>
          <Select value={datasourceId} onChange={setDatasourceId} placeholder="Internal warehouse"
                  options={[{ value: "", label: "Internal warehouse (SIT Postgres)" },
                            ...datasources.map((d) => ({ value: d.id, label: `${d.name}${d.hasJdbc ? " · live JDBC" : ""}` }))]} />
        </div>
      </div>
      <div className="field">
        <label style={{ display: "flex", alignItems: "center" }}>SQL query (SELECT only)
          <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>single statement · preview limited to 200 rows</span></label>
        <textarea className="input mono" style={{ height: 160, paddingTop: 10, resize: "vertical", fontSize: 12.5, lineHeight: 1.7, tabSize: 2 }}
                  value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" disabled={running} onClick={runPreview}>{running ? <span className="spin" /> : <Icon name="play" size={15} />}Preview</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? <span className="spin" /> : <Icon name="check" size={15} />}Save dataset</button>
      </div>

      {preview && (
        <div className="card" style={{ boxShadow: "none", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 13px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
            <Icon name="table" size={14} style={{ color: "var(--ink-3)" }} /><b>Preview</b>
            <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>{preview.rowCount} rows · {preview.columns.length} columns</span>
          </div>
          <div style={{ overflow: "auto", maxHeight: 320 }}>
            <table className="tbl">
              <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i} style={{ cursor: "default" }}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "num mono" : ""} style={{ fontSize: 12 }}>{v === null ? "—" : String(v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
