import type { CollaborationGitFacade } from "./collaboration-git/facade.js";
import type { GitExecutionAuthority } from "./collaboration-git/contracts.js";
import { redactTrace } from "./utils.js";

/** The system observes closing facts and wakes the original owner. Let the
 * Agent choose which owned files to deliver or discard; never do its work. */
export async function executionWorktreeClosingActions(
  git: Partial<Pick<CollaborationGitFacade, "observeExecutionWorktree">>,
  execution: GitExecutionAuthority, signal?: AbortSignal
): Promise<string[]> {
  if (!git.observeExecutionWorktree) throw new Error("Execution closing requires trusted worktree observation");
  const fact = await git.observeExecutionWorktree(execution, execution.ownershipEpoch, signal);
  if (fact.executionId !== execution.id || fact.ownershipEpoch !== execution.ownershipEpoch ||
    fact.branch !== execution.executionBranch || fact.worktreePath !== execution.worktreePath ||
    !Array.isArray(fact.pendingPaths) || fact.pendingPaths.some((file) => typeof file !== "string" || !file)) {
    throw new Error("Closing observation differs from the retained execution checkout");
  }
  if (!fact.pendingPaths.length) return [];
  // Persist one bounded missing-action entry under the existing repair budget.
  // The Agent can inspect the full path list with its normal Git/file tools.
  const files = redactTrace(JSON.stringify(fact.pendingPaths)).slice(0, 140);
  return [`Close ${fact.pendingPaths.length} pending worktree path(s): ${files}; inspect git_status, deliver required files or remove your disposable files`.slice(0, 256)];
}
