"use client";

// BI dashboards: a workspace/folder-organized library on the left, the selected
// dashboard on the right with a Power-BI-style filter bar, click-to-filter bars,
// per-widget resize/expand, edit-in-place and PUBLIC share URLs.
import { copyText } from "@/lib/clipboard";
import { PageHeader, Skeleton } from "@/components/ui";
import { Button, IconButton, TextInput, Tile, Tag, DismissibleTag } from "@carbon/react";
import { Add, Checkmark, Close, Edit, Filter, Link as LinkIcon, Maximize, TrashCan, View, ChartBar } from "@carbon/icons-react";
import css from "./P/dashboards.module.scss";
import { usePerms } from "@/lib/perms";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { AccessButton } from "@/components/AccessPanel";
import { Select } from "@/components/Select";
import { Modal } from "@/components/overlays";
import { Viz, normalizeWidgetData } from "@/components/viz";
import { useToast } from "@/components/Toast";
import { OpsPanel, OpsEmpty } from "@/components/OpsPanel";
import { api, type AggFn } from "@/lib/api";
import { SaveDestination, WorkspacePicker, getSharedWorkspace, useSharedWorkspace } from "@/components/workspace";
import type { AnalyticsMeta, DashboardData, DashboardRow, DatasetColumn, DatasetDef, SavedViewRow, VizKind, Widget } from "@/lib/types";

const VIZ: { value: VizKind; label: string }[] = [
  { value: "table", label: "Table" }, { value: "bar", label: "Bar" },
  { value: "line", label: "Line" }, { value: "heat", label: "Heatmap" },
  // Overview widgets: headline number, share split, map by province
  { value: "kpi", label: "KPI" }, { value: "donut", label: "Donut" },
  { value: "map", label: "Map" },
  // Hierarchical drill-down: level 1 → level 2 → level 3 → item
  { value: "tree", label: "Tree (collapsible)" }, { value: "treemap", label: "Treemap" },
];

// Filterable fields of the internal warehouse (adhoc widgets); dataset widgets accept
// any of their own column names — those arrive via bar-click cross filtering.
const WAREHOUSE_FILTERS = [
  { key: "fiscalYear", label: "Fiscal year", meta: "fiscalYears" },
  { key: "region", label: "Region", meta: "regions" },
  { key: "category", label: "Category", meta: "categories" },
  { key: "channel", label: "Channel", meta: "channels" },
] as const;

const NAV_KEY = "rs.dashboards.navOpen";

export default function DashboardsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <DashboardsHome />
    </Suspense>
  );
}

function DashboardsHome() {
  const { can } = usePerms();
  const qs = useSearchParams();
  const toast = useToast();
  const [list, setList] = useState<DashboardRow[]>([]);
  const [ws, setWs] = useSharedWorkspace();
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<DashboardRow | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<"closed" | "new" | "edit">("closed");
  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => { setNavOpen(localStorage.getItem(NAV_KEY) !== "0"); }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((v) => { localStorage.setItem(NAV_KEY, v ? "0" : "1"); return !v; });
  }, []);
  const [meta, setMeta] = useState<AnalyticsMeta | null>(null);
  /** Dashboard awaiting delete confirmation (danger modal instead of window.confirm) */
  const [confirmDel, setConfirmDel] = useState<DashboardRow | null>(null);

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
      reload(); setSel(res);
      toast(await copyText(url) ? "Public link copied to clipboard" : "Public link created", "ok");
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

  /** Items for the left nav — dashboard folders become nav groups */
  const navItems = useMemo(() => visible.map((d) => ({
    id: d.id, name: d.name, folder: d.folder, icon: "grid",
    mark: d.shareToken ? "var(--cds-interactive)" : "var(--cds-text-placeholder)",
    badge: d.shareToken ? <Icon name="link" size={11} /> : undefined,
    title: d.shareToken ? `${d.name} · public link` : d.name,
  })), [visible]);

  return (
    <div>
      <PageHeader title="Dashboards"
                  actions={can("RH.DASHBOARD", "create") && (<Button renderIcon={Add} onClick={() => setEditor("new")}>New dashboard</Button>)} />
      <div className={"rh-ops rh-fill" + (navOpen ? "" : " rh-ops--rail-off") + (sel ? " rh-ops--stack rh-ops--detail" : " rh-ops--stack")}>
        <OpsPanel
          items={navItems}
          selectedId={sel?.id ?? null}
          onSelect={(it) => { const d = visible.find((x) => x.id === Number(it.id)); if (d) open(d); }}
          navOpen={navOpen} onToggleNav={toggleNav} storageKey="rs.dashboards.shutFolders"
          placeholder="Find a dashboard"
          query={search} onQuery={setSearch}
          tools={<div style={{ width: "100%" }}><WorkspacePicker value={ws} onChange={setWs} allowAll /></div>}
          foot={`${visible.length} dashboards`}
          emptyText="No dashboards here yet"
        />

        <div className={css.pane}>
          {sel ? (
            <>
              {/* Management buttons sit next to the dashboard they act on */}
              <div className={css.head}>
                <h2 className={`cds--type-heading-03 ${css.title}`}>{sel.name}</h2>
                {sel.shareToken && <Tag size="sm" type="blue" renderIcon={LinkIcon}>Public link</Tag>}
                {can("RH.DASHBOARD", "update") && (<Button kind="tertiary" size="sm" renderIcon={Edit} onClick={() => setEditor("edit")}>Edit</Button>)}
                {sel.shareToken
                  ? <Button kind="ghost" size="sm" renderIcon={Close} onClick={() => unshare(sel)}>Revoke link</Button>
                  : <Button kind="ghost" size="sm" renderIcon={LinkIcon} onClick={() => share(sel)}>Share link</Button>}
                {can("RH.DASHBOARD", "delete") && (<IconButton kind="ghost" size="sm" label="Delete" align="bottom-end" onClick={() => setConfirmDel(sel)}><TrashCan /></IconButton>)}
              </div>
              <div className={css.body}>
                <FilterBar meta={meta} filters={filters} savedParams={parseParams(sel.paramsJson)} onChange={applyFilters} />
                {data
                  ? <WidgetGrid data={data} filters={filters} onResize={resizeWidget} onCross={crossFilter} />
                  : <Skeleton />}
              </div>
            </>
          ) : (
            <OpsEmpty icon="grid" title="Select a dashboard" />
          )}
        </div>
      </div>

      {editor !== "closed" && (
        <DashboardEditor existing={editor === "edit" ? sel : null}
                         seedSource={editor === "new" ? qs.get("addView") : null}
                         onClose={() => setEditor("closed")}
                         onSaved={(d) => { setEditor("closed"); reload(); open(d); }} />
      )}

      {confirmDel && (
        <Modal title={`Delete dashboard ${confirmDel.name}?`} danger width={400} onClose={() => setConfirmDel(null)}
               foot={<>
                 <Button kind="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
                 <Button kind="danger" onClick={() => { const d = confirmDel; setConfirmDel(null); remove(d); }}>Delete</Button>
               </>}>
          <p className="cds--type-body-01">{confirmDel.folder ? `${confirmDel.folder} / ` : ""}{confirmDel.name}</p>
        </Modal>
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
    <Tile className={css.filters}>
      <Filter style={{ color: "var(--cds-icon-secondary)", flex: "none" }} />
      <span className="cds--type-label-01 rh-dim">Filters</span>

      {Object.entries(savedParams).map(([k, v]) => !filters[k] && (
        <Tag key={k} size="sm" type="outline" title="Saved with the dashboard">{k} = {v}</Tag>
      ))}
      {Object.entries(filters).map(([k, v]) => (
        <DismissibleTag key={k} size="sm" type="blue" text={`${k} = ${v}`} title="Remove filter"
                        onClose={() => { const f = { ...filters }; delete f[k]; onChange(f); }} />
      ))}

      <span style={{ flex: 1 }} />
      <Select style={{ width: 160 }} compact value={field} onChange={setField} placeholder="Add filter"
              options={WAREHOUSE_FILTERS.map((f) => ({ value: f.key, label: f.label }))} />
      {fieldDef && (
        <Select style={{ width: 220 }} compact value={filters[field] ?? ""} searchable placeholder={`Pick ${fieldDef.label.toLowerCase()}`}
                options={values.map((v) => ({ value: v, label: v }))}
                onChange={(v) => { onChange({ ...filters, [field]: v }); setField(""); }} />
      )}
      {Object.keys(filters).length > 0 && (
        <Button kind="ghost" size="sm" renderIcon={Close} onClick={() => onChange({})}>Clear</Button>
      )}
    </Tile>
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
      <div className={css.grid}>
        {data.widgets.map((w, i) => {
          const full = (w.w ?? 1) === 2;
          // bar-click cross filter: server hint (pivot) or the first dimension column
          const CLICKABLE = ["bar", "tree", "treemap"];
          const firstCol = CLICKABLE.includes(w.viz) && w.data ? normalizeWidgetData(w.data).columns?.[0] : undefined;
          const filterable = !CLICKABLE.includes(w.viz) ? undefined
            : w.filterField ?? (firstCol && firstCol !== "Dimension" && firstCol !== "dimension" ? firstCol : undefined);
          return (
            <Tile key={i} className={css.widget} style={{ gridColumn: full ? "1 / -1" : undefined }}>
              <div className={css.wHead}>
                <h3 className="cds--type-heading-compact-01" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.title}</h3>
                <Tag size="sm" type="cool-gray">{w.viz}</Tag>
                <IconButton kind="ghost" size="sm" align="bottom" label={full ? "Shrink to half width" : "Expand to full width"}
                            onClick={() => onResize(i, full ? 1 : 2)}>
                  <Maximize style={full ? { transform: "rotate(180deg)" } : undefined} />
                </IconButton>
                <IconButton kind="ghost" size="sm" align="bottom-end" label="Expand" onClick={() => setZoom(i)}><View /></IconButton>
              </div>
              <div className={css.wBody}>
                {w.error
                  ? <div className="cds--type-body-compact-01" style={{ color: "var(--cds-text-error)", padding: 16 }}>{w.error}</div>
                  : <Viz viz={w.viz} data={w.data}
                         onSelect={filterable ? (label) => onCross(filterable, label) : undefined}
                         selected={filterable ? filters[filterable] : undefined} />}
              </div>
            </Tile>
          );
        })}
        {data.widgets.length === 0 && <div className={css.empty}>Dashboard has no widgets</div>}
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
    const bad = widgets.find((w) => w.kind === "dataset" && !((w.payload as DatasetPayload)?.measures?.length || (w.payload as DatasetPayload)?.dims?.length));
    if (bad) { toast(`"${bad.title}": pick at least one dimension or measure`, "error"); return; }
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
      foot={<>{existing && <AccessButton type="DASHBOARD" id={existing.id} name={existing.name} />}
            <Button kind="secondary" onClick={onClose}>Cancel</Button>
            <Button disabled={saving} onClick={save}>{existing ? "Save changes" : "Create"}</Button></>}>
      <div className={css.form}>
        <div className={css.nameRow}>
          <TextInput id="dash-name" labelText="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Quarterly overview" />
          <Select label="Fiscal year param" value={fiscalYear} onChange={setFiscalYear} placeholder="None"
                  options={[{ value: "", label: "None" }, { value: "2026", label: "2026" }, { value: "2025", label: "2025" }, { value: "2024", label: "2024" }]} />
        </div>

        <SaveDestination workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} folder={folder} setFolder={setFolder} folders={[]} />

        <div className={css.addRow}>
          <Select label="Add widget (from saved views & datasets)" value={source} onChange={setSource} options={sourceOptions}
                  placeholder="Pick a saved view or dataset" searchable
                  note={sourceOptions.length === 0 ? "No saved pivot views, ad-hoc queries or datasets yet" : undefined} />
          <Select style={{ width: 140 }} label="Chart" value={viz} onChange={(v) => setViz(v as VizKind)} options={VIZ.map((v) => ({ value: v.value, label: v.label }))} />
          <Button kind="tertiary" renderIcon={Add} onClick={() => addWidget()}>Add</Button>
        </div>

        {widgets.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {widgets.map((w, i) => (
              <div key={i}>
                <div className={css.wRow}>
                  <ChartBar style={{ color: "var(--cds-icon-secondary)", flex: "none" }} />
                  <span className="cds--type-body-compact-01" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.title}</span>
                  <Select style={{ width: 140 }} compact value={w.viz} onChange={(v) => setWidgets((ws) => ws.map((x, j) => j === i ? { ...x, viz: v as VizKind } : x))}
                          options={VIZ.map((v) => ({ value: v.value, label: v.label }))} />
                  <Button kind="ghost" size="sm" title="Toggle width"
                          onClick={() => setWidgets((ws) => ws.map((x, j) => j === i ? { ...x, w: (x.w ?? 1) === 2 ? 1 : 2 } : x))}>
                    {(w.w ?? 1) === 2 ? "Full" : "Half"}
                  </Button>
                  <IconButton kind="ghost" size="sm" align="left" label="Remove widget" onClick={() => setWidgets((ws) => ws.filter((_, j) => j !== i))}><Close /></IconButton>
                </div>
                {w.kind === "dataset" && w.datasetId != null && (
                  <DatasetWidgetFields datasetId={w.datasetId}
                    value={(w.payload ?? {}) as DatasetPayload}
                    onChange={(p) => setWidgets((ws) => ws.map((x, j) => j === i ? { ...x, payload: p } : x))} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

type DatasetPayload = { dims: string[]; measures: string[]; filters: Record<string, string>; agg?: AggFn };

const AGG_OPTIONS: { value: AggFn; label: string }[] = [
  { value: "sum", label: "Sum" }, { value: "avg", label: "Average" }, { value: "min", label: "Min" },
  { value: "max", label: "Max" }, { value: "count", label: "Count" },
];

/** Dimensions (group by) and measures (summed) of a dataset widget, from the dataset's fields. */
function DatasetWidgetFields({ datasetId, value, onChange }: {
  datasetId: number; value: DatasetPayload; onChange: (p: DatasetPayload) => void;
}) {
  const [fields, setFields] = useState<DatasetColumn[] | null>(null);
  useEffect(() => { api.datasetFields(datasetId).then(setFields).catch(() => setFields([])); }, [datasetId]);
  const dims = value.dims ?? [], measures = value.measures ?? [];
  const toggle = (key: "dims" | "measures", name: string) => {
    const cur = key === "dims" ? dims : measures;
    onChange({ dims, measures, filters: value.filters ?? {}, agg: value.agg, [key]: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] });
  };
  if (!fields) return <div className={css.dsFields}><Skeleton rows={2} /></div>;
  const row = (label: string, key: "dims" | "measures", list: DatasetColumn[], on: string[]) => (
    <div className={css.fieldRow}>
      <span className={`cds--type-label-01 ${css.fieldLabel}`}>{label}</span>
      {list.length === 0 && <span className="cds--type-label-01 rh-dim">None</span>}
      {list.map((f) => (
        <Button key={f.name} kind={on.includes(f.name) ? "primary" : "ghost"} size="sm"
                aria-pressed={on.includes(f.name)} onClick={() => toggle(key, f.name)}>{f.name}</Button>
      ))}
    </div>
  );
  return (
    <div className={css.dsFields}>
      {row("Group by", "dims", fields.filter((f) => f.kind === "dim"), dims)}
      <div className={css.fieldRow}>
        <span className={`cds--type-label-01 ${css.fieldLabel}`}>Aggregation</span>
        <Select style={{ width: 160 }} compact value={value.agg ?? "sum"} options={AGG_OPTIONS}
                onChange={(v) => onChange({ dims, measures, filters: value.filters ?? {}, agg: v as AggFn })} />
      </div>
      {row((AGG_OPTIONS.find((o) => o.value === (value.agg ?? "sum"))?.label ?? "Sum") + " of", "measures", fields.filter((f) => f.kind === "measure"), measures)}
    </div>
  );
}
