"use client";

// Paginated document renderer shared by the editor preview, the preview page and the print page
// (which the exporter turns into PDF). Pagination is measured, not estimated: every block is first
// rendered off-screen at its page's content width, then blocks are packed onto pages. Tables that
// do not fit are split between rows with their header rows repeated; a block or section marked
// landscape goes on landscape pages (named CSS pages, so the PDF gets rotated sheets).
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Block, BlockData, DocContent, GridCell, Orientation, TableBlock } from "@/lib/document/types";
import { MM_PX, pageDims } from "@/lib/document/pageSizes";
import { firstCutAt, mergeCrossesHeader, renderGrid, splitGrid } from "@/lib/document/grid";
import { fillParams, parseRuns } from "@/lib/document/text";

export interface RenderCtx {
  params: Record<string, string>;
  data: Record<string, BlockData>;
  baseFontPt: number;
  toc: TocEntry[];
  pageOf: Record<string, number>;
}
interface TocEntry { id: string; level: number; text: string }

const BLOCK_GAP_MM = 3;
const FONT_STACKS: Record<string, string> = {
  sans: "var(--font-plex), 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "var(--font-plex-mono), 'IBM Plex Mono', Menlo, Courier, monospace",
};
export const FONT_CHOICES = [
  { id: "sans", label: "Sans serif" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Monospace" },
];

// --- block views ---------------------------------------------------------------

function Rich({ text, params, extra }: { text: string; params: Record<string, string>; extra?: Record<string, string> }) {
  const filled = fillParams(text, params, extra);
  return <>{parseRuns(filled).map((r, i) => {
    let el: ReactNode = r.t;
    if (r.b) el = <strong>{el}</strong>;
    if (r.i) el = <em>{el}</em>;
    if (r.u) el = <u>{el}</u>;
    return <Fragment key={i}>{el}</Fragment>;
  })}</>;
}

function borderCss(w: number | undefined): string | undefined {
  if (w == null) return undefined;
  return w <= 0 ? "none" : `${w * 0.75}pt solid #000`;
}

export function TableView({ block, grid, fontPt, showTitle = true, params }: {
  block: TableBlock; grid: GridCell[][]; fontPt: number; showTitle?: boolean; params: Record<string, string>;
}) {
  const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const widths = block.colWidths && block.colWidths.length === cols ? block.colWidths : Array.from({ length: cols }, () => 1);
  const total = widths.reduce((s, w) => s + (w > 0 ? w : 1), 0);
  const hr = Math.min(block.headerRows, grid.length);
  return (
    <div>
      {showTitle && block.title && <div className="doc-table-title"><Rich text={block.title} params={params} /></div>}
      <table className="doc-table" style={{ fontSize: `${block.fontSizePt ?? fontPt - 1}pt` }}>
        <colgroup>{widths.map((w, i) => <col key={i} style={{ width: `${((w > 0 ? w : 1) / total) * 100}%` }} />)}</colgroup>
        <tbody>
          {grid.map((row, r) => (
            <tr key={r} className={r < hr ? "doc-th-row" : undefined}>
              {row.map((c, ci) => c.covered ? null : (
                <td key={ci} rowSpan={c.rowSpan} colSpan={c.colSpan}
                  style={{
                    textAlign: c.align, fontWeight: c.bold || r < hr ? 600 : undefined, fontStyle: c.italic ? "italic" : undefined,
                    background: c.bg, color: c.color,
                    borderTop: borderCss(c.borders?.t), borderRight: borderCss(c.borders?.r),
                    borderBottom: borderCss(c.borders?.b), borderLeft: borderCss(c.borders?.l),
                  }}>
                  {c.skeleton ? <span className="doc-skel" /> : <Rich text={c.text} params={params} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BlockView({ block, ctx, grid, showTitle }: { block: Block; ctx: RenderCtx; grid?: GridCell[][]; showTitle?: boolean }) {
  const p = ctx.params;
  switch (block.type) {
    case "heading": {
      const size = [0, 1.75, 1.35, 1.12][block.level];
      return <div className={`doc-h doc-h${block.level}`} style={{ textAlign: block.align, fontSize: `${ctx.baseFontPt * size}pt` }}><Rich text={block.text} params={p} /></div>;
    }
    case "paragraph":
      return (
        <div style={{ textAlign: block.align, fontSize: block.sizePt ? `${block.sizePt}pt` : undefined, paddingLeft: block.indentMm ? `${block.indentMm}mm` : undefined }}>
          {block.text.split(/\n\s*\n/).map((para, i) => (
            <p key={i} className="doc-p">{para.split("\n").map((ln, j) => <Fragment key={j}>{j > 0 && <br />}<Rich text={ln} params={p} /></Fragment>)}</p>
          ))}
        </div>
      );
    case "table":
      return <TableView block={block} grid={grid ?? renderGrid(block, ctx.data[block.id])} fontPt={ctx.baseFontPt} showTitle={showTitle} params={p} />;
    case "image":
      return (
        <div style={{ textAlign: block.align ?? "center" }}>
          {block.url
            ? // eslint-disable-next-line @next/next/no-img-element
              <img src={block.url} alt={block.caption ?? ""} style={{ width: `${block.widthPct}%`, display: "inline-block" }} />
            : <div className="doc-img-empty">No image selected</div>}
          {block.caption && <div className="doc-caption"><Rich text={block.caption} params={p} /></div>}
        </div>
      );
    case "toc":
      return (
        <div>
          <div className="doc-h doc-h1" style={{ fontSize: `${ctx.baseFontPt * 1.35}pt` }}>{block.title}</div>
          {ctx.toc.filter((e) => e.level <= block.maxLevel).map((e) => (
            <div key={e.id} className="doc-toc-row" style={{ paddingLeft: `${(e.level - 1) * 6}mm` }}>
              <span className="doc-toc-text"><Rich text={e.text} params={p} /></span>
              <span className="doc-toc-dots" />
              <span className="doc-toc-page">{ctx.pageOf[e.id] ?? "0"}</span>
            </div>
          ))}
        </div>
      );
    case "divider":
      return <hr className="doc-hr" />;
    case "spacer":
      return <div style={{ height: `${block.heightMm}mm` }} />;
    case "pageBreak":
      return null;
  }
}

// --- layout ----------------------------------------------------------------------

interface PageItem { block: Block; grid?: GridCell[][]; showTitle?: boolean }
export interface LaidPage { orientation: Orientation; sectionId: string; items: PageItem[] }

interface Measure { h: number; rows?: number[]; titleH?: number }

function flowBlocks(content: DocContent) {
  const out: { block: Block; sectionId: string; orientation: Orientation; newPage: boolean }[] = [];
  for (const s of content.sections) {
    if (s.disabled) continue;
    const so = s.orientation ?? content.page.orientation;
    s.blocks.forEach((b, i) => {
      out.push({
        block: b, sectionId: s.id,
        orientation: b.landscape ? "landscape" : so,
        newPage: (i === 0 && s.newPage !== false) || !!b.pageBreakBefore || b.type === "pageBreak",
      });
    });
  }
  return out;
}

function layout(content: DocContent, measures: Record<string, Measure>, data: Record<string, BlockData>): LaidPage[] {
  const pages: LaidPage[] = [];
  const m = content.page.marginsMm;
  let cur: LaidPage | null = null;
  let used = 0;
  const avail = (o: Orientation) => pageDims(content.page.size, o).h - m.top - m.bottom;
  const open = (o: Orientation, sectionId: string) => { cur = { orientation: o, sectionId, items: [] }; pages.push(cur); used = 0; };

  for (const f of flowBlocks(content)) {
    const ms = measures[f.block.id];
    if (!ms) continue;
    if (!cur || f.newPage || (cur as LaidPage).orientation !== f.orientation) {
      if (!(cur && (cur as LaidPage).items.length === 0 && (cur as LaidPage).orientation === f.orientation)) open(f.orientation, f.sectionId);
    }
    if (f.block.type === "pageBreak") continue;
    const page = () => cur as unknown as LaidPage;
    const full = avail(f.orientation);

    if (f.block.type === "table" && ms.rows && !f.block.keepWhole) {
      let grid = renderGrid(f.block, data[f.block.id]);
      let rows = ms.rows.slice();
      const hr = mergeCrossesHeader(grid, f.block.headerRows) ? 0 : Math.min(f.block.headerRows, grid.length);
      let first = true;
      for (;;) {
        const titleH = first ? ms.titleH ?? 0 : 0;
        const room = full - used - titleH - BLOCK_GAP_MM;
        const headH = rows.slice(0, hr).reduce((s, x) => s + x, 0);
        const firstRowH = rows[hr] ?? 0;
        if (page().items.length > 0 && headH + firstRowH > room) { open(f.orientation, f.sectionId); continue; }
        const cut = firstCutAt(rows, hr, room);
        if (cut == null) {
          page().items.push({ block: f.block, grid, showTitle: first });
          used += titleH + rows.reduce((s, x) => s + x, 0) + BLOCK_GAP_MM;
          break;
        }
        const { head, tail } = splitGrid(grid, hr, cut);
        page().items.push({ block: f.block, grid: head, showTitle: first });
        grid = tail;
        rows = [...rows.slice(0, hr), ...rows.slice(cut)];
        first = false;
        open(f.orientation, f.sectionId);
      }
      continue;
    }
    if (used > 0 && used + ms.h > full) open(f.orientation, f.sectionId);
    page().items.push({ block: f.block });
    used += ms.h;
  }
  return pages;
}

// --- component -------------------------------------------------------------------

export function docFontFamily(content: DocContent) {
  return FONT_STACKS[content.page.fontFamily ?? "sans"] ?? FONT_STACKS.sans;
}

/** CSS for print: one named @page per orientation so the PDF gets the right sheet size per page. */
export function printCss(content: DocContent): string {
  const p = pageDims(content.page.size, "portrait");
  const l = pageDims(content.page.size, "landscape");
  return `@page { margin: 0; size: ${p.w}mm ${p.h}mm; }
@page doc-portrait { margin: 0; size: ${p.w}mm ${p.h}mm; }
@page doc-landscape { margin: 0; size: ${l.w}mm ${l.h}mm; }`;
}

export function DocPages({ content, params, data, onReady, scale = 1, onPageCount }: {
  content: DocContent;
  params: Record<string, string>;
  data: Record<string, BlockData>;
  onReady?: () => void;
  scale?: number;
  onPageCount?: (n: number) => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [measures, setMeasures] = useState<Record<string, Measure> | null>(null);
  const [pageOf, setPageOf] = useState<Record<string, number>>({});
  const flows = useMemo(() => flowBlocks(content), [content]);
  const toc = useMemo<TocEntry[]>(() => flows
    .filter((f) => f.block.type === "heading" && !(f.block as { noToc?: boolean }).noToc)
    .map((f) => ({ id: f.block.id, level: (f.block as { level: number }).level, text: (f.block as { text: string }).text })), [flows]);
  const baseFontPt = content.page.fontSizePt ?? 11;
  const ctx: RenderCtx = { params, data, baseFontPt, toc, pageOf };
  const m = content.page.marginsMm;
  const key = useMemo(() => JSON.stringify([content, params, data]), [content, params, data]);

  // Measure every block off-screen at its content width (after fonts and images load).
  useLayoutEffect(() => {
    let cancelled = false;
    const root = measureRef.current;
    if (!root) return;
    const run = async () => {
      try { await document.fonts?.ready; } catch { /* ignore */ }
      await Promise.all(Array.from(root.querySelectorAll("img")).map((img) => img.complete ? null
        : new Promise((res) => { img.addEventListener("load", res, { once: true }); img.addEventListener("error", res, { once: true }); })));
      if (cancelled) return;
      const out: Record<string, Measure> = {};
      root.querySelectorAll<HTMLElement>("[data-measure]").forEach((el) => {
        const id = el.dataset.measure!;
        const meas: Measure = { h: el.getBoundingClientRect().height / MM_PX };
        const tbl = el.querySelector("table");
        if (tbl) {
          meas.rows = Array.from(tbl.rows).map((tr) => tr.getBoundingClientRect().height / MM_PX);
          const title = el.querySelector<HTMLElement>(".doc-table-title");
          meas.titleH = title ? title.getBoundingClientRect().height / MM_PX : 0;
        }
        out[id] = meas;
      });
      setMeasures(out);
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const pages = useMemo(() => (measures ? layout(content, measures, data) : []), [measures, content, data]);

  // Page numbers of headings for the table of contents (stable after one extra pass).
  useEffect(() => {
    if (!measures) return;
    const map: Record<string, number> = {};
    pages.forEach((pg, i) => pg.items.forEach((it) => { if (it.block.type === "heading" && !(it.block.id in map)) map[it.block.id] = i + 1; }));
    const same = Object.keys(map).length === Object.keys(pageOf).length && Object.entries(map).every(([k, v]) => pageOf[k] === v);
    if (!same) { setPageOf(map); return; }
    onPageCount?.(pages.length);
    if (onReady) requestAnimationFrame(() => requestAnimationFrame(onReady));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, measures, pageOf]);

  const fontFamily = docFontFamily(content);
  const pageStyle = (o: Orientation): CSSProperties => {
    const d = pageDims(content.page.size, o);
    return { width: `${d.w}mm`, height: `${d.h}mm`, fontFamily, fontSize: `${baseFontPt}pt`, page: o === "landscape" ? "doc-landscape" : "doc-portrait" } as CSSProperties;
  };
  const contentWidth = (o: Orientation) => pageDims(content.page.size, o).w - m.left - m.right;

  return (
    <div className="doc-pages" style={scale !== 1 ? ({ zoom: scale } as CSSProperties) : undefined}>
      <style>{printCss(content)}</style>
      {(
        <div ref={measureRef} className="doc-measure" aria-hidden style={{ fontFamily, fontSize: `${baseFontPt}pt` }}>
          {flows.map((f) => (
            <div key={f.block.id} data-measure={f.block.id} style={{ width: `${contentWidth(f.orientation)}mm`, paddingBottom: f.block.type === "table" ? 0 : `${BLOCK_GAP_MM}mm`, display: "flow-root" }}>
              <BlockView block={f.block} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
      {pages.map((pg, i) => (
        <div key={i} className="doc-page" style={pageStyle(pg.orientation)}>
          {content.page.header && <div className="doc-running doc-header" style={{ top: `${Math.max(m.top / 2 - 3, 3)}mm`, left: `${m.left}mm`, right: `${m.right}mm` }}><Rich text={content.page.header} params={params} extra={{ page: String(i + 1), pages: String(pages.length) }} /></div>}
          <div className="doc-content" style={{ position: "absolute", top: `${m.top}mm`, left: `${m.left}mm`, right: `${m.right}mm`, bottom: `${m.bottom}mm` }}>
            {pg.items.map((it, j) => (
              <div key={j} style={{ paddingBottom: `${BLOCK_GAP_MM}mm`, display: "flow-root" }}>
                <BlockView block={it.block} ctx={ctx} grid={it.grid} showTitle={it.showTitle} />
              </div>
            ))}
          </div>
          {content.page.footer && <div className="doc-running doc-footer" style={{ bottom: `${Math.max(m.bottom / 2 - 3, 3)}mm`, left: `${m.left}mm`, right: `${m.right}mm` }}><Rich text={content.page.footer} params={params} extra={{ page: String(i + 1), pages: String(pages.length) }} /></div>}
        </div>
      ))}
    </div>
  );
}
