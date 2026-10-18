import type { AgentOrchestrationTemplate, ScopedWorkflow } from "../../../types";
import type { CanvasOrchestrationShape } from "./canvas-layout";

/** Project a group's real semantic graph into the shared presentation planner.
 * The projection is never saved as a root Workflow or used by the scheduler. */
export function scopedCanvasPlanningOrchestration(
  workflow: ScopedWorkflow
): AgentOrchestrationTemplate & CanvasOrchestrationShape {
  const nodeIds = workflow.nodes.map((node) => node.nodeId);
  return {
    schemaVersion: 3,
    agents: nodeIds.map((name) => ({ name })),
    collaborations: [],
    scopedWorkflow: { schemaVersion: 1, rootAgentIds: nodeIds, groups: [] },
    input: { source: "input", target: workflow.input.edges[0]?.target ?? "" },
    layoutInputTargets: workflow.input.edges.map((edge) => edge.target),
    layoutRouteEdgeIds: "source-target",
    routes: workflow.routes,
    loops: workflow.loops,
    decisionPlans: {},
    allowUserIntervention: false,
    termination: { agent: "", condition: "", decisionBy: "main", automatic: true },
    canvas: workflow.canvas
  };
}
