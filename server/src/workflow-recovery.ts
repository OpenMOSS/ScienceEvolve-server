import type { ProjectState } from "./types.js";
import { redactTrace } from "./utils.js";

/** A runtime failure never withdraws the user's authorization to run. Only
 * the explicit Pause/Stop lifecycle may do that. Legacy user pauses retain
 * their meaning even before pauseRequest was introduced. */
export function hasUserWorkflowPause(state: Pick<ProjectState, "status" | "phase" | "pauseRequest">): boolean {
  return Boolean(state.pauseRequest) ||
    (["paused", "pausing"].includes(state.status) && (
      state.phase === "paused" || state.phase.startsWith("pausing:") ||
      state.phase.startsWith("collaboration:user-paus") ||
      state.phase === "collaboration:user-cancelled"
    ));
}

export function canAutomaticallyRecoverWorkflow(state: ProjectState): boolean {
  return !state.archivedAt && !hasUserWorkflowPause(state) &&
    !["completed", "cancelled", "cancelling", "interrupting", "interrupted"].includes(state.status);
}

export function workflowRecoveryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
}

/** Called at a durable scheduler boundary. Repeated checkpoint writes join
 * the same pending retry; they neither spend a new attempt nor postpone it.
 * Counters describe recovery rounds, never a permission or lifetime budget. */
export function checkpointWorkflowRecovery(state: ProjectState, options: {
  now?: number; delayMs?: (attempt: number) => number;
} = {}): boolean {
  if (state.status !== "retrying" || !canAutomaticallyRecoverWorkflow(state)) return false;
  const now = options.now ?? Date.now();
  const previous = state.workflowRecovery;
  const attempt = previous?.pending ? previous.attempt : Math.min(Number.MAX_SAFE_INTEGER,
    Math.max(0, previous?.attempt ?? 0) + 1);
  const requested = state.retryAt ? Date.parse(state.retryAt) : NaN;
  const nextRetryAt = previous?.pending ? previous.nextRetryAt : new Date(
    Number.isFinite(requested) && requested > now ? requested
      : now + Math.max(1, (options.delayMs ?? workflowRecoveryDelayMs)(attempt))
  ).toISOString();
  state.workflowRecovery = { attempt, pending: true, nextRetryAt,
    startedAt: previous?.startedAt ?? new Date(now).toISOString(),
    phase: state.phase, reason: redactTrace(state.lastError ?? (
      state.userIntervention?.status === "pending" ? "等待用户补充信息；其余可执行分支继续运行" : "正在恢复未完成的 Workflow 步骤"
    )).slice(0, 4_000) };
  state.retryAt = nextRetryAt;
  return true;
}

/** Consume scheduling intent before a retry. The attempt counter and original
 * checkpoint remain durable until actual progress succeeds. */
export function beginWorkflowRecovery(state: ProjectState, options: { renew?: boolean } = {}): void {
  if (options.renew) {
    const now = new Date().toISOString();
    const previous = state.workflowRecovery;
    state.workflowRecovery = { attempt: Math.min(Number.MAX_SAFE_INTEGER,
      Math.max(0, previous?.attempt ?? 0) + (previous?.pending ? 0 : 1)), pending: false,
      startedAt: previous?.startedAt ?? now, nextRetryAt: now,
      phase: state.phase, reason: previous?.reason ?? "用户继续原 Workflow" };
  }
  if (state.workflowRecovery) state.workflowRecovery.pending = false;
  state.retryAt = undefined;
}

export function finishWorkflowRecovery(state: ProjectState): void {
  state.workflowRecovery = undefined;
  state.retryAt = undefined;
}
