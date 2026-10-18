import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getRecommendationExplainerConfig, getAgentToolRecommendationCatalog, recommendAgentTools, getWorkflowAdjustmentPage, getWorkflowAdjustmentDetail, submitWorkflowAdjustment, withdrawWorkflowAdjustment, projectAction } from "../api";
import { workflowAdjustmentPageFixture } from "../test/workflow-adjustment-history";
import { DEFAULT_AGENT_ORCHESTRATION } from "../lib";
import { runtimeProjectFixture } from "../test/runtime-project";
import { loadWorkflowAdjustmentDraft, loadWorkflowAdjustmentOperation, saveWorkflowAdjustmentOperation } from "../workflowAdjustmentDraft";
import type { WorkflowAdjustmentContext, WorkflowAdjustmentRecord, WorkflowAdjustmentSubmission } from "../workflowAdjustments";
import type { HarnessCatalogEntry, Project } from "../types";
import { WorkflowAdjustmentEditor } from "./WorkflowAdjustmentEditor";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), getWorkflowAdjustmentPage: vi.fn(), getWorkflowAdjustmentDetail: vi.fn(), submitWorkflowAdjustment: vi.fn(),
  withdrawWorkflowAdjustment: vi.fn(), getRecommendationExplainerConfig: vi.fn(), getAgentToolRecommendationCatalog: vi.fn(), recommendAgentTools: vi.fn(), projectAction: vi.fn() }));
const harnesses = ["codex", "claude-code"].map(id => ({ id, label: id, adapterVersion: "1", available: true, purposes: ["workflow"], nativeProtocol: "responses",
  capabilities: { durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true, readOnlyExplainer: true, webSearch: true, skills: true, mcp: true } } as HarnessCatalogEntry));
function setup(complex = false, gitEnabled = true) {
  const project = runtimeProjectFixture(); project.git = (gitEnabled ? { enabled: true, status: "ready", provider: "github" } : { enabled: false, status: "disabled" }) as Project["git"];
  project.configurationLocked = true;
  if (!complex) { project.orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION); project.orchestration.input.target = "main"; }
  project.orchestration.allowMainReconfiguration = false;
  let context: WorkflowAdjustmentContext = { current: { version: { revision: 7, hash: "a".repeat(64) }, snapshot: {
    orchestration: structuredClone(project.orchestration), agents: structuredClone(project.agents), skillDefinitions: {}, mcpDefinitions: {} } }, records: [] };
  const record = (id: string, source: "user" | "main" = "main", status: WorkflowAdjustmentRecord["status"] = "pending"): WorkflowAdjustmentRecord => ({
    projectId: project.id, requestId: id, base: structuredClone(context.current.version), baseSnapshot: structuredClone(context.current.snapshot),
    proposal: structuredClone(context.current.snapshot), source: source === "user" ? { kind: "user" } : { kind: "main", acceptedRequestId: "accepted", acceptedEventId: "event",
      invocationId: "original-invocation", callId: "original-call", nodeRunId: "original-node", routeEpoch: 2 }, submittedAt: "2026-10-10T22:00:00Z",
    explanation: "原提出者的公开说明", changes: [{ path: ["agents", "main", "instructions"], kind: "changed", before: "原指令", after: "提案指令" }],
    status, history: [{ requestId: id, status, at: "2026-10-10T22:00:00Z" }], currentVersion: structuredClone(context.current.version) });
  const accept = (input: WorkflowAdjustmentSubmission, status: "pending" | "applied" = "pending") => {
    const accepted = { ...record(input.requestId, "user", status), base: structuredClone(input.base), proposal: structuredClone(input.proposal), explanation: input.explanation ?? "" };
    if (status === "applied") { context.current = { version: { revision: 8, hash: "b".repeat(64) }, snapshot: structuredClone(input.proposal) };
      accepted.currentVersion = context.current.version; accepted.history[0].appliedVersion = context.current.version; }
    context.records.push(accepted); return { record: accepted, revision: 99, replay: false };
  };
  vi.mocked(getWorkflowAdjustmentPage).mockImplementation(async (_projectId, input) => structuredClone(workflowAdjustmentPageFixture(context, input)));
  vi.mocked(getWorkflowAdjustmentDetail).mockImplementation(async (_projectId, id, expectedVersion) => {
    const page = workflowAdjustmentPageFixture(context);
    if (expectedVersion && expectedVersion !== page.journalVersion) throw new ApiError("读取期间已有更新", 409);
    const record = context.records.find(record => record.requestId === id);
    if (!record) throw new ApiError("请求不存在", 404);
    return { journalVersion: page.journalVersion, record: structuredClone(record) };
  });
  vi.mocked(submitWorkflowAdjustment).mockImplementation(async (_project, input) => accept(input));
  const close = vi.fn();
  const props = { project, gateways: [], harnesses, skills: [], mcpDirectory: [], onClose: close };
  const view = render(<WorkflowAdjustmentEditor {...props} />);
  return { project, record, accept, close, view, props, get context() { return context; }, set context(value) { context = value; } };
}
async function ready() { await screen.findByRole("button", { name: "提交完整修改" }); await screen.findByText(/^当前正式 r\d+$/); }
function instructions() { return screen.getByRole("textbox", { name: "Agent 指令" }); }
function enter(value: string) { const input = instructions(); act(() => input.focus()); fireEvent.change(input, { target: { value } }); return input; }
async function recordsTab() { await userEvent.click(screen.getByRole("tab", { name: /修改记录/ })); }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(getRecommendationExplainerConfig).mockResolvedValue({ fingerprint: "c".repeat(64), config: { harness: "codex", model: "fixture", available: false,
    validationError: "此检查不调用模型" } } as Awaited<ReturnType<typeof getRecommendationExplainerConfig>>);
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("runtime workflow adjustment window using the existing complete canvas", () => {
  it("coalesces event and timer refreshes without cancelling a slow initial configuration read", async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof workflowAdjustmentPageFixture>) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(getWorkflowAdjustmentPage).mockImplementationOnce((_project, _input, requestSignal) => {
      signal = requestSignal; return new Promise(done => { resolve = done; });
    });
    const f = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(getWorkflowAdjustmentPage).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    await act(async () => { resolve(workflowAdjustmentPageFixture(f.context)); });
    expect(screen.getByText("当前正式 r7")).toBeVisible();
    expect(getWorkflowAdjustmentPage).toHaveBeenCalledTimes(2);
    f.view.unmount();
  });

  it("updates formal history even when refreshing the selected full preview fails", async () => {
    const f = setup(); f.context.records.push(f.record("selected-main")); await ready();
    await recordsTab(); await userEvent.click(screen.getByRole("button", { name: "查看提案 selected-main" }));
    await screen.findByRole("region", { name: "完整请求记录" });
    f.context.current.version = { revision: 8, hash: "b".repeat(64) };
    f.context.records[0].status = "applied";
    vi.mocked(getWorkflowAdjustmentDetail).mockRejectedValueOnce(new ApiError("完整提案暂时不可用", 503));
    await userEvent.click(screen.getByRole("button", { name: "刷新正式配置" }));
    expect(await screen.findByText("当前正式 r8")).toBeVisible();
    expect(await screen.findByText(/完整记录查询失败.*完整提案暂时不可用/)).toBeVisible();
    expect(within(screen.getByRole("region", { name: "共用修改记录" })).getByText("Main · 已应用", { exact: true })).toBeVisible();
    expect(screen.getByRole("region", { name: "完整请求记录" })).toHaveTextContent("Main · 待应用");
    await userEvent.click(screen.getByRole("button", { name: "刷新正式配置" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "完整请求记录" })).toHaveTextContent("Main · 已应用"));
    expect(screen.queryByText(/完整记录查询失败/)).toBeNull();
  });

  it("releases a hung history read and makes its timeout visible without discarding the local draft", async () => {
    const f = setup(); await ready(); enter("请求超时也保留的完整草稿");
    vi.useFakeTimers();
    vi.mocked(getWorkflowAdjustmentPage).mockImplementation((_project, _input, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    fireEvent.click(screen.getByRole("button", { name: "刷新正式配置" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText(/读取超时，请刷新重试/)).toBeVisible();
    expect(instructions()).toHaveValue("请求超时也保留的完整草稿");
    expect(screen.getByText("当前正式 r7")).toBeVisible();
    f.view.unmount();
  });

  it("does not let a hidden editable canvas consume undo while viewing a read-only snapshot", async () => {
    const f = setup(); await ready(); enter("保留已经提交到本地草稿的修改"); fireEvent.blur(instructions());
    const before = loadWorkflowAdjustmentDraft(localStorage, f.project.id);
    await userEvent.click(screen.getByRole("button", { name: "查看当前正式版本" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toEqual(before);
    await userEvent.click(screen.getByRole("button", { name: "返回我的草稿" }));
    expect(instructions()).toHaveValue("保留已经提交到本地草稿的修改");
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
  });

  it("keeps an older formal preview explicit when a new official version arrives", async () => {
    const f = setup(); await ready(); await userEvent.click(screen.getByRole("button", { name: "查看当前正式版本" }));
    f.context.current.version = { revision: 8, hash: "b".repeat(64) };
    await userEvent.click(screen.getByRole("button", { name: "刷新正式配置" }));
    expect(await screen.findByText(/当前预览仍为 r7/)).toBeVisible();
    expect(screen.getByRole("button", { name: "已核对，更新草稿基础" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "查看当前正式版本" }));
    expect(screen.getByText("只读正式版本 r8")).toBeVisible();
  });

  it("keeps hidden unfinished text editable when returning from a read-only preview", async () => {
    const f = setup(); await ready(); const original = enter("返回后仍可正常确认的未完成字段");
    // Open the preview without committing the focused field first.
    fireEvent.click(screen.getByRole("button", { name: "查看当前正式版本" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "返回我的草稿" }));
    const stored = loadWorkflowAdjustmentDraft(localStorage, f.project.id);
    expect(stored.kind === "found" && stored.value.snapshot.agents.main.instructions).not.toBe("返回后仍可正常确认的未完成字段");
    fireEvent.click(screen.getByRole("button", { name: "返回我的草稿" }));
    fireEvent.blur(original);
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { snapshot: { agents: { main: { instructions: "返回后仍可正常确认的未完成字段" } } } } });
  });

  it.each([true, false])("edits a running locked project (Git: %s) with Main changes disabled and submits one exact complete request", async gitEnabled => {
    const f = setup(false, gitEnabled); await ready();
    expect(screen.getByRole("dialog", { name: "查看与调整当前 Workflow" })).toBeVisible();
    enter("完整未失焦用户指令\n第二行"); fireEvent.change(screen.getByRole("textbox", { name: "修改说明" }), { target: { value: "公开说明" } });
    await userEvent.click(screen.getByRole("button", { name: "提交完整修改" }));
    await waitFor(() => expect(submitWorkflowAdjustment).toHaveBeenCalledOnce());
    const [id, input] = vi.mocked(submitWorkflowAdjustment).mock.calls[0];
    expect(id).toBe(f.project.id); expect(input.base).toEqual({ revision: 7, hash: "a".repeat(64) });
    expect(input.proposal.agents.main.instructions).toBe("完整未失焦用户指令\n第二行"); expect(input.explanation).toBe("公开说明");
    expect(input.proposal.orchestration.allowMainReconfiguration).toBe(false);
    expect(await screen.findByText("已提交，等待安全时机应用")).toBeVisible(); expect(projectAction).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "配置" })).toHaveAttribute("aria-selected", "true");
  });

  it("restores an unfinished text field and original draft base after close/reload and a formal Main change", async () => {
    const f = setup(); await ready(); enter("刷新也保留尚未失焦的草稿");
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { base: { revision: 7 } } });
    f.view.unmount(); f.context.current.version = { revision: 8, hash: "b".repeat(64) }; f.context.current.snapshot.agents.main.instructions = "Main新正式指令";
    render(<WorkflowAdjustmentEditor {...f.props} />); await ready();
    expect(instructions()).toHaveValue("刷新也保留尚未失焦的草稿"); expect(screen.getByText(/原草稿及基础版本已保留/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "提交完整修改" }));
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled(); expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { base: { revision: 7 } } });
  });

  it("recommends from the project Explainer and full latest draft, then submits the four selected tool fields normally", async () => {
    vi.mocked(getRecommendationExplainerConfig).mockResolvedValue({ fingerprint: "c".repeat(64), config: { harness: "codex", model: "fixture", available: true } } as Awaited<ReturnType<typeof getRecommendationExplainerConfig>>);
    vi.mocked(getAgentToolRecommendationCatalog).mockResolvedValue({ fingerprint: "d".repeat(64) });
    vi.mocked(recommendAgentTools).mockImplementation(async input => ({ targetAgent: input.targetAgent, contextFingerprint: input.contextFingerprint,
      catalogFingerprint: input.catalogFingerprint, configurationFingerprint: input.configurationFingerprint,
      selection: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: true }, reasons: ["实际公开推荐理由"], warnings: [] }));
    const f = setup(); await ready(); const before = structuredClone(f.context.current.snapshot);
    enter("供推荐读取的最新未失焦指令");
    await userEvent.click(screen.getByRole("button", { name: "推荐 Skill / MCP" }));
    await screen.findByRole("region", { name: "main 工具推荐预览" });
    expect(vi.mocked(recommendAgentTools).mock.calls[0][0]).toMatchObject({ projectId: f.project.id, requirement: f.project.requirement,
      orchestration: before.orchestration, agents: { main: { instructions: "供推荐读取的最新未失焦指令" }, idea: before.agents.idea } });
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "应用工具推荐" }));
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "提交完整修改" }));
    await waitFor(() => expect(submitWorkflowAdjustment).toHaveBeenCalledOnce());
    expect(vi.mocked(submitWorkflowAdjustment).mock.calls[0][1].proposal.agents.main).toMatchObject({ instructions: "供推荐读取的最新未失焦指令", skills: [], autoSkills: [], mcpServers: [], experimentMcp: true });
    expect(vi.mocked(submitWorkflowAdjustment).mock.calls[0][1].proposal.agents.idea).toEqual(before.agents.idea);
  });

  it("previews immutable Main content on the same canvas and returns to the original mounted draft and selection", async () => {
    const f = setup(); f.context.records.push(f.record("main-one")); f.context.records[0].proposal.agents.main.instructions = "Main准确提案内容";
    await ready(); const original = enter("我的未提交编辑"); fireEvent.blur(original); await recordsTab();
    await userEvent.click(screen.getByRole("button", { name: "查看提案 main-one" }));
    // The shared record column replaces the configuration column; switch it to inspect the read-only Agent.
    await userEvent.click(screen.getByRole("tab", { name: "配置" }));
    expect(instructions()).toHaveValue("Main准确提案内容"); expect(instructions()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "返回我的草稿" }));
    expect(instructions()).toBe(original); expect(instructions()).toHaveValue("我的未提交编辑"); expect(instructions()).toBeEnabled();
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("previews an immutable serial Main proposal without Root routing fields or replacing the user's draft", async () => {
    const f = setup(); const proposal = f.record("serial-main-original");
    proposal.source = { kind: "main", acceptedRequestId: "serial-accepted", acceptedEventId: "serial-event",
      invocationId: "sdk-invocation", callId: "sdk-call", scope: { kind: "serial", agentExecutionId: "sdk-task", mainInvocationSeq: 7 } };
    proposal.proposal.agents.main.instructions = "串行 Main 原始完整提案"; f.context.records.push(proposal);
    await ready(); const original = enter("保留我的串行草稿"); fireEvent.blur(original); await recordsTab();
    await userEvent.click(screen.getByRole("button", { name: "查看提案 serial-main-original" }));
    const complete = await screen.findByRole("region", { name: "完整请求记录" });
    expect(complete).toHaveTextContent("Main · 待应用"); expect(complete).toHaveTextContent("serial-main-original");
    expect(vi.mocked(getWorkflowAdjustmentDetail).mock.calls[0].slice(0, 2)).toEqual([f.project.id, proposal.requestId]);
    await userEvent.click(screen.getByRole("tab", { name: "配置" }));
    expect(instructions()).toHaveValue("串行 Main 原始完整提案"); expect(instructions()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "返回我的草稿" }));
    expect(instructions()).toBe(original); expect(instructions()).toHaveValue("保留我的串行草稿");
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("refreshes formal Main facts from project events without replacing drafts or switching the selected panel", async () => {
    const f = setup(); f.context.records.push(f.record("main-one")); await ready(); const input = enter("Main更新时保留本地未失焦草稿");
    f.context.current.version = { revision: 8, hash: "b".repeat(64) }; f.context.records[0].status = "applied";
    f.context.records[0].history.push({ requestId: "main-one", status: "applied", at: "2026-10-10T23:00:00Z", appliedVersion: f.context.current.version });
    f.view.rerender(<WorkflowAdjustmentEditor {...f.props} eventRevision={2} />);
    await screen.findByText("当前正式 r8");
    expect(instructions()).toBe(input); expect(instructions()).toHaveValue("Main更新时保留本地未失焦草稿");
    expect(screen.getByRole("tab", { name: "配置" })).toHaveAttribute("aria-selected", "true");
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { base: { revision: 7 } } });
    await recordsTab(); expect(screen.getByText("Main · 已应用")).toBeVisible(); expect(screen.getByText(/基础 r7.*应用 r8/)).toBeVisible();
  });

  it("updates a stale base only after explicit version review and preserves the full user snapshot", async () => {
    const f = setup(); await ready(); enter("保留用户完整草稿"); fireEvent.blur(instructions());
    f.context.current = { version: { revision: 8, hash: "b".repeat(64) }, snapshot: structuredClone(f.context.current.snapshot) }; f.context.current.snapshot.agents.idea.instructions = "另一Agent的新正式指令";
    await recordsTab(); await userEvent.click(screen.getByRole("button", { name: "刷新记录" })); await screen.findByText("当前正式 r8");
    await userEvent.click(screen.getByRole("button", { name: "查看当前正式版本" }));
    expect(screen.getByRole("region", { name: "完整修改差异" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "已核对，更新草稿基础" }));
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { base: { revision: 8 }, snapshot: { agents: { main: { instructions: "保留用户完整草稿" } } } } });
    await userEvent.click(screen.getByRole("button", { name: "提交完整修改" })); await waitFor(() => expect(submitWorkflowAdjustment).toHaveBeenCalledOnce());
    expect(vi.mocked(submitWorkflowAdjustment).mock.calls[0][1].proposal.agents.idea.instructions).not.toBe("另一Agent的新正式指令");
  });

  it("retains an unconfirmed operation across reload and retries its original body despite later local edits", async () => {
    const f = setup(); await ready(); enter("第一次完整请求"); vi.mocked(submitWorkflowAdjustment).mockRejectedValueOnce(new TypeError("断线"));
    await userEvent.click(screen.getByRole("button", { name: "提交完整修改" })); await screen.findByRole("button", { name: "重试原操作" });
    const original = structuredClone(vi.mocked(submitWorkflowAdjustment).mock.calls[0][1]);
    enter("之后的本地草稿"); f.view.unmount(); render(<WorkflowAdjustmentEditor {...f.props} />);
    await screen.findByRole("button", { name: "重试原操作" }); await waitFor(() => expect(instructions()).toHaveValue("之后的本地草稿"));
    expect(submitWorkflowAdjustment).toHaveBeenCalledTimes(1); expect(screen.getByRole("button", { name: "提交完整修改" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重试原操作" })); await waitFor(() => expect(submitWorkflowAdjustment).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitWorkflowAdjustment).mock.calls[1][1]).toEqual(original);
    await waitFor(() => expect(loadWorkflowAdjustmentOperation(localStorage, f.project.id)).toEqual({ kind: "empty" }));
    expect(instructions()).toHaveValue("之后的本地草稿");
  });

  it("requires exact replacement confirmation and preserves the old request when the new request is rejected", async () => {
    const f = setup(); f.context.records.push(f.record("old-user", "user"), f.record("independent-main")); await ready(); enter("新完整提案");
    vi.mocked(submitWorkflowAdjustment).mockRejectedValueOnce(new ApiError("资源校验未通过", 400));
    await userEvent.click(screen.getByRole("button", { name: "提交完整修改" })); expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
    expect(screen.getByText(/已有一条待应用修改，本次提交将覆盖它/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "确认覆盖并提交" })); await screen.findByText("资源校验未通过");
    expect(vi.mocked(submitWorkflowAdjustment).mock.calls[0][1].replacesRequestId).toBe("old-user");
    expect(f.context.records.map(record => [record.requestId, record.status])).toEqual([["old-user", "pending"], ["independent-main", "pending"]]);
    expect(instructions()).toHaveValue("新完整提案"); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("shows an immediate applied result accurately instead of claiming a pending queue", async () => {
    const f = setup(); await ready(); vi.mocked(submitWorkflowAdjustment).mockImplementationOnce(async (_id, input) => f.accept(input, "applied"));
    enter("已安全应用内容"); await userEvent.click(screen.getByRole("button", { name: "提交完整修改" }));
    expect(await screen.findByText("已应用，实际接受版本 r8")).toBeVisible(); expect(screen.queryByText("已提交，等待安全时机应用")).not.toBeInTheDocument();
  });

  it.each(["withdrawn", "applied"] as const)("shows the true result when withdrawing one Main proposal (%s wins)", async winner => {
    const f = setup(); f.context.records.push(f.record("main-one")); await ready(); await recordsTab();
    vi.mocked(withdrawWorkflowAdjustment).mockImplementationOnce(async (_project, id, input) => {
      const record = f.context.records.find(record => record.requestId === id)!; record.status = winner;
      record.history.push({ requestId: id, operationId: input.operationId, status: winner, at: "2026-10-10T23:00:00Z",
        ...(winner === "applied" ? { appliedVersion: { revision: 8, hash: "b".repeat(64) } } : {}) });
      return { record, revision: 100, replay: false, withdrawn: winner === "withdrawn" };
    });
    await userEvent.click(screen.getByRole("button", { name: "撤回提案 main-one" })); await userEvent.click(screen.getByRole("button", { name: "确认撤回" }));
    await waitFor(() => expect(withdrawWorkflowAdjustment).toHaveBeenCalledOnce());
    expect(vi.mocked(withdrawWorkflowAdjustment).mock.calls[0]).toEqual([f.project.id, "main-one", { operationId: expect.any(String) }]);
    expect(await screen.findByText(winner === "withdrawn" ? "已撤回" : "未撤回：已应用，实际接受版本 r8", { exact: true, selector: '[role="status"]' })).toBeVisible();
    expect(projectAction).not.toHaveBeenCalled();
  });

  it("keeps drafts after an authoritative stale rejection and reads the new formal version", async () => {
    const f = setup(); await ready(); enter("被拒绝仍保留的草稿");
    vi.mocked(submitWorkflowAdjustment).mockImplementationOnce(async () => { f.context.current.version = { revision: 8, hash: "b".repeat(64) };
      throw new ApiError("配置已发生修改，请基于最新版本核对后重新提交", 409); });
    await userEvent.click(screen.getByRole("button", { name: "提交完整修改" })); await screen.findByText("配置已发生修改，请基于最新版本核对后重新提交");
    expect(instructions()).toHaveValue("被拒绝仍保留的草稿"); expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { base: { revision: 7 } } });
    expect(submitWorkflowAdjustment).toHaveBeenCalledOnce();
  });

  it("locks only an authoritative existing-Session Harness and keeps future instructions editable", async () => {
    const f = setup(); f.context.constraints = { agentHarnesses: { main: { harnessId: "codex", reason: "已有原生会话，保留原 Harness" } } }; await ready();
    expect(screen.getByRole("combobox", { name: "main Harness" })).toBeDisabled(); expect(screen.getByText("已有原生会话，保留原 Harness")).toBeVisible();
    expect(instructions()).toBeEnabled();
  });

  it("lets the user restore the exact original Harness when a Session binds after local drafting", async () => {
    const f = setup(); await ready(); enter("保留其余编辑"); fireEvent.blur(instructions());
    fireEvent.change(screen.getByRole("combobox", { name: "main Harness" }), { target: { value: "claude-code" } });
    f.context.constraints = { agentHarnesses: { main: { harnessId: "codex", reason: "已有原生会话，保留原 Harness" } } };
    await recordsTab(); await userEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    await userEvent.click(screen.getByRole("tab", { name: "配置" }));
    await userEvent.click(await screen.findByRole("button", { name: "恢复原会话 Harness" }));
    expect(screen.getByRole("combobox", { name: "main Harness" })).toHaveValue("codex"); expect(instructions()).toHaveValue("保留其余编辑");
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("shares the same record column inside nested scopes and preserves unfinished shared-Agent instructions on reload", async () => {
    const f = setup(true); await ready();
    await userEvent.click(screen.getByRole("button", { name: /Research.*根图协作组/ })); await userEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const scoped = screen.getByLabelText("Research 组内 Workflow 编辑器");
    expect(within(scoped).getByRole("tab", { name: /修改记录/ })).toBeVisible();
    await userEvent.click(within(scoped).getByRole("tab", { name: /修改记录/ }));
    expect(within(scoped).getByRole("region", { name: "共用修改记录" })).toBeVisible();
    expect(scoped.querySelectorAll(".scoped-inspector")).toHaveLength(1);
    await userEvent.click(within(scoped).getByRole("tab", { name: "配置" }));
    const inner = within(scoped).getByRole("button", { name: "Inner" }).closest("li")!;
    await userEvent.click(within(inner).getByRole("button", { name: "进入" }));
    const innerScope = screen.getByLabelText("Inner 组内 Workflow 编辑器");
    await userEvent.click(within(innerScope).getByRole("button", { name: "writing" }));
    enter("嵌套共享身份未失焦草稿");
    f.view.unmount(); render(<WorkflowAdjustmentEditor {...f.props} />); await ready();
    await userEvent.click(screen.getByRole("button", { name: /Research.*根图协作组/ })); await userEvent.click(screen.getByRole("button", { name: "进入组内 Workflow" }));
    const restored = screen.getByLabelText("Research 组内 Workflow 编辑器");
    await userEvent.click(within(within(restored).getByRole("button", { name: "Inner" }).closest("li")!).getByRole("button", { name: "进入" }));
    await userEvent.click(within(screen.getByLabelText("Inner 组内 Workflow 编辑器")).getByRole("button", { name: "writing" }));
    expect(instructions()).toHaveValue("嵌套共享身份未失焦草稿");
    fireEvent.blur(instructions());
    await userEvent.click(within(screen.getByRole("dialog", { name: "确认修改共享 Agent" })).getByRole("button", { name: "应用到所有引用" }));
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { snapshot: { agents: { writing: { instructions: "嵌套共享身份未失焦草稿" } } } } });
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("closes without withdrawing a persisted request or performing a project lifecycle action", async () => {
    const f = setup(); f.context.records.push(f.record("main-one")); await ready(); enter("关闭前未失焦输入");
    await userEvent.click(screen.getByRole("button", { name: "关闭 Workflow 调整" }));
    expect(f.close).toHaveBeenCalledOnce(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled(); expect(projectAction).not.toHaveBeenCalled();
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id).kind).toBe("found");
  });
  it("keeps the same unblurred canvas draft through actual API conditional refresh and query failure", async () => {
    const f = setup(); await ready(); f.view.unmount();
    const actual = await vi.importActual<typeof import("../api")>("../api");
    vi.mocked(getWorkflowAdjustmentPage).mockImplementation(actual.getWorkflowAdjustmentPage);
    const unchangedBodies: Array<ReturnType<typeof vi.spyOn>> = [];
    const fetchMock = vi.fn().mockImplementation(async (_url, options: RequestInit) => {
      if ((options.headers as Record<string, string>)["If-None-Match"]) {
        const response = new Response(null, { status: 304, headers: { ETag: '"browser-confirmed"' } });
        unchangedBodies.push(vi.spyOn(response, "text")); return response;
      }
      return new Response(JSON.stringify(workflowAdjustmentPageFixture(f.context)), { status: 200, headers: { "Content-Type": "application/json", ETag: '"browser-confirmed"' } });
    });
    vi.stubGlobal("fetch", fetchMock); render(<WorkflowAdjustmentEditor {...f.props} />); await ready();
    const original = enter("条件查询时保留未失焦完整草稿");
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(unchangedBodies.length).toBeGreaterThan(0));
    expect(instructions()).toBe(original); expect(original).toHaveFocus();
    expect(original).toHaveValue("条件查询时保留未失焦完整草稿");
    fetchMock.mockRejectedValueOnce(new Error("controlled query disconnect"));
    act(() => window.dispatchEvent(new Event("online")));
    await screen.findByText(/修改记录查询失败，保留最近已确认内容/);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.queryByText(/修改记录查询失败，保留最近已确认内容/)).toBeNull());
    expect(instructions()).toBe(original); expect(original).toHaveValue("条件查询时保留未失焦完整草稿");
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { base: f.context.current.version } });
    for (const body of unchangedBodies) expect(body).not.toHaveBeenCalled();
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled();
    expect(projectAction).not.toHaveBeenCalled();
  });

  it("pages older metadata only on request and fetches the complete selected proposal while preserving the draft", async () => {
    const f = setup(), own = f.record("older-user", "user"); f.context.records.push(own);
    for (let i = 0; i < 60; i++) f.context.records.push(f.record(`archive-${i}`, "main", "withdrawn"));
    const archived = f.context.records[1]; archived.proposal.agents.main.instructions = "归档完整提案";
    archived.explanation = "完整公开说明\n原始第二行"; archived.history[0].note = "完整原撤回说明";
    await ready(); const originalInput = enter("保持本地完整草稿"); await recordsTab(); await screen.findByText("已载入 25 / 61 条记录");
    expect(screen.getByRole("button", { name: "继续修改自己的请求" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "查看提案 archive-0" })).toBeNull(); expect(getWorkflowAdjustmentDetail).not.toHaveBeenCalled();
    expect(screen.queryByText("完整公开说明", { exact: false })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "加载更早记录" })); await screen.findByText("已载入 50 / 61 条记录");
    await userEvent.click(screen.getByRole("button", { name: "加载更早记录" })); await screen.findByText("已载入 61 / 61 条记录");
    await userEvent.click(screen.getByRole("button", { name: "查看提案 archive-0" }));
    const complete = await screen.findByRole("region", { name: "完整请求记录" });
    expect(within(complete).getByText(/完整公开说明/)).toHaveTextContent("原始第二行");
    expect(within(complete).getByText("完整原撤回说明")).toBeInTheDocument();
    expect(getWorkflowAdjustmentDetail).toHaveBeenCalledOnce(); expect(vi.mocked(getWorkflowAdjustmentDetail).mock.calls[0][1]).toBe("archive-0");
    await userEvent.click(screen.getByRole("button", { name: "返回我的草稿" })); await userEvent.click(screen.getByRole("tab", { name: "配置" }));
    expect(instructions()).toBe(originalInput); expect(originalInput).toHaveValue("保持本地完整草稿");
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("preserves the confirmed list and draft when a later page detects an intervening journal update", async () => {
    const f = setup(); for (let i = 0; i < 51; i++) f.context.records.push(f.record(`history-${i}`, "main", "withdrawn"));
    await ready(); const original = enter("失败后原草稿保持"); await recordsTab(); await screen.findByText("已载入 25 / 51 条记录");
    vi.mocked(getWorkflowAdjustmentPage).mockImplementationOnce(async (_project, input) => workflowAdjustmentPageFixture(f.context, input))
      .mockRejectedValueOnce(new ApiError("记录在读取期间已有更新", 409));
    await userEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    await screen.findByText(/修改记录查询失败，保留最近已确认内容.*读取期间已有更新/);
    expect(screen.getByText("已载入 25 / 51 条记录")).toBeVisible(); expect(original).toHaveValue("失败后原草稿保持");
    expect(getWorkflowAdjustmentDetail).not.toHaveBeenCalled(); expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("resolves a prior withdrawal outside the first page from the exact real terminal summary", async () => {
    const f = setup(); await ready(); f.view.unmount();
    const old = f.record("old-main-operation", "main", "applied");
    f.context.current.version = { revision: 8, hash: "b".repeat(64) }; old.currentVersion = f.context.current.version;
    old.history[0].appliedVersion = f.context.current.version; f.context.records.push(old);
    for (let i = 0; i < 60; i++) f.context.records.push(f.record(`other-history-${i}`, "main", "withdrawn"));
    saveWorkflowAdjustmentOperation(localStorage, f.project.id, { kind: "withdraw", requestId: old.requestId, input: { operationId: "original-unknown-withdrawal", note: "原说明" } });
    render(<WorkflowAdjustmentEditor {...f.props} />); await ready(); await screen.findByText("该请求已应用到 r8，未撤回");
    expect(loadWorkflowAdjustmentOperation(localStorage, f.project.id).kind).toBe("empty");
    expect(vi.mocked(getWorkflowAdjustmentPage).mock.calls.some(([, input]) => input?.watchRequestId === old.requestId)).toBe(true);
    expect(loadWorkflowAdjustmentDraft(localStorage, f.project.id)).toMatchObject({ kind: "found", value: { base: { revision: 7 } } });
    expect(getWorkflowAdjustmentDetail).not.toHaveBeenCalled(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled(); expect(projectAction).not.toHaveBeenCalled();
  });

  it("retains the original complete preview on detail failure and clears that failure only after a valid retry", async () => {
    const f = setup(); f.context.records.push(f.record("preview-a", "main", "withdrawn"), f.record("preview-b", "main", "withdrawn"));
    await ready(); await recordsTab(); await userEvent.click(await screen.findByRole("button", { name: "查看提案 preview-a" }));
    await screen.findByRole("region", { name: "完整请求记录" });
    vi.mocked(getWorkflowAdjustmentDetail).mockRejectedValueOnce(new ApiError("原记录查询断线", 503));
    await userEvent.click(screen.getByRole("button", { name: "查看提案 preview-b" })); await screen.findByText(/完整记录查询失败.*原记录查询断线/);
    expect(screen.getByRole("region", { name: "完整请求记录" })).toHaveTextContent("preview-a");
    await userEvent.click(screen.getByRole("button", { name: "查看提案 preview-b" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "完整请求记录" })).toHaveTextContent("preview-b"));
    expect(screen.queryByText(/完整记录查询失败/)).toBeNull(); expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("filters loaded records by source, status and search without loading proposals or disturbing the draft", async () => {
    const f = setup();
    const leader = f.record("leader-failed", "main", "failed");
    leader.source = { kind: "scoped_leader", agentId: "reviewer", acceptedRequestId: "accepted", acceptedEventId: "event",
      invocationId: "invocation", callId: "call", nodeRunId: "node", groupRunId: "group", coordinatorEpoch: 1 };
    f.context.records.push(f.record("user-pending", "user"), f.record("main-applied", "main", "applied"), leader);
    await ready(); const original = enter("筛选时保留我的未完成草稿"); await recordsTab();
    await screen.findByRole("button", { name: "查看提案 main-applied" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "按修改来源筛选" }), "main");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "按修改状态筛选" }), "applied");
    expect(screen.getByRole("button", { name: "查看提案 main-applied" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看提案 user-pending" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看提案 leader-failed" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索修改记录" }), "reviewer");
    expect(screen.getByRole("button", { name: "查看提案 leader-failed" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看提案 main-applied" })).toBeNull();
    expect(getWorkflowAdjustmentDetail).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("tab", { name: "配置" }));
    expect(instructions()).toBe(original); expect(original).toHaveValue("筛选时保留我的未完成草稿");
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("shows readable grouped differences and the complete transition notes in a selected record", async () => {
    const f = setup(), item = f.record("readable-difference", "main", "applied");
    item.changes = [
      { path: ["agents", "main", "instructions"], kind: "changed", before: "原指令\n原第二行", after: "新的完整指令\n新第二行" },
      { path: ["agents", "idea", "experimentMcp"], kind: "changed", before: false, after: true },
      { path: ["orchestration", "decisionPlans", "idea"], kind: "changed", before: "原决策", after: "独立验证后交付" }
    ];
    item.history = [{ requestId: item.requestId, status: "pending", at: item.submittedAt },
      { requestId: item.requestId, status: "applied", at: "2026-10-10T22:01:00Z", appliedVersion: { revision: 8, hash: "b".repeat(64) }, note: "完整应用说明\n保留第二行" }];
    f.context.records.push(item); await ready(); await recordsTab();
    await userEvent.click(await screen.findByRole("button", { name: "查看提案 readable-difference" }));
    const detail = await screen.findByRole("region", { name: "完整请求记录" });
    expect(within(detail).getByRole("heading", { name: "修改说明" })).toBeVisible();
    expect(within(detail).getByText("main · Agent 指令")).toBeVisible();
    expect(within(detail).getByText("原指令 原第二行")).toHaveTextContent("原第二行");
    expect(within(detail).getByText("新的完整指令 新第二行")).toHaveTextContent("新第二行");
    expect(within(detail).getByText("执行决策 · idea")).toBeVisible();
    await userEvent.click(within(detail).getByText("idea · SII 实验工具"));
    expect(within(detail).getByText("开启", { exact: true })).toBeVisible();
    expect(within(detail).getByText("关闭", { exact: true })).toBeVisible();
    expect(within(detail).getByRole("region", { name: "请求状态时间线" })).toHaveTextContent("完整应用说明");
    expect(within(detail).getByText("完整应用说明 保留第二行")).toBeVisible();
    expect(within(detail).getByText(/基础 r7.*应用到 r8/)).toBeVisible();
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled(); expect(withdrawWorkflowAdjustment).not.toHaveBeenCalled();
  });

  it("keeps filters through pagination and proposal previews when a match is outside the first page", async () => {
    const f = setup(); f.context.records.push(f.record("older-user-match", "user", "withdrawn"));
    for (let i = 0; i < 30; i++) f.context.records.push(f.record(`recent-main-${i}`, "main", "applied"));
    await ready(); enter("加载更早记录也保留的草稿"); await recordsTab();
    await screen.findByText("已载入 25 / 31 条记录");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "按修改来源筛选" }), "user");
    expect(screen.getByText(/已载入记录中没有符合条件的修改/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    await userEvent.click(await screen.findByRole("button", { name: "查看提案 older-user-match" }));
    await screen.findByRole("region", { name: "完整请求记录" });
    expect(screen.getByRole("combobox", { name: "按修改来源筛选" })).toHaveValue("user");
    expect(screen.queryByRole("button", { name: "查看提案 recent-main-0" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "返回我的草稿" }));
    await userEvent.click(screen.getByRole("tab", { name: "配置" }));
    expect(instructions()).toHaveValue("加载更早记录也保留的草稿");
    expect(getWorkflowAdjustmentDetail).toHaveBeenCalledOnce();
    expect(submitWorkflowAdjustment).not.toHaveBeenCalled();
  });

});
