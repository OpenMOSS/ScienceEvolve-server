import { describe, expect, it, vi } from "vitest";
import { executeAgentGitTool, type AgentGitFacts } from "../src/agent-git-tools.js";
import { GitCommandError, GitHubUncertainResultError, OperationPayloadMismatchError } from "../src/collaboration-git/errors.js";
import type { OperationRecord } from "../src/types.js";

function fixture() {
  const head = "a".repeat(40), merge = "b".repeat(40);
  const repository = { owner: "owner", name: "repo", private: true, defaultBranch: "main", htmlUrl: "https://github.com/owner/repo", observedAt: "2026-10-09T00:00:00Z" };
  const execution = { id: "original", agentId: "worker", ownershipEpoch: 2, purpose: "delivery" as const, executionBranch: "executions/original", worktreePath: "/tmp/original" };
  const base = "groups/parent", id = "agent-git-original-epoch-2-original-call-merge";
  const pull = { owner: repository.owner, repository: repository.name, ownerExecutionId: execution.id,
    id: "pull", providerNumber: 17, head: execution.executionBranch, headSha: head, base, status: "open" as const,
    htmlUrl: "https://github.com/owner/repo/pull/17", observedAt: repository.observedAt };
  const operation: OperationRecord = { id, kind: "pull.merge", status: "finalized", ownerExecutionId: execution.id,
    ownershipEpoch: 2, expectedHead: head, expectedBase: base, payloadHash: "c".repeat(64),
    remoteFact: { ...pull, status: "merged", mergeCommitSha: merge } };
  const error = new GitCommandError(1, "original local synchronization failure after the provider result");
  const mergePullRequest = vi.fn(async () => { throw error; });
  const git = { checkpointAndPush: vi.fn(), createPullRequest: vi.fn(), mergePullRequest,
    observePullRequest: vi.fn(async () => pull), observePullRequestForExecution: vi.fn(async () => pull) };
  const facts: AgentGitFacts = { pushedHeadSha: head };
  const input = { git, repository, execution, base, facts,
    envelope: { projectId: "project", agent: "worker", invocationId: "original-native", callId: "original-call",
      stateVersion: 2, receivedAt: repository.observedAt, action: { tool: "github_merge_pr" as const, providerNumber: 17 } },
    recordedOperation: vi.fn(() => operation) };
  return { input, operation, error, mergePullRequest, id };
}

describe("Known original Git result after an interrupted callback", () => {
  it("retains the exact remote merge and pending local synchronization without retrying", async () => {
    const f = fixture();
    await expect(executeAgentGitTool(f.input)).rejects.toMatchObject({ code: "GIT_OPERATION_RESULT_AVAILABLE",
      publicData: { operationId: f.id, status: "remote_success_local_pending", localStage: "synchronization_pending", reconcileRequired: true }, cause: f.error });
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(f.input.facts.merged).toBeUndefined();
    expect(f.operation.status).toBe("finalized");
    expect(await executeAgentGitTool({ ...f.input, envelope: { ...f.input.envelope, action: { tool: "git_get_operation", operationId: f.id } } }))
      .toMatchObject({ status: "remote_success_local_pending", operation: { remoteFact: { providerNumber: 17, status: "merged", mergeCommitSha: "b".repeat(40) } } });
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["observed", "finalized"] as const)("retains confirmed creation across %s callback failure", async status => {
    const f = fixture();
    f.operation.id = "agent-git-original-epoch-2-original-call-create";
    f.operation.kind = "pull.create"; f.operation.status = status; f.operation.remoteFact!.status = "open";
    f.input.git.createPullRequest.mockRejectedValue(f.error);
    await expect(executeAgentGitTool({ ...f.input, envelope: { ...f.input.envelope,
      action: { tool: "github_create_pr", base: f.input.base, title: "Original result", body: "Original body" } } }))
      .rejects.toMatchObject({ code: "GIT_OPERATION_RESULT_AVAILABLE", publicData: { operationId: f.operation.id,
        status: status === "finalized" ? "completed" : "remote_success_local_pending",
        localStage: status === "finalized" ? "not_required" : "journal_finalization_pending" } });
    expect(f.input.git.createPullRequest).toHaveBeenCalledTimes(1);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each(["unknown", "failed", "other_owner", "other_epoch", "other_head", "other_kind", "payload_mismatch", "no_dispatch"] as const)(
    "does not infer known success from %s", async variant => {
      const f = fixture(); let original: Error = f.error;
      if (variant === "unknown") { f.operation.status = "uncertain"; original = new GitHubUncertainResultError(f.id); }
      if (variant === "failed") f.operation.status = "failed";
      if (variant === "other_owner") f.operation.ownerExecutionId = "another-task";
      if (variant === "other_epoch") f.operation.ownershipEpoch = 1;
      if (variant === "other_head") f.operation.remoteFact!.headSha = "d".repeat(40);
      if (variant === "other_kind") f.operation.kind = "pull.create";
      if (variant === "payload_mismatch") original = new OperationPayloadMismatchError(f.id);
      f.mergePullRequest.mockRejectedValue(original);
      if (variant === "no_dispatch") f.input.git.observePullRequest.mockRejectedValue(original);
      if (["other_owner", "other_epoch", "other_kind"].includes(variant)) {
        await expect(executeAgentGitTool(f.input)).rejects.toThrow("Recorded Agent merge operation differs");
        expect(f.mergePullRequest).not.toHaveBeenCalled();
      } else await expect(executeAgentGitTool(f.input)).rejects.toBe(original);
      if (variant === "no_dispatch") expect(f.mergePullRequest).not.toHaveBeenCalled();
    });
});
