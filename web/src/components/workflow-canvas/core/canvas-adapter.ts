import type { AgentOrchestrationTemplate, WorkflowCanvasLayout } from "../../../types";
import { businessWorkflowEdges, canvasEdgeId, normalizeCanvasLayout } from "./canvas-layout";
import { CANVAS_FINISH_NODE_ID, CANVAS_INPUT_NODE_ID } from "./canvas-model";
import type { CanvasEdge, CanvasModel, CanvasNode, CanvasSummary } from "./canvas-model";
import { collaborationMemberRefs, workflowOuterNodes } from "./workflow-nodes";

/**
 * Convert OpenFARS workflow semantics into the canvas render model. This is
 * intentionally one-way: canvas coordinates and ports never alter routes,
 * termination, decision plans, or scheduler behavior.
 */
export function adaptWorkflowToCanvas(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout | undefined = orchestration.canvas
): CanvasModel {
  // Clone the semantic side first so consumers cannot accidentally use the
  // render snapshot as a mutable back door into application state.
  const semanticWorkflow = structuredClone(orchestration);
  const normalizedLayout = normalizeCanvasLayout(layout, orchestration);
  const nodes: CanvasNode[] = [
    {
      id: CANVAS_INPUT_NODE_ID,
      kind: "input",
      name: "用户输入",
      ...normalizedLayout.nodes[CANVAS_INPUT_NODE_ID]!
    },
    ...workflowOuterNodes(orchestration).map((node) => ({
      id: node.id,
      kind: "agent" as const,
      name: node.id,
      ...(node.kind === "collaboration" ? { displayName: node.displayName } : {}),
      ...(node.definition ? { template: node.definition.template ?? "general" } : {}),
      ...(node.collaboration
        ? {
            collaboration: structuredClone(node.collaboration),
            memberAgentIds: [...node.collaboration.memberAgentIds],
            ...(orchestration.schemaVersion === 3
              ? { memberNodeRefs: structuredClone(collaborationMemberRefs(orchestration, node.collaboration)) }
              : {})
          }
        : {}),
      ...(normalizedLayout.nodes[node.id] ?? { x: 540, y: 100 })
    })),
    {
      id: CANVAS_FINISH_NODE_ID,
      kind: "finish",
      name: "结束",
      ...normalizedLayout.nodes[CANVAS_FINISH_NODE_ID]!
    }
  ];
  // Every consumer receives the same semantic/presentation edge set.  The
  // builder also materializes legacy/missing presentation records with
  // deterministic ports, so an old project cannot silently lose a route.
  const edges: CanvasEdge[] = businessWorkflowEdges(orchestration, normalizedLayout);

  const summary = summarizeCanvas(orchestration, edges, normalizedLayout);
  return {
    nodes,
    edges,
    semanticWorkflow,
    presentationLayout: normalizedLayout,
    summary,
    layout: normalizedLayout
  };
}

/**
 * Persist presentation state on a cloned workflow. Semantic fields always
 * come from the caller's workflow, never from CanvasModel node or edge data.
 */
export function applyCanvasLayout(
  orchestration: AgentOrchestrationTemplate,
  layout: unknown
): AgentOrchestrationTemplate {
  const next = structuredClone(orchestration);
  next.canvas = normalizeCanvasLayout(layout, orchestration);
  return next;
}

/** Convenience boundary for hosts that edit a model's presentation only. */
export function applyCanvasModelLayout(
  orchestration: AgentOrchestrationTemplate,
  model: Pick<CanvasModel, "presentationLayout">
): AgentOrchestrationTemplate {
  return applyCanvasLayout(orchestration, model.presentationLayout);
}

function summarizeCanvas(
  orchestration: AgentOrchestrationTemplate,
  edges: readonly CanvasEdge[],
  layout: WorkflowCanvasLayout
): CanvasSummary {
  const inputEdgeId = canvasEdgeId(CANVAS_INPUT_NODE_ID, orchestration.input.target);
  const terminationAgent = orchestration.termination.agent;
  const terminationConnected = edges.some(
    (edge) => edge.source === terminationAgent && edge.target === CANVAS_FINISH_NODE_ID
  );
  return {
    agentCount: orchestration.agents.filter((agent) => agent.name !== "main").length,
    strongEdgeCount: edges.filter((edge) => edge.source !== CANVAS_INPUT_NODE_ID && edge.target !== CANVAS_FINISH_NODE_ID && !edge.systemRoute && edge.loop?.role !== "exit" && edge.kind === "strong").length,
    weakEdgeCount: edges.filter(
      (edge) => edge.source !== CANVAS_INPUT_NODE_ID && edge.target !== CANVAS_FINISH_NODE_ID && !edge.systemRoute && edge.loop?.role !== "exit" && edge.kind === "weak"
    ).length,
    inputTarget: layout.edges[inputEdgeId] ? orchestration.input.target : undefined,
    terminationTarget: terminationConnected ? terminationAgent : undefined,
    inputConnected: Boolean(layout.edges[inputEdgeId]),
    terminationConnected
  };
}
