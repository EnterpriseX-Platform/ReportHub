"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button, FileUploaderButton, IconButton, InlineNotification, PasswordInput, RadioButton, RadioButtonGroup, Stack,
  StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, Tab, TabListVertical, Tabs, Tag,
  TextInput, Tile,
} from "@carbon/react";
import { Add, Checkmark, Copy, Edit, Filter, Password, TrashCan } from "@carbon/icons-react";
import { FieldError, PageHeader } from "@/components/ui";
import { carbonIcon } from "@/components/Icon";
import { DataList } from "@/components/DataList";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { api, errorStatus, fieldErrors } from "@/lib/api";
import { usePerms } from "@/lib/perms";
import type { Category, MeResponse, SharedResource, UserRow } from "@/lib/types";
import { TenantsSection } from "@/components/TenancySettings";

const SECTIONS = [
  { id: "users", label: "Users & roles", icon: "settings" },
  { id: "tenants", label: "Tenants & projects", icon: "globe" },
  { id: "resources", label: "Shared resources", icon: "doc" },
  { id: "categories", label: "Report categories", icon: "registry" },
  { id: "parameters", label: "Parameters", icon: "filter" },
  { id: "system", label: "System", icon: "engine" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

/** A pending destructive action, confirmed in a danger Modal (no window.confirm). */
type Confirm = { title: string; body: React.ReactNode; action: string; run: () => Promise<void> };

export default function SettingsPage() {
  const toast = useToast();
  const perms = usePerms();
  const router = useRouter();
  const [section, setSection] = useState<Section>("users");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [editing, setEditing] = useState<UserRow | null | "new">(null);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [resources, setResources] = useState<SharedResource[] | null>(null);
  const [resBusy, setResBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [catEdit, setCatEdit] = useState<Category | "new" | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Carbon renders a hidden "Remove … tab" close button (title + "Press delete to remove … tab") in every
  // tab even when the tabs are not dismissable; screen readers and the accessibility tree still pick the
  // labels up. Strip them so each tab reads as just its name.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current?.querySelectorAll(".cds--tabs__nav-item--close--hidden").forEach((n) => {
      n.querySelectorAll("[title],[aria-label]").forEach((x) => { x.removeAttribute("title"); x.removeAttribute("aria-label"); });
      n.setAttribute("aria-hidden", "true");
    });
  });

  const reload = useCallback(() => {
    api.users().then(setUsers).catch((e) => setErr(e instanceof Error ? e.message : "load failed"));
  }, []);

  const reloadResources = useCallback(() => {
    api.sharedResources().then(setResources).catch(() => setResources((r) => r ?? []));
  }, []);

  useEffect(() => {
    api.me().then(setMe).catch(() => {});
    reload();
    reloadResources();
  }, [reload, reloadResources]);

  async function uploadResources(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setResBusy(true);
    try {
      for (const f of list) await api.uploadSharedResource(f);
      toast(`Uploaded ${list.length} shared resource${list.length > 1 ? "s" : ""}`, "ok");
      reloadResources();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setResBusy(false);
    }
  }

  async function removeResource(name: string) {
    // Check which reports reference this resource first, so deleting a logo in use is a conscious choice.
    let usage: string[] = [];
    try { usage = await api.resourceUsage(name); } catch { /* best-effort */ }
    setConfirm({
      title: `Delete shared resource ${name}?`,
      action: usage.length ? "Delete anyway" : "Delete",
      body: usage.length ? (
        <Stack gap={4}>
          <p>&quot;{name}&quot; is used by {usage.length} report(s):</p>
          <ul className="cds--type-code-01">{usage.map((u) => <li key={u}>{u}</li>)}</ul>
        </Stack>
      ) : <p>This cannot be undone.</p>,
      run: async () => {
        try {
          await api.deleteSharedResource(name, usage.length > 0);
          toast(`Deleted ${name}`, "ok");
          reloadResources();
        } catch (e) {
          toast(e instanceof Error ? e.message : "Delete failed", "error");
        }
      },
    });
  }

  function remove(u: UserRow) {
    setConfirm({
      title: `Delete user ${u.username}?`, action: "Delete", body: <p>This cannot be undone.</p>,
      run: async () => {
        try {
          await api.deleteUser(u.username);
          toast(`Deleted ${u.username}`, "ok");
          reload();
        } catch (e) {
          toast(e instanceof Error ? e.message : "Delete failed", "error");
        }
      },
    });
  }

  if (err) {
    return (
      <div style={{ maxWidth: "36rem" }}>
        <InlineNotification kind="error" lowContrast hideCloseButton title="Access denied"
          subtitle={`${perms.me?.permissions ? "This page requires the RH.SETTINGS permission" : "This page requires the ADMIN role"} (${err})`} />
      </div>
    );
  }

  const idx = SECTIONS.findIndex((s) => s.id === section);
  const iamMode = (me?.authMode ?? perms.me?.authMode) === "iam";

  return (
    <div>
      <PageHeader title="Settings" sub="Users · tenants · shared resources · parameters · system" />

      <div className="rh-split" ref={tabsRef}>
        <Tabs selectedIndex={idx} onChange={({ selectedIndex }) => setSection(SECTIONS[selectedIndex].id)}>
          <TabListVertical aria-label="Settings sections">
            {SECTIONS.map((s) => <Tab key={s.id} renderIcon={carbonIcon(s.icon)}>{s.label}</Tab>)}
          </TabListVertical>
        </Tabs>

        <div style={{ minWidth: 0 }}>
          {section === "tenants" && <TenantsSection />}

          {section === "users" && (
            <DataList<UserRow>
              title="Users & roles"
              rows={users ?? []}
              loading={users === null}
              description={iamMode ? <Tag size="sm" type="cool-gray">Sign-in is managed by IAM · local accounts below are not used</Tag> : undefined}
              toolbar={iamMode ? undefined : <Button renderIcon={Add} onClick={() => setEditing("new")}>New user</Button>}
              columns={[
                {
                  key: "username", header: "Username",
                  render: (u) => <span className="rh-inline"><span className="cds--type-code-02">{u.username}</span>{me?.username === u.username && <Tag size="sm" type="gray">you</Tag>}</span>,
                },
                { key: "displayName", header: "Display name" },
                { key: "role", header: "Role", width: 120, render: (u) => <Tag size="sm" type={u.role === "ADMIN" ? "blue" : "gray"}>{u.role}</Tag> },
              ]}
              rowActions={(u) => {
                const orig = (users ?? []).find((x) => x.username === u.username)!;
                return (
                  <span className="rh-inline" style={{ gap: 0 }}>
                    <IconButton kind="ghost" size="sm" label={`Edit ${u.username}`} align="left" onClick={() => setEditing(orig)}><Edit /></IconButton>
                    {!iamMode && <IconButton kind="ghost" size="sm" label={`Reset password for ${u.username}`} align="left" onClick={() => setResetFor(orig)}><Password /></IconButton>}
                    <IconButton kind="ghost" size="sm" label={`Delete ${u.username}`} align="left" disabled={me?.username === u.username} onClick={() => remove(orig)}><TrashCan /></IconButton>
                  </span>
                );
              }}
            />
          )}

          {section === "resources" && (
            <DataList<SharedResource & { id: string }>
              title="Shared resources"
              description={<>Logos / images / fonts reused by every report — reference in a template as <code className="cds--type-code-01">$P&#123;SUBREPORT_DIR&#125;+&quot;filename&quot;</code></>}
              rows={(resources ?? []).map((r) => ({ ...r, id: r.name }))}
              loading={resources === null}
              empty="No shared resources yet"
              toolbar={
                <FileUploaderButton labelText="Upload" buttonKind="primary" multiple disableLabelChanges disabled={resBusy}
                  accept={[".png", ".jpg", ".jpeg", ".gif", ".ttf", ".otf"]}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => { uploadResources(e.target.files); e.target.value = ""; }} />
              }
              columns={[
                {
                  key: "name", header: "Name",
                  render: (r) => (
                    <span className="rh-inline">
                      {r.thumbnail
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={r.thumbnail} alt="" className="rh-thumb" />
                        : <span className="rh-thumb" style={{ display: "grid", placeItems: "center" }} aria-hidden>{(() => { const I = carbonIcon("doc"); return I ? <I size={16} /> : null; })()}</span>}
                      <span className="cds--type-code-02">{r.name}</span>
                    </span>
                  ),
                },
                { key: "sizeBytes", header: "Size", align: "end", width: 120, render: (r) => `${(r.sizeBytes / 1024).toFixed(1)} KB` },
              ]}
              rowActions={(r) => (
                <span className="rh-inline" style={{ gap: 0 }}>
                  <Button kind="ghost" size="sm" renderIcon={Copy} title={`Copy $P{SUBREPORT_DIR}+"${r.name}"`}
                    onClick={() => { navigator.clipboard?.writeText(`$P{SUBREPORT_DIR}+"${r.name}"`); toast("Reference copied", "ok"); }}>
                    ref
                  </Button>
                  <IconButton kind="ghost" size="sm" label={`Delete ${r.name}`} align="left" onClick={() => removeResource(r.name)}><TrashCan /></IconButton>
                </span>
              )}
            />
          )}

          {section === "categories" && <CategoriesSection edit={catEdit} setEdit={setCatEdit} onConfirm={setConfirm} />}

          {section === "parameters" && (
            <Tile style={{ maxWidth: "40rem" }}>
              <Stack gap={5}>
                <h3 className="cds--type-heading-03">Parameters</h3>
                <p className="cds--type-body-01">
                  Report parameters (fiscal year, region, date range, …) live in a shared catalog and are assigned to a report
                  in its Config tab. Option lists resolve from static values, a query, or SQL.
                </p>
                <div><Button renderIcon={Filter} onClick={() => router.push("/parameters")}>Open Parameters catalog</Button></div>
              </Stack>
            </Tile>
          )}

          {section === "system" && (
            <Tile style={{ maxWidth: "40rem" }}>
              <Stack gap={6}>
                <div>
                  <h3 className="cds--type-heading-03" style={{ marginBottom: "var(--cds-spacing-03)" }}>System</h3>
                  <StructuredListWrapper isCondensed className="rh-slist" aria-label="System">
                    <StructuredListBody>
                      {[
                        ["App", "Report Studio", false],
                        ["API base", "/reportstudio/api", true],
                        ["Object store", "MinIO · report-outputs", true],
                        ["Auth", "JWT Bearer · RBAC (ADMIN / USER)", false],
                      ].map(([k, v, mono]) => (
                        <StructuredListRow key={String(k)}>
                          <StructuredListCell noWrap>{k}</StructuredListCell>
                          <StructuredListCell className={mono ? "cds--type-code-01" : undefined}>{v}</StructuredListCell>
                        </StructuredListRow>
                      ))}
                    </StructuredListBody>
                  </StructuredListWrapper>
                </div>
                <div>
                  <h3 className="cds--type-heading-compact-02" style={{ marginBottom: "var(--cds-spacing-03)" }}>Role matrix</h3>
                  <StructuredListWrapper isCondensed className="rh-slist" aria-label="Role matrix">
                    <StructuredListBody>
                      <StructuredListRow><StructuredListCell noWrap><b>ADMIN</b></StructuredListCell><StructuredListCell>Full control: reports, engines, parameters, users</StructuredListCell></StructuredListRow>
                      <StructuredListRow><StructuredListCell noWrap><b>USER</b></StructuredListCell><StructuredListCell>Read everything + run reports / ad-hoc / pivot</StructuredListCell></StructuredListRow>
                    </StructuredListBody>
                  </StructuredListWrapper>
                </div>
              </Stack>
            </Tile>
          )}
        </div>
      </div>

      {editing && (
        <UserEditor
          original={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      {resetFor && <PasswordReset user={resetFor} onClose={() => setResetFor(null)} />}
      {confirm && (
        <Modal title={confirm.title} danger width={480} onClose={() => setConfirm(null)}
          foot={<>
            <Button kind="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button kind="danger" disabled={confirmBusy}
              onClick={async () => { setConfirmBusy(true); try { await confirm.run(); } finally { setConfirmBusy(false); setConfirm(null); } }}>
              {confirm.action}
            </Button>
          </>}>
          <div className="cds--type-body-01">{confirm.body}</div>
        </Modal>
      )}
    </div>
  );
}

function UserEditor({ original, onClose, onSaved }: { original: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState(original?.username ?? "");
  const [displayName, setDisplayName] = useState(original?.displayName ?? "");
  const [role, setRole] = useState<string>(original?.role ?? "USER");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<{ username?: string; password?: string; displayName?: string; form?: string }>({});

  async function save() {
    if (busy) return;
    if (!original) {
      const e: typeof errs = {};
      if (!username.trim()) e.username = "Username is required";
      else if (!/^[a-z0-9._@-]+$/.test(username)) e.username = "Use lowercase letters, digits, dot, dash, underscore or @";
      if (!password) e.password = "Password is required";
      else if (password.length < 4 || password.length > 100) e.password = "Password must be 4 to 100 characters";
      setErrs(e);
      if (Object.keys(e).length) return;
    }
    setBusy(true);
    try {
      if (original) {
        await api.updateUser(original.username, { role, displayName });
      } else {
        await api.createUser({ username, password, role, displayName: displayName || username });
      }
      toast("User saved", "ok");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      // Put the server's message under the field it is about; otherwise under the form.
      const low = msg.toLowerCase();
      const f = fieldErrors(e);
      if (Object.keys(f).length) { setErrs({ username: f.username, password: f.password, displayName: f.displayName, form: f.role }); setBusy(false); return; }
      setErrs(low.includes("password") ? { password: msg }
        : low.includes("username") || low.includes("exists") ? { username: msg }
        : low.includes("display") ? { displayName: msg } : { form: msg });
      setBusy(false);
    }
  }

  return (
    <Modal title={original ? `Edit ${original.username}` : "New user"} onClose={onClose} width={440}
      foot={<>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={busy}>Save</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
      <button type="submit" hidden aria-hidden tabIndex={-1} />
      <Stack gap={6}>
        <TextInput id="user-username" labelText="Username" className="rh-mono" value={username} disabled={!!original} placeholder="jane.doe"
          onChange={(e) => { setUsername(e.target.value.toLowerCase()); setErrs((x) => ({ ...x, username: undefined })); }}
          invalid={!!errs.username} invalidText={errs.username} />
        {!original && (
          <PasswordInput id="user-password" labelText="Password" value={password} autoComplete="new-password"
            onChange={(e) => { setPassword(e.target.value); setErrs((x) => ({ ...x, password: undefined })); }}
            invalid={!!errs.password} invalidText={errs.password} />
        )}
        <TextInput id="user-display" labelText="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
          invalid={!!errs.displayName} invalidText={errs.displayName} />
        <RadioButtonGroup legendText="Role" name="user-role" orientation="horizontal" valueSelected={role} onChange={(v) => setRole(String(v))}>
          <RadioButton id="user-role-user" value="USER" labelText="USER" />
          <RadioButton id="user-role-admin" value="ADMIN" labelText="ADMIN" />
        </RadioButtonGroup>
        {errs.form && <InlineNotification kind="error" lowContrast hideCloseButton title={errs.form} />}
      </Stack>
      </form>
    </Modal>
  );
}

function PasswordReset({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    if (!password) { setError("Password is required"); return; }
    if (password.length < 4 || password.length > 100) { setError("Password must be 4 to 100 characters"); return; }
    setBusy(true);
    try {
      await api.resetPassword(user.username, password);
      toast(`Password reset for ${user.username}`, "ok");
      onClose();
    } catch (e) {
      setError(fieldErrors(e).password ?? (e instanceof Error ? e.message : "Reset failed"));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reset password · ${user.username}`} onClose={onClose} width={400}
      foot={<>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
        <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={busy}>Reset</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
        <PasswordInput id="reset-password" labelText="New password" autoComplete="new-password" value={password}
          invalid={!!error} invalidText={error ?? undefined}
          onChange={(e) => { setPassword(e.target.value); setError(null); }} />
      </form>
    </Modal>
  );
}

function CategoriesSection({ edit, setEdit, onConfirm }: {
  edit: Category | "new" | null; setEdit: (v: Category | "new" | null) => void; onConfirm: (c: Confirm) => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<Category[] | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [order, setOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [fErr, setFErr] = useState<Record<string, string>>({});
  const load = useCallback(() => { api.categories().then(setRows).catch((e) => { setRows([]); toast(e instanceof Error ? e.message : "Load failed", "error"); }); }, [toast]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!edit) return;
    setTouched(false);
    setFErr({});
    setName(edit === "new" ? "" : edit.name);
    setDesc(edit === "new" ? "" : edit.description ?? "");
    setOrder(edit === "new" ? String((rows?.length ?? 0) + 1) : edit.sortOrder != null ? String(edit.sortOrder) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit]);

  async function save() {
    setTouched(true);
    if (!name.trim() || !edit) return;
    setBusy(true);
    const body = { name: name.trim(), description: desc.trim() || null, sortOrder: order.trim() ? Number(order) : null };
    try {
      if (edit === "new") await api.createCategory(body);
      else await api.updateCategory(edit.id, { id: edit.id, ...body });
      toast(edit === "new" ? "Category created" : "Category saved", "ok");
      setEdit(null); load();
    } catch (e) {
      const f = fieldErrors(e);
      setFErr(f);
      if (Object.keys(f).length === 0) toast(e instanceof Error ? e.message : "Save failed", "error");
    }
    finally { setBusy(false); }
  }
  function remove(c: Category) {
    onConfirm({
      title: `Delete category "${c.name}"?`,
      action: c.registered > 0 ? "Delete anyway" : "Delete",
      body: <p>{c.registered > 0 ? `"${c.name}" has ${c.registered} report(s).` : "This cannot be undone."}</p>,
      run: async () => {
        try { await api.deleteCategory(c.id); toast("Category deleted", "ok"); load(); }
        catch (e) {
          const msg = e instanceof Error ? e.message : "Delete failed";
          toast(errorStatus(e) === 409 ? `Cannot delete "${c.name}": ${msg}` : msg, "error");
        }
      },
    });
  }
  const nameMissing = touched && !name.trim();

  return (
    <>
      <DataList<Category>
        title="Report categories"
        description={rows ? `${rows.length} ${rows.length === 1 ? "category" : "categories"}` : undefined}
        rows={rows ?? []}
        loading={rows === null}
        empty="No categories yet"
        initialSort={{ key: "sortOrder", dir: "ASC" }}
        toolbar={<Button renderIcon={Add} onClick={() => setEdit("new")}>New category</Button>}
        columns={[
          { key: "sortOrder", header: "Order", width: 96, render: (c) => <span className="cds--type-code-01">{c.sortOrder ?? "—"}</span> },
          { key: "name", header: "Name", render: (c) => <b style={{ fontWeight: 600 }}>{c.name}</b> },
          { key: "description", header: "Description", render: (c) => <span className="rh-dim">{c.description || "—"}</span> },
          { key: "registered", header: "Reports", align: "end", width: 120, render: (c) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{c.registered}</span> },
        ]}
        rowActions={(c) => (
          <span className="rh-inline" style={{ gap: 0 }}>
            <IconButton kind="ghost" size="sm" label={`Rename ${c.name}`} align="left" onClick={() => setEdit(c)}><Edit /></IconButton>
            <IconButton kind="ghost" size="sm" label={`Delete ${c.name}`} align="left" onClick={() => remove(c)}><TrashCan /></IconButton>
          </span>
        )}
      />

      {edit && (
        <Modal title={edit === "new" ? "New category" : `Edit category · ${edit.name}`} width={480} onClose={() => setEdit(null)}
               foot={<>
                 <Button kind="secondary" onClick={() => setEdit(null)}>Cancel</Button>
                 <Button kind="primary" renderIcon={Checkmark} disabled={busy} onClick={save}>{edit === "new" ? "Create" : "Save"}</Button>
               </>}>
          <Stack gap={6}>
            <div>
              <TextInput id="cat-name" labelText="Name (required)" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)}
                invalid={nameMissing} invalidText="Name is required" />
              <FieldError errors={fErr} name="name" />
            </div>
            <div>
              <TextInput id="cat-desc" labelText="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
              <FieldError errors={fErr} name="description" />
            </div>
            <div style={{ maxWidth: "10rem" }}>
              <TextInput id="cat-order" labelText="Sort order" className="rh-mono" inputMode="numeric" value={order}
                onChange={(e) => setOrder(e.target.value.replace(/[^0-9-]/g, ""))} />
              <FieldError errors={fErr} name="sortOrder" />
            </div>
          </Stack>
        </Modal>
      )}
    </>
  );
}
