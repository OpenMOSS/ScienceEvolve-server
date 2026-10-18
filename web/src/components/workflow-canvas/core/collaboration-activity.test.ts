import { describe, expect, it } from "vitest";
import { normalizeProject } from "../../../lib";
import type { AgentEvent, Project } from "../../../types";
import {
  buildCollaborationActivities,
  buildFailureAttemptTimeline,
  collaborationExecutionState,
  collaborationProgress
} from "./collaboration-activity";

function projectFixture(): Project {
  return {
    id: "prj_activity",
    title: "协作活动",
    requirement: "test",
    status: "running",
    phase: "group:running",
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:05:00.000Z",
    turn: 1,
    cycle: 1,
    eventSeq: 4,
    consecutiveFailures: 0,
    completionGeneration: 0,
    controlProtocol: "natural-language-tools-v1",
    agentSessionIds: {},
    agentSessions: {},
    agentSessionMeta: {},
    mainContextSeq: 0,
    runCounts: { main: 0, alpha: 1, beta: 0 },
    executionCounts: { main: 0, alpha: 1, beta: 0 },
    userInputs: [],
    tokenUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, invocations: 0, accountingVersion: 3, threadUsageCursors: {}, byAgent: {} },
    configurationLocked: true,
    workerFailureCounts: {},
    agentFailureHistory: {},
    artifacts: [],
    git: { enabled: true, status: "ready", repository: { owner: "owner", name: "repo", htmlUrl: "https://github.com/owner/repo", private: true, defaultBranch: "main", localPath: "/tmp/repo" } },
    workflowRevision: 1,
    agents: {} as Project["agents"],
    orchestration: {
      schemaVersion: 2,
      agents: [{ name: "main" }, { name: "alpha" }, { name: "beta" }],
      collaborations: [{ id: "group", displayName: "协作组", memberAgentIds: ["alpha", "beta"], renamePolicy: "editable" }],
      input: { source: "input", target: "group" },
      routes: { main: [{ target: "group", kind: "weak" }], group: [{ target: "main", kind: "strong" }] },
      decisionPlans: { main: "route", group: "route" },
      allowUserIntervention: true,
      termination: { agent: "main", condition: "done", decisionBy: "main", automatic: false }
    },
    nodeRuns: [{ id: "node-1", node: { kind: "collaboration", nodeId: "group", groupId: "group" }, workflowRevision: 1, activationRequestId: "activate", inputSnapshotRef: "input", activatedByAgentId: "main", status: "running" }],
    groupRuns: [{ id: "group-run-1", nodeRunId: "node-1", memberSnapshot: ["alpha", "beta"], leaderAgentId: "main", coordinatorEpoch: 1, baseCommit: "a".repeat(40), groupBranch: "groups/group-run-1", integrationTarget: "main", taskIds: ["task-1"], status: "running" }],
    tasks: [{ id: "task-1", nodeRunId: "node-1", groupRunId: "group-run-1", assignment: "实现接口", assigneeAgentId: "alpha", dependencyTaskIds: [], queueOrdinal: 1, status: "succeeded" }],
    executions: [{ id: "execution-1", nodeRunId: "node-1", groupRunId: "group-run-1", taskId: "task-1", agentId: "alpha", purpose: "delivery", ownershipEpoch: 1, status: "succeeded", executionBranch: "executions/execution-1", worktreePath: "/private/worktree", pullRequestId: "pull-1", startedAt: "2026-09-24T10:01:00.000Z", completedAt: "2026-09-24T10:03:00.000Z" }],
    pullRequests: [{ id: "pull-1", providerNumber: 7, htmlUrl: "https://github.com/owner/repo/pull/7", head: "executions/execution-1", base: "groups/group-run-1", ownerExecutionId: "execution-1", status: "merged", mergeCommitSha: "b".repeat(40), observedAt: "2026-09-24T10:04:00.000Z" }],
    queueDepth: 0,
    agentProgress: {},
    overallProgress: { percent: 30, label: "running", estimated: true, successfulCalls: 1 }
  } as Project;
}

describe("collaboration activity projection", () => {
  it("never treats a recovering lease or an old ownership epoch as a current execution", () => {
    const project = projectFixture();
    const execution = project.executions![0]!;
    execution.status = "working";
    project.pullRequests = [];
    project.runtime = { stateRevision: 1, status: "running", phase: "recovering", executionCount: 1,
      executionId: execution.id, groupRunId: execution.groupRunId, leaseState: "recovering", activities: [] };
    expect(collaborationExecutionState(project, execution)).toBe("waiting");
    project.runtime.leaseState = "current";
    project.runtime.ownershipEpoch = execution.ownershipEpoch + 1;
    expect(collaborationExecutionState(project, execution)).toBe("waiting");
  });
  it("resolves sparse PR events back to the authoritative Agent execution", () => {
    const project = projectFixture();
    const events: AgentEvent[] = [{
      seq: 4,
      ts: "2026-09-24T10:04:00.000Z",
      type: "pull.request.observed",
      message: "Agent alpha 的 PR #7 已合入 groups/group-run-1",
      data: { sourceType: "pull_request.merged", pullRequestId: "pull-1", status: "merged" }
    }];
    const merged = buildCollaborationActivities(project, events)
      .find((activity) => activity.id === "pr:pull-1:merged");
    expect(merged).toMatchObject({
      kind: "merge",
      agentId: "alpha",
      groupRunId: "group-run-1",
      pullRequestNumber: 7,
      title: "PR #7 已合入协作组分支"
    });
  });

  it("projects stable task assignment and checkpoint commit actions without duplicates", () => {
    const project = projectFixture();
    const events: AgentEvent[] = [{
      seq: 2,
      ts: "2026-09-24T10:00:30.000Z",
      type: "collaboration.task.assigned",
      message: "协作任务已分配",
      data: { sourceType: "group.tasks.assigned", taskIds: ["task-1"], groupRunId: "group-run-1" }
    }, {
      seq: 3,
      ts: "2026-09-24T10:02:00.000Z",
      type: "collaboration.execution.updated",
      message: "Agent alpha 提交 commit cccccccc",
      data: {
        sourceType: "execution.checkpoint.committed",
        executionId: "execution-1",
        commitSha: "c".repeat(40)
      }
    }];
    const activities = buildCollaborationActivities(project, events);
    expect(activities.filter((activity) => activity.id === "task:task-1:assigned")).toHaveLength(1);
    expect(activities.find((activity) => activity.id === `commit:${"c".repeat(40)}`)).toMatchObject({
      kind: "commit",
      agentId: "alpha",
      groupRunId: "group-run-1",
      title: "alpha 提交 commit cccccccc",
      commitUrl: `https://github.com/owner/repo/commit/${"c".repeat(40)}`
    });
  });

  it("builds a concise per-member progress view without exposing worktree paths", () => {
    const project = projectFixture();
    const group = project.orchestration.collaborations![0]!;
    const progress = collaborationProgress(project, group);
    expect(progress.completedMembers).toBe(1);
    expect(progress.totalMembers).toBe(2);
    expect(progress.members[0]).toMatchObject({ agentId: "alpha", executionCount: 1, label: "已完成", durationLabel: "2 分钟", state: "completed" });
    expect(progress.members[1]).toMatchObject({ agentId: "beta", executionCount: 0, label: "等待分工", state: "waiting" });
  });

  it("uses the authoritative runtime projection and never leaves a paused group running", () => {
    const project = projectFixture();
    project.status = "paused";
    project.phase = "collaboration:user-paused";
    project.updatedAt = "2026-09-24T10:06:00.000Z";
    project.groupRuns![0]!.status = "running";
    project.executions![0]!.status = "working";
    project.pullRequests = [];
    project.runtime = {
      stateRevision: 18,
      status: "paused",
      phase: "collaboration:user-paused",
      groupRunId: "group-run-1",
      executionId: "execution-1",
      executionCount: 1,
      activities: []
    };
    const started: AgentEvent = {
      seq: 5,
      ts: "2026-09-24T10:01:00.000Z",
      type: "collaboration.execution.started",
      message: "alpha started",
      groupRunId: "group-run-1",
      executionId: "execution-1",
      agentId: "alpha"
    };
    const untouched = structuredClone(started);

    const progress = collaborationProgress(project, project.orchestration.collaborations![0]!);
    const activities = buildCollaborationActivities(project, [started]);

    expect(progress).toMatchObject({ state: "paused", phaseLabel: "协作组已暂停" });
    expect(progress.members[0]).toMatchObject({ state: "paused", label: "已暂停" });
    expect(activities.some((activity) => activity.state === "running")).toBe(false);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "pause", state: "paused", title: "协作组当前已暂停" })
    ]));
    expect(started).toEqual(untouched);
  });

  it("requires a matching C13 execution projection before showing a group as running", () => {
    const project = projectFixture();
    project.groupRuns![0]!.status = "running";
    project.executions![0]!.status = "working";
    project.pullRequests = [];
    project.runtime = {
      stateRevision: 19,
      status: "running",
      phase: "model:running",
      currentAgent: "main",
      nodeRunId: "unrelated-node",
      executionCount: 1,
      activities: []
    };
    const group = project.orchestration.collaborations![0]!;
    expect(collaborationProgress(project, group)).toMatchObject({
      state: "waiting",
      phaseLabel: "等待下一项协作活动"
    });

    project.runtime = {
      ...project.runtime,
      currentAgent: "alpha",
      nodeRunId: "node-1",
      groupRunId: "group-run-1",
      taskId: "task-1",
      executionId: "execution-1",
      activeInvocationId: "invocation-1"
    };
    expect(collaborationProgress(project, group)).toMatchObject({
      state: "running",
      phaseLabel: "2 个成员协作执行中"
    });
  });

  it("distinguishes all authoritative execution display states", () => {
    const project = projectFixture();
    const execution = project.executions![0]!;
    project.pullRequests = [];
    project.runtime = {
      stateRevision: 20,
      status: "running",
      phase: "model:running",
      groupRunId: execution.groupRunId,
      executionId: execution.id,
      executionCount: 1,
      activities: []
    };

    execution.status = "working";
    expect(collaborationExecutionState(project, execution)).toBe("running");
    project.runtime.status = "paused";
    expect(collaborationExecutionState(project, execution)).toBe("paused");
    execution.status = "stop_requested";
    expect(collaborationExecutionState(project, execution)).toBe("stopping");
    execution.status = "stopped";
    expect(collaborationExecutionState(project, execution)).toBe("stopped");
    execution.status = "superseded";
    expect(collaborationExecutionState(project, execution)).toBe("superseded");
    execution.status = "failed";
    expect(collaborationExecutionState(project, execution)).toBe("failed");
    execution.status = "succeeded";
    expect(collaborationExecutionState(project, execution)).toBe("completed");
  });

  it("records PR submission, merge failure and pause as major actions", () => {
    const project = projectFixture();
    project.pullRequests = [{
      ...project.pullRequests![0]!,
      status: "open"
    }, {
      ...project.pullRequests![0]!,
      id: "pull-conflict",
      providerNumber: 8,
      status: "conflicted"
    }];
    const events: AgentEvent[] = [{
      seq: 7,
      ts: "2026-09-24T10:04:00.000Z",
      type: "pull.request.updated",
      message: "PR submitted",
      data: { sourceType: "pull_request.created", pullRequestId: "pull-1" }
    }, {
      seq: 8,
      ts: "2026-09-24T10:04:30.000Z",
      type: "pull.request.updated",
      message: "PR conflicted",
      data: { sourceType: "pull_request.conflicted", pullRequestId: "pull-conflict" }
    }, {
      seq: 9,
      ts: "2026-09-24T10:05:00.000Z",
      type: "collaboration.group.updated",
      message: "all members paused",
      groupRunId: "group-run-1",
      data: { sourceType: "group.paused.all_members_failed" }
    }];

    const activities = buildCollaborationActivities(project, events);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "pull_request", title: "alpha 提交 PR #7", state: "completed" }),
      expect.objectContaining({ kind: "failure", title: "PR #8 合并受阻", state: "failed" }),
      expect.objectContaining({ kind: "pause", title: "协作组已暂停", state: "paused" })
    ]));
  });

  it("keeps every durable failure attempt in chronological retry order", () => {
    const raw = projectFixture();
    const project = normalizeProject({
      ...raw,
      failureAttempts: [{
        attemptId: "attempt-git-2",
        projectId: raw.id,
        scope: "git",
        operation: "initialization",
        status: "succeeded",
        errorCode: null,
        retryable: false,
        redactedMessage: "Git initialization succeeded",
        causeClass: "None",
        startedAt: "2026-09-24T10:02:30.000Z",
        finishedAt: "2026-09-24T10:03:00.000Z",
        metadata: { attempt: 2 }
      }, {
        attemptId: "attempt-git-1",
        projectId: raw.id,
        scope: "git",
        operation: "initialization",
        status: "failed",
        errorCode: "GITHUB_PROVIDER_FAILED",
        retryable: true,
        redactedMessage: "provider rejected [REDACTED]",
        causeClass: "GitHubProviderError",
        agentId: "main",
        invocationId: "invocation-git-1",
        ownershipEpoch: 1,
        startedAt: "2026-09-24T10:01:00.000Z",
        finishedAt: "2026-09-24T10:02:00.000Z",
        metadata: { authorization: "[REDACTED]" }
      }],
      failureSummary: {
        currentStatus: "failed",
        totalAttempts: 2,
        failedAttempts: 1,
        succeededAttempts: 1,
        unresolvedFailures: 1,
        operations: [{
          scope: "git",
          operation: "initialization",
          status: "succeeded",
          attemptId: "attempt-git-2",
          attemptCount: 2,
          failureCount: 1,
          startedAt: "2026-09-24T10:02:30.000Z",
          finishedAt: "2026-09-24T10:03:00.000Z",
          lastFailureAt: "2026-09-24T10:02:00.000Z",
          lastSuccessAt: "2026-09-24T10:03:00.000Z"
        }]
      }
    });

    const timeline = buildFailureAttemptTimeline(project);
    expect(timeline).toHaveLength(2);
    expect(timeline.map((item) => item.attempt.attemptId)).toEqual([
      "attempt-git-1",
      "attempt-git-2"
    ]);
    expect(timeline[0]).toMatchObject({
      ordinal: 1,
      retry: false,
      title: "Git 尝试失败",
      attempt: { redactedMessage: "provider rejected [REDACTED]" }
    });
    expect(timeline[1]).toMatchObject({
      ordinal: 2,
      retry: true,
      title: "Git 重试成功"
    });
    expect(project.failureSummary).toMatchObject({
      currentStatus: "healthy",
      totalAttempts: 2,
      unresolvedFailures: 0,
      latestFailure: { attemptId: "attempt-git-1" },
      operations: [{
        status: "succeeded",
        attemptId: "attempt-git-2",
        attemptCount: 2,
        failureCount: 1
      }]
    });
  });
});
