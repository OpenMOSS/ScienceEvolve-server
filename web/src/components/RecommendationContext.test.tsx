import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentToolRecommendationCatalog, getRecommendationExplainerConfig, recommendAgentTools,
  recommendProjectConfig, updateProjectExplainerConfig, type ConfigRecommendationResponse,
  type ExplainerRecommendationConfiguration } from "../api";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../lib";
import type { GatewayRecord } from "../types";
import { AgentToolRecommendation } from "./AgentToolRecommendation";
import { ConfigRecommendation } from "./ConfigRecommendation";
import { ExplainerRecommendationSettings, RecommendationProvider } from "./RecommendationContext";

vi.mock("../api", () => ({ getAgentToolRecommendationCatalog: vi.fn(), getRecommendationExplainerConfig: vi.fn(),
  recommendAgentTools: vi.fn(), recommendProjectConfig: vi.fn(), updateProjectExplainerConfig: vi.fn(),
  updateRecommendationExplainerConfig: vi.fn() }));

const input = { title: "研究任务", requirement: "根据材料完成研究与独立验证", agents: structuredClone(DEFAULT_AGENTS),
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION) };
const gateways: GatewayRecord[] = [{ id: "gateway-main", name: "默认网关", models: ["original-model", "edited-model", "remote-model"],
  defaultModel: "original-model", protocol: "responses", revision: 1, url: "https://example.test/v1", apiKeyConfigured: true,
  test: { status: "untested" }, createdAt: "", updatedAt: "" }];
let source: ExplainerRecommendationConfiguration;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function settings(projectId?: string) {
  return <RecommendationProvider input={{ ...input, projectId }} gateways={gateways}>
    <ExplainerRecommendationSettings />
  </RecommendationProvider>;
}
async function openSettings() {
  const button = screen.getByRole("button", { name: "调整推荐模型" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

describe("recommendation settings synchronization", () => {
  afterEach(() => { delete window.ELK; window.__openfarsElkPromise = undefined; });
  beforeEach(() => {
    vi.resetAllMocks();
    // The recommendation now auto-arranges its canvas. Let the real planner
    // use its deterministic fallback without loading a browser script in jsdom.
    window.ELK = class { async layout() { return { children: [] }; } };
    window.__openfarsElkPromise = undefined;
    source = { fingerprint: "e".repeat(64), config: { schemaVersion: 2, harness: "codex", gatewayId: "gateway-main",
      nativeProtocol: "responses", gatewayProtocol: "responses", model: "original-model", reasoningEffort: "high",
      revision: 1, updatedAt: "", available: true, routeMode: "direct" } };
    vi.mocked(getRecommendationExplainerConfig).mockImplementation(async () => structuredClone(source));
  });

  it("keeps an in-flight configuration recommendation alive when focus reads the same configuration", async () => {
    const pending = deferred<ConfigRecommendationResponse>();
    vi.mocked(recommendProjectConfig).mockReturnValue(pending.promise);
    const apply = vi.fn();
    render(<ConfigRecommendation input={input} gateways={gateways} onApply={apply} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    await waitFor(() => expect(recommendProjectConfig).toHaveBeenCalledOnce());
    const signal = vi.mocked(recommendProjectConfig).mock.calls[0][1]!;
    const reads = vi.mocked(getRecommendationExplainerConfig).mock.calls.length;
    await act(async () => { fireEvent(window, new Event("focus")); });
    expect(getRecommendationExplainerConfig).toHaveBeenCalledTimes(reads + 1);
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve({ recommendation: structuredClone(input), warnings: [], configurationFingerprint: source.fingerprint }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  });

  it("preserves an existing tool preview across an unchanged focus read and still permits applying it", async () => {
    vi.mocked(getAgentToolRecommendationCatalog).mockResolvedValue({ fingerprint: "c".repeat(64) });
    vi.mocked(recommendAgentTools).mockImplementation(async request => ({ targetAgent: request.targetAgent,
      contextFingerprint: request.contextFingerprint, configurationFingerprint: request.configurationFingerprint,
      catalogFingerprint: request.catalogFingerprint, selection: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false },
      reasons: ["当前任务无需额外工具"], warnings: [] }));
    const apply = vi.fn();
    render(<RecommendationProvider input={input} gateways={gateways} onApplyTools={apply}>
      <AgentToolRecommendation agentId="idea" instructions="读取材料并制定研究方案" />
    </RecommendationProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐 Skill / MCP" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐 Skill / MCP" }));
    await screen.findByRole("region", { name: "idea 工具推荐预览" });
    await act(async () => { fireEvent(window, new Event("focus")); });
    expect(screen.getByRole("region", { name: "idea 工具推荐预览" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "应用工具推荐" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith("idea", { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false }));
  });

  it("defers focus reads while a project save is pending and accepts the saved configuration afterwards", async () => {
    const pending = deferred<ExplainerRecommendationConfiguration["config"]>();
    vi.mocked(updateProjectExplainerConfig).mockReturnValue(pending.promise);
    render(settings("prj_" + "a".repeat(32)));
    await openSettings();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("推荐 Explainer 模型"), "edited-model");
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(updateProjectExplainerConfig).toHaveBeenCalledOnce());
    const reads = vi.mocked(getRecommendationExplainerConfig).mock.calls.length;
    await act(async () => { fireEvent(window, new Event("focus")); });
    expect(getRecommendationExplainerConfig).toHaveBeenCalledTimes(reads);
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(screen.getByLabelText("推荐 Explainer 模型")).toBeDisabled();
    source = { fingerprint: "f".repeat(64), config: { ...source.config, model: "edited-model", revision: 2 } };
    await act(async () => pending.resolve(source.config));
    expect(await screen.findByText("设置已保存，将用于后续推荐。")).toBeVisible();
    expect(getRecommendationExplainerConfig).toHaveBeenCalledTimes(reads + 1);
    await openSettings();
    expect(screen.getByLabelText("推荐 Explainer 模型")).toHaveValue("edited-model");
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  });

  it("preserves unsaved choices on a remote update and restores the latest settings when cancelled", async () => {
    render(settings());
    await openSettings();
    await userEvent.selectOptions(screen.getByLabelText("推荐 Explainer 模型"), "edited-model");
    source = { fingerprint: "f".repeat(64), config: { ...source.config, model: "remote-model", revision: 2 } };
    await act(async () => { fireEvent(window, new Event("focus")); });
    expect(screen.getByLabelText("推荐 Explainer 模型")).toHaveValue("edited-model");
    expect(screen.getByText("设置已在其他页面更新。取消编辑可查看最新设置，保存则应用当前选择。")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await openSettings();
    expect(screen.getByLabelText("推荐 Explainer 模型")).toHaveValue("remote-model");
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(screen.queryByText("设置已在其他页面更新。取消编辑可查看最新设置，保存则应用当前选择。")).not.toBeInTheDocument();
  });

  it("clears the previous project's configuration and draft when the next project cannot load", async () => {
    const firstProject = "prj_" + "a".repeat(32);
    const nextProject = "prj_" + "b".repeat(32);
    const apply = vi.fn();
    vi.mocked(getRecommendationExplainerConfig).mockImplementation(async projectId => {
      if (projectId === nextProject) throw new Error("新项目设置读取失败");
      return structuredClone(source);
    });
    const tree = (projectId: string) => <ConfigRecommendation input={{ ...input, projectId }} gateways={gateways} onApply={apply} />;
    const view = render(tree(firstProject));
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled());
    await openSettings();
    await userEvent.selectOptions(screen.getByLabelText("推荐 Explainer 模型"), "edited-model");
    view.rerender(tree(nextProject));
    expect(await screen.findByRole("alert")).toHaveTextContent("新项目设置读取失败");
    expect(screen.queryByText("original-model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("推荐 Explainer 模型")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "调整推荐模型" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "推荐配置" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "推荐配置" }));
    expect(recommendProjectConfig).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(getRecommendationExplainerConfig).toHaveBeenLastCalledWith(nextProject, expect.any(AbortSignal));
  });

  it("offers a retry after initial loading fails and removes it after successful recovery", async () => {
    vi.mocked(getRecommendationExplainerConfig).mockRejectedValueOnce(new Error("服务暂时不可用"));
    render(settings());
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.getByRole("button", { name: "调整推荐模型" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重新读取设置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "调整推荐模型" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新读取设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新共用配置" })).not.toBeInTheDocument();
  });
});
