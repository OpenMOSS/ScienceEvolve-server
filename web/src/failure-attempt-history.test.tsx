import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { normalizeProject } from "./lib";
import { FailureAttemptHistory } from "./components/workflow-canvas/CollaborationActivityFeed";
import { buildFailureAttemptTimeline } from "./components/workflow-canvas/core/collaboration-activity";

const failure = { attemptId: "original", projectId: "project", scope: "control", operation: "publish_artifact", status: "failed",
  errorCode: "ARTIFACT_INVALID", retryable: false, redactedMessage: "Original artifact was unavailable", causeClass: "Error",
  agentId: "writing", executionId: "execution-a", ownershipEpoch: 1, taskId: "task-a", groupRunId: "group-a", nodeRunId: "node-a", coordinatorEpoch: 2,
  startedAt: "2026-11-09T00:00:00Z", finishedAt: "2026-11-09T00:00:01Z", metadata: { callId: "original-call" } };

describe("historical failure display", () => {
  it("preserves backend ownership and does not call another task's success a retry or a recovery", () => {
    const project = normalizeProject({ id: "project", title: "Finished research", status: "completed", failureAttempts: [failure,
      { ...failure, attemptId: "other", executionId: "execution-b", status: "succeeded", finishedAt: "2026-11-09T00:00:02Z" }] });
    expect(project.failureAttempts?.[0]).toMatchObject({ taskId: "task-a", executionId: "execution-a", groupRunId: "group-a", nodeRunId: "node-a", coordinatorEpoch: 2 });
    expect(project.failureSummary?.unresolvedFailures).toBe(1);
    expect(buildFailureAttemptTimeline(project)[1]).toMatchObject({ retry: false, ordinal: 1 });
    render(<FailureAttemptHistory project={project} />);
    expect(screen.getByText("历史失败，尚未确认解决")).toBeInTheDocument();
    expect(screen.queryByText("当前阻塞")).not.toBeInTheDocument();
  });

  it("shows confirmed follow-up only for the explicitly referenced original failure", () => {
    const project = normalizeProject({ id: "project", title: "Finished research", status: "completed", failureAttempts: [failure,
      { ...failure, attemptId: "confirmed", status: "succeeded", metadata: { callId: "follow-up", resolvedAttemptId: failure.attemptId }, finishedAt: "2026-11-09T00:00:02Z" }] });
    expect(project.failureSummary?.unresolvedFailures).toBe(0);
    expect(buildFailureAttemptTimeline(project)[0]?.resolution).toBe("resolved");
    render(<FailureAttemptHistory project={project} />);
    expect(screen.getByText("已确认后续成功")).toBeInTheDocument();
  });
});
