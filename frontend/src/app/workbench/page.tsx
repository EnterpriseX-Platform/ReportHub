"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { fmtTHB } from "@/lib/format";
import { WB_DIMENSIONS, WB_MEASURES } from "@/lib/facts";
import { Modal } from "@/components/overlays";
import { api } from "@/lib/api";
import { SavedViewList, SaveDestination, WorkspacePicker, getSharedWorkspace, useSharedWorkspace } from "@/components/workspace";
import type { AnalyticsMeta, PivotResponse, SavedViewRow } from "@/lib/types";

interface PivotRow { label: string; depth: number; vals: Record<string, number>; rowTotal: number; isGroup: boolean }
interface Pivot { colKeys: string[]; colDim: string | undefined; rows: PivotRow[]; colTotals: Record<string, number>; grand: number; maxCell: number }

const EMPTY_PIVOT: Pivot = { colKeys: [], colDim: undefined, rows: [], colTotals: {}, grand: 0, maxCell: 1 };

export default function WorkbenchPage() {
  const toast = useToast();
  const [rows, setRows] = useState<string[]>(["region"]);
  const [cols, setCols] = useState<string[]>(["year"]);
  const [measure, setMeasure] = useState("sales");
  const [heat, setHeat] = useState(true);
  const [pivot, setPivot] = useState<Pivot>(EMPTY_PIVOT);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [meta, setMeta] = useState<AnalyticsMeta | null>(null);
  const [views, setViews] = useState<SavedViewRow[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [ws, setWs] = useSharedWorkspace();              // shared across analytics pages

  const reloadViews = useCallback(() => {
    api.savedViews("pivot", ws || undefined).then(setViews).catch(() => {});
  }, [ws]);
  useEffect(() => {
    api.analyticsMeta().then(setMeta).catch(() => {});
    reloadViews();
  }, [reloadViews]);

  function applyView(v: SavedViewRow) {
    try {
      const p = JSON.parse(v.payload) as { rows: string[]; cols: string[]; measure: string };
      setRows(p.rows); setCols(p.cols); setMeasure(p.measure);
      toast(`Loaded "${v.name}"`, "ok");
    } catch { toast("Invalid payload", "error"); }
  }

  function assign(id: string, zone: "rows" | "cols") {
    setRows((r) => r.filter((x) => x !== id));
    setCols((c) => c.filter((x) => x !== id));
    if (zone === "rows") setRows((r) => [...r.filter((x) => x !== id), id].slice(-2));
    if (zone === "cols") setCols([id]);
  }
  function remove(id: string) { setRows((r) => r.filter((x) => x !== id)); setCols((c) => c.filter((x) => x !== id)); }

  // Server-side pivot. Requires at least one row dim and exactly one column dim.
  const fetchPivot = useCallback(async () => {
    if (rows.length === 0 || cols.length !== 1) { setPivot(EMPTY_PIVOT); return; }
    setLoading(true);
    try {
      const res: PivotResponse = await api.pivot({ rows, cols, measure });
      const maxCell = Math.max(
        ...res.rows.flatMap((r) => res.colKeys.map((ck) => r.vals[ck] || 0)), 1,
      );
      setPivot({ colKeys: res.colKeys, colDim: cols[0], rows: res.rows, colTotals: res.colTotals, grand: res.grand, maxCell });
    } catch (e) {
      setPivot(EMPTY_PIVOT);
      toast(e instanceof Error ? e.message : "Pivot failed", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, measure]);

  useEffect(() => { fetchPivot(); }, [fetchPivot]);

  async function exportExcel() {
    if (rows.length === 0 || cols.length !== 1) { toast("Pick a row and a column dimension first", "error"); return; }
    setExporting(true);
    try {
      await api.exportPivot({ rows, cols, measure }, "pivot.xlsx");
      toast("Pivot exported to Excel", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed", "error");
    } finally {
      setExporting(false);
    }
  }

  const measureLabel = WB_MEASURES.find((m) => m.id === measure)?.label;

  return (
    <div className="fade-in">
      <div className="page-head">
        <div><h1 className="page-title">Analytics Workbench</h1><div className="page-sub">Pivot &amp; explore the fact warehouse — like Excel, straight from the database</div></div>
        <div className="page-actions">
          <button className="btn" onClick={() => setShowSave(true)}><Icon name="star" size={15} />Save view</button>
          <button className="btn primary" disabled={exporting} onClick={exportExcel}>{exporting ? <span className="spin" /> : <Icon name="download" size={16} />}Export Excel</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, position: "sticky", top: 0 }}>
          <div className="card card-pad">
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <Icon name="datasource" size={15} style={{ color: "var(--accent)", marginRight: 7 }} />
              <b style={{ fontSize: 13 }}>fact</b>
              <span className="tag-pill" style={{ marginLeft: "auto", fontSize: 10.5 }}>{meta ? `${meta.factCount} rows` : "…"}</span>
            </div>
            <div className="section-label">Dimensions</div>
            {WB_DIMENSIONS.map((d) => (
              <FieldChip key={d.id} field={d} placed={rows.includes(d.id) ? "rows" : cols.includes(d.id) ? "cols" : null} onAssign={assign} />
            ))}
            <div className="section-label" style={{ marginTop: 14 }}>Measures</div>
            {WB_MEASURES.map((m) => (
              <div key={m.id} onClick={() => setMeasure(m.id)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (measure === m.id ? "var(--accent-line)" : "var(--line)"), background: measure === m.id ? "var(--accent-weak)" : "var(--surface)", marginBottom: 5 }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, background: "var(--violet-bg)", color: "var(--violet)", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, flex: "none" }}>Σ</span>
                <span style={{ fontSize: 12.5, flex: 1 }}>{m.label}</span>
                {measure === m.id && <Icon name="check" size={14} style={{ color: "var(--accent)" }} />}
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <div className="section-label">My views</div>
            <WorkspacePicker value={ws} onChange={setWs} allowAll style={{ marginBottom: 8 }} />
            <SavedViewList views={views} onLoad={applyView} onChanged={reloadViews} />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card card-pad" style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "center" }}>
            <Shelf label="Rows" icon="registry" items={rows} onRemove={remove} />
            <Shelf label="Columns" icon="table" items={cols} onRemove={remove} />
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span className="section-label" style={{ margin: 0 }}>Display</span>
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, cursor: "pointer" }}>
                <span onClick={() => setHeat((h) => !h)} style={{ width: 32, height: 18, borderRadius: 20, background: heat ? "var(--accent)" : "var(--line-strong)", position: "relative", transition: ".15s", flex: "none" }}>
                  <span style={{ position: "absolute", top: 2, left: heat ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: ".15s" }} />
                </span>
                Heatmap
              </label>
            </div>
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            <div className="card-head" style={{ background: "var(--surface-2)" }}>
              <Icon name="workbench" size={16} style={{ color: "var(--accent)" }} />
              <div style={{ flex: 1 }}><h3 style={{ fontSize: 13 }}>{measureLabel} by {rows.map((r) => WB_DIMENSIONS.find((d) => d.id === r)?.label).join(" › ")}{cols.length ? " × " + WB_DIMENSIONS.find((d) => d.id === cols[0])?.label : ""}</h3></div>
              {loading && <span className="spin" style={{ marginRight: 8 }} />}
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>unit: THB million</span>
            </div>
            <div style={{ overflow: "auto", maxHeight: "calc(100vh - 320px)" }}>
              {rows.length === 0 || cols.length !== 1
                ? <div className="empty" style={{ padding: 40 }}>Pick one row dimension and one column dimension to build the pivot</div>
                : <PivotTable pivot={pivot} heat={heat} />}
            </div>
          </div>
        </div>
      </div>

      {showSave && (
        <SaveViewModal
          folders={views.map((v) => v.folder ?? "")}
          onClose={() => setShowSave(false)}
          onSave={async (name, workspaceId, folder) => {
            try {
              await api.saveView({ kind: "pivot", name, workspaceId, folder: folder || undefined, payload: JSON.stringify({ rows, cols, measure }) });
              toast("View saved", "ok");
              setShowSave(false);
              reloadViews();
            } catch (e) {
              toast(e instanceof Error ? e.message : "Save failed", "error");
            }
          }}
        />
      )}
    </div>
  );
}

function SaveViewModal({ folders, onClose, onSave }: { folders: string[]; onClose: () => void; onSave: (name: string, workspaceId: number, folder: string) => void }) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState(() => getSharedWorkspace() || 1);
  const [folder, setFolder] = useState("");
  return (
    <Modal title="Save pivot view" width={480} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), workspaceId, folder.trim())}><Icon name="star" size={15} />Save</button></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div className="field"><label>View name</label>
          <input className="input" autoFocus placeholder="e.g. Sales by region × year" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <SaveDestination workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} folder={folder} setFolder={setFolder} folders={folders} />
      </div>
    </Modal>
  );
}

function FieldChip({ field, placed, onAssign }: { field: { id: string; label: string }; placed: string | null; onAssign: (id: string, zone: "rows" | "cols") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} style={{ position: "relative", marginBottom: 5 }}>
      <div onClick={() => setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (placed ? "var(--accent-line)" : "var(--line)"), background: placed ? "var(--accent-weak)" : "var(--surface)" }}>
        <Icon name="drag" size={14} style={{ color: "var(--ink-4)" }} />
        <span style={{ fontSize: 12.5, flex: 1 }}>{field.label}</span>
        {placed && <span className="chip blue" style={{ height: 18, textTransform: "uppercase", fontSize: 9.5 }}>{placed}</span>}
      </div>
      {open && (
        <div className="menu" style={{ top: 38, right: "auto", left: 0, minWidth: 150 }}>
          <div className="menu-item" onClick={() => { onAssign(field.id, "rows"); setOpen(false); }}><Icon name="registry" size={15} />Add to Rows</div>
          <div className="menu-item" onClick={() => { onAssign(field.id, "cols"); setOpen(false); }}><Icon name="table" size={15} />Add to Columns</div>
        </div>
      )}
    </div>
  );
}

function Shelf({ label, icon, items, onRemove }: { label: string; icon: IconName; items: string[]; onRemove: (id: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="section-label" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}><Icon name={icon} size={13} />{label}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", minHeight: 30, alignItems: "center", padding: "4px 6px", borderRadius: 8, border: "1px dashed var(--line-strong)", background: "var(--surface-2)" }}>
        {items.length === 0 && <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>—</span>}
        {items.map((id) => (
          <span key={id} className="tag-pill" style={{ background: "var(--accent-weak)", borderColor: "var(--accent-line)", color: "var(--accent)" }}>
            {WB_DIMENSIONS.find((d) => d.id === id)?.label}
            <Icon name="x" size={12} style={{ cursor: "pointer" }} onClick={() => onRemove(id)} />
          </span>
        ))}
      </div>
    </div>
  );
}


function PivotTable({ pivot, heat }: { pivot: Pivot; heat: boolean }) {
  const { colKeys, colDim, rows, colTotals, grand, maxCell } = pivot;
  const showCols = !!colDim && colKeys[0] !== "__total";
  const heatBg = (v: number) => (!heat || !v ? "transparent" : `color-mix(in srgb, var(--accent) ${Math.round(Math.min(1, v / maxCell) * 70)}%, transparent)`);
  const heatInk = (v: number) => (!heat || !v ? "var(--ink-2)" : v / maxCell > 0.62 ? "#fff" : "var(--ink)");
  return (
    <table className="tbl" style={{ fontVariantNumeric: "tabular-nums" }}>
      <thead>
        <tr>
          <th style={{ minWidth: 200 }}>Dimension</th>
          {showCols ? colKeys.map((ck) => <th key={ck} className="num" style={{ minWidth: 110 }}>{ck}</th>) : null}
          <th className="num" style={{ minWidth: 120, borderLeft: "2px solid var(--line-strong)" }}>Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ cursor: "default", background: r.depth === 0 && r.isGroup ? "var(--surface-2)" : "transparent" }}>
            <td style={{ paddingLeft: 14 + r.depth * 22, fontWeight: r.depth === 0 ? 600 : 400, color: r.depth === 0 ? "var(--ink)" : "var(--ink-2)" }}>
              {r.depth > 0 && <span style={{ color: "var(--ink-4)", marginRight: 6 }}>└</span>}{r.label}
            </td>
            {showCols ? colKeys.map((ck) => {
              const v = r.vals[ck] || 0;
              const leaf = !r.isGroup;
              return <td key={ck} className="num" style={{ background: leaf ? heatBg(v) : "transparent", color: leaf ? heatInk(v) : "var(--ink-3)", fontWeight: leaf ? 500 : 400 }}>{v ? fmtTHB(v) : "·"}</td>;
            }) : null}
            <td className="num" style={{ borderLeft: "2px solid var(--line-strong)", fontWeight: 600, color: "var(--ink)" }}>{fmtTHB(r.rowTotal)}</td>
          </tr>
        ))}
        <tr style={{ cursor: "default", background: "var(--surface-3)", fontWeight: 700, position: "sticky", bottom: 0 }}>
          <td style={{ fontWeight: 700 }}><Icon name="sum" size={13} style={{ verticalAlign: "-1px", marginRight: 6, color: "var(--accent)" }} />Grand total</td>
          {showCols ? colKeys.map((ck) => <td key={ck} className="num" style={{ fontWeight: 700 }}>{fmtTHB(colTotals[ck] || 0)}</td>) : null}
          <td className="num" style={{ borderLeft: "2px solid var(--line-strong)", fontWeight: 700, color: "var(--accent)" }}>{fmtTHB(grand)}</td>
        </tr>
      </tbody>
    </table>
  );
}
