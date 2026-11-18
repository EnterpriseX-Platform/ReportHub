// Shared presentational primitives — thin wrappers over IBM Carbon (@carbon/react).
// Prop APIs are unchanged from the hand-made versions so existing screens keep compiling.
import type { ReactNode } from "react";
import { SkeletonText, DataTableSkeleton, Tag, Tile } from "@carbon/react";
import { CheckmarkFilled, CircleDash, ErrorFilled, InProgress, MisuseOutline, WarningAltFilled } from "@carbon/icons-react";
import { ENGINES, STATUS, engineDef } from "@/lib/model";
import { Icon, ICONS, type IconName } from "./Icon";

/** Our tone names → Carbon Tag types. Carbon has no yellow tag; amber gets a warning icon instead. */
type TagType = "red" | "magenta" | "purple" | "blue" | "cyan" | "teal" | "green" | "gray" | "cool-gray" | "warm-gray" | "high-contrast" | "outline";
export const TONE_TAG: Record<string, TagType> = {
  green: "green", amber: "warm-gray", red: "red", slate: "gray", blue: "blue", violet: "purple", accent: "blue",
};

/** Status of a report / datasource as a Carbon Tag (Active, Testing, Error …). */
export function StatusChip({ s, pulse: _pulse, size = "md" }: { s: string; pulse?: boolean; size?: "sm" | "md" }) {
  const st = STATUS[s] ?? STATUS.draft;
  return (
    <Tag type={TONE_TAG[st.tone] ?? "gray"} size={size} renderIcon={st.tone === "amber" ? WarningAltFilled : undefined}>
      {st.label}
    </Tag>
  );
}

const FMT_TAG: Record<string, TagType> = { PDF: "red", XLSX: "green", XLS: "green", DOCX: "blue", DOC: "blue", CSV: "gray", HTML: "purple", JSON: "teal", TXT: "gray" };

/** Output format (PDF / XLSX / …) as a small Carbon Tag. */
export function FmtTag({ f }: { f: string }) {
  const k = (f ?? "").toUpperCase();
  return <Tag size="sm" type={FMT_TAG[k] ?? "outline"}>{k}</Tag>;
}

export function Fmts({ list }: { list: string[] }) {
  return (
    <span style={{ display: "inline-flex", gap: 0, flexWrap: "wrap" }}>
      {list.map((f) => <FmtTag key={f} f={f} />)}
    </span>
  );
}

/** Which engine a report uses — quiet cool-gray Tag with the engine icon. */
export function EngineBadge({ engine, sm }: { engine: string; sm?: boolean }) {
  const e = engineDef(engine);
  const I = ICONS[e.icon as IconName];
  return <Tag type="cool-gray" size={sm ? "sm" : "md"} title={e.desc} renderIcon={I}>{e.label}</Tag>;
}

/** Page title row: Carbon productive heading + optional subtitle and right-aligned actions.
 *  The shell already renders the Breadcrumb above it. */
export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rh-page-header">
      <div style={{ minWidth: 0 }}>
        <h1 className="cds--type-productive-heading-04 rh-page-header__title">{title}</h1>
        {sub && <p className="cds--type-body-01 rh-dim">{sub}</p>}
      </div>
      {actions && <div className="rh-page-header__actions">{actions}</div>}
    </div>
  );
}

export function Donut({
  value,
  max,
  size = 54,
  stroke = 7,
  color = "var(--cds-interactive)",
}: {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--cds-layer-accent-01)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset .6s" }}
      />
    </svg>
  );
}

export function Spark({
  data,
  w = 110,
  h = 34,
  color = "var(--cds-interactive)",
}: {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
}) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((d - min) / (max - min || 1)) * (h - 4) - 2;
    return [x, y] as const;
  });
  const path = pts.map((pt, i) => (i ? "L" : "M") + pt[0].toFixed(1) + " " + pt[1].toFixed(1)).join(" ");
  const area = `${path} L ${w} ${h} L 0 ${h} Z`;
  const id = "sg" + Math.round(max * 100 + data.length);
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


/** Carbon status indicator (icon + colour) for a job state or a datasource health value. */
const STATUS_ICON: Record<string, [typeof CheckmarkFilled, string, string]> = {
  running: [InProgress, "var(--cds-support-info)", "Running"],
  queued: [CircleDash, "var(--cds-icon-secondary)", "Queued"],
  done: [CheckmarkFilled, "var(--cds-support-success)", "Done"],
  error: [ErrorFilled, "var(--cds-support-error)", "Error"],
  cancelled: [MisuseOutline, "var(--cds-icon-secondary)", "Cancelled"],
  healthy: [CheckmarkFilled, "var(--cds-support-success)", "Healthy"],
  degraded: [WarningAltFilled, "var(--cds-support-warning)", "Degraded"],
  down: [ErrorFilled, "var(--cds-support-error)", "Down"],
};
export function StatusIcon({ s }: { s: string }) {
  const [I, color, label] = STATUS_ICON[s] ?? [CircleDash, "var(--cds-icon-secondary)", s];
  return <I size={16} aria-label={label} style={{ color, flex: "none" }}><title>{label}</title></I>;
}

/** One summary number tile.
 *
 * `tone` used to colour every tile's icon frame — four tiles gave four colours that said nothing
 * except that they were different tiles.
 * Now colour appears only for tones that mean something is wrong (amber/red); the rest are muted ink.
 * The number is what gets read; the icon just says what the tile is about.
 * All old tone values are still accepted so the 40 call sites need no change. */
export function MetricCard({ icon, label, value, tone = "accent" }: { icon: IconName; label: string; value: React.ReactNode; tone?: string }) {
  const alert = tone === "amber" || tone === "red";
  const color = alert ? (tone === "red" ? "var(--cds-support-error)" : "var(--cds-support-warning)") : undefined;
  return (
    <Tile className="rh-metric">
      <div className="rh-metric__head"><span className="cds--type-label-01">{label}</span><Icon name={icon} size={16} style={{ color: color ?? "var(--cds-icon-secondary)" }} /></div>
      <div className="cds--type-productive-heading-05 rh-metric__val" style={color ? { color } : undefined}>{value}</div>
    </Tile>
  );
}

export function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Tile className="rh-ministat">
      <div className="cds--type-label-01 rh-dim">{label}</div>
      <div className="cds--type-heading-compact-02" style={{ marginTop: 4 }}>{value}</div>
    </Tile>
  );
}






export { ENGINES };

/** Loading placeholder (Carbon skeleton, never a spinner). `rows` = number of text lines. */
export function Skeleton({ rows = 3, style }: { rows?: number; style?: React.CSSProperties }) {
  return (
    <div aria-busy="true" style={style}>
      <SkeletonText heading width="30%" />
      <SkeletonText paragraph lineCount={Math.max(1, rows)} />
    </div>
  );
}

/** Loading placeholder for a list screen: Carbon DataTableSkeleton. */
export function TableSkeleton({ rows = 5, columns = 4, toolbar = true }: { rows?: number; columns?: number; toolbar?: boolean }) {
  return <DataTableSkeleton rowCount={rows} columnCount={columns} showHeader={false} showToolbar={toolbar} />;
}

/**
 * Inline message for one form field from a validation error ({message, fields}).
 * New code: prefer Carbon's own `invalid` + `invalidText` on TextInput/Dropdown, e.g.
 * `<TextInput invalid={!!errs?.name} invalidText={errs?.name} … />`.
 */
export function FieldError({ errors, name }: { errors: Record<string, string> | null | undefined; name: string }) {
  const msg = errors?.[name];
  if (!msg) return null;
  return <div className="cds--form-requirement rh-field-error" role="alert">{msg}</div>;
}
