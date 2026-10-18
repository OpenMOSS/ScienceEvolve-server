import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSavedResearchTask,
  createProject,
  createProjectInputUpload,
  uploadProjectInputFile,
  discardProjectInputUpload,
  listProjectInputFiles,
  removeProjectInputFile,
  openProjectInputDirectory,
  createAgentConfigPreset,
  createUserSkill,
  getAgentConfigPresets,
  getCatalog,
  getGitHubAccounts,
  getSavedResearchTask,
  recommendProjectConfig,
  recommendAgentTools,
  getRecommendationExplainerConfig,
  getAgentToolRecommendationCatalog,
  testGateway,
  updateAgentConfigPreset,
  updateSavedResearchTask
} from "../api";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS } from "../lib";
import { addScopedGroup, upgradeLegacyGroups } from "../components/workflow-canvas/core/scoped-workflow";
import {
  type AgentConfigPreset,
  type AgentsConfig,
  type GatewayRecord,
  type GitHubAccountRecord,
  type HarnessCatalogEntry,
  type Project,
  type SavedResearchTask
} from "../types";
import { NewProjectPage } from "./NewProjectPage";

const agentPrompts = {
  main: "Built-in Main prompt",
  idea: "Built-in Idea prompt",
  execution: "Built-in Execution prompt",
  writing: "Built-in Writing prompt",
  review: "Built-in Review prompt"
};
const BUILTIN_AGENTS = ["main", "idea", "execution", "writing", "review"] as const;
const RUNTIME_GATEWAY_ID = "gwy_0123456789abcdef0123456789abcdef";
const GITHUB_ACCOUNT_ID = "gha_0123456789abcdef0123456789abcdef";
const githubAccount: GitHubAccountRecord = {
  id: GITHUB_ACCOUNT_ID,
  login: "openfars-test",
  providerUserId: 42,
  status: "ready",
  scopes: ["repo"],
  isDefault: true,
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  lastVerifiedAt: "2026-09-24T00:00:00.000Z"
};
const RUNTIME_MODELS = [
  "route-model",
  "nex-agi/Nex-N2-Pro",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "saved-execution-model"
] as const;

vi.mock("../api", () => ({
  createProject: vi.fn(),
  createProjectInputUpload: vi.fn(),
  uploadProjectInputFile: vi.fn(),
  discardProjectInputUpload: vi.fn(),
  listProjectInputFiles: vi.fn(),
  removeProjectInputFile: vi.fn(),
  openProjectInputDirectory: vi.fn(),
  createAgentConfigPreset: vi.fn(),
  createSavedResearchTask: vi.fn(),
  createUserSkill: vi.fn(),
  getAgentConfigPresets: vi.fn(),
  getCatalog: vi.fn(),
  getGitHubAccounts: vi.fn(),
  getSavedResearchTask: vi.fn(),
  recommendProjectConfig: vi.fn(),
  getRecommendationExplainerConfig: vi.fn(),
  updateRecommendationExplainerConfig: vi.fn(),
  updateProjectExplainerConfig: vi.fn(),
  getAgentToolRecommendationCatalog: vi.fn(),
  recommendAgentTools: vi.fn(),
  testGateway: vi.fn(),
  testGatewayMatrix: vi.fn(),
  updateAgentConfigPreset: vi.fn(),
  updateSavedResearchTask: vi.fn()
}));

const defaultPresetAgents = Object.fromEntries(
  BUILTIN_AGENTS.map((role) => [
    role,
    { ...DEFAULT_AGENTS[role], instructions: agentPrompts[role] }
  ])
) as AgentsConfig;

const defaultPreset: AgentConfigPreset = {
  schemaVersion: 2,
  kind: "scienceevolve-agent-config-preset",
  id: "default",
  name: "系统默认配置",
  builtin: true,
  agents: defaultPresetAgents,
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
};

const defaultPresetAgentsWithCatalogHarness = Object.fromEntries(
  Object.entries(defaultPresetAgents).map(([role, config]) => [
    role,
    { ...config, harness: "codex", gatewayId: RUNTIME_GATEWAY_ID }
  ])
) as AgentsConfig;

const runtimeHarnesses: HarnessCatalogEntry[] = [
  {
    id: "codex",
    label: "Codex",
    adapterVersion: "1",
    nativeProtocol: "responses",
    purposes: ["workflow", "explainer", "probe"],
    mode: "workflow",
    notes: "Embedded Codex",
    capabilities: {
      structuredEvents: true, toolResults: true, durableSession: true,
      permissionPrompts: ["workspace", "compute", "yolo"], workspaceInputs: true, autoSkills: true,
      officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: true, webSearch: true, skills: true, mcp: true
    },
    available: true
  },
  {
    id: "dsh",
    label: "dsh",
    adapterVersion: "1",
    nativeProtocol: "chat-completions",
    purposes: ["workflow", "probe"],
    mode: "workflow",
    notes: "Embedded dsh",
    capabilities: {
      structuredEvents: true, toolResults: true, durableSession: true,
      permissionPrompts: ["workspace", "compute", "yolo"], workspaceInputs: true, autoSkills: true,
      officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: false, webSearch: true, skills: true, mcp: true
    },
    available: true
  },
  {
    id: "pi",
    label: "pi",
    adapterVersion: "1",
    nativeProtocol: "chat-completions",
    purposes: ["workflow", "explainer", "probe"],
    mode: "workflow",
    notes: "Embedded pi",
    capabilities: {
      structuredEvents: true, toolResults: true, durableSession: true,
      permissionPrompts: ["workspace", "compute", "yolo"], workspaceInputs: true, autoSkills: true,
      officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: true, webSearch: false, skills: true, mcp: true
    },
    available: true
  },
  {
    id: "claude-code",
    label: "Claude Code",
    adapterVersion: "1",
    nativeProtocol: "anthropic-messages",
    purposes: ["workflow", "explainer", "probe"],
    mode: "workflow",
    notes: "Embedded Claude Code",
    capabilities: {
      structuredEvents: true, toolResults: true, durableSession: true,
      permissionPrompts: ["workspace", "compute", "yolo"], workspaceInputs: true, autoSkills: true,
      officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: true, webSearch: true, skills: true, mcp: true
    },
    available: true
  }
];

const runtimeGateway: GatewayRecord = {
  id: RUNTIME_GATEWAY_ID,
  name: "Responses 验收网关",
  url: "https://gateway.example.test/v1",
  models: [...RUNTIME_MODELS],
  defaultModel: "route-model",
  protocol: "responses",
  revision: 1,
  apiKeyConfigured: true,
  test: {
    status: "passed",
    protocol: "responses",
    model: "route-model",
    testedAt: "2026-09-12T08:30:00.000Z",
    harness: "codex",
    nativeProtocol: "responses",
    routeMode: "direct",
    probeKind: "adapter-smoke",
    cacheKey: "codex-route-model",
    adapterVersion: "1",
    executableFingerprint: "fixture-codex",
    gatewayRevision: 1,
    routerCompatibilityVersion: "1"
  },
  tests: RUNTIME_MODELS.flatMap((model) => [{
    status: "passed" as const,
    protocol: "responses" as const,
    model,
    harness: "codex",
    nativeProtocol: "responses" as const,
    routeMode: "direct" as const,
    probeKind: "route" as const
  }, {
    status: "passed" as const,
    protocol: "responses" as const,
    model,
    harness: "codex",
    nativeProtocol: "responses" as const,
    routeMode: "direct" as const,
    probeKind: "adapter-smoke" as const,
    cacheKey: `codex-${model}`,
    adapterVersion: "1",
    executableFingerprint: "fixture-codex",
    gatewayRevision: 1,
    routerCompatibilityVersion: "1"
  }]),
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z"
};

function renderExpanded(page: Parameters<typeof render>[0]) {
  const view = render(page);
  fireEvent.click(screen.getByRole("button", { name: "展开文字版 Workflow 编排" }));
  fireEvent.click(screen.getByRole("button", { name: "展开智能体编队" }));
  return view;
}

describe("NewProjectPage agent configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.ELK;
    window.__openfarsElkPromise = undefined;
    window.history.replaceState(null, "", "#/projects");
  });

  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(getRecommendationExplainerConfig).mockReset().mockResolvedValue({ fingerprint: "e".repeat(64), config: {
      schemaVersion: 2, harness: "codex", gatewayId: RUNTIME_GATEWAY_ID, nativeProtocol: "responses", gatewayProtocol: "responses",
      model: runtimeGateway.defaultModel, reasoningEffort: "high", revision: 1, updatedAt: "", available: true, routeMode: "direct"
    } });
    vi.mocked(getAgentToolRecommendationCatalog).mockReset().mockResolvedValue({ fingerprint: "c".repeat(64) });
    const uploadedInputs = new Map<string, number>();
    vi.mocked(createProject).mockReset();
    vi.mocked(createProjectInputUpload).mockReset().mockResolvedValue("upload-token");
    vi.mocked(uploadProjectInputFile).mockReset().mockImplementation(async (_id, path, file) => { uploadedInputs.set(path, file.size); });
    vi.mocked(discardProjectInputUpload).mockReset().mockResolvedValue(undefined);
    vi.mocked(listProjectInputFiles).mockReset().mockImplementation(async () => [...uploadedInputs].map(([path, size]) => ({ path, size })));
    vi.mocked(removeProjectInputFile).mockReset().mockImplementation(async (_id, path) => { uploadedInputs.delete(path); });
    vi.mocked(openProjectInputDirectory).mockReset().mockResolvedValue(undefined);
    vi.mocked(createAgentConfigPreset).mockReset();
    vi.mocked(createSavedResearchTask).mockReset();
    vi.mocked(createUserSkill).mockReset();
    vi.mocked(getAgentConfigPresets)
      .mockReset()
      .mockResolvedValue([defaultPreset]);
    vi.mocked(getCatalog).mockReset().mockResolvedValue({
      skills: [],
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      gateways: [runtimeGateway],
      defaultGatewayId: runtimeGateway.id,
      harnesses: runtimeHarnesses,
      defaultHarnessId: "codex",
      agentPrompts
    });
    vi.mocked(getGitHubAccounts).mockReset().mockResolvedValue({
      accounts: [githubAccount],
      defaultAccountId: GITHUB_ACCOUNT_ID,
      oauthConfigured: true
    });
    vi.mocked(getSavedResearchTask).mockReset();
    vi.mocked(testGateway).mockReset();
    vi.mocked(updateAgentConfigPreset).mockReset();
    vi.mocked(updateSavedResearchTask).mockReset();
  });

  it("keeps launch clickable, reports all missing fields, and starts only a valid draft with intervention disabled", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "prj_click_to_validate" } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/运行目录仍在加载/)).not.toBeInTheDocument());
    const start = screen.getByRole("button", { name: "创建并启动研究" });
    expect(start).toBeEnabled();
    await user.click(start);
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("请输入项目名称");
    expect(error).toHaveTextContent("课题方向与具体要求至少需要 10 个字符");
    expect(createProject).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("项目名称"), "可点击的启动校验");
    await user.type(screen.getByLabelText("课题方向与具体要求"), "先展示具体校验问题，修正配置后再正式启动研究。");
    await user.selectOptions(screen.getByRole("combobox", { name: "是否允许 Main 请求用户介入" }), "disabled");
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0]![0].orchestration?.allowUserIntervention).toBe(false);
  });

  it("starts with both details collapsed while termination and intervention stay visible", async () => {
    const user = userEvent.setup();
    render(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "从一个例子开始" })).not.toBeInTheDocument();

    const workflowToggle = screen.getByRole("button", { name: "展开文字版 Workflow 编排" });
    const agentToggle = screen.getByRole("button", { name: "展开智能体编队" });
    const workflowStructure = document.getElementById(workflowToggle.getAttribute("aria-controls")!);
    const agentFormation = document.getElementById(agentToggle.getAttribute("aria-controls")!);
    expect(workflowToggle).toHaveAttribute("aria-expanded", "false");
    expect(agentToggle).toHaveAttribute("aria-expanded", "false");
    expect(workflowStructure).toHaveAttribute("hidden");
    expect(agentFormation).toHaveAttribute("hidden");
    expect(agentFormation?.querySelector("input, select, textarea")).toBeNull();
    expect(workflowStructure?.querySelector("input, select, textarea")).toBeNull();
    expect(screen.getByRole("textbox", { name: "终止条件" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "是否允许 Main 请求用户介入" })).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "允许 Main 动态重配置（高级权限）" })
    ).toBeVisible();

    await user.click(workflowToggle);
    const inputTarget = screen.getByRole("combobox", { name: "输入目标外层节点" });
    expect(inputTarget).toBeVisible();
    await user.selectOptions(inputTarget, "execution");
    await user.click(screen.getByRole("button", { name: "收起文字版 Workflow 编排" }));
    expect(workflowStructure).toHaveAttribute("hidden");
    expect(screen.getByRole("textbox", { name: "终止条件" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "展开文字版 Workflow 编排" }));
    expect(screen.getByRole("combobox", { name: "输入目标外层节点" })).toHaveValue("execution");

    await user.click(agentToggle);
    expect(screen.getByRole("combobox", { name: "Main Agent模型" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "收起智能体编队" }));
    expect(agentFormation).toHaveAttribute("hidden");
  });

  it("shows the selected draft before a slow preset directory and keeps edits when it finishes", async () => {
    let releasePresets!: (presets: AgentConfigPreset[]) => void;
    vi.mocked(getAgentConfigPresets).mockReturnValue(new Promise(resolve => { releasePresets = resolve; }));
    const task: SavedResearchTask = { schemaVersion: 2, kind: "scienceevolve-saved-research-task",
      id: "task_0123456789abcdef0123456789abcdef", title: "立即显示已有草稿", requirement: "这是无需等待配置预设即可读取和编辑的研究任务。",
      agents: structuredClone(defaultPresetAgents), orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      git: { enabled: false }, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z" };
    vi.mocked(getSavedResearchTask).mockResolvedValue(task);
    render(<NewProjectPage savedTaskId={task.id} onBack={vi.fn()} onCreated={vi.fn()} />);
    const title = screen.getByRole("textbox", { name: "项目名称" });
    await waitFor(() => expect(title).toHaveValue(task.title));
    fireEvent.change(title, { target: { value: "载入期间的手动修改" } });
    releasePresets([defaultPreset]);
    await waitFor(() => expect(screen.queryByText(/运行目录仍在加载/)).not.toBeInTheDocument());
    expect(title).toHaveValue("载入期间的手动修改");
    expect(screen.getByRole("textbox", { name: "课题方向与具体要求" })).toHaveValue(task.requirement);
  });

  it("saves a new task from the top button and keeps the saved copy after discarding later edits", async () => {
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_top_save_000000000000000000000001",
      title: "主动保存的课题",
      requirement: "这是一份需要主动保存并保留的研究任务说明。",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      agents: defaultPresetAgents,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(createSavedResearchTask).mockResolvedValue(savedTask);
    const onBack = vi.fn();
    const user = userEvent.setup();
    const view = renderExpanded(<NewProjectPage onBack={onBack} onCreated={vi.fn()} />);

    expect(screen.getByRole("button", { name: "保存课题" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), savedTask.title);
    await user.type(screen.getByRole("textbox", { name: "课题方向与具体要求" }), savedTask.requirement);
    await user.click(screen.getByRole("button", { name: "保存课题" }));

    await waitFor(() => expect(createSavedResearchTask).toHaveBeenCalledTimes(1));
    expect(screen.getByText("已保存到主页")).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "，尚未保存的修改");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({} as Response);
    await user.click(screen.getByRole("button", { name: "返回项目" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    expect(onBack).toHaveBeenCalledOnce();
    view.unmount();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("updates an existing saved task from the top button while retaining its Git settings", async () => {
    const savedAccount = { ...githubAccount, id: "gha_fedcba9876543210fedcba9876543210", login: "saved-git-test", isDefault: false };
    vi.mocked(getGitHubAccounts).mockResolvedValue({ accounts: [githubAccount, savedAccount],
      defaultAccountId: GITHUB_ACCOUNT_ID, oauthConfigured: true });
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_top_update_00000000000000000001",
      title: "已有课题",
      requirement: "这是已有课题的研究任务说明。",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      agents: defaultPresetAgents,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      git: { enabled: true, provider: "github", accountId: savedAccount.id,
        repositoryName: "saved-research-repository", repositoryVisibility: "public" }
    };
    vi.mocked(getSavedResearchTask).mockResolvedValue(savedTask);
    vi.mocked(updateSavedResearchTask).mockResolvedValue({ ...savedTask, title: "修改后的课题" });
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage savedTaskId={savedTask.id} onBack={vi.fn()} onCreated={vi.fn()} />);

    const title = await screen.findByRole("textbox", { name: "项目名称" });
    await waitFor(() => expect(title).toHaveValue(savedTask.title));
    expect(screen.getByRole("switch", { name: "启用 Git 机制" })).toBeChecked();
    expect(screen.getByLabelText("GitHub 仓库名称")).toHaveValue("saved-research-repository");
    expect(screen.getByLabelText("Public 仓库")).toBeChecked();
    await user.clear(title);
    await user.type(title, "修改后的课题");
    await user.click(screen.getByRole("button", { name: "保存课题" }));

    await waitFor(() => expect(updateSavedResearchTask).toHaveBeenCalledWith(
      savedTask.id,
      expect.objectContaining({ title: "修改后的课题", git: savedTask.git })
    ));
    expect(createSavedResearchTask).not.toHaveBeenCalled();
  });

  it("previews and applies tools to one text-card Agent while preserving its prompt and other Agents", async () => {
    const user = userEvent.setup();
    vi.mocked(recommendAgentTools).mockImplementation(async input => ({ targetAgent: input.targetAgent, contextFingerprint: input.contextFingerprint,
      configurationFingerprint: input.configurationFingerprint, catalogFingerprint: input.catalogFingerprint,
      selection: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false }, reasons: ["该任务无需实验工具。"], warnings: [] }));
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByText(runtimeGateway.name);
    const ideaPrompt = await screen.findByDisplayValue(agentPrompts.idea);
    await user.clear(ideaPrompt); await user.type(ideaPrompt, "按照用户材料规划研究方案");
    const ideaExperiment = screen.getByRole("checkbox", { name: "idea SII 实验工具" });
    const reviewExperiment = screen.getByRole("checkbox", { name: "review SII 实验工具" });
    await user.click(ideaExperiment); await user.click(reviewExperiment);
    const panel = within(screen.getByRole("region", { name: "idea 工具推荐" }));
    await user.click(panel.getByRole("button", { name: "推荐 Skill / MCP" }));
    const preview = await screen.findByRole("region", { name: "idea 工具推荐预览" });
    expect(ideaExperiment).toBeChecked(); expect(reviewExperiment).toBeChecked();
    expect(vi.mocked(recommendAgentTools).mock.calls[0]![0].agents.idea.instructions).toBe("按照用户材料规划研究方案");
    await user.click(within(preview).getByRole("button", { name: "应用工具推荐" }));
    await waitFor(() => expect(ideaExperiment).not.toBeChecked());
    expect(reviewExperiment).toBeChecked(); expect(ideaPrompt).toHaveValue("按照用户材料规划研究方案");
    expect(createProject).not.toHaveBeenCalled(); expect(createSavedResearchTask).not.toHaveBeenCalled();
  });

  it.each([undefined, "saved-recommendation-task"])("shows advice in the %s editor, applies, arranges and saves its complete Workflow", async (savedTaskId) => {
    const user = userEvent.setup();
    window.ELK = class { async layout() { return { children: [] }; } };
    window.__openfarsElkPromise = undefined;
    const savedReply = (input: Parameters<typeof createSavedResearchTask>[0]) => ({ ...input,
      agents: input.agents as AgentsConfig, orchestration: input.orchestration!,
      schemaVersion: 2 as const, kind: "scienceevolve-saved-research-task" as const, id: savedTaskId ?? "new-recommended-task",
      createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" });
    vi.mocked(createSavedResearchTask).mockImplementation(async input => savedReply(input));
    vi.mocked(updateSavedResearchTask).mockImplementation(async (_id, input) => savedReply(input));
    vi.mocked(getSavedResearchTask).mockResolvedValue({
      schemaVersion: 2, kind: "scienceevolve-saved-research-task", id: "saved-recommendation-task",
      title: "待推荐课题", requirement: "分析实验数据并生成研究结果报告",
      agents: defaultPresetAgentsWithCatalogHarness, orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z"
    });
    vi.mocked(recommendProjectConfig).mockImplementation(async (input) => {
      const orchestration = structuredClone(input.orchestration);
      orchestration.input.target = "execution";
      orchestration.routes.execution = [{ target: "writing", kind: "strong" }];
      orchestration.routes.writing = [{ target: "review", kind: "strong" }];
      orchestration.termination.condition = "研究数据和结果报告通过复核";
      return { recommendation: { agents: { ...input.agents, idea: { ...input.agents.idea, instructions: "专门推荐的研究 Prompt" } }, orchestration }, warnings: [], configurationFingerprint: "e".repeat(64) };
    });
    render(<NewProjectPage savedTaskId={savedTaskId} onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByText(runtimeGateway.name);
    if (!savedTaskId) {
      await user.type(screen.getByLabelText("项目名称"), "待推荐课题");
      await user.type(screen.getByLabelText("课题方向与具体要求"), "分析实验数据并生成研究结果报告");
    }
    expect(screen.getByLabelText("推荐 Explainer 网关")).toBeInTheDocument();
    expect(screen.getByLabelText("推荐 Explainer 模型")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "推荐配置" }));
    expect(recommendProjectConfig).toHaveBeenCalledWith(expect.objectContaining({
      configurationFingerprint: "e".repeat(64)
    }), expect.any(AbortSignal), expect.any(Function));
    const dialog = await screen.findByRole("dialog", { name: "推荐配置已完成" });
    expect(within(dialog).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(within(dialog).getByText("本次推荐概述")).toBeVisible();
    expect(within(dialog).getByText("推荐团队共 5 个 Agent，任务入口为 execution，终止节点为 review。")).toBeVisible();
    expect(within(dialog).getByText("输入入口")).toBeVisible();
    expect(within(dialog).getByText("执行路由")).toBeVisible();
    expect(within(dialog).getByText("终止条件")).toBeVisible();
    expect(within(dialog).getByText("画布布局已自动整理。")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "完成，查看配置" }));
    await user.click(screen.getByRole("button", { name: "展开智能体编队" }));
    expect(await screen.findByDisplayValue("专门推荐的研究 Prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "保存课题" }));
    const saved = vi.mocked(savedTaskId ? updateSavedResearchTask : createSavedResearchTask).mock.calls[0]!.at(-1) as { orchestration: typeof DEFAULT_AGENT_ORCHESTRATION };
    expect(saved.orchestration.input.target).toBe("execution");
    expect(saved.orchestration.routes.execution).toEqual([{ target: "writing", kind: "strong" }]);
    expect(saved.orchestration.canvas?.layoutMode).toBe("layered");
    const positions = Object.values(saved.orchestration.canvas!.nodes);
    expect(new Set(positions.map(position => `${position.x},${position.y}`)).size).toBe(positions.length);
    expect(screen.getByLabelText("新项目 Agent 配置")).toHaveValue("saved-task");
  });

  it("refreshes gateway choices after returning without clearing the editor", async () => {
    const user = userEvent.setup();
    const { rerender } = renderExpanded(
      <NewProjectPage active onBack={vi.fn()} onCreated={vi.fn()} />
    );
    await screen.findByText(runtimeGateway.name);
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "未保存的课题");
    await user.type(screen.getByRole("textbox", { name: "课题方向与具体要求" }), "研究内容草稿需要保留");

    const originalCatalog = await vi.mocked(getCatalog).mock.results[0].value;
    vi.mocked(getCatalog).mockResolvedValueOnce({
      ...originalCatalog,
      gateways: [{ ...runtimeGateway, name: "刚配置的网关" }]
    });
    rerender(<NewProjectPage active={false} onBack={vi.fn()} onCreated={vi.fn()} />);
    rerender(<NewProjectPage active onBack={vi.fn()} onCreated={vi.fn()} />);

    expect((await screen.findAllByText("刚配置的网关"))[0]).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("未保存的课题");
    expect(screen.getByRole("textbox", { name: "课题方向与具体要求" })).toHaveValue("研究内容草稿需要保留");
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });

  it("fails closed on Catalog load failure while keeping explicit draft save available", async () => {
    vi.mocked(getCatalog).mockRejectedValue(new Error("运行目录服务超时"));
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_catalog_failure_draft_000000000001",
      title: "Catalog 故障期间的草稿",
      requirement: "Catalog 暂时不可用时只保存完整研究任务，不应启动任何 Agent。",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      agents: defaultPresetAgents,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(createSavedResearchTask).mockResolvedValue(savedTask);
    const user = userEvent.setup();

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("项目名称"), savedTask.title);
    await user.type(screen.getByLabelText("课题方向与具体要求"), savedTask.requirement);
    expect(await screen.findByText(/运行目录加载失败，暂不能启动项目：运行目录服务超时/))
      .toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并启动研究" }));

    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("menuitem", { name: /仅本次项目使用/ }));

    await waitFor(() => expect(createSavedResearchTask).toHaveBeenCalledTimes(1));
    expect(createProject).not.toHaveBeenCalled();
  });

  it("reports an empty loaded Catalog separately from a load failure", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [],
      harnesses: [],
      agentPrompts
    });

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    expect((await screen.findAllByText(/服务端没有可用的 Workflow Harness/)).length)
      .toBeGreaterThan(0);
    expect(screen.queryByText(/运行目录加载失败，暂不能启动项目/))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并启动研究" }));
  });

  it("keeps project launch disabled when the loaded Catalog has no global Gateway", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["nex-agi/Nex-N2-Pro"],
      gateways: [],
      harnesses: runtimeHarnesses,
      defaultHarnessId: "codex",
      agentPrompts
    });

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    expect(await screen.findByText(/运行目录已加载，但服务端没有可用的全局网关。/))
      .toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并启动研究" }));
    expect(createProject).not.toHaveBeenCalled();
  });

  it("saves the configured research brief and all Agent settings without starting", async () => {
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_00000000000000000000000000000001",
      title: "待重复启动课题",
      requirement: "保存需求内容和五个 Agent 的完整配置，但现在不要启动。",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      agents: defaultPresetAgents,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(createSavedResearchTask).mockResolvedValue(savedTask);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("项目名称"), savedTask.title);
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      savedTask.requirement
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("menuitem", { name: /仅本次项目使用/ }));

    await waitFor(() =>
      expect(createSavedResearchTask).toHaveBeenCalledTimes(1)
    );
    expect(createProject).not.toHaveBeenCalled();
    expect(vi.mocked(createSavedResearchTask).mock.calls[0][0]).toEqual({
      title: savedTask.title,
      requirement: savedTask.requirement,
      agents: defaultPresetAgentsWithCatalogHarness,
      orchestration: DEFAULT_AGENT_ORCHESTRATION,
      git: { enabled: false }
    });
    expect(screen.getByText(/研究任务副本已保存到主页/)).toBeInTheDocument();
  });

  it("loads and updates a saved research task with its Agent configuration", async () => {
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_00000000000000000000000000000002",
      title: "需要编辑的课题",
      requirement: "加载此前保存的科研需求和全部 Agent 配置供用户继续编辑。",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      agents: {
        ...defaultPresetAgents,
        execution: {
          ...defaultPresetAgents.execution,
          model: "saved-execution-model",
          reasoningEffort: "xhigh"
        }
      },
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(getSavedResearchTask).mockResolvedValue(savedTask);
    vi.mocked(updateSavedResearchTask).mockResolvedValue({
      ...savedTask,
      title: "编辑完成的课题"
    });
    const user = userEvent.setup();
    renderExpanded(
      <NewProjectPage
        onBack={vi.fn()}
        onCreated={vi.fn()}
        savedTaskId={savedTask.id}
      />
    );

    expect(
      await screen.findByRole("heading", { name: "编辑已保存的科研任务" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("执行智能体模型")).toHaveValue(
      "saved-execution-model"
    );
    const titleInput = screen.getByLabelText("项目名称");
    await user.clear(titleInput);
    await user.type(titleInput, "编辑完成的课题");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("menuitem", { name: /仅本次项目使用/ }));

    await waitFor(() =>
      expect(updateSavedResearchTask).toHaveBeenCalledWith(
        savedTask.id,
        expect.objectContaining({
          title: "编辑完成的课题",
          agents: expect.objectContaining({
            execution: expect.objectContaining({
              model: "saved-execution-model"
            })
          })
        })
      )
    );
    const savedExecution = vi.mocked(updateSavedResearchTask).mock.calls[0]![1].agents.execution;
    expect(savedExecution).not.toHaveProperty("reasoningEffort");
    expect(savedExecution).not.toHaveProperty("legacyReasoningEffort");
    expect(screen.getByText(/旧 Harness 思考深度“xhigh”无法精确匹配/)).toBeVisible();
  });

  it("uploads a project image before creating the project and passes its purpose note", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "prj_with_image" } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await user.type(screen.getByLabelText("项目名称"), "图片研究课题");
    await user.type(screen.getByLabelText("课题方向与具体要求"), "请结合参考图片分析研究方案。" );
    const image = new File([new Uint8Array([137, 80, 78, 71])], "diagram.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("选择课题文件或图片"), image);
    await waitFor(() => expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled());
    await user.type(screen.getByLabelText("这些文件的用途（可选）"), "参考图片用于理解目标。");
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(uploadProjectInputFile).toHaveBeenCalledWith("upload-token", "diagram.png", image);
    expect(vi.mocked(uploadProjectInputFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createProject).mock.invocationCallOrder[0]);
    expect(vi.mocked(createProject).mock.calls[0][0]).toMatchObject({
      inputUploadId: "upload-token",
      inputDescription: "参考图片用于理解目标。"
    });
  });

  it("preserves the relative path from a selected folder", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "prj_with_folder" } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await user.type(screen.getByLabelText("项目名称"), "文件夹输入课题");
    await user.type(screen.getByLabelText("课题方向与具体要求"), "请分析文件夹中的研究数据并总结。" );
    const file = new File(["value"], "table.csv", { type: "text/csv" });
    Object.defineProperty(file, "webkitRelativePath", { value: "dataset/data/table.csv" });
    await user.upload(screen.getByLabelText("选择课题文件夹"), file);
    await waitFor(() => expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(uploadProjectInputFile).toHaveBeenCalledWith("upload-token", "dataset/data/table.csv", file);
  });

  it("keeps selected folder files when the browser clears its live file list", async () => {
    let resolveSession: ((id: string) => void) | undefined;
    vi.mocked(createProjectInputUpload).mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    const file = new File(["data"], "table.csv", { type: "text/csv" });
    Object.defineProperty(file, "webkitRelativePath", { value: "dataset/table.csv" });
    const liveFiles = [file];
    fireEvent.change(screen.getByLabelText("选择课题文件夹"), { target: { files: liveFiles } });
    expect(createProjectInputUpload).toHaveBeenCalledOnce();
    liveFiles.length = 0;
    resolveSession?.("upload-token");
    await waitFor(() => expect(uploadProjectInputFile).toHaveBeenCalledWith("upload-token", "dataset/table.csv", file));
    expect(await screen.findByText("dataset")).toBeVisible();
  });

  it("shows at most five attachment entries and groups a selected folder", async () => {
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    const files = [1, 2, 3, 4, 5, 6].map((number) => new File([String(number)], `file-${number}.txt`));
    await user.upload(screen.getByLabelText("选择课题文件或图片"), files);
    await waitFor(() => expect(screen.getByText("file-5.txt")).toBeVisible());
    expect(screen.queryByText("file-6.txt")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开查看其余 1 项" }));
    expect(screen.getByText("file-6.txt")).toBeVisible();
    const folderFiles = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
    Object.defineProperty(folderFiles[0], "webkitRelativePath", { value: "dataset/data/a.txt" });
    Object.defineProperty(folderFiles[1], "webkitRelativePath", { value: "dataset/data/b.txt" });
    await user.upload(screen.getByLabelText("选择课题文件夹"), folderFiles);
    await waitFor(() => expect(screen.getByText("dataset")).toBeVisible());
    expect(screen.getByText("2 个文件")).toBeVisible();
    expect(screen.queryByText("dataset/data/a.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("dataset/data/b.txt")).not.toBeInTheDocument();
  });

  it("waits for an automatic scan before uploading and ignores focus events during upload", async () => {
    sessionStorage.setItem("openfars-user-inputs:new", "upload-token");
    let finishScan: ((files: Array<{ path: string; size: number }>) => void) | undefined;
    vi.mocked(listProjectInputFiles).mockImplementationOnce(() => new Promise((resolve) => { finishScan = resolve; }));
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    const file = new File(["new data"], "table.csv");
    Object.defineProperty(file, "webkitRelativePath", { value: "dataset/table.csv" });
    await user.upload(screen.getByLabelText("选择课题文件夹"), file);
    fireEvent.focus(window);
    expect(listProjectInputFiles).toHaveBeenCalledOnce();
    expect(uploadProjectInputFile).not.toHaveBeenCalled();
    finishScan?.([]);
    await waitFor(() => expect(uploadProjectInputFile).toHaveBeenCalledWith("upload-token", "dataset/table.csv", file));
    expect(await screen.findByText("dataset")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the temporary user_inputs folder in the system file manager and refreshes its contents", async () => {
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await user.click(screen.getByRole("button", { name: "打开目录" }));
    await waitFor(() => expect(openProjectInputDirectory).toHaveBeenCalledWith("upload-token"));
    await waitFor(() => expect(screen.getByRole("button", { name: "打开目录" })).toBeEnabled());
    vi.mocked(listProjectInputFiles).mockResolvedValue([
      { path: "references/note.txt", size: 4 }, { path: "references/plot.png", size: 8 }
    ]);
    expect(screen.queryByRole("button", { name: "刷新文件列表" })).not.toBeInTheDocument();
    fireEvent.focus(window);
    expect(await screen.findByText("references")).toBeVisible();
    expect(screen.getByText("2 个文件")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "移除 references" }));
    await waitFor(() => expect(removeProjectInputFile).toHaveBeenCalledWith("upload-token", "references/note.txt"));
    expect(removeProjectInputFile).toHaveBeenCalledWith("upload-token", "references/plot.png");
  });

  it("keeps uploads, recommendations and creation available when the file manager cannot open", async () => {
    vi.mocked(openProjectInputDirectory).mockRejectedValue(new Error("当前环境没有可用的文件管理器"));
    vi.mocked(createProject).mockResolvedValue({ id: "prj_without_desktop" } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await user.type(screen.getByLabelText("项目名称"), "跨平台输入课题");
    await user.type(screen.getByLabelText("课题方向与具体要求"), "请分析所附研究数据并总结研究结论。");
    await user.click(screen.getByRole("button", { name: "打开目录" }));
    expect(await screen.findByText(/当前环境没有可用的文件管理器/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "推荐配置" })).toBeEnabled();
    const file = new File(["data"], "研究数据.csv");
    await user.upload(screen.getByLabelText("选择课题文件或图片"), file);
    expect(await screen.findByText("研究数据.csv")).toBeVisible();
    expect(uploadProjectInputFile).toHaveBeenCalledWith("upload-token", "研究数据.csv", file);
    await waitFor(() => expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(vi.mocked(createProject).mock.calls[0]![0]).toMatchObject({ inputUploadId: "upload-token" });
  });

  it("still blocks creation when scanning inputs fails after a file manager failure", async () => {
    vi.mocked(openProjectInputDirectory).mockRejectedValue(new Error("文件管理器不可用"));
    vi.mocked(listProjectInputFiles).mockRejectedValue(new Error("文件列表无效"));
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await user.type(screen.getByLabelText("项目名称"), "输入校验课题");
    await user.type(screen.getByLabelText("课题方向与具体要求"), "请分析所附研究数据并总结研究结论。");
    await user.click(screen.getByRole("button", { name: "打开目录" }));
    expect(await screen.findByText("文件列表无效")).toBeVisible();
    expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并启动研究" }));
    expect(screen.getByRole("button", { name: "推荐配置" })).toBeDisabled();
  });

  it("restores the temporary inputs folder after the page reloads", async () => {
    sessionStorage.setItem("openfars-user-inputs:new", "upload-token");
    vi.mocked(listProjectInputFiles).mockResolvedValue([{ path: "notes.txt", size: 5 }]);
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    expect(await screen.findByText("notes.txt")).toBeVisible();
    expect(createProjectInputUpload).not.toHaveBeenCalled();
  });

  it("defaults every agent to Nex-N2-Pro without a Harness reasoning field and submits overrides", async () => {
    vi.mocked(createProject).mockResolvedValue({
      id: "prj_created"
    } as Project);
    const onCreated = vi.fn();
    const user = userEvent.setup();

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={onCreated} />);

    expect(
      await screen.findByRole("heading", {
        name: "定义你的下一个科研课题"
      })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("结果形式：论文")).toBeChecked();

    const modelInputs = screen.getAllByLabelText(/模型$/).filter((input) => !input.closest(".config-recommendation"));
    expect(modelInputs).toHaveLength(5);
    for (const input of modelInputs) {
      expect(input).toHaveValue("nex-agi/Nex-N2-Pro");
    }
    expect(screen.queryByLabelText(/(?<!网关)思考深度$/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Main Agent自定义 Prompt")).toHaveValue(
        agentPrompts.main
      )
    );

    const writingModel = screen.getByLabelText("写作智能体模型");
    await user.selectOptions(writingModel, "gpt-5.6-terra");
    const executionPrompt = screen.getByLabelText("执行智能体自定义 Prompt");
    await user.clear(executionPrompt);
    await user.type(executionPrompt, "Custom execution research prompt");
    await user.type(
      screen.getByLabelText("项目名称"),
      "模型与思考深度配置验证"
    );
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证五类科研智能体能够独立选择模型和思考深度。"
    );
    await user.click(
      screen.getByRole("button", { name: "创建并启动研究" })
    );

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createProject).mock.calls[0][0];
    expect(input.agents.execution).not.toHaveProperty("reasoningEffort");
    expect(input.agents.execution.mcpServers).toEqual([]);
    expect(input.agents.execution.skills).toEqual([
      "builtin:nature-figure"
    ]);
    expect(input.agents.execution.instructions).toBe(
      "Custom execution research prompt"
    );
    expect(input.agents.writing.model).toBe("gpt-5.6-terra");
    expect(input.agents.writing.skills).toEqual([
      "builtin:ccf-paper-writer",
      "builtin:ccf-visual-composer",
      "builtin:ccf-paper-to-exemplar",
      "builtin:nature-writing",
      "builtin:nature-polishing"
    ]);
    expect(input.agents.main).toEqual({
      ...DEFAULT_AGENTS.main,
      harness: "codex",
      gatewayId: runtimeGateway.id,
      instructions: agentPrompts.main
    });
    expect(onCreated).toHaveBeenCalledWith("prj_created");
  });

  it("submits a user-edited Agent orchestration template", async () => {
    vi.mocked(createProject).mockResolvedValue({
      id: "prj_custom_orchestration"
    } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("输入目标外层节点"), "execution");
    await user.selectOptions(
      screen.getByLabelText("执行智能体第 1 条出边目标"),
      "writing"
    );
    await user.selectOptions(screen.getByLabelText("终止条件 Agent"), "writing");
    await user.click(
      screen.getByRole("checkbox", { name: "允许 Main 动态重配置（高级权限）" })
    );
    const condition = screen.getByLabelText("终止条件");
    await user.clear(condition);
    await user.type(
      condition,
      "论文达到可投稿标准，并且所有关键实验都有可靠证据。"
    );
    await user.type(screen.getByLabelText("项目名称"), "自定义编排课题");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证前端能够将四部分 Agent 编排模板完整提交给后端。"
    );
    await user.click(
      screen.getByRole("button", { name: "创建并启动研究" })
    );

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0][0].orchestration).toMatchObject({
      input: { source: "input", target: "execution" },
      routes: expect.objectContaining({
        execution: [{ target: "writing", kind: "strong" }]
      }),
      termination: {
        agent: "writing",
        condition: "论文达到可投稿标准，并且所有关键实验都有可靠证据。",
        decisionBy: "main",
        automatic: false
      },
      allowMainReconfiguration: true
    });
  });

  it("saves a v3 collaboration draft with Agent identity references retained at root", async () => {
    vi.mocked(createSavedResearchTask).mockImplementation(async (input) => ({
      ...input,
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_scoped_000000000000000000000001",
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z"
    } as SavedResearchTask));
    const user = userEvent.setup();
    render(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await waitFor(() => expect(screen.queryByText(/运行目录仍在加载/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("switch", { name: "启用 Git 机制" }));
    await user.type(screen.getByLabelText("GitHub 仓库名称"), "evidence-collaboration");
    await user.click(screen.getByRole("radio", { name: "Public 仓库" }));
    await user.click(screen.getByRole("button", { name: "打开 Workflow 画布编辑器" }));
    const canvasDialog = await screen.findByRole("dialog", { name: "编辑 Workflow 画布" });
    await user.click(within(canvasDialog).getByRole("button", { name: "新增协作组" }));
    const groupDialog = screen.getByRole("dialog", { name: "新增协作组" });
    await user.type(within(groupDialog).getByLabelText("新协作组 ID"), "evidence_group");
    await user.type(within(groupDialog).getByLabelText("新协作组显示名称"), "Evidence group");
    await user.click(within(groupDialog).getByLabelText("idea"));
    await user.click(within(groupDialog).getByLabelText("execution"));
    await user.selectOptions(within(groupDialog).getByRole("combobox", { name: "新协作组 Leader" }), "main");
    await user.click(within(groupDialog).getByRole("button", { name: "创建可编排协作组" }));

    expect(within(canvasDialog).getByLabelText("Evidence group 组内 Workflow 编辑器")).toBeInTheDocument();
    await user.click(within(canvasDialog).getByRole("button", { name: "返回父图" }));
    expect(canvasDialog.querySelector('[data-node-id="evidence_group"]')).not.toBeNull();
    expect(canvasDialog.querySelector('[data-node-id="idea"]')).not.toBeNull();
    expect(canvasDialog.querySelector('[data-node-id="execution"]')).not.toBeNull();
    await user.click(within(canvasDialog).getAllByRole("button", { name: "关闭 Workflow 编辑器" })[0]!);
    expect(screen.getByRole("switch", { name: "启用 Git 机制" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "启用 Git 机制" })).toBeDisabled();

    await user.type(screen.getByLabelText("项目名称"), "Git 协作组提交验收");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证创建页面将 Git 选择和协作组拓扑作为同一个权威 payload 提交。"
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Public 仓库会公开研究过程");
    expect(screen.queryByText(/服务端递归运行尚未启用/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并启动研究" }));
    await user.click(screen.getByRole("button", { name: "保存课题" }));

    await waitFor(() => expect(createSavedResearchTask).toHaveBeenCalledTimes(1));
    expect(createProject).not.toHaveBeenCalled();
    const input = vi.mocked(createSavedResearchTask).mock.calls[0]![0];
    expect(input.git).toEqual({
      enabled: true,
      provider: "github",
      accountId: GITHUB_ACCOUNT_ID,
      repositoryName: "evidence-collaboration",
      repositoryVisibility: "public"
    });
    expect(input.orchestration).toMatchObject({
      schemaVersion: 3,
      collaborations: [{
        id: "evidence_group",
        displayName: "Evidence group",
        memberAgentIds: ["idea", "execution"],
        renamePolicy: "editable"
      }],
      scopedWorkflow: {
        rootAgentIds: ["main", "idea", "execution", "writing", "review"],
        groups: [{ id: "evidence_group", leaderAgentId: "main", workflow: { input: { edges: [{ kind: "parallel" }, { kind: "parallel" }] } } }]
      }
    });
    expect(input.orchestration!.routes.main.map((edge) => edge.target)).toContain("idea");
    expect(input.orchestration!.routes.main.map((edge) => edge.target)).toContain("execution");
  });

  it("starts a valid saved v3 collaboration without discarding its scoped graph or Git settings", async () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, {
      id: "evidence_group", displayName: "Evidence group",
      leaderAgentId: "main", memberAgentIds: ["idea", "execution"]
    });
    orchestration.routes.evidence_group = [{ target: "review", kind: "strong" }];
    orchestration.routes.main.push({ target: "evidence_group", kind: "weak" });
    const savedTask: SavedResearchTask = {
      schemaVersion: 2, kind: "scienceevolve-saved-research-task",
      id: "task_scoped_start_0000000000000001",
      title: "有效的分层协作课题", requirement: "使用保存的分层 Workflow 配置启动并核对图结构与 Git 设置。",
      agents: defaultPresetAgentsWithCatalogHarness, orchestration,
      git: { enabled: true, provider: "github", accountId: GITHUB_ACCOUNT_ID,
        repositoryName: "scoped-start-evidence", repositoryVisibility: "private" },
      createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z"
    };
    vi.mocked(getSavedResearchTask).mockResolvedValue(savedTask);
    vi.mocked(createProject).mockResolvedValue({ id: "prj_scoped_start" } as Project);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectPage savedTaskId={savedTask.id} onBack={vi.fn()} onCreated={onCreated} />);
    const start = await screen.findByRole("button", { name: "创建并启动研究" });
    await waitFor(() => expect(start).toBeEnabled());
    const file = new File(["samples"], "samples.csv");
    Object.defineProperty(file, "webkitRelativePath", { value: "measurements/samples.csv" });
    await user.upload(screen.getByLabelText("选择课题文件夹"), file);
    expect(await screen.findByText("measurements")).toBeVisible();
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0]![0]).toMatchObject({
      title: savedTask.title, orchestration, git: savedTask.git, inputUploadId: "upload-token"
    });
    expect(onCreated).toHaveBeenCalledWith("prj_scoped_start");
  });

  it("saves and starts a Git project without creating a collaboration group", async () => {
    vi.mocked(createSavedResearchTask).mockImplementation(async input => ({
      ...input, schemaVersion: 2, kind: "scienceevolve-saved-research-task",
      id: "task_git_without_group", createdAt: "", updatedAt: ""
    } as SavedResearchTask));
    vi.mocked(createProject).mockResolvedValue({ id: "prj_git_without_group" } as Project);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectPage onBack={vi.fn()} onCreated={onCreated} />);

    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await waitFor(() => expect(screen.queryByText(/运行目录仍在加载/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("switch", { name: "启用 Git 机制" }));

    expect(screen.getByText("Git 仓库配置")).toBeInTheDocument();
    expect(screen.queryByText(/还没有协作组，暂不能启动/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("GitHub 仓库名称"), "research-without-group");
    await user.type(screen.getByLabelText("项目名称"), "普通 Workflow 使用 Git");
    await user.type(screen.getByLabelText("课题方向与具体要求"), "使用普通 Agent 流程研究课题并通过 Git 管理产物。");
    const start = screen.getByRole("button", { name: "创建并启动研究" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "保存课题" }));
    await waitFor(() => expect(createSavedResearchTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const draft = vi.mocked(createSavedResearchTask).mock.calls[0]![0];
    const input = vi.mocked(createProject).mock.calls[0]![0];
    expect(draft.git).toEqual({ enabled: true, provider: "github", accountId: GITHUB_ACCOUNT_ID,
      repositoryName: "research-without-group", repositoryVisibility: "private" });
    expect(input.git).toEqual(draft.git);
    expect(input.orchestration).toEqual(draft.orchestration);
    expect(input.orchestration?.collaborations).toEqual([]);
    expect(input.orchestration?.agents).toEqual(DEFAULT_AGENT_ORCHESTRATION.agents);
    expect(input.orchestration?.routes).toEqual(DEFAULT_AGENT_ORCHESTRATION.routes);
    expect(onCreated).toHaveBeenCalledWith("prj_git_without_group");
  });

  it.each(["text", "canvas"] as const)("starts an ordinary workflow after disabling Git from the %s editor of a group-free v3 draft", async editor => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    const savedTask: SavedResearchTask = {
      schemaVersion: 2, kind: "scienceevolve-saved-research-task", id: "task_empty_scope_git",
      title: "已移除全部协作组", requirement: "保留普通 Agent 和所有连接，在不启用 Git 时启动这个研究流程。",
      agents: defaultPresetAgentsWithCatalogHarness, orchestration,
      git: { enabled: true, provider: "github", accountId: GITHUB_ACCOUNT_ID,
        repositoryName: "retained-repository", repositoryVisibility: "public" },
      createdAt: "", updatedAt: ""
    };
    vi.mocked(getSavedResearchTask).mockResolvedValue(savedTask);
    vi.mocked(createProject).mockResolvedValue({ id: "prj_git_disabled" } as Project);
    const user = userEvent.setup();
    render(<NewProjectPage savedTaskId={savedTask.id} onBack={vi.fn()} onCreated={vi.fn()} />);
    const gitSwitch = await screen.findByRole("switch", { name: "启用 Git 机制" });
    await waitFor(() => expect(gitSwitch).toBeChecked());
    expect(gitSwitch).toBeEnabled();
    if (editor === "canvas") {
      await user.click(screen.getByRole("button", { name: "打开 Workflow 画布编辑器" }));
      const dialog = screen.getByRole("dialog", { name: "编辑 Workflow 画布" });
      await user.click(within(dialog).getByRole("button", { name: /流程设置/ }));
      await user.click(within(dialog).getByRole("switch", { name: "画布启用 Git 机制" }));
      await user.click(within(dialog).getAllByRole("button", { name: "关闭 Workflow 编辑器" })[0]!);
    } else {
      await user.click(gitSwitch);
      await user.click(gitSwitch);
      expect(screen.getByLabelText("GitHub 仓库名称")).toHaveValue("retained-repository");
      expect(screen.getByLabelText("Public 仓库")).toBeChecked();
      await user.click(gitSwitch);
    }
    expect(gitSwitch).not.toBeChecked();
    const start = screen.getByRole("button", { name: "创建并启动研究" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createProject).mock.calls[0]![0];
    expect(input.git).toEqual({ enabled: false });
    const { scopedWorkflow: _scopedWorkflow, ...ordinary } = orchestration;
    expect(input.orchestration).toMatchObject({ ...ordinary, schemaVersion: 2 });
    expect(input.orchestration?.scopedWorkflow).toBeUndefined();
  });

  it("opens the GitHub account library when Git is enabled without a ready account", async () => {
    vi.mocked(getGitHubAccounts).mockResolvedValue({
      accounts: [],
      oauthConfigured: true
    });
    const user = userEvent.setup();
    render(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await screen.findByRole("heading", { name: "定义你的下一个科研课题" });
    await waitFor(() => expect(getGitHubAccounts).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("switch", { name: "启用 Git 机制" }));

    expect(window.location.hash).toBe("#/github-accounts");
    expect(screen.getByRole("switch", { name: "启用 Git 机制" })).toBeChecked();
    expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并启动研究" }));
  });

  it("keeps project Skill/MCP definitions out of the new-project form", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "prj_advanced_controls" } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByLabelText("Main Agent自定义 Prompt")).toHaveValue(agentPrompts.main)
    );

    const ideaCard = (await screen.findByRole("heading", { name: "构思智能体" })).closest("article");
    expect(ideaCard).not.toBeNull();
    expect(screen.queryByLabelText("Project Skill 定义 JSON")).toBeNull();
    expect(screen.queryByLabelText("Project MCP 定义 JSON")).toBeNull();
    expect(screen.queryByText("项目级 Skill 与 MCP")).toBeNull();
    expect(screen.queryByLabelText(/Bash 网络代理/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "允许终止 Agent 自动完成" }));
    await user.click(screen.getByRole("checkbox", { name: "允许 Main 动态重配置（高级权限）" }));
    await user.type(screen.getByLabelText("项目名称"), "高级运行配置验证");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证高级控制与项目资源通过同一份 Workflow 配置提交。"
    );
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createProject).mock.calls[0][0];
    expect(input.orchestration).toMatchObject({
      allowMainReconfiguration: true,
      termination: { automatic: true }
    });
    expect(input.agents.idea).toMatchObject({
      mcpServers: []
    });
    for (const config of Object.values(input.agents)) expect(config).not.toHaveProperty("proxy");
    expect(input).not.toHaveProperty("skillDefinitions");
    expect(input).not.toHaveProperty("mcpDefinitions");
  });

  it("submits result format presets and free-form delivery guidance", async () => {
    vi.mocked(createProject).mockResolvedValue({
      id: "prj_result_format"
    } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByLabelText("结果形式：表格"));
    await user.type(
      screen.getByLabelText("结果形式补充说明"),
      "整理成便于审阅和继续编辑的关系分析，包含比较表和证据边界。"
    );
    await user.type(screen.getByLabelText("项目名称"), "结果形式课题");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证用户交付意图会随项目创建保存，并进入 main 上下文。"
    );
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0][0].orchestration).toMatchObject({
      resultFormat: {
        presets: ["论文", "表格"],
        custom: "整理成便于审阅和继续编辑的关系分析，包含比较表和证据边界。"
      }
    });
  });

  it("keeps deterministic Agent routes and exposes candidate guidance for every Agent", async () => {
    vi.mocked(createProject).mockResolvedValue({
      id: "prj_main_autonomous_loop"
    } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const executionNext = screen.getByLabelText("执行智能体第 1 条出边目标");
    expect(executionNext).toHaveValue("main");
    expect(
      within(executionNext).queryByRole("option", { name: "继续流程判断" })
    ).not.toBeInTheDocument();
    const plan = screen.getByLabelText("执行智能体 路径判断提示");
    await user.clear(plan);
    await user.type(
      plan,
      "根据最新实验结果判断是继续实验、进入写作，还是调用其他 Agent。"
    );
    await user.type(screen.getByLabelText("项目名称"), "Main 自主路由课题");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证任意 Agent 完成后都能按照强边或多个弱边连接到下一个 Agent。"
    );
    await user.click(
      screen.getByRole("button", { name: "创建并启动研究" })
    );

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const orchestration = vi.mocked(createProject).mock.calls[0][0]
      .orchestration!;
    expect(orchestration.routes.execution).toEqual([
      { target: "main", kind: "strong" }
    ]);
    expect(orchestration.decisionPlans.execution).toContain(
      "结合 execution Agent 刚完成的结果、用户需求、当前项目证据、未解决问题和终止条件"
    );
    expect(orchestration.decisionPlans.execution).toContain(
      "根据最新实验结果判断是继续实验、进入写作，还是调用其他 Agent。"
    );
  });

  it("adds user-defined Agent names, reuses roles, and routes by name", async () => {
    vi.mocked(createProject).mockResolvedValue({
      id: "prj_dynamic_agents"
    } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const nameInput = await screen.findByLabelText("新 Agent name");
    const roleSelect = screen.getByLabelText("新 Agent 模板");
    await user.type(nameInput, "verifier");
    await user.selectOptions(roleSelect, "__new_template__");
    await user.click(screen.getByRole("button", { name: "添加 Agent" }));

    expect(screen.getByLabelText("verifier自定义 Prompt")).toHaveValue(
      "Carry out the bounded task assigned by main. Inspect project evidence, distinguish measured facts from proposals, and return an ordinary Worker handoff."
    );
    expect(
      within(screen.getByLabelText("输入目标外层节点")).getByRole("option", {
        name: "verifier · general"
      })
    ).toBeInTheDocument();

    await user.type(nameInput, "execution_backup");
    await user.selectOptions(roleSelect, "execution");
    await user.click(screen.getByRole("button", { name: "添加 Agent" }));
    expect(screen.getByLabelText("execution_backup模型")).toHaveValue(
      defaultPresetAgents.execution.model
    );
    expect(screen.getByLabelText("execution_backup自定义 Prompt")).toHaveValue(
      defaultPresetAgents.execution.instructions
    );

    await user.selectOptions(screen.getByLabelText("输入目标外层节点"), "verifier");
    await user.selectOptions(
      screen.getByLabelText("execution_backup第 1 条出边目标"),
      "verifier"
    );
    await user.type(screen.getByLabelText("项目名称"), "动态 Agent 编排");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证不同 Agent name 可以复用相同模板并按照 name 完成路由。"
    );
    await user.click(
      screen.getByRole("button", { name: "创建并启动研究" })
    );

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createProject).mock.calls[0][0];
    expect(input.orchestration).toBeDefined();
    const orchestration = input.orchestration!;
    expect(orchestration.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "verifier", template: "general" }),
        expect.objectContaining({ name: "execution_backup", template: "execution" })
      ])
    );
    expect(orchestration.input.target).toBe("verifier");
    expect(orchestration.routes.execution_backup).toEqual([
      { target: "verifier", kind: "strong" }
    ]);
    expect(input.agents.verifier.instructions).toContain("main");
    expect(input.agents.execution_backup.instructions).toBe(
      defaultPresetAgents.execution.instructions
    );
  });

  it("keeps every built-in Role available after its Agent is deleted", async () => {
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(await screen.findByRole("button", { name: "删除 idea" }));

    const roleSelect = screen.getByLabelText("新 Agent 模板");
    expect(
      within(roleSelect).getByRole("option", { name: "使用模板：idea" })
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("新 Agent name"), "idea_backup");
    await user.selectOptions(roleSelect, "idea");
    await user.click(screen.getByRole("button", { name: "添加 Agent" }));

    expect(screen.getByLabelText("idea_backup自定义 Prompt")).toHaveValue(
      agentPrompts.idea
    );
    expect(screen.getByLabelText("idea_backup模型")).toHaveValue(
      defaultPresetAgents.idea.model
    );
    expect(
      within(screen.getByLabelText("输入目标外层节点")).getByRole("option", {
        name: "idea_backup · idea"
      })
    ).toBeInTheDocument();
  });

  it("applies a project-exported preset before creating a new project", async () => {
    const savedPreset: AgentConfigPreset = {
      ...defaultPreset,
      id: "cfg_00000000000000000000000000000003",
      name: "论文复现实验配置",
      builtin: false,
      sourceProjectId: "prj_00000000000000000000000000000003",
      sourceProjectTitle: "论文复现实验",
      agents: {
        ...defaultPresetAgentsWithCatalogHarness,
        main: {
          ...defaultPresetAgentsWithCatalogHarness.main,
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
          instructions: "Exported Main prompt"
        },
        execution: {
          ...defaultPresetAgentsWithCatalogHarness.execution,
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
          instructions: "Exported Execution prompt",
          skills: ["builtin:experiment-runner", "builtin:inspire"],
          autoSkills: ["builtin:nature-figure"],
          mcpServers: [
            { name: "metrics", url: "https://metrics.example.test/mcp" }
          ],
          permission: "workspace",
          webSearch: true
        }
      }
    };
    vi.mocked(getAgentConfigPresets).mockResolvedValue([
      defaultPreset,
      savedPreset
    ]);
    vi.mocked(createProject).mockResolvedValue({
      id: "prj_created_from_preset"
    } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.selectOptions(
      await screen.findByLabelText("新项目 Agent 配置"),
      savedPreset.id
    );
    expect(
      screen.getByRole("option", { name: /论文复现实验配置/ })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Main Agent模型")).toHaveValue(
      "gpt-5.6-terra"
    );
    expect(screen.getByLabelText("Main Agent自定义 Prompt")).toHaveValue(
      "Exported Main prompt"
    );
    const executionCard = screen.getByRole("heading", { name: "执行智能体" }).closest("article");
    expect(executionCard).not.toBeNull();
    expect(
      within(executionCard!).getByRole("checkbox", { name: /metrics/ })
    ).toBeChecked();
    await user.type(screen.getByLabelText("项目名称"), "从预设启动的新项目");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证导出的完整 Agent 配置能够直接用于新建科研项目。"
    );
    await user.click(
      screen.getByRole("button", { name: "创建并启动研究" })
    );

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const createdAgents = vi.mocked(createProject).mock.calls[0]![0].agents;
    expect(createdAgents.main).not.toHaveProperty("reasoningEffort");
    expect(createdAgents.execution).not.toHaveProperty("reasoningEffort");
    expect(createdAgents.main.reasoningMigrationWarning).toMatch(/Provider 默认值/);
    expect(createdAgents.execution.reasoningMigrationWarning).toMatch(/Provider 默认值/);
  });

  it("keeps Canvas Harness/Gateway/model changes through all three save modes and a page reload", async () => {
    const canvasGateway: GatewayRecord = {
      ...runtimeGateway,
      models: ["route-model"],
      defaultModel: "route-model",
      tests: runtimeGateway.tests?.filter((test) => test.model === "route-model")
    };
    const reusablePreset: AgentConfigPreset = {
      ...defaultPreset,
      id: "cfg_00000000000000000000000000000044",
      name: "Canvas 可复用配置",
      builtin: false
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["route-model"],
      gateways: [canvasGateway],
      harnesses: runtimeHarnesses,
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getAgentConfigPresets).mockResolvedValue([defaultPreset, reusablePreset]);
    vi.mocked(updateAgentConfigPreset).mockImplementation(async (id, input) => ({
      ...reusablePreset,
      ...input,
      id,
      builtin: false
    }));
    vi.mocked(createAgentConfigPreset).mockImplementation(async (input) => ({
      schemaVersion: 2,
      kind: "scienceevolve-agent-config-preset",
      id: "cfg_00000000000000000000000000000045",
      builtin: false,
      ...input
    }));
    let savedCopy: SavedResearchTask | undefined;
    vi.mocked(createSavedResearchTask).mockImplementation(async (input) => {
      const task: SavedResearchTask = {
        schemaVersion: 2,
        kind: "scienceevolve-saved-research-task",
        id: "task_00000000000000000000000000000045",
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
        ...input,
        orchestration: input.orchestration ?? structuredClone(DEFAULT_AGENT_ORCHESTRATION)
      };
      savedCopy = task;
      return task;
    });
    const user = userEvent.setup();
    const view = renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("项目名称"), "Canvas 配置持久化验收");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证画布修改经更新、项目副本和另存配置后仍能完整恢复。"
    );
    await user.selectOptions(
      await screen.findByLabelText("新项目 Agent 配置"),
      reusablePreset.id
    );
    screen.getByRole("button", { name: "打开 Workflow 画布编辑器" }).focus();
    await user.keyboard("{Enter}");
    let canvasDialog = await screen.findByRole("dialog", { name: "编辑 Workflow 画布" });
    await user.click(canvasDialog.querySelector('[data-node-id="idea"]')!);
    await user.selectOptions(within(canvasDialog).getByLabelText("idea Harness"), "claude-code");
    await user.selectOptions(
      within(canvasDialog).getByLabelText("idea全局网关"),
      canvasGateway.id
    );
    expect(within(canvasDialog).getByLabelText("idea model")).toHaveValue("");
    expect(within(canvasDialog).getByText("切换网关后需要重新选择 model")).toHaveAttribute("role", "alert");
    await user.selectOptions(within(canvasDialog).getByLabelText("idea model"), "route-model");
    expect(within(canvasDialog).getByText("已启用自动路由：Anthropic Messages → OpenAI Responses")).toBeVisible();
    await user.click(within(canvasDialog).getAllByRole("button", { name: "关闭 Workflow 编辑器" })[0]!);

    expect(screen.getByLabelText("构思智能体 Harness")).toHaveValue("claude-code");
    expect(screen.getByLabelText("构思智能体全局网关")).toHaveValue(canvasGateway.id);
    expect(screen.getByLabelText("构思智能体模型")).toHaveValue("route-model");

    await user.selectOptions(screen.getByLabelText("构思智能体 Harness"), "pi");
    screen.getByRole("button", { name: "打开 Workflow 画布编辑器" }).focus();
    await user.keyboard("{Enter}");
    canvasDialog = await screen.findByRole("dialog", { name: "编辑 Workflow 画布" });
    await user.click(canvasDialog.querySelector('[data-node-id="idea"]')!);
    expect(within(canvasDialog).getByLabelText("idea Harness")).toHaveValue("pi");
    await user.selectOptions(within(canvasDialog).getByLabelText("idea Harness"), "claude-code");
    await user.click(within(canvasDialog).getAllByRole("button", { name: "关闭 Workflow 编辑器" })[0]!);

    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("menuitem", { name: /更新当前配置/ }));
    await user.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(updateAgentConfigPreset).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("menuitem", { name: /另存为新配置/ }));
    const nameInput = screen.getByLabelText("Workflow 配置名称");
    await user.clear(nameInput);
    await user.type(nameInput, "Canvas 路由副本");
    await user.click(screen.getByRole("button", { name: "保存新配置" }));
    await waitFor(() => expect(createAgentConfigPreset).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("menuitem", { name: /仅本次项目使用/ }));
    await waitFor(() => expect(createSavedResearchTask).toHaveBeenCalledTimes(1));

    for (const input of [
      vi.mocked(updateAgentConfigPreset).mock.calls[0]![1],
      vi.mocked(createAgentConfigPreset).mock.calls[0]![0],
      vi.mocked(createSavedResearchTask).mock.calls[0]![0]
    ]) {
      expect(input.agents.idea).toMatchObject({
        harness: "claude-code",
        gatewayId: canvasGateway.id,
        model: "route-model"
      });
    }
    expect(savedCopy).toBeDefined();

    view.unmount();
    vi.mocked(getSavedResearchTask).mockResolvedValue(savedCopy!);
    renderExpanded(
      <NewProjectPage
        onBack={vi.fn()}
        onCreated={vi.fn()}
        savedTaskId={savedCopy!.id}
      />
    );
    (await screen.findByRole("button", { name: "打开 Workflow 画布编辑器" })).focus();
    await user.keyboard("{Enter}");
    canvasDialog = await screen.findByRole("dialog", { name: "编辑 Workflow 画布" });
    await user.click(canvasDialog.querySelector('[data-node-id="idea"]')!);
    expect(within(canvasDialog).getByLabelText("idea Harness")).toHaveValue("claude-code");
    expect(within(canvasDialog).getByLabelText("idea全局网关")).toHaveValue(canvasGateway.id);
    expect(within(canvasDialog).getByLabelText("idea model")).toHaveValue("route-model");
  });

  it("shows the server reason for an unavailable Harness and blocks project submission", async () => {
    const unavailableAgents = structuredClone(defaultPresetAgents);
    unavailableAgents.main.harness = "dsh";
    vi.mocked(getAgentConfigPresets).mockResolvedValue([{
      ...defaultPreset,
      agents: unavailableAgents
    }]);
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["nex-agi/Nex-N2-Pro"],
      agentPrompts,
      harnesses: runtimeHarnesses.map((item) => item.id === "dsh"
        ? { ...item, available: false, availabilityReason: "项目内置 dsh 入口不可执行" }
        : item)
    });
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("项目名称"), "不可用 Harness 校验");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证服务端目录不可用原因会出现在字段旁并阻止项目提交。"
    );
    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]!.closest("article")!;
    const harnessSelect = within(mainCard).getByLabelText("Main Agent Harness");
    expect(within(harnessSelect).getByRole("option", { name: "dsh · 不可用" })).toBeDisabled();
    expect(within(mainCard).getByText("项目内置 dsh 入口不可执行")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "创建并启动研究" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建并启动研究" }));
    expect(screen.getByText(/启动前检查未通过：.*main：dsh 当前不可用/)).toBeVisible();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("shows and selects a newly cataloged fixture Harness without page-specific code", async () => {
    const fixtureHarness: HarnessCatalogEntry = {
      ...runtimeHarnesses[0]!,
      id: "fixture-harness",
      label: "Fixture Harness",
      adapterVersion: "test-1",
      default: true,
      notes: "Contract fixture adapter"
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["route-model"],
      harnesses: [fixtureHarness],
      defaultHarnessId: fixtureHarness.id,
      agentPrompts
    });

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]!.closest("article")!;
    const harnessSelect = within(mainCard).getByLabelText("Main Agent Harness");
    expect(within(harnessSelect).getByRole("option", { name: "Fixture Harness" })).toBeEnabled();
    expect(harnessSelect).toHaveValue("fixture-harness");
  });

  it("does not infer a proxy route for a historical Harness without Catalog protocol metadata", async () => {
    const historicalAgents = structuredClone(defaultPresetAgents);
    historicalAgents.main = {
      ...historicalAgents.main,
      harness: "retired-harness",
      gatewayId: runtimeGateway.id,
      model: runtimeGateway.defaultModel
    };
    vi.mocked(getAgentConfigPresets).mockResolvedValue([{
      ...defaultPreset,
      agents: historicalAgents
    }]);
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [runtimeGateway.defaultModel],
      gateways: [runtimeGateway],
      defaultGatewayId: runtimeGateway.id,
      harnesses: runtimeHarnesses,
      defaultHarnessId: "codex",
      agentPrompts
    });

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]!.closest("article")!;
    expect(await within(mainCard).findByText("Harness 目录待确认")).toBeVisible();
    expect(within(mainCard).queryByText("已根据所选 harness 和网关协议自动启用本地路由")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Main Agent Harness")).getByRole("option", {
      name: "retired-harness · 不可用"
    })).toBeDisabled();
  });

  it("derives every workflow configuration control from catalog purposes and capabilities", async () => {
    const limitedHarness: HarnessCatalogEntry = {
      ...runtimeHarnesses[0]!,
      id: "fixture-limited",
      label: "Fixture Limited",
      default: true,
      capabilities: {
        ...runtimeHarnesses[0]!.capabilities,
        permissionPrompts: ["workspace"],
        autoSkills: false,
        webSearch: false,
        mcp: false
      }
    };
    const noSkillsHarness: HarnessCatalogEntry = {
      ...runtimeHarnesses[0]!,
      id: "fixture-no-skills",
      label: "Fixture No Skills",
      capabilities: {
        ...runtimeHarnesses[0]!.capabilities,
        skills: false,
        autoSkills: false
      }
    };
    const explainerOnly: HarnessCatalogEntry = {
      ...runtimeHarnesses[0]!,
      id: "fixture-explainer-only",
      label: "Fixture Explainer Only",
      purposes: ["explainer"]
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [{
        id: "builtin:awesome-ai-research-writing-director",
        name: "Main Skill"
      }],
      models: ["route-model"],
      harnesses: [limitedHarness, noSkillsHarness, explainerOnly],
      defaultHarnessId: limitedHarness.id,
      agentPrompts
    });
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]!.closest("article")!;
    const harnessSelect = within(mainCard).getByLabelText("Main Agent Harness");
    await waitFor(() => {
      expect(harnessSelect).toHaveValue(limitedHarness.id);
      expect(within(harnessSelect).queryByRole("option", { name: "Fixture Explainer Only" })).not.toBeInTheDocument();
    });

    const permission = within(mainCard).getByLabelText("Main Agent运行权限");
    expect(permission).toHaveValue("workspace");
    expect(within(permission).getAllByRole("option")).toHaveLength(1);
    expect(within(mainCard).getByLabelText("Main Agent Web Search")).toBeDisabled();
    expect(within(mainCard).getByText("当前 Harness 不支持 Auto Skills，仅可固定加载")).toBeVisible();
    await user.click(within(mainCard).getByText(/已添加 1 项/));
    const skillMode = within(mainCard).getByLabelText(/Main Agent.*加载方式/);
    expect(within(skillMode).getByRole("option", { name: "自动选择" })).toBeDisabled();

    await user.click(within(mainCard).getByText("添加 MCP"));
    expect(within(mainCard).getByRole("button", { name: "添加新 MCP" })).toBeDisabled();
    expect(within(mainCard).getByText("当前 Harness 不支持 MCP")).toBeVisible();

    await user.selectOptions(harnessSelect, noSkillsHarness.id);
    expect(within(mainCard).getByText("当前 Harness 不支持 Skills")).toBeVisible();
    expect(within(mainCard).getByText("当前 Harness 不支持", { selector: "summary span" })).toBeVisible();
  });

  it("shows an exact gateway-combination failure but allows starting", async () => {
    const failedGateway: GatewayRecord = {
      ...runtimeGateway,
      models: ["route-model"],
      defaultModel: "route-model",
      test: {
        status: "failed",
        protocol: "responses",
        model: "route-model",
        error: "上游返回 HTTP 429",
        harness: "codex",
        nativeProtocol: "responses",
        routeMode: "direct",
        probeKind: "route"
      },
      tests: [{
        status: "failed",
        protocol: "responses",
        model: "route-model",
        error: "上游返回 HTTP 429",
        harness: "codex",
        nativeProtocol: "responses",
        routeMode: "direct",
        probeKind: "route"
      }]
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["route-model"],
      gateways: [failedGateway],
      defaultGatewayId: failedGateway.id,
      harnesses: runtimeHarnesses,
      agentPrompts
    });
    vi.mocked(createProject).mockResolvedValue({ id: "prj_failed_probe_allowed" } as Project);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={onCreated} />);

    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]!.closest("article")!;
    expect(within(mainCard).getByText(
      "当前 Harness / 网关 / model 组合验证失败：上游返回 HTTP 429；仍可启动，但运行可能失败。"
    )).toHaveAttribute("role", "alert");
    expect(within(within(mainCard).getByLabelText("Main Agent模型")).getByRole("option", {
      name: "route-model · 验证失败"
    })).not.toBeDisabled();
    expect(within(within(mainCard).getByLabelText("Main Agent全局网关")).getByRole("option", {
      name: "Responses 验收网关 · 连接验证失败"
    })).not.toBeDisabled();
    expect(within(mainCard).getByText(/以下 model 验证失败，仍可选择并启动：route-model.*HTTP 429/)).toBeVisible();
    expect(screen.getByText("网关连接验证未通过，允许启动")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "连接验证失败也可启动");
    await user.type(screen.getByRole("textbox", { name: "课题方向与具体要求" }), "允许尝试启动，让实际运行结果决定后续处理。");
    const start = screen.getByRole("button", { name: "创建并启动研究" });
    expect(start).not.toBeDisabled();
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith("prj_failed_probe_allowed");
  });

  it("tests an Agent's exact Harness, gateway and model combination inline", async () => {
    const untestedGateway: GatewayRecord = {
      ...runtimeGateway,
      models: ["route-model"],
      defaultModel: "route-model",
      test: {
        status: "untested",
        protocol: "responses",
        model: "route-model"
      },
      tests: []
    };
    const passedTest: GatewayRecord["test"] = {
      status: "passed",
      protocol: "responses",
      model: "route-model",
      harness: "codex",
      nativeProtocol: "responses",
      routeMode: "direct",
      probeKind: "adapter-smoke",
      cacheKey: "codex-route-model",
      adapterVersion: "1",
      executableFingerprint: "fixture-codex",
      gatewayRevision: 1,
      routerCompatibilityVersion: "1",
      testedAt: "2026-09-17T08:30:00.000Z"
    };
    const passedRoute: GatewayRecord["test"] = {
      status: "passed",
      protocol: "responses",
      model: "route-model",
      harness: "codex",
      nativeProtocol: "responses",
      routeMode: "direct",
      probeKind: "route",
      testedAt: "2026-09-17T08:29:59.000Z"
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["route-model"],
      gateways: [untestedGateway],
      defaultGatewayId: untestedGateway.id,
      harnesses: runtimeHarnesses,
      agentPrompts
    });
    vi.mocked(testGateway).mockResolvedValue({
      ...untestedGateway,
      test: passedTest,
      tests: [passedRoute, passedTest]
    });
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]!.closest("article")!;
    expect(within(mainCard).getByText(
      "当前 Harness / 网关 / model 组合尚未验证；仍可启动，但运行可能失败。"
    )).toHaveAttribute("role", "alert");

    const testButton = within(mainCard).getByRole("button", { name: "测试Main Agent连通性" });
    expect(testButton.closest(".agent-config-head")).not.toBeNull();
    expect(testButton.closest(".agent-gateway-route-field")).toBeNull();
    await user.click(testButton);

    await waitFor(() => expect(testGateway).toHaveBeenCalledWith(
      untestedGateway.id,
      "route-model",
      "codex"
    ));
    await waitFor(() => expect(within(mainCard).queryByText(
      "当前 Harness / 网关 / model 组合尚未验证；仍可启动，但运行可能失败。"
    )).not.toBeInTheDocument());
    expect(within(mainCard).getByRole("button", { name: "测试Main Agent连通性" })).toHaveTextContent("已通过，重新测试");
  });

  it("uses the model-level Gateway reasoning option as the sole workflow control", async () => {
    const configuredGateway: GatewayRecord = {
      ...runtimeGateway,
      modelReasoning: {
        "route-model": {
          parameter: "chat_template_kwargs.reasoning_effort",
          options: [
            { id: "low", label: "低", value: "low" },
            { id: "high", label: "高", value: "high" }
          ]
        }
      }
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [...RUNTIME_MODELS],
      gateways: [configuredGateway],
      defaultGatewayId: configuredGateway.id,
      harnesses: runtimeHarnesses,
      defaultHarnessId: "codex",
      agentPrompts
    });
    vi.mocked(testGateway).mockResolvedValue(configuredGateway);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]!.closest("article")!;
    await user.selectOptions(within(mainCard).getByLabelText("Main Agent模型"), "route-model");
    const gatewayEffort = within(mainCard).getByLabelText("Main Agent网关思考强度");
    expect(gatewayEffort).toHaveValue("");
    expect(within(mainCard).queryByLabelText("Main Agent思考深度")).not.toBeInTheDocument();
    await user.selectOptions(gatewayEffort, "high");
    await user.click(within(mainCard).getByRole("button", { name: "测试Main Agent连通性" }));

    await waitFor(() => expect(testGateway).toHaveBeenCalledWith(
      configuredGateway.id,
      "route-model",
      "codex",
      { gatewayReasoningOption: "high" }
    ));
    expect(gatewayEffort).toHaveValue("high");
  });

  it("applies the catalog default gateway after loading the default preset", async () => {
    const defaultOnlyGateway: GatewayRecord = {
      ...runtimeGateway,
      models: ["route-model"],
      defaultModel: "route-model",
      tests: runtimeGateway.tests?.filter((test) => test.model === "route-model")
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["route-model"],
      gateways: [defaultOnlyGateway],
      defaultGatewayId: defaultOnlyGateway.id,
      harnesses: runtimeHarnesses,
      agentPrompts
    });
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Main Agent全局网关")).toHaveValue(defaultOnlyGateway.id);
      expect(screen.getByLabelText("Main Agent模型")).toHaveValue("route-model");
      expect(screen.getByLabelText("构思智能体全局网关")).toHaveValue(defaultOnlyGateway.id);
    });
  });

  it("keeps gateway credentials and editing outside the new-project form", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["route-model"],
      gateways: [{ ...runtimeGateway, builtin: true }],
      defaultGatewayId: runtimeGateway.id,
      harnesses: runtimeHarnesses,
      agentPrompts
    });
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    expect(await screen.findByText("系统预置")).toBeInTheDocument();
    expect(screen.queryByLabelText("网关 API key")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "管理网关库" })).toHaveAttribute("href", "#/gateways");
  });

  it("shows shared gateway references while keeping management at the application level", async () => {
    const fallbackGateway: GatewayRecord = {
      ...runtimeGateway,
      id: "gwy_fedcba9876543210fedcba9876543210",
      name: "备用网关",
      builtin: false
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["route-model"],
      gateways: [{ ...runtimeGateway, name: "系统 AIGW", builtin: true }, fallbackGateway],
      defaultGatewayId: runtimeGateway.id,
      harnesses: runtimeHarnesses,
      agentPrompts
    });
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    expect(await screen.findByText("系统 AIGW")).toBeInTheDocument();
    expect(screen.getAllByText("备用网关")[0]).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "管理网关库" })).toBeInTheDocument();
  });

  it("shows all three permissions and keeps Main editable with a YOLO default", async () => {
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const mainPermission = await screen.findByLabelText("Main Agent运行权限");
    expect(mainPermission).toHaveValue("yolo");
    expect(
      within(mainPermission).getByRole("option", { name: "当前任务工作区" })
    ).toBeInTheDocument();
    expect(
      within(mainPermission).getByRole("option", { name: "项目内工作区" })
    ).toBeInTheDocument();
    expect(
      within(mainPermission).getByRole("option", { name: "原生完全访问" })
    ).toBeInTheDocument();
    await user.selectOptions(mainPermission, "workspace");
    expect(mainPermission).toHaveValue("workspace");
    await user.selectOptions(mainPermission, "compute");
    expect(mainPermission).toHaveValue("compute");
    await user.selectOptions(mainPermission, "yolo");
    expect(mainPermission).toHaveValue("yolo");

    const executionPermission = screen.getByLabelText("执行智能体运行权限");
    expect(executionPermission).toHaveValue("compute");
    await user.selectOptions(executionPermission, "yolo");
    expect(executionPermission).toHaveValue("yolo");
    expect(
      screen.getAllByText(/使用所选 Harness 的原生权限模式，实际访问受操作系统和当前调用条件约束/).length
    ).toBeGreaterThan(0);
  });

  it("adds a skill in fixed or automatic-selection mode", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [
        {
          id: "builtin:optional-analysis",
          name: "optional-analysis",
          description: "Load only when analysis is needed"
        }
      ],
      models: ["gpt-5.6-sol"],
      gateways: [runtimeGateway],
      defaultGatewayId: runtimeGateway.id,
      harnesses: runtimeHarnesses,
      defaultHarnessId: "codex",
      agentPrompts
    });
    vi.mocked(createProject).mockResolvedValue({ id: "prj_skill_mode" } as Project);
    const user = userEvent.setup();

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("项目名称"), "Skill 加载模式验证");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证智能体可以自动选择新添加的科研 Skill。"
    );
    const ideaCard = (await screen.findByRole("heading", { name: "构思智能体" })).closest("article");
    expect(ideaCard).not.toBeNull();
    await user.click(within(ideaCard!).getByText(/已添加 \d+ 项/));
    await user.click(
      within(ideaCard!).getByRole("checkbox", { name: /optional-analysis/ })
    );
    await user.selectOptions(
      within(ideaCard!).getByLabelText("构思智能体optional-analysis加载方式"),
      "auto"
    );
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createProject).mock.calls[0][0];
    expect(input.agents.idea.skills).toEqual([
      "builtin:ccf-idea-optimizer",
      "builtin:ccf-idea-reviewer",
      "builtin:ccf-literature-monitor",
      "builtin:ccf-literature-searcher",
      "builtin:ccf-experiment-designer"
    ]);
    expect(input.agents.idea.autoSkills).toEqual(["builtin:optional-analysis"]);
  });

  it("shares explicit SII choices between text and canvas and saves them without changing permissions", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "prj_explicit_sii" } as Project);
    const user = userEvent.setup();
    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText("项目名称"), "独立实验工具选择");
    await user.type(screen.getByLabelText("课题方向与具体要求"), "实验 Worker 按任务执行，其他 Agent 不分配实验工具。");
    const selected = await screen.findByRole("checkbox", { name: "execution SII 实验工具" });
    expect(selected).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "main SII 实验工具" })).not.toBeInTheDocument();
    await user.click(selected);
    await user.click(screen.getByRole("button", { name: "打开 Workflow 画布编辑器" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 Workflow 画布" });
    await user.click(dialog.querySelector('[data-node-id="execution"]')!);
    const canvasChoice = within(dialog).getByRole("checkbox", { name: "execution SII 实验工具" });
    expect(canvasChoice).toBeChecked();
    await user.click(canvasChoice);
    await user.click(within(dialog).getAllByRole("button", { name: "关闭 Workflow 编辑器" })[0]!);
    const restored = screen.getByRole("checkbox", { name: "execution SII 实验工具" });
    expect(restored).not.toBeChecked();
    await user.click(restored);
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createProject).mock.calls[0]![0];
    expect(input.agents.execution).toMatchObject({ experimentMcp: true, permission: defaultPresetAgents.execution.permission });
    expect(input.agents.writing.experimentMcp).not.toBe(true);
    expect(input.agents.main.experimentMcp).not.toBe(true);
  });

  it("opens a title-and-content dialog, saves SKILL.md, and adds the candidate", async () => {
    const customSkill = {
      id: "external:user:evidence-audit-a1b2c3",
      name: "证据一致性检查",
      description: "Audit user-supplied evidence"
    };
    vi.mocked(createUserSkill).mockResolvedValue(customSkill);
    const user = userEvent.setup();

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const ideaCard = (await screen.findByRole("heading", { name: "构思智能体" })).closest("article");
    expect(ideaCard).not.toBeNull();
    await user.click(within(ideaCard!).getByText(/已添加 \d+ 项/));
    await user.click(
      within(ideaCard!).getByRole("button", { name: /添加新 Skill/ })
    );
    expect(
      screen.getByRole("dialog", { name: "为构思智能体创建新 Skill" })
    ).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Skill 标题"),
      "证据一致性检查"
    );
    await user.type(
      screen.getByLabelText("Skill 内容"),
      "Audit user-supplied evidence before writing claims."
    );
    await user.click(
      screen.getByRole("button", { name: "保存 Skill" })
    );

    await waitFor(() =>
      expect(createUserSkill).toHaveBeenCalledWith(
        "证据一致性检查",
        "Audit user-supplied evidence before writing claims."
      )
    );
    const checkbox = await within(ideaCard!).findByRole("checkbox", {
      name: /证据一致性检查/
    });
    expect(checkbox).not.toBeChecked();
    expect(ideaCard).toHaveTextContent(
      "证据一致性检查 已保存并加入候选，请勾选后设置加载方式。"
    );
  });

  it("adds a named MCP URL to one Agent and submits it with the project", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "prj_mcp" } as Project);
    const user = userEvent.setup();

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const ideaCard = (await screen.findByRole("heading", { name: "构思智能体" })).closest("article");
    expect(ideaCard).not.toBeNull();
    await user.click(within(ideaCard!).getByText("添加 MCP"));
    await user.click(
      within(ideaCard!).getByRole("button", { name: "添加新 MCP" })
    );
    const dialog = screen.getByRole("dialog", {
      name: "为构思智能体添加 MCP"
    });
    await user.type(within(dialog).getByLabelText("MCP 名称"), "research-docs");
    await user.type(
      within(dialog).getByLabelText("MCP URL"),
      "https://docs.example.test/mcp"
    );
    await user.click(within(dialog).getByRole("button", { name: "添加 MCP" }));

    expect(
      await within(ideaCard!).findByRole("checkbox", { name: /research-docs/ })
    ).toBeChecked();
    await user.type(screen.getByLabelText("项目名称"), "MCP 配置验证");
    await user.type(
      screen.getByLabelText("课题方向与具体要求"),
      "验证构思智能体能够连接用户配置的远程 MCP 服务。"
    );
    await user.click(screen.getByRole("button", { name: "创建并启动研究" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(createProject).mock.calls[0][0].agents.idea.mcpServers
    ).toEqual([
      { name: "research-docs", url: "https://docs.example.test/mcp" }
    ]);
    expect(
      vi.mocked(createProject).mock.calls[0][0].agents.main.mcpServers
    ).toEqual([]);
  });

  it("hides every lark-prefixed skill from the new-project candidates", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [
        {
          id: "builtin:experiment-runner",
          name: "experiment-runner"
        },
        {
          id: "external:catalog:lark-doc",
          name: "lark-doc"
        },
        {
          id: "external:catalog:lark-hidden",
          name: "飞书隐藏技能"
        },
        {
          id: "external:catalog:other-skill",
          name: "LARK-visible-name"
        }
      ],
      models: ["gpt-5.6-sol"],
      agentPrompts
    });
    const user = userEvent.setup();

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getAllByText("experiment-runner").length).toBeGreaterThan(0)
    );
    expect(screen.queryByText("lark-doc")).not.toBeInTheDocument();
    expect(screen.queryByText("飞书隐藏技能")).not.toBeInTheDocument();
    expect(screen.queryByText("LARK-visible-name")).not.toBeInTheDocument();

    const ideaCard = screen.getByRole("heading", { name: "构思智能体" }).closest("article");
    expect(ideaCard).not.toBeNull();
    await user.click(within(ideaCard!).getByText(/已添加 \d+ 项/));
    await user.click(
      within(ideaCard!).getByRole("button", { name: /添加新 Skill/ })
    );
    await user.type(
      screen.getByLabelText("Skill 标题"),
      "lark-input"
    );
    await user.type(screen.getByLabelText("Skill 内容"), "Hidden integration");
    await user.click(
      screen.getByRole("button", { name: "保存 Skill" })
    );
    expect(
      await screen.findByText(
        "Lark Skills 不在科研 Agent 的候选范围内"
      )
    ).toBeInTheDocument();
    expect(createUserSkill).not.toHaveBeenCalled();
    expect(
      within(ideaCard!).queryByRole("checkbox", { name: /lark-input/ })
    ).not.toBeInTheDocument();
  });

  it("shows the default Writing skill as an editable fixed skill", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [
        {
          id: "builtin:nature-writing",
          name: "nature-writing",
          description: "Scientific manuscript structure"
        }
      ],
      models: ["gpt-5.6-sol"],
      agentPrompts
    });

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const writingCard = (await screen.findByRole("heading", { name: "写作智能体" })).closest(
      "article"
    );
    expect(writingCard).not.toBeNull();
    const checkbox = within(writingCard!).getByRole("checkbox", {
      name: /nature-writing/
    });
    expect(checkbox).toBeChecked();
    expect(checkbox).not.toBeDisabled();
    expect(
      within(writingCard!).getByLabelText("写作智能体nature-writing加载方式")
    ).toHaveValue("fixed");
  });

  it("shows Main as a public Agent with its configured Skill editable", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [
        {
          id: "builtin:awesome-ai-research-writing-director",
          name: "awesome-ai-research-writing-director",
          description: "Frame evidence-grounded Writing assignments"
        }
      ],
      models: ["gpt-5.6-sol"],
      agentPrompts
    });

    renderExpanded(<NewProjectPage onBack={vi.fn()} onCreated={vi.fn()} />);

    const mainCard = (await screen.findAllByRole("heading", { name: "Main Agent" }))[0]?.closest("article");
    const writingCard = screen.getByRole("heading", { name: "写作智能体" }).closest("article");
    expect(mainCard).not.toBeNull();
    expect(writingCard).not.toBeNull();
    const checkbox = within(mainCard!).getByRole("checkbox", {
      name: /awesome-ai-research-writing-director/
    });
    expect(checkbox).toBeChecked();
    expect(checkbox).not.toBeDisabled();
    expect(
      within(writingCard!).getByRole("checkbox", {
        name: /awesome-ai-research-writing-director/
      })
    ).not.toBeChecked();
  });
});
