"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import {
  Button, ButtonSet, IconButton, InlineNotification, Layer, Stack, StructuredListBody, StructuredListCell,
  StructuredListRow, StructuredListWrapper, Tag, TextInput, PasswordInput, Tile,
} from "@carbon/react";
import { Add, Checkmark, DataTable as DataTableIcon, Flash, Star, TrashCan } from "@carbon/icons-react";
import { AccessButton } from "@/components/AccessPanel";
import { MiniStat, StatusChip, TableSkeleton } from "@/components/ui";
import { DataList } from "@/components/DataList";
import { SlideOver, Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import type { Datasource, ReportSummary } from "@/lib/types";

/** Engine options offered in the form — shortcuts only, not a registry. The current value of
    the connection is always added so the Engine field never shows empty for unknown values. */
const KNOWN_ENGINES = ["PostgreSQL", "PostgreSQL 16", "PostgreSQL 15", "Oracle 19c", "MS SQL 2022", "MongoDB 7", "REST / SOAP"];
function engineOptions(current?: string) {
  const list = current && !KNOWN_ENGINES.includes(current) ? [current, ...KNOWN_ENGINES] : KNOWN_ENGINES;
  return list.map((x) => ({ value: x, label: x }));
}

function formOf(ds: Datasource) {
  return {
    name: ds.name, engine: ds.engine, host: ds.host ?? "", schemaName: ds.schemaName ?? "",
    jdbcUrl: "", dbUser: "", dbPassword: "",
  };
}

/** Never tested (no latency measured / no known status) reads as Unknown, not Down. */
function health(ds: Datasource): { key: string; label: string } {
  // Nothing to connect to: no JDBC URL on a database connection that is not the app's default warehouse
  if (ds.status === "not_configured" || (!ds.hasJdbc && !ds.isDefault && !/rest|soap/i.test(ds.engine ?? ""))) return { key: "not_configured", label: "Not configured" };
  if (ds.latencyMs == null || !["healthy", "degraded", "down"].includes(ds.status)) return { key: "unknown", label: "Unknown" };
  if (ds.status === "healthy") return { key: "healthy", label: "Healthy" };
  if (ds.status === "degraded") return { key: "degraded", label: "Degraded" };
  return { key: "down", label: "Down" };
}
/** Health as a Carbon status Tag (StatusChip maps healthy/degraded/down/unknown to green/warm-gray/red/gray). */
const HealthTag = ({ ds }: { ds: Datasource }) => (health(ds).key === "not_configured"
  ? <Tag size="sm" type="gray">Not configured</Tag>
  : <StatusChip s={health(ds).key} size="sm" />);

/** Integrations → Databases: the database connections (formerly the Connections screen), unchanged in behaviour. */
export default function DatabasesPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const [rows, setRows] = useState<Datasource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<Datasource | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  /** Card whose delete was clicked once and awaits a second click to confirm */
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const toast = useToast();

  const reload = () => api.datasources().then((r) => { setRows(r); setLoaded(true); }).catch((e) => setErr((e as Error).message));
  /** After add / delete: the list and the Integrations tab count both change. */
  const reloadAll = () => { reload(); onChanged?.(); };
  useEffect(() => { reload(); }, []);

  // Real probe: backend measures the connection and persists status + latency.
  async function test(ds: Datasource) {
    setTesting(ds.id);
    try {
      const res = await api.testDatasource(ds.id);
      if (res.ok) toast(`${ds.name}: ${res.message}`, "ok");
      else toast(`${ds.name}: ${res.message}`, "error");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Test failed", "error");
    } finally {
      setTesting(null);
    }
  }

  // Mark one connection as the default; backend returns the refreshed list (single default).
  async function setDefault(ds: Datasource) {
    try {
      const updated = await api.setDefaultDatasource(ds.id);
      setRows(updated);
      setSel((s) => (s ? updated.find((d) => d.id === s.id) ?? null : null));
      toast(`${ds.name} is now the default`, "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not set default", "error");
    }
  }

  // Delete a connection (backend refuses while reports still use it).
  // Confirmed in-page (two clicks) rather than window.confirm(), which browsers may suppress.
  async function remove(ds: Datasource) {
    try {
      await api.deleteDatasource(ds.id);
      toast(`Deleted ${ds.name}`);
      setSel(null);
      setRows((cur) => cur.filter((d) => d.id !== ds.id));
      reloadAll();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  if (err) {
    return <InlineNotification kind="error" title="Cannot reach the backend" subtitle={err} hideCloseButton lowContrast />;
  }

  if (!loaded) return <TableSkeleton columns={6} />;
  const healthy = rows.filter((d) => health(d).key === "healthy").length;
  const degraded = rows.filter((d) => health(d).key === "degraded").length;
  const avgLat = rows.length ? Math.round(rows.reduce((s, d) => s + (d.latencyMs ?? 0), 0) / rows.length) : 0;

  return (
    <div>
      <DataList
        title="Databases"
        description={`${rows.length} connection${rows.length === 1 ? "" : "s"} · ${healthy} healthy${degraded ? ` · ${degraded} degraded` : ""} · avg latency ${avgLat} ms`}
        rows={rows}
        onRowClick={setSel}
        empty="No connections yet"
        toolbar={<Button renderIcon={Add} onClick={() => setShowAdd(true)}>Add connection</Button>}
        columns={[
          { key: "name", header: "Name", render: (ds) => (
            <div>
              <span style={{ whiteSpace: "nowrap" }}>{ds.name}</span>
              {ds.isDefault && <Tag size="sm" type="blue" style={{ marginLeft: 8 }}>Default</Tag>}
              <div className="cds--type-code-01 rh-dim">{ds.id}</div>
            </div>
          ) },
          { key: "status", header: "Status", sortValue: (ds) => health(ds).label, render: (ds) => <HealthTag ds={ds} /> },
          { key: "engine", header: "Engine" },
          { key: "host", header: "Host", render: (ds) => <span className="cds--type-code-01 rh-dim rh-ellipsis" style={{ display: "block", maxWidth: 200 }} title={ds.host ?? undefined}>{ds.host ?? "—"}</span> },
          { key: "reportCount", header: "Reports", align: "end", render: (ds) => ds.reportCount ?? "—" },
          { key: "latencyMs", header: "Latency", align: "end", render: (ds) => <span className="cds--type-code-01">{health(ds).key === "unknown" || health(ds).key === "not_configured" || ds.latencyMs == null ? "—" : `${ds.latencyMs} ms`}</span> },
        ]}
        rowActions={(ds) => (
          <>
            <IconButton kind="ghost" size="sm" label="Test connection" align="left" disabled={testing === ds.id} onClick={() => test(ds)}><Flash /></IconButton>
            {confirmDel === ds.id ? (
              <Button kind="danger--ghost" size="sm" onClick={() => remove(ds).finally(() => setConfirmDel(null))}>Delete?</Button>
            ) : (
              <IconButton kind="ghost" size="sm" align="left" disabled={ds.inUse}
                          label={ds.inUse ? "Still used by reports, datasets or schedulers" : "Delete"}
                          onClick={() => setConfirmDel(ds.id)}><TrashCan /></IconButton>
            )}
          </>
        )}
      />

      {sel && <DsDetail ds={sel} onClose={() => setSel(null)} onTest={test} testing={testing === sel.id} onSetDefault={setDefault} onDelete={remove}
        onSaved={(updated) => { setSel(updated); reload(); }} />}
      {showAdd && <AddConnection onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reloadAll(); }} />}
    </div>
  );
}

function AddConnection({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ id: "", name: "", engine: "PostgreSQL 16", host: "", schemaName: "", jdbcUrl: "", dbUser: "", dbPassword: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.id || !f.name) { toast("id and name are required", "error"); return; }
    setBusy(true);
    try {
      await api.createDatasource(f);
      toast(`Added ${f.name}`, "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title="Add connection" width={480} onClose={onClose}
      foot={<><Button kind="secondary" onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy} onClick={save}>Add</Button></>}>
      <div className="rh-form-grid">
        <TextInput id="ds-add-id" labelText="ID" className="rh-mono" value={f.id} onChange={(e) => set("id", e.target.value)} placeholder="ds-newdb" />
        <Select label="Engine" value={f.engine} onChange={(v) => set("engine", v)} options={engineOptions()} />
        <div className="rh-span-2"><TextInput id="ds-add-name" labelText="Name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="New Warehouse" /></div>
        <TextInput id="ds-add-host" labelText="Host" className="rh-mono" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="db.example.com:5432" />
        <TextInput id="ds-add-schema" labelText="Schema" className="rh-mono" value={f.schemaName} onChange={(e) => set("schemaName", e.target.value)} />
        <div className="rh-span-2"><TextInput id="ds-add-jdbc" labelText="JDBC URL" className="rh-mono" value={f.jdbcUrl} onChange={(e) => set("jdbcUrl", e.target.value)}
                   placeholder="jdbc:postgresql://db.example.com:5432/warehouse" /></div>
        {/* Credentials of the target database, not the web login — keep the browser's saved logins out */}
        <input type="text" name="rs-af-user" autoComplete="username" tabIndex={-1} aria-hidden
               style={{ position: "absolute", opacity: 0, height: 0, width: 0, pointerEvents: "none" }} />
        <input type="password" name="rs-af-pass" autoComplete="current-password" tabIndex={-1} aria-hidden
               style={{ position: "absolute", opacity: 0, height: 0, width: 0, pointerEvents: "none" }} />
        <TextInput id="ds-add-account" labelText="DB user" name="ds-add-account" className="rh-mono" autoComplete="off" spellCheck={false}
                   value={f.dbUser} onChange={(e) => set("dbUser", e.target.value)} />
        <PasswordInput id="ds-add-secret" labelText="DB password" name="ds-add-secret" className="rh-mono" autoComplete="new-password"
                       value={f.dbPassword} onChange={(e) => set("dbPassword", e.target.value)} />
      </div>
    </Modal>
  );
}

function DsDetail({ ds, onClose, onTest, testing, onSetDefault, onDelete, onSaved }: { ds: Datasource; onClose: () => void; onTest: (d: Datasource) => void; testing: boolean; onSetDefault: (d: Datasource) => void; onDelete: (d: Datasource) => void; onSaved: (d: Datasource) => void }) {
  const toast = useToast();
  const [reps, setReps] = useState<ReportSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [f, setF] = useState(() => formOf(ds));
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  // Switching connection resets the form so typed values do not carry over
  useEffect(() => { setF(formOf(ds)); setConfirmDel(false); }, [ds]);

  useEffect(() => {
    api.reports({ datasource: ds.id, size: 200 }).then((p) => setReps(p.items)).catch(() => {});
  }, [ds.id]);

  const dirty = f.name !== ds.name || f.engine !== ds.engine || f.host !== (ds.host ?? "")
    || f.schemaName !== (ds.schemaName ?? "")
    || !!f.jdbcUrl || !!f.dbUser || !!f.dbPassword;

  async function save() {
    if (!f.name || !f.engine) { toast("Name and engine are required", "error"); return; }
    setBusy(true);
    try {
      const updated = await api.updateDatasource(ds.id, f);
      toast(`Saved ${f.name}`, "ok");
      onSaved(updated);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SlideOver
      title={ds.name}
      sub={`${ds.id} · ${ds.engine}`}
      badge={<HealthTag ds={ds} />}
      onClose={onClose}
      foot={confirmDel ? (
        /* Confirm delete in the panel footer — no nested dialog, no browser confirm() */
        <ButtonSet className="rh-foot-set">
          <Button kind="secondary" disabled={busy} onClick={() => setConfirmDel(false)}>Cancel</Button>
          <Button kind="danger" disabled={busy}
            onClick={async () => { setBusy(true); try { await onDelete(ds); } finally { setBusy(false); } }}>
            Delete {ds.name}
          </Button>
        </ButtonSet>
      ) : (
        /* Footer holds only actions on the item being edited: test connection and save. */
        <ButtonSet className="rh-foot-set">
          <Button kind="secondary" renderIcon={Flash} disabled={testing} onClick={() => onTest(ds)}>
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button kind="primary" renderIcon={Checkmark} disabled={!dirty || busy} onClick={save}>Save</Button>
        </ButtonSet>
      )}
    >
      <Stack gap={6}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 0, margin: "-8px 0 0 -16px" }}>
          <AccessButton type="DATASOURCE" id={ds.id} name={ds.name} ghost />
          <Button kind="ghost" renderIcon={Star} disabled={ds.isDefault} onClick={() => onSetDefault(ds)}>
            {ds.isDefault ? "Default connection" : "Set as default"}
          </Button>
          <Button kind="ghost" renderIcon={DataTableIcon} as={Link} href={`/datasets?datasource=${encodeURIComponent(ds.id)}`}>New dataset</Button>
          {!confirmDel && <Button kind="danger--ghost" renderIcon={TrashCan} disabled={ds.inUse} onClick={() => setConfirmDel(true)}>Delete</Button>}
        </div>
        <div className="rh-ministats">
          <MiniStat label="Latency" value={<span className="cds--type-code-02">{health(ds).key === "not_configured" || ds.latencyMs == null ? "—" : `${ds.latencyMs} ms`}</span>} />
          <MiniStat label="Pool usage" value={<span className="cds--type-code-02">{ds.pool ?? "—"}</span>} />
          <MiniStat label="Reports served" value={reps.length} />
          <MiniStat label="Default" value={ds.isDefault ? "Yes" : "No"} />
        </div>

        {/* Edited inline in this panel, no separate modal */}
        <h3 className="cds--type-heading-compact-01" style={{ margin: 0 }}>Connection</h3>
        <Layer>
          <div className="rh-form-grid">
            <div className="rh-span-2"><TextInput id="ds-name" labelText="Name" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
            <Select label="Engine" value={f.engine} onChange={(v) => set("engine", v)} options={engineOptions(ds.engine)} />
            <TextInput id="ds-host" labelText="Host" className="rh-mono" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="db.example.com:1521" />
            <TextInput id="ds-schema" labelText="Schema" className="rh-mono" value={f.schemaName} onChange={(e) => set("schemaName", e.target.value)} />
            <div className="rh-span-2"><TextInput id="ds-jdbc" labelText="JDBC URL" className="rh-mono" value={f.jdbcUrl} onChange={(e) => set("jdbcUrl", e.target.value)}
                       placeholder={ds.hasJdbc ? "configured — leave blank to keep" : "jdbc:oracle:thin:@host:1521/service"} /></div>
            {/* Credentials of the target database, not the web login: autofill off plus hidden decoy fields
                so the browser cannot fill saved web credentials here and overwrite the DB password on Save. */}
            <input type="text" name="rs-af-user" autoComplete="username" tabIndex={-1} aria-hidden
                   style={{ position: "absolute", opacity: 0, height: 0, width: 0, pointerEvents: "none" }} />
            <input type="password" name="rs-af-pass" autoComplete="current-password" tabIndex={-1} aria-hidden
                   style={{ position: "absolute", opacity: 0, height: 0, width: 0, pointerEvents: "none" }} />
            <TextInput id="ds-db-account" labelText="DB user" name="ds-db-account" className="rh-mono" autoComplete="off" spellCheck={false}
                       value={f.dbUser} onChange={(e) => set("dbUser", e.target.value)} placeholder="leave blank to keep" />
            <PasswordInput id="ds-db-secret" labelText="DB password" name="ds-db-secret" className="rh-mono" autoComplete="new-password"
                           value={f.dbPassword} onChange={(e) => set("dbPassword", e.target.value)} placeholder="leave blank to keep" />
          </div>
        </Layer>

        <StructuredListWrapper isCondensed aria-label="Reports using this datasource" className="rh-slist">
          <StructuredListBody>
            <StructuredListRow head>
              <StructuredListCell head>Reports using this datasource ({reps.length})</StructuredListCell>
              <StructuredListCell head>Status</StructuredListCell>
            </StructuredListRow>
            {reps.map((r) => (
              <StructuredListRow key={r.id}>
                <StructuredListCell>
                  <div className="rh-ellipsis">{r.name}</div>
                  <div className="cds--type-code-01 rh-dim">{r.code}</div>
                </StructuredListCell>
                <StructuredListCell><StatusChip s={r.status} size="sm" /></StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
        {reps.length === 0 && <Tile className="rh-dim">No reports yet.</Tile>}
      </Stack>
    </SlideOver>
  );
}
