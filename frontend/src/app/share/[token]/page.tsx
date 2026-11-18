"use client";

// PUBLIC dashboard view — reachable without an account via the share token URL.
import { Skeleton } from "@/components/ui";
import { localTime } from "@/lib/format";
import { use, useEffect, useState } from "react";
import { InlineNotification, Tag, Tile } from "@carbon/react";
import { ChartBar } from "@carbon/icons-react";
import { Viz } from "@/components/viz";
import { api } from "@/lib/api";
import type { DashboardData } from "@/lib/types";

export default function PublicDashboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.publicDashboard(token).then(setData).catch((e) => setErr(e instanceof Error ? e.message : "Not found"));
  }, [token]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--cds-background)", padding: "32px 4vw" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <ChartBar size={24} style={{ color: "var(--cds-icon-primary)" }} />
        <div>
          <h1 className="cds--type-heading-03">{data?.name ?? "Report Studio"}</h1>
          <div className="cds--type-label-01 rh-dim">Shared dashboard · Report Studio{data ? ` · updated ${localTime(data.updatedAt)}` : ""}</div>
        </div>
      </div>

      {err && <InlineNotification kind="error" title="Dashboard unavailable" subtitle={err} hideCloseButton lowContrast />}
      {!data && !err && <Skeleton />}

      {data && (
        <div className="rh-dash-grid">
          {data.widgets.map((w, i) => (
            <Tile key={i} style={{ padding: 0, overflow: "hidden", minWidth: 0, gridColumn: w.w === 2 ? "1 / -1" : undefined }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid var(--cds-border-subtle-01)" }}>
                <h3 className="cds--type-heading-compact-01" style={{ flex: 1, minWidth: 0 }}>{w.title}</h3>
                <Tag size="sm" type="cool-gray">{w.viz}</Tag>
              </div>
              <div style={{ padding: 12 }}>
                {w.error ? <div className="cds--type-body-compact-01" style={{ color: "var(--cds-text-error)", padding: 16 }}>{w.error}</div> : <Viz viz={w.viz} data={w.data} />}
              </div>
            </Tile>
          ))}
        </div>
      )}
    </div>
  );
}
