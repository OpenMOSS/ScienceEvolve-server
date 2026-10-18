import type { Project } from "./types";
import {
  currentScopedGroupRun,
  scopedGroupDisplayState,
  scopedNodeDisplayState
} from "../../server/src/internal/shared/project-runtime-status.js";

/** Keep the v3 public facts at the API boundary; never borrow legacy flat executions. */
export function normalizeScopedRuntime(data: Record<string, unknown>) {
  const records = <T,>(value: unknown, required: string[], fields: string[]): T[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const raw = value as Record<string, unknown>;
      if (required.some((key) => typeof raw[key] !== "string" || !(raw[key] as string).trim())) return [];
      const record = Object.fromEntries(fields.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
      for (const key of ["sequence", "ownershipEpoch", "coordinatorEpoch", "workflowRevision"]) {
        if (fields.includes(key) && (!Number.isSafeInteger(record[key]) || Number(record[key]) < (key === "ownershipEpoch" ? 1 : 0))) return [];
      }
      return [record as T];
    });
  };
  return {
    scopedGroupRuns: records<NonNullable<Project["scopedGroupRuns"]>[number]>(data.scopedGroupRuns,
      ["id", "groupId", "status", "activationRequestId"],
      ["id", "projectId", "groupId", "parentGroupRunId", "parentArrivalRequestId", "activationRequestId", "workflowRevision", "leaderAgentId", "baseCommit", "groupBranch", "integrationTarget", "status"]),
    scopedArrivals: records<NonNullable<Project["scopedArrivals"]>[number]>(data.scopedArrivals,
      ["requestId", "groupRunId", "targetNodeId", "status"],
      ["sequence", "requestId", "groupRunId", "sourceRunId", "targetNodeId", "targetKind", "agentId", "childGroupId", "status", "pathContext"]),
    scopedExecutions: records<NonNullable<Project["scopedExecutions"]>[number]>(data.scopedExecutions,
      ["id", "groupRunId", "arrivalRequestId", "agentId", "status"],
      ["id", "projectId", "groupRunId", "arrivalRequestId", "agentId", "ownershipEpoch", "executionBranch", "worktreePath", "status"]),
    scopedGroupIssues: records<NonNullable<Project["scopedGroupIssues"]>[number]>(data.scopedGroupIssues,
      ["id", "groupRunId", "kind", "arrivalRequestId"],
      ["id", "groupRunId", "kind", "sequence", "arrivalRequestId", "reason", "finalOwnershipEpoch"]),
    scopedManagementTurns: records<NonNullable<Project["scopedManagementTurns"]>[number]>(data.scopedManagementTurns,
      ["groupRunId", "agentId", "invocationId", "status"],
      ["projectId", "groupRunId", "agentId", "invocationId", "coordinatorEpoch", "status", "runtimePath"]),
    scopedAgentReports: records<NonNullable<Project["scopedAgentReports"]>[number]>(data.scopedAgentReports,
      ["executionId", "invocationId"],
      ["projectId", "executionId", "ownershipEpoch", "invocationId", "output", "selectedWeakTarget", "headSha", "recordedAt", "headRecordedAt"]),
    scopedFinalIntegrations: records<NonNullable<Project["scopedFinalIntegrations"]>[number]>(data.scopedFinalIntegrations,
      ["id", "groupRunId", "status"],
      ["id", "projectId", "groupRunId", "ownershipEpoch", "executionBranch", "integrationTarget", "expectedHeadSha", "status"]),
    scopedAgentMerges: records<NonNullable<Project["scopedAgentMerges"]>[number]>(data.scopedAgentMerges,
      ["arrivalRequestId", "executionId", "groupRunId"],
      ["arrivalRequestId", "executionId", "groupRunId", "pullRequest", "synchronization", "recordedAt"]),
    scopedGroupFinalMerges: records<NonNullable<Project["scopedGroupFinalMerges"]>[number]>(data.scopedGroupFinalMerges,
      ["groupRunId"], ["groupRunId", "pullRequest", "synchronization", "recordedAt"])
  };
}

/** Flatten nested workers for the roster while preserving the scope of each node reference. */
export function scopedRosterMembers(project: Project, groupId: string, visited = new Set<string>()): Array<{
  key: string; agentId: string; scopeLabel: string; executionCount: number; state: ReturnType<typeof scopedNodeDisplayState>;
}> {
  if (visited.has(groupId)) return [];
  visited.add(groupId);
  const group = project.orchestration.scopedWorkflow?.groups.find((entry) => entry.id === groupId);
  const run = currentScopedGroupRun(project, groupId);
  return group?.workflow.nodes.flatMap((node) => node.kind === "collaboration"
    ? scopedRosterMembers(project, node.groupId, visited)
    : [{ key: `${groupId}:${node.nodeId}`, agentId: node.agentId,
        scopeLabel: project.orchestration.collaborations?.find((entry) => entry.id === groupId)?.displayName ?? groupId,
        executionCount: new Set((project.scopedExecutions ?? []).filter((execution) => execution.groupRunId === run?.id &&
          (project.scopedArrivals ?? []).some((arrival) => arrival.requestId === execution.arrivalRequestId && arrival.targetNodeId === node.nodeId))
          .map((execution) => execution.arrivalRequestId)).size,
        state: scopedNodeDisplayState(project, groupId, node.nodeId) }]) ?? [];
}

export { currentScopedGroupRun, scopedGroupDisplayState, scopedNodeDisplayState };
