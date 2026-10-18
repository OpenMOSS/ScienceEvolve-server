/**
 * Compatibility surface for the original canvas imports.
 *
 * Layout, viewport and routing live in components/workflow-canvas/core.
 * These adapters preserve legacy imports without maintaining a second
 * geometry implementation.
 */
import type {
  AgentName,
  AgentOrchestrationTemplate,
  AgentsConfig,
  WorkflowCanvasEdgeLayout,
  WorkflowCanvasLayout,
  WorkflowCanvasPort
} from "./types";
import {
  canvasEdgeId,
  canvasEdgeLayout,
  createDefaultCanvasLayout,
  layeredCanvasLayout,
  normalizeCanvasLayout
} from "./components/workflow-canvas/core/canvas-layout";
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_WORLD_HEIGHT,
  CANVAS_WORLD_WIDTH
} from "./components/workflow-canvas/core/canvas-model";
import { workflowLoopMembers } from "../../server/src/internal/shared/workflow-loop-validation.js";
import {
  canvasPortPoint as coreCanvasPortPoint,
  mainDispatchGeometry,
  routeCanvasEdge
} from "./components/workflow-canvas/core/canvas-router";
import { adaptWorkflowToCanvas } from "./components/workflow-canvas/core/canvas-adapter";
import type {
  CanvasEdge,
  CanvasNode,
  CanvasPoint
} from "./components/workflow-canvas/core/canvas-model";

export const WORKFLOW_CANVAS_NODE_WIDTH = CANVAS_NODE_WIDTH;
export const WORKFLOW_CANVAS_NODE_HEIGHT = CANVAS_NODE_HEIGHT;
export const WORKFLOW_CANVAS_WIDTH = CANVAS_WORLD_WIDTH;
export const WORKFLOW_CANVAS_HEIGHT = CANVAS_WORLD_HEIGHT;

export interface WorkflowCanvasNode {
  id: string;
  kind: "input" | "agent" | "finish";
  name: string;
  template?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface WorkflowCanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: "strong" | "weak" | "parallel" | "termination";
  sourcePort: WorkflowCanvasPort;
  targetPort: WorkflowCanvasPort;
  sourcePortPinned: boolean;
  targetPortPinned: boolean;
  /** Main fan-out edges are system-owned; all other edges remain editable. */
  fixed?: boolean;
  systemRoute?: "main-dispatch";
  loop?: CanvasEdge["loop"];
}

export function workflowEdgeKey(source: string, target: string, index = 0): string {
  return canvasEdgeId(source, target, index);
}

export function edgeLayout(
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  sourcePortPinned = true,
  targetPortPinned = true
): WorkflowCanvasEdgeLayout {
  return canvasEdgeLayout(sourcePort, targetPort, sourcePortPinned, targetPortPinned);
}

export function defaultWorkflowCanvasLayout(
  orchestration: Pick<AgentOrchestrationTemplate, "agents" | "routes" | "input" | "termination">
): WorkflowCanvasLayout {
  return createDefaultCanvasLayout(orchestration);
}

export function normalizeWorkflowCanvasLayout(
  value: unknown,
  orchestration: Pick<AgentOrchestrationTemplate, "agents" | "routes" | "input" | "termination">
): WorkflowCanvasLayout {
  return normalizeCanvasLayout(value, orchestration);
}

export function workflowToCanvas(
  orchestration: AgentOrchestrationTemplate,
  layout?: WorkflowCanvasLayout
): { nodes: WorkflowCanvasNode[]; edges: WorkflowCanvasEdge[]; layout: WorkflowCanvasLayout } {
  const model = adaptWorkflowToCanvas(orchestration, layout);
  return {
    nodes: model.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      template: node.template,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
      sourcePortPinned: edge.sourcePortPinned,
      targetPortPinned: edge.targetPortPinned,
      fixed: edge.fixed,
      systemRoute: edge.systemRoute,
      loop: edge.loop
    })),
    layout: model.presentationLayout
  };
}

export function layeredWorkflowCanvasLayout(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout
): Promise<WorkflowCanvasLayout> {
  return layeredCanvasLayout(orchestration, layout);
}

export { CanvasPoint };

export function canvasPortPoint(
  node: Pick<WorkflowCanvasNode, "x" | "y">,
  port: WorkflowCanvasPort
): CanvasPoint {
  return coreCanvasPortPoint(node, port);
}

export function canvasMainDispatchGeometry(
  edge: WorkflowCanvasEdge,
  nodes: WorkflowCanvasNode[],
  index: number,
  total: number
): { path: string; midpoint: CanvasPoint } | undefined {
  const geometry = mainDispatchGeometry(
    toCoreEdge(edge),
    nodes.map(toCoreNode),
    index,
    total
  );
  return geometry ? { path: geometry.path, midpoint: geometry.midpoint } : undefined;
}

export function canvasEdgePath(
  edge: WorkflowCanvasEdge,
  nodes: WorkflowCanvasNode[],
  edgeIndex = 0
): string {
  return routeCanvasEdge(toCoreEdge(edge), nodes.map(toCoreNode), edgeIndex)?.path ?? "";
}

export function renameAgentInWorkflow(
  orchestration: AgentOrchestrationTemplate,
  agents: AgentsConfig,
  oldName: AgentName,
  nextName: AgentName
): { orchestration: AgentOrchestrationTemplate; agents: AgentsConfig } {
  if (!oldName || !nextName || oldName === "main" || nextName === "main") {
    return { orchestration: structuredClone(orchestration), agents: structuredClone(agents) };
  }
  const next = structuredClone(orchestration);
  next.agents = next.agents.map((entry) =>
    entry.name === oldName ? { ...entry, name: nextName } : entry
  );
  next.input.target = next.input.target === oldName ? nextName : next.input.target;
  next.termination.agent = next.termination.agent === oldName ? nextName : next.termination.agent;
  next.loops = next.loops?.map((loop) => ({
    ...loop,
    from: loop.from === oldName ? nextName : loop.from,
    to: loop.to === oldName ? nextName : loop.to,
    exitTo: loop.exitTo === oldName ? nextName : loop.exitTo
  }));
  next.routes = Object.fromEntries(
    Object.entries(next.routes ?? {}).map(([source, routes]) => [
      source === oldName ? nextName : source,
      routes.map((edge) => ({ ...edge, target: edge.target === oldName ? nextName : edge.target }))
    ])
  );
  next.decisionPlans = renameRecordKey(next.decisionPlans, oldName, nextName);
  if (next.canvas) {
    const nodes = { ...next.canvas.nodes };
    if (nodes[oldName]) {
      nodes[nextName] = nodes[oldName]!;
      delete nodes[oldName];
    }
    const edges = Object.fromEntries(
      Object.entries(next.canvas.edges).map(([id, value]) => [
        id.replaceAll(oldName + "->", nextName + "->").replaceAll("->" + oldName + ":", "->" + nextName + ":"),
        value
      ])
    );
    next.canvas = { ...next.canvas, nodes, edges };
  }
  const nextAgents = { ...agents };
  if (nextAgents[oldName]) {
    nextAgents[nextName] = nextAgents[oldName]!;
    delete nextAgents[oldName];
  }
  return { orchestration: next, agents: nextAgents };
}

export function removeAgentFromWorkflow(
  orchestration: AgentOrchestrationTemplate,
  agents: AgentsConfig,
  name: AgentName
): { orchestration: AgentOrchestrationTemplate; agents: AgentsConfig } {
  if (name === "main") {
    return { orchestration: structuredClone(orchestration), agents: structuredClone(agents) };
  }
  const next = structuredClone(orchestration);
  if (next.loops?.some((loop) => (
    loop.from === name || loop.to === name || loop.exitTo === name
    || workflowLoopMembers(next, loop).includes(name)
  ))) {
    return { orchestration: next, agents: structuredClone(agents) };
  }
  next.agents = next.agents.filter((entry) => entry.name !== name);
  const fallback = next.agents.find((entry) => entry.name !== "main")?.name ?? "main";
  if (next.input.target === name) next.input.target = fallback;
  if (next.termination.agent === name) next.termination.agent = fallback;
  next.routes = Object.fromEntries(
    Object.entries(next.routes ?? {})
      .filter(([source]) => source !== name)
      .map(([source, routes]) => [source, routes.filter((edge) => edge.target !== name)])
  );
  delete next.decisionPlans[name];
  if (next.termination.agent !== "main") {
    const routes = next.routes[next.termination.agent] ?? [];
    if (!routes.some((edge) => edge.target === "finish")) {
      next.routes[next.termination.agent] = [...routes, { target: "finish", kind: "weak" }];
    }
  }
  const nextAgents = { ...agents };
  delete nextAgents[name];
  next.canvas = normalizeCanvasLayout(next.canvas, next);
  return { orchestration: next, agents: nextAgents };
}

function renameRecordKey<T>(
  value: Record<string, T>,
  oldName: string,
  nextName: string
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([name, item]) => [name === oldName ? nextName : name, item])
  );
}

function toCoreNode(node: WorkflowCanvasNode): CanvasNode {
  return { id: node.id, kind: node.kind, name: node.name, x: node.x, y: node.y, width: node.width, height: node.height };
}

function toCoreEdge(edge: WorkflowCanvasEdge): CanvasEdge {
  return {
    ...edge,
    // Do not infer fixedness from the source alone: Main → End is a normal
    // termination edge and must stay selectable/editable.  Only an explicit
    // system marker (or the legacy `fixed` flag) denotes the dispatch rail.
    fixed: edge.fixed === true || edge.systemRoute === "main-dispatch",
    ...(edge.systemRoute === "main-dispatch" ? { systemRoute: "main-dispatch" as const } : {})
  };
}
