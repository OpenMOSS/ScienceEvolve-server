import type {
  AgentOrchestrationTemplate,
  WorkflowCanvasEdgeLayout,
  WorkflowCanvasLayout,
  WorkflowCanvasPort
} from "../../../types";
import {
  CANVAS_FINISH_NODE_ID,
  CANVAS_INPUT_NODE_ID,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_PORTS
} from "./canvas-model";
import { canvasNodeSize } from "./canvas-model";
import type { CanvasEdge, CanvasNodeGeometry, CanvasSize } from "./canvas-model";
import { workflowLoopMembers } from "../../../../../server/src/internal/shared/workflow-loop-validation.js";
import { workflowOuterNodes } from "./workflow-nodes";

type ElkLayoutEngine = {
  layout: (graph: Record<string, unknown>) => Promise<{ children?: Array<{ id?: string; x?: number; y?: number }> }>;
};

declare global {
  interface Window {
    ELK?: new () => ElkLayoutEngine;
    __openfarsElkPromise?: Promise<ElkLayoutEngine | undefined>;
  }
}

export type CanvasOrchestrationShape = Pick<
  AgentOrchestrationTemplate,
  "agents" | "collaborations" | "schemaVersion" | "scopedWorkflow" | "routes" | "loops" | "input" | "termination"
> & {
  /** Presentation-only adapter for a scoped Input's parallel fan-out. */
  layoutInputTargets?: readonly string[];
  /** Scoped routes have stable source/target identities instead of array ordinals. */
  layoutRouteEdgeIds?: "source-target";
};

export type CanvasLayoutGraphMode = "directed" | "main-dispatch";

/**
 * The rendered graph is the source of truth for what users see.  The layout
 * graph is a presentation-only projection used to choose ranks. Only fixed
 * Main -> Worker dispatch coverage is excluded from ranks. A user-authored
 * Worker -> Main edge stays an ordinary business constraint.
 */
export interface CanvasLayoutGraph {
  mode: CanvasLayoutGraphMode;
  nodeIds: string[];
  renderEdges: CanvasEdge[];
  layoutEdges: CanvasEdge[];
  returnEdgeIds: string[];
  components: string[][];
}

export const DEFAULT_CANVAS_VIEWPORT = { x: 0, y: 0, zoom: 0.82 } as const;
/** Runtime interaction limits from the reference canvas. */
export const MIN_CANVAS_ZOOM = 0.08;
export const MAX_CANVAS_ZOOM = 2.4;
export const MIN_CANVAS_COORDINATE = -20_000;
export const MAX_CANVAS_COORDINATE = 20_000;
// The bundled ELK file is loaded lazily.  A failed or blocked script must not
// leave the layout button waiting for several seconds before the deterministic
// fallback can take over; the fallback is presentation-only and is safe to
// use while ELK finishes loading for a later operation.
const ELK_LAYOUT_TIMEOUT_MS = 1_200;

export function canvasEdgeId(source: string, target: string, index = 0): string {
  return `${source}->${target}:${index}`;
}

function canvasInputTargets(orchestration: CanvasOrchestrationShape): readonly string[] {
  return orchestration.layoutInputTargets ?? (orchestration.input.target ? [orchestration.input.target] : []);
}

function canvasRouteEdgeId(orchestration: CanvasOrchestrationShape, source: string, target: string, index: number): string {
  return canvasEdgeId(source, target, orchestration.layoutRouteEdgeIds === "source-target" ? 0 : index);
}

export function loopExitCanvasEdgeId(loopId: string): string {
  return `loop:${loopId}:exit`;
}

/**
 * Build the one semantic/presentation edge set consumed by layout, reports,
 * routing adapters and runtime overlays.  Main's ordinary fan-out is kept as
 * a system-owned dispatch edge and is deliberately excluded by callers that
 * ask for business edges.  Missing presentation records are represented here
 * instead of being silently dropped; normalizeCanvasLayout supplies their
 * deterministic port defaults at the boundary.
 */
export function businessWorkflowEdges(
  orchestration: CanvasOrchestrationShape,
  value?: WorkflowCanvasLayout
): CanvasEdge[] {
  const layout = value ?? normalizeCanvasLayout(undefined, orchestration);
  const validIds = new Set([
    CANVAS_INPUT_NODE_ID,
    CANVAS_FINISH_NODE_ID,
    ...workflowOuterNodes(orchestration).map((node) => node.id)
  ]);
  const result: CanvasEdge[] = [];
  const seen = new Set<string>();
  const add = (
    id: string,
    source: string,
    target: string,
    kind: CanvasEdge["kind"],
    fixed = false,
    systemRoute?: "main-dispatch"
  ) => {
    if (!validIds.has(source) || !validIds.has(target) || source === target || seen.has(id)) return;
    if (target === CANVAS_FINISH_NODE_ID && layout.connections?.termination === false) return;
    if (source === CANVAS_INPUT_NODE_ID && layout.connections?.input === false) return;
    const stored = layout.edges[id];
    // Port fields are attached by the adapter after this semantic pass. Keep
    // a deterministic fallback here for consumers (ELK/report/runtime) that
    // only need graph topology.
    const sourceNode = layout.nodes[source];
    const targetNode = layout.nodes[target];
    const sourcePort = stored?.sourcePort ?? relativePort(sourceNode, targetNode, "right");
    const targetPort = stored?.targetPort ?? relativePort(targetNode, sourceNode, "left");
    result.push({
      id,
      source,
      target,
      kind,
      fixed,
      ...(systemRoute ? { systemRoute } : {}),
      sourcePort,
      targetPort,
      // Legacy/missing records are adaptive by default.  Explicit pins are
      // preserved, while the tidy/port phase may choose a better side for an
      // unpinned endpoint.
      sourcePortPinned: stored?.sourcePortPinned ?? false,
      targetPortPinned: stored?.targetPortPinned ?? false
    });
    seen.add(id);
  };

  for (const target of canvasInputTargets(orchestration)) {
    add(
      canvasEdgeId(CANVAS_INPUT_NODE_ID, target),
      CANVAS_INPUT_NODE_ID,
      target,
      orchestration.layoutInputTargets ? "parallel" : "strong"
    );
  }
  for (const definition of workflowOuterNodes(orchestration)) {
    for (const [index, route] of (orchestration.routes[definition.id] ?? []).entries()) {
      const target = route.target === "finish" ? CANVAS_FINISH_NODE_ID : route.target;
      add(
        canvasRouteEdgeId(orchestration, definition.id, target, index),
        definition.id,
        target,
        target === CANVAS_FINISH_NODE_ID ? "termination" : route.kind,
        definition.id === "main" && target !== CANVAS_FINISH_NODE_ID,
        definition.id === "main" && target !== CANVAS_FINISH_NODE_ID ? "main-dispatch" : undefined
      );
    }
  }
  decorateCanvasLoops(result, orchestration, (loop) => {
    add(
      loopExitCanvasEdgeId(loop.id),
      loop.from,
      loop.exitTo,
      "strong",
      true
    );
  });
  // A termination owner is always represented when its semantic anchor is
  // connected, even if old data omitted an explicit finish route.
  if (
    orchestration.termination.agent
    && !result.some(
      (edge) => edge.source === orchestration.termination.agent && edge.target === CANVAS_FINISH_NODE_ID
    )
  ) {
    add(
      canvasEdgeId(orchestration.termination.agent, CANVAS_FINISH_NODE_ID),
      orchestration.termination.agent,
      CANVAS_FINISH_NODE_ID,
      "termination"
    );
  }
  return result;
}

/** Shared Loop decoration for the root and each scoped Workflow canvas. */
export function decorateCanvasLoops(
  edges: CanvasEdge[],
  topology: Pick<CanvasOrchestrationShape, "routes" | "loops">,
  addVirtualExit: (loop: NonNullable<CanvasOrchestrationShape["loops"]>[number]) => void
): void {
  for (const loop of topology.loops ?? []) {
    for (const member of workflowLoopMembers(topology, loop)) {
      const memberRoute = (topology.routes[member] ?? []).find((route) => route.kind === "strong");
      const memberEdge = edges.find((edge) => (
        edge.source === member && edge.target === memberRoute?.target && edge.kind === "strong"
      ));
      if (memberEdge) memberEdge.loop = {
        id: loop.id,
        role: member === loop.from ? "return" : "member",
        maxIterations: loop.maxIterations,
        exitTo: loop.exitTo,
        virtual: false
      };
    }
    addVirtualExit(loop);
    const exitEdge = edges.find((edge) => edge.id === loopExitCanvasEdgeId(loop.id));
    if (exitEdge) exitEdge.loop = {
      id: loop.id,
      role: "exit",
      maxIterations: loop.maxIterations,
      exitTo: loop.exitTo,
      virtual: true
    };
  }
}

/** The router handles geometry only; attach Loop identity to the rendered paths. */
export function withCanvasLoopPresentation<T extends { id: string; label?: string }>(
  routed: readonly T[], semantic: readonly CanvasEdge[]
): Array<T & { loop?: CanvasEdge["loop"] }> {
  const edgeById = new Map(semantic.map((edge) => [edge.id, edge]));
  return routed.map((item) => {
    const loop = edgeById.get(item.id)?.loop;
    if (!loop) return item;
    return {
      ...item,
      loop,
      label: loop.role === "return" ? `↻ ${loop.id} · ${loop.maxIterations} 次/批`
        : loop.role === "exit" ? `批次退出 · ${loop.id}` : item.label
    };
  });
}

export function buildCanvasLayoutGraph(
  orchestration: CanvasOrchestrationShape,
  value?: WorkflowCanvasLayout
): CanvasLayoutGraph {
  const layout = value ?? normalizeCanvasLayout(undefined, orchestration);
  const nodeIds = [
    CANVAS_INPUT_NODE_ID,
    ...workflowOuterNodes(orchestration).map((node) => node.id),
    CANVAS_FINISH_NODE_ID
  ];
  const renderEdges = businessWorkflowEdges(orchestration, layout);
  const dispatchEdges = renderEdges.filter((edge) => edge.systemRoute === "main-dispatch");
  // Main is a normal business-layout node whenever a user edge reaches or
  // leaves it.  Only the system-owned Main -> Worker coverage is a visual
  // overlay.  Endpoint names alone must never turn a user-created edge into a
  // hidden "return" edge or remove it from rank constraints.
  const layoutEdges = renderEdges.filter(
    (edge) => edge.systemRoute !== "main-dispatch" && edge.loop?.role !== "exit"
  );
  const mode: CanvasLayoutGraphMode = dispatchEdges.length ? "main-dispatch" : "directed";
  return {
    mode,
    nodeIds,
    renderEdges,
    layoutEdges,
    // Retained for wire/test compatibility. There is no system return-edge
    // concept in the direct-edge product model.
    returnEdgeIds: [],
    components: stronglyConnectedComponents(nodeIds, layoutEdges)
  };
}

export function canvasEdgeLayout(
  sourcePort: WorkflowCanvasPort,
  targetPort: WorkflowCanvasPort,
  sourcePortPinned = false,
  targetPortPinned = false
): WorkflowCanvasEdgeLayout {
  return { sourcePort, targetPort, sourcePortPinned, targetPortPinned };
}

/**
 * Build presentation state from semantic workflow data. The positions follow
 * the reference OpenFARS fan-out/merge composition but never affect execution.
 */
export function createDefaultCanvasLayout(
  orchestration: CanvasOrchestrationShape
): WorkflowCanvasLayout {
  const blank = isBlankWorkflow(orchestration);
  const outerNodes = workflowOuterNodes(orchestration);
  const useComplexLayout = !blank && outerNodes.length >= 6;
  const nodes: WorkflowCanvasLayout["nodes"] = {
    [CANVAS_INPUT_NODE_ID]: { x: 20, y: blank ? 210 : 260 },
    [CANVAS_FINISH_NODE_ID]: { x: blank ? 550 : 735, y: blank ? 210 : 620 }
  };
  if (outerNodes.some((node) => node.id === "main")) {
    nodes.main = { x: blank ? 300 : 245, y: blank ? 210 : 260 };
  }

  // Larger reference flows use a wide left-to-right composition.  Keep the
  // small draft slots below for compact/default workflows, but derive a
  // deterministic topology layout for complex graphs so fit() sees the same
  // world-space span as the standalone canvas.  Main fan-out is treated as a
  // dispatch tier; ordinary routes then advance subsequent tiers.
  if (useComplexLayout) {
    const complexNodes = createComplexDefaultNodes(orchestration);
    Object.assign(nodes, complexNodes);
  }

  const preferredSlots = [
    { x: 490, y: 70 },
    { x: 490, y: 260 },
    { x: 490, y: 620 },
    { x: 735, y: 260 }
  ] as const;
  const usedSlots = new Set<number>();

  outerNodes
    .filter((node) => node.id !== "main")
    .forEach((node, index) => {
      const semanticSlot = node.definition?.template === "writing" || node.id === "writing"
        ? 3
        : node.definition?.template === "review" || node.id === "review"
          ? 2
          : undefined;
      const firstFreeSlot = preferredSlots.findIndex((_, slot) => !usedSlots.has(slot));
      const slot = semanticSlot !== undefined && !usedSlots.has(semanticSlot)
        ? semanticSlot
        : firstFreeSlot;
      if (nodes[node.id]) {
        return;
      }
      if (slot >= 0) {
        usedSlots.add(slot);
        nodes[node.id] = { ...preferredSlots[slot]! };
      } else {
        nodes[node.id] = {
          x: 980 + Math.floor(index / 4) * 250,
          y: 70 + (index % 4) * 174
        };
      }
    });

  const edges: WorkflowCanvasLayout["edges"] = {};
  // The reference direct-edge canvas always renders the two system-owned
  // anchor edges in a three-node draft as well as in populated workflows.
  // They are presentation metadata, not ordinary user routes, so derive them
  // from the semantic input/termination fields instead of treating a blank
  // workflow as disconnected.
  for (const target of canvasInputTargets(orchestration)) {
    edges[canvasEdgeId(CANVAS_INPUT_NODE_ID, target)] = canvasEdgeLayout("right", "left");
  }
  let hasTerminationEdge = false;
  for (const node of outerNodes) {
    (orchestration.routes[node.id] ?? []).forEach((route, index) => {
      const target = route.target === "finish" ? CANVAS_FINISH_NODE_ID : route.target;
      if (target === CANVAS_FINISH_NODE_ID && node.id === orchestration.termination.agent) hasTerminationEdge = true;
      edges[canvasRouteEdgeId(orchestration, node.id, target, index)] = canvasEdgeLayout(
        relativePort(nodes[node.id], nodes[target], "right"),
        relativePort(nodes[target], nodes[node.id], "left")
      );
    });
  }
  if (!hasTerminationEdge && orchestration.termination.agent && nodes[orchestration.termination.agent]) {
    const source = orchestration.termination.agent;
    edges[canvasEdgeId(source, CANVAS_FINISH_NODE_ID)] = canvasEdgeLayout(
      relativePort(nodes[source], nodes[CANVAS_FINISH_NODE_ID], "right"),
      relativePort(nodes[CANVAS_FINISH_NODE_ID], nodes[source], "left")
    );
  }

  return {
    schemaVersion: 1,
    nodes,
    edges,
    viewport: { ...DEFAULT_CANVAS_VIEWPORT },
    layoutMode: "free",
    connections: { input: true, termination: true }
  };
}

function createComplexDefaultNodes(
  orchestration: CanvasOrchestrationShape
): WorkflowCanvasLayout["nodes"] {
  const result: WorkflowCanvasLayout["nodes"] = {
    [CANVAS_INPUT_NODE_ID]: { x: 20, y: 270 },
    [CANVAS_FINISH_NODE_ID]: { x: 1720, y: 270 }
  };
  if (!workflowOuterNodes(orchestration).some((node) => node.id === "main")) return result;
  result.main = { x: 260, y: 270 };

  const ids = workflowOuterNodes(orchestration).map((node) => node.id);
  const ranks = new Map<string, number>([["main", 1]]);
  const queue: string[] = [];
  const enqueue = (id: string, rank: number) => {
    if (!ids.includes(id) || id === "main") return;
    if (rank > ids.length + 2) return;
    const previous = ranks.get(id);
    if (previous !== undefined && previous >= rank) return;
    ranks.set(id, rank);
    queue.push(id);
  };

  // Main fan-out is a system-owned display rail, but its children still form
  // the first visible worker tier. Ordinary routes then advance later tiers.
  for (const route of orchestration.routes.main ?? []) {
    if (route.target !== "finish") enqueue(route.target, 2);
  }
  for (const target of canvasInputTargets(orchestration)) {
    if (target !== "main") enqueue(target, 2);
  }

  while (queue.length) {
    const source = queue.shift()!;
    const sourceRank = ranks.get(source) ?? 2;
    for (const route of orchestration.routes[source] ?? []) {
      if (route.target === "finish" || route.target === "main") continue;
      enqueue(route.target, sourceRank + 1);
    }
  }

  const nextDisconnectedRank = Math.max(2, ...ranks.values()) + 1;
  ids.filter((id) => id !== "main" && !ranks.has(id)).forEach((id) => enqueue(id, nextDisconnectedRank));

  const columns = new Map<number, string[]>();
  for (const id of ids) {
    if (id === "main") continue;
    const rank = ranks.get(id) ?? 2;
    const column = columns.get(rank) ?? [];
    column.push(id);
    columns.set(rank, column);
  }
  for (const [rank, column] of [...columns.entries()].sort(([left], [right]) => left - right)) {
    column.sort((left, right) => ids.indexOf(left) - ids.indexOf(right));
    const rowGap = column.length === 2 ? 360 : 180;
    const startY = 270 - ((column.length - 1) * rowGap) / 2;
    column.forEach((id, index) => {
      result[id] = { x: complexColumnX(rank), y: startY + index * rowGap };
    });
  }
  const maxRank = Math.max(2, ...columns.keys());
  result[CANVAS_FINISH_NODE_ID] = { x: complexColumnX(maxRank) + 260, y: 270 };
  return result;
}

function complexColumnX(rank: number): number {
  if (rank <= 2) return 500;
  if (rank === 3) return 760;
  if (rank === 4) return 990;
  return 1220 + (rank - 5) * 240;
}

/**
 * Sanitize persisted presentation data against the current semantic graph.
 * Removed agents/routes cannot leak back into the active canvas.
 */
export function normalizeCanvasLayout(
  value: unknown,
  orchestration: CanvasOrchestrationShape
): WorkflowCanvasLayout {
  const fallback = createDefaultCanvasLayout(orchestration);
  if (!isRecord(value)) return fallback;

  const validNodeIds = new Set([
    CANVAS_INPUT_NODE_ID,
    CANVAS_FINISH_NODE_ID,
    ...workflowOuterNodes(orchestration).map((node) => node.id)
  ]);
  const nodes = { ...fallback.nodes };
  if (isRecord(value.nodes)) {
    for (const [id, raw] of Object.entries(value.nodes)) {
      if (!validNodeIds.has(id) || !isRecord(raw)) continue;
      const x = finiteNumber(raw.x);
      const y = finiteNumber(raw.y);
      if (x === undefined || y === undefined) continue;
      nodes[id] = {
        x: clamp(x, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
        y: clamp(y, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE)
      };
    }
  }

  const rawConnections = isRecord(value.connections) ? value.connections : {};
  const connections = {
    input: rawConnections.input !== false,
    termination: rawConnections.termination !== false
  };
  const edges = { ...fallback.edges };
  const inputEdgeIds = canvasInputTargets(orchestration).map((target) => canvasEdgeId(CANVAS_INPUT_NODE_ID, target));
  if (isRecord(value.edges)) {
    for (const [id, raw] of Object.entries(value.edges)) {
      if (!inputEdgeIds.includes(id) && !(id in fallback.edges)) continue;
      if (!isRecord(raw)) continue;
      const sourcePort = canvasPort(raw.sourcePort);
      const targetPort = canvasPort(raw.targetPort);
      if (!sourcePort || !targetPort) continue;
      edges[id] = canvasEdgeLayout(
        sourcePort,
        targetPort,
        raw.sourcePortPinned !== false,
        raw.targetPortPinned !== false
      );
    }
  }
  if (!connections.input) for (const id of inputEdgeIds) delete edges[id];
  if (!connections.termination) {
    for (const id of Object.keys(edges)) {
      if (id.includes(`->${CANVAS_FINISH_NODE_ID}:`)) delete edges[id];
    }
  }

  const rawViewport = isRecord(value.viewport) ? value.viewport : {};
  return {
    schemaVersion: 1,
    nodes,
    edges,
    viewport: {
      x: clamp(finiteNumber(rawViewport.x) ?? fallback.viewport.x, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
      y: clamp(finiteNumber(rawViewport.y) ?? fallback.viewport.y, MIN_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
      zoom: clamp(
        finiteNumber(rawViewport.zoom) ?? fallback.viewport.zoom,
        MIN_CANVAS_ZOOM,
        MAX_CANVAS_ZOOM
      )
    },
    layoutMode: value.layoutMode === "layered" ? "layered" : "free",
    connections
  };
}

export function relativePort(
  from: CanvasNodeGeometry | undefined,
  to: CanvasNodeGeometry | undefined,
  fallback: WorkflowCanvasPort
): WorkflowCanvasPort {
  if (!from || !to) return fallback;
  const fromSize = canvasNodeSize(from);
  const toSize = canvasNodeSize(to);
  const dx = to.x + toSize.width / 2 - (from.x + fromSize.width / 2);
  const dy = to.y + toSize.height / 2 - (from.y + fromSize.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** Attach sanitized presentation state without mutating semantic workflow. */
export function withCanvasLayout<T extends AgentOrchestrationTemplate>(
  orchestration: T,
  layout: unknown
): T {
  return {
    ...structuredClone(orchestration),
    canvas: normalizeCanvasLayout(layout, orchestration)
  };
}

/**
 * Build the reference-style tidy composition from graph structure rather than
 * array order. The function is pure and deterministic, making it safe to use
 * for both the toolbar command and compact/full previews.
 */
/** Build a deterministic topology seed for legacy callers.  The full tidy
 * command lives in `canvas-layout-report.ts`; keeping this helper separate
 * avoids a second command accidentally being invoked by the editor. */
export function buildTopologyTidyLayout(
  orchestration: CanvasOrchestrationShape,
  value?: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {}
): WorkflowCanvasLayout {
  const next = normalizeCanvasLayout(value, orchestration);
  const definitions = workflowOuterNodes(orchestration);
  const ids = definitions.map((entry) => entry.id);
  const workers = ids.filter((id) => id !== "main");
  const level = new Map<string, number>([["input", 0], ["main", 1]]);
  const queue = [...canvasInputTargets(orchestration)];
  let visits = 0;
  while (queue.length && visits < Math.max(1, ids.length * ids.length * 2)) {
    visits += 1;
    const source = queue.shift()!;
    const sourceLevel = level.get(source) ?? 1;
    for (const route of orchestration.routes[source] ?? []) {
      if (route.target === "finish") continue;
      const target = route.target;
      const proposed = sourceLevel + 1;
      if (proposed <= ids.length + 2 && (level.get(target) ?? -1) < proposed) {
        level.set(target, proposed);
        queue.push(target);
      }
    }
  }
  const maxLevel = Math.max(2, ...workers.map((id) => level.get(id) ?? 2));
  const columns = new Map<number, string[]>();
  for (const id of workers) {
    const column = Math.min(maxLevel, Math.max(2, level.get(id) ?? 2));
    const list = columns.get(column) ?? [];
    list.push(id);
    columns.set(column, list);
  }
  for (const list of columns.values()) list.sort((a, b) => a.localeCompare(b));
  next.nodes.input = { x: 40, y: 360 };
  next.nodes.main = { x: 300, y: 360 };
  const measuredWidths = [
    CANVAS_NODE_WIDTH,
    ...Object.values(nodeSizes).map((size) => canvasNodeSize(size).width)
  ];
  const columnWidth = Math.max(280, Math.max(...measuredWidths) + 86);
  const measuredHeights = [
    CANVAS_NODE_HEIGHT,
    ...Object.values(nodeSizes).map((size) => canvasNodeSize(size).height)
  ];
  const rowGap = Math.max(150, Math.max(...measuredHeights) + 58);
  for (const [column, list] of [...columns.entries()].sort(([a], [b]) => a - b)) {
    const x = 300 + (column - 1) * columnWidth;
    const totalHeight = (list.length - 1) * rowGap;
    list.forEach((id, index) => {
      const definition = definitions.find((entry) => entry.id === id)?.definition;
      const semanticOffset = definition?.template === "writing" ? 30 : definition?.template === "review" ? 60 : 0;
      next.nodes[id] = { x, y: 360 - totalHeight / 2 + index * rowGap + semanticOffset };
    });
  }
  next.nodes.finish = { x: 300 + (maxLevel + 1) * columnWidth, y: 360 };
  next.layoutMode = "free";
  // Recompute port choices after node movement while retaining explicit pins.
  for (const definition of definitions) {
    for (const [index, route] of (orchestration.routes[definition.id] ?? []).entries()) {
      const target = route.target === "finish" ? CANVAS_FINISH_NODE_ID : route.target;
      if (target === CANVAS_FINISH_NODE_ID && next.connections?.termination === false) continue;
      const id = canvasRouteEdgeId(orchestration, definition.id, target, index);
      const current = next.edges[id];
      const sourceGeometry = { ...next.nodes[definition.id]!, ...nodeSizes[definition.id] };
      const targetGeometry = { ...next.nodes[target]!, ...nodeSizes[target] };
      if (!current || !current.sourcePortPinned) current && (current.sourcePort = relativePort(sourceGeometry, targetGeometry, "right"));
      if (!current || !current.targetPortPinned) current && (current.targetPort = relativePort(targetGeometry, sourceGeometry, "left"));
      if (!current) next.edges[id] = canvasEdgeLayout(
        relativePort(sourceGeometry, targetGeometry, "right"),
        relativePort(targetGeometry, sourceGeometry, "left")
      );
    }
  }
  return next;
}

/** Alias used by the host to make the full tidy command explicit. */
export function tidyCanvas(
  orchestration: CanvasOrchestrationShape,
  value?: WorkflowCanvasLayout,
  nodeSizes?: Readonly<Record<string, CanvasSize>>
): WorkflowCanvasLayout {
  return buildTopologyTidyLayout(orchestration, value, nodeSizes);
}

/**
 * Run the reference canvas' layered phase through the bundled ELK runtime.
 * The returned value remains presentation-only and never mutates semantics.
 */
export interface LayeredCanvasLayoutResult {
  layout: WorkflowCanvasLayout;
  mode: CanvasLayoutGraphMode;
  /** True when ELK was unavailable, timed out, failed, or returned an
   * incomplete graph and the deterministic layered fallback was used. */
  usedFallback: boolean;
  reason?: string;
  elkTargets: Record<string, CanvasNodeGeometry>;
}

/** Run the layered phase and retain enough provenance for the editor's stage
 * snapshots and user-facing fallback notice. */
export async function layeredCanvasLayoutWithMeta(
  orchestration: AgentOrchestrationTemplate,
  value: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {}
): Promise<LayeredCanvasLayoutResult> {
  const layout = normalizeCanvasLayout(value, orchestration);
  const layoutGraph = buildCanvasLayoutGraph(orchestration, layout);
  const ordered = stableLayoutNodes(orchestration, layout);
  const fallback = () => {
    const targets = fallbackLayeredTargets(orchestration, layout, nodeSizes);
    const next = structuredClone(layout);
    for (const [id, point] of Object.entries(targets)) next.nodes[id] = point;
    applyMainDispatchPorts(next, layoutGraph, nodeSizes);
    next.layoutMode = "layered";
    return { layout: next, mode: layoutGraph.mode, usedFallback: true, reason: "ELK 不可用或返回结果不完整，已使用确定性分层回退", elkTargets: targets };
  };

  if (usesSparseBusinessGrid(orchestration, layoutGraph)) {
    const targets = sparseBusinessGridTargets(orchestration, layout, nodeSizes, layoutGraph);
    const next = structuredClone(layout);
    for (const [id, point] of Object.entries(targets)) next.nodes[id] = point;
    applyMainDispatchPorts(next, layoutGraph, nodeSizes);
    next.layoutMode = "layered";
    return { layout: next, mode: layoutGraph.mode, usedFallback: false, elkTargets: targets };
  }

  const engine = await promiseWithTimeout(loadElkLayoutEngine(), ELK_LAYOUT_TIMEOUT_MS).catch(() => undefined);
  if (!engine) return fallback();

  // ELK's model order is the workflow's authored Agent order.  This prevents
  // crossing minimization from swapping idea/execution/writing/review merely
  // to save a feedback crossing, which made repeated layered layouts feel
  // arbitrary to users.
  const semanticOrder = [
    { id: CANVAS_INPUT_NODE_ID },
    ...workflowOuterNodes(orchestration).map((node) => ({ id: node.id })),
    { id: CANVAS_FINISH_NODE_ID }
  ];
  const graphNodes = semanticOrder.map((node) => ({
    id: node.id,
    ...canvasNodeSize(nodeSizes[node.id] ?? {}),
    ...(node.id === CANVAS_INPUT_NODE_ID
      ? { layoutOptions: { "elk.layered.layering.layerConstraint": "FIRST" } }
      : {}),
    ...(node.id === CANVAS_FINISH_NODE_ID
      ? { layoutOptions: { "elk.layered.layering.layerConstraint": "LAST" } }
      : {})
  }));
  const validIds = new Set(graphNodes.map((node) => node.id));
  const graphEdges = layoutGraph.layoutEdges
    .filter((edge) => validIds.has(edge.source) && validIds.has(edge.target))
    .sort((left, right) => left.source.localeCompare(right.source)
      || left.target.localeCompare(right.target)
      || left.id.localeCompare(right.id));
  const graph = {
    id: "openfars-workflow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "SPLINES",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.spacing.nodeNode": "56",
      "elk.spacing.componentComponent": "88",
      "elk.separateConnectedComponents": "false",
      "elk.layered.spacing.nodeNodeBetweenLayers": "104",
      "elk.layered.spacing.edgeNodeBetweenLayers": "38",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.feedbackEdges": "true",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.thoroughness": "30",
      "elk.randomSeed": "1"
    },
    children: graphNodes,
    edges: graphEdges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      priority: edge.kind === "termination" ? 8 : edge.kind === "strong" ? 10 : 2
    }))
  };

  try {
    const result = await promiseWithTimeout(engine.layout(graph), 4_000);
    const targets: Record<string, CanvasNodeGeometry> = {};
    for (const child of result.children ?? []) {
      if (child.id && Number.isFinite(child.x) && Number.isFinite(child.y)) {
        targets[child.id] = { x: child.x!, y: child.y! };
      }
    }
    if (Object.keys(targets).length !== ordered.length || ordered.some((node) => !targets[node.id])) {
      return { ...fallback(), reason: "ELK 返回的 children 不完整，已使用确定性分层回退" };
    }
    dockIsolatedMain(targets, orchestration, layout, nodeSizes, layoutGraph);
    anchorLayoutTargets(targets, layout);
    const next = structuredClone(layout);
    for (const [id, point] of Object.entries(targets)) next.nodes[id] = { x: Math.round(point.x), y: Math.round(point.y) };
    applyMainDispatchPorts(next, layoutGraph, nodeSizes);
    next.layoutMode = "layered";
    return { layout: next, mode: layoutGraph.mode, usedFallback: false, elkTargets: targets };
  } catch {
    return { ...fallback(), reason: "ELK 执行失败或超时，已使用确定性分层回退" };
  }
}

/** Backwards-compatible layout-only API used by callers and tests. */
export async function layeredCanvasLayout(
  orchestration: AgentOrchestrationTemplate,
  value: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {}
): Promise<WorkflowCanvasLayout> {
  return (await layeredCanvasLayoutWithMeta(orchestration, value, nodeSizes)).layout;
}

function stableLayoutNodes(
  orchestration: CanvasOrchestrationShape,
  _layout: WorkflowCanvasLayout
): Array<{ id: string }> {
  return [
    { id: CANVAS_INPUT_NODE_ID },
    ...workflowOuterNodes(orchestration).map((node) => ({ id: node.id })),
    { id: CANVAS_FINISH_NODE_ID }
  ];
}

/** Compatibility entry point retained for callers that previously requested
 * the Main-specific grid directly.  The grid now represents only a sparse
 * business graph: Main's system coverage never creates ranks, and Main is
 * dynamically docked outside the Worker grid rather than fixed in column 1. */
export function mainDispatchLayoutTargets(
  orchestration: CanvasOrchestrationShape,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {}
): Record<string, CanvasNodeGeometry> {
  return sparseBusinessGridTargets(
    orchestration,
    layout,
    nodeSizes,
    buildCanvasLayoutGraph(orchestration, layout)
  );
}

function usesSparseBusinessGrid(
  orchestration: CanvasOrchestrationShape,
  graph: CanvasLayoutGraph
): boolean {
  const outerNodes = workflowOuterNodes(orchestration);
  if (!outerNodes.some((node) => node.id === "main")) return false;
  if (!outerNodes.some((node) => node.id !== "main")) return false;
  const agentIds = new Set(outerNodes.map((node) => node.id));
  const hasAgentBusinessEdge = graph.layoutEdges.some((edge) => (
    agentIds.has(edge.source) && agentIds.has(edge.target)
  ));
  const mainHasBusinessEdge = graph.layoutEdges.some((edge) => (
    edge.source === "main" || edge.target === "main"
  ));
  return !hasAgentBusinessEdge && !mainHasBusinessEdge;
}

function sparseBusinessGridTargets(
  orchestration: CanvasOrchestrationShape,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>>,
  graph: CanvasLayoutGraph
): Record<string, CanvasNodeGeometry> {
  const outerNodes = workflowOuterNodes(orchestration);
  const workers = outerNodes.filter((node) => node.id !== "main");
  if (!workers.length || !outerNodes.some((node) => node.id === "main")) {
    return fallbackLayeredTargets(orchestration, layout, nodeSizes);
  }
  const columnCount = workers.length <= 3
    ? workers.length
    : workers.length === 4
      ? 2
      : workers.length <= 6
        ? 3
        : Math.min(5, Math.max(3, Math.ceil(Math.sqrt(workers.length * 1.45))));
  const rowCount = Math.ceil(workers.length / columnCount);
  const inputSize = canvasNodeSize(nodeSizes[CANVAS_INPUT_NODE_ID] ?? {});
  const mainSize = canvasNodeSize(nodeSizes.main ?? {});
  const workerWidth = Math.max(...workers.map((worker) => canvasNodeSize(nodeSizes[worker.id] ?? {}).width));
  const workerHeight = Math.max(...workers.map((worker) => canvasNodeSize(nodeSizes[worker.id] ?? {}).height));
  const columnGap = Math.max(104, workerWidth * .52);
  const rowGap = Math.max(66, workerHeight * .68);
  const workerStartX = 280;
  const workerAreaHeight = rowCount * workerHeight + Math.max(0, rowCount - 1) * rowGap;
  const workerStartY = 0;
  const centerY = workerStartY + workerAreaHeight / 2;
  const targets: Record<string, CanvasNodeGeometry> = {};
  workers.forEach((worker, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    targets[worker.id] = {
      x: workerStartX + column * (workerWidth + columnGap),
      y: workerStartY + row * (workerHeight + rowGap)
    };
  });
  const inputTarget = targets[orchestration.input.target];
  const inputTargetSize = canvasNodeSize(nodeSizes[orchestration.input.target] ?? {});
  targets[CANVAS_INPUT_NODE_ID] = inputTarget
    ? {
        x: inputTarget.x - inputSize.width - 104,
        y: inputTarget.y + (inputTargetSize.height - inputSize.height) / 2
      }
    : { x: workerStartX - inputSize.width - 104, y: centerY - inputSize.height / 2 };
  const terminationPoint = targets[orchestration.termination.agent];
  const finishSize = canvasNodeSize(nodeSizes[CANVAS_FINISH_NODE_ID] ?? {});
  const lastWorkerX = workerStartX + (columnCount - 1) * (workerWidth + columnGap);
  targets[CANVAS_FINISH_NODE_ID] = {
    x: lastWorkerX + workerWidth + 136,
    y: terminationPoint
      ? terminationPoint.y + workerHeight / 2 - finishSize.height / 2
      : centerY - finishSize.height / 2
  };
  // Seed Main only so the docking scorer can use its measured size. Its final
  // position is derived from the current business composition below.
  targets.main = {
    x: workerStartX - mainSize.width - 104,
    y: centerY - mainSize.height / 2
  };
  dockIsolatedMain(targets, orchestration, layout, nodeSizes, graph);
  return anchorLayoutTargets(targets, layout);
}

function applyMainDispatchPorts(
  layout: WorkflowCanvasLayout,
  graph: CanvasLayoutGraph,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {}
): void {
  const mainPoint = layout.nodes.main;
  if (!mainPoint) return;
  const dispatch = graph.renderEdges.filter((edge) => edge.systemRoute === "main-dispatch");
  if (!dispatch.length) return;
  const mainSize = canvasNodeSize(nodeSizes.main ?? {});
  const mainCenter = { x: mainPoint.x + mainSize.width / 2, y: mainPoint.y + mainSize.height / 2 };
  const targetCenters = dispatch.flatMap((edge) => {
    const point = layout.nodes[edge.target];
    if (!point) return [];
    const size = canvasNodeSize(nodeSizes[edge.target] ?? {});
    return [{ x: point.x + size.width / 2, y: point.y + size.height / 2 }];
  });
  const centroid = targetCenters.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  centroid.x /= Math.max(1, targetCenters.length);
  centroid.y /= Math.max(1, targetCenters.length);
  const sourcePort = Math.abs(centroid.x - mainCenter.x) >= Math.abs(centroid.y - mainCenter.y)
    ? centroid.x >= mainCenter.x ? "right" as const : "left" as const
    : centroid.y >= mainCenter.y ? "bottom" as const : "top" as const;
  for (const edge of graph.renderEdges) {
    const stored = layout.edges[edge.id];
    if (!stored) continue;
    if (edge.systemRoute === "main-dispatch") {
      layout.edges[edge.id] = {
        ...stored,
        sourcePort,
        targetPort: relativePort(layout.nodes[edge.target], mainPoint, "left"),
        sourcePortPinned: false,
        targetPortPinned: false
      };
    }
  }
}

function dockIsolatedMain(
  targets: Record<string, CanvasNodeGeometry>,
  orchestration: CanvasOrchestrationShape,
  previous: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>>,
  graph: CanvasLayoutGraph
): void {
  if (!targets.main || graph.layoutEdges.some((edge) => edge.source === "main" || edge.target === "main")) return;
  const workerIds = workflowOuterNodes(orchestration).map((node) => node.id).filter((id) => id !== "main" && targets[id]);
  if (!workerIds.length) return;
  const mainSize = canvasNodeSize(nodeSizes.main ?? {});
  const workerRects = workerIds.map((id) => {
    const point = targets[id]!;
    const size = canvasNodeSize(nodeSizes[id] ?? {});
    return { id, left: point.x, top: point.y, right: point.x + size.width, bottom: point.y + size.height };
  });
  const bounds = workerRects.reduce((result, rect) => ({
    left: Math.min(result.left, rect.left),
    top: Math.min(result.top, rect.top),
    right: Math.max(result.right, rect.right),
    bottom: Math.max(result.bottom, rect.bottom)
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const center = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  const gap = 108;
  const baseCandidates = [
    { side: "left", x: bounds.left - mainSize.width - gap, y: center.y - mainSize.height / 2 },
    { side: "top", x: center.x - mainSize.width / 2, y: bounds.top - mainSize.height - gap },
    { side: "right", x: bounds.right + gap, y: center.y - mainSize.height / 2 },
    { side: "bottom", x: center.x - mainSize.width / 2, y: bounds.bottom + gap }
  ] as const;
  const allRects = Object.entries(targets).filter(([id]) => id !== "main").map(([id, point]) => {
    const size = canvasNodeSize(nodeSizes[id] ?? {});
    return { id, left: point.x, top: point.y, right: point.x + size.width, bottom: point.y + size.height };
  });
  const previousMain = previous.nodes.main;
  const previousWorkerPoints = workerIds.map((id) => previous.nodes[id]).filter(Boolean);
  const previousBounds = previousWorkerPoints.length ? previousWorkerPoints.reduce((result, point) => ({
    left: Math.min(result.left, point!.x), top: Math.min(result.top, point!.y),
    right: Math.max(result.right, point!.x), bottom: Math.max(result.bottom, point!.y)
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }) : undefined;
  const previousSide = previousMain && previousBounds
    ? sideOfBounds(previousMain, mainSize, previousBounds)
    : undefined;
  const candidates = baseCandidates.flatMap((candidate) => {
    const tangent = candidate.side === "left" || candidate.side === "right"
      ? { x: 0, y: mainSize.height + 52 }
      : { x: mainSize.width + 52, y: 0 };
    return [0, -1, 1].map((offset) => ({
      ...candidate,
      x: candidate.x + tangent.x * offset,
      y: candidate.y + tangent.y * offset
    }));
  });
  const sideOrder = new Map(["left", "top", "right", "bottom"].map((side, index) => [side, index]));
  const targetCenters = workerRects.map((rect) => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }));
  const score = (candidate: (typeof candidates)[number]): number => {
    const rect = {
      left: candidate.x - 28,
      top: candidate.y - 28,
      right: candidate.x + mainSize.width + 28,
      bottom: candidate.y + mainSize.height + 28
    };
    const collision = allRects.some((other) => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top);
    if (collision) return 1_000_000_000;
    const mainCenter = { x: candidate.x + mainSize.width / 2, y: candidate.y + mainSize.height / 2 };
    const totalLength = targetCenters.reduce((sum, point) => sum + Math.hypot(point.x - mainCenter.x, point.y - mainCenter.y), 0);
    const input = targets[CANVAS_INPUT_NODE_ID];
    const finish = targets[CANVAS_FINISH_NODE_ID];
    const corridorPenalty = input && finish
      && mainCenter.x > Math.min(input.x, finish.x) && mainCenter.x < Math.max(input.x, finish.x)
      && Math.abs(mainCenter.y - (input.y + finish.y) / 2) < mainSize.height
      ? 2_000 : 0;
    return totalLength + corridorPenalty
      + (candidate.side === previousSide ? -36 : 0)
      + (sideOrder.get(candidate.side) ?? 0) * .01;
  };
  candidates.sort((left, right) => score(left) - score(right));
  const best = candidates[0]!;
  targets.main = { x: best.x, y: best.y };
}

function sideOfBounds(
  point: CanvasNodeGeometry,
  size: CanvasSize,
  bounds: { left: number; top: number; right: number; bottom: number }
): "left" | "top" | "right" | "bottom" {
  const center = { x: point.x + size.width / 2, y: point.y + size.height / 2 };
  const distances = [
    { side: "left" as const, distance: Math.abs(center.x - bounds.left) },
    { side: "top" as const, distance: Math.abs(center.y - bounds.top) },
    { side: "right" as const, distance: Math.abs(center.x - bounds.right) },
    { side: "bottom" as const, distance: Math.abs(center.y - bounds.bottom) }
  ];
  distances.sort((left, right) => left.distance - right.distance);
  return distances[0]!.side;
}

/** Keep ELK/fallback coordinates in positive world space while preserving the
 * previous composition's minimum boundary.  The 18px floor is intentional:
 * `Math.max(18, previousMin)` prevents negative/zero anchors after repeated
 * operations and matches the reference implementation. */
export function anchorLayoutTargets(
  targets: Record<string, CanvasNodeGeometry>,
  previous: WorkflowCanvasLayout
): Record<string, CanvasNodeGeometry> {
  const targetValues = Object.values(targets);
  if (!targetValues.length) return targets;
  const previousValues = Object.values(previous.nodes);
  const previousMinX = previousValues.length ? Math.min(...previousValues.map((point) => point.x)) : 0;
  const previousMinY = previousValues.length ? Math.min(...previousValues.map((point) => point.y)) : 0;
  const targetMinX = Math.min(...targetValues.map((point) => point.x));
  const targetMinY = Math.min(...targetValues.map((point) => point.y));
  const offsetX = Math.max(18, previousMinX) - targetMinX;
  const offsetY = Math.max(18, previousMinY) - targetMinY;
  for (const point of targetValues) {
    point.x = Math.round(point.x + offsetX);
    point.y = Math.round(point.y + offsetY);
  }
  return targets;
}

/** Deterministic layered fallback used when the browser cannot load ELK. */
export function fallbackLayeredTargets(
  orchestration: CanvasOrchestrationShape,
  layout: WorkflowCanvasLayout,
  nodeSizes: Readonly<Record<string, CanvasSize>> = {}
): Record<string, CanvasNodeGeometry> {
  const ordered = stableLayoutNodes(orchestration, layout);
  const ids = new Set(ordered.map((node) => node.id));
  const graph = buildCanvasLayoutGraph(orchestration, layout);
  if (usesSparseBusinessGrid(orchestration, graph)) {
    return sparseBusinessGridTargets(orchestration, layout, nodeSizes, graph);
  }
  const edges = graph.layoutEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const componentByNode = new Map<string, number>();
  graph.components.forEach((component, componentIndex) => {
    component.forEach((id) => componentByNode.set(id, componentIndex));
  });
  const componentRank = new Map<number, number>();
  const inputComponent = componentByNode.get(CANVAS_INPUT_NODE_ID);
  if (inputComponent !== undefined) componentRank.set(inputComponent, 0);
  // The SCC condensation is acyclic, so stable relaxation cannot grow ranks
  // forever and a genuine Worker cycle stays together in one visual tier.
  for (let pass = 0; pass < graph.components.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const source = componentByNode.get(edge.source);
      const target = componentByNode.get(edge.target);
      if (source === undefined || target === undefined || source === target) continue;
      const next = (componentRank.get(source) ?? 0) + 1;
      if (next > (componentRank.get(target) ?? 0)) {
        componentRank.set(target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rank = new Map<string, number>(ordered.map((node) => [
    node.id,
    componentRank.get(componentByNode.get(node.id) ?? -1) ?? 0
  ]));
  const maxWorkerRank = Math.max(1, ...[...rank.entries()]
    .filter(([id]) => id !== CANVAS_FINISH_NODE_ID)
    .map(([, value]) => value));
  rank.set(CANVAS_FINISH_NODE_ID, maxWorkerRank + 1);
  const layers = new Map<number, string[]>();
  for (const node of ordered) {
    const layer = rank.get(node.id) ?? 0;
    const list = layers.get(layer) ?? [];
    list.push(node.id);
    layers.set(layer, list);
  }
  const authoredOrder = new Map(ordered.map((node, index) => [node.id, index]));
  for (const list of layers.values()) list.sort((left, right) => (
    (authoredOrder.get(left) ?? 0) - (authoredOrder.get(right) ?? 0)
    || left.localeCompare(right)
  ));
  const layerKeys = [...layers.keys()].sort((left, right) => left - right);
  const heights = new Map<number, number>();
  let maxHeight = 0;
  for (const key of layerKeys) {
    const height = (layers.get(key) ?? []).reduce((sum, id) => sum + canvasNodeSize(nodeSizes[id] ?? {}).height, 0)
      + Math.max(0, (layers.get(key)?.length ?? 0) - 1) * 62;
    heights.set(key, height);
    maxHeight = Math.max(maxHeight, height);
  }
  const targets: Record<string, CanvasNodeGeometry> = {};
  let cursorX = 0;
  for (const key of layerKeys) {
    const list = layers.get(key) ?? [];
    const width = Math.max(...list.map((id) => canvasNodeSize(nodeSizes[id] ?? {}).width));
    let cursorY = (maxHeight - (heights.get(key) ?? 0)) / 2;
    for (const id of list) {
      targets[id] = { x: cursorX, y: cursorY };
      cursorY += canvasNodeSize(nodeSizes[id] ?? {}).height + 62;
    }
    cursorX += width + 124;
  }
  dockIsolatedMain(targets, orchestration, layout, nodeSizes, graph);
  return anchorLayoutTargets(targets, layout);
}

function stronglyConnectedComponents(
  nodeIds: readonly string[],
  edges: readonly Pick<CanvasEdge, "source" | "target">[]
): string[][] {
  const order = new Map(nodeIds.map((id, index) => [id, index]));
  const adjacency = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)!.push(edge.target);
  }
  for (const targets of adjacency.values()) targets.sort((left, right) => (
    (order.get(left) ?? 0) - (order.get(right) ?? 0) || left.localeCompare(right)
  ));
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  let cursor = 0;
  const visit = (id: string) => {
    indices.set(id, cursor);
    lowLinks.set(id, cursor);
    cursor += 1;
    stack.push(id);
    stacked.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (stacked.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      stacked.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort((left, right) => (
      (order.get(left) ?? 0) - (order.get(right) ?? 0) || left.localeCompare(right)
    ));
    components.push(component);
  };
  for (const id of nodeIds) if (!indices.has(id)) visit(id);
  components.sort((left, right) => (
    Math.min(...left.map((id) => order.get(id) ?? 0))
    - Math.min(...right.map((id) => order.get(id) ?? 0))
  ));
  return components;
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("layout timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadElkLayoutEngine(): Promise<ElkLayoutEngine | undefined> {
  if (typeof window === "undefined") return undefined;
  if (window.ELK) return new window.ELK();
  if (!window.__openfarsElkPromise) {
    window.__openfarsElkPromise = new Promise((resolve) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-openfars-elk]');
      if (existing) {
        existing.addEventListener("load", () => resolve(window.ELK ? new window.ELK() : undefined), { once: true });
        existing.addEventListener("error", () => resolve(undefined), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "/vendor/elk.bundled.js";
      script.async = true;
      script.dataset.openfarsElk = "true";
      script.onload = () => resolve(window.ELK ? new window.ELK() : undefined);
      script.onerror = () => resolve(undefined);
      document.head.appendChild(script);
    });
  }
  return window.__openfarsElkPromise;
}

function isBlankWorkflow(orchestration: CanvasOrchestrationShape): boolean {
  const nodes = workflowOuterNodes(orchestration);
  return nodes.length === 1 && nodes[0]?.id === "main";
}

function canvasPort(value: unknown): WorkflowCanvasPort | undefined {
  return typeof value === "string" && CANVAS_PORTS.includes(value as WorkflowCanvasPort)
    ? value as WorkflowCanvasPort
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
