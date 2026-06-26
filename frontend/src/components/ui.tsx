// Shared presentational primitives built on the ported design-system classes.
import { ENGINES, STATUS, engineDef } from "@/lib/model";
import { Icon, type IconName } from "./Icon";

export function StatusChip({ s, pulse }: { s: string; pulse?: boolean }) {
  const st = STATUS[s] ?? STATUS.draft;
  return (
    <span className={`chip ${st.tone}${pulse ? " pulse" : ""}`}>
      <i className="led" />
      {st.label}
    </span>
  );
}

export function FmtTag({ f }: { f: string }) {
  return <span className={`fmt ${f}`}>{f}</span>;
}

export function Fmts({ list }: { list: string[] }) {
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {list.map((f) => <FmtTag key={f} f={f} />)}
    </span>
  );
}

export function EngineBadge({ engine, sm }: { engine: string; sm?: boolean }) {
  const e = engineDef(engine);
  return (
    <span
      className="chip"
      style={{ height: sm ? 19 : 22, background: `color-mix(in srgb, ${e.color} 13%, transparent)`, color: e.color }}
    >
      <Icon name={e.icon} size={sm ? 11 : 12} />
      {e.label}
    </span>
  );
}

export function Donut({
  value,
  max,
  size = 54,
  stroke = 7,
  color = "var(--accent)",
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
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
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
  color = "var(--accent)",
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

export function JobStateDot({ state }: { state: string }) {
  const map: Record<string, [string, boolean]> = {
    running: ["var(--accent)", true],
    queued: ["var(--ink-4)", false],
    done: ["var(--green)", false],
    error: ["var(--red)", false],
  };
  const [c, pulse] = map[state] ?? map.queued;
  return <span className={pulse ? "pulse" : ""} style={{ width: 8, height: 8, borderRadius: 8, background: c, flex: "none", display: "inline-block" }} />;
}

const TONE: Record<string, string> = {
  accent: "var(--accent)",
  green: "var(--green)",
  amber: "var(--amber)",
  red: "var(--red)",
  violet: "var(--violet)",
};

export function MetricCard({ icon, label, value, tone = "accent" }: { icon: IconName; label: string; value: React.ReactNode; tone?: string }) {
  const c = TONE[tone] ?? TONE.accent;
  return (
    <div className="stat">
      <div className="ico" style={{ background: `color-mix(in srgb, ${c} 13%, transparent)`, color: c }}>
        <Icon name={icon} size={18} />
      </div>
      <div className="label">{label}</div>
      <div className="val">{value}</div>
    </div>
  );
}

export function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "10px 12px", background: "var(--surface-2)" }}>
      <div style={{ fontSize: 10.5, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: ".4px", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 3 }}>{value}</div>
    </div>
  );
}

export function DsDot({ s, pulse }: { s: string; pulse?: boolean }) {
  const c = s === "healthy" ? "var(--green)" : s === "degraded" ? "var(--amber)" : "var(--red)";
  return <span className={pulse ? "pulse" : ""} style={{ width: 8, height: 8, borderRadius: 8, background: c, flex: "none", display: "inline-block" }} />;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export { ENGINES };
