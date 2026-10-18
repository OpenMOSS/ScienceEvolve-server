import type { ProjectState } from "./types.js";

export interface CancellationRequest {
  actor?: "user" | "deadline-monitor" | "system" | "admin";
  reason?: "user_cancelled" | "arm_timeout" | "budget_exhausted" | "dependency_failure" | "shutdown";
  /** Wait for the runner, commit rollback and final state writes to settle. */
  waitForSettlement?: boolean;
}

export function cancellationLabel(state: Pick<ProjectState, "cancelReason">): string {
  switch (state.cancelReason) {
    case "arm_timeout": return "运行超时，任务已取消";
    case "budget_exhausted": return "预算耗尽，任务已取消";
    case "dependency_failure": return "依赖失败，任务已取消";
    case "shutdown": return "系统关闭，任务已取消";
    case "user_cancelled": return "用户已取消任务";
    default: return "任务已取消";
  }
}
