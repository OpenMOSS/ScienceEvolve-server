import type { AgentOrchestrationTemplate, WorkflowCanvasLayout } from "../../../types";
import { adaptWorkflowToCanvas } from "./canvas-adapter";
import {
  buildCanvasLayoutGraph,
  layeredCanvasLayoutWithMeta,
  normalizeCanvasLayout,
  type CanvasLayoutGraphMode
} from "./canvas-layout";
import {
  buildSmartTidyPlan,
  canvasLayoutReport,
  optimizeCanvasPorts,
  type CanvasLayoutReport
} from "./canvas-layout-report";
import type { CanvasBounds, CanvasSize, CanvasViewport } from "./canvas-model";
import {
  canvasRouteTopologyKey,
  captureRouteLock,
  routeCanvasEdges,
  type DragRouteLock
} from "./canvas-router";
import { canvasContentBounds } from "./canvas-viewport";

export type CanvasLayoutPlanKind = "layered" | "tidy";

export interface CanvasLayoutPlan {
  kind: CanvasLayoutPlanKind;
  mode: CanvasLayoutGraphMode;
  layout: WorkflowCanvasLayout;
  finalViewport: CanvasViewport;
  initialReport: CanvasLayoutReport;
  finalReport: CanvasLayoutReport;
  movedNodeIds: string[];
  portChanges: number;
  collisionsReduced: number;
  graphChanged: boolean;
  viewportChanged: boolean;
  usedFallback: boolean;
  fallbackReason?: string;
  layeredTargets?: WorkflowCanvasLayout["nodes"];
  portTargets?: WorkflowCanvasLayout["edges"];
  /** Canonical final curves, computed once and reused by the apply animation. */
  routeLocks: DragRouteLock[];
  routeTopologyKey: string;
}

export interface BuildCanvasLayoutPlanOptions {
  kind: CanvasLayoutPlanKind;
  orchestration: AgentOrchestrationTemplate;
  layout?: WorkflowCanvasLayout;
  nodeSizes?: Readonly<Record<string, CanvasSize>>;
  viewportSize: CanvasSize;
}

/**
 * Compute the complete final frame without publishing any intermediate React
 * state. The caller can either animate once to this frame or commit it
 * atomically for reduced-motion users.
 */
export async function buildCanvasLayoutPlan({
  kind,
  orchestration,
  layout: value,
  nodeSizes = {},
  viewportSize
}: BuildCanvasLayoutPlanOptions): Promise<CanvasLayoutPlan> {
  const base = normalizeCanvasLayout(value, orchestration);
  const graph = buildCanvasLayoutGraph(orchestration, base);
  let staged = base;
  let usedFallback = false;
  let fallbackReason: string | undefined;
  let layeredTargets: WorkflowCanvasLayout["nodes"] | undefined;

  if (kind === "layered") {
    const layered = await layeredCanvasLayoutWithMeta(orchestration, base, nodeSizes);
    staged = layered.layout;
    usedFallback = layered.usedFallback;
    fallbackReason = layered.reason;
    layeredTargets = structuredClone(layered.elkTargets);
  }

  // ELK already performs the global collision/crossing minimization for a
  // layered command. Keep the reference smart-tidy refinement for ordinary
  // sized workflows, but do not run its exploratory candidate search on a
  // dense import: it evaluates many routed graphs synchronously on the main
  // thread. Large layered graphs use the bounded port pass below instead.
  const runTidyRefinement = kind === "tidy"
    || (Object.keys(staged.nodes).length <= 12 && graph.renderEdges.length <= 24);
  const tidy = runTidyRefinement
    ? buildSmartTidyPlan(
      orchestration,
      staged,
      nodeSizes,
      kind === "layered" ? { relaxPinnedPorts: true } : {}
    )
    : undefined;
  const finalLayout = structuredClone(
    tidy
      ? tidy.layout
      : optimizeCanvasPorts(orchestration, staged, nodeSizes, { relaxPinnedPorts: true }).layout
  );
  if (kind === "layered") finalLayout.layoutMode = "layered";
  const model = adaptWorkflowToCanvas(orchestration, finalLayout);
  const measuredNodes = model.nodes.map((node) => nodeSizes[node.id]
    ? { ...node, ...nodeSizes[node.id] }
    : node);
  // Dense workflows can make the exhaustive outer-lane search quadratic in
  // the number of ordinary edges. The bounded planner already vets direct
  // and two-cubic candidates against every card; use it for the large,
  // interactive layered commit and reserve the exhaustive router for small
  // graphs (and for the next full render/re-entry). This keeps the animation
  // responsive while preserving smooth SVG curves in the committed frame.
  const fastLayoutRouting = kind === "layered" && shouldUseFastLayoutRouting(model.edges, measuredNodes);
  const geometry = routeCanvasEdges(model.edges, measuredNodes, fastLayoutRouting
    ? { fastEvaluation: true, smoothFallback: true }
    : {});
  const routeLocks = captureRouteLock(geometry, measuredNodes);
  const routeTopologyKey = canvasRouteTopologyKey(model.edges);
  const bounds = canvasContentBounds(measuredNodes, geometry.flatMap((edge) => edge.samples));
  const finalViewport = kind === "tidy"
    ? { ...base.viewport }
    : minimallyRevealCanvas(base.viewport, viewportSize, bounds);
  finalLayout.viewport = finalViewport;
  const initialReport = tidy
    ? tidy.initialReport
    : canvasLayoutReport(orchestration, base, nodeSizes, base);
  const finalReport = tidy
    ? tidy.finalReport
    : canvasLayoutReport(orchestration, finalLayout, nodeSizes, base);
  const movedNodeIds = Object.keys(finalLayout.nodes).filter((id) => !samePoint(base.nodes[id], finalLayout.nodes[id]));
  const portChanges = Object.keys(finalLayout.edges).filter((id) => !samePorts(base.edges[id], finalLayout.edges[id])).length;
  const graphChanged = movedNodeIds.length > 0 || portChanges > 0 || base.layoutMode !== finalLayout.layoutMode;
  return {
    kind,
    mode: graph.mode,
    layout: finalLayout,
    finalViewport,
    initialReport,
    finalReport,
    movedNodeIds,
    portChanges,
    collisionsReduced: Math.max(0, initialReport.stats.issues - finalReport.stats.issues),
    graphChanged,
    viewportChanged: !sameViewport(base.viewport, finalViewport),
    usedFallback,
    fallbackReason,
    layeredTargets,
    portTargets: structuredClone(finalLayout.edges),
    routeLocks,
    routeTopologyKey
  };
}

function shouldUseFastLayoutRouting(
  edges: readonly { systemRoute?: string }[],
  nodes: readonly { id: string }[]
): boolean {
  const ordinaryEdgeCount = edges.reduce(
    (count, edge) => count + (edge.systemRoute === "main-dispatch" ? 0 : 1),
    0
  );
  // At this size the full visual router is still effectively instantaneous;
  // beyond it, a crowded fan-out/feedback graph can spend seconds exploring
  // equivalent outer lanes on the UI thread.
  return ordinaryEdgeCount > 12 || nodes.length > 16;
}

/** Preserve the user's view when the whole result is already visible. When
 * it is not, pan first and only zoom out as far as necessary. */
function minimallyRevealCanvas(
  current: CanvasViewport,
  viewportSize: CanvasSize,
  bounds: CanvasBounds | undefined
): CanvasViewport {
  if (!bounds) return { ...current };
  const width = Math.max(1, viewportSize.width);
  const height = Math.max(1, viewportSize.height);
  const padding = 30;
  const boundsPadding = 24;
  const minX = bounds.minX - boundsPadding;
  const minY = bounds.minY - boundsPadding;
  const graphWidth = Math.max(1, bounds.maxX - bounds.minX + boundsPadding * 2);
  const graphHeight = Math.max(1, bounds.maxY - bounds.minY + boundsPadding * 2);
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const fitZoom = Math.max(.08, Math.min(2.4, availableWidth / graphWidth, availableHeight / graphHeight));
  const zoom = Math.min(current.zoom, fitZoom);
  let x = current.x;
  let y = current.y;
  const left = minX * zoom + x;
  const right = (minX + graphWidth) * zoom + x;
  const top = minY * zoom + y;
  const bottom = (minY + graphHeight) * zoom + y;
  if (graphWidth * zoom <= availableWidth) {
    if (left < padding) x += padding - left;
    else if (right > width - padding) x -= right - (width - padding);
  } else {
    x = (width - graphWidth * zoom) / 2 - minX * zoom;
  }
  if (graphHeight * zoom <= availableHeight) {
    if (top < padding) y += padding - top;
    else if (bottom > height - padding) y -= bottom - (height - padding);
  } else {
    y = (height - graphHeight * zoom) / 2 - minY * zoom;
  }
  return { x: Math.round(x), y: Math.round(y), zoom };
}

export function sameCanvasLayoutFrame(
  left: WorkflowCanvasLayout,
  right: WorkflowCanvasLayout,
  epsilon = .25
): boolean {
  const leftNodeIds = Object.keys(left.nodes).sort();
  const rightNodeIds = Object.keys(right.nodes).sort();
  if (leftNodeIds.join("|") !== rightNodeIds.join("|")) return false;
  if (leftNodeIds.some((id) => !samePoint(left.nodes[id], right.nodes[id], epsilon))) return false;
  const leftEdgeIds = Object.keys(left.edges).sort();
  const rightEdgeIds = Object.keys(right.edges).sort();
  if (leftEdgeIds.join("|") !== rightEdgeIds.join("|")) return false;
  if (leftEdgeIds.some((id) => !samePorts(left.edges[id], right.edges[id]))) return false;
  return left.layoutMode === right.layoutMode && sameViewport(left.viewport, right.viewport, epsilon);
}

function samePoint(
  left: { x: number; y: number } | undefined,
  right: { x: number; y: number } | undefined,
  epsilon = .25
): boolean {
  return Boolean(left && right)
    && Math.abs(left!.x - right!.x) <= epsilon
    && Math.abs(left!.y - right!.y) <= epsilon;
}

function samePorts(
  left: WorkflowCanvasLayout["edges"][string] | undefined,
  right: WorkflowCanvasLayout["edges"][string] | undefined
): boolean {
  return Boolean(left && right)
    && left!.sourcePort === right!.sourcePort
    && left!.targetPort === right!.targetPort
    && left!.sourcePortPinned === right!.sourcePortPinned
    && left!.targetPortPinned === right!.targetPortPinned;
}

function sameViewport(left: CanvasViewport, right: CanvasViewport, epsilon = .25): boolean {
  return Math.abs(left.x - right.x) <= epsilon
    && Math.abs(left.y - right.y) <= epsilon
    && Math.abs(left.zoom - right.zoom) <= .002;
}
