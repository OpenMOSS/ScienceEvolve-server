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
