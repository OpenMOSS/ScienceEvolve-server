import type {
  AgentOrchestrationTemplate,
  WorkflowCanvasEdgeLayout,
  WorkflowCanvasLayout,
  WorkflowCanvasPort
} from "../../../types";
import {
  CANVAS_FINISH_NODE_ID,
  CANVAS_INPUT_NODE_ID,
  canvasNodeSize,
  type CanvasEdge,
  type CanvasNode,
  type CanvasPoint,
  type CanvasSize
} from "./canvas-model";
import {
  canvasPortPoint,
  polylineIntersectsRect,
  routeCanvasEdges,
  type EdgeGeometry
} from "./canvas-router";
import { businessWorkflowEdges, normalizeCanvasLayout } from "./canvas-layout";
import { workflowOuterNodes } from "./workflow-nodes";

export interface CanvasLayoutReport {
  score: number;
  stats: {
    issues: number;
    hardIssues: number;
    /** Reference-compatible aliases/metrics used by tidy planning. */
    nodePairs: number;
    edgePairs: number;
    labelPairs: number;
    labelNodeHits: number;
    alignmentOffsets: number;
    orderFlips: number;
    readabilityIssues: number;
    nodeOverlaps: number;
    edgeNodeHits: number;
    edgeCrossings: number;
    shortEdges: number;
    portCongestion: number;
  };
  conflictNodeIds: string[];
  overlapPairs: Array<{ first: string; second: string; area: number }>;
  edgeNodeHits: Array<{ edgeId: string; nodeId: string }>;
  shortEdges: Array<{ edgeId: string; source: string; target: string; length: number }>;
  /** Rich conflict records used to generate local candidate moves. */
  conflictNodes: Record<string, boolean>;
  nodePressure: Record<string, number>;
  hardNodes: Record<string, boolean>;
  overlapNodes: Record<string, boolean>;
  nodeConflicts: Array<{ first: CanvasNode; second: CanvasNode; area: number }>;
  edgeNodeConflicts: Array<{ edge: CanvasEdge; node: CanvasNode; point: CanvasPoint; samples: number }>;
  edgePairConflicts: Array<{
    first: CanvasEdge;
    second: CanvasEdge;
    point?: CanvasPoint;
    type: "crossing" | "overlap"
  }>;
  alignmentConflicts: Array<{ first: CanvasNode; second: CanvasNode; axis: "x" | "y"; delta: number }>;
}

export interface CanvasTidyResult {
  layout: WorkflowCanvasLayout;
  initialReport: CanvasLayoutReport;
  finalReport: CanvasLayoutReport;
  movedNodeIds: string[];
  portChanges: number;
}

export interface CanvasTidyOptions {
  /** Explicit layered layout may treat user-selected ports as strong
   * preferences when retaining them would cause a substantially worse route. */
  relaxPinnedPorts?: boolean;
}

const PORTS: readonly WorkflowCanvasPort[] = ["right", "left", "bottom", "top"];

/** Deterministic geometry report shared by tidy planning and acceptance tests. */
export function canvasLayoutReport(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {},
  originalLayout?: WorkflowCanvasLayout
): CanvasLayoutReport {
  const normalized = normalizeCanvasLayout(layout, orchestration);
  // System Main fan-out is a visual overlay. It must not create tidy pressure,
  // move cards, influence business port selection, or inflate crossing stats.
  const edgeModels = reportEdges(orchestration, normalized)
    .filter((edge) => edge.systemRoute !== "main-dispatch");
  const edgeById = new Map(edgeModels.map((edge) => [edge.id, edge]));
  const nodes = reportNodes(orchestration, normalized, nodeSizes);
  // Candidate scoring can run dozens of times for one tidy operation. The
  // exhaustive visual curve search belongs to the final frame, not every
  // rejected candidate; the fast path retains the same obstacle corridor and
  // collision predicates while avoiding repeated high-quality curve search.
  const geometry = routeCanvasEdges(edgeModels, nodes, { fastEvaluation: true });
  const overlapPairs: CanvasLayoutReport["overlapPairs"] = [];
  const edgeNodeHits: CanvasLayoutReport["edgeNodeHits"] = [];
  const shortEdges: CanvasLayoutReport["shortEdges"] = [];
  const conflicts = new Set<string>();
  const conflictNodes: Record<string, boolean> = {};
  const nodePressure: Record<string, number> = {};
  const hardNodes: Record<string, boolean> = {};
  const overlapNodes: Record<string, boolean> = {};
  const nodeConflicts: CanvasLayoutReport["nodeConflicts"] = [];
  const edgeNodeConflicts: CanvasLayoutReport["edgeNodeConflicts"] = [];
  const edgePairConflicts: CanvasLayoutReport["edgePairConflicts"] = [];
  const alignmentConflicts: CanvasLayoutReport["alignmentConflicts"] = [];
  const mark = (id: string, pressure = 0, hard = false) => {
    conflicts.add(id);
    conflictNodes[id] = true;
    nodePressure[id] = (nodePressure[id] ?? 0) + pressure;
    if (hard) hardNodes[id] = true;
  };
  let overlapArea = 0;

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      const area = rectOverlapArea(nodeRect(left, 16), nodeRect(right, 16));
      const leftCenter = center(left);
      const rightCenter = center(right);
      const leftSize = canvasNodeSize(left);
      const rightSize = canvasNodeSize(right);
      if (area) {
        overlapPairs.push({ first: left.id, second: right.id, area });
        nodeConflicts.push({ first: left, second: right, area });
        overlapNodes[left.id] = true;
        overlapNodes[right.id] = true;
        overlapArea += area;
        mark(left.id, 90, true);
        mark(right.id, 90, true);
      }
      const centerDx = Math.abs(rightCenter.x - leftCenter.x);
      const centerDy = Math.abs(rightCenter.y - leftCenter.y);
      if (centerDx > 0.75 && centerDx <= 14 && centerDy > Math.max(leftSize.height, rightSize.height) * 0.72) {
        alignmentConflicts.push({ first: left, second: right, axis: "x", delta: rightCenter.x - leftCenter.x });
        mark(right.id, 3);
      }
      if (centerDy > 0.75 && centerDy <= 14 && centerDx > Math.max(leftSize.width, rightSize.width) * 0.72) {
        alignmentConflicts.push({ first: left, second: right, axis: "y", delta: rightCenter.y - leftCenter.y });
        mark(right.id, 3);
      }
    }
  }

  for (const edge of geometry) {
    const edgeModel = edgeById.get(edge.id);
    if (!edgeModel) continue;
    for (const node of nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      if (!polylineIntersectsRect(edge.samples, nodeRect(node, 5))) continue;
      edgeNodeHits.push({ edgeId: edge.id, nodeId: node.id });
      const hitPoint = edge.samples.find((point) => pointInside(point, nodeRect(node, 5))) ?? edge.samples[Math.floor(edge.samples.length / 2)]!;
      const existing = edgeNodeConflicts.find((item) => item.edge.id === edge.id && item.node.id === node.id);
      if (existing) existing.samples += 1;
      else edgeNodeConflicts.push({ edge: edgeModel, node, point: hitPoint, samples: 1 });
      mark(node.id, 110, true);
      mark(edge.source, 28);
      mark(edge.target, 28);
    }
    const length = sampleLength(edge.samples);
    const endpointDistance = edge.samples.length > 1
      ? Math.hypot(edge.samples.at(-1)!.x - edge.samples[0]!.x, edge.samples.at(-1)!.y - edge.samples[0]!.y)
      : length;
    const minimum = edge.kind === "termination" ? 92 : edge.kind === "main-dispatch" ? 70 : 108;
    const readableLength = Math.min(length, endpointDistance);
    if (readableLength < minimum) {
      shortEdges.push({ edgeId: edge.id, source: edge.source, target: edge.target, length: readableLength });
      mark(edge.source, 34);
      mark(edge.target, 34);
    }
  }

  let edgeCrossings = 0;
  for (let leftIndex = 0; leftIndex < geometry.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.length; rightIndex += 1) {
      const crossing = crossingPoint(geometry[leftIndex]!, geometry[rightIndex]!);
      if (crossing) {
        edgeCrossings += 1;
        const first = edgeById.get(geometry[leftIndex]!.id);
        const second = edgeById.get(geometry[rightIndex]!.id);
        if (first && second) {
          edgePairConflicts.push({ first, second, type: "crossing", point: crossing });
          mark(first.source, 18); mark(first.target, 18); mark(second.source, 18); mark(second.target, 18);
        }
      }
      const first = edgeById.get(geometry[leftIndex]!.id);
      const second = edgeById.get(geometry[rightIndex]!.id);
      if (first && second) {
        const closeRatio = routeCloseRatio(geometry[leftIndex]!.samples, geometry[rightIndex]!.samples);
        if (closeRatio.ratio >= 0.2) {
          edgePairConflicts.push({ first, second, type: "overlap" });
          mark(first.source, 12); mark(first.target, 12); mark(second.source, 12); mark(second.target, 12);
        }
      }
    }
  }

  const labels = geometry.map((edge) => ({ edge, rect: labelRect(edge) }));
  let labelPairs = 0;
  let labelNodeHits = 0;
  for (const label of labels) {
    for (const node of nodes) {
      if (node.id === label.edge.source || node.id === label.edge.target) continue;
      const area = rectOverlapArea(label.rect, nodeRect(node, 5));
      if (!area) continue;
      labelNodeHits += 1;
      mark(node.id, 16);
      mark(label.edge.source, 7); mark(label.edge.target, 7);
    }
  }
  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      if (!rectOverlapArea(labels[first]!.rect, labels[second]!.rect)) continue;
      labelPairs += 1;
      mark(labels[first]!.edge.source, 6); mark(labels[first]!.edge.target, 6);
      mark(labels[second]!.edge.source, 6); mark(labels[second]!.edge.target, 6);
    }
  }

  const nodePairs = overlapPairs.length;
  const edgePairs = edgePairConflicts.filter((item) => item.type === "overlap").length;
  const alignmentOffsets = alignmentConflicts.length;
  let orderFlips = 0;
  if (originalLayout) {
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const first = nodes[left]!;
        const second = nodes[right]!;
        const originalFirst = originalLayout.nodes[first.id];
        const originalSecond = originalLayout.nodes[second.id];
        if (!originalFirst || !originalSecond) continue;
        const originalDx = originalSecond.x - originalFirst.x;
        const originalDy = originalSecond.y - originalFirst.y;
        const currentDx = second.x - first.x;
        const currentDy = second.y - first.y;
        if (Math.abs(originalDx) > 72 && originalDx * currentDx < 0) orderFlips += 1;
        if (Math.abs(originalDy) > 54 && originalDy * currentDy < 0) orderFlips += 1;
      }
    }
  }

  const portCounts = new Map<string, number>();
  for (const edge of geometry.filter((item) => item.kind !== "main-dispatch")) {
    increment(portCounts, edge.source + ":" + edge.sourcePort);
    increment(portCounts, edge.target + ":" + edge.targetPort);
  }
  const portCongestion = [...portCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 2),
    0
  );
  const hardIssues = nodePairs + edgeNodeHits.length;
  const readabilityIssues = hardIssues + edgeCrossings + edgePairs + labelPairs + labelNodeHits + shortEdges.length;
  const issues = readabilityIssues + alignmentOffsets + portCongestion;
  return {
    score: hardIssues * 100_000
      + overlapArea * 12
      + edgeCrossings * 4_000
      + shortEdges.reduce((sum, edge) => sum + Math.max(0, 108 - edge.length) * 22, 0)
      + portCongestion * 650
      + edgePairs * 5_200
      + labelPairs * 4_200
      + labelNodeHits * 4_800
      + alignmentOffsets * 55
      + orderFlips * 30_000,
    stats: {
      issues,
      hardIssues,
      nodePairs,
      edgePairs,
      labelPairs,
      labelNodeHits,
      alignmentOffsets,
      orderFlips,
      readabilityIssues,
      nodeOverlaps: overlapPairs.length,
      edgeNodeHits: edgeNodeHits.length,
      edgeCrossings,
      shortEdges: shortEdges.length,
      portCongestion
    },
    conflictNodeIds: [...conflicts].sort(),
    overlapPairs,
    edgeNodeHits,
    shortEdges,
    conflictNodes,
    nodePressure,
    hardNodes,
    overlapNodes,
    nodeConflicts,
    edgeNodeConflicts,
    edgePairConflicts,
    alignmentConflicts
  };
}

/** Score all non-pinned port pairs against direction, congestion, route
 * length and card clearance. Explicit user pins remain immutable. */
export function optimizeCanvasPorts(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {},
  options: CanvasTidyOptions = {}
): { layout: WorkflowCanvasLayout; changes: number } {
  const next = structuredClone(layout);
  const nodes = reportNodes(orchestration, next, nodeSizes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = reportEdges(orchestration, next)
    .filter((edge) => edge.systemRoute !== "main-dispatch")
    .sort((left, right) => edgePriority(right) - edgePriority(left) || left.id.localeCompare(right.id));
  const loads = new Map<string, number>();
  let changes = 0;

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const stored = next.edges[edge.id];
    if (!source || !target || !stored) continue;
    const sourcePorts = stored.sourcePortPinned && !options.relaxPinnedPorts ? [stored.sourcePort] : PORTS;
    const targetPorts = stored.targetPortPinned && !options.relaxPinnedPorts ? [stored.targetPort] : PORTS;
    let best = { sourcePort: stored.sourcePort, targetPort: stored.targetPort };
    let bestCost = Number.POSITIVE_INFINITY;
    for (const sourcePort of sourcePorts) {
      for (const targetPort of targetPorts) {
        const preferencePenalty = (stored.sourcePortPinned && sourcePort !== stored.sourcePort ? 84 : 0)
          + (stored.targetPortPinned && targetPort !== stored.targetPort ? 84 : 0);
        const cost = portPairCost(edge, source, target, sourcePort, targetPort, nodes, loads) + preferencePenalty;
        if (cost < bestCost - 0.01) {
          best = { sourcePort, targetPort };
          bestCost = cost;
        }
      }
    }
    const currentCost = portPairCost(
      edge,
      source,
      target,
      stored.sourcePort,
      stored.targetPort,
      nodes,
      loads
    );
    // Port changes are visually expensive because the anchor moves around a
    // card. Keep the current pair unless the deterministic candidate clears a
    // meaningful readability margin; tiny scoring fluctuations must not make
    // repeated tidy operations flicker between equivalent sides.
    if (bestCost + 24 >= currentCost) {
      best = { sourcePort: stored.sourcePort, targetPort: stored.targetPort };
    }
    if (best.sourcePort !== stored.sourcePort || best.targetPort !== stored.targetPort) changes += 1;
    next.edges[edge.id] = { ...stored, ...best };
    increment(loads, edge.source + ":" + best.sourcePort);
    increment(loads, edge.target + ":" + best.targetPort);
  }
  return { layout: next, changes };
}

/** Canonical tidy planner.  ELK, the port optimizer, the renderer and this
 * planner all consume `businessWorkflowEdges`; no second hidden tidy rule is
 * applied by the editor.  The planner deliberately makes local, bounded
 * changes so a user's readable composition is not replaced wholesale. */
export function buildSmartTidyPlan(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {},
  options: CanvasTidyOptions = {}
): CanvasTidyResult {
  const original = normalizeCanvasLayout(structuredClone(layout), orchestration);
  // Candidate moves frequently revisit an identical node/port arrangement
  // (especially when a crowded import has several equivalent conflicts).
  // Cache the expensive geometry report for the duration of this pure plan;
  // the key includes both coordinates and edge-port choices, so no stale
  // report can leak across a semantic/layout change.
  const reportCache = new Map<string, CanvasLayoutReport>();
  const reportFor = (candidate: WorkflowCanvasLayout): CanvasLayoutReport => {
    const key = JSON.stringify({ nodes: candidate.nodes, edges: candidate.edges });
    const cached = reportCache.get(key);
    if (cached) return cached;
    const report = canvasLayoutReport(orchestration, candidate, nodeSizes, original);
    reportCache.set(key, report);
    return report;
  };
  const initialReport = reportFor(original);
  const optimized = optimizeCanvasPorts(orchestration, original, nodeSizes, options).layout;
  let next = optimized;
  let report = reportFor(next);
  // Port changes are accepted only when they improve readability. This keeps
  // explicit pins immutable and prevents a port-only tie from perturbing a
  // correct ELK result.
  if (!reportBetter(report, initialReport, 0)) {
    next = original;
    report = initialReport;
  }

  // Resolve heavily stacked imports before evaluating local candidate moves.
  // The old order routed dozens of nearly identical overlapping graphs first,
  // which could block the browser main thread for several seconds and made the
  // full test suite time out under ordinary CI contention. The separation is
  // still accepted only when the canonical report improves.
  const severeCollisionThreshold = Math.max(2, Math.floor(Object.keys(next.nodes).length / 3));
  if (report.stats.nodePairs >= severeCollisionThreshold) {
    const separated = optimizeCanvasPorts(orchestration, separateCollisions(next, nodeSizes), nodeSizes, options).layout;
    const separatedReport = reportFor(separated);
    if (reportBetter(separatedReport, report, 0)) {
      next = separated;
      report = separatedReport;
    }
  }

  // First move a short-edge downstream group as one unit. Moving the target
  // and all reachable descendants together preserves the semantic tiers and
  // is substantially less destructive than nudging cards independently.
  for (const short of [...report.shortEdges]
    .sort((left, right) => left.length - right.length || left.edgeId.localeCompare(right.edgeId))
    .slice(0, 4)) {
    const edge = reportEdges(orchestration, next).find((candidate) => candidate.id === short.edgeId);
    if (!edge) continue;
    const group = downstreamGroup(edge, orchestration, next);
    if (!group.length || group.length >= Object.keys(next.nodes).length) continue;
    if (group.includes("main") && !report.hardNodes.main && !report.overlapNodes.main) continue;
    const source = reportNode(orchestration, next, edge.source, nodeSizes);
    const target = reportNode(orchestration, next, edge.target, nodeSizes);
    if (!source || !target) continue;
    const sourceCenter = center(source);
    const targetCenter = center(target);
    let dx = targetCenter.x - sourceCenter.x;
    let dy = targetCenter.y - sourceCenter.y;
    const distance = Math.max(0.01, Math.hypot(dx, dy));
    dx /= distance; dy /= distance;
    let bestLayout: WorkflowCanvasLayout | undefined;
    let bestReport = report;
    for (const step of [16, 32, 52, 72]) {
      const candidate = structuredClone(next);
      let valid = true;
      for (const id of group) {
        const current = candidate.nodes[id];
        const base = original.nodes[id];
        if (!current || !base) { valid = false; break; }
        const limit = id === CANVAS_INPUT_NODE_ID || id === CANVAS_FINISH_NODE_ID || id === "main" ? 104 : 144;
        const x = current.x + dx * step;
        const y = current.y + dy * step;
        if (x < 18 || y < 18 || Math.hypot(x - base.x, y - base.y) > limit) { valid = false; break; }
        current.x = Math.round(x);
        current.y = Math.round(y);
      }
      if (!valid) continue;
      const candidateReport = reportFor(candidate);
      if (reportBetter(candidateReport, bestReport, 40)) {
        bestLayout = candidate;
        bestReport = candidateReport;
      }
    }
    if (bestLayout) {
      next = bestLayout;
      report = bestReport;
    }
  }

  // Then resolve hard/readability conflicts one node at a time with an
  // adaptive radius. Every accepted move must reduce the global report and
  // may not introduce an order flip.
  for (let pass = 0; pass < 3 && report.stats.hardIssues > 0; pass += 1) {
    let accepted = false;
    const ranked = Object.keys(report.conflictNodes).sort((left, right) =>
      conflictPressure(report, right) - conflictPressure(report, left)
      || left.localeCompare(right)
    );
    // Keep the synchronous planner bounded even for an imported graph where
    // every card initially occupies the same point. The highest-pressure
    // nodes generate the useful moves; evaluating every low-pressure node
    // would only repeat expensive geometry reports without improving the
    // deterministic result.
    for (const nodeId of ranked.slice(0, 3)) {
      if (nodeId === "main" && !report.hardNodes.main && !report.overlapNodes.main) continue;
      const current = next.nodes[nodeId];
      const originalNode = original.nodes[nodeId];
      if (!current || !originalNode) continue;
      const node = reportNode(orchestration, next, nodeId, nodeSizes);
      if (!node) continue;
      const limit = adaptiveMoveLimit(nodeId, report);
      let bestLayout: WorkflowCanvasLayout | undefined;
      let bestReport = report;
      for (const candidate of tidyCandidates(nodeId, current, report, next, nodeSizes, originalNode, limit)) {
        const proposed = structuredClone(next);
        proposed.nodes[nodeId] = candidate;
        const candidateLayout = optimizeCanvasPorts(orchestration, proposed, nodeSizes, options).layout;
        const candidateReport = reportFor(candidateLayout);
        if (!reportBetter(candidateReport, bestReport, 24)) continue;
        bestLayout = candidateLayout;
        bestReport = candidateReport;
        // Once this move removes every hard collision, evaluating lower
        // scoring candidates for the same node cannot improve the primary
        // acceptance criterion and only burns synchronous layout time.
        if (bestReport.stats.hardIssues === 0) break;
      }
      if (!bestLayout) continue;
      next = bestLayout;
      report = bestReport;
      accepted = true;
    }
    const portCandidate = optimizeCanvasPorts(orchestration, next, nodeSizes, options).layout;
    const portReport = reportFor(portCandidate);
    if (reportBetter(portReport, report, 12)) {
      next = portCandidate;
      report = portReport;
      accepted = true;
    }
    if (!accepted) break;
  }

  // A severely stacked import needs a wider deterministic separation pass.
  // It is accepted only if the hard issue count actually drops, so this branch
  // cannot move a readable workflow merely because it has a large bounding box.
  if (report.stats.nodePairs > 0) {
    const separated = optimizeCanvasPorts(orchestration, separateCollisions(next, nodeSizes), nodeSizes, options).layout;
    const separatedReport = reportFor(separated);
    if (reportBetter(separatedReport, report, 0)) {
      next = separated;
      report = separatedReport;
    }
  }
  next.layoutMode = original.layoutMode;
  const movedNodeIds = Object.keys(next.nodes).filter((id) => {
    const before = original.nodes[id];
    const after = next.nodes[id];
    return before && after && (Math.abs(before.x - after.x) > 0.5 || Math.abs(before.y - after.y) > 0.5);
  });
  return {
    layout: next,
    initialReport,
    finalReport: report,
    movedNodeIds,
    portChanges: edgeLayoutChangeCount(original.edges, next.edges)
  };
}

/** Compatibility name retained for existing hosts; it delegates to the one
 * canonical planner above rather than maintaining a second implementation. */
export function buildCanvasTidyResult(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {}
): CanvasTidyResult {
  return buildSmartTidyPlan(orchestration, layout, nodeSizes);
}

function reportNodes(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>>
): CanvasNode[] {
  const createNode = (id: string, kind: CanvasNode["kind"], name: string): CanvasNode => ({
    id,
    kind,
    name,
    ...(layout.nodes[id] ?? { x: 0, y: 0 }),
    ...nodeSizes[id]
  });
  return [
    createNode(CANVAS_INPUT_NODE_ID, "input", "input"),
    ...workflowOuterNodes(orchestration).map((node) => ({
      ...createNode(node.id, "agent", node.id),
      ...(node.definition ? { template: node.definition.template ?? "general" } : {}),
      ...(node.collaboration
        ? { displayName: node.displayName, collaboration: node.collaboration, memberAgentIds: node.collaboration.memberAgentIds }
        : {})
    })),
    createNode(CANVAS_FINISH_NODE_ID, "finish", "finish")
  ];
}

function reportEdges(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout
): CanvasEdge[] {
  // Do not reconstruct a second edge set here.  Normalization and the shared
  // business builder materialize missing legacy presentation records and keep
  // system dispatch edges consistently marked for every consumer.
  return businessWorkflowEdges(orchestration, layout);
}

function portPairCost(
  edge: CanvasEdge,
  source: CanvasNode,
  target: CanvasNode,
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  nodes: readonly CanvasNode[],
  loads: ReadonlyMap<string, number>
): number {
  const start = canvasPortPoint(source, sourcePort);
  const end = canvasPortPoint(target, targetPort);
  const sourceCenter = center(source);
  const targetCenter = center(target);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const direction = { x: dx / length, y: dy / length };
  const sourceAlignment = dot(portVector(sourcePort), direction);
  const targetAlignment = dot(portVector(targetPort), { x: -direction.x, y: -direction.y });
  let cost = (1 - sourceAlignment) * 58 + (1 - targetAlignment) * 58;
  if (sourceAlignment < -0.1) cost += 180;
  if (targetAlignment < -0.1) cost += 180;
  cost += Math.hypot(end.x - start.x, end.y - start.y) * 0.08;
  const sourceLoad = loads.get(edge.source + ":" + sourcePort) ?? 0;
  const targetLoad = loads.get(edge.target + ":" + targetPort) ?? 0;
  cost += sourceLoad * sourceLoad * 32 + targetLoad * targetLoad * 32;
  if (sourcePort === targetPort) cost += edge.kind === "termination" ? 64 : 20;
  for (const node of nodes) {
    if (node.id === edge.source || node.id === edge.target) continue;
    if (polylineIntersectsRect([start, end], nodeRect(node, 12))) cost += 950;
  }
  return cost;
}

function tidyCandidates(
  nodeId: string,
  current: CanvasPoint,
  report: CanvasLayoutReport,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>>,
  original?: CanvasPoint,
  moveLimit = 76
): CanvasPoint[] {
  const candidates: CanvasPoint[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number) => {
    const point = { x: Math.round(Math.max(12, x)), y: Math.round(Math.max(12, y)) };
    if (original && Math.hypot(point.x - original.x, point.y - original.y) > moveLimit + .01) return;
    const key = point.x + ":" + point.y;
    if (seen.has(key) || (point.x === current.x && point.y === current.y)) return;
    seen.add(key);
    candidates.push(point);
  };
  for (const overlap of report.overlapPairs) {
    const otherId = overlap.first === nodeId ? overlap.second : overlap.second === nodeId ? overlap.first : undefined;
    if (!otherId) continue;
    const other = layout.nodes[otherId];
    if (!other) continue;
    const size = canvasNodeSize(nodeSizes[nodeId] ?? {});
    const otherSize = canvasNodeSize(nodeSizes[otherId] ?? {});
    add(other.x + otherSize.width + 42, current.y);
    add(other.x - size.width - 42, current.y);
    add(current.x, other.y + otherSize.height + 42);
    add(current.x, other.y - size.height - 42);
  }
  for (const short of report.shortEdges) {
    if (short.source !== nodeId && short.target !== nodeId) continue;
    const other = layout.nodes[short.source === nodeId ? short.target : short.source];
    if (!other) continue;
    const dx = current.x - other.x || (nodeId.localeCompare(short.source) > 0 ? 1 : -1);
    const dy = current.y - other.y;
    const magnitude = Math.max(1, Math.hypot(dx, dy));
    const push = Math.max(32, 118 - short.length);
    add(current.x + dx / magnitude * push, current.y + dy / magnitude * push);
  }
  for (const conflict of report.alignmentConflicts) {
    if (conflict.first.id !== nodeId && conflict.second.id !== nodeId) continue;
    const delta = conflict.delta;
    if (conflict.second.id === nodeId) {
      if (conflict.axis === "x") add(current.x - delta, current.y);
      else add(current.x, current.y - delta);
    } else if (conflict.axis === "x") add(current.x + delta, current.y);
    else add(current.x, current.y + delta);
  }
  for (const conflict of report.edgeNodeConflicts) {
    if (conflict.node.id === nodeId) {
      add(current.x + (current.x - conflict.point.x || 1), current.y + (current.y - conflict.point.y || 1));
    }
    if (conflict.edge.source === nodeId || conflict.edge.target === nodeId) {
      const blocker = layout.nodes[conflict.node.id];
      if (blocker) add(current.x + (current.x - blocker.x || 1), current.y + (current.y - blocker.y || 1));
    }
  }
  for (const conflict of report.edgePairConflicts) {
    for (const edge of [conflict.first, conflict.second]) {
      if (edge.source !== nodeId && edge.target !== nodeId) continue;
      const otherId = edge.source === nodeId ? edge.target : edge.source;
      const other = layout.nodes[otherId];
      if (!other) continue;
      const dx = other.x - current.x;
      const dy = other.y - current.y;
      add(current.x - dy * 0.25, current.y + dx * 0.25);
      add(current.x + dy * 0.25, current.y - dx * 0.25);
    }
  }
  // Match the reference tidy budget: start with small local corrections and
  // never move a card farther than its adaptive role-specific radius from the
  // user's original composition.
  const steps = [12, 24, 36, 48, 60, 72];
  const directions: Array<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const short of report.shortEdges) {
    if (short.source !== nodeId && short.target !== nodeId) continue;
    const other = layout.nodes[short.source === nodeId ? short.target : short.source];
    if (!other) continue;
    const dx = current.x - other.x || (nodeId.localeCompare(short.source) > 0 ? 1 : -1);
    const dy = current.y - other.y;
    const magnitude = Math.max(1, Math.hypot(dx, dy));
    directions.unshift([dx / magnitude, dy / magnitude], [-dy / magnitude, dx / magnitude], [dy / magnitude, -dx / magnitude]);
  }
  for (const step of steps) {
    for (const [dx, dy] of directions) {
      const x = current.x + dx * step;
      const y = current.y + dy * step;
      if (original && Math.hypot(x - original.x, y - original.y) > moveLimit + .01) continue;
      add(x, y);
    }
  }
  return candidates.slice(0, 8);
}

function separateCollisions(
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>>
): WorkflowCanvasLayout {
  const next = structuredClone(layout);
  const ids = Object.keys(next.nodes).sort();
  for (let pass = 0; pass < 24; pass += 1) {
    let changed = false;
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      const leftId = ids[leftIndex]!;
      const left = next.nodes[leftId]!;
      const leftSize = canvasNodeSize(nodeSizes[leftId] ?? {});
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
        const rightId = ids[rightIndex]!;
        const right = next.nodes[rightId]!;
        const rightSize = canvasNodeSize(nodeSizes[rightId] ?? {});
        const overlapX = Math.min(left.x + leftSize.width + 28, right.x + rightSize.width + 28) - Math.max(left.x, right.x);
        const overlapY = Math.min(left.y + leftSize.height + 28, right.y + rightSize.height + 28) - Math.max(left.y, right.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX <= overlapY) right.x = Math.round(Math.max(12, right.x + overlapX + 12));
        else right.y = Math.round(Math.max(12, right.y + overlapY + 12));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return next;
}

function reportBetter(candidate: CanvasLayoutReport, current: CanvasLayoutReport, minimumImprovement = 0.5): boolean {
  if (candidate.stats.hardIssues !== current.stats.hardIssues) return candidate.stats.hardIssues < current.stats.hardIssues;
  if (candidate.stats.orderFlips > current.stats.orderFlips) return false;
  if (candidate.stats.issues !== current.stats.issues) return candidate.stats.issues < current.stats.issues;
  return candidate.score < current.score - minimumImprovement;
}

function conflictPressure(report: CanvasLayoutReport, id: string): number {
  return report.nodePressure[id] ?? (
    report.overlapPairs.filter((pair) => pair.first === id || pair.second === id).length * 100
      + report.edgeNodeHits.filter((hit) => hit.nodeId === id).length * 40
      + report.shortEdges.filter((edge) => edge.source === id || edge.target === id).length * 10
  );
}

function reportNode(
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout,
  id: string,
  nodeSizes: Readonly<Record<string, CanvasSize>>
): CanvasNode | undefined {
  const point = layout.nodes[id];
  if (!point) return undefined;
  const outerNode = workflowOuterNodes(orchestration).find((node) => node.id === id);
  const definition = outerNode?.definition;
  const kind: CanvasNode["kind"] = id === CANVAS_INPUT_NODE_ID
    ? "input"
    : id === CANVAS_FINISH_NODE_ID ? "finish" : "agent";
  return {
    id,
    kind,
    name: id,
    template: definition?.template ?? (kind === "input" ? undefined : kind === "finish" ? undefined : "general"),
    ...(outerNode?.collaboration
      ? {
          displayName: outerNode.displayName,
          collaboration: outerNode.collaboration,
          memberAgentIds: outerNode.collaboration.memberAgentIds
        }
      : {}),
    ...point,
    ...nodeSizes[id]
  };
}

function downstreamGroup(
  edge: CanvasEdge,
  orchestration: AgentOrchestrationTemplate,
  layout: WorkflowCanvasLayout
): string[] {
  const ids = new Set<string>();
  const valid = new Set(Object.keys(layout.nodes));
  const queue = [edge.target];
  while (queue.length) {
    const id = queue.shift()!;
    if (ids.has(id) || id === edge.source || !valid.has(id)) continue;
    ids.add(id);
    for (const candidate of businessWorkflowEdges(orchestration, layout)) {
      if (candidate.source === id && candidate.target !== id && !candidate.fixed && !ids.has(candidate.target)) {
        queue.push(candidate.target);
      }
    }
  }
  return [...ids].sort();
}

function adaptiveMoveLimit(id: string, report: CanvasLayoutReport): number {
  const system = id === CANVAS_INPUT_NODE_ID || id === CANVAS_FINISH_NODE_ID || id === "main";
  let limit = system ? 68 : 88;
  const pressure = report.nodePressure[id] ?? 0;
  if (pressure >= 60) limit += 24;
  if (report.overlapNodes[id]) limit += system ? 64 : 88;
  else if (report.hardNodes[id]) limit += system ? 16 : 24;
  return Math.min(204, limit);
}

function crossingPoint(left: EdgeGeometry, right: EdgeGeometry): CanvasPoint | undefined {
  if (left.source === right.source || left.source === right.target || left.target === right.source || left.target === right.target) return undefined;
  for (let leftIndex = 1; leftIndex < left.samples.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex < right.samples.length; rightIndex += 1) {
      const point = segmentIntersectionPoint(
        left.samples[leftIndex - 1]!, left.samples[leftIndex]!,
        right.samples[rightIndex - 1]!, right.samples[rightIndex]!
      );
      if (point) return point;
    }
  }
  return undefined;
}

function segmentIntersectionPoint(
  a: CanvasPoint,
  b: CanvasPoint,
  c: CanvasPoint,
  d: CanvasPoint
): CanvasPoint | undefined {
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(denominator) < 0.001) return undefined;
  const u = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
  const v = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator;
  if (u <= 0.03 || u >= 0.97 || v <= 0.03 || v >= 0.97) return undefined;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

function routeCloseRatio(
  first: readonly CanvasPoint[],
  second: readonly CanvasPoint[]
): { ratio: number; exact: number } {
  if (first.length < 8 || second.length < 8) return { ratio: 0, exact: 0 };
  const start = 4;
  const end = first.length - 5;
  if (end <= start) return { ratio: 0, exact: 0 };
  let close = 0;
  let exact = 0;
  let total = 0;
  for (let index = start; index <= end; index += 2) {
    const point = first[index]!;
    let nearest = Number.POSITIVE_INFINITY;
    for (let segment = 2; segment < second.length; segment += 2) {
      nearest = Math.min(nearest, pointToSegmentDistance(point, second[segment - 2]!, second[segment]!));
    }
    total += 1;
    if (nearest < 18) close += 1;
    if (nearest < 6) exact += 1;
  }
  return { ratio: total ? close / total : 0, exact: total ? exact / total : 0 };
}

function pointToSegmentDistance(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 0.0001) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function pointInside(point: CanvasPoint, rect: ReturnType<typeof nodeRect>): boolean {
  return point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
}

function labelRect(edge: EdgeGeometry) {
  const width = edge.kind === "termination" ? 44 : 42;
  const centerY = edge.midpoint.y - 8;
  return {
    left: edge.midpoint.x - width / 2 - 5,
    top: centerY - 10,
    right: edge.midpoint.x + width / 2 + 5,
    bottom: centerY + 10
  };
}

function edgeLayoutChangeCount(
  before: Record<string, WorkflowCanvasEdgeLayout>,
  after: Record<string, WorkflowCanvasEdgeLayout>
): number {
  return Object.keys(after).filter((id) => {
    const left = before[id];
    const right = after[id];
    return left && right && (left.sourcePort !== right.sourcePort || left.targetPort !== right.targetPort);
  }).length;
}

function edgePriority(edge: CanvasEdge): number {
  if (edge.kind === "termination") return 3;
  if (edge.kind === "strong") return 2;
  return 1;
}

function center(node: CanvasNode): CanvasPoint {
  const size = canvasNodeSize(node);
  return { x: node.x + size.width / 2, y: node.y + size.height / 2 };
}

function nodeRect(node: CanvasNode, padding: number) {
  const size = canvasNodeSize(node);
  return {
    left: node.x - padding,
    top: node.y - padding,
    right: node.x + size.width + padding,
    bottom: node.y + size.height + padding
  };
}

function rectOverlapArea(left: ReturnType<typeof nodeRect>, right: ReturnType<typeof nodeRect>): number {
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function sampleLength(samples: readonly CanvasPoint[]): number {
  let result = 0;
  for (let index = 1; index < samples.length; index += 1) {
    result += Math.hypot(samples[index]!.x - samples[index - 1]!.x, samples[index]!.y - samples[index - 1]!.y);
  }
  return result;
}

function portVector(port: WorkflowCanvasPort): CanvasPoint {
  if (port === "top") return { x: 0, y: -1 };
  if (port === "bottom") return { x: 0, y: 1 };
  if (port === "left") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function dot(left: CanvasPoint, right: CanvasPoint): number {
  return left.x * right.x + left.y * right.y;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
