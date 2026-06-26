"use client";

// BI dashboards: a workspace/folder-organized library on the left, the selected
// dashboard on the right with a Power-BI-style filter bar, click-to-filter bars,
// per-widget resize/expand, edit-in-place and PUBLIC share URLs.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/Select";
import { Modal } from "@/components/overlays";
import { Viz, normalizeWidgetData } from "@/components/viz";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { FolderHead, SaveDestination, WorkspacePicker, getSharedWorkspace, groupByFolder, useSharedWorkspace } from "@/components/workspace";
import type { AnalyticsMeta, DashboardData, DashboardRow, DatasetDef, SavedViewRow, VizKind, Widget } from "@/lib/types";

const VIZ: { value: VizKind; label: string }[] = [
  { value: "table", label: "Table" }, { value: "bar", label: "Bar" },
  { value: "line", label: "Line" }, { value: "heat", label: "Heatmap" },
];

// Filterable fields of the internal warehouse (adhoc widgets); dataset widgets accept
// any of their own column names — those arrive via bar-click cross filtering.
const WAREHOUSE_FILTERS = [
  { key: "fiscalYear", label: "Fiscal year", meta: "fiscalYears" },
  { key: "region", label: "Region", meta: "regions" },
  { key: "category", label: "Category", meta: "categories" },
  { key: "channel", label: "Channel", meta: "channels" },
] as const;

export default function DashboardsPage() {
  return (
    <Suspense fallback={<div className="empty"><span className="spin" /></div>}>
      <DashboardsHome />
    </Suspense>
  );
}

function DashboardsHome() {
  const qs = useSearchParams();
  const toast = useToast();
  const [list, setList] = useState<DashboardRow[]>([]);
  const [ws, setWs] = useSharedWorkspace();
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<DashboardRow | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<"closed" | "new" | "edit">("closed");
  const [meta, setMeta] = useState<AnalyticsMeta | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const reload = useCallback(() => api.dashboards().then(setList).catch(() => {}), []);
  useEffect(() => { reload(); api.analyticsMeta().then(setMeta).catch(() => {}); }, [reload]);
  // bridge from a saved view's "Use in a dashboard…" menu
  useEffect(() => {
    if (qs.get("addView")) setEditor("new");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => list
    .filter((d) => !ws || d.workspaceId === ws)
    .filter((d) => !search || d.name.toLowerCase().includes(search.toLowerCase()) || (d.folder ?? "").toLowerCase().includes(search.toLowerCase())),
  [list, ws, search]);

  const fetchData = useCallback((d: DashboardRow, f: Record<string, string>) => {
    api.dashboardData(d.id, f).then(setData)
      .catch((e) => toast(e instanceof Error ? e.message : "Load failed", "error"));
  }, [toast]);

  const open = useCallback((d: DashboardRow) => {
    setSel(d); setData(null); setFilters({});
    fetchData(d, {});
  }, [fetchData]);

  useEffect(() => { if (visible.length && !sel) open(visible[0]); }, [visible, sel, open]);

  function applyFilters(f: Record<string, string>) {
    setFilters(f);
    if (sel) { setData(null); fetchData(sel, f); }
  }

  async function share(d: DashboardRow) {
    try {
      const res = await api.shareDashboard(d.id);
      const url = `${window.location.origin}${window.location.pathname.replace(/\/dashboards.*/, "")}/share/${res.shareToken}`;
      await navigator.clipboard.writeText(url).catch(() => {});
      toast("Public link copied to clipboard", "ok");
      reload(); setSel(res);
    } catch (e) { toast(e instanceof Error ? e.message : "Share failed", "error"); }
  }

  async function unshare(d: DashboardRow) {
    try {
      await api.unshareDashboard(d.id);
      toast("Public link revoked", "ok");
      setSel({ ...d, shareToken: null });
      reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
  }

  async function remove(d: DashboardRow) {
    if (!window.confirm(`Delete dashboard ${d.name}?`)) return;
    await api.deleteDashboard(d.id).catch(() => {});
    setSel(null); setData(null); reload();
  }

  /** Persist a widget resize (half ↔ full width) into layout_json. */
  async function resizeWidget(idx: number, w: number) {
    if (!sel) return;
    try {
      const layout = JSON.parse(sel.layoutJson) as { widgets: Widget[] };
      if (!layout.widgets[idx]) return;
      layout.widgets[idx].w = w;
      const updated = await api.updateDashboard(sel.id, {
        name: sel.name, layoutJson: JSON.stringify(layout),
        paramsJson: sel.paramsJson ?? undefined,
        workspaceId: sel.workspaceId ?? undefined, folder: sel.folder ?? undefined,
      });
      setSel(updated);
      setData((d) => d ? { ...d, widgets: d.widgets.map((x, i) => i === idx ? { ...x, w } : x) } : d);
      reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Resize failed", "error"); }
  }

  /** Click-to-filter: clicking a bar filters the whole dashboard by that value. */
  function crossFilter(field: string, label: string) {
    const f = { ...filters };
    if (f[field] === label) delete f[field]; else f[field] = label;
    applyFilters(f);
  }

  const groups = groupByFolder(visible);

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboards</h1>
          <div className="page-sub">Compose saved views &amp; datasets into shareable, interactive BI dashboards</div>
        </div>
        <div className="page-actions">
          {sel && <button className="btn" onClick={() => setEditor("edit")}><Icon name="edit" size={14} />Edit</button>}
          {sel && (sel.shareToken
            ? <button className="btn" onClick={() => unshare(sel)}><Icon name="x" size={14} />Revoke public link</button>
            : <button className="btn" onClick={() => share(sel)}><Icon name="link" size={14} />Share public link</button>)}
          {sel && <button className="btn" onClick={() => remove(sel)}><Icon name="x" size={14} />Delete</button>}
          <button className="btn primary" onClick={() => setEditor("new")}><Icon name="plus" size={16} />New dashboard</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "248px 1fr", gap: 16, alignItems: "start" }}>
        {/* library: workspace → folders → dashboards */}
        <div className="card" style={{ position: "sticky", top: 0 }}>
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <WorkspacePicker value={ws} onChange={setWs} allowAll />
            <input className="input" style={{ height: 32, fontSize: 12 }} placeholder="Search dashboards…"
                   value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div style={{ padding: "0 8px 10px", maxHeight: "calc(100vh - 240px)", overflow: "auto" }}>
            {groups.map((g) => (
              <div key={g.folder || "__root"}>
                {g.folder !== "" && (
                  <FolderHead name={g.folder} count={g.items.length} open={!closed[g.folder]}
                              onToggle={() => setClosed((c) => ({ ...c, [g.folder]: !c[g.folder] }))} />
                )}
                {(g.folder === "" || !closed[g.folder]) && g.items.map((d) => (
                  <div key={d.id} onClick={() => open(d)}
                       style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", paddingLeft: g.folder ? 28 : 9,
                                borderRadius: 8, cursor: "pointer",
                                background: sel?.id === d.id ? "var(--accent-weak)" : "transparent" }}>
                    <Icon name="grid" size={13} style={{ color: sel?.id === d.id ? "var(--accent)" : "var(--ink-4)", flex: "none" }} />
                    <span style={{ fontSize: 12, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                   color: sel?.id === d.id ? "var(--accent)" : "var(--ink)", fontWeight: sel?.id === d.id ? 600 : 400 }}>{d.name}</span>
                    {d.shareToken && <Icon name="link" size={11} style={{ color: "var(--accent)", opacity: 0.7, flex: "none" }} />}
                  </div>
                ))}
              </div>
            ))}
            {visible.length === 0 && <div style={{ fontSize: 11.5, color: "var(--ink-4)", padding: 9 }}>No dashboards here yet — create one from your saved views or datasets.</div>}
          </div>
        </div>

        {/* selected dashboard */}
        <div style={{ minWidth: 0 }}>
          {sel && (
            <FilterBar meta={meta} filters={filters} savedParams={parseParams(sel.paramsJson)} onChange={applyFilters} />
          )}
          {sel && (data
            ? <WidgetGrid data={data} filters={filters} onResize={resizeWidget} onCross={crossFilter} />
            : <div className="empty" style={{ padding: 50 }}><span className="spin" /></div>)}
          {!sel && <div className="empty" style={{ padding: 60 }}>Select or create a dashboard</div>}
        </div>
      </div>

      {editor !== "closed" && (
        <DashboardEditor existing={editor === "edit" ? sel : null}
                         seedSource={editor === "new" ? qs.get("addView") : null}
                         onClose={() => setEditor("closed")}
                         onSaved={(d) => { setEditor("closed"); reload(); open(d); }} />
      )}
    </div>
  );
}

function parseParams(paramsJson: string | null): Record<string, string> {
  try { return paramsJson ? JSON.parse(paramsJson) : {}; } catch { return {}; }
}

/** Power-BI-style global filter bar: saved params + runtime filters as removable chips. */
function FilterBar({ meta, filters, savedParams, onChange }: {
  meta: AnalyticsMeta | null;
  filters: Record<string, string>;
  savedParams: Record<string, string>;
  onChange: (f: Record<string, string>) => void;
}) {
  const [field, setField] = useState("");
  const fieldDef = WAREHOUSE_FILTERS.find((f) => f.key === field);
  const values: string[] = fieldDef && meta ? ((meta as unknown as Record<string, unknown>)[fieldDef.meta] as string[] ?? []) : [];
  return (
    <div className="card" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14, padding: "10px 14px" }}>
      <Icon name="filter" size={14} style={{ color: "var(--accent)", flex: "none" }} />
      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)" }}>Filters</span>

      {Object.entries(savedParams).map(([k, v]) => !filters[k] && (
        <span key={k} className="tag-pill" style={{ fontSize: 10.5, opacity: 0.8 }} title="Saved with the dashboard">{k} = {v}</span>
      ))}
      {Object.entries(filters).map(([k, v]) => (
        <span key={k} className="tag-pill" style={{ fontSize: 10.5, background: "var(--accent-weak)", borderColor: "var(--accent-line)", color: "var(--accent)" }}>
          {k} = {v}
          <Icon name="x" size={11} style={{ cursor: "pointer" }} onClick={() => { const f = { ...filters }; delete f[k]; onChange(f); }} />
        </span>
      ))}

      <span style={{ flex: 1 }} />
      <Select style={{ width: 150 }} value={field} onChange={setField} placeholder="+ Add filter"
              options={WAREHOUSE_FILTERS.map((f) => ({ value: f.key, label: f.label }))} />
      {fieldDef && (
        <Select style={{ width: 220 }} value={filters[field] ?? ""} searchable placeholder={`Pick ${fieldDef.label.toLowerCase()}…`}
                options={values.map((v) => ({ value: v, label: v }))}
                onChange={(v) => { onChange({ ...filters, [field]: v }); setField(""); }} />
      )}
      {Object.keys(filters).length > 0 && (
        <button className="btn sm ghost" onClick={() => onChange({})}><Icon name="x" size={12} />Clear</button>
      )}
    </div>
  );
}

function WidgetGrid({ data, filters, onResize, onCross }: {
  data: DashboardData;
  filters: Record<string, string>;
  onResize: (idx: number, w: number) => void;
  onCross: (field: string, label: string) => void;
}) {
  const [zoom, setZoom] = useState<number | null>(null);   // expanded (lightbox) widget
  return (
    <>
      <div className="dash-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
        {data.widgets.map((w, i) => {
          const full = (w.w ?? 1) === 2;
          // bar-click cross filter: server hint (pivot) or the first dimension column
          const firstCol = w.viz === "bar" && w.data ? normalizeWidgetData(w.data).columns?.[0] : undefined;
          const filterable = w.viz !== "bar" ? undefined
            : w.filterField ?? (firstCol && firstCol !== "Dimension" && firstCol !== "dimension" ? firstCol : undefined);
          return (
            <div key={i} className="card" style={{ overflow: "hidden", gridColumn: full ? "1 / -1" : undefined }}>
              <div className="card-head" style={{ padding: "10px 14px" }}>
                <Icon name="chart" size={14} style={{ color: "var(--accent)" }} />
                <h3 style={{ fontSize: 12.5, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.title}</h3>
                <span className="tag-pill" style={{ fontSize: 9.5 }}>{w.viz}</span>
                <span title={full ? "Shrink to half width" : "Expand to full width"}
                      onClick={() => onResize(i, full ? 1 : 2)}
                      style={{ cursor: "pointer", color: "var(--ink-4)", display: "inline-flex" }}>
                  <Icon name={full ? "arrowDown" : "arrowUp"} size={13} style={{ transform: "rotate(45deg)" }} />
                </span>
                <span title="Expand" onClick={() => setZoom(i)} style={{ cursor: "pointer", color: "var(--ink-4)", display: "inline-flex" }}>
                  <Icon name="eye" size={13} />
                </span>
              </div>
              <div style={{ padding: 10 }}>
                {w.error
                  ? <div className="empty" style={{ color: "var(--red)", fontSize: 12 }}>{w.error}</div>
                  : <Viz viz={w.viz} data={w.data}
                         onSelect={filterable ? (label) => onCross(filterable, label) : undefined}
                         selected={filterable ? filters[filterable] : undefined} />}
              </div>
            </div>
          );
        })}
        {data.widgets.length === 0 && <div className="empty" style={{ gridColumn: "1 / -1", padding: 40 }}>Dashboard has no widgets</div>}
      </div>

      {zoom !== null && data.widgets[zoom] && (
        <Modal title={data.widgets[zoom].title} width={980} onClose={() => setZoom(null)}>
          <Viz viz={data.widgets[zoom].viz} data={data.widgets[zoom].data} />
        </Modal>
      )}
    </>
  );
}

function DashboardEditor({ existing, seedSource, onClose, onSaved }: {
  existing: DashboardRow | null;
  seedSource?: string | null;
  onClose: () => void;
  onSaved: (d: DashboardRow) => void;
}) {
  const toast = useToast();
  const init = existing ? parseParams(existing.paramsJson) : {};
  const [name, setName] = useState(existing?.name ?? "");
  const [fiscalYear, setFiscalYear] = useState(init.fiscalYear ?? "");
  const [workspaceId, setWorkspaceId] = useState(() => existing?.workspaceId ?? (getSharedWorkspace() || 1));
  const [folder, setFolder] = useState(existing?.folder ?? "");
  const [widgets, setWidgets] = useState<Widget[]>(() => {
    try { return existing ? (JSON.parse(existing.layoutJson) as { widgets: Widget[] }).widgets : []; } catch { return []; }
  });
  const [pivotViews, setPivotViews] = useState<SavedViewRow[]>([]);
  const [adhocViews, setAdhocViews] = useState<SavedViewRow[]>([]);
  const [datasets, setDatasets] = useState<DatasetDef[]>([]);
  const [source, setSource] = useState("");
  const [viz, setViz] = useState<VizKind>("bar");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.savedViews("pivot").then(setPivotViews).catch(() => {});
    api.savedViews("adhoc").then(setAdhocViews).catch(() => {});
    api.datasets().then(setDatasets).catch(() => {});
  }, []);

  const sourceOptions = [
    ...pivotViews.map((v) => ({ value: `pivot:${v.id}`, label: `Pivot · ${v.name}`, sub: v.folder ?? undefined })),
    ...adhocViews.map((v) => ({ value: `adhoc:${v.id}`, label: `Ad-hoc · ${v.name}`, sub: v.folder ?? undefined })),
    ...datasets.map((d) => ({ value: `dataset:${d.id}`, label: `Dataset · ${d.name}`, sub: d.description ?? undefined })),
  ];

  // seed from "Use in a dashboard…": auto-add the view once the lists arrive
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !seedSource) return;
    const [k, idStr] = seedSource.split(":");
    const pool = k === "pivot" ? pivotViews : k === "adhoc" ? adhocViews : [];
    if (!pool.find((x) => x.id === Number(idStr))) return;
    seeded.current = true;
    setSource(seedSource);
    addWidget(seedSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivotViews, adhocViews]);

  function addWidget(src?: string) {
    const use = src ?? source;
    if (!use) { toast("Pick a source", "error"); return; }
    const [kind, idStr] = use.split(":");
    const id = Number(idStr);
    if (kind === "pivot" || kind === "adhoc") {
      const v = (kind === "pivot" ? pivotViews : adhocViews).find((x) => x.id === id);
      if (!v) return;
      let payload: unknown;
      try {
        const p = JSON.parse(v.payload);
        // adhoc saved payload is {dataset,picked,filters} from the builder → convert to AdhocRequest
        payload = kind === "adhoc"
          ? { dataset: "fact", fields: (p.picked as string[]).map((f: string) => ({ year: "fiscalYear" } as Record<string, string>)[f] ?? f), filters: p.filters }
          : p;
      } catch { toast("Saved view payload invalid", "error"); return; }
      setWidgets((w) => [...w, { title: v.name, viz, kind: kind as "pivot" | "adhoc", payload }]);
    } else {
      const d = datasets.find((x) => x.id === id);
      if (!d) return;
      // dataset widget: aggregate everything numeric grouped by the first dim
      setWidgets((w) => [...w, { title: d.name, viz, kind: "dataset", datasetId: d.id, payload: { dims: [], measures: [], filters: {} } }]);
    }
  }

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    if (widgets.length === 0) { toast("Add at least one widget", "error"); return; }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        layoutJson: JSON.stringify({ widgets }),
        paramsJson: fiscalYear ? JSON.stringify({ fiscalYear }) : undefined,
        workspaceId, folder: folder.trim() || undefined,
      };
      const d = existing ? await api.updateDashboard(existing.id, body) : await api.createDashboard(body);
      toast(existing ? "Dashboard updated" : "Dashboard created", "ok");
      onSaved(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
      setSaving(false);
    }
  }

  return (
    <Modal title={existing ? `Edit dashboard — ${existing.name}` : "New dashboard"} width={640} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? <span className="spin" /> : <Icon name="check" size={15} />}{existing ? "Save changes" : "Create"}</button></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12 }}>
          <div className="field"><label>Name</label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Quarterly overview" /></div>
          <div className="field"><label>Fiscal year param</label>
            <Select value={fiscalYear} onChange={setFiscalYear} placeholder="— none —"
                    options={[{ value: "", label: "— none —" }, { value: "2026", label: "2026" }, { value: "2025", label: "2025" }, { value: "2024", label: "2024" }]} />
          </div>
        </div>

        <SaveDestination workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} folder={folder} setFolder={setFolder} folders={[]} />

        <div className="field"><label>Add widget (from saved views &amp; datasets)</label>
          <div style={{ display: "flex", gap: 7 }}>
            <Select style={{ flex: 1 }} value={source} onChange={setSource} options={sourceOptions} placeholder="Pick a saved view or dataset…" searchable />
            <Select style={{ width: 120 }} value={viz} onChange={(v) => setViz(v as VizKind)} options={VIZ.map((v) => ({ value: v.value, label: v.label }))} />
            <button className="btn sm" style={{ height: 38 }} onClick={() => addWidget()}><Icon name="plus" size={14} />Add</button>
          </div>
          {sourceOptions.length === 0 && <div style={{ fontSize: 11.5, color: "var(--ink-4)", marginTop: 6 }}>Save a pivot view (Workbench), an ad-hoc query, or create a dataset first.</div>}
        </div>

        {widgets.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {widgets.map((w, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 11px", borderRadius: 9, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <Icon name="chart" size={14} style={{ color: "var(--accent)" }} />
                <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.title}</span>
                <Select style={{ width: 96 }} value={w.viz} onChange={(v) => setWidgets((ws) => ws.map((x, j) => j === i ? { ...x, viz: v as VizKind } : x))}
                        options={VIZ.map((v) => ({ value: v.value, label: v.label }))} />
                <button className="btn sm ghost" style={{ fontSize: 10.5 }} title="Toggle width"
                        onClick={() => setWidgets((ws) => ws.map((x, j) => j === i ? { ...x, w: (x.w ?? 1) === 2 ? 1 : 2 } : x))}>
                  {(w.w ?? 1) === 2 ? "Full" : "Half"}
                </button>
                <Icon name="x" size={13} style={{ cursor: "pointer", color: "var(--ink-4)" }} onClick={() => setWidgets((ws) => ws.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
