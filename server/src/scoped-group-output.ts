import type { CredentialFreeProjectStateProjection, ScopedArrivalRecord } from "./collaboration-state/contracts.js";

/** sourceRunId names the predecessor arrival, not its execution or child run. */
export function scopedPredecessorOutput(projection: CredentialFreeProjectStateProjection, arrival: ScopedArrivalRecord): string | undefined {
  const source = projection.scopedArrivals?.find((item) => item.requestId === arrival.sourceRunId && item.groupRunId === arrival.groupRunId);
  if (!source) return undefined;
  if (source.status === "skipped") return `Explicitly skipped (not successful work): ${source.targetNodeId}/${source.requestId}`;
  if (source.status !== "completed") return undefined;
  if (source.targetKind === "agent") {
    const execution = projection.scopedExecutions?.find((item) => item.arrivalRequestId === source.requestId && item.groupRunId === source.groupRunId && item.status === "completed");
    if (!execution || !projection.scopedAgentMerges?.some((merge) => merge.executionId === execution.id)) return undefined;
    return projection.scopedAgentReports?.find((report) => report.executionId === execution.id && report.ownershipEpoch === execution.ownershipEpoch)?.output;
  }
  const child = projection.scopedGroupRuns?.find((group) => group.parentArrivalRequestId === source.requestId && group.parentGroupRunId === source.groupRunId && group.status === "completed");
  return child && projection.scopedGroupFinalMerges?.some((merge) => merge.groupRunId === child.id)
    ? scopedGroupOutput(projection, child.id) : undefined;
}

/** Handoffs contain only current, completed owners with actual merge proofs.
 * A skipped/failed report is never promoted to a successful group result. */
export function scopedGroupOutput(projection: CredentialFreeProjectStateProjection, groupRunId: string): string {
  const groups = new Set([groupRunId]);
  for (;;) {
    const children = (projection.scopedGroupRuns ?? []).filter((group) => group.parentGroupRunId && groups.has(group.parentGroupRunId) && !groups.has(group.id));
    if (!children.length) break;
    children.forEach((group) => groups.add(group.id));
  }
  const owners = new Map((projection.scopedExecutions ?? []).filter((execution) => groups.has(execution.groupRunId) && execution.status === "completed")
    .map((execution) => [execution.id, execution.ownershipEpoch]));
  const merged = new Set((projection.scopedAgentMerges ?? []).map((merge) => merge.executionId));
  const reports = (projection.scopedAgentReports ?? []).filter((report) => owners.get(report.executionId) === report.ownershipEpoch && merged.has(report.executionId));
  const skips = (projection.scopedArrivals ?? []).filter((arrival) => groups.has(arrival.groupRunId) && arrival.status === "skipped");
  return [reports.map((report) => report.output).filter(Boolean).join("\n\n"),
    skips.length ? `Explicitly skipped (not successful work): ${skips.map((arrival) => `${arrival.targetNodeId}/${arrival.requestId}`).join(", ")}` : ""]
    .filter(Boolean).join("\n\n").slice(0, 100_000) || "Necessary paths reached Finish; no business result is claimed without a merged report.";
}
