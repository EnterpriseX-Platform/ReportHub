"use client";

import { copyText } from "@/lib/clipboard";
import { errMsg } from "@/lib/api";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Button, ButtonSet, CodeSnippet, IconButton, InlineNotification, ProgressBar, ProgressIndicator, ProgressStep,
  StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, Tag, Tile,
} from "@carbon/react";
import { Copy, Download, Pause, Play, Renew, Close, View, WarningAltFilled } from "@carbon/icons-react";
import { MetricCard, MiniStat, StatusIcon, FmtTag, PageHeader } from "@/components/ui";
import { DataList } from "@/components/DataList";
import { Modal, SlideOver } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { api, saveAs } from "@/lib/api";
import type { Datasource, Job, QueueStats } from "@/lib/types";

type LJob = Job & { _seq?: number };

export default function QueueMonitorPage() {
  const [jobs, setJobs] = useState<LJob[]>([]);
  /** First poll answered — until then show placeholders, not "0" and "No jobs in the queue". */
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [paused, setPaused] = useState(false);
  const [sel, setSel] = useState<LJob | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<LJob | null>(null);
  const [dsMap, setDsMap] = useState<Record<string, Datasource>>({});
  const toast = useToast();
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.datasources().then((d) => setDsMap(Object.fromEntries(d.map((x) => [x.id, x])))).catch(() => {});
  }, []);

  // Live poll of GET /jobs + queue stats every ~1.5s.
  useEffect(() => {
    let stopped = false;
    const refresh = () => {
      api.jobs({ limit: 50 }).then((j) => { if (!stopped) { setJobs(j); setLoaded(true); } }).catch(() => { if (!stopped) setLoaded(true); });
      api.queueStats().then((s) => { if (!stopped) setStats(s); }).catch(() => {});
    };
    refresh();
    if (!paused) poll.current = setInterval(refresh, 1500);
    return () => { stopped = true; if (poll.current) clearInterval(poll.current); };
  }, [paused]);

  // Keep the open slide-over in sync with the polled list.
  useEffect(() => {
    setSel((s) => (s ? jobs.find((j) => j.id === s.id) ?? s : s));
  }, [jobs]);

  const stageCounts = useMemo(() => {
    if (stats?.pipeline) {
      return { ingress: 0, queue: 0, worker: 0, jasper: 0, store: 0, ...stats.pipeline };
    }
    const c: Record<string, number> = { ingress: 0, queue: 0, worker: 0, jasper: 0, store: 0 };
    jobs.forEach((j) => { if (j.state !== "done") c[j.stage] = (c[j.stage] || 0) + 1; });
    c.ingress = jobs.filter((j) => j.state === "queued").length;
    return c;
  }, [jobs, stats]);

  const active = jobs.filter((j) => j.state === "running" || j.state === "queued");
  const done = jobs.filter((j) => j.state === "done");
  const errored = jobs.filter((j) => j.state === "error" && !isCancelled(j));

  async function retry(id: string) {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, state: "queued", stage: "queue", progress: 0 } : j)));
    try {
      await api.retryJob(id);
      toast("Job re-queued", "ok");
    } catch (e) {
      toast(errMsg(e, "Retry failed"), "error");
    }
  }
  async function cancel(id: string) {
    try {
      const updated = await api.cancelJob(id);
      setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...updated } : j)));
      toast("Job cancelled");
    } catch (e) {
      toast(errMsg(e, "Cancel failed"), "error");
    }
  }
  async function download(job: Job) {
    try {
      const outs = await api.outputs();
      const out = outs.find((o) => o.jobId === job.id) ?? outs.find((o) => o.reportCode === job.reportCode);
      if (!out) { toast("No stored artifact for this job", "error"); return; }
      await api.downloadOutput(out.objectKey, out.objectKey.split("/").pop() || out.objectKey);
    } catch (e) {
      toast(errMsg(e, "Download failed"), "error");
    }
  }

  const lag = stats?.consumerLag ?? stageCounts.queue;
  return (
    <div className="fade-in">
      <PageHeader
        title="Queue Monitor"
        sub="Live render pipeline"
        actions={<>
          {/* Paused must not look like the green "streaming" tag */}
          <Tag type={paused ? "gray" : "green"} size="md">{paused ? "paused" : "streaming"}</Tag>
          <Button kind="secondary" renderIcon={paused ? Play : Pause} onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</Button>
        </>}
      />

      <div className="rh-metric-grid" style={{ marginBottom: "var(--cds-spacing-05)" }}>
        <MetricCard icon="bolt" label="Active jobs" value={loaded ? stats?.active ?? active.length : "—"} tone="accent" />
        <MetricCard icon="checkCircle" label="Completed (1h)" value={loaded ? stats?.completedLastHour ?? done.length : "—"} tone="green" />
        <MetricCard icon="clock" label="Avg wait time" value={loaded ? stats ? `${(stats.avgWaitMs / 1000).toFixed(1)} s` : "—" : "—"} tone="accent" />
        <MetricCard icon="alert" label="Queue backlog" value={loaded ? `${lag} waiting` : "—"} tone={lag > 3 ? "amber" : "green"} />
        <MetricCard icon="alert" label="Failed (1h)" value={loaded ? stats?.failedLastHour ?? errored.length : "—"} tone={(stats?.failedLastHour ?? errored.length) > 0 ? "red" : "green"} />
        <MetricCard icon="x" label="Cancelled (1h)" value={loaded ? stats?.cancelledLastHour ?? jobs.filter(isCancelled).length : "—"} tone="accent" />
      </div>

      <div className="rh-queue-layout">
        <div style={{ minWidth: 0 }}>
          <DataList<LJob>
            title="Live jobs"
            description={`${stats?.active ?? active.length} active · ${stats?.failedLastHour ?? errored.length} failed (1h)`}
            rows={jobs}
            loading={!loaded}
            searchText={(j) => `${j.reportName} ${j.reportCode}`}
            size="md"
            pageSize={50}
            empty="No jobs in the queue"
            onRowClick={(j) => setSel(j)}
            columns={[
              { key: "reportName", header: "Job", render: (j) => (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)" }}>
                  <StatusIcon s={isCancelled(j) ? "cancelled" : j.state} />
                  <div style={{ minWidth: 0 }}>
                    <div className="rh-ellipsis" style={{ maxWidth: 280, fontWeight: sel?.id === j.id ? 600 : undefined }}>{j.reportName}</div>
                    <div className="cds--type-code-01 rh-dim">{j.reportCode} · {j.id} · {j.fmt}</div>
                  </div>
                </div>
              ) },
              { key: "stage", header: "Stage", render: (j) => <StageBadge stage={j.stage} state={isCancelled(j) ? "cancelled" : j.state} /> },
              { key: "progress", header: "Progress", width: 180, render: (j) => (
                isCancelled(j) ? <span className="rh-dim" style={{ fontStyle: "italic" }}>cancelled</span>
                  : j.state === "done" ? (j.warning
                    ? <span title={j.warning} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><WarningAltFilled style={{ fill: "var(--cds-support-warning)" }} /> warning</span>
                    : <span className="rh-dim">—</span>)
                  : j.state === "error" ? <span style={{ color: "var(--cds-text-error)" }}>failed</span>
                  : j.state === "queued" ? <span className="rh-dim">waiting…</span>
                  : <ProgressBar label={`${j.reportCode} progress`} hideLabel size="small" value={j.progress} max={100} helperText={`${j.progress}%`} />
              ) },
              { key: "priority", header: "Priority", render: (j) => <span style={{ textTransform: "capitalize", fontWeight: j.priority === "high" ? 600 : undefined }}>{j.priority ?? "normal"}</span> },
              { key: "requestedBy", header: "By", render: (j) => <span className="cds--type-code-01 rh-dim">{j.requestedBy}</span> },
            ]}
            rowActions={(j) => (
              <>
                {(j.state === "error" || j.state === "cancelled") && <IconButton kind="ghost" size="sm" align="left" label="Retry" onClick={() => retry(j.id)}><Renew /></IconButton>}
                {(j.state === "running" || j.state === "queued") && <IconButton kind="ghost" size="sm" align="left" label="Cancel" onClick={() => setConfirmCancel(j)}><Close /></IconButton>}
                {j.state === "done" && <IconButton kind="ghost" size="sm" align="left" label="Download" onClick={() => download(j)}><Download /></IconButton>}
              </>
            )}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--cds-spacing-05)" }}>
          <Tile>
            <ProgressBar label="Waiting for a worker" value={Math.min(100, lag * 10)} max={100}
                         helperText={`${lag} waiting`} />
          </Tile>
          <Tile>
            <h3 className="cds--type-heading-compact-01">Render workers</h3>
            <p className="cds--type-helper-text-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-03)" }}>
              {(stats?.workersActive ?? 0)}/{(stats?.workerConcurrency ?? 0)} rendering
              {(stats?.workersQueued ?? 0) > 0 ? ` · ${stats?.workersQueued} waiting` : ""}
            </p>
            {(stats?.workerConcurrency ?? 0) > 0 ? (
              <StructuredListWrapper isCondensed className="rh-slist" aria-label="Render workers">
                <StructuredListBody>
                  {Array.from({ length: stats?.workerConcurrency ?? 0 }).map((_, i) => {
                    const rendering = i < (stats?.workersActive ?? 0);
                    return (
                      <StructuredListRow key={i}>
                        <StructuredListCell className="cds--type-code-01">worker-{String(i + 1).padStart(2, "0")}</StructuredListCell>
                        <StructuredListCell style={{ textAlign: "right" }}>
                          <Tag size="sm" type={rendering ? "green" : "gray"}>{rendering ? "rendering" : "idle"}</Tag>
                        </StructuredListCell>
                      </StructuredListRow>
                    );
                  })}
                </StructuredListBody>
              </StructuredListWrapper>
            ) : <span className="rh-dim">—</span>}
          </Tile>
        </div>
      </div>

      {confirmCancel && (
        <Modal title="Cancel job" sub={`${confirmCancel.reportCode} · ${confirmCancel.id}`} width={460} danger
               onClose={() => setConfirmCancel(null)}
               foot={<>
                 <Button kind="secondary" onClick={() => setConfirmCancel(null)}>Keep running</Button>
                 <Button kind="danger" onClick={() => { const id = confirmCancel.id; setConfirmCancel(null); void cancel(id); }}>Cancel job</Button>
               </>}>
          <div className="cds--type-body-01">Stop {confirmCancel.reportName}? No file is produced for a cancelled job.</div>
        </Modal>
      )}
      {sel && <JobDetail job={sel} dsName={sel.datasourceId ? dsMap[sel.datasourceId]?.name ?? sel.datasourceId : "—"} onClose={() => setSel(null)} onRetry={retry} />}
    </div>
  );
}

/** Stage the job is in
 *
 * Plain text normally; coloured only on failure, so finished rows do not show two green chips
 * saying the same thing as the state column. */
function StageBadge({ stage, state }: { stage: string; state: string }) {
  if (state === "queued") return <span className="rh-dim">queued</span>;
  if (state === "done") return <span className="rh-dim">stored</span>;
  if (state === "cancelled") return <Tag size="sm" type="outline">cancelled</Tag>;
  if (state === "error") return <span style={{ color: "var(--cds-text-error)" }}>failed{stage ? ` at ${stage}` : ""}</span>;
  // The render stage carries the engine name (jasper, sql, docbuilder, ...).
  return <span>{stage || "—"}</span>;
}

function JobDetail({ job, dsName, onClose, onRetry }: { job: LJob; dsName: string; onClose: () => void; onRetry: (id: string) => void; }) {
  const toast = useToast();
  const started = new Date(job.startedAt).toLocaleTimeString("en-GB");
  // Render/store finish time = when the artifact was written (the job record has no finish time).
  const [storedAt, setStoredAt] = useState<string | null>(null);
  useEffect(() => {
    if (job.state !== "done") { setStoredAt(null); return; }
    let live = true;
    api.outputs().then((outs) => {
      const o = outs.find((x) => x.jobId === job.id);
      if (live && o) setStoredAt(new Date(o.createdAt).toLocaleTimeString("en-GB"));
    }).catch(() => {});
    return () => { live = false; };
  }, [job.id, job.state]);

  async function downloadLog() {
    try {
      const text = await api.jobLog(job.id);
      saveAs(new Blob([text], { type: "text/plain;charset=utf-8" }), `${job.id}.log`);
    } catch (e) {
      toast(errMsg(e, "Could not fetch log"), "error");
    }
  }
  async function copyLog() {
    try {
      const text = await api.jobLog(job.id);
      if (!(await copyText(text))) throw new Error("The browser did not allow copying");
      toast("Log copied to clipboard", "ok");
    } catch (e) {
      toast(errMsg(e, "Could not copy log"), "error");
    }
  }
  const steps = [
    { k: "Submitted", t: started, ok: true },
    { k: "Queued", t: started, ok: true },
    { k: "Picked by worker", t: job.state === "queued" ? null : started, ok: job.state !== "queued" },
    { k: "Render" + (isEngineStage(job.stage) ? ` · ${job.stage}` : ""), t: isEngineStage(job.stage) || job.stage === "store" || job.state === "done" ? (job.state === "done" ? (storedAt ?? "completed") : "in progress") : null, ok: isEngineStage(job.stage) || job.stage === "store" || job.state === "done" },
    { k: "Stored to S3 / MinIO", t: job.state === "done" ? (storedAt ?? "completed") : null, ok: job.state === "done" },
  ];
  return (
    <SlideOver title={job.reportName} sub={job.id + " · " + job.reportCode} badge={<StageBadge stage={job.stage} state={job.state} />} onClose={onClose}
      foot={
        <ButtonSet className="rh-foot-set">
          <Button kind="secondary" onClick={onClose}>Close</Button>
          {job.state === "done" && <Button kind="secondary" renderIcon={View} as={Link} href="/outputs">Output Files</Button>}
          <Button kind={job.state === "error" || job.state === "cancelled" ? "secondary" : "primary"} renderIcon={Play} as={Link}
                  href={`/runtask?code=${encodeURIComponent(job.reportCode)}`}>Run again</Button>
          {(job.state === "error" || job.state === "cancelled") && <Button kind="primary" renderIcon={Renew} onClick={() => { onRetry(job.id); onClose(); }}>Retry</Button>}
        </ButtonSet>
      }
    >
      <div className="rh-ministats" style={{ marginBottom: "var(--cds-spacing-06)" }}>
        <MiniStat label="Format" value={<FmtTag f={job.fmt} />} />
        <MiniStat label="Datasource" value={dsName} />
        <MiniStat label="Requested by" value={job.requestedBy} />
        <MiniStat label="Priority" value={job.priority} />
      </div>
      <h3 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-05)" }}>Pipeline trace</h3>
      <ProgressIndicator vertical currentIndex={Math.max(0, steps.findIndex((x) => !x.ok))}>
        {steps.map((x, i) => (
          <ProgressStep key={i} label={x.k} secondaryLabel={x.t ?? undefined} complete={x.ok}
                        current={!x.ok && i === steps.findIndex((y) => !y.ok)}
                        invalid={job.state === "error" && !x.ok && i === steps.findIndex((y) => !y.ok)} />
        ))}
      </ProgressIndicator>
      {job.warning && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Warning" subtitle={job.warning}
                            style={{ marginTop: "var(--cds-spacing-05)", maxWidth: "none" }} />
      )}
      {job.state === "error" && (
        <div style={{ marginTop: "var(--cds-spacing-05)" }}>
          <InlineNotification kind="error" lowContrast hideCloseButton style={{ maxWidth: "none" }}
                              title={job.datasourceId ? "Cancelled / render failed" : "Render failed"}
                              subtitle={job.errorMessage ? undefined : "Job was cancelled or no error details available. Use Retry to re-queue."} />
          {job.errorMessage && <CodeSnippet type="multi" feedback="Copied" wrapText>{job.errorMessage}</CodeSnippet>}
          <div style={{ display: "flex", marginTop: "var(--cds-spacing-03)" }}>
            <Button kind="tertiary" size="sm" renderIcon={Download} onClick={downloadLog}>Download log</Button>
            <Button kind="ghost" size="sm" renderIcon={Copy} onClick={copyLog}>Copy log</Button>
          </div>
          <p className="cds--type-helper-text-01 rh-dim" style={{ marginTop: "var(--cds-spacing-02)" }}>Full run log: cause chain + stack trace, up to ~1000 lines.</p>
        </div>
      )}
    </SlideOver>
  );
}

/** Stages other than the fixed pipeline steps are the engine doing the render. */
function isEngineStage(stage: string): boolean {
  return !!stage && !["ingress", "queue", "worker", "store"].includes(stage);
}

/** Cancelled jobs: the backend may send state "cancelled", or (older builds) an error whose message says so. */
function isCancelled(j: { state: string; errorMessage: string | null }): boolean {
  return j.state === "cancelled" || (j.state === "error" && /cancel/i.test(j.errorMessage ?? ""));
}
