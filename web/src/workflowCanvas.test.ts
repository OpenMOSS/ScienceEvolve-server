import { describe, expect, it } from "vitest";
import { cloneAgentsConfig, DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "./lib";
import {
  defaultWorkflowCanvasLayout,
  normalizeWorkflowCanvasLayout,
  removeAgentFromWorkflow,
  renameAgentInWorkflow,
  workflowEdgeKey,
  workflowToCanvas
} from "./workflowCanvas";

describe("workflow canvas mapping", () => {
  it("maps input, Main-derived routes and finish to stable edge ids", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const canvas = workflowToCanvas(orchestration);

    expect(canvas.nodes.map((node) => node.id)).toEqual([
      "input",
      "main",
      "idea",
      "execution",
      "writing",
      "review",
      "finish"
    ]);
    expect(canvas.edges.find((edge) => edge.id === workflowEdgeKey("input", "idea"))).toMatchObject({
      source: "input",
      target: "idea",
      kind: "strong"
    });
    expect(canvas.edges.find((edge) => edge.id === workflowEdgeKey("review", "finish", 1))).toMatchObject({
      source: "review",
      target: "finish",
      kind: "termination"
    });
    expect(canvas.edges.filter((edge) => edge.source === "main")).toHaveLength(4);
  });

  it("drops stale layout keys after semantic route changes and clamps viewport values", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const fallback = defaultWorkflowCanvasLayout(orchestration);
    const normalized = normalizeWorkflowCanvasLayout({
      ...fallback,
      edges: {
        ...fallback.edges,
        "review->removed:0": {
          sourcePort: "left",
          targetPort: "right",
          sourcePortPinned: false,
          targetPortPinned: false
        },
        [workflowEdgeKey("review", "finish", 1)]: {
          sourcePort: "top",
          targetPort: "bottom"
        }
      },
      viewport: { x: 99_999, y: -99_999, zoom: 99 }
    }, orchestration);

    expect(normalized.edges).not.toHaveProperty("review->removed:0");
    expect(normalized.edges[workflowEdgeKey("review", "finish", 1)]).toMatchObject({
      sourcePort: "top",
      targetPort: "bottom",
      sourcePortPinned: true,
      targetPortPinned: true
    });
    expect(normalized.viewport).toEqual({ x: 20_000, y: -20_000, zoom: 2.4 });
  });

  it("uses a stable default layout when old configurations omit canvas data", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const canvas = workflowToCanvas(orchestration, undefined);
    expect(canvas.layout.schemaVersion).toBe(1);
    expect(canvas.layout.nodes.input).toEqual({ x: 20, y: 260 });
    expect(canvas.layout.viewport.zoom).toBe(0.82);
  });

  it("derives both system anchor edges in a blank workflow", () => {
    const orchestration = {
      ...structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      agents: [{ name: "main", template: "main" as const }],
      input: { source: "input" as const, target: "main" },
      routes: { main: [] },
      decisionPlans: { main: "Main selects the next step." },
      termination: {
        ...structuredClone(DEFAULT_AGENT_ORCHESTRATION.termination),
        agent: "main"
      }
    };
    const blank = defaultWorkflowCanvasLayout(orchestration);
    expect(blank.edges).toHaveProperty(workflowEdgeKey("input", "main"));
    expect(blank.edges).toHaveProperty(workflowEdgeKey("main", "finish"));

    const normalized = normalizeWorkflowCanvasLayout({
      ...blank,
      edges: {
        [workflowEdgeKey("input", "main")]: {
          sourcePort: "right",
          targetPort: "left",
          sourcePortPinned: true,
          targetPortPinned: true
        }
      }
    }, orchestration);

    expect(normalized.edges[workflowEdgeKey("input", "main")]).toMatchObject({
      sourcePort: "right",
      targetPort: "left"
    });
    expect(workflowToCanvas(orchestration, normalized).edges).toHaveLength(2);
  });

  it("keeps Main termination edges editable in the compatibility surface", () => {
    const orchestration = {
      ...structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      agents: [{ name: "main", template: "main" as const }],
      input: { source: "input" as const, target: "main" },
      routes: { main: [{ target: "finish", kind: "weak" as const }] },
      termination: {
        ...structuredClone(DEFAULT_AGENT_ORCHESTRATION.termination),
        agent: "main"
      }
    };
    const canvas = workflowToCanvas(orchestration);
    const termination = canvas.edges.find((edge) => edge.target === "finish");
    expect(termination).toMatchObject({ kind: "termination", fixed: false });
    expect(termination?.systemRoute).toBeUndefined();

    const dispatch = workflowToCanvas(DEFAULT_AGENT_ORCHESTRATION).edges.find(
      (edge) => edge.source === "main" && edge.target === "idea"
    );
    expect(dispatch).toMatchObject({ fixed: true, systemRoute: "main-dispatch" });
  });

  it("renames every Loop reference and refuses to silently remove a Loop member", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.routes = {
      main: [{ target: "idea", kind: "weak" }],
      idea: [{ target: "execution", kind: "strong" }],
      execution: [{ target: "idea", kind: "strong" }],
      writing: [{ target: "review", kind: "strong" }],
      review: [{ target: "finish", kind: "weak" }]
    };
    orchestration.loops = [{
      id: "drafting",
      from: "execution",
      to: "idea",
      maxIterations: 3,
      exitTo: "writing"
    }];
    const agents = cloneAgentsConfig(DEFAULT_AGENTS);

    const renamed = renameAgentInWorkflow(orchestration, agents, "execution", "analysis");
    expect(renamed.orchestration.loops).toEqual([{
      id: "drafting",
      from: "analysis",
      to: "idea",
      maxIterations: 3,
      exitTo: "writing"
    }]);
    expect(renamed.orchestration.routes.idea).toEqual([{ target: "analysis", kind: "strong" }]);
    expect(renamed.orchestration.routes.analysis).toEqual([{ target: "idea", kind: "strong" }]);

    const removal = removeAgentFromWorkflow(orchestration, agents, "idea");
    expect(removal.orchestration).toEqual(orchestration);
    expect(removal.agents).toEqual(agents);
  });
});
