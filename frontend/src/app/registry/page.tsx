"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { EngineBadge, StatusChip, Fmts, DsDot } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { ReportDetail } from "@/components/registry/ReportDetail";
import { RegisterWizard } from "@/components/registry/RegisterWizard";
import { ImportConfigModal } from "@/components/registry/ImportConfigModal";
import { Modal } from "@/components/overlays";
import { api } from "@/lib/api";
import { ENGINES, STATUS } from "@/lib/model";
import { fmtMs } from "@/lib/format";
import type { Category, Datasource, ReportSummary } from "@/lib/types";

const STATUS_OPTS = ["all", "active", "testing", "draft", "error"];
const ENGINE_OPTS = ["all", "jasper", "api", "sql", "composite"];

export default function RegistryPage() {
  const toast = useToast();
  const [categories, setCategories] = useState<Category[]>([]);
  const [datasources, setDatasources] = useState<Datasource[]>([]);
  const [rows, setRows] = useState<ReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [cat, setCat] = useState("all");
  const [status, setStatus] = useState("all");
  const [engine, setEngine] = useState("all");
  const [q, setQ] = useState("");

  const [selCode, setSelCode] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [importer, setImporter] = useState(false);
  const [delCode, setDelCode] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const dsById = useMemo(() => Object.fromEntries(datasources.map((d) => [d.id, d])), [datasources]);

  const loadMeta = useCallback(() => {
    Promise.all([api.categories(), api.datasources()])
      .then(([c, d]) => { setCategories(c); setDatasources(d); })
      .catch(() => {});
  }, []);

  const loadReports = useCallback(() => {
    setLoading(true);
    const t = setTimeout(() => {
      api.reports({
        category: cat === "all" ? undefined : cat,
        status: status === "all" ? undefined : status,
        engine: engine === "all" ? undefined : engine,
        q: q || undefined,
        size: 200,
      })
        .then((p) => { setRows(p.items); setTotal(p.total); })
        .catch((e) => toast((e as Error).message, "error"))
        .finally(() => setLoading(false));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [cat, status, engine, q, toast]);

  useEffect(loadMeta, [loadMeta]);
  useEffect(loadReports, [loadReports]);

  const totalRegistered = categories.reduce((s, c) => s + c.registered, 0);
  const totalMin = categories.reduce((s, c) => s + c.min, 0);

  function onCreated(code: string, msg: string) {
    setWizard(false);
    setImporter(false);
    toast(msg, "ok");
    loadMeta();
    loadReports();
    setSelCode(code);
  }

  async function doDelete() {
    if (!delCode || deleting) return;
    setDeleting(true);
    try {
      await api.deleteReport(delCode);
      toast(`Report  deleted`, "ok");
      if (selCode === delCode) setSelCode(null);
      setDelCode(null);
      loadMeta();
      loadReports();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Report Registry</h1>
          <div className="page-sub">{totalRegistered} registered · {datasources.length} datasources</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setImporter(true)}><Icon name="upload" size={16} />Import config</button>
          <button className="btn primary" onClick={() => setWizard(true)}><Icon name="plus" size={16} />Register report</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "236px 1fr", gap: 16, alignItems: "start" }}>
        {/* category rail */}
        <div className="card" style={{ position: "sticky", top: 0 }}>
          <div className="card-pad" style={{ padding: 12 }}>
            <div className="section-label" style={{ margin: "4px 8px 8px" }}>Categories</div>
            <CatRow label="All reports" ref_="—" count={totalRegistered} active={cat === "all"} onClick={() => setCat("all")} />
            {categories.map((c) => (
              <CatRow key={c.id} label={c.name} ref_={c.ref} th={c.name} count={c.registered} min={c.min}
                active={cat === c.id} onClick={() => setCat(c.id)} />
            ))}
          </div>
        </div>

        {/* table */}
        <div className="card">
          <div className="card-head" style={{ gap: 10, flexWrap: "wrap" }}>
            <div className="search" style={{ width: 240, height: 34 }}>
              <Icon name="search" size={15} /><input placeholder="Search name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="seg">
              {STATUS_OPTS.map((s) => (
                <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{s === "all" ? "All" : STATUS[s].label}</button>
              ))}
            </div>
            <div className="seg">
              {ENGINE_OPTS.map((s) => (
                <button key={s} className={engine === s ? "on" : ""} onClick={() => setEngine(s)}>{s === "all" ? "Engine" : ENGINES[s].label}</button>
              ))}
            </div>
            <div style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-3)" }}>{loading ? "…" : `${total} shown`}</div>
          </div>
          <div style={{ maxHeight: "calc(100vh - 250px)", overflow: "auto" }}>
            <table className="tbl">
              <thead><tr><th>Report</th><th>Code</th><th>Engine</th><th>Format</th><th>Status</th><th>Datasource</th><th className="num">Avg</th><th>Ver</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const ds = r.datasourceId ? dsById[r.datasourceId] : undefined;
                  return (
                    <tr key={r.id} className={selCode === r.code ? "sel" : ""} onClick={() => setSelCode(r.code)}>
                      <td className="strong" style={{ maxWidth: 320 }}>
                        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                      </td>
                      <td className="mono">{r.code}</td>
                      <td><EngineBadge engine={r.engine} sm /></td>
                      <td><Fmts list={r.formats} /></td>
                      <td><StatusChip s={r.status} pulse={r.status === "testing"} /></td>
                      <td><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{ds && <DsDot s={ds.status} />}{r.datasourceName ?? "—"}</span></td>
                      <td className="num">{fmtMs(r.avgMs)}</td>
                      <td className="mono" style={{ color: "var(--ink-3)" }}>{r.version}</td>
                      <td style={{ width: 56 }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                          <button className="btn sm ghost" title="Delete report" aria-label={`Delete report `}
                                  style={{ color: "var(--red)" }} onClick={() => setDelCode(r.code)}>
                            <Icon name="x" size={14} />
                          </button>
                          <Icon name="chevron" size={15} style={{ color: "var(--ink-4)" }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && rows.length === 0 && <tr><td colSpan={9}><div className="empty">No reports match these filters.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {delCode && (
        <Modal
          title="Delete report"
          sub={`Report `}
          width={460}
          onClose={() => { if (!deleting) setDelCode(null); }}
          foot={<>
            <button className="btn" onClick={() => setDelCode(null)} disabled={deleting}>Cancel</button>
            <button className="btn primary" style={{ background: "var(--red)", borderColor: "var(--red)" }}
                    onClick={doDelete} disabled={deleting}>
              {deleting ? <span className="spin" /> : <Icon name="x" size={15} />}Delete report
            </button>
          </>}
        >
          <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--ink-2)" }}>
            Delete report <b className="mono">{delCode}</b>?
            <div style={{ marginTop: 10, display: "flex", gap: 9, alignItems: "flex-start", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px" }}>
              <Icon name="alert" size={16} style={{ color: "var(--amber)", flex: "none", marginTop: 1 }} />
              <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                This deletes the report along with its template, parameters, versions and all generated output files. This cannot be undone.
              </span>
            </div>
          </div>
        </Modal>
      )}
      {selCode && <ReportDetail code={selCode} onClose={() => setSelCode(null)} />}
      {wizard && <RegisterWizard categories={categories} datasources={datasources} onClose={() => setWizard(false)} onCreated={(r) => onCreated(r.code, `Report ${r.code} registered as draft`)} />}
      {importer && <ImportConfigModal onClose={() => setImporter(false)} onImported={(r) => onCreated(r.code, `Imported ${r.code}`)} />}
    </div>
  );
}

function CatRow({ label, ref_, th, count, min, active, onClick }: {
  label: string; ref_: string; th?: string; count: number; min?: number; active: boolean; onClick: () => void;
}) {
  const warn = min != null && count < min;
  return (
    <div
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", borderRadius: 8, cursor: "pointer", background: active ? "var(--accent-weak)" : "transparent", color: active ? "var(--accent)" : "var(--ink-2)", marginBottom: 1 }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-3)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
        {th && <div style={{ fontSize: 10.5, color: "var(--ink-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{th}</div>}
      </div>
      <span title={min != null ? `${count} registered of ${min} required by clause ${ref_}` : `${count} registered`}
            style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", color: warn ? "var(--amber)" : "var(--ink-4)", fontWeight: 600 }}>{count}{min != null ? "/" + min : ""}</span>
    </div>
  );
}
