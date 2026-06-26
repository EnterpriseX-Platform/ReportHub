"use client";

import { Fragment, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Icon, type IconName } from "@/components/Icon";
import { DsDot } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { fmtTHB } from "@/lib/format";
import { api } from "@/lib/api";
import { Select } from "@/components/Select";
import { SavedViewList, SaveDestination, WorkspacePicker, getSharedWorkspace, useSharedWorkspace } from "@/components/workspace";
import type { AdhocDataset, AdhocHistoryRow, AdhocResult, DatasetDef, Datasource, SavedViewRow } from "@/lib/types";

type FieldType = "dim" | "measure";
interface Field { id: string; label: string; type: FieldType }

// Map local field ids to the backend fact keys (server normalises "year" -> "fiscalYear").
const FIELD_KEY: Record<string, string> = {
  year: "fiscalYear", region: "region", channel: "channel", category: "category",
  target: "target", sales: "sales", profit: "profit",
};
// Backend dimensions usable as equality filters.
const FILTER_KEY: Record<string, string> = {
  year: "fiscalYear", region: "region", channel: "channel", category: "category",
};

// The ONLY built-in dataset is the real internal warehouse (fact);
// everything else comes from user-created datasets (/datasets).
const ADHOC_FIELDS: Record<string, Field[]> = {
  "d-core": [
    { id: "year", label: "Fiscal Year", type: "dim" }, { id: "region", label: "Region", type: "dim" },
    { id: "channel", label: "Channel", type: "dim" }, { id: "category", label: "Category", type: "dim" },
    { id: "target", label: "Target", type: "measure" }, { id: "sales", label: "Sales", type: "measure" }, { id: "profit", label: "Profit", type: "measure" },
  ],
};

interface SavedPayload { dataset: string; picked: string[]; filters: Record<string, string> }

// Build the backend AdhocRequest from local picks.
function buildAdhocRequest(picked: string[], fields: Field[], filters: Record<string, string>) {
  const fieldKeys = picked
    .map((id) => ({ id, key: FIELD_KEY[id], type: fields.find((f) => f.id === id)?.type }))
    .filter((f) => !!f.key);
  const reqFields = fieldKeys.map((f) => f.key);
  const reqFilters: Record<string, string> = {};
  Object.entries(filters).forEach(([k, v]) => { if (v && FILTER_KEY[k]) reqFilters[FILTER_KEY[k]] = v; });
  const hasMeasure = fieldKeys.some((f) => f.type === "measure");
  return { fields: reqFields, filters: reqFilters, hasMeasure };
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const mins = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default function AdhocBuilderPage() {
  return (
    <Suspense fallback={<div className="empty"><span className="spin" /></div>}>
      <AdhocBuilder />
    </Suspense>
  );
}

function AdhocBuilder() {
  const search = useSearchParams();
  const toast = useToast();
  const [dsMap, setDsMap] = useState<Record<string, Datasource>>({});
  const [dataset, setDataset] = useState(() => search.get("dataset") ?? "d-core");
  const [picked, setPicked] = useState<string[]>(["year", "region", "sales", "profit"]);
  const [filters, setFilters] = useState<Record<string, string>>({ year: "2026" });
  const [ran, setRan] = useState(false);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<AdhocResult | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [showHelp, setShowHelp] = useState(true);
  // real data: saved views + run history + filter values from the warehouse
  const [saved, setSaved] = useState<SavedViewRow[]>([]);
  const [history, setHistory] = useState<AdhocHistoryRow[]>([]);
  const [meta, setMeta] = useState<AdhocDataset | null>(null);
  // user-defined datasets (SQL editor) appear alongside the built-in warehouse families
  const [custom, setCustom] = useState<DatasetDef[]>([]);
  const [customFields, setCustomFields] = useState<Field[]>([]);
  const [customFilterValues, setCustomFilterValues] = useState<Record<string, string[]>>({});
  const customDef = dataset.startsWith("custom-") ? custom.find((c) => `custom-${c.id}` === dataset) : undefined;

  const [ws, setWs] = useSharedWorkspace();              // shared across analytics pages

  const reloadSide = useCallback(() => {
    api.savedViews("adhoc", ws || undefined).then(setSaved).catch(() => {});
    api.adhocHistory().then(setHistory).catch(() => {});
  }, [ws]);

  useEffect(() => {
    api.datasources().then((d) => setDsMap(Object.fromEntries(d.map((x) => [x.id, x])))).catch(() => {});
    api.adhocDatasets().then((ds) => setMeta(ds[0] ?? null)).catch(() => {});
    api.datasets().then(setCustom).catch(() => {});
    reloadSide();
  }, [reloadSide]);

  const fields = customDef ? customFields : (ADHOC_FIELDS[dataset] ?? []);
  // custom dataset selected → derive fields from its real columns + load filter values
  useEffect(() => {
    if (!customDef) { setCustomFields([]); setCustomFilterValues({}); return; }
    api.datasetFields(customDef.id).then((cols) => {
      const fs: Field[] = cols.map((c) => ({ id: c.name, label: c.name, type: c.kind === "measure" ? "measure" : "dim" }));
      setCustomFields(fs);
      setPicked(fs.filter((f) => f.type === "dim").slice(0, 2).map((f) => f.id)
        .concat(fs.filter((f) => f.type === "measure").slice(0, 1).map((f) => f.id)));
      setFilters({});
      setRan(false); setResult(null);
      fs.filter((f) => f.type === "dim").slice(0, 4).forEach((f) => {
        api.datasetDistinct(customDef.id, f.id).then((vals) =>
          setCustomFilterValues((s) => ({ ...s, [f.id]: vals }))).catch(() => {});
      });
    }).catch((e) => toast(e instanceof Error ? e.message : "Failed to read dataset columns", "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  useEffect(() => {
    if (customDef) return;
    setPicked(fields.filter((f) => f.type === "dim").slice(0, 2).map((f) => f.id).concat(fields.filter((f) => f.type === "measure").slice(0, 1).map((f) => f.id)));
    setRan(false);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  function toggle(id: string) { setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); setRan(false); setResult(null); }

  const resultCols = result?.columns ?? [];
  const colLabel = (key: string) => {
    if (customDef) return key;
    const localId = Object.keys(FIELD_KEY).find((id) => FIELD_KEY[id] === key) ?? key;
    return fields.find((f) => f.id === localId)?.label ?? key;
  };
  const isMeasureKey = (key: string) => customDef
    ? fields.some((f) => f.id === key && f.type === "measure")
    : ["target", "sales", "profit"].includes(key);

  const dimsPicked = picked.filter((id) => fields.find((f) => f.id === id)?.type === "dim").length;
  const measPicked = picked.filter((id) => fields.find((f) => f.id === id)?.type === "measure").length;
  const dsStatus = (id: string) => dsMap[id]?.status ?? "healthy";
  const dsName = (id: string) => dsMap[id]?.name ?? id;

  // Filter dimensions with REAL distinct values from the warehouse (GET /adhoc/datasets).
  const realFilters: { id: string; th: string; label: string; values: string[] }[] = customDef
    ? Object.entries(customFilterValues).map(([id, values]) => ({ id, th: id, label: "dataset column", values }))
    : meta ? [
    { id: "year", th: "Fiscal Year", label: "year", values: meta.filterOptions?.fiscalYears ?? [] },
    { id: "region", th: "Region", label: "region", values: meta.filterOptions?.regions ?? [] },
    { id: "category", th: "Category", label: "category", values: meta.filterOptions?.categories ?? [] },
    { id: "channel", th: "Channel", label: "channel", values: meta.filterOptions?.channels ?? [] },
    ] : [];

  async function runQuery() {
    if (customDef) {
      const dims = picked.filter((id) => fields.find((f) => f.id === id)?.type === "dim");
      const measures = picked.filter((id) => fields.find((f) => f.id === id)?.type === "measure");
      if (!measures.length) { toast("Pick at least one measure", "error"); return; }
      setRunning(true);
      try {
        const res = await api.datasetAggregate(customDef.id, { dims, measures, filters });
        const maps = res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i] as string | number])));
        const totals: Record<string, number> = {};
        measures.forEach((m) => { totals[m] = maps.reduce((s, r) => s + (Number(r[m]) || 0), 0); });
        setResult({ columns: res.columns, rows: maps, totals, rowCount: res.rowCount });
        setRan(true);
        toast(`Query executed · ${res.rowCount} rows`, "ok");
        reloadSide();
      } catch (e) {
        toast(e instanceof Error ? e.message : "Query failed", "error");
      } finally { setRunning(false); }
      return;
    }
    const { fields: reqFields, filters: reqFilters, hasMeasure } = buildAdhocRequest(picked, fields, filters);
    if (reqFields.length === 0) { toast("Pick at least one field", "error"); return; }
    if (!hasMeasure) { toast("Pick at least one measure", "error"); return; }
    setRunning(true);
    try {
      const res = await api.adhocRun({ dataset: "fact", fields: reqFields, filters: reqFilters });
      setResult(res);
      setRan(true);
      toast(`Query executed · ${res.rowCount} rows`, "ok");
      reloadSide();   // history just gained a row
    } catch (e) {
      toast(e instanceof Error ? e.message : "Query failed", "error");
    } finally {
      setRunning(false);
    }
  }

  async function exportExcel() {
    const { fields: reqFields, filters: reqFilters } = buildAdhocRequest(picked, fields, filters);
    setExporting(true);
    try {
      await api.adhocExport({ dataset: "fact", fields: reqFields, filters: reqFilters }, "adhoc.xlsx");
      toast("Exported to Excel (.xlsx)", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed", "error");
    } finally {
      setExporting(false);
    }
  }

  function loadSaved(v: SavedViewRow) {
    try {
      const p = JSON.parse(v.payload) as SavedPayload;
      setDataset(p.dataset);
      // dataset change effect resets picks — apply saved picks on the next tick
      setTimeout(() => {
        setPicked(p.picked);
        setFilters(p.filters);
        setRan(false);
        setResult(null);
      }, 0);
      toast(`Loaded "${v.name}"`, "ok");
    } catch {
      toast("This saved query has an invalid payload", "error");
    }
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div><h1 className="page-title">Ad-hoc Report Builder</h1><div className="page-sub">Compose your own dataset, fields and filters to produce one-off reports</div></div>
        <div className="page-actions">
          <button className="btn" onClick={() => setShowHelp((h) => !h)}><Icon name="eye" size={15} />{showHelp ? "Hide" : "Show"} overview</button>
          <button className="btn" onClick={() => setShowSave(true)}><Icon name="star" size={15} />Save query</button>
        </div>
      </div>

      {showHelp && <AdhocFlow active={ran ? 5 : picked.length ? 4 : 2} />}

      <div style={{ display: "grid", gridTemplateColumns: "248px 1fr", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, position: "sticky", top: 0 }}>
          <div className="card">
            <div className="card-head" style={{ padding: "12px 14px" }}><Icon name="star" size={15} style={{ color: "var(--accent)" }} /><div style={{ flex: 1 }}><h3 style={{ fontSize: 13 }}>Saved queries</h3></div></div>
            <div style={{ padding: 8 }}>
              <WorkspacePicker value={ws} onChange={setWs} allowAll style={{ marginBottom: 8 }} />
              <SavedViewList views={saved} onLoad={loadSaved} onChanged={reloadSide} />
            </div>
          </div>
          <div className="card">
            <div className="card-head" style={{ padding: "12px 14px" }}><Icon name="history" size={15} style={{ color: "var(--ink-3)" }} /><div style={{ flex: 1 }}><h3 style={{ fontSize: 13 }}>Query history</h3></div></div>
            <div style={{ padding: 8 }}>
              {history.length === 0 && <div style={{ fontSize: 11.5, color: "var(--ink-4)", padding: "6px 9px" }}>No history yet</div>}
              {history.map((h) => (
                <div key={h.id} style={{ display: "flex", gap: 9, padding: "8px 9px", borderRadius: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 6, background: "var(--ink-4)", marginTop: 6, flex: "none" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.fields} · {h.rowCount} rows</div>
                    <div style={{ fontSize: 10, color: "var(--ink-4)" }}>{relTime(h.createdAt)} · {h.createdBy}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <StepCard n="1" title="Choose a dataset" done={!!dataset}
                    aside={<span style={{ fontSize: 12, color: "var(--ink-3)" }}>{1 + custom.length} available</span>}>
            {(() => {
              const all = [
                { id: "d-core", label: "Core warehouse (fact)", sub: "Internal warehouse · live", ds: "ds-core" },
                ...custom.map((c) => ({ id: `custom-${c.id}`, label: c.name, sub: `${c.captureMode === "captured" ? `snapshot · ${c.captureRows?.toLocaleString()} rows` : "live SQL"}${c.description ? " · " + c.description : ""}`, ds: c.datasourceId ?? "ds-core" })),
              ];
              const selDs = all.find((d) => d.id === dataset);
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Select value={dataset} onChange={setDataset} searchable placeholder="Search datasets…"
                          options={all.map((d) => ({ value: d.id, label: d.label, sub: d.sub }))} />
                  {selDs && (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 13px", borderRadius: 10, border: "1px solid var(--accent-line)", background: "var(--accent-weak)" }}>
                      <Icon name="datasource" size={16} style={{ color: "var(--accent)", flex: "none", marginTop: 1 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent)" }}>{selDs.label}</div>
                        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{selDs.sub}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6 }}><DsDot s={dsStatus(selDs.ds)} /><span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{dsName(selDs.ds)}</span></div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </StepCard>

          <StepCard n="2" title="Pick the fields to show" done={picked.length > 0} aside={<span style={{ fontSize: 12, color: "var(--ink-3)" }}>{dimsPicked} dims · {measPicked} measures</span>}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {fields.map((f) => {
                const on = picked.includes(f.id);
                return (
                  <button key={f.id} onClick={() => toggle(f.id)} className="btn sm" style={{ borderColor: on ? "var(--accent)" : undefined, background: on ? "var(--accent-weak)" : undefined, color: on ? "var(--accent)" : "var(--ink-2)" }}>
                    {on ? <Icon name="check" size={13} /> : <Icon name="plus" size={13} />}{f.label}
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: f.type === "measure" ? "var(--violet)" : "var(--ink-4)", marginLeft: 2 }}>{f.type === "measure" ? "Σ" : "•"}</span>
                  </button>
                );
              })}
            </div>
          </StepCard>

          <StepCard n="3" title="Set the filters" done={Object.values(filters).some(Boolean)}
            aside={<span style={{ fontSize: 11, color: "var(--ink-4)" }}>live values from the warehouse</span>}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {realFilters.map((flt) => (
                <div className="field" key={flt.id}>
                  <label style={{ fontSize: 11.5 }}>{flt.th} <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>{flt.label}</span></label>
                  <Select value={filters[flt.id] || ""} placeholder="All"
                    onChange={(v) => { setFilters((s) => ({ ...s, [flt.id]: v })); setRan(false); }}
                    options={[{ value: "", label: "All" }, ...flt.values.map((v) => ({ value: v, label: v }))]} />
                </div>
              ))}
              {realFilters.length === 0 && <div className="empty" style={{ gridColumn: "1 / -1" }}><span className="spin" /></div>}
            </div>
            {Object.entries(filters).filter(([, v]) => v).length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
                {Object.entries(filters).filter(([, v]) => v).map(([k, v]) => (
                  <span key={k} className="tag-pill" style={{ background: "var(--accent-weak)", borderColor: "var(--accent-line)", color: "var(--accent)" }}>
                    {realFilters.find((f) => f.id === k)?.th ?? k}: <b style={{ marginLeft: 3 }}>{v}</b>
                    <Icon name="x" size={12} style={{ cursor: "pointer" }} onClick={() => setFilters((s) => { const n = { ...s }; delete n[k]; return n; })} />
                  </span>
                ))}
              </div>
            )}
          </StepCard>

          <StepCard n="4" title="Run &amp; export to Excel" done={ran}
            aside={<div style={{ display: "flex", gap: 8 }}>
              <button className="btn sm" disabled={running} onClick={runQuery}>{running ? <span className="spin" /> : <Icon name="play" size={14} />}Run query</button>
              <button className="btn sm primary" disabled={!ran || exporting || !!customDef} title={customDef ? "Excel export for custom datasets is coming" : undefined} onClick={exportExcel}>{exporting ? <span className="spin" /> : <Icon name="download" size={14} />}Export Excel</button>
            </div>}>
            <div className="card" style={{ boxShadow: "none", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
                <Icon name="table" size={14} style={{ color: "var(--ink-3)" }} /><b>Result</b>
                <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>{result ? `${result.rowCount} rows` : "Press Run to execute"}</span>
              </div>
              <div style={{ overflow: "auto", maxHeight: 320, opacity: ran ? 1 : 0.5, transition: ".2s", filter: ran ? "none" : "grayscale(0.4)" }}>
                <table className="tbl">
                  <thead><tr>{(result ? resultCols : picked.map((id) => FIELD_KEY[id]).filter(Boolean)).map((key) => <th key={key} className={isMeasureKey(key) ? "num" : ""}>{colLabel(key)}</th>)}</tr></thead>
                  <tbody>
                    {result && result.rows.map((r, i) => (
                      <tr key={i} style={{ cursor: "default" }}>
                        {resultCols.map((key) => <td key={key} className={isMeasureKey(key) ? "num" : ""}>{isMeasureKey(key) ? fmtTHB(Number(r[key]) || 0) : String(r[key] ?? "—")}</td>)}
                      </tr>
                    ))}
                    {result && result.rows.length > 0 && (
                      <tr style={{ cursor: "default", background: "var(--surface-3)", fontWeight: 700 }}>
                        {resultCols.map((key, i) => <td key={key} className={isMeasureKey(key) ? "num" : ""}>{i === 0 ? "Total" : isMeasureKey(key) ? fmtTHB(result.totals[key] || 0) : ""}</td>)}
                      </tr>
                    )}
                    {(!result || result.rows.length === 0) && <tr><td colSpan={Math.max(1, picked.length)}><div className="empty">{running ? "Running…" : "Pick fields and press Run query"}</div></td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </StepCard>
        </div>
      </div>

      {showSave && (
        <SaveQueryModal
          saved={saved}
          onClose={() => setShowSave(false)}
          onLoad={(v) => { setShowSave(false); loadSaved(v); }}
          onSave={async (name, workspaceId, folder) => {
            try {
              await api.saveView({
                kind: "adhoc", name, dataset, workspaceId, folder: folder || undefined,
                payload: JSON.stringify({ dataset, picked, filters } satisfies SavedPayload),
              });
              toast("Query saved", "ok");
              setShowSave(false);
              reloadSide();
            } catch (e) {
              toast(e instanceof Error ? e.message : "Save failed", "error");
            }
          }}
        />
      )}
    </div>
  );
}

function AdhocFlow({ active }: { active: number }) {
  const steps: { n: number; label: string; icon: IconName }[] = [
    { n: 1, label: "Choose dataset", icon: "datasource" },
    { n: 2, label: "Pick fields", icon: "filter" },
    { n: 3, label: "Set filters", icon: "adhoc" },
    { n: 4, label: "Run", icon: "bolt" },
    { n: 5, label: "Export Excel", icon: "download" },
  ];
  return (
    <div className="card card-pad" style={{ marginBottom: 16, background: "linear-gradient(180deg, var(--surface), var(--surface-2))" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <Icon name="bolt" size={15} style={{ color: "var(--accent)" }} />
        <b style={{ fontSize: 13 }}>How ad-hoc works</b>
        <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>— compose a report step by step; the system computes it from the database and exports Excel</span>
      </div>
      <div style={{ display: "flex", alignItems: "stretch", overflowX: "auto" }}>
        {steps.map((s, i) => (
          <Fragment key={s.n}>
            <div style={{ flex: 1, minWidth: 120, textAlign: "center", opacity: active >= s.n ? 1 : 0.45 }}>
              <div style={{ width: 44, height: 44, margin: "0 auto", borderRadius: 12, display: "grid", placeItems: "center", background: active >= s.n ? "var(--accent)" : "var(--surface-3)", color: active >= s.n ? "#fff" : "var(--ink-4)", transition: ".3s" }}>
                <Icon name={s.icon} size={20} />
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>{s.label}</div>
            </div>
            {i < steps.length - 1 && <div style={{ flex: "0 0 28px", display: "flex", alignItems: "center", justifyContent: "center", paddingBottom: 28, color: active > s.n ? "var(--accent)" : "var(--ink-4)" }}><Icon name="arrowRight" size={16} /></div>}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function StepCard({ n, title, done, aside, children }: { n: string; title: string; done: boolean; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <span style={{ width: 26, height: 26, borderRadius: 26, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, background: done ? "var(--green)" : "var(--accent)", color: "#fff", flex: "none" }}>{done ? <Icon name="check" size={14} /> : n}</span>
        <div style={{ flex: 1 }}><h3>{title}</h3></div>
        {aside}
      </div>
      <div className="card-pad">{children}</div>
    </div>
  );
}

function SaveQueryModal({ saved, onClose, onSave, onLoad }: {
  saved: SavedViewRow[];
  onClose: () => void;
  onSave: (name: string, workspaceId: number, folder: string) => void;
  onLoad: (v: SavedViewRow) => void;
}) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState(() => getSharedWorkspace() || 1);
  const [folder, setFolder] = useState("");
  return (
    <Modal title="Save ad-hoc query" sub="Keep the current dataset, fields and filters for reuse — then serve it as CSV / Excel / JSON via a public API URL" width={520} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), workspaceId, folder.trim())}><Icon name="star" size={15} />Save query</button></>}>
      <div className="field" style={{ marginBottom: 13 }}><label>Query name</label><input className="input" autoFocus placeholder="e.g. Sales by region 2025" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div style={{ marginBottom: 18 }}>
        <SaveDestination workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} folder={folder} setFolder={setFolder} folders={saved.map((v) => v.folder ?? "")} />
      </div>
      <div className="section-label">Saved queries ({saved.length})</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {saved.length === 0 && <div className="empty">None yet</div>}
        {saved.map((q) => (
          <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", borderRadius: 9, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
            <Icon name="history" size={15} style={{ color: "var(--ink-4)" }} />
            <div style={{ flex: 1 }}><div style={{ fontSize: 12.5 }}>{q.name}</div><div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{relTime(q.createdAt)} · {q.createdBy}</div></div>
            <button className="btn sm ghost" onClick={() => onLoad(q)}><Icon name="play" size={13} /></button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
