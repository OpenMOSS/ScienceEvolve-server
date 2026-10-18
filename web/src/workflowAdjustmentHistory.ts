import { ApiError, getWorkflowAdjustmentPage, type WorkflowAdjustmentPageReadCache } from "./api";
import { sameWorkflowVersion } from "./workflowAdjustmentDraft";
import type { WorkflowAdjustmentPage, WorkflowAdjustmentContext } from "./workflowAdjustments";

export type WorkflowAdjustmentHistory = WorkflowAdjustmentPage & { current: WorkflowAdjustmentContext["current"] };
export interface WorkflowAdjustmentHistoryCache { firstPage: WorkflowAdjustmentPageReadCache; projectId?: string; watchRequestId?: string; history?: WorkflowAdjustmentHistory }

/** Publish a coherent visible history only after every requested page agrees.
 * Failed/aborted reads retain the previous confirmed list. Unread archives
 * remain on S; no proposal bodies are downloaded by browsing or polling. */
export async function loadWorkflowAdjustmentHistory(projectId: string, minimumCount: number, cache: WorkflowAdjustmentHistoryCache,
  signal: AbortSignal, watchRequestId?: string): Promise<WorkflowAdjustmentHistory> {
  const first = await getWorkflowAdjustmentPage(projectId, { limit: 25, ...(watchRequestId ? { watchRequestId } : {}) }, signal, cache.firstPage);
  if (!first.current || !sameWorkflowVersion(first.current.version, first.currentVersion)) throw new ApiError("修改记录首页缺少一致的正式版本", 409);
  const previous = cache.projectId === projectId ? cache.history : undefined;
  if (new Set(first.records.map(record => record.requestId)).size !== first.records.length) throw new ApiError("记录首页存在重复身份", 409);
  if (previous?.journalVersion === first.journalVersion && previous.records.length >= minimumCount && cache.watchRequestId === watchRequestId) {
    if (signal.aborted) throw new DOMException("History read aborted", "AbortError");
    return previous;
  }
  const oldestVisible = previous?.records.at(-1)?.submissionSequence;
  const records = previous?.journalVersion === first.journalVersion ? [...previous.records] : [...first.records];
  let nextBefore = previous?.journalVersion === first.journalVersion ? previous.nextBefore : first.nextBefore;
  while (nextBefore !== undefined && (records.length < minimumCount ||
    oldestVisible !== undefined && (records.at(-1)?.submissionSequence ?? Infinity) > oldestVisible)) {
    if (signal.aborted) throw new DOMException("History read aborted", "AbortError");
    const page = await getWorkflowAdjustmentPage(projectId, { limit: 25, before: nextBefore, expectedVersion: first.journalVersion }, signal);
    if (new Set(page.records.map(record => record.requestId)).size !== page.records.length || page.journalVersion !== first.journalVersion || !sameWorkflowVersion(page.currentVersion, first.currentVersion) ||
      page.records.some(record => record.projectId !== projectId || records.some(prior => prior.requestId === record.requestId)) ||
      page.nextBefore !== undefined && page.nextBefore >= nextBefore) throw new ApiError("分页记录在读取期间已有更新或游标不一致，请刷新后继续", 409);
    records.push(...page.records); nextBefore = page.nextBefore;
  }
  if (signal.aborted) throw new DOMException("History read aborted", "AbortError");
  if (records.some(record => record.projectId !== projectId)) throw new ApiError("分页记录项目身份不匹配", 409);
  const history: WorkflowAdjustmentHistory = { ...first, current: first.current, records };
  if (nextBefore !== undefined) history.nextBefore = nextBefore; else delete history.nextBefore;
  cache.projectId = projectId; cache.history = history;
  if (watchRequestId !== undefined) cache.watchRequestId = watchRequestId; else delete cache.watchRequestId;
  return history;
}
