"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/overlays";
import { EngineBadge, Fmts } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { ENGINES } from "@/lib/model";
import { api } from "@/lib/api";
import { Select } from "@/components/Select";
import { SchemaForm, valuesToConfig } from "@/components/SchemaForm";
import { fmtBytes } from "@/lib/format";
import type { Category, Datasource, EngineDescriptor, ParamDef, ReportDetail } from "@/lib/types";

const FORMATS = ["PDF", "XLSX", "DOCX", "CSV"];
const STEPS = ["Definition", "Template & Source", "Parameters", "Gateway & Review"];
// Mirrors UnitController ALLOWED_EXT / MAX_BYTES — backend re-validates on upload.
const ACCEPT: Record<string, string> = {
  jasper: ".jrxml",
  composite: ".jrxml,.docx,.xlsx,.yml,.yaml,.json,.html",
  component: ".jrxml,.docx,.xlsx,.yml,.yaml,.json,.html",
};
const MAX_BYTES = 25 * 1024 * 1024;

export function RegisterWizard({
  categories,
  datasources,
  onClose,
  onCreated,
}: {
  categories: Category[];
  datasources: Datasource[];
  onClose: () => void;
  onCreated: (r: ReportDetail) => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [catalog, setCatalog] = useState<ParamDef[]>([]);
  const [selectedParams, setSelectedParams] = useState<string[]>([]);
  const [f, setF] = useState({
    th: "", code: "RPT-A-" + Math.floor(100 + Math.random() * 800),
    cat: categories[0]?.id ?? "c4", owner: "", ds: datasources[0]?.id ?? "ds-core",
    fmt: ["PDF", "XLSX"], engine: "jasper", unitFmt: "", cfgVals: {} as Record<string, string>, priority: "normal", timeout: 120, topic: "report.jobs",
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const [descriptors, setDescriptors] = useState<EngineDescriptor[]>([]);

  useEffect(() => {
    api.parameters().then(setCatalog).catch(() => {});
    api.engines().then((d) => setDescriptors(d.descriptors ?? [])).catch(() => {});
  }, []);

  const reportProps = descriptors.find((d) => d.kind === f.engine)?.reportProps ?? [];
  const hasSchema = reportProps.length > 0;
  const canNext = [
    f.th.trim() && f.code.trim() && f.owner.trim(),
    f.ds && f.fmt.length > 0 && reportProps.filter((p) => p.required).every((p) => (f.cfgVals[p.key] ?? "").trim()),
    true,
    true,
  ][step];

  const catOf = (id: string) => categories.find((c) => c.id === id);
  const dsOf = (id: string) => datasources.find((d) => d.id === id);

  // Merge static engine definitions with any loaded descriptor kinds not already in ENGINES
  // (e.g. http engines installed via the Engines page, or future JAR plugin kinds).
  const engineCards: [string, typeof ENGINES[string]][] = [
    ...Object.entries(ENGINES),
    ...descriptors
      .filter((d) => !ENGINES[d.kind])
      .map((d) => [d.kind, { label: d.label, th: d.requiresInstance ? "Installed engine" : "Built-in engine", icon: "engine" as const, color: "#5a6a7a", ext: "bin", desc: d.label }] as [string, typeof ENGINES[string]]),
  ];

  function pickEngine(k: string) {
    setF((s) => ({ ...s, engine: k, cfgVals: {} }));
    setFile(null);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    const accept = ACCEPT[f.engine];
    if (accept) {
      const ext = picked.name.split(".").pop()?.toLowerCase() ?? "";
      const allowed = accept.split(",").map((s) => s.trim().replace(".", ""));
      if (!allowed.includes(ext)) { toast(`File type .${ext} is not allowed — expected ${accept}`, "error"); return; }
    }
    if (picked.size > MAX_BYTES) { toast("File exceeds the 25 MB limit", "error"); return; }
    setFile(picked);
  }

  async function submit() {
    setBusy(true);
    let r: ReportDetail;
    try {
      r = await api.createReport({
        code: f.code, name: f.th, categoryId: f.cat, engine: f.engine, formats: f.fmt,
        datasourceId: f.ds, ownerUnit: f.owner, paramCount: selectedParams.length, note: "Registered via wizard",
      });
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
      return;
    }
    try {
      const units = await api.reportUnits(f.code);
      const unit = units[0] ?? await api.createUnit(f.code, { name: "default", engine: f.engine });
      const configJson = valuesToConfig(f.cfgVals, reportProps.map((p) => p.key));
      await api.updateUnit(f.code, unit.id, {
        name: unit.name, engine: f.engine, fmt: f.unitFmt || null, configJson,
        datasourceId: f.ds || null, enabled: true,
      });
      if (file) await api.uploadUnitFile(f.code, unit.id, file, "main");
      if (selectedParams.length > 0) {
        await api.assignReportParameters(f.code, selectedParams.map((n) => ({ name: n, requiredOverride: null })));
      }
    } catch (e) {
      toast(`Report ${f.code} created, but output setup failed: ${(e as Error).message} — fix it in the detail view`, "error");
    }
    onCreated(r);
  }

  return (
    <Modal
      title="Register report"
      sub="Add a report to the catalog"
      onClose={onClose}
      width={720}
      foot={<>
        <div style={{ marginRight: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {STEPS.map((_, i) => <span key={i} style={{ width: i === step ? 22 : 7, height: 7, borderRadius: 7, background: i <= step ? "var(--accent)" : "var(--line-strong)", transition: ".2s" }} />)}
        </div>
        {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
        {step < 3
          ? <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue <Icon name="chevron" size={15} /></button>
          : <button className="btn primary" disabled={busy} onClick={submit}>{busy ? <span className="spin" /> : <Icon name="check" size={15} />}Register report</button>}
      </>}
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 22 }}>
        {STEPS.map((s, i) => (
          <div key={i} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, opacity: i <= step ? 1 : 0.5 }}>
            <span style={{ width: 24, height: 24, borderRadius: 24, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, background: i < step ? "var(--green)" : i === step ? "var(--accent)" : "var(--surface-3)", color: i <= step ? "#fff" : "var(--ink-4)", flex: "none" }}>
              {i < step ? <Icon name="check" size={13} /> : i + 1}
            </span>
            <span style={{ fontSize: 12, fontWeight: i === step ? 600 : 500, color: i === step ? "var(--ink)" : "var(--ink-3)" }}>{s}</span>
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field"><label>Report name</label>
            <input className="input" placeholder="e.g. National strategy summary report" value={f.th} onChange={(e) => set("th", e.target.value)} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="field"><label>Report code</label><input className="input mono" value={f.code} onChange={(e) => set("code", e.target.value)} /></div>
            <div className="field"><label>Owner unit</label><input className="input" placeholder="e.g. Strategy division" value={f.owner} onChange={(e) => set("owner", e.target.value)} /></div>
          </div>
          <div className="field"><label>Category</label>
            <Select value={f.cat} onChange={(v) => set("cat", v)}
              options={categories.map((c) => ({ value: c.id, label: c.name }))} />
            <span className="hint">Determines the report&apos;s category.</span>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field"><label>Source engine</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {engineCards.map(([k, e]) => (
                <div key={k} onClick={() => pickEngine(k)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 11px", borderRadius: 9, cursor: "pointer", border: "1px solid " + (f.engine === k ? "var(--accent-line)" : "var(--line)"), background: f.engine === k ? "var(--accent-weak)" : "var(--surface)" }}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: `color-mix(in srgb, ${e.color} 14%, transparent)`, color: e.color, flex: "none" }}><Icon name={e.icon} size={16} /></span>
                  <div style={{ minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 600 }}>{e.label}</div><div style={{ fontSize: 10.5, color: "var(--ink-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.th}</div></div>
                  {f.engine === k && <Icon name="check" size={15} style={{ color: "var(--accent)", marginLeft: "auto" }} />}
                </div>
              ))}
            </div>
          </div>
          <div className="field"><label>{hasSchema ? (ENGINES[f.engine]?.label ?? f.engine) + " configuration" : "Template file (." + (ENGINES[f.engine]?.ext ?? "jrxml") + ")"}</label>
            {hasSchema ? (
              <SchemaForm props={reportProps} values={f.cfgVals} onChange={(k, v) => set("cfgVals", { ...f.cfgVals, [k]: v })} />
            ) : (
              <>
                <input ref={fileRef} type="file" style={{ display: "none" }} accept={ACCEPT[f.engine]} onChange={onPick} />
                {file ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--accent-line)", background: "var(--accent-weak)", borderRadius: 9, padding: "8px 12px" }}>
                    <Icon name="doc" size={15} style={{ color: "var(--accent)", flex: "none" }} />
                    <span className="mono" style={{ fontSize: 11.5, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</span>
                    <span style={{ fontSize: 10.5, color: "var(--ink-4)", flex: "none" }}>{fmtBytes(file.size)}</span>
                    <button className="btn sm" onClick={() => fileRef.current?.click()}>Replace</button>
                    <button className="icon-btn" style={{ width: 26, height: 26, border: 0 }} onClick={() => setFile(null)}><Icon name="x" size={14} /></button>
                  </div>
                ) : (
                  <button className="btn" style={{ width: "100%", justifyContent: "center", height: 42, borderStyle: "dashed" }} onClick={() => fileRef.current?.click()}>
                    <Icon name="upload" size={15} />Choose template file ({ACCEPT[f.engine]})
                  </button>
                )}
                <span className="hint">{ENGINES[f.engine]?.desc}{!file ? " — optional, built-in layout is used when no template is uploaded." : ""}</span>
              </>
            )}
          </div>
          <div className="field"><label>Datasource</label>
            <Select value={f.ds} onChange={(v) => set("ds", v)}
              options={datasources.map((d) => ({ value: d.id, label: `${d.name} — ${d.engine}` }))} />
          </div>
          <div className="field"><label>Output format</label>
            <div style={{ display: "flex", gap: 8 }}>
              {["", ...FORMATS].map((fm) => {
                const on = f.unitFmt === fm;
                return (
                  <button key={fm || "job"} className="btn sm" style={{ borderColor: on ? "var(--accent)" : undefined, background: on ? "var(--accent-weak)" : undefined, color: on ? "var(--accent)" : undefined }}
                    onClick={() => set("unitFmt", fm)}>
                    {on && <Icon name="check" size={14} />}{fm || "job format"}
                  </button>
                );
              })}
            </div>
            <span className="hint">Format of this output — "job format" follows the format chosen at run time.</span>
          </div>
          <div className="field"><label>Run formats</label>
            <div style={{ display: "flex", gap: 8 }}>
              {FORMATS.map((fm) => {
                const on = f.fmt.includes(fm);
                return (
                  <button key={fm} className="btn sm" style={{ borderColor: on ? "var(--accent)" : undefined, background: on ? "var(--accent-weak)" : undefined, color: on ? "var(--accent)" : undefined }}
                    onClick={() => set("fmt", on ? f.fmt.filter((x) => x !== fm) : [...f.fmt, fm])}>
                    {on && <Icon name="check" size={14} />}{fm}
                  </button>
                );
              })}
            </div>
            <span className="hint">Format choices offered at run time; outputs set to "job format" use the chosen one.</span>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="fade-in">
          <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
            <div className="section-label" style={{ margin: 0 }}>Runtime parameters ({selectedParams.length} selected)</div>
          </div>
          {catalog.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 12.5, color: "var(--ink-4)", border: "1px dashed var(--line-strong)", borderRadius: 10 }}>
              No parameters defined in the catalog yet — skip this step or add parameters in Settings → Parameters first.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {catalog.map((p) => {
                const on = selectedParams.includes(p.name);
                return (
                  <label key={p.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 11px", borderRadius: 9, cursor: "pointer", border: "1px solid " + (on ? "var(--accent-line)" : "var(--line)"), background: on ? "var(--accent-weak)" : "var(--surface)" }}>
                    <input type="checkbox" checked={on} onChange={() => setSelectedParams((s) => on ? s.filter((n) => n !== p.name) : [...s, p.name])} />
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{p.label}</span>
                    {p.required && <span className="chip blue" style={{ height: 17, fontSize: 9.5 }}>required</span>}
                    {p.dependsOn && <span className="chip blue" style={{ height: 17, fontSize: 9.5, marginLeft: "auto" }}>← {p.dependsOn}</span>}
                  </label>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--ink-4)" }}>
            You can update the parameter assignment later from the detail view.
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="field"><label>Kafka topic</label><input className="input mono" value={f.topic} onChange={(e) => set("topic", e.target.value)} /></div>
            <div className="field"><label>Priority</label>
              <div className="seg" style={{ width: "100%" }}>{["low", "normal", "high"].map((pr) => <button key={pr} style={{ flex: 1 }} className={f.priority === pr ? "on" : ""} onClick={() => set("priority", pr)}>{pr}</button>)}</div>
            </div>
          </div>
          <div className="field"><label>Render timeout (seconds)</label><input className="input mono" type="number" value={f.timeout} onChange={(e) => set("timeout", Number(e.target.value))} /></div>
          <div className="divider" />
          <div className="section-label">Review</div>
          <div style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{f.th || <span style={{ color: "var(--ink-4)" }}>— no name —</span>}</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 12 }}>{f.code} · {catOf(f.cat)?.name}</div>
            <div className="kv"><span className="k">Engine</span><span className="v"><EngineBadge engine={f.engine} /></span></div>
            <div className="kv"><span className="k">Datasource</span><span className="v">{dsOf(f.ds)?.name}</span></div>
            <div className="kv"><span className="k">Output</span><span className="v mono" style={{ fontSize: 11 }}>
              {(f.unitFmt || "job format") + " · " + (hasSchema ? (reportProps.map((p) => f.cfgVals[p.key]).filter(Boolean).join(" · ").slice(0, 60) || "no config") : file ? `${file.name} (${fmtBytes(file.size)})` : "built-in layout")}
            </span></div>
            <div className="kv"><span className="k">Run formats</span><span className="v"><Fmts list={f.fmt} /></span></div>
            <div className="kv"><span className="k">Parameters</span><span className="v">{selectedParams.length > 0 ? selectedParams.join(", ") : "— none —"}</span></div>
            <div className="kv"><span className="k">Gateway</span><span className="v">{f.topic} · {f.priority} · {f.timeout}s</span></div>
          </div>
          <div style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 12.5, color: "var(--ink-3)" }}>
            <Icon name="alert" size={15} style={{ color: "var(--amber)" }} />Report is created as <b style={{ margin: "0 3px" }}>Draft</b> — run it in Tester before activating.
          </div>
        </div>
      )}
    </Modal>
  );
}
