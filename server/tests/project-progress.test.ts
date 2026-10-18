import { describe, expect, it } from "vitest";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { deriveProjectRuntimeProjection } from "../src/collaboration-runtime.js";
import { overallProgress } from "../src/orchestrator.js";
import type { CredentialFreeProjectStateProjection, ProjectState } from "../src/types.js";

function state(overrides: Partial<ProjectState> = {}): ProjectState {
  const orchestration = cloneAgentOrchestrationTemplate();
  return {
    status: "running",
    phase: "execution:running",
    runCounts: Object.fromEntries(
      orchestration.agents.map(({ name }) => [name, 0])
    ),
    orchestration,
    ...overrides
  } as ProjectState;
}

function linearWorkflow(): ProjectState["orchestration"] {
  const template = cloneAgentOrchestrationTemplate();
  template.routes = {
    main: [],
    idea: [{ target: "execution", kind: "strong" }],
    execution: [{ target: "writing", kind: "strong" }],
    writing: [{ target: "review", kind: "strong" }],
    review: [{ target: "finish", kind: "weak" }]
  };
  return template;
}

function nodeRun(nodeId: string, kind: "agent" | "collaboration" = "agent"): NonNullable<ProjectState["nodeRuns"]>[number] {
  return {
    id: `run-${nodeId}`,
    node: kind === "agent"
      ? { kind, nodeId, agentId: nodeId }
      : { kind, nodeId, groupId: nodeId },
    workflowRevision: 1,
    activationRequestId: `activate-${nodeId}`,
    inputSnapshotRef: "snapshot",
    activatedByAgentId: "main",
    status: "running"
  };
}

describe("workflow project progress", () => {
  it("tracks positions in a linear workflow and reaches 100 only when completed", () => {
    const orchestration = linearWorkflow();
    expect(overallProgress(state({ orchestration }))).toMatchObject({
      percent: 0, estimated: true, successfulCalls: 0
    });
    for (const [currentAgent, percent] of [["idea", 0], ["execution", 25], ["writing", 50], ["review", 75]] as const) {
      expect(overallProgress(state({ orchestration, currentAgent })).percent).toBe(percent);
    }
    expect(overallProgress(state({ orchestration, currentAgent: "review", status: "completed" })).percent).toBe(100);
  });

  it("uses shortest reachable paths on both short and long branches", () => {
    const orchestration = linearWorkflow();
    orchestration.routes.idea = [
      { target: "execution", kind: "weak" },
      { target: "writing", kind: "weak" }
    ];
    orchestration.routes.execution = [{ target: "review", kind: "strong" }];
    orchestration.agents.push({ name: "analysis" });
    orchestration.routes.writing = [{ target: "analysis", kind: "strong" }];
    orchestration.routes.analysis = [{ target: "review", kind: "strong" }];
    expect(overallProgress(state({ orchestration, currentAgent: "execution" })).percent).toBe(33.3);
    expect(overallProgress(state({ orchestration, currentAgent: "writing" })).percent).toBe(25);
    expect(overallProgress(state({ orchestration, currentAgent: "analysis" })).percent).toBe(50);
    expect(overallProgress(state({ orchestration, currentAgent: "review" })).percent).toBe(66.7);
    orchestration.agents.reverse();
    expect(overallProgress(state({ orchestration, currentAgent: "writing" })).percent).toBe(25);
  });

  it("handles cycles and scheduler loop exits without accumulating iterations", () => {
    const orchestration = linearWorkflow();
    orchestration.routes.writing = [{ target: "execution", kind: "strong" }];
    orchestration.loops = [{ id: "experiment", from: "writing", to: "execution", maxIterations: 3, exitTo: "review" }];
    expect(overallProgress(state({ orchestration, currentAgent: "writing" })).percent).toBe(50);
    expect(overallProgress(state({ orchestration, currentAgent: "execution", runCounts: { execution: 100, writing: 100 } })).percent).toBe(25);
    expect(overallProgress(state({ orchestration, currentAgent: "review" })).percent).toBe(75);
  });

  it("does not advance for repeated calls, experiment waits, or legacy Explainer suggestions", () => {
    const orchestration = linearWorkflow();
    const waiting = state({
      orchestration,
      currentAgent: "execution",
      phase: "execution:experiment-waiting",
      runCounts: { main: 500, execution: 10_000 },
      explainerProgress: {
        percent: 95, evidence: "已完成方法章节与实验脚本", successfulCalls: 4,
        artifactCount: 2, updatedAt: "2026-09-24T00:00:00.000Z"
      }
    });
    expect(overallProgress(waiting)).toMatchObject({ percent: 25, successfulCalls: 10_000 });
  });

  it("uses the active outer node rather than its coordinating or member Agent", () => {
    const orchestration = linearWorkflow();
    orchestration.collaborations = [{ id: "research", displayName: "Research", memberAgentIds: ["execution", "writing"], renamePolicy: "editable" }];
    orchestration.routes.idea = [{ target: "research", kind: "strong" }];
    orchestration.routes.research = [{ target: "review", kind: "strong" }];
    const run = nodeRun("research", "collaboration");
    for (const currentAgent of ["main", "execution", "writing"]) {
      expect(overallProgress(state({ orchestration, currentAgent, activeNodeRunId: run.id, nodeRuns: [run] })).percent).toBe(33.3);
    }
    expect(overallProgress(state({ orchestration, currentAgent: "writing" })).percent).toBe(33.3);
  });

  it("maps members of nested v3 groups to their outer workflow position", () => {
    const orchestration = linearWorkflow();
    orchestration.schemaVersion = 3;
    orchestration.scopedWorkflow = {
      schemaVersion: 1,
      rootAgentIds: ["main", "idea", "review"],
      groups: [{
        id: "research", leaderAgentId: "main", allowLeaderReconfiguration: false,
        workflow: {
          nodes: [{ kind: "collaboration", nodeId: "child-ref", groupId: "experiments" }],
          input: { source: "input", edges: [{ target: "child-ref", kind: "parallel" }] }, routes: {}
        }
      }, {
        id: "experiments", parentGroupId: "research", leaderAgentId: "main", allowLeaderReconfiguration: false,
        workflow: {
          nodes: [{ kind: "agent", nodeId: "worker-ref", agentId: "execution" }],
          input: { source: "input", edges: [{ target: "worker-ref", kind: "parallel" }] }, routes: {}
        }
      }]
    };
    orchestration.routes.idea = [{ target: "research", kind: "strong" }];
    orchestration.routes.research = [{ target: "review", kind: "strong" }];
    expect(overallProgress(state({ orchestration, currentAgent: "execution" })).percent).toBe(33.3);
  });

  it("preserves position while queued, paused, failed, or cancelled", () => {
    const orchestration = linearWorkflow();
    for (const status of ["queued", "paused", "failed", "cancelled"] as const) {
      expect(overallProgress(state({ status, orchestration, queuedAgent: "writing" })).percent).toBe(50);
    }
    expect(overallProgress(state({ status: "paused", orchestration, nodeRuns: [nodeRun("writing")] })).percent).toBe(50);
  });

  it("returns zero for unreachable positions and supports termination without a literal finish edge", () => {
    const orchestration = linearWorkflow();
    orchestration.routes.execution = [];
    expect(overallProgress(state({ orchestration, currentAgent: "execution" })).percent).toBe(0);
    expect(overallProgress(state({ orchestration, currentAgent: "review" })).percent).toBe(0);
    const mainOnly = cloneAgentOrchestrationTemplate();
    mainOnly.agents = [{ name: "main", template: "main" }];
    mainOnly.input.target = "main";
    mainOnly.routes = { main: [] };
    mainOnly.termination.agent = "main";
    expect(overallProgress(state({ orchestration: mainOnly, currentAgent: "main" })).percent).toBe(0);
    expect(overallProgress(state({ orchestration: mainOnly, status: "completed" })).percent).toBe(100);
  });

  it("keeps 100 percent while naming unresolved technical failures", () => {
    const progress = overallProgress(state({
      status: "completed",
      runCounts: { main: 0 },
      failureSummary: { unresolvedFailures: 2 } as ProjectState["failureSummary"]
    }));
    expect(progress.percent).toBe(100);
    expect(progress.label).toContain("2");
    expect(progress.label).toContain("技术故障");
  });

  it("uses the canonical recovery reason instead of saying an already started project is waiting to start", () => {
    const reason = "等待恢复：opportunity 的 Git 操作结果待确认";
    const project = state({ status: "queued", runtime: { stateRevision: 1, status: "queued", phase: "collaboration:scoped-recovery-waiting",
      executionCount: 2, activities: [], waiting: { kind: "recovery", reason } } });
    expect(overallProgress(project).label).toBe(reason);
    project.status = "completed";
    expect(overallProgress(project).label).toBe("项目已完成");
  });

  it("does not project a stale Agent while a project is paused", () => {
    const projection = deriveProjectRuntimeProjection({
      stateRevision: 1,
      workflowRevision: 1,
      workflowSnapshot: {},
      frozen: false,
      recoveryAttempts: 0,
      recoveryLimit: 3,
      git: { enabled: false, status: "disabled" },
      nodeRuns: [],
      groupRuns: [],
      tasks: [],
      executions: [],
      pullRequests: [],
      operations: [],
      routeOutbox: [],
      usage: [],
      failureAttempts: [],
      failureSummary: {
        currentStatus: "healthy",
        totalAttempts: 0,
        failedAttempts: 0,
        succeededAttempts: 0,
        unresolvedFailures: 0,
        operations: []
      },
      gitRetryScheduling: [],
      runtimeActivities: []
    } as unknown as CredentialFreeProjectStateProjection, {
      status: "paused",
      phase: "collaboration:scoped-failure",
      currentAgent: "idea"
    });
    expect(projection).toMatchObject({ status: "paused", phase: "collaboration:scoped-failure" });
    expect(projection.currentAgent).toBeUndefined();
  });

  it("names the prior run, reason, and deadline while a Git retry is fenced", () => {
    const deadlineAt = "2026-09-22T00:00:06.000Z";
    const progress = overallProgress(state({
      status: "queued",
      phase: "collaboration:ready",
      gitRetryScheduling: [{
        retryId: "git-retry:git-init-project-1:2",
        projectId: "project-1",
        operationId: "git-init-project-1",
        attempt: 2,
        retryAcceptedAt: {
          at: "2026-09-22T00:00:00.000Z",
          projectId: "project-1",
          invocationId: "inv_prior",
          epoch: 4,
          epochKind: "coordinator",
          waitingFor: {
            kind: "git-initialization",
            objectId: "git-init-project-1@2",
            reason: "Waiting for Git ready",
            deadlineAt: null
          }
        },
        gitReadyPersistedAt: {
          at: "2026-09-22T00:00:01.000Z",
          projectId: "project-1",
          invocationId: "inv_prior",
          epoch: 4,
          epochKind: "coordinator",
          waitingFor: {
            kind: "prior-project-run",
            objectId: "inv_prior",
            reason: "旧运行仍持有调度 fence",
            deadlineAt
          }
        }
      }]
    }));

    expect(progress.label).toContain("inv_prior");
    expect(progress.label).toContain("旧运行仍持有调度 fence");
    expect(progress.label).toContain(deadlineAt);
  });
});
