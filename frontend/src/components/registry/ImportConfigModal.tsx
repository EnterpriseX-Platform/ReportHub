"use client";

import { errMsg } from "@/lib/api";
import { useEffect, useMemo, useState } from "react";
import { Select } from "@/components/Select";
import {
  Button, InlineNotification, Stack, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper,
  TextArea, TextInput, FileUploaderDropContainer, FileUploaderItem, FormGroup,
} from "@carbon/react";
import { CheckmarkFilled, Upload, WarningAltFilled } from "@carbon/icons-react";
import st from "@/components/R/r.module.scss";
import { Modal } from "@/components/overlays";
import { ModalKeys } from "@/components/R/ModalKeys";
import { EngineBadge, FmtTag } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { ENGINES } from "@/lib/model";
import { api } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import type { Category, Datasource, ParamDef, ReportDetail } from "@/lib/types";

const TEMPLATE_ACCEPT = [".jrxml", ".docx", ".xlsx", ".html"];

const SAMPLE_YAML = `app:
  component: report
  id: SALES-103
config:
  jasperEngine: Y
  exportType: jasper
  exportFormat: pdf
  templateFile: 'SALES-103'
  templateExtension: jasper
  jasper:
    jasperEngine: Y
  file:
    fileName: 'SALES-103_yyyyMMdd_HHmmss.pdf'
  meta:
    - element: parameter
      jdbc: jdbc/application
      sql: select * from dual
  sheetField:
    - sheetName: parameter
      fieldConfigs:
        - fieldName: YEAR
          valueType: parameter
        - fieldName: MIN_REPORT
          valueType: parameter
        - fieldName: BRANCH_REPORT
          valueType: parameter
        - fieldName: SUBBRANCH_REPORT
          valueType: parameter`;

function parseConfig(yaml: string) {
  const get = (k: string) => {
    const m = yaml.match(new RegExp(k + ":\\s*'?([^'\\n]+)'?"));
    return m ? m[1].trim() : null;
  };
  const fields = [...yaml.matchAll(/fieldName:\s*([\w$]+)/g)].map((m) => m[1]);
  return {
    id: get("id"), exportType: get("exportType"), exportFormat: get("exportFormat"),
    templateFile: get("templateFile"), templateExtension: get("templateExtension"),
    fileName: get("fileName"), jdbc: get("jdbc"), fields,
  };
}

export function ImportConfigModal({ onClose, onImported }: { onClose: () => void; onImported: (r: ReportDetail) => void }) {
  const [yaml, setYaml] = useState(SAMPLE_YAML);
  const [note, setNote] = useState("Initial import");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseConfig(yaml), [yaml]);
  const toast = useToast();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [dss, setDss] = useState<Datasource[] | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [datasourceId, setDatasourceId] = useState("");
  const [catalog, setCatalog] = useState<ParamDef[]>([]);
  const [template, setTemplate] = useState<File | null>(null);
  useEffect(() => {
    api.parameters().then(setCatalog).catch(() => {});
    api.categories().then((c) => {
      setCats(c);
      setCategoryId((cur) => cur || (c.find((x) => x.name.trim().toLowerCase() === "general") ?? c[0])?.id || "");
    }).catch(() => setCats([]));
    api.datasources().then((d) => {
      setDss(d);
      setDatasourceId((cur) => cur || (d.find((x) => x.isDefault) ?? d[0])?.id || "");
    }).catch(() => setDss([]));
  }, []);
  const ds = dss?.find((d) => d.id === datasourceId);

  const checks = [
    { ok: !!parsed.id, label: "Component id detected", detail: parsed.id || "id not found" },
    { ok: !!parsed.exportType, label: "Export engine: " + (parsed.exportType || "—"), detail: ENGINES[parsed.exportType ?? ""]?.th || "" },
    { ok: !!categoryId, label: "Category", detail: cats?.find((c) => c.id === categoryId)?.name || "choose a category" },
    { ok: !!ds && ds.hasJdbc && ds.status !== "down", label: "Datasource",
      detail: !ds ? "choose a datasource" : !ds.hasJdbc ? `${ds.name}: no connection configured` : ds.status === "down" ? `${ds.name}: unreachable` : `${ds.name} · ${ds.status}` },
    { ok: parsed.fields.length > 0, label: parsed.fields.length + " parameters",
      detail: parsed.fields.length === 0 ? "" : `${parsed.fields.filter((n) => catalog.some((p) => p.name === n)).length} existing · ${parsed.fields.filter((n) => !catalog.some((p) => p.name === n)).length} new` },
  ];
  const valid = checks.every((c, i) => c.ok || i === checks.length - 1);

  async function doImport() {
    setBusy(true);
    const eng = parsed.exportType && parsed.exportType in ENGINES ? parsed.exportType : "jasper";
    // Config files have been seen with a leading space around the id, which used to reach
    // the DB verbatim and sit alongside the trimmed code as a second report. The server
    // trims too; doing it here keeps what we send equal to what gets stored.
    const code = (parsed.id ?? "").trim() || "IMP-" + Math.floor(Math.random() * 900);
    try {
      const r = await api.createReport({
        code,
        name: "Imported from config · " + code,
        categoryId, engine: eng, formats: [(parsed.exportFormat ?? "pdf").toUpperCase()],
        datasourceId,
        templatePath: `/${eng}/${parsed.templateFile ?? parsed.id}.${parsed.templateExtension ?? "jasper"}`,
        ownerUnit: "import", paramCount: parsed.fields.length, note,
      });
      // Detected fields become the report's parameters: bind catalog entries by name, create the rest.
      const problems: string[] = [];
      const names = [...new Set(parsed.fields)];
      try {
        for (const n of names) {
          if (catalog.some((p) => p.name === n)) continue;
          await api.createParameter({ name: n, label: n, type: "string", required: false, sourceType: "static", staticOptions: [] });
        }
        if (names.length > 0) {
          await api.assignReportParameters(r.code, names.map((n) => ({ name: n, requiredOverride: null })));
        }
      } catch (e) {
        problems.push(`parameters: ${errMsg(e)}`);
      }
      if (template) {
        try {
          const units = await api.reportUnits(r.code);
          const unit = units[0] ?? await api.createUnit(r.code, { name: "default", engine: eng });
          await api.uploadUnitFile(r.code, unit.id, template, "main");
        } catch (e) {
          problems.push(`template: ${errMsg(e)}`);
        }
      }
      if (problems.length > 0) toast(`Imported ${r.code}, but ${problems.join("; ")} — fix it in the detail view`, "error");
      onImported(r);
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  }

  function pickTemplate(f: File | undefined) {
    if (!f) return;
    const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
    if (!TEMPLATE_ACCEPT.includes(ext)) { toast(`File type ${ext} is not allowed — expected ${TEMPLATE_ACCEPT.join(", ")}`, "error"); return; }
    if (f.size > 25 * 1024 * 1024) { toast("File exceeds the 25 MB limit", "error"); return; }
    setTemplate(f);
  }

  return (
    <Modal
      title="Import report config"
      sub="config.yml"
      width={980}
      onClose={onClose}
      foot={<>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" renderIcon={Upload} disabled={!valid || busy} onClick={doImport}>Import &amp; register</Button>
      </>}
    >
      <ModalKeys>
      <div className={st.importGrid}>
        <TextArea id="imp-yaml" labelText="config.yml" className="rh-mono" rows={18} value={yaml}
                  onChange={(e) => setYaml(e.target.value)} spellCheck={false}
                  helperText="Engine is detected from exportType (Jasper, API, SQL, Composite)." />

        <Stack gap={5}>
          <div>
            <div className="cds--type-label-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-03)" }}>Detected</div>
            <div className="rh-row" style={{ display: "flex", gap: "var(--cds-spacing-03)", marginBottom: "var(--cds-spacing-03)" }}>
              <EngineBadge engine={parsed.exportType && parsed.exportType in ENGINES ? parsed.exportType : "jasper"} />
              <FmtTag f={(parsed.exportFormat ?? "pdf").toUpperCase()} />
            </div>
            <StructuredListWrapper isCondensed className="rh-slist" aria-label="Detected">
              <StructuredListBody>
                {([
                  ["id", parsed.id ?? "—", true],
                  ["template", `${parsed.templateFile}.${parsed.templateExtension}`, true],
                  ["jdbc", parsed.jdbc ?? "—", true],
                  ["fields", String(parsed.fields.length), false],
                ] as const).map(([k, v, mono]) => (
                  <StructuredListRow key={k}>
                    <StructuredListCell noWrap className="rh-dim">{k}</StructuredListCell>
                    <StructuredListCell className={mono ? "cds--type-code-01" : undefined} style={{ wordBreak: "break-all" }}>{v}</StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          </div>
          <div>
            <div className="cds--type-label-01 rh-dim" style={{ marginBottom: "var(--cds-spacing-03)" }}>Validation</div>
            <ul style={{ display: "flex", flexDirection: "column", gap: "var(--cds-spacing-03)" }}>
              {checks.map((c, i) => (
                <li key={i} style={{ display: "flex", gap: "var(--cds-spacing-03)", alignItems: "flex-start" }}>
                  {c.ok
                    ? <CheckmarkFilled size={16} style={{ color: "var(--cds-support-success)", flex: "none", marginTop: 1 }} />
                    : <WarningAltFilled size={16} style={{ color: "var(--cds-support-warning)", flex: "none", marginTop: 1 }} />}
                  <div style={{ minWidth: 0 }}>
                    <div className="cds--type-body-compact-01">{c.label}</div>
                    {c.detail && <div className="cds--type-code-01 rh-dim rh-ellipsis">{c.detail}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <Select label="Category" value={categoryId} onChange={setCategoryId} placeholder={cats ? "Choose a category" : ""}
                  options={(cats ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <Select label="Datasource" value={datasourceId} onChange={setDatasourceId} placeholder={dss ? "Choose a datasource" : ""}
                  options={(dss ?? []).map((d) => ({ value: d.id, label: d.name + (d.isDefault ? " (default)" : ""), sub: d.engine }))} />
          <FormGroup legendText="Template file (optional)">
            <FileUploaderDropContainer labelText={template ? "Drop a file here or click to replace" : `Drop the template here (${TEMPLATE_ACCEPT.join(", ")})`}
              accept={TEMPLATE_ACCEPT} onAddFiles={(_e, { addedFiles }) => pickTemplate(addedFiles[0])} />
            {template && (
              <FileUploaderItem name={`${template.name} · ${fmtBytes(template.size)}`} status="edit" iconDescription="Remove file"
                                onDelete={() => setTemplate(null)} />
            )}
          </FormGroup>
          <TextInput id="imp-note" labelText="Version note" value={note} onChange={(e) => setNote(e.target.value)} />
          <InlineNotification kind={valid ? "success" : "warning"} lowContrast hideCloseButton
                              title={valid ? "Config valid" : "Check the config"} />
        </Stack>
      </div>
    </ModalKeys>
    </Modal>
  );
}
