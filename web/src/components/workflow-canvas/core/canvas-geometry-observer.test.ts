import { describe, expect, it } from "vitest";
import type { CanvasEdge, CanvasNode } from "./canvas-model";
import { geometryObservationFileName, observeCanvasGeometryFrame } from "./canvas-geometry-observer";
import { buildLockedEdgeRoutes, captureRouteLock, routeCanvasEdges } from "./canvas-router";

const nodes: CanvasNode[] = [
  { id: "input", kind: "input", name: "input", x: 20, y: 200 },
  { id: "worker", kind: "agent", name: "worker", x: 360, y: 200 },
  { id: "finish", kind: "finish", name: "finish", x: 700, y: 200 }
];
const edges: CanvasEdge[] = [
  { id: "input->worker:0", source: "input", target: "worker", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true, fixed: false },
  { id: "worker->finish:0", source: "worker", target: "finish", kind: "termination", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true, fixed: false }
];

describe("canvas geometry observations", () => {
  it("records exact endpoint, midpoint, sample and collision evidence", () => {
    const frame = observeCanvasGeometryFrame({
      phase: "50pct",
      nodes,
      geometry: routeCanvasEdges(edges, nodes),
      draggedNodeId: "worker"
    });

    expect(frame.edges).toHaveLength(2);
    expect(frame.edges.every((edge) => edge.sourceEndpointDistance === 0)).toBe(true);
    expect(frame.edges.every((edge) => edge.targetEndpointDistance === 0)).toBe(true);
    expect(frame.edges.every((edge) => edge.samples.length > 2)).toBe(true);
    expect(frame.edges.every((edge) => edge.midpointSampleDistance < 1)).toBe(true);
    expect(frame.edges.every((edge) => edge.nodeIntersections.length === 0)).toBe(true);
    expect(frame.valid).toBe(true);
  });

  it("flags an unrelated route change between drag frames", () => {
    const start = observeCanvasGeometryFrame({ phase: "start", nodes, geometry: routeCanvasEdges(edges, nodes), draggedNodeId: "input" });
    const changed = routeCanvasEdges(edges, nodes).map((edge) => edge.id === "worker->finish:0" ? { ...edge, path: `${edge.path} ` } : edge);
    const next = observeCanvasGeometryFrame({ phase: "25pct", nodes, geometry: changed, draggedNodeId: "input", previous: start });

    expect(next.edges.find((edge) => edge.edgeId === "worker->finish:0")?.unrelatedRouteChanged).toBe(true);
    expect(next.valid).toBe(false);
  });

  it("finds a node crossed by a long segment even when neither sample is inside", () => {
    const direct: CanvasEdge = { ...edges[0]!, id: "input->finish:0", target: "finish", kind: "termination" };
    const directGeometry = routeCanvasEdges([direct], nodes)[0]!;
    const start = directGeometry.points[0]!;
    const end = directGeometry.points.at(-1)!;
    const crossing = {
      ...directGeometry,
      points: [start, end],
      samples: [start, end],
      midpoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    };
    const frame = observeCanvasGeometryFrame({ phase: "50pct", nodes, geometry: [crossing] });

    expect(frame.edges[0]?.nodeIntersections).toEqual(["worker"]);
    expect(frame.valid).toBe(false);
  });

  it("accepts an unrelated route changed only because the dragged card blocks it", () => {
    const initialNodes = nodes.map((node) => node.id === "worker" ? { ...node, y: 420 } : node);
    const directEdge: CanvasEdge = { ...edges[0]!, id: "input->finish:0", target: "finish", kind: "termination" };
    const initialGeometry = routeCanvasEdges([directEdge], initialNodes);
    const initial = observeCanvasGeometryFrame({
      phase: "start",
      nodes: initialNodes,
      geometry: initialGeometry,
      draggedNodeId: "worker"
    });
    const movedNodes = initialNodes.map((node) => node.id === "worker" ? { ...node, y: 200 } : node);
    const rerouted = buildLockedEdgeRoutes(
      routeCanvasEdges([directEdge], movedNodes),
      captureRouteLock(initialGeometry, initialNodes),
      { nodes: movedNodes, draggedNodeId: "worker" }
    );
    const next = observeCanvasGeometryFrame({
      phase: "50pct",
      nodes: movedNodes,
      geometry: rerouted,
      draggedNodeId: "worker",
      previous: initial
    });

    expect(next.edges[0]?.reroutedBecauseBlocked).toBe(true);
    expect(next.edges[0]?.unrelatedRouteChanged).toBe(false);
    expect(next.edges[0]?.nodeIntersections).toEqual([]);
    expect(next.valid).toBe(true);
  });

  it("uses viewport and phase in deterministic evidence names", () => {
    expect(geometryObservationFileName("Drag Node", "75pct", { width: 1440, height: 1000 })).toBe("drag-node-75pct-1440x1000.json");
  });
});
