"use client";

// Workspace + folder organization shared by Ad-hoc, Workbench and Dashboards,
// plus the saved-view "data product" menu (CSV / Excel / JSON exports + public API URL).
import { copyText } from "@/lib/clipboard";
import { useCallback, useEffect, useState } from "react";
import { Button, ComboBox, OverflowMenu, OverflowMenuItem, TextInput } from "@carbon/react";
import { Folder, FolderOpen, Link as LinkIcon, StarFilled } from "@carbon/icons-react";
import { Modal } from "@/components/overlays";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import { api, publicViewUrl } from "@/lib/api";
import type { SavedViewRow, Workspace } from "@/lib/types";

const WS_KEY = "rs.workspace";

/** Last-picked workspace id, shared across Ad-hoc / Workbench / Dashboards (0 = all). */
export function getSharedWorkspace(): number {
  if (typeof window === "undefined") return 0;
  return Number(window.localStorage.getItem(WS_KEY) ?? 0) || 0;
}

export function useSharedWorkspace(): [number, (id: number) => void] {
  const [ws, setWsState] = useState(0);
  useEffect(() => { setWsState(getSharedWorkspace()); }, []);
  const setWs = useCallback((id: number) => {
    setWsState(id);
    try { window.localStorage.setItem(WS_KEY, String(id)); } catch { /* private mode */ }
  }, []);
  return [ws, setWs];
}

export function useWorkspaces(): [Workspace[], () => void] {
  const [list, setList] = useState<Workspace[]>([]);
  const reload = useCallback(() => { api.workspaces().then(setList).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);
  return [list, reload];
}

/** Workspace dropdown + inline "new workspace". value 0 = all workspaces (when allowAll). */
export function WorkspacePicker({ value, onChange, allowAll, style }: {
  value: number;
  onChange: (id: number) => void;
  allowAll?: boolean;
  style?: React.CSSProperties;
}) {
  const toast = useToast();
  const [list, reload] = useWorkspaces();
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  async function create() {
    const name = newName.trim();
    if (!name) return;
    try {
      const w = await api.createWorkspace(name);
      reload();
      onChange(w.id);
      setNaming(false); setNewName("");
    } catch (e) { toast(e instanceof Error ? e.message : "Create failed", "error"); }
  }
  const options = [
    ...(allowAll ? [{ value: "0", label: "All workspaces" }] : []),
    ...list.map((w) => ({ value: String(w.id), label: w.name })),
    { value: "__new", label: "＋ New workspace…" },
  ];
  return (
    <>
    <Select
      style={style}
      value={String(value)}
      searchable={list.length > 8}
      options={options}
      onChange={async (v) => {
        if (v === "__new") { setNaming(true); return; }
        onChange(Number(v));
      }}
    />
    {naming && (
      <Modal title="New workspace" width={400} onClose={() => setNaming(false)}
             foot={<>
               <Button kind="secondary" onClick={() => setNaming(false)}>Cancel</Button>
               <Button kind="primary" disabled={!newName.trim()} onClick={create}>Create</Button>
             </>}>
        <TextInput id="ws-new-name" labelText="Workspace name" value={newName} autoFocus
                   onChange={(e) => setNewName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
      </Modal>
    )}
    </>
  );
}

export interface FolderGroup<T> { folder: string; items: T[] }

/** Group items by their folder path ("" = root, listed first). */
export function groupByFolder<T extends { folder: string | null }>(items: T[]): FolderGroup<T>[] {
  const map = new Map<string, T[]>();
  items.forEach((it) => {
    const f = (it.folder ?? "").trim();
    if (!map.has(f)) map.set(f, []);
    map.get(f)!.push(it);
  });
  return [...map.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, its]) => ({ folder, items: its }));
}

/** Collapsible folder header used by the saved-view & dashboard trees. */
export function FolderHead({ name, open, count, onToggle }: { name: string; open: boolean; count: number; onToggle: () => void }) {
  return (
    <div onClick={onToggle}
         style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", borderRadius: 0, cursor: "pointer", userSelect: "none" }}
         onMouseEnter={(e) => (e.currentTarget.style.background = "var(--cds-layer-hover-01)")}
         onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <Icon name={open ? "chevDown" : "chevron"} size={12} style={{ color: "var(--cds-icon-secondary)", flex: "none" }} />
      {open ? <FolderOpen size={14} style={{ flex: "none" }} /> : <Folder size={14} style={{ flex: "none" }} />}
      <span className="cds--type-label-01" style={{ fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      <span className="cds--type-label-01 rh-dim">{count}</span>
    </div>
  );
}

/** Saved views (pivot/ad-hoc) as a folder tree; each view has a data-product menu. */
export function SavedViewList({ views, onLoad, onChanged }: {
  views: SavedViewRow[];
  onLoad: (v: SavedViewRow) => void;
  onChanged: () => void;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const groups = groupByFolder(views);
  if (views.length === 0) {
    return <div className="cds--type-label-01 rh-dim" style={{ padding: "6px 9px" }}>Nothing in this workspace yet</div>;
  }
  return (
    <div>
      {groups.map((g) => (
        <div key={g.folder || "__root"}>
          {g.folder !== "" && (
            <FolderHead name={g.folder} count={g.items.length} open={!closed[g.folder]}
                        onToggle={() => setClosed((c) => ({ ...c, [g.folder]: !c[g.folder] }))} />
          )}
          {(g.folder === "" || !closed[g.folder]) && g.items.map((v) => (
            <ViewRow key={v.id} v={v} indent={g.folder !== ""} onLoad={onLoad} onChanged={onChanged} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ViewRow({ v, indent, onLoad, onChanged }: {
  v: SavedViewRow; indent: boolean; onLoad: (v: SavedViewRow) => void; onChanged: () => void;
}) {
  const toast = useToast();
  const router = useRouter();

  async function ensureToken(): Promise<string> {
    if (v.shareToken) return v.shareToken;
    const r = await api.shareView(v.id);
    onChanged();
    return r.shareToken!;
  }

  async function copyApiUrl(format: "csv" | "xlsx" | "json") {
    try {
      const token = await ensureToken();
      const url = publicViewUrl(token, format);
      await copyText(url);
      toast(`Public ${format.toUpperCase()} URL copied — anyone can pull this data`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Share failed", "error"); }
  }

  async function download(format: "csv" | "xlsx" | "json") {
    try {
      await api.exportView(v.id, format, `${v.name}.${format}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Export failed", "error"); }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 0 0 9px", paddingLeft: indent ? 28 : 9, cursor: "pointer" }}
         onMouseEnter={(e) => (e.currentTarget.style.background = "var(--cds-layer-hover-01)")}
         onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <StarFilled size={14} style={{ fill: "var(--cds-support-warning)", flex: "none" }} />
      <span onClick={() => onLoad(v)} className="cds--type-body-compact-01"
            style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {v.name}
      </span>
      {v.shareToken && <LinkIcon size={14} aria-label="Shared publicly" style={{ fill: "var(--cds-icon-interactive)", flex: "none" }} />}
      <OverflowMenu size="sm" flipped aria-label="View actions" iconDescription="View actions">
        <OverflowMenuItem itemText="Load into builder" onClick={() => onLoad(v)} />
        <OverflowMenuItem itemText="Use in a dashboard…" onClick={() => router.push(`/dashboards?addView=${v.kind}:${v.id}`)} />
        <OverflowMenuItem hasDivider itemText="Download CSV" onClick={() => download("csv")} />
        <OverflowMenuItem itemText="Download Excel" onClick={() => download("xlsx")} />
        <OverflowMenuItem itemText="Download JSON" onClick={() => download("json")} />
        <OverflowMenuItem hasDivider itemText="Copy API URL (JSON)" onClick={() => copyApiUrl("json")} />
        <OverflowMenuItem itemText="Copy API URL (CSV)" onClick={() => copyApiUrl("csv")} />
        {v.shareToken ? (
          <OverflowMenuItem itemText="Revoke public access" onClick={async () => {
            try { await api.unshareView(v.id); onChanged(); toast("Public access revoked", "ok"); }
            catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
          }} />
        ) : null}
        <OverflowMenuItem hasDivider isDelete itemText="Delete view" onClick={async () => {
          try { await api.deleteView(v.id); onChanged(); }
          catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
        }} />
      </OverflowMenu>
    </div>
  );
}

/** Shared "save into workspace/folder" fields for the save modals. */
export function SaveDestination({ workspaceId, setWorkspaceId, folder, setFolder, folders }: {
  workspaceId: number;
  setWorkspaceId: (id: number) => void;
  folder: string;
  setFolder: (f: string) => void;
  folders: string[];
}) {
  const uniq = [...new Set(folders.filter(Boolean))];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div>
        <div className="cds--label">Workspace</div>
        <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} />
      </div>
      {/* Free text with suggestions: a new folder is just a new name */}
      <ComboBox id="save-folder" titleText="Folder (optional)" placeholder="— root —" helperText="e.g. reports/2025"
                allowCustomValue items={uniq} selectedItem={folder || null}
                onChange={({ selectedItem, inputValue }: { selectedItem?: string | null; inputValue?: string | null }) =>
                  setFolder(selectedItem ?? inputValue ?? "")}
                onInputChange={(t: string) => setFolder(t ?? "")} />
    </div>
  );
}
