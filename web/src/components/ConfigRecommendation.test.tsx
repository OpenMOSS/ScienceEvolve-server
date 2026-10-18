import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecommendationExplainerConfig, updateRecommendationExplainerConfig, recommendProjectConfig, type ConfigRecommendationResponse, type ExplainerRecommendationConfiguration } from "../api";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../lib";
import { ConfigRecommendation } from "./ConfigRecommendation";
import type { GatewayRecord } from "../types";

vi.mock("../api", () => ({ recommendProjectConfig: vi.fn(), getRecommendationExplainerConfig: vi.fn(), updateRecommendationExplainerConfig: vi.fn(), updateProjectExplainerConfig: vi.fn() }));
let source: ExplainerRecommendationConfiguration;
const input = { title: "新课题", requirement: "分析实验结果并形成完整报告", agents: structuredClone(DEFAULT_AGENTS), orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION) };
const gateways: GatewayRecord[] = [
  { id: "gateway-other", name: "备用网关", models: ["other-model", "shared-model"], defaultModel: "other-model", protocol: "chat-completions", revision: 1, url: "https://other.example/v1", apiKeyConfigured: true, test: { status: "untested" }, createdAt: "", updatedAt: "" },
  { id: "gateway-main", name: "默认网关", models: ["first-model", "default-model", "shared-model"], defaultModel: "default-model", protocol: "responses", revision: 2, url: "https://main.example/v1", apiKeyConfigured: true, test: { status: "passed", model: "default-model", protocol: "responses", gatewayRevision: 2, probeKind: "route" }, createdAt: "", updatedAt: "" }
];
function recommendation(): ConfigRecommendationResponse {
  const config = structuredClone(input);
  config.agents.idea.instructions = "推荐的研究方案 Prompt";
  config.orchestration.termination.condition = "验证全部成功标准后完成";
  return { recommendation: config, warnings: ["请检查实验资源。"], configurationFingerprint: "e".repeat(64) };
}

describe("configuration recommendation", () => {
  afterEach(() => { delete window.ELK; window.__openfarsElkPromise = undefined; });
  beforeEach(() => {
    vi.resetAllMocks();
    // Exercise the real deterministic planner without jsdom waiting for a
    // browser-only script load before taking the supported fallback path.
    window.ELK = class { async layout() { return { children: [] }; } };
    window.__openfarsElkPromise = undefined;
    source = { fingerprint: "e".repeat(64), config: { schemaVersion: 2, harness: "codex", gatewayId: "gateway-main", nativeProtocol: "responses", gatewayProtocol: "responses", model: "default-model", reasoningEffort: "high", revision: 1, updatedAt: "", available: true, routeMode: "direct" } };
    vi.mocked(getRecommendationExplainerConfig).mockImplementation(async () => structuredClone(source));
    vi.mocked(updateRecommendationExplainerConfig).mockImplementation(async input => {
      source = { fingerprint: "f".repeat(64), config: { ...source.config, ...input, reasoningEffort: input.reasoningEffort ?? "medium", revision: 2 } };
      return structuredClone(source);
    });
  });

  it("uses the actual Explainer config instead of an independent advisor selector", async () => {
    vi.mocked(recommendProjectConfig).mockResolvedValue(recommendation());
    render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-other" input={input} onApply={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    expect(screen.queryByLabelText("配置顾问网关")).not.toBeInTheDocument();
    expect(screen.getByText("default-model", { selector: "strong" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    expect(recommendProjectConfig).toHaveBeenCalledWith({ ...input, configurationFingerprint: source.fingerprint }, expect.any(AbortSignal), expect.any(Function));
    expect(vi.mocked(recommendProjectConfig).mock.calls[0][0]).not.toHaveProperty("advisor");
  });

  it("uses the staged inputs folder and purpose note", async () => {
    vi.mocked(recommendProjectConfig).mockResolvedValue(recommendation());
    render(<ConfigRecommendation gateways={gateways} input={input} files={[{ path: "reference.png", size: 4 }]} inputUploadId="upload-token" inputDescription="图片是目标风格" onApply={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    expect(recommendProjectConfig).toHaveBeenCalledWith(expect.objectContaining({ inputUploadId: "upload-token", inputDescription: "图片是目标风格", configurationFingerprint: source.fingerprint }), expect.any(AbortSignal), expect.any(Function));
  });

  it("saves the shared Explainer config and uses its accepted fingerprint", async () => {
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "调整推荐模型" }));
    await userEvent.selectOptions(screen.getByLabelText("推荐 Explainer 模型"), "shared-model");
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(source.config.model).toBe("shared-model"));
    expect(updateRecommendationExplainerConfig).toHaveBeenCalledWith(expect.objectContaining({ harness: "codex", model: "shared-model", reasoningEffort: "high" }), expect.any(AbortSignal));
    vi.mocked(recommendProjectConfig).mockResolvedValue({ ...recommendation(), configurationFingerprint: source.fingerprint });
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(recommendProjectConfig).toHaveBeenCalledWith(expect.objectContaining({ configurationFingerprint: "f".repeat(64) }), expect.any(AbortSignal), expect.any(Function));
  });

  it("disables generation when the real Explainer is unavailable or missing", async () => {
    source.config.available = false; source.config.validationError = "Explainer 配置不可用";
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Explainer 配置不可用");
    expect(screen.getByRole("button", { name: "推荐配置" })).toBeDisabled();
    expect(recommendProjectConfig).not.toHaveBeenCalled();
  });

  it("rejects a response when the accepted Explainer config changes while generating", async () => {
    const apply = vi.fn();
    vi.mocked(recommendProjectConfig).mockImplementation(async () => { source.fingerprint = "f".repeat(64); return recommendation(); });
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(getRecommendationExplainerConfig).toHaveBeenCalledTimes(4));
    expect(apply).not.toHaveBeenCalled();
  });

  it("requires task inputs and automatically applies the complete recommendation", async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    vi.mocked(recommendProjectConfig).mockResolvedValue(recommendation());
    const view = render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={{ ...input, title: "" }} onApply={apply} />);
    expect(screen.getByRole("button", { name: "推荐配置" })).toBeDisabled();
    view.rerender(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({
      agents: recommendation().recommendation.agents,
      orchestration: expect.objectContaining(recommendation().recommendation.orchestration)
    }));
    expect(apply.mock.calls[0]![0].orchestration.canvas?.layoutMode).toBe("layered");
    expect(screen.getByText("请检查实验资源。")).toBeVisible();
    expect(screen.getByText(/推荐配置已自动填入/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "推荐配置预览" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "一键应用全部" })).not.toBeInTheDocument();
  });

  it("shows real processing phases then summarizes the automatically applied changes in the same dialog", async () => {
    let resolve!: (value: ConfigRecommendationResponse) => void;
    vi.mocked(recommendProjectConfig).mockReturnValue(new Promise(done => { resolve = done; }));
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    const dialog = await screen.findByRole("dialog", { name: "正在生成推荐配置" });
    await waitFor(() => expect(recommendProjectConfig).toHaveBeenCalledOnce());
    const progress = vi.mocked(recommendProjectConfig).mock.calls[0]![2]!;
    act(() => progress({ phase: "generation", message: "正在设计 Agent 与工作流" }));
    expect(within(dialog).getByText("推荐模型：默认网关 · default-model")).toBeVisible();
    expect(within(dialog).getByText("第 2 / 4 阶段")).toBeVisible();
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(within(dialog).getByText("正在设计 Agent 与工作流")).toBeVisible();
    act(() => progress({ phase: "recovery", message: "正在修复推荐格式并重新生成" }));
    expect(within(dialog).getByText("正在修复推荐格式并重新生成")).toBeVisible();
    act(() => progress({ phase: "validation", message: "正在校验推荐" }));
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    act(() => progress({ phase: "recovery", message: "正在修复推荐格式并重新生成" }));
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await act(async () => resolve(recommendation()));
    expect(apply).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "推荐配置已完成" })).toBe(dialog);
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(within(dialog).getByText("100%")).toBeVisible();
    const summary = within(dialog).getByRole("region", { name: "本次配置修改摘要" });
    expect(within(summary).getByText("idea")).toBeVisible();
    expect(within(summary).getByText("职责提示词已更新")).toBeVisible();
    expect(within(summary).getByText("终止条件")).toBeVisible();
    expect(within(summary).getByText("本次推荐调整 1 个 Agent，更新 1 项 Workflow 设置。")).toBeVisible();
    expect(within(summary).getByText("推荐团队共 5 个 Agent，任务入口为 idea，终止节点为 review。")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "完成，查看配置" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看本次修改" }));
    expect(screen.getByRole("region", { name: "本次配置修改摘要" })).toBeVisible();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("cancels generation and ignores late progress and results without applying them", async () => {
    let resolve!: (value: ConfigRecommendationResponse) => void;
    vi.mocked(recommendProjectConfig).mockReturnValue(new Promise(done => { resolve = done; }));
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(recommendProjectConfig).toHaveBeenCalledOnce());
    const [, signal, progress] = vi.mocked(recommendProjectConfig).mock.calls[0]!;
    await userEvent.click(screen.getByRole("button", { name: "取消推荐" }));
    expect(signal?.aborted).toBe(true);
    act(() => progress!({ phase: "validation", message: "迟到的进度" }));
    await act(async () => resolve(recommendation()));
    expect(screen.getByRole("dialog", { name: "推荐配置已取消" })).toBeVisible();
    expect(screen.queryByText("迟到的进度")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "本次配置修改摘要" })).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });

  it("still finishes and explains when the recommended settings are unchanged", async () => {
    vi.mocked(recommendProjectConfig).mockResolvedValue({ recommendation: structuredClone(input), warnings: [], configurationFingerprint: source.fingerprint });
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    const dialog = await screen.findByRole("dialog", { name: "推荐配置已完成" });
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(within(dialog).getByText("推荐结果与当前配置一致，没有需要修改的内容。")).toBeVisible();
    expect(within(dialog).getByText("画布布局已自动整理。")).toBeVisible();
  });

  it("finishes with a summary after refocusing the window refreshes the unchanged Explainer configuration", async () => {
    let resolve!: (value: ConfigRecommendationResponse) => void;
    let resolveRefresh!: (value: ExplainerRecommendationConfiguration) => void;
    vi.mocked(recommendProjectConfig).mockReturnValue(new Promise(done => { resolve = done; }));
    vi.mocked(getRecommendationExplainerConfig)
      .mockResolvedValueOnce(structuredClone(source))
      .mockResolvedValueOnce(structuredClone(source))
      .mockImplementationOnce(() => new Promise(done => { resolveRefresh = done; }));
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(recommendProjectConfig).toHaveBeenCalledOnce());
    const signal = vi.mocked(recommendProjectConfig).mock.calls[0]![1]!;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(resolveRefresh).toBeDefined());
    expect(signal.aborted).toBe(false);
    await act(async () => resolveRefresh(structuredClone(source)));
    expect(signal.aborted).toBe(false);
    await act(async () => resolve(recommendation()));
    expect(apply).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "推荐配置已完成" })).toBeVisible();
    expect(screen.getByRole("region", { name: "本次配置修改摘要" })).toBeVisible();
  });

  it("still cancels after refocusing detects a different Explainer configuration", async () => {
    vi.mocked(recommendProjectConfig).mockReturnValue(new Promise(() => {}));
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(recommendProjectConfig).toHaveBeenCalledOnce());
    const signal = vi.mocked(recommendProjectConfig).mock.calls[0]![1]!;
    source.fingerprint = "f".repeat(64);
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByRole("dialog", { name: "推荐配置已取消" });
    expect(signal.aborted).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("allows retrying a failed recommendation from the dialog", async () => {
    vi.mocked(recommendProjectConfig).mockRejectedValueOnce(new Error("模型暂时不可用")).mockResolvedValueOnce(recommendation());
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("模型暂时不可用");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", "100");
    expect(screen.queryByRole("region", { name: "本次配置修改摘要" })).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "重新推荐" }));
    expect(await screen.findByRole("dialog", { name: "推荐配置已完成" })).toBeVisible();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("discards a completed layout after the user cancels during automatic arrangement", async () => {
    let resolveLayout!: (value: { children: [] }) => void;
    window.ELK = class { layout() { return new Promise<{ children: [] }>(resolve => { resolveLayout = resolve; }); } };
    vi.mocked(recommendProjectConfig).mockResolvedValue(recommendation());
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(resolveLayout).toBeDefined());
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "75");
    await userEvent.click(screen.getByRole("button", { name: "取消推荐" }));
    await act(async () => resolveLayout({ children: [] }));
    expect(screen.getByRole("dialog", { name: "推荐配置已取消" })).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
  });

  it("restores the default configuration through the editor callback", async () => {
    const user = userEvent.setup();
    const restore = vi.fn();
    const view = render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} onApply={vi.fn()} onRestoreDefault={restore} />);
    expect(screen.queryByRole("button", { name: "恢复默认" })).not.toBeInTheDocument();
    view.rerender(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} recommendedApplied onApply={vi.fn()} onRestoreDefault={restore} />);
    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(restore).toHaveBeenCalledOnce();
    expect(screen.getByText("已恢复系统默认 Agent 与 Workflow 配置。")).toBeVisible();
  });

  it("discards a delayed response after task edits and aborts the request", async () => {
    const user = userEvent.setup();
    let resolve!: (value: ConfigRecommendationResponse) => void;
    vi.mocked(recommendProjectConfig).mockReturnValue(new Promise((done) => { resolve = done; }));
    const apply = vi.fn();
    const view = render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "推荐配置" }));
    const signal = vi.mocked(recommendProjectConfig).mock.calls[0][1];
    view.rerender(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={{ ...input, requirement: "修改后的课题说明需要新的推荐" }} onApply={apply} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(recommendation()));
    expect(apply).not.toHaveBeenCalled();
  });

  it("discards a delayed response after current configuration changes", async () => {
    const user = userEvent.setup();
    let resolve!: (value: ConfigRecommendationResponse) => void;
    vi.mocked(recommendProjectConfig).mockReturnValue(new Promise((done) => { resolve = done; }));
    const apply = vi.fn();
    const view = render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "推荐配置" }));
    const signal = vi.mocked(recommendProjectConfig).mock.calls[0][1];
    view.rerender(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={{ ...input, agents: recommendation().recommendation.agents }} onApply={apply} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(recommendation()));
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(["尚未验证", "验证失败"])("allows recommendation with a %s warning and shows actual invocation errors", async (status) => {
    source.config.validationWarning = `当前组合${status}，仍可使用，但运行可能失败。`;
    vi.mocked(recommendProjectConfig).mockRejectedValue(new Error("上游返回 HTTP 503"));
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} input={input} onApply={apply} />);
    expect(await screen.findByText(source.config.validationWarning)).toHaveAttribute("role", "status");
    const button = screen.getByRole("button", { name: "推荐配置" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(recommendProjectConfig).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent("上游返回 HTTP 503");
    await waitFor(() => expect(button).toBeEnabled());
    expect(apply).not.toHaveBeenCalled();
  });

  it("shows a retryable error without applying configuration", async () => {
    vi.mocked(recommendProjectConfig).mockRejectedValue(new Error("没有已验证的模型"));
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("没有已验证的模型");
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    expect(apply).not.toHaveBeenCalled();
  });

  it("automatically applies a new Agent together with its Workflow", async () => {
    const result = recommendation();
    result.recommendation.agents.researcher = structuredClone(input.agents.idea);
    result.recommendation.orchestration.agents.push({ name: "researcher", template: "idea" });
    result.recommendation.orchestration.routes.researcher = [{ target: "main", kind: "strong" }];
    result.recommendation.orchestration.routes.main.push({ target: "researcher", kind: "weak" });
    result.recommendation.orchestration.decisionPlans.researcher = "调查资料后返回 Main";
    vi.mocked(recommendProjectConfig).mockResolvedValue(result);
    const apply = vi.fn();
    render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(apply.mock.calls[0][0].agents.researcher).toBeDefined();
    expect(apply.mock.calls[0][0].orchestration.agents).toContainEqual({ name: "researcher", template: "idea" });
  });

  it("aborts advice when the editor becomes inactive", async () => {
    vi.mocked(recommendProjectConfig).mockReturnValue(new Promise(() => {}));
    const view = render(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} onApply={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    const signal = vi.mocked(recommendProjectConfig).mock.calls[0][1];
    view.rerender(<ConfigRecommendation gateways={gateways} defaultGatewayId="gateway-main" input={input} disabled onApply={vi.fn()} />);
    expect(signal?.aborted).toBe(true);
  });
});
