import type { OperationRecord } from "./types.js";
import type { GitHubPullRequestFact } from "./collaboration-git/contracts.js";
import type { AgentGitFacts } from "./agent-git-tools.js";

/** The live MCP, delivery scheduler and shared state must agree on the
 * exact current PR and local proof, including a second PR at the same head. */
export function agentGitFactsSynchronized(facts: AgentGitFacts, expectedBase?: string): boolean {
  const pull = facts.pullRequest, merged = facts.merged, sync = merged?.localSynchronization;
  return Boolean(pull?.status === "merged" && merged?.status === "merged" && sync &&
    pull.id === merged.id && pull.providerNumber === merged.providerNumber &&
    pull.headSha === facts.pushedHeadSha && merged.headSha === facts.pushedHeadSha &&
    pull.base === merged.base && (expectedBase === undefined || pull.base === expectedBase) &&
    pull.mergeCommitSha && pull.mergeCommitSha === merged.mergeCommitSha &&
    sync.targetBranch === pull.base && sync.expectedSourceHead === pull.headSha &&
    sync.mergeCommitSha === pull.mergeCommitSha && sync.remoteHead === sync.localHeadAfter &&
    ["synchronized", "already_synchronized"].includes(sync.status));
}

export interface UnsettledAgentGitOperation {
  operationId: string;
  kind: OperationRecord["kind"];
  status: OperationRecord["status"];
  expectedHead?: string;
  expectedBase?: string;
  localStage?: "synchronization_pending";
  nextAction: { tool: "git_reconcile_push" | "git_get_operation"; operationId: string; retry?: false };
  instruction: string;
}

export function unsettledAgentGitOperations(operations: readonly OperationRecord[], executionId: string,
  ownershipEpoch: number): UnsettledAgentGitOperation[] {
  return operations.filter(operation => operation.ownerExecutionId === executionId &&
    operation.ownershipEpoch === ownershipEpoch && ["prepared", "observed", "uncertain"].includes(operation.status))
    .map(operation => ({ operationId: operation.id, kind: operation.kind, status: operation.status,
      ...(operation.expectedHead ? { expectedHead: operation.expectedHead } : {}),
      ...(operation.expectedBase ? { expectedBase: operation.expectedBase } : {}),
      instruction: operation.kind === "git.push"
        ? "Observe this original push with retry=false; inspect its actual result before deciding whether to resend its original commit."
        : "Read the original request and explicitly reconcile it using its original callId and arguments; a journal query alone does not settle it.",
      nextAction: operation.kind === "git.push"
        ? { tool: "git_reconcile_push" as const, operationId: operation.id, retry: false as const }
        : { tool: "git_get_operation" as const, operationId: operation.id } }));
}

export interface AgentGitDeliveryStatus {
  ready: boolean;
  headSha?: string;
  missingActions: string[];
  unresolvedOperations: UnsettledAgentGitOperation[];
}

/** One Git gate for live tool results, retained-session repair and delivery.
 * This describes Git readiness only; finish_task and routing remain separate.
 * Reading it never chooses a retry or changes an operation's recorded outcome. */
export function agentGitDeliveryStatus(input: {
  executionId: string; ownershipEpoch: number; headSha?: string;
  pull?: Pick<GitHubPullRequestFact, "ownerExecutionId" | "status" | "mergeCommitSha"> & { headSha?: string }; synchronized: boolean;
  operations: readonly OperationRecord[]; requirePullRequest?: boolean;
  worktreeMissingActions?: string[];
}): AgentGitDeliveryStatus {
  const unresolvedOperations = unsettledAgentGitOperations(input.operations, input.executionId, input.ownershipEpoch);
  if (!input.synchronized) {
    for (const operation of input.operations) {
      if (operation.ownerExecutionId !== input.executionId || operation.ownershipEpoch !== input.ownershipEpoch ||
        operation.kind !== "pull.merge" || operation.status !== "finalized" ||
        operation.expectedHead !== input.headSha || operation.remoteFact?.status !== "merged") continue;
      unresolvedOperations.push({ operationId: operation.id, kind: operation.kind, status: operation.status,
        expectedHead: operation.expectedHead, expectedBase: operation.expectedBase,
        localStage: "synchronization_pending", nextAction: { tool: "git_get_operation", operationId: operation.id },
        instruction: "The remote PR is merged, but local synchronization is still pending. Read the original request and replay github_merge_pr for this same PR to complete local synchronization; do not create another PR or repeat business work." });
    }
  }
  const pull = input.pull?.ownerExecutionId === input.executionId && input.pull.headSha === input.headSha ? input.pull : undefined;
  const missingActions = [!input.headSha && "git_push",
    input.requirePullRequest !== false && !pull && "github_get_pr or github_create_pr",
    input.requirePullRequest !== false && (!pull || pull.status !== "merged" || !pull.mergeCommitSha || !input.synchronized) && "github_merge_pr",
    ...unresolvedOperations.map(operation => `${operation.nextAction.tool} for retained operationId=${operation.operationId}` +
      (operation.kind === "git.push" ? "" : "; explicitly reconcile the original request with its original callId and arguments")),
    ...(input.worktreeMissingActions ?? [])].filter(Boolean) as string[];
  return { ready: missingActions.length === 0, ...(input.headSha ? { headSha: input.headSha } : {}),
    missingActions, unresolvedOperations };
}
