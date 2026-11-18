"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, IconButton, InlineNotification, Stack, Tag, TextInput, Toggle } from "@carbon/react";
import { Add, Checkmark, Edit } from "@carbon/icons-react";
import { DataList } from "./DataList";
import { Modal } from "./overlays";
import { useToast } from "./Toast";
import { api } from "@/lib/api";
import type { ProjectRow, TenantRow } from "@/lib/types";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Settings → Tenants & projects. */
export function TenantsSection() {
  const toast = useToast();
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [tenant, setTenant] = useState<string>("");
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [editTenant, setEditTenant] = useState<TenantRow | "new" | null>(null);
  const [editProject, setEditProject] = useState<ProjectRow | "new" | null>(null);

  const loadTenants = useCallback(() => {
    api.tenants().then((ts) => {
      setTenants(ts);
      setTenant((cur) => cur || ts[0]?.id || "");
    }).catch((e) => { setTenants((t) => t ?? []); toast(e instanceof Error ? e.message : "Load failed", "error"); });
  }, [toast]);

  const loadProjects = useCallback(() => {
    if (!tenant) return;
    setProjectsError(null);
    api.projects(tenant).then(setProjects).catch((e) => {
      setProjects([]);
      setProjectsError(e instanceof Error ? e.message : "Could not load projects");
    });
  }, [tenant]);

  useEffect(loadTenants, [loadTenants]);
  useEffect(loadProjects, [loadProjects]);

  const status = (active: boolean) => <Tag size="sm" type={active ? "green" : "gray"}>{active ? "Active" : "Inactive"}</Tag>;

  return (
    <div className="rh-stack-gap">
      <DataList<TenantRow>
        title="Tenants"
        rows={tenants ?? []}
        loading={tenants === null}
        search={(tenants?.length ?? 0) > 8}
        pagination={false}
        onRowClick={(t) => setTenant(t.id)}
        toolbar={<Button kind="tertiary" renderIcon={Add} onClick={() => setEditTenant("new")}>New tenant</Button>}
        columns={[
          {
            key: "name", header: "Name",
            render: (t) => <span className="rh-inline">{t.name}{t.id === tenant && <Tag size="sm" type="blue">Selected</Tag>}</span>,
          },
          { key: "id", header: "Tenant id", render: (t) => <span className="cds--type-code-01">{t.id}</span> },
          { key: "iamTenantId", header: "IAM tenant", render: (t) => <span className="cds--type-code-01">{t.iamTenantId || "—"}</span> },
          { key: "active", header: "Status", width: 120, sortValue: (t) => (t.active ? 1 : 0), render: (t) => status(t.active) },
        ]}
        rowActions={(t) => <IconButton kind="ghost" size="sm" label="Edit" align="left" onClick={() => setEditTenant(t)}><Edit /></IconButton>}
      />

      {tenant && projectsError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Projects could not be loaded" subtitle={projectsError} />
      )}
      {tenant && (
        <DataList<ProjectRow>
          title={`Projects · ${tenants?.find((t) => t.id === tenant)?.name ?? tenant}`}
          rows={projects ?? []}
          loading={projects === null}
          search={(projects?.length ?? 0) > 8}
          pagination={false}
          empty={projectsError ? "Projects could not be loaded" : "No projects yet"}
          toolbar={<Button kind="tertiary" renderIcon={Add} onClick={() => setEditProject("new")}>New project</Button>}
          columns={[
            { key: "name", header: "Name" },
            { key: "id", header: "Project id", render: (p) => <span className="cds--type-code-01">{p.id}</span> },
            { key: "iamAppCode", header: "IAM application", render: (p) => <span className="cds--type-code-01">{p.iamAppCode || "—"}</span> },
            { key: "active", header: "Status", width: 120, sortValue: (p) => (p.active ? 1 : 0), render: (p) => status(p.active) },
          ]}
          rowActions={(p) => <IconButton kind="ghost" size="sm" label="Edit" align="left" onClick={() => setEditProject(p)}><Edit /></IconButton>}
        />
      )}

      {editTenant && (
        <TenantForm original={editTenant === "new" ? null : editTenant} onClose={() => setEditTenant(null)}
                    onSaved={() => { setEditTenant(null); loadTenants(); window.dispatchEvent(new CustomEvent("rs-tenancy-changed")); }} />
      )}
      {editProject && (
        <ProjectForm tenantId={tenant} original={editProject === "new" ? null : editProject} onClose={() => setEditProject(null)}
                     onSaved={() => { setEditProject(null); loadProjects(); window.dispatchEvent(new CustomEvent("rs-tenancy-changed")); }} />
      )}
    </div>
  );
}

function ActiveSwitch({ value, onChange, id }: { value: boolean; onChange: (v: boolean) => void; id: string }) {
  return <Toggle id={id} labelText="Status" labelA="Inactive" labelB="Active" toggled={value} onToggle={onChange} />;
}

function TenantForm({ original, onClose, onSaved }: { original: TenantRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [id, setId] = useState(original?.id ?? "");
  const [name, setName] = useState(original?.name ?? "");
  const [iam, setIam] = useState(original?.iamTenantId ?? "");
  const [active, setActive] = useState(original?.active ?? true);
  const [busy, setBusy] = useState(false);
  const valid = ID_RE.test(id) && name.trim().length > 0;

  async function save() {
    setBusy(true);
    try {
      if (original) await api.updateTenant(original.id, { name, iamTenantId: iam, active });
      else await api.createTenant({ id, name, iamTenantId: iam || undefined });
      toast("Tenant saved", "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title={original ? `Edit tenant ${original.id}` : "New tenant"} onClose={onClose} width={460}
      foot={<>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={busy || !valid}>Save</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); if (valid && !busy) save(); }}>
      <button type="submit" hidden aria-hidden tabIndex={-1} />
      <Stack gap={6}>
        <TextInput id="tenant-id" labelText="Tenant id" className="rh-mono" value={id} disabled={!!original} placeholder="acme"
          onChange={(e) => setId(e.target.value.toLowerCase())} invalid={!!id && !ID_RE.test(id)} invalidText="Lowercase letters, digits, - or _" />
        <TextInput id="tenant-name" labelText="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput id="tenant-iam" labelText="IAM tenant id" className="rh-mono" value={iam} onChange={(e) => setIam(e.target.value)} />
        {original && <ActiveSwitch id="tenant-active" value={active} onChange={setActive} />}
      </Stack>
      </form>
    </Modal>
  );
}

function ProjectForm({ tenantId, original, onClose, onSaved }: {
  tenantId: string; original: ProjectRow | null; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [id, setId] = useState(original?.id ?? "");
  const [name, setName] = useState(original?.name ?? "");
  const [app, setApp] = useState(original?.iamAppCode ?? "");
  const [active, setActive] = useState(original?.active ?? true);
  const [busy, setBusy] = useState(false);
  const valid = ID_RE.test(id) && name.trim().length > 0;

  async function save() {
    setBusy(true);
    try {
      if (original) await api.updateProject(tenantId, original.id, { name, iamAppCode: app, active });
      else await api.createProject(tenantId, { id, name, iamAppCode: app || undefined });
      toast("Project saved", "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title={original ? `Edit project ${original.id}` : "New project"} sub={`Tenant ${tenantId}`} onClose={onClose} width={460}
      foot={<>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={busy || !valid}>Save</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); if (valid && !busy) save(); }}>
      <button type="submit" hidden aria-hidden tabIndex={-1} />
      <Stack gap={6}>
        <TextInput id="project-id" labelText="Project id" className="rh-mono" value={id} disabled={!!original} placeholder="sales"
          onChange={(e) => setId(e.target.value.toLowerCase())} invalid={!!id && !ID_RE.test(id)} invalidText="Lowercase letters, digits, - or _" />
        <TextInput id="project-name" labelText="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput id="project-app" labelText="IAM application code" className="rh-mono" value={app} placeholder="RH" onChange={(e) => setApp(e.target.value)} />
        {original && <ActiveSwitch id="project-active" value={active} onChange={setActive} />}
      </Stack>
      </form>
    </Modal>
  );
}

