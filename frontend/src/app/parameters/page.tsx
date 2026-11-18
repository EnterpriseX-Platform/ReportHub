"use client";

import { errMsg } from "@/lib/api";
import { usePerms } from "@/lib/perms";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button, Checkbox, ContentSwitcher, IconButton, InlineNotification, Stack, StructuredListBody, StructuredListCell,
  StructuredListRow, StructuredListWrapper, Switch, TextArea, TextInput, Tile,
} from "@carbon/react";
import { Add, Checkmark, Edit, Play, TrashCan } from "@carbon/icons-react";
import { DataList } from "@/components/DataList";
import st from "@/components/R/r.module.scss";
import { Modal } from "@/components/overlays";
import { ModalKeys } from "@/components/R/ModalKeys";
import { useToast } from "@/components/Toast";
import { api, fieldErrors } from "@/lib/api";
import { PageHeader } from "@/components/ui";
import { Select, type SelectOption } from "@/components/Select";
import type { Datasource, ParamDef, ParamOption, SaveParamInput } from "@/lib/types";

const TYPES = ["string", "integer", "boolean", "enum", "date"];

export default function ParametersPage() {
  const { can } = usePerms();
  const toast = useToast();
  const [rows, setRows] = useState<ParamDef[]>([]);
  const [editing, setEditing] = useState<ParamDef | null | "new">(null);
  const [busyDelete, setBusyDelete] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState<ParamDef | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    api.parameters().then(setRows).catch((e) => toast(errMsg(e, "Load failed"), "error")).finally(() => setLoaded(true));
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  /** Used parameters are confirmed in a dialog first; unused ones delete straight away (as before). */
  function remove(p: ParamDef) {
    if (p.usedByReports > 0) { setConfirmDel(p); return; }
    doRemove(p);
  }
  async function doRemove(p: ParamDef) {
    setConfirmDel(null);
    setBusyDelete(p.id);
    try {
      await api.deleteParameter(p.id);
      toast(`Deleted ${p.name}`, "ok");
      reload();
    } catch (e) {
      toast(errMsg(e, "Delete failed"), "error");
    } finally {
      setBusyDelete(null);
    }
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Parameters"
        sub="Central parameter catalog — lookup tables, SQL queries or static lists, with dependencies"
        actions={can("RH.REPORT.PARAMETER", "create") && (<Button kind="primary" renderIcon={Add} onClick={() => setEditing("new")}>New parameter</Button>)}
      />

      <div className={st.paramGrid}>
        <div style={{ minWidth: 0 }}>
          <DataList<ParamDef>
            rows={rows}
            loading={!loaded}
            pageSize={50}
            empty="No parameters yet"
            onRowClick={(p) => setEditing(p)}
            columns={[
              { key: "name", header: "Name", render: (p) => (
                <div>
                  <span className="cds--type-code-01" style={{ fontWeight: 600 }}>{p.name}</span>
                  {p.required && <span style={{ color: "var(--cds-text-error)" }}> *</span>}
                  <div className="cds--type-helper-text-01 rh-dim">{p.label}</div>
                </div>
              ) },
              { key: "type", header: "Type" },
              { key: "sourceType", header: "Source", render: (p) => (
                p.sourceType === "query" ? <span className="cds--type-code-01">{p.lookupTable}</span>
                  : p.sourceType === "sql" ? <span>SQL{p.datasourceId ? <> <span className="cds--type-code-01">{p.datasourceId}</span></> : null}</span>
                  : <span>{p.staticOptions.length ? `${p.staticOptions.length} values` : "free input"}</span>
              ) },
              { key: "dependsOn", header: "After", render: (p) => p.dependsOn ? <span className="cds--type-code-01">{p.dependsOn}</span> : <span className="rh-dim">—</span> },
              { key: "usedByReports", header: "Used by", align: "end", render: (p) => (
                /* Unused parameters show "unused" instead of a big 0. */
                p.usedByReports > 0 ? `${p.usedByReports} ${p.usedByReports === 1 ? "report" : "reports"}` : <span className="rh-dim">unused</span>
              ) },
            ]}
            rowActions={(row) => {
              const p = row;
              return (
                <>
                  {can("RH.REPORT.PARAMETER", "update") && (<IconButton kind="ghost" size="sm" align="left" label="Edit" onClick={() => setEditing(p)}><Edit /></IconButton>)}
                  {can("RH.REPORT.PARAMETER", "delete") && (
                    <IconButton kind="ghost" size="sm" align="left" label="Delete" onClick={() => remove(p)} disabled={busyDelete === p.id}><TrashCan /></IconButton>
                  )}
                </>
              );
            }}
          />
        </div>

        <CascadePreview defs={rows} />
      </div>

      {confirmDel && (
        <Modal title={`Delete ${confirmDel.name}?`} width={460} danger onClose={() => setConfirmDel(null)}
          foot={<>
            <Button kind="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button kind="danger" onClick={() => doRemove(confirmDel)}>Delete anyway</Button>
          </>}>
          <p className="cds--type-body-01">Parameter <span className="cds--type-code-01">{confirmDel.name}</span> is used by {confirmDel.usedByReports} reports.</p>
        </Modal>
      )}

      {editing && (
        <ParamEditor
          original={editing === "new" ? null : editing}
          all={rows}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

/** Live preview — actually exercises the options API including the cascade. */
function CascadePreview({ defs }: { defs: ParamDef[] }) {
  // Parents before children (depth-first from the roots), so a cascade reads top to bottom.
  const selects = useMemo(() => {
    const list = defs.filter((d) => d.sourceType === "query" || d.sourceType === "sql" || d.staticOptions.length > 0);
    const names = new Set(list.map((d) => d.name));
    const out: ParamDef[] = [];
    const seen = new Set<string>();
    const visit = (d: ParamDef) => {
      if (seen.has(d.name)) return;
      seen.add(d.name);
      out.push(d);
      list.filter((c) => c.dependsOn === d.name).forEach(visit);
    };
    list.filter((d) => !d.dependsOn || !names.has(d.dependsOn)).forEach(visit);
    list.forEach(visit); // cycles / leftovers keep their place at the end
    return out;
  }, [defs]);
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <Tile className={st.paramPreview}>
      <div className="rh-tile-head">
        <Play size={16} style={{ fill: "var(--cds-icon-secondary)" }} />
        <h2 className="cds--type-heading-compact-01">Live preview</h2>
        <span className="cds--type-helper-text-01 rh-dim" style={{ marginLeft: "auto" }}>live options API</span>
      </div>
      {selects.length === 0 && <p className="cds--type-body-compact-01 rh-dim">No dropdown parameters yet</p>}
      <Stack gap={5}>
        {selects.map((d) => (
          <PreviewSelect
            key={d.id}
            def={d}
            value={values[d.name] ?? ""}
            parentValue={d.dependsOn ? values[d.dependsOn] ?? "" : undefined}
            onChange={(v) => setValues((s) => {
              const next = { ...s, [d.name]: v };
              defs.filter((c) => c.dependsOn === d.name).forEach((c) => { delete next[c.name]; });
              return next;
            })}
          />
        ))}
      </Stack>
    </Tile>
  );
}

function PreviewSelect({ def, value, parentValue, onChange }: {
  def: ParamDef; value: string; parentValue?: string; onChange: (v: string) => void;
}) {
  const [options, setOptions] = useState<ParamOption[]>([]);
  const waiting = !!def.dependsOn && !parentValue;

  useEffect(() => {
    if (waiting) { setOptions([]); return; }
    let cancelled = false;
    api.paramOptions(def.name, def.dependsOn ? parentValue : undefined)
      .then((o) => { if (!cancelled) setOptions(o); })
      .catch(() => { if (!cancelled) setOptions([]); });
    return () => { cancelled = true; };
  }, [def.name, def.dependsOn, parentValue, waiting]);

  return (
    <Select value={value} disabled={waiting} onChange={onChange}
      label={def.label + (def.dependsOn ? ` ← ${def.dependsOn}` : "")}
      placeholder={waiting ? `Select ${def.dependsOn} first` : `— ${options.length} values —`}
      options={options.map((o) => ({ value: o.value, label: o.label }))} />
  );
}

function ParamEditor({ original, all, onClose, onSaved }: {
  original: ParamDef | null;
  all: ParamDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<SaveParamInput>(() => original ? {
    name: original.name, label: original.label, type: original.type, required: original.required,
    defaultValue: original.defaultValue, sourceType: original.sourceType,
    staticOptions: original.staticOptions, lookupTable: original.lookupTable,
    sourceSql: original.sourceSql, datasourceId: original.datasourceId,
    valueColumn: original.valueColumn, labelColumn: original.labelColumn,
    dependsOn: original.dependsOn, filterColumn: original.filterColumn, sortOrder: original.sortOrder,
  } : {
    name: "", label: "", type: "enum", required: false, defaultValue: "",
    sourceType: "query", staticOptions: [], lookupTable: "ref_region", sourceSql: "", datasourceId: "",
    valueColumn: "code", labelColumn: "name", dependsOn: "", filterColumn: "", sortOrder: (all.length + 1) * 10,
  });
  const [optionsText, setOptionsText] = useState(() =>
    (original?.staticOptions ?? []).map((o) => o.value === o.label ? o.value : `${o.value}=${o.label}`).join("\n"));
  const [busy, setBusy] = useState(false);
  // dynamic lookup metadata + datasources + option preview
  const [tables, setTables] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [dsList, setDsList] = useState<Datasource[]>([]);
  const [preview, setPreview] = useState<ParamOption[] | null>(null);
  const [previewParent, setPreviewParent] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    api.paramLookupTables().then(setTables).catch(() => {});
    api.datasources().then(setDsList).catch(() => {});
  }, []);
  useEffect(() => {
    if (f.sourceType !== "query" || !f.lookupTable) { setColumns([]); return; }
    api.paramTableColumns(f.lookupTable).then(setColumns).catch(() => setColumns([]));
  }, [f.sourceType, f.lookupTable]);

  const set = (patch: Partial<SaveParamInput>) => { setF((s) => ({ ...s, ...patch })); setPreview(null); setSrvErr(null); };
  // Backend 400 (lookup table not allow-listed, unregistered datasource, field errors) shown inline.
  const [srvErr, setSrvErr] = useState<string | null>(null);
  const [fErr, setFErr] = useState<Record<string, string>>({});
  const needsDs = f.sourceType === "sql" && !f.datasourceId;

  async function testOptions() {
    if (needsDs) { setFErr({ datasourceId: "Pick a datasource for an SQL parameter" }); return; }
    setPreviewBusy(true);
    try {
      const body = buildBody();
      const opts = await api.previewParamOptions(body, previewParent || undefined);
      setPreview(opts);
    } catch (e) {
      setSrvErr(errMsg(e, "Preview failed"));
      setFErr(fieldErrors(e));
      setPreview(null);
    } finally {
      setPreviewBusy(false);
    }
  }

  function buildBody(): SaveParamInput {
    const body: SaveParamInput = { ...f };
    if (f.sourceType === "static") {
      body.staticOptions = optionsText.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const [v, ...rest] = l.split("=");
        return { value: v.trim(), label: rest.length ? rest.join("=").trim() : v.trim() };
      });
      body.lookupTable = null; body.valueColumn = null; body.labelColumn = null;
      body.sourceSql = null; body.datasourceId = null;
      body.dependsOn = null; body.filterColumn = null;
    }
    if (f.sourceType === "sql") {
      body.lookupTable = null; body.valueColumn = null; body.labelColumn = null; body.filterColumn = null;
      body.staticOptions = [];
    }
    if (f.sourceType === "query") {
      body.sourceSql = null; body.datasourceId = null; body.staticOptions = [];
    }
    // "None" in a picker is an empty string: store a real null, not "".
    body.dependsOn = body.dependsOn?.trim() || null;
    body.filterColumn = body.filterColumn?.trim() || null;
    body.lookupTable = body.lookupTable?.trim() || null;
    body.datasourceId = body.datasourceId?.trim() || null;
    return body;
  }

  async function save() {
    if (!f.name || !f.label) { toast("name and label are required", "error"); return; }
    if (needsDs) { setFErr({ datasourceId: "Pick a datasource for an SQL parameter" }); return; }
    setFErr({}); setSrvErr(null);
    const body = buildBody();
    setBusy(true);
    try {
      if (original) await api.updateParameter(original.id, body);
      else await api.createParameter(body);
      toast(`Saved ${f.name}`, "ok");
      onSaved();
    } catch (e) {
      const fe = fieldErrors(e);
      setFErr(fe);
      setSrvErr(errMsg(e, "Save failed"));
      setBusy(false);
    }
  }

  const parentOpts = [{ value: "", label: "None" }, ...all.filter((p) => p.name !== f.name).map((p) => ({ value: p.name, label: p.name }))];
  const SOURCES = ["query", "sql", "static"] as const;
  return (
    <Modal title={original ? `Edit ${original.name}` : "New parameter"} onClose={onClose} width={720}
      foot={<>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={busy}>Save</Button>
      </>}>
      <ModalKeys onSubmit={() => { if (!busy) save(); }}>
      <div className="rh-form-grid">
        <TextInput id="pe-name" labelText="Name (runtime key)" className="rh-mono" value={f.name} disabled={!!original}
                   onChange={(e) => set({ name: e.target.value })} placeholder="paramName" invalid={!!fErr.name} invalidText={fErr.name} />
        <TextInput id="pe-label" labelText="Label" value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Region"
                   invalid={!!fErr.label} invalidText={fErr.label} />
        <Select label="Type" value={f.type} onChange={(v) => set({ type: v })} options={TYPES.map((t) => ({ value: t, label: t }))} />
        <TextInput id="pe-default" labelText="Default value" className="rh-mono" value={f.defaultValue ?? ""} onChange={(e) => set({ defaultValue: e.target.value })} />
        <div className="rh-span-2" style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-06)", flexWrap: "wrap" }}>
          <Checkbox id="pe-req" labelText="required" checked={f.required} onChange={(_, { checked }) => set({ required: checked })} />
          <ContentSwitcher size="md" selectedIndex={SOURCES.indexOf(f.sourceType as typeof SOURCES[number])}
                           onChange={({ name }) => set({ sourceType: name as SaveParamInput["sourceType"] })} style={{ width: "auto", flex: "1 1 320px" }}>
            <Switch name="query" text="From table" />
            <Switch name="sql" text="SQL query" />
            <Switch name="static" text="Static list" />
          </ContentSwitcher>
        </div>

        {f.sourceType === "query" && (
          <>
            <Select label="Lookup table" value={f.lookupTable ?? ""} searchable placeholder="Pick a table…" invalidText={fErr.lookupTable}
                    options={tables.length > 0 ? tables.map((t) => ({ value: t, label: t }))
                      : [{ value: "", label: "No lookup tables enabled", disabled: true } as SelectOption]}
                    onChange={(t) => t && set({ lookupTable: t, valueColumn: "", labelColumn: "", filterColumn: "" })} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--cds-spacing-03)" }}>
              <Select label="Value column" value={f.valueColumn ?? ""} placeholder="value…"
                      options={columns.map((c) => ({ value: c, label: c }))} onChange={(v) => set({ valueColumn: v })} />
              <Select label="Label column" value={f.labelColumn ?? ""} placeholder="label…"
                      options={columns.map((c) => ({ value: c, label: c }))} onChange={(v) => set({ labelColumn: v })} />
            </div>
            <Select label="Depends on (parent parameter)" value={f.dependsOn ?? ""} onChange={(v) => set({ dependsOn: v })} options={parentOpts} />
            <Select label="Filter column (filtered by the parent value)" value={f.filterColumn ?? ""} placeholder="None"
                    options={[{ value: "", label: "None" }, ...columns.map((c) => ({ value: c, label: c }))]}
                    onChange={(v) => set({ filterColumn: v })} />
          </>
        )}

        {f.sourceType === "sql" && (
          <>
            <Select label="Datasource *" value={f.datasourceId ?? ""} placeholder="Pick a datasource…" invalidText={fErr.datasourceId || undefined}
                    options={dsList.map((d) => ({ value: d.id, label: d.name, sub: d.engine }))}
                    onChange={(v) => { set({ datasourceId: v }); setFErr((x) => ({ ...x, datasourceId: "" })); }} />
            <Select label="Depends on (parent parameter)" value={f.dependsOn ?? ""} onChange={(v) => set({ dependsOn: v })} options={parentOpts} />
            <div className="rh-span-2">
              <TextArea id="pe-sql" className="rh-mono" rows={5}
                        labelText={<>SQL — first column = value, second = label · use <code className="cds--type-code-01">:parent</code> for the parent value</>}
                        value={f.sourceSql ?? ""} onChange={(e) => set({ sourceSql: e.target.value })}
                        placeholder={"SELECT branch_code, branch_name FROM m_branch WHERE region_code = :parent ORDER BY 2"} />
            </div>
          </>
        )}

        {f.sourceType === "static" && (
          <div className="rh-span-2">
            <TextArea id="pe-static" labelText="Options (one per line · value=label supported)" className="rh-mono" rows={5}
                      value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder={"2026\n2025=Fiscal year 2025"} />
          </div>
        )}

        {srvErr && (
          <div className="rh-span-2">
            <InlineNotification kind="error" lowContrast hideCloseButton title="Error" subtitle={srvErr} style={{ maxWidth: "none" }} />
          </div>
        )}

        {f.sourceType !== "static" && (
          <div className="rh-span-2">
            <div className="cds--label">Test the options before saving</div>
            <div style={{ display: "flex", gap: "var(--cds-spacing-03)", alignItems: "center", flexWrap: "wrap" }}>
              {f.dependsOn && <TextInput id="pe-parent" size="sm" labelText="Parent value" hideLabel className="rh-mono" style={{ width: 170 }}
                                         placeholder={`${f.dependsOn} value…`} value={previewParent} onChange={(e) => setPreviewParent(e.target.value)} />}
              <Button kind="tertiary" size="sm" renderIcon={Play} onClick={testOptions} disabled={previewBusy}>Preview options</Button>
              {preview && <span className="cds--type-helper-text-01 rh-dim">{preview.length} options</span>}
            </div>
            {preview && (
              <div style={{ marginTop: "var(--cds-spacing-03)", maxHeight: 160, overflow: "auto" }}>
                {preview.length === 0
                  ? <p className="cds--type-body-compact-01 rh-dim">No options returned{f.dependsOn ? " — try entering a parent value" : ""}</p>
                  : (
                    <StructuredListWrapper isCondensed className="rh-slist" aria-label="Options preview">
                      <StructuredListBody>
                        {preview.slice(0, 30).map((o) => (
                          <StructuredListRow key={o.value}>
                            <StructuredListCell noWrap className="cds--type-code-01">{o.value}</StructuredListCell>
                            <StructuredListCell>{o.label}</StructuredListCell>
                          </StructuredListRow>
                        ))}
                      </StructuredListBody>
                    </StructuredListWrapper>
                  )}
              </div>
            )}
          </div>
        )}
      </div>
    </ModalKeys>
    </Modal>
  );
}
