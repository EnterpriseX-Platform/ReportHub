"use client";

import { errMsg } from "@/lib/api";
import { useEffect, useState } from "react";
import {
  Button, Checkbox, ContentSwitcher, FileUploaderDropContainer, FileUploaderItem, FormGroup, InlineNotification,
  NumberInput, ProgressIndicator, ProgressStep, RadioButton, RadioButtonGroup, RadioTile, Stack,
  StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, Switch, Tag, TextInput, TileGroup,
} from "@carbon/react";
import { ArrowRight, Checkmark } from "@carbon/icons-react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/overlays";
import { ModalKeys } from "@/components/R/ModalKeys";
import { EngineBadge, Fmts } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { ENGINES } from "@/lib/model";
import { api, fieldErrors } from "@/lib/api";
import { Select } from "@/components/Select";
import st from "@/components/R/r.module.scss";
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

/** Default category for a new report: "General" when it exists, otherwise the first one. */
function defaultCat(categories: Category[]): string {
  return (categories.find((c) => c.name.trim().toLowerCase() === "general") ?? categories[0])?.id ?? "";
}

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
  const [fErr, setFErr] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [catalog, setCatalog] = useState<ParamDef[]>([]);
  const [selectedParams, setSelectedParams] = useState<string[]>([]);
  const [f, setF] = useState({
    th: "", code: "RPT-A-" + Math.floor(100 + Math.random() * 800),
    cat: defaultCat(categories), owner: "", ds: (datasources.find((d) => d.isDefault) ?? datasources[0])?.id ?? "",
    fmt: ["PDF", "XLSX"], engine: "jasper", unitFmt: "", cfgVals: {} as Record<string, string>, priority: "normal", timeout: 2, topic: "default",
    testData: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const [descriptors, setDescriptors] = useState<EngineDescriptor[]>([]);
  const [ownerTouched, setOwnerTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  // Lists can arrive after the wizard opens: fill an empty / stale choice once they do.
  useEffect(() => {
    setF((s) => ({
      ...s,
      ds: datasources.some((d) => d.id === s.ds) ? s.ds : (datasources.find((d) => d.isDefault) ?? datasources[0])?.id ?? "",
      cat: categories.some((c) => c.id === s.cat) ? s.cat : defaultCat(categories),
    }));
  }, [datasources, categories]);

  useEffect(() => {
    api.parameters().then(setCatalog).catch(() => {});
    api.engines().then((d) => setDescriptors(d.descriptors ?? [])).catch(() => {});
  }, []);

  const reportProps = descriptors.find((d) => d.kind === f.engine)?.reportProps ?? [];
  const hasSchema = reportProps.length > 0;
  // What still blocks Continue on each step — shown next to the disabled button.
  const missingByStep: string[][] = [
    [!f.th.trim() && "Report name", !f.code.trim() && "Report code", !f.owner.trim() && "Owner unit"].filter(Boolean) as string[],
    [!f.ds && "Datasource", f.fmt.length === 0 && "Run formats",
      ...reportProps.filter((p) => p.required && !(f.cfgVals[p.key] ?? "").trim()).map((p) => p.label || p.key)].filter(Boolean) as string[],
    [],
    [],
  ];
  const missing = missingByStep[step];
  const canNext = missing.length === 0;

  const catOf = (id: string) => categories.find((c) => c.id === id);
  const dsOf = (id: string) => datasources.find((d) => d.id === id);

  // Merge static engine definitions with any loaded descriptor kinds not already in ENGINES
  // (e.g. http engines installed via the Engines page, or future JAR plugin kinds).
  const engineCards: [string, typeof ENGINES[string]][] = [
    ...Object.entries(ENGINES),
    ...descriptors
      .filter((d) => !ENGINES[d.kind])
      .map((d) => [d.kind, { label: d.label, th: d.requiresInstance ? "Installed engine" : "Built-in engine", icon: "engine" as const, color: "#525252", ext: "bin", desc: d.label }] as [string, typeof ENGINES[string]]),
  ];

  function pickEngine(k: string) {
    setF((s) => ({ ...s, engine: k, cfgVals: {} }));
    setFile(null);
  }

  function onPick(picked: File | undefined) {
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
        datasourceId: f.ds, ownerUnit: f.owner, paramCount: selectedParams.length,
        testData: f.testData, note: "Registered via wizard",
        priority: f.priority, timeoutMinutes: Math.min(1440, Math.max(1, Math.round(f.timeout) || 1)), queue: f.topic.trim() || undefined,
      });
    } catch (e) {
      const fe = fieldErrors(e);
      setFErr(fe);
      if (Object.keys(fe).length === 0) toast(errMsg(e), "error");
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
      toast(`Report ${f.code} created, but output setup failed: ${errMsg(e)} — fix it in the detail view`, "error");
    }
    onCreated(r);
  }

  const otherErrs = Object.entries(fErr).filter(([k]) => k !== "queue" && k !== "timeoutMinutes");
  const reviewRows: [string, React.ReactNode][] = [
    ["Name", f.th || "— no name —"],
    ["Code", <span key="c" className="cds--type-code-01">{f.code} · {catOf(f.cat)?.name}</span>],
    ["Engine", <EngineBadge key="e" engine={f.engine} />],
    ["Datasource", dsOf(f.ds)?.name],
    ["Output", <span key="o" className="cds--type-code-01">
      {(f.unitFmt || "job format") + " · " + (hasSchema ? (reportProps.map((p) => f.cfgVals[p.key]).filter(Boolean).join(" · ").slice(0, 60) || "no config") : file ? `${file.name} (${fmtBytes(file.size)})` : "built-in layout")}
    </span>],
    ["Run formats", <Fmts key="f" list={f.fmt} />],
    ["Parameters", selectedParams.length > 0 ? selectedParams.join(", ") : "— none —"],
    ["Gateway", `${f.topic} · ${f.priority} · ${f.timeout} min`],
  ];

  return (
    <Modal
      title="Register report"
      sub="Add a report to the catalog"
      onClose={onClose}
      width={980}
      foot={<>
        {step > 0 ? <Button kind="secondary" onClick={() => setStep(step - 1)}>Back</Button> : <Button kind="secondary" onClick={onClose}>Cancel</Button>}
        {step < 3
          ? <Button kind="primary" renderIcon={ArrowRight} disabled={!canNext} onClick={() => setStep(step + 1)}>Continue</Button>
          : <Button kind="primary" renderIcon={Checkmark} disabled={busy} onClick={submit}>Register report</Button>}
      </>}
    >
      <ModalKeys>
      <div style={{ marginBottom: "var(--cds-spacing-07)" }}>
      {/* Only completed steps are clickable — later steps still need validation via Continue */}
      <ProgressIndicator currentIndex={step} spaceEqually onChange={(i: number) => { if (i < step) setStep(i); }}>
        {STEPS.map((x, i) => (
          <ProgressStep key={x} label={x} complete={i < step} current={i === step} disabled={i > step} />
        ))}
      </ProgressIndicator>
      </div>

      {missing.length > 0 && (
        <div className="cds--type-helper-text-01" role="status" style={{ color: "var(--cds-text-secondary)", marginBottom: "var(--cds-spacing-05)" }}>
          To continue, fill in: {missing.join(", ")}
        </div>
      )}

      {step === 0 && (
        <Stack gap={6}>
          <TextInput id="rw-name" labelText={<>Report name <span style={{ color: "var(--cds-text-error)" }}>*</span></>} placeholder="e.g. National strategy summary report" value={f.th}
                     aria-required invalid={nameTouched && !f.th.trim()} invalidText="Report name is required"
                     onBlur={() => setNameTouched(true)} onChange={(e) => set("th", e.target.value)} />
          <div className="rh-form-grid">
            <TextInput id="rw-code" labelText="Report code" className="rh-mono" value={f.code} onChange={(e) => set("code", e.target.value)}
                       invalid={!f.code.trim() || !!fErr.code} invalidText={fErr.code ?? "Report code is required"} />
            <TextInput id="rw-owner" labelText={<>Owner unit <span style={{ color: "var(--cds-text-error)" }}>*</span></>} placeholder="e.g. Strategy division" value={f.owner}
                       aria-required invalid={ownerTouched && !f.owner.trim()} invalidText="Owner unit is required"
                       onBlur={() => setOwnerTouched(true)} onChange={(e) => set("owner", e.target.value)} />
          </div>
          <Select label="Category" value={f.cat} onChange={(v) => set("cat", v)}
            options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          <Checkbox id="rw-test" labelText="Test data" helperText="Sample data for acceptance testing (shown as a note on the Overview tab)."
                    checked={f.testData} onChange={(_, { checked }) => set("testData", checked)} />
        </Stack>
      )}

      {step === 1 && (
        <Stack gap={6}>
          <TileGroup legend="Source engine" name="rw-engine" valueSelected={f.engine} onChange={(v) => pickEngine(String(v))} className={st.tileGrid}>
            {engineCards.map(([k, e]) => (
              <RadioTile key={k} id={`rw-eng-${k}`} value={k}>
                <span style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)" }}>
                  <Icon name={e.icon} size={16} style={{ color: "var(--cds-icon-secondary)", flex: "none" }} />
                  <span style={{ minWidth: 0 }}>
                    <span className="cds--type-heading-compact-01" style={{ display: "block" }}>{e.label}</span>
                    <span className="cds--type-helper-text-01 rh-dim rh-ellipsis" style={{ display: "block" }}>{e.th}</span>
                  </span>
                </span>
              </RadioTile>
            ))}
          </TileGroup>
          {hasSchema ? (
            <FormGroup legendText={(ENGINES[f.engine]?.label ?? f.engine) + " configuration"}>
              <SchemaForm props={reportProps} values={f.cfgVals} onChange={(k, v) => set("cfgVals", { ...f.cfgVals, [k]: v })} />
            </FormGroup>
          ) : (
            <FormGroup legendText={"Template file (." + (ENGINES[f.engine]?.ext ?? "jrxml") + ")"}>
              <p className="cds--type-helper-text-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-03)" }}>
                {ENGINES[f.engine]?.desc}{!file ? " — optional, built-in layout is used when no template is uploaded." : ""}
              </p>
              <FileUploaderDropContainer
                labelText={file ? "Drop a file here or click to replace" : `Drop a template here or click to choose (${ACCEPT[f.engine] ?? "any"})`}
                accept={ACCEPT[f.engine] ? ACCEPT[f.engine].split(",") : undefined}
                onAddFiles={(_e, { addedFiles }) => onPick(addedFiles[0])} />
              {file && (
                <FileUploaderItem name={`${file.name} · ${fmtBytes(file.size)}`} status="edit" iconDescription="Remove file"
                                  onDelete={() => setFile(null)} />
              )}
            </FormGroup>
          )}
          <Select label="Datasource" value={f.ds} onChange={(v) => set("ds", v)} placeholder="Choose a datasource"
            options={datasources.map((d) => ({ value: d.id, label: `${d.name} — ${d.engine}${d.isDefault ? " (default)" : ""}` }))} />
          <RadioButtonGroup legendText="Output format" name="rw-unitfmt" valueSelected={f.unitFmt || "__job"}
                            onChange={(v) => set("unitFmt", v === "__job" ? "" : String(v))}
                            helperText={'"Job format" follows the format chosen at run time.'}>
            {["", ...FORMATS].map((fm) => <RadioButton key={fm || "job"} id={`rw-uf-${fm || "job"}`} value={fm || "__job"} labelText={fm || "Job format"} />)}
          </RadioButtonGroup>
          <FormGroup legendText="Run formats">
            <div className={st.inlineChecks}>
              {FORMATS.map((fm) => {
                const on = f.fmt.includes(fm);
                return <Checkbox key={fm} id={`rw-rf-${fm}`} labelText={fm} checked={on}
                                 onChange={() => set("fmt", on ? f.fmt.filter((x) => x !== fm) : [...f.fmt, fm])} />;
              })}
            </div>
          </FormGroup>
        </Stack>
      )}

      {step === 2 && (
        <FormGroup legendText={`Runtime parameters (${selectedParams.length} selected)`}>
          {catalog.length === 0 ? (
            <p className="cds--type-body-compact-01 rh-dim">No parameters in the catalog yet (Parameters screen).</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {catalog.map((p) => {
                const on = selectedParams.includes(p.name);
                return (
                  <div key={p.name} style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)", borderBottom: "1px solid var(--cds-border-subtle-01)", padding: "var(--cds-spacing-02) 0" }}>
                    <Checkbox id={`rw-p-${p.name}`} checked={on}
                              labelText={<><span className="cds--type-code-01" style={{ fontWeight: 600 }}>{p.name}</span> <span className="rh-dim">{p.label}</span></>}
                              onChange={() => setSelectedParams((x) => on ? x.filter((n) => n !== p.name) : [...x, p.name])} />
                    {p.required && <Tag size="sm" type="blue">required</Tag>}
                    {p.dependsOn && <Tag size="sm" type="outline" style={{ marginLeft: "auto" }}>← {p.dependsOn}</Tag>}
                  </div>
                );
              })}
            </div>
          )}
        </FormGroup>
      )}

      {step === 3 && (
        <Stack gap={6}>
          <div className="rh-form-grid">
            <TextInput id="rw-queue" labelText="Queue" className="rh-mono" placeholder="default" value={f.topic} onChange={(e) => set("topic", e.target.value)}
                       invalid={!!fErr.queue} invalidText={fErr.queue} />
            <div>
              <div className="cds--label">Priority</div>
              <ContentSwitcher selectedIndex={["low", "normal", "high"].indexOf(f.priority)} onChange={({ name }) => set("priority", String(name))}>
                {["low", "normal", "high"].map((pr) => <Switch key={pr} name={pr} text={pr} />)}
              </ContentSwitcher>
            </div>
          </div>
          <NumberInput id="rw-timeout" label="Render timeout (minutes, 1–1440)" min={1} max={1440} value={f.timeout}
                       onChange={(_e, { value }) => set("timeout", Number(value))}
                       invalid={!!fErr.timeoutMinutes} invalidText={fErr.timeoutMinutes} />
          {otherErrs.length > 0 && (
            <InlineNotification kind="error" lowContrast hideCloseButton title="Check these fields"
              subtitle={otherErrs.map(([k, v]) => `${k}: ${v}`).join(" · ")} />
          )}
          <div>
            <h4 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-03)" }}>Review</h4>
            <StructuredListWrapper isCondensed className="rh-slist" aria-label="Review">
              <StructuredListBody>
                {reviewRows.map(([k, v]) => (
                  <StructuredListRow key={k}>
                    <StructuredListCell noWrap className="rh-dim">{k}</StructuredListCell>
                    <StructuredListCell>{v}</StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          </div>
          <InlineNotification kind="info" lowContrast hideCloseButton title="Created as Draft"
                              subtitle="Activate it from the report's Config tab after a test run in Run Task." />
        </Stack>
      )}
    </ModalKeys>
    </Modal>
  );
}
