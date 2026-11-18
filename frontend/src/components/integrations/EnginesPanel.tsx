"use client";

import { useEffect, useState } from "react";
import {
  Button, CodeSnippet, FileUploaderDropContainer, FileUploaderItem, FormGroup, IconButton, InlineNotification,
  RadioTile, Stack, Tag, TextInput, Tile, TileGroup,
} from "@carbon/react";
import { Add, Document, Download, Flash, Renew, TrashCan } from "@carbon/icons-react";
import { DataList } from "@/components/DataList";
import { MetricCard } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import { SchemaForm, valuesToConfig } from "@/components/SchemaForm";
import { api, type InstallEngineInput } from "@/lib/api";
import { usePerms } from "@/lib/perms";
import type { EngineDescriptor, EngineInstance, EngineList } from "@/lib/types";
import { downloadEngineStarter } from "@/lib/engineStarter";

const METHODS = [
  { id: "url", label: "Remote URL", hint: "HTTP service such as the component engine — base URL + token" },
  { id: "service", label: "Service", hint: "Internal container/service — base URL" },
  { id: "jar", label: "JAR plugin", hint: "Drop a .jar implementing the ReportEngine SPI (ServiceLoader)" },
  { id: "lib", label: "Library / SDK", hint: "Maven coordinate / module" },
];
const KIND_DESC: Record<string, string> = {
  jasper: "Built-in — Jasper PDF + POI XLSX + CSV + SQL (in-process, lightweight)",
  component: "external component engine (Aspose/LibreOffice) — called over HTTP",
  http: "Generic HTTP engine",
  aspose: "Aspose document engine (separate module)",
};

type EngineRow = EngineInstance & { id: number };

/** Integrations → Report engines: built-in engines, remote engine instances and plugin JARs (formerly the Engines screen). */
export default function EnginesPanel({ onChanged }: { onChanged?: (installed: number) => void } = {}) {
  const { can } = usePerms();
  const toast = useToast();
  const [data, setData] = useState<EngineList | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<EngineInstance | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = () => api.engines().then((d) => { setData(d); onChanged?.(d.installed.length); }).catch((e) => toast((e as Error).message, "error"));
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
    setRemoving(true);
    try {
      await api.deleteEngine(e.id);
      toast(`Removed engine ${e.name}`, "ok");
      setConfirmRemove(null);
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setRemoving(false);
    }
  }

  const installed = data?.installed ?? [];
  const kinds = data?.availableKinds ?? [];
  // DataList keys rows by string id
  const rows = installed.map((e) => ({ ...e, id: String(e.id), _id: e.id })) as unknown as (Omit<EngineRow, "id"> & { id: string; _id: number })[];

  return (
    <div className="rh-stack-gap">
      <div className="rh-section-head">
        <h2 className="cds--type-heading-03">Report engines</h2>
        <div className="rh-section-head__actions">
          <Button kind="tertiary" renderIcon={Document} onClick={() => setGuideOpen(true)}>Build an engine</Button>
          {can("RH.ENGINE", "create") && <Button renderIcon={Add} onClick={() => setInstallOpen(true)}>Install engine</Button>}
        </div>
      </div>

      <div className="rh-metric-grid rh-metric-grid--3">
        <MetricCard icon="engine" label="Installed engines" value={installed.length} />
        <MetricCard icon="checkCircle" label="Enabled" value={installed.filter((e) => e.enabled).length} />
        <MetricCard icon="layers" label="Adapter kinds loaded" value={kinds.length} />
      </div>

      <DataList
        title="Engines"
        description={`Adapters: ${kinds.join(" · ") || "—"}`}
        rows={rows}
        loading={data === null}
        search={rows.length > 8}
        pagination={false}
        empty="No engines yet"
        columns={[
          {
            key: "name", header: "Name",
            render: (e) => (
              <div>
                <div>{e.name}</div>
                {(e.baseUrl ?? e.artifactRef ?? e.note) && (
                  <div className="rh-cell-sub">
                    {e.baseUrl ?? e.artifactRef ? <span className="cds--type-code-01">{e.baseUrl ?? e.artifactRef}</span> : null}
                    {(e.baseUrl ?? e.artifactRef) && e.note ? " · " : null}{e.note}
                  </div>
                )}
              </div>
            ),
          },
          { key: "kind", header: "Kind", render: (e) => <span className="cds--type-code-01">{e.kind}</span> },
          {
            key: "installMethod", header: "Type", sortValue: (e) => (e.installMethod === "builtin" ? "built-in" : "remote"),
            render: (e) => <>{e.installMethod === "builtin" ? "built-in" : "remote"}{e.hasToken ? " · token" : ""}</>,
          },
          {
            key: "enabled", header: "Status", width: 120, sortValue: (e) => (e.enabled ? 1 : 0),
            render: (e) => <Tag size="sm" type={e.enabled ? "green" : "gray"}>{e.enabled ? "Enabled" : "Disabled"}</Tag>,
          },
        ]}
        rowActions={(row) => {
          const e = { ...row, id: row._id } as unknown as EngineInstance;
          return e.installMethod !== "builtin" ? (
            <span className="rh-inline" style={{ gap: 0 }}>
              <Button kind="ghost" size="sm" renderIcon={Flash} disabled={testing === e.id} onClick={() => test(e)}>Test</Button>
              <IconButton kind="ghost" size="sm" label={`Remove ${e.name}`} align="left" onClick={() => setConfirmRemove(e)}><TrashCan /></IconButton>
            </span>
          ) : null;
        }}
      />

      <PluginJars onChanged={load} />

      {installOpen && <InstallModal descriptors={data?.descriptors ?? []} onClose={() => setInstallOpen(false)} onDone={() => { setInstallOpen(false); load(); }} />}
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}
      {confirmRemove && (
        <Modal title={`Remove engine "${confirmRemove.name}"?`} danger width={480} onClose={() => setConfirmRemove(null)}
          foot={<>
            <Button kind="secondary" onClick={() => setConfirmRemove(null)}>Cancel</Button>
            <Button kind="danger" disabled={removing} onClick={() => remove(confirmRemove)}>Remove</Button>
          </>}>
          <p className="cds--type-body-01">Reports that use this engine fail to render until another engine is installed. This cannot be undone.</p>
        </Modal>
      )}
    </div>
  );
}

/** Installed plugin JARs (drop-in ServiceLoader engines) — list, hot-reload, and delete each. */
function PluginJars({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [jars, setJars] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmJar, setConfirmJar] = useState<string | null>(null);

  const load = () => api.enginePlugins().then(setJars).catch(() => setJars([]));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function remove(jar: string) {
    setBusy(jar);
    try {
      await api.deleteEnginePlugin(jar);
      toast(`Removed plugin ${jar}`, "ok");
      setConfirmJar(null);
      load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function reload() {
    setBusy("__reload__");
    try {
      const r = await api.reloadEnginePlugins();
      setJars(r.jars);
      toast(`Reloaded plugins — engines: ${r.availableKinds.join(", ")}`, "ok");
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <DataList
        title="Plugin JARs"
        rows={(jars ?? []).map((j) => ({ id: j }))}
        loading={jars === null}
        search={false}
        pagination={false}
        size="md"
        empty="No plugin JARs installed"
        toolbar={<Button kind="ghost" renderIcon={Renew} disabled={busy === "__reload__"} onClick={reload}>Reload</Button>}
        columns={[{ key: "id", header: "File", render: (r) => <span className="cds--type-code-01">{r.id}</span> }]}
        rowActions={(r) => (
          <IconButton kind="ghost" size="sm" label="Delete this plugin JAR" align="left" disabled={busy === r.id} onClick={() => setConfirmJar(r.id)}>
            <TrashCan />
          </IconButton>
        )}
      />
      {confirmJar && (
        <Modal title={`Delete plugin JAR "${confirmJar}"?`} danger width={480} onClose={() => setConfirmJar(null)}
          foot={<>
            <Button kind="secondary" onClick={() => setConfirmJar(null)}>Cancel</Button>
            <Button kind="danger" disabled={busy === confirmJar} onClick={() => remove(confirmJar)}>Delete</Button>
          </>}>
          <p className="cds--type-body-01">The engine(s) it provides stop loading immediately (no restart needed). This cannot be undone.</p>
        </Modal>
      )}
    </>
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
  const code = (t: string) => <code className="cds--type-code-01">{t}</code>;
  const h = (t: React.ReactNode) => <h3 className="cds--type-heading-compact-02" style={{ marginBottom: "var(--cds-spacing-03)" }}>{t}</h3>;
  return (
    <Modal title="Building an engine" sub="How to add a report-generation engine to Report Studio" width={900} onClose={onClose}
      foot={<>
        <Button kind="secondary" renderIcon={Download} onClick={() => downloadEngineStarter()}>Download Maven starter (.zip)</Button>
        <Button kind="primary" onClick={onClose}>Got it</Button>
      </>}>
      <Stack gap={7} className="cds--type-body-01">
        <section>
          {h("How rendering flows")}
          <p>
            A report has an {code("engine")} kind. When it runs, the worker asks <b>EngineResolver</b> to pick the
            engine for that kind, then calls {code("render(request, config)")}. The engine returns a{" "}
            {code("RenderResult")} (bytes + content type) which is streamed to the object store. Built-in engines
            run in-process; remote engines are called over HTTP.
          </p>
        </section>

        <section>
          {h("1 · Implement the SPI")}
          <CodeSnippet type="multi" feedback="Copied" wrapText={false}>{SPI}</CodeSnippet>
          <p style={{ marginTop: "var(--cds-spacing-04)" }}>
            {code("render()")} receives the report <b>code, parameters, datasource, output format, and configJson</b>.
            Declare {code("reportProps()")} and the per-report config form renders automatically (the same form used by
            the SQL / API engines). Declare {code("instanceProps()")} and the install form here renders those fields.
          </p>
        </section>

        <section>
          {h("2 · Pick how it plugs in")}
          <div className="rh-tile-grid-2">
            <Tile>
              <div className="rh-inline" style={{ marginBottom: "var(--cds-spacing-03)" }}><Tag size="sm" type="green">built-in</Tag><b>In-process class</b></div>
              <p>
                Add the class to the backend {code("engine/")} package as a Spring {code("@Component")};{" "}
                {code("requiresInstance()=false")}. Auto-registered, always available. Needs an app rebuild + redeploy.
                Best for light, native-Java engines.
              </p>
            </Tile>
            <Tile>
              <div className="rh-inline" style={{ marginBottom: "var(--cds-spacing-03)" }}><Tag size="sm" type="gray">remote</Tag><b>HTTP service</b></div>
              <p>
                Run your renderer as a separate service exposing the render endpoint; set {code("requiresInstance()=true")}{" "}
                and register it here with a <b>Base URL + token</b>. No app rebuild — install the URL and it is live. Best for heavy engines
                (Aspose / LibreOffice) or non-JVM renderers.
              </p>
            </Tile>
          </div>
        </section>

        <section>
          {h(<>3 · Remote HTTP contract <span className="rh-dim" style={{ fontWeight: 400 }}>(kind {code("http")} — recommended path)</span></>)}
          <p style={{ marginBottom: "var(--cds-spacing-04)" }}>
            Write a renderer in any language, expose one endpoint, and register its URL below. Report Studio POSTs this envelope and
            treats the response body as the finished document:
          </p>
          <CodeSnippet type="multi" feedback="Copied" wrapText={false}>{`POST  {baseUrl}
Content-Type: application/json
Authorization: Bearer <token>        // optional

{
  "code":   "SALES-114",        // report code
  "format": "pdf",                   // pdf | xlsx | csv | docx
  "params": { "<param>": "<value>" }
}`}</CodeSnippet>
          <div style={{ height: "var(--cds-spacing-04)" }} />
          <CodeSnippet type="multi" feedback="Copied" wrapText={false}>{`200 OK
Content-Type: application/pdf        // the rendered document's MIME type

<raw document bytes>                 // the response body IS the file`}</CodeSnippet>
          <p style={{ marginTop: "var(--cds-spacing-04)" }}>
            Any non-2xx status fails the render; the call times out at 120s. Then install it here as a <b>Remote</b> engine (kind{" "}
            {code("http")}) with the Base URL + optional Bearer token — no app rebuild.
          </p>
        </section>

        <InlineNotification kind="warning" lowContrast hideCloseButton title="JAR drop-in (ServiceLoader)">
          <span>
            Package your {code("ReportEngine")} as a JAR with a{" "}
            {code("META-INF/services/io.reporthub.reportstudio.engine.ReportEngine")} entry and upload it with
            Install engine → JAR plugin — it loads without an app rebuild. A plugin runs as in-process code, so it is
            ADMIN-only; the SDK types it compiles against are the interfaces shown here.
          </span>
        </InlineNotification>
      </Stack>
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof InstallEngineInput>(k: K, v: InstallEngineInput[K]) => setF((s) => ({ ...s, [k]: v }));
  const isRemote = f.installMethod === "url" || f.installMethod === "service";

  // The selected engine kind's declared install-time fields, rendered via the shared SchemaForm.
  const instanceProps = descriptors.find((d) => d.kind === f.kind)?.instanceProps ?? [];
  const propsKeys = instanceProps.filter((p) => p.storedIn === "INSTANCE_PROPS").map((p) => p.key);

  async function submit() {
    if (busy) return;
    setErrors({});
    if (f.installMethod === "jar") {
      if (!jarFile) { setErrors({ jar: "Choose a .jar file" }); return; }
      if (!jarFile.name.toLowerCase().endsWith(".jar")) { setErrors({ jar: "Only .jar files are accepted" }); return; }
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
    if (!f.name.trim()) { setErrors({ name: "Engine name is required" }); return; }
    const body: InstallEngineInput = { name: f.name.trim(), kind: f.kind, installMethod: f.installMethod, enabled: true };
    if (isRemote) {
      const missing = instanceProps.find((p) => p.required && !(vals[p.key] ?? "").trim());
      if (missing) { setErrors({ form: `${missing.label} is required` }); return; }
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
      foot={<>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" renderIcon={Download} disabled={busy} onClick={submit}>Install</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <button type="submit" hidden aria-hidden tabIndex={-1} />
      <Stack gap={6}>
        <TileGroup legend="Install method" name="engine-install-method" valueSelected={f.installMethod}
                   onChange={(v) => set("installMethod", String(v))}>
          <div className="rh-select-tiles">
            {METHODS.map((m) => (
              <RadioTile key={m.id} id={`eng-m-${m.id}`} value={m.id}>
                <div className="cds--type-heading-compact-01">{m.label}</div>
                <div className="cds--type-label-01 rh-dim" style={{ marginTop: "var(--cds-spacing-02)" }}>{m.hint}</div>
              </RadioTile>
            ))}
          </div>
        </TileGroup>
        {f.installMethod !== "jar" && (
          <div className="rh-form-grid">
            <TextInput id="eng-name" labelText="Name" placeholder="e.g. Component Engine" value={f.name}
              invalid={!!errors.name} invalidText={errors.name}
              onChange={(e) => { set("name", e.target.value); if (errors.name) setErrors({}); }} />
            <Select label="Engine kind (adapter)" value={f.kind} onChange={(v) => set("kind", v)}
              options={kinds.map((k) => ({ value: k, label: k }))} helperText={KIND_DESC[f.kind] ?? "loaded engine adapter"} />
          </div>
        )}
        {isRemote ? (
          <>
            {/* Render the selected engine's declared install-time fields — including custom ones like "App id". */}
            <SchemaForm props={instanceProps} values={vals} onChange={(k, v) => setVals((s) => ({ ...s, [k]: v }))}
              empty="This engine has no install-time properties." />
            {f.kind === "component" && (
              <InlineNotification kind="info" lowContrast hideCloseButton title={`Reports with engine = ${f.kind} are routed to`}>
                <code className="cds--type-code-01">{"{baseUrl}"}/component/v1/api/export/data</code>
              </InlineNotification>
            )}
            {/* Engines without INSTANCE_PROPS leave the note channel free for a human annotation. */}
            {propsKeys.length === 0 && (
              <TextInput id="eng-note" labelText="Note" value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} />
            )}
          </>
        ) : f.installMethod === "jar" ? (
          <FormGroup legendText="Plugin JAR">
            <FileUploaderDropContainer accept={[".jar"]} labelText={jarFile ? "Drop a file here or click to replace" : "Drop a .jar here or click to choose"}
              onAddFiles={(_e, { addedFiles }) => { setJarFile(addedFiles[0] ?? null); setErrors({}); }} />
            {errors.jar && <div className="cds--form-requirement" style={{ display: "block", color: "var(--cds-text-error)" }}>{errors.jar}</div>}
            {jarFile && (
              <FileUploaderItem name={jarFile.name} status="edit" iconDescription="Remove file" onDelete={() => setJarFile(null)} />
            )}
          </FormGroup>
        ) : (
          <>
            <TextInput id="eng-artifact" labelText="Artifact (maven coordinate)" className="rh-mono" placeholder="com.acme:my-engine:1.0.0"
                       value={f.artifactRef ?? ""} onChange={(e) => set("artifactRef", e.target.value)} />
            <TextInput id="eng-note2" labelText="Note" value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} />
          </>
        )}
        {errors.form && <InlineNotification kind="error" lowContrast hideCloseButton title={errors.form} />}
      </Stack>
      </form>
    </Modal>
  );
}
