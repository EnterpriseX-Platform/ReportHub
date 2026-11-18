"use client";

/**
 * Left-hand list rail shared by the Ops screens (Data Pipeline / Data Checks / Schedulers / Dashboards).
 *
 * The list stays on the left at all times and the right side shows the selected item, the same
 * layout as Tables / SQL Editor / Datasets. Swapping the whole screen for an editor
 * (`editing ? <Editor/> : <List/>`) lost the user's place in the list.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Checkbox, IconButton, Search, TreeNode, TreeView } from "@carbon/react";
import { Add, Folder, FolderOpen, SidePanelClose, SidePanelOpen } from "@carbon/icons-react";
import { Icon, carbonIcon } from "@/components/Icon";
import css from "@/components/P/ops.module.scss";

export interface OpsNavItem {
  id: number | string;
  name: string;
  folder?: string | null;
  /** Colored dot before the item — Checks uses it to flag failing groups */
  mark?: string;
  /** Text at the right of the row, e.g. "Failed" / "Disabled" */
  badge?: ReactNode;
  badgeColor?: string;
  title?: string;
  /** Extra search text beyond name+folder — Checks adds its member check names
   *  so typing a check name finds the group it belongs to (the rail shows groups only) */
  search?: string;
  /** Row icon, as on the SQL Editor screen, instead of a dot;
   *  its color comes from mark so it still conveys status */
  icon?: string;
}

/** One level of the folder tree drawn by the rail */
interface FolderNode {
  /** Full folder path, e.g. "ETL/Stage 5B" — also the key for remembering collapse state */
  path: string;
  /** Name of this level only */
  label: string;
  items: OpsNavItem[];
  kids: FolderNode[];
  /** Item count across all sub-levels */
  total: number;
}

export function OpsPanel({
  items, selectedId, onSelect, navOpen, onToggleNav,
  placeholder, addLabel, onAdd, foot, tools, onItemContextMenu, emptyText,
  folderAction, itemAction, picked, onPick, query, onQuery, storageKey,
}: {
  items: OpsNavItem[];
  selectedId: number | string | null;
  onSelect: (item: OpsNavItem) => void;
  navOpen: boolean;
  onToggleNav: () => void;
  placeholder: string;
  addLabel?: string;
  onAdd?: () => void;
  foot: ReactNode;
  /** Extra buttons on the toolbar row (e.g. "Run group") */
  tools?: ReactNode;
  onItemContextMenu?: (e: React.MouseEvent, item: OpsNavItem) => void;
  emptyText?: string;
  /** Per-group button, e.g. "Run group" on Data Checks — omitted means no button */
  folderAction?: (folder: string) => ReactNode;
  /** Per-row buttons — shown only on hover/selected row (CSS `.ops-nav .it .acts`)
   *  so rows stay uncluttered while scanning */
  itemAction?: (item: OpsNavItem) => ReactNode;
  /** Show a checkbox per row, for screens that can act on several items at once */
  picked?: Set<number | string>;
  onPick?: (id: number | string, on: boolean) => void;
  /** Controlled search term — omitted means it is kept internally */
  query?: string;
  onQuery?: (v: string) => void;
  /** Key for remembering collapsed folders — omitted means not remembered */
  storageKey?: string;
}) {
  const [ownQ, setOwnQ] = useState("");
  /** Row extras (checkbox, badge, buttons) go through TreeNode's renderIcon slot, NOT the label:
   *  Carbon wraps a truncated label in a tooltip <button>, and buttons nested in it are invalid HTML
   *  (hydration error). Slot components are cached per key so rows don't remount on every render. */
  const slotContent = useRef(new Map<string, () => ReactNode>());
  const slotCache = useRef(new Map<string, React.ComponentType>());
  const slot = (key: string, render: () => ReactNode) => {
    slotContent.current.set(key, render);
    let C = slotCache.current.get(key);
    if (!C) {
      C = function OpsSlot() { return <>{slotContent.current.get(key)?.()}</>; };
      slotCache.current.set(key, C);
    }
    return C;
  };
  const q = query ?? ownQ;
  const setQ = onQuery ?? setOwnQ;
  /** Collapsed folders — stored by name, not index, since the list can reorder on every load.
   *  localStorage is read in an effect, not during render: these screens also render on the server
   *  and reading during render would cause a hydration mismatch */
  const [shut, setShut] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setShut(new Set(JSON.parse(raw) as string[]));
    } catch { /* corrupt stored value = start fully expanded */ }
  }, [storageKey]);

  const toggleFolder = useCallback((name: string) => {
    setShut((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* storage full: ignore */ } }
      return next;
    });
  }, [storageKey]);

  /** Selecting an item inside a collapsed folder expands that folder (and remembers it).
   *  Don't force it open during render — that would make a folder containing the selected item
   *  impossible to collapse */
  const selectedFolderName = (items.find((it) => it.id === selectedId)?.folder ?? "").trim();
  useEffect(() => {
    if (!selectedFolderName) return;
    setShut((prev) => {
      if (!prev.has(selectedFolderName)) return prev;
      const next = new Set(prev);
      next.delete(selectedFolderName);
      if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* storage full: ignore */ } }
      return next;
    });
  }, [selectedFolderName, storageKey]);

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const shown = items.filter((it) => !s || (it.search ?? `${it.name} ${it.folder ?? ""}`).toLowerCase().includes(s));
    const m = new Map<string, OpsNavItem[]>();
    for (const it of shown) {
      const k = (it.folder ?? "").trim();
      m.set(k, [...(m.get(k) ?? []), it]);
    }
    // The ungrouped bucket (blank name) always goes last
    return [...m.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0], "th")));
  }, [items, q]);

  /**
   * Folder tree — a group name containing "/" is a sub-level, e.g. "ETL/Stage 5B".
   *
   * <p>Sub-levels come purely from group names, so large groups can be organized hierarchically
   * without a separate folder table.
   */
  const tree = useMemo(() => {
    const root: FolderNode = { path: "", label: "", items: [], kids: [], total: 0 };
    const find = (parent: FolderNode, label: string): FolderNode => {
      const path = parent.path ? `${parent.path}/${label}` : label;
      let n = parent.kids.find((k) => k.path === path);
      if (!n) { n = { path, label, items: [], kids: [], total: 0 }; parent.kids.push(n); }
      return n;
    };
    for (const [folder, list] of groups) {
      if (!folder) { root.items.push(...list); continue; }
      let cur = root;
      for (const seg of folder.split("/").map((x) => x.trim()).filter(Boolean)) cur = find(cur, seg);
      cur.items.push(...list);
    }
    const count = (n: FolderNode): number => (n.total = n.items.length + n.kids.reduce((a, k) => a + count(k), 0));
    const sort = (n: FolderNode) => { n.kids.sort((a, b) => a.label.localeCompare(b.label, "th", { numeric: true })); n.kids.forEach(sort); };
    root.kids.forEach(count); sort(root);
    return root;
  }, [groups]);

  if (!navOpen) {
    return (
      <aside className={"rh-ops__nav rh-ops__nav--collapsed"}>
        <IconButton kind="ghost" size="sm" label="Show list" align="right" onClick={onToggleNav}>
          <SidePanelOpen />
        </IconButton>
      </aside>
    );
  }

  const total = items.length;
  const matched = groups.reduce((n, [, l]) => n + l.length, 0);
  const itemKey = (id: number | string) => `i:${id}`;
  const byKey = new Map(items.map((it) => [itemKey(it.id), it]));
  /** Stops a click / key inside a row's own controls from selecting the row */
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  /** One item in the tree */
  function renderItem(it: OpsNavItem) {
    const ico = it.icon ? carbonIcon(it.icon) : undefined;
    const key = itemKey(it.id);
    const Slot = slot(key, () => (
      <>
        <span className={css.lead} onContextMenu={onItemContextMenu ? (e) => onItemContextMenu(e, it) : undefined}>
          {picked && onPick ? (
            <span onClick={stop} onKeyDown={stop}>
              <Checkbox id={`ops-pick-${it.id}`} className={css.tick} labelText="" hideLabel
                        checked={picked.has(it.id)} onChange={(_, { checked }) => onPick(it.id, checked)} />
            </span>
          ) : ico ? (() => { const I = ico; return <I size={16} style={it.mark ? { fill: it.mark } : undefined} />; })()
            : it.mark ? <span className={css.dot} style={{ background: it.mark }} /> : null}
        </span>
        <span className={css.trail}>
          {it.badge != null && (
            <span className={css.badge} style={it.badgeColor ? { color: it.badgeColor, fontWeight: 600 } : undefined}>{it.badge}</span>
          )}
          {itemAction && <span className={css.acts} onClick={stop} onKeyDown={stop}>{itemAction(it)}</span>}
        </span>
      </>
    ));
    return (
      <TreeNode key={key} id={key} value={String(it.id)} renderIcon={Slot}
                label={<span title={it.title ?? it.name}
                             onContextMenu={onItemContextMenu ? (e) => onItemContextMenu(e, it) : undefined}>{it.name}</span>} />
    );
  }

  /** One folder level, recursing into sub-levels */
  function renderNodes(nodes: FolderNode[]): ReactNode {
    return nodes.map((n) => {
      // While searching expand everything, otherwise matches are hidden. The selected item's folder
      // is expanded by the effect above so the user's collapse always wins.
      const open = !shut.has(n.path) || !!q.trim();
      const Slot = slot(`f:${n.path}`, () => (
        <>
          <span className={css.lead}>{open ? <FolderOpen size={16} /> : <Folder size={16} />}</span>
          <span className={css.trail}>
            <span className={css.count}>{n.total}</span>
            {folderAction && <span className={css.acts} onClick={stop} onKeyDown={stop}>{folderAction(n.path)}</span>}
          </span>
        </>
      ));
      return (
        <TreeNode key={`f:${n.path}`} id={`f:${n.path}`} isExpanded={open}
                  onToggle={() => toggleFolder(n.path)}
                  renderIcon={Slot}
                  label={<span title={n.path}>{n.label}</span>}>
          {renderNodes(n.kids)}
          {n.items.map(renderItem)}
        </TreeNode>
      );
    });
  }

  return (
    <aside className={"rh-ops__nav"}>
      <div className={css.head}>
        <Search size="md" labelText="Search" placeholder={placeholder} value={q}
                onChange={(e) => setQ(typeof e === "string" ? e : e.target.value)} onClear={() => setQ("")} />
        <IconButton kind="ghost" size="md" label="Hide list" align="left" onClick={onToggleNav}>
          <SidePanelClose />
        </IconButton>
      </div>

      {(onAdd || tools) && (
        <div className={css.tools}>
          {onAdd && <Button kind="ghost" size="sm" renderIcon={Add} onClick={onAdd}>{addLabel}</Button>}
          <span style={{ flex: 1 }} />
          {tools}
        </div>
      )}

      {/* Only the list scrolls — the search box above and the footer below stay fixed */}
      <div className={"rh-ops__list " + css.tree}>
        {matched > 0 && (
          <TreeView label={placeholder} hideLabel size="sm"
                    selected={selectedId != null ? [itemKey(selectedId)] : []}
                    active={selectedId != null ? itemKey(selectedId) : undefined}
                    onSelect={(e: unknown, node?: { id?: string | number }) => {
                      const id = String(node?.id ?? "");
                      if (id.startsWith("f:")) { toggleFolder(id.slice(2)); return; }
                      const it = byKey.get(id);
                      if (it) onSelect(it);
                    }}>
            {renderNodes(tree.kids)}
            {tree.items.map(renderItem)}
          </TreeView>
        )}
        {/* Say so explicitly when a search matches nothing, rather than an empty rail that looks unloaded */}
        {total > 0 && matched === 0 && <div className={css.note}>No match for “{q}”</div>}
        {total === 0 && emptyText && <div className={css.note}>{emptyText}</div>}
      </div>

      <div className={css.foot}>{foot}</div>
    </aside>
  );
}

/** Right side when nothing is selected — just names what to pick */
export function OpsEmpty({ icon, title }: { icon: string; title: string }) {
  return (
    <div className={css.empty}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Icon name={icon as any} size={32} />
      <div className={"cds--type-heading-compact-01 " + css.emptyTitle}>{title}</div>
    </div>
  );
}
