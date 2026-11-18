"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button, ButtonSet, InlineNotification, PasswordInput, Stack, StructuredListBody, StructuredListCell,
  StructuredListRow, StructuredListWrapper, Tab, TabListVertical, Tabs, Tag, TextInput, Toggle,
} from "@carbon/react";
import { Add, Checkmark, Download, Flash, TrashCan } from "@carbon/icons-react";
import { carbonIcon, type IconName } from "@/components/Icon";
import { SlideOver } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import { DataList } from "@/components/DataList";
import { PageHeader, TableSkeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { usePerms } from "@/lib/perms";
import type { IntegrationCategory, IntegrationItem, IntegrationTest } from "@/lib/types";
import DatabasesPanel from "@/components/integrations/DatabasesPanel";
import EnginesPanel from "@/components/integrations/EnginesPanel";

const MASK = "••• set";

/** Category list. obj = object code(s) that open the category (RH.DATASOURCE / RH.ENGINE kept for older grants). */
const CATS: { key: string; label: string; icon: IconName; objs: string[] }[] = [
  { key: "databases", label: "Databases", icon: "datasource", objs: ["RH.INTEGRATION", "RH.DATASOURCE"] },
  { key: "identity", label: "Identity", icon: "lock", objs: ["RH.INTEGRATION"] },
  { key: "storage", label: "File storage", icon: "store", objs: ["RH.INTEGRATION"] },
  { key: "engines", label: "Report engines", icon: "engine", objs: ["RH.INTEGRATION", "RH.ENGINE"] },
  { key: "exporter", label: "Document exporter", icon: "doc", objs: ["RH.INTEGRATION"] },
  { key: "notifications", label: "Notifications", icon: "bell", objs: ["RH.INTEGRATION"] },
];

type TagType = "green" | "red" | "warm-gray" | "gray";
const TONE: Record<string, TagType> = { healthy: "green", down: "red", degraded: "warm-gray" };
const statusLabel = (s?: string) => (s === "healthy" ? "Healthy" : s === "down" ? "Down" : s === "degraded" ? "Degraded" : "Not checked");
const HealthTag = ({ s }: { s?: string }) => <Tag size="sm" type={TONE[s ?? ""] ?? "gray"}>{statusLabel(s)}</Tag>;

export default function IntegrationsPage() {
  return <Suspense fallback={null}><Integrations /></Suspense>;
}

function Integrations() {
  const perms = usePerms();
  const router = useRouter();
  const sp = useSearchParams();
  const visible = CATS.filter((c) => c.objs.some((o) => perms.can(o)));
  const cat = visible.find((c) => c.key === sp.get("category"))?.key ?? visible[0]?.key ?? "databases";
  const [cats, setCats] = useState<IntegrationCategory[] | null>(null);
  const reload = useCallback(() => {
    if (!perms.can("RH.INTEGRATION")) { setCats([]); return; }
    api.integrations().then((r) => setCats(r.categories)).catch(() => setCats([]));
  }, [perms]);
  useEffect(() => { reload(); }, [reload]);
  const [engineCount, setEngineCount] = useState<number | undefined>();
  useEffect(() => {
    if (perms.can("RH.ENGINE") || perms.can("RH.INTEGRATION")) api.engines().then((d) => setEngineCount(d.installed.length)).catch(() => {});
  }, [perms]);

  if (!perms.me) return null; // permissions not loaded yet: render nothing rather than an empty list
  const count = (key: string) => (key === "engines" ? engineCount : cats?.find((c) => c.key === key)?.items.length);
  const idx = Math.max(0, visible.findIndex((c) => c.key === cat));

  return (
    <div>
      <PageHeader title="Integrations" />
      <div className="rh-split">
        <Tabs selectedIndex={idx} onChange={({ selectedIndex }) => {
          const c = visible[selectedIndex];
          if (c && c.key !== cat) router.replace(`/integrations?category=${c.key}`);
        }}>
          <TabListVertical aria-label="Integration categories">
            {visible.map((c) => {
              const n = count(c.key);
              return (
                <Tab key={c.key} renderIcon={carbonIcon(c.icon)}>
                  {c.label}{n != null ? ` (${n})` : ""}
                </Tab>
              );
            })}
          </TabListVertical>
        </Tabs>
        <div style={{ minWidth: 0 }}>
          {cat === "databases" && <DatabasesPanel onChanged={reload} />}
          {cat === "engines" && <EnginesPanel onChanged={setEngineCount} />}
          {cat === "identity" && <ItemsPanel title="Identity" items={items(cats, "identity")} onChanged={reload} />}
          {cat === "storage" && <ItemsPanel title="File storage" items={items(cats, "storage")} onChanged={reload} canAddFileHub />}
          {cat === "exporter" && <ItemsPanel title="Document exporter" items={items(cats, "exporter")} onChanged={reload} />}
          {cat === "notifications" && <ItemsPanel title="Notifications" items={items(cats, "notifications")} onChanged={reload} />}
        </div>
      </div>
    </div>
  );
}

function items(cats: IntegrationCategory[] | null, key: string) {
  return cats?.find((c) => c.key === key)?.items ?? null;
}

const TYPE_LABEL: Record<string, string> = {
  iam: "IAM", filehub: "FileHub", "object-store": "Object store (S3)", exporter: "PDF exporter", notify: "Notification service",
};

function ItemsPanel({ title, items, onChanged, canAddFileHub }: { title: string; items: IntegrationItem[] | null; onChanged: () => void; canAddFileHub?: boolean }) {
  const perms = usePerms();
  const isAdmin = !!perms.me?.admin || perms.me?.role === "ADMIN";
  const [sel, setSel] = useState<IntegrationItem | "new-filehub" | null>(null);
  const [checks, setChecks] = useState<Record<string, IntegrationTest>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const toast = useToast();

  async function check(it: IntegrationItem) {
    setChecking(it.id);
    try {
      const r = await api.testIntegration(it.id);
      setChecks((c) => ({ ...c, [it.id]: r }));
      toast(`${it.name}: ${r.message}`, r.ok ? "ok" : "error");
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "Check failed", "error"); }
    finally { setChecking(null); }
  }

  if (!items) return <TableSkeleton rows={3} columns={3} />;
  const st = (it: IntegrationItem) => (checks[it.id] ? (checks[it.id].ok ? "healthy" : "down") : it.status);
  return (
    <>
      <DataList<IntegrationItem>
        title={title}
        rows={items}
        search={items.length > 8}
        pagination={false}
        empty="Nothing configured"
        onRowClick={(it) => setSel(it)}
        toolbar={canAddFileHub && isAdmin ? <Button renderIcon={Add} onClick={() => setSel("new-filehub")}>Add FileHub</Button> : undefined}
        columns={[
          {
            key: "name", header: "Name",
            render: (it) => (
              <div style={{ minWidth: 0 }}>
                <div className="rh-inline">{it.name}{!it.enabled && <Tag size="sm" type="gray">Disabled</Tag>}</div>
                <div className="rh-cell-sub">
                  {TYPE_LABEL[it.type] ?? it.type} · <span className="cds--type-code-01">{summary(it) || "not configured"}</span>
                  {it.type === "iam" && it.authMode && <> · sign-in {it.authMode}</>}
                </div>
              </div>
            ),
          },
          { key: "status", header: "Status", width: 140, sortValue: (it) => statusLabel(st(it)), render: (it) => <HealthTag s={st(it)} /> },
        ]}
        rowActions={isAdmin ? (it) => (
          <Button kind="ghost" size="sm" renderIcon={Flash} disabled={checking === it.id} onClick={() => check(it)}>Check</Button>
        ) : undefined}
      />
      {sel && <Detail item={sel === "new-filehub" ? null : sel} isAdmin={isAdmin} onClose={() => setSel(null)}
        onSaved={() => { setSel(null); onChanged(); }} />}
    </>
  );
}

function summary(it: IntegrationItem): string {
  const c = it.config ?? {};
  const eff = it.effective ?? {};
  switch (it.type) {
    case "iam": case "notify": return String(eff.baseUrl ?? "");
    case "filehub": return [c.baseUrl, c.systemId].filter(Boolean).join(" · ");
    case "object-store": return `${c.endpoint ?? ""} · ${c.bucket ?? ""}`;
    case "exporter": return String(c.url ?? "");
    default: return "";
  }
}

type Field = { key: string; label: string; mono?: boolean; secret?: boolean; bool?: boolean; options?: string[]; full?: boolean; title?: string };

const FIELDS: Record<string, Field[]> = {
  iam: [
    { key: "baseUrl", label: "Base URL", mono: true, full: true, title: "Default from IAM_BASE_URL" },
    { key: "cacheTtlSeconds", label: "Permission cache (s)", mono: true, title: "Default from IAM_CACHE_TTL_SECONDS" },
    { key: "timeoutMs", label: "Timeout (ms)", mono: true, title: "Default from IAM_TIMEOUT_MS" },
    { key: "autoProvisionTenant", label: "Auto-provision tenant", bool: true, title: "Default from IAM_AUTO_PROVISION_TENANT" },
    { key: "adminRoles", label: "Admin roles", mono: true, title: "Comma-separated IAM role codes; default from IAM_ADMIN_ROLES" },
    { key: "adminUsers", label: "Admin users", mono: true, full: true, title: "Comma-separated usernames; default from IAM_ADMIN_USERS" },
  ],
  notify: [{ key: "baseUrl", label: "Base URL", mono: true, full: true, title: "Default from APP_NOTIFY_BASE_URL" }],
  filehub: [
    { key: "baseUrl", label: "Base URL", mono: true, full: true, title: "FileHub API root that contains /api, e.g. https://host/fh" },
    { key: "apiKey", label: "API key", mono: true, secret: true, full: true },
    { key: "systemId", label: "Target system", mono: true },
    { key: "orgId", label: "Organization", mono: true },
    { key: "folderPath", label: "Folder path", mono: true, title: "Placeholders {code} {yyyy} {mm} {dd}" },
    { key: "status", label: "File status", options: ["", "Draft", "Review", "Approved", "Archived"] },
    { key: "owner", label: "Owner", },
    { key: "timeoutMs", label: "Timeout (ms)", mono: true },
    { key: "linkTemplate", label: "Link template", mono: true, full: true, title: "Link stored on published files; {id} = FileHub file id. Blank = API download link" },
  ],
  "object-store": [
    { key: "endpoint", label: "Endpoint", mono: true, full: true, title: "MINIO_ENDPOINT" },
    { key: "bucket", label: "Bucket", mono: true, title: "MINIO_BUCKET" },
  ],
  exporter: [{ key: "url", label: "URL", mono: true, full: true, title: "DOC_EXPORTER_URL" }],
};

function Detail({ item, isAdmin, onClose, onSaved }: { item: IntegrationItem | null; isAdmin: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const type = item?.type ?? "filehub";
  const fields = FIELDS[type] ?? [];
  const readOnly = !isAdmin || (item != null && !item.editable);
  const initial = () => {
    const v: Record<string, string> = {};
    for (const f of fields) {
      const raw = item?.config?.[f.key];
      v[f.key] = raw == null ? "" : String(raw);
    }
    return v;
  };
  const [f, setF] = useState<Record<string, string>>(initial);
  const [name, setName] = useState(item?.name ?? "FileHub");
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<IntegrationTest | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [secretFocus, setSecretFocus] = useState<string | null>(null);
  const set = (k: string, v: string) => { setF((s) => ({ ...s, [k]: v })); setTest(null); setTried(false); };
  const def = (k: string) => {
    const d = item?.defaults?.[k];
    return d == null || d === "" ? undefined : String(d);
  };
  /** New FileHub: shown once Save/Test was attempted with missing or malformed values. */
  const [tried, setTried] = useState(false);
  const [tested, setTested] = useState(false);
  const isNew = !item && type === "filehub";
  const fieldErr = (k: string): string | undefined => {
    if (type !== "filehub" || readOnly) return undefined;
    const v = (f[k] ?? "").trim();
    if (k === "baseUrl") {
      if (!v) return item && def(k) ? undefined : "Base URL is required";
      if (!/^https?:\/\/\S+$/i.test(v)) return "Must start with http:// or https://";
    }
    if (k === "apiKey") {
      if (v === MASK) return undefined;
      if (!v) return "API key is required";
      if (!v.startsWith("fhk_")) return "API key must start with fhk_";
    }
    return undefined;
  };
  const invalid = type === "filehub" && !readOnly && (!!fieldErr("baseUrl") || !!fieldErr("apiKey"));

  function config() {
    const out: Record<string, unknown> = {};
    for (const fl of fields) out[fl.key] = fl.bool ? (f[fl.key] === "" ? "" : f[fl.key] === "true") : f[fl.key];
    return out;
  }

  async function save() {
    if (invalid) { setTried(true); return; }
    if (isNew && !tested) { setTried(true); toast("Test the connection before saving", "error"); return; }
    setBusy(true);
    try {
      if (item) await api.saveIntegration(item.id, { name, enabled, config: config() });
      else await api.createIntegration({ type: "filehub", name, enabled, config: config() });
      toast(`Saved ${name}`, "ok");
      onSaved();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed", "error"); }
    finally { setBusy(false); }
  }

  async function probe() {
    if (invalid) { setTried(true); return; }
    setBusy(true);
    try {
      const r = await api.testIntegration(item ? item.id : "_new-filehub", readOnly ? undefined : config());
      setTest(r);
      if (r.ok) setTested(true);
    }
    catch (e) { setTest({ ok: false, status: 0, message: e instanceof Error ? e.message : "failed" }); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!item) return;
    setBusy(true);
    try { await api.deleteIntegration(item.id); toast(`Deleted ${item.name}`, "ok"); onSaved(); }
    catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); setBusy(false); }
  }

  const canDelete = item?.type === "filehub" && isAdmin;

  const foot = confirmDel ? (
    <ButtonSet className="rh-foot-set">
      <Button kind="secondary" disabled={busy} onClick={() => setConfirmDel(false)}>Cancel</Button>
      <Button kind="danger" disabled={busy} onClick={remove}>Delete {item?.name}</Button>
    </ButtonSet>
  ) : (canDelete || item && isAdmin || !readOnly) ? (
    <ButtonSet className="rh-foot-set">
      {canDelete && <Button kind="danger--ghost" renderIcon={TrashCan} disabled={busy} onClick={() => setConfirmDel(true)}>Delete</Button>}
      {(item || isNew) && isAdmin && <Button kind="secondary" renderIcon={Flash} disabled={busy} onClick={probe}>Test connection</Button>}
      {!readOnly && <Button kind="primary" renderIcon={Checkmark} disabled={busy || (isNew && !tested)}
        title={isNew && !tested ? "Test the connection first" : undefined} onClick={save}>Save</Button>}
    </ButtonSet>
  ) : undefined;

  return (
    <SlideOver title={item ? item.name : "New FileHub connector"} sub={item ? `${item.id} · ${TYPE_LABEL[type] ?? type}` : "FileHub"}
      badge={item ? <HealthTag s={item.status} /> : undefined}
      onClose={onClose} foot={foot}>
      <Stack gap={6}>
        {item?.type === "iam" && (
          <StructuredListWrapper isCondensed className="rh-slist" aria-label="IAM">
            <StructuredListBody>
              <StructuredListRow>
                <StructuredListCell noWrap title="APP_AUTH_MODE">Sign-in mode</StructuredListCell>
                <StructuredListCell className="cds--type-code-01">{item.authMode}</StructuredListCell>
              </StructuredListRow>
            </StructuredListBody>
          </StructuredListWrapper>
        )}
        {type === "filehub" && (
          <div className="rh-form-grid">
            <TextInput id="integ-name" labelText="Name" value={name} readOnly={readOnly} onChange={(e) => setName(e.target.value)} />
            <Toggle id="integ-enabled" labelText="Enabled" labelA="Disabled" labelB="Enabled" toggled={enabled}
                    disabled={readOnly} onToggle={(v) => setEnabled(v)} />
          </div>
        )}
        <div className="rh-form-grid">
          {fields.map((fl) => {
            const wrap = (el: React.ReactNode) => <div key={fl.key} className={fl.full ? "rh-span-2" : undefined} title={fl.title}>{el}</div>;
            if (fl.bool) {
              return wrap(
                <Select label={fl.label} value={f[fl.key]} disabled={readOnly} onChange={(v) => set(fl.key, v)}
                  options={[{ value: "", label: `Default${def(fl.key) ? ` (${def(fl.key) === "true" ? "yes" : "no"})` : ""}` }, { value: "true", label: "Yes" }, { value: "false", label: "No" }]} />,
              );
            }
            if (fl.options) {
              return wrap(
                <Select label={fl.label} value={f[fl.key]} disabled={readOnly} onChange={(v) => set(fl.key, v)}
                  options={fl.options.map((o) => ({ value: o, label: o || "FileHub default" }))} />,
              );
            }
            if (fl.secret) {
              const masked = f[fl.key] === MASK;
              return wrap(
                <PasswordInput id={`integ-${fl.key}`} labelText={fl.label} className="rh-mono" value={f[fl.key]} readOnly={readOnly}
                  autoComplete="new-password" spellCheck={false}
                  placeholder={secretFocus === fl.key ? `${MASK} — type to replace` : masked ? "" : "fhk_…"}
                  invalid={tried && !!fieldErr(fl.key)} invalidText={fieldErr(fl.key)}
                  onFocus={() => { if (masked) { set(fl.key, ""); setSecretFocus(fl.key); } }}
                  onChange={(e) => set(fl.key, e.target.value)} />,
              );
            }
            return wrap(
              <TextInput id={`integ-${fl.key}`} labelText={fl.label} className={fl.mono ? "rh-mono" : undefined} value={f[fl.key]}
                readOnly={readOnly} autoComplete="off" spellCheck={false} placeholder={def(fl.key) ?? ""}
                invalid={tried && !!fieldErr(fl.key)} invalidText={fieldErr(fl.key)}
                onChange={(e) => set(fl.key, e.target.value)} />,
            );
          })}
        </div>
        {test && (
          <InlineNotification lowContrast hideCloseButton kind={test.ok ? "success" : "error"}
            title={`${test.ok ? "OK" : "Failed"} · HTTP ${test.status || "—"}${test.ms != null ? ` · ${test.ms} ms` : ""}`}
            subtitle={test.message} />
        )}
        {item?.lastCheckedAt && !test && (
          <p className="cds--type-label-01 rh-dim">
            Last check {new Date(item.lastCheckedAt).toLocaleString()}{item.lastError ? <span className="cds--type-code-01"> · {item.lastError}</span> : null}
          </p>
        )}
        {item?.type === "iam" && <IamObjectExport />}
      </Stack>
    </SlideOver>
  );
}

/** Object codes for import into the IAM service (moved from Settings → IAM). */
function IamObjectExport() {
  const toast = useToast();
  const [appCode, setAppCode] = useState("RH");
  return (
    <div>
      <h3 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-05)" }}>Object codes for IAM</h3>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) max-content", gap: "var(--cds-spacing-03)", alignItems: "end" }}>
        <TextInput id="iam-appcode" labelText="Application code" className="rh-mono" value={appCode} onChange={(e) => setAppCode(e.target.value.toUpperCase())} />
        <Button kind="tertiary" renderIcon={Download} disabled={!appCode.trim()}
          onClick={() => api.exportIamObjects(appCode.trim()).catch((e) => toast(e instanceof Error ? e.message : "Export failed", "error"))}>
          Export JSON
        </Button>
      </div>
    </div>
  );
}
