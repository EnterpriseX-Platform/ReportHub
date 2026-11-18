"use client";

// Dataset builder: define a SELECT against a datasource, preview it, save it.
// Saved datasets feed the Ad-hoc builder and dashboard widgets.
import { Skeleton } from "@/components/ui";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button, IconButton, InlineNotification, Menu, MenuItem, MenuItemDivider, Search, TextInput } from "@carbon/react";
import { Add, Checkmark, Close, FolderAdd, Play, Renew, SidePanelClose, SidePanelOpen, TrashCan } from "@carbon/icons-react";
import { useRouter } from "next/navigation";
import cx from "@/components/D/d.module.scss";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { AccessButton, AccessPanel } from "@/components/AccessPanel";
import { Modal } from "@/components/overlays";
import { usePerms } from "@/lib/perms";
import { buildFolderTree, inFolder, repath, type FolderTreeNode } from "@/lib/foldertree";
import { Select } from "@/components/Select";
import { SqlEditor } from "@/components/SqlEditor";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { DatasetDef, Datasource, TableResult } from "@/lib/types";

export default function DatasetsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Datasets />
    </Suspense>
  );
}

function Datasets() {
  const search = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [confirmDel, setConfirmDel] = useState<DatasetDef | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [rows, setRows] = useState<DatasetDef[]>([]);
  const [dss, setDss] = useState<Datasource[]>([]);
  const [editing, setEditing] = useState<DatasetDef | null | "new">(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  /** Collapse the left nav — own storage key (read in an effect, not during render, because Next renders on the server) */
  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => { setNavOpen(localStorage.getItem("rs.ds.nav") !== "0"); }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((v) => { localStorage.setItem("rs.ds.nav", v ? "0" : "1"); return !v; });
  }, []);
  /** Folders just created that have no dataset yet — a folder is only a field on datasets, not a table */
  const [draftFolders, setDraftFolders] = useState<string[]>([]);
  const [editFolder, setEditFolder] = useState<{ old: string | null; value: string } | null>(null);
  const [confirmDelFolder, setConfirmDelFolder] = useState<string | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; d: DatasetDef } | null>(null);
  const [accessFor, setAccessFor] = useState<DatasetDef | null>(null);
  const [accessDirty, setAccessDirty] = useState(false);
  /** Same unsaved-changes guard as AccessButton. */
  const closeAccess = () => {
    if (accessDirty) { setConfirmDiscard(true); return; }
    setAccessDirty(false); setAccessFor(null);
  };
  const { can } = usePerms();

  // Retries twice before surfacing an inline error — a deploy/rollout can blip the API.
  const reload = useCallback((attempt = 0) => {
    setLoadErr(null);
    api.datasets().then(setRows).catch((e) => {
      if (attempt < 2) { setTimeout(() => reload(attempt + 1), 1500 * (attempt + 1)); return; }
      setLoadErr(e instanceof Error ? e.message : "Failed to load");
    });
  }, []);
  useEffect(() => { reload(); api.datasources().then(setDss).catch(() => {}); }, [reload]);
  // bridge from /datasources: "New dataset" lands here with the connection preselected
  useEffect(() => {
    if (search.get("datasource")) setEditing("new");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Group by folder; datasets without a folder go to "Ungrouped"
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((d) => !s || `${d.name} ${d.folder ?? ""} ${d.description ?? ""}`.toLowerCase().includes(s));
  }, [rows, q]);

  const groups = useMemo(() => {
    const m = new Map<string, DatasetDef[]>();
    for (const f of draftFolders) m.set(f, []);
    for (const d of shown) {
      const k = d.folder?.trim() || "Ungrouped";
      (m.get(k) ?? m.set(k, []).get(k)!).push(d);
    }
    return [...m.entries()].sort((a, b) =>
      a[0] === "Ungrouped" ? 1 : b[0] === "Ungrouped" ? -1 : a[0].localeCompare(b[0], "en"));
  }, [shown, draftFolders]);

  /** Folder tree — a group name containing "/" becomes a subfolder, same as Data Pipeline */
  const tree = useMemo(() => buildFolderTree<DatasetDef>(groups, "Ungrouped"), [groups]);

  /** Folders offered in the move menu — includes freshly created empty ones */
  const folderNames = useMemo(
    () => [...new Set([...rows.map((d) => d.folder?.trim() ?? ""), ...draftFolders])]
      .filter(Boolean).sort((a, b) => a.localeCompare(b, "en")),
    [rows, draftFolders]);

  /** Move a dataset into/out of a folder — folder is just a field, so save it directly */
  async function moveTo(d: DatasetDef, folder: string | null) {
    try {
      await api.updateDataset(d.id, {
        name: d.name, description: d.description ?? undefined, folder,
        datasourceId: d.datasourceId, sqlText: d.sqlText, dimensionColumns: d.dimensionColumns ?? null,
      });
      reload();
      toast(folder ? `Moved "${d.name}" to "${folder}"` : `Removed "${d.name}" from its folder`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Move failed", "error"); }
  }

  /** Rename a folder = move every dataset in it to the new name */
  async function commitFolderEdit() {
    const e = editFolder;
    setEditFolder(null);
    if (!e) return;
    const name = e.value.trim();
    if (!name || name === e.old) return;
    if (e.old === null) {
      if (!folderNames.includes(name)) setDraftFolders((c) => [...c, name]);
      return;
    }
    // Renaming a folder with subfolders moves the whole branch
    const members = rows.filter((d) => inFolder(d.folder, e.old!));
    try {
      await Promise.all(members.map((d) => api.updateDataset(d.id, {
        name: d.name, description: d.description ?? undefined, folder: repath(d.folder, e.old!, name),
        datasourceId: d.datasourceId, sqlText: d.sqlText, dimensionColumns: d.dimensionColumns ?? null,
      })));
      setDraftFolders((c) => c.filter((f) => f !== e.old));
      reload();
      toast(`Renamed to "${name}" (${members.length} items)`, "ok");
    } catch (err) { toast(err instanceof Error ? err.message : "Rename failed", "error"); }
  }

  /** Delete a folder = move every dataset in it out; datasets are not deleted */
  async function removeFolder(name: string) {
    const members = rows.filter((d) => inFolder(d.folder, name));
    try {
      await Promise.all(members.map((d) => api.updateDataset(d.id, {
        name: d.name, description: d.description ?? undefined, folder: null,
        datasourceId: d.datasourceId, sqlText: d.sqlText, dimensionColumns: d.dimensionColumns ?? null,
      })));
      setDraftFolders((c) => c.filter((f) => f !== name));
      setConfirmDelFolder(null);
      reload();
      toast(members.length ? `Folder deleted — moved ${members.length} items out` : "Folder deleted", "ok");
    } catch (err) { toast(err instanceof Error ? err.message : "Delete failed", "error"); }
  }

  function remove(d: DatasetDef) { setConfirmDel(d); }
  async function doRemove(d: DatasetDef) {
    setConfirmDel(null);
    try { await api.deleteDataset(d.id); reload(); } catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  /** One dataset row — indented by its folder depth */
  function renderDataset(d: DatasetDef, depth: number) {
    return (
      <div key={d.id}
           className={"rh-nt-item" + (editing !== "new" && editing?.id === d.id ? " rh-nt--on" : "") + (dragId === d.id ? " rh-nt--dragging" : "")}
           role="button" tabIndex={0} style={{ cursor: "pointer", paddingLeft: 10 + depth * 13 }}
           draggable
           onDragStart={(e) => { e.stopPropagation(); setDragId(d.id); }}
           onDragEnd={() => { setDragId(null); setDropOn(null); }}
           onClick={() => setEditing(d)}
           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(d); } }}
           onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, d }); }}
           title={`${d.name}${d.description ? ` — ${d.description}` : ""}`}>
        <Icon name="table" size={13} className="rh-nt-ico" />
        <span className="rh-nt-text">{d.name}</span>
        {d.captureMode === "captured" && (
          <span className="rh-nt-n" title="Stored as a snapshot">
            {d.captureRows?.toLocaleString() ?? "—"}
          </span>
        )}
        <IconButton kind="ghost" size="sm" label="Options" align="left" className="rh-nt-cog"
                    onClick={(e) => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, d }); }}>
          <Icon name="dots" size={16} />
        </IconButton>
      </div>
    );
  }

  /** The "Ungrouped" group — collapsible like a real folder, but cannot be renamed or deleted */
  function renderUngrouped() {
    const open = q.trim() ? true : !shut["Ungrouped"];
    return (
      <div key="__ungrouped__">
        <div className={"rh-nt-fold" + (open ? "" : " rh-nt--shut") + (dropOn === "Ungrouped" ? " rh-nt--drop" : "")}
             role="button" tabIndex={0} style={{ paddingLeft: 8 }}
             onClick={() => setShut((c) => ({ ...c, Ungrouped: open }))}
             onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShut((c) => ({ ...c, Ungrouped: open })); } }}
             onDragOver={(e) => { if (dragId != null) { e.preventDefault(); e.stopPropagation(); setDropOn("Ungrouped"); } }}
             onDragLeave={(e) => { e.stopPropagation(); setDropOn((c) => (c === "Ungrouped" ? null : c)); }}
             onDrop={(e) => {
               e.preventDefault(); e.stopPropagation();
               const d = rows.find((x) => x.id === dragId);
               setDragId(null); setDropOn(null);
               if (d && (d.folder?.trim() || "")) moveTo(d, null);
             }}
             title="Datasets not in any folder">
          <Icon name="chevron" size={11} className="rh-nt-caret" />
          <Icon name={open ? "folderOpen" : "folder"} size={13} className="rh-nt-fico" />
          <span className="rh-nt-name">Ungrouped</span>
          <span className="rh-nt-count">{tree.loose.length}</span>
        </div>
        {open && tree.loose.map((d) => renderDataset(d, 1))}
      </div>
    );
  }

  /** One folder level, recursing into subfolders */
  function renderFolders(nodes: FolderTreeNode<DatasetDef>[], depth: number) {
    return nodes.map((n) => {
      // While searching, expand every folder so results are not hidden in collapsed groups
      const open = q.trim() ? true : !shut[n.path];
      return (
        <div key={n.path}>
          {editFolder?.old === n.path ? (
            <div className="rh-nt-fold rh-nt--editing" style={{ paddingLeft: 8 + depth * 13 }}>
              <span style={{ width: 11, flex: "none" }} />
              <Icon name="folder" size={13} className="rh-nt-fico" />
              <TextInput id={`ds-fold-${n.path}`} size="sm" hideLabel labelText="Folder name" autoFocus value={editFolder.value} placeholder="Folder name"
                     onChange={(e) => setEditFolder({ old: n.path, value: e.target.value })}
                     onBlur={commitFolderEdit}
                     onKeyDown={(e) => {
                       if (e.key === "Enter") { e.preventDefault(); commitFolderEdit(); }
                       if (e.key === "Escape") { e.preventDefault(); setEditFolder(null); }
                     }} />
            </div>
          ) : (
            <div className={"rh-nt-fold" + (open ? "" : " rh-nt--shut") + (dropOn === n.path ? " rh-nt--drop" : "")}
                 role="button" tabIndex={0} style={{ paddingLeft: 8 + depth * 13 }}
                 onClick={() => setShut((c) => ({ ...c, [n.path]: open }))}
                 onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShut((c) => ({ ...c, [n.path]: open })); } }}
                 onDragOver={(e) => { if (dragId != null) { e.preventDefault(); e.stopPropagation(); setDropOn(n.path); } }}
                 onDragLeave={(e) => { e.stopPropagation(); setDropOn((c) => (c === n.path ? null : c)); }}
                 onDrop={(e) => {
                   e.preventDefault(); e.stopPropagation();
                   const d = rows.find((x) => x.id === dragId);
                   setDragId(null); setDropOn(null);
                   if (d && (d.folder?.trim() || "") !== n.path) moveTo(d, n.path);
                 }}
                 onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setEditFolder({ old: n.path, value: n.path }); }}
                 title={`${n.path}\nDouble-click to rename · drop a dataset here to move it into this folder`}>
              <Icon name="chevron" size={11} className="rh-nt-caret" />
              <Icon name={open ? "folderOpen" : "folder"} size={13} className="rh-nt-fico" />
              <span className="rh-nt-name"
                    onDoubleClick={(e) => { e.stopPropagation(); setEditFolder({ old: n.path, value: n.path }); }}>{n.label}</span>
              <span className="rh-nt-count">{n.total}</span>
              <span className="rh-nt-acts" onClick={(e) => e.stopPropagation()}>
                {confirmDelFolder === n.path
                  ? <Button kind="danger" size="sm" title="Click again to delete — datasets inside are moved out, not deleted"
                            onClick={() => removeFolder(n.path)}>Remove?</Button>
                  : <IconButton kind="ghost" size="sm" label="Delete this folder" align="left"
                                onClick={() => setConfirmDelFolder(n.path)}><TrashCan /></IconButton>}
              </span>
            </div>
          )}
          {open && (
            <>
              {renderFolders(n.kids, depth + 1)}
              {n.items.map((d) => renderDataset(d, depth + 1))}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <div className="fade-in">
      {can("RH.DATASET", "create") && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--cds-spacing-05)" }}>
          <Button kind="primary" renderIcon={Add} onClick={() => setEditing("new")}>New dataset</Button>
        </div>
      )}
      {loadErr && (
        <InlineNotification kind="error" lowContrast hideCloseButton style={{ maxWidth: "none", marginBottom: "var(--cds-spacing-05)" }}
          title="Failed to load datasets" subtitle={`${loadErr} — the service may be restarting (a deploy is running)`}>
          <Button kind="ghost" size="sm" renderIcon={Renew} onClick={() => reload()}>Retry</Button>
        </InlineNotification>
      )}

      {/* Same layout as Tables / SQL Editor: list in the left nav, editor in the main area, so the
          list stays visible while switching between datasets */}
      <div className={"rh-ops rh-fill" + (navOpen ? "" : " rh-ops--rail-off")}>
        {!navOpen && (
          <aside className="rh-ops__nav rh-ops__nav--collapsed">
            <IconButton kind="ghost" size="sm" label="Show dataset list" align="right" onClick={toggleNav}>
              <SidePanelOpen />
            </IconButton>
          </aside>
        )}
        <aside className="rh-ops__nav" hidden={!navOpen}>
          <div className={cx.railHead}>
            <Search size="md" labelText="Find a dataset" placeholder="Find a dataset" value={q}
                    onChange={(e) => setQ(e.target.value)} onClear={() => setQ("")} />
            <IconButton kind="ghost" size="md" label="Hide dataset list" align="left" onClick={toggleNav}>
              <SidePanelClose />
            </IconButton>
          </div>

          {can("RH.DATASET", "create") && (
          <div className={cx.railTools}>
            <IconButton kind="ghost" size="sm" label="New folder" align="left" onClick={() => setEditFolder({ old: null, value: "" })}>
              <FolderAdd />
            </IconButton>
          </div>)}

          {editFolder?.old === null && (
            <div className="rh-nt-fold rh-nt--editing" style={{ paddingLeft: 8 }}>
              <span style={{ width: 11, flex: "none" }} />
              <Icon name="folder" size={13} className="rh-nt-fico" />
              <TextInput id="ds-fold-new" size="sm" hideLabel labelText="Folder name" autoFocus value={editFolder.value} placeholder="Folder name"
                     onChange={(e) => setEditFolder({ old: null, value: e.target.value })}
                     onBlur={commitFolderEdit}
                     onKeyDown={(e) => {
                       if (e.key === "Enter") { e.preventDefault(); commitFolderEdit(); }
                       if (e.key === "Escape") { e.preventDefault(); setEditFolder(null); }
                     }} />
            </div>
          )}

          {/* Dropping on empty space removes it from its folder */}
          <div style={{ display: "contents" }}
               onDragOver={(e) => { if (dragId != null) { e.preventDefault(); setDropOn(null); } }}
               onDrop={(e) => {
                 if (dragId == null) return;
                 e.preventDefault();
                 const d = rows.find((x) => x.id === dragId);
                 setDragId(null); setDropOn(null);
                 if (d && (d.folder?.trim() || "")) moveTo(d, null);
               }}>
          {renderFolders(tree.roots, 0)}
          {tree.loose.length > 0 && renderUngrouped()}
          </div>

          <div className={cx.railFoot}>
            {`${rows.length} dataset${rows.length === 1 ? "" : "s"}`}
            <IconButton kind="ghost" size="sm" label="Reload" align="top" onClick={() => reload()}>
              <Renew />
            </IconButton>
          </div>
        </aside>

        {menu && (
          <Menu open label={menu.d.name} x={menu.x} y={menu.y} onClose={() => setMenu(null)} size="sm">
            <MenuItem label="Edit" onClick={() => { const x = menu.d; setMenu(null); setEditing(x); }} />
            <MenuItem label="New report from this dataset" onClick={() => { const x = menu.d; setMenu(null); router.push(`/adhoc?dataset=custom-${x.id}`); }} />
            <MenuItem label={menu.d.captureMode === "captured" ? "Refresh snapshot" : "Store as snapshot"} onClick={async () => {
              const x = menu.d; setMenu(null);
              try {
                const res = await api.captureDataset(x.id);
                toast(x.captureMode === "captured"
                  ? `Refreshed the snapshot of "${x.name}"`
                  : `Captured ${res.captureRows?.toLocaleString("en-US")} rows`, "ok");
                reload();
              } catch (e) { toast(e instanceof Error ? e.message : "Snapshot failed", "error"); }
            }} />
            {menu.d.captureMode === "captured" && (
              <MenuItem label="Read live again" onClick={async () => {
                const x = menu.d; setMenu(null);
                try { await api.uncaptureDataset(x.id); toast(`"${x.name}" now reads live again`, "ok"); reload(); }
                catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
              }} />
            )}
            <MenuItemDivider />
            <MenuItem label="Move to folder">
              <MenuItem label="Ungrouped" onClick={() => { const x = menu.d; setMenu(null); moveTo(x, null); }} />
              {folderNames.filter((f) => f !== (menu.d.folder?.trim() ?? "")).map((f) => (
                <MenuItem key={f} label={f} onClick={() => { const x = menu.d; setMenu(null); moveTo(x, f); }} />
              ))}
            </MenuItem>
            {(can("RH.ACCESS") || can("RH.DATASET", "delete")) && <MenuItemDivider />}
            {can("RH.ACCESS") && (
              <MenuItem label="Access" onClick={() => { const x = menu.d; setMenu(null); setAccessFor(x); }} />
            )}
            {can("RH.DATASET", "delete") && (
              <MenuItem kind="danger" label="Delete this dataset" onClick={() => { const x = menu.d; setMenu(null); remove(x); }} />
            )}
          </Menu>
        )}

        <div className={cx.main} style={{ overflow: "auto" }}>
          {editing ? (
            <DatasetEditor key={editing === "new" ? "new" : editing.id}
                           original={editing === "new" ? null : editing} datasources={dss}
                           initialDatasourceId={search.get("datasource") ?? undefined}
                           onClose={() => setEditing(null)} onSaved={(saved) => { setEditing(saved ?? null); reload(); }} />
          ) : (
            <div className={cx.empty}>
              <Icon name="table" size={32} />
              <div className={"cds--type-heading-compact-01 " + cx.emptyTitle}>Pick a dataset from the left</div>
              {rows.length === 0 && <div className="cds--type-label-01" style={{ marginTop: 4 }}>No datasets yet</div>}
            </div>
          )}
        </div>
      </div>
      {accessFor && (
        <Modal title={`Access · ${accessFor.name}`} sub={`dataset ${accessFor.id}`} width={980} onClose={closeAccess}>
          <AccessPanel type="DATASET" id={String(accessFor.id)} onDirty={setAccessDirty} />
        </Modal>
      )}
      {confirmDiscard && (
        <Modal title="Discard unsaved access changes?" width={400} danger onClose={() => setConfirmDiscard(false)}
          foot={<><Button kind="secondary" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
                  <Button kind="danger" onClick={() => { setConfirmDiscard(false); setAccessDirty(false); setAccessFor(null); }}>Discard</Button></>}>
          <span />
        </Modal>
      )}
      {confirmDel && (
        <Modal title={`Delete dataset ${confirmDel.name}?`} width={400} danger onClose={() => setConfirmDel(null)}
          foot={<><Button kind="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
                  <Button kind="danger" onClick={() => doRemove(confirmDel)}>Delete</Button></>}>
          <span />
        </Modal>
      )}
    </div>
  );
}

function DatasetEditor({ original, datasources, initialDatasourceId, onClose, onSaved }: {
  original: DatasetDef | null; datasources: Datasource[]; initialDatasourceId?: string; onClose: () => void;
  /** Called with the saved dataset, which then stays open */
  onSaved: (saved: DatasetDef | null) => void;
}) {
  const { can } = usePerms();
  const toast = useToast();
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [folder, setFolder] = useState(original?.folder ?? "");
  const [datasourceId, setDatasourceId] = useState(original?.datasourceId ?? initialDatasourceId ?? "");
  const [sql, setSql] = useState(original?.sqlText ?? "SELECT region, fiscal_year, target, sales, profit\nFROM fact");
  const [dimCols, setDimCols] = useState(original?.dimensionColumns ?? "");
  const [preview, setPreview] = useState<TableResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const { me } = usePerms();
  const isAdmin = !!me && (me.admin || me.role === "ADMIN");

  async function runPreview() {
    if (!isAdmin && !datasourceId) { toast("Choose a datasource first", "error"); return; }
    setRunning(true);
    try {
      const res = await api.previewDataset({ datasourceId: datasourceId || null, sql, datasetId: original?.id ?? null });
      setPreview(res);
      toast(`Preview OK · ${res.rowCount} rows`, "ok");
    } catch (e) {
      setPreview(null);
      toast(e instanceof Error ? e.message : "Preview failed", "error");
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description, folder: folder.trim() || null,
        datasourceId: datasourceId || null, sqlText: sql, dimensionColumns: dimCols.trim() || null };
      const saved = original ? await api.updateDataset(original.id, body) : await api.createDataset(body);
      toast("Dataset saved", "ok");
      onSaved(saved && typeof saved === "object" && "id" in saved ? saved as DatasetDef : null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
      setSaving(false);
    }
  }

  return (
    <div className={cx.pane}>
      <div className={cx.paneHead}>
        <h2 className="cds--type-heading-03" style={{ margin: 0, flex: 1, minWidth: 0 }}>{original ? `Edit dataset · ${original.name}` : "New dataset"}</h2>
        {original && <AccessButton type="DATASET" id={original.id} name={original.name} ghost />}
        <Button kind="ghost" size="sm" renderIcon={Close} onClick={onClose}>Close</Button>
      </div>
      <div className={cx.grid3}>
        <TextInput id="ds-name" labelText="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Records by region" />
        <TextInput id="ds-desc" labelText="Description" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} />
        <TextInput id="ds-dimcols" labelText="Numeric columns to group by" helperText="comma-separated · numeric columns are otherwise measures"
                   className="rh-mono" value={dimCols} onChange={(e) => setDimCols(e.target.value)} placeholder="<column>, <column>" />
        <TextInput id="ds-folder" labelText="Folder" helperText="blank = ungrouped" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Sales" />
        <Select label="Datasource" value={datasourceId} onChange={setDatasourceId} placeholder="Internal warehouse"
                options={[...(isAdmin ? [{ value: "", label: "Report Studio internal database" }] : []),
                          ...datasources.map((x) => ({ value: x.id, label: `${x.name}${x.hasJdbc ? " · live JDBC" : ""}` }))]} />
      </div>
      <div>
        <div className={cx.labelRow}>
          <span className="cds--label" style={{ margin: 0 }}>SQL query (SELECT only)</span>
          <span className="cds--type-label-01 rh-dim">single statement · preview limited to 200 rows</span>
        </div>
        <SqlEditor value={sql} onChange={setSql} height={242}
                   placeholder={"SELECT branch_code, branch_name, amount\nFROM fact\nWHERE fiscal_year = 2026"} />
      </div>
      <div style={{ display: "flex", gap: 1 }}>
        <Button kind="secondary" renderIcon={Play} disabled={running} onClick={runPreview}>Preview</Button>
        {can("RH.DATASET", "update") && (<Button kind="primary" renderIcon={Checkmark} disabled={saving} onClick={save}>Save dataset</Button>)}
      </div>

      {preview && (
        <div className={cx.result}>
          <div className={cx.resultHead}>
            <Icon name="table" size={16} /><span className="cds--type-heading-compact-01">Preview</span>
            <span className="rh-dim" style={{ marginLeft: "auto" }}>{preview.rowCount} rows · {preview.columns.length} columns</span>
          </div>
          <div className={cx.scroll} style={{ maxHeight: 320 }}>
            <table className={"cds--data-table cds--data-table--sm " + cx.table}>
              <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? `${cx.num} ${cx.mono}` : ""}>{v === null ? "—" : String(v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
