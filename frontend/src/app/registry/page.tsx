"use client";

import { errMsg } from "@/lib/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button, ContainedList, ContainedListItem, ContentSwitcher, IconButton, InlineNotification, Search, Switch, Tag,
} from "@carbon/react";
import { Add, TrashCan, Upload } from "@carbon/icons-react";
import { Select } from "@/components/Select";
import { DataList } from "@/components/DataList";
import { Fmts, PageHeader, StatusChip } from "@/components/ui";
import s from "@/components/R/r.module.scss";
import { AccessButton } from "@/components/AccessPanel";
import { usePerms } from "@/lib/perms";
import { StatusIcon } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { ReportDetail } from "@/components/registry/ReportDetail";
import { RegisterWizard } from "@/components/registry/RegisterWizard";
import { ImportConfigModal } from "@/components/registry/ImportConfigModal";
import { Modal } from "@/components/overlays";
import { api } from "@/lib/api";
import { ENGINES, STATUS } from "@/lib/model";
import { engineLabel } from "@/components/R/engineLabel";
import { fmtMs } from "@/lib/format";
import type { Category, Datasource, ReportSummary } from "@/lib/types";

const STATUS_OPTS = ["all", "active", "testing", "draft", "error"];
// Engine filter buttons. "other" is a catch-all bucket for every engine kind that
// isn't one of the four explicit buttons (composite, component, http, other, bce,
// plugin engines, …) — a NOT-IN filter the API can't express, so engine
// filtering runs client-side over the loaded rows (see displayRows).
const ENGINE_OPTS = ["all", "jasper", "api", "sql", "fetch", "book", "docbuilder", "other"];
const EXPLICIT_ENGINES = ["jasper", "api", "sql", "fetch", "book", "docbuilder"];
/** Sentence case throughout, matching the engine cards elsewhere. */
const ENGINE_LABEL: Record<string, string> = { all: "All engines", book: "Book", docbuilder: "Doc builder", other: "Other" };

export default function RegistryPage() {
  const { can } = usePerms();
  const toast = useToast();
  const [categories, setCategories] = useState<Category[]>([]);
  const [datasources, setDatasources] = useState<Datasource[]>([]);
  const [rows, setRows] = useState<ReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [cat, setCat] = useState("all");
  const [status, setStatus] = useState("all");
  const [engine, setEngine] = useState("all");
  const [q, setQ] = useState("");

  const [selCode, setSelCode] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [importer, setImporter] = useState(false);
  const [delCode, setDelCode] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const dsById = useMemo(() => Object.fromEntries(datasources.map((d) => [d.id, d])), [datasources]);
  // Engine is filtered client-side over the loaded rows: the "other" bucket is a NOT-IN
  // the API can't express. The list loads up to 400 rows, so the filter stays complete.
  const displayRows = useMemo(
    () =>
      rows.filter((r) => {
        if (engine === "other") return !EXPLICIT_ENGINES.includes(r.engine);
        if (engine !== "all") return r.engine === engine;
        return true;
      }),
    [rows, engine],
  );

  const loadMeta = useCallback(() => {
    Promise.all([api.categories(), api.datasources()])
      .then(([c, d]) => { setCategories(c); setDatasources(d); })
      .catch(() => {});
  }, []);

  const loadReports = useCallback(() => {
    setLoading(true);
    const t = setTimeout(() => {
      // engine is filtered client-side (incl. the "other" bucket), so it is not sent
      // to the API. size 400 loads every report in one page so the client-side
      // engine filter sees the complete set.
      api.reports({
        category: cat === "all" ? undefined : cat,
        status: status === "all" ? undefined : status,
        q: q || undefined,
        size: 400,
      })
        .then((p) => { setRows(p.items); setTotal(p.total); })
        .catch((e) => toast(errMsg(e), "error"))
        .finally(() => setLoading(false));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [cat, status, q, toast]);

  useEffect(loadMeta, [loadMeta]);
  useEffect(loadReports, [loadReports]);

  const totalRegistered = categories.reduce((s, c) => s + c.registered, 0);
  const totalMin = categories.reduce((s, c) => s + c.min, 0);

  function onCreated(code: string, msg: string) {
    setWizard(false);
    setImporter(false);
    toast(msg, "ok");
    loadMeta();
    loadReports();
    setSelCode(code);
  }

  async function doDelete() {
    if (!delCode || deleting) return;
    setDeleting(true);
    try {
      await api.deleteReport(delCode);
      toast(`Report ${delCode} deleted`, "ok");
      if (selCode === delCode) setSelCode(null);
      setDelCode(null);
      loadMeta();
      loadReports();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Report Registry"
        sub={`${totalRegistered} registered · ${datasources.length} datasources`}
        actions={<>
          {can("RH.REPORT", "create") && (<Button kind="secondary" renderIcon={Upload} onClick={() => setImporter(true)}>Import config</Button>)}
          {can("RH.REPORT", "create") && (<Button kind="primary" renderIcon={Add} onClick={() => setWizard(true)}>Register report</Button>)}
        </>}
      />

      <div className={s.split}>
        {/* category rail */}
        <div className={s.rail}>
          <ContainedList label="Categories" kind="on-page" size="md">
            <CatRow label="All reports" ref_="—" count={totalRegistered} active={cat === "all"} onClick={() => setCat("all")} />
            {categories.map((c) => (
              <CatRow key={c.id} label={c.name} ref_={c.ref} count={c.registered} min={c.min}
                active={cat === c.id} onClick={() => setCat(c.id)} />
            ))}
          </ContainedList>
        </div>

        {/* table */}
        <div style={{ minWidth: 0 }}>
          <div className={s.filters}>
            <div className={s.grow}>
              <Search size="md" labelText="Search reports" placeholder="Search name or code…" value={q}
                      onChange={(e) => setQ(typeof e === "string" ? e : e.target.value)} />
            </div>
            <ContentSwitcher size="md" selectedIndex={Math.max(0, STATUS_OPTS.indexOf(status))}
                             onChange={({ name }) => setStatus(String(name))} className="rh-switch-fit">
              {STATUS_OPTS.map((x) => <Switch key={x} name={x} text={x === "all" ? "All" : STATUS[x].label} />)}
            </ContentSwitcher>
            <Select prefix="Engine:" className={s.menuEnd} value={engine} onChange={setEngine}
                    options={ENGINE_OPTS.map((x) => ({ value: x, label: ENGINE_LABEL[x] ?? ENGINES[x]?.label ?? x }))} />
            <span className={`cds--type-label-01 ${s.count}`}>{loading ? "" : `${displayRows.length} shown`}</span>
          </div>
          <DataList
            rows={displayRows}
            loading={loading && rows.length === 0}
            search={false}
            pageSize={50}
            empty={q.trim() || status !== "all" || engine !== "all" ? "No reports match these filters." : "No reports yet"}
            onRowClick={(r) => setSelCode(r.code)}
            columns={[
              { key: "name", header: "Report", render: (r) => (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: selCode === r.code ? 600 : undefined }}>{r.name}</div>
                  <div className="cds--type-code-01 rh-dim">{r.code}</div>
                </div>
              ) },
              { key: "engine", header: "Engine", sortValue: (r) => engineLabel(r.engine),
                render: (r) => engineLabel(r.engine) },
              { key: "formats", header: "Formats", sortable: false, render: (r) => <Fmts list={r.formats} /> },
              { key: "datasourceName", header: "Datasource", render: (r) => {
                const ds = r.datasourceId ? dsById[r.datasourceId] : undefined;
                return <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{ds && <StatusIcon s={ds.status} />}{r.datasourceName ?? "—"}</span>;
              } },
              { key: "version", header: "Version", render: (r) => <span className="cds--type-code-01">v{r.version}</span> },
              { key: "status", header: "Status", render: (r) => <StatusChip s={r.status} size="sm" /> },
              { key: "avgMs", header: "Avg time", align: "end", render: (r) => <span className="cds--type-code-01">{fmtMs(r.avgMs)}</span> },
            ]}
            rowActions={(r) => (
              <>
                <AccessButton small type="REPORT" id={r.code} name={r.name} />
                {can("RH.REPORT", "delete") && (
                  <IconButton kind="ghost" size="sm" align="left" label="Delete report" aria-label={`Delete report ${r.code}`}
                              onClick={() => setDelCode(r.code)}><TrashCan /></IconButton>
                )}
              </>
            )}
          />
        </div>
      </div>

      {delCode && (
        <Modal
          title="Delete report"
          sub={`Report ${delCode}`}
          width={460}
          danger
          onClose={() => { if (!deleting) setDelCode(null); }}
          foot={<>
            <Button kind="secondary" onClick={() => setDelCode(null)} disabled={deleting}>Cancel</Button>
            <Button kind="danger" onClick={doDelete} disabled={deleting}>Delete report</Button>
          </>}
        >
          <div className="cds--type-body-01" style={{ marginBottom: "var(--cds-spacing-05)" }}>
            Delete report <Tag size="sm" type="outline" className="rh-mono">{delCode}</Tag>?
          </div>
          <InlineNotification kind="warning" lowContrast hideCloseButton title="Cannot be undone"
            subtitle="This deletes the report along with its template, parameters, versions and all generated output files." />
        </Modal>
      )}
      {selCode && <ReportDetail code={selCode} onClose={() => setSelCode(null)} onChanged={() => { loadMeta(); loadReports(); }} />}
      {wizard && <RegisterWizard categories={categories} datasources={datasources} onClose={() => setWizard(false)} onCreated={(r) => onCreated(r.code, `Report ${r.code} registered as draft`)} />}
      {importer && <ImportConfigModal onClose={() => setImporter(false)} onImported={(r) => onCreated(r.code, `Imported ${r.code}`)} />}
    </div>
  );
}

/** Category row in the registry rail. The name wraps instead of being truncated;
 * the second line is the category reference. */
function CatRow({ label, ref_, count, min, active, onClick }: {
  label: string; ref_: string; count: number; min?: number; active: boolean; onClick: () => void;
}) {
  const warn = min != null && count < min;
  return (
    <ContainedListItem onClick={onClick} className={active ? s.active : undefined} aria-current={active || undefined}>
      <span className={s.railItem}>
        <span style={{ minWidth: 0 }}>
          <span className="cds--type-body-compact-01" style={{ display: "block", fontWeight: active ? 600 : undefined }}>{label}</span>
          <span className="cds--type-helper-text-01 rh-dim">{ref_}</span>
        </span>
        <span className={`cds--type-label-01 ${s.railCount} ${warn ? s.railWarn : ""}`}
              title={min != null ? `${count} registered of ${min} required by clause ${ref_}` : `${count} registered`}>
          {count}{min != null ? "/" + min : ""}
        </span>
      </span>
    </ContainedListItem>
  );
}
