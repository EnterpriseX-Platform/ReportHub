"use client";

// Client component: every API read now requires the bearer token (localStorage),
// so the dashboard fetches client-side after the auth guard passes.
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { Donut, Spark, StatusChip, Fmts, FmtTag, EngineBadge, JobStateDot } from "@/components/ui";
import type { DashboardSummary, Job } from "@/lib/types";


export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.dashboard(), api.jobs({ limit: 5 })])
      .then(([d, j]) => { setData(d); setJobs(j); })
      .catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <BackendDown message={err} />;
  if (!data) return <div className="empty" style={{ padding: 60 }}><span className="spin" /></div>;

  const { stats, statusBreakdown, engineBreakdown, recentReports } = data;
  const cover = Math.round((stats.registered / stats.required) * 100);

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <div className="page-sub">Report platform health &amp; activity · FY 2026</div>
        </div>
        <div className="page-actions">
          <div className="tag-pill">
            <i className="led pulse" style={{ width: 7, height: 7, borderRadius: 7, background: "var(--green)", display: "inline-block" }} /> Gateway online
          </div>
          <Link className="btn primary" href="/registry"><Icon name="plus" size={16} />Register report</Link>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Registered reports" val={String(stats.registered)} small={`/ ${stats.required} target`} icon="registry" />
        <Stat label="Runs today" val={String(stats.runsToday)} icon="play" delta={stats.runsToday === 0 ? "no runs yet today" : `${stats.failedToday} failed`} />
        <Stat label="In queue now" val={String(stats.inQueue)} icon="queue" delta="queued + running" />
        <Stat label="Success rate" val={`${stats.successRate}%`} icon="checkCircle" delta="of today's finished jobs" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div className="card card-pad" style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ position: "relative" }}>
            <Donut value={stats.registered} max={stats.required} size={86} stroke={10} />
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{cover}%</div>
                <div style={{ fontSize: 10, color: "var(--ink-3)" }}>coverage</div>
              </div>
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Catalog complete</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
              {stats.registered} of {stats.required} minimum reports registered across 9 clauses.
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 10 }}>
              <CountPill n={statusBreakdown.active ?? 0} color="var(--green)" label="active" />
              <CountPill n={statusBreakdown.testing ?? 0} color="var(--amber)" label="testing" />
              <CountPill n={statusBreakdown.error ?? 0} color="var(--red)" label="error" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              {Object.entries(engineBreakdown).map(([k, c]) => (
                <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--ink-3)" }}>
                  <EngineBadge engine={k} sm />
                  <b style={{ color: "var(--ink-2)" }}>{c}</b>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <div className="card-head">
            <Icon name="queue" size={17} style={{ color: "var(--accent)" }} />
            <div style={{ flex: 1 }}><h3>Live queue</h3></div>
            <span className="chip green pulse"><i className="led" />streaming</span>
          </div>
          <div style={{ padding: "6px 0" }}>
            {jobs.map((j) => (
              <div key={j.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 16px", borderBottom: "1px solid var(--line)" }}>
                <JobStateDot state={j.state} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--ink)" }}>{j.reportName}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{j.id} · {j.reportCode}</div>
                </div>
                <FmtTag f={j.fmt} />
              </div>
            ))}
          </div>
          <div style={{ padding: 12 }}>
            <Link className="btn sm ghost" style={{ width: "100%", justifyContent: "center" }} href="/queue">
              Open Queue Monitor <Icon name="arrowRight" size={14} />
            </Link>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <Icon name="history" size={17} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}><h3>Recently updated reports</h3></div>
          <Link className="btn sm ghost" href="/registry">View all</Link>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Report</th><th>Format</th><th>Status</th><th>Datasource</th><th className="num">Runs 30d</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {recentReports.map((r) => (
              <tr key={r.id}>
                <td className="strong" style={{ maxWidth: 360, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</td>
                <td><Fmts list={r.formats} /></td>
                <td><StatusChip s={r.status} /></td>
                <td>{r.datasourceName ?? "—"}</td>
                <td className="num">{r.runs}</td>
                <td style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{timeAgo(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, val, small, icon, delta, up, spark }: {
  label: string; val: string; small?: string; icon: string; delta?: string; up?: boolean; spark?: number[];
}) {
  return (
    <div className="stat">
      <div className="ico"><Icon name={icon} size={18} /></div>
      <div className="label">{label}</div>
      <div className="val">{val} {small && <small>{small}</small>}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {delta && (up === undefined
          ? <div className="delta" style={{ color: "var(--ink-4)" }}>{delta}</div>
          : <div className={"delta " + (up ? "up" : "down")}><Icon name={up ? "arrowUp" : "arrowDown"} size={13} />{delta}</div>)}
        {spark && <Spark data={spark} w={84} h={26} />}
      </div>
    </div>
  );
}

function CountPill({ n, color, label }: { n: number; color: string; label: string }) {
  return (
    <span style={{ fontSize: 12 }}>
      <b style={{ color }}>{n}</b> <span style={{ color: "var(--ink-3)" }}>{label}</span>
    </span>
  );
}

function BackendDown({ message }: { message: string }) {
  return (
    <div className="card card-pad" style={{ maxWidth: 560 }}>
      <h2 style={{ color: "var(--red)", fontSize: 15, margin: 0 }}>Cannot reach the backend</h2>
      <p style={{ fontSize: 13, color: "var(--ink-2)" }}>
        Check that the Spring Boot API at{" "}
        <code className="mono">{process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080/api"}</code> + Postgres are running
      </p>
      <pre className="mono" style={{ background: "var(--surface-3)", padding: 10, borderRadius: 6, fontSize: 12, color: "var(--ink-3)", overflowX: "auto" }}>{message}</pre>
    </div>
  );
}
