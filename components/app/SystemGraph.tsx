// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import dagre from "@dagrejs/dagre";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { SystemGraph as G } from "@/lib/cobol/analyze";

type NodeData = { label: string; detail?: string; kind: G["nodes"][number]["type"]; stage?: string };

const TAG: Record<NodeData["kind"], string> = { program: "program", job: "JCL job", table: "DB2 table", copybook: "copybook", external: "not in sources" };

function GNode({ data }: NodeProps<Node<NodeData>>) {
  return (
    <div className={`gnode ${data.kind}`}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="tag">{TAG[data.kind]}{data.stage ? ` · ${data.stage}` : ""}</div>
      {data.label}
      {data.detail && <small title={data.detail}>{data.detail}</small>}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { g: GNode };

const EDGE_STYLE: Record<G["edges"][number]["kind"], { stroke: string; dash?: string; label: string }> = {
  exec: { stroke: "#0b5cad", label: "runs" },
  call: { stroke: "#1b3d7a", label: "CALL" },
  copy: { stroke: "#6f6f6f", dash: "4 4", label: "COPY" },
  read: { stroke: "#18753c", label: "reads" },
  write: { stroke: "#c00f0c", label: "writes" },
};

export default function SystemGraph({ graph, projectId, stages }: { graph: G; projectId: number; stages: Record<string, string> }) {
  const router = useRouter();
  const { nodes, edges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 26, ranksep: 90, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of graph.nodes) g.setNode(n.id, { width: 190, height: n.detail ? 58 : 44 });
    for (const e of graph.edges) g.setEdge(e.source, e.target);
    dagre.layout(g);
    const nodes: Node<NodeData>[] = graph.nodes.map((n) => {
      const p = g.node(n.id);
      return { id: n.id, type: "g", position: { x: p.x - 95, y: p.y - 24 }, data: { label: n.label, detail: n.detail, kind: n.type, stage: n.type === "program" ? stages[n.label] : undefined } };
    });
    const edges: Edge[] = graph.edges.map((e) => {
      const st = EDGE_STYLE[e.kind];
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: st.label,
        labelStyle: { fill: "#5e5e5e", fontSize: 10, fontFamily: "var(--font-mono)" },
        labelBgStyle: { fill: "#ffffff" },
        style: { stroke: st.stroke, strokeWidth: 1.4, strokeDasharray: st.dash },
        markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke, width: 14, height: 14 },
        animated: e.kind === "call",
      };
    });
    return { nodes, edges };
  }, [graph, stages]);

  return (
    <div className="graphwrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.3}
        maxZoom={1.8}
        nodesDraggable
        proOptions={{ hideAttribution: true }}
        colorMode="light"
        onNodeClick={(_, n) => {
          if (n.data.kind === "program") router.push(`/projects/${projectId}/programs/${n.data.label}`);
        }}
      >
        <Background color="transparent" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
