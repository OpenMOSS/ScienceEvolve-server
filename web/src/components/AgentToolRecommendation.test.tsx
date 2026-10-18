import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentToolRecommendationCatalog, getRecommendationExplainerConfig, recommendAgentTools,
  type AgentToolRecommendationResponse, type ExplainerRecommendationConfiguration, type ConfigRecommendationInput } from "../api";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION } from "../lib";
import { AgentToolRecommendation } from "./AgentToolRecommendation";
import { RecommendationProvider } from "./RecommendationContext";
import { CanvasInspector } from "./workflow-canvas/CanvasInspector";
import { ScopedWorkflowEditor } from "./workflow-canvas/ScopedWorkflowEditor";
import { addScopedGroup, upgradeLegacyGroups } from "./workflow-canvas/core/scoped-workflow";

vi.mock("../api", () => ({ getAgentToolRecommendationCatalog: vi.fn(), getRecommendationExplainerConfig: vi.fn(), recommendAgentTools: vi.fn(),
  updateRecommendationExplainerConfig: vi.fn(), updateProjectExplainerConfig: vi.fn() }));
const initial = (): ConfigRecommendationInput => ({ title: "研究任务", requirement: "根据材料完成研究与独立验证", agents: { ...structuredClone(DEFAULT_AGENTS), idea: { ...structuredClone(DEFAULT_AGENTS.idea), instructions: "读取材料并制定研究方案" } }, orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION) });
let config: ExplainerRecommendationConfiguration;
const catalogFingerprint = "c".repeat(64);
describe("Agent tool recommendation previews", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    config = { fingerprint: "e".repeat(64), config: { schemaVersion: 2, harness: "codex", model: "shared-model", nativeProtocol: "responses", gatewayProtocol: "responses",
      reasoningEffort: "high", revision: 1, updatedAt: "", available: true, routeMode: "direct" } };
    vi.mocked(getRecommendationExplainerConfig).mockImplementation(async () => structuredClone(config));
    vi.mocked(getAgentToolRecommendationCatalog).mockResolvedValue({ fingerprint: catalogFingerprint });
    vi.mocked(recommendAgentTools).mockImplementation(async input => ({ targetAgent: input.targetAgent, contextFingerprint: input.contextFingerprint,
      configurationFingerprint: input.configurationFingerprint, catalogFingerprint: input.catalogFingerprint,
      selection: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false }, reasons: ["现有任务无需额外业务工具。"], warnings: [] }));
  });
  async function generate() {
    const button = screen.getByRole("button", { name: "推荐 Skill / MCP" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    return screen.findByRole("region", { name: "idea 工具推荐预览" });
  }

  it("previews empty selections and applies exactly four tool fields to one shared identity", async () => {
    const input = initial(); input.agents.idea.skills = ["manual-skill"]; input.agents.idea.experimentMcp = true;
    const before = structuredClone(input); const apply = vi.fn();
    render(<RecommendationProvider input={input} gateways={[]} onApplyTools={apply}>
      <AgentToolRecommendation agentId="idea" instructions={input.agents.idea.instructions} />
    </RecommendationProvider>);
    const preview = await generate(); expect(apply).not.toHaveBeenCalled(); expect(input).toEqual(before);
    expect(within(preview).getByText("现有任务无需额外业务工具。")).toBeVisible();
    await userEvent.click(within(preview).getByRole("button", { name: "应用工具推荐" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith("idea", { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false }));
    expect(input).toEqual(before);
    expect(Object.keys(apply.mock.calls[0][1]).sort()).toEqual(["autoSkills", "experimentMcp", "mcpServers", "skills"]);
  });

  it("allows tool recommendation when the Explainer has a verification warning", async () => {
    config.config.validationWarning = "当前组合尚未通过验证，仍可使用，但运行可能失败。";
    const input = initial();
    render(<RecommendationProvider input={input} gateways={[]} onApplyTools={vi.fn()}>
      <AgentToolRecommendation agentId="idea" instructions={input.agents.idea.instructions} />
    </RecommendationProvider>);
    expect(await screen.findByText(config.config.validationWarning)).toHaveAttribute("role", "status");
    expect(await generate()).toBeVisible();
    expect(recommendAgentTools).toHaveBeenCalledOnce();
  });

  it.each(["instructions", "graph", "manual", "catalog", "target"])("invalidates the preview after %s changes", async change => {
    const original = initial(); const apply = vi.fn();
    const tree = (input = original, version = "v1", id = "idea") => <RecommendationProvider input={input} gateways={[]} catalogVersion={version} onApplyTools={apply}>
      <AgentToolRecommendation agentId={id} instructions={input.agents[id]!.instructions} />
    </RecommendationProvider>;
    const view = render(tree()); await generate(); const edited = structuredClone(original);
    if (change === "instructions") edited.agents.idea.instructions += "新增要求";
    if (change === "graph") edited.orchestration.decisionPlans.idea = "新的分支选择条件";
    if (change === "manual") edited.agents.idea.skills = ["manual-skill"];
    view.rerender(tree(edited, change === "catalog" ? "v2" : "v1", change === "target" ? "review" : "idea"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "idea 工具推荐预览" })).not.toBeInTheDocument());
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(["catalog", "explainer"])("rechecks the remote %s before applying", async change => {
    const input = initial(); const apply = vi.fn();
    render(<RecommendationProvider input={input} gateways={[]} onApplyTools={apply}><AgentToolRecommendation agentId="idea" instructions={input.agents.idea.instructions} /></RecommendationProvider>);
    const preview = await generate();
    if (change === "catalog") vi.mocked(getAgentToolRecommendationCatalog).mockResolvedValue({ fingerprint: "d".repeat(64) });
    else config.fingerprint = "f".repeat(64);
    await userEvent.click(within(preview).getByRole("button", { name: "应用工具推荐" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "idea 工具推荐预览" })).not.toBeInTheDocument());
    expect(apply).not.toHaveBeenCalled();
  });

  it("cancels the real pending request and discards a response that ignores cancellation", async () => {
    let resolve!: (result: AgentToolRecommendationResponse) => void;
    vi.mocked(recommendAgentTools).mockReturnValue(new Promise(done => { resolve = done; }));
    const input = initial(); const apply = vi.fn();
    render(<RecommendationProvider input={input} gateways={[]} onApplyTools={apply}><AgentToolRecommendation agentId="idea" instructions={input.agents.idea.instructions} /></RecommendationProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐 Skill / MCP" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐 Skill / MCP" }));
    const [submitted, signal] = vi.mocked(recommendAgentTools).mock.calls[0]!;
    await userEvent.click(screen.getByRole("button", { name: "取消推荐" })); expect(signal?.aborted).toBe(true);
    await act(async () => resolve({ ...submitted, selection: { skills: ["late"], autoSkills: [], mcpServers: [], experimentMcp: false }, reasons: ["迟到结果"], warnings: [] }));
    expect(screen.queryByRole("region", { name: "idea 工具推荐预览" })).not.toBeInTheDocument(); expect(apply).not.toHaveBeenCalled();
  });

  it("preserves choices on errors and rejects a response for another identity", async () => {
    const input = initial(); const apply = vi.fn();
    vi.mocked(recommendAgentTools).mockRejectedValueOnce(new Error("网关暂时不可用"));
    render(<RecommendationProvider input={input} gateways={[]} onApplyTools={apply}><AgentToolRecommendation agentId="idea" instructions={input.agents.idea.instructions} /></RecommendationProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐 Skill / MCP" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "推荐 Skill / MCP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网关暂时不可用");
    vi.mocked(recommendAgentTools).mockImplementationOnce(async input => ({ ...input, targetAgent: "review", selection: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false }, reasons: ["错误目标"], warnings: [] }));
    await userEvent.click(screen.getByRole("button", { name: "推荐 Skill / MCP" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("不一致")); expect(apply).not.toHaveBeenCalled();
  });

  it("uses the canvas textarea's latest unblurred instructions and obeys node locks", async () => {
    const input = initial(); const patch = vi.fn();
    const tree = (readOnly = false) => <RecommendationProvider input={input} gateways={[]}>
      <CanvasInspector node={{ id: "idea", kind: "agent", name: "idea", x: 0, y: 0 }} agent={input.agents.idea}
        orchestration={input.orchestration} onAgentPatch={patch} readOnly={readOnly} />
    </RecommendationProvider>;
    const view = render(tree());
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐 Skill / MCP" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Agent 指令"), { target: { value: "尚未失焦的新指令" } }); expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "推荐 Skill / MCP" }));
    await screen.findByRole("region", { name: "idea 工具推荐预览" });
    expect(vi.mocked(recommendAgentTools).mock.calls[0]![0].agents.idea.instructions).toBe("尚未失焦的新指令");
    view.rerender(tree(true)); expect(screen.getByRole("button", { name: "推荐 Skill / MCP" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "idea 工具推荐预览" })).not.toBeInTheDocument();
  });

  it.each(["pointer", "keyboard", "cancel"])("uses an unblurred shared Agent draft and full nested graph through %s", async interaction => {
    const input = initial(); upgradeLegacyGroups(input.orchestration);
    addScopedGroup(input.orchestration, { id: "parent", displayName: "父组", leaderAgentId: "review", memberAgentIds: ["idea", "execution", "writing"] });
    addScopedGroup(input.orchestration, { id: "child", displayName: "子组", parentGroupId: "parent", leaderAgentId: "writing", memberAgentIds: ["idea", "execution"] });
    const patch = vi.fn();
    const view = render(<RecommendationProvider input={input} gateways={[]}>
      <ScopedWorkflowEditor orchestration={input.orchestration} agents={input.agents} groupId="child" isAgentLocked={() => false}
        onSharedAgentPatch={patch} onSharedAgentRename={vi.fn()} onSharedAgentDescriptionChange={vi.fn()} onSharedAgentMcpAdd={vi.fn()}
        onSharedAgentMcpToggle={vi.fn()} onChange={vi.fn()} onNavigate={vi.fn()} />
    </RecommendationProvider>);
    // Select the actual child Agent card, rather than constructing its inspector.
    const ref = input.orchestration.scopedWorkflow!.groups.find(group => group.id === "child")!.workflow.nodes.find(node => node.kind === "agent" && node.agentId === "idea")!;
    const card = view.container.querySelector(`[data-node-id="${ref.nodeId}"]`);
    expect(card).not.toBeNull(); fireEvent.click(card!);
    await waitFor(() => expect(screen.getByRole("button", { name: "推荐 Skill / MCP" })).toBeEnabled());
    const instructions = screen.getByLabelText("Agent 指令");
    await userEvent.clear(instructions);
    await userEvent.type(instructions, "子组尚未失焦的新指令");
    expect(patch).not.toHaveBeenCalled();
    const recommend = screen.getByRole("button", { name: "推荐 Skill / MCP" });
    if (interaction === "keyboard") {
      await userEvent.tab();
      expect(recommend).toHaveFocus();
      await userEvent.keyboard("{Enter}");
    } else await userEvent.click(recommend);
    await screen.findByRole("region", { name: "idea 工具推荐预览" });
    const submitted = vi.mocked(recommendAgentTools).mock.calls[0]![0];
    expect(submitted.targetAgent).toBe("idea"); expect(submitted.orchestration.scopedWorkflow).toEqual(input.orchestration.scopedWorkflow);
    expect(submitted.agents.idea.instructions).toBe("子组尚未失焦的新指令");
    expect(screen.queryByRole("dialog", { name: "确认修改共享 Agent" })).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "应用工具推荐" }));
    const confirmation = await screen.findByRole("dialog", { name: "确认修改共享 Agent" });
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText("工具推荐已提交，请确认共享 Agent 配置修改。")).toBeVisible();
    if (interaction === "cancel") {
      await userEvent.click(within(confirmation).getByRole("button", { name: /^取消$/ }));
      expect(patch).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Agent 指令")).toHaveValue("子组尚未失焦的新指令");
      expect(screen.queryByRole("dialog", { name: "确认修改共享 Agent" })).not.toBeInTheDocument();
      return;
    }
    await userEvent.click(within(confirmation).getByRole("button", { name: "应用到所有引用" }));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("idea", { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false });
    expect(instructions).toHaveValue("子组尚未失焦的新指令");
    expect(screen.queryByRole("dialog", { name: "确认修改共享 Agent" })).not.toBeInTheDocument();
    await userEvent.click(instructions);
    await userEvent.click(document.body);
    const promptConfirmation = await screen.findByRole("dialog", { name: "确认修改共享 Agent" });
    expect(patch).toHaveBeenCalledTimes(1);
    await userEvent.click(within(promptConfirmation).getByRole("button", { name: "应用到所有引用" }));
    expect(patch).toHaveBeenLastCalledWith("idea", { instructions: "子组尚未失焦的新指令" });
  });
});
