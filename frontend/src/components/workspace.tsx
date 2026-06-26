"use client";

// Workspace + folder organization shared by Ad-hoc, Workbench and Dashboards,
// plus the saved-view "data product" menu (CSV / Excel / JSON exports + public API URL).
import { useCallback, useEffect, useRef, useState } from "react";
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
  const options = [
    ...(allowAll ? [{ value: "0", label: "All workspaces" }] : []),
    ...list.map((w) => ({ value: String(w.id), label: w.name })),
    { value: "__new", label: "＋ New workspace…" },
  ];
  return (
    <Select
      style={style}
      value={String(value)}
      searchable={list.length > 8}
      options={options}
      onChange={async (v) => {
        if (v === "__new") {
          const name = window.prompt("Workspace name");
          if (!name?.trim()) return;
          try {
            const w = await api.createWorkspace(name.trim());
            reload();
            onChange(w.id);
          } catch (e) { toast(e instanceof Error ? e.message : "Create failed", "error"); }
          return;
        }
        onChange(Number(v));
      }}
    />
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
         style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", borderRadius: 7, cursor: "pointer", userSelect: "none" }}
         onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-3)")}
         onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <Icon name={open ? "chevDown" : "chevron"} size={12} style={{ color: "var(--ink-4)", flex: "none" }} />
      <Icon name="folder" size={13} style={{ color: "var(--amber)", flex: "none" }} />
      <span style={{ fontSize: 11.5, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      <span style={{ fontSize: 10, color: "var(--ink-4)" }}>{count}</span>
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
    return <div style={{ fontSize: 11.5, color: "var(--ink-4)", padding: "6px 9px" }}>None in this workspace yet</div>;
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

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
      await navigator.clipboard.writeText(url).catch(() => {});
      toast(`Public ${format.toUpperCase()} URL copied — anyone can pull this data`, "ok");
      setOpen(false);
    } catch (e) { toast(e instanceof Error ? e.message : "Share failed", "error"); }
  }

  async function download(format: "csv" | "xlsx" | "json") {
    try {
      await api.exportView(v.id, format, `${v.name}.${format}`);
      setOpen(false);
    } catch (e) { toast(e instanceof Error ? e.message : "Export failed", "error"); }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", paddingLeft: indent ? 28 : 9, borderRadius: 8, cursor: "pointer" }}
           onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-3)")}
           onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
        <Icon name="star" size={13} style={{ color: "var(--amber)", flex: "none" }} />
        <span onClick={() => onLoad(v)}
              style={{ fontSize: 12, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {v.name}
        </span>
        {v.shareToken && <Icon name="link" size={11} style={{ color: "var(--accent)", flex: "none" }} />}
        <Icon name="dots" size={14} style={{ color: "var(--ink-4)", cursor: "pointer", flex: "none" }}
              onClick={() => setOpen((o) => !o)} />
      </div>
      {open && (
        <div className="menu" style={{ top: 30, right: 4, minWidth: 215, zIndex: 30 }}>
          <div className="menu-item" onClick={() => { onLoad(v); setOpen(false); }}><Icon name="play" size={14} />Load into builder</div>
          <div className="menu-item" onClick={() => router.push(`/dashboards?addView=${v.kind}:${v.id}`)}><Icon name="grid" size={14} />Use in a dashboard…</div>
          <div className="menu-sep" />
          <div className="menu-item" onClick={() => download("csv")}><Icon name="download" size={14} />Download CSV</div>
          <div className="menu-item" onClick={() => download("xlsx")}><Icon name="download" size={14} />Download Excel</div>
          <div className="menu-item" onClick={() => download("json")}><Icon name="download" size={14} />Download JSON</div>
          <div className="menu-sep" />
          <div className="menu-item" onClick={() => copyApiUrl("json")}><Icon name="link" size={14} />Copy API URL (JSON)</div>
          <div className="menu-item" onClick={() => copyApiUrl("csv")}><Icon name="link" size={14} />Copy API URL (CSV)</div>
          {v.shareToken && (
            <div className="menu-item" onClick={async () => {
              try { await api.unshareView(v.id); onChanged(); setOpen(false); toast("Public access revoked", "ok"); }
              catch (e) { toast(e instanceof Error ? e.message : "Failed", "error"); }
            }}><Icon name="x" size={14} />Revoke public access</div>
          )}
          <div className="menu-sep" />
          <div className="menu-item" style={{ color: "var(--red)" }} onClick={async () => {
            try { await api.deleteView(v.id); onChanged(); setOpen(false); }
            catch (e) { toast(e instanceof Error ? e.message : "Delete failed", "error"); }
          }}><Icon name="x" size={14} />Delete view</div>
        </div>
      )}
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
      <div className="field"><label>Workspace</label>
        <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} /></div>
      <div className="field"><label>Folder <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>(optional, e.g. reports/2025)</span></label>
        <input className="input" list="folder-suggestions" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="— root —" />
        <datalist id="folder-suggestions">{uniq.map((f) => <option key={f} value={f} />)}</datalist>
      </div>
    </div>
  );
}
