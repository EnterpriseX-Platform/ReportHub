// Page size registry — the single source for the editor, the paginated preview and the
// print CSS (@page), so preview and PDF always break pages at the same place.
import type { Orientation, PageSizeValue } from "./types";

export interface PageSize {
  /** Value stored in documents — never rename an existing id. */
  id: string;
  label: string;
  note?: string;
  widthMm: number;
  heightMm: number;
}

export const PAGE_SIZES: PageSize[] = [
  { id: "a4", label: "A4", note: "210 × 297 mm", widthMm: 210, heightMm: 297 },
  { id: "a5", label: "A5", note: "148 × 210 mm", widthMm: 148, heightMm: 210 },
  { id: "b5", label: "B5 (JIS)", note: "182 × 257 mm", widthMm: 182, heightMm: 257 },
  { id: "letter", label: "Letter", note: "8.5 × 11 in", widthMm: 215.9, heightMm: 279.4 },
  { id: "legal", label: "Legal", note: "8.5 × 14 in", widthMm: 215.9, heightMm: 355.6 },
];

export const DEFAULT_PAGE_SIZE = PAGE_SIZES[0].id;

/**
 * Resolve a stored value to a real size. Out-of-range custom sizes fall back to A4 — a zero or
 * negative content area would make the paginator loop forever or drop content silently.
 */
export function pageSizeOf(v?: PageSizeValue): PageSize {
  if (v && typeof v === "object") {
    const w = Number(v.widthMm);
    const h = Number(v.heightMm);
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 50 && h >= 50 && w <= 2000 && h <= 2000) {
      return { id: "custom", label: "Custom", widthMm: w, heightMm: h };
    }
    return PAGE_SIZES[0];
  }
  return PAGE_SIZES.find((p) => p.id === v) ?? PAGE_SIZES[0];
}

/** Physical page dimensions for an orientation. */
export function pageDims(v: PageSizeValue | undefined, o: Orientation): { w: number; h: number } {
  const p = pageSizeOf(v);
  const short = Math.min(p.widthMm, p.heightMm);
  const long = Math.max(p.widthMm, p.heightMm);
  return o === "landscape" ? { w: long, h: short } : { w: short, h: long };
}

export const MM_PX = 96 / 25.4;
