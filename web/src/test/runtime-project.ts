import { DEFAULT_AGENT_ORCHESTRATION, normalizeProject } from "../lib";
import { addScopedGroup, upgradeLegacyGroups } from "../components/workflow-canvas/core/scoped-workflow";
import type { Project } from "../types";

export function runtimeProjectFixture(): Project {
  const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
  upgradeLegacyGroups(orchestration);
  addScopedGroup(orchestration, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution", "writing", "review"] });
  addScopedGroup(orchestration, { id: "inner", displayName: "Inner", parentGroupId: "research", leaderAgentId: "main", memberAgentIds: ["writing", "review"] });
  const run = (groupId: string, parentGroupRunId?: string) => ({ id: `run-${groupId}`, projectId: "prj_runtime",
    groupId, parentGroupRunId, activationRequestId: `activate-${groupId}`, workflowRevision: 2,
    leaderAgentId: "main", baseCommit: "a".repeat(40), groupBranch: `groups/${groupId}`, integrationTarget: "main", status: "running" });
  const groups = [run("research"), run("inner", "run-research")];
  const nodes = orchestration.scopedWorkflow!.groups.find((group) => group.id === "inner")!.workflow.nodes;
  const arrivals = nodes.filter((node) => node.kind === "agent").map((node, index) => ({
    sequence: index + 1, requestId: `arrival-${node.nodeId}`, groupRunId: "run-inner", sourceRunId: "input:run-inner",
    targetNodeId: node.nodeId, targetKind: "agent", agentId: node.agentId, status: "running"
  }));
  const executions = arrivals.map((arrival) => ({ id: `exec-${arrival.agentId}`, projectId: "prj_runtime", groupRunId: arrival.groupRunId,
    arrivalRequestId: arrival.requestId, agentId: arrival.agentId, ownershipEpoch: 1,
    executionBranch: `executions/${arrival.agentId}`, worktreePath: "/tmp/worktree", status: "running" }));
  return normalizeProject({ id: "prj_runtime", title: "Runtime fixture", status: "running", currentAgent: "main", orchestration,
    runCounts: {}, agentProgress: { main: { state: "running", runs: 0 }, writing: { state: "waiting", runs: 0 } },
    scopedGroupRuns: groups, scopedArrivals: arrivals, scopedExecutions: executions,
    scopedManagementTurns: [{ projectId: "prj_runtime", groupRunId: "run-research", agentId: "main", invocationId: "manage-1", coordinatorEpoch: 1, status: "active" }],
    runtime: { stateRevision: 12, status: "running", phase: "model:running", currentAgent: "main", executionCount: 2,
      activities: executions.map((execution) => ({ activityId: `activity-${execution.agentId}`, projectId: "prj_runtime", kind: "turn", scopeKind: "scoped-agent",
        phase: "model:running", invocationId: `inv-${execution.agentId}`, agentId: execution.agentId, nodeRunId: "outer-node",
        groupRunId: "run-inner", executionId: execution.id, ownershipEpoch: 1, writerLeaseEpoch: 1,
        startedAt: "2026-10-09T00:00:00Z", leaseState: "current" })) }
  });
}
