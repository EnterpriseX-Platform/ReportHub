"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { Select } from "@/components/Select";
import type { Datasource, ParamDef, ParamOption, SaveParamInput } from "@/lib/types";

const TYPES = ["string", "integer", "boolean", "enum", "date"];

export default function ParametersPage() {
  const toast = useToast();
  const [rows, setRows] = useState<ParamDef[]>([]);
  const [editing, setEditing] = useState<ParamDef | null | "new">(null);
  const [busyDelete, setBusyDelete] = useState<number | null>(null);

  const reload = useCallback(() => {
    api.parameters().then(setRows).catch((e) => toast(e instanceof Error ? e.message : "Load failed", "error"));
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  async function remove(p: ParamDef) {
    if (p.usedByReports > 0 && !window.confirm(`Parameter ${p.name} is used by ${p.usedByReports} reports — delete anyway?`)) return;
    setBusyDelete(p.id);
    try {
      await api.deleteParameter(p.id);
      toast(`Deleted ${p.name}`, "ok");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    } finally {
      setBusyDelete(null);
    }
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Parameters</h1>
          <div className="page-sub">Central parameter catalog — options come from lookup tables or SQL queries (any datasource), with dependency support (e.g. branch ← region)</div>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" size={16} />New parameter</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead>
              <tr><th>Name</th><th>Label</th><th>Type</th><th>Source</th><th>Depends on</th><th>Used by</th><th style={{ width: 90 }} /></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setEditing(p)}>
                  <td className="mono strong">{p.name}{p.required && <span style={{ color: "var(--red)" }}> *</span>}</td>
                  <td>{p.label}</td>
                  <td><span className="tag-pill">{p.type}</span></td>
                  <td>
                    {p.sourceType === "query" && <span className="chip blue" style={{ height: 19 }}><Icon name="datasource" size={11} />{p.lookupTable}</span>}
                    {p.sourceType === "sql" && <span className="chip violet" style={{ height: 19 }}><Icon name="bolt" size={11} />SQL{p.datasourceId ? ` · ${p.datasourceId}` : ""}</span>}
                    {p.sourceType === "static" && <span className="chip" style={{ height: 19 }}>{p.staticOptions.length ? `${p.staticOptions.length} values` : "free input"}</span>}
                  </td>
                  <td>{p.dependsOn ? <span className="mono" style={{ fontSize: 11.5, color: "var(--accent)" }}>← {p.dependsOn}</span> : <span style={{ color: "var(--ink-4)" }}>—</span>}</td>
                  <td><span className="mono" style={{ fontSize: 11.5 }}>{p.usedByReports}</span></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn sm ghost" onClick={() => setEditing(p)}><Icon name="edit" size={13} /></button>
                      <button className="btn sm ghost" onClick={() => remove(p)} disabled={busyDelete === p.id}>
                        {busyDelete === p.id ? <span className="spin" /> : <Icon name="x" size={13} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7}><div className="empty">No parameters yet</div></td></tr>}
            </tbody>
          </table>
        </div>

        <CascadePreview defs={rows} />
      </div>

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
  const selects = useMemo(() => defs.filter((d) => d.sourceType === "query" || d.sourceType === "sql" || d.staticOptions.length > 0), [defs]);
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div className="card card-pad" style={{ position: "sticky", top: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Icon name="play" size={15} style={{ color: "var(--accent)" }} />
        <b style={{ fontSize: 13 }}>Live preview</b>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>live options API</span>
      </div>
      {selects.length === 0 && <div className="empty">No dropdown parameters yet</div>}
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
    </div>
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
    <div className="field" style={{ marginBottom: 10 }}>
      <label style={{ display: "flex", gap: 6 }}>
        {def.label}
        {def.dependsOn && <span className="chip blue" style={{ height: 17, fontSize: 9.5 }}>← {def.dependsOn}</span>}
      </label>
      <Select value={value} disabled={waiting} onChange={onChange}
        placeholder={waiting ? `Select ${def.dependsOn} first` : `— ${options.length} values —`}
        options={options.map((o) => ({ value: o.value, label: o.label }))} />
    </div>
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

  const set = (patch: Partial<SaveParamInput>) => { setF((s) => ({ ...s, ...patch })); setPreview(null); };

  async function testOptions() {
    setPreviewBusy(true);
    try {
      const body = buildBody();
      const opts = await api.previewParamOptions(body, previewParent || undefined);
      setPreview(opts);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Preview failed", "error");
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
    return body;
  }

  async function save() {
    if (!f.name || !f.label) { toast("name and label are required", "error"); return; }
    const body = buildBody();
    setBusy(true);
    try {
      if (original) await api.updateParameter(original.id, body);
      else await api.createParameter(body);
      toast(`Saved ${f.name}`, "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title={original ? `Edit ${original.name}` : "New parameter"} onClose={onClose} width={620}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field"><label>Name (runtime key)</label>
          <input className="input mono" value={f.name} disabled={!!original} onChange={(e) => set({ name: e.target.value })} placeholder="regionCode" /></div>
        <div className="field"><label>Label</label>
          <input className="input" value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Region" /></div>
        <div className="field"><label>Type</label>
          <Select value={f.type} onChange={(v) => set({ type: v })}
            options={TYPES.map((t) => ({ value: t, label: t }))} /></div>
        <div className="field"><label>Default value</label>
          <input className="input mono" value={f.defaultValue ?? ""} onChange={(e) => set({ defaultValue: e.target.value })} /></div>
        <div className="field" style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 16 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", margin: 0 }}>
            <input type="checkbox" checked={f.required} onChange={(e) => set({ required: e.target.checked })} /> required
          </label>
          <div className="seg">
            <button className={f.sourceType === "query" ? "on" : ""} onClick={() => set({ sourceType: "query" })}>From table</button>
            <button className={f.sourceType === "sql" ? "on" : ""} onClick={() => set({ sourceType: "sql" })}>SQL query</button>
            <button className={f.sourceType === "static" ? "on" : ""} onClick={() => set({ sourceType: "static" })}>Static list</button>
          </div>
        </div>

        {f.sourceType === "query" && (
          <>
            <div className="field"><label>Lookup table <span style={{ fontWeight: 400, color: "var(--ink-4)" }}>(internal warehouse — any table)</span></label>
              <Select value={f.lookupTable ?? ""} searchable placeholder="Pick a table…"
                      options={tables.map((t) => ({ value: t, label: t }))}
                      onChange={(t) => set({ lookupTable: t, valueColumn: "", labelColumn: "", filterColumn: "" })} /></div>
            <div className="field"><label>Value / Label column</label>
              <div style={{ display: "flex", gap: 7 }}>
                <Select style={{ flex: 1 }} value={f.valueColumn ?? ""} placeholder="value…"
                        options={columns.map((c) => ({ value: c, label: c }))} onChange={(v) => set({ valueColumn: v })} />
                <Select style={{ flex: 1 }} value={f.labelColumn ?? ""} placeholder="label…"
                        options={columns.map((c) => ({ value: c, label: c }))} onChange={(v) => set({ labelColumn: v })} />
              </div></div>
            <div className="field"><label>Depends on (parent parameter)</label>
              <Select value={f.dependsOn ?? ""} onChange={(v) => set({ dependsOn: v })}
                options={[{ value: "", label: "— none —" }, ...all.filter((p) => p.name !== f.name).map((p) => ({ value: p.name, label: p.name }))]} /></div>
            <div className="field"><label>Filter column (filtered by the parent value)</label>
              <Select value={f.filterColumn ?? ""} placeholder="— none —"
                      options={[{ value: "", label: "— none —" }, ...columns.map((c) => ({ value: c, label: c }))]}
                      onChange={(v) => set({ filterColumn: v })} /></div>
          </>
        )}

        {f.sourceType === "sql" && (
          <>
            <div className="field"><label>Datasource <span style={{ fontWeight: 400, color: "var(--ink-4)" }}>(where the query runs)</span></label>
              <Select value={f.datasourceId ?? ""} placeholder="Internal warehouse"
                      options={[{ value: "", label: "Internal warehouse (default)" },
                                ...dsList.map((d) => ({ value: d.id, label: d.name, sub: d.engine }))]}
                      onChange={(v) => set({ datasourceId: v })} /></div>
            <div className="field"><label>Depends on (parent parameter)</label>
              <Select value={f.dependsOn ?? ""} onChange={(v) => set({ dependsOn: v })}
                options={[{ value: "", label: "— none —" }, ...all.filter((p) => p.name !== f.name).map((p) => ({ value: p.name, label: p.name }))]} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>SQL — first column = value, second = label · use <code className="mono">:parent</code> for the parent value</label>
              <textarea className="input mono" style={{ height: 110, paddingTop: 9, resize: "vertical" }}
                        value={f.sourceSql ?? ""} onChange={(e) => set({ sourceSql: e.target.value })}
                        placeholder={"SELECT branch_code, branch_name FROM m_branch WHERE region_code = :parent ORDER BY 2"} />
            </div>
          </>
        )}

        {f.sourceType === "static" && (
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>Options (one per line · value=label supported)</label>
            <textarea className="input mono" style={{ height: 120, paddingTop: 9, resize: "vertical" }} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder={"2026\n2568=Fiscal year 2025"} />
          </div>
        )}

        {f.sourceType !== "static" && (
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>Test the options before saving</label>
            <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
              {f.dependsOn && <input className="input mono" style={{ width: 170 }} placeholder={`${f.dependsOn} value…`} value={previewParent} onChange={(e) => setPreviewParent(e.target.value)} />}
              <button className="btn sm" onClick={testOptions} disabled={previewBusy}>
                {previewBusy ? <span className="spin" /> : <Icon name="play" size={13} />}Preview options
              </button>
              {preview && <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{preview.length} options</span>}
            </div>
            {preview && (
              <div style={{ marginTop: 8, maxHeight: 130, overflow: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-2)", padding: "6px 10px" }}>
                {preview.slice(0, 30).map((o) => (
                  <div key={o.value} style={{ display: "flex", gap: 10, fontSize: 11.5, padding: "2px 0" }}>
                    <span className="mono" style={{ color: "var(--accent)", minWidth: 90 }}>{o.value}</span>
                    <span style={{ color: "var(--ink-2)" }}>{o.label}</span>
                  </div>
                ))}
                {preview.length === 0 && <div style={{ fontSize: 11.5, color: "var(--ink-4)", padding: "4px 0" }}>No options returned{f.dependsOn ? " — try entering a parent value" : ""}</div>}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? <span className="spin" /> : <Icon name="check" size={15} />}Save
        </button>
      </div>
    </Modal>
  );
}
