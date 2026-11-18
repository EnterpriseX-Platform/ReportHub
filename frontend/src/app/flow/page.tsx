"use client";

import { errMsg } from "@/lib/api";
import { Skeleton } from "@/components/ui";
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
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button, ClickableTile, Tag } from "@carbon/react";
import { Add, Checkmark } from "@carbon/icons-react";
import { Icon, type IconName } from "@/components/Icon";
import { PageHeader } from "@/components/ui";
import { Select } from "@/components/Select";
import st from "@/components/R/r.module.scss";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { ReportSummary } from "@/lib/types";

type StageData = { kind: string; label: string; sub?: string; executed?: boolean };

/** Stage kinds the render pipeline actually runs; anything else is drawn but not executed. */
const PIPELINE_KINDS = new Set(["ingress", "queue", "worker", "engine", "store"]);
type StageNodeType = Node<StageData, "stage">;

const KIND_META: Record<string, { icon: IconName; color: string }> = {
  ingress:   { icon: "gateway",   color: "var(--cds-interactive)" },
  queue:     { icon: "queue",     color: "var(--cds-support-info)" },
  worker:    { icon: "worker",    color: "var(--cds-link-primary)" },
  engine:    { icon: "engine",    color: "var(--cds-support-warning)" },
  store:     { icon: "store",     color: "var(--cds-support-success)" },
  transform: { icon: "filter",    color: "var(--cds-interactive)" },
  validate:  { icon: "checkCircle", color: "var(--cds-support-success)" },
  notify:    { icon: "bell",      color: "var(--cds-support-info)" },
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
      minWidth: 170, background: "var(--cds-layer-01)", padding: "var(--cds-spacing-03) var(--cds-spacing-04)",
      border: `1px solid ${selected ? "var(--cds-border-interactive)" : "var(--cds-border-strong-01)"}`,
      boxShadow: selected ? "inset 0 0 0 1px var(--cds-border-interactive)" : "none",
    }}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--cds-icon-secondary)", width: 8, height: 8 }} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)" }}>
        <Icon name={meta.icon} size={16} style={{ color: "var(--cds-icon-secondary)", flex: "none" }} />
        <div style={{ minWidth: 0 }}>
          <div className="cds--type-heading-compact-01" style={{ color: "var(--cds-text-primary)" }}>{data.label}</div>
          {data.sub && <div className="cds--type-code-01 rh-dim rh-ellipsis" style={{ maxWidth: 170 }}>{data.sub}</div>}
          {data.executed === false && <Tag size="sm" type="outline" style={{ marginLeft: 0 }}>Not executed</Tag>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--cds-icon-secondary)", width: 8, height: 8 }} />
    </div>
  );
}

export default function FlowPage() {
  return (
    <Suspense fallback={<Skeleton />}>
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
  const [rf, setRf] = useState<ReactFlowInstance<StageNodeType, Edge> | null>(null);

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
      const notRun = new Set(doc.notExecutedStages ?? []);
      setNodes((doc.nodes ?? []).map((n) => ({
        id: n.id, type: "stage", position: n.position,
        data: { ...n.data, executed: n.data.executed ?? !(notRun.has(n.data.label) || notRun.has(n.id)) } as StageData,
      })));
      setEdges((doc.edges ?? []).map((e) => ({ ...e, animated: e.animated ?? true })));
      setSavedInfo({ saved: !!doc.saved, by: doc.updatedBy, at: doc.updatedAt });
    }).catch((e) => toast(errMsg(e, "Failed to load flow"), "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, animated: true }, eds));
  }, [setEdges]);

  function addStage(p: { kind: string; label: string; sub: string }) {
    const id = `${p.kind}-${Math.random().toString(36).slice(2, 7)}`;
    // Anchor = the selected node, else the right-most one; the new stage goes just after it and is
    // connected to it, then the view pans to it so it is never dropped off-screen.
    const anchor = nodes.find((n) => n.selected)
      ?? nodes.reduce<StageNodeType | null>((m, n) => (!m || n.position.x > m.position.x ? n : m), null);
    const position = anchor ? { x: anchor.position.x + 220, y: anchor.position.y } : { x: 0, y: 0 };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), {
      id, type: "stage", position, selected: true,
      data: { kind: p.kind, label: p.label, sub: p.sub, executed: PIPELINE_KINDS.has(p.kind) },
    }]);
    if (anchor) {
      setEdges((eds) => addEdge({ id: `e-${anchor.id}-${id}`, source: anchor.id, target: id, sourceHandle: null, targetHandle: null, animated: true }, eds));
    }
    if (rf) {
      const z = rf.getZoom();
      setTimeout(() => rf.setCenter(position.x + 90, position.y + 30, { zoom: z, duration: 300 }), 0);
    }
  }

  async function save() {
    if (!code) return;
    setSaving(true);
    try {
      const res = await api.saveReportFlow(code, {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: e.animated })),
      });
      if (res?.notExecutedStages) {
        const notRun = new Set(res.notExecutedStages);
        setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, executed: !(notRun.has(n.data.label) || notRun.has(n.id)) } })));
      }
      setSavedInfo({ saved: true, by: "you", at: new Date().toISOString() });
      toast("Flow saved", "ok");
    } catch (e) {
      toast(errMsg(e, "Save failed"), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fade-in rh-fill" style={{ display: "flex", flexDirection: "column", minHeight: "32rem" }}>
      <PageHeader
        title="Flow Designer"
        sub="Render pipeline per report"
        actions={<>
          {savedInfo.saved
            ? <Tag type="green" size="md">saved{savedInfo.by ? ` · ${savedInfo.by}` : ""}</Tag>
            : <Tag type="gray" size="md">default pipeline</Tag>}
          <Select value={code} onChange={setCode} style={{ width: 320, maxWidth: "100%" }} size="lg"
            options={reports.map((r) => ({ value: r.code, label: `${r.code} · ${r.name}` }))} />
          <Button kind="primary" renderIcon={Checkmark} onClick={save} disabled={saving || loading || !code}>Save flow</Button>
        </>}
      />

      <div className={st.flowGrid}>
        <div style={{ overflow: "auto" }}>
          <h2 className="cds--type-heading-compact-01" style={{ marginBottom: "var(--cds-spacing-03)" }}>Add stage</h2>
          {PALETTE.map((p) => {
            const meta = KIND_META[p.kind];
            return (
              <ClickableTile key={p.kind} onClick={() => addStage(p)} renderIcon={Add} style={{ marginBottom: 1, minHeight: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: "var(--cds-spacing-03)" }}>
                  <Icon name={meta.icon} size={16} style={{ color: "var(--cds-icon-secondary)", flex: "none" }} />
                  <span>
                    <span className="cds--type-heading-compact-01" style={{ display: "block" }}>{p.label}</span>
                    <span className="cds--type-helper-text-01 rh-dim">{p.sub}</span>
                  </span>
                </span>
              </ClickableTile>
            );
          })}
        </div>

        <div style={{ overflow: "hidden", position: "relative", border: "1px solid var(--cds-border-subtle-01)", background: "var(--cds-layer-01)" }}>
          {loading && <div style={{ position: "absolute", inset: 0, zIndex: 5, background: "var(--cds-layer-01)", padding: "var(--cds-spacing-05)" }}><Skeleton rows={6} /></div>}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRf}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ animated: true }}
          >
            <Background gap={18} size={1} color="var(--cds-border-subtle-01)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ width: 140, height: 90 }} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
