import { workflowAdjustmentPageFixture } from "./test/workflow-adjustment-history";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkflowAdjustmentReadCache, type WorkflowAdjustmentPageReadCache, getWorkflowAdjustmentPage, getWorkflowAdjustmentDetail, getWorkflowAdjustments, submitWorkflowAdjustment, withdrawWorkflowAdjustment } from "./api";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "./lib";
import type { WorkflowAdjustmentContext, WorkflowAdjustmentRecord, WorkflowAdjustmentSubmission } from "./workflowAdjustments";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const version = { revision: 7, hash: "a".repeat(64) };
const submission = (): WorkflowAdjustmentSubmission => ({ requestId: "original request/用户", base: { ...version },
  proposal: { orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION), agents: structuredClone(DEFAULT_AGENTS), skillDefinitions: {}, mcpDefinitions: {} },
  explanation: "保留完整说明\n原始第二行", replacesRequestId: "previous-user-request" });
function record(input = submission()): WorkflowAdjustmentRecord {
  return { ...input, projectId: "original-project", source: { kind: "user" }, submittedAt: "2026-10-10T22:00:00.000Z",
    baseSnapshot: structuredClone(input.proposal), explanation: input.explanation ?? "", changes: [], status: "pending", history: [], currentVersion: { ...version } };
}

describe("workflow adjustment browser API", () => {
  it("reads complete user/Main history without normalization and supports cancelling an obsolete read", async () => {
    const input = submission(), original = record(input);
    const main: WorkflowAdjustmentRecord = { ...original, requestId: "main-request", source: { kind: "main", acceptedRequestId: "accepted", acceptedEventId: "event",
      invocationId: "invocation", callId: "call", nodeRunId: "original-node", routeEpoch: 2,
      session: { schemaVersion: 1, harnessId: "codex", adapterVersion: "native", nativeId: "original-session", generation: 3, durable: true, createdAt: original.submittedAt } },
      status: "needs_resubmission", waitingReason: "配置已发生修改，请基于最新版本核对后重新提交" };
    const context: WorkflowAdjustmentContext = { current: { version, snapshot: input.proposal }, records: [original, main] };
    const fetchMock = vi.fn().mockResolvedValue(json(context)); vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(await getWorkflowAdjustments("original/project 用户", controller.signal)).toEqual(context);
    expect(fetchMock).toHaveBeenCalledWith("./api/projects/original%2Fproject%20%E7%94%A8%E6%88%B7/workflow/adjustments",
      expect.objectContaining({ cache: "no-store", signal: controller.signal }));
  });

  it("submits the full snapshot and keeps an already applied 202 result authoritative", async () => {
    const input = submission(); input.proposal.agents.main.instructions = "未失焦的指令\n引号\"和反斜杠\\";
    const before = structuredClone(input), appliedVersion = { revision: 8, hash: "b".repeat(64) };
    const result = { record: { ...record(input), status: "applied", currentVersion: appliedVersion,
      history: [{ requestId: input.requestId, status: "applied", at: "2026-10-10T22:01:00.000Z", appliedVersion }] }, revision: 94, replay: false };
    const fetchMock = vi.fn().mockResolvedValue(json(result, 202)); vi.stubGlobal("fetch", fetchMock);
    expect(await submitWorkflowAdjustment("original-project", input)).toEqual(result);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("./api/projects/original-project/workflow/adjustments");
    expect(options.method).toBe("POST"); expect(JSON.parse(options.body)).toEqual(before);
    expect(input).toEqual(before); expect(JSON.parse(options.body)).not.toHaveProperty("projectId");
  });

  it("retries the same request identity and exact body after an unconfirmed network result", async () => {
    const input = submission(), result = { record: record(input), revision: 31, replay: true };
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Connection closed after server acceptance")).mockResolvedValueOnce(json(result));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitWorkflowAdjustment("original-project", input)).rejects.toThrow("Connection closed");
    expect(await submitWorkflowAdjustment("original-project", input)).toEqual(result);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a stale-version conflict and its latest facts without rewriting the draft base", async () => {
    const input = submission(), before = structuredClone(input);
    const details = { code: "STALE_WORKFLOW_VERSION", message: "配置已发生修改，请基于最新版本核对后重新提交",
      currentVersion: { revision: 8, hash: "b".repeat(64) }, requestId: input.requestId };
    const fetchMock = vi.fn().mockResolvedValue(json(details, 409)); vi.stubGlobal("fetch", fetchMock);
    const error = await submitWorkflowAdjustment("original-project", input).catch(value => value);
    expect(error).toBeInstanceOf(ApiError); expect(error.status).toBe(409); expect(error.details).toEqual(details);
    expect(input).toEqual(before); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "只撤回本提案；下一次请保留原工具选择"])("withdraws exactly one request and preserves an optional user note (%s)", async note => {
    const original = record(), result = { record: { ...original, status: "withdrawn" }, revision: 32, replay: false, withdrawn: true };
    const fetchMock = vi.fn().mockResolvedValue(json(result)); vi.stubGlobal("fetch", fetchMock);
    const input = { operationId: "original-withdraw-operation", ...(note === undefined ? {} : { note }) };
    expect(await withdrawWorkflowAdjustment("original/project", original.requestId, input)).toEqual(result);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("./api/projects/original%2Fproject/workflow/adjustments/original%20request%2F%E7%94%A8%E6%88%B7/withdraw");
    expect(options.method).toBe("POST"); expect(JSON.parse(options.body)).toEqual(input);
    if (note === undefined) expect(JSON.parse(options.body)).not.toHaveProperty("note");
  });
  it("reuses only the same project's complete confirmed response for a matching 304", async () => {
    const context: WorkflowAdjustmentContext = { current: { version, snapshot: submission().proposal }, records: [record()] };
    const first = json(context); first.headers.set("ETag", '"original-etag"');
    const unchanged = new Response(null, { status: 304, headers: { ETag: '"original-etag"' } });
    const text = vi.spyOn(unchanged, "text"), fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(unchanged);
    vi.stubGlobal("fetch", fetchMock); const cache: WorkflowAdjustmentReadCache = {};
    const confirmed = await getWorkflowAdjustments("original-project", undefined, cache);
    expect(cache).toEqual({ projectId: "original-project", etag: '"original-etag"', context: confirmed });
    expect(await getWorkflowAdjustments("original-project", undefined, cache)).toBe(confirmed);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: "no-store", headers: { "If-None-Match": '"original-etag"' } });
    expect(text).not.toHaveBeenCalled(); expect(confirmed).toEqual(context);
  });

  it("rejects missing, foreign-project and conflicting 304 bodies without replacing confirmed content", async () => {
    const context: WorkflowAdjustmentContext = { current: { version, snapshot: submission().proposal }, records: [record()] };
    const cache: WorkflowAdjustmentReadCache = { projectId: "original-project", etag: '"confirmed"', context };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 304, headers: { ETag: '"different"' } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getWorkflowAdjustments("original-project", undefined, cache)).rejects.toMatchObject({ status: 304 });
    await expect(getWorkflowAdjustments("another-project", undefined, cache)).rejects.toMatchObject({ status: 304 });
    await expect(getWorkflowAdjustments("original-project", undefined, {})).rejects.toMatchObject({ status: 304 });
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty("If-None-Match");
    expect(cache).toEqual({ projectId: "original-project", etag: '"confirmed"', context });
  });

  it("retains the last confirmed version on HTTP failure and ignores an aborted newer response", async () => {
    const context: WorkflowAdjustmentContext = { current: { version, snapshot: submission().proposal }, records: [record()] };
    const cache: WorkflowAdjustmentReadCache = { projectId: "original-project", etag: '"confirmed"', context };
    const newer = { ...context, records: [] }, response = json(newer); response.headers.set("ETag", '"newer"');
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ message: "Temporary query failure" }, 503)).mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(getWorkflowAdjustments("original-project", undefined, cache)).rejects.toMatchObject({ status: 503, message: "Temporary query failure" });
    const controller = new AbortController(); controller.abort();
    expect(await getWorkflowAdjustments("original-project", controller.signal, cache)).toEqual(newer);
    expect(cache).toEqual({ projectId: "original-project", etag: '"confirmed"', context });
  });

  it("advances to the exact complete changed context and accepts servers without conditional support", async () => {
    const context: WorkflowAdjustmentContext = { current: { version, snapshot: submission().proposal }, records: [record()] };
    const cache: WorkflowAdjustmentReadCache = { projectId: "original-project", etag: '"old"', context };
    const newer = { ...context, records: [{ ...record(), status: "withdrawn" as const }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(newer)).mockResolvedValueOnce(json(newer)));
    expect(await getWorkflowAdjustments("original-project", undefined, cache)).toEqual(newer);
    expect(cache.etag).toBeUndefined();
    await getWorkflowAdjustments("original-project", undefined, cache);
    expect(vi.mocked(fetch).mock.calls[1][1]!.headers).not.toHaveProperty("If-None-Match");
  });

  it("conditionally reuses the exact metadata page and sends no cursor or watch request silently", async () => {
    const context: WorkflowAdjustmentContext = { current: { version, snapshot: submission().proposal }, records: [record()] };
    const page = workflowAdjustmentPageFixture(context), first = json(page); first.headers.set("ETag", '"page-confirmed"');
    const unchanged = new Response(null, { status: 304, headers: { ETag: '"page-confirmed"' } }), body = vi.spyOn(unchanged, "text");
    const fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(unchanged); vi.stubGlobal("fetch", fetchMock);
    const cache: WorkflowAdjustmentPageReadCache = {}, signal = new AbortController().signal;
    const confirmed = await getWorkflowAdjustmentPage("original-project", { limit: 25 }, signal, cache);
    expect(await getWorkflowAdjustmentPage("original-project", { limit: 25 }, signal, cache)).toBe(confirmed);
    expect(fetchMock.mock.calls[1]).toEqual(["./api/projects/original-project/workflow/adjustments/history?limit=25",
      { signal, cache: "no-store", headers: { Accept: "application/json", "If-None-Match": '"page-confirmed"' } }]);
    expect(body).not.toHaveBeenCalled(); expect(confirmed).toEqual(page);
  });

  it.each(["project", "cursor", "watch"])("does not reuse a confirmed page for a different %s scope", async scope => {
    const page = workflowAdjustmentPageFixture({ current: { version, snapshot: submission().proposal }, records: [record()] });
    const first = json(page); first.headers.set("ETag", '"confirmed"');
    const fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock); const cache: WorkflowAdjustmentPageReadCache = {};
    await getWorkflowAdjustmentPage("original-project", {}, undefined, cache);
    const input = scope === "cursor" ? { before: 50, expectedVersion: page.journalVersion } : scope === "watch" ? { watchRequestId: "other-original-operation" } : {};
    await expect(getWorkflowAdjustmentPage(scope === "project" ? "another-project" : "original-project", input, undefined, cache)).rejects.toMatchObject({ status: 304 });
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty("If-None-Match");
    expect(cache.page).toEqual(page);
  });

  it("keeps a confirmed metadata page on failure or an aborted newer response", async () => {
    const page = workflowAdjustmentPageFixture({ current: { version, snapshot: submission().proposal }, records: [record()] });
    const first = json(page); first.headers.set("ETag", '"confirmed"');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(json({ message: "Query disconnected" }, 503)).mockResolvedValueOnce(json({ ...page, records: [] })));
    const cache: WorkflowAdjustmentPageReadCache = {}; await getWorkflowAdjustmentPage("original-project", {}, undefined, cache);
    const confirmed = cache.page;
    await expect(getWorkflowAdjustmentPage("original-project", {}, undefined, cache)).rejects.toMatchObject({ status: 503 });
    const controller = new AbortController(); controller.abort(); await getWorkflowAdjustmentPage("original-project", {}, controller.signal, cache);
    expect(cache.page).toBe(confirmed); expect(cache.etag).toBe('"confirmed"');
  });

  it("fetches every original detail field by exact encoded identity and journal without normalizing", async () => {
    const original = record(), journalVersion = "b".repeat(64), signal = new AbortController().signal;
    original.history.push({ requestId: original.requestId, status: "withdrawn", at: "original-terminal-time", note: "完整原撤回说明\n第二行" });
    original.status = "withdrawn"; const fetchMock = vi.fn().mockResolvedValue(json({ record: original, journalVersion })); vi.stubGlobal("fetch", fetchMock);
    expect(await getWorkflowAdjustmentDetail("original-project", original.requestId, journalVersion, signal)).toEqual({ record: original, journalVersion });
    expect(fetchMock.mock.calls[0][0]).toBe(`./api/projects/original-project/workflow/adjustments/requests/${encodeURIComponent(original.requestId)}?expectedVersion=${journalVersion}`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal, cache: "no-store" }); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["project", "request", "journal"])("rejects an incorrect full detail %s identity", async fault => {
    const original = record(), journalVersion = "b".repeat(64);
    if (fault === "project") original.projectId = "foreign-project";
    if (fault === "request") original.requestId = "foreign-request";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ record: original, journalVersion: fault === "journal" ? "c".repeat(64) : journalVersion })));
    await expect(getWorkflowAdjustmentDetail("original-project", submission().requestId, journalVersion)).rejects.toMatchObject({ status: 409 });
  });

});
