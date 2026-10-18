import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../lib";
import type { Catalog, CreateProjectInput, ProjectExplainerEvent, ProjectExplainerRuntimeConfig } from "../types";
import { ProjectExplainerAssistantProvider, useExplainerDraftBridge } from "./ProjectExplainerAssistant";

vi.mock("../api", async importOriginal => ({ ...await importOriginal<typeof import("../api")>(),
  createExplainerConversation: vi.fn(), getExplainerConversation: vi.fn(), getExplainerConversationHistory: vi.fn(),
  getExplainerConversationConfig: vi.fn(), getCatalog: vi.fn(), syncExplainerConversation: vi.fn(),
  streamExplainerConversation: vi.fn(), cancelExplainerConversation: vi.fn(), updateExplainerConversationConfig: vi.fn(),
  undoExplainerDraft: vi.fn(), createProject: vi.fn()
}));

const id = `exp_${"a".repeat(32)}`, taskId = `task_${"b".repeat(32)}`, gatewayId = `gwy_${"c".repeat(32)}`;
let backend: api.ExplainerAssistantContext, history: ProjectExplainerEvent[], serial: number;
const runtimeConfig: ProjectExplainerRuntimeConfig = { schemaVersion: 2, harness: "codex", gatewayId, model: "configured-model",
  reasoningEffort: "high", nativeProtocol: "responses", gatewayProtocol: "responses", routeMode: "direct", available: true,
  revision: 0, updatedAt: "2026-10-14T00:00:00.000Z", validationWarning: "当前组合尚未验证，仍可使用。" };
const catalog = { gateways: [{ id: gatewayId, name: "默认网关", models: ["configured-model", "other-model"], defaultModel: "configured-model" }],
  harnesses: [{ id: "codex", label: "Codex", purposes: ["workflow", "explainer"], available: true, capabilities: { readOnlyExplainer: true } },
    { id: "pi", label: "Pi", purposes: ["workflow", "explainer"], available: true, capabilities: { readOnlyExplainer: true } }] } as Catalog;
function draft(title = "当前课题"): CreateProjectInput {
  return { title, requirement: "分析合成数据并提供可复现的验证结果", agents: structuredClone(DEFAULT_AGENTS),
    orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION), git: { enabled: false } };
}
function event(kind: ProjectExplainerEvent["kind"], text: string, data?: Record<string, unknown>): ProjectExplainerEvent {
  return { id: `event_${++serial}`, projectId: id, turnId: "turn-a", ts: new Date().toISOString(), kind, text, phase: "completed", ...(data ? { data } : {}) };
}
function action(title = "助手设计的课题", revision = backend.revision + 1): api.ExplainerAssistantAction {
  backend = { ...backend, revision, taskId, draft: { ...backend.draft, title } };
  return { kind: "draft.saved", context: structuredClone(backend), summary: "已保存草稿，尚未启动运行。", href: `/saved-tasks/${taskId}/edit` };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "打开 Project Explainer 助手" }));
  await waitFor(() => expect(api.getExplainerConversationConfig).toHaveBeenCalled());
  await screen.findByText("codex · configured-model");
}
async function send(text = "帮我修改并保存草稿") {
  fireEvent.change(screen.getByRole("textbox", { name: "给 Project Explainer 的消息" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(api.streamExplainerConversation).toHaveBeenCalled());
}
function deferredStream() {
  let complete!: () => void, sink!: (event: ProjectExplainerEvent) => Promise<void> | void;
  let signal: AbortSignal | undefined;
  vi.mocked(api.streamExplainerConversation).mockImplementation(async (_id, _question, receive, activeSignal) => {
    sink = receive; signal = activeSignal; await new Promise<void>(resolve => { complete = resolve; });
  });
  return { get signal() { return signal; }, emit: async (incoming: ProjectExplainerEvent) => { history.push(incoming); await sink(incoming); }, finish: () => complete() };
}
function Editor() {
  const [value, setValue] = useState(draft());
  useExplainerDraftBridge({ key: "new", active: true, draft: value, apply: next => setValue(next) });
  return <input aria-label="手动课题名称" value={value.title} onChange={event => setValue(current => ({ ...current, title: event.target.value }))} />;
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); serial = 0; history = [];
  backend = { id, revision: 0, draft: draft(), updatedAt: new Date().toISOString() };
  vi.mocked(api.createExplainerConversation).mockImplementation(async () => structuredClone(backend));
  vi.mocked(api.getExplainerConversation).mockImplementation(async () => structuredClone(backend));
  vi.mocked(api.getExplainerConversationHistory).mockImplementation(async () => ({ active: false, events: structuredClone(history) }));
  vi.mocked(api.getExplainerConversationConfig).mockResolvedValue(runtimeConfig);
  vi.mocked(api.getCatalog).mockResolvedValue(catalog);
  vi.mocked(api.syncExplainerConversation).mockImplementation(async (_id, input) => {
    backend = { ...backend, revision: backend.revision + 1, draft: input.draft ?? backend.draft, ...(input.taskId ? { taskId: input.taskId } : {}) };
    return structuredClone(backend);
  });
  vi.mocked(api.updateExplainerConversationConfig).mockImplementation(async (_id, input) => ({ ...runtimeConfig, ...input, revision: 1 }));
  vi.mocked(api.cancelExplainerConversation).mockResolvedValue();
});

describe("shared Project Explainer floating assistant", () => {
  it("does not overlap slow history polls for a remotely active conversation", async () => {
    vi.mocked(api.getExplainerConversationHistory).mockResolvedValueOnce({ active: true, events: [] });
    vi.useFakeTimers();
    const view = render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    try {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "打开 Project Explainer 助手" })); });
      expect(api.getExplainerConversationHistory).toHaveBeenCalledTimes(1);
      vi.mocked(api.getExplainerConversationHistory).mockImplementation(() => new Promise(() => undefined));
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(api.getExplainerConversationHistory).toHaveBeenCalledTimes(2);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("shows one semantic progress line without raw lifecycle logs during streaming and reload", async () => {
    const stream = deferredStream();
    const view = render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open(); await send();
    const logs = ["Invocation gateway route ready", "Starting Codex process for __explainer__", "Codex thread started",
      "item.completed: error", "Protocol proxy forwarded request", "模型正在生成回复…", "Protocol proxy stream finished", "Codex turn completed"];
    await act(async () => {
      await stream.emit({ ...event("assistant", "当前研究正在进行中。"), itemId: "answer-1", phase: "delta" });
      for (const text of logs) await stream.emit({ ...event("status", text, { diagnostic: true }), phase: "delta" });
    });
    for (const text of logs) expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Project Explainer 回复状态")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Project Explainer 回复状态" })).toHaveTextContent("正在生成回复…");
    const quarantine = "Protocol proxy quarantined a request after malformed tool arguments".repeat(4);
    await act(async () => {
      await stream.emit({ ...event("error", quarantine, { diagnostic: true, errorCode: "PROTOCOL_TOOL_ARGUMENTS_INVALID" }), phase: "delta" });
      await stream.emit({ ...event("status", "恢复中", { diagnostic: true, automaticRecovery: true }), phase: "delta" });
    });
    expect(screen.queryByText(quarantine)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Project Explainer 回复状态")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Project Explainer 回复状态" })).toHaveTextContent("正在自动恢复");
    await act(async () => { await stream.emit(event("status", "回答完成", { turnComplete: true })); stream.finish(); });
    await waitFor(() => expect(screen.getByRole("status", { name: "Project Explainer 回复状态" })).toHaveTextContent("回答完成"));
    view.unmount(); render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>); await open();
    for (const text of logs) expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Project Explainer 回复状态")).toHaveLength(1);
    expect(screen.queryByText(quarantine)).not.toBeInTheDocument();
    expect(screen.getByText("当前研究正在进行中。")).toBeVisible();
  });

  it("keeps a fatal streamed error visible with its actual explanation", async () => {
    const stream = deferredStream();
    render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open(); await send();
    await act(async () => { await stream.emit(event("error", "网关连接失败，请稍后重试。", { diagnostic: true })); stream.finish(); });
    expect(await screen.findByRole("alert")).toHaveTextContent("网关连接失败，请稍后重试。");
    expect(screen.getByRole("status", { name: "Project Explainer 回复状态" })).toHaveTextContent("回答失败");
  });

  it("shows live tool steps, streamed public summaries and actual failure results after a history reload", async () => {
    const stream = deferredStream();
    const view = render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open(); await send();
    const tool = { ...event("tool", "get_context", { canonicalEvent: { kind: "tool.started",
      tool: { callId: "read-1", name: "get_context", status: "started", input: { scope: "current" } } } }), itemId: "read-1", phase: "started" as const };
    await act(async () => { await stream.emit(tool); });
    expect(screen.getByLabelText("读取当前配置：执行中")).toBeVisible();
    const summary = { ...event("reasoning", "读取配置，", { publicSummary: true }), itemId: "summary-1", phase: "delta" as const };
    await act(async () => { await stream.emit(summary); await stream.emit({ ...summary, id: "summary-2", text: "再核对版本。" }); await stream.emit(summary); });
    expect(screen.getByText("思考摘要")).toBeVisible();
    expect(screen.getByText("读取配置，再核对版本。")).toBeVisible();
    const failed = { ...event("tool", "get_context", { canonicalEvent: { kind: "tool.failed",
      tool: { callId: "read-1", name: "get_context", status: "failed", isError: true, outputPreview: "版本发生冲突", durationMs: 1200 } } }), itemId: "read-1" };
    await act(async () => { await stream.emit(failed); await stream.emit({ ...event("tool_output", "版本发生冲突", failed.data), itemId: "read-1" }); stream.finish(); });
    expect(screen.getAllByLabelText("读取当前配置：调用失败")).toHaveLength(1);
    fireEvent.click(screen.getByText("查看错误详情")); expect(screen.getByText("版本发生冲突")).toBeVisible();
    expect(screen.getByText("耗时 1.2 秒")).toBeVisible();
    view.unmount(); render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>); await open();
    expect(screen.getAllByLabelText("读取当前配置：调用失败")).toHaveLength(1);
    expect(screen.getAllByText("思考摘要")).toHaveLength(1);
  });

  it("shows deltas while the turn is running and replaces them with one completed message across reloads", async () => {
    const stream = deferredStream();
    const view = render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open(); await send();
    const first = { ...event("assistant", "正在设计"), itemId: "assistant-0-0", phase: "delta" as const };
    await act(async () => { await stream.emit(first); });
    expect(screen.getByText("正在设计")).toBeVisible();
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
    const second = { ...event("assistant", "并行流程。"), itemId: first.itemId, phase: "delta" as const };
    await act(async () => { await stream.emit(second); await stream.emit(second); });
    expect(screen.getAllByText("正在设计并行流程。")).toHaveLength(1);
    expect(screen.queryByText("正在设计并行流程。并行流程。")).not.toBeInTheDocument();
    await act(async () => {
      await stream.emit({ ...event("assistant", "已完成并行流程设计。"), itemId: first.itemId });
      stream.finish();
    });
    expect(screen.getAllByText("已完成并行流程设计。")).toHaveLength(1);
    expect(screen.queryByText("正在设计并行流程。")).not.toBeInTheDocument();
    view.unmount();
    render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open();
    expect(screen.getAllByText("已完成并行流程设计。")).toHaveLength(1);
    expect(screen.queryByText("正在设计并行流程。")).not.toBeInTheDocument();
  });

  it("saves an actual-result card and lets the user choose navigation without launching research", async () => {
    vi.mocked(api.streamExplainerConversation).mockImplementation(async (_id, question, sink) => {
      const events = [event("user", question), event("status", "草稿已保存", { assistantAction: action() }), event("assistant", "已设计并保存，可以先查看草稿。")];
      history.push(...events); for (const incoming of events) await sink(incoming);
    });
    const view = render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open(); await send();
    expect(await screen.findByRole("link", { name: "打开项目草稿" })).toHaveAttribute("href", `#/saved-tasks/${taskId}/edit`);
    expect(api.createProject).not.toHaveBeenCalled();
    view.rerender(<ProjectExplainerAssistantProvider target={{ taskId, newProject: true }}>草稿编辑页</ProjectExplainerAssistantProvider>);
    await waitFor(() => expect(api.createExplainerConversation).toHaveBeenLastCalledWith({ taskId }));
    expect(api.getExplainerConversationHistory).toHaveBeenLastCalledWith(id);
    expect(await screen.findByText("已设计并保存，可以先查看草稿。")).toBeVisible();
  });

  it("keeps the same active stream when minimized and reopened", async () => {
    const stream = deferredStream();
    render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open(); await send();
    fireEvent.click(screen.getByRole("button", { name: "最小化助手" }));
    await open(); expect(api.createExplainerConversation).toHaveBeenCalledTimes(1); expect(stream.signal?.aborted).toBe(false);
    await act(async () => { await stream.emit(event("assistant", "仍然沿用刚才的回答。")); stream.finish(); });
    expect(screen.getByText("仍然沿用刚才的回答。")).toBeVisible();
  });

  it("preserves manual edits made during generation and applies agent changes only on the user's choice", async () => {
    const stream = deferredStream();
    render(<ProjectExplainerAssistantProvider target={{ newProject: true }}><Editor /></ProjectExplainerAssistantProvider>);
    await open(); await send();
    fireEvent.change(screen.getByRole("textbox", { name: "手动课题名称" }), { target: { value: "用户刚改的标题" } });
    await act(async () => { await stream.emit(event("status", "保存完成", { assistantAction: action("助手的改动") })); stream.finish(); });
    expect(screen.getByRole("textbox", { name: "手动课题名称" })).toHaveValue("用户刚改的标题");
    expect(screen.getByText(/已保留手动编辑/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "应用助手修改" }));
    expect(screen.getByRole("textbox", { name: "手动课题名称" })).toHaveValue("助手的改动");
  });

  it("allows unverified models and saves configurable Harness/model fields without response-only metadata", async () => {
    render(<ProjectExplainerAssistantProvider target={{}}>首页</ProjectExplainerAssistantProvider>);
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "给 Project Explainer 的消息" }), { target: { value: "继续调整" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "助手 Harness 与模型设置" }));
    fireEvent.change(screen.getByRole("combobox", { name: "助手 Harness" }), { target: { value: "pi" } });
    fireEvent.change(screen.getByRole("combobox", { name: "助手模型" }), { target: { value: "other-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存助手配置" }));
    await waitFor(() => expect(api.updateExplainerConversationConfig).toHaveBeenCalledWith(id, {
      harness: "pi", gatewayId, model: "other-model", reasoningEffort: "high"
    }));
    expect(await screen.findByText("Project Explainer 配置已更新，已有对话历史保留。")).toBeVisible();
  });

  it("does not reuse a saved project's conversation for a fresh new project form", async () => {
    localStorage.setItem("openfars.explainer.conversation.new", id);
    vi.mocked(api.getExplainerConversation).mockResolvedValue({ ...backend, taskId });
    backend = { ...backend, id: `exp_${"d".repeat(32)}` };
    render(<ProjectExplainerAssistantProvider target={{ newProject: true }}><Editor /></ProjectExplainerAssistantProvider>);
    await open();
    expect(api.getExplainerConversation).toHaveBeenCalledWith(id); expect(api.createExplainerConversation).toHaveBeenCalledWith({});
    expect(api.getExplainerConversationConfig).toHaveBeenCalledWith(backend.id);
  });

  it("does not apply an old tool receipt over a later successful edit", async () => {
    const stream = deferredStream();
    render(<ProjectExplainerAssistantProvider target={{ newProject: true }}><Editor /></ProjectExplainerAssistantProvider>);
    await open(); await send();
    await act(async () => {
      const earlier = action("旧结果", 2); await stream.emit(event("status", "旧修改", { assistantAction: earlier }));
      await stream.emit(event("status", "新修改", { assistantAction: action("最新结果", 3) }));
      await stream.emit(event("status", "重放旧回执", { assistantAction: earlier })); stream.finish();
    });
    expect(screen.getByRole("textbox", { name: "手动课题名称" })).toHaveValue("最新结果");
  });
});
