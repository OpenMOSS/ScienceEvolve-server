/** Web snapshots also accept initial and historical display-only states.
 * Server lifecycle ownership is checked by project-status.test.ts; do not
 * extend this vocabulary with unrelated task, receipt or execution states.
 */
export const PROJECT_VIEW_STATUSES = [
  "draft", "queued", "running", "retrying", "interrupting", "interrupted",
  "pausing", "paused", "cancelling", "cancelled", "stopping", "stopped",
  "completed", "failed"
] as const;

export type ProjectViewStatus = (typeof PROJECT_VIEW_STATUSES)[number];

const statuses = new Set<string>(PROJECT_VIEW_STATUSES);

/** Exact membership only. Callers retain their own normalization/error policy. */
export function isProjectViewStatus(value: unknown): value is ProjectViewStatus {
  return typeof value === "string" && statuses.has(value);
}

/** Recovery and safe-point Pause must still leave the user a Stop entry. */
export function isStoppedProject(project: { status: ProjectViewStatus; phase?: string }): boolean {
  return project.status === "cancelled" || project.status === "stopped" ||
    project.status === "paused" && project.phase === "collaboration:user-cancelled";
}

export function canStopProject(project: { status: ProjectViewStatus; phase?: string; archivedAt?: string }): boolean {
  return !project.archivedAt && !isStoppedProject(project) && [
    "queued", "running", "retrying", "interrupting", "interrupted", "pausing", "paused"
  ].includes(project.status);
}

export function canArchiveProject(project: {
  status: ProjectViewStatus; git?: { enabled: boolean };
}): boolean {
  return project.status === "completed" || project.status === "cancelled" ||
    project.status === "paused" && project.git?.enabled === true;
}
