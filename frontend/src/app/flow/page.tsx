"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon, type IconName } from "@/components/Icon";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { ReportSummary } from "@/lib/types";

type StageData = { kind: string; label: string; sub?: string };
type StageNodeType = Node<StageData, "stage">;

const KIND_META: Record<string, { icon: IconName; color: string }> = {
  ingress:   { icon: "gateway",   color: "var(--accent)" },
  queue:     { icon: "queue",     color: "var(--violet)" },
  worker:    { icon: "worker",    color: "var(--blue)" },
  engine:    { icon: "engine",    color: "var(--amber)" },
  store:     { icon: "store",     color: "var(--green)" },
  transform: { icon: "filter",    color: "var(--accent)" },
  validate:  { icon: "checkCircle", color: "var(--green)" },
  notify:    { icon: "bell",      color: "var(--violet)" },
};

const PALETTE: { kind: string; label: string; sub: string }[] = [
  { kind: "transform", label: "Transform", sub: "map / enrich payload" },
  { kind: "validate",  label: "Validate",  sub: "check params & schema" },
  { kind: "engine",    label: "Engine",    sub: "render stage" },
  { kind: "notify",    label: "Notify",    sub: "webhook / e-mail on done" },
  { kind: "store",     label: "Store",     sub: "extra artifact sink" },
];

function StageNode({ data, selected }: NodeProps<StageNodeType>) {
  const meta = KIND_META[data.kind] ?? KIND_META.transform;
  return (
    <div style={{
      minWidth: 170, borderRadius: 12, background: "var(--surface)", padding: "10px 13px",
      border: `1.5px solid ${selected ? "var(--accent)" : "var(--line-strong)"}`,
      boxShadow: selected ? "0 0 0 3px var(--accent-weak)" : "var(--shadow)",
      fontFamily: "inherit",
    }}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--ink-4)", width: 8, height: 8 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: "grid", placeItems: "center", background: `color-mix(in srgb, ${meta.color} 12%, transparent)`, color: meta.color, flex: "none" }}>
          <Icon name={meta.icon} size={16} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{data.label}</div>
          {data.sub && <div className="mono" style={{ fontSize: 9.5, color: "var(--ink-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 170 }}>{data.sub}</div>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--ink-4)", width: 8, height: 8 }} />
    </div>
  );
}

export default function FlowPage() {
  return (
    <Suspense fallback={<div className="empty"><span className="spin" /></div>}>
      <FlowDesigner />
    </Suspense>
  );
}

function FlowDesigner() {
  const toast = useToast();
  const search = useSearchParams();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [code, setCode] = useState<string>("");
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [savedInfo, setSavedInfo] = useState<{ saved: boolean; by?: string; at?: string }>({ saved: false });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const nodeTypes = useMemo(() => ({ stage: StageNode }), []);

  useEffect(() => {
    api.reports({ size: 200 }).then((p) => {
      setReports(p.items);
      const initial = search.get("code") ?? p.items[0]?.code;
      if (initial) setCode(initial);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    api.reportFlow(code).then((doc) => {
      setNodes((doc.nodes ?? []).map((n) => ({
        id: n.id, type: "stage", position: n.position, data: n.data as StageData,
      })));
      setEdges((doc.edges ?? []).map((e) => ({ ...e, animated: e.animated ?? true })));
      setSavedInfo({ saved: !!doc.saved, by: doc.updatedBy, at: doc.updatedAt });
    }).catch((e) => toast(e instanceof Error ? e.message : "Failed to load flow", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, animated: true }, eds));
  }, [setEdges]);

  function addStage(p: { kind: string; label: string; sub: string }) {
    const id = `${p.kind}-${Math.random().toString(36).slice(2, 7)}`;
    const maxX = nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
    setNodes((ns) => [...ns, {
      id, type: "stage",
      position: { x: maxX + 120, y: 280 },
      data: { kind: p.kind, label: p.label, sub: p.sub },
    }]);
  }

  async function save() {
    if (!code) return;
    setSaving(true);
    try {
      await api.saveReportFlow(code, {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: e.animated })),
      });
      setSavedInfo({ saved: true, by: "you", at: new Date().toISOString() });
      toast("Flow saved", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 130px)" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Flow Designer</h1>
          <div className="page-sub">Design each report’s render pipeline — drag, connect, and persist it for real</div>
        </div>
        <div className="page-actions" style={{ alignItems: "center" }}>
          {savedInfo.saved
            ? <span className="chip green" style={{ height: 22 }}><i className="led" />saved{savedInfo.by ? ` · ${savedInfo.by}` : ""}</span>
            : <span className="chip" style={{ height: 22 }}>default pipeline</span>}
          <Select value={code} onChange={setCode} style={{ width: 320 }}
            options={reports.map((r) => ({ value: r.code, label: `${r.code} · ${r.name}` }))} />
          <button className="btn primary" onClick={save} disabled={saving || loading || !code}>
            {saving ? <span className="spin" /> : <Icon name="check" size={15} />}Save flow
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", gap: 14, flex: 1, minHeight: 0 }}>
        <div className="card card-pad" style={{ overflow: "auto" }}>
          <div className="section-label">Add stage</div>
          {PALETTE.map((p) => {
            const meta = KIND_META[p.kind];
            return (
              <div key={p.kind} onClick={() => addStage(p)}
                   style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 9, cursor: "pointer", border: "1px solid var(--line)", marginBottom: 6, background: "var(--surface)" }}>
                <span style={{ width: 26, height: 26, borderRadius: 8, display: "grid", placeItems: "center", background: `color-mix(in srgb, ${meta.color} 12%, transparent)`, color: meta.color }}>
                  <Icon name={meta.icon} size={14} />
                </span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{p.label}</div>
                  <div style={{ fontSize: 10, color: "var(--ink-4)" }}>{p.sub}</div>
                </div>
                <Icon name="plus" size={13} style={{ marginLeft: "auto", color: "var(--ink-4)" }} />
              </div>
            );
          })}
          <div className="divider" />
          <div style={{ fontSize: 11, color: "var(--ink-4)", lineHeight: 1.7 }}>
            · Drag nodes to arrange<br />
            · Drag right handle → left handle to connect<br />
            · Select + <kbd>⌫</kbd> to delete<br />
            · <b>Save flow</b> persists to the database
          </div>
        </div>

        <div className="card" style={{ overflow: "hidden", position: "relative" }}>
          {loading && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", zIndex: 5, background: "color-mix(in srgb, var(--surface) 60%, transparent)" }}><span className="spin" /></div>}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ animated: true }}
          >
            <Background gap={18} size={1} color="var(--line)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ width: 140, height: 90 }} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
