import { describe, expect, it } from "vitest";
import type { AgentOrchestrationTemplate } from "../../../types";
import { CANVAS_NODE_HEIGHT, CANVAS_NODE_WIDTH } from "./canvas-model";
import {
  anchorLayoutTargets,
  buildCanvasLayoutGraph,
  businessWorkflowEdges,
  canvasEdgeId,
  createDefaultCanvasLayout,
  fallbackLayeredTargets,
  layeredCanvasLayoutWithMeta,
  mainDispatchLayoutTargets,
  normalizeCanvasLayout,
  withCanvasLayout
} from "./canvas-layout";

const workflow: AgentOrchestrationTemplate = {
  agents: [
    { name: "main", template: "main" },
    { name: "writer", template: "writing" },
    { name: "critic", template: "review" }
  ],
  input: { source: "input", target: "writer" },
  routes: {
    main: [{ target: "writer", kind: "weak" }],
    writer: [{ target: "critic", kind: "strong" }],
    critic: [{ target: "finish", kind: "weak" }]
  },
  decisionPlans: {},
  allowUserIntervention: true,
  termination: { agent: "critic", condition: "done", decisionBy: "main", automatic: false }
};

function mainDispatchWorkflow(workerCount: number): AgentOrchestrationTemplate {
  const workers = Array.from({ length: workerCount }, (_, index) => `worker_${index + 1}`);
  const terminal = workers.at(-1) ?? "main";
  return {
    agents: [
      { name: "main", template: "main" },
      ...workers.map((name) => ({ name, template: "general" as const }))
    ],
    input: { source: "input", target: workers[0] ?? "main" },
    routes: {
      main: workers.map((target) => ({ target, kind: "weak" as const })),
      ...Object.fromEntries(workers.map((name) => [
        name,
        name === terminal ? [{ target: "finish", kind: "weak" as const }] : []
      ]))
    },
    decisionPlans: {},
    allowUserIntervention: true,
    termination: { agent: terminal, condition: "done", decisionBy: "main", automatic: false }
  };
}

describe("canvas layout", () => {
  it("uses semantic template slots in the reference composition", () => {
    const layout = createDefaultCanvasLayout(workflow);
    expect(layout.nodes.input).toEqual({ x: 20, y: 260 });
    expect(layout.nodes.writer).toEqual({ x: 735, y: 260 });
    expect(layout.nodes.critic).toEqual({ x: 490, y: 620 });
    expect(layout.viewport).toEqual({ x: 0, y: 0, zoom: 0.82 });
  });

  it("drops stale presentation keys and preserves valid unpinned ports", () => {
    const fallback = createDefaultCanvasLayout(workflow);
    const edgeId = canvasEdgeId("writer", "critic");
    const normalized = normalizeCanvasLayout({
      ...fallback,
      nodes: { ...fallback.nodes, removed: { x: 1, y: 2 }, writer: { x: Infinity, y: 12 } },
      edges: {
        ...fallback.edges,
        "removed->critic:0": fallback.edges[edgeId],
        [edgeId]: {
          sourcePort: "bottom",
          targetPort: "top",
          sourcePortPinned: false,
          targetPortPinned: false
        }
      },
      viewport: { x: 99_999, y: -99_999, zoom: 99 }
    }, workflow);

    expect(normalized.nodes).not.toHaveProperty("removed");
    expect(normalized.nodes.writer).toEqual(fallback.nodes.writer);
    expect(normalized.edges).not.toHaveProperty("removed->critic:0");
    expect(normalized.edges[edgeId]).toMatchObject({
      sourcePort: "bottom",
      targetPort: "top",
      sourcePortPinned: false,
      targetPortPinned: false
    });
    expect(normalized.viewport).toEqual({ x: 20_000, y: -20_000, zoom: 2.4 });
  });

  it("keeps runtime-only zoom values inside the persisted OpenFARS schema", () => {
    expect(normalizeCanvasLayout({
      nodes: {},
      edges: {},
      viewport: { x: 0, y: 0, zoom: 0.08 }
    }, workflow).viewport.zoom).toBe(0.08);

    const next = withCanvasLayout(workflow, { viewport: { x: 11, y: 22, zoom: 1 } });
    expect(next).not.toBe(workflow);
    expect(next.routes).toEqual(workflow.routes);
    expect(next.termination).toEqual(workflow.termination);
    expect(next.canvas?.viewport).toEqual({ x: 11, y: 22, zoom: 1 });
  });

  it("uses a wide topology layout for larger workflows without changing routes", () => {
    const large: AgentOrchestrationTemplate = {
      ...workflow,
      agents: [
        { name: "main", template: "main" },
        { name: "planner", template: "general" },
        { name: "research", template: "general" },
        { name: "experiment", template: "general" },
        { name: "analysis", template: "general" },
        { name: "writing", template: "writing" },
        { name: "review", template: "review" },
        { name: "validator", template: "general" }
      ],
      input: { source: "input", target: "planner" },
      routes: {
        main: [
          { target: "planner", kind: "weak" },
          { target: "research", kind: "weak" },
          { target: "experiment", kind: "weak" },
          { target: "analysis", kind: "weak" },
          { target: "writing", kind: "weak" },
          { target: "review", kind: "weak" },
          { target: "validator", kind: "weak" }
        ],
        planner: [
          { target: "research", kind: "weak" },
          { target: "experiment", kind: "weak" }
        ],
        research: [{ target: "analysis", kind: "strong" }],
        experiment: [{ target: "analysis", kind: "strong" }],
        analysis: [
          { target: "writing", kind: "weak" },
          { target: "review", kind: "weak" }
        ],
        writing: [{ target: "validator", kind: "strong" }],
        review: [{ target: "validator", kind: "strong" }],
        validator: [{ target: "finish", kind: "weak" }]
      },
      termination: { agent: "validator", condition: "done", decisionBy: "main", automatic: false }
    };
    const originalRoutes = structuredClone(large.routes);
    const layout = createDefaultCanvasLayout(large);
    expect(layout.nodes.input).toEqual({ x: 20, y: 270 });
    expect(layout.nodes.main).toEqual({ x: 260, y: 270 });
    expect(layout.nodes.planner).toEqual({ x: 500, y: 270 });
    expect(layout.nodes.research).toEqual({ x: 760, y: 90 });
    expect(layout.nodes.experiment).toEqual({ x: 760, y: 450 });
    expect(layout.nodes.analysis).toEqual({ x: 990, y: 270 });
    expect(layout.nodes.writing).toEqual({ x: 1220, y: 90 });
    expect(layout.nodes.review).toEqual({ x: 1220, y: 450 });
    expect(layout.nodes.validator).toEqual({ x: 1460, y: 270 });
    expect(layout.nodes.finish).toEqual({ x: 1720, y: 270 });
    expect(layout.edges).toHaveProperty(canvasEdgeId("validator", "finish"));
    expect(large.routes).toEqual(originalRoutes);
  });

  it("materializes one shared semantic edge set, including missing legacy presentation records", () => {
    const legacy = structuredClone(workflow);
    const layout = normalizeCanvasLayout(undefined, legacy);
    delete layout.edges[canvasEdgeId("writer", "critic")];
    const edges = businessWorkflowEdges(legacy, layout);
    expect(edges.map((edge) => edge.id)).toEqual([
      canvasEdgeId("input", "writer"),
      canvasEdgeId("main", "writer"),
      canvasEdgeId("writer", "critic"),
      canvasEdgeId("critic", "finish")
    ]);
    expect(edges.find((edge) => edge.id === canvasEdgeId("main", "writer"))).toMatchObject({
      fixed: true,
      systemRoute: "main-dispatch"
    });
    expect(edges.find((edge) => edge.id === canvasEdgeId("writer", "critic"))).toMatchObject({
      sourcePortPinned: false,
      targetPortPinned: false
    });
  });

  it("anchors ELK and deterministic fallback targets at the positive reference boundary", () => {
    const layout = normalizeCanvasLayout(undefined, workflow);
    const targets = {
      input: { x: -120, y: -80 },
      main: { x: -20, y: 10 },
      writer: { x: 140, y: -60 },
      critic: { x: 290, y: 30 },
      finish: { x: 420, y: -10 }
    };
    anchorLayoutTargets(targets, layout);
    expect(Math.min(...Object.values(targets).map((point) => point.x))).toBeGreaterThanOrEqual(18);
    expect(Math.min(...Object.values(targets).map((point) => point.y))).toBeGreaterThanOrEqual(18);

    const first = fallbackLayeredTargets(workflow, layout);
    const second = fallbackLayeredTargets(workflow, layout);
    expect(first).toEqual(second);
    expect(Math.min(...Object.values(first).map((point) => point.x))).toBeGreaterThanOrEqual(18);
    expect(Math.min(...Object.values(first).map((point) => point.y))).toBeGreaterThanOrEqual(18);
  });

  it("uses a deterministic fallback when ELK returns incomplete children", async () => {
    const originalElk = window.ELK;
    const originalPromise = window.__openfarsElkPromise;
    class IncompleteElk {
      async layout() {
        return { children: [{ id: "main", x: 0, y: 0 }] };
      }
    }
    window.ELK = IncompleteElk;
    window.__openfarsElkPromise = undefined;
    try {
      const result = await layeredCanvasLayoutWithMeta(workflow, normalizeCanvasLayout(undefined, workflow));
      expect(result.usedFallback).toBe(true);
      expect(result.reason).toContain("children");
      expect(Object.keys(result.elkTargets)).toEqual(expect.arrayContaining(["input", "main", "writer", "critic", "finish"]));
    } finally {
      window.ELK = originalElk;
      window.__openfarsElkPromise = originalPromise;
    }
  });

  it.each([1, 4, 10, 25, 50])("packs %i Main-dispatched workers stably and docks isolated Main outside them", (workerCount) => {
    const orchestration = mainDispatchWorkflow(workerCount);
    const layout = normalizeCanvasLayout(undefined, orchestration);
    const graph = buildCanvasLayoutGraph(orchestration, layout);
    const targets = mainDispatchLayoutTargets(orchestration, layout);
    const workers = orchestration.agents.slice(1).map((agent) => agent.name);

    expect(graph.mode).toBe("main-dispatch");
    expect(graph.renderEdges).toHaveLength(businessWorkflowEdges(orchestration, layout).length);
    expect(graph.layoutEdges.some((edge) => edge.target === "main" && edge.source !== "input")).toBe(false);
    expect(graph.layoutEdges.some((edge) => edge.systemRoute === "main-dispatch")).toBe(false);
    expect(graph.returnEdgeIds).toEqual([]);
    const workerBounds = {
      left: Math.min(...workers.map((name) => targets[name]!.x)),
      top: Math.min(...workers.map((name) => targets[name]!.y)),
      right: Math.max(...workers.map((name) => targets[name]!.x + CANVAS_NODE_WIDTH)),
      bottom: Math.max(...workers.map((name) => targets[name]!.y + CANVAS_NODE_HEIGHT))
    };
    const main = targets.main!;
    expect(
      main.x + CANVAS_NODE_WIDTH <= workerBounds.left
      || main.x >= workerBounds.right
      || main.y + CANVAS_NODE_HEIGHT <= workerBounds.top
      || main.y >= workerBounds.bottom
    ).toBe(true);
    expect(targets.input!.x).toBeLessThan(targets[workers[0]!]!.x);
    expect(targets.finish!.x).toBeGreaterThan(targets[workers.at(-1)!]!.x);

    const repeated = mainDispatchLayoutTargets(orchestration, {
      ...layout,
      nodes: structuredClone(targets)
    });
    expect(repeated).toEqual(targets);
  });

  it("keeps an explicit Worker-to-Main edge in the business layout graph", () => {
    const orchestration = mainDispatchWorkflow(4);
    orchestration.routes.worker_1 = [{ target: "main", kind: "strong" }];
    const layout = normalizeCanvasLayout(undefined, orchestration);
    const graph = buildCanvasLayoutGraph(orchestration, layout);

    expect(graph.layoutEdges).toContainEqual(expect.objectContaining({
      id: canvasEdgeId("worker_1", "main"),
      source: "worker_1",
      target: "main",
      kind: "strong"
    }));
    expect(graph.returnEdgeIds).toEqual([]);
  });

  it("packs the default four-worker dispatch area as a stable 2 by 2 grid", () => {
    const orchestration = mainDispatchWorkflow(4);
    const targets = mainDispatchLayoutTargets(orchestration, normalizeCanvasLayout(undefined, orchestration));
    const [first, second, third, fourth] = orchestration.agents.slice(1).map((agent) => targets[agent.name]!);

    expect(first.y).toBe(second.y);
    expect(third.y).toBe(fourth.y);
    expect(first.x).toBe(third.x);
    expect(second.x).toBe(fourth.x);
    expect(second.x).toBeGreaterThan(first.x);
    expect(third.y).toBeGreaterThan(first.y);
  });

  it("keeps a genuine worker cycle in one deterministic fallback tier", () => {
    const cyclic: AgentOrchestrationTemplate = {
      ...structuredClone(workflow),
      agents: [
        { name: "main", template: "main" },
        { name: "alpha", template: "general" },
        { name: "beta", template: "general" },
        { name: "review", template: "review" }
      ],
      input: { source: "input", target: "alpha" },
      routes: {
        main: [{ target: "alpha", kind: "weak" }],
        alpha: [{ target: "beta", kind: "strong" }],
        beta: [{ target: "alpha", kind: "strong" }],
        review: [{ target: "finish", kind: "weak" }]
      },
      termination: { agent: "review", condition: "done", decisionBy: "main", automatic: false }
    };
    const layout = normalizeCanvasLayout(undefined, cyclic);
    const graph = buildCanvasLayoutGraph(cyclic, layout);
    const first = fallbackLayeredTargets(cyclic, layout);
    const second = fallbackLayeredTargets(cyclic, layout);

    expect(graph.mode).toBe("main-dispatch");
    expect(graph.components).toContainEqual(["alpha", "beta"]);
    expect(first.alpha.x).toBe(first.beta.x);
    expect(first.alpha.y).toBeLessThan(first.beta.y);
    expect(second).toEqual(first);
  });
});
