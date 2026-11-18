"use client";

// Hand-rolled SVG visualizations for dashboard widgets (table / bar / line / heatmap / tree / treemap).
// All accept normalized data: { labels: string[], series: { name: string, values: number[] }[] }
// plus a raw table fallback { columns, rows }.
import { Skeleton } from "@/components/ui";
import { useEffect, useMemo, useState } from "react";
import styles from "./D/viz.module.scss";
import { fmtAmount } from "@/lib/format";
import { EN_TH, provinceEn } from "@/lib/thmap";

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

const PALETTE = ["var(--cds-interactive)", "var(--cds-tag-color-purple)", "var(--cds-tag-color-teal)", "var(--cds-tag-color-magenta)", "var(--cds-tag-color-red)", "var(--cds-tag-color-cyan)"];

/**
 * The named amounts a widget is really about, whichever shape the query returned.
 *
 * Two shapes reach here and both are legitimate SQL for the same question:
 *   wide — one row, one column per measure   (TARGET, SALES, PROFIT)
 *   tall — one row per category, one measure (8 categories × AMOUNT)
 * A KPI row and a donut both want "name → amount", so they read the same way and the choice of
 * widget stays a display decision rather than a constraint on how the query was written.
 */
function slicesOf(d: VizData): { name: string; value: number }[] {
  if (d.series.length > 1 && d.labels.length <= 1) {
    return d.series.map((s) => ({ name: s.name, value: s.values.reduce((a, b) => a + b, 0) }));
  }
  const s0 = d.series[0];
  if (!s0) return [];
  if (d.labels.length > 1) return d.labels.map((l, i) => ({ name: l, value: s0.values[i] || 0 }));
  return [{ name: s0.name, value: s0.values.reduce((a, b) => a + b, 0) }];
}

/**
 * Big-number tiles — e.g. a total / part A / part B row.
 *
 * Shows the share of the largest amount beside each smaller one, because the question these
 * tiles answer is never just "how much" but "how much of the whole": the parts are read
 * against the total, and a bare pair of numbers makes the reader do that division themselves.
 * Suppressed when one tile IS the largest, where the share is a tautological 100%.
 */
export function KpiViz({ d }: { d: VizData }) {
  const slices = slicesOf(d);
  if (!slices.length) return <Empty />;
  const max = Math.max(...slices.map((s) => s.value), 0);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "6px 2px" }}>
      {slices.slice(0, 6).map((s, i) => (
        <div key={i} style={{ flex: "1 1 150px", minWidth: 140, padding: "11px 13px", borderRadius: 0,
                              background: "var(--cds-layer-01)", border: "1px solid var(--cds-border-subtle-01)" }}>
          <div style={{ fontSize: 11, color: "var(--cds-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
          <div className={styles.mono} style={{ fontSize: 19, fontWeight: 600, marginTop: 3, color: PALETTE[i % PALETTE.length] }}>{fmtAmount(s.value)}</div>
          {max > 0 && s.value !== max && (
            <div style={{ fontSize: 10.5, color: "var(--cds-text-helper)", marginTop: 2 }}>{((s.value / max) * 100).toFixed(1)}% of the largest</div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Donut — proportions, e.g. how a total splits into its parts.
 *
 * Drawn as stroked arcs on one circle rather than filled wedges: a stroke needs only
 * stroke-dasharray to place it, so there is no path arithmetic to get wrong, and the hole
 * leaves room for the total — which is the number people look for first.
 * Negative and zero amounts are dropped; a ring cannot show a negative share, and letting one
 * through would silently distort every other slice's angle.
 */
export function DonutViz({ d }: { d: VizData }) {
  const slices = slicesOf(d).filter((s) => s.value > 0).slice(0, 6);
  const total = slices.reduce((a, b) => a + b.value, 0);
  if (!slices.length || total <= 0) return <Empty />;
  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "6px 2px", flexWrap: "wrap" }}>
      <svg width={140} height={140} viewBox="0 0 140 140" style={{ flexShrink: 0 }}>
        <g transform="rotate(-90 70 70)">
          {slices.map((s, i) => {
            const len = (s.value / total) * C;
            const el = <circle key={i} cx={70} cy={70} r={R} fill="none" stroke={PALETTE[i % PALETTE.length]}
                               strokeWidth={20} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} />;
            acc += len;
            return el;
          })}
        </g>
        <text x={70} y={68} textAnchor="middle" style={{ fontSize: 10, fill: "var(--cds-text-helper)" }}>Total</text>
        <text x={70} y={83} textAnchor="middle" className={styles.mono} style={{ fontSize: 12, fontWeight: 600, fill: "var(--cds-text-primary)" }}>{fmtAmount(total)}</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1, minWidth: 150 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11 }}>
            <span style={{ width: 10, height: 10, borderRadius: 0, background: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
            <span style={{ flex: 1, color: "var(--cds-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
            <span className={styles.mono} style={{ color: "var(--cds-text-primary)" }}>{fmtAmount(s.value)}</span>
            <span style={{ width: 44, textAlign: "right", color: "var(--cds-text-helper)" }}>{((s.value / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TableViz({ d }: { d: VizData }) {
  if (!d.columns || !d.rows) return <Empty />;
  return (
    <div style={{ overflow: "auto", maxHeight: 260 }}>
      <table className="cds--data-table cds--data-table--sm">
        <thead><tr>{d.columns.map((c) => <th key={c} style={{ fontSize: 10.5 }}>{c}</th>)}</tr></thead>
        <tbody>
          {d.rows.slice(0, 50).map((r, i) => (
            <tr key={i} style={{ cursor: "default" }}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? styles.mono : ""} style={{ fontSize: 11.5 }}>{typeof v === "number" ? fmtAmount(v) : String(v ?? "—")}</td>)}</tr>
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
                        opacity: dim ? 0.45 : 1, borderRadius: 0,
                        background: isSel ? "var(--cds-highlight)" : "transparent", transition: ".15s" }}>
            <span style={{ width: 130, fontSize: 10.5, color: isSel ? "var(--cds-interactive)" : "var(--cds-text-secondary)", fontWeight: isSel ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "right" }}>{l}</span>
            <div style={{ flex: 1, height: 16, background: "var(--cds-layer-accent-01)", borderRadius: 0, overflow: "hidden", display: "flex" }}>
              <div style={{ width: `${(s0.values[i] / max) * 100}%`, background: PALETTE[0], borderRadius: 0, transition: ".3s" }} />
            </div>
            <span className={styles.mono} style={{ width: 78, fontSize: 10.5, textAlign: "right" }}>{fmtAmount(s0.values[i] || 0)}</span>
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
          <line key={t} x1={pad} x2={w - pad} y1={y(max * t)} y2={y(max * t)} stroke="var(--cds-border-subtle-01)" strokeDasharray="3 4" />
        ))}
        {d.series.slice(0, 4).map((s, si) => (
          <g key={s.name}>
            <polyline fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2}
                      points={s.values.slice(0, 24).map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
            {s.values.slice(0, 24).map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={PALETTE[si % PALETTE.length]} />)}
          </g>
        ))}
        {labels.map((l, i) => (labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0) && (
          <text key={i} x={x(i)} y={h - 8} fontSize={8.5} fill="var(--cds-text-helper)" textAnchor="middle">{l.slice(0, 10)}</text>
        ))}
      </svg>
      {d.series.length > 1 && (
        <div style={{ display: "flex", gap: 12, padding: "2px 8px", flexWrap: "wrap" }}>
          {d.series.slice(0, 4).map((s, i) => (
            <span key={s.name} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--cds-text-secondary)" }}>
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
            {series.map((s) => <th key={s.name} style={{ fontSize: 10, color: "var(--cds-text-helper)", padding: "4px 6px", fontWeight: 600 }}>{s.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={i}>
              <td style={{ fontSize: 10.5, color: "var(--cds-text-secondary)", padding: "3px 8px", whiteSpace: "nowrap", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>{l}</td>
              {series.map((s) => {
                const v = s.values[i] || 0;
                const t = v / max;
                return (
                  <td key={s.name} title={fmtAmount(v)}
                      style={{ padding: 2 }}>
                    <div style={{ height: 24, borderRadius: 0, display: "grid", placeItems: "center", fontSize: 9.5, fontWeight: 600,
                                  background: `color-mix(in srgb, var(--cds-interactive) ${Math.round(t * 85)}%, var(--cds-layer-accent-01))`,
                                  color: t > 0.55 ? "#fff" : "var(--cds-text-primary)" }}>
                      {v ? fmtAmount(v) : "·"}
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

// ---- Tree / Treemap --------------------------------------------------------

/**
 * The hierarchy a query already describes by the ORDER of its dimension columns.
 *
 * An analytical question is almost always nested — region → branch → category → item — and SQL says so
 * by selecting those columns left to right, so no extra configuration is invented here: dimension
 * columns become levels in the order they were written, and the first numeric column is the amount.
 * A branch's amount is the sum of its leaves rather than a value of its own, because a parent row
 * usually does not exist in the result at all.
 */
export interface TreeNode { name: string; value: number; children: TreeNode[]; depth: number; path: string }

function buildTree(d: VizData): { roots: TreeNode[]; total: number; levels: string[] } {
  const cols = d.columns ?? [];
  const rows = d.rows ?? [];
  if (!cols.length || !rows.length) return { roots: [], total: 0, levels: [] };
  const numIdx = cols.map((_, i) => i).filter((i) => rows.some((r) => typeof r[i] === "number"));
  const dimIdx = cols.map((_, i) => i).filter((i) => !numIdx.includes(i));
  if (!dimIdx.length || !numIdx.length) return { roots: [], total: 0, levels: [] };
  const valIdx = numIdx[numIdx.length - 1];   // last measure — the total column, when a query has several
  const roots: TreeNode[] = [];
  let total = 0;
  for (const r of rows) {
    const v = Number(r[valIdx]) || 0;
    total += v;
    let level = roots, path = "";
    dimIdx.forEach((di, depth) => {
      const name = String(r[di] ?? "").trim() || "—";
      path = path ? path + " › " + name : name;
      let node = level.find((n) => n.name === name);
      if (!node) { node = { name, value: 0, children: [], depth, path }; level.push(node); }
      node.value += v;
      level = node.children;
    });
  }
  const sortDeep = (ns: TreeNode[]) => { ns.sort((a, b) => b.value - a.value); ns.forEach((n) => sortDeep(n.children)); };
  sortDeep(roots);
  return { roots, total, levels: dimIdx.map((i) => cols[i]) };
}

/** Flatten to the rows that are actually visible, so the render list stays O(visible). */
function visibleRows(roots: TreeNode[], open: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ns: TreeNode[]) => ns.forEach((n) => { out.push(n); if (open.has(n.path)) walk(n.children); });
  walk(roots);
  return out;
}

/**
 * Tree — the nesting itself is the answer, so it is drawn as rows rather than as a graph:
 * a region with 200 items has to stay readable, and an org-chart layout would be unreadable long
 * before then. Each row carries its share of the level above, which is the comparison a reader
 * makes when scanning a hierarchy.
 */
export function TreeViz({ d, onSelect, selected }: { d: VizData; onSelect?: (label: string) => void; selected?: string }) {
  const { roots, total, levels } = useMemo(() => buildTree(d), [d]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(roots.slice(0, 1).map((n) => n.path)));
  if (!roots.length) return <Empty />;
  const rows = visibleRows(roots, open);
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const parentOf = (n: TreeNode): number => {
    if (n.depth === 0) return total;
    const parts = n.path.split(" › "); parts.pop();
    const pp = parts.join(" › ");
    const find = (ns: TreeNode[]): TreeNode | undefined => {
      for (const x of ns) { if (x.path === pp) return x; const f = find(x.children); if (f) return f; }
      return undefined;
    };
    return find(roots)?.value ?? total;
  };
  return (
    <div style={{ padding: "4px 2px", maxHeight: 420, overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 6, fontSize: 10, color: "var(--cds-text-helper)", padding: "0 4px 6px" }}>
        {levels.map((l, i) => <span key={i}>{i > 0 && <span style={{ opacity: 0.5 }}> › </span>}{l}</span>)}
        <span style={{ marginLeft: "auto" }} className={styles.mono}>Total {fmtAmount(total)}</span>
      </div>
      {rows.map((n) => {
        const share = parentOf(n) > 0 ? n.value / parentOf(n) : 0;
        const hasKids = n.children.length > 0;
        const isSel = selected != null && selected === n.name;
        return (
          <div key={n.path} onClick={() => (hasKids ? toggle(n.path) : onSelect?.(n.name))}
               title={n.path + " · " + fmtAmount(n.value)}
               style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 0,
                        marginLeft: n.depth * 16, cursor: hasKids || onSelect ? "pointer" : "default",
                        background: isSel ? "color-mix(in srgb, var(--cds-interactive) 14%, transparent)" : undefined }}>
            <span style={{ width: 11, fontSize: 9, color: "var(--cds-text-helper)", flexShrink: 0 }}>
              {hasKids ? (open.has(n.path) ? "▼" : "▶") : "·"}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden",
                           textOverflow: "ellipsis", fontWeight: n.depth === 0 ? 600 : 400 }}>{n.name}</span>
            <span style={{ width: 74, height: 6, borderRadius: 0, background: "var(--cds-layer-accent-01)", flexShrink: 0 }}>
              <span style={{ display: "block", height: "100%", borderRadius: 0, width: `${Math.round(share * 100)}%`,
                             background: PALETTE[n.depth % PALETTE.length] }} />
            </span>
            <span style={{ width: 44, fontSize: 10, color: "var(--cds-text-helper)", textAlign: "right", flexShrink: 0 }}>
              {(share * 100).toFixed(1)}%
            </span>
            <span className={styles.mono} style={{ width: 108, fontSize: 11, textAlign: "right", flexShrink: 0 }}>{fmtAmount(n.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Squarified treemap — same tree, read as area instead of as rows.
 *
 * Squarified rather than a plain slice-and-dice: strips are chosen to keep rectangles near-square,
 * because a 400:1 sliver carries the same area as a square of the same value but reads as nothing.
 * Two levels are drawn (parent frame + children inside) since a deeper nesting turns into noise at
 * dashboard size.
 */
function squarify(items: { name: string; value: number }[], x: number, y: number, w: number, h: number) {
  const out: { name: string; value: number; x: number; y: number; w: number; h: number }[] = [];
  const rest = items.filter((i) => i.value > 0).slice();
  let sum = rest.reduce((a, b) => a + b.value, 0);
  while (rest.length) {
    const horizontal = w >= h;
    const side = horizontal ? h : w;
    const row: typeof rest = [];
    let rowSum = 0, best = Infinity;
    while (rest.length) {
      const next = rest[0];
      const s = rowSum + next.value;
      const thick = (s / sum) * (horizontal ? w : h);
      const worst = Math.max(...[...row, next].map((it) => {
        const len = (it.value / s) * side;
        return Math.max(thick / len, len / thick);
      }));
      if (row.length && worst > best) break;
      row.push(rest.shift()!); rowSum = s; best = worst;
    }
    const thick = (rowSum / sum) * (horizontal ? w : h);
    let off = 0;
    for (const it of row) {
      const len = (it.value / rowSum) * side;
      out.push(horizontal ? { ...it, x, y: y + off, w: thick, h: len } : { ...it, x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (horizontal) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    sum -= rowSum;
  }
  return out;
}

export function TreemapViz({ d, onSelect, selected }: { d: VizData; onSelect?: (label: string) => void; selected?: string }) {
  const { roots, total } = useMemo(() => buildTree(d), [d]);
  const W = 640, H = 340;
  const cells = useMemo(() => squarify(roots.map((r) => ({ name: r.name, value: r.value })), 0, 0, W, H), [roots]);
  if (!roots.length || total <= 0) return <Empty />;
  return (
    <div style={{ padding: "4px 2px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {cells.map((c, i) => {
          const node = roots.find((r) => r.name === c.name)!;
          const kids = c.w > 60 && c.h > 40 ? squarify(node.children.map((k) => ({ name: k.name, value: k.value })),
                                                       c.x + 1, c.y + 15, Math.max(c.w - 2, 1), Math.max(c.h - 16, 1)) : [];
          const isSel = selected != null && selected === c.name;
          return (
            <g key={i} onClick={() => onSelect?.(c.name)} style={{ cursor: onSelect ? "pointer" : "default" }}>
              <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={3} fill={PALETTE[i % PALETTE.length]}
                    fillOpacity={isSel ? 0.55 : 0.28} stroke="var(--cds-background)" strokeWidth={1.5} />
              {kids.map((k, j) => (
                <g key={j}>
                  <rect x={k.x} y={k.y} width={k.w} height={k.h} rx={2} fill={PALETTE[i % PALETTE.length]}
                        fillOpacity={0.5} stroke="var(--cds-background)" strokeWidth={0.8} />
                  <title>{c.name + " › " + k.name + " · " + fmtAmount(k.value)}</title>
                  {k.w > 54 && k.h > 16 && (
                    <text x={k.x + 4} y={k.y + 11} style={{ fontSize: 8, fill: "var(--cds-text-primary)" }}>
                      {k.name.length > Math.floor(k.w / 5) ? k.name.slice(0, Math.floor(k.w / 5)) + "…" : k.name}
                    </text>
                  )}
                </g>
              ))}
              <title>{c.name + " · " + fmtAmount(c.value) + " · " + ((c.value / total) * 100).toFixed(1) + "%"}</title>
              {c.w > 46 && c.h > 14 && (
                <text x={c.x + 5} y={c.y + 11} style={{ fontSize: 9.5, fontWeight: 600, fill: "var(--cds-text-primary)" }}>
                  {c.name.length > Math.floor(c.w / 5.5) ? c.name.slice(0, Math.floor(c.w / 5.5)) + "…" : c.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 10, color: "var(--cds-text-helper)", textAlign: "right", paddingTop: 4 }} className={styles.mono}>Total {fmtAmount(total)}</div>
    </div>
  );
}

function Empty() {
  return <p className="cds--type-body-compact-01" style={{ padding: "var(--cds-spacing-06)", color: "var(--cds-text-secondary)" }}>No data</p>;
}

export function Viz({ viz, data, onSelect, selected }: { viz: string; data: unknown; onSelect?: (label: string) => void; selected?: string }) {
  const d = normalizeWidgetData(data);
  switch (viz) {
    case "bar": return <BarViz d={d} onSelect={onSelect} selected={selected} />;
    case "line": return <LineViz d={d} />;
    case "heat": return <HeatViz d={d} />;
    case "kpi": return <KpiViz d={d} />;
    case "donut": return <DonutViz d={d} />;
    case "map": return <MapViz d={d} />;
    case "tree": return <TreeViz d={d} onSelect={onSelect} selected={selected} />;
    case "treemap": return <TreemapViz d={d} onSelect={onSelect} selected={selected} />;
    default: return <TableViz d={d} />;
  }
}

// ---- Thailand choropleth ---------------------------------------------------

type Feature = { properties: { name: string }; geometry: { type: string; coordinates: unknown } };
let geoCache: Feature[] | null = null;

/** Every ring of a Polygon/MultiPolygon, flattened to one list. */
function ringsOf(g: Feature["geometry"]): [number, number][][] {
  const c = g.coordinates as number[][][] | number[][][][];
  return g.type === "Polygon"
    ? (c as number[][][]).map((r) => r as [number, number][])
    : (c as number[][][][]).flatMap((poly) => poly.map((r) => r as [number, number][]));
}

/**
 * Amount by province, shaded.
 *
 * The GeoJSON is fetched on first render rather than imported, because it is 442 KB and every
 * screen in this app would otherwise carry it — only this widget needs it. Cached in a module
 * variable so a dashboard with two map widgets still fetches once.
 *
 * Shaded on rank, not on amount: one metropolitan area can be orders of magnitude above the median
 * area, so a linear scale paints the country one flat colour and the
 * differences everyone actually wants to compare disappear. Rank keeps them visible; the legend
 * says so, and the real amounts stay one hover away.
 */
export function MapViz({ d }: { d: VizData }) {
  const [feats, setFeats] = useState<Feature[] | null>(geoCache);
  const [hover, setHover] = useState<{ name: string; value: number } | null>(null);

  useEffect(() => {
    if (geoCache) return;
    let live = true;
    fetch("/reportstudio/geo/th-provinces.json")
      .then((r) => r.json())
      .then((j) => { geoCache = j.features as Feature[]; if (live) setFeats(geoCache); })
      .catch(() => { /* leave the widget empty rather than break the dashboard */ });
    return () => { live = false; };
  }, []);

  const byEn = useMemo(() => {
    const m = new Map<string, number>();
    slicesOf(d).forEach((s) => {
      const en = provinceEn(s.name);
      if (en) m.set(en, (m.get(en) ?? 0) + s.value);
    });
    return m;
  }, [d]);

  const rank = useMemo(() => {
    const sorted = [...byEn.entries()].filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
    const r = new Map<string, number>();
    sorted.forEach(([k], i) => r.set(k, sorted.length > 1 ? i / (sorted.length - 1) : 1));
    return r;
  }, [byEn]);

  if (!feats) return <Skeleton />;
  if (!byEn.size) return <Empty />;

  // equirectangular, with longitude squeezed by cos(mid-latitude) so Thailand is not stretched
  const W = 300, H = 420, PAD = 6;
  const k = Math.cos((13 * Math.PI) / 180);
  const pts = feats.flatMap((f) => ringsOf(f.geometry).flat());
  const xs = pts.map((p) => p[0] * k), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((W - PAD * 2) / (maxX - minX), (H - PAD * 2) / (maxY - minY));
  const px = (lon: number) => PAD + (lon * k - minX) * s;
  const py = (lat: number) => PAD + (maxY - lat) * s;

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ flexShrink: 0 }}>
        {feats.map((f) => {
          const name = f.properties.name;
          const v = byEn.get(name);
          const t = rank.get(name);
          const dPath = ringsOf(f.geometry)
            .map((r) => r.map((p, i) => `${i ? "L" : "M"}${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)}`).join("") + "Z")
            .join("");
          return (
            <path key={name} d={dPath}
                  fill={v === undefined ? "var(--cds-layer-accent-01)" : `color-mix(in srgb, var(--cds-interactive) ${12 + (t ?? 0) * 88}%, transparent)`}
                  stroke="var(--cds-background)" strokeWidth={0.4}
                  onMouseEnter={() => setHover(v === undefined ? null : { name, value: v })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: v === undefined ? "default" : "pointer" }} />
          );
        })}
      </svg>
      <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 10.5, color: "var(--cds-text-helper)" }}>Shaded by rank</div>
        <div style={{ height: 8, borderRadius: 0, background: "linear-gradient(90deg, color-mix(in srgb, var(--cds-interactive) 12%, transparent), var(--cds-interactive))" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--cds-text-helper)" }}><span>Low</span><span>High</span></div>
        {hover
          ? <div style={{ marginTop: 4, fontSize: 12 }}>
              <div style={{ color: "var(--cds-text-primary)" }}>{EN_TH[hover.name] ?? hover.name}</div>
              <div className={styles.mono} style={{ fontSize: 15, fontWeight: 600, color: "var(--cds-interactive)" }}>{fmtAmount(hover.value)}</div>
            </div>
          : <div style={{ marginTop: 4, fontSize: 11, color: "var(--cds-text-helper)" }}>{byEn.size} provinces with data</div>}
      </div>
    </div>
  );
}
