"use client";

// Output Files as a folder explorer: report-code folders on the left,
// files of the selected folder on the right, with inline PDF preview.
//
// `?menu=report-check` swaps in the Report Check view: no folder pane, only reports whose
// code starts with REPORT_CHECK_PREFIX, the latest file per report, name and download
// only — no report code. The explorer stays the default so /outputs is unchanged for
// anyone reaching it without the query.
import { copyText } from "@/lib/clipboard";
import { errMsg } from "@/lib/api";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Breadcrumb, BreadcrumbItem, Button, ButtonSet, IconButton, Stack, StructuredListBody, StructuredListCell,
  StructuredListRow, StructuredListWrapper, Tag, TableToolbarSearch, TextInput, Tile, Toggle, TreeNode, TreeView,
} from "@carbon/react";
import {
  Checkmark, Copy, Document, Download, Email, Folder, FolderOpen, Launch, Link as LinkIcon, Renew, Close, Upload, Undo, Grid,
} from "@carbon/icons-react";
import { DataList } from "@/components/DataList";
import { Pager, PAGE_SIZES, DEFAULT_PAGE_SIZE } from "@/components/Pager";
import st from "@/components/R/r.module.scss";
import { AccessButton } from "@/components/AccessPanel";
import { SlideOver } from "@/components/overlays";
import { FmtTag, PageHeader, Skeleton } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api, apiUrl, fetchOutputBlob, shareLink as apiShareLink } from "@/lib/api";
import { timeAgo, localTime } from "@/lib/format";
import { Select } from "@/components/Select";
import { carbonIcon } from "@/components/Icon";
import type { FileHubTarget, OutputFile, OutputShare, OutputTreeRow } from "@/lib/types";
import { usePerms } from "@/lib/perms";
import { usePortalYear } from "@/lib/portal-year";

/** Report-code prefix the Report Check view is scoped to (empty = every report). */
const REPORT_CHECK_PREFIX = process.env.NEXT_PUBLIC_REPORT_CHECK_PREFIX ?? "";
/** Bucket for files whose run never recorded a fiscal year. */
const NO_YEAR = "No year";

/**
 * Run parameter(s) that carry the year a file was produced for — configured per deployment via
 * NEXT_PUBLIC_OUTPUT_YEAR_PARAMS (comma-separated, matched case-insensitively). Empty (default) =
 * every file falls in the "No year" bucket. Names are never guessed.
 */
const YEAR_KEYS = (process.env.NEXT_PUBLIC_OUTPUT_YEAR_PARAMS ?? "")
  .split(",").map((k) => k.trim().toLowerCase().replace(/[\s-]/g, "_")).filter(Boolean);

function yearOf(o: OutputFile): string {
  if (!o.params) return NO_YEAR;
  try {
    const p = JSON.parse(o.params) as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) {
      if (!YEAR_KEYS.includes(k.toLowerCase().replace(/[\s-]/g, "_"))) continue;
      const s = v == null ? "" : String(v).trim();
      if (s) return s;
    }
    return NO_YEAR;
  } catch {
    return NO_YEAR;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function OutputsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <OutputsRouter />
    </Suspense>
  );
}

function OutputsRouter() {
  const search = useSearchParams();
  return search.get("menu") === "report-check" ? <ReportCheckScreen /> : <OutputExplorer />;
}

/**
 * Newest file per report within the portal's year (files with no recorded year always kept).
 *
 * Shared by the list and by the checked/total counters so the counters describe the same
 * population the reviewer is looking at — counting over all files instead would report
 * progress against rows that are not on screen.
 */
function latestAll(scoped: OutputFile[], year: string): OutputFile[] {
  const byReport = new Map<string, OutputFile>();
  scoped
    .filter((o) => { const y = yearOf(o); return !year || y === year || y === NO_YEAR; })
    .forEach((o) => {
      const cur = byReport.get(o.reportCode);
      if (!cur || o.createdAt > cur.createdAt) byReport.set(o.reportCode, o);
    });
  return [...byReport.values()];
}

/**
 * Report Check — one row per in-scope report showing its newest rendered file, scoped to the
 * fiscal year the portal is set to.
 *
 * A file's year comes from its run parameters, and many runs never recorded one. Hiding those
 * would leave an almost empty screen, so a file whose year is unknown is kept and labelled
 * "No year" — only a file known to belong to a *different* year is filtered out. Filtering
 * fully by year requires the run itself to record the year.
 */
function ReportCheckScreen() {
  const toast = useToast();
  const [rows, setRows] = useState<OutputFile[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<OutputFile | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [onlyUnchecked, setOnlyUnchecked] = useState(false);
  const year = usePortalYear();

  useEffect(() => {
    api.outputs().then(setRows).catch((e) => toast(errMsg(e, "Load failed"), "error"));
  }, [toast]);

  /**
   * Confirm / withdraw the reviewer's sign-off on one rendered file
   *
   * The row is patched from the server's answer rather than re-fetching the whole list: a
   * re-fetch would also pull in files rendered since the screen opened and quietly move rows
   * under the reviewer's cursor mid-review.
   */
  const toggleConfirm = async (o: OutputFile) => {
    setBusyKey(o.objectKey);
    try {
      if (o.review) {
        await api.unconfirmOutput(o.objectKey);
        setRows((prev) => prev.map((r) => (r.objectKey === o.objectKey ? { ...r, review: null } : r)));
        toast("Confirmation withdrawn", "ok");
      } else {
        const review = await api.confirmOutput(o.objectKey);
        setRows((prev) => prev.map((r) => (r.objectKey === o.objectKey ? { ...r, review } : r)));
        toast("Marked as checked", "ok");
      }
    } catch (e) {
      toast(errMsg(e, "Could not save"), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const scoped = useMemo(
    () => rows.filter((o) => o.reportCode?.startsWith(REPORT_CHECK_PREFIX)),
    [rows],
  );

  // Newest file per report, within the portal's year (unknown-year files always kept).
  const latest = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return latestAll(scoped, year)
      .filter((o) => !needle || (o.reportName ?? "").toLowerCase().includes(needle))
      .filter((o) => !onlyUnchecked || !o.review)
      .sort((a, b) => (a.reportName ?? "").localeCompare(b.reportName ?? ""));
  }, [scoped, year, q, onlyUnchecked]);

  const checkedCount = useMemo(() => latestAll(scoped, year).filter((o) => o.review).length, [scoped, year]);
  const totalCount = useMemo(() => latestAll(scoped, year).length, [scoped, year]);

  return (
    <div className="fade-in">
      <PageHeader title="Report Check" sub={`The latest rendered file for each report${year ? ` · fiscal year ${year}` : ""}`} />

      <DataList<OutputFile & { id: string }>
        rows={latest.map((o) => ({ ...o, id: o.objectKey }))}
        search={false}
        pageSize={50}
        /* Counters sit next to the search box, where the numbers change with the filters. */
        description={`${latest.length} ${latest.length === 1 ? "report" : "reports"} · ${checkedCount} of ${totalCount} checked`}
        empty="No reports match these filters"
        onRowClick={(o) => setSel(o)}
        toolbar={<>
          <TableToolbarSearch persistent placeholder="Search report name…" value={q}
                              onChange={(e) => setQ(typeof e === "string" ? e : (e.target as HTMLInputElement).value)} />
          <div style={{ display: "flex", alignItems: "center", padding: "0 var(--cds-spacing-05)" }}>
            <Toggle id="rc-unchecked" size="sm" labelText="Unchecked only" hideLabel labelA="Unchecked only" labelB="Unchecked only"
                    toggled={onlyUnchecked} onToggle={(v) => setOnlyUnchecked(v)} />
          </div>
        </>}
        columns={[
          { key: "reportName", header: "Report", render: (o) => (
            <div>
              <div>{o.reportName ?? <span className="rh-dim">{o.reportCode ? `${o.reportCode} · report removed` : "Export without a report"}</span>}</div>
              {o.review && (
                <div className="cds--type-helper-text-01" style={{ color: "var(--cds-support-success)" }}>
                  Checked by {o.review.confirmedBy} {timeAgo(o.review.confirmedAt)}
                </div>
              )}
            </div>
          ) },
          { key: "year", header: "Year", sortValue: (o) => yearOf(o), render: (o) => { const y = yearOf(o); return y === NO_YEAR ? <span className="rh-dim">{y}</span> : y; } },
          { key: "fmt", header: "Format", render: (o) => <FmtTag f={o.fmt} /> },
          { key: "sizeBytes", header: "Size", align: "end", render: (o) => <span className="cds--type-code-01">{fmtBytes(o.sizeBytes)}</span> },
          { key: "createdAt", header: "Created", render: (o) => <span className="rh-dim">{timeAgo(o.createdAt)}</span> },
        ]}
        rowActions={(o) => (
          <>
            <Button kind={o.review ? "ghost" : "primary"} size="sm" renderIcon={o.review ? Undo : Checkmark}
                    disabled={busyKey === o.objectKey}
                    title={o.review ? "Withdraw this confirmation" : "Confirm you have checked this file"}
                    onClick={() => toggleConfirm(o)}>
              {o.review ? "Undo" : "Confirm"}
            </Button>
            <IconButton kind="ghost" size="sm" align="left" label="Download" onClick={() => api.downloadOutput(o.objectKey, o.objectKey.split("/").pop() || o.objectKey)}><Download /></IconButton>
          </>
        )}
      />

      {sel && <FilePreview file={sel} onClose={() => setSel(null)}
                           onShareChanged={(sh) => {
                             // Patch the open file and its table row instead of reloading the whole list
                             setSel((c) => (c ? { ...c, share: sh } : c));
                             setRows((rs) => rs.map((r) => (r.objectKey === sel.objectKey ? { ...r, share: sh } : r)));
                           }} />}
    </div>
  );
}

/** Bucket for files whose report no longer has a category — still shown, never hidden. */
const NO_CATEGORY = "Uncategorized";

/** Rows per page of the file table. */

/** One report in the tree = second-level folder. */
type ReportNode = { code: string; name: string; files: number; size: number; latest: string };
/** One report category = first-level folder. */
type CatNode = { name: string; reports: ReportNode[]; count: number; size: number };

/**
 * Category → report tree built from server-side aggregates (/outputs/tree), so the screen
 * never pulls every file just to draw folders; the file table pages through /outputs/page.
 */
function buildTree(rows: OutputTreeRow[]): CatNode[] {
  const cats = new Map<string, ReportNode[]>();
  for (const r of rows) {
    const cat = r.categoryName ?? NO_CATEGORY;
    const list = cats.get(cat) ?? [];
    list.push({ code: r.reportCode, name: r.reportName ?? r.reportCode, files: r.files, size: r.sizeBytes, latest: r.latestAt });
    cats.set(cat, list);
  }
  return [...cats.entries()]
    .map(([name, reports]) => ({
      name,
      reports: [...reports].sort((a, b) => a.name.localeCompare(b.name)),
      count: reports.reduce((n, r) => n + r.files, 0),
      size: reports.reduce((n, r) => n + r.size, 0),
    }))
    // Uncategorized always last; the rest by name
    .sort((a, b) => (a.name === NO_CATEGORY ? 1 : b.name === NO_CATEGORY ? -1 : a.name.localeCompare(b.name)));
}

function OutputExplorer() {
  const toast = useToast();
  const perms = usePerms();
  const [tree, setTree] = useState<CatNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  /** Selected folder — [category] or [category, report code]; empty = root. */
  const [path, setPath] = useState<string[]>([]);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<OutputFile | null>(null);
  const [files, setFiles] = useState<OutputFile[]>([]);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(true);
  // FileHub publishing: targets (enabled FileHub connectors), chosen target and the rows ticked for bulk
  const [fhTargets, setFhTargets] = useState<FileHubTarget[]>([]);
  const [fhTarget, setFhTarget] = useState("");
  const [publishing, setPublishing] = useState(false);
  const canPublish = fhTargets.length > 0 && perms.can("RH.OUTPUT", "execute");
  useEffect(() => {
    api.fileHubTargets().then((t) => { setFhTargets(t); setFhTarget((c) => c || t[0]?.id || ""); }).catch(() => {});
  }, []);
  async function publish(keys: string[]) {
    if (!keys.length) return;
    setPublishing(true);
    try {
      const res = await api.publishOutputsToFileHub(keys, fhTarget || undefined);
      const okRows = new Map(res.filter((r) => r.ok && r.filehub).map((r) => [r.objectKey, r.filehub]));
      setFiles((rs) => rs.map((r) => (okRows.has(r.objectKey) ? { ...r, filehub: okRows.get(r.objectKey) } : r)));
      const failed = res.filter((r) => !r.ok);
      if (failed.length) toast(`${okRows.size} published · ${failed.length} failed: ${failed[0].error ?? ""}`, "error");
      else toast(`Published ${okRows.size} file${okRows.size === 1 ? "" : "s"} to FileHub`, "ok");
    } catch (e) {
      toast(errMsg(e, "Publish failed"), "error");
    } finally {
      setPublishing(false);
    }
  }

  useEffect(() => {
    setLoadingTree(true);
    api.outputsTree()
      .then((rows) => setTree(buildTree(rows)))
      .catch((e) => toast(errMsg(e, "Load failed"), "error"))
      .finally(() => setLoadingTree(false));
  }, [toast]);

  const [catSel, codeSel] = [path[0], path[1]];
  const cat = useMemo(() => tree.find((c) => c.name === catSel), [tree, catSel]);
  const report = useMemo(() => cat?.reports.find((r) => r.code === codeSel), [cat, codeSel]);

  /**
   * Report codes the file table asks for: a report = that one; a category = every report in it
   * (categories live in the registry, not the file table, so the screen sends the codes);
   * root = no limit.
   */
  const scopeCodes = useMemo(() => {
    if (report) return report.code;
    if (cat) return cat.reports.map((r) => r.code).join(",");
    return "";
  }, [cat, report]);

  // Search always covers every file, not just the open folder
  const needle = q.trim();
  useEffect(() => { setOffset(0); }, [scopeCodes, needle]);

  useEffect(() => {
    let live = true;
    setLoadingFiles(true);
    const t = setTimeout(() => {
      api.outputsPage({ report: needle ? undefined : scopeCodes, q: needle || undefined, limit: pageSize, offset })
        .then((p) => { if (!live) return; setFiles(p.items); setTotal(p.total); })
        .catch((e) => { if (live) toast(errMsg(e, "Load failed"), "error"); })
        .finally(() => { if (live) setLoadingFiles(false); });
    }, needle ? 250 : 0);                      // debounce typing
    return () => { live = false; clearTimeout(t); };
  }, [scopeCodes, needle, offset, pageSize, toast]);

  const totalFiles = tree.reduce((n, c) => n + c.count, 0);
  const totalSize = tree.reduce((n, c) => n + c.size, 0);

  const treeSel = codeSel ? `r:${catSel}|${codeSel}` : catSel ? `c:${catSel}` : "all";
  return (
    <div className="fade-in">
      <PageHeader title="Output Files"
                  actions={<Tag type="outline" size="md" renderIcon={carbonIcon("store")}>{totalFiles} files · {fmtBytes(totalSize)}</Tag>} />

      <div className={st.explorer}>
        {/* Left pane: categories, then reports. Click a category to expand/collapse and list
            its files; click a report to list only its files on the right. */}
        <Tile className={st.treePane}>
          <h2 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-03)" }}>Folders</h2>
          {loadingTree ? <Skeleton /> : (
            <TreeView key={treeSel} label="Folders" hideLabel size="sm" selected={[treeSel]} active={treeSel}>
              <TreeNode id="all" renderIcon={Grid}
                        label={<span className={st.treeLabel}><span>All files</span><span className={st.treeCount}>{totalFiles}</span></span>}
                        onSelect={() => setPath([])} />
              {tree.map((c) => {
                // While searching, expand every category so matches are not hidden
                const open = q.trim() ? true : opened.has(c.name);
                const toggle = () => setOpened((cur) => { const n = new Set(cur); if (n.has(c.name)) n.delete(c.name); else n.add(c.name); return n; });
                return (
                  <TreeNode key={c.name} id={`c:${c.name}`} isExpanded={open} renderIcon={open ? FolderOpen : Folder}
                            title={`${c.name} · ${c.reports.length} report${c.reports.length === 1 ? "" : "s"} · ${c.count} file${c.count === 1 ? "" : "s"}`}
                            label={<span className={st.treeLabel}><span className="rh-ellipsis">{c.name}</span><span className={st.treeCount}>{c.count}</span></span>}
                            // Select the category and toggle it; other open categories stay open for comparison
                            onSelect={() => { setPath([c.name]); toggle(); }}
                            onToggle={() => toggle()}>
                    {c.reports.length > 0 ? c.reports.map((r) => (
                      <TreeNode key={r.code} id={`r:${c.name}|${r.code}`} renderIcon={Document}
                                title={`${r.name}\n${r.code} · ${r.files} file${r.files === 1 ? "" : "s"} · ${fmtBytes(r.size)}`}
                                label={<span className={st.treeLabel}><span className="rh-ellipsis">{r.name}</span><span className={st.treeCount}>{r.files}</span></span>}
                                onSelect={() => setPath([c.name, r.code])} />
                    )) : undefined}
                  </TreeNode>
                );
              })}
            </TreeView>
          )}
          {!loadingTree && tree.length === 0 && <p className="cds--type-body-compact-01 rh-dim">No outputs you can access</p>}
        </Tile>

        <div style={{ minWidth: 0 }}>
          <div className={st.filters} style={{ marginBottom: "var(--cds-spacing-03)" }}>
            <Breadcrumb noTrailingSlash aria-label="Folder">
              <BreadcrumbItem href="#" isCurrentPage={!path.length} onClick={(e: React.MouseEvent) => { e.preventDefault(); setPath([]); }}>Outputs</BreadcrumbItem>
              {cat && <BreadcrumbItem href="#" isCurrentPage={!report} onClick={(e: React.MouseEvent) => { e.preventDefault(); setPath([cat.name]); }}>{cat.name}</BreadcrumbItem>}
              {report && <BreadcrumbItem isCurrentPage>{report.name} <span className="cds--type-code-01 rh-dim">&nbsp;{report.code}</span></BreadcrumbItem>}
            </Breadcrumb>
          </div>
          <DataList<OutputFile & { id: string }>
            rows={files.map((o) => ({ ...o, id: o.objectKey }))}
            loading={loadingFiles && files.length === 0}
            search={false}
            pagination={false}
            empty={q ? "No files matching the search" : "No outputs you can access"}
            onRowClick={(o) => setSel(o)}
            batchActions={canPublish ? [{ label: "Publish to FileHub", icon: Upload, onClick: (sel) => publish(sel.map((o) => o.objectKey)) }] : undefined}
            toolbar={<>
              <TableToolbarSearch persistent placeholder="Search files or report name…" value={q}
                                  onChange={(e) => setQ(typeof e === "string" ? e : (e.target as HTMLInputElement).value)} />
              {canPublish && fhTargets.length > 1 && (
                <Select prefix="FileHub:" size="lg" value={fhTarget} onChange={setFhTarget} options={fhTargets.map((t) => ({ value: t.id, label: t.name }))} />
              )}
            </>}
            columns={[
              { key: "objectKey", header: "File", render: (o) => (
                <div style={{ minWidth: 0 }}>
                  <span className="cds--type-code-01 rh-ellipsis" style={{ display: "block", maxWidth: 240 }} title={o.objectKey}>{q ? o.objectKey : o.objectKey.split("/").pop()}</span>
                  {q && o.categoryName && <div className="cds--type-helper-text-01 rh-dim">{o.categoryName}</div>}
                  {o.filehub && <Tag size="sm" type="blue" renderIcon={Launch} as="a" href={o.filehub.url} target="_blank" rel="noreferrer"
                    title={`FileHub file ${o.filehub.fileId}`} onClick={(e: React.MouseEvent) => e.stopPropagation()}>FileHub</Tag>}
                </div>
              ) },
              { key: "fmt", header: "Format", render: (o) => <FmtTag f={o.fmt} /> },
              { key: "sizeBytes", header: "Size", align: "end", render: (o) => <span className="cds--type-code-01">{fmtBytes(o.sizeBytes)}</span> },
              { key: "createdBy", header: "By", render: (o) => o.createdBy ?? "—" },
              { key: "createdAt", header: "Created", render: (o) => <span className="rh-dim">{timeAgo(o.createdAt)}</span> },
            ]}
            rowActions={(o) => (
              <>
                {/* Link icon marks a shared file right in the table */}
                {o.share && (
                  <IconButton kind="ghost" size="sm" align="left" label={`Shared · opened ${o.share.hits} times`} onClick={() => setSel(o)}>
                    <LinkIcon style={{ fill: "var(--cds-link-primary)" }} />
                  </IconButton>
                )}
                <IconButton kind="ghost" size="sm" align="left" label="Download" onClick={() => api.downloadOutput(o.objectKey, o.objectKey.split("/").pop() || o.objectKey)}><Download /></IconButton>
                {canPublish && <IconButton kind="ghost" size="sm" align="left" label={o.filehub ? "Publish to FileHub again" : "Publish to FileHub"} disabled={publishing}
                  onClick={() => publish([o.objectKey])}><Upload /></IconButton>}
              </>
            )}
          />
          {/* Server paging — the table loads one page of rows at a time */}
          {total > PAGE_SIZES[0] && (
            <Pager offset={offset} pageRows={files.length} total={total} loading={loadingFiles} pageSize={pageSize}
                   onPageSize={(n) => { setPageSize(n); setOffset(0); }} onGo={setOffset} />
          )}
        </div>
      </div>

      {sel && <FilePreview file={sel} onClose={() => setSel(null)}
                           onShareChanged={(sh) => {
                             // Patch the open file and its table row instead of reloading the whole list
                             setSel((c) => (c ? { ...c, share: sh } : c));
                             setFiles((rs) => rs.map((r) => (r.objectKey === sel.objectKey ? { ...r, share: sh } : r)));
                           }} />}
    </div>
  );
}

/**
 * Share panel — creates a link that opens without signing in.
 *
 * The link (a random 32-byte token) is the only thing protecting the file, so anyone holding it
 * can open it; the panel therefore shows who shared it, when it expires, and how often it was
 * opened. "New link" invalidates the old one immediately — the way to rotate a leaked link.
 */
function SharePanel({ file, onChanged }: { file: OutputFile; onChanged: (s: OutputShare | null) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState<string>("7");
  /** Email box — shown only after clicking the button. */
  const [mailOpen, setMailOpen] = useState(false);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const share = file.share;

  async function sendMail() {
    setBusy(true);
    try {
      const res = await api.emailOutputShare(file.objectKey, { to: to.trim(), note: note.trim() || undefined });
      // Sending may have created the first link — refresh this file's share state (one report's page only)
      const page = await api.outputsPage({ report: file.reportCode, limit: 500 });
      const fresh = page.items.find((r) => r.objectKey === file.objectKey);
      onChanged(fresh?.share ?? null);
      setMailOpen(false); setTo(""); setNote("");
      toast(res.notifiedOnScreen > 0
        ? `Email sent to ${res.to} · ${res.notifiedOnScreen} in-app notification(s)`
        : `Email sent to ${res.to}`, "ok");
    } catch (e) { toast(errMsg(e, "Could not send email"), "error"); }
    finally { setBusy(false); }
  }
  const fullUrl = share ? shareLink(share) : "";

  async function makeLink() {
    setBusy(true);
    try {
      const n = days === "0" ? null : Number(days);
      const s = await api.shareOutput(file.objectKey, n);
      onChanged(s);
      toast(await copyText(shareLink(s)) ? "Link created and copied" : "Link created", "ok");
    } catch (e) { toast(errMsg(e, "Could not create link"), "error"); }
    finally { setBusy(false); }
  }

  async function revoke() {
    setBusy(true);
    try { await api.unshareOutput(file.objectKey); onChanged(null); toast("Sharing stopped — the old link no longer works", "ok"); }
    catch (e) { toast(errMsg(e, "Could not stop sharing"), "error"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: "var(--cds-spacing-05)", paddingTop: "var(--cds-spacing-05)", borderTop: "1px solid var(--cds-border-subtle-01)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--cds-spacing-03)", marginBottom: "var(--cds-spacing-04)" }}>
        <h3 className="cds--type-heading-compact-01">Share this file</h3>
        <span className="cds--type-helper-text-01 rh-dim">opens without signing in</span>
      </div>

      {/* Email the link — sent on demand by the user, never automatically after a render */}
      {mailOpen ? (
        <Tile style={{ marginBottom: "var(--cds-spacing-05)" }}>
          <Stack gap={4}>
            <TextInput id="sh-to" labelText="Email the link" helperText="Separate several with , or ;" placeholder="alice@example.com, bob@example.com"
                       value={to} onChange={(e) => setTo(e.target.value)} />
            <TextInput id="sh-note" labelText="Message to recipients (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            {!share && (
              <p className="cds--type-helper-text-01 rh-dim">
                Not shared yet — sending creates a link (valid 30 days). Users also get an in-app notification.
              </p>
            )}
            <div style={{ display: "flex" }}>
              <Button kind="primary" size="sm" renderIcon={Email} disabled={busy || !to.trim()} onClick={sendMail}>Send email</Button>
              <Button kind="ghost" size="sm" disabled={busy} onClick={() => setMailOpen(false)}>Cancel</Button>
            </div>
          </Stack>
        </Tile>
      ) : (
        <Button kind="tertiary" size="sm" renderIcon={Email} style={{ marginBottom: "var(--cds-spacing-05)" }} onClick={() => setMailOpen(true)}>Email the link</Button>
      )}

      {share ? (
        <>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextInput id="sh-url" labelText="Share link" hideLabel className="rh-mono" readOnly value={fullUrl} onFocus={(e) => e.currentTarget.select()} />
            </div>
            <IconButton kind="ghost" label="Copy link" align="left" disabled={busy}
                        onClick={() => { navigator.clipboard.writeText(fullUrl).then(() => toast("Copied", "ok"), () => toast("Could not copy", "error")); }}>
              <Copy />
            </IconButton>
          </div>
          <p className="cds--type-helper-text-01 rh-dim" style={{ marginTop: "var(--cds-spacing-03)" }}>
            {share.expiresAt
              ? <>Expires <b>{localTime(share.expiresAt)}</b></>
              : <>Never expires</>}
            {" · "}opened <b>{share.hits}</b> times
            {share.sharedBy && <> · shared by {share.sharedBy}</>}
          </p>
          <div style={{ display: "flex", marginTop: "var(--cds-spacing-03)" }}>
            <Button kind="tertiary" size="sm" renderIcon={Renew} disabled={busy} onClick={makeLink}>New link</Button>
            <Button kind="danger--ghost" size="sm" renderIcon={Close} disabled={busy} onClick={revoke}>Stop sharing</Button>
          </div>
        </>
      ) : (
        <div style={{ display: "flex", gap: "var(--cds-spacing-03)", alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ width: 190 }}>
            <Select value={days} onChange={setDays} compact
                    options={[{ value: "1", label: "Expires in 1 day" }, { value: "7", label: "Expires in 7 days" },
                              { value: "30", label: "Expires in 30 days" }, { value: "0", label: "Never expires" }]} />
          </div>
          <Button kind="primary" size="sm" renderIcon={LinkIcon} disabled={busy} onClick={makeLink}>Create share link</Button>
        </div>
      )}
    </div>
  );
}

function FilePreview({ file, onClose, onShareChanged }: {
  file: OutputFile; onClose: () => void;
  /** Push share state back to the list so the table icon stays current after closing. */
  onShareChanged: (s: OutputShare | null) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    if (file.fmt === "PDF") {
      fetchOutputBlob(file.objectKey).then((b) => { revoke = URL.createObjectURL(b); setUrl(revoke); }).catch(() => {});
    }
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [file]);

  return (
    <SlideOver
      title={file.objectKey}
      sub={`${file.reportCode} · ${file.jobId ?? ""}`}
      badge={<FmtTag f={file.fmt} />}
      onClose={onClose}
      foot={
        <ButtonSet className="rh-foot-set">
          <Button kind="secondary" onClick={onClose}>Close</Button>
          <Button kind="primary" renderIcon={Download} onClick={() => api.downloadOutput(file.objectKey, file.objectKey.split("/").pop() || file.objectKey)}>Download {file.fmt}</Button>
        </ButtonSet>
      }
    >
      {file.reportCode && (
        <div style={{ margin: "calc(-1 * var(--cds-spacing-03)) 0 var(--cds-spacing-03) calc(-1 * var(--cds-spacing-05))" }}>
          <AccessButton type="OUTPUT" id={file.reportCode} name={`Outputs of ${file.reportCode}`} ghost />
        </div>
      )}
      <StructuredListWrapper isCondensed className="rh-slist" aria-label="File">
        <StructuredListBody>
          <StructuredListRow><StructuredListCell noWrap className="rh-dim">Size</StructuredListCell><StructuredListCell className="cds--type-code-01">{fmtBytes(file.sizeBytes)}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap className="rh-dim">Created by</StructuredListCell><StructuredListCell>{file.createdBy ?? "—"}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap className="rh-dim">Created</StructuredListCell><StructuredListCell>{localTime(file.createdAt, true)}</StructuredListCell></StructuredListRow>
          {(() => {
            if (!file.params) return null;
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(file.params); } catch { return null; }
            const entries = Object.entries(parsed);
            if (entries.length === 0) return null;
            return (
              <StructuredListRow>
                <StructuredListCell noWrap className="rh-dim">Parameters</StructuredListCell>
                <StructuredListCell>{entries.map(([k, v]) => (
                  <div key={k} className="cds--type-code-01">{k} = {String(v)}</div>
                ))}</StructuredListCell>
              </StructuredListRow>
            );
          })()}
        </StructuredListBody>
      </StructuredListWrapper>
      <SharePanel file={file} onChanged={onShareChanged} />
      <div style={{ marginTop: "var(--cds-spacing-06)" }}>
        {file.fmt === "PDF" ? (
          url
            ? <iframe title="preview" src={url} style={{ width: "100%", height: 560, border: "1px solid var(--cds-border-subtle-01)", background: "#525659" }} />
            : <Skeleton />
        ) : (
          <Tile style={{ textAlign: "center", padding: "var(--cds-spacing-07)" }}>
            <Document size={32} style={{ fill: "var(--cds-icon-secondary)", marginBottom: "var(--cds-spacing-03)" }} />
            <div className="cds--type-body-compact-01 rh-dim">Download to open this {file.fmt} file</div>
          </Tile>
        )}
      </div>
    </SlideOver>
  );
}

/** Public share link: the server's absolute `url`, else API base + `path`. */
const shareLink = apiShareLink;
