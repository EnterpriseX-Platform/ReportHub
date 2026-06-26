"use client";

// Hand-rolled SVG visualizations for dashboard widgets (table / bar / line / heatmap).
// All accept normalized data: { labels: string[], series: { name: string, values: number[] }[] }
// plus a raw table fallback { columns, rows }.
import { fmtTHB } from "@/lib/format";

export interface VizData {
  labels: string[];
  series: { name: string; values: number[] }[];
  columns?: string[];
  rows?: (string | number | null)[][];
}

/** Normalize backend widget payloads (pivot / adhoc / dataset table) into VizData. */
export function normalizeWidgetData(data: unknown): VizData {
  const d = data as Record<string, unknown>;
  if (!d) return { labels: [], series: [] };
  // pivot: { colKeys, rows:[{label, vals, rowTotal}] }
  if (Array.isArray(d.colKeys) && Array.isArray(d.rows) && (d.rows as unknown[]).every((r) => (r as Record<string, unknown>).vals !== undefined)) {
    const rows = d.rows as { label: string; depth: number; isGroup: boolean; vals: Record<string, number>; rowTotal: number }[];
    const leaf = rows.filter((r) => !r.isGroup || r.depth === 0);
    const colKeys = d.colKeys as string[];
    const labels = leaf.map((r) => r.label);
    const series = colKeys[0] === "__total"
      ? [{ name: "Total", values: leaf.map((r) => r.rowTotal) }]
      : colKeys.map((ck) => ({ name: ck, values: leaf.map((r) => r.vals[ck] || 0) }));
    return { labels, series, columns: ["Dimension", ...colKeys.filter((c) => c !== "__total"), "Total"], rows: leaf.map((r) => [r.label, ...(colKeys[0] === "__total" ? [] : colKeys.map((ck) => r.vals[ck] || 0)), r.rowTotal]) };
  }
  // adhoc: { columns, rows: [{col: val}], totals }
  if (Array.isArray(d.columns) && Array.isArray(d.rows) && (d.rows as unknown[])[0] && !Array.isArray((d.rows as unknown[])[0])) {
    const columns = d.columns as string[];
    const rows = d.rows as Record<string, string | number>[];
    const numCols = columns.filter((c) => rows.some((r) => typeof r[c] === "number"));
    const dimCols = columns.filter((c) => !numCols.includes(c));
    const labels = rows.map((r) => dimCols.map((c) => String(r[c] ?? "")).join(" · ") || "—");
    return {
      labels,
      series: numCols.map((c) => ({ name: c, values: rows.map((r) => Number(r[c]) || 0) })),
      columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)),
    };
  }
  // dataset TableResult: { columns, rows: [][] }
  if (Array.isArray(d.columns) && Array.isArray(d.rows)) {
    const columns = d.columns as string[];
    const rows = d.rows as (string | number | null)[][];
    const numIdx = columns.map((_, i) => i).filter((i) => rows.some((r) => typeof r[i] === "number"));
    const dimIdx = columns.map((_, i) => i).filter((i) => !numIdx.includes(i));
    const labels = rows.map((r) => dimIdx.map((i) => String(r[i] ?? "")).join(" · ") || "—");
    return {
      labels,
      series: numIdx.map((i) => ({ name: columns[i], values: rows.map((r) => Number(r[i]) || 0) })),
      columns, rows,
    };
  }
  return { labels: [], series: [] };
}

const PALETTE = ["var(--accent)", "var(--violet)", "var(--green)", "var(--amber)", "var(--red)", "var(--blue)"];

export function TableViz({ d }: { d: VizData }) {
  if (!d.columns || !d.rows) return <Empty />;
  return (
    <div style={{ overflow: "auto", maxHeight: 260 }}>
      <table className="tbl">
        <thead><tr>{d.columns.map((c) => <th key={c} style={{ fontSize: 10.5 }}>{c}</th>)}</tr></thead>
        <tbody>
          {d.rows.slice(0, 50).map((r, i) => (
            <tr key={i} style={{ cursor: "default" }}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "num mono" : ""} style={{ fontSize: 11.5 }}>{typeof v === "number" ? fmtTHB(v) : String(v ?? "—")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BarViz({ d, onSelect, selected }: { d: VizData; onSelect?: (label: string) => void; selected?: string }) {
  const labels = d.labels.slice(0, 12);
  const s0 = d.series[0];
  if (!s0) return <Empty />;
  const max = Math.max(...s0.values.slice(0, 12), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 2px" }}>
      {labels.map((l, i) => {
        const isSel = selected === l;
        const dim = !!selected && !isSel;
        return (
          <div key={i} onClick={onSelect ? () => onSelect(l) : undefined}
               title={onSelect ? "Click to filter the dashboard by this value" : undefined}
               style={{ display: "flex", alignItems: "center", gap: 8, cursor: onSelect ? "pointer" : "default",
                        opacity: dim ? 0.45 : 1, borderRadius: 6,
                        background: isSel ? "var(--accent-weak)" : "transparent", transition: ".15s" }}>
            <span style={{ width: 130, fontSize: 10.5, color: isSel ? "var(--accent)" : "var(--ink-3)", fontWeight: isSel ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "right" }}>{l}</span>
            <div style={{ flex: 1, height: 16, background: "var(--surface-3)", borderRadius: 5, overflow: "hidden", display: "flex" }}>
              <div style={{ width: `${(s0.values[i] / max) * 100}%`, background: PALETTE[0], borderRadius: 5, transition: ".3s" }} />
            </div>
            <span className="mono" style={{ width: 78, fontSize: 10.5, textAlign: "right" }}>{fmtTHB(s0.values[i] || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function LineViz({ d }: { d: VizData }) {
  const labels = d.labels.slice(0, 24);
  if (!d.series[0]) return <Empty />;
  const w = 520, h = 180, pad = 28;
  const all = d.series.flatMap((s) => s.values.slice(0, 24));
  const max = Math.max(...all, 1);
  const x = (i: number) => pad + (i * (w - 2 * pad)) / Math.max(1, labels.length - 1);
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  return (
    <div style={{ overflow: "auto" }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", minWidth: 360 }}>
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <line key={t} x1={pad} x2={w - pad} y1={y(max * t)} y2={y(max * t)} stroke="var(--line)" strokeDasharray="3 4" />
        ))}
        {d.series.slice(0, 4).map((s, si) => (
          <g key={s.name}>
            <polyline fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2}
                      points={s.values.slice(0, 24).map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
            {s.values.slice(0, 24).map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={PALETTE[si % PALETTE.length]} />)}
          </g>
        ))}
        {labels.map((l, i) => (labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0) && (
          <text key={i} x={x(i)} y={h - 8} fontSize={8.5} fill="var(--ink-4)" textAnchor="middle">{l.slice(0, 10)}</text>
        ))}
      </svg>
      {d.series.length > 1 && (
        <div style={{ display: "flex", gap: 12, padding: "2px 8px", flexWrap: "wrap" }}>
          {d.series.slice(0, 4).map((s, i) => (
            <span key={s.name} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--ink-3)" }}>
              <i style={{ width: 8, height: 8, borderRadius: 8, background: PALETTE[i % PALETTE.length] }} />{s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function HeatViz({ d }: { d: VizData }) {
  const labels = d.labels.slice(0, 14);
  const series = d.series.slice(0, 8);
  if (!series[0]) return <Empty />;
  const max = Math.max(...series.flatMap((s) => s.values.slice(0, 14)), 1);
  return (
    <div style={{ overflow: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th />
            {series.map((s) => <th key={s.name} style={{ fontSize: 10, color: "var(--ink-4)", padding: "4px 6px", fontWeight: 600 }}>{s.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={i}>
              <td style={{ fontSize: 10.5, color: "var(--ink-3)", padding: "3px 8px", whiteSpace: "nowrap", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>{l}</td>
              {series.map((s) => {
                const v = s.values[i] || 0;
                const t = v / max;
                return (
                  <td key={s.name} title={fmtTHB(v)}
                      style={{ padding: 2 }}>
                    <div style={{ height: 24, borderRadius: 5, display: "grid", placeItems: "center", fontSize: 9.5, fontWeight: 600,
                                  background: `color-mix(in srgb, var(--accent) ${Math.round(t * 85)}%, var(--surface-3))`,
                                  color: t > 0.55 ? "#fff" : "var(--ink-2)" }}>
                      {v ? fmtTHB(v) : "·"}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty() {
  return <div className="empty" style={{ padding: 24, fontSize: 12 }}>No data</div>;
}

export function Viz({ viz, data, onSelect, selected }: { viz: string; data: unknown; onSelect?: (label: string) => void; selected?: string }) {
  const d = normalizeWidgetData(data);
  switch (viz) {
    case "bar": return <BarViz d={d} onSelect={onSelect} selected={selected} />;
    case "line": return <LineViz d={d} />;
    case "heat": return <HeatViz d={d} />;
    default: return <TableViz d={d} />;
  }
}
