"use client";

// A pipeline or chain drawn as a production line: stations left → right, rows travelling along the
// conveyor between them. Used by Data Pipeline and Job Chains.
//
// Layout is computed, not dragged: both runners execute strictly in order, so a free canvas could only
// show something the runner cannot do. xyflow gives pan / zoom / fit and the edge rendering.
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge, Controls, applyNodeChanges, type NodeChange, EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider, getSmoothStepPath, getStraightPath, useReactFlow, useUpdateNodeInternals,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { Tag } from "@carbon/react";
import {
  CheckmarkFilled, CircleDash, Code, DataBase, DataTable, ErrorFilled, Flow, Rule, Sql,
} from "@carbon/icons-react";
import s from "./flowline.module.scss";

export type StationStatus = "idle" | "queued" | "running" | "success" | "failed" | "skipped" | "cancelled";

export type Station = {
  id: string;
  /** source · sql · assert · target · pipeline · check · statement · load (drives the icon) */
  kind: string;
  /** Upper-case kind caption, e.g. "Source" */
  caption: string;
  title: string;
  lines?: Array<[string, string]>;
  status?: StationStatus;
  /** Rows this station hands to the next one (drawn on the outgoing edge) */
  passRows?: number | null;
  durationMs?: number | null;
  message?: string | null;
};

const ICON: Record<string, typeof DataBase> = {
  source: DataBase, target: DataTable, sql: Sql, statement: Code, assert: Rule, check: Rule,
  pipeline: Flow, load: DataTable,
};

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function StatusTag({ st }: { st: StationStatus }) {
  switch (st) {
    case "running": return <Tag size="sm" type="blue">Running</Tag>;
    case "success": return <Tag size="sm" type="green" renderIcon={CheckmarkFilled}>Done</Tag>;
    case "failed": return <Tag size="sm" type="red" renderIcon={ErrorFilled}>Failed</Tag>;
    case "skipped": return <Tag size="sm" type="gray">Skipped</Tag>;
    case "cancelled": return <Tag size="sm" type="gray">Cancelled</Tag>;
    case "queued": return <Tag size="sm" type="cool-gray" renderIcon={CircleDash}>Waiting</Tag>;
    default: return null;
  }
}

type Side = "l" | "r" | "t" | "b";
type StationData = Station & {
  no: number; selected: boolean; inSide: Side | null; outSide: Side | null; onPick?: (id: string) => void;
};
type StationNode = Node<StationData, "station">;
const POS: Record<Side, Position> = { l: Position.Left, r: Position.Right, t: Position.Top, b: Position.Bottom };

const StationCard = memo(function StationCard({ data }: NodeProps<StationNode>) {
  const Ico = ICON[data.kind] ?? Code;
  const st = data.status ?? "idle";
  const cls = [s.node, data.selected && s.sel, st === "running" && s.running, st === "failed" && s.failed,
               (st === "skipped" || st === "cancelled") && s.skipped, st === "success" && s.success]
    .filter(Boolean).join(" ");
  return (
    <div className={cls} role="button" tabIndex={0} aria-label={`${data.caption}: ${data.title}`}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); data.onPick?.(data.id); } }}>
      {data.inSide && <Handle id="in" type="target" position={POS[data.inSide]} isConnectable={false} />}
      <div className={s.stripe} />
      <div className={s.head}>
        <Ico size={16} />
        <span className={s.kind}>{data.caption}</span>
        <span className={s.no}>{data.no}</span>
      </div>
      <div className={s.title} title={data.title}>{data.title}</div>
      <div className={s.lines}>
        {(data.lines ?? []).slice(0, 3).map(([k, v]) => (
          <div className={s.line} key={k}><span className={s.k}>{k}</span><span className={s.v} title={v}>{v}</span></div>
        ))}
      </div>
      {st === "failed" && data.message && <div className={s.err} title={data.message}>{data.message}</div>}
      <div className={s.foot}>
        {st === "idle" ? <span className="cds--type-label-01 rh-dim">Not run</span> : <StatusTag st={st} />}
        {data.durationMs != null && st !== "skipped" && <span className={s.dur}>{fmtDuration(data.durationMs)}</span>}
      </div>
      {data.outSide && <Handle id="out" type="source" position={POS[data.outSide]} isConnectable={false} />}
    </div>
  );
});

type FlowEdgeData = { rows: number | null | undefined; state: "idle" | "done" | "live" | "plain"; wrap: boolean };
type FlowEdge = Edge<FlowEdgeData, "conveyor">;

function Conveyor({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const [path, lx, ly] = data?.wrap
    ? getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 0, offset: 24 })
    : getStraightPath({ sourceX, sourceY, targetX, targetY });
  const state = data?.state ?? "plain";
  const cls = [s.edge, state === "done" && s.edgeDone, state === "idle" && s.edgeIdle, state === "live" && s.edgeLive]
    .filter(Boolean).join(" ");
  const rows = data?.rows;
  return (
    <>
      <BaseEdge path={path} className={cls} />
      {state === "live" && <path d={path} className={s.dots} />}
      {(rows != null || state === "live") && (
        <EdgeLabelRenderer>
          <div className={s.label + (state === "live" ? " " + s.labelLive : "")}
               style={{ transform: `translate(-50%, ${data?.wrap ? "-50%" : "-150%"}) translate(${lx}px, ${ly}px)` }}>
            {rows != null ? `${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"}` : "moving"}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { station: StationCard };
const edgeTypes = { conveyor: Conveyor };
/** Station width (14rem) · gap between stations · row pitch when the line wraps */
const W = 224, GAP = 72, ROW = 220;
/** Extra room on the right / bottom so the zoom controls (bottom-right) never sit on a station */
const FIT_PAD = { top: "24px", left: "24px", right: "64px", bottom: "48px" } as const;

/**
 * Serpentine layout: as many stations per row as fit at a readable zoom, the next row runs back the
 * other way (a factory floor, not a 2000px strip shrunk to illegibility in a narrow panel).
 */
function layout(n: number, width: number) {
  const cols = Math.max(2, Math.min(n, Math.floor((width - 32) / ((W + GAP) * 0.78)) || 1));
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols), k = i % cols;
    const rtl = row % 2 === 1;
    return { x: (rtl ? cols - 1 - k : k) * (W + GAP), y: row * ROW, row, rtl, endOfRow: k === cols - 1, startOfRow: k === 0 };
  });
}

function Inner({ stations, selectedId, onSelect, width }: FlowLineProps & { width: number }) {
  const rf = useReactFlow();
  const spots = useMemo(() => layout(stations.length, width), [stations.length, width]);
  const computed = useMemo<StationNode[]>(() => stations.map((st, i) => {
    const p = spots[i];
    const inSide: Side | null = i === 0 ? null : p.startOfRow ? "t" : p.rtl ? "r" : "l";
    const outSide: Side | null = i === stations.length - 1 ? null : p.endOfRow ? "b" : p.rtl ? "l" : "r";
    return {
      id: st.id, type: "station", position: { x: p.x, y: p.y },
      draggable: false, connectable: false, selectable: false,
      data: { ...st, no: i + 1, selected: st.id === selectedId, inSide, outSide, onPick: onSelect },
    };
  }), [stations, selectedId, onSelect, spots]);
  // Controlled nodes must keep their measured size between polls, or xyflow hides them until re-measured
  const [nodes, setNodes] = useState<StationNode[]>(computed);
  useEffect(() => {
    setNodes((prev) => computed.map((n) => {
      const old = prev.find((x) => x.id === n.id);
      return old?.measured ? { ...n, measured: old.measured } : n;
    }));
  }, [computed]);
  const onNodesChange = useCallback((ch: NodeChange<StationNode>[]) => setNodes((ns) => applyNodeChanges(ch, ns)), []);

  const edges = useMemo<FlowEdge[]>(() => stations.slice(1).map((to, i) => {
    const from = stations[i];
    const fs = from.status ?? "idle", ts = to.status ?? "idle";
    const state: FlowEdgeData["state"] =
      ts === "running" || (fs === "success" && ts === "queued") ? "live"
        : fs === "success" && (ts === "success" || ts === "failed") ? "done"
          : fs === "skipped" || ts === "skipped" || fs === "failed" || fs === "cancelled" ? "idle" : "plain";
    return { id: `${from.id}->${to.id}`, source: from.id, target: to.id, sourceHandle: "out", targetHandle: "in",
             type: "conveyor",
             data: { rows: fs === "success" || fs === "running" ? from.passRows : null, state, wrap: spots[i].endOfRow } };
  }), [stations, spots]);

  // Re-fit when the line changes shape (step added / removed, panel resized) — not on every status poll
  const shape = stations.map((x) => x.id).join("|") + "@" + spots.filter((x) => x.startOfRow).length;
  // Handles move sides when the line re-wraps; xyflow caches handle bounds, so tell it to re-measure
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => {
    const t = setTimeout(() => {
      updateInternals(stations.map((x) => x.id));
      rf.fitView({ padding: FIT_PAD, maxZoom: 1, duration: 200 });
    }, 60);
    return () => clearTimeout(t);
  }, [shape, width, rf]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
               fitView fitViewOptions={{ padding: FIT_PAD, maxZoom: 1 }} minZoom={0.2} maxZoom={1.5}
               nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
               onNodeClick={(_e, n) => onSelect?.(n.id)}
               panOnScroll zoomOnScroll={false} zoomOnPinch preventScrolling={false}
               proOptions={{ hideAttribution: true }}>
      <Controls position="bottom-right" showInteractive={false} aria-label="Zoom" />
    </ReactFlow>
  );
}

export interface FlowLineProps {
  stations: Station[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}

export function FlowLine(props: FlowLineProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => setWidth(el.clientWidth), 80); });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, []);
  return (
    <div className={s.wrap} ref={box}>
      {width > 0 && <ReactFlowProvider><Inner {...props} width={width} /></ReactFlowProvider>}
    </div>
  );
}

/** Milliseconds between two timestamps; null while unfinished. */
export function durationOf(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  return new Date(b).getTime() - new Date(a).getTime();
}
