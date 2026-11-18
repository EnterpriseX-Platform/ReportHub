// Pure grid helpers: editing operations, formulas, data binding and page splitting.
// No DOM here — the paginator measures row heights and drives splitGrid().
import type { BlockData, GridCell, TableBlock } from "./types";

export const cell = (text = ""): GridCell => ({ text });

export function makeGrid(rows: number, cols: number): GridCell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => cell()));
}

export const colCount = (g: GridCell[][]) => g.reduce((m, r) => Math.max(m, r.length), 0);

const clone = (g: GridCell[][]) => g.map((r) => r.map((c) => ({ ...c })));

/** Anchor (top-left) cell of the merge covering (r, c). */
export function anchorOf(g: GridCell[][], r: number, c: number): [number, number] {
  for (let rr = r; rr >= 0; rr--) {
    for (let cc = c; cc >= 0; cc--) {
      const x = g[rr]?.[cc];
      if (!x || x.covered) continue;
      if (rr + (x.rowSpan ?? 1) > r && cc + (x.colSpan ?? 1) > c) return [rr, cc];
    }
  }
  return [r, c];
}

/** Remove every merge that touches the given rows/cols so structural edits stay consistent. */
function unmergeAll(g: GridCell[][]): GridCell[][] {
  return g.map((row) => row.map((c) => {
    const n = { ...c };
    delete n.rowSpan; delete n.colSpan; delete n.covered;
    return n;
  }));
}

function hasMerges(g: GridCell[][]) {
  return g.some((r) => r.some((c) => c.covered || (c.rowSpan ?? 1) > 1 || (c.colSpan ?? 1) > 1));
}

export function insertRow(g: GridCell[][], at: number): GridCell[][] {
  const out = clone(g);
  const cols = colCount(g);
  // Grow a vertical merge that spans the insertion point instead of tearing it.
  const row: GridCell[] = Array.from({ length: cols }, () => cell());
  if (at > 0 && at < g.length) {
    for (let c = 0; c < cols; c++) {
      const [ar, ac] = anchorOf(g, at, c);
      const a = out[ar][ac];
      if (ar < at && ar + (a.rowSpan ?? 1) > at) {
        row[c] = { text: "", covered: true };
        if (ac === c) a.rowSpan = (a.rowSpan ?? 1) + 1;
      }
    }
  }
  out.splice(at, 0, row);
  return out;
}

export function deleteRow(g: GridCell[][], at: number): GridCell[][] {
  if (g.length <= 1) return g;
  const base = hasMerges(g) ? unmergeAll(g) : clone(g);
  base.splice(at, 1);
  return base;
}

export function insertCol(g: GridCell[][], at: number): GridCell[][] {
  const base = hasMerges(g) ? unmergeAll(g) : clone(g);
  return base.map((r) => { const n = [...r]; n.splice(at, 0, cell()); return n; });
}

export function deleteCol(g: GridCell[][], at: number): GridCell[][] {
  if (colCount(g) <= 1) return g;
  const base = hasMerges(g) ? unmergeAll(g) : clone(g);
  return base.map((r) => { const n = [...r]; n.splice(at, 1); return n; });
}

export interface Range { r0: number; c0: number; r1: number; c1: number }

export function normRange(a: [number, number], b: [number, number]): Range {
  return { r0: Math.min(a[0], b[0]), c0: Math.min(a[1], b[1]), r1: Math.max(a[0], b[0]), c1: Math.max(a[1], b[1]) };
}

/** Merge a rectangle; text of the covered cells is appended to the anchor. */
export function merge(g: GridCell[][], rg: Range): GridCell[][] {
  const out = unmergeRange(g, rg);
  const texts: string[] = [];
  for (let r = rg.r0; r <= rg.r1; r++) {
    for (let c = rg.c0; c <= rg.c1; c++) {
      const x = out[r][c];
      if (x.text) texts.push(x.text);
      if (r !== rg.r0 || c !== rg.c0) out[r][c] = { text: "", covered: true };
    }
  }
  const a = out[rg.r0][rg.c0];
  a.text = texts.join(" ");
  if (rg.r1 > rg.r0) a.rowSpan = rg.r1 - rg.r0 + 1;
  if (rg.c1 > rg.c0) a.colSpan = rg.c1 - rg.c0 + 1;
  return out;
}

/** Undo every merge whose anchor lies in the rectangle. */
export function unmergeRange(g: GridCell[][], rg: Range): GridCell[][] {
  const out = clone(g);
  for (let r = rg.r0; r <= rg.r1; r++) {
    for (let c = rg.c0; c <= rg.c1; c++) {
      const [ar, ac] = anchorOf(out, r, c);
      const a = out[ar][ac];
      const rs = a.rowSpan ?? 1, cs = a.colSpan ?? 1;
      if (rs === 1 && cs === 1) continue;
      for (let rr = ar; rr < ar + rs; rr++) for (let cc = ac; cc < ac + cs; cc++) {
        if (rr !== ar || cc !== ac) out[rr][cc] = { text: "" };
      }
      delete a.rowSpan; delete a.colSpan;
    }
  }
  return out;
}

export function updateCells(g: GridCell[][], rg: Range, patch: Partial<GridCell>): GridCell[][] {
  const out = clone(g);
  for (let r = rg.r0; r <= rg.r1; r++) for (let c = rg.c0; c <= rg.c1; c++) {
    if (!out[r]?.[c] || out[r][c].covered) continue;
    out[r][c] = { ...out[r][c], ...patch };
  }
  return out;
}

// --- formulas -------------------------------------------------------------------
// Supported: numbers, A1 references, ranges inside functions, + - * / ( ), unary minus,
// SUM / AVERAGE / MIN / MAX / COUNT / ROUND / ABS.

export const colName = (c: number) => {
  let s = ""; let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

function parseRef(ref: string): [number, number] | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/,/g, "").trim();
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t)) return null;
  const n = Number(t.replace("%", ""));
  return t.endsWith("%") ? n / 100 : n;
}

type Tok = { k: "num"; v: number } | { k: "ref"; v: string } | { k: "id"; v: string } | { k: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) { out.push({ k: "num", v: Number(num[1]) }); i += num[1].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      const w = id[0];
      out.push(/^[A-Za-z]+\d+$/.test(w) ? { k: "ref", v: w.toUpperCase() } : { k: "id", v: w.toUpperCase() });
      i += w.length; continue;
    }
    if ("+-*/(),:".includes(ch)) { out.push({ k: "op", v: ch }); i++; continue; }
    throw new Error("bad char " + ch);
  }
  return out;
}

export function evalFormula(formula: string, get: (r: number, c: number) => number): number {
  const toks = lex(formula.replace(/^=/, ""));
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p++];
    if (!t || (v && !(t.k === "op" && t.v === v))) throw new Error("syntax");
    return t;
  };
  const rangeVals = (a: string, b: string): number[] => {
    const ra = parseRef(a), rb = parseRef(b);
    if (!ra || !rb) throw new Error("ref");
    const vals: number[] = [];
    for (let r = Math.min(ra[0], rb[0]); r <= Math.max(ra[0], rb[0]); r++)
      for (let c = Math.min(ra[1], rb[1]); c <= Math.max(ra[1], rb[1]); c++) vals.push(get(r, c));
    return vals;
  };
  const args = (): number[] => {
    const vals: number[] = [];
    eat("(");
    if (peek()?.k === "op" && peek()!.v === ")") { p++; return vals; }
    for (;;) {
      const t = peek();
      if (t?.k === "ref" && toks[p + 1]?.k === "op" && toks[p + 1].v === ":") {
        p += 2;
        const b = eat();
        if (b.k !== "ref") throw new Error("range");
        vals.push(...rangeVals(t.v, b.v));
      } else vals.push(expr());
      const n = eat();
      if (n.k === "op" && n.v === ")") return vals;
      if (!(n.k === "op" && n.v === ",")) throw new Error("args");
    }
  };
  const atom = (): number => {
    const t = eat();
    if (t.k === "num") return t.v;
    if (t.k === "ref") { const rc = parseRef(t.v); if (!rc) throw new Error("ref"); return get(rc[0], rc[1]); }
    if (t.k === "op" && t.v === "(") { const v = expr(); eat(")"); return v; }
    if (t.k === "op" && t.v === "-") return -atom();
    if (t.k === "op" && t.v === "+") return atom();
    if (t.k === "id") {
      const a = args();
      switch (t.v) {
        case "SUM": return a.reduce((s, x) => s + x, 0);
        case "AVERAGE": case "AVG": return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
        case "MIN": return a.length ? Math.min(...a) : 0;
        case "MAX": return a.length ? Math.max(...a) : 0;
        case "COUNT": return a.length;
        case "ABS": return Math.abs(a[0] ?? 0);
        case "ROUND": { const f = 10 ** (a[1] ?? 0); return Math.round((a[0] ?? 0) * f) / f; }
        default: throw new Error("unknown function " + t.v);
      }
    }
    throw new Error("syntax");
  };
  const term = (): number => {
    let v = atom();
    while (peek()?.k === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = eat().v; const r = atom();
      v = op === "*" ? v * r : r === 0 ? NaN : v / r;
    }
    return v;
  };
  function expr(): number {
    let v = term();
    while (peek()?.k === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = eat().v; const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  if (p !== toks.length) throw new Error("syntax");
  return v;
}

export const gridHasFormula = (g: GridCell[][]) => g.some((r) => r.some((c) => !!c.formula));

/** Evaluate every formula cell; returns a grid whose formula cells carry the computed number (or #ERR). */
export function evalGrid(g: GridCell[][], decimals = 0): GridCell[][] {
  if (!gridHasFormula(g)) return g;
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const value = (r: number, c: number): number => {
    const key = r + ":" + c;
    if (memo.has(key)) return memo.get(key)!;
    const x = g[r]?.[c];
    if (!x) return 0;
    if (!x.formula) return toNumber(x.text) ?? 0;
    if (visiting.has(key)) throw new Error("cycle");
    visiting.add(key);
    const v = evalFormula(x.formula, value);
    visiting.delete(key);
    memo.set(key, v);
    return v;
  };
  return g.map((row, r) => row.map((x, c) => {
    if (!x.formula) return x;
    let text: string;
    try { text = formatNumber(value(r, c), decimals); } catch { text = "#ERR"; }
    const n = { ...x, text };
    delete n.formula;
    return n;
  }));
}

export function formatNumber(n: number, decimals = 0): string {
  if (!Number.isFinite(n)) return "#ERR";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// --- data binding ---------------------------------------------------------------

/** Year-like values: every present value is a whole number between 1900 and 2100 (decided by value, not by name). */
export function isYearLike(_name: string, values: (string | number | null)[]): boolean {
  const nums = values.filter((v) => v != null && v !== "");
  return nums.length > 0 && nums.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 1900 && v <= 2100);
}

/**
 * Columns summed on a total row when the user has not picked any: none. Which columns to total is
 * an explicit per-table choice (block.source.totalColumns); it is never guessed from column names.
 */
export function defaultTotalColumns(_wanted: string[], _data: BlockData): string[] {
  return [];
}

/**
 * Grid as rendered: header rows from the block, body from the bound data (when bound),
 * formulas evaluated. Numbers are formatted and right-aligned.
 */
export function renderGrid(block: TableBlock, data?: BlockData): GridCell[][] {
  if (!block.source) return evalGrid(block.grid, block.decimals ?? 0);
  const hr = Math.min(block.headerRows, block.grid.length);
  if (!data) {
    const n = Math.max(colCount(block.grid), block.source.columns?.length ?? 0, 1);
    const head = hr > 0 ? block.grid.slice(0, hr) : (block.source.columns?.length ? [block.source.columns.map((w) => ({ text: w, bold: true, align: "center" as const }))] : []);
    return [...head, ...Array.from({ length: 3 }, () => Array.from({ length: n }, () => ({ text: "", skeleton: true })))];
  }
  if (data.error) {
    const head = block.grid.slice(0, hr);
    const n = Math.max(colCount(block.grid), 1);
    const msg = data?.error ? "Data error: " + data.error : "No data loaded";
    return [...head, [{ text: msg, colSpan: n, italic: true }, ...Array.from({ length: n - 1 }, () => ({ text: "", covered: true }))]];
  }
  const wanted = block.source.columns?.length ? block.source.columns : data.columns;
  const idx = wanted.map((w) => data.columns.findIndex((c) => c.toLowerCase() === w.toLowerCase()));
  const head = hr > 0 ? block.grid.slice(0, hr) : [wanted.map((w) => ({ text: w, bold: true, align: "center" as const }))];
  const proto = block.grid[hr] ?? [];
  // decimals: explicit setting wins; otherwise whole-number columns get 0 and the rest 2
  const colDec = idx.map((k) => block.decimals ?? (k >= 0 && data.rows.some((r) => typeof r[k] === "number" && !Number.isInteger(r[k])) ? 2 : 0));
  const sumCols = (block.source.totalColumns ?? defaultTotalColumns(wanted, data)).map((c) => c.toLowerCase());
  const totals = wanted.map(() => 0);
  const numeric = wanted.map(() => false);
  // Years print as 2025, never 2,025 - and are never summed, even when picked for the total row.
  const yearCol = idx.map((k, j) => k >= 0 && isYearLike(wanted[j], data.rows.map((r) => r[k])));
  const body: GridCell[][] = data.rows.map((row) => wanted.map((_, j) => {
    const v = idx[j] >= 0 ? row[idx[j]] : null;
    const style = { ...(proto[j] ?? {}), text: "" };
    delete style.formula; delete style.covered; delete style.rowSpan; delete style.colSpan;
    if (typeof v === "number") {
      totals[j] += v; numeric[j] = true;
      if (yearCol[j] && Number.isInteger(v)) return { ...style, text: String(v), align: style.align ?? "right" };
      return { ...style, text: formatNumber(v, colDec[j]), align: style.align ?? "right" };
    }
    return { ...style, text: v == null ? "" : String(v) };
  }));
  if (block.source.totalRow && body.length) {
    // The label always sits in the first column; only chosen (or default) numeric columns are summed.
    body.push(wanted.map((_, j) => j === 0
      ? { text: block.source!.totalLabel || "Total", bold: true }
      : numeric[j] && !yearCol[j] && sumCols.includes(wanted[j].toLowerCase()) ? { text: formatNumber(totals[j], colDec[j]), bold: true, align: "right" as const } : { text: "" }));
  }
  return [...head, ...body];
}

// --- page splitting -------------------------------------------------------------

/** Force a visible border on one side of each cell (copy) — closes a table piece at a page cut. */
export function closeRowBorder(row: GridCell[], side: "t" | "b"): GridCell[] {
  return row.map((c) => c.covered ? c : { ...c, borders: { ...(c.borders ?? {}), [side]: Math.max(c.borders?.[side] ?? 1, 1) } });
}

/** True when a vertical merge starts in the header and reaches the body — such a grid cannot repeat its header. */
export function mergeCrossesHeader(g: GridCell[][], headerRows: number): boolean {
  const hr = Math.min(headerRows, g.length);
  for (let r = 0; r < hr; r++) for (const c of g[r]) {
    if (!c.covered && (c.rowSpan ?? 1) > 1 && r + (c.rowSpan ?? 1) > hr) return true;
  }
  return false;
}

/**
 * Split a grid before row `cut` (a body row index into the full grid). The head keeps rows
 * [0, cut); the tail repeats the header rows then continues from `cut`. A vertical merge that
 * crosses the cut is torn: shortened in the head and re-opened (with contText) in the tail.
 */
export function splitGrid(g: GridCell[][], headerRows: number, cut: number): { head: GridCell[][]; tail: GridCell[][] } {
  const hr = Math.min(headerRows, g.length);
  const head = g.slice(0, cut).map((r) => r.map((c) => ({ ...c })));
  const tailBody = g.slice(cut).map((r) => r.map((c) => ({ ...c })));
  for (let r = hr; r < cut; r++) {
    head[r].forEach((c, ci) => {
      const rs = c.rowSpan ?? 1;
      if (c.covered || r + rs <= cut) return;
      if (cut - r > 1) c.rowSpan = cut - r; else delete c.rowSpan;
      const reopened: GridCell = { ...g[r][ci] };
      delete reopened.covered;
      if (reopened.contText != null) reopened.text = reopened.contText;
      if (r + rs - cut > 1) reopened.rowSpan = r + rs - cut; else delete reopened.rowSpan;
      if (tailBody[0]) tailBody[0][ci] = reopened;
    });
  }
  if (head.length) head[head.length - 1] = closeRowBorder(head[head.length - 1], "b");
  return { head, tail: [...g.slice(0, hr), ...tailBody] };
}

/**
 * First cut for a piece: accumulate row heights until header + rows exceed `avail`, keeping
 * at least one body row. Returns null when everything fits.
 */
export function firstCutAt(rowHeights: number[], headerRows: number, avail: number): number | null {
  const hr = Math.min(headerRows, rowHeights.length);
  let used = 0;
  for (let r = 0; r < hr; r++) used += rowHeights[r];
  for (let r = hr; r < rowHeights.length; r++) {
    if (r > hr && used + rowHeights[r] > avail) return r;
    used += rowHeights[r];
  }
  return null;
}
