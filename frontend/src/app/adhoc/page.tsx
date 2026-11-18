"use client";

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Button, ContentSwitcher, IconButton, InlineNotification, Switch, Tag, TextInput, Tile } from "@carbon/react";
import { Add, Checkmark, Download, Edit, Play, Renew, Star } from "@carbon/icons-react";
import { Icon } from "@/components/Icon";
import { StatusIcon, PageHeader } from "@/components/ui";
import cx from "@/components/D/d.module.scss";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { fmtAmount } from "@/lib/format";
import { api } from "@/lib/api";
import { Select } from "@/components/Select";
import { SavedViewList, SaveDestination, WorkspacePicker, getSharedWorkspace, useSharedWorkspace } from "@/components/workspace";
import { SqlEditor } from "@/components/SqlEditor";
import type { AdhocDataset, AdhocHistoryRow, AdhocResult, DatasetDef, Datasource, SavedViewRow, SqlRunLogRow } from "@/lib/types";

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
    <Suspense fallback={null}>
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
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [ran, setRan] = useState(false);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<AdhocResult | null>(null);
  const [mode, setMode] = useState<"builder" | "sql">(search.get("mode") === "sql" ? "sql" : "builder");
  const [showSave, setShowSave] = useState(false);
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
      // every dimension, not the first few: on a wide dataset a cut-off could drop a column this
      // screen exists to filter on. /distinct caps its own result at 200 values, so the extra calls are cheap.
      fs.filter((f) => f.type === "dim").forEach((f) => {
        api.datasetDistinct(customDef.id, f.id).then((vals) =>
          setCustomFilterValues((s) => ({ ...s, [f.id]: vals }))).catch(() => {});
      });
    }).catch((e) => toast(e instanceof Error ? e.message : "Failed to read dataset columns", "error"));
    // customDef?.id, not just dataset: `custom` is fetched asynchronously, so landing here from
    // /datasets ("explore in Ad-hoc" → ?dataset=custom-N) renders once with an empty list, finds no
    // customDef, and bails. Keyed on dataset alone the effect never fired again once the list
    // arrived, and the screen sat on "0 group-by columns · 0 measures" with the right dataset selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, customDef?.id]);

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
        toast(`Query executed · ${res.rowCount} row${res.rowCount === 1 ? "" : "s"}`, "ok");
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
      toast(`Query executed · ${res.rowCount} row${res.rowCount === 1 ? "" : "s"}`, "ok");
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
      if (customDef) {
        // User-defined datasets have their own columns; export via that dataset's endpoint
        // (/adhoc/export is bound to the built-in fact dataset only).
        const dims = picked.filter((id) => fields.find((f) => f.id === id)?.type === "dim");
        const measures = picked.filter((id) => fields.find((f) => f.id === id)?.type === "measure");
        await api.datasetExport(customDef.id, { dims, measures, filters },
                                `${customDef.name || "dataset"}.xlsx`);
        toast("Exported to Excel (.xlsx)", "ok");
        return;
      }
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

  /** Decimals a measure column really has (99.9 stays 99.9, whole numbers stay whole), at most 4. */
  const decOf = (key: string) => {
    let d = 0;
    for (const row of result?.rows ?? []) {
      const v = Number(row[key]);
      if (!Number.isFinite(v)) continue;
      const m = /\.(\d+)$/.exec(String(v));
      if (m) d = Math.max(d, Math.min(4, m[1].length));
    }
    return d;
  };
  return (
    <div className="fade-in">
      <PageHeader title="Ad-hoc Report"
        actions={<>
          {/* Two ways to do the same job: SQL users skip the three-step builder, others keep it */}
          <ContentSwitcher size="md" selectedIndex={mode === "builder" ? 0 : 1} style={{ width: 200 }}
                           onChange={(e) => setMode(e.index === 0 ? "builder" : "sql")}>
            <Switch name="builder" text="Builder" />
            <Switch name="sql" text="SQL" />
          </ContentSwitcher>
          {mode === "builder" &&
            <Button kind="secondary" renderIcon={Star} onClick={() => setShowSave(true)}>Save for reuse</Button>}
        </>} />

      {mode === "sql" ? <SqlPanel toast={toast} /> : (
      <div className={cx.side2}>
        <div className={cx.sideCol}>
          <Tile>
            <SideHead icon="star" title="Saved reports" />
            <WorkspacePicker value={ws} onChange={setWs} allowAll style={{ marginBottom: 8 }} />
            <SavedViewList views={saved} onLoad={loadSaved} onChanged={reloadSide} />
          </Tile>
          <Tile>
            <SideHead icon="history" title="Run history" />
            {history.length === 0 && <div className="cds--type-label-01 rh-dim">No history yet</div>}
            {history.map((h) => (
              <div key={h.id} className={cx.histRow}>
                <div className="cds--type-body-compact-01 rh-ellipsis">{h.fields} · {h.rowCount} rows</div>
                <div className="cds--type-label-01 rh-dim">{relTime(h.createdAt)} · {h.createdBy}</div>
              </div>
            ))}
          </Tile>
        </div>

        <div className={cx.mainCol}>
          <StepCard n="1" title="1. Choose a dataset" done={!!dataset}
                    aside={<span className="cds--type-label-01 rh-dim">{1 + custom.length} available</span>}>
            {(() => {
              const all = [
                { id: "d-core", label: "Core warehouse (fact)", sub: "Internal warehouse · live", ds: "ds-core" },
                ...custom.map((c) => ({ id: `custom-${c.id}`, label: c.name, sub: `${c.captureMode === "captured" ? `snapshot · ${c.captureRows?.toLocaleString()} rows` : "live SQL"}${c.description ? " · " + c.description : ""}`, ds: c.datasourceId ?? "ds-core" })),
              ];
              const selDs = all.find((d) => d.id === dataset);
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Select label="Dataset" value={dataset} onChange={setDataset} searchable placeholder="Search datasets…"
                          options={all.map((d) => ({ value: d.id, label: d.label, sub: d.sub }))} />
                  {selDs && (
                    <div className={cx.selCard}>
                      <Icon name="datasource" size={16} style={{ color: "var(--cds-icon-secondary)", flex: "none", marginTop: 2 }} />
                      <div style={{ minWidth: 0 }}>
                        <div className="cds--type-heading-compact-01">{selDs.label}</div>
                        <div className="cds--type-label-01 rh-dim" style={{ marginTop: 2 }}>{selDs.sub}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}><StatusIcon s={dsStatus(selDs.ds)} /><span className="cds--type-label-01 rh-dim">{dsName(selDs.ds)}</span></div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </StepCard>

          <StepCard n="2" title="2. Choose columns to show" done={picked.length > 0} aside={<span className="cds--type-label-01 rh-dim">{dimsPicked} group columns · {measPicked} measures</span>}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cds-spacing-03)" }}>
              {fields.map((f) => {
                const on = picked.includes(f.id);
                return (
                  <Button key={f.id} size="sm" kind={on ? "primary" : "tertiary"} renderIcon={on ? Checkmark : Add}
                          aria-pressed={on} onClick={() => toggle(f.id)}>
                    {f.label}{f.type === "measure" ? " Σ" : ""}
                  </Button>
                );
              })}
            </div>
          </StepCard>

          <StepCard n="3" title="3. Add filters" done={Object.values(filters).some(Boolean)}
            aside={<span className="cds--type-label-01 rh-dim">Values come from the real data</span>}>
            <div className={cx.grid3}>
              {realFilters.map((flt) => (
                <div key={flt.id}>
                  <Select label={`${flt.th} · ${flt.label}`} value={filters[flt.id] || ""} placeholder="All"
                    onChange={(v) => { setFilters((s) => ({ ...s, [flt.id]: v })); setRan(false); }}
                    options={[{ value: "", label: "All" }, ...flt.values.map((v) => ({ value: v, label: v }))]} />
                </div>
              ))}
              {realFilters.length === 0 && <div style={{ gridColumn: "1 / -1", height: 64 }} />}
            </div>
            {Object.entries(filters).filter(([, v]) => v).length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", marginTop: "var(--cds-spacing-05)" }}>
                {Object.entries(filters).filter(([, v]) => v).map(([k, v]) => (
                  <Tag key={k} type="blue" filter title="Remove filter" onClose={() => setFilters((s) => { const n = { ...s }; delete n[k]; return n; })}>
                    {realFilters.find((f) => f.id === k)?.th ?? k}: {v}
                  </Tag>
                ))}
              </div>
            )}
          </StepCard>

          <StepCard n="4" title="4. Run and export to Excel" done={ran}
            aside={<div style={{ display: "flex", gap: 1 }}>
              <Button size="sm" kind="secondary" renderIcon={Play} disabled={running} onClick={runQuery}>{running ? "Running…" : "Run"}</Button>
              <Button size="sm" kind="primary" renderIcon={Download} disabled={!ran || exporting} onClick={exportExcel}>{exporting ? "Exporting…" : "Export to Excel"}</Button>
            </div>}>
            <div className={cx.result}>
              <div className={cx.resultHead}>
                <Icon name="table" size={16} /><span className="cds--type-heading-compact-01">Results</span>
                <span className="rh-dim" style={{ marginLeft: "auto" }}>{result ? `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}` : "Run to see the results"}</span>
              </div>
              <div className={cx.scroll} style={{ maxHeight: 320, opacity: ran ? 1 : 0.5, transition: "opacity .2s" }}>
                <table className={"cds--data-table cds--data-table--sm " + cx.table}>
                  <thead><tr>{(result ? resultCols : picked.map((id) => FIELD_KEY[id]).filter(Boolean)).map((key) => <th key={key} className={isMeasureKey(key) ? cx.num : ""}>{colLabel(key)}</th>)}</tr></thead>
                  <tbody>
                    {result && result.rows.map((r, i) => (
                      <tr key={i}>
                        {resultCols.map((key) => <td key={key} className={isMeasureKey(key) ? cx.num : ""}>{isMeasureKey(key) ? fmtAmount(Number(r[key]) || 0, decOf(key)) : String(r[key] ?? "—")}</td>)}
                      </tr>
                    ))}
                    {result && result.rows.length > 0 && (
                      <tr className={cx.totalRow}>
                        {resultCols.map((key, i) => <td key={key} className={isMeasureKey(key) ? cx.num : ""}>{i === 0 ? "Total" : isMeasureKey(key) ? fmtAmount(result.totals[key] || 0, decOf(key)) : ""}</td>)}
                      </tr>
                    )}
                    {(!result || result.rows.length === 0) && <tr><td colSpan={Math.max(1, picked.length)}><div className={cx.cellEmpty}>{running ? "Running…" : picked.length === 0 ? "Pick columns, then run" : result ? "No rows match" : "Run to see the results"}</div></td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </StepCard>
        </div>
      </div>
      )}

      {showSave && (
        <SaveQueryModal
          saved={saved}
          onClose={() => setShowSave(false)}
          onLoad={(v) => { setShowSave(false); loadSaved(v); }}
          onUpdate={async (v) => {
            try {
              await api.updateView(v.id, {
                dataset,
                payload: JSON.stringify({ dataset, picked, filters } satisfies SavedPayload),
              });
              toast("Query updated", "ok");
              setShowSave(false);
              reloadSide();
            } catch (e) {
              toast(e instanceof Error ? e.message : "Update failed", "error");
            }
          }}
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

function StepCard({ n: _n, title, done: _done, aside, children }: { n: string; title: string; done: boolean; aside?: ReactNode; children: ReactNode }) {
  return (
    <Tile>
      <div className={cx.cardHead}>
        <h3 className="cds--type-heading-compact-02" style={{ margin: 0, flex: 1, minWidth: 0 }}>{title}</h3>
        {aside}
      </div>
      {children}
    </Tile>
  );
}

function SideHead({ icon, title, action }: { icon: "star" | "history"; title: string; action?: ReactNode }) {
  return (
    <div className={cx.cardHead}>
      <Icon name={icon} size={16} style={{ color: "var(--cds-icon-secondary)" }} />
      <h3 className="cds--type-heading-compact-01" style={{ margin: 0, flex: 1 }}>{title}</h3>
      {action}
    </div>
  );
}

function SaveQueryModal({ saved, onClose, onSave, onUpdate, onLoad }: {
  saved: SavedViewRow[];
  onClose: () => void;
  onSave: (name: string, workspaceId: number, folder: string) => void;
  onUpdate: (v: SavedViewRow) => void;
  onLoad: (v: SavedViewRow) => void;
}) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState(() => getSharedWorkspace() || 1);
  const [folder, setFolder] = useState("");
  return (
    <Modal title="Save this report for reuse" sub="Keep the current dataset, fields and filters for reuse — then serve it as CSV / Excel / JSON via a public API URL" width={520} onClose={onClose}
      foot={<><Button kind="secondary" onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), workspaceId, folder.trim())}>Save for reuse</Button></>}>
      <div style={{ marginBottom: "var(--cds-spacing-05)" }}><TextInput id="adhoc-save-name" labelText="Report name" autoFocus placeholder="e.g. Sales by region, FY2025" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div style={{ marginBottom: 18 }}>
        <SaveDestination workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} folder={folder} setFolder={setFolder} folders={saved.map((v) => v.folder ?? "")} />
      </div>
      <div className="cds--label">Saved queries ({saved.length})</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {saved.length === 0 && <div className="cds--type-label-01 rh-dim">None yet</div>}
        {saved.map((q) => (
          <div key={q.id} className={cx.listRow}>
            <Icon name="history" size={16} style={{ color: "var(--cds-icon-secondary)" }} />
            <div style={{ flex: 1, minWidth: 0 }}><div className="cds--type-body-compact-01">{q.name}</div><div className="cds--type-label-01 rh-dim">{relTime(q.createdAt)} · {q.createdBy}</div></div>
            {/* Overwrite this saved query with the current conditions; saving under the same name creates a new one */}
            <IconButton kind="ghost" size="sm" label="Overwrite with the current conditions" align="left" onClick={() => onUpdate(q)}><Edit /></IconButton>
            <IconButton kind="ghost" size="sm" label="Load this query" align="left" onClick={() => onLoad(q)}><Play /></IconButton>
          </div>
        ))}
      </div>
    </Modal>
  );
}


/**
 * SQL tab of the Ad-hoc screen — write, run, save and export.
 *
 * The Tables screen also has a SQL box, but that is a tool for table maintainers; this is where
 * people requesting reports already are, so saving, exporting and reopening scripts live here too.
 *
 * Saved to saved_view kind="sql", shared with the Tables SQL box, so scripts saved on either
 * screen show on both. Export runs server-side on the full result, not on the rows shown.
 */
function SqlPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [dss, setDss] = useState<Datasource[]>([]);
  const [datasourceId, setDatasourceId] = useState("");
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [result, setResult] = useState<{ kind: string; columns: string[]; rows: (string | number | null)[][]; rowCount: number; affected: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [saved, setSaved] = useState<SavedViewRow[]>([]);
  const [ws, setWs] = useSharedWorkspace();
  const [showSave, setShowSave] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [openedName, setOpenedName] = useState<string | null>(null);

  const reloadSaved = useCallback(() => {
    api.savedViews("sql", ws || undefined).then(setSaved).catch(() => {});
  }, [ws]);
  useEffect(() => { reloadSaved(); }, [reloadSaved]);

  /** Server-side run history — every run, including failed ones (sql_run_log) */
  const [runs, setRuns] = useState<SqlRunLogRow[]>([]);
  const reloadRuns = useCallback(() => { api.sqlRunHistory(25).then(setRuns).catch(() => {}); }, []);
  useEffect(() => { reloadRuns(); }, [reloadRuns]);
  useEffect(() => { api.datasources().then(setDss).catch(() => {}); }, []);

  async function run() {
    if (!sql.trim()) { toast("Write a statement first", "error"); return; }
    setRunning(true); setErr(null);
    try {
      const res = await api.repoExecute({ datasourceId: datasourceId || null, sql, source: "adhoc" });
      setResult(res);
      toast(res.kind === "select" ? `${res.rowCount} row${res.rowCount === 1 ? "" : "s"}` : `${res.affected} row(s) affected`, "ok");
    } catch (e) {
      setResult(null);
      setErr(e instanceof Error ? e.message : "SQL failed to run");
    } finally { setRunning(false); reloadRuns(); }
  }

  async function doExport(fmt: "csv" | "xlsx") {
    if (!sql.trim()) { toast("Write a statement first", "error"); return; }
    setExporting(fmt);
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      await api.exportSqlResult({ datasourceId: datasourceId || null, sql },
        fmt, `${(openedName || "query").replace(/[^\w\u0E00-\u0E7F.-]+/g, "_")}_${stamp}.${fmt}`);
      toast(`Exported ${fmt.toUpperCase()}`, "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed", "error");
    } finally { setExporting(null); }
  }

  async function save() {
    if (!name.trim()) { toast("Give it a name first", "error"); return; }
    if (!sql.trim()) { toast("There is no SQL to save", "error"); return; }
    try {
      await api.saveView({
        kind: "sql", name: name.trim(), workspaceId: ws, folder: folder || undefined,
        payload: JSON.stringify({ datasourceId: datasourceId || null, sql }),
      });
      toast("Saved — it is in the left panel", "ok");
      setShowSave(false); setOpenedName(name.trim()); setName("");
      reloadSaved();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
  }

  function openSaved(v: SavedViewRow) {
    try {
      const p = JSON.parse(v.payload) as { datasourceId?: string | null; sql?: string };
      setSql(p.sql ?? "");
      setDatasourceId(p.datasourceId ?? "");
      setOpenedName(v.name);
      setResult(null); setErr(null);
    } catch { toast("This saved item is not a SQL script", "error"); }
  }

  return (
    <div className={cx.side2}>
      <div className={cx.sideCol}>
       <Tile>
        <SideHead icon="star" title="Saved SQL" />
        <WorkspacePicker value={ws} onChange={setWs} allowAll style={{ marginBottom: 8 }} />
        <SavedViewList views={saved} onLoad={openSaved} onChanged={reloadSaved} />
       </Tile>
       <Tile>
        {/* Real run history, not just saved scripts: the only place to trace who ran what and when.
            Failed runs are kept (red dot) since they are the ones read most often. */}
        <SideHead icon="history" title="Run history"
                  action={<IconButton kind="ghost" size="sm" label="Reload" align="left" onClick={reloadRuns}><Renew /></IconButton>} />
        <div style={{ maxHeight: 280, overflow: "auto" }}>
          {runs.length === 0 && <div className="cds--type-label-01 rh-dim">No runs yet</div>}
          {runs.map((r) => (
            <button key={r.id} onClick={() => { setSql(r.sql); setDatasourceId(r.datasourceId ?? ""); setOpenedName(null); }}
                    title={r.error ?? r.sql}
                    className={cx.runRow}>
              <span className={cx.dot} style={{ background: r.status === "ok" ? "var(--cds-support-success)" : "var(--cds-support-error)" }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className={"cds--type-body-compact-01 rh-ellipsis " + cx.mono} style={{ display: "block" }}>
                  {r.sql.replace(/\s+/g, " ").slice(0, 70)}
                </span>
                <span className="cds--type-label-01 rh-dim" style={{ display: "block", marginTop: 2 }}>
                  {r.status === "ok"
                    ? (r.kind === "select" ? `${(r.rowCount ?? 0).toLocaleString("en-US")} rows` : `${r.affected ?? 0} affected`)
                    : "failed"}
                  {" · "}{r.ms} ms{r.createdBy ? ` · ${r.createdBy}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
       </Tile>
      </div>

      <div className={cx.mainCol}>
        <Tile>
          <div className={cx.cardHead} style={{ flexWrap: "wrap" }}>
            <h3 className="cds--type-heading-compact-02" style={{ margin: 0, flex: 1 }}>Write SQL</h3>
            {openedName && <Tag type="gray" size="md">{openedName}</Tag>}
            <div style={{ minWidth: 240, flex: "0 1 280px" }}>
              <Select value={datasourceId} onChange={setDatasourceId} placeholder="Report Studio internal database"
                      options={[{ value: "", label: "Report Studio internal database" },
                                ...dss.map((d) => ({ value: d.id, label: d.name, sub: d.engine }))]} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--cds-spacing-05)" }}>
            <SqlEditor value={sql} onChange={setSql} height={272}
                       placeholder="SELECT … — one statement at a time" />
            <div style={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              <Button kind="primary" renderIcon={Play} disabled={running} onClick={run}>Run</Button>
              <Button kind="secondary" renderIcon={Star} onClick={() => { setName(openedName ?? ""); setShowSave(true); }}>Save</Button>
              <Button kind="tertiary" renderIcon={Download} disabled={!!exporting} onClick={() => doExport("csv")}>CSV</Button>
              <Button kind="tertiary" renderIcon={Download} disabled={!!exporting} onClick={() => doExport("xlsx")}>Excel</Button>
            </div>
          </div>
        </Tile>

        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="SQL failed" subtitle={err} style={{ maxWidth: "none" }} />}

        {result?.kind === "update" && (
          <InlineNotification kind="success" lowContrast hideCloseButton title={`${result.affected} row(s) affected`} style={{ maxWidth: "none" }} />
        )}

        {result?.kind === "select" && (
          <div className={cx.result}>
            <div className={cx.resultHead}>
              <span className="cds--type-heading-compact-01">Result</span>
              <span className="rh-dim" style={{ marginLeft: "auto" }}>
                {result.rowCount.toLocaleString("en-US")} row{result.rowCount === 1 ? "" : "s"} · {result.columns.length} col{result.columns.length === 1 ? "" : "s"}
                {result.rowCount >= 1000 ? " · showing the first page" : ""}
              </span>
            </div>
            <div className={cx.scroll} style={{ maxHeight: "52vh" }}>
              <table className={"cds--data-table cds--data-table--sm " + cx.table}>
                <thead><tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((v, j) => (
                        <td key={j} className={typeof v === "number" ? `${cx.num} ${cx.mono}` : ""}>
                          {v === null ? <span className="rh-dim">NULL</span> : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.rows.length === 0 && <tr><td colSpan={Math.max(1, result.columns.length)}><div className={cx.cellEmpty}>No rows</div></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showSave && (
        <Modal title="Save this SQL" width={520} onClose={() => setShowSave(false)}
               foot={<>
                 <Button kind="secondary" onClick={() => setShowSave(false)}>Cancel</Button>
                 <Button kind="primary" onClick={save}>Save</Button>
               </>}>
          <div style={{ marginBottom: "var(--cds-spacing-05)" }}>
            <TextInput id="adhoc-sql-save-name" labelText="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                       placeholder="e.g. Open orders 2026" />
          </div>
          <SaveDestination workspaceId={ws} setWorkspaceId={setWs}
                           folder={folder} setFolder={setFolder} folders={saved.map((v) => v.folder ?? "")} />
        </Modal>
      )}
    </div>
  );
}
