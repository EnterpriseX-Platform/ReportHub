"use client";

import { errMsg } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";
import {
  Button, ButtonSet, Checkbox, FileUploaderButton, FormGroup, IconButton, Stack, StructuredListBody,
  StructuredListCell, StructuredListRow, StructuredListWrapper, Tab as CTab, TabList, Tabs, Tag, TextArea, TextInput, Tile, Toggle,
} from "@carbon/react";
import {
  Add, CheckmarkFilled, Checkmark, Close, Download, Edit, Pause, Play, Settings, Time, TrashCan, WarningAltFilled,
} from "@carbon/icons-react";
import st from "@/components/R/r.module.scss";
import { useRouter } from "next/navigation";
import { Icon, carbonIcon } from "@/components/Icon";
import { SlideOver } from "@/components/overlays";
import { DataList } from "@/components/DataList";
import { EngineBadge, StatusChip, Fmts, FmtTag, MiniStat, Skeleton } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api, fieldErrors } from "@/lib/api";
import { ENGINES } from "@/lib/model";
import { fmtMs, localTime } from "@/lib/format";
import { Select } from "@/components/Select";
import { SchemaForm, configToValues, valuesToConfig } from "@/components/SchemaForm";
import type { Category, FileHubTarget, Datasource, EngineDescriptor, Job, ParamDef, ReportDetail as RD, ReportUnit, UnitFile, VersionEntry } from "@/lib/types";

const TABS = ["overview", "config", "parameters", "versions", "history"] as const;
type Tab = (typeof TABS)[number];

const ENGINE_KINDS = ["jasper", "component", "api", "sql", "composite", "http", "docbuilder", "book"];
const ALL_FORMATS = ["PDF", "XLSX", "DOCX", "CSV"];
const STATUSES = ["active", "testing", "draft", "error"];

/**
 * @param overviewOnly read-only mode for the per-module list: Overview alone, no tab bar and no
 *        Configure button. Same panel otherwise, so the two screens can't drift apart.
 */
export function ReportDetail({ code, onClose, overviewOnly = false, onChanged }:
  { code: string; onClose: () => void; overviewOnly?: boolean; /** Called after a save so the parent list can refresh. */ onChanged?: () => void }) {
  const [r, setR] = useState<RD | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const toast = useToast();
  const router = useRouter();

  const reload = useCallback(() => {
    api.report(code).then(setR).catch(() => toast("Failed to load details", "error"));
  }, [code, toast]);
  useEffect(() => { reload(); }, [reload]);

  if (!r) {
    return (
      <SlideOver title="Report" onClose={onClose}>
        <Skeleton />
      </SlideOver>
    );
  }

  return (
    <SlideOver
      title={r.name}
      sub={`${r.code} · ${r.categoryName ?? ""}`}
      badge={<><EngineBadge engine={r.engine} /><StatusChip s={r.status} /></>}
      onClose={onClose}
      foot={
        <ButtonSet className="rh-foot-set">
          <Button kind="secondary" onClick={onClose}>Close</Button>
          {r.engine !== "other" && (
            <Button kind="primary" renderIcon={Play} onClick={() => router.push(`/runtask?code=${r.code}`)}>Run task</Button>
          )}
        </ButtonSet>
      }
    >
      {!overviewOnly && (
        <div style={{ marginBottom: "var(--cds-spacing-06)" }}>
          <Tabs selectedIndex={TABS.indexOf(tab)} onChange={({ selectedIndex }) => setTab(TABS[selectedIndex])}>
            <TabList aria-label="Report detail" contained={false}>
              {TABS.map((t) => <CTab key={t}>{t[0].toUpperCase() + t.slice(1)}</CTab>)}
            </TabList>
          </Tabs>
        </div>
      )}

      {(overviewOnly || tab === "overview") && <Overview r={r} />}
      {tab === "config" && <ConfigForm r={r} onSaved={() => { reload(); onChanged?.(); }} />}
      {tab === "parameters" && <Parameters r={r} />}
      {tab === "versions" && <Versions r={r} />}
      {tab === "history" && <History r={r} />}
    </SlideOver>
  );
}

function Overview({ r }: { r: RD }) {
  // An "Other" (information-only) unit stores free-text app-module notes in configJson.appModule —
  // surface it right under the owner unit so the report's documentation is visible without editing.
  const [appModule, setAppModule] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.reportUnits(r.code).then((units) => {
      if (!live) return;
      const other = units.find((u) => u.engine === "other" && (configToValues(u.configJson).appModule ?? "").trim());
      setAppModule(other ? configToValues(other.configJson).appModule : null);
    }).catch(() => {});
    return () => { live = false; };
  }, [r.code]);

  return (
    <Stack gap={6}>
      <div className="rh-ministats">
        <MiniStat label="Runs (30d)" value={r.runs} />
        <MiniStat label="Avg render" value={fmtMs(r.avgMs)} />
        <MiniStat label="Version" value={r.version} />
        <MiniStat label="Output formats" value={<Fmts list={r.formats} />} />
      </div>
      <div>
        <h3 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-03)" }}>Definition</h3>
        <StructuredListWrapper isCondensed className="rh-slist" aria-label="Definition">
          <StructuredListBody>
            <KV k="Source engine"><EngineBadge engine={r.engine} /> <span className="cds--type-helper-text-01 rh-dim">{ENGINES[r.engine]?.desc}</span></KV>
            <KV k="Category">{r.categoryName}</KV>
            <KV k="Template"><span className="cds--type-code-01" style={{ wordBreak: "break-all" }}>{r.templatePath ?? "—"}</span></KV>
            <KV k="Owner unit">{r.ownerUnit ?? "—"}</KV>
            {appModule && <KV k="App module / information"><span style={{ whiteSpace: "pre-wrap" }}>{appModule}</span></KV>}
          </StructuredListBody>
        </StructuredListWrapper>
        {r.testData && (
          <p className="cds--type-helper-text-01" style={{ color: "var(--cds-text-secondary)", fontStyle: "italic", marginTop: "var(--cds-spacing-03)" }}>*Sample data for acceptance testing</p>
        )}
      </div>
      <div>
        <h3 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-03)" }}>Datasource &amp; gateway</h3>
        <Tile>
          <div className="rh-tile-head">
            <Icon name="datasource" size={16} style={{ color: "var(--cds-icon-secondary)" }} />
            <span className="cds--type-heading-compact-01">{r.datasourceName ?? r.datasourceId ?? "—"}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            <Tag type="outline" size="md" renderIcon={carbonIcon("queue")}>queue: {r.queue || "default"}</Tag>
            <Tag type="outline" size="md" renderIcon={carbonIcon("bolt")}>priority: {r.priority || "normal"}</Tag>
            <Tag type="outline" size="md" renderIcon={Time}>timeout: {r.timeoutMinutes ?? 2} min</Tag>
          </div>
        </Tile>
      </div>
    </Stack>
  );
}

/** Two-column row of a condensed StructuredList (label · value). */
function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <StructuredListRow>
      <StructuredListCell noWrap className="rh-dim" style={{ width: "34%" }}>{k}</StructuredListCell>
      <StructuredListCell>{children}</StructuredListCell>
    </StructuredListRow>
  );
}

/** The Config screen — a real form persisted via PUT /reports/{code} (bumps the version). */
function ConfigForm({ r, onSaved }: { r: RD; onSaved: () => void }) {
  const toast = useToast();
  const [cats, setCats] = useState<Category[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [name, setName] = useState(r.name);
  const [formats, setFormats] = useState<string[]>(r.formats);
  const [status, setStatus] = useState<string>(r.status);
  const [categoryId, setCategoryId] = useState(r.categoryId);
  const [datasourceId, setDatasourceId] = useState(r.datasourceId ?? "");
  const [testData, setTestData] = useState(r.testData);
  const [ownerUnit, setOwnerUnit] = useState(r.ownerUnit ?? "");
  const [outputFolder, setOutputFolder] = useState(r.outputFolder ?? "");
  const [allowedRoles, setAllowedRoles] = useState(r.allowedRoles ?? "");
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState(r.priority ?? "normal");
  const [timeoutMin, setTimeoutMin] = useState(r.timeoutMinutes != null ? String(r.timeoutMinutes) : "");
  const [queue, setQueue] = useState(r.queue ?? "");
  const [busy, setBusy] = useState(false);
  const [fErr, setFErr] = useState<Record<string, string>>({});
  // Deliver to FileHub after each render (saved with the metadata; separate endpoint)
  const [fhTargets, setFhTargets] = useState<FileHubTarget[]>([]);
  const [deliveryTo, setDeliveryTo] = useState("");
  const [deliveryPath, setDeliveryPath] = useState("");
  const [deliveryOrig, setDeliveryOrig] = useState("|");

  // Render the form only once both lists are in, so the pickers never flash "— none —" / an empty value.
  const [listsReady, setListsReady] = useState(false);
  useEffect(() => {
    Promise.allSettled([
      api.categories().then(setCats),
      api.datasources().then(setDss),
      api.fileHubTargets().then(setFhTargets),
      api.reportDelivery(r.code).then((d) => {
        setDeliveryTo(d.connectorId ?? ""); setDeliveryPath(d.path ?? "");
        setDeliveryOrig(`${d.connectorId ?? ""}|${d.path ?? ""}`);
      }),
    ]).then(() => setListsReady(true));
  }, []);

  function toggleFormat(f: string) {
    setFormats((s) => (s.includes(f) ? s.filter((x) => x !== f) : [...s, f]));
  }

  async function save() {
    if (!name.trim()) { toast("Report name is required", "error"); return; }
    if (formats.length === 0) { toast("Pick at least one format", "error"); return; }
    const tm = timeoutMin.trim() ? Number(timeoutMin) : undefined;
    if (tm !== undefined && (!Number.isInteger(tm) || tm < 1 || tm > 1440)) {
      setFErr({ timeoutMinutes: "Must be a whole number from 1 to 1440" }); return;
    }
    setFErr({});
    setBusy(true);
    try {
      await api.updateReport(r.code, {
        name: name.trim(),
        formats, status, categoryId,
        datasourceId, ownerUnit, outputFolder,
        testData,
        allowedRoles: allowedRoles.trim(),
        note: note.trim() || undefined,
        priority, timeoutMinutes: tm, queue: queue.trim() || undefined,
      });
      if (`${deliveryTo}|${deliveryPath.trim()}` !== deliveryOrig) {
        await api.saveReportDelivery(r.code, { connectorId: deliveryTo || null, path: deliveryPath.trim() || null });
        setDeliveryOrig(`${deliveryTo}|${deliveryPath.trim()}`);
      }
      toast(`Configuration saved · version bumped`, "ok");
      setNote("");
      onSaved();
    } catch (e) {
      const f = fieldErrors(e);
      setFErr(f);
      if (Object.keys(f).length === 0) toast(errMsg(e, "Save failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!listsReady) return <Skeleton rows={8} />;
  const folderPreview = outputFolder
    .replace("{code}", r.code).replace("{category}", r.categoryName ?? "category")
    .replace("{unit}", "default").replace("{fmt}", "pdf")
    .replace("{yyyy}", String(new Date().getFullYear())).replace("{MM}", String(new Date().getMonth() + 1).padStart(2, "0")).replace("{dd}", String(new Date().getDate()).padStart(2, "0"));
  return (
    <Stack gap={6}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--cds-spacing-03)", flexWrap: "wrap" }}>
        <h3 className="cds--type-heading-compact-01">Report configuration</h3>
        <span className="cds--type-code-01 rh-dim" style={{ marginLeft: "auto" }}>v{r.version} · saving bumps the minor version</span>
      </div>

      {/* The unit set IS the report definition — engine/format/config live on each unit. */}
      <UnitsManager code={r.code} onChanged={onSaved} />

      <h3 className="cds--type-heading-compact-01" style={{ borderTop: "1px solid var(--cds-border-subtle-01)", paddingTop: "var(--cds-spacing-05)" }}>Report info</h3>
      <TextInput id="rd-name" labelText="Report name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Report name"
                 invalid={!!fErr.name} invalidText={fErr.name} />
      <TextInput id="rd-code" labelText="Report code" helperText="Identifier · cannot be changed" className="rh-mono" value={r.code} readOnly />
      <div className="rh-form-grid">
        <Select label="Status" value={status} onChange={setStatus} options={STATUSES.map((x) => ({ value: x, label: x }))} />
        <Select label="Default datasource" value={datasourceId} onChange={setDatasourceId} placeholder="No connection"
                options={[{ value: "", label: "No connection" }, ...dss.map((d) => ({ value: d.id, label: d.name }))]} />
        <div className="rh-span-2">
          <Select label="Category" value={categoryId} onChange={setCategoryId}
                  options={cats.map((c) => ({ value: c.id, label: c.name }))} />
        </div>
      </div>

      <Checkbox id="rd-test" labelText="Test data" helperText="Sample data for acceptance testing (shown as a note on the Overview tab)."
                checked={testData} onChange={(_, { checked }) => setTestData(checked)} />

      <FormGroup legendText={'Run formats · choices at run time for units set to "job format"'}>
        <div className={st.inlineChecks}>
          {ALL_FORMATS.map((f) => (
            <Checkbox key={f} id={`rd-fmt-${f}`} labelText={f} checked={formats.includes(f)} onChange={() => toggleFormat(f)} />
          ))}
        </div>
      </FormGroup>

      <div>
        <TextInput id="rd-folder" labelText="Output folder" className="rh-mono" value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)}
                   placeholder="{code}  ·  e.g. {category}/{yyyy}/{MM}"
                   helperText={outputFolder ? `preview: /${folderPreview}/…` : "Where rendered files land — a path or placeholders"} />
        <div style={{ display: "flex", flexWrap: "wrap", marginTop: "var(--cds-spacing-02)" }}>
          {["{code}", "{category}", "{unit}", "{fmt}", "{yyyy}", "{MM}", "{dd}"].map((t) => (
            <Tag key={t} type="outline" size="sm" className="rh-mono" as="button"
                 onClick={() => setOutputFolder((x) => (x ? x.replace(/\/?$/, "") + "/" + t : t))}>{t}</Tag>
          ))}
        </div>
      </div>

      <TextInput id="rd-roles" labelText="Who can see this report (portal roles, comma separated)" className="rh-mono" value={allowedRoles}
                 onChange={(e) => setAllowedRoles(e.target.value)} placeholder="ADMIN-UNIT, ADMIN-UNIT-II"
                 helperText={(allowedRoles.trim()
                   ? "Only these roles see it in the registry list, and only when opened from the portal"
                   : "Everyone sees it") + " · a direct admin/admin login is never filtered"} />

      <div className="rh-form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <Select label="Priority" value={priority} onChange={setPriority} invalidText={fErr.priority}
                options={["high", "normal", "low"].map((x) => ({ value: x, label: x }))} />
        <TextInput id="rd-timeout" labelText="Timeout (minutes)" className="rh-mono" type="number" min={1} max={1440} value={timeoutMin}
                   onChange={(e) => setTimeoutMin(e.target.value)} placeholder="1–1440" invalid={!!fErr.timeoutMinutes} invalidText={fErr.timeoutMinutes} />
        <TextInput id="rd-queue" labelText="Queue" className="rh-mono" value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="default"
                   invalid={!!fErr.queue} invalidText={fErr.queue} />
      </div>

      {(fhTargets.length > 0 || deliveryTo) && (
        <div className="rh-form-grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)" }}>
          <Select label="Deliver to FileHub" value={deliveryTo} onChange={setDeliveryTo}
            options={[{ value: "", label: "Off" }, ...fhTargets.map((t) => ({ value: t.id, label: t.name })),
              ...(deliveryTo && !fhTargets.some((t) => t.id === deliveryTo) ? [{ value: deliveryTo, label: deliveryTo }] : [])]} />
          <TextInput id="rd-fhpath" labelText="Folder path" title="Placeholders {code} {yyyy} {mm} {dd}; blank = the connector's folder path"
                     className="rh-mono" value={deliveryPath} disabled={!deliveryTo} onChange={(e) => setDeliveryPath(e.target.value)}
                     placeholder={fhTargets.find((t) => t.id === deliveryTo)?.folderPath || "{code}/{yyyy}/{mm}"} />
        </div>
      )}

      <TextInput id="rd-owner" labelText="Owner unit" value={ownerUnit} onChange={(e) => setOwnerUnit(e.target.value)} placeholder="Strategy division" />
      <TextInput id="rd-note" labelText="Change note (recorded in version history)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Adjusted datasource and template" />

      {/* Saves the REPORT-level metadata (status, datasource, owner, change note) —
          NOT the per-unit engine config inside each UnitCard. Each unit has its own
          "Save engine config" button. Labelled explicitly so users editing a unit's
          engine config don't mistake this big blue button for theirs. */}
      <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={busy}>Save report metadata</Button>
    </Stack>
  );
}

/**
 * Render units — ONE report can hold several units, each with its own engine, output format
 * and template files (main + Jasper subreports). A single run call executes every enabled
 * unit and produces one artifact per unit (multi-file / multi-engine in one call).
 */
function UnitsManager({ code, onChanged }: { code: string; onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<ReportUnit[] | null>(null);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [engineDescriptors, setEngineDescriptors] = useState<EngineDescriptor[]>([]);
  useEffect(() => { api.datasources().then(setDss).catch(() => {}); }, []);
  useEffect(() => { api.engines().then((d) => setEngineDescriptors(d.descriptors ?? [])).catch(() => {}); }, []);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEngine, setNewEngine] = useState("jasper");
  const [newFmt, setNewFmt] = useState("");

  const reload = useCallback(() => {
    api.reportUnits(code).then(setItems).catch(() => setItems([]));
  }, [code]);
  useEffect(() => { reload(); }, [reload]);

  async function addUnit() {
    if (!newName.trim()) { toast("Output name is required", "error"); return; }
    setAdding(true);
    try {
      await api.createUnit(code, { name: newName.trim(), engine: newEngine, fmt: newFmt || null });
      setNewName("");
      toast("Output added", "ok");
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e, "Create failed"), "error");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--cds-spacing-03)", flexWrap: "wrap", marginBottom: "var(--cds-spacing-03)" }}>
        <span className="cds--label" style={{ margin: 0 }}>Outputs ({items?.length ?? 0})</span>
        <span className="cds--type-helper-text-01 rh-dim" style={{ marginLeft: "auto" }}>one file per output · own engine / template / format</span>
      </div>

      {items === null && <Skeleton />}
      {items?.map((u) => (
        <UnitCard key={u.id} code={code} unit={u} datasources={dss}
                  reportProps={engineDescriptors.find((d) => d.kind === u.engine)?.reportProps ?? []}
                  onChanged={() => { reload(); onChanged(); }} />
      ))}
      {items?.length === 0 && (
        <p className="cds--type-body-compact-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-03)" }}>No outputs yet.</p>
      )}

      <div className={st.unitAdd}>
        <TextInput id={`ua-name-${code}`} size="md" labelText="Output name" hideLabel placeholder="Output name · e.g. summary-pdf" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Select value={newEngine} onChange={setNewEngine} options={ENGINE_KINDS.map((k) => ({ value: k, label: k }))} />
        <Select value={newFmt} onChange={setNewFmt} placeholder="job format"
                options={[{ value: "", label: "job format" }, ...ALL_FORMATS.map((f) => ({ value: f, label: f }))]} />
        <Button kind="tertiary" size="md" renderIcon={Add} disabled={adding} onClick={addUnit}>Add output</Button>
      </div>
    </div>
  );
}

function UnitCard({ code, unit, datasources, reportProps, onChanged }: { code: string; unit: ReportUnit; datasources: Datasource[]; reportProps: EngineDescriptor["reportProps"]; onChanged: () => void }) {
  const toast = useToast();
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [cfg, setCfg] = useState(unit.configJson ?? "");
  const [vals, setVals] = useState<Record<string, string>>(() => configToValues(unit.configJson));
  const [rawMode, setRawMode] = useState(false);
  const hasSchema = reportProps && reportProps.length > 0;

  // Keep the editor in sync with the unit prop: if the unit's stored config / engine changes (after a
  // save+refetch, or the engine descriptor changes), reset both form values and the raw JSON so the
  // editor never shows stale config for a different engine. Value deps, so an upload (which doesn't
  // touch configJson) won't wipe an in-progress edit.
  useEffect(() => {
    setVals(configToValues(unit.configJson));
    setCfg(unit.configJson ?? "");
    setRawMode(false);
  }, [unit.id, unit.engine, unit.configJson]);

  function onPropChange(key: string, value: string) {
    const nv = { ...vals, [key]: value };
    setVals(nv);
    setCfg(valuesToConfig(nv, reportProps.map((p) => p.key)) ?? "");
  }

  // Switching JSON -> Form must re-parse the raw textarea back into form values, else a manual JSON
  // edit is silently discarded the moment the user touches any form field after switching back.
  function toggleRawMode() {
    if (rawMode) setVals(configToValues(cfg));
    setRawMode((v) => !v);
  }

  async function saveCfg() {
    if (cfg.trim()) {
      try { JSON.parse(cfg); } catch { toast("Engine config must be valid JSON", "error"); return; }
    }
    try {
      await api.updateUnit(code, unit.id, { name: unit.name, engine: unit.engine, fmt: unit.fmt, datasourceId: unit.datasourceId, enabled: unit.enabled, configJson: cfg.trim() || null });
      toast(`Config saved for ${unit.name}`, "ok");
      setShowCfg(false);
      onChanged();
    } catch (e) {
      toast(errMsg(e, "Save failed"), "error");
    }
  }

  const main = unit.files.find((f) => f.role === "main" && f.active);
  const mainHistory = unit.files.filter((f) => f.role === "main" && !f.active);
  const subs = unit.files.filter((f) => f.role === "subreport");
  const resources = unit.files.filter((f) => f.role === "resource");

  async function upload(files: FileList | null, role: "main" | "subreport" | "resource") {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy(true);
    try {
      for (const f of list) await api.uploadUnitFile(code, unit.id, f, role);
      toast(`Uploaded ${list.length} file${list.length > 1 ? "s" : ""} to ${unit.name}`, "ok");
      onChanged();
    } catch (e) {
      toast(errMsg(e, "Upload failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    try {
      await api.updateUnit(code, unit.id, { name: unit.name, engine: unit.engine, fmt: unit.fmt, datasourceId: unit.datasourceId, configJson: unit.configJson, enabled: !unit.enabled });
      onChanged();
    } catch (e) {
      toast(errMsg(e, "Update failed"), "error");
    }
  }

  async function removeUnit() {
    try {
      await api.deleteUnit(code, unit.id);
      onChanged();
    } catch (e) {
      toast(errMsg(e, "Delete failed"), "error");
    }
  }

  async function removeFile(f: UnitFile) {
    try {
      await api.deleteUnitFile(code, unit.id, f.id);
      onChanged();
    } catch (e) {
      toast(errMsg(e, "Delete failed"), "error");
    }
  }

  async function activateFile(f: UnitFile) {
    try {
      await api.activateUnitFile(code, unit.id, f.id);
      toast(`Activated ${f.fileName}`, "ok");
      onChanged();
    } catch (e) {
      toast(errMsg(e, "Activate failed"), "error");
    }
  }

  const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  return (
    <div className={st.unit} style={{ opacity: unit.enabled ? 1 : 0.6 }}>
      <div className={st.unitHead}>
        <span className="cds--type-heading-compact-01">{unit.name}</span>
        <EngineBadge engine={unit.engine} sm />
        <Tag size="sm" type="outline">{unit.fmt ?? "job format"}</Tag>
        {!unit.enabled && <Tag size="sm" type="gray">disabled</Tag>}
        <span style={{ marginLeft: "auto", display: "flex" }}>
          <IconButton kind="ghost" size="sm" align="bottom-end" label="Engine config (JSON)" isSelected={showCfg || undefined} onClick={() => setShowCfg((v) => !v)}>
            <Settings style={unit.configJson ? { fill: "var(--cds-link-primary)" } : undefined} />
          </IconButton>
          <IconButton kind="ghost" size="sm" align="bottom-end" label={unit.enabled ? "Disable" : "Enable"} onClick={toggleEnabled}>
            {unit.enabled ? <Pause /> : <Play />}
          </IconButton>
          {confirmDel ? (
            <Button kind="danger--ghost" size="sm" onClick={() => { setConfirmDel(false); removeUnit(); }} onBlur={() => setConfirmDel(false)}>Delete?</Button>
          ) : (
            <IconButton kind="ghost" size="sm" align="bottom-end" label="Delete output" onClick={() => setConfirmDel(true)}><TrashCan /></IconButton>
          )}
        </span>
      </div>
      <div className={st.unitBody}>
        <div className={st.unitRow}>
          <span className="cds--label">Main</span>
          <div style={{ minWidth: 0 }}>
            {main ? (
              <FileLine name={main.fileName} size={fmtSize(main.sizeBytes)}
                        onDownload={() => api.downloadUnitFile(code, unit.id, main.id, main.fileName)} onRemove={() => removeFile(main)} />
            ) : <span className="cds--type-helper-text-01 rh-dim">built-in layout (no template uploaded)</span>}
          </div>
          <FileUploaderButton labelText={main ? "Replace" : "Upload"} size="sm" buttonKind="tertiary" disableLabelChanges disabled={busy}
                              accept={[".jrxml", ".docx", ".xlsx", ".yml", ".yaml", ".json", ".html"]}
                              onChange={(e) => { upload(e.target.files, "main"); e.target.value = ""; }} />
        </div>
        {mainHistory.length > 0 && (
          <div className={st.unitRow}>
            <span className="cds--label rh-dim">History</span>
            <div style={{ minWidth: 0 }}>
              {mainHistory.map((f) => (
                <FileLine key={f.id} name={f.fileName} size={fmtSize(f.sizeBytes)} dim
                          extra={<Button kind="ghost" size="sm" onClick={() => activateFile(f)}>Use this</Button>}
                          onDownload={() => api.downloadUnitFile(code, unit.id, f.id, f.fileName)} onRemove={() => removeFile(f)} />
              ))}
            </div>
            <span />
          </div>
        )}
        <div className={st.unitRow}>
          <span className="cds--label">Datasource</span>
          <Select compact style={{ maxWidth: 280 }} value={unit.datasourceId ?? ""} placeholder="Report default"
                  onChange={async (v) => {
                    try {
                      await api.updateUnit(code, unit.id, { name: unit.name, engine: unit.engine, fmt: unit.fmt, configJson: unit.configJson, enabled: unit.enabled, datasourceId: v || null });
                      onChanged();
                    } catch (e) { toast(errMsg(e, "Update failed"), "error"); }
                  }}
                  options={[{ value: "", label: "Report default" }, ...datasources.map((d) => ({ value: d.id, label: d.name }))]} />
          <span />
        </div>
        {showCfg && (
          <Stack gap={4}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <span className="cds--label" style={{ margin: 0 }}>{unit.engine} config</span>
              {hasSchema && (
                <Toggle id={`raw-${unit.id}`} size="sm" labelText="Edit as JSON" hideLabel labelA="Edit as JSON" labelB="Edit as JSON"
                        toggled={rawMode} onToggle={toggleRawMode} style={{ marginLeft: "auto" }} />
              )}
            </div>
            {hasSchema && !rawMode ? (
              <SchemaForm props={reportProps} values={vals} onChange={onPropChange} />
            ) : (
              <TextArea id={`cfg-${unit.id}`} labelText="Engine config (JSON)" hideLabel className="rh-mono" rows={4}
                        value={cfg} onChange={(e) => setCfg(e.target.value)}
                        placeholder={hasSchema ? '{ ... }' : '{ "exportFormat": "pdf" }  · engine-specific options for THIS unit'} />
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button kind="ghost" size="sm" onClick={() => { setCfg(unit.configJson ?? ""); setVals(configToValues(unit.configJson)); setRawMode(false); setShowCfg(false); }}>Cancel</Button>
              {/* Primary-styled so users don't mistake the bottom "Save report metadata"
                  button for the one that persists THIS unit's engine config. */}
              <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={saveCfg}>Save engine config</Button>
            </div>
          </Stack>
        )}
        {unit.engine === "jasper" && (
          <div className={st.unitRow}>
            <span className="cds--label">Subreports</span>
            <div style={{ minWidth: 0 }}>
              {subs.length === 0 && <span className="cds--type-helper-text-01 rh-dim">none</span>}
              {subs.map((f) => (
                <FileLine key={f.id} name={f.fileName} size={fmtSize(f.sizeBytes)}
                          onDownload={() => api.downloadUnitFile(code, unit.id, f.id, f.fileName)} onRemove={() => removeFile(f)} />
              ))}
            </div>
            <FileUploaderButton labelText="Add" size="sm" buttonKind="ghost" multiple disableLabelChanges disabled={busy} accept={[".jrxml"]}
                                onChange={(e) => { upload(e.target.files, "subreport"); e.target.value = ""; }} />
          </div>
        )}

        {unit.engine === "jasper" && (
          <div className={st.unitRow}>
            <span className="cds--label">Resources</span>
            <div style={{ minWidth: 0 }}>
              {resources.length === 0 && <span className="cds--type-helper-text-01 rh-dim">none · logo / image / font</span>}
              {resources.map((f) => (
                <FileLine key={f.id} name={f.fileName} size={fmtSize(f.sizeBytes)}
                          onDownload={() => api.downloadUnitFile(code, unit.id, f.id, f.fileName)} onRemove={() => removeFile(f)} />
              ))}
            </div>
            <span title="Upload a logo/image/font referenced via $P{SUBREPORT_DIR}">
              <FileUploaderButton labelText="Add" size="sm" buttonKind="ghost" multiple disableLabelChanges disabled={busy} accept={[".png", ".jpg", ".jpeg", ".ttf"]}
                                  onChange={(e) => { upload(e.target.files, "resource"); e.target.value = ""; }} />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** One uploaded file: name · size · download · remove (+ optional extra action). */
function FileLine({ name, size, dim, extra, onDownload, onRemove }: {
  name: string; size: string; dim?: boolean; extra?: React.ReactNode; onDownload: () => void; onRemove: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)", minWidth: 0 }}>
      <span className={`cds--type-code-01 rh-ellipsis ${dim ? "rh-dim" : ""}`} style={{ flex: 1, minWidth: 0 }} title={name}>{name}</span>
      <span className="cds--type-helper-text-01 rh-dim" style={{ flex: "none" }}>{size}</span>
      {extra}
      <IconButton kind="ghost" size="sm" label="Download" align="top-end" onClick={onDownload}><Download /></IconButton>
      <IconButton kind="ghost" size="sm" label="Remove" align="top-end" onClick={onRemove}><Close /></IconButton>
    </div>
  );
}

/** Real assigned parameters + assignment editor backed by the catalog. */
function Parameters({ r }: { r: RD }) {
  const toast = useToast();
  const [assigned, setAssigned] = useState<ParamDef[] | null>(null);
  const [catalog, setCatalog] = useState<ParamDef[]>([]);
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [reqOverride, setReqOverride] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.reportParameters(r.code).then((ps) => {
      setAssigned(ps);
      setNames(ps.map((p) => p.name));
      setReqOverride(Object.fromEntries(ps.map((p) => [p.name, p.requiredOverride ?? p.required])));
    }).catch(() => setAssigned([]));
  }, [r.code]);
  useEffect(() => { reload(); api.parameters().then(setCatalog).catch(() => {}); }, [reload]);

  async function save() {
    setBusy(true);
    try {
      const items = names.map((n) => ({
        name: n,
        requiredOverride: reqOverride[n] ?? (catalog.find((c) => c.name === n)?.required ?? false),
      }));
      await api.assignReportParameters(r.code, items);
      toast("Report parameters saved", "ok");
      setEditing(false);
      reload();
    } catch (e) {
      toast(errMsg(e, "Save failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  if (assigned === null) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: "var(--cds-spacing-03)" }}>
        <h3 className="cds--type-heading-compact-01">Runtime parameters ({assigned.length})</h3>
        <Button kind="ghost" size="sm" renderIcon={editing ? undefined : Edit} style={{ marginLeft: "auto" }} onClick={() => setEditing((e) => !e)}>
          {editing ? "Cancel" : "Edit list"}
        </Button>
      </div>

      {!editing ? (
        <DataList<Omit<ParamDef, "id"> & { id: string }>
          rows={assigned.map((p) => ({ ...p, id: p.name }))}
          search={false}
          size="sm"
          empty='Nothing assigned — use "Edit list" to pick from the catalog'
          columns={[
            { key: "name", header: "Name", render: (p) => <span className="cds--type-code-01" style={{ fontWeight: 600 }}>{p.name}</span> },
            { key: "label", header: "Label" },
            { key: "sourceType", header: "Source", render: (p) => p.sourceType === "query"
              ? <span><span className="rh-dim">lookup</span>{p.lookupTable && <span className="cds--type-code-01" style={{ marginLeft: 6 }}>{p.lookupTable}</span>}</span>
              : p.sourceType === "sql"
                ? <span><span className="rh-dim">sql</span>{p.datasourceId && <span className="cds--type-code-01" style={{ marginLeft: 6 }}>{p.datasourceId}</span>}</span>
                : <span className="rh-dim">static</span> },
            { key: "dependsOn", header: "Depends on", render: (p) => p.dependsOn ? <span className="cds--type-code-01">← {p.dependsOn}</span> : "—" },
            { key: "required", header: "Required", sortValue: (p) => ((p.requiredOverride ?? p.required) ? 1 : 0),
              render: (p) => (p.requiredOverride ?? p.required) ? <Tag size="sm" type="blue">required</Tag> : <span className="rh-dim">optional</span> },
          ]}
        />
      ) : (
        <div>
          <div style={{ display: "flex", flexDirection: "column", marginBottom: "var(--cds-spacing-05)" }}>
            {catalog.map((p) => {
              const on = names.includes(p.name);
              const req = reqOverride[p.name] ?? p.required;
              return (
                <div key={p.name} style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)", borderBottom: "1px solid var(--cds-border-subtle-01)", padding: "var(--cds-spacing-02) 0" }}>
                  <Checkbox id={`rdp-${p.name}`} checked={on}
                            labelText={<><span className="cds--type-code-01" style={{ fontWeight: 600 }}>{p.name}</span> <span className="rh-dim">{p.label}</span></>}
                            onChange={() => {
                              setNames((x) => on ? x.filter((n) => n !== p.name) : [...x, p.name]);
                              if (!on && reqOverride[p.name] === undefined) setReqOverride((m) => ({ ...m, [p.name]: p.required }));
                            }} />
                  {p.dependsOn && <Tag size="sm" type="outline">← {p.dependsOn}</Tag>}
                  {on && (
                    <span style={{ marginLeft: "auto" }} title="Required for this report">
                      <Checkbox id={`rdp-req-${p.name}`} labelText="required" checked={req}
                                onChange={(_, { checked }) => setReqOverride((m) => ({ ...m, [p.name]: checked }))} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={busy}>Save assignment</Button>
        </div>
      )}
    </div>
  );
}

/** Real run history (jobs of this report). */
function History({ r }: { r: RD }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  useEffect(() => {
    api.reportJobs(r.code, 15).then(setJobs).catch(() => setJobs([]));
  }, [r.code]);

  if (jobs === null) return <Skeleton />;
  return (
    <DataList<Job>
      title="Recent runs"
      rows={jobs}
      search={false}
      size="md"
      empty="No runs yet"
      columns={[
        { key: "state", header: "State", render: (h) => (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {h.state === "done" ? <CheckmarkFilled style={{ fill: "var(--cds-support-success)" }} />
              : h.state === "error" ? <WarningAltFilled style={{ fill: "var(--cds-support-error)" }} />
              : <Time style={{ fill: "var(--cds-support-warning)" }} />}
            {h.state}
          </span>
        ) },
        { key: "requestedBy", header: "By", render: (h) => (
          <div>
            <div>{h.requestedBy ?? "—"}</div>
            <div className="cds--type-code-01 rh-dim">{h.id}</div>
          </div>
        ) },
        { key: "startedAt", header: "Started", render: (h) => <span className="cds--type-code-01">{localTime(h.startedAt, true)}</span> },
        { key: "fmt", header: "Format", render: (h) => <FmtTag f={h.fmt} /> },
      ]}
    />
  );
}

const TYPE_META: Record<string, { label: string; tag: "blue" | "purple" | "teal"; icon: string }> = {
  config: { label: "config", tag: "blue", icon: "doc" },
  template: { label: "template", tag: "purple", icon: "layers" },
  both: { label: "config + template", tag: "teal", icon: "star" },
};

/** Real version history from report_version. */
function Versions({ r }: { r: RD }) {
  const [vers, setVers] = useState<VersionEntry[] | null>(null);
  useEffect(() => {
    api.reportVersions(r.code).then(setVers).catch(() => setVers([]));
  }, [r.code]);

  if (vers === null) return <Skeleton />;
  return (
    <div>
      <h3 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-05)" }}>Version history</h3>
      {vers.length === 0 && <p className="cds--type-body-compact-01 rh-dim">No versions yet</p>}
      <ol className={st.timeline}>
        {vers.map((v) => {
          const tm = TYPE_META[v.changeType] ?? TYPE_META.both;
          return (
            <li key={v.id} className={v.current ? st.timelineCurrent : undefined}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)", flexWrap: "wrap" }}>
                <span className="cds--type-heading-compact-01 cds--type-code-02">v{v.version}</span>
                {v.current && <Tag size="sm" type="green">current</Tag>}
                <Tag size="sm" type={tm.tag} renderIcon={carbonIcon(tm.icon)}>{tm.label}</Tag>
              </div>
              <div className="cds--type-body-compact-01" style={{ marginTop: "var(--cds-spacing-02)" }}>{v.note}</div>
              <div className="cds--type-code-01 rh-dim" style={{ marginTop: "var(--cds-spacing-01)" }}>{localTime(v.createdAt, true)} · {v.createdBy}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
