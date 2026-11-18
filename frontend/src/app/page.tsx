"use client";

// Client component: every API read now requires the bearer token (localStorage),
// so the dashboard fetches client-side after the auth guard passes.
import { usePerms } from "@/lib/perms";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, CodeSnippet, Tag, Tile } from "@carbon/react";
import { Add, ArrowRight } from "@carbon/icons-react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { Donut, StatusChip, Fmts, FmtTag, EngineBadge, StatusIcon, PageHeader, Skeleton } from "@/components/ui";
import { DataList } from "@/components/DataList";
import type { DashboardSummary, Job } from "@/lib/types";


export default function DashboardPage() {
  const { can } = usePerms();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.dashboard(), api.jobs({ limit: 5 })])
      .then(([d, j]) => { setData(d); setJobs(j); })
      .catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <BackendDown message={err} />;
  if (!data) return <Skeleton rows={6} />;

  const { stats, statusBreakdown, engineBreakdown, recentReports } = data;
  const cover = stats.required > 0 ? Math.min(100, Math.round((stats.registered / stats.required) * 100)) : 0;
  const complete = stats.required > 0 && stats.registered >= stats.required;

  return (
    <div>
      <PageHeader
        title="Overview"
        sub="Report platform health & activity"
        actions={<>
          <Tag type="green" size="md">Gateway online</Tag>
          {can("RH.REPORT", "create") && <Button as={Link} href="/registry" renderIcon={Add}>Register report</Button>}
        </>}
      />

      <div className="rh-metric-grid">
        <Stat label="Registered reports" val={String(stats.registered)} small={stats.required > 0 ? `/ ${stats.required} target` : undefined} icon="registry" />
        <Stat label="Runs today" val={String(stats.runsToday)} icon="play" delta={stats.runsToday === 0 ? "no runs yet today" : `${stats.failedToday} failed${stats.cancelledToday ? ` · ${stats.cancelledToday} cancelled` : ""}`} />
        <Stat label="In queue now" val={String(stats.inQueue)} icon="queue" delta="queued + running" />
        <Stat label="Success rate" val={`${stats.successRate}%`} icon="checkCircle" delta="of today's finished jobs" />
      </div>

      <div className="rh-overview-row">
        <Tile className="rh-coverage">
          {stats.required > 0 && (
            <div style={{ position: "relative", flex: "none" }}>
              <Donut value={stats.registered} max={Math.max(1, stats.required)} size={86} stroke={10} color="var(--cds-interactive)" />
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
                <div>
                  <div className="cds--type-heading-03">{cover}%</div>
                  <div className="cds--type-label-01 rh-dim">coverage</div>
                </div>
              </div>
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* No category has a minimum: coverage means nothing, show the catalog only. */}
            <h2 className="cds--type-heading-compact-01" style={{ margin: 0 }}>{stats.required > 0 ? (complete ? "Catalog complete" : "Catalog coverage") : "Catalog"}</h2>
            <p className="cds--type-body-compact-01 rh-dim" style={{ marginTop: 4 }}>
              {stats.required > 0
                ? `${stats.registered} of ${stats.required} minimum reports registered.`
                : `${stats.registered} reports registered.`}
            </p>
            <div style={{ display: "flex", gap: 16, marginTop: 12 }} className="cds--type-body-compact-01">
              <CountPill n={statusBreakdown.active ?? 0} color="var(--cds-support-success)" label="active" />
              <CountPill n={statusBreakdown.testing ?? 0} color="var(--cds-text-primary)" label="testing" />
              <CountPill n={statusBreakdown.error ?? 0} color="var(--cds-support-error)" label="error" />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
              {Object.entries(engineBreakdown).map(([k, c]) => (
                <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  <EngineBadge engine={k} sm />
                  <b className="cds--type-label-01">{c}</b>
                </span>
              ))}
            </div>
          </div>
        </Tile>

        <Tile className="rh-livequeue">
          <div className="rh-tile-head">
            <h2 className="cds--type-heading-compact-01" style={{ margin: 0, flex: 1 }}>Live queue</h2>
            <Tag type="green" size="sm">streaming</Tag>
          </div>
          <ul className="rh-joblist">
            {jobs.map((j) => (
              <li key={j.id}>
                <StatusIcon s={j.state} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cds--type-body-compact-01 rh-ellipsis">{j.reportName}</div>
                  <div className="cds--type-code-01 rh-dim">{j.id} · {j.reportCode}</div>
                </div>
                <FmtTag f={j.fmt} />
              </li>
            ))}
            {jobs.length === 0 && <li className="rh-dim cds--type-body-compact-01">No jobs yet</li>}
          </ul>
          {can("RH.QUEUE") && (
            <Button as={Link} href="/queue" kind="ghost" size="sm" renderIcon={ArrowRight}>Open Queue Monitor</Button>
          )}
        </Tile>
      </div>

      <div style={{ marginTop: 32 }}>
        <DataList
          title="Recently updated reports"
          rows={recentReports}
          search={false}
          pagination={false}
          size="md"
          toolbar={<Button as={Link} href="/registry" kind="ghost">View all</Button>}
          empty="No reports yet"
          columns={[
            { key: "name", header: "Report", render: (r) => <span className="rh-ellipsis" style={{ maxWidth: 360, display: "block" }}>{r.name}</span> },
            { key: "formats", header: "Format", sortable: false, render: (r) => <Fmts list={r.formats} /> },
            { key: "status", header: "Status", render: (r) => <StatusChip s={r.status} size="sm" /> },
            { key: "datasourceName", header: "Datasource", render: (r) => r.datasourceName ?? "—" },
            { key: "runs", header: "Runs 30d", align: "end" },
            { key: "updatedAt", header: "Updated", render: (r) => <span className="rh-dim">{timeAgo(r.updatedAt)}</span> },
          ]}
        />
      </div>
    </div>
  );
}

function Stat({ label, val, small, icon, delta }: {
  label: string; val: string; small?: string; icon: string; delta?: string;
}) {
  return (
    <Tile className="rh-metric">
      <div className="rh-metric__head"><span className="cds--type-label-01">{label}</span><Icon name={icon} size={16} /></div>
      <div className="rh-metric__val">
        <span className="cds--type-productive-heading-05">{val}</span>{" "}
        {small && <span className="cds--type-label-01 rh-dim">{small}</span>}
      </div>
      {delta && <div className="cds--type-label-01 rh-dim">{delta}</div>}
    </Tile>
  );
}

function CountPill({ n, color, label }: { n: number; color: string; label: string }) {
  return (
    <span>
      <b style={{ color }}>{n}</b> <span className="rh-dim">{label}</span>
    </span>
  );
}

function BackendDown({ message }: { message: string }) {
  return (
    <Tile style={{ maxWidth: 640 }}>
      <h2 className="cds--type-heading-03" style={{ margin: 0, color: "var(--cds-text-error)" }}>Cannot reach the backend</h2>
      <p className="cds--type-body-01" style={{ margin: "8px 0 16px" }}>
        Check that the API at <code className="cds--type-code-01">{process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080/api"}</code> and its database are running.
      </p>
      <CodeSnippet type="multi" hideCopyButton>{message}</CodeSnippet>
    </Tile>
  );
}
