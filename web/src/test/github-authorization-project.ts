import type { Project } from "../types";

/** A recovery failure from the server version that only projected a generic wait. */
export function githubAuthorizationProject(base: Project): Project {
  const message = "GitHub credential could not be resolved";
  return { ...base, status: "retrying", phase: "collaboration:recovering", error: message,
    currentAgent: undefined, queuedAgent: undefined,
    git: { enabled: true, status: "ready", account: { id: "gha_test", login: "test-owner", providerUserId: 42 } },
    failureAttempts: [{ attemptId: "auth-1", projectId: base.id, operation: "workflow.recovery", status: "failed", scope: "git",
      errorCode: "GITHUB_WAITING_FOR_AUTHORIZATION", redactedMessage: message, retryable: true, causeClass: "GitHubAuthorizationError",
      startedAt: "2026-11-03T08:00:00Z", finishedAt: "2026-11-03T08:00:00Z", metadata: { provider: "github", status: 401 } }],
    failureSummary: undefined,
    runtime: { stateRevision: 3, status: "retrying", phase: "collaboration:recovering", executionCount: 2, activities: [],
      waiting: { kind: "recovery", reason: "等待恢复：协作组的最终集成尚未完成" } } };
}
