import type { TerminalPushObservationScope } from "../types.js";

export function isTerminalPushObservationScope(value: unknown): value is TerminalPushObservationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.operationId === "string" &&
    record.operationId.trim() === record.operationId && record.operationId.length > 0 &&
    record.operationId.length <= 1024 && !record.operationId.includes("\0");
}

/** A completed task never regains delivery or management authority. The system
 * supplies this narrow mechanism; the original Agent interprets the provider's
 * actual result and authors its own handoff/memory. */
export function assertTerminalPushObservationControl(context: {
  terminalPushObservation?: unknown;
  terminalPushCoordination?: unknown;
  kind: string;
  candidates: readonly string[];
  decisionBy: string;
  allowAgentGitActions?: boolean;
  allowUserIntervention: boolean;
  canComplete: boolean;
  requireBridge?: boolean;
  collaboration?: unknown;
  mainCapabilities?: unknown;
  canonicalFinalIntegration?: boolean;
  scopedAgentRouting?: boolean;
  allowFinishRoute?: boolean;
  allowWorkflowReconfiguration?: boolean;
  allowAgentOrchestrationReconfiguration?: boolean;
  workflowAuthoringPath?: string;
  tasklessRouteTargets?: readonly string[];
}): void {
  if (context.terminalPushObservation === undefined) return;
  if (!isTerminalPushObservationScope(context.terminalPushObservation) || context.terminalPushCoordination !== undefined ||
    context.kind !== "worker" || context.decisionBy !== "agent" ||
    context.allowAgentGitActions !== true || context.requireBridge !== true ||
    context.candidates.length > 0 || context.tasklessRouteTargets?.length ||
    context.allowUserIntervention || context.canComplete || context.collaboration !== undefined ||
    context.mainCapabilities !== undefined || context.canonicalFinalIntegration ||
    context.scopedAgentRouting || context.allowFinishRoute || context.allowWorkflowReconfiguration ||
    context.allowAgentOrchestrationReconfiguration || context.workflowAuthoringPath !== undefined) {
    throw new Error("Terminal push observation requires an exact receipt-only Worker control scope");
  }
}

export function terminalPushObservationActionAllowed(
  scope: TerminalPushObservationScope,
  action: { tool: string; operationId?: unknown; historical?: unknown; retry?: unknown }
): boolean {
  return action.tool === "finish_task" || action.tool === "git_reconcile_push" &&
    action.operationId === scope.operationId && action.historical === true &&
    (action.retry === undefined || action.retry === false);
}
