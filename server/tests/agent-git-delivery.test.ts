import { describe, expect, it } from "vitest";
import { agentGitDeliveryStatus, agentGitFactsSynchronized } from "../src/agent-git-delivery.js";
import type { AgentGitFacts } from "../src/agent-git-tools.js";
import { agentGitResultSummary, agentGitResultText } from "../src/agent-git-result.js";
import type { OperationRecord } from "../src/types.js";

const head = "a".repeat(40);
const oldPush: OperationRecord = { id: "first-push", kind: "git.push", status: "uncertain",
  ownerExecutionId: "worker", ownershipEpoch: 1, payloadHash: "b".repeat(64), expectedHead: head,
  expectedBase: "executions/worker" };
const input = { executionId: "worker", ownershipEpoch: 1, headSha: head,
  pull: { ownerExecutionId: "worker", headSha: head, status: "merged" as const, mergeCommitSha: "c".repeat(40) },
  synchronized: true, operations: [oldPush, { ...oldPush, id: "second-push", status: "finalized" as const }] };

describe("Git delivery readiness", () => {
  it.each(["same", "another-pr", "another-merge", "another-target", "missing-sync"] as const)(
    "uses the same exact local synchronization gate for the scheduler, MCP and shared state (%s)", kind => {
      const merged = { ...input.pull, id: "original-pr", providerNumber: 1, base: "main",
        localSynchronization: { targetBranch: "main", expectedSourceHead: head, mergeCommitSha: input.pull.mergeCommitSha,
          remoteHead: input.pull.mergeCommitSha, localHeadAfter: input.pull.mergeCommitSha, status: "synchronized" } };
      const facts = { pushedHeadSha: head, pullRequest: { ...merged }, merged: structuredClone(merged) } as AgentGitFacts;
      if (kind === "another-pr") facts.pullRequest!.id = "second-pr-at-the-same-head";
      if (kind === "another-merge") facts.pullRequest!.mergeCommitSha = "d".repeat(40);
      if (kind === "another-target") facts.merged!.localSynchronization.targetBranch = "groups/other";
      if (kind === "missing-sync") delete (facts.merged as any).localSynchronization;
      const synchronized = agentGitFactsSynchronized(facts, "main");
      expect(synchronized).toBe(kind === "same");
      expect(agentGitDeliveryStatus({ ...input, pull: facts.pullRequest, synchronized, operations: [] }).ready).toBe(kind === "same");
    });

  it("keeps a finalized remote merge actionable until its local synchronization is recorded", () => {
    const operation: OperationRecord = { ...oldPush, id: "merge-original", kind: "pull.merge", status: "finalized",
      expectedBase: "main", remoteFact: { status: "merged" } };
    const pending = agentGitDeliveryStatus({ ...input, synchronized: false, operations: [operation] });
    expect(pending.ready).toBe(false);
    expect(pending.unresolvedOperations).toMatchObject([{ operationId: "merge-original", status: "finalized",
      localStage: "synchronization_pending", nextAction: { tool: "git_get_operation", operationId: "merge-original" } }]);
    expect(pending.missingActions).toContain("github_merge_pr");
    expect(agentGitDeliveryStatus({ ...input, operations: [operation] }).ready).toBe(true);
    expect(agentGitDeliveryStatus({ ...input, synchronized: false, operations: [{ ...operation, ownershipEpoch: 0 }] }).unresolvedOperations).toEqual([]);
  });

  it("keeps the exact original push actionable after a later push and PR merge succeed", () => {
    const result = agentGitDeliveryStatus(input);
    expect(result.ready).toBe(false);
    expect(result.missingActions).toEqual(["git_reconcile_push for retained operationId=first-push"]);
    expect(result.unresolvedOperations).toEqual([expect.objectContaining({ operationId: "first-push",
      nextAction: { tool: "git_reconcile_push", operationId: "first-push", retry: false } })]);
    expect(input.operations[0].status).toBe("uncertain");
  });

  it.each(["finalized", "superseded"] as const)("accepts the original push only after a proven %s result", status => {
    expect(agentGitDeliveryStatus({ ...input, operations: [{ ...oldPush, status }] }).ready).toBe(true);
  });

  it("does not confuse missing PRs, local synchronization and another ownership epoch", () => {
    expect(agentGitDeliveryStatus({ ...input, pull: undefined, operations: [{ ...oldPush, ownershipEpoch: 2 }] }))
      .toMatchObject({ ready: false, missingActions: ["github_get_pr or github_create_pr", "github_merge_pr"], unresolvedOperations: [] });
    expect(agentGitDeliveryStatus({ ...input, synchronized: false, operations: [] }).missingActions).toEqual(["github_merge_pr"]);
    expect(agentGitDeliveryStatus({ ...input, pull: { ...input.pull, headSha: "d".repeat(40) }, operations: [] }).ready).toBe(false);
  });

  it.each(["not_committed", "push_unconfirmed", "unconfirmed", "outcome_unknown", "remote_success_local_pending"])(
    "reports %s without implying task completion", status => {
      const gitDelivery = agentGitDeliveryStatus(input);
      const result = { status, operation: oldPush, gitDelivery };
      expect(agentGitResultSummary("git_get_operation", result)).toMatchObject({ outcome: status,
        completesTask: false, gitDeliveryReady: false, observationOnly: true,
        nextActions: [{ tool: "git_reconcile_push", operationId: "first-push", retry: false }] });
      expect(agentGitResultText("git_get_operation", result)).toContain("does not reconcile or finalize");
    });
});
