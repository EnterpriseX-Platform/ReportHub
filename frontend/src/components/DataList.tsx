"use client";

import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  Table, TableBatchAction, TableBatchActions, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, TableSelectAll, TableSelectRow, TableToolbar, TableToolbarContent,
  TableToolbarSearch, DataTableSkeleton,
} from "@carbon/react";
import { PagerBar } from "@/components/Pager";

export interface DataListColumn<T> {
  key: string;
  header: ReactNode;
  /** Cell content; defaults to `String(row[key])`. */
  render?: (row: T) => ReactNode;
  /** Value used for sorting; defaults to `row[key]`. Set `sortable: false` to turn sorting off for the column. */
  sortValue?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  /** Right-align (numbers). */
  align?: "end";
  width?: number | string;
}

export interface DataListBatchAction<T> {
  label: string;
  icon?: ComponentType;
  onClick: (selected: T[]) => void;
}

/**
 * The common list pattern on Carbon DataTable parts: title/description, toolbar search,
 * toolbar buttons, sortable headers, row selection + batch actions, pagination, row click,
 * per-row actions (last column, e.g. an OverflowMenu or ghost IconButtons).
 *
 * Sorting, filtering and paging are client-side over `rows`. For server paging pass
 * `pagination={false}` and render <Pager> yourself.
 */
export function DataList<T extends { id: string | number }>({
  rows, columns, title, description, search = true, searchText, toolbar, batchActions, onRowClick,
  rowActions, empty = "No items", loading, pageSize = 25, pagination = true, size = "lg", initialSort,
}: {
  rows: T[];
  columns: DataListColumn<T>[];
  title?: ReactNode;
  description?: ReactNode;
  /** Show the toolbar search. `searchText(row)` gives the text matched (default: all column values). */
  search?: boolean;
  searchText?: (row: T) => string;
  /** Toolbar content to the right of search — usually a primary <Button>. */
  toolbar?: ReactNode;
  /** Enables row checkboxes; shown in Carbon's batch action bar when rows are selected. */
  batchActions?: DataListBatchAction<T>[];
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => ReactNode;
  empty?: ReactNode;
  /** true = Carbon DataTableSkeleton instead of the table. */
  loading?: boolean;
  pageSize?: number;
  pagination?: boolean;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  initialSort?: { key: string; dir: "ASC" | "DESC" };
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "ASC" | "DESC" | "NONE" }>(initialSort ?? { key: "", dir: "NONE" });
  const [page, setPage] = useState(1);
  const [size_, setSize] = useState(pageSize);
  const [sel, setSel] = useState<Set<string | number>>(new Set());

  // Selection never outlives the rows it pointed at.
  useEffect(() => { setSel((s) => new Set([...s].filter((id) => rows.some((r) => r.id === id)))); }, [rows]);
  useEffect(() => { setPage(1); }, [q]);

  const val = (row: T, c: DataListColumn<T>) => (c.sortValue ? c.sortValue(row) : (row as Record<string, unknown>)[c.key]);
  const filtered = useMemo(() => {
    if (!q) return rows;
    const needle = q.toLowerCase();
    const text = searchText ?? ((r: T) => columns.map((c) => String(val(r, c) ?? "")).join(" "));
    return rows.filter((r) => text(r).toLowerCase().includes(needle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, columns, searchText]);
  const sorted = useMemo(() => {
    const c = columns.find((x) => x.key === sort.key);
    if (!c || sort.dir === "NONE") return filtered;
    const m = sort.dir === "ASC" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const x = val(a, c), y = val(b, c);
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * m;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort, columns]);
  const shown = pagination ? sorted.slice((page - 1) * size_, page * size_) : sorted;

  const selectable = !!batchActions?.length;
  const selected = rows.filter((r) => sel.has(r.id));
  const allOnPage = shown.length > 0 && shown.every((r) => sel.has(r.id));
  const someOnPage = shown.some((r) => sel.has(r.id));
  const nextDir = (key: string) => (sort.key !== key ? "ASC" : sort.dir === "ASC" ? "DESC" : sort.dir === "DESC" ? "NONE" : "ASC");

  if (loading) return <DataTableSkeleton rowCount={5} columnCount={columns.length} showHeader={!!title} showToolbar={search} />;

  return (
    <TableContainer title={title} description={description} className="rh-datalist">
      {(search || toolbar || selectable) && (
        <TableToolbar>
          {selectable && (
            <TableBatchActions shouldShowBatchActions={selected.length > 0} totalSelected={selected.length}
                               onCancel={() => setSel(new Set())}>
              {batchActions!.map((a) => (
                <TableBatchAction key={a.label} renderIcon={a.icon} onClick={() => a.onClick(selected)}>{a.label}</TableBatchAction>
              ))}
            </TableBatchActions>
          )}
          <TableToolbarContent aria-hidden={selected.length > 0}>
            {search && <TableToolbarSearch persistent onChange={(e) => setQ(typeof e === "string" ? e : (e.target as HTMLInputElement).value)} />}
            {toolbar}
          </TableToolbarContent>
        </TableToolbar>
      )}
      <Table size={size} useZebraStyles={false}>
        {/* Column widths go on <col>: Carbon passes a sortable TableHeader's style to its inner button, not the <th>. */}
        {columns.some((c) => c.width) && (
          <colgroup>
            {selectable && <col />}
            {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
            {rowActions && <col />}
          </colgroup>
        )}
        <TableHead>
          <TableRow>
            {selectable && (
              <TableSelectAll id="rh-sel-all" name="rh-sel-all" ariaLabel="Select all rows" checked={allOnPage} indeterminate={someOnPage && !allOnPage}
                onSelect={() => setSel((s) => { const n = new Set(s); shown.forEach((r) => (allOnPage ? n.delete(r.id) : n.add(r.id))); return n; })} />
            )}
            {columns.map((c) => (
              <TableHeader key={c.key} isSortable={c.sortable !== false} sortDirection={sort.key === c.key ? sort.dir : "NONE"}
                           onClick={c.sortable !== false ? () => setSort({ key: c.key, dir: nextDir(c.key) }) : undefined}
                           className={c.align === "end" ? "rh-th-end" : undefined}>
                {c.header}
              </TableHeader>
            ))}
            {rowActions && <TableHeader aria-label="Actions" />}
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.map((r) => (
            <TableRow key={r.id} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? "rh-row-click" : undefined}
                      isSelected={sel.has(r.id)}>
              {selectable && (
                <TableSelectRow id={`rh-sel-${r.id}`} name={`rh-sel-${r.id}`} ariaLabel="Select row" checked={sel.has(r.id)}
                  onSelect={(e) => { e.stopPropagation(); setSel((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; }); }} />
              )}
              {columns.map((c) => (
                <TableCell key={c.key} className={c.align === "end" ? "rh-td-end" : undefined}>
                  {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "—")}
                </TableCell>
              ))}
              {rowActions && (
                <TableCell className="cds--table-column-menu rh-row-actions" onClick={(e) => e.stopPropagation()}>{rowActions(r)}</TableCell>
              )}
            </TableRow>
          ))}
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0)} className="rh-empty-cell">{q ? "No matches" : empty}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {pagination && sorted.length > size_ && (
        <PagerBar page={page} pageSize={size_} pageSizes={[10, 25, 50, 100]} totalItems={sorted.length}
                  pageRows={Math.max(0, Math.min(size_, sorted.length - (page - 1) * size_))}
                  onPage={setPage} onPageSize={(ps) => { setSize(ps); setPage(1); }} />
      )}
    </TableContainer>
  );
}
