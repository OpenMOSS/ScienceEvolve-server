import type { WorkflowCanvasPort } from "../../../types";
import type { CanvasEdge, CanvasNode, CanvasPoint, CanvasBounds, CanvasNodeGeometry } from "./canvas-model";
import { CANVAS_PORTS, canvasNodeSize } from "./canvas-model";
import { CanvasProximityIndex, CanvasSegmentIndex } from "./canvas-segment-index";

export interface EdgeGeometry {
  id: string;
  source: string;
  target: string;
  path: string;
  points: CanvasPoint[];
  midpoint: CanvasPoint;
  kind: CanvasEdge["kind"] | "main-dispatch";
  sourcePort: WorkflowCanvasPort;
  targetPort: WorkflowCanvasPort;
  sourcePortPinned: boolean;
  targetPortPinned: boolean;
  /** Samples of the rendered route used by labels, particles and audits. */
  samples: CanvasPoint[];
  /** Set only while a drag lock locally reroutes an otherwise unrelated edge
   * because the moving card genuinely blocks its captured route. */
  reroutedBecauseBlocked?: boolean;
  fixed?: boolean;
  label?: string;
  /** Cubic control points of the visible path (one pair per C command). */
  controlPoints?: Array<{ control1: CanvasPoint; control2: CanvasPoint }>;
  /** Join anchors for multi-cubic paths, retained for cheap drag updates. */
  curveJoins?: CanvasPoint[];
  /** Stable lateral preference retained by drag/layout consumers. */
  bend?: number;
}

/** A serializable route structure captured at pointer-down. */
export interface DragRouteLock {
  edgeId: string;
  source: string;
  target: string;
  kind: EdgeGeometry["kind"];
  fixed?: boolean;
  label?: string;
  sourceSide: WorkflowCanvasPort;
  targetSide: WorkflowCanvasPort;
  sourcePinned: boolean;
  targetPinned: boolean;
  points: CanvasPoint[];
  samples: CanvasPoint[];
  lane?: number;
  bend?: CanvasPoint;
  startEndpoint: { source: CanvasPoint; target: CanvasPoint };
  sourcePosition: CanvasPoint;
  targetPosition: CanvasPoint;
  path: string;
  midpoint: CanvasPoint;
  /** Lateral cubic preference captured at pointer-down. */
  curveBend?: number;
  controlPoints?: Array<{ control1: CanvasPoint; control2: CanvasPoint }>;
  /** Join anchors for multi-cubic paths, retained for cheap drag updates. */
  curveJoins?: CanvasPoint[];
}

export interface LockedRouteOptions {
  nodes?: readonly CanvasNode[];
  draggedNodeId?: string;
  /** Use the captured cubic directly; reserve full routing for true blockers. */
  fast?: boolean;
  /** Keep temporary layout frames curved when the cheap safe fallback has no
   * two-cubic solution. Persisted frames still use the full router. */
  smoothFallback?: boolean;
}

interface Rect { left: number; top: number; right: number; bottom: number; }

/** Stable semantic key for reusing a routed frame while node positions move. */
export function canvasRouteTopologyKey(edges: readonly CanvasEdge[]): string {
  return edges
    .map((edge) => [
      edge.id,
      edge.source,
      edge.target,
      edge.kind,
      edge.systemRoute ?? "",
      edge.sourcePort,
      edge.targetPort,
      edge.sourcePortPinned ? "1" : "0",
      edge.targetPortPinned ? "1" : "0"
    ].join(":"))
    .sort()
    .join("|");
}

/**
 * Deterministic port-aware cubic router shared by full and compact views.
 * Routes are sorted by id, reserve their segments, and apply a conflict
 * penalty so parallel curves remain readable while node dragging does not
 * cause random lane changes.
 */
/** Capture route structure at pointer-down for stable drag rendering. */
export function captureRouteLock(
  geometry: readonly EdgeGeometry[],
  nodes: readonly CanvasNode[] = []
): DragRouteLock[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return geometry.map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    return {
      edgeId: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      fixed: edge.fixed,
      label: edge.label,
      sourceSide: edge.sourcePort,
      targetSide: edge.targetPort,
      sourcePinned: edge.sourcePortPinned,
      targetPinned: edge.targetPortPinned,
      points: clonePoints(edge.points),
      samples: clonePoints(edge.samples),
      bend: clonePoint(edge.midpoint),
      startEndpoint: {
        source: clonePoint(edge.points[0] ?? { x: 0, y: 0 }),
        target: clonePoint(edge.points.at(-1) ?? { x: 0, y: 0 })
      },
      sourcePosition: { x: source?.x ?? 0, y: source?.y ?? 0 },
      targetPosition: { x: target?.x ?? 0, y: target?.y ?? 0 },
      path: edge.path,
      midpoint: clonePoint(edge.midpoint),
      curveBend: edge.bend,
      controlPoints: edge.controlPoints?.map((pair) => ({
        control1: clonePoint(pair.control1),
        control2: clonePoint(pair.control2)
      })),
      curveJoins: captureCurveJoins(edge)
    };
  });
}

/**
 * Rehydrate the geometry captured at pointer-down without invoking the full
 * obstacle-aware router.  Drag rendering uses this as its immutable base and
 * only rebuilds routes whose endpoints (or obstacle visibility) actually
 * changed.
 */
const restoredRouteLocks = new WeakMap<readonly DragRouteLock[], EdgeGeometry[]>();

export function geometryFromRouteLocks(locked: readonly DragRouteLock[]): EdgeGeometry[] {
  const cached = restoredRouteLocks.get(locked);
  if (cached) return cached;
  const geometry = locked.map((lock) => ({
    id: lock.edgeId,
    source: lock.source,
    target: lock.target,
    path: lock.path,
    points: clonePoints(lock.points),
    midpoint: clonePoint(lock.midpoint),
    kind: lock.kind,
    sourcePort: lock.sourceSide,
    targetPort: lock.targetSide,
    sourcePortPinned: lock.sourcePinned,
    targetPortPinned: lock.targetPinned,
    samples: clonePoints(lock.samples),
    fixed: lock.fixed,
    label: lock.label,
    controlPoints: lock.controlPoints?.map((pair) => ({
      control1: clonePoint(pair.control1),
      control2: clonePoint(pair.control2)
    })),
    curveJoins: lock.curveJoins?.map(clonePoint),
    bend: lock.curveBend
  }));
  restoredRouteLocks.set(locked, geometry);
  return geometry;
}

/**
 * Drag-only route update.  Unlike routeCanvasEdges(), this starts from the
 * captured route snapshot, so a pointer move never pays the cost of routing
 * every edge in the graph before applying the lock.
 */
export function buildLockedEdgeRoutesFromSnapshot(
  locked: readonly DragRouteLock[] | undefined,
  options: LockedRouteOptions = {},
  tolerance = 0.01
): EdgeGeometry[] {
  if (!locked?.length) return [];
  return buildLockedEdgeRoutes(geometryFromRouteLocks(locked), locked, { ...options, fast: options.fast ?? true }, tolerance);
}

/**
 * Keep unrelated edges exact while attached edges follow live endpoints. A
 * blocked unrelated route is the only case that may be locally rerouted.
 */
export function buildLockedEdgeRoutes(
  live: readonly EdgeGeometry[],
  locked: readonly DragRouteLock[] | undefined,
  options: LockedRouteOptions = {},
  tolerance = 0.01
): EdgeGeometry[] {
  if (!locked?.length) return [...live];
  const snapshots = new Map(locked.map((edge) => [edge.edgeId, edge]));
  const nodes = options.nodes ?? [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const reserved = new CanvasSegmentIndex(live
    .filter((edge) => !options.draggedNodeId || (edge.source !== options.draggedNodeId && edge.target !== options.draggedNodeId))
    .flatMap((edge) => segments(edge.points)));
  return live.map((edge, edgeIndex) => {
    const snapshot = snapshots.get(edge.id);
    if (!snapshot) return edge;
    // System dispatch edges can share a fractional target slot. Compare their
    // actual live endpoints rather than rebuilding them through the four
    // cardinal midpoints. User edges into Main are ordinary routes.
    if (edge.kind === "main-dispatch") {
      // Snapshot-only drag updates do not have a freshly routed `edge`, so
      // move its captured fractional slots with their owning nodes.  Without
      // this, a dispatch curve stayed attached to the target's pointer-down
      // position even though the card itself had moved.
      const start = options.fast
        ? shiftedEndpoint(snapshot.startEndpoint.source, snapshot, nodeById, "source")
        : edge.points[0] ?? snapshot.startEndpoint.source;
      const end = options.fast
        ? shiftedEndpoint(snapshot.startEndpoint.target, snapshot, nodeById, "target")
        : edge.points.at(-1) ?? snapshot.startEndpoint.target;
      const endpointChanged = distance(start, snapshot.startEndpoint.source) > tolerance
        || distance(end, snapshot.startEndpoint.target) > tolerance;
      const attached = edge.source === options.draggedNodeId || edge.target === options.draggedNodeId;
      const blocked = !attached && Boolean(options.draggedNodeId) && routeIntersectsNode(
        snapshot.samples,
        nodeById.get(options.draggedNodeId!)
      );
      if (!endpointChanged && !blocked) {
        return options.smoothFallback
          ? smoothLockedGeometry(edge, snapshot, nodes)
          : edge.path === snapshot.path ? edge : restoreLockedGeometry(edge, snapshot);
      }
      if (blocked) {
        if (options.fast && nodes.length) {
          const reroute = chooseRoute(
            start,
            end,
            snapshot.sourceSide,
            snapshot.targetSide,
            nodes,
            reserved,
            edgeIndex,
            edge
          );
          const planned = geometryFromPlanningPointsFast(edge, reroute, snapshot.sourceSide, snapshot.targetSide, snapshot.curveBend, true, nodes, options.smoothFallback);
          // The fast corridor is the last line of defence during a pointer
          // move.  Never fall back to the global curve search here: doing so
          // would reintroduce the long task this snapshot path is designed to
          // avoid.  The corridor is built with obstacle clearance and the
          // geometry observer will flag an exceptional impossible layout.
          return planned;
        }
        return { ...edge, reroutedBecauseBlocked: true };
      }
      if (options.fast) {
        const movedStart = shiftedEndpoint(snapshot.startEndpoint.source, snapshot, nodeById, "source");
        const movedEnd = shiftedEndpoint(snapshot.startEndpoint.target, snapshot, nodeById, "target");
        const points = elasticRoutePoints(snapshot, movedStart, movedEnd, snapshot.sourceSide, snapshot.targetSide);
        const fast = geometryFromLockedPoints(edge, snapshot, points, snapshot.sourceSide, snapshot.targetSide);
        return routeHitsNonEndpointNode(fast.samples, edge, nodes)
          ? geometryFromPlanningPointsFast(edge, chooseRoute(movedStart, movedEnd, snapshot.sourceSide, snapshot.targetSide, nodes, reserved, edgeIndex, edge), snapshot.sourceSide, snapshot.targetSide, snapshot.curveBend, false, nodes, options.smoothFallback)
          : fast;
      }
      // A non-fast caller already supplied geometry routed against the live
      // nodes. Reuse that result if a layout transaction moved an endpoint
      // outside an active pointer drag.
      return edge;
    }
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) return edge;
    const sourcePort = snapshot.sourcePinned
      ? snapshot.sourceSide
      : lockedPort(edge.kind, edge.sourcePort, snapshot.sourceSide, sourceNode, targetNode);
    const targetPort = snapshot.targetPinned
      ? snapshot.targetSide
      : lockedPort(edge.kind, edge.targetPort, snapshot.targetSide, targetNode, sourceNode);
    const start = canvasPortPoint(sourceNode, sourcePort);
    const end = canvasPortPoint(targetNode, targetPort);
    const endpointChanged = distance(start, snapshot.startEndpoint.source) > tolerance
      || distance(end, snapshot.startEndpoint.target) > tolerance
      || sourcePort !== snapshot.sourceSide
      || targetPort !== snapshot.targetSide;
    const attached = edge.source === options.draggedNodeId || edge.target === options.draggedNodeId;
    const blocked = !attached && Boolean(options.draggedNodeId) && routeIntersectsNode(
      snapshot.samples,
      nodeById.get(options.draggedNodeId!)
    );
    if (!endpointChanged && !blocked) {
      return options.smoothFallback
        ? smoothLockedGeometry(edge, snapshot, nodes)
        : edge.path === snapshot.path ? edge : restoreLockedGeometry(edge, snapshot);
    }
    if (blocked && nodes.length) {
      const points = chooseRoute(start, end, sourcePort, targetPort, nodes, reserved, edgeIndex, edge);
      return options.fast
        ? geometryFromPlanningPointsFast(edge, points, sourcePort, targetPort, snapshot.curveBend, true, nodes, options.smoothFallback)
        : geometryFromPoints(edge, points, sourcePort, targetPort, true, nodes, snapshot.curveBend);
    }
    let points = endpointChanged
      ? elasticRoutePoints(snapshot, start, end, sourcePort, targetPort)
      : snapshot.points;
    let rerouted = false;
    // Keep the captured route topology while it remains clear. If the moving
    // card or a nearby card now blocks an attached route, switch only that
    // route to the deterministic obstacle-aware router. This is the same
    // rerouting boundary used for unrelated blocked routes and prevents a
    // dragged edge from visibly tunnelling through another card.
    if (nodes.length && routeCrossesNonEndpointNode(points, edge, nodes)) {
      points = chooseRoute(start, end, sourcePort, targetPort, nodes, reserved, edgeIndex, edge);
      rerouted = true;
    }
    if (options.fast) {
      const fast = rerouted
        ? geometryFromPlanningPointsFast(edge, points, sourcePort, targetPort, snapshot.curveBend, false, nodes, options.smoothFallback)
        : geometryFromLockedPoints(edge, snapshot, points, sourcePort, targetPort);
      if (!routeHitsNonEndpointNode(fast.samples, edge, nodes)) return fast;
      const safePoints = rerouted
        ? points
        : chooseRoute(start, end, sourcePort, targetPort, nodes, reserved, edgeIndex, edge);
      const planned = geometryFromPlanningPointsFast(edge, safePoints, sourcePort, targetPort, snapshot.curveBend, rerouted, nodes, options.smoothFallback);
      return planned;
    }
    return geometryFromPoints(edge, points, sourcePort, targetPort, false, nodes, snapshot.curveBend);
  });
}

export function routeCanvasEdges(
  edges: readonly CanvasEdge[],
  nodes: readonly CanvasNode[],
  options: CanvasRouteOptions = {}
): EdgeGeometry[] {
  return [...routeCanvasEdgesInSteps(edges, nodes, options)];
}

export interface CanvasRouteOptions {
  lockRoutes?: boolean;
  /** Use the obstacle-safe planning corridor without the exhaustive visual
   * curve search. Suitable for layout scoring and bounded large-graph
   * commits; the regular router remains the highest-quality path. */
  fastEvaluation?: boolean;
  /** Keep the bounded layout route curved when no hard-safe projection is
   * available. This is used for large layout commits where the exhaustive
   * outer-lane search would otherwise monopolize the main thread. */
  smoothFallback?: boolean;
}

/** Also consumed cooperatively when a browser cannot start a routing worker. */
export function* routeCanvasEdgesInSteps(
  edges: readonly CanvasEdge[],
  nodes: readonly CanvasNode[],
  options: CanvasRouteOptions = {}
): Generator<EdgeGeometry> {
  const ordinary = edges.filter((edge) => edge.systemRoute !== "main-dispatch");
  const dispatch = edges.filter((edge) => edge.systemRoute === "main-dispatch");
  const reserved: Segment[] = [];
  const reservationIndex = new CanvasSegmentIndex();
  const bendOverrides = stableBusinessBends(ordinary);
  const sorted = [...ordinary].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, edge] of sorted.entries()) {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    if (!source || !target) continue;
    const { sourcePort, targetPort, points, rendered } = ordinaryRouteGeometry(
      edge,
      source,
      target,
      nodes,
      reserved,
      index,
      options.lockRoutes,
      bendOverrides.get(edge.id),
      options.fastEvaluation,
      options.smoothFallback,
      reservationIndex
    );
    // Reserve only after rendering so an edge never competes with its own
    // planning anchors while selecting a smooth bend.
    const plannedSegments = segments(points);
    reserved.push(...plannedSegments);
    reservationIndex.add(plannedSegments);
    yield {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      path: rendered.path,
      points,
      samples: rendered.samples,
      midpoint: rendered.midpoint,
      kind: edge.kind,
      sourcePort,
      targetPort,
      sourcePortPinned: edge.sourcePortPinned,
      targetPortPinned: edge.targetPortPinned,
      fixed: edge.fixed,
      label: edge.kind === "termination" ? "结束" : edge.kind === "parallel" ? "并行" : edge.kind === "strong" ? "强边" : "弱边",
      controlPoints: rendered.controlPoints,
      bend: rendered.bend
    };
  }
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const main = dispatch.sort((a, b) => (
    (nodeOrder.get(a.target) ?? 0) - (nodeOrder.get(b.target) ?? 0)
    || a.id.localeCompare(b.id)
  ));
  const dispatchSourcePort = sharedDispatchSourcePort(main, nodes);
  for (const [index, edge] of main.entries()) {
    const geometry = mainDispatchGeometry(edge, nodes, index, main.length, reserved, dispatchSourcePort, reservationIndex);
    if (!geometry) continue;
    const plannedSegments = segments(geometry.points);
    reserved.push(...plannedSegments);
    reservationIndex.add(plannedSegments);
    yield geometry;
  }
}

/** Complete, linear-cost first paint while the canonical obstacle solver runs
 * off the UI thread. No edges or pinned ports are omitted from this preview. */
export function previewCanvasEdges(edges: readonly CanvasEdge[], nodes: readonly CanvasNode[]): EdgeGeometry[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const dispatch = edges.filter((edge) => edge.systemRoute === "main-dispatch");
  const sharedSourcePort = sharedDispatchSourcePort(dispatch, nodes);
  const bends = stableBusinessBends(edges.filter((edge) => edge.systemRoute !== "main-dispatch"));
  return edges.flatMap((edge) => {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) return [];
    const system = edge.systemRoute === "main-dispatch";
    const sourcePort = system ? sharedSourcePort ?? edge.sourcePort : edge.sourcePort;
    const targetPort = edge.targetPort;
    const start = canvasPortPoint(source, sourcePort);
    const end = canvasPortPoint(target, targetPort);
    const rendered = directCubicGeometry(start, end, sourcePort, targetPort, bends.get(edge.id) ?? 0);
    return [{
      id: edge.id, source: edge.source, target: edge.target,
      ...rendered, points: [start, end], kind: system ? "main-dispatch" as const : edge.kind,
      sourcePort, targetPort, sourcePortPinned: edge.sourcePortPinned, targetPortPinned: edge.targetPortPinned,
      fixed: edge.fixed, label: system ? "Main 固定调度" : edge.kind === "termination" ? "结束" : edge.kind === "parallel" ? "并行" : edge.kind === "strong" ? "强边" : "弱边"
    }];
  });
}

/** Route one edge through the canonical router. */
export function routeCanvasEdge(
  edge: CanvasEdge,
  nodes: readonly CanvasNode[],
  edgeIndex = 0
): EdgeGeometry | undefined {
  if (edge.systemRoute === "main-dispatch") return mainDispatchGeometry(edge, nodes, edgeIndex, 1);
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return undefined;
  const { sourcePort, targetPort, points, rendered } = ordinaryRouteGeometry(
    edge,
    source,
    target,
    nodes,
    [],
    edgeIndex
  );
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    path: rendered.path,
    points,
    samples: rendered.samples,
    midpoint: rendered.midpoint,
    kind: edge.kind,
    sourcePort,
    targetPort,
    sourcePortPinned: edge.sourcePortPinned,
    targetPortPinned: edge.targetPortPinned,
    fixed: edge.fixed,
    label: edge.kind === "termination" ? "结束" : edge.kind === "strong" ? "强边" : "弱边",
    controlPoints: rendered.controlPoints,
    bend: rendered.bend
  };
}

interface OrdinaryRouteResult {
  sourcePort: WorkflowCanvasPort;
  targetPort: WorkflowCanvasPort;
  points: CanvasPoint[];
  rendered: RenderedRouteGeometry;
}

/**
 * Route an ordinary edge from the geometrically natural ports first. Most
 * edges stop there, which keeps pointer-frame routing cheap and stable. Old
 * projects can, however, place a third card directly in front of that port
 * pair. The curve renderer used to preserve the pair by taking a very large
 * outside lane, shrinking the entire fitted canvas. Only for that outlier do
 * we compare the remaining unpinned port pairs and choose the compact clear
 * route. Explicit user pins are never changed.
 */
function ordinaryRouteGeometry(
  edge: CanvasEdge,
  source: CanvasNode,
  target: CanvasNode,
  nodes: readonly CanvasNode[],
  reserved: readonly Segment[],
  edgeIndex: number,
  lockRoutes = false,
  preferredBendOverride?: number,
  fastEvaluation = false,
  smoothFallback = false,
  reservationIndex = new CanvasSegmentIndex(reserved)
): OrdinaryRouteResult {
  const preferredSource = adaptivePort(source, target, edge.sourcePort);
  const preferredTarget = adaptivePort(target, source, edge.targetPort);
  const initialSource = edge.sourcePortPinned ? edge.sourcePort : preferredSource;
  const initialTarget = edge.targetPortPinned ? edge.targetPort : preferredTarget;
  const build = (
    sourcePort: WorkflowCanvasPort,
    targetPort: WorkflowCanvasPort,
    highQuality: boolean
  ): OrdinaryRouteResult => {
    const start = canvasPortPoint(source, sourcePort);
    const end = canvasPortPoint(target, targetPort);
    const planned = chooseRoute(start, end, sourcePort, targetPort, nodes, reservationIndex, edgeIndex, edge);
    const points = lockRoutes ? [start, end] : planned;
    const preferredBend = preferredBendOverride ?? routeBendPreference(points, start, end, edgeIndex);
    return {
      sourcePort,
      targetPort,
      points,
      rendered: highQuality
        ? renderedRouteGeometry(edge, points, sourcePort, targetPort, nodes, reserved, edgeIndex, preferredBendOverride)
        : fastPlanningGeometry(start, end, points, sourcePort, targetPort, preferredBend, nodes, edge, smoothFallback)
    };
  };

  // Port recovery may compare up to sixteen endpoint pairs. Use the same
  // obstacle corridor with a cheap smooth projection for that comparison,
  // then run the exhaustive visual renderer exactly once for the winner.
  let best = build(initialSource, initialTarget, false);
  const initialNeedsRecovery = routeNeedsPortRecovery(best, edge, nodes);
  if ((edge.sourcePortPinned && edge.targetPortPinned) || !initialNeedsRecovery) {
    return fastEvaluation ? best : build(best.sourcePort, best.targetPort, true);
  }
  // A very tight but legitimate aisle can make the cheap projection fall
  // back to a multi-segment chain even though the high-quality renderer can
  // keep the geometrically natural ports with two smooth curves. Preserve
  // that natural pair before considering a side switch.
  if (!fastEvaluation && best.rendered.controlPoints.length > 2) {
    const natural = build(initialSource, initialTarget, true);
    if (!routeNeedsPortRecovery(natural, edge, nodes)) return natural;
  }

  let bestScore = ordinaryRouteScore(
    best,
    edge,
    nodes,
    source,
    target,
    preferredSource,
    preferredTarget
  );
  const sourcePorts = edge.sourcePortPinned
    ? [edge.sourcePort]
    : orderedPorts(preferredSource, edge.sourcePort);
  const targetPorts = edge.targetPortPinned
    ? [edge.targetPort]
    : orderedPorts(preferredTarget, edge.targetPort);
  for (const sourcePort of sourcePorts) {
    for (const targetPort of targetPorts) {
      if (sourcePort === initialSource && targetPort === initialTarget) continue;
      const candidate = build(sourcePort, targetPort, false);
      const score = ordinaryRouteScore(
        candidate,
        edge,
        nodes,
        source,
        target,
        preferredSource,
        preferredTarget
      );
      if (score < bestScore - .01) {
        best = candidate;
        bestScore = score;
      }
    }
  }
  return fastEvaluation ? best : build(best.sourcePort, best.targetPort, true);
}

function orderedPorts(primary: WorkflowCanvasPort, stored: WorkflowCanvasPort): WorkflowCanvasPort[] {
  return [...new Set<WorkflowCanvasPort>([primary, stored, ...CANVAS_PORTS])];
}

function routeNeedsPortRecovery(
  route: OrdinaryRouteResult,
  edge: Pick<CanvasEdge, "source" | "target">,
  nodes: readonly CanvasNode[]
): boolean {
  if (routeCrossesNonEndpointNode(route.rendered.samples, edge, nodes)) return true;
  const bounds = canvasNodesRect(nodes, 36);
  return bounds ? curveExcursion(route.rendered.samples, bounds) > 96 : false;
}

function ordinaryRouteScore(
  route: OrdinaryRouteResult,
  edge: CanvasEdge,
  nodes: readonly CanvasNode[],
  source: CanvasNode,
  target: CanvasNode,
  preferredSource: WorkflowCanvasPort,
  preferredTarget: WorkflowCanvasPort
): number {
  const start = route.points[0]!;
  const end = route.points.at(-1)!;
  const bounds = canvasNodesRect(nodes, 36);
  let score = sampledLength(route.rendered.samples)
    + pathLength(route.points) * .12
    + Math.max(0, route.points.length - 2) * 12;
  if (routeCrossesNonEndpointNode(route.rendered.samples, edge, nodes)) score += 1_000_000;
  if (bounds) score += curveExcursion(route.rendered.samples, bounds) * 5;
  score += portDirectionPenalty(source, target, route.sourcePort, route.targetPort);
  if (route.sourcePort !== preferredSource) score += 18;
  if (route.targetPort !== preferredTarget) score += 18;
  if (route.sourcePort !== edge.sourcePort) score += 6;
  if (route.targetPort !== edge.targetPort) score += 6;
  // Very indirect candidates can remain within the global graph bounds. This
  // ratio catches those without discouraging a legitimate short detour.
  score += Math.max(0, sampledLength(route.rendered.samples) - distance(start, end) * 1.8) * .7;
  return score;
}

function canvasNodesRect(nodes: readonly CanvasNode[], padding = 0): Rect | undefined {
  if (!nodes.length) return undefined;
  return nodes.reduce<Rect>((bounds, node) => {
    const size = canvasNodeSize(node);
    return {
      left: Math.min(bounds.left, node.x - padding),
      top: Math.min(bounds.top, node.y - padding),
      right: Math.max(bounds.right, node.x + size.width + padding),
      bottom: Math.max(bounds.bottom, node.y + size.height + padding)
    };
  }, {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY
  });
}

function portDirectionPenalty(
  source: CanvasNode,
  target: CanvasNode,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort
): number {
  const sourceSize = canvasNodeSize(source);
  const targetSize = canvasNodeSize(target);
  const dx = target.x + targetSize.width / 2 - source.x - sourceSize.width / 2;
  const dy = target.y + targetSize.height / 2 - source.y - sourceSize.height / 2;
  const length = Math.max(1, Math.hypot(dx, dy));
  const direction = { x: dx / length, y: dy / length };
  const sourceAlignment = direction.x * portVector(sourcePort).x + direction.y * portVector(sourcePort).y;
  const targetAlignment = -direction.x * portVector(targetPort).x - direction.y * portVector(targetPort).y;
  return (1 - sourceAlignment) * 28
    + (1 - targetAlignment) * 28
    + (sourceAlignment < -.1 ? 140 : 0)
    + (targetAlignment < -.1 ? 140 : 0);
}

/** Give repeated and reciprocal business edges a small, deterministic lane.
 * A reciprocal pair receives the same signed bend because reversing the path
 * also reverses its normal vector, placing the two curves on opposite sides
 * of the shared centre line. */
function stableBusinessBends(edges: readonly CanvasEdge[]): Map<string, number> {
  const result = new Map<string, number>();
  const directed = new Map<string, CanvasEdge[]>();
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.target}`;
    const group = directed.get(key) ?? [];
    group.push(edge);
    directed.set(key, group);
  }
  for (const [key, group] of directed) {
    const [source, target] = key.split("\u0000");
    const ordered = [...group].sort((left, right) => left.id.localeCompare(right.id));
    if (ordered.length > 1) {
      ordered.forEach((edge, index) => result.set(edge.id, (index - (ordered.length - 1) / 2) * 24));
      continue;
    }
    if ((directed.get(`${target}\u0000${source}`)?.length ?? 0) > 0) result.set(ordered[0]!.id, 24);
  }
  return result;
}

/** All fixed Main fan-out edges leave through one shared side. The side is
 * derived from the current target centroid so Main can move with the graph. */
function sharedDispatchSourcePort(
  edges: readonly CanvasEdge[],
  nodes: readonly CanvasNode[]
): WorkflowCanvasPort | undefined {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const main = nodeMap.get("main");
  if (!main || !edges.length) return undefined;
  const targets = edges.flatMap((edge) => {
    const node = nodeMap.get(edge.target);
    if (!node) return [];
    const size = canvasNodeSize(node);
    return [{ x: node.x + size.width / 2, y: node.y + size.height / 2 }];
  });
  if (!targets.length) return undefined;
  const mainSize = canvasNodeSize(main);
  const center = { x: main.x + mainSize.width / 2, y: main.y + mainSize.height / 2 };
  const centroid = targets.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  centroid.x /= targets.length;
  centroid.y /= targets.length;
  const dx = centroid.x - center.x;
  const dy = centroid.y - center.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0 ? "right" : "left"
    : dy >= 0 ? "bottom" : "top";
}

/** Canonical Main fan-out geometry used by modern and compatibility APIs. */
export function mainDispatchGeometry(
  edge: CanvasEdge,
  nodes: readonly CanvasNode[],
  index: number,
  total: number,
  reserved: readonly Segment[] = [],
  sharedSourcePort?: WorkflowCanvasPort,
  reservationIndex = new CanvasSegmentIndex(reserved)
): EdgeGeometry | undefined {
  if (edge.source !== "main" || edge.target === "finish") return undefined;
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return undefined;
  const sourcePort = sharedSourcePort ?? adaptivePort(source, target, edge.sourcePort);
  const naturalTargetPort = edge.targetPortPinned ? edge.targetPort : adaptivePort(target, source, edge.targetPort);
  const lane = (index - (total - 1) / 2) * 20;
  const targetSize = canvasNodeSize(target);
  const start = canvasPortPoint(source, sourcePort);
  const dispatchBendLimit = dispatchCurveBendLimit(source, target, nodes);
  const build = (targetPort: WorkflowCanvasPort, broadDetour = false, forceDetour = false) => {
    const targetSpan = targetPort === "left" || targetPort === "right" ? targetSize.height : targetSize.width;
    const targetRatio = .5 + Math.max(-.28, Math.min(.28, lane * .32 / Math.max(1, targetSpan)));
    const end = canvasSidePoint(target, targetPort, targetRatio);
    const points = chooseRoute(start, end, sourcePort, targetPort, nodes, reservationIndex, index, edge);
    const rendered = renderedRouteGeometry(
      { source: edge.source, target: edge.target, kind: "main-dispatch" },
      points,
      sourcePort,
      targetPort,
      nodes,
      reserved,
      index,
      lane * .72,
      broadDetour,
      forceDetour,
      dispatchBendLimit
    );
    return { targetPort, points, rendered };
  };
  const targetPorts = edge.targetPortPinned
    ? [naturalTargetPort]
    : orderedPorts(naturalTargetPort, edge.targetPort);
  let route = build(naturalTargetPort);
  let routeScore = mainDispatchRouteScore(route, edge, nodes, naturalTargetPort);
  if (routeScore >= 1_000_000) {
    for (const targetPort of targetPorts) {
      if (targetPort === naturalTargetPort) continue;
      const candidate = build(targetPort);
      const score = mainDispatchRouteScore(candidate, edge, nodes, naturalTargetPort);
      if (score < routeScore) {
        route = candidate;
        routeScore = score;
      }
    }
  }
  // Collision sampling uses the rendered curve, rather than only the
  // orthogonal planning anchors. Dense worker grids can leave a direct cubic
  // just below the planner's threshold while its bow still enters a card.
  // Re-run the bounded two-cubic search in that case and choose the shortest
  // candidate that is clear in the same geometry used by the audit.
  if (routeCrossesNonEndpointNode(route.rendered.samples, edge, nodes)) {
    const forcedCandidates = targetPorts.map((targetPort) => build(targetPort, true, true));
    const clear = forcedCandidates
      .filter((candidate) => !routeCrossesNonEndpointNode(candidate.rendered.samples, edge, nodes))
      .sort((left, right) => mainDispatchRouteScore(left, edge, nodes, naturalTargetPort)
        - mainDispatchRouteScore(right, edge, nodes, naturalTargetPort));
    if (clear[0]) route = clear[0];
  }
  const { targetPort, points, rendered } = route;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    path: rendered.path,
    points,
    samples: rendered.samples,
    midpoint: rendered.midpoint,
    kind: "main-dispatch",
    sourcePort,
    targetPort,
    // These sides are system-derived, not user pins. Drag locking applies a
    // generous hysteresis so they remain steady during a gesture while still
    // being free to adapt after a genuine side change.
    sourcePortPinned: false,
    targetPortPinned: false,
    fixed: true,
    label: "Main 固定调度",
    controlPoints: rendered.controlPoints,
    bend: rendered.bend
  };
}

function mainDispatchRouteScore(
  route: { targetPort: WorkflowCanvasPort; points: CanvasPoint[]; rendered: RenderedRouteGeometry },
  edge: Pick<CanvasEdge, "source" | "target">,
  nodes: readonly CanvasNode[],
  naturalTargetPort: WorkflowCanvasPort
): number {
  const bounds = canvasNodesRect(nodes, 36);
  return (routeCrossesNonEndpointNode(route.rendered.samples, edge, nodes) ? 1_000_000 : 0)
    + sampledLength(route.rendered.samples)
    + pathLength(route.points) * .08
    + (bounds ? curveExcursion(route.rendered.samples, bounds) * 4 : 0)
    + (route.targetPort === naturalTargetPort ? 0 : 18);
}

/** A dense dispatch fan-out needs more room than the ordinary 136px bend
 * cap. The limit is still bounded by the current worker area so a curve can
 * clear a grid without creating an unbounded viewport excursion. */
function dispatchCurveBendLimit(
  source: CanvasNode,
  target: CanvasNode,
  nodes: readonly CanvasNode[]
): number {
  const workerRects = nodes
    .filter((node) => node.id !== source.id && node.id !== "input" && node.id !== "finish")
    .map((node) => {
      const size = canvasNodeSize(node);
      return { left: node.x, top: node.y, right: node.x + size.width, bottom: node.y + size.height };
    });
  if (!workerRects.length) return 136;
  // Small hub compositions already have a local corridor and the reference
  // curve cap keeps their visual envelope compact. Larger dispatch grids need
  // the extra bend room to reach a column aisle without crossing a card.
  if (workerRects.length <= 10) return 136;
  const left = Math.min(...workerRects.map((rect) => rect.left));
  const right = Math.max(...workerRects.map((rect) => rect.right));
  const top = Math.min(...workerRects.map((rect) => rect.top));
  const bottom = Math.max(...workerRects.map((rect) => rect.bottom));
  const targetSize = canvasNodeSize(target);
  const targetCenter = { x: target.x + targetSize.width / 2, y: target.y + targetSize.height / 2 };
  const sourceSize = canvasNodeSize(source);
  const sourceCenter = { x: source.x + sourceSize.width / 2, y: source.y + sourceSize.height / 2 };
  const outer = Math.max(
    Math.abs(targetCenter.x - sourceCenter.x),
    Math.abs(targetCenter.y - sourceCenter.y),
    Math.abs(right - left),
    Math.abs(bottom - top)
  );
  return Math.min(1_600, Math.max(136, outer * 1.25));
}

function canvasSidePoint(node: CanvasNode, port: WorkflowCanvasPort, ratio: number): CanvasPoint {
  const size = canvasNodeSize(node);
  const bounded = Math.max(.08, Math.min(.92, ratio));
  if (port === "left") return { x: node.x, y: node.y + size.height * bounded };
  if (port === "right") return { x: node.x + size.width, y: node.y + size.height * bounded };
  if (port === "top") return { x: node.x + size.width * bounded, y: node.y };
  return { x: node.x + size.width * bounded, y: node.y + size.height };
}

export function routeBounds(geometries: readonly EdgeGeometry[]): CanvasBounds | undefined {
  // Bounds must include the actual rendered curve, not just orthogonal route
  // anchors/control metadata; otherwise a bowed edge can be clipped by fit().
  const points = geometries.flatMap((geometry) => geometry.samples.length ? geometry.samples : geometry.points);
  if (!points.length) return undefined;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

function chooseRoute(
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  nodes: readonly CanvasNode[],
  reserved: CanvasSegmentIndex,
  edgeIndex: number,
  edge: Pick<CanvasEdge, "source" | "target">
): CanvasPoint[] {
  const obstacles = nodes.map((node) => {
    const size = canvasNodeSize(node);
    const padding = node.id === edge.source || node.id === edge.target ? 0 : 22;
    const rect = { left: node.x - padding, top: node.y - padding, right: node.x + size.width + padding, bottom: node.y + size.height + padding };
    // Cards may be closer than the preferred clearance without overlapping.
    // Reduce only the clearance when it encloses an endpoint; never discard
    // the entire neighbouring card from the obstacle set.
    return padding && (containsEndpoint(rect, start) || containsEndpoint(rect, end))
      ? { left: node.x, top: node.y, right: node.x + size.width, bottom: node.y + size.height }
      : rect;
  });
  const bounds = obstacles.reduce<Rect>((acc, rect) => ({
    left: Math.min(acc.left, rect.left), top: Math.min(acc.top, rect.top),
    right: Math.max(acc.right, rect.right), bottom: Math.max(acc.bottom, rect.bottom)
  }), { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) });
  const lane = ((edgeIndex % 7) - 3) * 16;
  const candidates: CanvasPoint[][] = [
    [start, { x: (start.x + end.x) / 2 + lane, y: start.y }, { x: (start.x + end.x) / 2 + lane, y: end.y }, end],
    [start, { x: start.x, y: (start.y + end.y) / 2 + lane }, { x: end.x, y: (start.y + end.y) / 2 + lane }, end]
  ];
  const gap = 70 + Math.abs(lane);
  candidates.push(
    [start, { x: start.x, y: bounds.top - gap }, { x: end.x, y: bounds.top - gap }, end],
    [start, { x: start.x, y: bounds.bottom + gap }, { x: end.x, y: bounds.bottom + gap }, end],
    [start, { x: bounds.left - gap, y: start.y }, { x: bounds.left - gap, y: end.y }, end],
    [start, { x: bounds.right + gap, y: start.y }, { x: bounds.right + gap, y: end.y }, end]
  );
  // Respect the direction of pinned ports with a short escape segment.
  candidates.push(portAwareCandidate(start, end, sourcePort, targetPort));
  for (const lead of [34, 12]) {
    const a = escape(start, sourcePort, lead);
    const b = escape(end, targetPort, lead);
    const xs = new Set([bounds.left - gap, bounds.right + gap, ...obstacles.flatMap((rect) => [rect.left - 12, rect.right + 12])]);
    const ys = new Set([bounds.top - gap, bounds.bottom + gap, ...obstacles.flatMap((rect) => [rect.top - 12, rect.bottom + 12])]);
    for (const x of xs) candidates.push([start, a, { x, y: a.y }, { x, y: b.y }, b, end]);
    for (const y of ys) candidates.push([start, a, { x: a.x, y }, { x: b.x, y }, b, end]);
  }
  let best: CanvasPoint[] | undefined;
  let score = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const compact = simplify(candidate);
    if (!followsPortDirections(compact, sourcePort, targetPort)) continue;
    const length = pathLength(compact);
    const bends = Math.max(0, compact.length - 2);
    // Conflicts only increase the score. Keep the original candidate order
    // and tie rule while avoiding work for candidates that cannot win.
    if (length + bends * 70 + Math.abs(lane) * 1.5 >= score || !clearRoute(compact, obstacles)) continue;
    const conflicts = segments(compact).reduce((sum, segment) => sum + reserved.count(segment), 0);
    const value = length + bends * 70 + conflicts * 220 + Math.abs(lane) * 1.5;
    if (value < score) { score = value; best = compact; }
  }
  return best ?? simplify(portAwareCandidate(start, end, sourcePort, targetPort));
}

function followsPortDirections(points: readonly CanvasPoint[], source: WorkflowCanvasPort, target: WorkflowCanvasPort): boolean {
  if (points.length < 2) return false;
  const follows = (anchor: CanvasPoint, lead: CanvasPoint, port: WorkflowCanvasPort) => {
    const vector = portVector(port);
    const dx = lead.x - anchor.x;
    const dy = lead.y - anchor.y;
    return dx * vector.x + dy * vector.y > 0 && Math.abs(dx * vector.y - dy * vector.x) < .5;
  };
  return follows(points[0]!, points[1]!, source) && follows(points.at(-1)!, points.at(-2)!, target);
}

function portAwareCandidate(start: CanvasPoint, end: CanvasPoint, source: WorkflowCanvasPort, target: WorkflowCanvasPort): CanvasPoint[] {
  const sourceEscape = escape(start, source, 34);
  const targetEscape = escape(end, target, 34);
  const middle = { x: (sourceEscape.x + targetEscape.x) / 2, y: (sourceEscape.y + targetEscape.y) / 2 };
  return [start, sourceEscape, { x: middle.x, y: sourceEscape.y }, { x: middle.x, y: targetEscape.y }, targetEscape, end];
}

function escape(point: CanvasPoint, port: WorkflowCanvasPort, distance: number): CanvasPoint {
  if (port === "top") return { x: point.x, y: point.y - distance };
  if (port === "bottom") return { x: point.x, y: point.y + distance };
  if (port === "left") return { x: point.x - distance, y: point.y };
  return { x: point.x + distance, y: point.y };
}

function adaptivePort(node: CanvasNode, other: CanvasNode, fallback: WorkflowCanvasPort): WorkflowCanvasPort {
  const nodeSize = canvasNodeSize(node);
  const otherSize = canvasNodeSize(other);
  const dx = other.x + otherSize.width / 2 - (node.x + nodeSize.width / 2);
  const dy = other.y + otherSize.height / 2 - (node.y + nodeSize.height / 2);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

interface Segment { a: CanvasPoint; b: CanvasPoint; }
function segments(points: readonly CanvasPoint[]): Segment[] { return points.slice(1).map((b, i) => ({ a: points[i]!, b })); }
function containsEndpoint(rect: Rect, point: CanvasPoint): boolean { return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom; }
function clearRoute(points: readonly CanvasPoint[], obstacles: readonly Rect[]): boolean {
  return segments(points).every((segment) => {
    const horizontal = Math.abs(segment.a.y - segment.b.y) < .5;
    const vertical = Math.abs(segment.a.x - segment.b.x) < .5;
    if (!horizontal && !vertical) return false;
    return !obstacles.some((rect) => segmentIntersectsOpenRect(segment, rect));
  });
}
function simplify(points: readonly CanvasPoint[]): CanvasPoint[] {
  const result: CanvasPoint[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && Math.abs(last.x - point.x) < .5 && Math.abs(last.y - point.y) < .5) continue;
    result.push({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
    while (result.length >= 3) {
      const a = result.at(-3)!; const b = result.at(-2)!; const c = result.at(-1)!;
      if (!((Math.abs(a.y - b.y) < .5 && Math.abs(b.y - c.y) < .5) || (Math.abs(a.x - b.x) < .5 && Math.abs(b.x - c.x) < .5))) break;
      if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) break;
      result.splice(result.length - 2, 1);
    }
  }
  return result;
}
function pathLength(points: readonly CanvasPoint[]): number { return segments(points).reduce((sum, segment) => sum + Math.abs(segment.a.x - segment.b.x) + Math.abs(segment.a.y - segment.b.y), 0); }

function clonePoint(point: CanvasPoint): CanvasPoint { return { x: point.x, y: point.y }; }
function clonePoints(points: readonly CanvasPoint[]): CanvasPoint[] { return points.map(clonePoint); }
function distance(left: CanvasPoint, right: CanvasPoint): number { return Math.hypot(left.x - right.x, left.y - right.y); }

function unitVector(a: CanvasPoint, b: CanvasPoint): CanvasPoint {
  const length = Math.max(.001, distance(a, b));
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

function sampleMidpoint(samples: readonly CanvasPoint[]): CanvasPoint {
  if (!samples.length) return { x: 0, y: 0 };
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) total += distance(samples[index - 1]!, samples[index]!);
  let remaining = total / 2;
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1]!;
    const end = samples[index]!;
    const length = distance(start, end);
    if (remaining <= length) {
      const ratio = length ? remaining / length : 0;
      return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    }
    remaining -= length;
  }
  return clonePoint(samples.at(-1)!);
}

function cubicSamples(a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint): CanvasPoint[] {
  const result: CanvasPoint[] = [];
  for (let index = 0; index <= 36; index += 1) result.push(cubicPoint(a, b, c, d, index / 36));
  return result;
}

interface RenderedRouteGeometry {
  path: string;
  samples: CanvasPoint[];
  midpoint: CanvasPoint;
  controlPoints: Array<{ control1: CanvasPoint; control2: CanvasPoint }>;
  bend: number;
  curveJoins?: CanvasPoint[];
}

/** Convert obstacle-aware route anchors into the one visible curve consumed by
 * SVG, labels, particles and collision audits.  The orthogonal anchors remain
 * planning metadata only; the chosen path is a direct cubic (or a cubic
 * chain for an unavoidable outer detour). */
function renderedRouteGeometry(
  edge: Pick<EdgeGeometry, "source" | "target" | "kind">,
  points: readonly CanvasPoint[],
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  nodes: readonly CanvasNode[],
  reserved: readonly Segment[],
  edgeIndex: number,
  preferredBendOverride?: number,
  broadDetour = true,
  forceDetour = false,
  bendLimitOverride?: number
): RenderedRouteGeometry {
  const collisionReservations = new CanvasProximityIndex(reserved);
  const compact = simplify(points);
  const start = compact[0] ?? { x: 0, y: 0 };
  const end = compact.at(-1) ?? start;
  const preferred = Number.isFinite(preferredBendOverride)
    ? preferredBendOverride!
    : routeBendPreference(compact, start, end, edgeIndex);
  const length = Math.max(1, distance(start, end));
  const limit = bendLimitOverride === undefined
    ? Math.max(18, Math.min(136, length * 0.3))
    : Math.max(18, Math.min(bendLimitOverride, length * 0.95));
  const candidates = uniqueNumbers([
    preferred,
    -preferred,
    0,
    limit * 0.22,
    -limit * 0.22,
    limit * 0.48,
    -limit * 0.48,
    ...(bendLimitOverride === undefined
      ? Array.from({ length: Math.max(0, Math.floor((limit - 20) / 16) + 1) }, (_, index) => 20 + index * 16).flatMap((value) => [value, -value])
      : [limit * .25, -limit * .25, limit * .5, -limit * .5, limit * .75, -limit * .75, limit, -limit])
  ]).map((value) => Math.max(-limit, Math.min(limit, value)));
  const hardObstacles = nodes.map((node) => {
    const size = canvasNodeSize(node);
    return { id: node.id, left: node.x, top: node.y, right: node.x + size.width, bottom: node.y + size.height };
  });
  const obstacles = hardObstacles.map((hard) => {
    // Match the planning router's 22px clearance. A larger rendering-only
    // margin rejects legitimate narrow corridors that planning has already
    // proven clear, sending the visible curve into a distant outer loop.
    const padding = hard.id === edge.source || hard.id === edge.target ? 0 : 22;
    const expanded = {
      id: hard.id,
      left: hard.left - padding,
      top: hard.top - padding,
      right: hard.right + padding,
      bottom: hard.bottom + padding
    };
    // Closely spaced cards can place a legitimate source/target anchor inside
    // a neighbouring card's preferred clearance. Keeping that expanded
    // obstacle would make every candidate look blocked and force the direct
    // cubic straight through the actual card. Relax only the clearance in
    // that case; the neighbouring card itself remains a hard obstacle.
    return padding && (containsEndpoint(expanded, start) || containsEndpoint(expanded, end))
      ? hard
      : expanded;
  });
  let best: RenderedRouteGeometry | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  if (!forceDetour) {
    for (const bend of candidates) {
      const curve = directCubicGeometry(start, end, sourcePort, targetPort, bend);
      const score = curveCollisionScore(curve.samples, obstacles, edge.source, edge.target, collisionReservations, 120)
        + Math.abs(bend - preferred) * 1.2
        + Math.abs(bend) * 0.06;
      if (score < bestScore) {
        bestScore = score;
        best = { ...curve, bend };
      }
    }
  }
  // Dense fan-out grids need the exhaustive aisle/outer-lane search below to
  // preserve the canonical collision guarantee across many shared lanes.
  if (nodes.length <= 12 && (forceDetour || (best && bestScore >= 100_000))) {
    const corridor = fastPlanningGeometry(
      start,
      end,
      compact,
      sourcePort,
      targetPort,
      preferred,
      nodes,
      edge
    );
    const corridorCollision = curveCollisionScore(
      corridor.samples,
      hardObstacles,
      edge.source,
      edge.target,
      collisionReservations,
      120
    );
    // The orthogonal planner has already found a clear corridor. Its smooth
    // one/two-cubic projection is a complete final route, so do not launch
    // the much broader waypoint search unless that compact projection cannot
    // remain hard-safe.
    if (corridor.controlPoints.length <= 2 && corridorCollision < 100_000) {
      return corridor;
    }
  }
  // If every direct cubic is blocked, retain the route anchors only as a
  // planning hint and search one or more outer lanes.  This is the same
  // emergency detour used by the reference canvas: a card dropped over a
  // dispatch rail must not leave the visible curve underneath that card.
  // The detour is itself smoothed into a cubic chain, so the SVG never falls
  // back to an orthogonal/polyline rendering.
  if (forceDetour || (best && bestScore >= 100_000)) {
    // First project the already-clear planning corridor into two cubics. If
    // a dense grid has no room for the preferred 22px halo, retry against the
    // actual card rectangles before launching the broader waypoint search.
    // This guarantees a hard-safe route without paying the quadratic search
    // cost merely to preserve optional whitespace.
    const detour = (forceDetour ? planningCornerCurve(
      start,
      end,
      sourcePort,
      targetPort,
      obstacles,
      edge.source,
      edge.target,
      collisionReservations,
      preferred,
      compact
    ) : undefined) ?? (forceDetour ? planningCornerCurve(
      start,
      end,
      sourcePort,
      targetPort,
      hardObstacles,
      edge.source,
      edge.target,
      collisionReservations,
      preferred,
      compact
    ) : undefined) ?? (forceDetour ? planningWaypointCurve(
      start,
      end,
      sourcePort,
      targetPort,
      obstacles,
      edge.source,
      edge.target,
      collisionReservations,
      preferred,
      compact
    ) : undefined) ?? bestPlanningCurve(
      start,
      end,
      obstacles,
      edge.source,
      edge.target,
      collisionReservations,
      preferred,
      compact
    ) ?? bestPlanningCurve(
      start,
      end,
      hardObstacles,
      edge.source,
      edge.target,
      collisionReservations,
      preferred,
      compact
    ) ?? (broadDetour ? bestOuterCurve(
      start,
      end,
      sourcePort,
      targetPort,
      obstacles,
      edge.source,
      edge.target,
      collisionReservations,
      preferred,
      compact
    ) : undefined) ?? (broadDetour ? bestOuterCurve(
      start,
      end,
      sourcePort,
      targetPort,
      hardObstacles,
      edge.source,
      edge.target,
      collisionReservations,
      preferred,
      compact
    ) : undefined);
    if (detour && (forceDetour || detour.score < bestScore)) best = detour.geometry;
  }
  return best ?? directCubicGeometry(start, end, sourcePort, targetPort, preferred);
}

interface CurveObstacle {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function bestPlanningCurve(
  start: CanvasPoint,
  end: CanvasPoint,
  obstacles: readonly CurveObstacle[],
  sourceId: string,
  targetId: string,
  reserved: CanvasProximityIndex,
  preferred: number,
  planningPoints: readonly CanvasPoint[]
): { geometry: RenderedRouteGeometry; score: number } | undefined {
  const planningBounds = pointBounds(planningPoints.length ? planningPoints : [start, end]);
  let best: { geometry: RenderedRouteGeometry; score: number } | undefined;
  for (const geometry of planningTwoCubicGeometries(start, end, planningPoints)) {
    const collisionScore = curveCollisionScore(
      geometry.samples,
      obstacles,
      sourceId,
      targetId,
      reserved,
      120, 100_000
    );
    const excursion = curveExcursion(geometry.samples, planningBounds);
    if (collisionScore >= 100_000 || excursion > 144) continue;
    const score = collisionScore
      + Math.abs(geometry.bend - preferred) * .18
      + excursion * 4
      + Math.max(0, sampledLength(geometry.samples) - distance(start, end)) * .08;
    if (!best || score < best.score) best = { geometry, score };
  }
  return best;
}

/** Try the actual escape/aisle waypoints produced by the orthogonal planner.
 * A dense grid often has a clear column gap that is lost when only the
 * midpoint of the planning polyline is used as a smooth-curve hint. */
function planningWaypointCurve(
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  obstacles: readonly CurveObstacle[],
  sourceId: string,
  targetId: string,
  reserved: CanvasProximityIndex,
  preferred: number,
  planningPoints: readonly CanvasPoint[]
): { geometry: RenderedRouteGeometry; score: number } | undefined {
  const waypoints = simplify(planningPoints).slice(1, -1);
  let best: { geometry: RenderedRouteGeometry; score: number } | undefined;
  for (const waypoint of waypoints) {
    for (const sourceLead of [8, 24]) {
      for (const targetLead of [8, 24]) {
        const geometry = twoCubicGeometry(start, end, sourcePort, targetPort, waypoint, sourceLead, targetLead);
        const collisionScore = curveCollisionScore(
          geometry.samples,
          obstacles,
          sourceId,
          targetId,
          reserved,
          120, 100_000
        );
        if (collisionScore >= 100_000) continue;
        const score = collisionScore
          + Math.abs(geometry.bend - preferred) * .18
          + Math.max(0, sampledLength(geometry.samples) - distance(start, end)) * .08;
        if (!best || score < best.score) best = { geometry, score };
      }
    }
  }
  return best;
}

/** Smooth one safe planner corner while preserving the incoming and outgoing
 * directions independently. This keeps an aisle route in the aisle; using a
 * blended tangent at the corner can bow back through an adjacent card. */
function planningCornerCurve(
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  obstacles: readonly CurveObstacle[],
  sourceId: string,
  targetId: string,
  reserved: CanvasProximityIndex,
  preferred: number,
  planningPoints: readonly CanvasPoint[]
): { geometry: RenderedRouteGeometry; score: number } | undefined {
  const points = simplify(planningPoints);
  const rawWaypoints = points.slice(1, -1);
  if (!rawWaypoints.length) return undefined;
  const nonEndpoint = obstacles.filter((obstacle) => obstacle.id !== sourceId && obstacle.id !== targetId);
  const xs = [...new Set(nonEndpoint.flatMap((rect) => [rect.left, rect.right]).map((value) => Math.round(value * 10) / 10))].sort((a, b) => a - b);
  const ys = [...new Set(nonEndpoint.flatMap((rect) => [rect.top, rect.bottom]).map((value) => Math.round(value * 10) / 10))].sort((a, b) => a - b);
  const gapXs = xs.slice(0, -1).flatMap((left, index) => {
    const right = xs[index + 1]!;
    return right - left >= 10 ? [(left + right) / 2] : [];
  });
  const gapYs = ys.slice(0, -1).flatMap((top, index) => {
    const bottom = ys[index + 1]!;
    return bottom - top >= 10 ? [(top + bottom) / 2] : [];
  });
  const candidates = new Map<string, CanvasPoint>();
  const add = (point: CanvasPoint) => {
    const key = `${Math.round(point.x * 10)}:${Math.round(point.y * 10)}`;
    if (!candidates.has(key)) candidates.set(key, point);
  };
  for (const point of rawWaypoints) {
    add(point);
    for (const x of gapXs) add({ x, y: point.y });
    for (const y of gapYs) add({ x: point.x, y });
  }
  let best: { geometry: RenderedRouteGeometry; score: number } | undefined;
  for (const waypoint of candidates.values()) {
    const firstLength = distance(start, waypoint);
    const secondLength = distance(waypoint, end);
    if (firstLength < 24 || secondLength < 24) continue;
    const incoming = unitVector(start, waypoint);
    const outgoing = unitVector(waypoint, end);
    const sourceDistance = Math.max(4, Math.min(34, firstLength * .14));
    const targetDistance = Math.max(4, Math.min(34, secondLength * .14));
    const joinDistance = Math.max(8, Math.min(72, Math.min(firstLength, secondLength) * .2));
    const sourceVector = portVector(sourcePort);
    const targetVector = portVector(targetPort);
    const firstControl = { x: start.x + sourceVector.x * sourceDistance, y: start.y + sourceVector.y * sourceDistance };
    const beforeJoin = { x: waypoint.x - incoming.x * joinDistance, y: waypoint.y - incoming.y * joinDistance };
    const afterJoin = { x: waypoint.x + outgoing.x * joinDistance, y: waypoint.y + outgoing.y * joinDistance };
    const targetControl = { x: end.x + targetVector.x * targetDistance, y: end.y + targetVector.y * targetDistance };
    const firstSamples = cubicSamples(start, firstControl, beforeJoin, waypoint);
    const secondSamples = cubicSamples(waypoint, afterJoin, targetControl, end);
    const samples = [...firstSamples, ...secondSamples.slice(1)];
    const line = unitVector(start, end);
    const normal = { x: -line.y, y: line.x };
    const geometry: RenderedRouteGeometry = {
      path: `M ${fmt(start.x)} ${fmt(start.y)} C ${fmt(firstControl.x)} ${fmt(firstControl.y)}, ${fmt(beforeJoin.x)} ${fmt(beforeJoin.y)}, ${fmt(waypoint.x)} ${fmt(waypoint.y)} C ${fmt(afterJoin.x)} ${fmt(afterJoin.y)}, ${fmt(targetControl.x)} ${fmt(targetControl.y)}, ${fmt(end.x)} ${fmt(end.y)}`,
      samples,
      midpoint: sampleMidpoint(samples),
      controlPoints: [{ control1: firstControl, control2: beforeJoin }, { control1: afterJoin, control2: targetControl }],
      bend: (waypoint.x - start.x) * normal.x + (waypoint.y - start.y) * normal.y
    };
    const collisionScore = curveCollisionScore(samples, obstacles, sourceId, targetId, reserved, 120, 100_000);
    if (collisionScore >= 100_000) continue;
    const score = collisionScore
      + Math.abs(geometry.bend - preferred) * .12
      + Math.max(0, sampledLength(samples) - distance(start, end)) * .06;
    if (!best || score < best.score) best = { geometry, score };
  }
  return best;
}

/**
 * Find a clear bounded two-cubic detour when every single cubic hits a card.
 * Orthogonal planning anchors are hints only: exposing every anchor as a
 * visible segment produced the jagged, railway-like paths this router is
 * meant to avoid.
 */
function bestOuterCurve(
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  obstacles: readonly CurveObstacle[],
  sourceId: string,
  targetId: string,
  reserved: CanvasProximityIndex,
  preferred: number,
  planningPoints: readonly CanvasPoint[]
): { geometry: RenderedRouteGeometry; score: number } | undefined {
  if (obstacles.length < 1) return undefined;
  const nonEndpoint = obstacles.filter((obstacle) => obstacle.id !== sourceId && obstacle.id !== targetId);
  if (!nonEndpoint.length) return undefined;
  const bounds = nonEndpoint.reduce(
    (result, obstacle) => ({
      left: Math.min(result.left, obstacle.left),
      top: Math.min(result.top, obstacle.top),
      right: Math.max(result.right, obstacle.right),
      bottom: Math.max(result.bottom, obstacle.bottom)
    }),
    { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) }
  );
  const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const line = unitVector(start, end);
  const normal = { x: -line.y, y: line.x };
  const sourceEscape = escape(start, sourcePort, 12);
  const targetEscape = escape(end, targetPort, 12);
  const candidates: CanvasPoint[] = [];
  const planningBounds = pointBounds(planningPoints.length ? planningPoints : [start, end]);
  const sourceObstacle = obstacles.find((obstacle) => obstacle.id === sourceId);
  const targetObstacle = obstacles.find((obstacle) => obstacle.id === targetId);
  let best: { geometry: RenderedRouteGeometry; score: number } | undefined;
  if (sourceObstacle) {
    if (sourcePort === "left" || sourcePort === "right") {
      candidates.push(
        { x: sourceEscape.x, y: sourceObstacle.top - 42 },
        { x: sourceEscape.x, y: sourceObstacle.bottom + 42 }
      );
    } else {
      candidates.push(
        { x: sourceObstacle.left - 42, y: sourceEscape.y },
        { x: sourceObstacle.right + 42, y: sourceEscape.y }
      );
    }
  }
  if (targetObstacle) {
    if (targetPort === "left" || targetPort === "right") {
      candidates.push(
        { x: targetEscape.x, y: targetObstacle.top - 42 },
        { x: targetEscape.x, y: targetObstacle.bottom + 42 }
      );
    } else {
      candidates.push(
        { x: targetObstacle.left - 42, y: targetEscape.y },
        { x: targetObstacle.right + 42, y: targetEscape.y }
      );
    }
  }
  if (planningPoints.length > 2) candidates.push(sampleMidpoint(planningPoints));
  for (const gap of [54, 82, 116, 152]) {
    candidates.push(
      { x: center.x + normal.x * gap, y: center.y + normal.y * gap },
      { x: center.x - normal.x * gap, y: center.y - normal.y * gap },
      { x: center.x, y: bounds.top - gap },
      { x: center.x, y: bounds.bottom + gap },
      { x: bounds.left - gap, y: center.y },
      { x: bounds.right + gap, y: center.y }
    );
  }
  for (const obstacle of nonEndpoint) {
    const obstacleCenter = { x: (obstacle.left + obstacle.right) / 2, y: (obstacle.top + obstacle.bottom) / 2 };
    candidates.push(
      { x: obstacleCenter.x, y: obstacle.top - 42 },
      { x: obstacleCenter.x, y: obstacle.bottom + 42 },
      { x: obstacle.left - 42, y: obstacleCenter.y },
      { x: obstacle.right + 42, y: obstacleCenter.y }
    );
    if (sourcePort === "left" || sourcePort === "right") {
      candidates.push(
        { x: sourceEscape.x, y: obstacle.top - 42 },
        { x: sourceEscape.x, y: obstacle.bottom + 42 }
      );
    } else {
      candidates.push(
        { x: obstacle.left - 42, y: sourceEscape.y },
        { x: obstacle.right + 42, y: sourceEscape.y }
      );
    }
    if (targetPort === "left" || targetPort === "right") {
      candidates.push(
        { x: targetEscape.x, y: obstacle.top - 42 },
        { x: targetEscape.x, y: obstacle.bottom + 42 }
      );
    } else {
      candidates.push(
        { x: obstacle.left - 42, y: targetEscape.y },
        { x: obstacle.right + 42, y: targetEscape.y }
      );
    }
  }
  const seen = new Set<string>();
  for (const waypoint of candidates) {
    const key = `${fmt(waypoint.x)}:${fmt(waypoint.y)}`;
    if (seen.has(key) || distance(start, waypoint) < 24 || distance(end, waypoint) < 24) continue;
    seen.add(key);
    for (const sourceLead of [8, 24]) {
      for (const targetLead of [8, 24]) {
        const geometry = twoCubicGeometry(start, end, sourcePort, targetPort, waypoint, sourceLead, targetLead);
        const collisionScore = curveCollisionScore(
          geometry.samples,
          obstacles,
          sourceId,
          targetId,
          reserved,
          120, 100_000
        );
        const excursion = curveExcursion(geometry.samples, planningBounds);
        if (collisionScore >= 100_000 || excursion > 144) continue;
        const score = collisionScore
          + Math.abs(geometry.bend - preferred) * 0.18
          + excursion * 4
          + Math.max(0, sampledLength(geometry.samples) - distance(start, end)) * .08;
        if (!best || score < best.score) best = { geometry, score };
      }
    }
  }
  // A backwards pair of pinned ports can require the first curve to leave the
  // source card while the second sweeps almost an entire outer lane before it
  // approaches the target. Try those long controls only when the compact
  // candidates above found no clear route.
  if (!best) {
    const directions = [
      { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }
    ];
    for (const waypoint of candidates.slice(0, 12)) {
      for (const joinVector of directions) {
        for (const sweep of [.65, .85, 1.05]) {
          for (const sourceLead of [24, 48]) {
            for (const targetLead of [8, 24]) {
              const geometry = twoCubicGeometry(
                start,
                end,
                sourcePort,
                targetPort,
                waypoint,
                sourceLead,
                targetLead,
                joinVector,
                distance(waypoint, end) * sweep
              );
              const collisionScore = curveCollisionScore(
                geometry.samples,
                obstacles,
                sourceId,
                targetId,
                reserved,
                120, 100_000
              );
              const excursion = curveExcursion(geometry.samples, planningBounds);
              if (collisionScore >= 100_000 || excursion > 144) continue;
              const score = collisionScore
                + Math.abs(geometry.bend - preferred) * .18
                + excursion * 4
                + Math.max(0, sampledLength(geometry.samples) - distance(start, end)) * .08;
              if (!best || score < best.score) best = { geometry, score };
            }
          }
        }
      }
    }
  }
  return best;
}

export function planningTwoCubicGeometries(
  start: CanvasPoint,
  end: CanvasPoint,
  planningPoints: readonly CanvasPoint[]
): RenderedRouteGeometry[] {
  const points = simplify(planningPoints);
  if (points.length < 4) return [];
  const sourceControl = points[1]!;
  const targetControl = points.at(-2)!;
  const rails = points
    .slice(1, -2)
    .map((railStart, index) => ({
      railStart,
      railEnd: points[index + 2]!,
      length: distance(railStart, points[index + 2]!),
      index
    }))
    .filter((rail) => rail.length >= 12)
    .sort((left, right) => right.length - left.length || left.index - right.index);
  return rails.map(({ railStart, railEnd }) => {
    const waypoint = {
      x: (railStart.x + railEnd.x) / 2,
      y: (railStart.y + railEnd.y) / 2
    };
    const firstSamples = cubicSamples(start, sourceControl, railStart, waypoint);
    const secondSamples = cubicSamples(waypoint, railEnd, targetControl, end);
    const samples = [...firstSamples, ...secondSamples.slice(1)];
    const line = unitVector(start, end);
    const normal = { x: -line.y, y: line.x };
    const bend = (waypoint.x - start.x) * normal.x + (waypoint.y - start.y) * normal.y;
    return {
      path: `M ${fmt(start.x)} ${fmt(start.y)} C ${fmt(sourceControl.x)} ${fmt(sourceControl.y)}, ${fmt(railStart.x)} ${fmt(railStart.y)}, ${fmt(waypoint.x)} ${fmt(waypoint.y)} C ${fmt(railEnd.x)} ${fmt(railEnd.y)}, ${fmt(targetControl.x)} ${fmt(targetControl.y)}, ${fmt(end.x)} ${fmt(end.y)}`,
      samples,
      midpoint: sampleMidpoint(samples),
      controlPoints: [
        { control1: sourceControl, control2: railStart },
        { control1: railEnd, control2: targetControl }
      ],
      bend
    };
  });
}

function twoCubicGeometry(
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  waypoint: CanvasPoint,
  sourceLead = 10,
  targetLead = 10,
  joinVectorOverride?: CanvasPoint,
  outgoingJoinDistance?: number
): RenderedRouteGeometry {
  const line = unitVector(start, end);
  const firstLength = Math.max(1, distance(start, waypoint));
  const secondLength = Math.max(1, distance(waypoint, end));
  // Emergency detours must be able to turn inside a narrow port corridor. A
  // long first control handle would honor the tangent mathematically while
  // still driving straight through the neighbouring card before it bends.
  const sourceDistance = Math.max(2, Math.min(sourceLead, firstLength * .3));
  const targetDistance = Math.max(2, Math.min(targetLead, secondLength * .3));
  // Keep most of an outer detour on its clear lane. Short join handles make
  // the curve drift diagonally through the blocker before reaching the lane.
  const joinDistance = Math.max(8, Math.min(160, Math.min(firstLength, secondLength) * .72));
  const sourceVector = portVector(sourcePort);
  const targetVector = portVector(targetPort);
  const incoming = unitVector(start, waypoint);
  const outgoing = unitVector(waypoint, end);
  const blended = unitVector(
    { x: 0, y: 0 },
    { x: incoming.x + outgoing.x, y: incoming.y + outgoing.y }
  );
  const joinVector = joinVectorOverride ?? (firstLength > secondLength * 1.8
    ? outgoing
    : secondLength > firstLength * 1.8 ? incoming : blended);
  const firstControl = {
    x: start.x + sourceVector.x * sourceDistance,
    y: start.y + sourceVector.y * sourceDistance
  };
  const beforeJoin = { x: waypoint.x - joinVector.x * joinDistance, y: waypoint.y - joinVector.y * joinDistance };
  const afterDistance = outgoingJoinDistance ?? joinDistance;
  const afterJoin = { x: waypoint.x + joinVector.x * afterDistance, y: waypoint.y + joinVector.y * afterDistance };
  const targetControl = {
    x: end.x + targetVector.x * targetDistance,
    y: end.y + targetVector.y * targetDistance
  };
  const firstSamples = cubicSamples(start, firstControl, beforeJoin, waypoint);
  const secondSamples = cubicSamples(waypoint, afterJoin, targetControl, end);
  const samples = [...firstSamples, ...secondSamples.slice(1)];
  const normal = { x: -line.y, y: line.x };
  const bend = (waypoint.x - start.x) * normal.x + (waypoint.y - start.y) * normal.y;
  return {
    path: `M ${fmt(start.x)} ${fmt(start.y)} C ${fmt(firstControl.x)} ${fmt(firstControl.y)}, ${fmt(beforeJoin.x)} ${fmt(beforeJoin.y)}, ${fmt(waypoint.x)} ${fmt(waypoint.y)} C ${fmt(afterJoin.x)} ${fmt(afterJoin.y)}, ${fmt(targetControl.x)} ${fmt(targetControl.y)}, ${fmt(end.x)} ${fmt(end.y)}`,
    samples,
    midpoint: sampleMidpoint(samples),
    controlPoints: [
      { control1: firstControl, control2: beforeJoin },
      { control1: afterJoin, control2: targetControl }
    ],
    bend
  };
}

function pointBounds(points: readonly CanvasPoint[]): Rect {
  return points.reduce<Rect>((bounds, point) => ({
    left: Math.min(bounds.left, point.x),
    top: Math.min(bounds.top, point.y),
    right: Math.max(bounds.right, point.x),
    bottom: Math.max(bounds.bottom, point.y)
  }), {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY
  });
}

function curveExcursion(points: readonly CanvasPoint[], bounds: Rect): number {
  if (!points.length) return 0;
  const rendered = pointBounds(points);
  return Math.max(0, bounds.left - rendered.left)
    + Math.max(0, bounds.top - rendered.top)
    + Math.max(0, rendered.right - bounds.right)
    + Math.max(0, rendered.bottom - bounds.bottom);
}

function sampledLength(points: readonly CanvasPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

function directCubicGeometry(
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  bend: number
): RenderedRouteGeometry {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  // Do not let a short edge's controls pass each other. The previous 42px
  // minimum turned the common 30–40px gap between adjacent cards into a
  // conspicuous loop instead of a compact curve.
  const distanceAlong = Math.max(10, Math.min(180, length * 0.42));
  const normal = { x: -dy / length, y: dx / length };
  const sourceVector = portVector(sourcePort);
  const targetVector = portVector(targetPort);
  const offset = Number.isFinite(bend) ? bend : 0;
  const control1 = {
    x: start.x + sourceVector.x * distanceAlong + normal.x * offset,
    y: start.y + sourceVector.y * distanceAlong + normal.y * offset
  };
  const control2 = {
    x: end.x + targetVector.x * distanceAlong + normal.x * offset,
    y: end.y + targetVector.y * distanceAlong + normal.y * offset
  };
  const samples = cubicSamples(start, control1, control2, end);
  return {
    path: `M ${fmt(start.x)} ${fmt(start.y)} C ${fmt(control1.x)} ${fmt(control1.y)}, ${fmt(control2.x)} ${fmt(control2.y)}, ${fmt(end.x)} ${fmt(end.y)}`,
    samples,
    midpoint: sampleMidpoint(samples),
    controlPoints: [{ control1, control2 }],
    bend: offset
  };
}

function cubicChainGeometry(
  start: CanvasPoint,
  end: CanvasPoint,
  joins: readonly CanvasPoint[],
  controls: readonly { control1: CanvasPoint; control2: CanvasPoint }[],
  bend: number
): RenderedRouteGeometry {
  const anchors = [start, ...joins, end];
  const samples: CanvasPoint[] = [];
  let path = `M ${fmt(start.x)} ${fmt(start.y)}`;
  controls.forEach((pair, index) => {
    const segmentStart = anchors[index] ?? start;
    const segmentEnd = anchors[index + 1] ?? end;
    const segmentSamples = cubicSamples(segmentStart, pair.control1, pair.control2, segmentEnd);
    samples.push(...(index === 0 ? segmentSamples : segmentSamples.slice(1)));
    path += ` C ${fmt(pair.control1.x)} ${fmt(pair.control1.y)}, ${fmt(pair.control2.x)} ${fmt(pair.control2.y)}, ${fmt(segmentEnd.x)} ${fmt(segmentEnd.y)}`;
  });
  return {
    path,
    samples,
    midpoint: sampleMidpoint(samples),
    controlPoints: controls.map((pair) => ({
      control1: clonePoint(pair.control1),
      control2: clonePoint(pair.control2)
    })),
    curveJoins: joins.map(clonePoint),
    bend
  };
}

/**
 * Render an orthogonal planning corridor as straight cubic pieces.  A cubic
 * whose controls lie on its segment is mathematically a line, so its sampled
 * geometry cannot bow through a card between two planning anchors.  This is
 * deliberately cheap and is used only for local drag reroutes; ordinary
 * topology and layout routing still use the smoother global route above.
 */
function orthogonalCubicGeometry(
  start: CanvasPoint,
  end: CanvasPoint,
  planningPoints: readonly CanvasPoint[],
  bend: number
): RenderedRouteGeometry {
  const compact = simplify([start, ...planningPoints.slice(1, -1), end]);
  const anchors = [compact[0] ?? start, ...compact.slice(1, -1), compact.at(-1) ?? end];
  const controls = anchors.slice(1).map((anchor, index) => {
    const previous = anchors[index]!;
    return {
      control1: {
        x: previous.x + (anchor.x - previous.x) / 3,
        y: previous.y + (anchor.y - previous.y) / 3
      },
      control2: {
        x: previous.x + (anchor.x - previous.x) * 2 / 3,
        y: previous.y + (anchor.y - previous.y) * 2 / 3
      }
    };
  });
  return cubicChainGeometry(anchors[0]!, anchors.at(-1)!, anchors.slice(1, -1), controls, bend);
}

function curveCollisionScore(
  samples: readonly CanvasPoint[],
  obstacles: ReadonlyArray<{ id: string; left: number; top: number; right: number; bottom: number }>,
  sourceId: string,
  targetId: string,
  reserved: CanvasProximityIndex,
  reservedPenaltyLimit = Number.POSITIVE_INFINITY,
  rejectAt = Number.POSITIVE_INFINITY
): number {
  // A candidate cannot hit a rectangle outside its complete sampled bounds.
  // Narrow the exact checks once instead of visiting every card for every
  // sample and segment during the outer-lane search.
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const sample of samples) {
    left = Math.min(left, sample.x); top = Math.min(top, sample.y);
    right = Math.max(right, sample.x); bottom = Math.max(bottom, sample.y);
  }
  const nearbyObstacles = obstacles.filter(obstacle => right > obstacle.left && left < obstacle.right
    && bottom > obstacle.top && top < obstacle.bottom);
  let score = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const point = samples[index]!;
    for (const obstacle of nearbyObstacles) {
      if (!pointInside(point, obstacle)) continue;
      const endpoint = obstacle.id === sourceId || obstacle.id === targetId;
      const endpointWindow = index < 3 || index > samples.length - 4;
      if (!endpoint || !endpointWindow) {
        score += 100_000;
        // Search callers discard blocked candidates; their exact larger
        // penalty cannot affect the selected clear route.
        if (score >= rejectAt) return score;
      }
    }
  }
  // Sampling vertices alone can miss a narrow card between two samples. Use
  // the same open-rectangle segment test as the planning router so the
  // rendered cubic cannot tunnel through an obstacle between sample points.
  for (let index = 1; index < samples.length; index += 1) {
    const segment = { a: samples[index - 1]!, b: samples[index]! };
    for (const obstacle of nearbyObstacles) {
      if (!segmentIntersectsOpenRect(segment, obstacle)) continue;
      const endpoint = obstacle.id === sourceId || obstacle.id === targetId;
      const endpointWindow = index <= 3 || index >= samples.length - 3;
      if (!endpoint || !endpointWindow) {
        score += 100_000;
        // Search callers discard blocked candidates; their exact larger
        // penalty cannot affect the selected clear route.
        if (score >= rejectAt) return score;
      }
    }
  }
  // Penalize sustained proximity to already reserved orthogonal lanes without
  // making a single shared endpoint prohibitively expensive.
  return score + reserved.penalty(samples, reservedPenaltyLimit);
}

function routeBendPreference(points: readonly CanvasPoint[], start: CanvasPoint, end: CanvasPoint, _edgeIndex: number): number {
  if (points.length < 3) return 0;
  const middle = points[Math.floor(points.length / 2)]!;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const normal = { x: -dy / length, y: dx / length };
  const offset = (middle.x - start.x) * normal.x + (middle.y - start.y) * normal.y;
  if (Math.abs(offset) > 8) return Math.max(-136, Math.min(136, offset));
  return 0;
}

function uniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<string>();
  return values
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value * 10) / 10)
    .filter((value) => {
      const key = String(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function pointInside(
  point: CanvasPoint,
  rect: { left: number; top: number; right: number; bottom: number }
): boolean {
  return point.x > rect.left + 0.001 && point.x < rect.right - 0.001
    && point.y > rect.top + 0.001 && point.y < rect.bottom - 0.001;
}

function restoreLockedGeometry(edge: EdgeGeometry, lock: DragRouteLock): EdgeGeometry {
  return {
    ...edge,
    path: lock.path,
    points: clonePoints(lock.points),
    samples: clonePoints(lock.samples),
    midpoint: clonePoint(lock.midpoint),
    sourcePort: lock.sourceSide,
    targetPort: lock.targetSide,
    sourcePortPinned: lock.sourcePinned,
    targetPortPinned: lock.targetPinned,
    controlPoints: lock.controlPoints?.map((pair) => ({
      control1: clonePoint(pair.control1),
      control2: clonePoint(pair.control2)
    })),
    curveJoins: lock.curveJoins?.map(clonePoint),
    bend: lock.curveBend
  };
}

/** Replace an old orthogonal lock with a bounded smooth projection during a
 * layout transition. Older snapshots (and a few dense fallback corridors)
 * may contain several collinear cubic segments. Keeping that lock verbatim
 * made the post-layout frame look like a polyline until the next reload. The
 * projection is only used by callers that explicitly request a smooth
 * temporary frame; normal drag locks retain their exact geometry. */
function smoothLockedGeometry(
  edge: EdgeGeometry,
  lock: DragRouteLock,
  nodes: readonly CanvasNode[]
): EdgeGeometry {
  if ((lock.controlPoints?.length ?? 0) <= 2) return restoreLockedGeometry(edge, lock);
  return geometryFromPlanningPointsFast(
    edge,
    lock.points,
    lock.sourceSide,
    lock.targetSide,
    lock.curveBend,
    false,
    nodes,
    true
  );
}

function captureCurveJoins(edge: Pick<EdgeGeometry, "controlPoints" | "samples" | "points" | "curveJoins">): CanvasPoint[] | undefined {
  const segmentCount = edge.controlPoints?.length ?? 0;
  if (segmentCount < 2) return undefined;
  const joins = edge.curveJoins ?? [];
  if (joins.length >= segmentCount - 1) return joins.slice(0, segmentCount - 1).map(clonePoint);
  return Array.from({ length: segmentCount - 1 }, (_, index) => {
    const sampleIndex = Math.round(((index + 1) * (edge.samples.length - 1)) / segmentCount);
    return clonePoint(edge.samples[sampleIndex] ?? edge.points[Math.min(edge.points.length - 1, index + 1)] ?? { x: 0, y: 0 });
  });
}

function shiftedEndpoint(
  point: CanvasPoint,
  lock: DragRouteLock,
  nodeById: ReadonlyMap<string, CanvasNode>,
  side: "source" | "target"
): CanvasPoint {
  const id = side === "source" ? lock.source : lock.target;
  const origin = side === "source" ? lock.sourcePosition : lock.targetPosition;
  const node = nodeById.get(id);
  if (!node) return clonePoint(point);
  return { x: point.x + node.x - origin.x, y: point.y + node.y - origin.y };
}

/** Rebuild only the visible cubic from a captured route. */
function geometryFromLockedPoints(
  edge: EdgeGeometry,
  lock: DragRouteLock,
  points: readonly CanvasPoint[],
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort
): EdgeGeometry {
  const compact = simplify(points);
  const start = compact[0] ?? lock.startEndpoint.source;
  const end = compact.at(-1) ?? lock.startEndpoint.target;
  const sourceDelta = { x: start.x - lock.startEndpoint.source.x, y: start.y - lock.startEndpoint.source.y };
  const targetDelta = { x: end.x - lock.startEndpoint.target.x, y: end.y - lock.startEndpoint.target.y };
  const rendered = fastLockedCurve(lock, start, end, sourcePort, targetPort, sourceDelta, targetDelta);
  return {
    ...edge,
    path: rendered.path,
    points: compact,
    samples: rendered.samples,
    midpoint: rendered.midpoint,
    sourcePort,
    targetPort,
    controlPoints: rendered.controlPoints,
    curveJoins: rendered.curveJoins,
    bend: rendered.bend
  };
}

function geometryFromPlanningPointsFast(
  edge: EdgeGeometry,
  points: readonly CanvasPoint[],
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  preferredBend?: number,
  reroutedBecauseBlocked = false,
  nodes: readonly CanvasNode[] = [],
  smoothFallback = false
): EdgeGeometry {
  const compact = simplify(points);
  const start = compact[0] ?? { x: 0, y: 0 };
  const end = compact.at(-1) ?? start;
  const needsDetour = nodes.length && (reroutedBecauseBlocked || routeHitsNonEndpointNode(compact, edge, nodes));
  const detour = needsDetour ? fallbackDetourPoints(start, end, sourcePort, targetPort, nodes, edge) : undefined;
  const safePoints = detour ?? compact;
  const rendered = nodes.length
    ? fastPlanningGeometry(
        start,
        end,
        safePoints,
        sourcePort,
        targetPort,
        preferredBend ?? 0,
        nodes,
        edge,
        smoothFallback
      )
    : directCubicGeometry(start, end, sourcePort, targetPort, preferredBend ?? 0);
  return {
    ...edge,
    path: rendered.path,
    points: safePoints,
    samples: rendered.samples,
    midpoint: rendered.midpoint,
    sourcePort,
    targetPort,
    controlPoints: rendered.controlPoints,
    curveJoins: rendered.curveJoins,
    bend: rendered.bend,
    ...(reroutedBecauseBlocked ? { reroutedBecauseBlocked: true } : {})
  };
}

/** Render the already-vetted planning corridor without a global curve search. */
function fastPlanningGeometry(
  start: CanvasPoint,
  end: CanvasPoint,
  planningPoints: readonly CanvasPoint[],
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  preferredBend: number,
  nodes: readonly CanvasNode[],
  edge: Pick<EdgeGeometry, "source" | "target">,
  smoothFallback = false
): RenderedRouteGeometry {
  const direct = uniqueNumbers([preferredBend, 0, 24, -24, 48, -48])
    .map((bend) => directCubicGeometry(start, end, sourcePort, targetPort, bend));
  const smooth = [...direct, ...planningTwoCubicGeometries(start, end, planningPoints)];
  const rank = (geometry: RenderedRouteGeometry) =>
    geometry.controlPoints.length * 240
    + sampledLength(geometry.samples)
    + Math.abs(geometry.bend - preferredBend) * .15;
  // Rank once, then stop at the first safe candidate. Filtering before sorting
  // tested every curve against every card even when the best curve was clear.
  // Stable ordering preserves the same winner for equal scores.
  const ranked = smooth.map((geometry) => ({ geometry, score: rank(geometry) }))
    .sort((left, right) => left.score - right.score)
    .map(({ geometry }) => geometry);
  const padded = ranked.find((geometry) => !routeCrossesNonEndpointNode(geometry.samples, edge, nodes));
  if (padded) return padded;
  const hardSafe = ranked.find((geometry) => !routeHitsNonEndpointNode(geometry.samples, edge, nodes));
  // A rare corridor may genuinely require more than two straight sections.
  // Keep the old hard-safe chain only as the last fallback; ordinary and
  // layered-layout routes now stay at one or two visible curves.
  if (hardSafe) return hardSafe;
  // During a layout animation, a temporary smooth curve is preferable to
  // exposing the orthogonal fallback as a visible multi-segment polyline.
  // The committed frame is recalculated by routeCanvasEdges(), so this only
  // affects the cheap interpolation path.
  if (smoothFallback) return ranked[0] ?? direct[0]!;
  return orthogonalCubicGeometry(start, end, planningPoints, preferredBend);
}

function fallbackDetourPoints(
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  nodes: readonly CanvasNode[],
  edge: Pick<EdgeGeometry, "source" | "target">
): CanvasPoint[] | undefined {
  // Use a small visibility grid instead of the global router.  It is bounded
  // by the obstacle rectangles and therefore remains predictable during a
  // pointer move, while still finding a route when two expanded cards close
  // the obvious horizontal corridor.
  const clearance = 28;
  const obstacles = nodes
    .filter((node) => node.id !== edge.source && node.id !== edge.target)
    .map((node) => {
      const size = canvasNodeSize(node);
      const expanded = { left: node.x - clearance, top: node.y - clearance, right: node.x + size.width + clearance, bottom: node.y + size.height + clearance };
      // Adjacent cards can put an endpoint inside the preferred clearance
      // envelope without actually overlapping.  Keep the real card boundary
      // for that local obstacle so the route can use the narrow, valid aisle
      // immediately beside the endpoint (the full router follows the same
      // rule in chooseRoute()).
      return containsEndpoint(expanded, start) || containsEndpoint(expanded, end)
        ? { left: node.x, top: node.y, right: node.x + size.width, bottom: node.y + size.height }
        : expanded;
    });
  if (!obstacles.length) return undefined;

  const sourceLead = chooseClearLead(start, sourcePort, obstacles);
  const targetLead = chooseClearLead(end, targetPort, obstacles);
  if (!sourceLead || !targetLead) return undefined;
  const xs = uniqueGridNumbers([
    start.x, end.x, sourceLead.x, targetLead.x,
    ...obstacles.flatMap((rect) => [rect.left - 1, rect.right + 1])
  ]);
  const ys = uniqueGridNumbers([
    start.y, end.y, sourceLead.y, targetLead.y,
    ...obstacles.flatMap((rect) => [rect.top - 1, rect.bottom + 1])
  ]);
  const grid = new Map<string, CanvasPoint>();
  for (const y of ys) {
    for (const x of xs) {
      const point = { x, y };
      if (!obstacles.some((rect) => pointInside(point, rect))) grid.set(pointKey(point), point);
    }
  }
  const sourceKey = pointKey(sourceLead);
  const targetKey = pointKey(targetLead);
  if (!grid.has(sourceKey) || !grid.has(targetKey)) return undefined;

  const adjacency = new Map<string, Array<{ key: string; distance: number; direction: "h" | "v" }>>();
  const addConnection = (left: CanvasPoint, right: CanvasPoint, direction: "h" | "v") => {
    if (!clearRoute([left, right], obstacles)) return;
    const leftKey = pointKey(left);
    const rightKey = pointKey(right);
    const distanceValue = distance(left, right);
    if (!distanceValue) return;
    adjacency.get(leftKey)?.push({ key: rightKey, distance: distanceValue, direction });
    adjacency.get(rightKey)?.push({ key: leftKey, distance: distanceValue, direction });
  };
  for (const point of grid.values()) adjacency.set(pointKey(point), []);
  for (const y of ys) {
    const row = xs.map((x) => grid.get(pointKey({ x, y }))).filter((point): point is CanvasPoint => Boolean(point));
    for (let index = 1; index < row.length; index += 1) addConnection(row[index - 1]!, row[index]!, "h");
  }
  for (const x of xs) {
    const column = ys.map((y) => grid.get(pointKey({ x, y }))).filter((point): point is CanvasPoint => Boolean(point));
    for (let index = 1; index < column.length; index += 1) addConnection(column[index - 1]!, column[index]!, "v");
  }

  const queue: Array<{ key: string; cost: number; bends: number; direction?: "h" | "v" }> = [{ key: sourceKey, cost: 0, bends: 0 }];
  const best = new Map<string, { cost: number; bends: number; previous?: string; direction?: "h" | "v" }>([[sourceKey, { cost: 0, bends: 0 }]]);
  while (queue.length) {
    queue.sort((left, right) => left.cost - right.cost || left.bends - right.bends);
    const current = queue.shift()!;
    const known = best.get(current.key);
    if (!known || known.cost !== current.cost || known.bends !== current.bends) continue;
    if (current.key === targetKey) break;
    for (const next of adjacency.get(current.key) ?? []) {
      const bends = current.direction && current.direction !== next.direction ? current.bends + 1 : current.bends;
      const cost = current.cost + next.distance + (bends - current.bends) * 64;
      const previous = best.get(next.key);
      if (previous && (previous.cost < cost || (previous.cost === cost && previous.bends <= bends))) continue;
      best.set(next.key, { cost, bends, previous: current.key, direction: next.direction });
      queue.push({ key: next.key, cost, bends, direction: next.direction });
    }
  }
  if (!best.has(targetKey)) return undefined;
  const path: CanvasPoint[] = [];
  let key: string | undefined = targetKey;
  while (key) {
    const point = grid.get(key);
    if (!point) return undefined;
    path.push(point);
    key = best.get(key)?.previous;
  }
  path.reverse();
  const route = collapseSafeBacktracks(
    simplify([start, sourceLead, ...path.slice(1, -1), targetLead, end]),
    obstacles
  );
  return clearRoute(route, obstacles) ? route : undefined;
}

function collapseSafeBacktracks(points: readonly CanvasPoint[], obstacles: readonly Rect[]): CanvasPoint[] {
  const result = points.map(clonePoint);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < result.length - 1; index += 1) {
      const previous = result[index - 1]!;
      const current = result[index]!;
      const next = result[index + 1]!;
      const sameColumn = Math.abs(previous.x - current.x) < .5 && Math.abs(current.x - next.x) < .5;
      const sameRow = Math.abs(previous.y - current.y) < .5 && Math.abs(current.y - next.y) < .5;
      const reverses = sameColumn
        ? (current.y - previous.y) * (next.y - current.y) < 0
        : sameRow && (current.x - previous.x) * (next.x - current.x) < 0;
      if (reverses && clearRoute([previous, next], obstacles)) {
        result.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return simplify(result);
}

function pointKey(point: CanvasPoint): string {
  return `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
}

function uniqueGridNumbers(values: readonly number[]): number[] {
  const result = new Map<string, number>();
  for (const value of values) {
    if (Number.isFinite(value)) result.set(value.toFixed(6), value);
  }
  return [...result.values()].sort((left, right) => left - right);
}

function chooseClearLead(
  point: CanvasPoint,
  port: WorkflowCanvasPort,
  obstacles: readonly Rect[]
): CanvasPoint | undefined {
  const vector = portVector(port);
  const perpendicular = { x: -vector.y, y: vector.x };
  const candidates: Array<{ point: CanvasPoint; score: number }> = [];
  for (const length of [12, 20, 32, 48, 72, 104]) {
    candidates.push({ point: { x: point.x + vector.x * length, y: point.y + vector.y * length }, score: length });
    for (const offset of [-length, length]) {
      candidates.push({
        point: { x: point.x + perpendicular.x * offset, y: point.y + perpendicular.y * offset },
        score: length + 18
      });
    }
  }
  return candidates
    .filter(({ point: candidate }) => clearRoute([point, candidate], obstacles))
    .sort((left, right) => left.score - right.score)[0]?.point;
}

function fastLockedCurve(
  lock: DragRouteLock,
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  sourceDelta: CanvasPoint,
  targetDelta: CanvasPoint
): RenderedRouteGeometry {
  const captured = lock.controlPoints;
  if (!captured?.length || captured.length === 1) {
    return directCubicGeometry(start, end, sourcePort, targetPort, lock.curveBend ?? 0);
  }
  const segmentCount = captured.length;
  const oldJoins = lock.curveJoins ?? [];
  const joins = oldJoins.slice(0, segmentCount - 1).map((join, index) => {
    const ratio = (index + 1) / segmentCount;
    return {
      x: join.x + sourceDelta.x * (1 - ratio) + targetDelta.x * ratio,
      y: join.y + sourceDelta.y * (1 - ratio) + targetDelta.y * ratio
    };
  });
  const controls = captured.map((pair, index) => {
    const startRatio = index / segmentCount;
    const endRatio = (index + 1) / segmentCount;
    return {
      control1: {
        x: pair.control1.x + sourceDelta.x * (1 - startRatio) + targetDelta.x * startRatio,
        y: pair.control1.y + sourceDelta.y * (1 - startRatio) + targetDelta.y * startRatio
      },
      control2: {
        x: pair.control2.x + sourceDelta.x * (1 - endRatio) + targetDelta.x * endRatio,
        y: pair.control2.y + sourceDelta.y * (1 - endRatio) + targetDelta.y * endRatio
      }
    };
  });
  return cubicChainGeometry(start, end, joins, controls, lock.curveBend ?? 0);
}

function geometryFromPoints(
  edge: EdgeGeometry,
  points: readonly CanvasPoint[],
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  reroutedBecauseBlocked = false,
  nodes: readonly CanvasNode[] = [],
  preferredBend?: number
): EdgeGeometry {
  const compact = simplify(points);
  const rendered = renderedRouteGeometry(
    edge,
    compact,
    sourcePort,
    targetPort,
    nodes,
    [],
    0,
    preferredBend
  );
  return {
    ...edge,
    path: rendered.path,
    points: compact,
    samples: rendered.samples,
    midpoint: rendered.midpoint,
    sourcePort,
    targetPort,
    controlPoints: rendered.controlPoints,
    bend: rendered.bend,
    ...(reroutedBecauseBlocked ? { reroutedBecauseBlocked: true } : {})
  };
}

function routeIntersectsNode(points: readonly CanvasPoint[], node: CanvasNode | undefined): boolean {
  if (!node) return false;
  const size = canvasNodeSize(node);
  return polylineIntersectsRect(points, {
    left: node.x - 22,
    top: node.y - 22,
    right: node.x + size.width + 22,
    bottom: node.y + size.height + 22
  });
}

/** True when any segment of a sampled/polyline route crosses the open
 * rectangle. Checking segments (rather than only sample vertices) prevents a
 * long segment from tunnelling through a narrow card between samples. */
export function polylineIntersectsRect(
  points: readonly CanvasPoint[],
  rect: Rect
): boolean {
  if (!points.length) return false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (pointInsideOpenRect(point, rect)) return true;
    if (index && segmentIntersectsOpenRect({ a: points[index - 1]!, b: point }, rect)) return true;
  }
  return false;
}

function pointInsideOpenRect(point: CanvasPoint, rect: Rect): boolean {
  return point.x > rect.left && point.x < rect.right
    && point.y > rect.top && point.y < rect.bottom;
}

/** Liang-Barsky clipping against a slightly inset rectangle gives open-edge
 * semantics: a route that merely runs along a card boundary is not reported
 * as passing through the card. */
function segmentIntersectsOpenRect(segment: Segment, rect: Rect): boolean {
  const epsilon = 1e-6;
  const left = rect.left + epsilon;
  const right = rect.right - epsilon;
  const top = rect.top + epsilon;
  const bottom = rect.bottom - epsilon;
  if (left >= right || top >= bottom) return false;
  // Most sampled segments lie entirely outside a card. Reject their bounding
  // boxes before allocating the clipping closure or calculating intersections.
  if ((segment.a.x < left && segment.b.x < left)
    || (segment.a.x > right && segment.b.x > right)
    || (segment.a.y < top && segment.b.y < top)
    || (segment.a.y > bottom && segment.b.y > bottom)) return false;
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  let enter = 0;
  let leave = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < epsilon) return q >= 0;
    const ratio = q / p;
    if (p < 0) {
      if (ratio > leave) return false;
      if (ratio > enter) enter = ratio;
    } else {
      if (ratio < enter) return false;
      if (ratio < leave) leave = ratio;
    }
    return true;
  };
  return clip(-dx, segment.a.x - left)
    && clip(dx, right - segment.a.x)
    && clip(-dy, segment.a.y - top)
    && clip(dy, bottom - segment.a.y)
    && enter <= leave;
}

function lockedPort(
  kind: EdgeGeometry["kind"],
  current: WorkflowCanvasPort,
  fallback: WorkflowCanvasPort,
  node: CanvasNode,
  other: CanvasNode
): WorkflowCanvasPort {
  const size = canvasNodeSize(node);
  const otherSize = canvasNodeSize(other);
  const dx = other.x + otherSize.width / 2 - (node.x + size.width / 2);
  const dy = other.y + otherSize.height / 2 - (node.y + size.height / 2);
  const vector = portVector(fallback);
  const forward = dx * vector.x + dy * vector.y;
  // Weak decision branches keep their captured side longer. A small pointer
  // movement should bend the branch continuously instead of making a dashed
  // edge jump to a new port and restart its route.
  const threshold = kind === "main-dispatch"
    ? Math.max(76, Math.max(Math.abs(dx), Math.abs(dy)) * 0.26)
    : kind === "weak"
      ? Math.max(54, Math.max(Math.abs(dx), Math.abs(dy)) * 0.2)
      : Math.max(24, Math.max(Math.abs(dx), Math.abs(dy)) * 0.08);
  return forward >= -threshold ? fallback : adaptivePort(node, other, current);
}

function routeCrossesNonEndpointNode(
  points: readonly CanvasPoint[],
  edge: Pick<EdgeGeometry, "source" | "target">,
  nodes: readonly CanvasNode[]
): boolean {
  return routeIntersectsNonEndpointNode(points, edge, nodes, 22);
}

/** Fast-drag collision predicate.  The audit and the full router use the
 * actual card body; the 22px clearance above is only a planning penalty and
 * would incorrectly reject the narrow aisle between adjacent cards. */
function routeHitsNonEndpointNode(
  points: readonly CanvasPoint[],
  edge: Pick<EdgeGeometry, "source" | "target">,
  nodes: readonly CanvasNode[]
): boolean {
  return routeIntersectsNonEndpointNode(points, edge, nodes, 0);
}

function routeIntersectsNonEndpointNode(
  points: readonly CanvasPoint[],
  edge: Pick<EdgeGeometry, "source" | "target">,
  nodes: readonly CanvasNode[],
  padding: number
): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  return nodes.some((node) => {
    if (node.id === edge.source || node.id === edge.target) return false;
    const size = canvasNodeSize(node);
    const rect = { left: node.x - padding, top: node.y - padding,
      right: node.x + size.width + padding, bottom: node.y + size.height + padding };
    if (maxX <= rect.left || minX >= rect.right || maxY <= rect.top || minY >= rect.bottom) return false;
    return polylineIntersectsRect(points, rect);
  });
}

function portVector(port: WorkflowCanvasPort): CanvasPoint {
  if (port === "top") return { x: 0, y: -1 };
  if (port === "bottom") return { x: 0, y: 1 };
  if (port === "left") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function elasticRoutePoints(
  lock: DragRouteLock,
  start: CanvasPoint,
  end: CanvasPoint,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort
): CanvasPoint[] {
  const original = lock.points.length >= 2 ? lock.points : [lock.startEndpoint.source, lock.startEndpoint.target];
  if (original.length < 3 || sourcePort !== lock.sourceSide || targetPort !== lock.targetSide) {
    return simplify(portAwareCandidate(start, end, sourcePort, targetPort));
  }
  const originalStart = lock.startEndpoint.source;
  const originalEnd = lock.startEndpoint.target;
  const sourceDelta = { x: start.x - originalStart.x, y: start.y - originalStart.y };
  const targetDelta = { x: end.x - originalEnd.x, y: end.y - originalEnd.y };
  const lengths = segments(original).map((segment) => distance(segment.a, segment.b));
  const total = lengths.reduce((sum, value) => sum + value, 0) || 1;
  let travelled = 0;
  const moved = original.map((point, index) => {
    if (index === 0) return clonePoint(start);
    if (index === original.length - 1) return clonePoint(end);
    travelled += lengths[index - 1] ?? 0;
    const progress = travelled / total;
    const eased = progress * progress * (3 - 2 * progress);
    return {
      x: point.x + sourceDelta.x * (1 - eased) + targetDelta.x * eased,
      y: point.y + sourceDelta.y * (1 - eased) + targetDelta.y * eased
    };
  });
  // Move the captured orthogonal anchors only as an obstacle-planning hint,
  // then intersect adjacent rails. The caller always passes these anchors
  // through renderedRouteGeometry(), so they never become the visible path.
  const rails = segments(original).map((segment, index) => {
    const horizontal = Math.abs(segment.a.y - segment.b.y) < .5;
    const axis = horizontal ? "y" : "x";
    return {
      horizontal,
      value: index === 0 ? start[axis]
        : index === original.length - 2 ? end[axis]
          : (moved[index]![axis] + moved[index + 1]![axis]) / 2
    };
  });
  if (rails.some((rail, index) => index > 0 && rail.horizontal === rails[index - 1]!.horizontal)) {
    return simplify(portAwareCandidate(start, end, sourcePort, targetPort));
  }
  const points = [start];
  for (let index = 1; index < original.length - 1; index += 1) {
    const incoming = rails[index - 1]!;
    const outgoing = rails[index]!;
    points.push(incoming.horizontal
      ? { x: outgoing.value, y: incoming.value }
      : { x: incoming.value, y: outgoing.value });
  }
  points.push(end);
  const first = points[1]!;
  const last = points.at(-2)!;
  const sourceDirection = portVector(sourcePort);
  const targetDirection = portVector(targetPort);
  if ((first.x - start.x) * sourceDirection.x + (first.y - start.y) * sourceDirection.y < 0
    || (last.x - end.x) * targetDirection.x + (last.y - end.y) * targetDirection.y < 0) {
    return simplify(portAwareCandidate(start, end, sourcePort, targetPort));
  }
  return simplify(points);
}

function cubicPoint(a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint, t: number): CanvasPoint { const q = 1 - t; return { x: q ** 3 * a.x + 3 * q ** 2 * t * b.x + 3 * q * t ** 2 * c.x + t ** 3 * d.x, y: q ** 3 * a.y + 3 * q ** 2 * t * b.y + 3 * q * t ** 2 * c.y + t ** 3 * d.y }; }
function fmt(value: number): string { return String(Math.round(value * 10) / 10); }

export function canvasPortPoint(node: CanvasNodeGeometry, port: WorkflowCanvasPort): CanvasPoint {
  const { width, height } = canvasNodeSize(node);
  if (port === "top") return { x: node.x + width / 2, y: node.y };
  if (port === "bottom") return { x: node.x + width / 2, y: node.y + height };
  if (port === "left") return { x: node.x, y: node.y + height / 2 };
  return { x: node.x + width, y: node.y + height / 2 };
}
