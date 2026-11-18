"use client";

// Schedulers: run an INSERT/UPDATE/DELETE/MERGE against a datasource on a cron
// schedule. Enable/disable, run manually, and see the success/error history of each run.
//
// The list is the shared card list of the whole app (.lrow*, same language as Data Warehouse),
// not a table: what people come here to know while scanning is "which one is broken, and how many
// rows did the last run touch" — so the affected-row count is the biggest thing in the row and the
// settings (cron, datasource) drop to the quiet second line. Run history opens as a popup instead
// of expanding in place, so the rows below never jump.
import { PageHeader, Skeleton } from "@/components/ui";
import { Button, Checkbox, CodeSnippet, IconButton, InlineNotification, Tag, TextInput } from "@carbon/react";
import { Add, Checkmark, Close, Edit, Pause, Play, TrashCan } from "@carbon/icons-react";
import { Modal } from "@/components/overlays";
import css from "./P/schedulers.module.scss";
import { localTime } from "@/lib/format";
import { usePerms } from "@/lib/perms";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "@/components/Select";
import { SqlEditor } from "@/components/SqlEditor";
import { useToast } from "@/components/Toast";
import { OpsPanel, OpsEmpty } from "@/components/OpsPanel";
import { api } from "@/lib/api";
import type { Datasource, Scheduler, SchedulerRun } from "@/lib/types";

const CRON_PRESETS: { value: string; label: string }[] = [
  { value: "0 */5 * * * *", label: "Every 5 minutes" },
  { value: "0 */15 * * * *", label: "Every 15 minutes" },
  { value: "0 0 * * * *", label: "Hourly (on the hour)" },
  { value: "0 0 2 * * *", label: "Daily at 02:00" },
  { value: "0 0 6 * * *", label: "Daily at 06:00" },
  { value: "0 30 0 * * *", label: "Daily at 00:30" },
  { value: "0 0 2 * * MON", label: "Weekly · Monday 02:00" },
  { value: "0 0 1 1 * *", label: "Monthly · 1st at 01:00" },
];

/** Word + colour per status — ink for everything that is behaving, colour only when it is not. */
const STATUS: Record<string, [string, string]> = {
  ok: ["var(--cds-text-primary)", "Succeeded"],
  error: ["var(--cds-support-error)", "Failed"],
  running: ["var(--cds-interactive)", "Running"],
  queued: ["var(--cds-text-secondary)", "Queued"],
  cancelled: ["var(--cds-text-placeholder)", "Cancelled"],
};
const TAG: Record<string, "green" | "red" | "blue" | "gray"> = { ok: "green", error: "red", running: "blue", queued: "gray", cancelled: "gray" };
const DAY: Record<string, string> = {
  SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday",
  THU: "Thursday", FRI: "Friday", SAT: "Saturday",
};

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  return localTime(ts);
}
function ago(ts: string | null | undefined): string {
  if (!ts) return "never run";
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
/** How long until the next fire — a countdown answers "is it about to run?" faster than a date. */
function until(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = (new Date(ts).getTime() - Date.now()) / 1000;
  if (d <= 0) return "due now";
  if (d < 60) return "in under a minute";
  if (d < 3600) return `in ${Math.round(d / 60)}m`;
  if (d < 86400) return `in ${Math.round(d / 3600)}h`;
  return `in ${Math.round(d / 86400)}d`;
}
function took(sec: number | null | undefined): string {
  if (sec == null) return "";
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
}
/** A run carries start + finish, not a duration — derive it once here. */
function runSeconds(r: SchedulerRun): number | null {
  if (!r.finishedAt) return null;
  return Math.max(0, Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000));
}

/**
 * A cron in plain words. The presets cover the common ones; this handles the hand-written shapes
 * that the presets miss, so a schedule is readable without decoding six fields. Returns null when
 * the expression is more complicated than a sentence, and the caller shows the raw cron instead.
 */
function cronPhrase(cron: string): string | null {
  const f = (cron ?? "").trim().split(/\s+/);
  if (f.length !== 6) return null;
  const [sec, min, hour, dom, mon, dow] = f;
  if (sec !== "0") return null;
  const two = (v: string) => v.padStart(2, "0");
  const every = /^\*\/(\d+)$/;
  const num = /^\d+$/;
  if (mon === "*" && dom === "*" && dow === "*") {
    const m = min.match(every);
    if (m && hour === "*") return `Every ${m[1]} minutes`;
    if (num.test(min) && hour === "*") return min === "0" ? "Every hour" : `Every hour at :${two(min)}`;
    if (num.test(min) && num.test(hour)) return `Every day at ${two(hour)}:${two(min)}`;
  }
  if (mon === "*" && dom === "*" && num.test(min) && num.test(hour) && /^[A-Za-z]{3}$/.test(dow)) {
    return `Every ${DAY[dow.toUpperCase()] ?? dow} at ${two(hour)}:${two(min)}`;
  }
  if (mon === "*" && dow === "*" && num.test(dom) && num.test(min) && num.test(hour)) {
    return `Day ${dom} of every month at ${two(hour)}:${two(min)}`;
  }
  return null;
}
function scheduleLabel(cron: string): string | null {
  return CRON_PRESETS.find((p) => p.value === cron)?.label ?? cronPhrase(cron);
}
function dsLabel(id: string | null, dss: Datasource[]): string {
  return id ? (dss.find((d) => d.id === id)?.name ?? id) : "internal warehouse";
}

const NAV_KEY = "rs.schedulers.navOpen";

export default function SchedulersPage() {
  const { can } = usePerms();
  const toast = useToast();
  const [rows, setRows] = useState<Scheduler[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [editing, setEditing] = useState<Scheduler | "new" | null>(null);
  /** Scheduler whose history is open — stored as id so the panel follows fresh data after reload */
  const [detailId, setDetailId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** Scheduler awaiting delete confirmation (Carbon danger modal instead of window.confirm) */
  const [confirmDel, setConfirmDel] = useState<Scheduler | null>(null);

  const reload = useCallback(() => {
    setLoadErr(null);
    api.schedulers().then(setRows).catch((e) => setLoadErr(e instanceof Error ? e.message : "Load failed"));
  }, []);
  useEffect(() => { reload(); api.datasources().then(setDss).catch(() => {}); }, [reload]);

  /** Left navigation panel (same layout as Data Warehouse / Run Flow). */
  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => { setNavOpen(localStorage.getItem(NAV_KEY) !== "0"); }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((v) => { localStorage.setItem(NAV_KEY, v ? "0" : "1"); return !v; });
  }, []);

  const shownRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((s) => !q || [s.name, s.description, s.cron, s.sqlText]
      .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rows, query]);

  /** Items for the left panel — schedulers have no folder column, so they are grouped by
      the datasource they write to. */
  const navItems = useMemo(() => shownRows.map((s) => {
    const live = s.lastStatus === "running" || s.lastStatus === "queued";
    const bad = s.lastStatus === "error";
    return {
      id: s.id, name: s.name, folder: dsLabel(s.datasourceId, dss), icon: "clock",
      mark: !s.enabled ? "var(--cds-text-placeholder)" : bad ? "var(--cds-support-error)" : live ? "var(--cds-support-warning)" : "var(--cds-support-success)",
      badge: live ? "running" : bad ? "failed" : !s.enabled ? "paused" : (scheduleLabel(s.cron) ?? s.cron),
      badgeColor: bad ? "var(--cds-support-error)" : live ? "var(--cds-support-warning)" : undefined,
      title: `${s.name}${s.description ? ` — ${s.description}` : ""}\n${scheduleLabel(s.cron) ?? s.cron}${s.enabled ? "" : " · paused"}`,
    };
  }), [shownRows, dss]);

  const detail = detailId == null ? null : (rows.find((s) => s.id === detailId) ?? null);

  async function toggle(s: Scheduler) {
    try { await api.toggleScheduler(s.id, !s.enabled); toast(s.enabled ? "Disabled" : "Enabled", "ok"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
  }
  async function runNow(s: Scheduler) {
    try { const r = await api.runScheduler(s.id); toast(r.status === "ok" ? `Ran · ${r.affected} row(s)` : `Error: ${r.message}`, r.status === "ok" ? "ok" : "error"); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Run failed", "error"); }
  }
  async function remove(s: Scheduler) {
    try { await api.deleteScheduler(s.id); toast("Deleted", "ok"); if (detailId === s.id) setDetailId(null); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  return (
    <div>
      <PageHeader title="Scheduled SQL"
                  actions={can("RH.SCHEDULER", "create") && (
                    <Button renderIcon={Add} onClick={() => { setDetailId(null); setEditing("new"); }}>New scheduler</Button>)} />

      {loadErr && <InlineNotification kind="error" title="Load failed" subtitle={loadErr} hideCloseButton lowContrast style={{ marginBottom: 16, maxWidth: "none" }} />}

      {/* Same layout as Tables / SQL Editor / Datasets — list on the left, the selected item on the right. */}
      <div className={"rh-ops rh-fill" + (navOpen ? "" : " rh-ops--rail-off") + (editing || detail ? " rh-ops--stack rh-ops--detail" : " rh-ops--stack")}>
        <OpsPanel
          items={navItems}
          selectedId={editing === "new" ? "__new__" : editing ? editing.id : detailId}
          onSelect={(it) => { setEditing(null); setDetailId(Number(it.id)); }}
          navOpen={navOpen} onToggleNav={toggleNav} storageKey="rs.schedulers.shutFolders"
          placeholder="Find a scheduler"
          query={query} onQuery={setQuery}
          foot={shownRows.length === rows.length ? `${rows.length} schedulers` : `${shownRows.length} of ${rows.length} schedulers`}
          emptyText="No schedulers yet"
        />

        <div className={css.pane}>
          {editing ? (
            <SchedulerEditor key={editing === "new" ? "new" : editing.id}
                             original={editing === "new" ? null : editing} datasources={dss} toast={toast}
                             onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
          ) : detail ? (
            <SchedulerDetail key={detail.id} s={detail} dss={dss}
                             onRun={() => runNow(detail)} onEdit={() => setEditing(detail)}
                             onToggle={() => toggle(detail)} onDelete={() => setConfirmDel(detail)} />
          ) : (
            <OpsEmpty icon="clock" title="Select a scheduler" />
          )}
        </div>
      </div>

      {confirmDel && (
        <Modal title={`Delete scheduler "${confirmDel.name}"?`} danger width={400} onClose={() => setConfirmDel(null)}
               foot={<>
                 <Button kind="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
                 <Button kind="danger" onClick={() => { const s = confirmDel; setConfirmDel(null); remove(s); }}>Delete</Button>
               </>}>
          <p className="cds--type-body-01">{confirmDel.description || confirmDel.name}</p>
        </Modal>
      )}
    </div>
  );
}

/**
 * Run history of one scheduler: past runs as small cards on the left, the selected run on the
 * right — its result, full message, and the statement it ran (the first thing to read when the
 * latest run failed).
 */
function SchedulerDetail({ s, dss, onRun, onEdit, onToggle, onDelete }: {
  s: Scheduler; dss: Datasource[]; onRun: () => Promise<void>;
  onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const { can } = usePerms();
  const [runs, setRuns] = useState<SchedulerRun[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.schedulerRuns(s.id).then((r) => {
      setRuns(r);
      setPick((cur) => (cur != null && r.some((x) => x.id === cur) ? cur : r[0]?.id ?? null));
    }).catch(() => setRuns([]));
  }, [s.id]);
  useEffect(load, [load]);

  const current = runs?.find((r) => r.id === pick) ?? null;
  const readable = scheduleLabel(s.cron);

  async function run() {
    setBusy(true);
    try { await onRun(); load(); } finally { setBusy(false); }
  }

  return (
    // Rendered inside the right panel: no backdrop or close button; select another item to close.
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div className={css.head}>
        <div className={css.headText}>
          <h2 className={`cds--type-heading-03 ${css.ellipsis}`}>{s.name}</h2>
          <div className={`cds--type-label-01 rh-dim ${css.ellipsis}`}>
            {dsLabel(s.datasourceId, dss)}
            {" · "}<span title={s.cron}>{readable ?? s.cron}</span>
            {s.enabled && s.nextRunAt
              ? <>{" · "}<span title={fmt(s.nextRunAt)}>next {until(s.nextRunAt)}</span></>
              : !s.enabled ? <>{" · "}paused</> : null}
          </div>
        </div>
        <Button size="md" renderIcon={Play} disabled={busy} onClick={run}>Run now</Button>
        <IconButton kind="ghost" label={s.enabled ? "Pause" : "Enable"} align="bottom" onClick={onToggle}>
          {s.enabled ? <Pause /> : <Play />}
        </IconButton>
        {can("RH.SCHEDULER", "update") && (<IconButton kind="ghost" label="Settings" align="bottom" onClick={onEdit}><Edit /></IconButton>)}
        {can("RH.SCHEDULER", "delete") && (<IconButton kind="ghost" label="Delete" align="bottom-end" onClick={onDelete}><TrashCan /></IconButton>)}
      </div>

      <div className={css.body}>
        {/* Left: past runs */}
        <div className={css.runs}>
          <div className={`cds--type-label-01 ${css.runsTitle}`}>Run history</div>
          {runs === null && <div style={{ padding: 16 }}><Skeleton /></div>}
          {runs?.length === 0 && <div className="cds--type-label-01 rh-dim" style={{ padding: 16 }}>Never run</div>}
          {runs?.map((r) => {
            const [tone, text] = STATUS[r.status] ?? ["var(--cds-text-secondary)", r.status];
            const on = r.id === pick;
            const sec = runSeconds(r);
            return (
              <button type="button" key={r.id} onClick={() => setPick(r.id)} className={css.run + (on ? " " + css.runOn : "")}>
                <span className={css.dot} style={{ background: tone }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="cds--type-heading-compact-01" style={{ display: "block", color: tone }}>{text}</span>
                  <span className="cds--type-label-01 rh-dim" style={{ display: "block" }} title={fmt(r.startedAt)}>
                    {ago(r.startedAt)}{sec != null ? " · " + took(sec) : ""}
                  </span>
                  {r.affected != null && r.affected >= 0 && (
                    <span className="cds--type-code-01 rh-dim" style={{ display: "block" }}>{r.affected.toLocaleString("en-US")} rows</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right: the selected run — result, full message and the statement it ran */}
        <div className={css.main}>
          {!current && <div className="cds--type-body-01 rh-dim" style={{ padding: 32, textAlign: "center" }}>Not run yet</div>}
          {current && (
            <>
              <div className={css.summary}>
                <div>
                  {current.affected != null && current.affected >= 0
                    ? <div><span className={css.big}>{current.affected.toLocaleString("en-US")}</span> <span className="cds--type-label-01 rh-dim">rows affected</span></div>
                    : <div className="cds--type-heading-03">no row count <span className="cds--type-label-01 rh-dim">a PL/SQL block returns none</span></div>}
                  <div style={{ marginTop: 4 }}>
                    <Tag size="sm" type={TAG[current.status] ?? "gray"}>{STATUS[current.status]?.[1] ?? current.status}</Tag>
                  </div>
                </div>
                <div className={`cds--type-label-01 ${css.meta}`}>
                  <div>Started <span className="cds--type-code-01">{fmt(current.startedAt)}</span></div>
                  <div>Finished <span className="cds--type-code-01">{fmt(current.finishedAt)}</span>
                    {runSeconds(current) != null ? ` · ${took(runSeconds(current))}` : ""}</div>
                  <div>{current.trigger === "manual" ? "Run by hand" : "Run by the schedule"}
                    {current.runBy ? ` · ${current.runBy}` : ""}</div>
                </div>
              </div>

              {current.message && (
                current.status === "error"
                  ? <InlineNotification kind="error" title="Run failed" subtitle={current.message} hideCloseButton lowContrast style={{ maxWidth: "none", whiteSpace: "pre-wrap", wordBreak: "break-word" }} />
                  : <InlineNotification kind="info" title="" subtitle={current.message} hideCloseButton lowContrast style={{ maxWidth: "none", whiteSpace: "pre-wrap", wordBreak: "break-word" }} />
              )}

              {/* The statement that ran — shown here so a failed run can be read without opening the editor */}
              <div>
                <div className={`cds--type-label-01 ${css.label}`}>The statement it runs</div>
                <CodeSnippet type="multi" feedback="Copied" wrapText={false} maxCollapsedNumberOfRows={30}>{s.sqlText}</CodeSnippet>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SchedulerEditor({ original, datasources, toast, onClose, onSaved }: {
  original: Scheduler | null; datasources: Datasource[]; toast: ReturnType<typeof useToast>;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [datasourceId, setDatasourceId] = useState(original?.datasourceId ?? "");
  const [sql, setSql] = useState(original?.sqlText ?? "");
  const [cron, setCron] = useState(original?.cron ?? "0 0 2 * * *");
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const presetValue = CRON_PRESETS.some((p) => p.value === cron) ? cron : "";

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    if (!sql.trim()) { toast("SQL is required", "error"); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, datasourceId: datasourceId || null, sqlText: sql, cron: cron.trim(), enabled };
      if (original) await api.updateScheduler(original.id, body);
      else await api.createScheduler(body);
      toast("Scheduler saved", "ok");
      onSaved();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); setSaving(false); }
  }

  return (
    <div className={css.editor}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <h2 className="cds--type-heading-03" style={{ flex: 1, minWidth: 0 }}>{original ? `Edit scheduler · ${original.name}` : "New scheduler"}</h2>
        <Button kind="ghost" size="sm" renderIcon={Close} onClick={onClose}>Close</Button>
      </div>

      <div className={css.grid3}>
        <TextInput id="sch-name" labelText="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Build external system staging" />
        <TextInput id="sch-desc" labelText="Description" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} />
        <Select label="Target datasource" value={datasourceId} onChange={setDatasourceId} placeholder="Internal warehouse"
                options={[{ value: "", label: "Report Studio internal database" },
                          ...datasources.map((d) => ({ value: d.id, label: `${d.name}${d.hasJdbc ? " · live JDBC" : ""}` }))]} />
      </div>

      <div className={css.grid2}>
        <Select label="Schedule (preset)" value={presetValue} onChange={setCron} placeholder="Custom"
                options={[{ value: "", label: "Custom (cron expression)" }, ...CRON_PRESETS]} />
        <TextInput id="sch-cron" className={css.mono} labelText="Cron expression (sec min hour day month weekday)" value={cron}
                   onChange={(e) => setCron(e.target.value)} placeholder="0 0 2 * * *"
                   helperText={scheduleLabel(cron) ?? "Custom schedule"} />
      </div>

      <div>
        <div className={`cds--label`}>SQL statement (INSERT / UPDATE / DELETE / MERGE) · single statement, runs against the target datasource</div>
        <SqlEditor value={sql} onChange={setSql} height={252} vars={["$YEAR4", "$YEAR2"]}
                   placeholder={"INSERT INTO staging_to_warehouse (...)\nSELECT ... FROM ..."} />
      </div>

      <div className={css.foot}>
        <Checkbox id="sch-enabled" labelText="Enabled (run automatically on schedule)" checked={enabled}
                  onChange={(_, { checked }) => setEnabled(checked)} />
        <Button renderIcon={Checkmark} disabled={saving} onClick={save}>Save scheduler</Button>
      </div>
    </div>
  );
}
