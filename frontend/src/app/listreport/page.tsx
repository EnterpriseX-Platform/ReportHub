"use client";

import { errMsg } from "@/lib/api";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/Select";
import st from "@/components/R/r.module.scss";
import { StatusIcon, Fmts, PageHeader, Skeleton, StatusChip } from "@/components/ui";
import { DataList } from "@/components/DataList";
import { useToast } from "@/components/Toast";
import { ReportDetail } from "@/components/registry/ReportDetail";
import { api } from "@/lib/api";
import { engineLabel } from "@/components/R/engineLabel";
import { fmtMs } from "@/lib/format";
import type { Datasource, ReportSummary } from "@/lib/types";

export default function ListReportPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <ListReport />
    </Suspense>
  );
}

function ListReport() {
  const search = useSearchParams();
  const router = useRouter();
  const toast = useToast();

  const [rows, setRows] = useState<ReportSummary[]>([]);
  const [datasources, setDatasources] = useState<Datasource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selCode, setSelCode] = useState<string | null>(null);
  const [catNames, setCatNames] = useState<Record<string, string>>({});
  const catName = (id: string) => catNames[id] ?? id;

  // The category lives in the URL (?m=<categoryId>) so a link points at one category.
  const urlModule = search.get("m");

  const dsById = useMemo(() => Object.fromEntries(datasources.map((d) => [d.id, d])), [datasources]);

  // size 400 loads every report in one page, so the category list below is complete.
  useEffect(() => {
    setLoading(true);
    Promise.all([api.reports({ size: 400 }), api.datasources()])
      .then(([p, d]) => { setRows(p.items); setDatasources(d); })
      .then(() => api.categories().then((c) => setCatNames(Object.fromEntries(c.map((x) => [x.id, x.name])))).catch(() => {}))
      .catch((e) => toast(errMsg(e), "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  const moduleOpts = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.categoryId) set.add(r.categoryId);
    return [...set].sort((a, b) => catName(a).localeCompare(catName(b)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, catNames]);

  // Fall back to the first category so a bare /listreport still shows something,
  // and reflect it in the URL so what you see always matches the address bar.
  const module = urlModule ?? moduleOpts[0] ?? null;
  useEffect(() => {
    if (!urlModule && module) router.replace(`/listreport?m=${encodeURIComponent(module)}`);
  }, [urlModule, module, router]);

  const setModule = useCallback((m: string) => {
    setSelCode(null);
    router.replace(`/listreport?m=${encodeURIComponent(m)}`);
  }, [router]);

  const listed = useMemo(
    () => rows.filter((r) => r.categoryId === module),
    [rows, module],
  );

  return (
    <div className="fade-in">
      <PageHeader
        title="Report List"
        sub={module ? `${catName(module)} · ${listed.length} reports` : "No category selected"}
      />

      <DataList
        rows={listed}
        loading={loading}
        pageSize={50}
        empty="No reports in this module."
        onRowClick={(r) => setSelCode(r.code)}
        toolbar={
          <Select
            prefix="Category:"
            value={module ?? ""}
            onChange={(v) => setModule(v)}
            options={moduleOpts.map((m) => ({ value: m, label: catName(m) }))}
            className={st.menuEnd}
            style={{ minWidth: 220 }}
            size="lg"
          />
        }
        columns={[
          { key: "name", header: "Report", render: (r) => (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: selCode === r.code ? 600 : undefined }}>{r.name}</div>
              <div className="cds--type-code-01 rh-dim">{r.code}</div>
            </div>
          ) },
          { key: "engine", header: "Engine", sortValue: (r) => engineLabel(r.engine), render: (r) => engineLabel(r.engine) },
          { key: "formats", header: "Formats", sortable: false, render: (r) => <Fmts list={r.formats} /> },
          { key: "datasourceName", header: "Datasource", render: (r) => {
            const ds = r.datasourceId ? dsById[r.datasourceId] : undefined;
            return <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{ds && <StatusIcon s={ds.status} />}{r.datasourceName ?? "—"}</span>;
          } },
          { key: "version", header: "Version", render: (r) => <span className="cds--type-code-01">v{r.version}</span> },
          { key: "status", header: "Status", render: (r) => <StatusChip s={r.status} size="sm" /> },
          { key: "avgMs", header: "Avg time", align: "end", render: (r) => <span className="cds--type-code-01">{fmtMs(r.avgMs)}</span> },
        ]}
      />

      {selCode && <ReportDetail code={selCode} overviewOnly onClose={() => setSelCode(null)} />}
    </div>
  );
}
