import { describe, expect, it } from "vitest";
import type { ScopedWorkflow } from "../../../types";
import { buildCanvasLayoutGraph, canvasEdgeId, normalizeCanvasLayout } from "./canvas-layout";
import { buildCanvasLayoutPlan } from "./canvas-layout-plan";
import { scopedCanvasPlanningOrchestration } from "./scoped-canvas-layout";
import { cloneAgentOrchestration } from "../../../lib";

function workflow(): ScopedWorkflow {
  return {
    nodes: ["a", "b", "c"].map((agentId) => ({ kind: "agent" as const, nodeId: agentId, agentId })),
    input: { source: "input", edges: ["a", "b"].map((target) => ({ target, kind: "parallel" as const })) },
    routes: {
      a: [{ target: "finish", kind: "strong" }],
      b: [{ target: "c", kind: "weak" }, { target: "finish", kind: "weak" }],
      c: [{ target: "finish", kind: "strong" }]
    },
    canvas: {
      schemaVersion: 1,
      nodes: { input: { x: 40, y: 100 }, a: { x: 260, y: 100 }, b: { x: 260, y: 100 }, c: { x: 500, y: 100 }, finish: { x: 800, y: 100 } },
      edges: { [canvasEdgeId("b", "finish")]: { sourcePort: "bottom", targetPort: "left", sourcePortPinned: true, targetPortPinned: false } },
      viewport: { x: 0, y: 0, zoom: 1 },
      layoutMode: "free"
    }
  };
}

describe("scoped canvas shared layout planning", () => {
  it("reflows a long vertical route into readable rows and preserves pinned ports", async () => {
    const workers = Array.from({ length: 14 }, (_, index) => `worker-${index}`);
    const orchestration = cloneAgentOrchestration();
    orchestration.agents = [{ name: "main", template: "main" }, ...workers.map(name => ({ name, template: "general" as const }))];
    orchestration.input.target = workers[0]!;
    orchestration.termination.agent = workers.at(-1)!;
    orchestration.routes = Object.fromEntries(workers.map((id, index) => [id, [
      { target: workers[index + 1] ?? "finish", kind: index === 3 || index === 8 ? "weak" as const : "strong" as const }
    ]]));
    const layout = normalizeCanvasLayout(undefined, orchestration);
    workers.forEach((id, index) => {
      const row = Math.floor(index / 4);
      const column = row % 2 ? 3 - index % 4 : index % 4;
      layout.nodes[id] = { x: 80 + column * 280, y: 80 + row * 175 };
    });
    layout.viewport.zoom = .29;
    const edge = canvasEdgeId(workers[0]!, workers[1]!);
    layout.edges[edge] = { ...layout.edges[edge]!, sourcePort: "bottom", sourcePortPinned: true };
    const plan = await buildCanvasLayoutPlan({ kind: "tidy", orchestration, layout, viewportSize: { width: 1440, height: 720 } });
    expect(new Set(workers.map(id => plan.layout.nodes[id]!.x)).size).toBeGreaterThanOrEqual(4);
    const ordered = ["input", ...workers, "finish"].map(id => plan.layout.nodes[id]!);
    expect(ordered.slice(1).every((point, index) => point.y > ordered[index]!.y ||
      point.y === ordered[index]!.y && point.x > ordered[index]!.x)).toBe(true);
    expect(plan.layout.nodes[workers[4]!]!.y).toBeGreaterThan(plan.layout.nodes[workers[3]!]!.y);
    expect(plan.layout.nodes[workers[9]!]!.y).toBeGreaterThan(plan.layout.nodes[workers[8]!]!.y);
    expect(plan.finalViewport.zoom).toBeGreaterThan(.6);
    expect(plan.finalReport.stats.nodeOverlaps).toBe(0);
    expect(plan.layout.edges[edge]).toMatchObject({ sourcePort: "bottom", sourcePortPinned: true });
    expect(buildCanvasLayoutGraph(orchestration, plan.layout).layoutEdges.map(item => item.id))
      .toEqual(buildCanvasLayoutGraph(orchestration, layout).layoutEdges.map(item => item.id));
  });

  it("keeps all parallel Input edges and stable scoped route identities", () => {
    const scoped = workflow();
    const projected = scopedCanvasPlanningOrchestration(scoped);
    const layout = normalizeCanvasLayout(scoped.canvas, projected);
    const graph = buildCanvasLayoutGraph(projected, layout);

    expect(graph.mode).toBe("directed");
    expect(graph.renderEdges.filter((edge) => edge.source === "input").map((edge) => [edge.id, edge.kind])).toEqual([
      [canvasEdgeId("input", "a"), "parallel"],
      [canvasEdgeId("input", "b"), "parallel"]
    ]);
    expect(graph.renderEdges.map((edge) => edge.id)).toContain(canvasEdgeId("b", "finish"));
    expect(graph.renderEdges.map((edge) => edge.id)).not.toContain(canvasEdgeId("b", "finish", 1));
    expect(layout.edges[canvasEdgeId("b", "finish")]?.sourcePortPinned).toBe(true);
    expect(graph.renderEdges.filter((edge) => edge.target === "finish")).toHaveLength(3);
  });

  it("uses the shared planner without changing group routes or parallel fan-out", async () => {
    const scoped = workflow();
    const before = structuredClone(scoped);
    const projected = scopedCanvasPlanningOrchestration(scoped);
    const plan = await buildCanvasLayoutPlan({
      kind: "tidy", orchestration: projected, layout: scoped.canvas,
      viewportSize: { width: 900, height: 600 }
    });

    expect(scoped).toEqual(before);
    expect(plan.layout.nodes).toHaveProperty("a");
    expect(plan.layout.nodes).toHaveProperty("b");
    expect(plan.layout.edges).toHaveProperty(canvasEdgeId("input", "a"));
    expect(plan.layout.edges).toHaveProperty(canvasEdgeId("input", "b"));
    expect(plan.layout.edges).toHaveProperty(canvasEdgeId("b", "finish"));
    expect(plan.layout.edges).not.toHaveProperty(canvasEdgeId("b", "finish", 1));
    expect(plan.finalReport.stats.nodeOverlaps).toBeLessThanOrEqual(plan.initialReport.stats.nodeOverlaps);
  });
});
