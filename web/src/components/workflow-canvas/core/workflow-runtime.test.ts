import { describe, expect, it } from "vitest";
import type { AgentEvent, Project } from "../../../types";
import { canvasEdgeId, loopExitCanvasEdgeId } from "./canvas-layout";
import { buildWorkflowRuntimeState } from "./workflow-runtime";

const project = {
  status: "running",
  currentAgent: "writing",
  queuedAgent: undefined,
  cycle: 1,
  orchestration: {
    agents: [
      { name: "main", template: "main" },
      { name: "idea", template: "idea" },
      { name: "writing", template: "writing" },
      { name: "review", template: "review" }
    ],
    input: { source: "input", target: "idea" },
    routes: {
      main: [
        { target: "writing", kind: "weak" },
        { target: "review", kind: "weak" }
      ],
      idea: [{ target: "main", kind: "strong" }],
      writing: [{ target: "review", kind: "strong" }],
      review: [{ target: "finish", kind: "weak" }]
    },
    decisionPlans: {},
    allowUserIntervention: true,
    termination: { agent: "review", condition: "done", decisionBy: "main", automatic: false }
  },
  agentProgress: {}
} as unknown as Project;

function event(seq: number, type: string, agent?: string, data?: Record<string, unknown>): AgentEvent {
  return { seq, type, agent, data, message: type, ts: new Date(seq * 1000).toISOString() };
}

describe("workflow runtime overlay", () => {
  it("does not complete a collaboration node from a member completion carrying its outer node id", () => {
    const grouped = structuredClone(project);
    grouped.currentAgent = undefined;
    grouped.orchestration.collaborations = [{ id: "research", displayName: "Research", memberAgentIds: ["writing", "review"], renamePolicy: "editable" }];
    const state = buildWorkflowRuntimeState(grouped, [
      event(1, "agent.started", "writing", { nodeId: "research", invocationId: "member-1" }),
      event(2, "agent.completed", "writing", { nodeId: "research", invocationId: "member-1" })
    ]);
    expect(state.nodeStates.research).toBe("running");
    expect(state.nodeStates.finish).toBe("waiting");
  });
  it("keeps every configured node and marks only the actual branch", () => {
    const state = buildWorkflowRuntimeState(project, [
      event(1, "agent.started", "idea", { invocationId: "i1", sourceAgent: "input" }),
      event(2, "agent.completed", "idea", { invocationId: "i1" }),
      event(3, "main.assignment.committed", "main", { sourceAgent: "main", target: "writing" }),
      event(4, "agent.started", "writing", { invocationId: "w1", sourceAgent: "main" })
    ]);
    expect(Object.keys(state.nodeStates)).toEqual(["input", "main", "idea", "writing", "review", "finish"]);
    expect(state.nodeStates.idea).toBe("completed");
    expect(state.nodeStates.writing).toBe("running");
    expect(state.nodeStates.review).toBe("waiting");
    expect(state.traversedEdgeIds.some((id) => id.startsWith("main->writing"))).toBe(true);
    expect(state.edgeStates["main->review:1"]).toBe("configured");
  });

  it("uses the immutable input target when the first start omits sourceAgent", () => {
    const state = buildWorkflowRuntimeState(project, [
      event(1, "agent.started", "idea", { invocationId: "i1" }),
      event(2, "agent.completed", "idea", { invocationId: "i1" })
    ]);
    expect(state.inferredEdgeIds).toContain("input->idea:0");
    expect(state.edgeStates["input->idea:0"]).toBe("traversed");
  });

  it("retains one node for a retry without counting the repeated invocation", () => {
    const retryProject = { ...project, currentAgent: "idea", queuedAgent: "idea", status: "retrying" } as Project;
    const state = buildWorkflowRuntimeState(retryProject, [
      event(1, "agent.execution.started", "idea", { executionId: "exec-1", executionNumber: 1, invocationId: "i1", sourceAgent: "input" }),
      event(2, "agent.started", "idea", { invocationId: "i1", executionId: "exec-1", sourceAgent: "input" }),
      event(3, "retry.scheduled", "idea", { invocationId: "i1" }),
      event(4, "agent.started", "idea", { invocationId: "i2", executionId: "exec-1", sourceAgent: "input" })
    ]);
    expect(state.executionCounts.idea).toBe(1);
    expect(state.nodeStates.idea).toBe("running");
    expect(state.recentInvocationPath.map((entry) => entry.nodeId)).toEqual(["idea", "idea"]);
  });

  it("increments only when the Agent starts a distinct business task", () => {
    const state = buildWorkflowRuntimeState(project, [
      event(1, "agent.execution.started", "writing", { executionId: "exec-1", executionNumber: 1, invocationId: "w1" }),
      event(2, "agent.started", "writing", { invocationId: "w1", executionId: "exec-1" }),
      event(3, "agent.completed", "writing", { invocationId: "w1" }),
      event(4, "agent.execution.started", "writing", { executionId: "exec-2", executionNumber: 2, invocationId: "w2" }),
      event(5, "agent.started", "writing", { invocationId: "w2", executionId: "exec-2" })
    ]);
    expect(state.executionCounts.writing).toBe(2);
  });

  it("does not complete finish from project status alone", () => {
    const completed = { ...project, status: "completed", currentAgent: undefined } as Project;
    const state = buildWorkflowRuntimeState(completed, []);
    expect(state.nodeStates.finish).toBe("waiting");
    expect(state.traversedEdgeIds).toHaveLength(0);
  });

  it("keeps queued decisions as candidates until the selected route starts", () => {
    const queued = { ...project, currentAgent: undefined, queuedAgent: "writing", status: "queued" } as Project;
    const state = buildWorkflowRuntimeState(queued, [
      event(1, "route.queued", "main", { sourceAgent: "main", targetAgent: "writing" }),
      event(2, "main.assignment.queued", "main", { sourceAgent: "main", target: "review" })
    ]);
    expect(state.nodeStates.writing).toBe("queued");
    expect(state.candidateEdgeIds).toEqual(["main->writing:0", "main->review:1"]);
    expect(state.edgeStates["main->review:1"]).toBe("candidate");
  });

  it("only marks the finish edge after the termination agent really completes", () => {
    const completed = { ...project, status: "completed", currentAgent: undefined } as Project;
    const state = buildWorkflowRuntimeState(completed, [
      event(1, "agent.started", "review", { invocationId: "r1", sourceAgent: "writing" }),
      event(2, "agent.completed", "review", { invocationId: "r1" })
    ]);
    expect(state.nodeStates.review).toBe("completed");
    expect(state.nodeStates.finish).toBe("completed");
    expect(state.edgeStates["review->finish:0"]).toBe("traversed");
  });

  it("deduplicates invocation envelopes and does not count durable session creation as a call", () => {
    const state = buildWorkflowRuntimeState(project, [
      event(1, "agent.execution.started", "idea", { executionId: "exec-1", executionNumber: 1, invocationId: "i1" }),
      event(2, "invocation.started", "idea", { invocationId: "i1", executionId: "exec-1" }),
      event(3, "session.started", "idea", { threadId: "thread-1" }),
      event(4, "agent.started", "idea", { invocationId: "i1", executionId: "exec-1", cycle: 2, sourceAgent: "input" }),
      event(5, "invocation.completed", "idea", { invocationId: "i1" })
    ]);
    expect(state.executionCounts.idea).toBe(1);
    expect(state.recentInvocationPath).toEqual([
      { invocationId: "i1", nodeId: "idea", cycle: 2, state: "completed" }
    ]);
  });

  it("lets a successful retry replace an earlier failure and preserves its diagnostic", () => {
    const retryProject = { ...project, status: "running", currentAgent: "writing" } as Project;
    const state = buildWorkflowRuntimeState(retryProject, [
      event(1, "agent.execution.started", "writing", { executionId: "exec-1", executionNumber: 1, invocationId: "e1", sourceAgent: "main" }),
      event(2, "agent.started", "writing", { invocationId: "e1", executionId: "exec-1", sourceAgent: "main" }),
      event(3, "invocation.failed", "writing", { invocationId: "e1", error: "temporary provider outage" }),
      event(4, "retry.scheduled", "writing", { invocationId: "e1" }),
      event(5, "agent.started", "writing", { invocationId: "e2", executionId: "exec-1", sourceAgent: "main" }),
      event(6, "agent.completed", "writing", { invocationId: "e2" })
    ]);
    expect(state.executionCounts.writing).toBe(1);
    expect(state.nodeStates.writing).toBe("completed");
    expect(state.nodeReasons.writing).toContain("temporary provider outage");
    expect(state.recentInvocationPath.map((entry) => entry.state)).toEqual(["retrying", "completed"]);
  });

  it("marks all queued decision candidates and rejects the unselected siblings", () => {
    const state = buildWorkflowRuntimeState(project, [
      event(1, "main.assignment.queued", "main", {
        sourceAgent: "main",
        candidateAgents: ["writing", "review"]
      }),
      event(2, "main.assignment.committed", "main", {
        sourceAgent: "main",
        target: "writing"
      })
    ]);
    expect(state.edgeStates["main->writing:0"]).toBe("active");
    expect(state.edgeStates["main->review:1"]).toBe("rejected");
    expect(state.candidateEdgeIds).toEqual([]);
  });

  it("keeps an interrupted path visible without completing the finish node", () => {
    const interrupted = { ...project, status: "interrupted", currentAgent: "writing" } as Project;
    const state = buildWorkflowRuntimeState(interrupted, [
      event(1, "agent.started", "writing", { invocationId: "w1", sourceAgent: "main" }),
      event(2, "session.resume_failed", "writing", { reason: "durable thread unavailable" })
    ]);
    expect(state.nodeStates.writing).toBe("interrupted");
    expect(state.nodeReasons.writing).toContain("durable thread unavailable");
    expect(state.nodeStates.finish).toBe("waiting");
    expect(state.edgeStates["writing->review:0"]).toBe("configured");
  });

  it("tracks Loop batch counters and distinguishes return from virtual exit traversal", () => {
    const loopProject = {
      ...project,
      currentAgent: "evaluate",
      orchestration: {
        ...structuredClone(project.orchestration),
        routes: {
          main: [{ target: "refine", kind: "weak" }],
          refine: [{ target: "evaluate", kind: "strong" }],
          evaluate: [{ target: "refine", kind: "strong" }],
          review: [{ target: "finish", kind: "weak" }]
        },
        agents: [
          { name: "main", template: "main" },
          { name: "refine", template: "idea" },
          { name: "evaluate", template: "review" },
          { name: "review", template: "review" }
        ],
        input: { source: "input", target: "refine" },
        loops: [{
          id: "refinement",
          from: "evaluate",
          to: "refine",
          maxIterations: 3,
          exitTo: "review"
        }],
        termination: { ...project.orchestration.termination, agent: "review" }
      },
      loopIterations: { refinement: 1 },
      loopBatches: { refinement: 1 },
      loopTotalIterations: { refinement: 1 }
    } as unknown as Project;

    const iterating = buildWorkflowRuntimeState(loopProject, [
      event(1, "workflow.loop.batch.started", "refine", {
        loopId: "refinement", batch: 2, iterations: 1, totalIterations: 4, maxIterations: 3
      }),
      event(2, "workflow.loop.iteration", "evaluate", {
        loopId: "refinement", batch: 2, iterations: 2, totalIterations: 5, maxIterations: 3
      })
    ]);
    expect(iterating.loopStates.refinement).toEqual({
      id: "refinement",
      batch: 2,
      iteration: 2,
      totalIterations: 5,
      maxIterations: 3,
      phase: "iterating"
    });
    expect(iterating.edgeStates[canvasEdgeId("evaluate", "refine")]).toBe("active");
    expect(iterating.edgeStates[loopExitCanvasEdgeId("refinement")]).toBe("configured");

    const exhausted = buildWorkflowRuntimeState(loopProject, [
      event(3, "workflow.loop.exhausted", "evaluate", {
        loopId: "refinement", batch: 2, iterations: 3, totalIterations: 6, maxIterations: 3
      })
    ]);
    expect(exhausted.loopStates.refinement).toMatchObject({
      batch: 2,
      iteration: 3,
      totalIterations: 6,
      phase: "exhausted"
    });
    expect(exhausted.edgeStates[canvasEdgeId("evaluate", "refine")]).toBe("traversed");
    expect(exhausted.edgeStates[loopExitCanvasEdgeId("refinement")]).toBe("active");
  });
});
