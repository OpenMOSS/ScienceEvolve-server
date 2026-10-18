import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION } from "../../../lib";
import { canvasEdgeId, normalizeCanvasLayout } from "./canvas-layout";
import {
  buildCanvasTidyResult,
  buildSmartTidyPlan,
  canvasLayoutReport,
  optimizeCanvasPorts
} from "./canvas-layout-report";

describe("canvas layout report and tidy planner", () => {
  it("reports hard overlap and edge-through-node conflicts", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const layout = normalizeCanvasLayout(undefined, orchestration);
    layout.nodes.idea = { x: 380, y: 220 };
    layout.nodes.execution = { x: 390, y: 225 };
    layout.nodes.writing = { x: 560, y: 220 };
    const report = canvasLayoutReport(orchestration, layout);

    expect(report.stats.nodeOverlaps).toBeGreaterThan(0);
    expect(report.stats.hardIssues).toBeGreaterThan(0);
    expect(report.conflictNodeIds).toEqual(expect.arrayContaining(["idea", "execution"]));
  });

  it("reduces hard conflicts with one deterministic tidy result", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const layout = normalizeCanvasLayout(undefined, orchestration);
    for (const name of ["idea", "execution", "writing", "review"]) {
      layout.nodes[name] = { x: 420, y: 260 };
    }
    const result = buildCanvasTidyResult(orchestration, layout);

    expect(result.finalReport.stats.hardIssues).toBeLessThan(result.initialReport.stats.hardIssues);
    expect(result.layout.layoutMode).toBe("free");
    expect(buildCanvasTidyResult(orchestration, layout).layout).toEqual(result.layout);
  });

  it("keeps the default five-Agent return graph and a crowded branch/merge graph readable", () => {
    const defaultWorkflow = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const defaultLayout = normalizeCanvasLayout(undefined, defaultWorkflow);
    for (const name of ["idea", "execution", "writing", "review"]) {
      defaultLayout.nodes[name] = { x: 460, y: 280 };
    }
    const defaultResult = buildSmartTidyPlan(defaultWorkflow, defaultLayout);
    expect(defaultResult.finalReport.stats.hardIssues).toBeLessThan(defaultResult.initialReport.stats.hardIssues);

    const branchWorkflow = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    branchWorkflow.routes = {
      main: [
        { target: "idea", kind: "weak" },
        { target: "execution", kind: "weak" },
        { target: "writing", kind: "weak" }
      ],
      idea: [{ target: "review", kind: "strong" }],
      execution: [{ target: "review", kind: "strong" }],
      writing: [{ target: "review", kind: "strong" }],
      review: [{ target: "finish", kind: "weak" }, { target: "main", kind: "weak" }]
    };
    const branchLayout = normalizeCanvasLayout(undefined, branchWorkflow);
    for (const id of Object.keys(branchLayout.nodes)) branchLayout.nodes[id] = { x: 520, y: 300 };
    const branchResult = buildSmartTidyPlan(branchWorkflow, branchLayout);
    expect(branchResult.finalReport.stats.hardIssues).toBeLessThan(branchResult.initialReport.stats.hardIssues);
    expect(buildSmartTidyPlan(branchWorkflow, branchLayout).layout).toEqual(branchResult.layout);
  });

  it("never changes explicitly pinned ports but optimizes adaptive ports", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const layout = normalizeCanvasLayout(undefined, orchestration);
    const pinnedId = canvasEdgeId("idea", "main", 0);
    layout.edges[pinnedId] = {
      sourcePort: "top",
      targetPort: "bottom",
      sourcePortPinned: true,
      targetPortPinned: true
    };
    const adaptiveId = canvasEdgeId("execution", "main", 0);
    layout.edges[adaptiveId] = {
      sourcePort: "top",
      targetPort: "top",
      sourcePortPinned: false,
      targetPortPinned: false
    };
    const optimized = optimizeCanvasPorts(orchestration, layout).layout;

    expect(optimized.edges[pinnedId]).toMatchObject({ sourcePort: "top", targetPort: "bottom" });
    expect(optimized.edges[adaptiveId]).toBeDefined();
  });

  it("keeps long-label cyclic branch/merge graphs deterministic and separated", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.agents = [
      { name: "main", template: "main", description: "Main controller with a deliberately long label" },
      { name: "long-planner", template: "general", description: "A long planning role that must remain readable on narrow screens" },
      { name: "long-researcher", template: "general", description: "A long evidence gathering role" },
      { name: "long-experimenter", template: "general", description: "A long experiment execution role" },
      { name: "long-reviewer", template: "review", description: "A long review and quality assurance role" },
      { name: "long-writer", template: "writing", description: "A long scientific writing role" }
    ];
    orchestration.input = { source: "input", target: "long-planner" };
    orchestration.routes = {
      main: [
        { target: "long-planner", kind: "weak" },
        { target: "long-researcher", kind: "weak" },
        { target: "long-experimenter", kind: "weak" }
      ],
      "long-planner": [{ target: "long-researcher", kind: "strong" }],
      "long-researcher": [
        { target: "long-experimenter", kind: "strong" },
        { target: "long-reviewer", kind: "weak" }
      ],
      "long-experimenter": [{ target: "long-reviewer", kind: "strong" }],
      "long-reviewer": [
        { target: "long-writer", kind: "strong" },
        { target: "long-researcher", kind: "weak" }
      ],
      "long-writer": [{ target: "finish", kind: "strong" }]
    };
    orchestration.termination = { agent: "long-writer", condition: "done", decisionBy: "main", automatic: false };
    const layout = normalizeCanvasLayout(undefined, orchestration);
    for (const id of Object.keys(layout.nodes)) layout.nodes[id] = { x: 420, y: 280 };
    const nodeSizes = Object.fromEntries(
      orchestration.agents.map((agent) => [agent.name, { width: 270, height: 126 }])
    );
    const result = buildSmartTidyPlan(orchestration, layout, nodeSizes);
    const repeat = buildSmartTidyPlan(orchestration, layout, nodeSizes);
    expect(result.layout).toEqual(repeat.layout);
    expect(result.finalReport.stats.hardIssues).toBeLessThan(result.initialReport.stats.hardIssues);
    expect(result.finalReport.stats.nodeOverlaps).toBe(0);
    expect(result.finalReport.stats.edgeNodeHits).toBeLessThanOrEqual(result.initialReport.stats.edgeNodeHits);
  });
});
