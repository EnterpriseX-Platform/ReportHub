"use client";

/**
 * SQL box that actually runs one statement — SELECT / INSERT / UPDATE / DELETE / MERGE.
 *
 * Lives on its own screen at /sqleditor (the Tables screen shows tables only).
 *
 * Every statement goes through POST /repository/execute, which logs each run **whether it succeeds or fails**
 * and rejects DDL (DROP/ALTER/TRUNCATE/CREATE) and multi-statement input up front.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Button, ContentSwitcher, DataTableSkeleton, IconButton, InlineNotification, OverflowMenu, OverflowMenuItem, Switch,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, TextInput,
} from "@carbon/react";
import { Checkmark, Close, Code, Copy, Download, Edit, Play, RecentlyViewed, Save, Table as TableIcon } from "@carbon/icons-react";
import styles from "./D/SqlRunner.module.scss";
import { localTime } from "@/lib/format";
import { SqlEditor as SqlBox } from "@/components/SqlEditor";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { SaveDestination, getSharedWorkspace } from "@/components/workspace";
import { Select } from "@/components/Select";
import { Pager, PAGE_SIZES, DEFAULT_PAGE_SIZE } from "@/components/Pager";
import { HeaderFilter, EMPTY_FILTER, isFilterOn, type ColFilterValue } from "@/components/HeaderFilter";
import type { Datasource, RepoExecResult, SavedViewRow, SqlRunLogRow } from "@/lib/types";

const PAGE_KEY = "rs.sqleditor.pageSize";
const H_KEY = "rs.sqleditor.editorH";

export function SqlRunner({ datasourceId, toast, seed, openedName: openedNameProp, openedId: openedIdProp, onSavedChanged, datasources, onDatasource, deletedId }: {
  datasourceId: string; toast: ReturnType<typeof useToast>; seed: string;
  openedName: string | null;
  /** The saved script currently open — null = a new, never-saved script */
  openedId: number | null;
  onSavedChanged: () => void;
  /** A script just deleted from the list — if it is the one saved from this editor, the editor goes back to "New script". */
  deletedId?: number | null;
  /** All connections + setter — on the editor toolbar rather than a floating row above the screen */
  datasources: Datasource[];
  onDatasource: (id: string) => void;
}) {
  const uid = useId();
  const [sql, setSql] = useState(seed);
  /** Set after "Save" of a new script, so the header shows its name and later saves overwrite it */
  const [savedAs, setSavedAs] = useState<{ id: number; name: string } | null>(null);
  const openedName = savedAs?.name ?? openedNameProp;
  useEffect(() => {
    if (deletedId != null && savedAs?.id === deletedId) { setSavedAs(null); setSavedSql(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deletedId]);
  const openedId = savedAs?.id ?? openedIdProp;
  /** Values for $NAME / :name variables found in the SQL */
  const [vars, setVars] = useState<Record<string, string>>({});
  const varNames = useMemo(() => sqlVariables(sql), [sql]);
  /** Bare names (no ':' / '$' prefix) — the server binds by name */
  const params = () => Object.fromEntries(varNames.map((n) => [n.replace(/^[:$]/, ""), vars[n] ?? ""]));
  /** Text as loaded when the script was opened — used to detect unsaved edits */
  const [savedSql, setSavedSql] = useState(seed);
  const dirty = sql !== savedSql;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RepoExecResult | null>(null);

  /**
   * Paging of the result — same component as the Tables screen (components/Pager).
   * Unlike Tables, paging is client-side: /repository/execute already returns the whole
   * (server-capped) result, and asking again would re-run the statement —
   * for INSERT/UPDATE/DELETE that means doing the work twice, not just slowness.
   */
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const n = Number(localStorage.getItem(PAGE_KEY));
    if (PAGE_SIZES.includes(n)) setPageSize(n);
  }, []);
  /**
   * Per-column header filters — same component as the Tables screen (components/HeaderFilter).
   *
   * <p>Unlike Tables, **no database round trip at all**: both the pickable values and the filtering
   * come from `result.rows`, which is already in hand. Tables must query because real tables have
   * millions of rows; here a re-query would re-run the statement, which for
   * INSERT/UPDATE/DELETE means doing the work again.
   */
  const [colFilters, setColFilters] = useState<Record<string, ColFilterValue>>({});
  const anyFilter = useMemo(() => Object.values(colFilters).some(isFilterOn), [colFilters]);

  /** Distinct values present in the column (from the result) — sorted, capped at 500 to keep the panel usable */
  const hfOptionsFor = useCallback((col: string) => {
    if (result?.kind !== "select") return [];
    const j = result.columns.indexOf(col);
    if (j < 0) return [];
    const seen = new Set<string>();
    for (const r of result.rows) {
      seen.add(r[j] === null ? "" : String(r[j]));
      if (seen.size > 500) break;
    }
    return [...seen].sort((a, b) => a.localeCompare(b, "th", { numeric: true }))
      .map((v) => ({ value: v, label: v === "" ? "(blank)" : null }));
  }, [result]);

  /** Rows left after filtering — picked values and/or contains term (both set = must match both) */
  const filteredRows = useMemo(() => {
    if (result?.kind !== "select") return [];
    if (!anyFilter) return result.rows;
    const active = Object.entries(colFilters)
      .filter(([, f]) => isFilterOn(f))
      .map(([c, f]) => ({ j: result.columns.indexOf(c), f }))
      .filter((x) => x.j >= 0);
    return result.rows.filter((r) => active.every(({ j, f }) => {
      const cell = r[j] === null ? "" : String(r[j]);
      if (f.values.length > 0 && !f.values.includes(cell)) return false;
      const q = f.contains.trim().toLowerCase();
      return !q || cell.toLowerCase().includes(q);
    }));
  }, [result, colFilters, anyFilter]);

  const pageRows = useMemo(
    () => filteredRows.slice(offset, offset + pageSize), [filteredRows, offset, pageSize]);

  // Re-filtering must go back to page 1, otherwise you can sit on page 7 of a 3-row result = empty screen
  useEffect(() => { setOffset(0); }, [colFilters]);

  /** Editor height — drag the divider to split space between SQL and results; remembered */
  const [editorH, setEditorH] = useState(260);
  useEffect(() => {
    const n = Number(localStorage.getItem(H_KEY));
    if (n >= 120 && n <= 720) setEditorH(n);
  }, []);
  const drag = useRef<{ y: number; h: number } | null>(null);
  useEffect(() => {
    function move(e: MouseEvent) {
      if (!drag.current) return;
      const h = Math.min(720, Math.max(120, drag.current.h + e.clientY - drag.current.y));
      setEditorH(h);
    }
    function up() {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.userSelect = "";
      setEditorH((h) => { localStorage.setItem(H_KEY, String(h)); return h; });
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  // Everything else in the app can be saved and picked up again — a dataset, a pipeline, a check,
  // an ad-hoc report. This editor was the one place where the work only lived in the textarea:
  // navigate away and the SQL was gone. Saved under saved_view kind="sql", so these inherit the
  // folders, workspaces and sharing the other saved things already have.
  const [saved, setSaved] = useState<SavedViewRow[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  /** Private (default) or visible to everyone — stored in saved_view.is_public */
  const [isPublic, setIsPublic] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<number>(getSharedWorkspace());
  const loadedName = openedName;

  // only for the folder suggestions in the save dialog — the list itself lives in the left panel
  const reloadSaved = useCallback(() => {
    api.savedViews("sql").then(setSaved).catch(() => {});
  }, []);
  useEffect(() => { reloadSaved(); }, [reloadSaved]);

  /**
   * Update the open script in place rather than creating a new one;
   * saving twice must not produce two scripts with the same name.
   */
  async function updateProgram() {
    if (openedId == null) return;
    if (!sql.trim()) { toast("There is no SQL to save", "error"); return; }
    try {
      await api.updateView(openedId, { payload: JSON.stringify({ datasourceId, sql }) });
      setSavedSql(sql);                       // saved: clear the "unsaved" marker
      toast(`Updated "${loadedName}"`, "ok");
      onSavedChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "Update failed", "error"); }
  }

  /** Run history — already recorded in the database (sql_run_log); this shows it */
  const [histOpen, setHistOpen] = useState(false);
  const [hist, setHist] = useState<SqlRunLogRow[] | null>(null);
  async function openHistory() {
    setHistOpen(true);
    if (hist) return;
    try { setHist(await api.sqlRunHistory(30, true)); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not read the history", "error"); setHist([]); }
  }

  async function saveProgram() {
    if (!name.trim()) { toast("Give it a name first", "error"); return; }
    if (!sql.trim()) { toast("There is no SQL to save", "error"); return; }
    try {
      const row = await api.saveView({
        kind: "sql", name: name.trim(), workspaceId, folder: folder || undefined, isPublic,
        payload: JSON.stringify({ datasourceId, sql }),
      });
      setSavedSql(sql);
      if (row && typeof row.id === "number") setSavedAs({ id: row.id, name: row.name ?? name.trim() });
      toast("Saved — it's in the list on the left", "ok");
      setShowSave(false); setName("");
      reloadSaved(); onSavedChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
  }

  /**
   * Export the result to a file — the server re-runs the statement and writes the file directly,
   * not from the on-screen table, which only holds the (row-capped) result,
   * so the file contains every row the statement returns, not just what is visible.
   */
  const [exporting, setExporting] = useState<null | "csv" | "xlsx">(null);
  async function exportResult(format: "csv" | "xlsx") {
    if (!sql.trim()) return;
    setExporting(format);
    try {
      const base = (loadedName || "sql-result").replace(/[\\/:*?"<>|]+/g, "_");
      // Header filters travel with the export, otherwise a filtered export would not match the screen
      // (the server re-runs the statement and filters with the same rules as the screen — it does not
      //  write the on-screen rows, which are capped by the server's row limit)
      const filters = anyFilter
        ? Object.fromEntries(Object.entries(colFilters).filter(([, f]) => isFilterOn(f))
            .map(([c, f]) => [c, { values: f.values, contains: f.contains.trim() }]))
        : undefined;
      await api.exportSqlResult({ datasourceId: datasourceId || null, sql, filters, variables: params() }, format, `${base}.${format}`);
      toast("The file is downloading", "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Export failed", "error"); }
    finally { setExporting(null); }
  }

  async function run() {
    if (!sql.trim()) return;
    setRunning(true);
    try {
      const res = await api.repoExecute({ datasourceId: datasourceId || null, sql, source: "sqleditor", variables: params() });
      setResult(res); setOffset(0); setColFilters({});
      toast(res.kind === "select" ? `${res.rowCount} row${res.rowCount === 1 ? "" : "s"}` : `${res.affected} row(s) affected`, "ok");
    } catch (e) { setResult(null); toast(e instanceof Error ? e.message : "SQL failed to run", "error"); }
    finally { setRunning(false); }
  }

  return (
    <div className={styles.wrap}>
      {/* Toolbar, in the order people use it: what is being edited → which database → actions.
          The open script's name sits at the left with an unsaved-changes marker; the target database
          is next to Run; there is a single Save button, with "Save as new" beside it. */}
      <div className={styles.bar}>
        <Code size={16} style={{ fill: "var(--cds-icon-secondary)", flex: "none" }} />
        <span className={`cds--type-heading-compact-01 ${styles.name}`} title={loadedName ?? "New script, not saved yet"}>
          {loadedName ?? "New script"}
        </span>
        {dirty && <Tag size="sm" type="warm-gray" title="Unsaved changes">Unsaved</Tag>}

        {/* Target database — next to Run because it decides where Run goes */}
        <div className={styles.ds}>
          <Select value={datasourceId} placeholder="Choose connection" compact prefix="Database" onChange={onDatasource}
                  options={datasources.map((d) => ({ value: d.id, label: d.name, sub: d.engine || undefined }))} />
        </div>

        <Button kind="primary" size="sm" renderIcon={Play} disabled={running} onClick={run} title="Run this statement (Ctrl/Cmd + Enter)">
          {running ? "Running…" : "Run"}
        </Button>

        <span className={styles.grow} />

        {/* Single Save button — with a saved script open it overwrites that script;
            otherwise it asks for a name. "Save as new" is the icon button next to it. */}
        <Button kind="secondary" size="sm" renderIcon={Save} disabled={!dirty && openedId != null}
                onClick={() => (openedId == null ? (setName(loadedName ?? ""), setShowSave(true)) : updateProgram())}
                title={openedId == null ? "Save this script for later" : `Overwrite "${loadedName}"`}>
          Save
        </Button>
        {openedId != null && (
          <IconButton kind="ghost" size="sm" label="Save as new" align="bottom"
                      onClick={() => { setName((loadedName ?? "") + " (copy)"); setShowSave(true); }}>
            <Copy />
          </IconButton>
        )}
        <Button kind="ghost" size="sm" renderIcon={RecentlyViewed} onClick={openHistory} title="My run history">
          History
        </Button>
      </div>

      {varNames.length > 0 && (
        <div className={styles.vars}>
          {varNames.map((n) => (
            <TextInput key={n} id={`${uid}-var-${n}`} size="sm" labelText={n} className="rh-mono" value={vars[n] ?? ""}
                       onChange={(e) => setVars((v) => ({ ...v, [n]: e.target.value }))} />
          ))}
        </div>
      )}
      {/* The editor takes the height it was dragged to and the rest goes to results, avoiding
          empty space on tall screens and nested scrollbars on short ones. */}
      <div className={styles.ed} style={{ height: editorH }}>
        <SqlBox value={sql} onChange={setSql} height={editorH}
                placeholder="SELECT / INSERT / UPDATE / DELETE / MERGE" />
      </div>
      <div className={styles.grip} title="Drag to resize"
           onMouseDown={(e) => { drag.current = { y: e.clientY, h: editorH }; document.body.style.userSelect = "none"; }}>
        <span />
      </div>

      {/* Run history — clicking Reuse loads its SQL back into the editor */}
      {histOpen && (
        <Modal title="My run history" onClose={() => setHistOpen(false)} width={820}
               foot={<Button kind="secondary" onClick={() => setHistOpen(false)}>Close</Button>}>
          {hist === null && <DataTableSkeleton showHeader={false} showToolbar={false} columnCount={6} rowCount={4} />}
          {hist && hist.length === 0 && <p className="cds--type-body-01 rh-dim" style={{ padding: "var(--cds-spacing-06) 0" }}>No history yet</p>}
          {hist && hist.length > 0 && (
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              <Table size="sm">
                <TableHead><TableRow>
                  <TableHeader>When</TableHeader><TableHeader>Kind</TableHeader><TableHeader>Statement</TableHeader>
                  <TableHeader className={styles.num}>Rows</TableHeader><TableHeader className={styles.num}>Time</TableHeader>
                  <TableHeader>Result</TableHeader><TableHeader aria-label="Actions" />
                </TableRow></TableHead>
                <TableBody>
                  {hist.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell style={{ whiteSpace: "nowrap" }}>{localTime(h.createdAt)}</TableCell>
                      <TableCell>{h.kind}</TableCell>
                      <TableCell><span className={`cds--type-code-01 ${styles.histSql}`} title={h.sql}>{h.sql}</span></TableCell>
                      <TableCell className={styles.num}>
                        {h.rowCount ?? (h.affected != null && h.affected >= 0 ? h.affected : "—")}</TableCell>
                      <TableCell className={styles.num}>{h.ms} ms</TableCell>
                      <TableCell title={h.error ?? ""}>
                        <Tag size="sm" type={h.status === "ok" ? "green" : "red"}>{h.status === "ok" ? "ok" : "failed"}</Tag>
                      </TableCell>
                      <TableCell>
                        <Button kind="ghost" size="sm" renderIcon={Edit} title="Load this statement back into the editor"
                                onClick={() => { setSql(h.sql); setHistOpen(false); toast("Loaded back into the editor", "ok"); }}>
                          Reuse
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Modal>
      )}

      {showSave && (
        <Modal title="Save this SQL for later" onClose={() => setShowSave(false)} width={520}
               foot={<>
                 <Button kind="secondary" onClick={() => setShowSave(false)}>Cancel</Button>
                 <Button kind="primary" renderIcon={Checkmark} onClick={saveProgram}>Save</Button>
               </>}>
          <div style={{ marginBottom: "var(--cds-spacing-05)" }}>
            <TextInput id={`${uid}-name`} labelText="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                       placeholder="e.g. Duplicate items, FY2026" />
          </div>
          <SaveDestination workspaceId={workspaceId} setWorkspaceId={setWorkspaceId}
                           folder={folder} setFolder={setFolder} folders={saved.map((v) => v.folder ?? "")} />

          {/* Visibility — scripts still being drafted should not show up for other users */}
          <div style={{ marginTop: "var(--cds-spacing-05)" }}>
            <div className="cds--label">Who can see it</div>
            <ContentSwitcher size="md" selectedIndex={isPublic ? 1 : 0}
                             onChange={(e: { index?: number }) => setIsPublic(e.index === 1)}>
              <Switch name="private" text="Only me" />
              <Switch name="public" text="Everyone" />
            </ContentSwitcher>
          </div>
        </Modal>
      )}
      {result && result.kind === "update" && (
        <div className={styles.res}>
          <InlineNotification kind="success" lowContrast hideCloseButton title="Done"
                              subtitle={`${result.affected.toLocaleString("en-US")} row(s) affected`} />
        </div>
      )}
      {result && result.kind === "select" && (
        <div className={styles.res}>
          {/* Result summary bar — export menu shares the row with the row count */}
          <div className={styles.resHead}>
            <span className="cds--type-heading-compact-01">Result</span>
            <span className="cds--type-body-compact-01 rh-dim">
              {anyFilter
                ? `${filteredRows.length.toLocaleString("en-US")} of ${result.rowCount.toLocaleString("en-US")} rows`
                : `${result.rowCount.toLocaleString("en-US")} row${result.rowCount === 1 ? "" : "s"}`} · {result.columns.length} col{result.columns.length === 1 ? "" : "s"}
            </span>
            {anyFilter && (
              <Button kind="ghost" size="sm" renderIcon={Close} title="Clear all column filters" onClick={() => setColFilters({})}>
                Clear filters
              </Button>
            )}
            <span className={styles.grow} />
            {/* Export directly from this screen */}
            <OverflowMenu size="sm" flipped aria-label="Export" iconDescription={exporting ? "Exporting" : "Export"}
                          renderIcon={Download} disabled={!!exporting}>
              <OverflowMenuItem itemText="CSV (.csv)" onClick={() => exportResult("csv")}
                                title={anyFilter ? "Export only rows matching the filters (.csv)" : "Export every row this statement returns as .csv"} />
              <OverflowMenuItem itemText="Excel (.xlsx)" onClick={() => exportResult("xlsx")}
                                title={anyFilter ? "Export only rows matching the filters (.xlsx)" : "Export every row this statement returns as .xlsx"} />
            </OverflowMenu>
          </div>

          {/* Same grid as the Tables screen — sticky header, row numbers continue across pages,
              and NULL shown faded rather than mixed with data */}
          <div className={styles.gridWrap}>
            <Table size="sm" className={styles.grid}>
              <TableHead>
                <TableRow>
                  <TableHeader className={styles.colNo}>#</TableHeader>
                  {result.columns.map((c) => (
                    <TableHeader key={c}>
                      <div className={styles.ghName}>
                        {c}
                        <HeaderFilter label={c} value={colFilters[c] ?? EMPTY_FILTER}
                                      onChange={(v) => setColFilters((cur) => ({ ...cur, [c]: v }))}
                                      options={hfOptionsFor(c)}
                                      optionsNote={hfOptionsFor(c).length > 500 ? "Showing the first 500 values" : undefined} />
                      </div>
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {pageRows.map((r, i) => (
                  <TableRow key={offset + i}>
                    <TableCell className={`${styles.colNo} ${styles.num}`}>{offset + i + 1}</TableCell>
                    {r.map((v, j) => (
                      <TableCell key={j} className={typeof v === "number" ? styles.num : undefined}
                                 title={v === null ? "" : String(v)}>
                        {v === null ? <span className={styles.null}>NULL</span> : String(v)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {filteredRows.length === 0 && (
                  <TableRow><TableCell colSpan={result.columns.length + 1}>
                    <div className={styles.empty}>
                      <TableIcon size={24} style={{ fill: "var(--cds-icon-secondary)" }} />
                      <span className="cds--type-heading-compact-01">
                        {anyFilter ? "No rows match the filters" : "No rows returned"}
                      </span>
                    </div>
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Same pager as the Tables screen · the total is exact because the full result is in hand */}
          {filteredRows.length > 0 && (
            <div className={styles.foot}>
              <Pager offset={offset} pageRows={pageRows.length} total={filteredRows.length} loading={false}
                     pageSize={pageSize}
                     onPageSize={(n) => { setPageSize(n); localStorage.setItem(PAGE_KEY, String(n)); setOffset(0); }}
                     onGo={setOffset} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Variables in the SQL: $NAME (upper-case word after $) and :name (bind style).
 * Ignores text inside quotes and comments, and "::" casts.
 */
export function sqlVariables(sql: string): string[] {
  const clean = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
  const out: string[] = [];
  const re = /(?<![:\w])(\$[A-Za-z_][A-Za-z0-9_]*|:[A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
