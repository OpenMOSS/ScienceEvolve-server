import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION } from "../../../lib";
import type { AgentEvent, Project } from "../../../types";
import { buildExecutionPreview, previewText } from "./execution-preview";
import { buildWorkflowRuntimeState } from "./workflow-runtime";

const project = {
  id: "preview", requirement: "研究任务原文", status: "running", currentAgent: "idea",
  orchestration: DEFAULT_AGENT_ORCHESTRATION, agentProgress: {}, cycle: 1
} as Project;
const event = (seq: number, type: string, agent: string, data: Record<string, unknown> = {}): AgentEvent => ({
  seq, type, agent, data, message: "", ts: "2026-09-20T10:00:00Z"
});

describe("execution preview", () => {
  it("keeps repeated calls distinct, merges duplicate starts, and attaches each original output to its invocation", () => {
    const events = [
      event(1, "invocation.started", "idea", { invocationId: "inv_first" }),
      event(2, "agent.started", "idea", { invocationId: "inv_first" }),
      event(3, "handoff.saved", "idea", { invocationId: "inv_first", excerpt: "# 原文\n第一轮结论" }),
      event(4, "agent.completed", "idea", { invocationId: "inv_first" }),
      event(5, "route.queued", "main", { sourceAgent: "idea", sourceInvocationId: "inv_first" }),
      event(6, "agent.started", "main", { invocationId: "inv_main" }),
      event(7, "agent.completed", "main", { invocationId: "inv_main" }),
      event(8, "main.assignment.committed", "main", { invocationId: "inv_main", nextAgent: "idea", message: "继续验证", rationale: "证据不足" }),
      event(9, "route.queued", "idea", { sourceAgent: "main", sourceInvocationId: "inv_main" }),
      event(10, "agent.started", "idea", { invocationId: "inv_second" })
    ];
    const steps = buildExecutionPreview(project, [...events].reverse(), buildWorkflowRuntimeState(project, events));
    expect(steps.map((step) => step.kind)).toEqual(["input", "agent", "route", "agent", "route", "agent"]);
    const calls = steps.filter((step) => step.kind === "agent");
    expect(calls.map((step) => step.state)).toEqual(["completed", "completed", "running"]);
    expect(calls[0].output).toBe("# 原文\n第一轮结论");
    expect(calls[2].output).toBeUndefined();
    expect(steps[4]).toMatchObject({ source: "main", target: "idea", text: "继续验证", rationale: "证据不足" });
  });

  it("does not call a queued or paused agent running and retains failure evidence", () => {
    const events = [event(1, "agent.started", "idea", { invocationId: "inv_first" }), event(2, "agent.failed", "idea", { invocationId: "inv_first" }), event(3, "route.queued", "main", { sourceAgent: "idea" })];
    const queued = { ...project, status: "queued", currentAgent: undefined, queuedAgent: "main" } as Project;
    const steps = buildExecutionPreview(queued, events, buildWorkflowRuntimeState(queued, events));
    expect(steps.find((step) => step.kind === "agent")?.state).toBe("failed");
    expect(steps.some((step) => step.state === "running")).toBe(false);
    const paused = { ...project, status: "paused" } as Project;
    expect(buildExecutionPreview(paused, events.slice(0, 1), buildWorkflowRuntimeState(paused, events.slice(0, 1)))[1].state).toBe("paused");
  });

  it("limits original text to 1000 Unicode characters without rewriting or splitting an emoji", () => {
    const original = "# 原文\n" + "中".repeat(994) + "🧪" + "不能展示";
    expect(previewText(original)).toBe("# 原文\n" + "中".repeat(994) + "🧪");
    expect(Array.from(previewText(original))).toHaveLength(1000);
  });

  it("attributes a sparse merged-PR event to its Agent and exposes the major collaboration action", () => {
    const collaborationProject = {
      ...project,
      orchestration: {
        schemaVersion: 2,
        agents: [{ name: "main", template: "main" }, { name: "structure", template: "idea" }],
        collaborations: [{ id: "delivery", displayName: "Delivery", memberAgentIds: ["structure"], renamePolicy: "editable" }],
        input: { source: "input", target: "delivery" },
        routes: { main: [{ target: "delivery", kind: "weak" }], delivery: [{ target: "finish", kind: "strong" }] },
        decisionPlans: {},
        allowUserIntervention: true,
        termination: { agent: "delivery", condition: "Merged", decisionBy: "main", automatic: true }
      },
      nodeRuns: [{
        id: "node-run", node: { kind: "collaboration", nodeId: "delivery", groupId: "delivery" },
        workflowRevision: 1, activationRequestId: "activation", inputSnapshotRef: "snapshot", status: "completed"
      }],
      groupRuns: [{
        id: "group-run", nodeRunId: "node-run", memberSnapshot: ["structure"], leaderAgentId: "structure",
        coordinatorEpoch: 1, baseCommit: "1".repeat(40), groupBranch: "groups/group-run", integrationTarget: "main",
        integrationOwnerExecutionId: "execution", finalPullRequestId: "pull", taskIds: ["task"], status: "completed"
      }],
      tasks: [{
        id: "task", nodeRunId: "node-run", groupRunId: "group-run", assignment: "整理项目结构",
        assigneeAgentId: "structure", dependencyTaskIds: [], queueOrdinal: 1, currentExecutionId: "execution", status: "succeeded"
      }],
      executions: [{
        id: "execution", nodeRunId: "node-run", groupRunId: "group-run", taskId: "task", agentId: "structure",
        purpose: "final-integration", ownershipEpoch: 1, status: "succeeded", executionBranch: "groups/group-run",
        worktreePath: "hidden", pullRequestId: "pull"
      }],
      pullRequests: [{
        id: "pull", providerNumber: 3, htmlUrl: "https://github.example.test/pull/3", head: "groups/group-run", base: "main",
        ownerExecutionId: "execution", status: "merged", mergeCommitSha: "3".repeat(40), observedAt: "2026-09-20T10:00:03Z"
      }]
    } as unknown as Project;
    const sparseEvent = event(12, "pull.request.observed", "", {
      sourceType: "pull_request.merged",
      pullRequestId: "pull"
    });
    const steps = buildExecutionPreview(
      collaborationProject,
      [sparseEvent],
      buildWorkflowRuntimeState(collaborationProject, [sparseEvent])
    );
    expect(steps.find((step) => step.kind === "merge")).toMatchObject({
      agent: "structure",
      heading: "PR #3 已合入 main",
      pullRequestNumber: 3,
      url: "https://github.example.test/pull/3",
      source: "groups/group-run",
      target: "main"
    });
  });
});
