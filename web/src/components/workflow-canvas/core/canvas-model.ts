import type {
  CollaborationNode,
  AgentOrchestrationTemplate,
  AgentTemplate,
  NodeRef,
  WorkflowCanvasLayout,
  WorkflowCanvasPort
} from "../../../types";

/** Fixed system node ids used by both the semantic adapter and presentation. */
export const CANVAS_INPUT_NODE_ID = "input" as const;
export const CANVAS_FINISH_NODE_ID = "finish" as const;

// These dimensions mirror the reference canvas cards. Keeping them in the
// model prevents the edge router and viewport fitter from inventing their own.
export const CANVAS_NODE_WIDTH = 194;
export const CANVAS_NODE_HEIGHT = 92;
export const CANVAS_WORLD_WIDTH = 1480;
export const CANVAS_WORLD_HEIGHT = 860;

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export type CanvasNodeKind = "input" | "agent" | "finish";
export type CanvasEdgeKind = "strong" | "weak" | "parallel" | "termination";

/** A render model. Coordinates and port choices are presentation-only. */
export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  name: string;
  displayName?: string;
  template?: AgentTemplate;
  collaboration?: CollaborationNode;
  memberAgentIds?: string[];
  memberNodeRefs?: NodeRef[];
  x: number;
  y: number;
  /** Runtime DOM measurements. These are never persisted to orchestration.canvas. */
  width?: number;
  height?: number;
}

export type CanvasNodeGeometry = Pick<CanvasNode, "x" | "y"> &
  Partial<Pick<CanvasNode, "width" | "height">>;

/** Return a finite measured card size, falling back to the reference card. */
export function canvasNodeSize(node: Pick<CanvasNode, "width" | "height">): CanvasSize {
  return {
    width: finitePositive(node.width, CANVAS_NODE_WIDTH),
    height: finitePositive(node.height, CANVAS_NODE_HEIGHT)
  };
}

/** A semantic route decorated with its presentation-only port layout. */
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: CanvasEdgeKind;
  sourcePort: WorkflowCanvasPort;
  targetPort: WorkflowCanvasPort;
  sourcePortPinned: boolean;
  targetPortPinned: boolean;
  /** Main fan-out is semantic, system-owned topology in OpenFARS. */
  fixed: boolean;
  systemRoute?: "main-dispatch";
  /** Loop metadata decorates every member route and the read-only virtual exit. */
  loop?: {
    id: string;
    role: "member" | "return" | "exit";
    maxIterations: number;
    exitTo: string;
    virtual: boolean;
  };
}

export interface CanvasSummary {
  agentCount: number;
  strongEdgeCount: number;
  weakEdgeCount: number;
  inputTarget?: string;
  terminationTarget?: string;
  inputConnected: boolean;
  terminationConnected: boolean;
}

/**
 * One render snapshot with its two source domains kept explicit. Layout may
 * be persisted, but it is never allowed to rewrite semantic workflow fields.
 */
export interface CanvasModel {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  semanticWorkflow: AgentOrchestrationTemplate;
  presentationLayout: WorkflowCanvasLayout;
  summary: CanvasSummary;
  /** Compatibility alias while the host migrates to presentationLayout. */
  readonly layout: WorkflowCanvasLayout;
}

export const CANVAS_PORTS: readonly WorkflowCanvasPort[] = [
  "top",
  "right",
  "bottom",
  "left"
] as const;

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
