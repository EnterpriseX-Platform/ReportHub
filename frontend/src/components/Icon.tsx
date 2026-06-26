import type { CSSProperties, ReactNode } from "react";

const p = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export type IconName =
  | "dashboard" | "registry" | "tester" | "queue" | "datasource" | "adhoc" | "workbench"
  | "viewer" | "search" | "bell" | "chevron" | "chevDown" | "plus" | "settings" | "check"
  | "checkCircle" | "x" | "alert" | "clock" | "download" | "refresh" | "play" | "pause"
  | "gateway" | "worker" | "engine" | "store" | "filter" | "table" | "layers" | "drag"
  | "sum" | "arrowUp" | "arrowDown" | "arrowRight" | "history" | "star" | "grid" | "dots"
  | "copy" | "edit" | "eye" | "sidebar" | "bolt" | "link" | "doc" | "upload" | "calendar" | "chart" | "folder" | "database";

const paths: Record<string, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" {...p}/><rect x="14" y="3" width="7" height="5" rx="1.5" {...p}/><rect x="14" y="12" width="7" height="9" rx="1.5" {...p}/><rect x="3" y="16" width="7" height="5" rx="1.5" {...p}/></>,
  registry: <><rect x="3" y="3" width="18" height="18" rx="2.5" {...p}/><path d="M3 9h18M9 9v12" {...p}/></>,
  tester: <><circle cx="12" cy="12" r="9" {...p}/><path d="M10 8.5l5 3.5-5 3.5z" {...p} fill="currentColor"/></>,
  queue: <><path d="M12 3l9 5-9 5-9-5 9-5z" {...p}/><path d="M3 13l9 5 9-5M3 8.5v3.5M21 8.5v3.5" {...p}/></>,
  datasource: <><ellipse cx="12" cy="5.5" rx="8" ry="3" {...p}/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" {...p}/></>,
  adhoc: <><path d="M4 6h16M7 12h10M10 18h4" {...p}/><circle cx="9" cy="6" r="2" {...p} fill="var(--surface)"/><circle cx="15" cy="12" r="2" {...p} fill="var(--surface)"/><circle cx="11" cy="18" r="2" {...p} fill="var(--surface)"/></>,
  workbench: <><rect x="3" y="3" width="18" height="18" rx="2" {...p}/><path d="M3 9h18M9 3v18" {...p}/><path d="M9 9h12v6H9z" fill="var(--accent-weak)" stroke="none"/></>,
  viewer: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" {...p}/><path d="M14 3v5h5M9 13h6M9 17h4" {...p}/></>,
  search: <><circle cx="11" cy="11" r="7" {...p}/><path d="M21 21l-4-4" {...p}/></>,
  bell: <><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" {...p}/></>,
  chevron: <path d="M9 6l6 6-6 6" {...p}/>,
  chevDown: <path d="M6 9l6 6 6-6" {...p}/>,
  plus: <path d="M12 5v14M5 12h14" {...p}/>,
  settings: <><circle cx="12" cy="12" r="3" {...p}/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 17 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" {...p}/></>,
  check: <path d="M20 6L9 17l-5-5" {...p}/>,
  checkCircle: <><circle cx="12" cy="12" r="9" {...p}/><path d="M8.5 12.5l2.5 2.5 4.5-5" {...p}/></>,
  x: <path d="M18 6L6 18M6 6l12 12" {...p}/>,
  alert: <><path d="M12 9v4M12 17h.01" {...p}/><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" {...p}/></>,
  clock: <><circle cx="12" cy="12" r="9" {...p}/><path d="M12 7v5l3 2" {...p}/></>,
  download: <><path d="M12 3v12M7 11l5 4 5-4M4 21h16" {...p}/></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" {...p}/></>,
  play: <path d="M6 4l14 8-14 8z" {...p} fill="currentColor"/>,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" {...p} fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" {...p} fill="currentColor"/></>,
  gateway: <><rect x="3" y="9" width="18" height="6" rx="2" {...p}/><path d="M7 9V6a5 5 0 0 1 10 0v3M12 12h.01" {...p}/></>,
  worker: <><rect x="4" y="4" width="16" height="16" rx="3" {...p}/><path d="M9 9h6v6H9z" {...p}/></>,
  engine: <><circle cx="12" cy="12" r="3.5" {...p}/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" {...p}/></>,
  store: <><path d="M3 7l9-4 9 4-9 4-9-4z" {...p}/><path d="M3 7v6l9 4 9-4V7M3 13v4l9 4 9-4v-4" {...p}/></>,
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4z" {...p}/>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" {...p}/><path d="M3 10h18M3 15h18M9 4v16M15 4v16" {...p}/></>,
  layers: <><path d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" {...p}/></>,
  drag: <><circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/></>,
  sum: <path d="M17 5H7l6 7-6 7h10" {...p}/>,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" {...p}/>,
  arrowDown: <path d="M12 5v14M18 13l-6 6-6-6" {...p}/>,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" {...p}/>,
  history: <><path d="M3 3v5h5" {...p}/><path d="M3.5 8A9 9 0 1 1 3 12" {...p}/><path d="M12 8v4l3 2" {...p}/></>,
  star: <path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6L12 17l-5.4 2.6 1.2-6L3.3 9.4l6.1-.8z" {...p}/>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2.5 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...p}/>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" {...p}/><rect x="14" y="3" width="7" height="7" rx="1.5" {...p}/><rect x="3" y="14" width="7" height="7" rx="1.5" {...p}/><rect x="14" y="14" width="7" height="7" rx="1.5" {...p}/></>,
  dots: <><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" {...p}/><path d="M5 15V5a2 2 0 0 1 2-2h8" {...p}/></>,
  edit: <><path d="M12 20h9" {...p}/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" {...p}/></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" {...p}/><circle cx="12" cy="12" r="3" {...p}/></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" {...p}/><path d="M9 4v16" {...p}/></>,
  bolt: <path d="M13 2L4 14h6l-1 8 9-12h-6z" {...p}/>,
  link: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" {...p}/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" {...p}/></>,
  doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" {...p}/><path d="M14 3v5h5" {...p}/></>,
  upload: <><path d="M12 15V3M7 8l5-5 5 5M4 21h16" {...p}/></>,
  calendar: <><rect x="3" y="4" width="18" height="17" rx="2" {...p}/><path d="M3 9h18M8 2v4M16 2v4" {...p}/></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" {...p}/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" {...p}/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" {...p}/></>,
};

export function Icon({
  name,
  size = 18,
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
  return (
    <svg viewBox="0 0 24 24" className={className} style={{ width: size, height: size, ...style }} aria-hidden="true" onClick={onClick}>
      {paths[name] ?? null}
    </svg>
  );
}
