"use client";
import { PageHeader, Skeleton, TableSkeleton } from "@/components/ui";
import styles from "./checks.module.scss";
import {
  Button, Checkbox, CodeSnippet, ContentSwitcher, IconButton, InlineNotification, Search, Switch, Tag, TextArea, TextInput, Tile, Toggle,
  StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper,
  Table, TableBody, TableCell, TableContainer, TableExpandHeader, TableExpandRow, TableExpandedRow, TableHead, TableHeader, TableRow,
  ComboBox, SkeletonText,
} from "@carbon/react";
import {
  Add, Checkmark, CheckmarkFilled, Close, Download, Edit, Flash, Folder, FolderAdd, Pause, Play, Renew, TrashCan, View, WarningAltFilled,
} from "@carbon/icons-react";
import { localTime } from "@/lib/format";

// Data checks.
// A check is a SELECT that returns the rows that are WRONG — zero rows means pass. Writing the
// rule as "what must never appear" is what lets this screen show pass/fail without knowing the
// rule, and show the offending rows straight from the same query when it fails.
import { usePerms } from "@/lib/perms";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select } from "@/components/Select";
import { SqlEditor } from "@/components/SqlEditor";
import { useToast } from "@/components/Toast";
import { OpsEmpty, OpsPanel } from "@/components/OpsPanel";
import { Modal } from "@/components/overlays";
import { Pager, DEFAULT_PAGE_SIZE } from "@/components/Pager";
import { HeaderFilter, EMPTY_FILTER, isFilterOn, type ColFilterValue } from "@/components/HeaderFilter";
import { api } from "@/lib/api";
import { usePortalYear } from "@/lib/portal-year";
import type { CheckFinding, CheckGroupSource, CheckRound, DataCheck, DataCheckRun, Datasource, SaveCheckInput, ScopeAdoptResult, TableResult } from "@/lib/types";

const CRON_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Manual only (no schedule)" },
  { value: "0 0 * * * *", label: "Every hour" },
  { value: "0 0 6 * * *", label: "Daily at 06:00" },
  { value: "0 0 2 * * *", label: "Daily at 02:00" },
  { value: "0 0 7 * * MON", label: "Every Monday at 07:00" },
];

const NAV_KEY = "rs.checks.navOpen";

const STATUS: Record<string, [string, string]> = {
  pass: ["var(--cds-text-primary)", "Pass"],
  fail: ["var(--cds-text-error)", "Fail"],
  error: ["var(--cds-text-error)", "Error"],
  running: ["var(--cds-text-secondary)", "Running"],
};
const STATUS_TAG: Record<string, "green" | "red" | "gray" | "blue"> = { pass: "green", fail: "red", error: "red", running: "blue" };

/** A run result as a Carbon Tag; "never run" / "not in this round" read as a quiet gray tag. */
function ResultTag({ status, fallback }: { status: string | null | undefined; fallback: string }) {
  const text = STATUS[status ?? ""]?.[1] ?? (status || fallback);
  return <Tag size="sm" type={STATUS_TAG[status ?? ""] ?? "gray"}>{text}</Tag>;
}

/** Plain result grid (columns + rows of cells) as a Carbon table. */
function ResultTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <Table size="sm" useZebraStyles={false}>
      <TableHead><TableRow>{columns.map((c) => <TableHeader key={c}>{c}</TableHeader>)}</TableRow></TableHead>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>{r.map((v, j) => <TableCell key={j} className="cds--type-code-01">{v === null ? "—" : String(v)}</TableCell>)}</TableRow>
        ))}
      </TableBody>
    </Table>
  );
}


function fmt(ts: string | null | undefined): string {
  return ts ? localTime(ts) : "—";
}
function ago(ts: string | null | undefined): string {
  if (!ts) return "never run";
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
function dur(a: string, b: string | null): string {
  if (!b) return "";
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function dsLabel(id: string | null, dss: Datasource[]): string {
  return id ? (dss.find((d) => d.id === id)?.name ?? id) : "internal warehouse";
}
function cronLabel(cron: string): string {
  return CRON_PRESETS.find((p) => p.value === cron)?.label ?? cron;
}

export default function ChecksPage() {
  const { can } = usePerms();
  const toast = useToast();
  const [rows, setRows] = useState<DataCheck[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [editing, setEditing] = useState<DataCheck | "new" | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailRows, setDetailRows] = useState(false);
  const [groupSel, setGroupSel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [batching, setBatching] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const portalYear = usePortalYear();

  const [refreshKey, setRefreshKey] = useState(0);
  const reload = useCallback(() => {
    setLoadErr(null);
    api.checks()
      .then((r) => { setRows(r); setRefreshKey((k) => k + 1); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : "Failed to load"));
  }, []);
  useEffect(() => { reload(); api.datasources().then(setDss).catch(() => {}); }, [reload]);

  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => { setNavOpen(localStorage.getItem(NAV_KEY) !== "0"); }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((v) => { localStorage.setItem(NAV_KEY, v ? "0" : "1"); return !v; });
  }, []);



  const detail = detailId == null ? null : rows.find((r) => r.id === detailId) ?? null;

  async function toggle(c: DataCheck) {
    try { await api.toggleCheck(c.id, !c.enabled); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
  }
  // A check that names its own fiscal year means it — the portal's year is only a fallback for
  // checks that leave it blank. Sending the portal year regardless would quietly evaluate a
  const yearFor = (c: DataCheck) => c.fiscalYear?.trim() || portalYear || undefined;

  async function runMany(list: DataCheck[], folder?: string | null) {
    const scope = folder !== undefined
      ? rows.filter((c) => (c.folder ?? "").trim() === (folder ?? "").trim())
      : list;
    const targets = scope.filter((c) => c.enabled && c.lastStatus !== "running");
    if (!targets.length) { toast("Nothing to run — they are paused or already running", "error"); return; }
    setBatching(true);
    let queued: DataCheckRun[];
    try {
      queued = folder !== undefined
        ? await api.runChecksBatch({ folder }, portalYear || undefined)
        : await api.runChecksBatch({ ids: targets.map((c) => c.id) }, portalYear || undefined);
    } catch (e) {
      setBatching(false);
      toast(e instanceof Error ? e.message : "Could not queue the batch", "error");
      return;
    }
    reload();
    if (!queued.length) {
      setBatching(false);
      toast("Nothing was queued — those checks are already running", "error");
      return;
    }
    toast(`Queued ${queued.length} ${queued.length === 1 ? "check" : "checks"} — they run one at a time`, "ok");

    try {
      const ids = new Set(queued.map((r) => r.checkId));
      let miss = 0;
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive.current) return;
        let fresh: DataCheck[];
        try { fresh = await api.checks(); miss = 0; }
        catch {
          if (++miss < 5) continue;
          toast("Lost track of the batch — the checks are still running, reopen this screen later", "error");
          return;
        }
        setRows(fresh);
        const mine = fresh.filter((c) => ids.has(c.id));
        if (!mine.length) { toast("Those checks are no longer on the list", "error"); return; }
        if (mine.some((c) => c.lastStatus === "running")) continue;
        const bad = mine.filter((c) => c.lastStatus !== "pass");
        toast(bad.length === 0
                ? `All ${mine.length} passed`
                : `${bad.length} of ${mine.length} did not pass — ${bad.slice(0, 3).map((c) => c.name).join(", ")}${bad.length > 3 ? "…" : ""}`,
              bad.length === 0 ? "ok" : "error");
        return;
      }
      toast("Still running after 20 minutes — see each check's history", "error");
    } finally {
      setBatching(false);
    }
  }

  // The run starts on a worker and this polls for its verdict — a reverse proxy may time the
  // request out, so a check over millions of rows can never report back on the request itself.
  async function runNow(c: DataCheck) {
    try {
      const started = await api.runCheck(c.id, yearFor(c));
      setDetailRows(false);
      setDetailId(c.id);
      reload();
      if (started.status !== "running") {
        toast(started.status === "pass" ? `Pass · ${started.message}` : `${started.status === "fail" ? "Fail" : "error"} · ${started.message}`,
              started.status === "pass" ? "ok" : "error");
        return;
      }
      toast("Checking…", "ok");
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive.current) return;
        const [last] = await api.checkRuns(c.id, 1);
        if (!last || last.status === "running") continue;
        toast(last.status === "pass" ? `Pass · ${last.message}` : `${last.status === "fail" ? "Fail" : "error"} · ${last.message}`,
              last.status === "pass" ? "ok" : "error");
        reload();
        return;
      }
      toast("This check is taking unusually long — see its run history", "error");
      reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Run failed", "error"); }
  }
  const [confirmDel, setConfirmDel] = useState<DataCheck | null>(null);
  async function remove(c: DataCheck) {
    try { await api.deleteCheck(c.id); toast("Deleted", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }


  const groupList = useMemo(() => {
    const m = new Map<string, DataCheck[]>();
    for (const c of rows) {
      const k = (c.folder ?? "").trim();
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()]
      .map(([name, list]) => ({
        name,
        label: name ? (name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name) : "Ungrouped",
        total: list.length,
        bad: list.filter((c) => c.lastStatus === "fail" || c.lastStatus === "error").length,
        pass: list.filter((c) => c.lastStatus === "pass").length,
        never: list.filter((c) => !c.lastStatus).length,
        text: [name, ...list.map((c) => `${c.name} ${c.description ?? ""}`)].join(" "),
      }))
      .sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : a.name.localeCompare(b.name, "th")));
  }, [rows]);

  const navItems = useMemo(() => groupList.map((g) => {
    const hasBad = g.bad > 0;
    const allPass = g.total > 0 && g.pass === g.total;
    const i = g.name.lastIndexOf("/");
    return {
      id: g.name || "__ungrouped__",
      name: g.label,
      folder: i < 0 ? "" : g.name.slice(0, i),
      icon: hasBad ? "alert" : allPass ? "checkCircle" : "clock",
      search: g.text,
      mark: hasBad ? "var(--cds-support-error)" : allPass ? "var(--cds-support-success)" : "var(--cds-text-placeholder)",
      title: `${g.name || "Ungrouped"} · ${g.total} ${g.total === 1 ? "check" : "checks"}`
             + ` · ${g.pass} passed${g.bad ? ` · ${g.bad} failed` : ""}${g.never ? ` · ${g.never} never run` : ""}`,
    };
  }), [groupList]);

  return (
    <div className="fade-in">
      <PageHeader title="Data Checks" sub="Rules that test your data and flag rows that break them"
        actions={can("RH.CHECK", "create") && (
          <Button renderIcon={Add} onClick={() => { setDetailId(null); setGroupSel(null); setEditing("new"); }}>New check</Button>
        )} />

      {loadErr && <InlineNotification kind="error" title="Could not load checks" subtitle={loadErr} hideCloseButton lowContrast style={{ marginBottom: 16, maxWidth: "none" }} />}

      {confirmDel && (
        <Modal title={`Delete check "${confirmDel.name}"?`} danger width={400} onClose={() => setConfirmDel(null)}
               foot={<>
                 <Button kind="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
                 <Button kind="danger" onClick={() => { const c = confirmDel; setConfirmDel(null); void remove(c); }}>Delete</Button>
               </>}>
          <p className="cds--type-body-01">The check and its run history are removed.</p>
        </Modal>
      )}

      <div className={"rh-ops rh-fill" + (navOpen ? "" : " rh-ops--rail-off") + (editing || detailId || groupSel !== null ? " rh-ops--stack rh-ops--detail" : " rh-ops--stack")}>
        <OpsPanel
          items={navItems}
          selectedId={editing || detailId ? null : groupSel === null ? null : groupSel || "__ungrouped__"}
          onSelect={(it) => {
            setEditing(null); setDetailId(null); setDetailRows(false);
            setGroupSel(it.id === "__ungrouped__" ? "" : String(it.id));
          }}
          navOpen={navOpen} onToggleNav={toggleNav} storageKey="rs.checks.shutFolders"
          placeholder="Search groups or checks"
          query={query} onQuery={setQuery}
          tools={
            <Button kind="ghost" size="sm" renderIcon={FolderAdd}
                    onClick={() => {
                      setEditing(null); setDetailId(null); setDetailRows(false);
                      let n = "New Group"; let i = 2;
                      const used = new Set(rows.map((c) => (c.folder ?? "").trim()));
                      while (used.has(n)) n = `New Group ${i++}`;
                      setGroupSel(n);
                    }}>
              New Group
            </Button>
          }
          itemAction={(it) => (
            <IconButton kind="ghost" size="sm" align="left" disabled={batching} label={`Run all checks in ${it.name}`}
                    onClick={() => runMany([], it.id === "__ungrouped__" ? "" : String(it.id))}>
              <Play />
            </IconButton>
          )}
          foot={`${rows.length} ${rows.length === 1 ? "check" : "checks"} · ${groupList.length} ${groupList.length === 1 ? "group" : "groups"}`}
          emptyText="No checks yet"
        />

        <Tile style={{ overflow: "auto", minWidth: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {editing ? (
            <CheckEditor key={editing === "new" ? "new" : editing.id}
                         original={editing === "new" ? null : editing} datasources={dss} toast={toast}
                         portalYear={portalYear}
                         knownFolders={[...new Set(rows.map((r) => r.folder).filter(Boolean) as string[])].sort()}
                         onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
          ) : detail ? (
            <CheckDetail key={detail.id} check={detail} dss={dss} portalYear={portalYear} autoRows={detailRows}
                         onEdit={() => setEditing(detail)} onToggle={() => toggle(detail)} onDelete={() => setConfirmDel(detail)}
                         onRun={() => runNow(detail)} />
          ) : groupSel !== null ? (
            <GroupPanel folder={groupSel} checks={rows.filter((c) => (c.folder ?? "") === groupSel)}
                        others={rows.filter((c) => (c.folder ?? "") !== groupSel)}
                        batching={batching} portalYear={portalYear} refreshKey={refreshKey} datasources={dss}
                        onRunAll={() => runMany([], groupSel)}
                        onRunOne={(c) => runNow(c)}
                        onOpen={(c) => { setGroupSel(null); setDetailId(c.id); }}
                        onToggle={(c) => toggle(c)}
                        onReload={reload}
                        onSave={async (c, patch) => {
                          await api.updateCheck(c.id, {
                            name: c.name, description: c.description, folder: c.folder,
                            datasourceId: c.datasourceId, sqlText: c.sqlText,
                            fiscalYear: c.fiscalYear, maxRows: c.maxRows,
                            cron: c.cron, enabled: c.enabled,
                            ...patch,
                          });
                          reload();
                        }}
                        onMove={(c, f) => {
                          api.setCheckFolder(c.id, f)
                            .then(() => { reload(); toast(f ? `Moved "${c.name}" to ${f}` : `Removed "${c.name}" from group`, "ok"); })
                            .catch((e) => toast(e instanceof Error ? e.message : "Move failed", "error"));
                        }}
                        onRename={(to) => {
                          if (!rows.some((c) => (c.folder ?? "") === groupSel)) { setGroupSel(to); return; }
                          api.renameCheckFolder(groupSel, to)
                            .then((r) => { setGroupSel(to); reload(); toast(`Group renamed · moved ${r.moved} checks`, "ok"); })
                            .catch((e) => toast(e instanceof Error ? e.message : "Rename failed", "error"));
                        }} />
          ) : (
            <OpsEmpty icon="checks" title="Select a group from the sidebar" />
          )}
        </Tile>
      </div>

    </div>
  );
}

const TABS = ["rules", "scope", "records", "logs"] as const;

function GroupPanel({ folder, checks, others, batching, portalYear, refreshKey, datasources,
                     onRunAll, onRunOne, onOpen, onMove, onRename, onToggle, onSave, onReload }: {
  folder: string; checks: DataCheck[];
  others: DataCheck[];
  batching: boolean; portalYear: string;
  refreshKey: number;
  datasources: Datasource[];
  onRunAll: () => void;
  onRunOne: (c: DataCheck) => void;
  onOpen: (c: DataCheck) => void;
  onMove: (c: DataCheck, folder: string | null) => void;
  onRename: (to: string) => void;
  onToggle: (c: DataCheck) => void;
  onSave: (c: DataCheck, patch: Partial<SaveCheckInput>) => Promise<void>;
  onReload: () => void;
}) {
  const toast = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addQ, setAddQ] = useState("");
  const [src, setSrc] = useState<CheckGroupSource | null>(null);
  const [rounds, setRounds] = useState<CheckRound[] | null>(null);
  const [round, setRound] = useState<CheckRound | null>(null);
  const [roundRuns, setRoundRuns] = useState<Record<number, DataCheckRun>>({});
  const [tab, setTab] = useState<"scope" | "rules" | "records" | "logs">("rules");
  const [findings, setFindings] = useState<CheckFinding[] | null>(null);
  const [scopeDraft, setScopeDraft] = useState<{ source: string; conditions: string } | null>(null);
  const [savingScope, setSavingScope] = useState(false);
  const [adopt, setAdopt] = useState<ScopeAdoptResult[] | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [countingScope, setCountingScope] = useState(false);
  const [loadingFindings, setLoadingFindings] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<SaveCheckInput> | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savingDs, setSavingDs] = useState(false);
  const [allLogs, setAllLogs] = useState<DataCheckRun[] | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logFilter, setLogFilter] = useState<number | null>(null);

  async function saveScope() {
    if (!scopeDraft) return;
    setSavingScope(true);
    try {
      const next = await api.saveCheckScope(folder, {
        source: scopeDraft.source.trim(),
        conditions: scopeDraft.conditions.split("\n").map((x) => x.trim()).filter(Boolean),
      });
      setSrc(next); setScopeDraft(null);
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save the scope", "error"); }
    finally { setSavingScope(false); }
  }

  async function previewAdopt() {
    setAdopting(true);
    try { setAdopt(await api.adoptCheckScope(folder, false)); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not preview the conversion", "error"); }
    finally { setAdopting(false); }
  }

  async function applyAdopt() {
    setAdopting(true);
    try {
      const res = await api.adoptCheckScope(folder, true);
      setAdopt(null);
      setSrc(await api.checkGroupSource(folder, { year: portalYear || undefined, withRows: true }));
      onReload();
      toast(`Converted ${res.filter((r) => r.changed).length} · skipped ${res.filter((r) => !r.changed).length}`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Conversion failed", "error"); }
    finally { setAdopting(false); }
  }

  async function clearScope() {
    setConfirmClear(false);
    setSavingScope(true);
    try {
      await api.clearCheckScope(folder);
      setSrc(await api.checkGroupSource(folder, { year: portalYear || undefined, withRows: true }));
      setScopeDraft(null);
    } catch (e) { toast(e instanceof Error ? e.message : "Could not clear the scope", "error"); }
    finally { setSavingScope(false); }
  }

  useEffect(() => {
    if (tab !== "scope") return;
    setCountingScope(true);
    api.checkGroupSource(folder, { year: portalYear || undefined, withRows: true })
      .then(setSrc).catch(() => {}).finally(() => setCountingScope(false));
  }, [tab, folder, portalYear, refreshKey]);

  const [fFilters, setFFilters] = useState<Record<string, ColFilterValue>>({});
  const [fOffset, setFOffset] = useState(0);
  const [fPageSize, setFPageSize] = useState(DEFAULT_PAGE_SIZE);

  const findingsKey = `${folder}|${portalYear}|${refreshKey}|${round?.batchId ?? ""}`;
  const loadedFindings = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== "records" || loadedFindings.current === findingsKey) return;
    loadedFindings.current = findingsKey;
    setFindings(null);
    setLoadingFindings(true);
    api.checkGroupFindings(folder, portalYear || undefined, round?.batchId)
      .then(setFindings)
      .catch(() => setFindings([]))
      .finally(() => setLoadingFindings(false));
  }, [tab, folder, portalYear, refreshKey, findingsKey, round?.batchId]);

  const fCols = useMemo(() => {
    const out = ["Record", "Failed checks", "Failing checks"];
    for (const f of findings ?? []) for (const k of Object.keys(f.columns)) if (!out.includes(k)) out.push(k);
    return out;
  }, [findings]);

  const fRows = useMemo(() => (findings ?? []).map((f) => {
    const r: Record<string, string> = {
      "Record": f.key,
      "Failed checks": String(f.rules.length),
      "Failing checks": f.rules.join(" · "),
    };
    for (const [k, v] of Object.entries(f.columns)) r[k] = v == null ? "" : String(v);
    return r;
  }), [findings]);

  const fAnyFilter = useMemo(() => Object.values(fFilters).some(isFilterOn), [fFilters]);
  const fFiltered = useMemo(() => {
    if (!fAnyFilter) return fRows;
    const active = Object.entries(fFilters).filter(([, v]) => isFilterOn(v));
    return fRows.filter((r) => active.every(([c, v]) => {
      const cell = r[c] ?? "";
      if (v.values.length > 0 && !v.values.includes(cell)) return false;
      const q = v.contains.trim().toLowerCase();
      return !q || cell.toLowerCase().includes(q);
    }));
  }, [fRows, fFilters, fAnyFilter]);
  const fPage = useMemo(() => fFiltered.slice(fOffset, fOffset + fPageSize), [fFiltered, fOffset, fPageSize]);
  useEffect(() => { setFOffset(0); }, [fFilters, findingsKey]);

  const fOptions = useCallback((col: string) => {
    const seen = new Set<string>();
    for (const r of fRows) { seen.add(r[col] ?? ""); if (seen.size > 500) break; }
    return [...seen].sort((a, b) => a.localeCompare(b, "th", { numeric: true }))
      .map((v) => ({ value: v, label: v === "" ? "(empty)" : null }));
  }, [fRows]);

  const [fExporting, setFExporting] = useState<"csv" | "xlsx" | "txt" | null>(null);
  async function downloadFindings(format: "csv" | "xlsx" | "txt") {
    setFExporting(format);
    try {
      const stamp = (round ? fmt(round.startedAt) : fmt(new Date().toISOString()))?.replace(/[: ]/g, "-") ?? "";
      const base = `findings-${folder || "ungrouped"}-${stamp}`;
      await api.exportFindings(
        { columns: fCols, rows: fFiltered.map((r) => fCols.map((c) => r[c] ?? "")), filename: base },
        format, `${base}.${format}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Download failed", "error"); }
    finally { setFExporting(null); }
  }

  useEffect(() => {
    setRound(null); setRoundRuns({});
    api.checkGroupSource(folder).then(setSrc).catch(() => setSrc(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    api.checkGroupRounds(folder).then(setRounds).catch(() => setRounds([]));
  }, [folder, checks.length, refreshKey]);

  useEffect(() => {
    if (tab !== "logs" || !logFilter) { setAllLogs(null); return; }
    setLoadingLogs(true);
    api.checkRuns(logFilter, 30)
      .then(setAllLogs)
      .catch(() => setAllLogs([]))
      .finally(() => setLoadingLogs(false));
  }, [tab, logFilter, refreshKey]);

  useEffect(() => { setLogFilter(null); setExpandedId(null); setDraft(null); }, [folder]);

  useEffect(() => {
    if (!round) { setRoundRuns({}); return; }
    api.checkRoundRuns(round.batchId)
      .then((rs) => setRoundRuns(Object.fromEntries(rs.map((r) => [r.checkId, r]))))
      .catch(() => setRoundRuns({}));
  }, [round]);
  const list = useMemo(
    () => [...checks].sort((a, b) => a.name.localeCompare(b.name, "th", { numeric: true })),
    [checks]);
  const statusOf = (c: DataCheck) => (round ? (roundRuns[c.id]?.status ?? null) : c.lastStatus);
  const pass = list.filter((c) => statusOf(c) === "pass").length;
  const bad = list.filter((c) => { const st = statusOf(c); return st === "fail" || st === "error"; }).length;
  const never = list.filter((c) => !statusOf(c)).length;
  const running = list.some((c) => c.lastStatus === "running");

  async function setGroupDatasource(id: string | null) {
    setSavingDs(true);
    try {
      for (const c of list) {
        if ((c.datasourceId ?? null) === id) continue;
        await onSave(c, { datasourceId: id });
      }
    } finally { setSavingDs(false); }
  }

  function download() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const head = ["Check", "Rule", "Result", "Bad Rows", "Max Allowed", "Checked At", "Error"];
    const body = list.map((c) => {
      const rr = round ? roundRuns[c.id] : undefined;
      const st = round ? (rr?.status ?? null) : c.lastStatus;
      return [
        c.name,
        c.description ?? "",
        STATUS[st ?? ""]?.[1] ?? (round ? "Not in this round" : "Never run"),
        (round ? rr?.rowCount : c.lastCount) == null ? "" : String(round ? rr?.rowCount : c.lastCount),
        String(c.maxRows),
        fmt(round ? rr?.startedAt : c.lastRunAt),
        (round ? rr?.message : c.lastError) ?? "",
      ];
    });
    const csv = [head, ...body].map((r) => r.map((v) => esc(String(v))).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `check-results-${folder}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)", flexWrap: "wrap" }}>
        <Folder size={20} style={{ flex: "none", color: "var(--cds-icon-secondary)" }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          {rename === null ? (
            <h2 className="cds--type-heading-03" style={{ cursor: "text", margin: 0 }}
                 title="Click to rename group" onClick={() => setRename(folder)}>{folder}</h2>
          ) : (
            <TextInput id="chk-group-rename" labelText="Group name" hideLabel size="sm" autoFocus value={rename}
                   onChange={(e) => setRename(e.target.value)}
                   onBlur={() => { const v = rename.trim(); setRename(null); if (v && v !== folder) onRename(v); }}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                     if (e.key === "Escape") { e.preventDefault(); setRename(null); }
                   }} />
          )}
          <div className="cds--type-label-01 rh-dim">
            {list.length} {list.length === 1 ? "check" : "checks"} · {pass} passed
            {bad > 0 && <> · <span style={{ color: "var(--cds-text-error)", fontWeight: 600 }}>{bad} failed</span></>}
            {never > 0 && ` · ${never} ${round ? "not in this round" : "never run"}`}
          </div>
        </div>
        {round && (
          <Tag type="blue" filter title="Back to the latest result" onClose={() => setRound(null)} style={{ flex: "none" }}>
            Run {fmt(round.startedAt)?.slice(5)} · {round.passed} passed
            {round.failed > 0 ? ` · ${round.failed} failed` : ""}
          </Tag>
        )}
        <Button renderIcon={Play} size="md" disabled={batching || running} onClick={onRunAll}>Run All</Button>
        <IconButton kind="ghost" label="Download results" align="left" onClick={download}><Download /></IconButton>
      </div>


      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)", flexWrap: "wrap" }}>
        <ContentSwitcher size="sm" style={{ width: "auto", minWidth: 0, maxWidth: 420, flex: "1 1 320px" }}
                         selectedIndex={TABS.indexOf(tab)} onChange={(e) => setTab(TABS[e.index ?? 0])}>
          <Switch name="rules" text="Rules" />
          <Switch name="scope" text="Scope" />
          <Switch name="records" text="Findings" />
          <Switch name="logs" text="History" />
        </ContentSwitcher>
        {tab === "records" && !loadingFindings && findings && findings.length > 0 && (
          <>
            <span className="cds--type-label-01 rh-dim">
              {findings.length.toLocaleString("en-US")} {findings.length === 1 ? "record" : "records"} with violations
            </span>
            <IconButton kind="ghost" size="sm" label="Re-run the query of every failing check"
                    onClick={() => { loadedFindings.current = null; setTab("rules"); setTimeout(() => setTab("records"), 0); }}>
              <Renew />
            </IconButton>
          </>
        )}
        <span style={{ flex: 1 }} />
        <Button kind="ghost" size="sm" renderIcon={adding ? Close : Add} onClick={() => { setAdding((v) => !v); setAddQ(""); }}>
          {adding ? "Close" : "Add"}
        </Button>
      </div>
      {adding && (
        <div style={{ borderBottom: "1px solid var(--cds-border-subtle-01)", padding: "8px 16px" }}>
          <Search size="sm" labelText="Add check" placeholder="Type check name to add" autoFocus value={addQ}
                  onChange={(e) => setAddQ((e.target as HTMLInputElement).value)} style={{ maxWidth: 400 }} />
          <StructuredListWrapper isCondensed selection={false} style={{ marginBottom: 0, maxHeight: 180, overflow: "auto", display: "block" }}>
            <StructuredListBody>
              {others
                .filter((c) => !addQ.trim() || `${c.name} ${c.description ?? ""}`.toLowerCase().includes(addQ.trim().toLowerCase()))
                .slice(0, 50)
                .map((c) => (
                  <StructuredListRow key={c.id} onClick={() => onMove(c, folder)} style={{ cursor: "pointer" }}>
                    <StructuredListCell style={{ width: 24 }}><Add /></StructuredListCell>
                    <StructuredListCell>{c.name}</StructuredListCell>
                    <StructuredListCell className="cds--type-label-01 rh-dim">{c.folder ?? "Ungrouped"}</StructuredListCell>
                  </StructuredListRow>
                ))}
            </StructuredListBody>
          </StructuredListWrapper>
          {others.length === 0 && <p className="cds--type-body-compact-01 rh-dim" style={{ padding: 8 }}>All checks are already in this group</p>}
        </div>
      )}

      {adopt && (
        <Modal title="Make the group's checks use $SCOPE" onClose={() => setAdopt(null)} width={900}
               foot={
                 <>
                   <Button kind="secondary" onClick={() => setAdopt(null)}>Cancel</Button>
                   <Button kind="primary" disabled={adopting || adopt.every((r) => !r.changed)} onClick={applyAdopt}>
                     Apply to {adopt.filter((r) => r.changed).length} checks
                   </Button>
                 </>
               }>
          <p className="cds--type-body-01" style={{ marginBottom: 12 }}>
            Convertible <b>{adopt.filter((r) => r.changed).length}</b> · skipped <b>{adopt.filter((r) => !r.changed).length}</b>
          </p>
          <div style={{ maxHeight: 460, overflow: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
            {adopt.map((r) => (
              <Tile key={r.id} style={{ padding: 12, minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {r.changed
                    ? <CheckmarkFilled style={{ color: "var(--cds-support-success)", flex: "none" }} />
                    : <WarningAltFilled style={{ color: "var(--cds-support-warning)", flex: "none" }} />}
                  <span className="cds--type-heading-compact-01" style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
                  <span className="cds--type-label-01 rh-dim">{r.reason}</span>
                </div>
                {r.changed && r.after && (
                  <CodeSnippet type="multi" feedback="Copied" className={styles.snippet}>{r.after}</CodeSnippet>
                )}
              </Tile>
            ))}
          </div>
        </Modal>
      )}

      {tab === "scope" && (
        <div style={{ overflow: "auto", minHeight: 0, flex: 1, padding: 16 }}>
          <div className={styles.kv}>
            <div className="cds--type-label-01 rh-dim">Table / SQL</div>
            <div>
              {scopeDraft ? (
                <TextArea id="chk-scope-src" labelText="Table / SQL" hideLabel className="rh-mono"
                          rows={scopeDraft.source.includes("\n") ? 8 : 3}
                          value={scopeDraft.source}
                          onChange={(e) => setScopeDraft({ ...scopeDraft, source: e.target.value })}
                          helperText="A table name or a single SELECT (no ;)"
                          placeholder={"SALES.ORDERS\n— or a full SELECT, e.g.\nSELECT a.*, b.NAME FROM T a JOIN U b ON ..."} />
              ) : (
                <div className="cds--type-code-01" style={{ whiteSpace: "pre-wrap" }}>
                  {src?.table ?? "—"}
                  <span className="cds--type-label-01 rh-dim" style={{ marginLeft: 8 }}>
                    {src?.stored ? "— set manually" : "— inferred from each check's SQL"}
                  </span>
                </div>
              )}
            </div>

            <div className="cds--type-label-01 rh-dim">Connection</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Select value={src?.datasourceId ?? ""}
                      disabled={savingDs || list.length === 0}
                      onChange={(v) => setGroupDatasource(v || null)}
                      options={[{ value: "", label: "Internal Report Studio warehouse" }, ...datasources.map((d) => ({ value: d.id, label: d.name }))]}
                      style={{ width: "auto", minWidth: 240 }} compact />
              <span className="cds--type-label-01 rh-dim">
                applies to all {list.length} {list.length === 1 ? "check" : "checks"} in this group
              </span>
            </div>

            <div className="cds--type-label-01 rh-dim">Shared conditions</div>
            <div>
              {scopeDraft ? (
                <TextArea id="chk-scope-cond" labelText="Shared conditions" hideLabel className="rh-mono" rows={4}
                          value={scopeDraft.conditions}
                          onChange={(e) => setScopeDraft({ ...scopeDraft, conditions: e.target.value })}
                          helperText="One condition per line, joined with AND"
                          placeholder={"<column> = '$YEAR4'\n<column> = '<value>'"} />
              ) : src?.where?.length ? (
                <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
                  {src.where.map((w) => <Tag key={w} size="sm" type="cool-gray" className="cds--type-code-01">{w}</Tag>)}
                </div>
              ) : (
                <span className="rh-dim">No shared conditions</span>
              )}
            </div>

            <div />
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {scopeDraft ? (
                <>
                  <Button size="sm" renderIcon={Checkmark} disabled={savingScope || !scopeDraft.source.trim()} onClick={saveScope}>
                    Save scope
                  </Button>
                  <Button size="sm" kind="ghost" disabled={savingScope} onClick={() => setScopeDraft(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <Button size="sm" kind="tertiary" renderIcon={Edit} onClick={() => setScopeDraft({
                    source: src?.table ?? "",
                    conditions: (src?.where ?? []).join("\n"),
                  })}>
                    {src?.stored ? "Edit scope" : "Set scope"}
                  </Button>
                  {src?.stored && (
                    <>
                      <Button size="sm" kind="tertiary" renderIcon={Flash} disabled={adopting} onClick={previewAdopt}>
                        Make all checks use $SCOPE
                      </Button>
                      {confirmClear ? (
                        <Button size="sm" kind="danger--ghost" disabled={savingScope} onClick={clearScope}
                                title={(src?.usingScope ?? 0) > 0 ? `${src?.usingScope} checks use FROM $SCOPE and will fail until edited` : undefined}>
                          {(src?.usingScope ?? 0) > 0 ? `Clear? ${src?.usingScope} checks will fail` : "Clear scope?"}
                        </Button>
                      ) : (
                        <Button size="sm" kind="ghost" renderIcon={Renew} disabled={savingScope} onClick={() => setConfirmClear(true)}>
                          Clear · infer from checks
                        </Button>
                      )}
                    </>
                  )}
                </>
              )}
              {src?.stored && (
                <span className="cds--type-label-01 rh-dim">
                  <code className="cds--type-code-01">FROM $SCOPE</code> — used by {src.usingScope} of {list.length}
                </span>
              )}
            </div>

            <div className="cds--type-label-01 rh-dim">Rows in scope</div>
            <div className="cds--type-code-01">
              {countingScope ? <SkeletonText width="120px" />
                : src?.scopeRows == null ? "— (unable to count)"
                : src.scopeRows.toLocaleString("en-US") + " rows"}
            </div>

            <div className="cds--type-label-01 rh-dim">Data source</div>
            <div>
              {src?.pipelineName ? (
                <>
                  {src.pipelineName}
                  <div className="cds--type-label-01 rh-dim" style={{ marginTop: 2 }}>
                    {src.pipelineLastRunAt ? `Last run ${fmt(src.pipelineLastRunAt)}` : "Never run"}
                    {src.pipelineRows != null ? ` · wrote ${src.pipelineRows.toLocaleString("en-US")} rows` : ""}
                  </div>
                </>
              ) : <span className="rh-dim">No pipeline writes to this table</span>}
            </div>

            <div className="cds--type-label-01 rh-dim">Rules in group</div>
            <div>{src?.rules ?? list.length} checks</div>
          </div>
        </div>
      )}

      {tab === "records" && (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          {loadingFindings && (
            <TableSkeleton rows={5} columns={4} toolbar={false} />
          )}
          {!loadingFindings && fRows.length === 0 && (
            <div style={{ padding: 32 }} className="rh-dim cds--type-body-01">
              {round ? `Run ${fmt(round.startedAt)} has no stored failing rows` : "No failing rows — or the checks have not been run yet"}
            </div>
          )}
          {!loadingFindings && fRows.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", flexWrap: "wrap",
                            borderBottom: "1px solid var(--cds-border-subtle-01)" }}>
                <span className="cds--type-label-01 rh-dim">
                  {fAnyFilter
                    ? `${fFiltered.length.toLocaleString("en-US")} of ${fRows.length.toLocaleString("en-US")} rows`
                    : `${fRows.length.toLocaleString("en-US")} failing rows`} · {fCols.length} columns
                </span>
                {fAnyFilter && (
                  <Button kind="ghost" size="sm" renderIcon={Close} onClick={() => setFFilters({})}>Clear filters</Button>
                )}
                <span style={{ flex: 1 }} />
                {(["xlsx", "csv", "txt"] as const).map((f) => (
                  <Button key={f} kind="ghost" size="sm" renderIcon={Download} disabled={!!fExporting}
                          onClick={() => downloadFindings(f)}
                          title={fAnyFilter ? `Download filtered rows (.${f})` : `Download all rows and columns (.${f})`}>
                    {f === "xlsx" ? "Excel" : f === "csv" ? "CSV" : "Text"}
                  </Button>
                ))}
              </div>
              <TableContainer className={styles.gridScroll}>
                <Table size="sm">
                  <TableHead>
                    <TableRow>
                      <TableHeader style={{ width: 48 }}>#</TableHeader>
                      {fCols.map((c) => (
                        <TableHeader key={c}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            {c}
                            <HeaderFilter label={c} value={fFilters[c] ?? EMPTY_FILTER}
                                          onChange={(v) => setFFilters((cur) => ({ ...cur, [c]: v }))}
                                          options={fOptions(c)} />
                          </span>
                        </TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {fPage.map((r, i) => (
                      <TableRow key={fOffset + i}>
                        <TableCell className="cds--type-code-01 rh-dim">{fOffset + i + 1}</TableCell>
                        {fCols.map((c) => (
                          <TableCell key={c} title={r[c] ?? ""}
                              className={c === "Failed checks" || c === "Record" ? "cds--type-code-01" : undefined}
                              style={c === "Failed checks" ? { textAlign: "right", ...(Number(r[c]) > 1 ? { color: "var(--cds-text-error)", fontWeight: 600 } : {}) } : undefined}>
                            {(r[c] ?? "") === "" ? <span className={styles.null}>NULL</span> : r[c]}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                    {fFiltered.length === 0 && (
                      <TableRow><TableCell colSpan={fCols.length + 1} className="rh-dim" style={{ textAlign: "center", padding: 32 }}>
                        No rows match the filters
                      </TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
              {fFiltered.length > 0 && (
                <div>
                  <Pager offset={fOffset} pageRows={fPage.length} total={fFiltered.length} loading={false}
                         pageSize={fPageSize}
                         onPageSize={(n) => { setFPageSize(n); setFOffset(0); }}
                         onGo={setFOffset} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "rules" && (
      <TableContainer className={styles.scroll} style={{ minHeight: 0, flex: 1 }}>
        <Table size="md">
          <TableHead>
            <TableRow>
              <TableExpandHeader aria-label="Expand" />
              <TableHeader style={{ width: 72 }}>On</TableHeader>
              <TableHeader style={{ width: 210 }}>Check</TableHeader>
              <TableHeader>Rule description</TableHeader>
              <TableHeader style={{ width: 120 }}>Result</TableHeader>
              <TableHeader style={{ width: 96, textAlign: "right" }}>Bad rows</TableHeader>
              <TableHeader style={{ width: 150 }}>Last run</TableHeader>
              <TableHeader style={{ width: 96 }}><span className="cds--visually-hidden">Actions</span></TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {list.map((c) => {
              const rr = round ? roundRuns[c.id] : undefined;
              const status = round ? (rr?.status ?? null) : c.lastStatus;
              const count = round ? (rr?.rowCount ?? null) : c.lastCount;
              const when = round ? (rr?.startedAt ?? null) : c.lastRunAt;
              const err = round ? (rr?.message ?? null) : c.lastError;
              const expanded = expandedId === c.id;
              return (<Fragment key={c.id}>
                <TableExpandRow isExpanded={expanded} aria-label="Expand" expandIconDescription={expanded ? "Collapse" : "Edit inline"}
                    style={{ cursor: "pointer" }}
                    onClickCapture={(e) => {
                      // The whole row toggles the inline editor (chevron included); cells marked data-noexpand don't.
                      if ((e.target as HTMLElement).closest("[data-noexpand]")) return;
                      setExpandedId(expanded ? null : c.id); setDraft(null);
                    }}
                    onExpand={() => {}}>
                  <TableCell data-noexpand>
                    <Toggle id={`chk-on-${c.id}`} size="sm" labelA="" labelB=""
                            labelText="" aria-label={c.enabled ? "Disable temporarily" : "Enable"} title={c.enabled ? "Disable temporarily" : "Enable"}
                            toggled={c.enabled} onToggle={() => onToggle(c)} />
                  </TableCell>
                  <TableCell style={{ fontWeight: 600 }}>
                    {c.name}
                    {!c.enabled && <span className="cds--type-label-01 rh-dim" style={{ marginLeft: 6, fontWeight: 400 }}>· disabled</span>}
                  </TableCell>
                  <TableCell style={{ whiteSpace: "pre-wrap", color: c.enabled ? undefined : "var(--cds-text-secondary)" }}>
                    {c.description || <span className="rh-dim">—</span>}
                    {err && <div style={{ color: "var(--cds-text-error)", marginTop: 4 }}>{err}</div>}
                  </TableCell>
                  <TableCell><ResultTag status={status} fallback={round ? "Not in this round" : "Never run"} /></TableCell>
                  <TableCell className="cds--type-code-01" style={{ textAlign: "right", color: (count ?? 0) > c.maxRows ? "var(--cds-text-error)" : undefined }}>
                    {count == null ? "—" : count.toLocaleString("en-US")}
                  </TableCell>
                  <TableCell className="rh-dim">{fmt(when)}</TableCell>
                  <TableCell data-noexpand style={{ whiteSpace: "nowrap" }}>
                    <IconButton kind="ghost" size="sm" align="left" label={`Run "${c.name}" now`}
                            disabled={batching || !c.enabled || c.lastStatus === "running"}
                            onClick={() => onRunOne(c)}><Play /></IconButton>
                    <IconButton kind="ghost" size="sm" align="left" label="Remove from group (does not delete the check)"
                            onClick={() => onMove(c, null)}><Close /></IconButton>
                  </TableCell>
                </TableExpandRow>
                {expanded && (() => {
                  const dirty = draft !== null && Object.keys(draft).length > 0;
                  const v = <K extends keyof SaveCheckInput>(k: K, fallback: SaveCheckInput[K]) =>
                    (draft && draft[k] !== undefined ? draft[k] : fallback) as SaveCheckInput[K];
                  const set = (patch: Partial<SaveCheckInput>) => setDraft((d) => ({ ...(d ?? {}), ...patch }));
                  const busy = savingId === c.id;
                  const save = async () => {
                    if (!dirty || busy) return;
                    setSavingId(c.id);
                    try { await onSave(c, draft ?? {}); setDraft(null); }
                    finally { setSavingId(null); }
                  };
                  return (
                  <TableExpandedRow colSpan={8}>
                    <div onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
                          if (e.key === "Escape" && dirty) { e.preventDefault(); setDraft(null); }
                        }} style={{ padding: "8px 0" }}>
                      <div className={styles.sql}>
                        <span className="cds--type-label-01 rh-dim">Datasource</span>
                        <Select value={v("datasourceId", c.datasourceId) ?? ""}
                                onChange={(val) => set({ datasourceId: val || null })}
                                options={[{ value: "", label: "Internal Report Studio warehouse" }, ...datasources.map((d) => ({ value: d.id, label: d.name }))]}
                                style={{ maxWidth: 340 }} compact />

                        <span className="cds--type-label-01 rh-dim">Fiscal year</span>
                        <TextInput id={`chk-fy-${c.id}`} labelText="Fiscal year" hideLabel size="sm" maxLength={4}
                               placeholder="Portal default" style={{ maxWidth: 120 }}
                               value={v("fiscalYear", c.fiscalYear) ?? ""}
                               onChange={(e) => set({ fiscalYear: e.target.value.replace(/\D/g, "") || null })} />

                        <span className="cds--type-label-01 rh-dim">Max bad rows</span>
                        <TextInput id={`chk-max-${c.id}`} labelText="Max bad rows" hideLabel size="sm" style={{ maxWidth: 120 }}
                               value={String(v("maxRows", c.maxRows) ?? 0)}
                               onChange={(e) => set({ maxRows: Number(e.target.value.replace(/\D/g, "")) || 0 })} />

                        <span className="cds--type-label-01 rh-dim" style={{ alignSelf: "start", paddingTop: 6 }}>SQL</span>
                        <SqlEditor value={v("sqlText", c.sqlText) ?? ""} onChange={(t) => set({ sqlText: t })}
                                   height={252} vars={["$YEAR4", "$YEAR2", "$SCOPE"]} />
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {dirty && (
                          <>
                            <Button size="sm" renderIcon={Checkmark} disabled={busy} onClick={save}>Save</Button>
                            <Button size="sm" kind="ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
                            <span className="cds--type-label-01 rh-dim">Unsaved · ⌘S save · Esc discard</span>
                          </>
                        )}
                        <span style={{ flex: 1 }} />
                        <Button size="sm" kind="ghost" renderIcon={View} onClick={() => onOpen(c)}>View Details</Button>
                      </div>
                    </div>
                  </TableExpandedRow>
                  );
                })()}
              </Fragment>);
            })}
            {list.length === 0 && (
              <TableRow><TableCell colSpan={8} className="rh-dim" style={{ textAlign: "center", padding: 32 }}>No checks in this group</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      )}

      {tab === "logs" && (
        <div style={{ overflow: "auto", minHeight: 0, flex: 1 }}>
          <div style={{ padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <Select compact searchable style={{ width: 280, maxWidth: "100%" }}
                    value={logFilter == null ? "" : String(logFilter)}
                    onChange={(v) => setLogFilter(v ? Number(v) : null)}
                    options={[{ value: "", label: "All checks (per-run summary)" },
                              ...list.map((c) => ({ value: String(c.id), label: c.name }))]} />
            {logFilter && allLogs && (
              <span className="cds--type-label-01 rh-dim">{allLogs.length} entries</span>
            )}
          </div>

          {!logFilter && (
            <Table size="sm">
              <TableHead>
                <TableRow>
                  <TableHeader>When</TableHeader>
                  <TableHeader style={{ textAlign: "right" }}>Passed</TableHeader>
                  <TableHeader style={{ textAlign: "right" }}>Failed</TableHeader>
                  <TableHeader style={{ textAlign: "right" }}>Error / pending</TableHeader>
                  <TableHeader style={{ textAlign: "right" }}>Total</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {!rounds && (
                  <TableRow><TableCell colSpan={5}><Skeleton /></TableCell></TableRow>
                )}
                {rounds?.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="rh-dim" style={{ textAlign: "center", padding: 32 }}>No run history yet</TableCell></TableRow>
                )}
                {rounds?.map((r) => {
                  const other = r.total - r.passed - r.failed;
                  const done = !!r.finishedAt;
                  const on = round?.batchId === r.batchId;
                  return (
                    <TableRow key={r.batchId} className={on ? styles.onRow : undefined} isSelected={on}
                        style={{ cursor: "pointer" }}
                        title={on ? "Viewing this run — click to return to the latest" : "Click to view this run"}
                        onClick={() => setRound(on ? null : r)}>
                      <TableCell style={{ fontWeight: on ? 600 : 400 }}>{fmt(r.startedAt)}</TableCell>
                      <TableCell style={{ textAlign: "right" }}>{r.passed}</TableCell>
                      <TableCell style={{ textAlign: "right", color: r.failed > 0 ? "var(--cds-text-error)" : undefined, fontWeight: r.failed > 0 ? 600 : 400 }}>{r.failed}</TableCell>
                      <TableCell title={done ? "checks that errored" : "still running or queued in this round"}
                          style={{ textAlign: "right", color: done && other > 0 ? "var(--cds-text-error)" : undefined }}>
                        {other}{!done && other > 0 ? " …" : ""}
                      </TableCell>
                      <TableCell style={{ textAlign: "right" }}>{r.total}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {logFilter && (
            <Table size="sm">
              <TableHead>
                <TableRow>
                  <TableHeader>When</TableHeader>
                  <TableHeader>Result</TableHeader>
                  <TableHeader style={{ textAlign: "right" }}>Bad rows</TableHeader>
                  <TableHeader>Trigger</TableHeader>
                  <TableHeader>Message</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {loadingLogs && (
                  <TableRow><TableCell colSpan={5}><Skeleton /></TableCell></TableRow>
                )}
                {!loadingLogs && allLogs?.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="rh-dim" style={{ textAlign: "center", padding: 32 }}>No run history for this check</TableCell></TableRow>
                )}
                {!loadingLogs && allLogs?.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="rh-dim">{fmt(run.startedAt)}</TableCell>
                    <TableCell><ResultTag status={run.status} fallback={run.status} /></TableCell>
                    <TableCell className="cds--type-code-01" style={{ textAlign: "right" }}>
                      {run.rowCount == null ? "-" : run.rowCount.toLocaleString("en-US")}
                    </TableCell>
                    <TableCell className="rh-dim">{run.trigger === "manual" ? "Manual" : "Scheduled"}</TableCell>
                    <TableCell style={{ color: run.message ? "var(--cds-text-error)" : "var(--cds-text-secondary)" }}>
                      {run.message ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}

function CheckDetail({ check, dss, portalYear, autoRows, onRun, onEdit, onToggle, onDelete }: {
  check: DataCheck; dss: Datasource[]; portalYear: string; autoRows: boolean;
  onRun: () => void; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const { can } = usePerms();
  const [runs, setRuns] = useState<DataCheckRun[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [bad, setBad] = useState<TableResult | null>(null);
  const [badErr, setBadErr] = useState<string | null>(null);
  const [loadingBad, setLoadingBad] = useState(false);

  useEffect(() => {
    api.checkRuns(check.id)
      .then((r) => { setRuns(r); setPick((cur) => cur ?? r[0]?.id ?? null); })
      .catch(() => setRuns([]));
  }, [check.id, check.lastRunAt, check.lastStatus]);

  const year = check.fiscalYear?.trim() || portalYear || undefined;
  const showBad = useCallback(async () => {
    setLoadingBad(true);
    setBadErr(null);
    try { setBad(await api.checkRows(check.id, year, 100)); }
    catch (e) { setBad(null); setBadErr(e instanceof Error ? e.message : "Could not read the bad rows"); }
    finally { setLoadingBad(false); }
  }, [check.id, year]);

  useEffect(() => { if (autoRows) void showBad(); }, [autoRows, showBad]);

  const current = runs?.find((r) => r.id === pick) ?? null;
  const [curTone, curText] = STATUS[current?.status ?? ""] ?? ["var(--cds-text-placeholder)", "Never run"];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 220px" }}>
          <h2 className="cds--type-heading-03 rh-ellipsis" style={{ margin: 0 }}>{check.name}</h2>
          <div className="cds--type-label-01 rh-dim">
            {dsLabel(check.datasourceId, dss)}
            {" · "}max {check.maxRows.toLocaleString("en-US")} bad rows
            {" · "}FY {year ?? "—"}
            {check.cron ? ` · ${cronLabel(check.cron)}` : ""}
          </div>
        </div>
        <Button renderIcon={Play} onClick={onRun}>Run Now</Button>
        <IconButton kind="ghost" align="left" label={check.enabled ? "Disable temporarily" : "Enable"} onClick={onToggle}>
          {check.enabled ? <Pause /> : <Play />}
        </IconButton>
        {can("RH.CHECK", "update") && (<IconButton kind="ghost" align="left" label="Edit" onClick={onEdit}><Edit /></IconButton>)}
        {can("RH.CHECK", "delete") && (<IconButton kind="ghost" align="left" label="Delete" onClick={onDelete}><TrashCan /></IconButton>)}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)", background: "var(--cds-layer-02)", flexWrap: "wrap" }}>
        {current ? (
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {current.rowCount != null && current.rowCount > 0 ? (
                <span className="cds--type-productive-heading-04" style={{ fontVariantNumeric: "tabular-nums",
                                                 color: curTone === "var(--cds-text-error)" ? curTone : undefined }}>
                  {current.rowCount.toLocaleString("en-US")}
                  <span className="cds--type-label-01 rh-dim" style={{ marginLeft: 4 }}>bad rows</span>
                </span>
              ) : (
                <ResultTag status={current.status} fallback={curText} />
              )}
            </div>
            <div className="cds--type-label-01 rh-dim" style={{ marginTop: 2 }} title={fmt(current.startedAt)}>
              {current.rowCount != null && current.rowCount > 0 ? `${curText} · ` : ""}
              {ago(current.startedAt)}
              {current.finishedAt ? ` · took ${dur(current.startedAt, current.finishedAt)}` : ""}
              {current.runBy ? ` · ${current.runBy}` : ""}
            </div>
            {current.message && (
              <div className="cds--type-body-compact-01" style={{ marginTop: 4 }}>{current.message}</div>
            )}
            {check.lastError && current.id === runs?.[0]?.id && (
              <div className="cds--type-body-compact-01" style={{ color: "var(--cds-text-error)", marginTop: 4 }}>{check.lastError}</div>
            )}
          </div>
        ) : (
          <div className="cds--type-body-compact-01 rh-dim" style={{ flex: 1 }}>
            {runs === null ? "" : "Never run"}
          </div>
        )}
        {runs && runs.length > 0 && (
          <Select value={pick != null ? String(pick) : ""}
                  onChange={(val) => setPick(Number(val) || null)}
                  options={runs.map((r, i) => {
                    const [, text] = STATUS[r.status] ?? ["", r.status];
                    return {
                      value: String(r.id),
                      label: `${i === 0 ? "Latest" : fmt(r.startedAt)?.slice(5)} — ${text}${r.rowCount != null && r.rowCount > 0 ? ` (${r.rowCount.toLocaleString("en-US")})` : ""}`,
                    };
                  })}
                  style={{ width: "auto", flex: "none", minWidth: 220 }} compact />
        )}
        <Button size="sm" kind="tertiary" renderIcon={View} onClick={showBad} disabled={loadingBad}>Show Bad Rows</Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
        <div className="cds--type-label-01 rh-dim" style={{ marginBottom: 8 }}>
          First 100 bad rows{year ? ` · FY ${year}` : ""}
        </div>
        {badErr && <InlineNotification kind="error" title="Could not read the bad rows" subtitle={badErr} hideCloseButton lowContrast style={{ maxWidth: "none" }} />}
        {loadingBad && <TableSkeleton rows={4} columns={4} toolbar={false} />}
        {bad && !loadingBad && (
          <TableContainer className={styles.scroll} style={{ maxHeight: 400 }}>
            <ResultTable columns={bad.columns} rows={bad.rows} />
            {bad.rows.length === 0 && (
              <div className="cds--type-body-compact-01 rh-dim" style={{ padding: 24, textAlign: "center" }}>No bad rows right now — this check passes</div>
            )}
          </TableContainer>
        )}
      </div>
    </div>
  );
}

function CheckEditor({ original, datasources, toast, portalYear, knownFolders, onClose, onSaved }: {
  original: DataCheck | null; datasources: Datasource[]; toast: ReturnType<typeof useToast>;
  portalYear: string; knownFolders: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [folder, setFolder] = useState(original?.folder ?? "");
  const [datasourceId, setDatasourceId] = useState(original?.datasourceId ?? "");
  const [sqlText, setSqlText] = useState(original?.sqlText ?? "");
  const [fiscalYear, setFiscalYear] = useState(original?.fiscalYear ?? "");
  const [maxRows, setMaxRows] = useState(String(original?.maxRows ?? 0));
  const [cron] = useState(original?.cron ?? "");
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<TableResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const dsOptions = [{ value: "", label: "Internal Report Studio warehouse" },
                     ...datasources.map((d) => ({ value: d.id, label: d.name }))];

  async function tryIt() {
    if (!sqlText.trim()) { toast("Enter SQL first", "error"); return; }
    setPreviewing(true);
    try {
      const y = fiscalYear.trim() || portalYear;
      setPreview(await api.warehousePreview({ datasourceId: datasourceId || null, sql: sqlText, year: y || undefined, limit: 100 }));
    } catch (e) {
      setPreview(null);
      toast(e instanceof Error ? e.message : "Preview failed", "error");
    } finally { setPreviewing(false); }
  }

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    if (!sqlText.trim()) { toast("SQL is required", "error"); return; }
    if (fiscalYear.trim() && !/^\d{4}$/.test(fiscalYear.trim())) { toast("Year must be 4 digits", "error"); return; }
    if (cron && !fiscalYear.trim() && /\$YEAR(?::?[24])?\b/.test(sqlText)) {
      toast("This SQL uses $YEAR4/$YEAR2 — a scheduled check must set the fiscal year", "error"); return;
    }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, folder: folder.trim() || null,
        datasourceId: datasourceId || null, sqlText, fiscalYear: fiscalYear.trim() || null,
        maxRows: Number(maxRows) || 0, cron: cron || null, enabled };
      if (original) await api.updateCheck(original.id, body);
      else await api.createCheck(body);
      toast("Saved", "ok");
      onSaved();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); setSaving(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 className="cds--type-heading-03" style={{ margin: 0, flex: 1, minWidth: 0 }}>{original ? `Edit Check · ${original.name}` : "New Check"}</h2>
        <IconButton kind="ghost" align="left" label="Close" onClick={onClose}><Close /></IconButton>
      </div>

      <div className={styles.grid2}>
        <TextInput id="chk-name" labelText="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Orders without amount" />
        <TextInput id="chk-desc" labelText="Description" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className={styles.grid3}>
        <ComboBox id="chk-folder" titleText="Group" placeholder="Pre-export" allowCustomValue
                  items={knownFolders} selectedItem={folder || null}
                  onChange={({ selectedItem, inputValue }) => setFolder((selectedItem as string | null) ?? inputValue ?? "")}
                  onInputChange={(v) => setFolder(v ?? "")} />
        <TextInput id="chk-fy" labelText="Fiscal Year" helperText="Replaces $YEAR4/$YEAR2 in scheduled runs"
                   value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} placeholder="2026" maxLength={4} />
        <TextInput id="chk-max" labelText="Max Bad Rows" helperText="0 = zero tolerance"
                   value={maxRows} onChange={(e) => setMaxRows(e.target.value.replace(/\D/g, ""))} placeholder="0" />
      </div>

      <Tile style={{ background: "var(--cds-layer-02)", display: "flex", flexDirection: "column", gap: 16 }}>
        <Select label="Datasource" value={datasourceId} onChange={setDatasourceId} placeholder="Internal warehouse" options={dsOptions} />
        <div>
          <div className="cds--label" style={{ display: "flex", width: "100%" }}>
            <span>SQL returning bad rows (SELECT only)</span>
            <span style={{ marginLeft: "auto" }}>0 rows = pass</span>
          </div>
          <SqlEditor value={sqlText} onChange={setSqlText} height={232} vars={["$YEAR4", "$YEAR2", "$SCOPE"]}
                     placeholder={"SELECT BRANCH_CODE, ORDER_NO, AMOUNT\nFROM SALES.ORDERS\nWHERE <year_column> = '$YEAR4'\n  AND (AMOUNT IS NULL OR AMOUNT <= 0)"} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Button size="sm" kind="tertiary" renderIcon={View} onClick={tryIt} disabled={previewing}>Preview (100 rows)</Button>
          <span className="cds--type-label-01 rh-dim">
            {(fiscalYear.trim() || portalYear) ? `Using FY ${fiscalYear.trim() || portalYear}` : "No fiscal year set"}
          </span>
        </div>
        {previewing && <TableSkeleton rows={3} columns={4} toolbar={false} />}
        {preview && !previewing && (
          <TableContainer title={`${preview.rowCount} rows found${preview.rowCount === 0 ? " — this check passes" : ""}`}
                          className={styles.scroll} style={{ maxHeight: 280 }}>
            <ResultTable columns={preview.columns} rows={preview.rows} />
          </TableContainer>
        )}
      </Tile>

      <Checkbox id="chk-enabled" labelText="Enabled" checked={enabled} onChange={(_, { checked }) => setEnabled(checked)} />

      <div style={{ display: "flex", gap: 1 }}>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button renderIcon={Checkmark} onClick={save} disabled={saving}>Save</Button>
      </div>
    </div>
  );
}
