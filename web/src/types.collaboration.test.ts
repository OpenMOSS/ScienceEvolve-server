import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentOrchestrationTemplateV2,
  CreateProjectInput,
  MemberExecution,
  NodeRun,
  ProjectGitState,
  PullRequestRecord
} from "./types";

describe("collaboration v2 public type mirror", () => {
  it("represents outer groups, scoped sibling executions, Git facts, and event ownership", () => {
    const orchestration: AgentOrchestrationTemplateV2 = {
      schemaVersion: 2,
      agents: [
        { name: "main", template: "main" },
        { name: "a", template: "idea" },
        { name: "b", template: "execution" },
        { name: "reviewer", template: "review" }
      ],
      collaborations: [{
        id: "research_group",
        displayName: "Research group",
        memberAgentIds: ["a", "b"],
        renamePolicy: "editable"
      }],
      input: { source: "input", target: "research_group" },
      routes: {
        main: [{ target: "research_group", kind: "weak" }, { target: "reviewer", kind: "weak" }],
        research_group: [{ target: "reviewer", kind: "strong" }],
        reviewer: [{ target: "finish", kind: "weak" }]
      },
      decisionPlans: {},
      allowUserIntervention: true,
      termination: {
        agent: "reviewer",
        condition: "The reviewed integrated output exists.",
        decisionBy: "main",
        automatic: true
      }
    };
    const createInput: CreateProjectInput = {
      title: "Typed collaboration",
      requirement: "Keep member executions separate.",
      agents: {},
      orchestration,
      git: { enabled: true, provider: "github" }
    };
    const nodeRun: NodeRun = {
      id: "nr_1",
      node: { kind: "collaboration", nodeId: "research_group", groupId: "research_group" },
      workflowRevision: 1,
      activationRequestId: "activate_1",
      inputSnapshotRef: "messages/input.json",
      activatedByAgentId: "main",
      status: "running"
    };
    const executions: MemberExecution[] = ["a", "b"].map((agentId, index) => ({
      id: `exec_${agentId}`,
      nodeRunId: nodeRun.id,
      groupRunId: "gr_1",
      taskId: `task_${agentId}`,
      agentId,
      purpose: "delivery",
      ownershipEpoch: 1,
      status: index === 0 ? "working" : "waiting_review",
      executionBranch: `executions/exec_${agentId}`,
      worktreePath: `git-worktrees/exec_${agentId}`
    }));
    const git: ProjectGitState = {
      enabled: true,
      status: "ready",
      provider: "github",
      repository: {
        owner: "example-user",
        name: "typed-collaboration",
        htmlUrl: "https://github.com/example-user/typed-collaboration",
        private: true,
        defaultBranch: "main",
        localPath: "repository"
      },
      branches: [{
        name: "executions/exec_a",
        head: "a".repeat(40),
        base: "groups/gr_1",
        ownerExecutionId: "exec_a",
        worktreePath: "git-worktrees/exec_a",
        status: "retained",
        retained: true
      }],
      blockers: [],
      capacity: { retainedWorktreeCount: 2, warningThreshold: 100 }
    };
    const pullRequest: PullRequestRecord = {
      id: "pr_exec_a",
      providerNumber: 7,
      htmlUrl: "https://github.com/example-user/typed-collaboration/pull/7",
      head: "executions/exec_a",
      base: "groups/gr_1",
      ownerExecutionId: "exec_a",
      status: "open",
      headSha: "a".repeat(40),
      mergeable: false,
      conflictPaths: ["result.md"],
      blockers: ["Owner must resolve the conflict"],
      checks: [{
        id: 11,
        name: "external-rule",
        status: "completed",
        conclusion: "failure",
        observedAt: "2026-09-22T00:00:00.000Z"
      }],
      reconciliation: { status: "observed", observedAt: "2026-09-22T00:00:00.000Z" },
      observedAt: "2026-09-22T00:00:00.000Z"
    };
    const event: AgentEvent = {
      eventId: "evt_1",
      requestId: "request_1",
      seq: 1,
      projectId: "prj_1",
      workflowRevision: 1,
      nodeId: "research_group",
      nodeRunId: nodeRun.id,
      groupRunId: "gr_1",
      agentId: "b",
      taskId: "task_b",
      executionId: "exec_b",
      invocationId: "inv_b",
      ownershipEpoch: 1,
      coordinatorEpoch: 1,
      type: "execution.status",
      message: "waiting for review",
      ts: "2026-09-22T00:00:00.000Z"
    };

    expect(createInput.orchestration?.collaborations?.[0]?.memberAgentIds).toEqual(["a", "b"]);
    expect(executions.map((execution) => execution.id)).toEqual(["exec_a", "exec_b"]);
    expect(new Set(executions.map((execution) => execution.id))).toHaveLength(2);
    expect(git.repository?.private).toBe(true);
    expect(pullRequest.conflictPaths).toEqual(["result.md"]);
    expect(event.executionId).toBe("exec_b");
  });
});
