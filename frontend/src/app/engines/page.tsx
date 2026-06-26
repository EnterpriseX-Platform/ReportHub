"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MetricCard } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import { SchemaForm, valuesToConfig } from "@/components/SchemaForm";
import { api, type InstallEngineInput } from "@/lib/api";
import type { EngineDescriptor, EngineInstance, EngineList } from "@/lib/types";
import { downloadEngineStarter } from "@/lib/engineStarter";

const METHODS = [
  { id: "url", label: "Remote URL", hint: "HTTP service such as component (OneWeb) — base URL + token" },
  { id: "service", label: "Service", hint: "Internal container/service — base URL" },
  { id: "jar", label: "JAR plugin", hint: "Drop a .jar implementing the ReportEngine SPI (ServiceLoader)" },
  { id: "lib", label: "Library / SDK", hint: "Maven coordinate / module" },
];
const KIND_DESC: Record<string, string> = {
  jasper: "Built-in — Jasper PDF + POI XLSX + CSV + SQL (in-process, lightweight)",
  component: "OneWeb component engine (Aspose/LibreOffice) — called over HTTP",
  http: "Generic HTTP engine",
  aspose: "Aspose document engine (separate module)",
};

export default function EnginesPage() {
  const toast = useToast();
  const [data, setData] = useState<EngineList | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  const load = () => api.engines().then(setData).catch((e) => toast((e as Error).message, "error"));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function test(e: EngineInstance) {
    setTesting(e.id);
    try {
      const r = await api.testEngine(e.id);
      toast(`${e.name}: ${r.message}${r.status ? ` (HTTP ${r.status}, ${r.latencyMs}ms)` : ""}`, r.ok ? "ok" : "error");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setTesting(null);
    }
  }

  async function remove(e: EngineInstance) {
    try {
      await api.deleteEngine(e.id);
      toast(`Removed engine ${e.name}`, "ok");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const installed = data?.installed ?? [];
  const kinds = data?.availableKinds ?? [];

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Engines</h1>
          <div className="page-sub">Report-generation engines — installable via URL / JAR / lib / service; the engine resolves first, then the per-report custom</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setGuideOpen(true)}><Icon name="doc" size={16} />Build an engine</button>
          <button className="btn primary" onClick={() => setInstallOpen(true)}><Icon name="plus" size={16} />Install engine</button>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <MetricCard icon="engine" label="Installed engines" value={installed.length} tone="accent" />
        <MetricCard icon="checkCircle" label="Enabled" value={installed.filter((e) => e.enabled).length} tone="green" />
        <MetricCard icon="layers" label="Adapter kinds loaded" value={kinds.length} tone="violet" />
      </div>

      <div style={{ display: "flex", gap: 9, alignItems: "flex-start", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 10, padding: "11px 13px", marginBottom: 14 }}>
        <Icon name="engine" size={16} style={{ color: "var(--accent)", flex: "none", marginTop: 1 }} />
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
          <b>Built-in</b> engines (Jasper, SQL query-export, REST API) are compiled into Report Studio and always available — nothing to install.{" "}
          <b>Remote</b> engines (Component, HTTP) are registered here with a URL + credentials and need an enabled instance to run.{" "}
          Want to add your own? <button className="linklike" onClick={() => setGuideOpen(true)} style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Read the build guide →</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Icon name="engine" size={17} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}><h3>Engines</h3></div>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>adapters: {kinds.join(" · ") || "—"}</span>
        </div>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Kind</th><th>Install</th><th>Endpoint / artifact</th><th>Auth</th><th>Status</th><th /></tr></thead>
          <tbody>
            {installed.map((e) => (
              <tr key={e.id} style={{ cursor: "default" }}>
                <td className="strong">{e.name}{e.note && <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{e.note}</div>}</td>
                <td>
                  <span className="chip blue" style={{ height: 20 }}>{e.kind}</span>
                  {e.installMethod === "builtin"
                    ? <span className="chip green" style={{ height: 18, marginLeft: 6 }}>built-in</span>
                    : <span className="chip slate" style={{ height: 18, marginLeft: 6 }}>remote</span>}
                </td>
                <td className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{e.installMethod}</td>
                <td className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.baseUrl ?? e.artifactRef ?? "—"}</td>
                <td>{e.hasToken ? <span className="chip green" style={{ height: 19 }}>token</span> : <span style={{ color: "var(--ink-4)", fontSize: 12 }}>—</span>}</td>
                <td>{e.enabled ? <span className="chip green" style={{ height: 20 }}><i className="led" />enabled</span> : <span className="chip slate" style={{ height: 20 }}>disabled</span>}</td>
                <td style={{ width: 150 }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    {e.installMethod === "builtin" ? (
                      <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>always available</span>
                    ) : (
                      <>
                        <button className="btn sm" disabled={testing === e.id} onClick={() => test(e)}>{testing === e.id ? <span className="spin" /> : <Icon name="bolt" size={13} />}Test</button>
                        <button className="btn sm ghost" onClick={() => remove(e)}><Icon name="x" size={14} /></button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {installed.length === 0 && <tr><td colSpan={7}><div className="empty">No engines yet — click Install engine</div></td></tr>}
          </tbody>
        </table>
      </div>

      {installOpen && <InstallModal descriptors={data?.descriptors ?? []} onClose={() => setInstallOpen(false)} onDone={() => { setInstallOpen(false); load(); }} />}
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}
    </div>
  );
}

/** Developer guide: how to write a ReportEngine and plug it into the render flow. */
function GuideModal({ onClose }: { onClose: () => void }) {
  const SPI = `public interface ReportEngine {
    String kind();                       // unique id, e.g. "myengine"
    RenderResult render(RenderRequest req, EngineConfig cfg);

    default boolean requiresInstance() { return false; }  // true = needs a registered URL/creds
    default String  label()            { return kind(); } // shown in the UI
    default List<EngineProp> instanceProps() { return List.of(); } // install-time fields
    default List<EngineProp> reportProps()   { return List.of(); } // per-report config fields
}`;
  return (
    <Modal title="Building an engine" sub="How to add a report-generation engine to Report Studio" width={720} onClose={onClose}
      foot={<><button className="btn" onClick={() => downloadEngineStarter()}><Icon name="download" size={15} />Download Maven starter (.zip)</button><button className="btn primary" onClick={onClose}>Got it</button></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.7 }}>
        <div>
          <div className="section-label" style={{ margin: "0 0 4px" }}>How rendering flows</div>
          A report has an <span className="mono">engine</span> kind. When it runs, the worker asks <b>EngineResolver</b> to pick the
          engine for that kind, then calls <span className="mono">render(request, config)</span>. The engine returns a{" "}
          <span className="mono">RenderResult</span> (bytes + content type) which is streamed to the object store. Built-in engines
          run in-process; remote engines are called over HTTP.
        </div>

        <div>
          <div className="section-label" style={{ margin: "0 0 4px" }}>1 · Implement the SPI</div>
          <pre style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 8, padding: 12, overflow: "auto", fontSize: 11.5, lineHeight: 1.6, fontFamily: "var(--mono)" }}>{SPI}</pre>
          <div style={{ marginTop: 8 }}>
            <span className="mono">render()</span> receives the report <b>code, parameters, datasource, output format, and configJson</b>.
            Declare <span className="mono">reportProps()</span> and the per-report config form renders automatically (the same form used by
            the SQL / API engines). Declare <span className="mono">instanceProps()</span> and the install form here renders those fields.
          </div>
        </div>

        <div>
          <div className="section-label" style={{ margin: "0 0 6px" }}>2 · Pick how it plugs in</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ border: "1px solid var(--line)", borderRadius: 9, padding: 11 }}>
              <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 3 }}><span className="chip green" style={{ height: 18, marginRight: 6 }}>built-in</span>In-process class</div>
              Add the class to the backend <span className="mono">engine/</span> package as a Spring <span className="mono">@Component</span>;{" "}
              <span className="mono">requiresInstance()=false</span>. Auto-registered, always available. Needs an app rebuild + redeploy.
              Best for light, native-Java engines.
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: 9, padding: 11 }}>
              <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 3 }}><span className="chip slate" style={{ height: 18, marginRight: 6 }}>remote</span>HTTP service</div>
              Run your renderer as a separate service exposing the render endpoint; set <span className="mono">requiresInstance()=true</span>{" "}
              and register it here with a <b>Base URL + token</b>. No app rebuild — install the URL and it is live. Best for heavy engines
              (Aspose / LibreOffice) or non-JVM renderers.
            </div>
          </div>
        </div>

        <div>
          <div className="section-label" style={{ margin: "0 0 4px" }}>3 · Remote HTTP contract <span style={{ fontWeight: 400, color: "var(--ink-4)" }}>(kind <span className="mono">http</span> — recommended path)</span></div>
          Write a renderer in any language, expose one endpoint, and register its URL below. Report Studio POSTs this envelope and
          treats the response body as the finished document:
          <pre style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 8, padding: 12, overflow: "auto", fontSize: 11.5, lineHeight: 1.6, fontFamily: "var(--mono)", margin: "8px 0" }}>{`POST  {baseUrl}
Content-Type: application/json
Authorization: Bearer <token>        // optional

{
  "code":   "BCE01-01-RPT14",        // report code
  "format": "pdf",                   // pdf | xlsx | csv | docx
  "params": { "fiscalYear": "2025", "regionCode": "C01" }
}`}</pre>
          <pre style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 8, padding: 12, overflow: "auto", fontSize: 11.5, lineHeight: 1.6, fontFamily: "var(--mono)", margin: "0 0 8px" }}>{`200 OK
Content-Type: application/pdf        // the rendered document's MIME type

<raw document bytes>                 // the response body IS the file`}</pre>
          Any non-2xx status fails the render; the call times out at 120s. Then install it here as a <b>Remote</b> engine (kind{" "}
          <span className="mono">http</span>) with the Base URL + optional Bearer token — no app rebuild.
        </div>

        <div style={{ display: "flex", gap: 8, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px" }}>
          <Icon name="alert" size={15} style={{ color: "var(--amber)", flex: "none", marginTop: 1 }} />
          <div style={{ fontSize: 12.5 }}>
            <b>JAR drop-in (ServiceLoader):</b> package your <span className="mono">ReportEngine</span> as a JAR with a{" "}
            <span className="mono">META-INF/services/io.reporthub.reportstudio.engine.ReportEngine</span> entry and upload it with{" "}
            <b>Upload plugin (.jar)</b> above — it loads without an app rebuild. A plugin runs as in-process code, so it is
            ADMIN-only; the SDK types it compiles against are the interfaces shown here.
          </div>
        </div>
      </div>
    </Modal>
  );
}

function InstallModal({ descriptors, onClose, onDone }: { descriptors: EngineDescriptor[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Only REMOTE engines are installed here; built-in engines are always available, nothing to register.
  const kinds = descriptors.filter((d) => d.requiresInstance).map((d) => d.kind);
  const [f, setF] = useState<InstallEngineInput>({
    name: "", kind: kinds[0] ?? "component", installMethod: "url", artifactRef: "", note: "", enabled: true,
  });
  // Install-time values for the selected engine's declared instanceProps, keyed by prop.key.
  // Split into their storage channels on submit (INSTANCE_COLUMN -> columns, INSTANCE_PROPS -> note JSON).
  const [vals, setVals] = useState<Record<string, string>>({});
  const [jarFile, setJarFile] = useState<File | null>(null);
  const jarRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof InstallEngineInput>(k: K, v: InstallEngineInput[K]) => setF((s) => ({ ...s, [k]: v }));
  const isRemote = f.installMethod === "url" || f.installMethod === "service";

  // The selected engine kind's declared install-time fields, rendered via the shared SchemaForm.
  const instanceProps = descriptors.find((d) => d.kind === f.kind)?.instanceProps ?? [];
  const propsKeys = instanceProps.filter((p) => p.storedIn === "INSTANCE_PROPS").map((p) => p.key);

  async function submit() {
    if (f.installMethod === "jar") {
      if (!jarFile) { toast("Choose a .jar file", "error"); return; }
      if (!jarFile.name.toLowerCase().endsWith(".jar")) { toast("Only .jar files are accepted", "error"); return; }
      setBusy(true);
      try {
        const r = await api.uploadEnginePlugin(jarFile);
        toast(`Plugin ${r.jar} installed — engines: ${r.availableKinds.join(", ")}`, "ok");
        onDone();
      } catch (e) {
        toast((e as Error).message, "error");
        setBusy(false);
      }
      return;
    }
    if (!f.name.trim()) { toast("Engine name is required", "error"); return; }
    const body: InstallEngineInput = { name: f.name.trim(), kind: f.kind, installMethod: f.installMethod, enabled: true };
    if (isRemote) {
      const missing = instanceProps.find((p) => p.required && !(vals[p.key] ?? "").trim());
      if (missing) { toast(`${missing.label} is required`, "error"); return; }
      // INSTANCE_COLUMN props map to their dedicated EngineInstance columns; INSTANCE_PROPS props
      // (e.g. the component engine's "app") serialize into the note JSON channel EngineResolver.toConfig reads.
      for (const p of instanceProps) {
        if (p.storedIn !== "INSTANCE_COLUMN") continue;
        const v = (vals[p.key] ?? "").trim();
        if (p.key === "baseUrl") body.baseUrl = v;
        else if (p.key === "authToken") body.authToken = v;
        else if (p.key === "componentFormat") body.componentFormat = v;
      }
      if (propsKeys.length > 0) {
        const propsVals: Record<string, string> = {};
        for (const k of propsKeys) propsVals[k] = vals[k] ?? "";
        body.note = valuesToConfig(propsVals, propsKeys) ?? undefined;
      } else {
        body.note = f.note?.trim() || undefined;
      }
    } else {
      body.artifactRef = f.artifactRef?.trim();
      body.note = f.note?.trim() || undefined;
    }
    setBusy(true);
    try {
      await api.installEngine(body);
      toast(`Installed engine ${body.name}`, "ok");
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  }

  return (
    <Modal title="Install engine" sub="Add a report-generation engine — URL / JAR / lib / service" width={620} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}>{busy ? <span className="spin" /> : <Icon name="download" size={15} />}Install</button></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="field"><label>Install method</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {METHODS.map((m) => (
              <div key={m.id} onClick={() => set("installMethod", m.id)} style={{ padding: "10px 11px", borderRadius: 9, cursor: "pointer", border: "1px solid " + (f.installMethod === m.id ? "var(--accent-line)" : "var(--line)"), background: f.installMethod === m.id ? "var(--accent-weak)" : "var(--surface)" }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: f.installMethod === m.id ? "var(--accent)" : "var(--ink)" }}>{m.label}</div>
                <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 2 }}>{m.hint}</div>
              </div>
            ))}
          </div>
        </div>
        {f.installMethod !== "jar" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="field"><label>Name</label><input className="input" placeholder="e.g. OneWeb Component" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div className="field"><label>Engine kind (adapter)</label>
              <Select value={f.kind} onChange={(v) => set("kind", v)}
                options={kinds.map((k) => ({ value: k, label: k }))} />
              <span className="hint">{KIND_DESC[f.kind] ?? "loaded engine adapter"}</span>
            </div>
          </div>
        )}
        {isRemote ? (
          <>
            {/* Render the selected engine's declared install-time fields — including custom ones like "App id". */}
            <SchemaForm props={instanceProps} values={vals} onChange={(k, v) => setVals((s) => ({ ...s, [k]: v }))}
              empty="This engine has no install-time properties." />
            {f.kind === "component" && (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", display: "flex", gap: 8 }}><Icon name="alert" size={14} style={{ color: "var(--amber)", flex: "none", marginTop: 1 }} />Reports with engine = <span className="mono">{f.kind}</span> are routed to <span className="mono">{"{baseUrl}"}/component/v1/api/export/data</span></div>
            )}
            {/* Engines without INSTANCE_PROPS leave the note channel free for a human annotation. */}
            {propsKeys.length === 0 && (
              <div className="field"><label>Note</label><input className="input" value={f.note} onChange={(e) => set("note", e.target.value)} /></div>
            )}
          </>
        ) : f.installMethod === "jar" ? (
          <div className="field">
            <label>Plugin JAR</label>
            <input ref={jarRef} type="file" accept=".jar" style={{ display: "none" }}
                   onChange={(e) => { setJarFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn sm" onClick={() => jarRef.current?.click()}><Icon name="upload" size={14} />Choose .jar</button>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{jarFile ? jarFile.name : "no file selected"}</span>
            </div>
            <span className="hint">A .jar implementing the ReportEngine SPI (ServiceLoader). The engine kind comes from the jar — no name needed.</span>
            <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-3)" }}>New to this? Open <b>Build an engine</b> and click <b>Download Maven starter</b> to scaffold one.</div>
          </div>
        ) : (
          <>
            <div className="field"><label>Artifact (maven coordinate)</label><input className="input mono" placeholder="com.acme:my-engine:1.0.0" value={f.artifactRef} onChange={(e) => set("artifactRef", e.target.value)} /></div>
            <div className="field"><label>Note</label><input className="input" value={f.note} onChange={(e) => set("note", e.target.value)} /></div>
          </>
        )}
      </div>
    </Modal>
  );
}
