import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getWorkflowAdjustmentPage } from "./api";
import { loadWorkflowAdjustmentHistory, type WorkflowAdjustmentHistoryCache } from "./workflowAdjustmentHistory";
import { workflowAdjustmentPageFixture } from "./test/workflow-adjustment-history";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "./lib";
import type { WorkflowAdjustmentContext, WorkflowAdjustmentPage } from "./workflowAdjustments";
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getWorkflowAdjustmentPage: vi.fn() }));
function fixture(projectId = "p", count = 61) {
  const snapshot = { orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION), agents: structuredClone(DEFAULT_AGENTS), skillDefinitions: {}, mcpDefinitions: {} };
  const current = { version: { revision: 1, hash: "a".repeat(64) }, snapshot };
  const context: WorkflowAdjustmentContext = { current, records: Array.from({ length: count }, (_, i) => ({ projectId, requestId: `${projectId}-${i}`,
    source: { kind: "user" }, submittedAt: "original-time", base: current.version, baseSnapshot: snapshot, proposal: snapshot, explanation: "Original explanation",
    changes: [], status: "withdrawn", history: [], currentVersion: current.version })) };
  vi.mocked(getWorkflowAdjustmentPage).mockImplementation(async (_project, input) => workflowAdjustmentPageFixture(context, input));
  return { context, cache: { firstPage: {} } as WorkflowAdjustmentHistoryCache, signal: new AbortController().signal };
}
beforeEach(() => vi.clearAllMocks());
describe("coherent workflow adjustment metadata history", () => {
  it("loads only the first 25 summaries before the user asks for older records", async () => {
    const f = fixture(), history = await loadWorkflowAdjustmentHistory("p", 25, f.cache, f.signal);
    expect(history.records).toHaveLength(25); expect(history.total).toBe(61);
    expect(history.records[0].requestId).toBe("p-60"); expect(history.nextBefore).toBe(37);
    expect(getWorkflowAdjustmentPage).toHaveBeenCalledOnce(); expect(f.cache.history).toBe(history);
    expect(history.records.every(record => !("proposal" in record))).toBe(true);
  });
  it("extends the visible range using the same journal and reuses it unchanged on polling", async () => {
    const f = fixture(); await loadWorkflowAdjustmentHistory("p", 25, f.cache, f.signal);
    const expanded = await loadWorkflowAdjustmentHistory("p", 50, f.cache, f.signal);
    expect(expanded.records).toHaveLength(50); expect(new Set(expanded.records.map(record => record.requestId)).size).toBe(50);
    expect(vi.mocked(getWorkflowAdjustmentPage).mock.calls[2][1]).toMatchObject({ before: 37, expectedVersion: expanded.journalVersion });
    expect(await loadWorkflowAdjustmentHistory("p", 50, f.cache, f.signal)).toBe(expanded);
    expect(getWorkflowAdjustmentPage).toHaveBeenCalledTimes(4);
  });
  it("preserves every previously visible older record when a new submission shifts the newest page", async () => {
    const f = fixture(), old = await loadWorkflowAdjustmentHistory("p", 50, f.cache, f.signal);
    f.context.records.push({ ...f.context.records[0], requestId: "new-submission" });
    const next = await loadWorkflowAdjustmentHistory("p", 50, f.cache, f.signal);
    expect(next.records[0].requestId).toBe("new-submission");
    expect(old.records.every(record => next.records.some(current => current.requestId === record.requestId))).toBe(true);
  });
  it("keeps the previous confirmed history when a later page rejects a changed journal", async () => {
    const f = fixture(), previous = await loadWorkflowAdjustmentHistory("p", 25, f.cache, f.signal);
    vi.mocked(getWorkflowAdjustmentPage).mockResolvedValueOnce(workflowAdjustmentPageFixture(f.context))
      .mockRejectedValueOnce(new ApiError("Journal changed while reading", 409));
    await expect(loadWorkflowAdjustmentHistory("p", 50, f.cache, f.signal)).rejects.toMatchObject({ status: 409 });
    expect(f.cache.history).toBe(previous);
  });
  it("does not advance history for an aborted response or reuse another project's matching journal hash", async () => {
    const f = fixture(), controller = new AbortController();
    vi.mocked(getWorkflowAdjustmentPage).mockImplementationOnce(async () => { controller.abort(); return workflowAdjustmentPageFixture(f.context); });
    await expect(loadWorkflowAdjustmentHistory("p", 25, f.cache, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.cache.history).toBeUndefined();
    const confirmed = await loadWorkflowAdjustmentHistory("p", 50, f.cache, f.signal);
    const other = fixture("other"), page = { ...workflowAdjustmentPageFixture(other.context), journalVersion: confirmed.journalVersion };
    vi.mocked(getWorkflowAdjustmentPage).mockResolvedValue(page);
    const read = await loadWorkflowAdjustmentHistory("other", 25, f.cache, f.signal);
    expect(read.records.every(record => record.projectId === "other")).toBe(true);
  });
  it.each(["journal", "duplicate", "cursor"])("rejects an inconsistent %s without publishing a mixed page", async fault => {
    const f = fixture(), first = workflowAdjustmentPageFixture(f.context), next = workflowAdjustmentPageFixture(f.context, { before: first.nextBefore });
    if (fault === "journal") next.journalVersion = "b".repeat(64);
    if (fault === "duplicate") next.records[0] = first.records[0];
    if (fault === "cursor") next.nextBefore = first.nextBefore;
    vi.mocked(getWorkflowAdjustmentPage).mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    await expect(loadWorkflowAdjustmentHistory("p", 50, f.cache, f.signal)).rejects.toMatchObject({ status: 409 });
    expect(f.cache.history).toBeUndefined();
  });
  it("requires a full matching current editor snapshot on the first page", async () => {
    const f = fixture(), page: WorkflowAdjustmentPage = workflowAdjustmentPageFixture(f.context); delete page.current;
    vi.mocked(getWorkflowAdjustmentPage).mockResolvedValueOnce(page);
    await expect(loadWorkflowAdjustmentHistory("p", 25, f.cache, f.signal)).rejects.toMatchObject({ status: 409 });
    expect(f.cache.history).toBeUndefined();
  });
});
