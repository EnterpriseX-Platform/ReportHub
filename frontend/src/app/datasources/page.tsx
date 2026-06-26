"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { MetricCard, MiniStat, DsDot, StatusChip } from "@/components/ui";
import { SlideOver, Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import type { Datasource, ReportSummary } from "@/lib/types";

export default function DatasourcesPage() {
  const [rows, setRows] = useState<Datasource[]>([]);
  const [sel, setSel] = useState<Datasource | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const toast = useToast();

  const reload = () => api.datasources().then(setRows).catch((e) => setErr((e as Error).message));
  useEffect(() => { reload(); }, []);

  // Real probe: backend measures the connection and persists status + latency.
  async function test(ds: Datasource) {
    setTesting(ds.id);
    try {
      const res = await api.testDatasource(ds.id);
      if (res.ok) toast(`${ds.name}: ${res.message}`, "ok");
      else toast(`${ds.name}: ${res.message}`, "error");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Test failed", "error");
    } finally {
      setTesting(null);
    }
  }

  if (err) {
    return <div className="card card-pad" style={{ maxWidth: 520 }}><b style={{ color: "var(--red)" }}>Cannot reach the backend</b><pre className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{err}</pre></div>;
  }

  const healthy = rows.filter((d) => d.status === "healthy").length;
  const degraded = rows.filter((d) => d.status === "degraded").length;
  const avgLat = rows.length ? Math.round(rows.reduce((s, d) => s + (d.latencyMs ?? 0), 0) / rows.length) : 0;

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Datasources</h1>
          <div className="page-sub">Database &amp; service connections used by the rendering gateway</div>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={16} />Add connection</button>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <MetricCard icon="datasource" label="Connections" value={rows.length} tone="accent" />
        <MetricCard icon="checkCircle" label="Healthy" value={healthy} tone="green" />
        <MetricCard icon="alert" label="Degraded" value={degraded} tone="amber" />
        <MetricCard icon="bolt" label="Avg latency" value={`${avgLat} ms`} tone="accent" />
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Connection</th><th>Engine</th><th>Host</th><th>Status</th>
              <th className="num">Latency</th><th className="num">Reports</th><th>Pool</th><th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((ds) => (
              <tr key={ds.id} style={{ cursor: "pointer" }} onClick={() => setSel(ds)}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 8, background: "var(--accent-weak)", color: "var(--accent)", display: "grid", placeItems: "center", flex: "none" }}>
                      <Icon name="datasource" size={15} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>{ds.name}</span>
                      <span style={{ display: "block", fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 }}>{ds.name}</span>
                    </span>
                  </div>
                </td>
                <td><span className="tag-pill">{ds.engine}</span></td>
                <td><span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{ds.host}</span></td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: ds.status === "healthy" ? "var(--green)" : ds.status === "degraded" ? "var(--amber)" : "var(--red)" }}>
                    <DsDot s={ds.status} pulse={ds.status === "degraded"} />{ds.status}
                  </span>
                </td>
                <td className="num"><span className="mono" style={{ fontSize: 11.5, color: (ds.latencyMs ?? 0) > 200 ? "var(--amber)" : "var(--ink)" }}>{ds.latencyMs} ms</span></td>
                <td className="num"><span className="mono" style={{ fontSize: 11.5 }}>{ds.reportCount}</span></td>
                <td><span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{ds.pool}</span></td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <Link className="btn sm ghost" title="Create a dataset that queries this connection" href={`/datasets?datasource=${encodeURIComponent(ds.id)}`}><Icon name="table" size={13} />New dataset</Link>
                    <button className="btn sm" onClick={() => test(ds)}>
                      {testing === ds.id ? <span className="spin" /> : <Icon name="bolt" size={14} />}Test
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8}><div className="empty">No connections yet</div></td></tr>}
          </tbody>
        </table>
      </div>

      {sel && <DsDetail ds={sel} onClose={() => setSel(null)} onTest={test} testing={testing === sel.id} />}
      {showAdd && <AddConnection onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reload(); }} />}
    </div>
  );
}

function AddConnection({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ id: "", name: "", engine: "PostgreSQL 16", host: "", schemaName: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.id || !f.name) { toast("id and name are required", "error"); return; }
    setBusy(true);
    try {
      await api.createDatasource(f);
      toast(`Added ${f.name}`, "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title="Add connection" width={480} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spin" /> : <Icon name="plus" size={15} />}Add</button></>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field"><label>ID</label><input className="input mono" value={f.id} onChange={(e) => set("id", e.target.value)} placeholder="ds-newdb" /></div>
        <div className="field"><label>Engine</label>
          <Select value={f.engine} onChange={(v) => set("engine", v)}
            options={["PostgreSQL 16", "PostgreSQL 15", "Oracle 19c", "MS SQL 2022", "MongoDB 7", "REST / SOAP"].map((x) => ({ value: x, label: x }))} /></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Name</label><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="New Warehouse" /></div>
        <div className="field"><label>Host</label><input className="input mono" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="db.example.com:5432" /></div>
        <div className="field"><label>Schema</label><input className="input mono" value={f.schemaName} onChange={(e) => set("schemaName", e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: ".4px", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 12.5, marginTop: 2 }}>{children}</div>
    </div>
  );
}

function DsDetail({ ds, onClose, onTest, testing }: { ds: Datasource; onClose: () => void; onTest: (d: Datasource) => void; testing: boolean }) {
  const [reps, setReps] = useState<ReportSummary[]>([]);
  useEffect(() => {
    api.reports({ datasource: ds.id, size: 200 }).then((p) => setReps(p.items)).catch(() => {});
  }, [ds.id]);

  return (
    <SlideOver
      title={ds.name}
      sub={`${ds.engine} · ${ds.name ?? ""}`}
      badge={<span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: ds.status === "healthy" ? "var(--green)" : ds.status === "degraded" ? "var(--amber)" : "var(--red)" }}><DsDot s={ds.status} />{ds.status}</span>}
      onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={() => onTest(ds)}>{testing ? <span className="spin" /> : <Icon name="bolt" size={15} />}Test connection</button></>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
        <MiniStat label="Latency" value={<span className="mono">{ds.latencyMs} ms</span>} />
        <MiniStat label="Pool usage" value={<span className="mono">{ds.pool}</span>} />
        <MiniStat label="Reports served" value={reps.length} />
        <MiniStat label="Dataset" value={<span style={{ fontSize: 12 }}>{ds.name}</span>} />
      </div>
      <div className="section-label">Connection</div>
      <div className="kv"><span className="k">Engine</span><span className="v">{ds.engine}</span></div>
      <div className="kv"><span className="k">Host</span><span className="v mono" style={{ fontSize: 11.5 }}>{ds.host}</span></div>
      <div className="kv"><span className="k">Schema</span><span className="v mono">{ds.schemaName}</span></div>
      <div className="kv"><span className="k">Pool</span><span className="v mono">{ds.pool}</span></div>
      <div className="divider" />
      <div className="section-label">Reports using this datasource ({reps.length})</div>
      {reps.length ? reps.map((r) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px dashed var(--line)" }}>
          <Icon name="registry" size={15} style={{ color: "var(--ink-4)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{r.code}</div>
          </div>
          <StatusChip s={r.status} />
        </div>
      )) : <div className="empty">No reports yet.</div>}
    </SlideOver>
  );
}
