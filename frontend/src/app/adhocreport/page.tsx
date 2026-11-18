"use client";

/**
 * Ad-hoc Report — write your own query, run it against a live datasource, then save and reuse it
 * (SELECT / INSERT / UPDATE / DELETE / MERGE).
 *
 * The localStorage keys and the run-log source value still say "sqleditor" on purpose: renaming
 * them would lose users' remembered settings and split old run history from new.
 *
 * Same layout as Data Pipeline / Data Checks: a left index (.ops-nav) and a work area on the right.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, FileUploaderDropContainer, IconButton, Menu, MenuItem, MenuItemDivider, Search, TextInput } from "@carbon/react";
import { Add, Download, Edit, FolderAdd, OverflowMenuVertical, Renew, SidePanelClose, SidePanelOpen, TrashCan, Upload } from "@carbon/icons-react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/overlays";
import cx from "@/components/D/d.module.scss";
import { buildFolderTree, inFolder, repath, type FolderTreeNode } from "@/lib/foldertree";
import { useToast } from "@/components/Toast";
import { SqlRunner } from "@/components/SqlRunner";
import { api } from "@/lib/api";
import type { Datasource, SavedViewRow } from "@/lib/types";

const DS_KEY = "rs.sqleditor.datasourceId";
const NAV_KEY = "rs.sqleditor.navOpen";
const FOLDERS_KEY = "rs.sqleditor.emptyFolders";

/** Script open in the editor. id = the saved script being edited (so Save overwrites it);
 *  null = new and unsaved (e.g. just imported from a file). */
interface Opened { id: number | null; name: string; sql: string; datasourceId: string }

export default function SqlEditorPage() {
  const toast = useToast();
  const [dss, setDss] = useState<Datasource[]>([]);
  const [datasourceId, setDatasourceId] = useState("");
  const [saved, setSaved] = useState<SavedViewRow[]>([]);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  /** Left pane collapsed — separate key from Tables so each is remembered (read in an effect, not during render). */
  const [navOpen, setNavOpen] = useState(true);
  useEffect(() => { setNavOpen(localStorage.getItem(NAV_KEY) !== "0"); }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((v) => { localStorage.setItem(NAV_KEY, v ? "0" : "1"); return !v; });
  }, []);
  /** Collapsed folders — stored by name, not index, since the list can reorder. */
  const [closedFolders, setClosedFolders] = useState<Set<string>>(new Set());
  const toggleFolder = (name: string) => setClosedFolders((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const reloadSaved = useCallback(() => {
    api.savedViews("sql").then(setSaved).catch(() => setSaved([]));
  }, []);

  useEffect(() => {
    api.datasources()
      .then((list) => {
        setDss(list);
        // Remember the last connection — most people stay on one datasource all day.
        // Read localStorage here, not during render (the screen is also server-rendered).
        const last = localStorage.getItem(DS_KEY);
        const usable = list.find((d) => d.isDefault)?.id
          ?? (last && list.some((d) => d.id === last) ? last : null) ?? list[0]?.id ?? "";
        setDatasourceId((cur) => cur || usable);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    reloadSaved();
  }, [reloadSaved]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return saved
      .filter((v) => !s || `${v.name} ${v.folder ?? ""}`.toLowerCase().includes(s))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [saved, q]);

  /** Newly created folders with no scripts yet. A folder is only a name on the script
   *  (saved_view.folder), so an empty folder exists only on screen until something is dropped in. */
  const [draftFolders, setDraftFolders] = useState<string[]>([]);
  // Empty folders are kept (per browser) until the user removes them — they must not vanish
  // on reload or when their last script is deleted / moved out.
  const draftsLoaded = useRef(false);
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "[]"); if (Array.isArray(v)) setDraftFolders(v.filter((x) => typeof x === "string")); } catch { /* ignore */ }
    draftsLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!draftsLoaded.current) return;
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(draftFolders)); } catch { /* ignore */ }
  }, [draftFolders]);
  const keepFolder = (f: string | null | undefined) => {
    const k = (f ?? "").trim();
    if (k) setDraftFolders((c) => (c.includes(k) ? c : [...c, k]));
  };
  /** Script awaiting delete confirmation. */
  const [confirmDel, setConfirmDel] = useState<SavedViewRow | null>(null);
  const [deletedId, setDeletedId] = useState<number | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, SavedViewRow[]>();
    // New empty folders must show immediately
    for (const f of draftFolders) if (!m.has(f)) m.set(f, []);
    for (const v of shown) {
      const k = (v.folder ?? "").trim();
      m.set(k, [...(m.get(k) ?? []), v]);
    }
    // Ungrouped ("") always last
    return [...m.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])));
  }, [shown, draftFolders]);

  /** Folder tree — a "/" in a folder name makes a sub-level, same as Data Pipeline. */
  const tree = useMemo(() => buildFolderTree<SavedViewRow>(groups), [groups]);

  function open(v: SavedViewRow) {
    try {
      const p = JSON.parse(v.payload) as { datasourceId?: string; sql?: string };
      setOpened({ id: v.id, name: v.name, sql: p.sql ?? "", datasourceId: p.datasourceId ?? datasourceId });
      if (p.datasourceId) setDatasourceId(p.datasourceId);
    } catch {
      // A broken payload must not hang the screen — say so plainly
      toast(`Cannot open "${v.name}" — the saved content is not readable JSON`, "error");
    }
  }

  /** Script being renamed inline — null = none. */
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);

  /** Inline rename — empty or unchanged name skips the backend call. */
  async function commitRename() {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const name = r.value.trim();
    const cur = saved.find((v) => v.id === r.id);
    if (!cur || !name || name === cur.name) return;
    try {
      await api.updateView(r.id, { name });
      // Keep the open script's header in sync
      setOpened((o) => (o && o.id === r.id ? { ...o, name } : o));
      reloadSaved();
      toast(`Renamed to "${name}"`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Rename failed", "error"); }
  }

  /** Download the script as a .sql file (to keep, share, or commit). */
  function exportSql(v: SavedViewRow) {
    let sql = "";
    try { sql = (JSON.parse(v.payload) as { sql?: string }).sql ?? ""; } catch { /* broken payload = empty file */ }
    // Strip characters file systems reject
    const safe = v.name.replace(/[\\/:*?"<>|]/g, "_").trim() || `script-${v.id}`;
    const blob = new Blob(["\uFEFF" + sql], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safe}.sql`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Import a .sql file as a new script — opened in the editor, not saved until Save. */
  function importSql(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "").replace(/^\uFEFF/, "");
      const name = file.name.replace(/\.(sql|txt)$/i, "");
      setOpened({ id: null, name, sql: text, datasourceId });
      toast(`Imported "${file.name}" — press Save to keep it as a script`, "ok");
    };
    reader.onerror = () => toast("Could not read the file", "error");
    reader.readAsText(file, "utf-8");
  }

  /** Folder name being typed — old=null creates, old=name renames. */
  const [editFolder, setEditFolder] = useState<{ old: string | null; value: string } | null>(null);
  /** Script being dragged + folder under the pointer (drop-target highlight). */
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  /** First click on delete asks, second click deletes (no browser confirm). */
  const [confirmDelFolder, setConfirmDelFolder] = useState<string | null>(null);

  /** Script context menu — move folder / toggle private-public / delete. */
  const [menu, setMenu] = useState<{ x: number; y: number; v: SavedViewRow } | null>(null);
  /** Script a new folder name is being typed for (null = none). */
  const [newFolderFor, setNewFolderFor] = useState<SavedViewRow | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [importing, setImporting] = useState(false);

  /**
   * Folder names offered in the "Move to folder" menu — includes new empty folders, which no
   * script carries yet, so they would otherwise be reachable only by drag-and-drop.
   */
  const folderNames = useMemo(
    () => [...new Set([...saved.map((v) => (v.folder ?? "").trim()), ...draftFolders])]
      .filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [saved, draftFolders]);

  async function moveTo(v: SavedViewRow, folder: string | null) {
    keepFolder(v.folder);
    // Show the move at once; the reload confirms it
    setSaved((cur) => cur.map((x) => (x.id === v.id ? { ...x, folder } : x)));
    try {
      await api.moveView(v.id, folder);
      reloadSaved();
      toast(folder ? `Moved "${v.name}" to "${folder}"` : `Removed "${v.name}" from its folder`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Move failed", "error"); }
  }

  async function toggleVisibility(v: SavedViewRow) {
    try {
      await api.setViewVisibility(v.id, !v.isPublic);
      reloadSaved();
      toast(v.isPublic ? `"${v.name}" is now private` : `"${v.name}" is now visible to everyone`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Change failed", "error"); }
  }

  /** Renaming a folder moves every script in it to the new name (there is no folder table). */
  async function commitFolderEdit() {
    const e = editFolder;
    setEditFolder(null);
    if (!e) return;
    const name = e.value.trim();
    if (!name || name === e.old) return;
    if (e.old === null) {
      // New: nothing inside yet — keep it on screen until a script is dropped in
      if (!folderNames.includes(name) && !draftFolders.includes(name)) setDraftFolders((c) => [...c, name]);
      return;
    }
    // Renaming moves the whole subtree, not just this level
    const members = saved.filter((v) => inFolder(v.folder, e.old!));
    try {
      await Promise.all(members.map((v) => api.moveView(v.id, repath(v.folder, e.old!, name))));
      setDraftFolders((c) => [...c.filter((f) => !inFolder(f, e.old!)), name]);
      reloadSaved();
      toast(`Renamed to "${name}" (${members.length} items)`, "ok");
    } catch (err) { toast(err instanceof Error ? err.message : "Rename failed", "error"); }
  }

  /** Deleting a folder moves its scripts to the top level; no script is lost. */
  async function removeFolder(name: string) {
    const members = saved.filter((v) => inFolder(v.folder, name));
    try {
      await Promise.all(members.map((v) => api.moveView(v.id, null)));
      setDraftFolders((c) => c.filter((f) => !inFolder(f, name)));
      setConfirmDelFolder(null);
      reloadSaved();
      toast(members.length ? `Folder removed — ${members.length} items moved out` : "Folder removed", "ok");
    } catch (err) { toast(err instanceof Error ? err.message : "Delete failed", "error"); }
  }

  async function remove(v: SavedViewRow) {
    keepFolder(v.folder);
    try {
      await api.deleteView(v.id);
      setSaved((cur) => cur.filter((x) => x.id !== v.id));
      if (opened?.id === v.id) setOpened(null);
      setDeletedId(v.id);
      reloadSaved();
      toast(`Deleted "${v.name}"`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
  }

  /** One script row, indented by folder depth. */
  function renderScript(v: SavedViewRow, depth: number) {
    // Renaming turns the row into an inline input, no dialog
    if (renaming?.id === v.id) {
      return (
        <div key={v.id} className="rh-nt-item rh-nt--editing" style={{ paddingLeft: 10 + depth * 13 }}>
          <Icon name="doc" size={13} className="rh-nt-ico" />
          <TextInput id={`sql-ren-${v.id}`} size="sm" hideLabel labelText="Script name" autoFocus value={renaming.value}
                 onChange={(e) => setRenaming({ id: v.id, value: e.target.value })}
                 onBlur={commitRename}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                   if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                 }} />
        </div>
      );
    }
    return (
      <div key={v.id} className={"rh-nt-item" + (opened?.id === v.id ? " rh-nt--on" : "") + (dragId === v.id ? " rh-nt--dragging" : "")}
           role="button" tabIndex={0} style={{ cursor: "pointer", paddingLeft: 10 + depth * 13 }}
           draggable
           onDragStart={(e) => {
             e.stopPropagation();
             e.dataTransfer.effectAllowed = "move";
             e.dataTransfer.setData("text/plain", String(v.id));
             setDragId(v.id);
           }}
           onDragEnd={() => { setDragId(null); setDropOn(null); }}
           onClick={() => open(v)}
           onDoubleClick={(e) => { e.stopPropagation(); setRenaming({ id: v.id, value: v.name }); }}
           onKeyDown={(e) => {
             if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(v); }
             if (e.key === "F2") { e.preventDefault(); setRenaming({ id: v.id, value: v.name }); }
           }}
           onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, v }); }}
           title={`${v.name}${v.createdBy ? ` · ${v.createdBy}` : ""}${v.isPublic ? " · everyone" : " · only me"}\nDouble-click to rename`}>
        <Icon name="doc" size={13} className="rh-nt-ico" />
        <span className="rh-nt-text">{v.name}</span>
        {/* Globe = visible to others; none = private */}
        {v.isPublic && <Icon name="globe" size={11} className="rh-nt-pub" />}
        <span className="rh-nt-acts" onClick={(e) => e.stopPropagation()}>
          <IconButton kind="ghost" size="sm" className="rh-nt-cog" label="Rename (or double-click the name)" align="left"
                      onClick={() => setRenaming({ id: v.id, value: v.name })}><Edit /></IconButton>
          <IconButton kind="ghost" size="sm" className="rh-nt-cog" label="Save as .sql file" align="left" onClick={() => exportSql(v)}>
            <Download />
          </IconButton>
          <IconButton kind="ghost" size="sm" className="rh-nt-cog" label="Options" align="left"
                      onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, v })}><OverflowMenuVertical /></IconButton>
        </span>
      </div>
    );
  }

  /** One folder level, recursing into sub-folders. */
  function renderFolders(nodes: FolderTreeNode<SavedViewRow>[], depth: number) {
    return nodes.map((n) => {
      // While searching, expand every folder so matches are not hidden
      const folderOpen = q.trim() ? true : !closedFolders.has(n.path);
      return (
        <div key={n.path}
             onDragOver={(e) => { if (dragId != null) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; setDropOn(n.path); } }}
             onDrop={(e) => {
               if (dragId == null) return;
               e.preventDefault(); e.stopPropagation();
               const v = saved.find((x) => x.id === dragId);
               setDragId(null); setDropOn(null);
               if (v && (v.folder ?? "") !== n.path) moveTo(v, n.path);
             }}>
          {editFolder?.old === n.path ? (
            <div className="rh-nt-fold rh-nt--editing" style={{ paddingLeft: 8 + depth * 13 }}>
              <span style={{ width: 11, flex: "none" }} />
              <Icon name="folder" size={13} className="rh-nt-fico" />
              <TextInput id={`sql-fold-${editFolder.old ?? "new"}`} size="sm" hideLabel labelText="Folder name" autoFocus onFocus={(e) => e.currentTarget.select()} value={editFolder.value} placeholder="Folder name"
                     onChange={(e) => setEditFolder({ old: n.path, value: e.target.value })}
                     onBlur={commitFolderEdit}
                     onKeyDown={(e) => {
                       if (e.key === "Enter") { e.preventDefault(); commitFolderEdit(); }
                       if (e.key === "Escape") { e.preventDefault(); setEditFolder(null); }
                     }} />
            </div>
          ) : (
            <div className={"rh-nt-fold" + (folderOpen ? "" : " rh-nt--shut") + (dropOn === n.path ? " rh-nt--drop" : "")}
                 role="button" tabIndex={0} style={{ paddingLeft: 8 + depth * 13 }}
                 onClick={() => toggleFolder(n.path)}
                 onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFolder(n.path); } }}
                 onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setEditFolder({ old: n.path, value: n.path }); }}
                 title={`${n.path}\nDouble-click to rename · drop a script here to move it into this folder`}>
              <Icon name="chevron" size={11} className="rh-nt-caret" />
              <Icon name={folderOpen ? "folderOpen" : "folder"} size={13} className="rh-nt-fico" />
              <span className="rh-nt-name"
                    onDoubleClick={(e) => { e.stopPropagation(); setEditFolder({ old: n.path, value: n.path }); }}>{n.label}</span>
              <span className="rh-nt-count">{n.total}</span>
              <span className="rh-nt-acts" onClick={(e) => e.stopPropagation()}>
                {confirmDelFolder === n.path
                  ? <Button kind="danger" size="sm" title="Click again to remove — scripts inside are moved out, not deleted"
                            onClick={() => removeFolder(n.path)}>Remove?</Button>
                  : <IconButton kind="ghost" size="sm" label="Remove this folder" align="left"
                                onClick={() => setConfirmDelFolder(n.path)}><TrashCan /></IconButton>}
              </span>
            </div>
          )}
          {folderOpen && (
            <>
              {renderFolders(n.kids, depth + 1)}
              {n.items.map((v) => renderScript(v, depth + 1))}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <div className="fade-in">
      {/* All editor actions live in one toolbar above the editor; New script stays at the top of the left pane. */}
      <div className={"rh-ops rh-fill" + (navOpen ? "" : " rh-ops--rail-off")}>
        {/* Collapsible left pane, like Tables — long scripts need the room */}
        {!navOpen && (
          <aside className="rh-ops__nav rh-ops__nav--collapsed">
            <IconButton kind="ghost" size="sm" label="Show script list" align="right" onClick={toggleNav}>
              <SidePanelOpen />
            </IconButton>
          </aside>
        )}
        <aside className="rh-ops__nav" hidden={!navOpen}>
          <div className={cx.railHead}>
            <Search size="md" labelText="Find a script" placeholder="Find a script" value={q}
                    onChange={(e) => setQ(e.target.value)} onClear={() => setQ("")} />
            <IconButton kind="ghost" size="md" label="Hide script list" align="left" onClick={toggleNav}>
              <SidePanelClose />
            </IconButton>
          </div>

          {/* Toolbar like the Tables left pane — new folder / new script */}
          <div className={cx.railTools} style={{ justifyContent: "flex-start" }}>
            <Button kind="ghost" size="sm" renderIcon={Add} isSelected={opened === null} onClick={() => setOpened(null)}
                    title="Start a new blank script">New script</Button>
            <span style={{ flex: 1 }} />
            {/* Import a .sql file — opened in the editor, not saved until Save */}
            <IconButton kind="ghost" size="sm" label="Import .sql file" align="left" onClick={() => setImporting(true)}>
              <Upload />
            </IconButton>
            <IconButton kind="ghost" size="sm" label="New folder" align="left"
                        onClick={() => setEditFolder({ old: null, value: "" })}>
              <FolderAdd />
            </IconButton>
          </div>

          {/* New folder name input — top of the list, like Tables */}
          {editFolder?.old === null && (
            <div className="rh-nt-fold rh-nt--editing" style={{ paddingLeft: 8 }}>
              <span style={{ width: 11, flex: "none" }} />
              <Icon name="folder" size={13} className="rh-nt-fico" />
              <TextInput id={`sql-fold-${editFolder.old ?? "new"}`} size="sm" hideLabel labelText="Folder name" autoFocus onFocus={(e) => e.currentTarget.select()} value={editFolder.value} placeholder="Folder name"
                     onChange={(e) => setEditFolder({ old: null, value: e.target.value })}
                     onBlur={commitFolderEdit}
                     onKeyDown={(e) => {
                       if (e.key === "Enter") { e.preventDefault(); commitFolderEdit(); }
                       if (e.key === "Escape") { e.preventDefault(); setEditFolder(null); }
                     }} />
            </div>
          )}

          {/* Root drop zone — drop a script on empty space to take it out of its folder */}
          <div style={{ display: "contents" }}
               onDragOver={(e) => { if (dragId != null) { e.preventDefault(); setDropOn(null); } }}
               onDrop={(e) => {
                 if (dragId == null) return;
                 e.preventDefault();
                 const v = saved.find((x) => x.id === dragId);
                 setDragId(null); setDropOn(null);
                 if (v && (v.folder ?? "")) moveTo(v, null);
               }}>

          {renderFolders(tree.roots, 0)}
          {tree.loose.map((v) => renderScript(v, 0))}
          </div>

          <div className={cx.railFoot}>
            {loading ? "" : `${saved.length} saved script${saved.length === 1 ? "" : "s"}`}
            <IconButton kind="ghost" size="sm" label="Reload" align="top" onClick={reloadSaved}>
              <Renew />
            </IconButton>
          </div>
        </aside>

        {/* Script menu. Folders are just names stored on scripts (saved_view.folder): creating one means
            typing a new name, and a folder disappears once its last script moves out. */}
        {menu && (
          <Menu open label={menu.v.name} x={menu.x} y={menu.y} size="sm" onClose={() => setMenu(null)}>
            <MenuItem label="Rename" onClick={() => { const v = menu.v; setMenu(null); setRenaming({ id: v.id, value: v.name }); }} />
            <MenuItem label="Save as .sql file" onClick={() => { const v = menu.v; setMenu(null); exportSql(v); }} />
            <MenuItem label={menu.v.isPublic ? "Make private (only me)" : "Share with everyone"}
                      onClick={() => { const v = menu.v; setMenu(null); toggleVisibility(v); }} />
            <MenuItemDivider />
            <MenuItem label="Move to folder">
              <MenuItem label="Ungrouped" onClick={() => { const v = menu.v; setMenu(null); moveTo(v, null); }} />
              {folderNames.filter((f) => f !== (menu.v.folder ?? "")).map((f) => (
                <MenuItem key={f} label={f} onClick={() => { const v = menu.v; setMenu(null); moveTo(v, f); }} />
              ))}
              <MenuItemDivider />
              <MenuItem label="New folder…" onClick={() => { const v = menu.v; setMenu(null); setFolderDraft(""); setNewFolderFor(v); }} />
            </MenuItem>
            <MenuItemDivider />
            <MenuItem kind="danger" label="Delete this script" onClick={() => { const v = menu.v; setMenu(null); setConfirmDel(v); }} />
          </Menu>
        )}
        {newFolderFor && (
          <Modal title="Move to a new folder" sub={newFolderFor.name} width={400} onClose={() => setNewFolderFor(null)}
                 foot={<><Button kind="secondary" onClick={() => setNewFolderFor(null)}>Cancel</Button>
                         <Button kind="primary" disabled={!folderDraft.trim()} onClick={() => {
                           const v = newFolderFor, f = folderDraft.trim();
                           setNewFolderFor(null); setFolderDraft(""); moveTo(v, f);
                         }}>Move</Button></>}>
            <TextInput id="sql-new-folder" labelText="New folder name" autoFocus value={folderDraft}
                       onChange={(e) => setFolderDraft(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key !== "Enter" || !folderDraft.trim()) return;
                         const v = newFolderFor, f = folderDraft.trim();
                         setNewFolderFor(null); setFolderDraft(""); moveTo(v, f);
                       }} />
          </Modal>
        )}
        {confirmDel && (
          <Modal danger title={`Delete "${confirmDel.name}"?`} sub="Delete script" width={440} onClose={() => setConfirmDel(null)}
                 foot={<><Button kind="secondary" onClick={() => setConfirmDel(null)}>Cancel</Button>
                         <Button kind="danger" data-modal-primary-focus onClick={() => { const v = confirmDel; setConfirmDel(null); remove(v); }}>Delete</Button></>}>
            <p className="cds--type-body-01">This cannot be undone.</p>
          </Modal>
        )}
        {importing && (
          <Modal title="Import .sql file" width={480} onClose={() => setImporting(false)}>
            <FileUploaderDropContainer accept={[".sql", ".txt", "text/plain"]} labelText="Drag and drop a .sql file here or click to upload"
              onAddFiles={(_e, { addedFiles }) => { const f = addedFiles?.[0]; if (f) { importSql(f); setImporting(false); } }} />
          </Modal>
        )}

        <div className={"sqlpane " + cx.main}>
          {/* Keyed by script name — opening another must remount so the editor SQL changes */}
          <SqlRunner key={opened?.name ?? "__blank__"} datasourceId={datasourceId} toast={toast}
                     seed={opened?.sql ?? ""} openedName={opened?.name ?? null} openedId={opened?.id ?? null}
                     onSavedChanged={reloadSaved} deletedId={deletedId}
                     datasources={dss}
                     onDatasource={(v) => { setDatasourceId(v); localStorage.setItem(DS_KEY, v); }} />
        </div>
      </div>
    </div>
  );
}
