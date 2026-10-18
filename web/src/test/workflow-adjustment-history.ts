import { createHash } from "node:crypto";
import type { WorkflowAdjustmentContext, WorkflowAdjustmentPage, WorkflowAdjustmentPageInput, WorkflowAdjustmentSummary } from "../workflowAdjustments";

/** Controlled HTTP metadata fixtures; production S/index correctness is tested separately. */
export function workflowAdjustmentPageFixture(context: WorkflowAdjustmentContext, input: WorkflowAdjustmentPageInput = {}): WorkflowAdjustmentPage {
  const journalVersion = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  const summaries: WorkflowAdjustmentSummary[] = context.records.map((record, i) => {
    const source = structuredClone(record.source); if ("session" in source) delete source.session;
    const last = record.history.at(-1), appliedVersion = [...record.history].reverse().find(item => item.appliedVersion)?.appliedVersion;
    return { projectId: record.projectId, requestId: record.requestId, submissionSequence: i + 1, source,
      submittedAt: record.submittedAt, base: record.base, currentVersion: context.current.version,
      status: record.status, changeCount: record.changes.length, ...(record.waitingReason ? { waitingReason: record.waitingReason } : {}),
      ...(appliedVersion ? { appliedVersion } : {}), ...(record.replacesRequestId ? { replacesRequestId: record.replacesRequestId } : {}),
      ...(last?.replacedByRequestId ? { replacedByRequestId: last.replacedByRequestId } : {}) };
  });
  const candidates = summaries.filter(record => input.before === undefined || record.submissionSequence < input.before).reverse();
  const records = candidates.slice(0, input.limit ?? 25);
  return { journalVersion, currentVersion: context.current.version, records, total: summaries.length,
    ...(candidates.length > records.length ? { nextBefore: records.at(-1)!.submissionSequence } : {}),
    ...(input.before === undefined ? { current: structuredClone(context.current), ...(context.constraints ? { constraints: context.constraints } : {}),
      userRequest: summaries.find(record => record.source.kind === "user" && ["pending", "needs_resubmission"].includes(record.status)) ?? null,
      ...(input.watchRequestId ? { operationRecord: summaries.find(record => record.requestId === input.watchRequestId) ?? null } : {}) } : {}) };
}
