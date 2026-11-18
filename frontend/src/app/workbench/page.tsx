"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, OverflowMenu, OverflowMenuItem, Tag, TextInput, Tile, Toggle } from "@carbon/react";
import { Download, Star } from "@carbon/icons-react";
import { Icon, type IconName } from "@/components/Icon";
import { PageHeader } from "@/components/ui";
import cx from "@/components/D/d.module.scss";
import { useToast } from "@/components/Toast";
import { fmtAmount } from "@/lib/format";
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
      <PageHeader title="Analytics Workbench" sub="Pivot & explore the fact warehouse — like Excel, straight from the database"
        actions={<>
          <Button kind="secondary" renderIcon={Star} onClick={() => setShowSave(true)}>Save view</Button>
          <Button kind="primary" renderIcon={Download} disabled={exporting} onClick={exportExcel}>Export Excel</Button>
        </>} />

      <div className={cx.side2}>
        <div className={cx.sideCol}>
          <Tile>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <Icon name="datasource" size={16} style={{ color: "var(--cds-icon-secondary)" }} />
              <span className="cds--type-heading-compact-01">fact</span>
              <Tag size="sm" type="gray" style={{ marginLeft: "auto" }}>{meta ? `${meta.factCount} rows` : "…"}</Tag>
            </div>
            <div className="cds--type-label-01 rh-dim" style={{ marginBottom: 8 }}>Dimensions</div>
            {WB_DIMENSIONS.map((d) => (
              <FieldChip key={d.id} field={d} placed={rows.includes(d.id) ? "rows" : cols.includes(d.id) ? "cols" : null} onAssign={assign} />
            ))}
            <div className="cds--type-label-01 rh-dim" style={{ margin: "16px 0 8px" }}>Measures</div>
            {WB_MEASURES.map((m) => (
              <div key={m.id} role="button" tabIndex={0} onClick={() => setMeasure(m.id)} onKeyDown={(e) => { if (e.key === "Enter") setMeasure(m.id); }} style={pickRow(measure === m.id)}>
                <Icon name="sum" size={16} style={{ color: "var(--cds-icon-secondary)" }} />
                <span className="cds--type-body-compact-01" style={{ flex: 1 }}>{m.label}</span>
                {measure === m.id && <Icon name="check" size={16} style={{ color: "var(--cds-interactive)" }} />}
              </div>
            ))}
          </Tile>

          <Tile>
            <div className="cds--type-label-01 rh-dim" style={{ marginBottom: 8 }}>My views</div>
            <WorkspacePicker value={ws} onChange={setWs} allowAll style={{ marginBottom: 8 }} />
            <SavedViewList views={views} onLoad={applyView} onChanged={reloadViews} />
          </Tile>
        </div>

        <div className={cx.mainCol}>
          <Tile style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--cds-spacing-05)", alignItems: "end" }}>
            <Shelf label="Rows" icon="registry" items={rows} onRemove={remove} />
            <Shelf label="Columns" icon="table" items={cols} onRemove={remove} />
            <Toggle id="wb-heat" size="sm" labelText="Display" labelA="Heatmap" labelB="Heatmap" toggled={heat} onToggle={(v) => setHeat(v)} />
          </Tile>

          <Tile style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "var(--cds-spacing-04) var(--cds-spacing-05)", borderBottom: "1px solid var(--cds-border-subtle-01)" }}>
              <Icon name="workbench" size={16} style={{ color: "var(--cds-icon-secondary)" }} />
              <div style={{ flex: 1, minWidth: 0 }}><h3 className="cds--type-heading-compact-01" style={{ margin: 0 }}>{measureLabel} by {rows.map((r) => WB_DIMENSIONS.find((d) => d.id === r)?.label).join(" › ")}{cols.length ? " × " + WB_DIMENSIONS.find((d) => d.id === cols[0])?.label : ""}</h3></div>
              <span className="cds--type-code-01 rh-dim">unit: amount</span>
            </div>
            <div style={{ overflow: "auto", maxHeight: "calc(100vh - 320px)" }}>
              {rows.length === 0 || cols.length !== 1
                ? <div className="cds--type-body-01 rh-dim" style={{ padding: "var(--cds-spacing-09)", textAlign: "center" }}>Pick one row dimension and one column dimension to build the pivot</div>
                : !loading && pivot.rows.length === 0
                  ? <div style={{ padding: "var(--cds-spacing-09)", textAlign: "center" }}>
                      <h4 className="cds--type-heading-compact-01">No data to pivot</h4>
                      <p className="cds--type-body-compact-01 rh-dim" style={{ marginTop: 4 }}>The fact table has no rows</p>
                    </div>
                  : <PivotTable pivot={pivot} heat={heat} />}
            </div>
          </Tile>
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
      foot={<><Button kind="secondary" onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), workspaceId, folder.trim())}>Save</Button></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <TextInput id="wb-view-name" labelText="View name" autoFocus placeholder="e.g. Sales by region × year" value={name} onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { e.preventDefault(); onSave(name.trim(), workspaceId, folder.trim()); } }} />
        <SaveDestination workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} folder={folder} setFolder={setFolder} folders={folders} />
      </div>
    </Modal>
  );
}

function FieldChip({ field, placed, onAssign }: { field: { id: string; label: string }; placed: string | null; onAssign: (id: string, zone: "rows" | "cols") => void }) {
  return (
    <div style={{ ...pickRow(!!placed), padding: 0, paddingLeft: 10 }}>
      <Icon name="drag" size={16} style={{ color: "var(--cds-icon-secondary)" }} />
      <span className="cds--type-body-compact-01" style={{ flex: 1 }}>{field.label}</span>
      {placed && <Tag size="sm" type="blue">{placed}</Tag>}
      <OverflowMenu size="sm" flipped aria-label={`Place ${field.label}`} iconDescription="Place field">
        <OverflowMenuItem itemText="Add to Rows" onClick={() => onAssign(field.id, "rows")} />
        <OverflowMenuItem itemText="Add to Columns" onClick={() => onAssign(field.id, "cols")} />
      </OverflowMenu>
    </div>
  );
}

/** Selectable list row (field / measure) — Carbon layer + selected border, layout only. */
function pickRow(on: boolean): React.CSSProperties {
  return { display: "flex", alignItems: "center", gap: 8, minHeight: 32, padding: "6px 10px", cursor: "pointer", marginBottom: 2,
    border: "1px solid " + (on ? "var(--cds-border-interactive)" : "var(--cds-border-subtle-01)"),
    background: on ? "var(--cds-layer-selected-01)" : "var(--cds-layer-02)" };
}

function Shelf({ label, icon, items, onRemove }: { label: string; icon: IconName; items: string[]; onRemove: (id: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="cds--type-label-01 rh-dim" style={{ display: "flex", alignItems: "center", gap: 6 }}><Icon name={icon} size={16} />{label}</span>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minHeight: 32, alignItems: "center", padding: "2px 6px", border: "1px dashed var(--cds-border-strong-01)", background: "var(--cds-field-01)" }}>
        {items.length === 0 && <span className="rh-dim">—</span>}
        {items.map((id) => (
          <Tag key={id} type="blue" size="sm" filter title="Remove" onClose={() => onRemove(id)}>
            {WB_DIMENSIONS.find((d) => d.id === id)?.label}
          </Tag>
        ))}
      </div>
    </div>
  );
}


function PivotTable({ pivot, heat }: { pivot: Pivot; heat: boolean }) {
  const { colKeys, colDim, rows, colTotals, grand, maxCell } = pivot;
  const showCols = !!colDim && colKeys[0] !== "__total";
  const heatBg = (v: number) => (!heat || !v ? "transparent" : `color-mix(in srgb, var(--cds-interactive) ${Math.round(Math.min(1, v / maxCell) * 70)}%, transparent)`);
  const heatInk = (v: number) => (!heat || !v ? "var(--cds-text-secondary)" : v / maxCell > 0.62 ? "#fff" : "var(--cds-text-primary)");
  return (
    <table className="cds--data-table cds--data-table--sm" style={{ fontVariantNumeric: "tabular-nums", width: "100%" }}>
      <thead>
        <tr>
          <th style={{ minWidth: 200 }}>Dimension</th>
          {showCols ? colKeys.map((ck) => <th key={ck} style={{ textAlign: "right", minWidth: 110 }}>{ck}</th>) : null}
          <th style={{ textAlign: "right", minWidth: 120, borderLeft: "2px solid var(--cds-border-strong-01)" }}>Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ cursor: "default", background: r.depth === 0 && r.isGroup ? "var(--cds-layer-accent-01)" : "transparent" }}>
            <td style={{ paddingLeft: 14 + r.depth * 22, fontWeight: r.depth === 0 ? 600 : 400, color: r.depth === 0 ? "var(--cds-text-primary)" : "var(--cds-text-secondary)" }}>
              {r.depth > 0 && <span style={{ color: "var(--cds-text-placeholder)", marginRight: 6 }}>└</span>}{r.label}
            </td>
            {showCols ? colKeys.map((ck) => {
              const v = r.vals[ck] || 0;
              const leaf = !r.isGroup;
              return <td key={ck} style={{ textAlign: "right", background: leaf ? heatBg(v) : "transparent", color: leaf ? heatInk(v) : "var(--cds-text-secondary)", fontWeight: leaf ? 500 : 400 }}>{v ? fmtAmount(v) : "·"}</td>;
            }) : null}
            <td style={{ textAlign: "right", borderLeft: "2px solid var(--cds-border-strong-01)", fontWeight: 600, color: "var(--cds-text-primary)" }}>{fmtAmount(r.rowTotal)}</td>
          </tr>
        ))}
        <tr style={{ cursor: "default", background: "var(--cds-layer-accent-01)", fontWeight: 600, position: "sticky", bottom: 0 }}>
          <td style={{ fontWeight: 600 }}><Icon name="sum" size={13} style={{ verticalAlign: "-1px", marginRight: 6, color: "var(--cds-icon-secondary)" }} />Grand total</td>
          {showCols ? colKeys.map((ck) => <td key={ck} style={{ textAlign: "right", fontWeight: 600 }}>{fmtAmount(colTotals[ck] || 0)}</td>) : null}
          <td style={{ textAlign: "right", borderLeft: "2px solid var(--cds-border-strong-01)", fontWeight: 600, color: "var(--cds-text-primary)" }}>{fmtAmount(grand)}</td>
        </tr>
      </tbody>
    </table>
  );
}
