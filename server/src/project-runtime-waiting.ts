import type { ProjectSchedulingProjection } from "./collaboration-state/contracts.js";
import type { ProjectRuntimeProjection } from "./types.js";

/** Describe retained facts without admitting work or choosing a recovery. */
export function scopedProjectWaiting(projection: ProjectSchedulingProjection, rootGroupRunId: string): ProjectRuntimeProjection["waiting"] {
  const groups = new Map(projection.scopedGroupRuns?.map(group => [group.id, group]));
  const belongsToRoot = (groupRunId: string): boolean => {
    const seen = new Set<string>();
    let group = groups.get(groupRunId);
    while (group && !seen.has(group.id)) {
      if (["cancelled", "failed"].includes(group.status)) return false;
      if (group.id === rootGroupRunId) return true;
      seen.add(group.id);
      group = group.parentGroupRunId ? groups.get(group.parentGroupRunId) : undefined;
    }
    return false;
  };
  const issue = projection.scopedGroupIssues?.find(issue => belongsToRoot(issue.groupRunId) &&
    (groups.get(issue.groupRunId)?.status !== "completed" || issue.kind === "worktree-closing"));
  if (!issue) return undefined;
  const execution = projection.scopedExecutions?.find(execution => execution.id === issue.executionId);
  const group = groups.get(issue.groupRunId)!;
  const agentId = execution?.agentId ?? group.leaderAgentId;
  const operation = projection.pendingGitOperations?.find(operation => issue.operationId === operation.id ||
    Boolean(execution && operation.ownerExecutionId === execution.id && operation.ownershipEpoch === execution.ownershipEpoch));
  const operationId = operation?.id;
  const reason = operation ? `等待恢复：${agentId} 的 Git 操作结果待确认`
    : issue.kind === "worktree-closing" ? `等待恢复：${agentId} 的工作区尚未完成收尾`
      : issue.kind === "mechanism" ? `等待恢复：${agentId} 的交付步骤尚未完成`
        : issue.kind === "final" ? `等待恢复：协作组 ${group.groupId} 的最终集成尚未完成`
          : issue.kind === "terminal-push" ? `等待恢复：${agentId} 的 Git 提交回执尚未完成`
            : `等待恢复：协作组 ${group.groupId} 的管理步骤尚未完成`;
  return { kind: "recovery", reason, agentId, groupRunId: group.id,
    ...(execution ? { executionId: execution.id } : {}), ...(operationId ? { operationId } : {}) };
}
