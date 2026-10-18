import type { WorkflowCanvasPort } from "../../../types";
import type { CanvasNode, CanvasPoint } from "./canvas-model";
import { canvasNodeSize } from "./canvas-model";
import { polylineIntersectsRect, type EdgeGeometry } from "./canvas-router";

export type GeometryFramePhase = "start" | "drag" | "25pct" | "50pct" | "75pct" | "release" | "cancel";

/** Browser-only audit bridge. It is deliberately read-only and never drives
 * workflow state; Playwright can request a named frame at the exact moment a
 * pointer is sampled without having to reconstruct the router from DOM paths.
 */
export interface CanvasGeometryAuditWindow extends Window {
  __openfarsCanvasGeometry?: CanvasGeometryObservation;
  __openfarsCaptureCanvasGeometry?: (
    phase: GeometryFramePhase
  ) => CanvasGeometryObservation;
}

declare global {
  interface Window {
    __openfarsCanvasGeometry?: CanvasGeometryObservation;
    __openfarsCaptureCanvasGeometry?: (
      phase: GeometryFramePhase
    ) => CanvasGeometryObservation;
  }
}

export interface EdgeGeometryObservation {
  edgeId: string;
  source: string;
  target: string;
  kind: EdgeGeometry["kind"];
  sourcePort: WorkflowCanvasPort;
  targetPort: WorkflowCanvasPort;
  path: string;
  points: CanvasPoint[];
  samples: CanvasPoint[];
  sourceAnchor: CanvasPoint;
  targetAnchor: CanvasPoint;
  sourceEndpointDistance: number;
  targetEndpointDistance: number;
  midpoint: CanvasPoint;
  midpointSampleDistance: number;
  nodeIntersections: string[];
  reroutedBecauseBlocked: boolean;
  unrelatedRouteChanged: boolean;
}

export interface CanvasGeometryObservation {
  phase: GeometryFramePhase;
  capturedAt: string;
  draggedNodeId?: string;
  nodes: Record<string, { x: number; y: number; width: number; height: number }>;
  edges: EdgeGeometryObservation[];
  valid: boolean;
}

export interface ObserveCanvasGeometryOptions {
  phase: GeometryFramePhase;
  nodes: readonly CanvasNode[];
  geometry: readonly EdgeGeometry[];
  draggedNodeId?: string;
  previous?: CanvasGeometryObservation;
  endpointTolerance?: number;
}

export function publishCanvasGeometryObservation(
  observation: CanvasGeometryObservation
): void {
  if (typeof window === "undefined") return;
  window.__openfarsCanvasGeometry = observation;
}

/**
 * Produce a serializable, read-only frame record for drag/layout audits.
 *
 * The record deliberately comes from the exact EdgeGeometry consumed by SVG:
 * labels, particles, Main controls and assertions therefore cannot observe a
 * second, subtly different route model. Browser audit scripts persist these
 * records beside their start/25/50/75/release screenshots.
 */
export function observeCanvasGeometryFrame({
  phase,
  nodes,
  geometry,
  draggedNodeId,
  previous,
  endpointTolerance = 0.75
}: ObserveCanvasGeometryOptions): CanvasGeometryObservation {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const previousById = new Map(previous?.edges.map((edge) => [edge.edgeId, edge]) ?? []);
  const nodeRecords = Object.fromEntries(nodes.map((node) => {
    const size = canvasNodeSize(node);
    return [node.id, { x: node.x, y: node.y, width: size.width, height: size.height }];
  }));
  const edges = geometry.flatMap<EdgeGeometryObservation>((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return [];
    const samples = clonePoints(edge.samples.length ? edge.samples : edge.points);
    const first = samples[0] ?? edge.points[0] ?? { x: 0, y: 0 };
    const last = samples.at(-1) ?? edge.points.at(-1) ?? first;
    // A routed edge can own a fractional slot along one side of a node (Main
    // fan-out/return lanes).  The first and last routing points are therefore
    // the canonical anchors; rebuilding a cardinal midpoint from only the
    // side name would incorrectly report a detached edge for those slots.
    const sourceAnchor = edge.points[0] ?? first;
    const targetAnchor = edge.points.at(-1) ?? last;
    const previousEdge = previousById.get(edge.id);
    const attachedToDraggedNode = Boolean(
      draggedNodeId && (edge.source === draggedNodeId || edge.target === draggedNodeId)
    );
    const reroutedBecauseBlocked = edge.reroutedBecauseBlocked === true;
    return [{
      edgeId: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
      path: edge.path,
      points: clonePoints(edge.points),
      samples,
      sourceAnchor,
      targetAnchor,
      sourceEndpointDistance: distance(first, sourceAnchor),
      targetEndpointDistance: distance(last, targetAnchor),
      midpoint: { ...edge.midpoint },
      midpointSampleDistance: nearestSampleDistance(edge.midpoint, samples),
      nodeIntersections: intersectedNonEndpointNodes(edge, nodes, samples),
      reroutedBecauseBlocked,
      unrelatedRouteChanged: Boolean(
        draggedNodeId
        && !attachedToDraggedNode
        && previousEdge
        && previousEdge.path !== edge.path
        && !reroutedBecauseBlocked
      )
    }];
  });
  return {
    phase,
    capturedAt: new Date().toISOString(),
    ...(draggedNodeId ? { draggedNodeId } : {}),
    nodes: nodeRecords,
    edges,
    valid: edges.every((edge) =>
      edge.sourceEndpointDistance <= endpointTolerance
      && edge.targetEndpointDistance <= endpointTolerance
      && edge.nodeIntersections.length === 0
      && !edge.unrelatedRouteChanged
    )
  };
}

/** Stable evidence filename required by the canvas migration audit. */
export function geometryObservationFileName(
  scenario: string,
  phase: GeometryFramePhase,
  viewport: { width: number; height: number },
  extension: "json" | "png" = "json"
): string {
  const safeScenario = scenario.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "canvas";
  return `${safeScenario}-${phase}-${Math.round(viewport.width)}x${Math.round(viewport.height)}.${extension}`;
}

function intersectedNonEndpointNodes(
  edge: Pick<EdgeGeometry, "source" | "target">,
  nodes: readonly CanvasNode[],
  samples: readonly CanvasPoint[]
): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.id === edge.source || node.id === edge.target) continue;
    const size = canvasNodeSize(node);
    const intersects = polylineIntersectsRect(samples, {
      left: node.x,
      top: node.y,
      right: node.x + size.width,
      bottom: node.y + size.height
    });
    if (intersects) result.push(node.id);
  }
  return result;
}

function nearestSampleDistance(point: CanvasPoint, samples: readonly CanvasPoint[]): number {
  if (!samples.length) return Number.POSITIVE_INFINITY;
  if (samples.length === 1) return distance(point, samples[0]!);
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < samples.length; index += 1) {
    nearest = Math.min(nearest, pointToSegmentDistance(point, samples[index - 1]!, samples[index]!));
  }
  return nearest;
}

function pointToSegmentDistance(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return distance(point, { x: start.x + projection * dx, y: start.y + projection * dy });
}

function distance(left: CanvasPoint, right: CanvasPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function clonePoints(points: readonly CanvasPoint[]): CanvasPoint[] {
  return points.map((point) => ({ x: point.x, y: point.y }));
}
