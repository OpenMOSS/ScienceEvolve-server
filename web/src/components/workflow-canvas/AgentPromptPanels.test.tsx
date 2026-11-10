import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENTS, normalizeAgentOrchestration } from "../../lib";
import { AgentPromptPanels } from "./AgentPromptPanels";
import { CanvasInspector } from "./CanvasInspector";
import { getCatalog, getHarnessPrompt } from "../../api";
import type { Catalog, HarnessPromptResult } from "../../types";

vi.mock("../../api", async importOriginal => ({ ...await importOriginal<typeof import("../../api")>(),
  getCatalog: vi.fn(async () => ({ mainSystemPrompt: "FIXED_MAIN_SYSTEM" })),
  getHarnessPrompt: vi.fn() }));

function result(model: string): HarnessPromptResult {
  return { harness: "codex", model, resolvedModel: model, installedVersion: "0.153.4", status: "available",
    sourceType: "bundled-default", source: "installed bundled models", scope: "base-default", collectedAt: "2026-10-27T12:00:00Z",
    configurationDigest: "digest", text: `NATIVE_${model}` };
}

describe("canvas Prompt sources", () => {
  it("shows runtime permission rules for workers and updates them with unsaved permission changes", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValue(result("a"));
    const agent = { ...DEFAULT_AGENTS.writing, harness: "dsh", model: "a", permission: "workspace" as const };
    const { rerender } = render(<AgentPromptPanels agentId="writing" agent={agent} />);
    expect(screen.getByLabelText("System Prompt")).toHaveProperty("value", expect.stringContaining("ScienceEvolve permission mode: workspace."));
    expect(screen.getByLabelText("System Prompt")).toHaveProperty("value", expect.not.stringContaining("OpenFARS"));
    expect(screen.getByLabelText("System Prompt")).toHaveAttribute("readonly");
    rerender(<AgentPromptPanels agentId="writing" agent={{ ...agent, permission: "compute" }} />);
    expect(screen.getByLabelText("System Prompt")).toHaveProperty("value", expect.stringContaining("ScienceEvolve permission mode: compute."));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新提示词" })).toBeEnabled());
  });

  it("forces fresh collection, prevents repeated clicks, and preserves the last text on a failed refresh", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValueOnce(result("refresh"));
    render(<AgentPromptPanels agentId="writing" agent={{ ...DEFAULT_AGENTS.writing, harness: "pi", model: "refresh" }} />);
    await waitFor(() => expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_refresh"));
    let fail!: (reason: Error) => void;
    vi.mocked(getHarnessPrompt).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "刷新提示词" }));
    expect(screen.getByRole("button", { name: "正在读取提示词…" })).toBeDisabled();
    expect(getHarnessPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ model: "refresh" }), expect.any(AbortSignal), true);
    await act(async () => fail(new Error("读取安装失败")));
    expect(screen.getByRole("alert")).toHaveTextContent("刷新失败：读取安装失败");
    expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_refresh");
    expect(screen.getByRole("button", { name: "刷新提示词" })).toBeEnabled();
  });

  it("keeps System/Harness read-only while editing only the original user configuration", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValue(result("a"));
    const patch = vi.fn();
    const config = { ...DEFAULT_AGENTS.main, harness: "codex", model: "a", instructions: "USER_CONFIGURATION" };
    const props = { node: { id: "main", kind: "agent" as const, name: "main", x: 0, y: 0 }, agent: config,
      orchestration: normalizeAgentOrchestration(undefined), onAgentPatch: patch };
    const { rerender } = render(<CanvasInspector {...props} />);
    await waitFor(() => expect(screen.getByLabelText("System Prompt")).toHaveValue("FIXED_MAIN_SYSTEM"));
    expect(screen.getByLabelText("System Prompt")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Harness Prompt")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_a");
    expect(screen.getByText(/基础默认文本/)).toBeVisible();
    expect(patch).not.toHaveBeenCalled();
    const user = screen.getByDisplayValue("USER_CONFIGURATION");
    fireEvent.change(user, { target: { value: "EDITED_USER_CONFIGURATION" } }); fireEvent.blur(user);
    expect(patch).toHaveBeenCalledWith({ instructions: "EDITED_USER_CONFIGURATION" });
    rerender(<CanvasInspector {...props} readOnly />);
    expect(screen.getByDisplayValue("EDITED_USER_CONFIGURATION")).toBeDisabled();
    expect(screen.getByLabelText("Harness Prompt")).toHaveAttribute("readonly");
  });

  it("never shows a prior Agent/model response after a slower query resolves", async () => {
    let finishA!: (value: HarnessPromptResult) => void;
    let finishB!: (value: HarnessPromptResult) => void;
    vi.mocked(getHarnessPrompt).mockImplementation(config => new Promise(resolve => {
      if (config.model === "a") finishA = resolve; else finishB = resolve;
    }));
    const config = { ...DEFAULT_AGENTS.idea, harness: "codex", model: "a" };
    const { rerender } = render(<AgentPromptPanels agentId="analysis" agent={config} />);
    rerender(<AgentPromptPanels agentId="charts" agent={{ ...config, model: "b" }} />);
    await act(async () => finishA(result("a")));
    expect(screen.queryByDisplayValue("NATIVE_a")).toBeNull();
    await act(async () => finishB(result("b")));
    expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_b");
    expect(screen.getByLabelText("System Prompt")).toHaveProperty("value", expect.stringContaining("ScienceEvolve permission mode:"));
    expect(screen.queryByDisplayValue("FIXED_MAIN_SYSTEM")).toBeNull();
  });

  it("shows an actual source failure with the selected model and installed version", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValue({ ...result("custom"), status: "source-unavailable", text: undefined,
      reason: "当前安装版模板读取失败" });
    render(<AgentPromptPanels agentId="worker" agent={{ ...DEFAULT_AGENTS.idea, harness: "codex", model: "custom" }} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("当前安装版模板读取失败"));
    expect(screen.getByRole("alert")).toHaveTextContent("codex 0.153.4 · 模型：custom");
    expect(screen.getByRole("alert")).toHaveTextContent("无法显示 Harness Prompt");
    expect(screen.queryByLabelText("Harness Prompt")).toBeNull();
  });

  it.each(["gpt-6.1-sol", "deepseek-chat", "qwen3-coder", "claude-sonnet-4-5"])(
    "displays the Codex Prompt and its actual template for %s", async model => {
    vi.mocked(getHarnessPrompt).mockResolvedValue({ ...result(model), resolvedModel: "gpt-5.5",
      text: "ACTUAL_GATEWAY_PROMPT", scopeNote: `网关运行使用安装版 gpt-5.5 的基础 Prompt 模板，请求模型仍为 ${model}。` });
    render(<AgentPromptPanels agentId="worker" agent={{ ...DEFAULT_AGENTS.idea, harness: "codex", model }} />);
    await waitFor(() => expect(screen.getByLabelText("Harness Prompt")).toHaveValue("ACTUAL_GATEWAY_PROMPT"));
    expect(screen.getByLabelText("Harness Prompt")).toHaveAttribute("readonly");
    expect(screen.getByText(/Prompt 模板：gpt-5.5/)).toHaveTextContent(`模型：${model}`);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed default Harness lookup for workers and allows a manual refresh", async () => {
    vi.mocked(getHarnessPrompt).mockClear().mockResolvedValue(result("default"));
    vi.mocked(getCatalog).mockRejectedValueOnce(new Error("目录连接失败"));
    const agent = { ...DEFAULT_AGENTS.idea, harness: undefined, model: "default" };
    render(<AgentPromptPanels agentId="worker" agent={agent} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("无法读取默认 Harness：目录连接失败"));
    expect(screen.getByRole("button", { name: "刷新提示词" })).toBeEnabled();
    expect(getHarnessPrompt).not.toHaveBeenCalled();
    vi.mocked(getCatalog).mockResolvedValueOnce({ defaultHarnessId: "codex", mainSystemPrompt: "FIXED_MAIN_SYSTEM" } as Catalog);
    fireEvent.click(screen.getByRole("button", { name: "刷新提示词" }));
    await waitFor(() => expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_default"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a catalog without a default Harness instead of waiting indefinitely", async () => {
    vi.mocked(getHarnessPrompt).mockClear();
    vi.mocked(getCatalog).mockResolvedValueOnce({ mainSystemPrompt: "FIXED_MAIN_SYSTEM" } as Catalog);
    render(<AgentPromptPanels agentId="worker" agent={{ ...DEFAULT_AGENTS.idea, harness: undefined, model: "a" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新提示词" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("未找到默认 Harness，请先选择 Harness。");
    expect(getHarnessPrompt).not.toHaveBeenCalled();
  });

  it("keeps the Harness section visible without querying an empty model", () => {
    vi.mocked(getHarnessPrompt).mockClear();
    render(<AgentPromptPanels agentId="worker" agent={{ ...DEFAULT_AGENTS.idea, harness: "codex", model: "" }} />);
    expect(screen.getByText("Harness Prompt")).toBeVisible();
    expect(screen.getByText("尚未选择模型，选择后可查询 Harness Prompt。")).toBeVisible();
    expect(getHarnessPrompt).not.toHaveBeenCalled();
  });
});
