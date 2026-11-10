import { describe, expect, it } from "vitest";
import { DEFAULT_RESEARCH_WORKFLOW, defaultResearchAgents } from "./default-research-preset";
import { normalizeAgentOrchestration, normalizeAgents, agentOrchestrationError } from "./lib";
import { validateWorkflowLoops, workflowLoopMembers } from "../../server/src/internal/shared/workflow-loop-validation.js";
import { normalizeCanvasLayout } from "./components/workflow-canvas/core/canvas-layout";
import { CANVAS_NODE_HEIGHT, CANVAS_NODE_WIDTH } from "./components/workflow-canvas/core/canvas-model";
import { canvasLayoutReport } from "./components/workflow-canvas/core/canvas-layout-report";

describe("default research preset", () => {
  it("opens a compact layered canvas with the evidence loop together and no overlapping cards", () => {
    const layout = normalizeCanvasLayout(DEFAULT_RESEARCH_WORKFLOW.canvas, DEFAULT_RESEARCH_WORKFLOW);
    expect(layout.layoutMode).toBe("layered");
    expect(layout.nodes.main.x).toBeLessThan(layout.nodes.文献研究员.x);
    expect(layout.nodes.文献研究员.x).toBeLessThan(layout.nodes.因果裁判.x);
    expect(layout.nodes.因果裁判.x).toBeLessThan(layout.nodes.证据复核员.x);
    expect(layout.nodes.证据复核员.x).toBe(layout.nodes.定点补证员.x);
    expect(Math.max(...Object.values(layout.nodes).map(node => node.x + CANVAS_NODE_WIDTH))).toBeLessThan(1500);
    const nodes = Object.values(layout.nodes);
    for (let i = 0; i < nodes.length; i++) for (const other of nodes.slice(i + 1)) {
      const node = nodes[i]!;
      expect(Math.abs(node.x - other.x) >= CANVAS_NODE_WIDTH || Math.abs(node.y - other.y) >= CANVAS_NODE_HEIGHT).toBe(true);
    }
    expect(canvasLayoutReport(DEFAULT_RESEARCH_WORKFLOW, layout).stats.issues).toBe(0);
  });
  it("preserves the weak decision and two-round evidence loop through form normalization", () => {
    const graph = normalizeAgentOrchestration(DEFAULT_RESEARCH_WORKFLOW);
    expect(agentOrchestrationError(graph, false)).toBeUndefined();
    expect(validateWorkflowLoops(graph)).toEqual([]);
    expect(graph.routes.因果裁判).toEqual([{ target: "证据复核员", kind: "weak" }, { target: "研究总编", kind: "weak" }]);
    expect(workflowLoopMembers(graph, graph.loops![0]!)).toEqual(["证据复核员", "定点补证员"]);
    const agents = normalizeAgents(defaultResearchAgents(), graph);
    expect(Object.keys(agents)).toEqual(graph.agents.map(agent => agent.name));
    expect(agents.因果裁判.decisionBy).toBe("agent");
    expect(graph.loops![0]!.maxIterations).toBe(2);
    const second = defaultResearchAgents();
    agents.文献研究员.skills.push("local-edit");
    expect(second.文献研究员.skills).not.toContain("local-edit");
  });
});
