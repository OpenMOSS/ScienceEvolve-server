import type { TerminalPushCoordinationScope } from "../types.js";

export function isTerminalPushCoordinationScope(value: unknown): value is TerminalPushCoordinationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5 && typeof record.incidentId === "string" &&
    record.incidentId.trim() === record.incidentId && record.incidentId.length > 0 && record.incidentId.length <= 1024 &&
    !record.incidentId.includes("\0") && Number.isSafeInteger(record.coordinatorEpoch) && Number(record.coordinatorEpoch) >= 1 &&
    Number.isSafeInteger(record.level) && Number(record.level) >= 0 && (record.role === "leader" || record.role === "main") &&
    typeof record.canRequestUser === "boolean" && (record.role === "main" || record.canRequestUser === false);
}

/** The system supplies the original hierarchy, narrow tools and reliable
 * lifecycle. The Agent chooses retry/escalation/user help and writes its own
 * finish/memory; the system must never substitute a business or Git decision. */
export function assertTerminalPushCoordinationControl(context: {
  terminalPushCoordination?: unknown; terminalPushObservation?: unknown;
  kind: string; agent: string; stateVersion: number; candidates: readonly string[]; decisionBy: string;
  allowAgentGitActions?: boolean; allowUserIntervention: boolean; canComplete: boolean; requireBridge?: boolean;
  collaboration?: unknown; mainCapabilities?: unknown; canonicalFinalIntegration?: boolean; scopedAgentRouting?: boolean;
  allowFinishRoute?: boolean; allowWorkflowReconfiguration?: boolean; allowAgentOrchestrationReconfiguration?: boolean;
  workflowAuthoringPath?: string; tasklessRouteTargets?: readonly string[];
}): void {
  if (context.terminalPushCoordination === undefined) return;
  const scope = context.terminalPushCoordination;
  if (!isTerminalPushCoordinationScope(scope) || context.terminalPushObservation !== undefined ||
    context.kind !== "worker" && context.kind !== "main" || context.kind === "main" && context.agent !== "main" ||
    scope.role === "main" && (context.kind !== "main" || context.agent !== "main") ||
    context.stateVersion !== scope.coordinatorEpoch || context.decisionBy !== "agent" || context.requireBridge !== true ||
    context.candidates.length || context.tasklessRouteTargets?.length || context.allowAgentGitActions ||
    context.allowUserIntervention !== scope.canRequestUser || context.canComplete || context.collaboration !== undefined ||
    context.mainCapabilities !== undefined || context.canonicalFinalIntegration || context.scopedAgentRouting || context.allowFinishRoute ||
    context.allowWorkflowReconfiguration || context.allowAgentOrchestrationReconfiguration || context.workflowAuthoringPath !== undefined) {
    throw new Error("Historical receipt coordination requires the exact manager-only control scope");
  }
}

export function terminalPushCoordinationActionAllowed(scope: TerminalPushCoordinationScope,
  action: { tool: string; incidentId?: unknown; operation?: unknown }): boolean {
  return action.tool === "finish_task" || action.tool === "coordinate_agent_receipt" && action.incidentId === scope.incidentId &&
    (action.operation === "retry" || action.operation === "escalate" && scope.role === "leader") ||
    action.tool === "request_user" && scope.role === "main" && scope.canRequestUser;
}
