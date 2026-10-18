import type { AgentRunRequest, WorktreeClosingScope } from "../types.js";
import { restrictedClosingPaths } from "../collaboration-git/restricted-worktree-closing.js";

const SCOPE_FIELDS = ["kind", "reportHeadSha", "paths", "executionId", "ownershipEpoch", "grantInvocationId", "grantCallId"];
const identifier = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);

export function isWorktreeClosingScope(value: unknown, agentId: string): value is WorktreeClosingScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as WorktreeClosingScope;
  if (Object.keys(scope).length !== SCOPE_FIELDS.length || Object.keys(scope).some(key => !SCOPE_FIELDS.includes(key)) ||
    !identifier(scope.executionId) || !identifier(scope.grantInvocationId) || !identifier(scope.grantCallId) ||
    !Number.isSafeInteger(scope.ownershipEpoch) || scope.ownershipEpoch < 1 || typeof scope.reportHeadSha !== "string") return false;
  try { restrictedClosingPaths({ agentId }, scope); return true; } catch { return false; }
}

export function assertWorktreeClosingRequest(request: AgentRunRequest, sameEpochReopen: unknown): void {
  if (request.worktreeClosing === undefined) return;
  const context = request.executionContext;
  if (!isWorktreeClosingScope(request.worktreeClosing, request.agent) || context?.role !== "delivery" ||
    request.worktreeClosing.executionId !== context.executionId || request.worktreeClosing.ownershipEpoch !== context.ownershipEpoch ||
    request.kind !== "worker" || request.agent === "main" || request.project.git?.enabled !== true ||
    request.project.orchestration.schemaVersion !== 3 || !context.groupRunId || request.project.status === "completed" ||
    request.sessionContinuity !== "strict" || request.project.agentSessions?.[request.agent]?.durable !== true ||
    !sameEpochReopen || request.terminalPushObservation !== undefined || request.terminalPushCoordination !== undefined ||
    request.terminalControlRepair !== undefined || request.siiMcp !== undefined || request.siiResumePrompt !== undefined) {
    throw new Error("Worktree closing requires its exact original durable scoped delivery session and retained grant");
  }
}

export function assertWorktreeClosingControl(context: {
  agent: string; worktreeClosing?: unknown; terminalPushObservation?: unknown; terminalPushCoordination?: unknown;
  kind: string; candidates: readonly string[]; decisionBy: string; allowAgentGitActions?: boolean;
  allowUserIntervention: boolean; canComplete: boolean; requireBridge?: boolean; collaboration?: unknown;
  mainCapabilities?: unknown; canonicalFinalIntegration?: boolean; scopedAgentRouting?: boolean;
  allowFinishRoute?: boolean; allowWorkflowReconfiguration?: boolean; allowAgentOrchestrationReconfiguration?: boolean;
  workflowAuthoringPath?: string; tasklessRouteTargets?: readonly string[];
}): void {
  if (context.worktreeClosing === undefined) return;
  if (!isWorktreeClosingScope(context.worktreeClosing, context.agent) || context.agent === "main" ||
    context.terminalPushObservation !== undefined || context.terminalPushCoordination !== undefined ||
    context.kind !== "worker" || context.decisionBy !== "agent" || context.allowAgentGitActions !== true ||
    context.requireBridge !== true || context.candidates.length || context.tasklessRouteTargets?.length ||
    context.allowUserIntervention || context.canComplete || context.collaboration !== undefined || context.mainCapabilities !== undefined ||
    context.canonicalFinalIntegration || context.scopedAgentRouting || context.allowFinishRoute || context.allowWorkflowReconfiguration ||
    context.allowAgentOrchestrationReconfiguration || context.workflowAuthoringPath !== undefined) {
    throw new Error("Worktree closing requires an exact manifest-only Worker control scope");
  }
}

export function worktreeClosingActionAllowed(action: { tool: string; reason?: unknown; historical?: unknown }): boolean {
  if (action.tool === "git_push") return typeof action.reason === "string" && Boolean(action.reason.trim()) && action.reason.length <= 8192;
  if (action.tool === "git_reconcile_push") return action.historical === undefined || action.historical === false;
  return ["finish_task", "git_get_operation", "github_create_pr", "github_get_pr", "github_merge_pr", "github_close_pr"].includes(action.tool);
}
