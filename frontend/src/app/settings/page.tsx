"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/overlays";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { MeResponse, SharedResource, UserRow } from "@/lib/types";

const SECTIONS = [
  { id: "users", label: "Users & roles", icon: "settings", desc: "Accounts and role assignments" },
  { id: "resources", label: "Shared resources", icon: "doc", desc: "Logos, images, fonts for all reports" },
  { id: "parameters", label: "Parameters", icon: "filter", desc: "Shared report parameter catalog" },
  { id: "system", label: "System", icon: "engine", desc: "Runtime info and role matrix" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
  const toast = useToast();
  const router = useRouter();
  const [section, setSection] = useState<Section>("users");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [editing, setEditing] = useState<UserRow | null | "new">(null);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [resources, setResources] = useState<SharedResource[]>([]);
  const [resBusy, setResBusy] = useState(false);
  const resInputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.users().then(setUsers).catch((e) => setErr(e instanceof Error ? e.message : "load failed"));
  }, []);

  const reloadResources = useCallback(() => {
    api.sharedResources().then(setResources).catch(() => {});
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
    const msg = usage.length
      ? `"${name}" is used by ${usage.length} report(s):\n\n${usage.join("\n")}\n\nDelete anyway?`
      : `Delete shared resource ${name}?`;
    if (!window.confirm(msg)) return;
    try {
      await api.deleteSharedResource(name, usage.length > 0);
      toast(`Deleted ${name}`, "ok");
      reloadResources();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  async function remove(u: UserRow) {
    if (!window.confirm(`Delete user ${u.username}?`)) return;
    try {
      await api.deleteUser(u.username);
      toast(`Deleted ${u.username}`, "ok");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  if (err) {
    return <div className="card card-pad" style={{ maxWidth: 560 }}>
      <b style={{ color: "var(--red)" }}>Access denied</b>
      <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 6 }}>This page requires the ADMIN role ({err})</div>
    </div>;
  }

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">Users · shared resources · parameters · system</div>
        </div>
        <div className="page-actions">
          {section === "users" && <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" size={16} />New user</button>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "232px 1fr", gap: 16, alignItems: "start" }}>
        {/* section headings on the left — click to show that section's config on the right (left-nav layout) */}
        <div className="card" style={{ padding: 6, position: "sticky", top: 0 }}>
          {SECTIONS.map((s) => {
            const on = section === s.id;
            return (
              <button key={s.id} onClick={() => setSection(s.id)}
                      style={{ position: "relative", display: "flex", alignItems: "flex-start", gap: 10, width: "100%", textAlign: "left",
                               padding: "10px 11px", borderRadius: 10, border: "none", cursor: "pointer", marginBottom: 2,
                               background: on ? "var(--accent-weak)" : "transparent" }}
                      onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--surface-3)"; }}
                      onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}>
                {on && <span aria-hidden style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)", width: 3, height: 24, borderRadius: 3, background: "var(--accent)" }} />}
                <Icon name={s.icon} size={15} style={{ color: on ? "var(--accent)" : "var(--ink-4)", flex: "none", marginTop: 1 }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? "var(--accent)" : "var(--ink)" }}>{s.label}</span>
                  <span style={{ display: "block", fontSize: 10.5, color: "var(--ink-4)", marginTop: 1, lineHeight: 1.4 }}>{s.desc}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ minWidth: 0 }}>
      {section === "users" && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-head"><Icon name="settings" size={16} style={{ color: "var(--accent)" }} /><h3>Users &amp; roles</h3></div>
          <table className="tbl">
            <thead><tr><th>Username</th><th>Display name</th><th>Role</th><th style={{ width: 170 }} /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ cursor: "default" }}>
                  <td className="mono strong">{u.username}{me?.username === u.username && <span className="chip blue" style={{ height: 17, marginLeft: 7 }}>you</span>}</td>
                  <td>{u.displayName}</td>
                  <td>
                    <span className="chip" style={{ height: 19, background: u.role === "ADMIN" ? "var(--accent-weak)" : undefined, color: u.role === "ADMIN" ? "var(--accent)" : undefined }}>{u.role}</span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn sm ghost" title="Edit" onClick={() => setEditing(u)}><Icon name="edit" size={13} /></button>
                      <button className="btn sm ghost" title="Reset password" onClick={() => setResetFor(u)}><Icon name="refresh" size={13} /></button>
                      <button className="btn sm ghost" title="Delete" disabled={me?.username === u.username} onClick={() => remove(u)}><Icon name="x" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan={4}><div className="empty"><span className="spin" /></div></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {section === "resources" && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-head" style={{ justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="doc" size={16} style={{ color: "var(--accent)" }} />
              <h3>Shared resources</h3>
              <span style={{ fontSize: 12, color: "var(--ink-4)" }}>logos / images / fonts reused by every report — reference in a template as $P&#123;SUBREPORT_DIR&#125;+&quot;filename&quot;</span>
            </div>
            <input ref={resInputRef} type="file" multiple style={{ display: "none" }} accept=".png,.jpg,.jpeg,.gif,.ttf,.otf"
                   onChange={(e) => { uploadResources(e.target.files); e.target.value = ""; }} />
            <button className="btn sm" disabled={resBusy} onClick={() => resInputRef.current?.click()}>
              {resBusy ? <span className="spin" /> : <Icon name="upload" size={14} />}Upload
            </button>
          </div>
          <table className="tbl">
            <thead><tr><th>File</th><th style={{ width: 110 }}>Size</th><th style={{ width: 130 }}>Status</th><th style={{ width: 150 }} /></tr></thead>
            <tbody>
              {resources.map((r) => (
                <tr key={r.name} style={{ cursor: "default" }}>
                  <td className="mono strong">
                    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {r.thumbnail
                        ? <img src={r.thumbnail} alt="" style={{ width: 28, height: 28, objectFit: "contain", borderRadius: 4, border: "1px solid var(--line)", background: "var(--surface-2)", flex: "none" }} />
                        : <Icon name="doc" size={18} style={{ color: "var(--ink-4)", flex: "none" }} />}
                      {r.name}
                    </span>
                  </td>
                  <td style={{ color: "var(--ink-3)" }}>{(r.sizeBytes / 1024).toFixed(1)} KB</td>
                  <td><span className="chip green" style={{ height: 19 }}><i className="led" />all reports</span></td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn sm ghost" title={`Copy $P{SUBREPORT_DIR}+"${r.name}"`}
                              onClick={() => { navigator.clipboard?.writeText(`$P{SUBREPORT_DIR}+"${r.name}"`); toast("Reference copied", "ok"); }}>
                        <Icon name="copy" size={13} />ref
                      </button>
                      <button className="btn sm ghost" title="Delete" style={{ color: "var(--red)" }} onClick={() => removeResource(r.name)}><Icon name="x" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {resources.length === 0 && <tr><td colSpan={4}><div className="empty">No shared resources yet. Upload a logo/font here to reuse it across all reports.</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {section === "parameters" && (
        <div className="card card-pad" style={{ maxWidth: 620 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Icon name="filter" size={16} style={{ color: "var(--accent)" }} />
            <h3 style={{ margin: 0 }}>Parameters</h3>
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.7, marginBottom: 12 }}>
            Report parameters (fiscal year, region, date range, …) live in a shared catalog. Define them once,
            then assign them to a report in its <b>Config</b> tab. The catalog also resolves option lists from static
            values, a query, or SQL.
          </div>
          <button className="btn primary" onClick={() => router.push("/parameters")}><Icon name="filter" size={15} />Open Parameters catalog</button>
        </div>
      )}

      {section === "system" && (
        <div className="card card-pad" style={{ maxWidth: 520 }}>
          <div className="section-label">System</div>
          <div className="kv"><span className="k">App</span><span className="v">Report Studio</span></div>
          <div className="kv"><span className="k">API base</span><span className="v mono" style={{ fontSize: 11 }}>/reportstudio/api</span></div>
          <div className="kv"><span className="k">Gateway topic</span><span className="v mono" style={{ fontSize: 11 }}>report.jobs</span></div>
          <div className="kv"><span className="k">Object store</span><span className="v mono" style={{ fontSize: 11 }}>MinIO · report-outputs</span></div>
          <div className="kv"><span className="k">Auth</span><span className="v">JWT Bearer · RBAC (ADMIN / USER)</span></div>
          <div className="divider" />
          <div className="section-label">Role matrix</div>
          <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.9 }}>
            <b>ADMIN</b> — full control: reports, engines, parameters, users<br />
            <b>USER</b> — read everything + run reports / ad-hoc / pivot
          </div>
        </div>
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
      {resetFor && (
        <PasswordReset user={resetFor} onClose={() => setResetFor(null)} />
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

  async function save() {
    setBusy(true);
    try {
      if (original) {
        await api.updateUser(original.username, { role, displayName });
      } else {
        if (!username || !password) { toast("username and password are required", "error"); setBusy(false); return; }
        await api.createUser({ username, password, role, displayName: displayName || username });
      }
      toast("User saved", "ok");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title={original ? `Edit ${original.username}` : "New user"} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div className="field"><label>Username</label>
          <input className="input mono" value={username} disabled={!!original} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="somchai.p" /></div>
        {!original && (
          <div className="field"><label>Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        )}
        <div className="field"><label>Display name</label>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
        <div className="field"><label>Role</label>
          <div className="seg" style={{ width: "100%" }}>
            <button style={{ flex: 1 }} className={role === "USER" ? "on" : ""} onClick={() => setRole("USER")}>USER</button>
            <button style={{ flex: 1 }} className={role === "ADMIN" ? "on" : ""} onClick={() => setRole("ADMIN")}>ADMIN</button>
          </div></div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? <span className="spin" /> : <Icon name="check" size={15} />}Save</button>
      </div>
    </Modal>
  );
}

function PasswordReset({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!password) return;
    setBusy(true);
    try {
      await api.resetPassword(user.username, password);
      toast(`Password reset for ${user.username}`, "ok");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Reset failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reset password · ${user.username}`} onClose={onClose} width={400}>
      <div className="field"><label>New password</label>
        <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !password}>{busy ? <span className="spin" /> : <Icon name="check" size={15} />}Reset</button>
      </div>
    </Modal>
  );
}
