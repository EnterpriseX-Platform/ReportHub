"use client";

// Repository / Database Tool: browse the tables of any datasource, page through and
// edit their rows, and run ad-hoc SQL. Reuses the datasource JDBC plumbing; all writes go through
// parameterized, identifier-validated backend endpoints.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import { api, saveAs } from "@/lib/api";
import type { Datasource, RepoColumn, RepoExecResult, RepoRows, RepoTable, RepoTableMeta } from "@/lib/types";

const PAGE = 100;
type Tab = "data" | "columns" | "sql";

export default function RepositoryPage() {
  const toast = useToast();
  const [dss, setDss] = useState<Datasource[]>([]);
  const [datasourceId, setDatasourceId] = useState<string>("");
  const [tables, setTables] = useState<RepoTable[]>([]);
  const [tablesErr, setTablesErr] = useState<string | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<RepoTable | null>(null);
  const [tab, setTab] = useState<Tab>("data");

  useEffect(() => { api.datasources().then(setDss).catch(() => {}); }, []);

  const loadTables = useCallback(() => {
    setLoadingTables(true); setTablesErr(null); setActive(null);
    api.repoTables(datasourceId || null)
      .then((t) => setTables(t))
      .catch((e) => { setTables([]); setTablesErr(e instanceof Error ? e.message : "Failed to list tables"); })
      .finally(() => setLoadingTables(false));
  }, [datasourceId]);
  useEffect(() => { loadTables(); }, [loadTables]);

  const shown = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())),
    [tables, filter]);

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Repository</h1>
          <div className="page-sub">Browse and edit the tables of any datasource — view data, manage rows, and run SQL</div>
        </div>
        <div className="page-actions" style={{ minWidth: 280 }}>
          <Select value={datasourceId} onChange={setDatasourceId} placeholder="Internal warehouse"
                  options={[{ value: "", label: "Internal warehouse (SIT Postgres)" },
                            ...dss.map((d) => ({ value: d.id, label: `${d.name}${d.hasJdbc ? " · live JDBC" : ""}` }))]} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14, alignItems: "start" }}>
        {/* Tables tree */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 11px", borderBottom: "1px solid var(--line)" }}>
            <Icon name="database" size={15} style={{ color: "var(--ink-3)" }} />
            <b style={{ fontSize: 12.5 }}>Tables</b>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>{tables.length}</span>
            <button className="btn sm ghost" title="Refresh" onClick={loadTables}><Icon name="refresh" size={12} /></button>
          </div>
          <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
            <input className="input" style={{ height: 30, fontSize: 12 }} placeholder="Search tables…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div style={{ maxHeight: "62vh", overflow: "auto" }}>
            {loadingTables && <div className="empty" style={{ padding: 24 }}><span className="spin" /></div>}
            {tablesErr && <div style={{ padding: 12, fontSize: 12, color: "var(--red)" }}>{tablesErr}</div>}
            {!loadingTables && !tablesErr && shown.map((t) => {
              const on = active?.name === t.name && active?.schema === t.schema;
              return (
                <button key={`${t.schema ?? ""}.${t.name}`} onClick={() => { setActive(t); setTab("data"); }}
                        className="repo-table-row" style={{
                          display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left",
                          padding: "7px 11px", border: "none", borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
                          background: on ? "var(--accent-weak)" : "transparent", cursor: "pointer", fontSize: 12.5,
                          color: on ? "var(--accent)" : "var(--ink-2)", fontWeight: on ? 600 : 400 }}>
                  <Icon name={t.type === "VIEW" ? "eye" : "table"} size={13} style={{ opacity: 0.7, flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                </button>
              );
            })}
            {!loadingTables && !tablesErr && shown.length === 0 && <div className="empty" style={{ padding: 20, fontSize: 12 }}>No tables</div>}
          </div>
        </div>

        {/* Main panel */}
        {active ? (
          <TablePanel key={`${datasourceId}:${active.schema ?? ""}.${active.name}`}
                      datasourceId={datasourceId} table={active} tab={tab} setTab={setTab} toast={toast} />
        ) : (
          <SqlOnlyPanel datasourceId={datasourceId} tab={tab} setTab={setTab} toast={toast} />
        )}
      </div>
    </div>
  );
}

function TabBar({ tab, setTab, hasTable }: { tab: Tab; setTab: (t: Tab) => void; hasTable: boolean }) {
  const tabs: { key: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
    { key: "data", label: "Data", icon: "table" },
    { key: "columns", label: "Properties", icon: "layers" },
    { key: "sql", label: "SQL Editor", icon: "adhoc" },
  ];
  return (
    <div style={{ display: "flex", gap: 2, padding: "0 6px", borderBottom: "1px solid var(--line)" }}>
      {tabs.map((t) => {
        if (t.key !== "sql" && !hasTable) return null;
        const on = tab === t.key;
        return (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", border: "none", background: "transparent",
            borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent", color: on ? "var(--accent)" : "var(--ink-3)",
            fontWeight: on ? 600 : 500, fontSize: 12.5, cursor: "pointer", marginBottom: -1 }}>
            <Icon name={t.icon} size={14} />{t.label}
          </button>
        );
      })}
    </div>
  );
}

function TablePanel({ datasourceId, table, tab, setTab, toast }: {
  datasourceId: string; table: RepoTable; tab: Tab; setTab: (t: Tab) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [meta, setMeta] = useState<RepoTableMeta | null>(null);
  const [rows, setRows] = useState<RepoRows | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: "new" | "edit"; values: Record<string, string>; orig?: (string | number | null)[] } | null>(null);

  const schema = table.schema ?? undefined;

  useEffect(() => {
    api.repoTableMeta(table.name, datasourceId || null, schema).then(setMeta).catch(() => setMeta(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, table.name, table.schema]);

  const load = useCallback((off: number) => {
    setLoading(true); setErr(null);
    api.repoRows(table.name, { datasourceId: datasourceId || null, schema, limit: PAGE, offset: off })
      .then((r) => { setRows(r); setOffset(off); })
      .catch((e) => { setRows(null); setErr(e instanceof Error ? e.message : "Failed to load rows"); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, table.name, table.schema]);
  useEffect(() => { if (tab === "data") load(0); }, [tab, load]);

  const pk = meta?.primaryKey ?? [];
  const canEdit = pk.length > 0;

  function keyOf(row: (string | number | null)[]): Record<string, unknown> {
    const cols = rows!.columns;
    const k: Record<string, unknown> = {};
    for (const p of pk) { const i = cols.findIndex((c) => c.toLowerCase() === p.toLowerCase()); if (i >= 0) k[p] = row[i]; }
    return k;
  }

  async function removeRow(row: (string | number | null)[]) {
    if (!canEdit) return;
    if (!window.confirm("Delete this row?")) return;
    try {
      const res = await api.repoDelete(table.name, { datasourceId: datasourceId || null, schema, key: keyOf(row) });
      toast(`Deleted · ${res.affected} row(s)`, "ok");
      load(offset);
    } catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  function openEdit(row: (string | number | null)[]) {
    const values: Record<string, string> = {};
    rows!.columns.forEach((c, i) => { values[c] = row[i] === null ? "" : String(row[i]); });
    setEditing({ mode: "edit", values, orig: row });
  }
  function openNew() {
    const values: Record<string, string> = {};
    (meta?.columns ?? []).forEach((c) => { values[c.name] = ""; });
    setEditing({ mode: "new", values });
  }

  async function saveEdit(edited: Record<string, string>, nulls: Record<string, boolean>) {
    if (!editing || !meta) return;
    try {
      if (editing.mode === "new") {
        const values: Record<string, unknown> = {};
        for (const c of meta.columns) {
          const v = edited[c.name];
          if (nulls[c.name]) values[c.name] = null;
          else if (v !== "" && v !== undefined) values[c.name] = v;
        }
        if (Object.keys(values).length === 0) { toast("Enter at least one value", "error"); return; }
        const res = await api.repoInsert(table.name, { datasourceId: datasourceId || null, schema, values });
        toast(`Inserted · ${res.affected} row(s)`, "ok");
      } else {
        const set: Record<string, unknown> = {};
        rows!.columns.forEach((c, i) => {
          const before = editing.orig![i];
          const after = nulls[c] ? null : edited[c];
          const beforeStr = before === null ? "" : String(before);
          if (nulls[c] ? before !== null : after !== beforeStr) set[c] = after;
        });
        if (Object.keys(set).length === 0) { setEditing(null); return; }
        const res = await api.repoUpdate(table.name, { datasourceId: datasourceId || null, schema, set, key: keyOf(editing.orig!) });
        toast(`Updated · ${res.affected} row(s)`, "ok");
      }
      setEditing(null); load(offset);
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
  }

  function exportCsv() {
    if (!rows) return;
    const esc = (v: string | number | null) => { const s = v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [rows.columns.join(","), ...rows.rows.map((r) => r.map(esc).join(","))].join("\n");
    saveAs(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `${table.name}.csv`);
  }

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 13px", borderBottom: "1px solid var(--line)" }}>
        <Icon name={table.type === "VIEW" ? "eye" : "table"} size={15} style={{ color: "var(--accent)" }} />
        <b style={{ fontSize: 13.5 }}>{table.schema ? `${table.schema}.` : ""}{table.name}</b>
        {table.type === "VIEW" && <span className="chip" style={{ height: 18 }}>view</span>}
        {meta && <span style={{ fontSize: 11, color: "var(--ink-4)" }}>{meta.columns.length} cols{pk.length ? ` · PK: ${pk.join(", ")}` : " · no PK"}</span>}
      </div>
      <TabBar tab={tab} setTab={setTab} hasTable />

      {tab === "data" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)" }}>
            <button className="btn sm" onClick={openNew}><Icon name="plus" size={13} />Add row</button>
            <button className="btn sm ghost" onClick={() => load(offset)} title="Reload"><Icon name="refresh" size={13} /></button>
            <button className="btn sm ghost" onClick={exportCsv} title="Export this page as CSV"><Icon name="download" size={13} />CSV</button>
            {!canEdit && <span style={{ fontSize: 11, color: "var(--ink-4)" }}>read-only — table has no primary key (use the SQL Editor to write)</span>}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-3)" }}>
              <button className="btn sm ghost" disabled={offset === 0 || loading} onClick={() => load(Math.max(0, offset - PAGE))}><Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /></button>
              <span>rows {rows ? offset + 1 : 0}–{rows ? offset + rows.rowCount : 0}</span>
              <button className="btn sm ghost" disabled={loading || !rows || rows.rowCount < PAGE} onClick={() => load(offset + PAGE)}><Icon name="chevron" size={13} /></button>
            </div>
          </div>
          <div style={{ overflow: "auto", maxHeight: "58vh" }}>
            {loading && <div className="empty" style={{ padding: 30 }}><span className="spin" /></div>}
            {err && <div style={{ padding: 14, fontSize: 12.5, color: "var(--red)" }}>{err}</div>}
            {!loading && !err && rows && (
              <table className="tbl">
                <thead><tr>
                  {(canEdit) && <th style={{ width: 64 }} />}
                  {rows.columns.map((c) => <th key={c}>{c}{pk.some((p) => p.toLowerCase() === c.toLowerCase()) && <Icon name="star" size={10} style={{ marginLeft: 4, color: "var(--amber, var(--accent))" }} />}</th>)}
                </tr></thead>
                <tbody>
                  {rows.rows.map((r, i) => (
                    <tr key={i} style={{ cursor: canEdit ? "pointer" : "default" }} onClick={() => canEdit && openEdit(r)}>
                      {canEdit && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <button className="btn sm ghost" title="Edit" onClick={() => openEdit(r)}><Icon name="edit" size={12} /></button>
                            <button className="btn sm ghost" title="Delete" onClick={() => removeRow(r)}><Icon name="x" size={12} /></button>
                          </div>
                        </td>
                      )}
                      {r.map((v, j) => <td key={j} className={typeof v === "number" ? "num mono" : ""} style={{ fontSize: 12, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v === null ? <span style={{ color: "var(--ink-4)" }}>NULL</span> : String(v)}</td>)}
                    </tr>
                  ))}
                  {rows.rowCount === 0 && <tr><td colSpan={rows.columns.length + (canEdit ? 1 : 0)}><div className="empty">No rows</div></td></tr>}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === "columns" && meta && <ColumnsTab columns={meta.columns} />}
      {tab === "sql" && <SqlEditor datasourceId={datasourceId} toast={toast} seed={`SELECT * FROM ${table.schema ? `"${table.schema}".` : ""}"${table.name}"`} />}

      {editing && meta && (
        <RowEditor meta={meta} editing={editing} setEditing={setEditing} onSave={saveEdit} />
      )}
    </div>
  );
}

function ColumnsTab({ columns }: { columns: RepoColumn[] }) {
  return (
    <div style={{ overflow: "auto", maxHeight: "62vh" }}>
      <table className="tbl">
        <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Key</th></tr></thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} style={{ cursor: "default" }}>
              <td className="strong">{c.name}</td>
              <td className="mono" style={{ fontSize: 12 }}>{c.type}</td>
              <td>{c.nullable ? <span style={{ color: "var(--ink-4)" }}>nullable</span> : <span className="chip" style={{ height: 18 }}>NOT NULL</span>}</td>
              <td>{c.pk ? <span className="chip green" style={{ height: 18 }}>PK</span> : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowEditor({ meta, editing, setEditing, onSave }: {
  meta: RepoTableMeta;
  editing: { mode: "new" | "edit"; values: Record<string, string>; orig?: (string | number | null)[] };
  setEditing: (e: typeof editing | null) => void;
  onSave: (values: Record<string, string>, nulls: Record<string, boolean>) => void;
}) {
  const [values, setValues] = useState(editing.values);
  const [nulls, setNulls] = useState<Record<string, boolean>>(() => {
    const n: Record<string, boolean> = {};
    if (editing.mode === "edit" && editing.orig) meta.columns.forEach((c, i) => { if (editing.orig![i] === null) n[c.name] = true; });
    return n;
  });
  return (
    <div className="modal-backdrop" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "grid", placeItems: "center", zIndex: 50 }} onClick={() => setEditing(null)}>
      <div className="card card-pad" style={{ width: 520, maxHeight: "82vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <b style={{ fontSize: 14 }}>{editing.mode === "new" ? "Insert row" : "Edit row"}</b>
          <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setEditing(null)}><Icon name="x" size={14} /></button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {meta.columns.map((c) => (
            <div key={c.name} className="field">
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                {c.name}<span className="mono" style={{ color: "var(--ink-4)", fontWeight: 400 }}>{c.type}</span>
                {c.pk && <span className="chip green" style={{ height: 16 }}>PK</span>}
                <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontWeight: 400, color: "var(--ink-4)" }}>
                  <input type="checkbox" checked={!!nulls[c.name]} onChange={(e) => setNulls((n) => ({ ...n, [c.name]: e.target.checked }))} disabled={!c.nullable && !c.pk} />NULL
                </label>
              </label>
              <input className="input mono" style={{ fontSize: 12.5 }} value={nulls[c.name] ? "" : (values[c.name] ?? "")}
                     disabled={nulls[c.name]}
                     onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))} />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="btn primary" onClick={() => onSave(values, nulls)}><Icon name="check" size={14} />{editing.mode === "new" ? "Insert" : "Save changes"}</button>
          <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)", alignSelf: "center" }}>
            {editing.mode === "edit" ? "Leave NULL columns checked to clear them" : "Empty fields are omitted (DB default applies)"}
          </span>
        </div>
      </div>
    </div>
  );
}

function SqlOnlyPanel({ datasourceId, tab, setTab, toast }: {
  datasourceId: string; tab: Tab; setTab: (t: Tab) => void; toast: ReturnType<typeof useToast>;
}) {
  useEffect(() => { if (tab !== "sql") setTab("sql"); }, [tab, setTab]);
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ padding: "10px 13px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="adhoc" size={15} style={{ color: "var(--ink-3)" }} />
        <b style={{ fontSize: 13 }}>SQL Editor</b>
        <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>select a table on the left, or run SQL directly</span>
      </div>
      <SqlEditor datasourceId={datasourceId} toast={toast} seed="" />
    </div>
  );
}

function SqlEditor({ datasourceId, toast, seed }: { datasourceId: string; toast: ReturnType<typeof useToast>; seed: string }) {
  const [sql, setSql] = useState(seed);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RepoExecResult | null>(null);

  async function run() {
    if (!sql.trim()) return;
    setRunning(true);
    try {
      const res = await api.repoExecute({ datasourceId: datasourceId || null, sql });
      setResult(res);
      toast(res.kind === "select" ? `${res.rowCount} rows` : `${res.affected} row(s) affected`, "ok");
    } catch (e) { setResult(null); toast(e instanceof Error ? e.message : "SQL failed", "error"); }
    finally { setRunning(false); }
  }

  return (
    <div style={{ padding: 13, display: "flex", flexDirection: "column", gap: 11 }}>
      <textarea className="input mono" style={{ height: 150, paddingTop: 10, resize: "vertical", fontSize: 12.5, lineHeight: 1.7, tabSize: 2 }}
                value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false}
                placeholder="SELECT / INSERT / UPDATE / DELETE / MERGE — a single statement" />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button className="btn primary" disabled={running} onClick={run}>{running ? <span className="spin" /> : <Icon name="play" size={15} />}Run</button>
        <span style={{ fontSize: 11, color: "var(--ink-4)" }}>single statement · DDL (DROP/ALTER/TRUNCATE/CREATE) is blocked</span>
      </div>
      {result && result.kind === "update" && (
        <div className="card card-pad" style={{ boxShadow: "none", background: "var(--surface-2)", fontSize: 13 }}>
          <Icon name="check" size={15} style={{ color: "var(--green)", verticalAlign: "middle", marginRight: 6 }} />
          <b>{result.affected}</b> row(s) affected
        </div>
      )}
      {result && result.kind === "select" && (
        <div className="card" style={{ boxShadow: "none", overflow: "hidden" }}>
          <div style={{ padding: "7px 12px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
            <b>Result</b><span style={{ marginLeft: "auto", color: "var(--ink-3)", float: "right" }}>{result.rowCount} rows · {result.columns.length} cols</span>
          </div>
          <div style={{ overflow: "auto", maxHeight: 360 }}>
            <table className="tbl">
              <thead><tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i} style={{ cursor: "default" }}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "num mono" : ""} style={{ fontSize: 12 }}>{v === null ? <span style={{ color: "var(--ink-4)" }}>NULL</span> : String(v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
