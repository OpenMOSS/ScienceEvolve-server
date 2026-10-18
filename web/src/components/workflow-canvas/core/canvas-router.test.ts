import { describe, expect, it } from "vitest";
import type { CanvasEdge, CanvasNode } from "./canvas-model";
import { buildLockedEdgeRoutes, buildLockedEdgeRoutesFromSnapshot, canvasPortPoint, captureRouteLock, polylineIntersectsRect, routeCanvasEdge, routeCanvasEdges } from "./canvas-router";

const nodes: CanvasNode[] = [
  { id: "input", kind: "input", name: "用户输入", x: 20, y: 200 },
  { id: "main", kind: "agent", name: "main", template: "main", x: 300, y: 200 },
  { id: "worker", kind: "agent", name: "worker", template: "general", x: 600, y: 200 },
  { id: "finish", kind: "finish", name: "完成", x: 900, y: 200 }
];
const edge = (id: string, source: string, target: string, fixed = false, systemRoute = false): CanvasEdge => ({
  id, source, target, kind: target === "finish" ? "termination" : "strong",
  sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true, fixed,
  ...(systemRoute ? { systemRoute: "main-dispatch" as const } : {})
});

describe("canvas router", () => {
  it("keeps initial routing of a thirteen-agent draft within an interactive work budget", () => {
    const workers: CanvasNode[] = Array.from({ length: 12 }, (_, index) => ({
      id: `worker_${String(index + 1).padStart(2, "0")}`, name: `worker_${index + 1}`, kind: "agent", template: "general",
      x: index < 9 ? 520 : 780, y: index < 9 ? 40 + index * 80 : 360 + (index - 9) * 180
    }));
    const graph: CanvasNode[] = [{ ...nodes[0]!, x: 20, y: 360 }, { ...nodes[1]!, x: 260, y: 360 },
      ...workers, { ...nodes[3]!, x: 980, y: 720 }];
    const edges: CanvasEdge[] = [edge("input->main", "input", "main", true),
      ...workers.map((worker, index) => ({ ...edge(`main->${worker.id}:${index}`, "main", worker.id, true, true),
        sourcePortPinned: false, targetPortPinned: false })),
      ...workers.map(worker => ({ ...edge(`${worker.id}->main`, worker.id, "main"), sourcePortPinned: false, targetPortPinned: false })),
      edge("worker_12->finish", "worker_12", "finish")];
    const started = performance.now();
    const routes = routeCanvasEdges(edges, graph);
    // Catch multi-second exhaustive scoring with ample CI scheduling margin.
    expect(performance.now() - started).toBeLessThan(2500);
    expect(new Set(routes.map(route => route.id))).toEqual(new Set(edges.map(edge => edge.id)));
    expect(routes.filter(route => route.kind === "main-dispatch")).toHaveLength(12);
    expect(routes.every(route => route.samples.length > 1 && Number.isFinite(route.midpoint.x))).toBe(true);
  });

  it("returns one shared path and midpoint for ordinary and Main edges", () => {
    const result = routeCanvasEdges([
      edge("input->main:0", "input", "main", true),
      edge("main->worker:0", "main", "worker", true, true),
      edge("worker->finish:0", "worker", "finish")
    ], nodes);
    expect(result).toHaveLength(3);
    for (const geometry of result) {
      expect(geometry.path).toMatch(/^M /);
      expect(geometry.path).toContain(" C ");
      expect(geometry.path).not.toContain(" Q ");
      expect(geometry.points.length).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(geometry.midpoint.x)).toBe(true);
      expect(Number.isFinite(geometry.midpoint.y)).toBe(true);
    }
    expect(result.find((item) => item.id === "main->worker:0")?.kind).toBe("main-dispatch");
  });

  it("keeps aligned routes straight and compresses obstacle detours to at most two cubics", () => {
    const geometry = routeCanvasEdges([
      edge("input->worker:0", "input", "worker"),
      edge("worker->finish:0", "worker", "finish")
    ], nodes);
    const detour = geometry.find((item) => item.id === "input->worker:0")!;
    const aligned = geometry.find((item) => item.id === "worker->finish:0")!;

    expect(detour.controlPoints?.length).toBeGreaterThanOrEqual(1);
    expect(detour.controlPoints?.length).toBeLessThanOrEqual(2);
    expect(polylineIntersectsRect(detour.samples, {
      left: 300,
      top: 200,
      right: 494,
      bottom: 292
    })).toBe(false);
    expect(aligned.controlPoints).toHaveLength(1);
    expect(aligned.samples.every((point) => Math.abs(point.y - aligned.samples[0]!.y) < .01)).toBe(true);
    expect(aligned.path.match(/ C /g)).toHaveLength(1);
  });

  it("keeps cubic samples and endpoints aligned during an elastic drag", () => {
    const edges = [edge("worker->finish:0", "worker", "finish")];
    const locked = captureRouteLock(routeCanvasEdges(edges, nodes), nodes);
    const movedNodes = nodes.map((node) => node.id === "worker" ? { ...node, x: 560, y: 340 } : node);
    const geometry = buildLockedEdgeRoutes(routeCanvasEdges(edges, movedNodes), locked, { nodes: movedNodes, draggedNodeId: "worker" })[0]!;
    expect(geometry.path.match(/ C /g)?.length).toBeGreaterThan(0);
    expect(geometry.samples[0]).toEqual(geometry.points[0]);
    expect(geometry.samples.at(-1)).toEqual(geometry.points.at(-1));
  });

  it("routes Main termination edges as editable ordinary geometry", () => {
    const termination = edge("main->finish:0", "main", "finish");
    const [geometry] = routeCanvasEdges([termination], nodes);
    expect(geometry).toMatchObject({
      id: "main->finish:0",
      kind: "termination",
      fixed: false,
      label: "结束"
    });
    expect(geometry?.path).toMatch(/^M /);
    expect(routeCanvasEdge(termination, nodes)).toMatchObject({ kind: "termination", fixed: false });
  });

  it("keeps route ordering deterministic and applies route locks", () => {
    const edges = [edge("worker->finish:1", "worker", "finish"), edge("worker->main:0", "worker", "main")];
    const first = routeCanvasEdges(edges, nodes).map((item) => item.id);
    const second = routeCanvasEdges([...edges].reverse(), nodes).map((item) => item.id);
    expect(second).toEqual(first);
    const locked = routeCanvasEdges([edges[0]!], nodes, { lockRoutes: true })[0]!;
    expect(locked.points).toHaveLength(2);
  });

  it("smooths a legacy multi-segment lock during a layout transition", () => {
    const edges = [edge("worker->finish:0", "worker", "finish")];
    const locked = captureRouteLock(routeCanvasEdges(edges, nodes), nodes);
    const legacy = locked[0]!;
    legacy.controlPoints = [
      { control1: { x: 650, y: 246 }, control2: { x: 690, y: 246 } },
      { control1: { x: 730, y: 246 }, control2: { x: 770, y: 246 } },
      { control1: { x: 810, y: 246 }, control2: { x: 850, y: 246 } }
    ];
    legacy.curveJoins = [{ x: 700, y: 246 }, { x: 780, y: 246 }];
    legacy.path = "M 794 246 C 650 246, 690 246, 700 246 C 730 246, 770 246, 780 246 C 810 246, 850 246, 900 246";

    const [smooth] = buildLockedEdgeRoutesFromSnapshot(locked, {
      nodes,
      smoothFallback: true
    });

    expect(smooth?.path).not.toBe(legacy.path);
    expect(smooth?.controlPoints?.length).toBeLessThanOrEqual(2);
    expect(smooth?.path.match(/ C /g)?.length).toBeLessThanOrEqual(2);
  });

  it("keeps unrelated routes stable while attached routes follow live endpoints", () => {
    const edges = [
      edge("input->main:0", "input", "main", true),
      edge("main->worker:0", "main", "worker", true, true),
      edge("worker->finish:0", "worker", "finish")
    ];
    const initialGeometry = routeCanvasEdges(edges, nodes);
    const locked = captureRouteLock(initialGeometry, nodes);
    const movedNodes = nodes.map((node) => node.id === "main" ? { ...node, x: 360, y: 280 } : node);
    const live = routeCanvasEdges(edges, movedNodes);
    const result = buildLockedEdgeRoutes(live, locked, { nodes: movedNodes, draggedNodeId: "main" });
    expect(result.find((item) => item.id === "input->main:0")?.points.at(-1)).toEqual(live.find((item) => item.id === "input->main:0")?.points.at(-1));
    expect(result.find((item) => item.id === "worker->finish:0")?.path).toBe(locked.find((item) => item.edgeId === "worker->finish:0")?.path);
    expect(result.find((item) => item.id === "main->worker:0")?.path).toBe(live.find((item) => item.id === "main->worker:0")?.path);
    expect(locked[0]).toMatchObject({
      edgeId: "input->main:0",
      sourceSide: "right",
      targetSide: "left",
      sourcePinned: true,
      targetPinned: true,
      startEndpoint: { source: initialGeometry[0]!.points[0] }
    });
  });

  it("uses measured card dimensions for anchors and obstacle clearance", () => {
    const measuredNodes = nodes.map((node) => node.id === "worker"
      ? { ...node, width: 240, height: 116 }
      : node);
    expect(canvasPortPoint(measuredNodes[2]!, "right")).toEqual({ x: 840, y: 258 });
    expect(canvasPortPoint(measuredNodes[2]!, "bottom")).toEqual({ x: 720, y: 316 });

    const geometry = routeCanvasEdge({
      ...edge("main->finish:0", "main", "finish"),
      sourcePort: "right",
      targetPort: "left"
    }, measuredNodes);
    expect(geometry?.points[0]).toEqual({ x: 494, y: 246 });
    expect(geometry?.points.at(-1)).toEqual({ x: 900, y: 246 });
  });

  it("keeps every edge kind attached through five continuous drag samples", () => {
    const branchNodes: CanvasNode[] = [
      ...nodes,
      { id: "review", kind: "agent", name: "review", template: "review", x: 600, y: 430 }
    ];
    const branchEdges: CanvasEdge[] = [
      edge("input->main:0", "input", "main", true),
      edge("main->worker:0", "main", "worker", true, true),
      { ...edge("worker->review:0", "worker", "review"), kind: "weak" },
      edge("worker->finish:1", "worker", "finish")
    ];
    const initial = routeCanvasEdges(branchEdges, branchNodes);
    const lock = captureRouteLock(initial, branchNodes);
    const stages = [
      { x: 600, y: 200 },
      { x: 540, y: 250 },
      { x: 480, y: 300 },
      { x: 420, y: 350 },
      { x: 360, y: 400 }
    ];

    for (const position of stages) {
      const currentNodes = branchNodes.map((node) => node.id === "worker" ? { ...node, ...position } : node);
      const live = routeCanvasEdges(branchEdges, currentNodes);
      const current = buildLockedEdgeRoutes(live, lock, { nodes: currentNodes, draggedNodeId: "worker" });
      for (const geometry of current.filter((item) => item.source === "worker" || item.target === "worker")) {
        const source = currentNodes.find((node) => node.id === geometry.source)!;
        const target = currentNodes.find((node) => node.id === geometry.target)!;
        if (geometry.kind === "main-dispatch") {
          expect(geometry.points[0], geometry.id + " shared source anchor").toEqual(canvasPortPoint(source, geometry.sourcePort));
          const targetPoint = geometry.points.at(-1)!;
          if (geometry.targetPort === "left" || geometry.targetPort === "right") {
            expect(targetPoint.x, geometry.id + " target side").toBe(target.x + (geometry.targetPort === "right" ? 194 : 0));
            expect(targetPoint.y, geometry.id + " target slot").toBeGreaterThan(target.y);
            expect(targetPoint.y, geometry.id + " target slot").toBeLessThan(target.y + 92);
          } else {
            expect(targetPoint.y, geometry.id + " target side").toBe(target.y + (geometry.targetPort === "bottom" ? 92 : 0));
            expect(targetPoint.x, geometry.id + " target slot").toBeGreaterThan(target.x);
            expect(targetPoint.x, geometry.id + " target slot").toBeLessThan(target.x + 194);
          }
        } else {
          expect(geometry.points[0], geometry.id + " source").toEqual(canvasPortPoint(source, geometry.sourcePort));
          expect(geometry.points.at(-1), geometry.id + " target").toEqual(canvasPortPoint(target, geometry.targetPort));
        }
        expect(geometry.samples[0]).toEqual(geometry.points[0]);
        expect(geometry.samples.at(-1)).toEqual(geometry.points.at(-1));
        expect(geometry.path).toContain(" C ");
        expect(geometry.controlPoints?.length, `${geometry.id} must expose cubic controls`).toBeGreaterThanOrEqual(1);
        expect(geometry.controlPoints?.length, `${geometry.id} must use at most two visible cubics`).toBeLessThanOrEqual(2);
      }
      expect(current.find((item) => item.id === "main->worker:0")?.kind).toBe("main-dispatch");
      expect(current.find((item) => item.id === "worker->review:0")?.kind).toBe("weak");
      expect(current.find((item) => item.id === "worker->finish:1")?.kind).toBe("termination");
    }
  });

  it("moves a captured Main dispatch slot with its target in snapshot-only updates", () => {
    const dispatchEdges = [edge("main->worker:0", "main", "worker", true, true)];
    const initial = routeCanvasEdges(dispatchEdges, nodes);
    const lock = captureRouteLock(initial, nodes);
    const movedNodes = nodes.map((node) => node.id === "worker"
      ? { ...node, x: 733.25, y: 341.5 }
      : node);
    const initialTarget = initial[0]!.points.at(-1)!;
    for (const draggedNodeId of ["worker", undefined]) {
      const [current] = buildLockedEdgeRoutesFromSnapshot(lock, {
        nodes: movedNodes,
        ...(draggedNodeId ? { draggedNodeId } : {})
      });
      const currentTarget = current!.points.at(-1)!;

      expect(Math.abs(currentTarget.x - (initialTarget.x + 133.25))).toBeLessThanOrEqual(.1);
      expect(Math.abs(currentTarget.y - (initialTarget.y + 141.5))).toBeLessThanOrEqual(.1);
      expect(current!.samples[0]).toEqual(current!.points[0]);
      expect(current!.samples.at(-1)).toEqual(currentTarget);
      expect(current!.path).not.toBe(initial[0]!.path);
    }
  });

  it("locally reroutes an attached elastic edge when a nearby card blocks it", () => {
    const dragNodes: CanvasNode[] = [
      { id: "worker", kind: "agent", name: "worker", template: "general", x: 220, y: 120 },
      { id: "review", kind: "agent", name: "review", template: "review", x: 760, y: 120 },
      { id: "blocker", kind: "agent", name: "blocker", template: "general", x: 500, y: 330 }
    ];
    const dragEdges: CanvasEdge[] = [
      { ...edge("worker->review:0", "worker", "review"), kind: "weak", sourcePortPinned: false, targetPortPinned: false }
    ];
    const initial = routeCanvasEdges(dragEdges, dragNodes);
    const lock = captureRouteLock(initial, dragNodes);
    const movedNodes = dragNodes.map((node) => node.id === "worker" ? { ...node, y: 360 } : node);
    const current = buildLockedEdgeRoutes(
      routeCanvasEdges(dragEdges, movedNodes),
      lock,
      { nodes: movedNodes, draggedNodeId: "worker" }
    );
    const route = current[0]!;
    const blocker = movedNodes.find((node) => node.id === "blocker")!;
    expect(polylineIntersectsRect(route.samples, {
      left: blocker.x - 22,
      top: blocker.y - 22,
      right: blocker.x + 194 + 22,
      bottom: blocker.y + 92 + 22
    })).toBe(false);
    expect(route.points[0]).toEqual(canvasPortPoint(movedNodes[0]!, route.sourcePort));
    expect(route.points.at(-1)).toEqual(canvasPortPoint(movedNodes[1]!, route.targetPort));
    expect(route.controlPoints?.length, "local detour should stay visually smooth").toBeLessThanOrEqual(2);
    expect(route.path.match(/ C /g)?.length, "local detour should use at most two curves").toBeLessThanOrEqual(2);
  });

  it("detects a card crossed between sparse sample vertices", () => {
    expect(polylineIntersectsRect(
      [{ x: 0, y: 50 }, { x: 200, y: 50 }],
      { left: 80, top: 20, right: 120, bottom: 80 }
    )).toBe(true);
    expect(polylineIntersectsRect(
      [{ x: 0, y: 20 }, { x: 200, y: 20 }],
      { left: 80, top: 20, right: 120, bottom: 80 }
    )).toBe(false);
  });

  it("keeps a close neighbour hard while relaxing clearance that contains an endpoint", () => {
    const closeNodes: CanvasNode[] = [
      { id: "input", kind: "input", name: "用户输入", x: 20, y: 260, width: 206, height: 100 },
      { id: "main", kind: "agent", name: "main", template: "main", x: 245, y: 260, width: 206, height: 100 },
      { id: "idea", kind: "agent", name: "idea", template: "idea", x: 490, y: 70, width: 206, height: 100 }
    ];
    const geometry = routeCanvasEdge(edge("input->idea:0", "input", "idea", true), closeNodes)!;

    expect(polylineIntersectsRect(geometry.samples, {
      left: 245,
      top: 260,
      right: 451,
      bottom: 360
    })).toBe(false);
    expect(geometry.points[0]).toEqual({ x: 226, y: 310 });
    expect(geometry.points.at(-1)).toEqual({ x: 490, y: 120 });
  });

  it("keeps a natural unpinned port when a compact local detour is clear", () => {
    const legacyNodes: CanvasNode[] = [
      { id: "input", kind: "input", name: "用户输入", x: 20, y: 260, width: 194, height: 92 },
      { id: "main", kind: "agent", name: "main", template: "main", x: 245, y: 260, width: 194, height: 92 },
      { id: "idea", kind: "agent", name: "idea", template: "idea", x: 490, y: 70, width: 194, height: 92 },
      { id: "execution", kind: "agent", name: "execution", template: "execution", x: 490, y: 260, width: 194, height: 92 },
      { id: "writing", kind: "agent", name: "writing", template: "writing", x: 735, y: 260, width: 194, height: 92 },
      { id: "review", kind: "agent", name: "review", template: "review", x: 490, y: 620, width: 194, height: 92 },
      { id: "finish", kind: "finish", name: "结束", x: 735, y: 620, width: 194, height: 92 }
    ];
    const legacyEdge: CanvasEdge = {
      ...edge("input->idea:0", "input", "idea", true),
      sourcePortPinned: false,
      targetPortPinned: false
    };
    const geometry = routeCanvasEdge(legacyEdge, legacyNodes)!;

    expect(geometry.sourcePort).toBe("right");
    expect(Math.min(...geometry.samples.map((point) => point.y))).toBeGreaterThanOrEqual(20);
    expect(Math.max(...geometry.samples.map((point) => point.y))).toBeLessThanOrEqual(352);
    expect(polylineIntersectsRect(geometry.samples, {
      left: 245,
      top: 260,
      right: 439,
      bottom: 352
    })).toBe(false);
  });

  it("keeps attached routes clear through a far drag beside tightly spaced cards", () => {
    const dragNodes: CanvasNode[] = [
      { id: "input", kind: "input", name: "用户输入", x: 20, y: 260, width: 206, height: 100 },
      { id: "main", kind: "agent", name: "main", template: "main", x: 245, y: 260, width: 206, height: 100 },
      { id: "idea", kind: "agent", name: "idea", template: "idea", x: 490, y: 70, width: 206, height: 100 },
      { id: "execution", kind: "agent", name: "execution", template: "execution", x: 490, y: 260, width: 206, height: 100 },
      { id: "writing", kind: "agent", name: "writing", template: "writing", x: 735, y: 260, width: 206, height: 100 },
      { id: "review", kind: "agent", name: "review", template: "review", x: 490, y: 620, width: 206, height: 100 },
      { id: "finish", kind: "finish", name: "结束", x: 735, y: 620, width: 206, height: 100 }
    ];
    const dragEdges: CanvasEdge[] = [
      edge("input->idea:0", "input", "idea", true),
      edge("idea->main:0", "idea", "main")
    ];
    const locked = captureRouteLock(routeCanvasEdges(dragEdges, dragNodes), dragNodes);
    const movedNodes = dragNodes.map((node) => node.id === "idea"
      ? { ...node, x: 647.37, y: 24.15 }
      : node);
    const routes = buildLockedEdgeRoutes(
      routeCanvasEdges(dragEdges, movedNodes),
      locked,
      { nodes: movedNodes, draggedNodeId: "idea" }
    );

    for (const route of routes) {
      for (const node of movedNodes) {
        if (node.id === route.source || node.id === route.target) continue;
        expect(polylineIntersectsRect(route.samples, {
          left: node.x,
          top: node.y,
          right: node.x + (node.width ?? 194),
          bottom: node.y + (node.height ?? 92)
        }), `${route.id} crossed ${node.id}`).toBe(false);
      }
    }
  });

  it("reroutes a Main dispatch rail only when the moving card blocks it", () => {
    const dispatchNodes = [
      { ...nodes[1]!, x: 20, y: 200 },
      { ...nodes[2]!, x: 800, y: 200 },
      { ...nodes[3]!, id: "blocker", kind: "agent" as const, x: 410, y: 420 }
    ];
    const dispatchEdges = [edge("main->worker:0", "main", "worker", true, true)];
    const original = routeCanvasEdges(dispatchEdges, dispatchNodes);
    const lock = captureRouteLock(original, dispatchNodes);
    for (const y of [390, 280, 200, 120]) {
      const moved = dispatchNodes.map((node) => node.id === "blocker" ? { ...node, y } : node);
      const current = buildLockedEdgeRoutes(routeCanvasEdges(dispatchEdges, moved), lock, { nodes: moved, draggedNodeId: "blocker" })[0]!;
      expect(polylineIntersectsRect(current.samples, { left: 410, right: 604, top: y, bottom: y + 92 })).toBe(false);
      if (!current.reroutedBecauseBlocked) expect(current.path).toBe(original[0]!.path);
      expect(current.sourcePort).toBe("right");
      expect(current.targetPort).toBe("left");
    }
  });

  it("uses a local corridor when a dragged card blocks a Main target approach", () => {
    const dispatchNodes: CanvasNode[] = [
      { id: "input", kind: "input", name: "用户输入", x: 20, y: 260, width: 206, height: 100 },
      { id: "main", kind: "agent", name: "main", template: "main", x: 245, y: 260, width: 206, height: 100 },
      { id: "idea", kind: "agent", name: "idea", template: "idea", x: 490, y: 70, width: 206, height: 100 },
      { id: "execution", kind: "agent", name: "execution", template: "execution", x: 490, y: 260, width: 206, height: 100 },
      { id: "writing", kind: "agent", name: "writing", template: "writing", x: 735, y: 260, width: 206, height: 100 },
      { id: "review", kind: "agent", name: "review", template: "review", x: 490, y: 620, width: 206, height: 100 },
      { id: "finish", kind: "finish", name: "结束", x: 735, y: 620, width: 206, height: 100 }
    ];
    const dispatchEdges: CanvasEdge[] = [
      edge("main->idea:0", "main", "idea", true, true),
      edge("main->execution:1", "main", "execution", true, true),
      edge("main->writing:2", "main", "writing", true, true),
      edge("main->review:3", "main", "review", true, true)
    ];
    const lock = captureRouteLock(routeCanvasEdges(dispatchEdges, dispatchNodes), dispatchNodes);
    const positions = [
      { x: 547.1188679245283, y: 330.68032345013477 },
      { x: 612.9521563342319, y: 342.8376010781671 },
      { x: 677.1281671159029, y: 354.4823450134771 }
    ];

    for (const position of positions) {
      const moved = dispatchNodes.map((node) => node.id === "idea" ? { ...node, ...position } : node);
      const current = buildLockedEdgeRoutes(
        routeCanvasEdges(dispatchEdges, moved),
        lock,
        { nodes: moved, draggedNodeId: "idea" }
      );
      const writingRoute = current.find((item) => item.id === "main->writing:2")!;
      expect(writingRoute.reroutedBecauseBlocked).toBe(true);
      for (const node of moved) {
        if (node.id === writingRoute.source || node.id === writingRoute.target) continue;
        expect(polylineIntersectsRect(writingRoute.samples, {
          left: node.x,
          top: node.y,
          right: node.x + (node.width ?? 194),
          bottom: node.y + (node.height ?? 92)
        }), `${writingRoute.id} crossed ${node.id} at ${position.x},${position.y}`).toBe(false);
      }
    }
  });

  it("keeps the snapshot-only drag router clear around fractional obstacle positions", () => {
    const dispatchNodes: CanvasNode[] = [
      { id: "main", kind: "agent", name: "main", template: "main", x: 245, y: 260, width: 206, height: 100 },
      { id: "idea", kind: "agent", name: "idea", template: "idea", x: 490, y: 70, width: 206, height: 100 },
      { id: "execution", kind: "agent", name: "execution", template: "execution", x: 490, y: 260, width: 206, height: 100 },
      { id: "writing", kind: "agent", name: "writing", template: "writing", x: 735, y: 260, width: 206, height: 100 },
      { id: "review", kind: "agent", name: "review", template: "review", x: 490, y: 620, width: 206, height: 100 },
      { id: "finish", kind: "finish", name: "结束", x: 735, y: 620, width: 206, height: 100 }
    ];
    const dispatchEdges: CanvasEdge[] = [
      edge("main->idea:0", "main", "idea", true, true),
      edge("main->execution:1", "main", "execution", true, true),
      edge("main->writing:2", "main", "writing", true, true),
      edge("main->review:3", "main", "review", true, true)
    ];
    const lock = captureRouteLock(routeCanvasEdges(dispatchEdges, dispatchNodes), dispatchNodes);
    const moved = dispatchNodes.map((node) => node.id === "execution"
      ? { ...node, x: 406.6666666667, y: 371.1111111111 }
      : node);
    const current = buildLockedEdgeRoutesFromSnapshot(lock, {
      nodes: moved,
      draggedNodeId: "execution"
    });
    const reviewRoute = current.find((item) => item.id === "main->review:3")!;

    expect(reviewRoute.reroutedBecauseBlocked).toBe(true);
    expect(reviewRoute.controlPoints?.length, "snapshot reroute should avoid a rigid multi-segment chain").toBeLessThanOrEqual(2);
    expect(reviewRoute.path.match(/ C /g)?.length, "snapshot reroute should use at most two curves").toBeLessThanOrEqual(2);
    for (const node of moved) {
      if (node.id === reviewRoute.source || node.id === reviewRoute.target) continue;
      expect(polylineIntersectsRect(reviewRoute.samples, {
        left: node.x,
        top: node.y,
        right: node.x + (node.width ?? 194),
        bottom: node.y + (node.height ?? 92)
      }), `${reviewRoute.id} crossed ${node.id}`).toBe(false);
    }
  });

  it("shares one Main dispatch anchor while worker-to-Main edges remain ordinary", () => {
    const hubNodes: CanvasNode[] = [
      { id: "main", kind: "agent", name: "main", template: "main", x: 220, y: 260 },
      { id: "worker_1", kind: "agent", name: "worker_1", template: "general", x: 560, y: 80 },
      { id: "worker_2", kind: "agent", name: "worker_2", template: "general", x: 850, y: 80 },
      { id: "worker_3", kind: "agent", name: "worker_3", template: "general", x: 560, y: 430 },
      { id: "worker_4", kind: "agent", name: "worker_4", template: "general", x: 850, y: 430 }
    ];
    const hubEdges = hubNodes.slice(1).flatMap((worker, index) => [
      edge(`main->${worker.id}:${index}`, "main", worker.id, true, true),
      { ...edge(`${worker.id}->main:0`, worker.id, "main"), sourcePortPinned: false, targetPortPinned: false }
    ]);
    const first = routeCanvasEdges(hubEdges, hubNodes);
    const second = routeCanvasEdges([...hubEdges].reverse(), hubNodes);
    const dispatch = first.filter((item) => item.kind === "main-dispatch");
    const returns = first.filter((item) => item.target === "main");
    const dispatchSlots = dispatch.map((item) => item.points[0]!.y);
    const returnSlots = returns.map((item) => item.points.at(-1)!.y);

    expect(new Set(dispatchSlots).size).toBe(1);
    expect(dispatch.every((item) => item.sourcePort === dispatch[0]!.sourcePort)).toBe(true);
    expect(returns.every((item) => item.kind === "strong" && item.fixed !== true)).toBe(true);
    expect(returnSlots.every(Number.isFinite)).toBe(true);
    expect(new Set(first.map((item) => item.path)).size).toBe(first.length);
    expect(second.map((item) => [item.id, item.path])).toEqual(first.map((item) => [item.id, item.path]));
  });

  it("keeps rendered Main return curves near their compact routing corridors", () => {
    const hubNodes: CanvasNode[] = [
      { id: "main", kind: "agent", name: "main", template: "main", x: 330, y: 155, width: 206, height: 100 },
      { id: "idea", kind: "agent", name: "idea", template: "idea", x: 668, y: 70, width: 206, height: 100 },
      { id: "execution", kind: "agent", name: "execution", template: "execution", x: 982, y: 70, width: 206, height: 100 },
      { id: "writing", kind: "agent", name: "writing", template: "writing", x: 668, y: 240, width: 206, height: 100 },
      { id: "review", kind: "agent", name: "review", template: "review", x: 982, y: 240, width: 206, height: 100 }
    ];
    const returns = hubNodes.slice(1).map((worker) => ({
      ...edge(`${worker.id}->main:0`, worker.id, "main"),
      sourcePortPinned: false,
      targetPortPinned: false
    }));
    const geometry = routeCanvasEdges(returns, hubNodes);

    for (const route of geometry) {
      const plannedMinX = Math.min(...route.points.map((point) => point.x));
      const plannedMinY = Math.min(...route.points.map((point) => point.y));
      const plannedMaxX = Math.max(...route.points.map((point) => point.x));
      const plannedMaxY = Math.max(...route.points.map((point) => point.y));
      expect(Math.min(...route.samples.map((point) => point.x)), `${route.id} left excursion`).toBeGreaterThanOrEqual(plannedMinX - 36);
      expect(Math.min(...route.samples.map((point) => point.y)), `${route.id} top excursion`).toBeGreaterThanOrEqual(plannedMinY - 36);
      expect(Math.max(...route.samples.map((point) => point.x)), `${route.id} right excursion`).toBeLessThanOrEqual(plannedMaxX + 36);
      expect(Math.max(...route.samples.map((point) => point.y)), `${route.id} bottom excursion`).toBeLessThanOrEqual(plannedMaxY + 36);
    }
  });

  it("preserves explicit user ports on a Worker return to Main", () => {
    const returnNodes: CanvasNode[] = [
      { id: "main", kind: "agent", name: "main", template: "main", x: 220, y: 260 },
      { id: "worker", kind: "agent", name: "worker", template: "general", x: 620, y: 90 }
    ];
    const pinned: CanvasEdge = {
      ...edge("worker->main:0", "worker", "main"),
      sourcePort: "top",
      targetPort: "bottom"
    };
    const geometry = routeCanvasEdge(pinned, returnNodes)!;

    expect(geometry.sourcePort).toBe("top");
    expect(geometry.targetPort).toBe("bottom");
    expect(geometry.points[0]).toEqual(canvasPortPoint(returnNodes[1]!, "top"));
    expect(geometry.points.at(-1)).toEqual(canvasPortPoint(returnNodes[0]!, "bottom"));
  });

  it("keeps dense hub corridors local instead of escaping around the whole graph", () => {
    const denseNodes: CanvasNode[] = [
      { id: "main", kind: "agent", name: "main", template: "main", x: 318, y: 310 },
      ...Array.from({ length: 10 }, (_, index): CanvasNode => ({
        id: `worker_${index + 1}`,
        kind: "agent",
        name: `worker_${index + 1}`,
        template: "general",
        x: 644 + (index % 3) * 302,
        y: 70 + Math.floor(index / 3) * 160
      }))
    ];
    const denseEdges: CanvasEdge[] = [
      ...denseNodes.slice(1, 5).map((worker, index) => edge(`main->${worker.id}:${index}`, "main", worker.id, true, true)),
      ...denseNodes.slice(1).map((worker) => ({
        ...edge(`${worker.id}->main:0`, worker.id, "main"),
        sourcePortPinned: false,
        targetPortPinned: false
      }))
    ];
    const routes = routeCanvasEdges(denseEdges, denseNodes);
    const longDispatch = routes.find((route) => route.id === "main->worker_3:2")!;
    const allSamples = routes.flatMap((route) => route.samples);

    expect(Math.min(...longDispatch.samples.map((point) => point.y))).toBeGreaterThanOrEqual(60);
    const nodeTop = Math.min(...denseNodes.map((node) => node.y));
    const nodeBottom = Math.max(...denseNodes.map((node) => node.y + (node.height ?? 92)));
    expect(Math.min(...allSamples.map((point) => point.y))).toBeGreaterThanOrEqual(nodeTop - 80);
    expect(Math.max(...allSamples.map((point) => point.y))).toBeLessThanOrEqual(nodeBottom + 80);
  });
});
