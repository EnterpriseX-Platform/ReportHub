"use client";

/**
 * Pager for data tables, shared by every screen that shows tabular results.
 * Carbon's `Pagination` renders native <select>s for page size and page number, which this app
 * does not allow — so this is the same Carbon pagination bar (Carbon's own `cds--pagination`
 * classes) with Carbon `Dropdown`s in place of the selects and `IconButton`s for previous/next.
 * `total = -1` means the total row count is unknown (not requested, or the count timed out);
 * the bar then shows plain previous/next instead of page numbers.
 */
import { Dropdown, IconButton } from "@carbon/react";
import { CaretLeft, CaretRight } from "@carbon/icons-react";
import { useId } from "react";

export const PAGE_SIZES = [25, 50, 100, 250, 500];
export const DEFAULT_PAGE_SIZE = 100;

const n = (v: number) => v.toLocaleString("en-US");
/** Above this many pages the page dropdown would be unwieldy; the bar shows "Page x of y" instead. */
const MAX_PAGE_ITEMS = 1000;

/** The pagination bar itself — page-based. Used by `Pager` (offset-based) and `DataList`. */
export function PagerBar({ page, pageSize, pageSizes, totalItems, pageRows, disabled, onPage, onPageSize }: {
  /** 1-based */
  page: number; pageSize: number; pageSizes: number[];
  /** undefined = unknown total */
  totalItems?: number;
  /** Rows on the current page (for the range text when the total is unknown). */
  pageRows: number;
  disabled?: boolean;
  onPage: (page: number) => void; onPageSize: (size: number) => void;
}) {
  const uid = useId();
  const known = totalItems !== undefined;
  const pages = known ? Math.max(1, Math.ceil(totalItems / pageSize)) : 0;
  const first = (page - 1) * pageSize;
  const hasNext = known ? page < pages : pageRows === pageSize;
  const from = pageRows ? first + 1 : 0;
  const to = first + pageRows;
  const sizes = pageSizes.includes(pageSize) ? pageSizes : [...pageSizes, pageSize].sort((a, b) => a - b);
  const pageItems = known && pages <= MAX_PAGE_ITEMS ? Array.from({ length: pages }, (_, i) => i + 1) : null;

  return (
    <div className="cds--pagination rh-pager" data-disabled={disabled || undefined}>
      <div className="cds--pagination__left">
        <span className="cds--pagination__text" id={`${uid}-rows`}>Rows</span>
        <Dropdown id={`${uid}-size`} type="inline" size="md" label="" titleText="" hideLabel aria-labelledby={`${uid}-rows`}
                  className="rh-pager__dd" items={sizes} selectedItem={pageSize} itemToString={(v) => (v == null ? "" : String(v))}
                  disabled={disabled} onChange={({ selectedItem }) => { if (selectedItem && selectedItem !== pageSize) onPageSize(selectedItem); }} />
        <span className="cds--pagination__text cds--pagination__items-count">
          {known ? `${n(from)}–${n(to)} of ${n(totalItems)}` : `${n(from)}–${n(to)}`}
        </span>
      </div>
      <div className="cds--pagination__right">
        {pageItems ? (
          <>
            <Dropdown id={`${uid}-page`} type="inline" size="md" label="" titleText="Page" hideLabel
                      className="rh-pager__dd" items={pageItems} selectedItem={page} itemToString={(v) => (v == null ? "" : String(v))}
                      disabled={disabled} onChange={({ selectedItem }) => { if (selectedItem && selectedItem !== page) onPage(selectedItem); }} />
            <span className="cds--pagination__text">of {n(pages)} page{pages === 1 ? "" : "s"}</span>
          </>
        ) : (
          <span className="cds--pagination__text">Page {n(page)}{known ? ` of ${n(pages)}` : ""}</span>
        )}
        <div className="cds--pagination__control-buttons">
          <IconButton kind="ghost" size="md" label="Previous page" align="top" disabled={disabled || page <= 1}
                      className="cds--pagination__button" onClick={() => onPage(page - 1)}><CaretLeft /></IconButton>
          <IconButton kind="ghost" size="md" label="Next page" align="top-end" disabled={disabled || !hasNext}
                      className="cds--pagination__button" onClick={() => onPage(page + 1)}><CaretRight /></IconButton>
        </div>
      </div>
    </div>
  );
}

/** Offset-based wrapper used by the data grids (Tables, SQL results, checks). */
export function Pager({ offset, pageRows, total, loading, pageSize, onPageSize, onGo }: {
  offset: number; pageRows: number; total: number; loading: boolean;
  pageSize: number; onPageSize: (n: number) => void; onGo: (offset: number) => void;
}) {
  const known = total >= 0;
  const pages = known ? Math.max(1, Math.ceil(total / pageSize)) : Infinity;
  return (
    <PagerBar page={Math.floor(offset / pageSize) + 1} pageSize={pageSize} pageSizes={PAGE_SIZES}
              totalItems={known ? total : undefined} pageRows={pageRows} disabled={loading}
              onPageSize={onPageSize}
              onPage={(p) => onGo((Math.min(Math.max(p, 1), pages) - 1) * pageSize)} />
  );
}
