"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { MetricCard, MiniStat, JobStateDot, FmtTag } from "@/components/ui";
import { SlideOver } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { PIPELINE } from "@/lib/model";
import { api } from "@/lib/api";
import type { Datasource, Job, QueueStats } from "@/lib/types";

type LJob = Job & { _seq?: number };

export default function QueueMonitorPage() {
  const [jobs, setJobs] = useState<LJob[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [paused, setPaused] = useState(false);
  const [sel, setSel] = useState<LJob | null>(null);
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
      api.jobs({ limit: 50 }).then((j) => { if (!stopped) setJobs(j); }).catch(() => {});
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
  const errored = jobs.filter((j) => j.state === "error");

  async function retry(id: string) {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, state: "queued", stage: "queue", progress: 0 } : j)));
    try {
      await api.retryJob(id);
      toast("Job re-queued", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Retry failed", "error");
    }
  }
  async function cancel(id: string) {
    try {
      const updated = await api.cancelJob(id);
      setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...updated } : j)));
      toast("Job cancelled");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Cancel failed", "error");
    }
  }
  async function download(job: Job) {
    try {
      const outs = await api.outputs();
      const out = outs.find((o) => o.jobId === job.id) ?? outs.find((o) => o.reportCode === job.reportCode);
      if (!out) { toast("No stored artifact for this job", "error"); return; }
      await api.downloadOutput(out.objectKey);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Download failed", "error");
    }
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Queue Monitor</h1>
          <div className="page-sub">Kafka gateway · live render pipeline · topic <span className="mono">report.jobs</span></div>
        </div>
        <div className="page-actions">
          <span className="chip green pulse"><i className="led" />{paused ? "paused" : "streaming"}</span>
          <button className="btn" onClick={() => setPaused((p) => !p)}><Icon name={paused ? "play" : "pause"} size={15} />{paused ? "Resume" : "Pause"}</button>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <MetricCard icon="bolt" label="Active jobs" value={stats?.active ?? active.length} tone="accent" />
        <MetricCard icon="checkCircle" label="Completed (1h)" value={stats?.completedLastHour ?? done.length} tone="green" />
        <MetricCard icon="clock" label="Avg wait time" value={stats ? `${(stats.avgWaitMs / 1000).toFixed(1)} s` : "—"} tone="accent" />
        <MetricCard icon="alert" label="Consumer lag" value={`${stats?.consumerLag ?? stageCounts.queue} msg`} tone={(stats?.consumerLag ?? stageCounts.queue) > 3 ? "amber" : "green"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 16, alignItems: "start" }}>
        <div className="card">
          <div className="card-head">
            <div style={{ flex: 1 }}><h3>Live jobs</h3></div>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{active.length} active · {errored.length} error</span>
          </div>
          <div style={{ maxHeight: "calc(100vh - 470px)", overflow: "auto" }}>
            <table className="tbl">
              <thead><tr><th>Job</th><th>Stage</th><th style={{ width: 150 }}>Progress</th><th>By</th><th>Part.</th><th /></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} onClick={() => setSel(j)} className={sel?.id === j.id ? "sel" : ""}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <JobStateDot state={j.state} />
                        <div style={{ minWidth: 0 }}>
                          <div className="strong" style={{ maxWidth: 280, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j.reportName}</div>
                          <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{j.id} · <span style={{ color: "var(--ink-3)" }}>{j.fmt}</span></div>
                        </div>
                      </div>
                    </td>
                    <td><StageBadge stage={j.stage} state={j.state} /></td>
                    <td>
                      {j.state === "done" ? <span className="chip green" style={{ height: 19 }}>done</span>
                        : j.state === "error" ? <span className="chip red" style={{ height: 19 }}>failed</span>
                        : j.state === "queued" ? <span style={{ color: "var(--ink-4)", fontSize: 12 }}>waiting…</span>
                        : <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div className="bar" style={{ flex: 1 }}><i style={{ width: j.progress + "%" }} /></div><span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", width: 30 }}>{j.progress}%</span></div>}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{j.requestedBy}</td>
                    <td className="mono" style={{ color: "var(--ink-4)" }}>P{j.partition}</td>
                    <td style={{ width: 80 }} onClick={(e) => e.stopPropagation()}>
                      {j.state === "error" && <button className="btn sm ghost" onClick={() => retry(j.id)}><Icon name="refresh" size={13} /></button>}
                      {(j.state === "running" || j.state === "queued") && <button className="btn sm ghost" onClick={() => cancel(j.id)}><Icon name="x" size={13} /></button>}
                      {j.state === "done" && <button className="btn sm ghost" onClick={() => download(j)}><Icon name="download" size={13} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card card-pad">
            <div className="section-label" style={{ marginTop: 0 }}>Partitions</div>
            {[0, 1, 2, 3].map((p) => {
              const load = jobs.filter((j) => j.partition === p && j.state !== "done").length;
              return (
                <div key={p} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
                  <span className="mono" style={{ fontSize: 11.5, width: 26, color: "var(--ink-3)" }}>P{p}</span>
                  <div className="bar" style={{ flex: 1 }}><i style={{ width: Math.min(100, load * 33) + "%", background: load > 2 ? "var(--amber)" : "var(--accent)" }} /></div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", width: 14 }}>{load}</span>
                </div>
              );
            })}
          </div>
          <div className="card card-pad">
            <div className="section-label" style={{ marginTop: 0 }}>Consumers</div>
            {["worker-01", "worker-02", "worker-03", "worker-04"].map((w, i) => (
              <div key={w} style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
                <span className={i === 3 ? "" : "pulse"} style={{ width: 7, height: 7, borderRadius: 7, background: i === 3 ? "var(--ink-4)" : "var(--green)", display: "inline-block" }} />
                <span className="mono" style={{ fontSize: 11.5, flex: 1, color: "var(--ink-2)" }}>{w}</span>
                <span style={{ fontSize: 11, color: "var(--ink-4)" }}>{i === 3 ? "idle" : "rendering"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {sel && <JobDetail job={sel} dsName={sel.datasourceId ? dsMap[sel.datasourceId]?.name ?? sel.datasourceId : "—"} onClose={() => setSel(null)} onRetry={retry} />}
    </div>
  );
}

function PipelineNode({ icon, label, sub, count, active }: { icon: IconName; label: string; sub: string; count: number; active: boolean }) {
  return (
    <div style={{ flex: 1, textAlign: "center", position: "relative" }}>
      <div style={{ width: 56, height: 56, margin: "0 auto", borderRadius: 15, background: "var(--surface-2)", border: "1px solid var(--line)", display: "grid", placeItems: "center", color: "var(--accent)", position: "relative", boxShadow: "var(--shadow-sm)" }}>
        <Icon name={icon} size={24} />
        {count > 0 && <span className={active ? "pulse" : ""} style={{ position: "absolute", top: -7, right: -7, minWidth: 20, height: 20, padding: "0 5px", borderRadius: 20, background: "var(--accent)", color: "#fff", fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center", border: "2px solid var(--surface)" }}>{count}</span>}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 9 }}>{label}</div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 1 }}>{sub}</div>
    </div>
  );
}

function PipelineLink({ active }: { active: boolean }) {
  return (
    <div style={{ flex: "0 0 54px", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 24, overflow: "hidden" }}>
      <svg width="54" height="10" viewBox="0 0 54 10">
        <line x1="2" y1="5" x2="52" y2="5" stroke="var(--line-strong)" strokeWidth="2" strokeDasharray="3 4" />
        {active && <circle r="3" fill="var(--accent)"><animate attributeName="cx" from="2" to="52" dur="1.4s" repeatCount="indefinite" /></circle>}
      </svg>
    </div>
  );
}

function StageBadge({ stage, state }: { stage: string; state: string }) {
  if (state === "queued") return <span className="chip slate" style={{ height: 20 }}>queued</span>;
  if (state === "done") return <span className="chip green" style={{ height: 20 }}>stored</span>;
  if (state === "error") return <span className="chip red" style={{ height: 20 }}>worker</span>;
  const labels: Record<string, [string, string]> = { queue: ["Kafka", "blue"], worker: ["worker", "violet"], jasper: ["jasper", "amber"], store: ["store", "green"] };
  const [l, t] = labels[stage] ?? ["—", "slate"];
  return <span className={"chip " + t} style={{ height: 20 }}>{l}</span>;
}

function JobDetail({ job, dsName, onClose, onRetry }: { job: LJob; dsName: string; onClose: () => void; onRetry: (id: string) => void; }) {
  const started = new Date(job.startedAt).toLocaleTimeString("en-GB");
  const steps = [
    { k: "Received at gateway", t: started, ok: true },
    { k: "Enqueued · partition P" + job.partition, t: started, ok: true },
    { k: "Picked by worker", t: job.state === "queued" ? null : started, ok: job.state !== "queued" },
    { k: "Jasper render", t: ["jasper", "store"].includes(job.stage) || job.state === "done" ? "in progress" : null, ok: ["jasper", "store"].includes(job.stage) || job.state === "done" },
    { k: "Stored to S3 / MinIO", t: job.state === "done" ? "completed" : null, ok: job.state === "done" },
  ];
  return (
    <SlideOver title={job.reportName} sub={job.id + " · " + job.reportCode} badge={<StageBadge stage={job.stage} state={job.state} />} onClose={onClose}
      foot={<>
        {job.state === "error" && <button className="btn primary" onClick={() => { onRetry(job.id); onClose(); }}><Icon name="refresh" size={15} />Retry</button>}
        <Link className="btn" href={`/runtask?code=${encodeURIComponent(job.reportCode)}`}><Icon name="play" size={14} />Run again</Link>
        {job.state === "done" && <Link className="btn" href="/outputs"><Icon name="viewer" size={14} />Output Files</Link>}
        <button className="btn" onClick={onClose}>Close</button></>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
        <MiniStat label="Format" value={<FmtTag f={job.fmt} />} />
        <MiniStat label="Datasource" value={dsName} />
        <MiniStat label="Requested by" value={job.requestedBy} />
        <MiniStat label="Priority" value={job.priority} />
      </div>
      <div className="section-label">Pipeline trace</div>
      <div style={{ position: "relative", paddingLeft: 8 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 12, paddingBottom: 18, position: "relative" }}>
            {i < steps.length - 1 && <span style={{ position: "absolute", left: 8, top: 18, bottom: 0, width: 2, background: s.ok ? "var(--green)" : "var(--line)" }} />}
            <span style={{ width: 18, height: 18, borderRadius: 18, flex: "none", display: "grid", placeItems: "center", background: s.ok ? "var(--green)" : "var(--surface-3)", color: "#fff", zIndex: 1 }}>
              {s.ok ? <Icon name="check" size={11} /> : <span style={{ width: 5, height: 5, borderRadius: 5, background: "var(--ink-4)" }} />}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: s.ok ? "var(--ink)" : "var(--ink-4)", fontWeight: 500 }}>{s.k}</div>
              {s.t && <div className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{s.t}</div>}
            </div>
          </div>
        ))}
      </div>
      {job.state === "error" && (
        <div style={{ marginTop: 8, background: "var(--red-bg)", border: "1px solid color-mix(in srgb, var(--red) 25%, var(--line))", borderRadius: 10, padding: 14 }}>
          <div style={{ display: "flex", gap: 9, alignItems: "center", color: "var(--red)", fontWeight: 600, fontSize: 13, marginBottom: 6 }}><Icon name="alert" size={16} />{job.datasourceId ? "Cancelled / render failed" : "Render failed"}</div>
          {job.errorMessage
            ? <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-2)", wordBreak: "break-word" }}>{job.errorMessage}</div>
            : <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Job was cancelled or no error details available. Use Retry to re-queue.</div>}
        </div>
      )}
    </SlideOver>
  );
}
