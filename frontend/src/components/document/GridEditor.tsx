"use client";

// Spreadsheet-like editor for a table block's grid: typing, formulas (=SUM(B2:B4)), row/column
// insert and delete, merge/unmerge, header rows, bold/italic, alignment, fill colour and borders.
import { useState } from "react";
import type { GridCell } from "@/lib/document/types";
import { Button, IconButton } from "@carbon/react";
import { ColumnDelete, ColumnInsert, Erase, RowDelete, RowInsert, TextAlignCenter, TextAlignLeft, TextAlignRight, TextBold, TextItalic } from "@carbon/icons-react";
import { F } from "./P/fields";
import {
  colCount, colName, deleteCol, deleteRow, insertCol, insertRow, merge, normRange, unmergeRange, updateCells, type Range,
} from "@/lib/document/grid";

const FILLS = ["", "#e8eef7", "#f2f2f2", "#fff4cc", "#e3f4e6", "#fde8e8"];

export function GridEditor({ grid, headerRows, onChange, onHeaderRows, bodyLocked, boundNote }: {
  grid: GridCell[][];
  headerRows: number;
  onChange: (g: GridCell[][]) => void;
  onHeaderRows: (n: number) => void;
  /** Body rows come from bound data: only header rows are shown and editable. */
  bodyLocked?: boolean;
  boundNote?: string;
}) {
  const [anchor, setAnchor] = useState<[number, number]>([0, 0]);
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
  const [dragging, setDragging] = useState(false);
  const rg: Range = normRange(anchor, focus);
  const cols = colCount(grid);
  const shown = bodyLocked ? grid.slice(0, Math.max(headerRows, 1)) : grid;
  const cur = grid[anchor[0]]?.[anchor[1]];

  const inSel = (r: number, c: number) => r >= rg.r0 && r <= rg.r1 && c >= rg.c0 && c <= rg.c1;
  const setCell = (r: number, c: number, v: string) => {
    const g = grid.map((row) => row.slice());
    const x = { ...g[r][c] };
    if (v.startsWith("=")) { x.formula = v; x.text = ""; } else { delete x.formula; x.text = v; }
    g[r][c] = x;
    onChange(g);
  };
  const apply = (patch: Partial<GridCell>) => onChange(updateCells(grid, rg, patch));
  const toggle = (k: "bold" | "italic") => apply({ [k]: !cur?.[k] });
  const borders = (w: number | undefined) => onChange(updateCells(grid, rg, { borders: w == null ? undefined : { t: w, r: w, b: w, l: w } }));

  return (
    <div>
      <div className="rh-docx-gridbar">
        <IconButton kind="ghost" size="sm" align="bottom" label="Insert row above" onClick={() => onChange(insertRow(grid, rg.r0))}><RowInsert /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Insert row below" onClick={() => onChange(insertRow(grid, rg.r1 + 1))}><RowInsert /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Delete row" disabled={grid.length <= 1} onClick={() => { onChange(deleteRow(grid, rg.r0)); setAnchor([Math.max(0, rg.r0 - 1), rg.c0]); setFocus([Math.max(0, rg.r0 - 1), rg.c0]); }}><RowDelete /></IconButton>
        <span className="rh-docx-sep" style={{ width: 1, alignSelf: "stretch", background: "var(--cds-border-subtle-01)", margin: "0 4px" }} />
        <IconButton kind="ghost" size="sm" align="bottom" label="Insert column left" onClick={() => onChange(insertCol(grid, rg.c0))}><ColumnInsert /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Insert column right" onClick={() => onChange(insertCol(grid, rg.c1 + 1))}><ColumnInsert /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Delete column" disabled={cols <= 1} onClick={() => { onChange(deleteCol(grid, rg.c0)); setAnchor([rg.r0, Math.max(0, rg.c0 - 1)]); setFocus([rg.r0, Math.max(0, rg.c0 - 1)]); }}><ColumnDelete /></IconButton>
        <span className="rh-docx-sep" style={{ width: 1, alignSelf: "stretch", background: "var(--cds-border-subtle-01)", margin: "0 4px" }} />
        <Button kind="ghost" size="sm" disabled={rg.r0 === rg.r1 && rg.c0 === rg.c1} onClick={() => onChange(merge(grid, rg))}>Merge</Button>
        <Button kind="ghost" size="sm" onClick={() => onChange(unmergeRange(grid, rg))}>Unmerge</Button>
        <span className="rh-docx-sep" style={{ width: 1, alignSelf: "stretch", background: "var(--cds-border-subtle-01)", margin: "0 4px" }} />
        <IconButton kind="ghost" size="sm" align="bottom" label="Bold" onClick={() => toggle("bold")}><TextBold /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Italic" onClick={() => toggle("italic")}><TextItalic /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Align left" onClick={() => apply({ align: "left" })}><TextAlignLeft /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Align center" onClick={() => apply({ align: "center" })}><TextAlignCenter /></IconButton>
        <IconButton kind="ghost" size="sm" align="bottom" label="Align right" onClick={() => apply({ align: "right" })}><TextAlignRight /></IconButton>
        <span className="rh-docx-sep" style={{ width: 1, alignSelf: "stretch", background: "var(--cds-border-subtle-01)", margin: "0 4px" }} />
        {FILLS.map((f) => (
          <IconButton key={f || "none"} kind="ghost" size="sm" align="bottom" label={f ? `Fill ${f}` : "No fill"} onClick={() => apply({ bg: f || undefined })}>
            {f ? <span style={{ display: "block", width: 14, height: 14, background: f, border: "1px solid var(--cds-border-strong-01)" }} /> : <Erase />}
          </IconButton>
        ))}
        <span className="rh-docx-sep" style={{ width: 1, alignSelf: "stretch", background: "var(--cds-border-subtle-01)", margin: "0 4px" }} />
        <Button kind="ghost" size="sm" title="Default borders" onClick={() => borders(undefined)}>Borders</Button>
        <Button kind="ghost" size="sm" title="No borders" onClick={() => borders(0)}>No lines</Button>
        <Button kind="ghost" size="sm" title="Thick borders" onClick={() => borders(2)}>Thick</Button>
      </div>
      <div className="rh-docx-gridbar">
        <span className="cds--type-code-01 rh-dim" style={{ minWidth: 40 }}>{colName(anchor[1])}{anchor[0] + 1}</span>
        <F mono style={{ flex: 1 }} placeholder="Value or formula, e.g. =SUM(B2:B5)"
          value={cur ? cur.formula ?? cur.text : ""} disabled={!cur || cur.covered}
          onChange={(e) => setCell(anchor[0], anchor[1], e.target.value)} />
        <span className="cds--type-label-01 rh-dim">Header rows</span>
        <F type="number" min={0} max={grid.length} value={headerRows} style={{ width: 72 }} placeholder="Header rows"
          onChange={(e) => onHeaderRows(Math.max(0, Math.min(grid.length, Number(e.target.value) || 0)))} />
      </div>
      <div className="rh-docx-grid-wrap" onMouseUp={() => setDragging(false)} onMouseLeave={() => setDragging(false)}>
        <table className="rh-docx-grid">
          <thead>
            <tr><th />{Array.from({ length: cols }, (_, c) => <th key={c}>{colName(c)}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                <th>{r + 1}</th>
                {row.map((c, ci) => c.covered ? null : (
                  <td key={ci} rowSpan={c.rowSpan} colSpan={c.colSpan}
                    className={(r < headerRows ? "rh-docx--hdr " : "") + (inSel(r, ci) ? "rh-docx--in-sel" : "")}
                    style={{ background: c.bg }}
                    onMouseDown={(e) => { if (e.shiftKey) setFocus([r, ci]); else { setAnchor([r, ci]); setFocus([r, ci]); } setDragging(true); }}
                    onMouseEnter={() => { if (dragging) setFocus([r, ci]); }}>
                    <input value={c.formula ?? c.text}
                      style={{ fontWeight: c.bold || r < headerRows ? 600 : undefined, fontStyle: c.italic ? "italic" : undefined, textAlign: c.align }}
                      onChange={(e) => setCell(r, ci, e.target.value)} />
                    {c.formula && <span className="rh-docx-fx">fx</span>}
                  </td>
                ))}
              </tr>
            ))}
            {bodyLocked && (
              <tr className="rh-docx--bound"><th>…</th><td colSpan={cols}>{boundNote ?? "Body rows come from the bound dataset"}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
