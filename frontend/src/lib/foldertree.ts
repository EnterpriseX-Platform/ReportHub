/**
 * Folder tree built from group names containing "/" — shared by every screen with a left-hand list.
 *
 * Ops-screen folders have no table of their own: each item carries a single `folder` text field,
 * and nesting comes from splitting on "/", e.g. "SALES/Stage 5B".
 * All screens sort the same way, with Data Pipeline as the reference.
 */

export interface FolderTreeNode<T> {
  /** Full path, e.g. "SALES/Stage 5B" — the key for collapse/rename/delete */
  path: string;
  /** This level's own name */
  label: string;
  items: T[];
  kids: FolderTreeNode<T>[];
  /** Total count across all sub-levels */
  total: number;
}

/**
 * @param groups pairs of [group name, members] — an empty name means "ungrouped"
 * @param looseKey group name to treat as "ungrouped" (some screens use "Ungrouped")
 * @returns roots = top-level folders · loose = items not in any folder
 */
export function buildFolderTree<T>(
  groups: [string, T[]][],
  looseKey = "",
): { roots: FolderTreeNode<T>[]; loose: T[] } {
  const root: FolderTreeNode<T> = { path: "", label: "", items: [], kids: [], total: 0 };
  const find = (parent: FolderTreeNode<T>, label: string): FolderTreeNode<T> => {
    const path = parent.path ? `${parent.path}/${label}` : label;
    let n = parent.kids.find((k) => k.path === path);
    if (!n) { n = { path, label, items: [], kids: [], total: 0 }; parent.kids.push(n); }
    return n;
  };
  for (const [folder, list] of groups) {
    if (folder === looseKey) { root.items.push(...list); continue; }
    let cur = root;
    for (const seg of folder.split("/").map((x) => x.trim()).filter(Boolean)) cur = find(cur, seg);
    cur.items.push(...list);
  }
  const count = (n: FolderTreeNode<T>): number =>
    (n.total = n.items.length + n.kids.reduce((a, k) => a + count(k), 0));
  const sort = (n: FolderTreeNode<T>) => {
    n.kids.sort((a, b) => a.label.localeCompare(b.label, "th", { numeric: true }));
    n.kids.forEach(sort);
  };
  root.kids.forEach(count);
  sort(root);
  return { roots: root.kids, loose: root.items };
}

/** Whether the item sits in this folder or one of its sub-folders */
export function inFolder(folder: string | null | undefined, path: string): boolean {
  const f = (folder ?? "").trim();
  return f === path || f.startsWith(path + "/");
}

/** Re-path a whole branch — used when renaming a folder that has sub-folders */
export function repath(folder: string | null | undefined, from: string, to: string): string {
  const f = (folder ?? "").trim();
  return f === from ? to : f.startsWith(from + "/") ? to + f.slice(from.length) : f;
}
