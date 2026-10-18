import type { ControlAction } from "./types.js";

const DECISION_TOOLS = new Set<ControlAction["tool"]>([
  "coordinate_group_task", "coordinate_agent_receipt", "route_to_agent", "request_user", "apply_workflow", "complete_project",
  "assign_group_tasks", "claim_group_task", "request_group_integration", "complete_group"
]);

export function isControlDecision(action: ControlAction): boolean {
  return DECISION_TOOLS.has(action.tool);
}

/** The Agent chooses how to handle each independent retained failure. The
 * system only preserves those choices and their original scoped authority;
 * it must not invent a retry, escalation, or business plan. Global transitions
 * keep their existing single decision, while finish_task remains separate. */
export function controlDecisionsConflict(existing: ControlAction, candidate: ControlAction): boolean {
  if (!isControlDecision(existing) || !isControlDecision(candidate)) return false;
  if (existing.tool === "coordinate_group_task" && candidate.tool === "coordinate_group_task") {
    return existing.groupRunId === candidate.groupRunId && existing.coordinatorEpoch === candidate.coordinatorEpoch &&
      existing.arrivalRequestId === candidate.arrivalRequestId;
  }
  return true;
}
