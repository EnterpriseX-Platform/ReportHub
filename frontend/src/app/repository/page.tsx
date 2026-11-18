"use client";

// Repository / Database Tool: page through and edit table rows, and run ad-hoc SQL.
// Reuses the datasource JDBC plumbing; all writes go through parameterized,
// identifier-validated backend endpoints.
//
// The left panel lists the tables an admin PUT on this screen (repo_table), not everything the
// connection can see — a large database can expose well over a thousand tables, which is not a
// screen anyone can work with. `?menu=<key>` selects which set to show, so one screen serves
// several host-app menus. Admins can still browse the raw catalogue with the toggle.
import { Skeleton } from "@/components/ui";
import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon, carbonIcon } from "@/components/Icon";
import {
  Button, ButtonSet, Checkbox, DataTableSkeleton, DismissibleTag, IconButton, InlineNotification, Layer, Menu, MenuItem,
  MenuItemDivider, MenuItemGroup, OperationalTag, OverflowMenu, OverflowMenuItem, Search, SelectableTag, Stack, Tab, TabList,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, Tag, TextInput, Tile,
} from "@carbon/react";
import {
  Add, ArrowDown, ArrowLeft, ArrowUp, ArrowsVertical, Checkmark, ChevronDown, ChevronUp, Close, DataBase, Download, Draggable,
  Edit, Filter, Folder, FolderAdd, Renew, Settings, SidePanelClose, SidePanelOpen, Table as TableIcon, TrashCan,
} from "@carbon/icons-react";
import styles from "./repository.module.scss";
import { AccessButton } from "@/components/AccessPanel";
import { Select } from "@/components/Select";
import { Pager, PAGE_SIZES, DEFAULT_PAGE_SIZE } from "@/components/Pager";
import { Modal, SlideOver } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { api, OPT_LIMIT } from "@/lib/api";
import { byFolder, usePortalYear, fiscalYearNow, year2 } from "@/lib/portal-year";
import { HeaderFilter, EMPTY_FILTER, isFilterOn, type ColFilterValue } from "@/components/HeaderFilter";
import { SaveDestination, getSharedWorkspace } from "@/components/workspace";
import type { Datasource, RepoColumn, RepoExecResult, RepoFolder, RepoOption, RepoRows, RepoTable, RepoTableEntry, RepoTableEntryInput, RepoTableMeta, SavedViewRow } from "@/lib/types";

/** Default rows per page — changeable from the bottom bar and remembered across visits. */
const PAGE_KEY = "rs.repo.pageSize";
const NAV_KEY = "rs.repo.navOpen";

/** One level of the folder tree the screen draws. */
interface FolderNode {
  folder: RepoFolder;
  children: FolderNode[];
  items: RepoTableEntry[];
  /** Table count across all sub-levels — a folder header shows the total, not just its own level. */
  total: number;
}

/**
 * Build the tree from repo_folder, ordered by the sort_order the user arranged by dragging,
 * not alphabetically as when folders were plain text in repo_table.folder.
 */
function buildFolderTree(folders: RepoFolder[], rows: RepoTableEntry[]): {
  roots: FolderNode[]; loose: RepoTableEntry[];
} {
  const byId = new Map<number, FolderNode>();
  for (const f of folders) byId.set(f.id, { folder: f, children: [], items: [], total: 0 });

  const roots: FolderNode[] = [];
  for (const n of byId.values()) {
    const parent = n.folder.parentId != null ? byId.get(n.folder.parentId) : undefined;
    if (parent) parent.children.push(n); else roots.push(n);
  }

  const loose: RepoTableEntry[] = [];
  for (const r of rows) {
    const n = r.folderId != null ? byId.get(r.folderId) : undefined;
    if (n) n.items.push(r); else loose.push(r);
  }

  const order = (a: FolderNode, b: FolderNode) =>
    (a.folder.sortOrder ?? 0) - (b.folder.sortOrder ?? 0) || a.folder.id - b.folder.id;
  const count = (n: FolderNode): number => {
    n.children.sort(order);
    n.total = n.items.length + n.children.reduce((acc, c) => acc + count(c), 0);
    return n.total;
  };
  roots.sort(order);
  roots.forEach(count);
  return { roots, loose };
}

// Writing SQL lives on the /sqleditor screen; this screen has no "sql" tab.
type Tab = "data" | "columns" | "settings";

/**
 * What a portal menu lets you do to the rows it shows.
 *
 *  - "read-only" — no add, edit or delete.
 *  - "update-only" — no adding rows on any table. Correcting a row stays on: rows there may be
 *    corrected but never removed.
 * A menu with no entry here is unrestricted, which is what /repository is outside the portal.
 * The server enforces the same table in RepositoryController — this map only decides which
 * affordances are drawn.
 */
const MENU_RIGHTS: Record<string, { add: boolean; edit: boolean; del: boolean }> = {
  "read-only": { add: false, edit: false, del: false },
  "update-only": { add: false, edit: true, del: false },
};
const FULL_RIGHTS = { add: true, edit: true, del: true };

/** One user-facing filter on a data screen, as the registry spells it. */
type FilterCol = { col: string; label: string; labelSource: string | null; optionsFrom: string | null;
                  def: string | null;
                  /** Show the name only, without the code prefix — set with "!" before the label/options source in the registry. */
                  labelOnly?: boolean };

/**
 * `REGION:Region:REGION_NAME` -> what the picker shows and where its names come from.
 *
 * Both halves live in the registry rather than in this file: the same screen serves several
 * tables whose columns are named differently, and a table added later should not need a code
 * change to read properly.
 *
 * A bare `REGION` keeps the old behaviour — column name as the label, no names in the list.
 */
/**
 * Column order the screen shows — the physical order in the database is untouched.
 *
 * Format: groups separated by ';', each `COL[,COL...]>AFTER_COL` = move the left-hand columns
 * to sit right after AFTER_COL, e.g.
 *   'TAX,TOTAL>PRICE; REGION_CODE,REGION_NAME>BRANCH_NAME'
 *
 * Names that are not found are skipped silently — when a table changes shape the screen must
 * still open. (Reordering the table itself is not an option: Oracle cannot do it in place, it
 * means rebuilding the table, risking partitions/indexes/grants and needing twice the disk.)
 */
function columnOrderIndex(spec: string | null | undefined, columns: string[]): number[] {
  const order = columns.map((_, i) => i);
  if (!spec || !spec.trim()) return order;
  const at = (name: string) => columns.findIndex((c) => c.toLowerCase() === name.trim().toLowerCase());

  /**
   * Second form: a **plain ordered column list** with no '>' — produced by drag-sorting on the
   * Properties tab. Names not in the list follow in their original order, so columns added to
   * the table later still show up. The move form (A,B>C) keeps working as before.
   */
  if (!spec.includes(">")) {
    const listed: number[] = [];
    const seen = new Set<number>();
    for (const name of spec.split(",")) {
      const i = at(name);
      if (i >= 0 && !seen.has(i)) { seen.add(i); listed.push(i); }
    }
    return listed.length ? [...listed, ...order.filter((i) => !seen.has(i))] : order;
  }

  for (const group of spec.split(";")) {
    const [movedRaw, afterRaw] = group.split(">");
    if (!movedRaw || !afterRaw) continue;
    const anchor = at(afterRaw);
    if (anchor < 0) continue;
    const moved = movedRaw.split(",").map(at).filter((i) => i >= 0 && i !== anchor);
    if (!moved.length) continue;
    const kept = order.filter((i) => !moved.includes(i));
    const pos = kept.indexOf(anchor);
    if (pos < 0) continue;
    kept.splice(pos + 1, 0, ...moved);
    order.length = 0; order.push(...kept);
  }
  return order;
}

/** Oracle pseudo-column usable as a key on any table — not a real column, so it is not in the column list. */
const ROWID_COL = "ROWID";

/**
 * Pull ROWID out of a result before drawing the grid.
 *
 * The backend sends ROWID as the first column when the table uses ROWID as its key, but it is
 * not data anyone needs to see (and it must not leak into the edit form, or it would be sent
 * back as a column to UPDATE). Keep it aside, aligned row by row, and use it to build the key
 * on edit/delete.
 */
function stripRowIds<T extends { columns: string[]; rows: (string | number | null)[][] }>(data: T)
    : { data: T; ids: string[] | null } {
  const i = data.columns.findIndex((c) => c.toUpperCase() === ROWID_COL);
  if (i < 0) return { data, ids: null };
  return {
    data: { ...data, columns: data.columns.filter((_, j) => j !== i),
            rows: data.rows.map((r) => r.filter((_, j) => j !== i)) },
    ids: data.rows.map((r) => String(r[i] ?? "")),
  };
}

/** Reorder headers and row values together — always with the same index, or values land under the wrong column. */
function applyColumnOrder<T extends { columns: string[]; rows: (string | number | null)[][] }>(
  spec: string | null | undefined, data: T): T {
  const idx = columnOrderIndex(spec, data.columns);
  if (idx.every((v, i) => v === i)) return data;
  return { ...data, columns: idx.map((i) => data.columns[i]),
           rows: data.rows.map((r) => idx.map((i) => r[i])) };
}

function parseFilterColumns(csv: string | null | undefined, year?: string): FilterCol[] {
  return (csv ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    // COLUMN:label:label source:options source:default
    //   options source — SCHEMA.TABLE.CODE.NAME makes the dropdown read from that small lookup
    //     instead of scanning the data table (a multi-GB table cannot feed a dropdown).
    //   default — preselected when the screen opens, still changeable/clearable. It keeps a big
    //     table from opening with an unfiltered query.
    const [col, label, labelSource, optionsFrom, def] = entry.split(":").map((s) => s.trim());
    return { col, label: label || col, labelSource: labelSource || null, optionsFrom: optionsFrom || null,
             def: defaultValue(def, year) };
  });
}

/**
 * Default value of a filter — accepts the same year placeholders as eq_filter.
 *
 * The registry writes `$YEAR4` (four digits, e.g. 2026) or `$YEAR2` (two digits, 26)
 * and the screen fills in the portal's year. Otherwise every entry would need editing each fiscal
 * year, and one that was missed would silently open on last year.
 *
 * Unknown year = no default, never the literal "$YEAR2" as a filter (0 rows with no clue why).
 */
function defaultValue(def: string | undefined, year?: string): string | null {
  const d = (def ?? "").trim();
  if (!d) return null;
  if (!needsYear(d)) return d;
  if (!year) return null;
  return d.replace(/\$YEAR(?::?([24]))?\b/g,
                   (_m, digits, fy) => (digits === "2" || fy ? year2(year) : year));
}

/**
 * "A=1;B=2" -> ["A=1","B=2"] for the rows endpoint's repeatable `eq` param.
 *
 * Registry filters are `COLUMN=value`, `;`-separated. Two placeholders carry the portal's year,
 * because some tables write the year as four digits (2026) and others as two (26). The
 * registry entry says which shape its table uses, so neither has to be guessed from the column name.
 *
 *   <column>=$YEAR4  ->  <column>=2026
 *   <column>=$YEAR2  ->  <column>=26   (same year, the shape that column uses)
 *
 * A filter naming a placeholder is dropped entirely while the year is unknown (screen opened
 * outside the portal), so it never degrades into matching the literal "$YEAR4".
 */
/**
 * Whether this table's registry entry declares a year filter.
 *
 * Opening the console directly, outside the portal, there is no stored fiscal year and eqList
 * would drop the year filter, firing SELECT * and COUNT(*) unfiltered at a very large table. A
 * table that declares a year filter must not query at all while the year is unknown.
 */
/**
 * The table's year column for the optional year picker — the one configured on the registry entry
 * (repo_table.year_column), never guessed from column names. Null when none is configured, the
 * table does not have it, or the fixed filters already pin it.
 */
function exportYearColumn(configured: string | null | undefined, cols: string[] | undefined, activeEq: string[]): string | null {
  const want = (configured ?? "").trim().toUpperCase();
  if (!want || !cols) return null;
  const hit = cols.find((c) => c.toUpperCase() === want);
  if (!hit) return null;
  const already = activeEq.some((e) => e.split("=")[0].trim().toUpperCase() === want);
  return already ? null : hit;
}

function needsYear(f: string | null | undefined): boolean {
  return /\$YEAR(?::?[24])?\b/.test(f ?? "");
}

/**
 * Filters assembled from several fields — e.g. a composite partition key.
 *
 * Example: a table LIST-partitioned on **one PART_KEY column** whose values are
 * FY|REGION|CATEGORY joined by '|', e.g. '26|N|A'. Filtering on FY alone prunes no
 * partition, so every query scans them all and can hit a reverse proxy's request timeout.
 *
 * Registry setup: in eq_filter, write a term that refers to other fields with $COLUMN
 *    FY=$YEAR2;PART_KEY=$YEAR2|$REGION|$CATEGORY
 * Values come from both fixed filters and what the user picks on screen.
 * A term with any value still missing is dropped whole — sending 'PART_KEY=26|N|$CATEGORY'
 * would filter on text that never exists and return 0 rows with no clue why.
 */
const HAS_PLACEHOLDER = /\$[A-Za-z_][A-Za-z0-9_]*/;

/** Terms still "incomplete" after year substitution — TablePanel fills them from the user's picks. */
function derivedEqList(f: string | null | undefined, year?: string, deferred: string[] = []): string[] {
  return rawEqTerms(f, year, deferred).filter((t) => HAS_PLACEHOLDER.test(t));
}

/**
 * Which field this one's options depend on — "…@PARENT_COL=FIELD" at the end of the options source,
 * e.g. V_BRANCH.CODE.NAME@REGION_CODE=REGION lists branches for the region picked.
 */
function parentColOf(f: FilterCol): string | null {
  const at = (f.optionsFrom ?? "").split("@")[1];
  const want = at?.split("=")[1]?.trim();
  return want || null;
}

function eqList(f: string | null | undefined, year?: string, deferred: string[] = []): string[] {
  // A leftover $ means not ready yet — derivedEqList handles it instead.
  return rawEqTerms(f, year, deferred).filter((t) => !HAS_PLACEHOLDER.test(t));
}

/**
 * @param deferred names of fields the user can pick on screen — placeholders with those names are
 * **never** replaced with the portal year.
 *
 * Example: a table with a user-selectable fiscal year field (column FY) and eq_filter
 * `PART_KEY=$FY|$REGION|$CATEGORY`. `$FY` matches the year-placeholder pattern, so
 * it would be replaced with the portal year right here; switching the year on screen would still
 * read the portal year's partition and **silently return 0 rows every time**. Fields on screen
 * are left for builtEq to fill from what the user actually picked.
 */
function rawEqTerms(f: string | null | undefined, year?: string, deferred: string[] = []): string[] {
  const skip = new Set(deferred.map((d) => d.toUpperCase()));
  const yearRe = /\$YEAR(?::?[24])?\b/g;
  const hitsPortalYear = (x: string) => {
    yearRe.lastIndex = 0;
    for (let m = yearRe.exec(x); m; m = yearRe.exec(x)) {
      if (!skip.has(m[0].slice(1).toUpperCase())) return true;
    }
    return false;
  };
  return (f ?? "").split(";").map((x) => x.trim()).filter(Boolean)
    .flatMap((x) => {
      if (!hitsPortalYear(x)) return [x];
      if (!year) return [];
      return [x.replace(/\$YEAR(?::?([24]))?\b/g,
                        (m, d, fy) => (skip.has(m.slice(1).toUpperCase()) ? m
                                       : d === "2" || fy ? year2(year) : year))];
    });
}

export default function RepositoryPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Repository />
    </Suspense>
  );
}

function Repository() {
  const toast = useToast();
  const search = useSearchParams();
  const menuKey = search.get("menu");
  const [entries, setEntries] = useState<RepoTableEntry[]>([]);
  /** Latest server copy of every entry — saves merge onto this, never onto a copy captured earlier. */
  const entriesRef = useRef<RepoTableEntry[]>([]);
  /** Registry has answered at least once for the signed-in user (avoids an empty-state flash, or a stale
      empty list when the first request raced the sign-in). */
  const [entriesLoaded, setEntriesLoaded] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [entry, setEntry] = useState<RepoTableEntry | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  /** Entry whose settings are being edited — same dialog as adding, saving over it instead. */
  const [editingEntry, setEditingEntry] = useState<RepoTableEntry | null>(null);
  /** Collapse the left panel — wide tables want the 252px back.
      Read localStorage in an effect, not during render (Next.js also renders on the server). */
  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => { setNavOpen(localStorage.getItem(NAV_KEY) !== "0"); }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((v) => { localStorage.setItem(NAV_KEY, v ? "0" : "1"); return !v; });
  }, []);
  const [closedFolders, setClosedFolders] = useState<Set<number>>(new Set());
  /** Row count per entry — -1 = could not count in time (the backend times out at 10s and returns -1). */
  const [rowCounts, setRowCounts] = useState<Record<number, number>>({});
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<number | "root" | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: RepoTableEntry } | null>(null);
  const [folders, setFolders] = useState<RepoFolder[]>([]);
  /** Folder being dragged (separate from dragId, which is a table). */
  const [dragFolder, setDragFolder] = useState<number | null>(null);
  /** Inline input — id=null means creating a new one under parentId. Replaces window.prompt,
   *  an OS dialog that looks out of place and blocks everything else. */
  const [editFolder, setEditFolder] = useState<{ id: number | null; parentId: number | null; value: string } | null>(null);
  /** Folder clicked delete once — a second click deletes, instead of the browser confirm box. */
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [datasourceId, setDatasourceId] = useState<string>("");
  const [tables, setTables] = useState<RepoTable[]>([]);
  const [tablesErr, setTablesErr] = useState<string | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<RepoTable | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  const _portalYear = usePortalYear();
  const portalYear = _portalYear || fiscalYearNow();
  // The menu, not the table, decides what may be written — the same table can sit on two menus.
  // Applied in the raw-catalogue view too: the restriction is on the menu.
  const rights = MENU_RIGHTS[menuKey ?? ""] ?? FULL_RIGHTS;


  useEffect(() => { api.datasources().then(setDss).catch(() => {}); }, []);
  // Load the registry only once the session is confirmed (right after sign-in the first request could
  // otherwise go out before the identity/project is settled and leave "No tables" until a reload).
  useEffect(() => {
    api.me().then((m) => { setIsAdmin(m.role === "ADMIN" || !!m.admin); setAuthReady(true); }).catch(() => {});
  }, []);

  const loadEntries = useCallback(() => {
    if (!authReady) return;
    api.repoRegistry(menuKey)
      .then((rows) => {
        setEntries(rows);
        entriesRef.current = rows;
        setEntriesLoaded(true);
        // Keep the selected entry in step with the server copy (a stale copy here made later saves
        // overwrite earlier ones); land on the first entry when nothing is selected yet.
        setEntry((cur) => (cur ? rows.find((x) => x.id === cur.id) ?? rows[0] ?? null : rows[0] ?? null));
      })
      .catch(() => { setEntries([]); setEntriesLoaded(true); });
  }, [menuKey, authReady]);
  useEffect(() => { loadEntries(); }, [loadEntries]);

  const loadFolders = useCallback(() => {
    if (!authReady) return;
    api.repoFolders(menuKey).then(setFolders).catch(() => setFolders([]));
  }, [menuKey, authReady]);
  useEffect(() => { loadFolders(); }, [loadFolders]);

  /**
   * Move an entry into a group, or out of one. Groups are just the distinct folder names in use,
   * so "creating a folder" is typing a name that nobody has typed yet and "deleting" one is moving
   * its last table out — there is nothing else to keep in step.
   */

  /** Open this entry on the Settings tab (from right-click > Edit settings) instead of Data. */
  const openSettingsNext = useRef(false);

  // Picking an entry drives the datasource + table the panel reads.
  useEffect(() => {
    if (!entry) return;
    setDatasourceId(entry.datasourceId);
    setActive({ name: entry.tableName, schema: entry.schemaName, type: "TABLE" } as RepoTable);
    // This effect runs after the click, so setting the tab directly on click would be overwritten with "data".
    setTab(openSettingsNext.current ? "settings" : "data");
    openSettingsNext.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id]);

  // Only fetched for the raw-catalogue view. Listing every table of a large database is
  // thousands of rows that the curated screen never shows, and it used to clear the selection
  // out from under the entry the user just picked.
  const loadTables = useCallback(() => {
    setLoadingTables(true); setTablesErr(null);
    api.repoTables(datasourceId || null)
      .then((t) => setTables(t))
      .catch((e) => { setTables([]); setTablesErr(e instanceof Error ? e.message : "Failed to load the table list"); })
      .finally(() => setLoadingTables(false));
  }, [datasourceId]);
  useEffect(() => { if (showAll) loadTables(); }, [showAll, loadTables]);

  /** One search box filters both kinds in the panel.
      Search by table name first (what the panel shows), plus schema and folder name, and the
      display label that moved into the tooltip — people who only remember the label can still find it. */
  const shownEntries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.tableName, e.schemaName, `${e.schemaName ?? ""}.${e.tableName}`, e.folder, e.label]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [entries, filter]);
  const shown = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())),
    [tables, filter]);

  const folderTree = useMemo(() => buildFolderTree(folders, shownEntries), [folders, shownEntries]);

  /** Schema most entries use — entries in it skip the schema prefix to save space;
   *  entries in other schemas show SCHEMA.TABLE. */
  const mainSchema = useMemo(() => {
    const tally = new Map<string, number>();
    for (const e of entries) {
      const k = (e.schemaName ?? "").toUpperCase();
      if (k) tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    let best = ""; let n = 0;
    for (const [k, v] of tally) if (v > n) { best = k; n = v; }
    return n > 1 ? best : "";
  }, [entries]);

  /** Same table added as several entries (differing only by filter) — table name alone cannot tell them apart. */
  const dupTable = useMemo(() => {
    const tally = new Map<string, number>();
    for (const e of entries) {
      const k = `${e.schemaName ?? ""}.${e.tableName}`.toUpperCase();
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    return tally;
  }, [entries]);

  function entryName(e: RepoTableEntry) {
    const sc = (e.schemaName ?? "").toUpperCase();
    return sc && sc !== mainSchema ? `${e.schemaName}.${e.tableName}` : e.tableName;
  }

  /** Filter fields of the selected entry — year placeholders already substituted. */
  const entryFilterCols = useMemo(
    () => parseFilterColumns(entry?.filterColumns, portalYear),
    [entry?.filterColumns, portalYear]);
  /** Fields the user picks on screen — same-named placeholders in eq_filter wait for those values, not the portal year. */
  const filterColNames = useMemo(() => entryFilterCols.map((c) => c.col), [entryFilterCols]);

  /**
   * Export jobs still building their file — kept at screen level, **not in the table panel**.
   *
   * Click and move on: once queued, this keeps polling on its own, export can be clicked again any
   * number of times, and each job follows its own result and downloads when done.
   *
   * Kept in TablePanel it would vanish on every table switch (the component is re-keyed) and
   * files already queued would never be picked up, though the server finished them.
   */
  const [exportJobs, setExportJobs] = useState<{ id: string; name: string }[]>([]);
  const trackExport = useCallback((jobId: string, name: string) => {
    setExportJobs((cur) => (cur.some((j) => j.id === jobId) ? cur : [...cur, { id: jobId, name }]));
    (async () => {
      for (let i = 0; i < 300; i++) {              // ~10 minutes
        await new Promise((ok) => setTimeout(ok, 2000));
        const j = await api.job(jobId).catch(() => null);
        if (!j) continue;
        if (j.state === "error") {
          toast(j.errorMessage || `Could not build ${name}`, "error");
          break;
        }
        if (j.state === "done") {
          try {
            await api.jobOutput(jobId, name);
            toast(`${name} is ready`, "ok");
          } catch (e) {
            toast(e instanceof Error ? e.message : `Could not download ${name}`, "error");
          }
          break;
        }
      }
      setExportJobs((cur) => cur.filter((x) => x.id !== jobId));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Save display settings (labels, hidden columns, column order from the Properties tab) to the
   * entry's registry row.
   *
   * Stored in the registry, not on the user's machine — the column layout of a shared table is
   * something everyone should see the same (and exported files follow the agreed order).
   */
  /** Save one registry entry: merge `patch` onto the latest server copy, then show the server's answer at once. */
  const saveEntry = useCallback(async (e: RepoTableEntry, patch: Partial<RepoTableEntryInput>) => {
    const b = entriesRef.current.find((x) => x.id === e.id) ?? e;
    const saved = await api.repoRegistryUpdate(e.id, {
      menuKey: b.menuKey, label: b.label, folder: b.folder, folderId: b.folderId,
      datasourceId: b.datasourceId, schemaName: b.schemaName, tableName: b.tableName,
      eqFilter: b.eqFilter, filterColumns: b.filterColumns, columnOrder: b.columnOrder ?? null,
      hiddenColumns: b.hiddenColumns ?? null, columnLabels: b.columnLabels ?? null,
      keyColumns: b.keyColumns, yearColumn: b.yearColumn ?? null, sortOrder: b.sortOrder,
      ...patch,
    });
    const fresh = saved && typeof saved === "object" && "id" in saved ? saved : { ...b, ...patch } as RepoTableEntry;
    entriesRef.current = entriesRef.current.map((x) => (x.id === fresh.id ? fresh : x));
    setEntries(entriesRef.current);
    setEntry((cur) => (cur?.id === fresh.id ? fresh : cur));
    return fresh;
  }, []);

  /** Put a server copy of one entry on screen at once (list + selected entry). */
  const applyEntry = useCallback((fresh: RepoTableEntry) => {
    const has = entriesRef.current.some((x) => x.id === fresh.id);
    entriesRef.current = has ? entriesRef.current.map((x) => (x.id === fresh.id ? fresh : x)) : [...entriesRef.current, fresh];
    setEntries(entriesRef.current);
    setEntry((cur) => (cur?.id === fresh.id ? fresh : cur));
  }, []);

  const saveLabels = useCallback(async (e: RepoTableEntry, pairs: Record<string, string>) => {
    try {
      await saveEntry(e, {
        columnLabels: Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(",") || null,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveHidden = useCallback(async (e: RepoTableEntry, names: string[]) => {
    try {
      await saveEntry(e, { hiddenColumns: names.length ? names.join(",") : null });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveColumnOrder = useCallback(async (e: RepoTableEntry, spec: string | null) => {
    try {
      await saveEntry(e, { columnOrder: spec });
      toast(spec ? "Column order saved" : "Column order cleared", "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the column order", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Conditions this entry really fires on open = fixed eq + on-screen field defaults + composite
   * terms that are fully filled.
   *
   * The left panel used to count with eq_filter alone. Once the year condition moved from
   * eq_filter to an "on-screen field with a default", the panel showed an all-years COUNT that did
   * not match the grid — and on a big table an unfiltered COUNT(*) on every visit.
   */
  const openingEq = useCallback((e: RepoTableEntry): string[] => {
    const cols = parseFilterColumns(e.filterColumns, portalYear);
    const names = cols.map((c) => c.col);
    const defs = cols.filter((c) => c.def).map((c) => `${c.col}=${c.def}`);
    const fixed = eqList(e.eqFilter, portalYear, names);
    const vals: Record<string, string> = {};
    for (const t of [...fixed, ...defs]) {
      const i = t.indexOf("=");
      if (i > 0) vals[t.slice(0, i).trim().toUpperCase()] = t.slice(i + 1).trim();
    }
    const built = derivedEqList(e.eqFilter, portalYear, names)
      .map((t) => t.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => vals[String(n).toUpperCase()] ?? m))
      .filter((t) => !HAS_PLACEHOLDER.test(t));
    return [...fixed, ...built, ...defs];
  }, [portalYear]);

  // ---- Row count per entry ---------------------------------------------------
  // One at a time, never in parallel — some tables are very large. The backend already times
  // out at 10s and returns -1; entries that cannot be counted in time just show no number.
  useEffect(() => {
    if (showAll || entries.length === 0) return;
    let live = true;
    (async () => {
      for (const e of entries) {
        if (!live) return;
        if (rowCounts[e.id] !== undefined) continue;
        try {
          const r = await api.repoRows(e.tableName, {
            datasourceId: e.datasourceId || null, schema: e.schemaName, limit: 1,
            eq: openingEq(e), withTotal: true,
          });
          if (live) setRowCounts((c) => ({ ...c, [e.id]: r.total }));
        } catch { if (live) setRowCounts((c) => ({ ...c, [e.id]: -1 })); }
      }
    })();
    return () => { live = false; };
    // rowCounts deliberately left out of deps — otherwise this reruns after every count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, showAll, portalYear]);

  /** Move one entry into the given folder (null = out of any folder). */
  async function setEntryFolder(e: RepoTableEntry, folderId: number | null) {
    await saveEntry(e, { folderId });
  }

  const folderName = useCallback(
    (id: number | null) => (id == null ? null : folders.find((f) => f.id === id)?.name ?? null),
    [folders]);

  /** Drop what is being dragged onto a folder (or the root) — tables and folders both drag. */
  async function dropOnto(target: number | null) {
    const tableId = dragId; const folderId = dragFolder;
    setDragId(null); setDragFolder(null); setDropOn(null);
    try {
      if (folderId != null) {
        if (folderId === target) return;
        const f = folders.find((x) => x.id === folderId);
        if (!f || f.parentId === target) return;
        await api.repoFolderUpdate(folderId, { menuKey: f.menuKey, parentId: target, name: f.name });
        loadFolders();
        toast(target == null ? `Moved "${f.name}" to the top level` : `Moved "${f.name}" into "${folderName(target)}"`, "ok");
        return;
      }
      const e = entries.find((x) => x.id === tableId);
      if (!e || (e.folderId ?? null) === target) return;
      await setEntryFolder(e, target);
      loadEntries();
      toast(target == null ? "Taken out of its folder" : `Moved to ${folderName(target)}`, "ok");
    } catch (err) { toast(err instanceof Error ? err.message : "Move failed", "error"); }
  }

  /** Reorder within a level — place the dragged folder "before" the target. */
  async function reorderFolder(beforeId: number) {
    const moving = dragFolder;
    setDragFolder(null); setDropOn(null);
    if (moving == null || moving === beforeId) return;
    const target = folders.find((f) => f.id === beforeId);
    const src = folders.find((f) => f.id === moving);
    if (!target || !src) return;
    try {
      // Different level: move levels first, then order, so no cross-level ordering is created.
      if ((src.parentId ?? null) !== (target.parentId ?? null)) {
        await api.repoFolderUpdate(moving, { menuKey: src.menuKey, parentId: target.parentId, name: src.name });
      }
      const level = folders
        .filter((f) => (f.parentId ?? null) === (target.parentId ?? null) && f.id !== moving)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id)
        .map((f) => f.id);
      const at = level.indexOf(beforeId);
      level.splice(at < 0 ? level.length : at, 0, moving);
      await api.repoFolderReorder(level);
      loadFolders();
    } catch (err) { toast(err instanceof Error ? err.message : "Reorder failed", "error"); }
  }

  /** Save the inline input — create if id is null, otherwise rename. */
  async function commitFolderEdit() {
    const ed = editFolder;
    setEditFolder(null);
    if (!ed) return;
    const name = ed.value.trim();
    if (!name) return;
    try {
      if (ed.id == null) {
        await api.repoFolderAdd({ menuKey: menuKey ?? null, parentId: ed.parentId, name });
        toast(`Folder "${name}" created`, "ok");
      } else {
        const f = folders.find((x) => x.id === ed.id);
        if (!f || f.name === name) return;
        await api.repoFolderUpdate(ed.id, { menuKey: f.menuKey, parentId: f.parentId, name });
        toast(`Renamed to ${name}`, "ok");
      }
      loadFolders();
    } catch (err) { toast(err instanceof Error ? err.message : "Could not save the folder", "error"); }
  }

  /** Delete a folder — its contents move up to the parent, no table is deleted (the backend does this).
   *  Needs two clicks: the first turns the button into a red "Remove?", the second deletes. */
  async function deleteFolder(n: FolderNode) {
    if (confirmDel !== n.folder.id) { setConfirmDel(n.folder.id); return; }
    setConfirmDel(null);
    try {
      await api.repoFolderRemove(n.folder.id);
      loadFolders(); loadEntries();
      toast(`Folder "${n.folder.name}" removed · ${n.total} table${n.total === 1 ? "" : "s"} moved up`, "ok");
    } catch (err) { toast(err instanceof Error ? err.message : "Could not remove the folder", "error"); }
  }

  function newFolder(parentId: number | null = null) {
    if (parentId != null) setClosedFolders((c) => { const x = new Set(c); x.delete(parentId); return x; });
    setEditFolder({ id: null, parentId, value: "" });
  }

  async function removeEntry(e: RepoTableEntry) {
    try {
      await api.repoRegistryRemove(e.id);
      if (entry?.id === e.id) setEntry(null);
      loadEntries();
      toast(`Removed ${entryName(e)}`, "ok");
    } catch (err) { toast(err instanceof Error ? err.message : "Delete failed", "error"); }
  }

  /** One entry row · depth sets the indent. */
  function renderEntry(e: RepoTableEntry, depth: number) {
    const n = rowCounts[e.id];
    // div, not button: the row contains action buttons, and <button> inside <button> makes
    // React throw a hydration error that leaves the whole page on a spinner.
    return (
      <div key={e.id} className={"rh-nt-item" + (entry?.id === e.id ? " rh-nt--on" : "") + (dragId === e.id ? " rh-nt--dragging" : "")}
           role="button" tabIndex={0}
           draggable={isAdmin}
           onDragStart={() => setDragId(e.id)}
           onDragEnd={() => { setDragId(null); setDropOn(null); }}
           onContextMenu={(ev) => { if (!isAdmin) return; ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}
           style={{ cursor: "pointer", paddingLeft: 10 + depth * 14 }}
           onClick={() => setEntry(e)}
           onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setEntry(e); } }}
           title={`${e.label}\n${e.schemaName ? `${e.schemaName}.` : ""}${e.tableName}${e.eqFilter ? `\n${e.eqFilter}` : ""}`}>
        {isAdmin && <Icon name="drag" size={10} className="rh-nt-grip" />}
        <Icon name="table" size={13} className="rh-nt-ico" />
        <span className="rh-nt-text rh-nt-tname">
          <span className="rh-nt-tname-txt">{e.label?.trim() || entryName(e)}</span>
          {/* Filter tag shows only when needed to tell entries apart — the same table added
              several times with different filters would otherwise read as duplicate names. */}
          {e.eqFilter && (dupTable.get(`${e.schemaName ?? ""}.${e.tableName}`.toUpperCase()) ?? 0) > 1 && (
            <span className="rh-nt-tag" title={e.eqFilter}>{e.eqFilter.split("=")[0]}</span>
          )}
        </span>
        {n !== undefined && n >= 0 && <span className="rh-nt-n">{n.toLocaleString("en-US")}</span>}
        {/* Settings button on hover, so editing an added table does not depend on discovering
            the right-click menu (which still works). */}
        {isAdmin && (
          <IconButton kind="ghost" size="sm" className="rh-nt-cog" label="Edit this table's settings" align="left"
                      onClick={(ev) => { ev.stopPropagation(); openSettingsNext.current = true; setEntry(e); setTab("settings"); }}>
            <Icon name="settings" size={16} />
          </IconButton>
        )}
      </div>
    );
  }

  /** Row that becomes an input — used for both creating and renaming. */
  function renderFolderInput(depth: number) {
    return (
      <div className="rh-nt-fold rh-nt--editing" style={{ paddingLeft: 8 + depth * 14 }}>
        <span style={{ width: 11, flex: "none" }} />
        <Icon name="folder" size={13} className="rh-nt-fico" />
        <TextInput id="repo-fold-edit" size="sm" hideLabel labelText="Folder name" className="rh-nt-input" autoFocus
               value={editFolder?.value ?? ""}
               onChange={(e) => setEditFolder((c) => (c ? { ...c, value: e.target.value } : c))}
               onBlur={commitFolderEdit}
               onKeyDown={(e) => {
                 if (e.key === "Enter") { e.preventDefault(); commitFolderEdit(); }
                 if (e.key === "Escape") { e.preventDefault(); setEditFolder(null); }
               }}
               placeholder="Folder name" />
      </div>
    );
  }

  /** One folder level, recursing for sub-levels. */
  function renderFolder(n: FolderNode, depth: number) {
    const f = n.folder;
    // While searching, expand everything — otherwise matches hide inside closed folders.
    const open = filter.trim() ? true : !closedFolders.has(f.id);
    const dragging = dragFolder === f.id;
    return (
      <div key={f.id} style={{ display: "contents" }}>
        {/* Insertion line while dragging a folder in */}
        {dragFolder != null && dropOn === f.id && !dragging && <div className="rh-nt-dropline" style={{ marginLeft: 8 + depth * 14 }} />}
        {editFolder?.id === f.id ? renderFolderInput(depth) : (
        <div className={"rh-nt-fold" + (open ? "" : " rh-nt--shut") + (dropOn === f.id && dragFolder == null ? " rh-nt--drop" : "") + (dragging ? " rh-nt--dragging" : "")}
             role="button" tabIndex={0}
             draggable={isAdmin}
             onDragStart={(ev) => { ev.stopPropagation(); setDragFolder(f.id); }}
             onDragEnd={() => { setDragFolder(null); setDropOn(null); }}
             style={{ paddingLeft: 8 + depth * 14 }}
             // dragover bubbles up to the enclosing root drop zone, which overwrites it at once,
             // so the highlight never sticks — stop the bubbling here.
             onDragOver={(ev) => { if (dragId != null || dragFolder != null) { ev.preventDefault(); ev.stopPropagation(); setDropOn(f.id); } }}
             onDragLeave={(ev) => { ev.stopPropagation(); setDropOn((c) => (c === f.id ? null : c)); }}
             onDrop={(ev) => {
               ev.preventDefault(); ev.stopPropagation();
               // Folder dropped on a folder: Shift = nest inside · otherwise = insert before this one
               if (dragFolder != null) { if (ev.shiftKey) dropOnto(f.id); else reorderFolder(f.id); }
               else dropOnto(f.id);
             }}
             onContextMenu={(ev) => { if (!isAdmin) return; ev.preventDefault(); ev.stopPropagation(); setEditFolder({ id: f.id, parentId: f.parentId, value: f.name }); }}
             onClick={() => setClosedFolders((cur) => {
               const next = new Set(cur);
               if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
               return next;
             })}
             onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); (ev.currentTarget as HTMLElement).click(); } }}
             title={`${f.name}\nDouble-click to rename · drop a table here to move it\nDrag a folder here to reorder, hold Shift to nest it inside`}>
          {isAdmin && <Icon name="drag" size={10} className="rh-nt-grip" />}
          <Icon name="chevron" size={11} className="rh-nt-caret" />
          <Icon name={open ? "folderOpen" : "folder"} size={13} className="rh-nt-fico" />
          <span className="rh-nt-name"
                onDoubleClick={(ev) => { if (!isAdmin) return; ev.stopPropagation(); setEditFolder({ id: f.id, parentId: f.parentId, value: f.name }); }}>{f.name}</span>
          <span className="rh-nt-count">{n.total}</span>
          {isAdmin && (
            <span className="rh-nt-acts" onClick={(ev) => ev.stopPropagation()}>
              <IconButton kind="ghost" size="sm" label="New folder inside this one" align="left"
                          onClick={() => newFolder(f.id)}><Add size={16} /></IconButton>
              {/* First click turns the button into a red "Remove?", a second deletes — instead of the browser confirm box */}
              {confirmDel === f.id
                ? <Button kind="danger" size="sm"
                          title={`Click again — ${n.total} table${n.total === 1 ? "" : "s"} inside move up one level, none are deleted`}
                          onClick={() => deleteFolder(n)}>Remove?</Button>
                : <IconButton kind="ghost" size="sm" label="Remove this folder" align="left" onClick={() => deleteFolder(n)}><TrashCan size={16} /></IconButton>}
            </span>
          )}
        </div>
        )}
        {open && (
          <>
            {editFolder && editFolder.id == null && editFolder.parentId === f.id && renderFolderInput(depth + 1)}
            {n.children.map((c) => renderFolder(c, depth + 1))}
            {n.items.map((e) => renderEntry(e, depth + 1))}
          </>
        )}
      </div>
    );
  }


  return (
    <div className="fade-in">
      <div className={styles.pageActions}>
        {/* No connection picker here — each entry carries its own datasourceId (set from the
            entry on selection). */}
        {isAdmin && !showAll && (
          <Button kind="primary" size="md" renderIcon={Add} onClick={() => setAdding(true)}>New table</Button>
        )}
      </div>

      <div className={"rh-ops rh-fill" + (navOpen ? "" : " rh-ops--rail-off")}>
        {/* Same navigation panel as the other ops screens (.ops-nav). Collapsed, it leaves a thin
            strip with an expand button — there must always be a way back. */}
        {!navOpen && (
          <aside className="rh-ops__nav rh-ops__nav--collapsed">
            <IconButton kind="ghost" size="sm" label="Show table list" align="right" onClick={toggleNav}><SidePanelOpen size={16} /></IconButton>
          </aside>
        )}
        <aside className="rh-ops__nav" hidden={!navOpen}>
          <div className={styles.navFind}>
            <Search size="sm" labelText="Find a table" placeholder="Find a table" value={filter}
                    onChange={(e) => setFilter(e.target.value)} />
            <IconButton kind="ghost" size="sm" label="Hide table list" align="bottom-end" onClick={toggleNav}><SidePanelClose size={16} /></IconButton>
          </div>

          {isAdmin && (
            <div className="rh-nt-tools">
              <Button kind="ghost" size="sm" renderIcon={showAll ? ArrowLeft : DataBase} onClick={() => setShowAll((v) => !v)}
                      title={showAll ? "Back to the tables on this screen" : "Browse every table in the connection"}>
                {showAll ? "Back" : "Browse all"}
              </Button>
              {!showAll && (
                <>
                  <span style={{ flex: 1 }} />
                  <IconButton kind="ghost" size="sm" label="New folder" align="bottom-end" onClick={() => newFolder(null)}><FolderAdd size={16} /></IconButton>
                </>
              )}
            </div>
          )}

          {/* Nested folders. Tables with no folder float at the top, no need to expand anything to
              see them. This area is also the drop target for "take out of folder". */}
          {!showAll && (
            <div className={"rh-nt-root" + (dropOn === "root" ? " rh-nt--drop" : "")}
                 onDragOver={(ev) => { if (dragId != null || dragFolder != null) { ev.preventDefault(); setDropOn("root"); } }}
                 onDragLeave={() => setDropOn((c) => (c === "root" ? null : c))}
                 onDrop={(ev) => { ev.preventDefault(); dropOnto(null); }}>
              {/* Not just editFolder?.id == null — with editFolder null that is undefined == null,
                  i.e. true, and the input would appear on page load. Check editFolder first. */}
              {editFolder && editFolder.id == null && editFolder.parentId == null && renderFolderInput(0)}
              {folderTree.roots.map((n) => renderFolder(n, 0))}
              {folderTree.loose.map((e) => renderEntry(e, 0))}
              {(dragId != null || dragFolder != null) && folderTree.loose.length === 0 && (
                <div className="rh-nt-hint">Drop here to move it to the top level</div>
              )}
            </div>
          )}
          {!showAll && entriesLoaded && shownEntries.length === 0 && (
            <p className={styles.navEmpty}>{filter ? "No table matches" : "No tables on this screen yet"}</p>
          )}

          {showAll && loadingTables && <Skeleton />}
          {showAll && tablesErr && <InlineNotification kind="error" lowContrast hideCloseButton title={tablesErr} />}
          {showAll && !loadingTables && !tablesErr && shown.map((t) => {
            const on = active?.name === t.name && active?.schema === t.schema;
            return (
              <button key={`${t.schema ?? ""}.${t.name}`} className={"rh-nt-item" + (on ? " rh-nt--on" : "")}
                      onClick={() => { setActive(t); setTab("data"); }} title={`${t.schema ?? ""}.${t.name}`}>
                <span className="rh-nt-mark" style={{ background: t.type === "VIEW" ? "var(--cds-support-info)" : "var(--cds-icon-disabled)" }} />
                <span className="rh-nt-text">{t.name}</span>
              </button>
            );
          })}
          {showAll && !loadingTables && !tablesErr && shown.length === 0 && (
            <p className={styles.navEmpty}>No tables</p>)}

          <div className={styles.navFoot}>
            <span className="cds--type-label-01 rh-dim">
              {showAll
                ? `${tables.length} tables in connection`
                : `${entries.length} table${entries.length === 1 ? "" : "s"}`}
            </span>
            <IconButton kind="ghost" size="sm" label="Reload" align="top"
                        onClick={() => (showAll ? loadTables() : loadEntries())}><Renew size={16} /></IconButton>
          </div>
        </aside>

        {/* Main panel */}
        {/* With no portal year the screen assumes the current fiscal year, so there is no
            "unknown year" state that blocks the screen. */}
        {active ? (
          <TablePanel key={`${datasourceId}:${active.schema ?? ""}.${active.name}:${entry?.eqFilter ?? ""}:${portalYear}`}
                      label={showAll ? undefined : entry?.label}
                      datasourceId={datasourceId} table={active} tab={tab} setTab={setTab} toast={toast}
                      eq={showAll ? [] : eqList(entry?.eqFilter, portalYear, filterColNames)}
                      derivedEq={showAll ? [] : derivedEqList(entry?.eqFilter, portalYear, filterColNames)}
                      filterColumns={showAll ? [] : entryFilterCols}
                      columnOrder={showAll ? null : entry?.columnOrder ?? null}
                      hiddenColumns={showAll ? null : entry?.hiddenColumns ?? null}
                      columnLabels={showAll ? null : entry?.columnLabels ?? null}
                      rights={rights}
                      settingsPanel={isAdmin && entry && !showAll ? (
                        <AddTableModal inline key={`set-${entry.id}`} menuKey={menuKey} datasources={dss}
                                       currentDsId={datasourceId} existing={entry} folders={folders}
                                       onFoldersChanged={loadFolders} onClose={() => setTab("data")}
                                       onAdded={(res) => { if (res) applyEntry(res); loadEntries(); setTab("data"); }} toast={toast} />
                      ) : undefined}
                      onSaveOrder={isAdmin && entry && !showAll ? (spec) => saveColumnOrder(entry, spec) : undefined}
                      onSaveHidden={isAdmin && entry && !showAll ? (names) => saveHidden(entry, names) : undefined}
                      onSaveLabels={isAdmin && entry && !showAll ? (pairs) => saveLabels(entry, pairs) : undefined}
                      onExportQueued={trackExport}
                      pendingExports={exportJobs.length}
                      onRowsChanged={entry && !showAll ? (d) => setRowCounts((c) => (c[entry.id] == null || c[entry.id]! < 0 ? c : { ...c, [entry.id]: Math.max(0, c[entry.id]! + d) })) : undefined}
                      keyColumns={showAll ? [] : (entry?.keyColumns ?? "").split(",").map((c) => c.trim()).filter(Boolean)}
                      yearColumn={showAll ? null : entry?.yearColumn ?? null} />
        ) : (
          // Nothing selected yet: point to the left panel.
          <Tile className={styles.noTable}>
            <TableIcon size={32} className="rh-dim" />
            <h2 className="cds--type-heading-compact-02">Select a table to view data</h2>
          </Tile>
        )}
      </div>

      {/* Right-click menu on an entry row */}
      {menu && (
        <>
          <Menu open mode="basic" size="sm" x={menu.x} y={menu.y} label={entryName(menu.entry)} onClose={() => setMenu(null)}>
            <MenuItem label="Open" renderIcon={TableIcon} onClick={() => { setEntry(menu.entry); setMenu(null); }} />
            {/* Opens the entry's Settings tab, no longer a floating dialog */}
            <MenuItem label="Edit settings" renderIcon={Settings} onClick={() => { const e = menu.entry; setMenu(null); openSettingsNext.current = true; setEntry(e); setTab("settings"); }} />
            <MenuItemDivider />
            <MenuItemGroup label="Move to folder">
              <MenuItem label="Top level" renderIcon={ArrowUp} onClick={() => { const e = menu.entry; setMenu(null); setEntryFolder(e, null).then(loadEntries); }} />
              {folders.map((f) => (
                <MenuItem key={f.id} label={f.name} renderIcon={Folder} onClick={() => { const e = menu.entry; setMenu(null); setEntryFolder(e, f.id).then(loadEntries); }} />
              ))}
            </MenuItemGroup>
            <MenuItemDivider />
            <MenuItem label="Remove from this screen" kind="danger" renderIcon={TrashCan} onClick={() => { const e = menu.entry; setMenu(null); removeEntry(e); }} />
          </Menu>
        </>
      )}

      {(adding || editingEntry) && (
        <AddTableModal key={editingEntry?.id ?? "new"} menuKey={menuKey} datasources={dss} currentDsId={datasourceId}
                       existing={editingEntry}
                       onClose={() => { setAdding(false); setEditingEntry(null); }}
                       folders={folders} onFoldersChanged={loadFolders}
                       onAdded={(res) => {
                         setAdding(false); setEditingEntry(null);
                         // Open what was just added / edited
                         if (res) { applyEntry(res); setEntry(res); }
                         loadEntries();
                       }} toast={toast} />
      )}
    </div>
  );
}

/** Admin picker: choose a live table from a datasource and give it a label on this screen. */
function AddTableModal({ menuKey, datasources, currentDsId, existing, onClose, onAdded, toast, folders, onFoldersChanged, inline = false }: {
  menuKey: string | null; datasources: Datasource[]; currentDsId: string;
  onClose: () => void; onAdded: (saved: RepoTableEntry | null) => void; toast: ReturnType<typeof useToast>;
  folders: RepoFolder[];
  onFoldersChanged: () => void;
  /** Not null = editing this entry's settings instead of adding a new one. */
  existing?: RepoTableEntry | null;
  /** Draw on the screen (Settings tab) instead of a floating dialog. */
  inline?: boolean;
}) {
  // Default used to be datasources[0], which may well be a connection that is down — the dialog
  // would open on an error. Sensible order: the one the screen is on -> first healthy -> first.
  const [dsId, setDsId] = useState(
    () => existing?.datasourceId
       ?? ((currentDsId && datasources.some((d) => d.id === currentDsId) ? currentDsId : null)
       ?? datasources.find((d) => d.status === "healthy")?.id
       ?? datasources[0]?.id
       ?? ""));
  const [all, setAll] = useState<RepoTable[]>([]);
  const [q, setQ] = useState(existing ? `${existing.schemaName ? `${existing.schemaName}.` : ""}${existing.tableName}` : "");
  const [picked, setPicked] = useState<RepoTable | null>(
    existing ? { schema: existing.schemaName, name: existing.tableName, type: "TABLE" } : null);
  const [label, setLabel] = useState(existing?.label ?? "");
  const [folderId, setFolderId] = useState<number | null>(existing?.folderId ?? null);
  const [eqFilter, setEqFilter] = useState(existing?.eqFilter ?? "");
  const [filterCols, setFilterCols] = useState(existing?.filterColumns ?? "");
  const [keyColumns, setKeyColumns] = useState(existing?.keyColumns ?? "");
  const [yearColumn, setYearColumn] = useState(existing?.yearColumn ?? "");
  const [busy, setBusy] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  // Real columns + sample rows of the chosen table — otherwise column names for filter columns and
  // fixed filters had to be typed, and typos only surfaced when the screen was opened.
  const [meta, setMeta] = useState<RepoTableMeta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<RepoRows | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [fCol, setFCol] = useState("");
  const [fVal, setFVal] = useState("");
  // Dialog tab — opens on the structure, because the job when adding a table is choosing which
  // columns users can filter by, not reading data. Data is there to confirm the right table.
  // Unique per instance — the Settings tab and the Add dialog can be open at the same time.
  const uid = useId();
  const [mTab, setMTab] = useState<"structure" | "data">("structure");
  const chosenDs = useMemo(() => datasources.find((d) => d.id === dsId) ?? null, [datasources, dsId]);
  const [colQ, setColQ] = useState("");
  const [listOpen, setListOpen] = useState(false);
  /** null = not creating · string = typing a new folder name inline */
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  /** Column whose default value is being typed */
  const [editDef, setEditDef] = useState<string | null>(null);
  const [defDraft, setDefDraft] = useState("");
  const shownCols = useMemo(() => {
    const q = colQ.trim().toLowerCase();
    return q ? (meta?.columns ?? []).filter((c) => c.name.toLowerCase().includes(q)) : (meta?.columns ?? []);
  }, [meta, colQ]);
  /** Search box for the "Key columns" list — separate from colQ since it is a different list scrolled separately. */
  const [keyQ, setKeyQ] = useState("");
  const shownKeyCols = useMemo(() => {
    const q = keyQ.trim().toLowerCase();
    return q ? (meta?.columns ?? []).filter((c) => c.name.toLowerCase().includes(q)) : (meta?.columns ?? []);
  }, [meta, keyQ]);

  useEffect(() => {
    setAll([]); setPicked(null); setListErr(null);
    if (!dsId) return;
    setLoadingList(true);
    // A dead connection takes far longer to time out than a healthy one takes to load, so
    // without dropping stale answers the late error would overwrite the newer connection's
    // successful result.
    let live = true;
    api.repoTables(dsId)
      // Errors used to be swallowed, so a dead connection looked like "no tables here" and the
      // Add button stayed disabled with no reason given.
      .then((t) => { if (!live) return; setAll(t); setListErr(null); })
      .catch((e) => { if (!live) return; setAll([]); setListErr(e instanceof Error ? e.message : "Could not read the table list from this connection"); })
      .finally(() => { if (live) setLoadingList(false); });
    return () => { live = false; };
  }, [dsId]);

  /** Typed name — accepts both "TABLE" and "SCHEMA.TABLE" (first dot separates). */
  const typed = useMemo(() => {
    const raw = q.trim().replace(/;+$/, "");
    if (!raw) return null;
    const i = raw.indexOf(".");
    const schema = i > 0 ? raw.slice(0, i).trim() : null;
    const name = (i > 0 ? raw.slice(i + 1) : raw).trim();
    return name ? { schema, name } : null;
  }, [q]);

  // Cannot filter on the raw text — "SCHEMA.TABLE" compared with t.name (no schema prefix) would
  // match nothing though the table exists. Compare the name part, and the schema if one was given.
  const hits = useMemo(() => {
    if (!typed) return [];
    const n = typed.name.toLowerCase();
    const sc = typed.schema?.toLowerCase();
    return all
      .filter((t) => t.name.toLowerCase().includes(n) && (!sc || (t.schema ?? "").toLowerCase() === sc))
      .slice(0, 60);
  }, [all, typed]);

  /** What the table picker lists — before typing, the first 60 tables to choose from. */
  const browseHits = useMemo(() => (q.trim() ? hits : all.slice(0, 60)), [q, hits, all]);

  /** Exactly matches a listed table already? (So "use what you typed" is not offered redundantly.) */
  const typedIsKnown = useMemo(
    () => !!typed && all.some((t) => t.name.toLowerCase() === typed.name.toLowerCase()),
    [typed, all]);

  /** What will actually be saved: the picked table, otherwise the typed name. */
  const target = picked ?? (typed ? { schema: typed.schema, name: typed.name } : null);

  /** eqFilter ("COL=value;COL=value") -> the array repoRows takes */
  const eqPairs = useMemo(
    () => eqFilter.split(";").map((x) => x.trim()).filter((x) => x.includes("=")),
    [eqFilter]);

  // Load the chosen table's real columns — the same call the screen uses when opening a table.
  useEffect(() => {
    setMeta(null); setMetaErr(null);
    if (!dsId || !target?.name) return;
    let live = true;
    api.repoTableMeta(target.name, dsId, target.schema)
      .then((m) => { if (live) setMeta(m); })
      .catch((e) => { if (live) setMetaErr(e instanceof Error ? e.message : "Could not read the columns"); });
    return () => { live = false; };
  }, [dsId, target?.schema, target?.name]);

  // Sample rows — debounced since eqFilter is typed character by character. withTotal tells how
  // many rows the configured filter really leaves.
  useEffect(() => {
    if (!dsId || !target?.name) { setPreview(null); setPreviewErr(null); return; }
    let live = true;
    setPreviewing(true);
    const t = setTimeout(() => {
      api.repoRows(target.name, { datasourceId: dsId, schema: target.schema, limit: 8,
                                  eq: eqPairs, withTotal: true })
        .then((r) => { if (live) { setPreview(r); setPreviewErr(null); } })
        .catch((e) => { if (live) { setPreview(null); setPreviewErr(e instanceof Error ? e.message : "Could not read the rows"); } })
        .finally(() => { if (live) setPreviewing(false); });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [dsId, target?.schema, target?.name, eqFilter]);

  const filterColList = useMemo(
    () => filterCols.split(",").map((x) => x.trim()).filter(Boolean),
    [filterCols]);

  /** Stored as COLUMN[:label:label source:options source:default] — compare on the column name only. */
  const colOf = (entry: string) => entry.split(":")[0].trim().toUpperCase();

  function toggleFilterCol(name: string) {
    const has = filterColList.some((c) => colOf(c) === name.toUpperCase());
    const next = has ? filterColList.filter((c) => colOf(c) !== name.toUpperCase())
                     : [...filterColList, name];
    setFilterCols(next.join(","));
  }

  const keyColList = useMemo(
    () => keyColumns.split(",").map((x) => x.trim()).filter(Boolean),
    [keyColumns]);

  const keyHas = (name: string) => keyColList.some((c) => c.toUpperCase() === name.toUpperCase());
  /** ROWID is Oracle-only — not offered for other connections. */
  const isOracleDs = (chosenDs?.engine ?? "").toLowerCase().includes("oracle");

  function toggleKeyCol(name: string) {
    const has = keyColList.some((c) => c.toUpperCase() === name.toUpperCase());
    setKeyColumns((has ? keyColList.filter((c) => c.toUpperCase() !== name.toUpperCase())
                       : [...keyColList, name]).join(","));
  }

  function removeFixedFilter(pair: string) {
    setEqFilter(eqPairs.filter((p) => p !== pair).join(";"));
  }

  function addFixedFilter() {
    if (!fCol || !fVal.trim()) { toast("Pick a column and type a value", "error"); return; }
    const pair = `${fCol}=${fVal.trim()}`;
    const kept = eqPairs.filter((p) => p.split("=")[0].trim().toUpperCase() !== fCol.toUpperCase());
    setEqFilter([...kept, pair].join(";"));
    setFVal("");
  }

  async function save() {
    if (!dsId) { toast("Pick a connection first", "error"); return; }
    if (!target) { toast("Type a table name, or pick one from the list", "error"); return; }
    setBusy(true);
    try {
      const body = {
        menuKey: existing?.menuKey ?? menuKey,
        label: label.trim() || target.name, folder: existing?.folder ?? null, folderId, datasourceId: dsId,
        schemaName: target.schema ?? null, tableName: target.name,
        eqFilter: eqFilter.trim() || null, filterColumns: filterCols.trim() || null,
        columnOrder: existing?.columnOrder ?? null,
        hiddenColumns: existing?.hiddenColumns ?? null,
        columnLabels: existing?.columnLabels ?? null,
        keyColumns: keyColumns.trim() || null, yearColumn: yearColumn.trim() || null,
        sortOrder: existing?.sortOrder ?? 99,
      };
      let res: RepoTableEntry;
      if (existing) {
        res = await api.repoRegistryUpdate(existing.id, body);
        toast(`Saved ${label.trim() || target.name}`, "ok");
      } else {
        res = await api.repoRegistryAdd(body);
        toast(`Added ${label.trim() || target.name}`, "ok");
      }
      onAdded(res && typeof res === "object" && "id" in res ? res : null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add the table", "error");
    } finally { setBusy(false); }
  }

  // One body used in both places — on the screen (Settings tab) and in the dialog (adding a table).
  // Built as a variable, not a component created during render, or inputs would remount on every keystroke.
  const newFolderInput = (
    <TextInput id={`${uid}-repo-new-folder`} size="sm" hideLabel labelText="Folder name" autoFocus value={newFolderName ?? ""} placeholder="Folder name"
               className={styles.inlineInput}
               onChange={(e) => setNewFolderName(e.target.value)}
               onBlur={() => setNewFolderName(null)}
               onKeyDown={async (e) => {
                 if (e.key === "Escape") { setNewFolderName(null); return; }
                 if (e.key !== "Enter") return;
                 e.preventDefault();
                 const name = (newFolderName ?? "").trim();
                 setNewFolderName(null);
                 if (!name) return;
                 try {
                   const f = await api.repoFolderAdd({ menuKey: menuKey ?? null, parentId: null, name });
                   onFoldersChanged();
                   setFolderId(f.id);
                 } catch (err) { toast(err instanceof Error ? err.message : "Could not create the folder", "error"); }
               }} />
  );

  // One body used in both places — on the screen (Settings tab) and in the dialog (adding a table).
  // Built as a variable, not a component created during render, or inputs would remount on every keystroke.
  const body = (
    <Stack gap={6}>
      {/* Single-line dropdown that still shows status — a dead connection should be obvious
          before picking it, not discovered as an empty table list. */}
      <div>
        <Select label="Connection" value={dsId} onChange={setDsId} placeholder="Pick a connection"
                invalidText={!dsId ? "Pick a connection to continue" : undefined}
                options={datasources.map((d) => ({
                  value: d.id,
                  label: d.status === "healthy" ? d.name : `${d.name}  ● ${d.status}`,
                  sub: [d.engine, d.hasJdbc ? "live JDBC" : null, d.latencyMs != null ? `${d.latencyMs} ms` : null]
                        .filter(Boolean).join(" · "),
                }))} />
        {chosenDs && chosenDs.status !== "healthy" && (
          <InlineNotification kind={chosenDs.status === "degraded" ? "warning" : "error"} lowContrast hideCloseButton
                              title={`Connection is ${chosenDs.status}`} subtitle="The table list may not load; a table name can still be typed" />
        )}
      </div>

      {/* Clicking the field lists tables right away; typing only filters — people who do not
          know the table name can still pick one. */}
      <div className={styles.pickWrap}>
        <TextInput id={`${uid}-repo-table-name`} labelText="Table name" className="rh-mono" value={q} onFocus={() => setListOpen(true)}
                   onChange={(e) => { setQ(e.target.value); setPicked(null); setListOpen(true); }}
                   placeholder={all.length ? `Pick from ${all.length} tables, or type SCHEMA.TABLE` : "SCHEMA.TABLE, e.g. SALES.ORDERS"}
                   invalid={!!listErr} invalidText={listErr ? `${listErr} — a table name can still be typed` : undefined}
                   helperText={loadingList ? "Reading the table list" : picked ? "Table chosen" : undefined} />

        {/* The connection's list only assists — a dead connection or a table not yet granted
            for listing can still be typed in. */}
        {listOpen && !picked && (all.length > 0 || typed) && (
          <Layer className={styles.pickList} role="listbox">
            {typed && !typedIsKnown && (
              <button type="button" role="option" aria-selected={false} className={styles.pickOpt}
                      onClick={() => { setPicked({ schema: typed.schema, name: typed.name, type: "TABLE" }); setListOpen(false); if (!label) setLabel(typed.name); }}>
                <span className="rh-dim">Use what you typed: </span>
                <span className="rh-mono">{typed.schema ? `${typed.schema}.` : ""}{typed.name}</span>
              </button>
            )}
            {browseHits.map((t) => (
              <button type="button" role="option" aria-selected={false} key={`${t.schema ?? ""}.${t.name}`} className={styles.pickOpt + " rh-mono"}
                      onClick={() => { setPicked(t); setQ(t.schema ? `${t.schema}.${t.name}` : t.name); setListOpen(false); if (!label) setLabel(t.name); }}>
                {t.schema ? `${t.schema}.` : ""}{t.name}
              </button>
            ))}
            {browseHits.length === 0 && !typed && <p className={styles.pickNote}>No tables found</p>}
            {all.length > browseHits.length && !q.trim() && (
              <p className={styles.pickNote}>Showing {browseHits.length} of {all.length} — type to search the rest</p>
            )}
          </Layer>
        )}
      </div>

      <TextInput id={`${uid}-repo-label`} labelText="Name shown on screen (optional)" value={label} onChange={(e) => setLabel(e.target.value)}
                 placeholder={target?.name ? `${target.name} (leave blank to use this)` : "e.g. Branch registry"} />

      {/* Existing folders are tags to click, not typed — typing risks a near-duplicate folder.
          Folders are real rows (repo_folder), referenced by id. */}
      <div>
        <span className="cds--label">Folder (optional · none = top level)</span>
        <div className={styles.tagRow}>
          {folders.map((f) => (
            <SelectableTag key={f.id} size="md" text={f.name} selected={folderId === f.id}
                           onChange={() => setFolderId(folderId === f.id ? null : f.id)} />
          ))}
          {newFolderName === null
            ? <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setNewFolderName("")}>New folder</Button>
            : newFolderInput}
        </div>
      </div>

      {/* Tabs like the Tables screen, instead of one long form with half of it under a
          "More options" toggle. */}
      {target?.name && (
        <div>
          <Tabs selectedIndex={mTab === "structure" ? 0 : 1} onChange={({ selectedIndex }) => setMTab(selectedIndex === 0 ? "structure" : "data")}>
            <TabList aria-label="Table settings" contained>
              <Tab renderIcon={carbonIcon("layers")}>{`Structure${filterColList.length ? ` (${filterColList.length})` : ""}`}</Tab>
              <Tab renderIcon={carbonIcon("table")}>Data</Tab>
            </TabList>
          </Tabs>

          <Stack gap={6} className={styles.mtabBody}>
            {mTab === "structure" ? (
              <>
      {/* Columns users may filter by — dozens of tags in a row are hard to scan, so: chosen
          (removable) + search box + the rest as a list. */}
      <div>
        <span className="cds--label">Filter columns{meta ? ` · ${meta.columns.length} columns in this table` : ""}</span>

        {meta ? (
          <>
            <div className={styles.tagRow}>
              {filterColList.length === 0
                ? <span className="cds--type-body-compact-01 rh-dim">None chosen — no filter on this table</span>
                : <>
                    {filterColList.map((c) => {
                      const [name, ...rest] = c.split(":");
                      const def = rest[3] || "";
                      return (
                        <span key={name} className={styles.tagGroup}>
                          {/* Click the name = set/edit the default · click × = remove the column.
                              A default makes the screen open filtered, never an unfiltered big table. */}
                          {editDef === name ? (
                            <TextInput id={`${uid}-def-${name}`} size="sm" hideLabel labelText={`Default for ${name}`} autoFocus value={defDraft} placeholder="default value"
                                   className={styles.inlineInput}
                                   onChange={(e) => setDefDraft(e.target.value)}
                                   onBlur={() => setEditDef(null)}
                                   onKeyDown={(e) => {
                                     if (e.key === "Escape") { setEditDef(null); return; }
                                     if (e.key !== "Enter") return;
                                     e.preventDefault();
                                     const parts = [name, rest[0] ?? "", rest[1] ?? "", rest[2] ?? "", defDraft.trim()];
                                     while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
                                     setFilterCols(filterColList.map((x) => (x.split(":")[0] === name ? parts.join(":") : x)).join(","));
                                     setEditDef(null);
                                   }} />
                          ) : (
                            <OperationalTag size="md" type={def ? "blue" : "gray"} title="Set this filter's default value"
                                            text={`${name} = ${def || "default"}`}
                                            onClick={() => { setDefDraft(def); setEditDef(name); }} />
                          )}
                          <IconButton kind="ghost" size="sm" label={`Remove ${name}`} onClick={() => toggleFilterCol(name)}><Close size={16} /></IconButton>
                        </span>
                      );
                    })}
                    <Button kind="ghost" size="sm" onClick={() => setFilterCols("")}>Clear all</Button>
                  </>}
            </div>

            <div className={styles.colTools}>
              <Search size="sm" labelText="Find a column" placeholder="Find a column" value={colQ} onChange={(e) => setColQ(e.target.value)} />
              {/* Ticking dozens of columns one by one is tedious — this does the visible set at once. */}
              <Button kind="ghost" size="sm" onClick={() => {
                const add = shownCols.map((c) => c.name)
                  .filter((n) => !filterColList.some((x) => colOf(x) === n.toUpperCase()));
                setFilterCols([...filterColList, ...add].join(","));
              }}>Select {colQ.trim() ? "these" : "all"}</Button>
              <Button kind="ghost" size="sm" onClick={() => setFilterCols("")}>Clear</Button>
            </div>

            {/* One row per column with its type. */}
            <div className={styles.colList}>
              {shownCols.map((c) => {
                const on = filterColList.some((x) => colOf(x) === c.name.toUpperCase());
                return (
                  <Checkbox key={c.name} id={`${uid}-fc-${c.name}`} checked={on} onChange={() => toggleFilterCol(c.name)}
                            labelText={<span className={styles.colRow}><span className="rh-mono">{c.name}</span><span className="rh-dim">{c.type}{c.pk ? " · PK" : ""}</span></span>} />
                );
              })}
              {shownCols.length === 0 && (
                <p className="cds--type-body-compact-01 rh-dim">No column matches “{colQ}”</p>
              )}
            </div>
          </>
        ) : (
          // Columns unreadable (dead connection / no table yet) — typing still works.
          <TextInput id={`${uid}-repo-filter-cols`} hideLabel labelText="Filter columns" className="rh-mono" value={filterCols} onChange={(e) => setFilterCols(e.target.value)} placeholder="REGION,BRANCH" />
        )}
        {metaErr && <p className="cds--form-requirement" style={{ display: "block", color: "var(--cds-text-error)" }}>{metaErr}</p>}
      </div>

      {/* Pick from the real columns rather than typing names from memory. */}
      <div>
        <span className="cds--label">Key columns (only when the table has no primary key)</span>
        {meta ? (
          <>
            <div className={styles.tagRow}>
              {keyColList.length === 0 ? (
                meta.primaryKey.length
                  ? <span className="cds--type-body-compact-01 rh-dim">Using the primary key: <span className="rh-mono">{meta.primaryKey.join(", ")}</span></span>
                  : <InlineNotification kind="warning" lowContrast hideCloseButton title="No primary key" subtitle="Pick a key column below or rows cannot be edited" />
              ) : (
                <>
                  {keyColList.map((c) => (
                    <DismissibleTag key={c} size="md" type="gray" text={c} title="Remove" onClose={() => toggleKeyCol(c)} />
                  ))}
                  <Button kind="ghost" size="sm" onClick={() => setKeyColumns("")}>Clear all</Button>
                </>
              )}
            </div>
            <div className={styles.colTools}>
              <Search size="sm" labelText="Find a column" placeholder="Find a column" value={keyQ} onChange={(e) => setKeyQ(e.target.value)} />
              {meta.primaryKey.length > 0 && (
                <Button kind="ghost" size="sm" onClick={() => setKeyColumns(meta.primaryKey.join(","))}>Use primary key</Button>
              )}
              <Button kind="ghost" size="sm" onClick={() => setKeyColumns("")}>Clear</Button>
            </div>

            <div className={styles.colList}>
              {/* ROWID — the row's physical address in Oracle, always identifies exactly one row,
                  even without a PK. Listed first as the right answer for tables with no key. */}
              {isOracleDs && ROWID_COL.includes(keyQ.trim().toUpperCase()) && (
                <Checkbox id={`${uid}-kc-ROWID`} checked={keyHas(ROWID_COL)} onChange={() => toggleKeyCol(ROWID_COL)}
                          labelText={<span className={styles.colRow}><span className="rh-mono">{ROWID_COL}</span><span className="rh-dim">Oracle · always identifies a row</span></span>} />
              )}
              {shownKeyCols.map((c) => (
                <Checkbox key={c.name} id={`${uid}-kc-${c.name}`} checked={keyHas(c.name)} onChange={() => toggleKeyCol(c.name)}
                          labelText={<span className={styles.colRow}><span className="rh-mono">{c.name}</span><span className="rh-dim">{c.type}{c.pk ? " · PK" : ""}</span></span>} />
              ))}
              {/* The ROWID row is synthetic, not in shownKeyCols — if it shows, there is a match. */}
              {shownKeyCols.length === 0 && !(isOracleDs && ROWID_COL.includes(keyQ.trim().toUpperCase())) && (
                <p className="cds--type-body-compact-01 rh-dim">No column matches “{keyQ}”</p>
              )}
            </div>
            {keyHas(ROWID_COL) && (
              <p className="cds--form__helper-text">ROWID can change when a row is moved — a stale value then updates 0 rows, never another row</p>
            )}
          </>
        ) : (
          <TextInput id={`${uid}-repo-key-cols`} hideLabel labelText="Key columns" className="rh-mono" value={keyColumns} onChange={(e) => setKeyColumns(e.target.value)} placeholder="ID" />
        )}
      </div>
      <TextInput id={`${uid}-repo-year-col`} labelText="Year column (optional)" className="rh-mono"
                 helperText="Column the year picker and export year filter use · empty = no year picker"
                 value={yearColumn} onChange={(e) => setYearColumn(e.target.value)} placeholder="<column>" />
              </>
            ) : (
              <>
      {/* Fixed filter — added ones show as removable tags, not raw text to edit by hand. */}
      <div>
        <span className="cds--label">Fixed filter (empty means the whole table)</span>

        {meta ? (
          <>
            <div className={styles.eqBuild}>
              <Select value={fCol} onChange={setFCol} placeholder="Column" searchable
                      options={meta.columns.map((c) => ({ value: c.name, label: c.name }))} />
              <TextInput id={`${uid}-repo-fval`} hideLabel labelText="Value" className="rh-mono" value={fVal} onChange={(e) => setFVal(e.target.value)}
                         onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFixedFilter(); } }}
                         placeholder="value" />
              <Button kind="tertiary" size="md" onClick={addFixedFilter}>Add</Button>
            </div>
            <div className={styles.tagRow}>
              {eqPairs.length === 0
                ? <span className="cds--type-body-compact-01 rh-dim">No filter — the screen shows the whole table</span>
                : <>
                    {eqPairs.map((pair) => (
                      <DismissibleTag key={pair} size="md" type="gray" text={pair} title="Remove" onClose={() => removeFixedFilter(pair)} />
                    ))}
                    <Button kind="ghost" size="sm" onClick={() => setEqFilter("")}>Clear all</Button>
                  </>}
            </div>
          </>
        ) : (
          <TextInput id={`${uid}-repo-eq`} hideLabel labelText="Fixed filter" className="rh-mono" value={eqFilter} onChange={(e) => setEqFilter(e.target.value)}
                     placeholder="STATUS=active" />
        )}
      </div>

      {/* Real rows of the chosen table with the fixed filter applied — so a wrong choice is
          visible before adding, not after. */}
      {target?.name && (
        <div>
          <div className={styles.labelRow}>
            <span className="cds--label">Data</span>
            <span className="cds--label rh-dim">
              {preview ? `${eqPairs.length ? "filter matches " : ""}${preview.total >= 0 ? preview.total.toLocaleString() : "?"} rows · showing ${preview.rowCount}` : ""}
            </span>
          </div>
          {previewing && !preview && <DataTableSkeleton showHeader={false} showToolbar={false} columnCount={5} rowCount={4} size="xs" />}
          {previewErr && <InlineNotification kind="error" lowContrast hideCloseButton title={previewErr} />}
          {!previewErr && preview && preview.rowCount === 0 && (
            <p className="cds--type-body-compact-01 rh-dim">{eqPairs.length ? "No row matches this filter" : "This table is empty"}</p>
          )}
          {!previewErr && preview && preview.rowCount > 0 && (
            <div className={styles.prevWrap}>
              <Table size="xs">
                <TableHead><TableRow>{preview.columns.map((c) => <TableHeader key={c}>{c}</TableHeader>)}</TableRow></TableHead>
                <TableBody>
                  {preview.rows.map((r, i) => (
                    <TableRow key={i}>{r.map((v, j) => <TableCell key={j}>{v === null ? <span className="rh-dim">null</span> : String(v)}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

              </>
            )}
          </Stack>
        </div>
      )}

      {inline && (
        <div className={styles.formFoot}>
          <Button kind="secondary" onClick={onClose}>Back to data</Button>
          <Button kind="primary" onClick={save} disabled={busy || !dsId || !target}>{busy ? "Saving" : existing ? "Save" : "Add"}</Button>
        </div>
      )}
    </Stack>
  );

  // Inline = no backdrop, no floating box, the table stays visible. Adding a new table is still a
  // dialog, since there is no table tab to stand on yet.
  const access = existing?.id != null ? (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--cds-spacing-05)" }}>
      <AccessButton type="REPO_TABLE" id={existing.id} name={existing.label || existing.tableName} />
    </div>
  ) : null;
  return inline ? <div className={styles.settingsPane}>{access}{body}</div> : (
    <Modal title={existing ? "Table settings" : "Add a table to this screen"} onClose={onClose} width={740}
           foot={<>
             <Button kind="secondary" onClick={onClose}>Cancel</Button>
             <Button kind="primary" onClick={save} disabled={busy || !dsId || !target}>{busy ? "Saving" : existing ? "Save" : "Add"}</Button>
           </>}>
      {access}{body}
    </Modal>
  );
}

function TabBar({ tab, setTab, hasTable, canEdit }: {
  tab: Tab; setTab: (t: Tab) => void; hasTable: boolean;
  /** Whether the Settings tab shows — not an admin / table outside the registry = no tab. */
  canEdit?: boolean }) {
  const tabs: { key: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
    // Tables only — SQL is written on the SQL editor screen.
    { key: "data", label: "Data", icon: "table" },
    { key: "columns", label: "Properties", icon: "layers" },
    // Settings is a tab, not a dialog — configure while looking at the table, nothing covers it.
    ...(canEdit ? [{ key: "settings" as Tab, label: "Settings", icon: "settings" as Parameters<typeof Icon>[0]["name"] }] : []),
  ];
  if (!hasTable) return null;
  const idx = Math.max(0, tabs.findIndex((t) => t.key === tab));
  return (
    <Tabs selectedIndex={idx} onChange={({ selectedIndex }) => setTab(tabs[selectedIndex].key)}>
      <TabList aria-label="Table views" className={styles.tabs}>
        {tabs.map((t) => <Tab key={t.key} renderIcon={carbonIcon(t.icon)}>{t.label}</Tab>)}
      </TabList>
    </Tabs>
  );
}

function TablePanel({ label, datasourceId, table, tab, setTab, toast, eq, derivedEq, filterColumns, columnOrder, hiddenColumns, columnLabels, keyColumns, yearColumn, rights, settingsPanel, onSaveOrder, onSaveHidden, onSaveLabels, onExportQueued, pendingExports, onRowsChanged }: {
  /** Registered display label — shown as the title instead of SCHEMA.TABLE when set. */
  label?: string;
  datasourceId: string; table: RepoTable; tab: Tab; setTab: (t: Tab) => void; eq: string[];
  /** Terms assembled from other fields' values, e.g. PART_KEY=$YEAR2|$REGION|$CATEGORY */
  derivedEq: string[];
  /** Columns this screen offers as user-driven pickers, on top of the fixed `eq` slice. */
  filterColumns: FilterCol[];
  /** Column order this screen shows (registry repo_table.column_order) · null = database order */
  columnOrder: string | null;
  /** Columns present in the table but not shown (comma separated) — hides them on screen and in exports only. */
  hiddenColumns: string | null;
  /** Export header names when they differ from the real names — "COL=Name", comma separated. */
  columnLabels: string | null;
  /** Save column order to the registry — absent = this user cannot reorder (not admin / table outside the registry). */
  onSaveOrder?: (spec: string | null) => Promise<void>;
  /** Save the hidden-column list. */
  onSaveHidden?: (names: string[]) => Promise<void>;
  /** Save export header names. */
  onSaveLabels?: (pairs: Record<string, string>) => Promise<void>;
  /** Hand a just-queued job to the screen to follow — the table does not wait, so export can be clicked again at once. */
  onExportQueued: (jobId: string, filename: string) => void;
  /** Number of files being built right now (whole screen). */
  pendingExports: number;
  keyColumns: string[];
  /** Registry-configured year column (repo_table.year_column); null = no year picker. */
  yearColumn?: string | null;
  /** Rows were inserted (+n) or deleted (-n) — lets the table list keep its row count in step. */
  onRowsChanged?: (delta: number) => void;
  /** What the portal menu this panel was opened from allows. See MENU_RIGHTS. */
  rights: { add: boolean; edit: boolean; del: boolean };
  /** Settings panel for this table, drawn in the Settings tab — absent = no such tab (no rights, or Browse all mode). */
  settingsPanel?: React.ReactNode;
  toast: ReturnType<typeof useToast>;
}) {
  const _portalYear = usePortalYear();
  const portalYear = _portalYear || fiscalYearNow();
  const eqKey = eq.join(";");
  // User-driven filters on the data screens (e.g. region / branch). These sit on top of the
  // admin-pinned eq, and both go out in ONE eq param — some WAFs reject repeated parameter names.
  const [userEq, setUserEq] = useState<Record<string, string>>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQ, setFilterQ] = useState("");
  const filtRef = useRef<HTMLDivElement>(null);
  /** The filter panel's search box matches filter names, not values — each dropdown searches its own values. */
  const shownFilterCols = useMemo(() => {
    const q = filterQ.trim().toLowerCase();
    if (!q) return filterColumns;
    return filterColumns.filter((f) => `${f.label} ${f.col}`.toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterColumns, filterQ]);
  const activeFilters = useMemo(
    () => Object.entries(userEq).filter(([, v]) => v), [userEq]);

  /**
   * Close the panel on an outside click or Escape — it floats over the grid and would hide data.
   *
   * The {@link Select} menu is rendered into document.body (a portal) so its parent cannot clip it,
   * which means the clicked option is **not inside filtRef**. Treating that as an outside click
   * closed the panel on mousedown, unmounting the Select before the click reached the option, so
   * onChange never fired. (Defaults still appeared, since code sets them without a click — which
   * made filters look like they worked only sometimes.)
   */
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      const el = t instanceof Element ? t : (t?.parentElement ?? null);
      // The Select's floating menu counts as part of the panel, wherever it sits in the DOM.
      if (el?.closest(".menu")) return;
      if (filtRef.current && !filtRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFilterOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [filterOpen]);

  const [opts, setOpts] = useState<Record<string, RepoOption[]>>({});
  /**
   * Filters from the funnel on the column headers — **deliberately kept apart from userEq**.
   *
   * keyOf(), which identifies a row on edit/delete, puts every activeEq term in the WHERE as "=".
   * Mixing "contains…" filters into activeEq would add foreign conditions to the UPDATE, so it could
   * hit no row or the wrong one. Keep them separate.
   */
  const [colFilters, setColFilters] = useState<Record<string, ColFilterValue>>({});
  /** Values loaded for ticking in the funnel (separate from the filter panel's opts). */
  const [hfOpts, setHfOpts] = useState<Record<string, RepoOption[]>>({});
  const [hfBusy, setHfBusy] = useState<Record<string, boolean>>({});
  const [hfErr, setHfErr] = useState<Record<string, string | null>>({});
  const activeColFilters = useMemo(
    () => Object.entries(colFilters).filter(([, v]) => isFilterOn(v)), [colFilters]);
  /** Sent as one JSON blob — some WAFs reject requests that repeat a parameter name. */
  const filtersParam = useMemo(() => (activeColFilters.length
    ? JSON.stringify(activeColFilters.map(([column, v]) => ({
        column, values: v.values, contains: v.contains.trim() || undefined })))
    : ""), [activeColFilters]);
  const userEqTerms = Object.entries(userEq).filter(([, v]) => v).map(([c, v]) => `${c}=${v}`);
  /**
   * Fill the composite terms before use, from both the fixed filters and the fields the user has
   * picked right now.
   */
  const derived = useMemo(() => {
    if (!derivedEq.length) return { eq: [] as string[], missing: [] as string[] };
    const vals: Record<string, string> = {};
    for (const t of [...eq, ...userEqTerms]) {
      const i = t.indexOf("=");
      if (i > 0) vals[t.slice(0, i).trim().toUpperCase()] = t.slice(i + 1).trim();
    }
    const missing = new Set<string>();
    const out: string[] = [];
    for (const t of derivedEq) {
      const filled = t.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => vals[String(n).toUpperCase()] ?? m);
      if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(filled)) {
        for (const m of filled.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) missing.add(m[1]);
      } else out.push(filled);
    }
    return { eq: out, missing: [...missing] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedEq.join(";"), eq.join(";"), userEqTerms.join(";")]);
  const builtEq = derived.eq;
  /**
   * Fields that must be picked first, otherwise the composite term is dropped whole and the query
   * becomes "no filter at all".
   *
   * For a table partitioned only by a composite key like PART_KEY=$FY|$REGION|$CATEGORY,
   * "clear all" or removing the year chip leaves nothing to prune partitions, so the query scans
   * all of them into a reverse proxy's request timeout. Better not to query and ask for a pick first.
   */
  const missingParts = derived.missing;

  const [meta, setMeta] = useState<RepoTableMeta | null>(null);
  /** Optional year filter — applied only once the user picks a year ("" = all years). */
  const [yearPick, setYearPick] = useState("");
  const baseEq = [...eq, ...builtEq, ...userEqTerms];
  const yearCol = exportYearColumn(yearColumn, meta?.columns.map((c) => c.name), baseEq);
  // The picked value is one of the column's own values (4-digit or 2-digit alike)
  const yearVal = yearPick && yearCol ? yearPick : "";
  /** Year choices = the year column's distinct values (newest first), not a fixed range. */
  const [yearOpts, setYearOpts] = useState<string[]>([]);
  const baseKey = baseEq.join("&");
  useEffect(() => {
    if (!yearCol) { setYearOpts([]); return; }
    let live = true;
    api.repoDistinct(table.name, yearCol, { datasourceId: datasourceId || null, schema: table.schema ?? null, eq: baseEq })
      .then((vals) => {
        if (!live) return;
        const vs = [...new Set(vals.map((v) => String(v.value ?? "").trim()).filter(Boolean))];
        vs.sort((a, b) => (Number(b) - Number(a)) || b.localeCompare(a));
        setYearOpts(vs);
      })
      .catch(() => { if (live) setYearOpts([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearCol, table.name, table.schema, datasourceId, baseKey]);
  const activeEq = yearVal && yearCol ? [...baseEq, `${yearCol}=${yearVal}`] : baseEq;
  /** Column-header sort: none → ascending → descending → none; Shift+click adds a column.
      Sent as sort=COL,asc|desc (several joined with ';') on rows and export. */
  const [sorts, setSorts] = useState<{ col: string; dir: "asc" | "desc" }[]>([]);
  const sortParam = sorts.map((x) => `${x.col},${x.dir}`).join(";");
  const sortOf = (col: string) => sorts.find((x) => x.col === col) ?? null;
  const cycleSort = (col: string, multi: boolean) => setSorts((cur) => {
    const one = cur.find((x) => x.col === col);
    const next = !one ? { col, dir: "asc" as const } : one.dir === "asc" ? { col, dir: "desc" as const } : null;
    if (!multi) return next ? [next] : [];
    const rest = cur.filter((x) => x.col !== col);
    return next ? (one ? cur.map((x) => (x.col === col ? next : x)) : [...rest, next]) : rest;
  });
  /** Signature of the full condition set — header filters and sort must be in it too, or changing them would not re-query. */
  const activeKey = activeEq.join(";") + "||" + filtersParam + "||" + sortParam;
  const [rows, setRows] = useState<RepoRows | null>(null);
  /** ROWID of each displayed row, aligned with rows.rows — null when this table does not key on ROWID. */
  const [rowIds, setRowIds] = useState<string[] | null>(null);
  /** Whether this table keys on ROWID — decides whether to ask the backend for it. */
  const wantRowId = keyColumns.some((c) => c.toUpperCase() === ROWID_COL);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: "new" | "edit"; values: Record<string, string>; orig?: (string | number | null)[] } | null>(null);
  /** rows matching the current filter; -1 while unknown (not counted yet, or the count timed out) */
  const [total, setTotal] = useState(-1);
  /** Right-align only numeric columns (by declared type); text — even text holding digits — stays left. */
  const isNumCol = (c: string, v: unknown) => {
    const t = meta?.columns.find((m) => m.name.toLowerCase() === c.toLowerCase())?.type;
    if (!t) return typeof v === "number";
    return /^(number|numeric|decimal|int|integer|bigint|smallint|tinyint|float|double|real|money|serial|bigserial)/i.test(t.trim()) || /^int\d|^float\d/i.test(t.trim());
  };
  /** Rows per page — wide tables scroll long at 100, narrow ones want 500 at once.
      The saved value is only readable after mount (this screen also renders on the server; reading
      it during render is a hydration mismatch). Until then pageSize is the default, and loading
      straight away would fire twice on every visit: once at 100, again at the saved size —
      counting a big table twice for nothing. This flag makes it load once with the right size. */
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sizeReady, setSizeReady] = useState(false);
  useEffect(() => {
    const saved = Number(localStorage.getItem(PAGE_KEY));
    if (PAGE_SIZES.includes(saved)) setPageSize(saved);
    setSizeReady(true);
  }, []);

  const schema = table.schema ?? undefined;
  /**
   * Columns not shown — hidden only "when drawing", never removed from the loaded data.
   *
   * They must not be cut from rows: a table may key on a column that is also hidden, and cutting it
   * from the data would leave edit/delete with no key for the WHERE.
   */
  const hiddenSet = useMemo(() => new Set((hiddenColumns ?? "").split(",")
    .map((c) => c.trim().toUpperCase()).filter(Boolean)), [hiddenColumns]);
  /** Header names used "for export only" — the screen always shows the real names. */
  const labelMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const part of (columnLabels ?? "").split(",")) {
      const i = part.indexOf("=");
      if (i > 0) {
        const k = part.slice(0, i).trim().toUpperCase(), v = part.slice(i + 1).trim();
        if (k && v) m[k] = v;
      }
    }
    return m;
  }, [columnLabels]);
  const isHidden = useCallback((c: string) => hiddenSet.has(c.toUpperCase()), [hiddenSet]);
  /**
   * Signature of the latest grid request (filters + page + page size) — answers with another
   * signature are stale and not shown.
   * Not an incrementing counter: two requests with the same signature would drop the first even
   * though its data is correct, and if the second never returned the screen would hang on
   * "Reading rows…" with the answer already in.
   */
  const lastSig = useRef("");

  // columnOrder must be in deps — otherwise saving a new order leaves the header in the old order
  // until switching tables and back ("saved, nothing changed").
  useEffect(() => {
    api.repoTableMeta(table.name, datasourceId || null, schema)
      .then((m) => setMeta({ ...m, columns: columnOrderIndex(columnOrder, m.columns.map((c) => c.name)).map((i) => m.columns[i]) }))
      .catch(() => setMeta(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, table.name, table.schema, columnOrder]);

  const load = useCallback((off: number, countAgain = false) => {
    setLoading(true); setErr(null);
    // A slower answer must not overwrite a newer one — picking a region then a branch right away,
    // the region-only query (wider, so slower) came back last and overwrote the region+branch grid,
    // showing rows that did not match the visible chips.
    const sig = `${activeKey}|${off}|${pageSize}`;
    lastSig.current = sig;
    // The count is asked for once per filter, then carried: it reads the whole filtered set, so
    // repeating it on every page click would make later pages slower than earlier ones.
    api.repoRows(table.name, { datasourceId: datasourceId || null, schema, limit: pageSize, offset: off,
                              eq: activeEq, filters: filtersParam, sort: sortParam || undefined, withTotal: countAgain, withRowId: wantRowId })
      .then((r) => {
        if (lastSig.current !== sig) return;
        const s = stripRowIds(r);
        setRowIds(s.ids);
        setRows(applyColumnOrder(columnOrder, s.data)); setOffset(off); if (countAgain) setTotal(r.total);
      })
      .catch((e) => {
        if (lastSig.current !== sig) return;
        setRows(null); setRowIds(null); setErr(e instanceof Error ? e.message : "Failed to load rows");
      })
      // Always stop the spinner, even for a stale answer — a stuck spinner is worse than one that stops a bit early.
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  // activeKey not the array: it is rebuilt every render and would re-fire the load forever
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, table.name, table.schema, activeKey, pageSize, wantRowId, columnOrder, filtersParam]);

  // Options for the pickers, once per column. A small lookup fits outright; a large one (thousands
  // of values) comes back as the first OPT_LIMIT, so the picker alone can only ever show a slice of
  // it. Typing therefore has to go back to the server — searching the loaded slice would report
  // "no matches" for values that never made it to the browser.
  // Options load once per table switch — not reloaded as the user changes filters.
  //
  // On a table partitioned by a virtual column that concatenates several fields, option queries
  // do not prune partitions even with every component filtered (Oracle cannot infer the
  // concatenation from separate conditions), so reloading on every filter change would rescan the
  // whole table. Left out until there is an option cache table.
  // Filter defaults — set once per table switch, never overwriting what the user just picked.
  useEffect(() => {
    const def: Record<string, string> = {};
    for (const f of filterColumns) if (f.def) def[f.col] = f.def;
    setUserEq(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.name, table.schema, filterColumns.map((f) => `${f.col}=${f.def ?? ""}`).join(",")]);

  useEffect(() => {
    if (!filterColumns.length) { setOpts({}); return; }
    filterColumns.forEach((f) => loadOpts(f, ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, table.name, table.schema, filterColumns.map((f) => f.col).join(",")]);

  // eq sent with distinct = the admin-pinned slice (e.g. FY) + filters the user picked, except the
  // column being loaded — on a partitioned table this turns a full scan into a single partition.
  const optsEq = useCallback((skipCol: string) =>
    [...eq, ...Object.entries(userEq).filter(([c, v]) => v && c !== skipCol).map(([c, v]) => `${c}=${v}`)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eqKey, userEq]);
  /** Columns whose options failed to load — shown on screen rather than swallowed (silence = users hammering F5). */
  const [optErr, setOptErr] = useState<Record<string, boolean>>({});
  const loadOpts = useCallback((f: FilterCol, q: string) => {
    api.repoDistinct(table.name, f.col, { datasourceId: datasourceId || null, schema, q, labelSource: f.labelSource, eq: optsEq(f.col), optionsFrom: f.optionsFrom })
      .then((vals) => { setOpts((o) => ({ ...o, [f.col]: vals })); setOptErr((e) => ({ ...e, [f.col]: false })); })
      .catch(() => setOptErr((e) => ({ ...e, [f.col]: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, table.name, table.schema, optsEq]);

  /**
   * Child fields reload their options when the parent changes — pick a region and the branch field
   * should list only that region's branches.
   *
   * Only for fields that read options from a small lookup (optionsFrom), so this does not break the
   * rule above about not reloading options from the data table on every filter change.
   *
   * The child's selected value is cleared too — the old region's branch means nothing under the
   * new region; left in place the grid would filter on a pair that does not exist (0 rows, no clue why).
   */
  const kidCols = useMemo(
    () => filterColumns.filter((f) => parentColOf(f)).map((f) => [f.col, parentColOf(f)!] as const),
    [filterColumns]);
  const parentVals = kidCols.map(([c, p]) => `${c}=${userEq[p] ?? ""}`).join(";");
  /**
   * Parent values last seen, and for which table.
   * The table name is kept here rather than resetting the ref in a separate effect — that effect
   * also runs on mount and, declared later, wiped the value just recorded every time, so every
   * round looked like the first and child fields never reloaded.
   */
  const parentSeen = useRef<{ key: string; vals: string } | null>(null);
  useEffect(() => {
    if (!kidCols.length) return;
    const key = `${table.schema ?? ""}.${table.name}`;
    const prev = parentSeen.current;
    parentSeen.current = { key, vals: parentVals };
    // Just opened / just switched tables = already loaded by the table-switch effect.
    if (!prev || prev.key !== key || prev.vals === parentVals) return;
    for (const [col, parent] of kidCols) {
      const f = filterColumns.find((x) => x.col === col);
      if (!f) continue;
      // Clearing the parent (choosing "All") is not changing it — the selected child still applies.
      // Clear the child only when the parent really changes to another value.
      if (userEq[parent] && userEq[col]) setUserEq((cur) => ({ ...cur, [col]: "" }));
      setOpts((o) => { const n = { ...o }; delete n[col]; return n; });
      loadOpts(f, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentVals, table.name, table.schema]);

  // Header filters belong to that table's columns — clear on table switch, or they linger on columns that do not exist.
  useEffect(() => { setColFilters({}); setHfOpts({}); setHfErr({}); }, [table.name, table.schema]);

  // The chosen value must survive the re-fetch: it is what the grid is filtered by, and dropping it
  // from the options would blank the trigger label while the filter stayed on.
  // Searching in one field sends only the admin-pinned eq (FY/stage = the partition pruner), **not**
  // the user's picks in other fields — otherwise after picking a branch the region field would have
  // one value left and the region could not be changed until filters were cleared.
  const searchOpts = useCallback((f: FilterCol, q: string) => {
    const keep = userEq[f.col];
    const kept = opts[f.col]?.find((o) => o.value === keep);
    // Fields that read from a small lookup can send the other filters; the backend uses only the
    // declared parent field. Searching branches stays within the picked region; fields that scan
    // the real table still send just eq.
    const searchEq = f.optionsFrom ? optsEq(f.col) : eq;
    api.repoDistinct(table.name, f.col, { datasourceId: datasourceId || null, schema, q, labelSource: f.labelSource, eq: searchEq, optionsFrom: f.optionsFrom })
      .then((vals) => {
        setOpts((o) => ({
          ...o,
          [f.col]: keep && !vals.some((v) => v.value === keep) ? [kept ?? { value: keep, label: null }, ...vals] : vals,
        }));
        setOptErr((e) => ({ ...e, [f.col]: false }));
      })
      .catch(() => setOptErr((e) => ({ ...e, [f.col]: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, table.name, table.schema, userEq, opts, eqKey, optsEq]);
  /**
   * Values to tick in this column's funnel — three tiers, cheapest first.
   *
   * 1. Columns declared in the registry (with an options source) → reuse the loaded list, no new query.
   * 2. Other columns → the user clicks "load values", offered only on tables small enough to count.
   * 3. Tables that cannot be counted (total = -1) or are too large → type-to-search only, no list.
   *
   * Tier 3 exists because SELECT DISTINCT on a very large table is never fast enough, and opening
   * funnels rapidly column by column opens a new session each time until the database stalls.
   */
  const LIST_MAX_ROWS = 200_000;
  const canListValues = useCallback((col: string) => {
    if (filterColumns.some((f) => f.col.toUpperCase() === col.toUpperCase() && f.optionsFrom)) return true;
    return total >= 0 && total <= LIST_MAX_ROWS;
  }, [filterColumns, total]);

  const hfOptionsFor = useCallback((col: string): RepoOption[] | undefined => {
    const declared = filterColumns.find((f) => f.col.toUpperCase() === col.toUpperCase() && f.optionsFrom);
    if (declared && opts[declared.col]) return opts[declared.col];
    return hfOpts[col];
  }, [filterColumns, opts, hfOpts]);

  const hfNoteFor = useCallback((col: string) => {
    const list = hfOptionsFor(col);
    if (!list) return undefined;
    return list.length >= OPT_LIMIT ? `Showing the first ${OPT_LIMIT} values — use "contains" to search the whole column` : undefined;
  }, [hfOptionsFor]);

  /** Load this column's values, one column at a time on click only — never prefetched for the whole header row. */
  const loadHeaderOpts = useCallback((col: string) => {
    if (hfBusy[col] || hfOpts[col]) return;
    setHfBusy((b) => ({ ...b, [col]: true }));
    setHfErr((e) => ({ ...e, [col]: null }));
    const declared = filterColumns.find((f) => f.col.toUpperCase() === col.toUpperCase());
    api.repoDistinct(table.name, col, {
      datasourceId: datasourceId || null, schema,
      labelSource: declared?.labelSource ?? null, optionsFrom: declared?.optionsFrom ?? null,
      // Send the pinned filters — on a table pruned by a composite key this makes or breaks it.
      eq: activeEq,
      // And narrow by the other columns' funnels (like Excel) — the backend drops this column's own.
      filters: filtersParam,
    })
      .then((vals) => setHfOpts((o) => ({ ...o, [col]: vals })))
      .catch((e) => setHfErr((x) => ({ ...x, [col]: e instanceof Error ? e.message : "Could not load values" })))
      .finally(() => setHfBusy((b) => ({ ...b, [col]: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.name, table.schema, datasourceId, activeKey, filterColumns, hfOpts, hfBusy, filtersParam]);

  // A new filter means a new population, so the count is asked for again here and only here.
  useEffect(() => {
    if (!sizeReady) return;
    // Composite term incomplete = no partition pruning — ask for a pick first rather than fire and fail.
    if (missingParts.length) { setRows(null); setRowIds(null); setErr(null); setLoading(false); return; }
    if (tab === "data") { setTotal(-1); load(0, true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, load, sizeReady, missingParts.join(",")]);

  // A table without a declared primary key is not necessarily unidentifiable — a table may have
  // none, but an ID column that is unique across every row. The registry entry says what to use, and the
  // update/delete endpoints bind whatever key columns they are handed.
  const realPk = meta?.primaryKey ?? [];
  const pk = realPk.length > 0 ? realPk : keyColumns;
  // Two different reasons a row cannot be changed, kept apart so the screen can say which one it
  // is: the table offers no way to address a single row, or the menu is a viewing menu.
  const hasKey = pk.length > 0;
  const canEdit = rights.edit && hasKey;
  const canDelete = rights.del && hasKey;

  /**
   * Edit/delete is "one row" on screen, but the statement is WHERE <key> = ? — if the key columns set
   * in the registry (repo_table.key_columns) are not really unique, it silently hits several rows.
   * A green "Updated · N row(s)" would read like a normal success.
   * So: exactly 1 = normal · anything else = a warning pointing at Key columns.
   */
  function reportRowWrite(what: string, affected: number) {
    if (affected === 1) { toast(`${what} 1 row`, "ok"); return; }
    if (affected === 0) {
      toast(`${what} 0 rows — no row matches the key; someone may have changed or deleted it. Click Reload for the latest`, "error");
      return;
    }
    toast(`⚠ ${what} ${affected} rows at once — the configured key does not identify a single row. `
        + `Check "Key columns" in this table's Settings`, "error");
  }

  function keyOf(row: (string | number | null)[]): Record<string, unknown> {
    const cols = rows!.columns;
    const k: Record<string, unknown> = {};
    for (const p of pk) {
      // ROWID is not in the row the screen holds (split off on load) — take it from the parallel array by row index.
      if (p.toUpperCase() === ROWID_COL) {
        const at = rows!.rows.indexOf(row);
        if (at >= 0 && rowIds?.[at]) k[ROWID_COL] = rowIds[at];
        continue;
      }
      const i = cols.findIndex((c) => c.toLowerCase() === p.toLowerCase()); if (i >= 0) k[p] = row[i];
    }
    // The filters the screen is using must be part of the key too, not just the key columns.
    //
    // A table with no primary key whose configured key repeats across years — unique within a
    // year, and (key, year) unique overall — would otherwise have every "single row" edit on this
    // year's screen also hit last year's twin.
    //
    // The screen already filters by year (eq_filter) but would not send it with the write. Adding the active filters to the key is true of the visible row by definition, so it
    // only narrows — it can never hit another row.
    for (const e of activeEq) {
      const at = e.indexOf("=");
      if (at <= 0) continue;
      const col = e.slice(0, at).trim();
      if (!col || col in k) continue;
      if (!cols.some((c) => c.toLowerCase() === col.toLowerCase())) continue;
      k[col] = e.slice(at + 1).trim();
    }
    return k;
  }

  /** Row clicked delete once — a second click deletes, instead of the browser confirm box. */
  const [confirmRow, setConfirmRow] = useState<number | null>(null);

  async function removeRow(row: (string | number | null)[], i: number) {
    if (!canDelete) return;
    if (confirmRow !== i) { setConfirmRow(i); return; }
    setConfirmRow(null);
    try {
      const res = await api.repoDelete(table.name, { datasourceId: datasourceId || null, schema, key: keyOf(row) });
      reportRowWrite("Deleted", res.affected);
      if (res.affected > 0) { setTotal((t) => (t >= 0 ? Math.max(0, t - res.affected) : t)); onRowsChanged?.(-res.affected); }
      load(offset);
    } catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  function openEdit(row: (string | number | null)[]) {
    const values: Record<string, string> = {};
    rows!.columns.forEach((c, i) => { values[c] = row[i] === null ? "" : String(row[i]); });
    setEditing({ mode: "edit", values, orig: row });
  }
  function openNew() {
    const values: Record<string, string> = {};
    (meta?.columns ?? []).forEach((c) => { values[c.name] = ""; });
    setEditing({ mode: "new", values });
  }

  async function saveEdit(edited: Record<string, string>, nulls: Record<string, boolean>) {
    if (!editing || !meta) return;
    try {
      if (editing.mode === "new") {
        const values: Record<string, unknown> = {};
        for (const c of meta.columns) {
          const v = edited[c.name];
          if (nulls[c.name]) values[c.name] = null;
          else if (v !== "" && v !== undefined) values[c.name] = v;
        }
        if (Object.keys(values).length === 0) { toast("Enter at least one value", "error"); return; }
        const res = await api.repoInsert(table.name, { datasourceId: datasourceId || null, schema, values });
        toast(`Inserted · ${res.affected} row(s)`, "ok");
        // Keep the "N rows" total in step with the grid without re-counting the whole table.
        if (res.affected > 0) { setTotal((t) => (t >= 0 ? t + res.affected : t)); onRowsChanged?.(res.affected); }
      } else {
        const set: Record<string, unknown> = {};
        rows!.columns.forEach((c, i) => {
          const before = editing.orig![i];
          const after = nulls[c] ? null : edited[c];
          const beforeStr = before === null ? "" : String(before);
          if (nulls[c] ? before !== null : after !== beforeStr) set[c] = after;
        });
        if (Object.keys(set).length === 0) { setEditing(null); return; }
        const res = await api.repoUpdate(table.name, { datasourceId: datasourceId || null, schema, set, key: keyOf(editing.orig!) });
        reportRowWrite("Updated", res.affected);
      }
      setEditing(null); load(offset);
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
  }

  // Queued on the real export system, not downloaded straight from the screen.
  //
  // It used to write the whole file on the request thread before the first byte — a multi-GB table
  // hung for minutes, a reverse proxy cut it off, the user saw only an error while the database query
  // kept running to the end. The sql engine streams row by row, can be cancelled, and keeps the
  // file for later download.
  const [exporting, setExporting] = useState(false);
  /**
   * Export = queue the file build, then **wait for it and download it automatically**.
   *
   * Previously the screen only said "queued, fetch it from Output Files", so clicking seemed to do
   * nothing and users read it as "export produced no data", though the file was correct.
   *
   * Large tables that take longer still fall back to Output Files, but that is no longer the norm.
   */
  async function doExport(format: "txt" | "csv" | "xlsx") {
    setExporting(true);                       // only while sending the request, not while the file builds
    try {
      const r = await api.repoExportJob(table.name, format,
        { datasourceId: datasourceId || null, schema, eq: activeEq, year: yearVal ? yearPick : undefined, yearColumn: yearVal && yearCol ? yearCol : undefined,
          sort: sortParam || undefined,
          label: (label?.trim() || table.name),
          // File columns in the on-screen order (meta.columns is already ordered by the registry)
          columns: meta?.columns.map((c) => c.name).filter((n) => !isHidden(n)),
          filters: filtersParam,
          // Header names the destination expects  — only the configured columns
          labels: Object.entries(labelMap).map(([k, v]) => `${k}=${v}`).join(";") || undefined });
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      toast("Building the file… keep working, other exports can be started too", "ok");
      onExportQueued(r.jobId, `${table.name}_${stamp}.${format}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Export failed", "error"); }
    finally { setExporting(false); }
  }

  return (
    <Tile className={styles.panel}>
      {/* Table name and tabs share one row — saves a second bar that held only the name and column count. */}
      <div className={styles.panelHead}>
        <Icon name={table.type === "VIEW" ? "eye" : "table"} size={16} style={{ color: "var(--cds-icon-secondary)", flex: "none" }} />
        <h2 className={"cds--type-heading-compact-02 " + styles.panelTitle} title={`${table.schema ? `${table.schema}.` : ""}${table.name}`}>{label?.trim() || `${table.schema ? `${table.schema}.` : ""}${table.name}`}</h2>
        {table.type === "VIEW" && <Tag size="sm" type="purple">view</Tag>}
        {/* Not "PK:" for a key set in the registry (repo_table.key_columns) — it is not a real primary
            key and may not be unique; labelling it PK would suggest it is safe. */}
        {meta && (
          <span className="cds--type-label-01 rh-dim">
            {meta.columns.length} cols
            {realPk.length ? ` · PK: ${realPk.join(", ")}`
              : pk.length ? ` · configured key: ${pk.join(", ")}`
              : " · no PK"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <TabBar tab={tab} setTab={setTab} hasTable canEdit={!!settingsPanel} />
      </div>

      {tab === "data" && (
        <div className={styles.dataPane}>
          {/* One filter button opening a panel — one dropdown per column used to overflow the line
              on tables with 5-6 filters. */}
          <div className={styles.controls}>
            {filterColumns.length > 0 && (
              <div className={styles.filt} ref={filtRef}>
                <Button kind={activeFilters.length ? "tertiary" : "ghost"} size="sm" renderIcon={filterOpen ? ChevronUp : ChevronDown}
                        onClick={() => setFilterOpen((v) => !v)} aria-expanded={filterOpen}>
                  Filters{activeFilters.length > 0 ? ` (${activeFilters.length})` : ""}
                </Button>

                {filterOpen && (
                  <Layer className={styles.filtPanel}>
                    {/* With few fields all are visible; an autofocused search would just steal the cursor. */}
                    {filterColumns.length > 4 && (
                      <Search size="sm" autoFocus labelText="Find a filter" placeholder="Find a filter" value={filterQ}
                              onChange={(e) => setFilterQ(e.target.value)} />
                    )}

                    <div className={styles.filtBody}>
                      {/* One dropdown per column — chips cannot hold columns with thousands of values.
                          Dropdowns search their own values, so the panel search finds filters instead. */}
                      {shownFilterCols.map((f) => (
                        <Select key={f.col} label={f.label} value={userEq[f.col] ?? ""} searchable compact
                                placeholder={opts[f.col] === undefined && !optErr[f.col] ? "" : "All"}
                                onChange={(v) => setUserEq((cur) => ({ ...cur, [f.col]: v }))}
                                onSearch={(q) => searchOpts(f, q)}
                                note={optErr[f.col] ? "Could not load options — type to retry"
                                  : (opts[f.col] ?? []).length >= OPT_LIMIT ? `Showing the first ${OPT_LIMIT} values — type to search the whole table` : undefined}
                                options={[{ value: "", label: "All" },
                                          ...(opts[f.col] ?? []).map((o) => ({
                                            value: o.value,
                                            label: o.label ? `${o.value} ${o.label}` : o.value,
                                          }))]} />
                      ))}
                      {shownFilterCols.length === 0 && (
                        <p className="cds--type-body-compact-01 rh-dim">No filter matches “{filterQ}”</p>
                      )}
                    </div>

                    <div className={styles.filtFoot}>
                      <span className="cds--type-label-01 rh-dim">{activeFilters.length ? `${activeFilters.length} selected` : "None selected"}</span>
                      <Button kind="ghost" size="sm" onClick={() => setUserEq({})}>Clear all</Button>
                    </div>
                  </Layer>
                )}
              </div>
            )}

            {/* Selected filters show as tags next to the button — visible without opening the panel. */}
            {activeFilters.map(([col, val]) => {
              const f = filterColumns.find((x) => x.col === col);
              const o = (opts[col] ?? []).find((x) => x.value === val);
              return (
                <DismissibleTag key={col} size="sm" type="blue" title="Remove this filter"
                                text={`${f?.label ?? col}: ${o?.label ? `${val} ${o.label}` : val}`}
                                onClose={() => setUserEq((cur) => ({ ...cur, [col]: "" }))} />
              );
            })}

            {/* Header funnel filters show as tags too, or after scrolling far one forgets what is filtered. */}
            {activeColFilters.map(([col, v]) => (
              <DismissibleTag key={`hf-${col}`} size="sm" type="cool-gray" renderIcon={Filter}
                              title="Filtered from the column header — remove"
                              text={`${col}: ${v.values.length ? (v.values.length > 2 ? `${v.values.length} values` : v.values.join(", ")) : ""}${v.values.length && v.contains ? " + " : ""}${v.contains ? `“${v.contains}”` : ""}`}
                              onClose={() => setColFilters((cur) => ({ ...cur, [col]: { ...EMPTY_FILTER } }))} />
            ))}

            <span style={{ flex: 1 }} />
            {yearCol && (
              <Select compact prefix="Year:" className={styles.menuEnd} value={yearPick} placeholder="All years" style={{ width: 150 }}
                      onChange={setYearPick}
                      options={[{ value: "", label: "All years" },
                                ...(yearPick && !yearOpts.includes(yearPick) ? [yearPick] : []).concat(yearOpts).map((y) => ({ value: y, label: y }))]} />
            )}
            <IconButton kind="ghost" size="sm" label="Reload" onClick={() => load(offset)}><Renew size={16} /></IconButton>
            <ExportMenu busy={exporting} pending={pendingExports} onPick={doExport}
                        activeFilters={activeEq.filter((t) => t.slice(t.indexOf("=") + 1).trim() !== "").length + activeColFilters.length} />
            {!rights.edit && !rights.add && !rights.del && <Tag size="sm" type="gray">View only</Tag>}
            {rights.add && <IconButton kind="primary" size="sm" label="Add row" align="bottom-end" onClick={openNew}><Add size={16} /></IconButton>}
          </div>

          <div className={styles.gridCard}>
          <div className={styles.gridWrap}>
            {!loading && missingParts.length > 0 && (
              <div className={styles.gridEmpty}>
                <Filter size={24} className="rh-dim" />
                <h3 className="cds--type-heading-compact-01">Pick the required filters first</h3>
                <p className="cds--type-body-compact-01 rh-dim">
                  Required: <strong>{missingParts.map((c) => filterColumns.find((f) => f.col === c)?.label ?? c).join(" · ")}</strong>
                </p>
              </div>
            )}
            {/* The skeleton is only for "nothing to show yet". With data already shown, keep the grid
                and just dim it — otherwise every refilter unmounts the grid, closing any open funnel
                panel and dropping focus from its input mid-typing. */}
            {loading && !rows && (
              <DataTableSkeleton showHeader={false} showToolbar={false} columnCount={7} rowCount={8} size="sm" />
            )}
            {err && <InlineNotification kind="error" lowContrast hideCloseButton title={err} className={styles.gridErr} />}
            {!err && rows && (
              <Table size="sm" className={styles.grid + (loading ? " " + styles.dim : "")}>
                <TableHead><TableRow>
                  <TableHeader className={styles.colNo}>#</TableHeader>
                  {rows.columns.map((c) => {
                    if (isHidden(c)) return null;
                    const isPk = pk.some((p) => p.toLowerCase() === c.toLowerCase());
                    const so = sortOf(c);
                    return (
                      <TableHeader key={c} aria-sort={so ? (so.dir === "asc" ? "ascending" : "descending") : "none"}>
                        <div className={styles.ghName}>
                          <button type="button" className={styles.ghSort + (so ? " " + styles.ghSorted : "")} title="Sort (Shift+click to add)" onClick={(ev) => cycleSort(c, ev.shiftKey)}>
                            {c}
                            {so ? (so.dir === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />) : <ArrowsVertical size={14} className={styles.ghIdle} />}
                            {sorts.length > 1 && so && <span className="cds--type-helper-text-01">{sorts.findIndex((x) => x.col === c) + 1}</span>}
                          </button>{isPk && <Icon name="star" size={12} className={styles.ghPk} />}
                          <HeaderFilter label={c}
                            value={colFilters[c]}
                            onChange={(v) => setColFilters((cur) => ({ ...cur, [c]: v }))}
                            options={hfOptionsFor(c)}
                            optionsNote={hfNoteFor(c)}
                            onNeedOptions={canListValues(c) ? () => loadHeaderOpts(c) : undefined}
                            loadingOptions={!!hfBusy[c]}
                            optionsError={hfErr[c] ?? null} />
                        </div>
                        <div className={styles.ghType}>{meta?.columns.find((m) => m.name.toLowerCase() === c.toLowerCase())?.type ?? ""}</div>
                      </TableHeader>
                    );
                  })}
                </TableRow></TableHead>
                <TableBody>
                  {rows.rows.map((r, i) => (
                    <TableRow key={i} className={canEdit ? styles.editable : undefined}
                        onDoubleClick={() => canEdit && openEdit(r)}
                        onMouseLeave={() => setConfirmRow((c) => (c === i ? null : c))}>
                      {/* Row number always shown · actions appear on hover. */}
                      <TableCell className={styles.colNo}>
                        <span className={styles.gno}>{offset + i + 1}</span>
                        {canEdit && (
                          <span className={styles.gacts} onClick={(e) => e.stopPropagation()}>
                            <IconButton kind="ghost" size="sm" label="Edit this row" align="right" onClick={() => openEdit(r)}><Edit size={16} /></IconButton>
                            {canDelete && (confirmRow === i
                              ? <Button kind="danger" size="sm" title="Click again to delete this row" onClick={() => removeRow(r, i)}>Sure?</Button>
                              : <IconButton kind="ghost" size="sm" label="Delete this row" align="right" onClick={() => removeRow(r, i)}><TrashCan size={16} /></IconButton>)}
                          </span>
                        )}
                      </TableCell>
                      {r.map((v, j) => (
                        isHidden(rows.columns[j]) ? null : (
                          <TableCell key={j} className={isNumCol(rows.columns[j], v) ? styles.num : styles.txt} title={v === null ? "" : String(v)}>
                            {v === null ? <span className={styles.gnull}>NULL</span> : String(v)}
                          </TableCell>
                        )
                      ))}
                    </TableRow>
                  ))}
                  {rows.rowCount === 0 && (
                    <TableRow><TableCell colSpan={rows.columns.filter((c) => !isHidden(c)).length + 1}>
                      <div className={styles.gridEmpty}>
                        <Filter size={24} className="rh-dim" />
                        <h3 className="cds--type-heading-compact-01">
                          {Object.values(userEq).some(Boolean) || yearVal || activeColFilters.length || eq.length || builtEq.length
                            ? "No row matches the filters" : "This table is empty"}
                        </h3>
                      </div>
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </div>
          {/* Footer bar — the pager sits where scrolling ends, no need to scroll back up. */}
          <div className={styles.gridFoot}>
            <Pager offset={offset} pageRows={rows?.rowCount ?? 0} total={total} loading={loading}
                   pageSize={pageSize}
                   onPageSize={(n) => { setPageSize(n); localStorage.setItem(PAGE_KEY, String(n)); load(0); }}
                   onGo={(o) => load(o)} />
          </div>
          </div>
        </div>
      )}

      {tab === "columns" && meta && (
        <ColumnsTab columns={meta.columns} canOrder={!!onSaveOrder}
                    onSaveOrder={async (spec) => { await onSaveOrder?.(spec); }}
                    hidden={hiddenSet}
                    onSaveHidden={async (names) => { await onSaveHidden?.(names); }}
                    labels={labelMap}
                    onSaveLabels={async (pairs) => { await onSaveLabels?.(pairs); }} />
      )}

      {tab === "settings" && settingsPanel}

      {editing && meta && (
        <RowEditor meta={meta} editing={editing} setEditing={setEditing} onSave={saveEdit} />
      )}
    </Tile>
  );
}

/**
 * Properties tab — drag to reorder columns; the screen and exported files follow that order.
 *
 * The order is stored as a column list in the registry (repo_table.column_order); the physical
 * column order is not touched — Oracle cannot reorder columns in place, it means rebuilding the
 * whole table (risking partitions/grants and needing twice the disk), so ordering is done at the
 * display layer.
 */
function ColumnsTab({ columns, canOrder, onSaveOrder, hidden, onSaveHidden, labels, onSaveLabels }: {
  columns: RepoColumn[];
  canOrder: boolean;
  onSaveOrder: (spec: string | null) => Promise<void>;
  /** Hidden column names (upper case) */
  hidden: Set<string>;
  onSaveHidden: (names: string[]) => Promise<void>;
  /** Export header names (keys upper case) */
  labels: Record<string, string>;
  onSaveLabels: (pairs: Record<string, string>) => Promise<void>;
}) {
  const original = useMemo(() => columns.map((c) => c.name), [columns]);
  const [names, setNames] = useState<string[]>(original);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Table changed = start from the order the screen is actually using.
  useEffect(() => { setNames(original); }, [original]);

  const byName = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns]);
  const dirty = names.length !== original.length || names.some((n, i) => n !== original[i]);

  function move(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    setNames((cur) => { const n = [...cur]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; });
  }

  async function save() {
    setBusy(true);
    try { await onSaveOrder(names.join(",")); } finally { setBusy(false); }
  }

  /** Set one column's export header name — empty = use the real name. */
  async function setLabel(name: string, value: string) {
    const up = name.toUpperCase();
    const v = value.trim();
    if ((labels[up] ?? "") === v) return;
    const next = { ...labels };
    if (v) next[up] = v; else delete next[up];
    setBusy(true);
    try { await onSaveLabels(next); } finally { setBusy(false); }
  }

  /** Toggle one column shown/hidden — saved immediately, no confirm (click again to undo). */
  async function toggleHidden(name: string) {
    const up = name.toUpperCase();
    const next = hidden.has(up)
      ? [...hidden].filter((h) => h !== up)
      : [...hidden, up];
    setBusy(true);
    try { await onSaveHidden(next); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {canOrder && (
        <div className={styles.orderBar}>
          <span className="cds--type-label-01 rh-dim">Column order applies to the grid and exported files</span>
          <span style={{ flex: 1 }} />
          {dirty && (
            <>
              <Button kind="ghost" size="sm" disabled={busy} onClick={() => setNames(original)}>Revert</Button>
              <Button kind="primary" size="sm" disabled={busy} renderIcon={Checkmark} onClick={save}>Save order</Button>
            </>
          )}
          {!dirty && (
            <Button kind="ghost" size="sm" disabled={busy} onClick={() => onSaveOrder(null)}
                    title="Go back to the order stored in the database">Clear saved order</Button>
          )}
        </div>
      )}
      {/* Fill the remaining height and scroll inside. */}
      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        <Table size="sm" useZebraStyles={false}>
          <TableHead><TableRow>
            {canOrder && <TableHeader style={{ width: 40 }} aria-label="Drag" />}
            <TableHeader style={{ width: 48 }}>#</TableHeader>
            {canOrder && <TableHeader style={{ width: 64 }}>Show</TableHeader>}
            <TableHeader>Column</TableHeader>
            {canOrder && <TableHeader style={{ width: 180 }}>Export name</TableHeader>}
            <TableHeader>Type</TableHeader><TableHeader>Nullable</TableHeader><TableHeader>Key</TableHeader>
          </TableRow></TableHead>
          <TableBody>
            {names.map((n, i) => {
              const c = byName.get(n);
              if (!c) return null;
              const off = hidden.has(n.toUpperCase());
              // draggable on the row turned clicks on its controls into drag starts, so the
              // show/hide checkbox never registered. Only the grip is draggable; the whole row
              // remains a drop target.
              return (
                <TableRow key={n} data-off={off ? "1" : undefined}
                    className={(off ? styles.rowOff + " " : "") + (drag === i ? styles.rowDrag + " " : "") + (over === i && drag !== null && drag !== i ? styles.rowOver : "")}
                    onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(i); } }}
                    onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}>
                  {canOrder && (
                    <TableCell className={styles.grip} title="Drag to reorder"
                        draggable
                        onDragStart={() => setDrag(i)}
                        onDragEnd={() => { setDrag(null); setOver(null); }}><Draggable size={16} /></TableCell>
                  )}
                  <TableCell className="rh-dim">{i + 1}</TableCell>
                  {canOrder && (
                    <TableCell>
                      <Checkbox id={`show-${c.name}`} hideLabel labelText={off ? `Show ${c.name}` : `Hide ${c.name}`}
                                title={off ? "Hidden — tick to show" : "Shown — untick to hide"}
                                checked={!off} disabled={busy} onChange={() => toggleHidden(c.name)} />
                    </TableCell>
                  )}
                  <TableCell><strong>{c.name}</strong></TableCell>
                  {canOrder && (
                    <TableCell>
                      {/* Empty = real name · the screen always shows the real name, only the export header changes. */}
                      <TextInput id={`lbl-${c.name}`} size="sm" hideLabel labelText={`Export name for ${c.name}`}
                                 defaultValue={labels[c.name.toUpperCase()] ?? ""}
                                 placeholder={c.name} disabled={busy}
                                 onBlur={(e) => setLabel(c.name, e.target.value)}
                                 onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                    </TableCell>
                  )}
                  <TableCell className="cds--type-code-01">{c.type}</TableCell>
                  <TableCell>{c.nullable ? <span className="rh-dim">nullable</span> : <Tag size="sm" type="gray">NOT NULL</Tag>}</TableCell>
                  <TableCell>{c.pk ? <Tag size="sm" type="green">PK</Tag> : ""}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RowEditor({ meta, editing, setEditing, onSave }: {
  meta: RepoTableMeta;
  editing: { mode: "new" | "edit"; values: Record<string, string>; orig?: (string | number | null)[] };
  setEditing: (e: typeof editing | null) => void;
  onSave: (values: Record<string, string>, nulls: Record<string, boolean>) => void;
}) {
  const [values, setValues] = useState(editing.values);
  const [nulls, setNulls] = useState<Record<string, boolean>>(() => {
    const n: Record<string, boolean> = {};
    if (editing.mode === "edit" && editing.orig) meta.columns.forEach((c, i) => { if (editing.orig![i] === null) n[c.name] = true; });
    return n;
  });
  const [q, setQ] = useState("");
  const shown = q.trim()
    ? meta.columns.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()))
    : meta.columns;

  // A side panel instead of a centered dialog — a 250-column table in a 520px box means endless
  // scrolling, and the dialog hid the row being edited. The panel stays beside the grid.
  return (
    <SlideOver title={editing.mode === "new" ? "Insert row" : "Edit row"} sub={`${meta.columns.length} columns`}
               onClose={() => setEditing(null)} width={520}
               foot={
                 <ButtonSet className="rh-foot-set">
                   <Button kind="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                   <Button kind="primary" renderIcon={Checkmark} onClick={() => onSave(values, nulls)}>
                     {editing.mode === "new" ? "Insert" : "Save changes"}
                   </Button>
                 </ButtonSet>
               }>
      {/* Hundreds of columns cannot be scanned by eye — a search box is needed. */}
      {meta.columns.length > 12 && (
        <Search size="sm" labelText="Find a column" placeholder="Find a column" value={q}
                onChange={(e) => setQ(e.target.value)} className={styles.gapBelow} />
      )}
      {shown.map((c) => (
        <div key={c.name} className={styles.rowField}>
          <TextInput id={`re-${c.name}`} size="sm" className="rh-mono"
                     labelText={<span className={styles.inlineLabel}>{c.name}<span className="rh-dim">{c.type}</span>{c.pk && <Tag size="sm" type="green">PK</Tag>}</span>}
                     value={nulls[c.name] ? "" : (values[c.name] ?? "")}
                     disabled={nulls[c.name]}
                     onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))} />
          <Checkbox id={`rn-${c.name}`} labelText="NULL" checked={!!nulls[c.name]}
                    disabled={!c.nullable && !c.pk}
                    onChange={(_, { checked }) => setNulls((n) => ({ ...n, [c.name]: checked }))} />
        </div>
      ))}
      {shown.length === 0 && <p className="cds--type-body-compact-01 rh-dim">No column matches “{q}”</p>}
    </SlideOver>
  );
}

/**
 * Three-format export action button. Downloads run over the whole filtered result server-side, so
 * the menu names the scope explicitly — the previous button silently exported only the visible
 * page.
 *
 * The formats are just formats. This exports the table AS IT IS — every column, in physical order
 * — so it is not a way to produce an interface file with a required layout: those need a specific
 * column list in a specific order (a file spec may list dozens of named fields whose order does not match the table's). That belongs in a saved SQL program, which is what the left
 * panel is for.
 */
function ExportMenu({ busy, pending = 0, onPick, activeFilters = 0 }: {
  busy: boolean;
  /** Files being built — shown as a number next to the button, does not block more clicks. */
  pending?: number;
  onPick: (f: "txt" | "csv" | "xlsx") => void; activeFilters?: number;
}) {
  // Filters that really affect the file = the filters in force on screen (the export sends exactly those).
  const total = activeFilters;
  const scope = total > 0
    ? `Every row matching the ${total} filter${total === 1 ? "" : "s"} in force · every column · sent to the queue`
    : "Every row in the table · every column · sent to the queue";
  // Not disabled while files build — exports can be stacked, each job follows its own result
  // (disabled only for the instant the request is sent, to avoid duplicate jobs).
  return (
    <span className={styles.exportWrap}>
      <OverflowMenu renderIcon={Download} size="sm" flipped disabled={busy} aria-label="Export"
                    iconDescription={pending > 0 ? `${pending} file${pending === 1 ? "" : "s"} building — more can be queued` : `Export — ${scope}`}>
        <OverflowMenuItem itemText=".txt (pipe delimited)" title={scope} onClick={() => onPick("txt")} />
        <OverflowMenuItem itemText=".xlsx (Excel)" title={scope} onClick={() => onPick("xlsx")} />
        <OverflowMenuItem itemText=".csv" title={scope} onClick={() => onPick("csv")} />
      </OverflowMenu>
      {pending > 0 && <Tag size="sm" type="blue" title="Files building">{pending}</Tag>}
    </span>
  );
}
