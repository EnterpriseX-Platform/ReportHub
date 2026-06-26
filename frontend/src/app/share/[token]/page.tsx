"use client";

// PUBLIC dashboard view — reachable without an account via the share token URL.
import { use, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
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
    <div style={{ minHeight: "100vh", background: "var(--bg-deep)", padding: "28px 4vw" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 18 }}>
        <div className="brand-mark" style={{ width: 34, height: 34, borderRadius: 9 }}><Icon name="chart" size={18} /></div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{data?.name ?? "Report Studio"}</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Shared dashboard · Report Studio{data ? ` · updated ${data.updatedAt.slice(0, 16).replace("T", " ")}` : ""}</div>
        </div>
      </div>

      {err && <div className="card card-pad" style={{ maxWidth: 480 }}><b style={{ color: "var(--red)" }}>Dashboard unavailable</b><div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 5 }}>{err}</div></div>}
      {!data && !err && <div className="empty" style={{ padding: 60 }}><span className="spin" /></div>}

      {data && (
        <div className="dash-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
          {data.widgets.map((w, i) => (
            <div key={i} className="card" style={{ overflow: "hidden", gridColumn: w.w === 2 ? "1 / -1" : undefined }}>
              <div className="card-head" style={{ padding: "10px 14px" }}>
                <Icon name="chart" size={14} style={{ color: "var(--accent)" }} />
                <h3 style={{ fontSize: 12.5 }}>{w.title}</h3>
                <span className="tag-pill" style={{ marginLeft: "auto", fontSize: 9.5 }}>{w.viz}</span>
              </div>
              <div style={{ padding: 10 }}>
                {w.error ? <div className="empty" style={{ color: "var(--red)", fontSize: 12 }}>{w.error}</div> : <Viz viz={w.viz} data={w.data} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
