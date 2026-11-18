import type { CSSProperties, ComponentType } from "react";
import {
  Activity, Add, Archive, ArrowDown, ArrowRight, ArrowUp, Box, Branch, Calendar, Catalog,
  ChartColumn, Checkmark, CheckmarkOutline, ChevronDown, ChevronRight, Close, Copy, CopyFile,
  Dashboard, DataBase, DataTable, Document, Download, Draggable, Earth, Edit, Filter, Flash,
  Folder, FolderAdd, FolderOpen, Grid, Hashtag, Layers, Link, ListChecked, Locked, Menu,
  Network_3, Notification, OverflowMenuHorizontal, Pause, Play, PlayOutline, RecentlyViewed,
  Renew, Search, ServerDns, Settings, SidePanelOpen, Sigma, Star, Terminal, Time, TrashCan,
  Upload, View, ViewOff, WarningAlt,
} from "@carbon/icons-react";

/**
 * Icons come from @carbon/icons-react. The old string names (used at 400+ call sites) are kept
 * and mapped to Carbon pictograms, so `<Icon name="refresh" />` still works everywhere.
 * New code may import Carbon icons directly; pass them as `renderIcon` to Carbon buttons.
 */
export type IconName =
  | "dashboard" | "registry" | "tester" | "queue" | "datasource" | "adhoc" | "workbench"
  | "viewer" | "search" | "bell" | "chevron" | "chevDown" | "plus" | "settings" | "check"
  | "checkCircle" | "x" | "alert" | "clock" | "download" | "refresh" | "play" | "pause"
  | "gateway" | "worker" | "engine" | "store" | "filter" | "table" | "layers" | "drag"
  | "sum" | "arrowUp" | "arrowDown" | "arrowRight" | "history" | "star" | "grid" | "dots"
  | "copy" | "edit" | "eye" | "eyeOff" | "sidebar" | "bolt" | "link" | "doc" | "upload" | "calendar"
  | "chart" | "folder" | "folderOpen" | "folderPlus" | "database" | "lock" | "globe" | "menu"
  | "trash" | "checks" | "branch";

type CarbonIcon = ComponentType<{ size?: number | string; className?: string; style?: CSSProperties; "aria-hidden"?: boolean | "true"; onClick?: (e: React.MouseEvent<SVGSVGElement>) => void }>;

export const ICONS: Record<IconName, CarbonIcon> = {
  dashboard: Dashboard,
  registry: Catalog,
  tester: PlayOutline,
  queue: Box,
  datasource: DataBase,
  adhoc: Terminal,
  workbench: Grid,
  viewer: Document,
  search: Search,
  bell: Notification,
  chevron: ChevronRight,
  chevDown: ChevronDown,
  plus: Add,
  settings: Settings,
  check: Checkmark,
  checkCircle: CheckmarkOutline,
  x: Close,
  alert: WarningAlt,
  clock: Time,
  download: Download,
  refresh: Renew,
  play: Play,
  pause: Pause,
  gateway: Network_3,
  worker: ServerDns,
  engine: Activity,
  store: Archive,
  filter: Filter,
  table: DataTable,
  layers: Layers,
  drag: Draggable,
  sum: Sigma,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowRight: ArrowRight,
  history: RecentlyViewed,
  star: Star,
  grid: Hashtag,
  dots: OverflowMenuHorizontal,
  copy: Copy,
  edit: Edit,
  eye: View,
  eyeOff: ViewOff,
  sidebar: SidePanelOpen,
  bolt: Flash,
  link: Link,
  doc: CopyFile,
  upload: Upload,
  calendar: Calendar,
  chart: ChartColumn,
  folder: Folder,
  folderOpen: FolderOpen,
  folderPlus: FolderAdd,
  database: DataBase,
  lock: Locked,
  menu: Menu,
  globe: Earth,
  trash: TrashCan,
  checks: ListChecked,
  branch: Branch,
};

/** Carbon icon component for a legacy name — for `renderIcon` on Carbon Button/HeaderGlobalAction etc. */
export function carbonIcon(name: IconName | string): CarbonIcon | undefined {
  return ICONS[name as IconName];
}

export function Icon({
  name,
  size = 16,
  className = "",
  style = {},
  onClick,
}: {
  name: IconName | string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  onClick?: (e: React.MouseEvent<SVGSVGElement>) => void;
}) {
  const C = ICONS[name as IconName];
  if (!C) return null;
  return <C size={size} className={className} style={{ flexShrink: 0, ...style }} aria-hidden="true" onClick={onClick} />;
}
