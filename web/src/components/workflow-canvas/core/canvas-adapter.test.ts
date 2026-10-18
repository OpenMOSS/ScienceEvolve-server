import { describe, expect, it } from "vitest";
import type { AgentOrchestrationTemplate } from "../../../types";
import { adaptWorkflowToCanvas, applyCanvasLayout, applyCanvasModelLayout } from "./canvas-adapter";
import { canvasEdgeId, loopExitCanvasEdgeId } from "./canvas-layout";

const workflow: AgentOrchestrationTemplate = {
  agents: [
    { name: "main", template: "main" },
    { name: "research", template: "idea" },
    { name: "review", template: "review" }
  ],
  input: { source: "input", target: "research" },
  routes: {
    main: [{ target: "research", kind: "weak" }],
    research: [{ target: "review", kind: "strong" }],
    review: [{ target: "finish", kind: "weak" }]
  },
  decisionPlans: {},
  allowUserIntervention: true,
  termination: { agent: "review", condition: "accepted", decisionBy: "main", automatic: false }
};

describe("adaptWorkflowToCanvas", () => {
  it("preserves route semantics while decorating routes with layout", () => {
    const model = adaptWorkflowToCanvas(workflow);

    expect(model.nodes.map((node) => node.id)).toEqual(["input", "main", "research", "review", "finish"]);
    expect(model.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: canvasEdgeId("input", "research"), kind: "strong", fixed: false }),
      expect.objectContaining({ id: canvasEdgeId("main", "research"), kind: "weak", fixed: true, systemRoute: "main-dispatch" }),
      expect.objectContaining({ id: canvasEdgeId("research", "review"), kind: "strong", fixed: false }),
      expect.objectContaining({ id: canvasEdgeId("review", "finish"), kind: "termination", fixed: false })
    ]));
    expect(model.semanticWorkflow).not.toBe(workflow);
    expect(model.semanticWorkflow).toEqual(workflow);
    expect(model.presentationLayout).toBe(model.layout);
    expect(model.summary).toMatchObject({
      agentCount: 2,
      strongEdgeCount: 1,
      weakEdgeCount: 0,
      inputTarget: "research",
      terminationTarget: "review",
      inputConnected: true,
      terminationConnected: true
    });
    expect(workflow.canvas).toBeUndefined();
    expect(workflow.routes.review).toEqual([{ target: "finish", kind: "weak" }]);
  });

  it("renders the two reference system connections in a new blank workflow", () => {
    const blank = {
      ...structuredClone(workflow),
      agents: [{ name: "main", template: "main" as const }],
      input: { source: "input" as const, target: "main" },
      routes: { main: [] },
      termination: { ...workflow.termination, agent: "main" }
    };
    const model = adaptWorkflowToCanvas(blank);
    expect(model.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: canvasEdgeId("input", "main"), source: "input", target: "main", kind: "strong", fixed: false }),
      expect.objectContaining({ id: canvasEdgeId("main", "finish"), source: "main", target: "finish", kind: "termination", fixed: false })
    ]));
    expect(model.edges).toHaveLength(2);
    expect(model.summary).toMatchObject({
      agentCount: 0,
      strongEdgeCount: 0,
      weakEdgeCount: 0,
      inputTarget: "main",
      terminationTarget: "main",
      inputConnected: true,
      terminationConnected: true
    });
  });

  it("keeps an explicit Main termination route outside the fixed dispatch rail", () => {
    const direct = {
      ...structuredClone(workflow),
      agents: [{ name: "main", template: "main" as const }],
      input: { source: "input" as const, target: "main" },
      routes: { main: [{ target: "finish", kind: "weak" as const }] },
      termination: { ...workflow.termination, agent: "main" }
    };
    const termination = adaptWorkflowToCanvas(direct).edges.find((edge) => edge.target === "finish");
    expect(termination).toMatchObject({
      source: "main",
      target: "finish",
      kind: "termination",
      fixed: false
    });
    expect(termination).not.toHaveProperty("systemRoute");
  });

  it("decorates every Loop member edge and derives one read-only exit without changing routes", () => {
    const loopWorkflow: AgentOrchestrationTemplate = {
      ...structuredClone(workflow),
      agents: [
        { name: "main", template: "main" },
        { name: "refine", template: "idea" },
        { name: "evaluate", template: "review" },
        { name: "review", template: "review" }
      ],
      input: { source: "input", target: "refine" },
      routes: {
        main: [
          { target: "refine", kind: "weak" },
          { target: "review", kind: "weak" }
        ],
        refine: [{ target: "evaluate", kind: "strong" }],
        evaluate: [{ target: "refine", kind: "strong" }],
        review: [{ target: "finish", kind: "weak" }]
      },
      loops: [{
        id: "refinement",
        from: "evaluate",
        to: "refine",
        maxIterations: 3,
        exitTo: "review"
      }],
      termination: { ...workflow.termination, agent: "review" }
    };
    const originalRoutes = structuredClone(loopWorkflow.routes);

    const model = adaptWorkflowToCanvas(loopWorkflow);
    expect(model.nodes.map((node) => node.id)).not.toContain("refinement");
    expect(model.edges.find((edge) => edge.id === canvasEdgeId("evaluate", "refine"))).toMatchObject({
      fixed: false,
      loop: {
        id: "refinement",
        role: "return",
        maxIterations: 3,
        exitTo: "review",
        virtual: false
      }
    });
    expect(model.edges.find((edge) => edge.id === canvasEdgeId("refine", "evaluate"))).toMatchObject({
      loop: { id: "refinement", role: "member", virtual: false }
    });
    expect(model.edges.find((edge) => edge.id === loopExitCanvasEdgeId("refinement"))).toMatchObject({
      source: "evaluate",
      target: "review",
      fixed: true,
      loop: {
        id: "refinement",
        role: "exit",
        virtual: true
      }
    });
    expect(model.summary.strongEdgeCount).toBe(2);
    expect(loopWorkflow.routes).toEqual(originalRoutes);
    expect(loopWorkflow.routes.evaluate).toEqual([{ target: "refine", kind: "strong" }]);
  });

  it("writes only sanitized presentation state back to a cloned workflow", () => {
    const model = adaptWorkflowToCanvas(workflow);
    model.presentationLayout.nodes.research = { x: 1234, y: 567 };
    model.edges[1]!.target = "finish";
    model.semanticWorkflow.routes.research = [];

    const next = applyCanvasModelLayout(workflow, model);
    expect(next).not.toBe(workflow);
    expect(next.routes).toEqual(workflow.routes);
    expect(next.termination).toEqual(workflow.termination);
    expect(next.canvas?.nodes.research).toEqual({ x: 1234, y: 567 });

    const untrusted = applyCanvasLayout(workflow, {
      nodes: { research: { x: 12, y: 34 }, stale: { x: 1, y: 1 } },
      edges: {},
      viewport: { x: 0, y: 0, zoom: 0.01 }
    });
    expect(untrusted.canvas?.nodes).not.toHaveProperty("stale");
    expect(untrusted.canvas?.viewport.zoom).toBe(0.08);
    expect(untrusted.routes).toEqual(workflow.routes);
  });
});
