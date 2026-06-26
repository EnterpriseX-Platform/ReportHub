"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/overlays";
import { EngineBadge, FmtTag } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { ENGINES } from "@/lib/model";
import { api } from "@/lib/api";
import type { ReportDetail } from "@/lib/types";

const SAMPLE_YAML = `app:
component: report
id: BEC01-01-RPT03
config:
  jasperEngine: Y
  exportType: jasper
  exportFormat: pdf
  templateFile: 'BEC01-01-RPT03'
  templateExtension: jasper
  jasper:
    jasperEngine: Y
  file:
    fileName: 'BEC01-01-RPT03_yyyyMMdd_HHmmss.pdf'
  meta:
    - element: parameter
      jdbc: jdbc/application
      sql: select * from dual
  sheetField:
    - sheetName: parameter
      fieldConfigs:
        - fieldName: YEAR_TH
          valueType: parameter
        - fieldName: MIN_REPORT
          valueType: parameter
        - fieldName: AGC_REPORT
          valueType: parameter
        - fieldName: SUBAGC_REPORT
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

  const checks = [
    { ok: !!parsed.id, label: "Component id detected", detail: parsed.id || "id not found" },
    { ok: !!parsed.exportType, label: "Export engine: " + (parsed.exportType || "—"), detail: ENGINES[parsed.exportType ?? ""]?.th || "" },
    { ok: !!parsed.jdbc, label: "Datasource (jdbc) resolvable", detail: parsed.jdbc || "jdbc not found" },
    { ok: parsed.fields.length > 0, label: parsed.fields.length + " field configs", detail: parsed.fields.slice(0, 4).join(", ") },
  ];
  const valid = !!parsed.id && !!parsed.exportType;

  async function doImport() {
    setBusy(true);
    const eng = parsed.exportType && parsed.exportType in ENGINES ? parsed.exportType : "jasper";
    try {
      const r = await api.createReport({
        code: parsed.id ?? "IMP-" + Math.floor(Math.random() * 900),
        name: "Imported from config · " + (parsed.id ?? "report"),
        categoryId: "c7", engine: eng, formats: [(parsed.exportFormat ?? "pdf").toUpperCase()],
        datasourceId: "ds-core",
        templatePath: `/${eng}/${parsed.templateFile ?? parsed.id}.${parsed.templateExtension ?? "jasper"}`,
        ownerUnit: "import", paramCount: parsed.fields.length || 4, note,
      });
      onImported(r);
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Import report config"
      sub="Paste a config.yml to register or create a new version — template files are uploaded in the report's detail view"
      width={780}
      onClose={onClose}
      foot={<>
        <div style={{ marginRight: "auto", display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: valid ? "var(--green)" : "var(--amber)" }}>
          <Icon name={valid ? "checkCircle" : "alert"} size={16} />{valid ? "Config valid" : "Check the config"}
        </div>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!valid || busy} onClick={doImport}>{busy ? <span className="spin" /> : <Icon name="upload" size={15} />}Import &amp; register</button>
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 18 }}>
        <div>
          <div className="section-label" style={{ marginBottom: 8 }}>config.yml</div>
          <textarea className="input" style={{ height: 360, fontSize: 11.5, lineHeight: 1.6, width: "100%" }} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} />
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10 }}>
            <Icon name="alert" size={14} style={{ color: "var(--ink-4)", marginTop: 1 }} />Multiple engines supported — Jasper, API, SQL, Composite. The engine is detected from <span className="mono">exportType</span> in the config.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="section-label" style={{ marginTop: 0 }}>Detected</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <EngineBadge engine={parsed.exportType && parsed.exportType in ENGINES ? parsed.exportType : "jasper"} />
              <FmtTag f={(parsed.exportFormat ?? "pdf").toUpperCase()} />
            </div>
            <div className="kv"><span className="k">id</span><span className="v mono" style={{ fontSize: 11.5 }}>{parsed.id ?? "—"}</span></div>
            <div className="kv"><span className="k">template</span><span className="v mono" style={{ fontSize: 11 }}>{parsed.templateFile}.{parsed.templateExtension}</span></div>
            <div className="kv"><span className="k">jdbc</span><span className="v mono" style={{ fontSize: 11 }}>{parsed.jdbc ?? "—"}</span></div>
            <div className="kv"><span className="k">fields</span><span className="v">{parsed.fields.length}</span></div>
          </div>
          <div>
            <div className="section-label">Validation</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {checks.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <Icon name={c.ok ? "checkCircle" : "alert"} size={15} style={{ color: c.ok ? "var(--green)" : "var(--amber)", flex: "none", marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{c.label}</div>
                    {c.detail && <div className="mono" style={{ fontSize: 10, color: "var(--ink-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="field"><label style={{ fontSize: 11.5 }}>Version note</label><input className="input" style={{ height: 34 }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
      </div>
    </Modal>
  );
}

