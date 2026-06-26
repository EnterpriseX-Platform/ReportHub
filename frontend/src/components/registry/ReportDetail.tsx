"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { SlideOver } from "@/components/overlays";
import { EngineBadge, StatusChip, Fmts, FmtTag, MiniStat } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { ENGINES } from "@/lib/model";
import { fmtMs } from "@/lib/format";
import { Select } from "@/components/Select";
import { SchemaForm, configToValues, valuesToConfig } from "@/components/SchemaForm";
import type { Category, Datasource, EngineDescriptor, Job, ParamDef, ReportDetail as RD, ReportUnit, UnitFile, VersionEntry } from "@/lib/types";

const TABS = ["overview", "config", "parameters", "versions", "history"] as const;
type Tab = (typeof TABS)[number];

const ENGINE_KINDS = ["jasper", "component", "api", "sql", "composite", "http"];
const ALL_FORMATS = ["PDF", "XLSX", "DOCX", "CSV"];
const STATUSES = ["active", "testing", "draft", "error"];

export function ReportDetail({ code, onClose }: { code: string; onClose: () => void }) {
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
      <SlideOver title="Loading…" onClose={onClose}>
        <div className="empty"><span className="spin" /></div>
      </SlideOver>
    );
  }

  return (
    <SlideOver
      title={r.name}
      sub={`${r.code} · ${r.categoryName ?? ""}`}
      badge={<><EngineBadge engine={r.engine} /><StatusChip s={r.status} /></>}
      onClose={onClose}
      foot={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn" onClick={() => setTab("config")}><Icon name="edit" size={15} />Configure</button>
        {r.engine !== "other" && (
          <button className="btn primary" onClick={() => router.push(`/runtask?code=${r.code}`)}><Icon name="play" size={15} />Run task</button>
        )}
      </>}
    >
      <div className="seg" style={{ marginBottom: 18, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {tab === "overview" && <Overview r={r} />}
      {tab === "config" && <ConfigForm r={r} onSaved={reload} />}
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
    <div className="fade-in">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
        <MiniStat label="Runs (30d)" value={r.runs} />
        <MiniStat label="Avg render" value={fmtMs(r.avgMs)} />
        <MiniStat label="Version" value={r.version} />
        <MiniStat label="Output formats" value={<Fmts list={r.formats} />} />
      </div>
      <div className="section-label">Definition</div>
      <div className="kv"><span className="k">Source engine</span><span className="v"><EngineBadge engine={r.engine} /> <span style={{ color: "var(--ink-3)", fontSize: 12 }}>{ENGINES[r.engine]?.desc}</span></span></div>
      <div className="kv"><span className="k">Category</span><span className="v">{r.categoryName}</span></div>
      <div className="kv"><span className="k">Template</span><span className="v mono" style={{ fontSize: 11.5 }}>{r.templatePath ?? "—"}</span></div>
      <div className="kv"><span className="k">Owner unit</span><span className="v">{r.ownerUnit ?? "—"}</span></div>
      {appModule && (
        <div className="kv" style={{ alignItems: "flex-start" }}>
          <span className="k">App module / information</span>
          <span className="v" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{appModule}</span>
        </div>
      )}
      <div className="divider" />
      <div className="section-label">Datasource &amp; gateway</div>
      <div style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 10, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <Icon name="datasource" size={18} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}><b style={{ fontSize: 13 }}>{r.datasourceName ?? r.datasourceId ?? "—"}</b></div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="tag-pill"><Icon name="queue" size={13} />topic: report.jobs</span>
          <span className="tag-pill"><Icon name="bolt" size={13} />priority: normal</span>
          <span className="tag-pill"><Icon name="clock" size={13} />timeout: 120s</span>
        </div>
      </div>
    </div>
  );
}

/** The Config screen — a real form persisted via PUT /reports/{code} (bumps the version). */
function ConfigForm({ r, onSaved }: { r: RD; onSaved: () => void }) {
  const toast = useToast();
  const [cats, setCats] = useState<Category[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [formats, setFormats] = useState<string[]>(r.formats);
  const [status, setStatus] = useState<string>(r.status);
  const [categoryId, setCategoryId] = useState(r.categoryId);
  const [datasourceId, setDatasourceId] = useState(r.datasourceId ?? "");
  const [ownerUnit, setOwnerUnit] = useState(r.ownerUnit ?? "");
  const [outputFolder, setOutputFolder] = useState(r.outputFolder ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.categories().then(setCats).catch(() => {});
    api.datasources().then(setDss).catch(() => {});
  }, []);

  function toggleFormat(f: string) {
    setFormats((s) => (s.includes(f) ? s.filter((x) => x !== f) : [...s, f]));
  }

  async function save() {
    if (formats.length === 0) { toast("Pick at least one format", "error"); return; }
    setBusy(true);
    try {
      await api.updateReport(r.code, {
        formats, status, categoryId,
        datasourceId, ownerUnit, outputFolder,
        note: note.trim() || undefined,
      });
      toast(`Configuration saved · version bumped`, "ok");
      setNote("");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div className="section-label" style={{ margin: 0 }}>Report configuration</div>
        <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>v{r.version} · saving bumps the minor version</span>
      </div>

      {/* The unit set IS the report definition — engine/format/config live on each unit. */}
      <UnitsManager code={r.code} onChanged={onSaved} />

      <div className="divider" style={{ margin: "4px 0" }} />

      <div className="section-label" style={{ margin: "2px 0 0" }}>Report info</div>
      <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field"><label>Status</label>
          <Select value={status} onChange={setStatus} options={STATUSES.map((x) => ({ value: x, label: x }))} /></div>
        <div className="field"><label>Default datasource</label>
          <Select value={datasourceId} onChange={setDatasourceId} placeholder="— none —"
                  options={[{ value: "", label: "— none —" }, ...dss.map((d) => ({ value: d.id, label: d.name }))]} /></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label>Category</label>
          <Select value={categoryId} onChange={setCategoryId}
                  options={cats.map((c) => ({ value: c.id, label: c.name }))} /></div>
      </div>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center" }}>Run formats
          <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>choices at run time for units set to "job format"</span></label>
        <div style={{ display: "flex", gap: 7 }}>
          {ALL_FORMATS.map((f) => (
            <button key={f} className="btn sm" onClick={() => toggleFormat(f)}
                    style={{ borderColor: formats.includes(f) ? "var(--accent)" : undefined, background: formats.includes(f) ? "var(--accent-weak)" : undefined, color: formats.includes(f) ? "var(--accent)" : undefined }}>
              {formats.includes(f) && <Icon name="check" size={12} />}{f}
            </button>
          ))}
        </div></div>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center" }}>Output folder
          <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>where rendered files land — type a path or use placeholders</span></label>
        <input className="input mono" value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)} placeholder="{code}  ·  e.g. {category}/{yyyy}/{MM}" />
        <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
          {["{code}", "{category}", "{unit}", "{fmt}", "{yyyy}", "{MM}", "{dd}"].map((t) => (
            <button key={t} type="button" className="tag-pill" style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10 }}
                    onClick={() => setOutputFolder((s) => (s ? s.replace(/\/?$/, "") + "/" + t : t))}>{t}</button>
          ))}
        </div>
        {outputFolder && (
          <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 5 }}>
            preview: /{outputFolder
              .replace("{code}", r.code).replace("{category}", r.categoryName ?? "category")
              .replace("{unit}", "default").replace("{fmt}", "pdf")
              .replace("{yyyy}", String(new Date().getFullYear())).replace("{MM}", String(new Date().getMonth() + 1).padStart(2, "0")).replace("{dd}", String(new Date().getDate()).padStart(2, "0"))}/…
          </div>
        )}
      </div>

      <div className="field"><label>Owner unit</label>
        <input className="input" value={ownerUnit} onChange={(e) => setOwnerUnit(e.target.value)} placeholder="Strategy division" /></div>

      <div className="field"><label>Change note (recorded in version history)</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Adjusted datasource and template" /></div>

      {/* Saves the REPORT-level metadata (status, datasource, owner, change note) —
          NOT the per-unit engine config inside each UnitCard. Each unit has its own
          "Save engine config" button. Labelled explicitly so users editing a unit's
          engine config don't mistake this big blue button for theirs. */}
      <button className="btn primary" style={{ height: 40 }} onClick={save} disabled={busy}>
        {busy ? <span className="spin" /> : <Icon name="check" size={15} />}Save report metadata
      </button>
    </div>
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
      toast(e instanceof Error ? e.message : "Create failed", "error");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="field">
      <label style={{ display: "flex", alignItems: "center" }}>
        Outputs ({items?.length ?? 0})
        <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--ink-4)" }}>
          what this report produces — one file per output, each with its own engine / template / format
        </span>
      </label>

      {items === null && <div className="empty" style={{ padding: 14 }}><span className="spin" /></div>}
      {items?.map((u) => (
        <UnitCard key={u.id} code={code} unit={u} datasources={dss}
                  reportProps={engineDescriptors.find((d) => d.kind === u.engine)?.reportProps ?? []}
                  onChanged={() => { reload(); onChanged(); }} />
      ))}
      {items?.length === 0 && (
        <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--ink-4)", border: "1px dashed var(--line-strong)", borderRadius: 10, marginBottom: 8 }}>
          No outputs yet — add one to define what this report produces (one run renders them all).
        </div>
      )}

      <div style={{ display: "flex", gap: 7, marginTop: 6 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Output name · e.g. summary-pdf" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Select style={{ width: 130 }} value={newEngine} onChange={setNewEngine}
                options={ENGINE_KINDS.map((k) => ({ value: k, label: k }))} />
        <Select style={{ width: 120 }} value={newFmt} onChange={setNewFmt} placeholder="job format"
                options={[{ value: "", label: "job format" }, ...ALL_FORMATS.map((f) => ({ value: f, label: f }))]} />
        <button className="btn sm" style={{ height: 38 }} disabled={adding} onClick={addUnit}>
          {adding ? <span className="spin" /> : <Icon name="plus" size={14} />}Add output
        </button>
      </div>
    </div>
  );
}

function UnitCard({ code, unit, datasources, reportProps, onChanged }: { code: string; unit: ReportUnit; datasources: Datasource[]; reportProps: EngineDescriptor["reportProps"]; onChanged: () => void }) {
  const toast = useToast();
  const mainRef = useRef<HTMLInputElement>(null);
  const subRef = useRef<HTMLInputElement>(null);
  const resRef = useRef<HTMLInputElement>(null);
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
      toast(e instanceof Error ? e.message : "Save failed", "error");
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
      toast(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    try {
      await api.updateUnit(code, unit.id, { name: unit.name, engine: unit.engine, fmt: unit.fmt, datasourceId: unit.datasourceId, configJson: unit.configJson, enabled: !unit.enabled });
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "error");
    }
  }

  async function removeUnit() {
    if (!window.confirm(`Delete output ${unit.name}?`)) return;
    try {
      await api.deleteUnit(code, unit.id);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  async function removeFile(f: UnitFile) {
    try {
      await api.deleteUnitFile(code, unit.id, f.id);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  async function activateFile(f: UnitFile) {
    try {
      await api.activateUnitFile(code, unit.id, f.id);
      toast(`Activated ${f.fileName}`, "ok");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Activate failed", "error");
    }
  }

  const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, marginBottom: 8, opacity: unit.enabled ? 1 : 0.55 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)" }}>
        <Icon name="layers" size={14} style={{ color: "var(--accent)" }} />
        <b style={{ fontSize: 12.5 }}>{unit.name}</b>
        <EngineBadge engine={unit.engine} sm />
        <span className="tag-pill" style={{ fontSize: 10 }}>{unit.fmt ?? "job format"}</span>
        {!unit.enabled && <span className="chip" style={{ height: 17 }}>disabled</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          <button className="btn sm ghost" style={{ height: 24, color: unit.configJson ? "var(--accent)" : undefined }} title="Engine config (JSON)" onClick={() => setShowCfg((v) => !v)}>
            <Icon name="settings" size={12} />
          </button>
          <button className="btn sm ghost" style={{ height: 24 }} title={unit.enabled ? "Disable" : "Enable"} onClick={toggleEnabled}>
            <Icon name={unit.enabled ? "pause" : "play"} size={12} />
          </button>
          <button className="btn sm ghost" style={{ height: 24 }} title="Delete output" onClick={removeUnit}><Icon name="x" size={12} /></button>
        </span>
      </div>
      <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="section-label" style={{ margin: 0, width: 86 }}>Main</span>
          {main ? (
            <>
              <span className="mono" style={{ fontSize: 11, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{main.fileName}</span>
              <span style={{ fontSize: 10, color: "var(--ink-4)" }}>{fmtSize(main.sizeBytes)}</span>
              <button className="btn sm ghost" style={{ height: 22 }} onClick={() => api.downloadUnitFile(code, unit.id, main.id, main.fileName)}><Icon name="download" size={11} /></button>
              <button className="btn sm ghost" style={{ height: 22 }} onClick={() => removeFile(main)}><Icon name="x" size={11} /></button>
            </>
          ) : <span style={{ fontSize: 11.5, color: "var(--ink-4)", flex: 1 }}>built-in layout (no template uploaded)</span>}
          <input ref={mainRef} type="file" style={{ display: "none" }} accept=".jrxml,.docx,.xlsx,.yml,.yaml,.json,.html" onChange={(e) => { upload(e.target.files, "main"); e.target.value = ""; }} />
          <button className="btn sm" style={{ height: 24 }} disabled={busy} onClick={() => mainRef.current?.click()}>
            {busy ? <span className="spin" /> : <Icon name="upload" size={11} />}{main ? "Replace" : "Upload"}
          </button>
        </div>
        {mainHistory.length > 0 && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <span className="section-label" style={{ margin: "3px 0 0", width: 86, color: "var(--ink-4)" }}>History</span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              {mainHistory.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 4px", borderRadius: 6, background: "var(--surface-2)" }}>
                  <Icon name="doc" size={11} style={{ color: "var(--ink-4)", flex: "none" }} />
                  <span className="mono" style={{ fontSize: 10.5, flex: 1, minWidth: 0, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.fileName}</span>
                  <span style={{ fontSize: 9.5, color: "var(--ink-4)", flex: "none" }}>{fmtSize(f.sizeBytes)}</span>
                  <button className="btn sm ghost" style={{ height: 20, fontSize: 10 }} onClick={() => activateFile(f)}>Use this</button>
                  <button className="btn sm ghost" style={{ height: 20 }} onClick={() => api.downloadUnitFile(code, unit.id, f.id, f.fileName)}><Icon name="download" size={10} /></button>
                  <button className="btn sm ghost" style={{ height: 20 }} onClick={() => removeFile(f)}><Icon name="x" size={10} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="section-label" style={{ margin: 0, width: 86 }}>Datasource</span>
          <Select style={{ flex: 1, maxWidth: 280 }} value={unit.datasourceId ?? ""} placeholder="Report default"
                  onChange={async (v) => {
                    try {
                      await api.updateUnit(code, unit.id, { name: unit.name, engine: unit.engine, fmt: unit.fmt, configJson: unit.configJson, enabled: unit.enabled, datasourceId: v || null });
                      onChanged();
                    } catch (e) { toast(e instanceof Error ? e.message : "Update failed", "error"); }
                  }}
                  options={[{ value: "", label: "Report default" }, ...datasources.map((d) => ({ value: d.id, label: d.name }))]} />
        </div>
        {showCfg && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <span className="section-label" style={{ margin: 0 }}>{unit.engine} config</span>
              {hasSchema && (
                <button className="btn sm ghost" style={{ height: 22, marginLeft: "auto", fontSize: 11 }} onClick={toggleRawMode}>
                  {rawMode ? "Form" : "Edit as JSON"}
                </button>
              )}
            </div>
            {hasSchema && !rawMode ? (
              <SchemaForm props={reportProps} values={vals} onChange={onPropChange} />
            ) : (
              <textarea className="input mono" style={{ height: 90, paddingTop: 8, resize: "vertical", fontSize: 11 }}
                        value={cfg} onChange={(e) => setCfg(e.target.value)}
                        placeholder={hasSchema ? '{ ... }' : '{ "exportFormat": "pdf" }  · engine-specific options for THIS unit'} />
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button className="btn sm ghost" style={{ height: 24 }} onClick={() => { setCfg(unit.configJson ?? ""); setVals(configToValues(unit.configJson)); setRawMode(false); setShowCfg(false); }}>Cancel</button>
              {/* Primary-styled so users don't mistake the bottom "Save report metadata"
                  button for the one that persists THIS unit's engine config. */}
              <button className="btn sm primary" style={{ height: 24 }} onClick={saveCfg}><Icon name="check" size={11} />Save engine config</button>
            </div>
          </div>
        )}
        {unit.engine === "jasper" && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <span className="section-label" style={{ margin: "4px 0 0", width: 86 }}>Subreports</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {subs.length === 0 && <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>none</span>}
              {subs.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0" }}>
                  <Icon name="doc" size={11} style={{ color: "var(--ink-4)" }} />
                  <span className="mono" style={{ fontSize: 11, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.fileName}</span>
                  <span style={{ fontSize: 10, color: "var(--ink-4)" }}>{fmtSize(f.sizeBytes)}</span>
                  <button className="btn sm ghost" style={{ height: 22 }} onClick={() => api.downloadUnitFile(code, unit.id, f.id, f.fileName)}><Icon name="download" size={11} /></button>
                  <button className="btn sm ghost" style={{ height: 22 }} onClick={() => removeFile(f)}><Icon name="x" size={11} /></button>
                </div>
              ))}
            </div>
            <input ref={subRef} type="file" multiple style={{ display: "none" }} accept=".jrxml" onChange={(e) => { upload(e.target.files, "subreport"); e.target.value = ""; }} />
            <button className="btn sm" style={{ height: 24 }} disabled={busy} onClick={() => subRef.current?.click()}>
              {busy ? <span className="spin" /> : <Icon name="plus" size={11} />}Add
            </button>
          </div>
        )}

        {unit.engine === "jasper" && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <span className="section-label" style={{ margin: "4px 0 0", width: 86 }}>Resources</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {resources.length === 0 && <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>none · logo / image / font</span>}
              {resources.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0" }}>
                  <Icon name="doc" size={11} style={{ color: "var(--ink-4)" }} />
                  <span className="mono" style={{ fontSize: 11, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.fileName}</span>
                  <span style={{ fontSize: 10, color: "var(--ink-4)" }}>{fmtSize(f.sizeBytes)}</span>
                  <button className="btn sm ghost" style={{ height: 22 }} onClick={() => api.downloadUnitFile(code, unit.id, f.id, f.fileName)}><Icon name="download" size={11} /></button>
                  <button className="btn sm ghost" style={{ height: 22 }} onClick={() => removeFile(f)}><Icon name="x" size={11} /></button>
                </div>
              ))}
            </div>
            <input ref={resRef} type="file" multiple style={{ display: "none" }} accept=".png,.jpg,.jpeg,.ttf" onChange={(e) => { upload(e.target.files, "resource"); e.target.value = ""; }} />
            <button className="btn sm" style={{ height: 24 }} disabled={busy} onClick={() => resRef.current?.click()} title="Upload a logo/image/font referenced via $P{SUBREPORT_DIR}">
              {busy ? <span className="spin" /> : <Icon name="plus" size={11} />}Add
            </button>
          </div>
        )}
      </div>
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
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  if (assigned === null) return <div className="empty"><span className="spin" /></div>;

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <div className="section-label" style={{ margin: 0 }}>Runtime parameters ({assigned.length})</div>
        <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setEditing((e) => !e)}>
          <Icon name="edit" size={13} />{editing ? "Cancel" : "Edit list"}
        </button>
      </div>

      {!editing ? (
        <table className="tbl" style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
          <thead><tr><th>Name</th><th>Label</th><th>Source</th><th>Depends on</th><th>Required</th></tr></thead>
          <tbody>
            {assigned.map((p) => (
              <tr key={p.name} style={{ cursor: "default" }}>
                <td className="mono strong">{p.name}</td>
                <td>{p.label}</td>
                <td>{p.sourceType === "query" ? <span className="chip blue" style={{ height: 19 }}>{p.lookupTable}</span> : <span style={{ color: "var(--ink-3)" }}>static</span>}</td>
                <td>{p.dependsOn ? <span className="mono" style={{ fontSize: 11.5, color: "var(--accent)" }}>← {p.dependsOn}</span> : "—"}</td>
                <td>{(p.requiredOverride ?? p.required) ? <span className="chip blue" style={{ height: 19 }}>required</span> : <span style={{ color: "var(--ink-4)" }}>optional</span>}</td>
              </tr>
            ))}
            {assigned.length === 0 && <tr><td colSpan={5}><div className="empty">Nothing assigned — use "Edit list" to pick from the catalog</div></td></tr>}
          </tbody>
        </table>
      ) : (
        <div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {catalog.map((p) => {
              const on = names.includes(p.name);
              const req = reqOverride[p.name] ?? p.required;
              return (
                <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 11px", borderRadius: 9, border: "1px solid " + (on ? "var(--accent-line)" : "var(--line)"), background: on ? "var(--accent-weak)" : "var(--surface)" }}>
                  <input type="checkbox" checked={on} onChange={() => {
                    setNames((s) => on ? s.filter((n) => n !== p.name) : [...s, p.name]);
                    if (!on && reqOverride[p.name] === undefined) setReqOverride((m) => ({ ...m, [p.name]: p.required }));
                  }} />
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{p.label}</span>
                  {p.dependsOn && <span className="chip blue" style={{ height: 17, fontSize: 9.5 }}>← {p.dependsOn}</span>}
                  {on && (
                    <label style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: "auto", fontSize: 11.5, color: "var(--ink-2)", cursor: "pointer" }} title="Required for this report">
                      <input type="checkbox" checked={req} onChange={(e) => setReqOverride((m) => ({ ...m, [p.name]: e.target.checked }))} />
                      required
                    </label>
                  )}
                </div>
              );
            })}
          </div>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <span className="spin" /> : <Icon name="check" size={15} />}Save assignment
          </button>
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

  if (jobs === null) return <div className="empty"><span className="spin" /></div>;
  return (
    <div className="fade-in">
      <div className="section-label">Recent runs</div>
      {jobs.length === 0 && <div className="empty">No runs yet</div>}
      {jobs.map((h) => (
        <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 0", borderBottom: "1px dashed var(--line)" }}>
          <Icon name={h.state === "done" ? "checkCircle" : h.state === "error" ? "alert" : "clock"} size={17}
                style={{ color: h.state === "done" ? "var(--green)" : h.state === "error" ? "var(--red)" : "var(--amber)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5 }}>{h.requestedBy ?? "—"} · <span className="mono" style={{ fontSize: 11 }}>{h.id}</span></div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{h.startedAt?.replace("T", " ").slice(0, 19)}</div>
          </div>
          <FmtTag f={h.fmt} />
          <span className="chip" style={{ height: 19 }}>{h.state}</span>
        </div>
      ))}
    </div>
  );
}

const TYPE_META: Record<string, { label: string; color: string; icon: string }> = {
  config: { label: "config", color: "var(--blue)", icon: "doc" },
  template: { label: "template", color: "var(--violet)", icon: "layers" },
  both: { label: "config + template", color: "var(--green)", icon: "star" },
};

/** Real version history from report_version. */
function Versions({ r }: { r: RD }) {
  const [vers, setVers] = useState<VersionEntry[] | null>(null);
  useEffect(() => {
    api.reportVersions(r.code).then(setVers).catch(() => setVers([]));
  }, [r.code]);

  if (vers === null) return <div className="empty"><span className="spin" /></div>;
  return (
    <div className="fade-in">
      <div className="section-label">Version history</div>
      {vers.length === 0 && <div className="empty">No versions yet</div>}
      <div style={{ position: "relative" }}>
        {vers.map((v, i) => {
          const tm = TYPE_META[v.changeType] ?? TYPE_META.both;
          return (
            <div key={v.id} style={{ display: "flex", gap: 13, paddingBottom: 18, position: "relative" }}>
              {i < vers.length - 1 && <span style={{ position: "absolute", left: 13, top: 26, bottom: 0, width: 2, background: "var(--line)" }} />}
              <span style={{ width: 28, height: 28, borderRadius: 28, flex: "none", display: "grid", placeItems: "center", background: v.current ? "var(--accent)" : "var(--surface-3)", color: v.current ? "#fff" : "var(--ink-3)", border: "1px solid " + (v.current ? "var(--accent)" : "var(--line)"), zIndex: 1 }}>
                <Icon name={tm.icon} size={14} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <b className="mono" style={{ fontSize: 13 }}>v{v.version}</b>
                  {v.current && <span className="chip green" style={{ height: 18 }}>current</span>}
                  <span className="chip" style={{ height: 18, background: `color-mix(in srgb, ${tm.color} 13%, transparent)`, color: tm.color }}>{tm.label}</span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 3 }}>{v.note}</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 2 }}>{v.createdAt?.replace("T", " ").slice(0, 19)} · {v.createdBy}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
