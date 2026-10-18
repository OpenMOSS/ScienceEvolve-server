import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveProjects,
  createSavedResearchTask,
  createProject,
  createAgentConfigPreset,
  deleteAgentConfigPreset,
  deleteArchivedProject,
  deleteArchivedProjects,
  deleteSavedResearchTask,
  downloadAgentConfigPreset,
  downloadWorkflowSource,
  importAgentConfigPreset,
  getAgentConfigPresets,
  getCatalog,
  getGitHubAccounts,
  getProjects,
  getQueue,
  getSavedResearchTasks,
  projectAction,
  saveProjectAgentConfigPreset,
  updateAgentConfigPreset
} from "../api";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS } from "../lib";
import { addScopedGroup, upgradeLegacyGroups } from "../components/workflow-canvas/core/scoped-workflow";
import type {
  AgentConfigPreset,
  GitHubAccountRecord,
  GatewayRecord,
  Project,
  ProjectStatus,
  QueueSnapshot,
  SavedResearchTask
} from "../types";
import { classifyProjectStatus, ProjectListPage } from "./ProjectListPage";
import { cacheProjectOverview, readCachedProjectOverview } from "../project-overview-cache";
import {
  cacheProjectList,
  clearProjectListMemoryCache,
  readCachedProjectList
} from "../project-list-cache";

vi.mock("../api", () => ({
  archiveProjects: vi.fn(),
  createProject: vi.fn(),
  createSavedResearchTask: vi.fn(),
  createAgentConfigPreset: vi.fn(),
  deleteAgentConfigPreset: vi.fn(),
  deleteArchivedProject: vi.fn(),
  deleteArchivedProjects: vi.fn(),
  deleteSavedResearchTask: vi.fn(),
  downloadAgentConfigPreset: vi.fn(),
  downloadWorkflowSource: vi.fn(),
  importAgentConfigPreset: vi.fn(),
  getAgentConfigPresets: vi.fn(),
  getCatalog: vi.fn(),
  getGitHubAccounts: vi.fn(),
  getProjects: vi.fn(),
  getQueue: vi.fn(),
  getSavedResearchTasks: vi.fn(),
  projectAction: vi.fn(),
  saveProjectAgentConfigPreset: vi.fn(),
  updateAgentConfigPreset: vi.fn()
}));

const defaultPreset: AgentConfigPreset = {
  schemaVersion: 2,
  kind: "scienceevolve-agent-config-preset",
  id: "default",
  name: "系统默认配置",
  builtin: true,
  agents: DEFAULT_AGENTS,
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
};

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
  updatedAt: "2026-09-24T00:00:00.000Z"
};
const RUNTIME_MODELS = ["nex-agi/Nex-N2-Pro", "gpt-5.6-terra"] as const;

const defaultAgentsWithCatalogHarness = Object.fromEntries(
  Object.entries(DEFAULT_AGENTS).map(([role, config]) => [
    role,
    { ...config, harness: "codex", gatewayId: RUNTIME_GATEWAY_ID }
  ])
) as typeof DEFAULT_AGENTS;

const runtimeGateway: GatewayRecord = {
  id: RUNTIME_GATEWAY_ID,
  name: "Responses 验收网关",
  url: "https://gateway.example.test/v1",
  models: [...RUNTIME_MODELS],
  defaultModel: "nex-agi/Nex-N2-Pro",
  protocol: "responses",
  revision: 1,
  apiKeyConfigured: true,
  test: {
    status: "passed",
    protocol: "responses",
    model: "nex-agi/Nex-N2-Pro",
    harness: "codex",
    nativeProtocol: "responses",
    routeMode: "direct",
    probeKind: "adapter-smoke",
    cacheKey: "codex-nex-agi/Nex-N2-Pro",
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

const project: Project = {
  id: "prj_waiting",
  title: "长文本推理研究",
  requirement: "验证稀疏注意力在长文本推理任务上的效率与质量。",
  status: "retrying",
  phase: "execution:retrying",
  queuedAgent: "execution",
  turn: 4,
  cycle: 2,
  queuePosition: 2,
  queueDepth: 3,
  agentProgress: {
    main: { state: "completed", runs: 2 },
    idea: { state: "completed", runs: 1 },
    execution: { state: "retrying", runs: 1, queuePosition: 2 },
    writing: { state: "waiting", runs: 0 },
    review: { state: "waiting", runs: 0 }
  },
  overallProgress: {
    percent: 42,
    label: "执行智能体等待重试",
    estimated: true,
    successfulCalls: 15
  },
  tokenUsage: {
    inputTokens: 100_000,
    cachedInputTokens: 25_000,
    outputTokens: 23_456,
    totalTokens: 123_456,
    invocations: 7,
    updatedAt: "2026-07-31T03:10:00.000Z",
    byAgent: {
      idea: { inputTokens: 10_000, cachedInputTokens: 2_000, outputTokens: 2_000, totalTokens: 12_000, invocations: 1 },
      main: { inputTokens: 20_000, cachedInputTokens: 5_000, outputTokens: 4_000, totalTokens: 24_000, invocations: 2 },
      execution: { inputTokens: 70_000, cachedInputTokens: 18_000, outputTokens: 17_456, totalTokens: 87_456, invocations: 4 },
      writing: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, invocations: 0 },
      review: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, invocations: 0 }
    }
  },
  agents: DEFAULT_AGENTS,
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
};

const queue: QueueSnapshot = {
  main: { capacity: 10, activeProjectIds: [], queued: [] },
  worker: {
    capacity: 10,
    activeProjectIds: ["prj_active"],
    queued: [
      {
        projectId: "prj_waiting",
        position: 2,
        enteredAt: "2026-07-31T03:00:00.000Z"
      }
    ]
  }
};

describe("ProjectListPage task overview", () => {
  beforeEach(() => {
    localStorage.clear();
    clearProjectListMemoryCache();
    vi.mocked(getProjects).mockReset().mockResolvedValue([project]);
    vi.mocked(getQueue).mockReset().mockResolvedValue(queue);
    vi.mocked(getAgentConfigPresets)
      .mockReset()
      .mockResolvedValue([defaultPreset]);
    vi.mocked(getCatalog).mockReset().mockResolvedValue({
      skills: [],
      models: ["nex-agi/Nex-N2-Pro"],
      agentPrompts: {},
      gateways: [runtimeGateway],
      defaultGatewayId: runtimeGateway.id,
      harnesses: [
        {
          id: "codex",
          label: "Codex",
          adapterVersion: "1",
          nativeProtocol: "responses",
          purposes: ["workflow", "explainer", "probe"],
          mode: "workflow",
          notes: "OpenFARS Codex Runner",
          capabilities: {
            durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
            readOnlyExplainer: true, webSearch: true, skills: true, mcp: true
          },
          available: true
        }
      ]
    });
    vi.mocked(getGitHubAccounts).mockReset().mockResolvedValue({
      accounts: [githubAccount],
      defaultAccountId: GITHUB_ACCOUNT_ID,
      oauthConfigured: true
    });
    vi.mocked(createProject).mockReset();
    vi.mocked(createSavedResearchTask).mockReset();
    vi.mocked(createAgentConfigPreset).mockReset();
    vi.mocked(projectAction).mockReset().mockResolvedValue(undefined);
    vi.mocked(archiveProjects).mockReset();
    vi.mocked(deleteArchivedProject).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteArchivedProjects).mockReset();
    vi.mocked(saveProjectAgentConfigPreset).mockReset();
    vi.mocked(deleteAgentConfigPreset).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteSavedResearchTask).mockReset().mockResolvedValue(undefined);
    vi.mocked(getSavedResearchTasks).mockReset().mockResolvedValue([]);
    vi.mocked(downloadAgentConfigPreset).mockReset();
    vi.mocked(downloadWorkflowSource).mockReset();
    vi.mocked(importAgentConfigPreset).mockReset();
    vi.mocked(updateAgentConfigPreset).mockReset();
  });

  it("shows cached project cards immediately on re-entry while refreshing in the background", async () => {
    const first = render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("heading", { name: project.title });
    expect(screen.queryByRole("heading", { name: "从一个例子开始" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 SDK workflow.json" })).toBeVisible();
    await waitFor(() => expect(readCachedProjectList()?.projects).toHaveLength(1));
    first.unmount();

    let resolveProjects!: (projects: Project[]) => void;
    let resolveQueue!: (snapshot: QueueSnapshot) => void;
    vi.mocked(getProjects).mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve; }));
    vi.mocked(getQueue).mockImplementationOnce(() => new Promise((resolve) => { resolveQueue = resolve; }));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(screen.getByRole("heading", { name: project.title })).toBeVisible();
    expect(screen.queryByText("正在整理科研项目…")).not.toBeInTheDocument();
    const updated = { ...project, title: "最新项目状态", status: "completed" as const };
    await act(async () => resolveProjects([updated]));
    expect(screen.getByRole("heading", { name: updated.title })).toBeVisible();
    expect(screen.queryByRole("heading", { name: project.title })).not.toBeInTheDocument();
    expect(readCachedProjectList()?.projects[0].status).toBe("completed");
    await act(async () => resolveQueue(queue));
  });

  it("restores persisted cards after the in-memory cache is cleared and replaces them with an empty response", async () => {
    cacheProjectList([project], Date.now());
    clearProjectListMemoryCache();
    let resolveProjects!: (projects: Project[]) => void;
    vi.mocked(getProjects).mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve; }));
    const first = render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(screen.getByRole("heading", { name: project.title })).toBeVisible();
    expect(screen.queryByText("正在整理科研项目…")).not.toBeInTheDocument();
    await act(async () => resolveProjects([]));
    expect(screen.queryByRole("heading", { name: project.title })).not.toBeInTheDocument();
    expect(readCachedProjectList()?.projects).toEqual([]);
    first.unmount();

    vi.mocked(getProjects).mockImplementationOnce(() => new Promise(() => {}));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByText("正在整理科研项目…")).not.toBeInTheDocument();
    expect(screen.getByLabelText("项目统计").querySelector("strong")).toHaveTextContent("0");
  });

  it("retains cached cards when the background refresh fails", async () => {
    cacheProjectList([project], Date.now());
    vi.mocked(getProjects).mockRejectedValueOnce(new Error("后台刷新暂不可用"));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(screen.getByRole("heading", { name: project.title })).toBeVisible();
    await screen.findByText(/后台刷新暂不可用/);
    expect(screen.getByRole("heading", { name: project.title })).toBeVisible();
    expect(readCachedProjectList()?.projects[0].id).toBe(project.id);
  });

  it("shows the backend's retained Git recovery reason instead of an idle resource queue", async () => {
    const reason = "等待恢复：opportunity 的 Git 操作结果待确认";
    vi.mocked(getProjects).mockResolvedValue([{ ...project, status: "queued", currentAgent: undefined, queuedAgent: undefined,
      runtime: { stateRevision: 3, status: "queued", phase: "collaboration:scoped-recovery-waiting", executionCount: 2, activities: [],
        waiting: { kind: "recovery", reason, agentId: "opportunity", executionId: "exec-a", operationId: "original-push" } } }]);
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: project.title });
    const card = within(heading.closest("article")!);
    expect(card.getByText("等待恢复")).toBeVisible();
    expect(card.getByText(reason)).toBeVisible();
    expect(card.queryByText("排队中")).not.toBeInTheDocument();
    expect(card.queryByText("等待资源")).not.toBeInTheDocument();
  });

  it("shows the first project response without waiting for the queue", async () => {
    let resolveQueue!: (snapshot: QueueSnapshot) => void;
    vi.mocked(getQueue).mockImplementationOnce(() => new Promise((resolve) => { resolveQueue = resolve; }));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: project.title })).toBeVisible();
    expect(screen.queryByText("正在整理科研项目…")).not.toBeInTheDocument();
    await act(async () => resolveQueue(queue));
  });

  it("ignores an old page's response after a newer page has refreshed the cache", async () => {
    let resolveOldProjects!: (projects: Project[]) => void;
    vi.mocked(getProjects).mockImplementationOnce(() => new Promise((resolve) => { resolveOldProjects = resolve; }));
    const first = render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    first.unmount();

    const updated = { ...project, title: "新页面返回的项目" };
    vi.mocked(getProjects).mockResolvedValueOnce([updated]);
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("heading", { name: updated.title });
    await act(async () => resolveOldProjects([project]));

    expect(screen.getByRole("heading", { name: updated.title })).toBeVisible();
    expect(readCachedProjectList()?.projects[0].title).toBe(updated.title);
  });

  it("does not restore deleted cached projects from a refresh started before deletion", async () => {
    const archived = { ...project, status: "cancelled" as const, archivedAt: "2026-10-12T00:00:00.000Z" };
    cacheProjectList([archived], Date.now());
    let resolveProjects!: (projects: Project[]) => void;
    vi.mocked(getProjects).mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve; }));
    vi.mocked(deleteArchivedProjects).mockResolvedValue({ successCount: 1, failureCount: 0,
      results: [{ projectId: archived.id, ok: true }] });
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "已归档（1）" }));
    await user.click(screen.getByRole("button", { name: "批量管理" }));
    await user.click(screen.getByRole("checkbox", { name: `选择项目 ${archived.title}` }));
    await user.click(screen.getByRole("button", { name: "永久删除所选" }));
    await user.type(screen.getByRole("textbox", { name: "批量删除确认词" }), "永久删除");
    await user.click(screen.getByRole("button", { name: "永久删除" }));
    await screen.findByText("永久删除完成：成功 1 个，失败 0 个。");
    await act(async () => resolveProjects([archived]));

    expect(screen.queryByRole("heading", { name: archived.title })).not.toBeInTheDocument();
    expect(readCachedProjectList()?.projects).toEqual([]);
  });

  it("refreshes projects independently while a queue request remains pending", async () => {
    let resolveQueue!: (snapshot: QueueSnapshot) => void;
    vi.mocked(getQueue).mockImplementationOnce(() => new Promise((resolve) => { resolveQueue = resolve; }));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("heading", { name: project.title });
    const updated = { ...project, title: "队列等待期间更新的项目" };
    vi.mocked(getProjects).mockResolvedValueOnce([updated]);
    fireEvent(document, new Event("visibilitychange"));

    expect(await screen.findByRole("heading", { name: updated.title })).toBeVisible();
    expect(getQueue).toHaveBeenCalledTimes(1);
    await act(async () => resolveQueue(queue));
  });

  it("does not let a pending action on an unmounted page overwrite a newer cached snapshot", async () => {
    const cancelled = { ...project, status: "cancelled" as const, phase: "cancelled" };
    vi.mocked(getProjects).mockResolvedValueOnce([cancelled]);
    let resolveAction!: () => void;
    vi.mocked(projectAction).mockImplementationOnce(() => new Promise((resolve) => { resolveAction = resolve; }));
    const user = userEvent.setup();
    const first = render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("heading", { name: cancelled.title });
    await user.click(screen.getByRole("button", { name: "归档项目" }));
    first.unmount();

    const updated = { ...cancelled, title: "重新进入后的新快照" };
    vi.mocked(getProjects).mockResolvedValueOnce([updated]);
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("heading", { name: updated.title });
    await act(async () => resolveAction());

    expect(readCachedProjectList()?.projects[0].title).toBe(updated.title);
    expect(getProjects).toHaveBeenCalledTimes(2);
  });

  it("restores saved counts before refresh finishes and replaces them with a real empty result", async () => {
    const first = render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByLabelText("正在推进 1");
    await waitFor(() => expect(readCachedProjectOverview()?.total).toBe(1));
    first.unmount();

    let resolveProjects!: (projects: Project[]) => void;
    vi.mocked(getProjects).mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve; }));
    const second = render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    const summary = screen.getByLabelText("项目统计");
    expect(summary.querySelector("strong")).toHaveTextContent("1");
    expect(screen.getByLabelText("正在推进 1")).toBeInTheDocument();
    expect(summary).toHaveAttribute("aria-busy", "true");
    await act(async () => resolveProjects([]));
    expect(summary.querySelector("strong")).toHaveTextContent("0");
    expect(summary).toHaveAttribute("aria-busy", "false");
    expect(readCachedProjectOverview()?.total).toBe(0);
    second.unmount();

    vi.mocked(getProjects).mockImplementationOnce(() => new Promise(() => {}));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByLabelText("项目统计").querySelector("strong")).toHaveTextContent("0");
  });

  it("retains cached statistics when the initial refresh fails", async () => {
    cacheProjectOverview({ total: 7, archived: 2, totalCycles: 13,
      statusCounts: { active: 2, attention: 3, stopping: 1, terminal: 1 } });
    vi.mocked(getProjects).mockRejectedValueOnce(new Error("项目服务暂不可用"));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByText("项目服务暂不可用");
    expect(screen.getByLabelText("项目统计").querySelector("strong")).toHaveTextContent("7");
    expect(screen.getByLabelText("正在推进 2")).toBeInTheDocument();
    expect(readCachedProjectOverview()?.total).toBe(7);
  });

  it("shows unknown counts instead of false zeroes before the first successful response", async () => {
    let resolveProjects!: (projects: Project[]) => void;
    vi.mocked(getProjects).mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve; }));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    const summary = screen.getByLabelText("项目统计");
    expect(Array.from(summary.querySelectorAll("strong"), (element) => element.textContent)).toEqual(Array(6).fill("—"));
    await act(async () => resolveProjects([project]));
    expect(summary.querySelector("strong")).toHaveTextContent("1");
  });

  it("classifies every project status into one list category", () => {
    const statuses: Record<ProjectStatus, ReturnType<typeof classifyProjectStatus>> = {
      draft: "attention",
      queued: "active",
      running: "active",
      retrying: "active",
      interrupting: "stopping",
      interrupted: "attention",
      pausing: "stopping",
      paused: "attention",
      cancelling: "stopping",
      cancelled: "terminal",
      stopping: "stopping",
      stopped: "terminal",
      completed: "terminal",
      failed: "terminal"
    };

    for (const [status, category] of Object.entries(statuses)) {
      expect(classifyProjectStatus(status as ProjectStatus)).toBe(category);
    }
  });

  it("counts paused projects as attention and keeps them out of the active filter", async () => {
    const pausedProjects = Array.from({ length: 14 }, (_, index): Project => ({
      ...project,
      id: `prj_paused_${String(index).padStart(2, "0")}`,
      title: `暂停项目 ${index + 1}`,
      status: "paused",
      phase: "paused",
      currentAgent: undefined,
      queuedAgent: "execution",
      queuePosition: undefined,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()
    }));
    vi.mocked(getProjects).mockResolvedValue(pausedProjects);
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(await screen.findByLabelText("正在推进 0")).toBeVisible();
    expect(screen.getByLabelText("待处理 14")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "进行中" }));
    expect(await screen.findByText("没有正在推进的项目")).toBeVisible();
    expect(screen.queryByText(pausedProjects[13].title)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "待处理" }));
    const pausedTitle = await screen.findByText(pausedProjects[13].title);
    expect(pausedTitle.closest("article")).toHaveAttribute(
      "data-status-category",
      "attention"
    );
    expect(screen.queryByText("没有正在推进的项目")).not.toBeInTheDocument();
  });

  it("restores the quick task text when the page remounts", async () => {
    function DraftHost() {
      const [requirement, setRequirement] = useState("");
      const [visible, setVisible] = useState(true);
      return <>
        <button onClick={() => setVisible((current) => !current)}>切换页面</button>
        {visible && <ProjectListPage
          onCreate={vi.fn()}
          onOpen={vi.fn()}
          quickDraft={{ requirement, onRequirementChange: setRequirement }}
        />}
      </>;
    }
    const user = userEvent.setup();
    render(<DraftHost />);

    const draft = "这段快速任务说明尚未保存";
    await user.type(screen.getByRole("textbox", { name: "研究任务需求" }), draft);
    await user.click(screen.getByRole("button", { name: "切换页面" }));
    expect(screen.queryByRole("textbox", { name: "研究任务需求" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "切换页面" }));
    expect(screen.getByRole("textbox", { name: "研究任务需求" })).toHaveValue(draft);
  });

  it("fails closed on Catalog load failure while quick draft save remains available", async () => {
    vi.mocked(getCatalog).mockRejectedValue(new Error("运行目录服务超时"));
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_quick_catalog_failure_000000001",
      title: "Catalog 故障期间的快速草稿",
      requirement: "Catalog 暂时不可用时保存快速研究任务副本，但绝不能启动项目。",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      agents: DEFAULT_AGENTS,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(createSavedResearchTask).mockResolvedValue(savedTask);
    vi.mocked(getSavedResearchTasks).mockResolvedValue([savedTask]);
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    const input = await screen.findByPlaceholderText(
      "描述研究问题、数据约束、评价指标和期望产物…"
    );
    const quickForm = input.closest("form");
    expect(quickForm).not.toBeNull();
    await user.type(input, savedTask.requirement);
    expect(await within(quickForm!).findByText(/运行目录加载失败，暂不能启动项目：运行目录服务超时/))
      .toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    const savedStart = await screen.findByRole("button", { name: `启动任务 ${savedTask.title}` });
    expect(savedStart).toBeEnabled();
    await user.click(savedStart);
    expect(await within(screen.getByRole("region", { name: "已保存科研任务" })).findByRole("alert"))
      .toHaveTextContent("运行目录加载失败，暂不能启动项目：运行目录服务超时");

    await user.click(screen.getByRole("button", { name: "保存研究任务副本" }));

    await waitFor(() => expect(createSavedResearchTask).toHaveBeenCalledTimes(1));
    expect(createProject).not.toHaveBeenCalled();
  });

  it("reports an empty loaded Catalog as a runtime configuration error", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [],
      harnesses: [],
      agentPrompts: {}
    });

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect((await screen.findAllByText(/服务端没有可用的 Workflow Harness/)).length)
      .toBeGreaterThan(0);
    expect(screen.queryByText(/运行目录加载失败，暂不能启动项目/))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
  });

  it("reports missing global Gateways after clicking quick and saved-task launch", async () => {
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_no_gateway_000000000000000001",
      title: "无网关历史任务",
      requirement: "服务端没有任何全局网关时，快速入口和历史任务都不能启动。",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      agents: DEFAULT_AGENTS,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(getSavedResearchTasks).mockResolvedValue([savedTask]);
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["nex-agi/Nex-N2-Pro"],
      gateways: [],
      harnesses: [{
        id: "codex",
        label: "Codex",
        adapterVersion: "1",
        nativeProtocol: "responses",
        purposes: ["workflow", "explainer", "probe"],
        mode: "workflow",
        notes: "OpenFARS Codex Runner",
        capabilities: {
          durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
          readOnlyExplainer: true, webSearch: true, skills: true, mcp: true
        },
        available: true
      }],
      defaultHarnessId: "codex",
      agentPrompts: {}
    });

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    const noGatewayAlerts = await screen.findAllByText(
      /运行目录已加载，但服务端没有可用的全局网关。/
    );
    expect(noGatewayAlerts.length).toBeGreaterThan(0);
    expect(noGatewayAlerts[0]).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    const savedStart = await screen.findByRole("button", { name: `启动任务 ${savedTask.title}` });
    expect(savedStart).toBeEnabled();
    fireEvent.click(savedStart);
    expect(await within(screen.getByRole("region", { name: "已保存科研任务" })).findByRole("alert"))
      .toHaveTextContent("服务端没有可用的全局网关");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("saves quick briefs and lets users inspect, edit, start and delete saved tasks", async () => {
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_00000000000000000000000000000001",
      title: "快速保存课题",
      requirement: "快速保存课题。保存快速发起内容与当前选择的完整 Agent 配置供以后启动。",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      agents: defaultAgentsWithCatalogHarness,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(createSavedResearchTask).mockResolvedValue(savedTask);
    vi.mocked(createProject).mockResolvedValue({
      ...project,
      id: "prj_started_from_saved_task",
      title: savedTask.title,
      requirement: savedTask.requirement
    });
    const onEditSavedTask = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectListPage
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onEditSavedTask={onEditSavedTask}
      />
    );

    const quickInput = screen.getByPlaceholderText(
      "描述研究问题、数据约束、评价指标和期望产物…"
    );
    await user.type(quickInput, savedTask.requirement);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("menuitem", { name: /仅本次项目使用/ }));
    await waitFor(() =>
      expect(createSavedResearchTask).toHaveBeenCalledWith({
        title: savedTask.title,
        requirement: savedTask.requirement,
        agents: defaultAgentsWithCatalogHarness,
        orchestration: DEFAULT_AGENT_ORCHESTRATION,
        git: { enabled: false }
      })
    );
    expect(
      screen.getByRole("region", { name: "已保存科研任务" })
    ).toHaveTextContent(savedTask.title);

    await user.click(
      screen.getByRole("button", { name: `查看任务 ${savedTask.title}` })
    );
    expect(screen.getByText("完整科研需求")).toBeInTheDocument();
    expect(screen.getAllByText("nex-agi/Nex-N2-Pro").length).toBeGreaterThan(0);
    const mainConfigSummary = screen.getByLabelText("查看main完整配置");
    await user.click(mainConfigSummary);
    const mainConfig = mainConfigSummary.closest("details");
    expect(mainConfig).not.toBeNull();
    expect(within(mainConfig!).getByText("Prompt")).toBeInTheDocument();
    expect(within(mainConfig!).getByText("权限：原生完全访问")).toBeInTheDocument();
    expect(within(mainConfig!).getByText("固定 Skills")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: `编辑任务 ${savedTask.title}` })
    );
    expect(onEditSavedTask).toHaveBeenCalledWith(savedTask.id);

    await user.click(
      screen.getByRole("button", { name: `启动任务 ${savedTask.title}` })
    );
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        title: savedTask.title,
        requirement: savedTask.requirement,
        sourceSavedTaskId: savedTask.id,
        agents: defaultAgentsWithCatalogHarness,
        orchestration: DEFAULT_AGENT_ORCHESTRATION,
        git: { enabled: false }
      })
    );
    expect(
      await screen.findByText("prj_started_from_saved_task")
    ).toBeInTheDocument();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(
      screen.getByRole("button", { name: `删除任务 ${savedTask.title}` })
    );
    await waitFor(() =>
      expect(deleteSavedResearchTask).toHaveBeenCalledWith(savedTask.id)
    );
  });

  it("shows task identity, overall progress, queued agent and shared kind queues", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(await screen.findByText("prj_waiting")).toBeInTheDocument();
    expect(screen.getByText("执行智能体等待重试")).toBeInTheDocument();
    expect(screen.getByText("流程进度 42%")).toBeInTheDocument();
    expect(screen.getByText("队列 #2 / 3")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent 队列看板" })).toBeInTheDocument();
    expect(screen.getAllByText("prj_active").length).toBeGreaterThan(0);
    expect(screen.getByText("1/10 槽占用 · 1 个排队")).toBeInTheDocument();
    expect(screen.getByText("Token 消耗每 10 分钟更新")).toBeInTheDocument();
    expect(
      screen.getByTitle("累计 123,456 tokens；每 10 分钟更新")
    ).toBeInTheDocument();
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000);
    intervalSpy.mockRestore();
  });

  it("shows concurrent calls in one Git project separately and keeps recovery out of active counts", async () => {
    vi.mocked(getQueue).mockResolvedValue({ main: { capacity: 10, activeProjectIds: [project.id], activeTasks: [{ id: "leader", projectId: project.id, agentId: "leader", state: "running" }], queued: [] },
      worker: { capacity: 10, activeProjectIds: [project.id], activeTasks: [{ id: "a", projectId: project.id, agentId: "alice", state: "running" }, { id: "b", projectId: project.id, agentId: "bob", state: "starting" }],
        recoveringTasks: [{ id: "old", projectId: project.id, agentId: "retained-agent", state: "recovering" }],
        queued: [{ id: "q1", projectId: project.id, agentId: "alice", position: 1, enteredAt: "2026-10-14T00:00:00Z" }, { id: "q2", projectId: project.id, agentId: "bob", position: 2, enteredAt: "2026-10-14T00:00:00Z" }],
        pools: [{ id: "project-pool", scope: "project", projectId: project.id, capacity: 2, occupied: 2 }] } });
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    const board = within(await screen.findByRole("region", { name: "Agent 队列看板" }));
    expect(await board.findByText("2 个调用中 · 2 个排队")).toBeVisible();
    expect(board.getByText("2 个任务正在执行")).toBeVisible();
    expect(board.getByText("bob · 正在启动")).toBeVisible();
    expect(board.getByText("leader · 调用中")).toBeVisible();
    expect(board.getByText("1 个调用等待恢复")).toBeVisible();
    expect(board.getByText("1 个项目队列 · 单项目并发上限 2")).toBeVisible();
  });

  it("keeps queue refresh failures visible when a previous snapshot is retained", async () => {
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    const board = within(await screen.findByRole("region", { name: "Agent 队列看板" }));
    await board.findByText("1/10 槽占用 · 1 个排队");
    vi.mocked(getQueue).mockRejectedValue(new Error("队列服务不可用"));
    await user.click(board.getByRole("button", { name: "刷新" }));
    expect(await board.findByText(/当前显示最近一次成功读取的快照/)).toBeVisible();
    expect(board.getByText("1/10 槽占用 · 1 个排队")).toBeVisible();
  });

  it("does not claim idle slots when no queue snapshot is available", async () => {
    vi.mocked(getQueue).mockRejectedValue(new Error("队列服务不可用"));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    const board = within(await screen.findByRole("region", { name: "Agent 队列看板" }));
    expect(await board.findByText(/队列快照暂不可用/)).toBeVisible();
    expect(board.queryByText(/槽位空闲/)).not.toBeInTheDocument();
    expect(board.getAllByText("状态未读取")).toHaveLength(2);
  });

  it("keeps project cards newest-to-oldest by start time across live refreshes", async () => {
    const oldest: Project = {
      ...project,
      id: "prj_oldest",
      title: "最早启动项目",
      createdAt: "2026-07-31T08:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z"
    };
    const middle: Project = {
      ...project,
      id: "prj_middle",
      title: "中间启动项目",
      createdAt: "2026-07-31T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z"
    };
    const newest: Project = {
      ...project,
      id: "prj_newest",
      title: "最新启动项目",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:00:00.000Z"
    };
    vi.mocked(getProjects)
      .mockReset()
      .mockResolvedValueOnce([oldest, newest, middle])
      .mockResolvedValueOnce([
        { ...middle, updatedAt: "2026-08-01T12:00:00.000Z" },
        { ...oldest, updatedAt: "2026-08-01T13:00:00.000Z" },
        newest
      ]);

    const { container } = render(
      <ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />
    );
    expect(await screen.findByText("最新启动项目")).toBeInTheDocument();

    const displayedTitles = () =>
      [...container.querySelectorAll(".project-grid .project-card h3")].map(
        (heading) => heading.textContent
      );
    expect(displayedTitles()).toEqual([
      "最新启动项目",
      "中间启动项目",
      "最早启动项目"
    ]);

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(getProjects).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(displayedTitles()).toEqual([
        "最新启动项目",
        "中间启动项目",
        "最早启动项目"
      ])
    );
  });

  it("renders large project portfolios in bounded batches", async () => {
    const manyProjects = Array.from({ length: 13 }, (_, index): Project => ({
      ...project,
      id: `prj_batch_${index}`,
      title: `批次项目 ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString()
    }));
    vi.mocked(getProjects).mockReset().mockResolvedValue(manyProjects);
    const user = userEvent.setup();
    const { container } = render(
      <ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />
    );

    expect(await screen.findByText("批次项目 13")).toBeInTheDocument();
    expect(container.querySelectorAll(".project-grid .project-card")).toHaveLength(12);
    expect(screen.queryByText("批次项目 1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "再显示 1 个" }));
    expect(await screen.findByText("批次项目 1")).toBeInTheDocument();
    expect(container.querySelectorAll(".project-grid .project-card")).toHaveLength(13);
  });

  it("submits consecutive quick tasks with the default agent configuration", async () => {
    const created = { ...project, id: "prj_created", title: "新的研究需求" };
    vi.mocked(createProject).mockResolvedValue(created);
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={onOpen} />);

    const input = await screen.findByPlaceholderText(
      "描述研究问题、数据约束、评价指标和期望产物…"
    );
    await user.type(input, "研究一个可复现的多智能体调度基准并输出论文");
    await user.click(screen.getByRole("button", { name: "提交并继续" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        requirement: "研究一个可复现的多智能体调度基准并输出论文",
        agents: defaultAgentsWithCatalogHarness,
        orchestration: DEFAULT_AGENT_ORCHESTRATION
      })
    );
    expect(input).toHaveValue("");
    expect(screen.getByText("prj_created")).toBeInTheDocument();
    expect(screen.getByText(/可继续提交下一条需求/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /查看任务/ }));
    expect(onOpen).toHaveBeenCalledWith("prj_created");
  });

  it("lets quick start edit the orchestration template before launch", async () => {
    vi.mocked(createProject).mockResolvedValue({
      ...project,
      id: "prj_quick_orchestration"
    });
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", { name: "高级配置" })
    );
    const advancedDialog = await screen.findByRole("dialog", {
      name: "高级配置",
    });
    expect(
      within(advancedDialog).getByText("文字版 Workflow 编排")
    ).toBeInTheDocument();
    await user.selectOptions(
      within(advancedDialog).getByLabelText("输入目标外层节点"),
      "execution"
    );
    await user.selectOptions(
      within(advancedDialog).getByLabelText("执行智能体第 1 条出边目标"),
      "writing"
    );
    await user.click(within(advancedDialog).getByRole("button", { name: "完成" }));
    const input = screen.getByPlaceholderText(
      "描述研究问题、数据约束、评价指标和期望产物…"
    );
    await user.type(input, "从 Execution 开始验证一个自定义快速启动编排流程。");
    await user.click(screen.getByRole("button", { name: "提交并继续" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0][0].orchestration).toMatchObject({
      input: { target: "execution" },
      routes: {
        execution: [{ target: "writing", kind: "strong" }]
      }
    });
  });

  it("quick-starts with a saved project Agent configuration preset", async () => {
    const savedPreset: AgentConfigPreset = {
      ...defaultPreset,
      id: "cfg_00000000000000000000000000000001",
      name: "高思考实验配置",
      builtin: false,
      sourceProjectId: "prj_00000000000000000000000000000001",
      sourceProjectTitle: "来源项目",
      agents: {
        ...defaultAgentsWithCatalogHarness,
        execution: {
          ...defaultAgentsWithCatalogHarness.execution,
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
          instructions: "Use the exported execution prompt.",
          skills: ["builtin:experiment-runner", "builtin:inspire"],
          autoSkills: ["builtin:nature-figure"],
          mcpServers: [
            { name: "metrics", url: "https://metrics.example.test/mcp" }
          ]
        }
      }
    };
    vi.mocked(getAgentConfigPresets).mockResolvedValue([
      defaultPreset,
      savedPreset
    ]);
    vi.mocked(createProject).mockResolvedValue({
      ...project,
      id: "prj_quick_preset"
    });
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    await user.selectOptions(
      await screen.findByLabelText("快速启动 Agent 配置"),
      savedPreset.id
    );
    expect(
      screen.getByRole("option", { name: /高思考实验配置/ })
    ).toBeInTheDocument();
    expect(screen.getByText("1 个 MCP 绑定")).toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText("描述研究问题、数据约束、评价指标和期望产物…"),
      "使用保存的完整智能体配置运行新的可复现实验研究任务"
    );
    await user.click(screen.getByRole("button", { name: "提交并继续" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const expectedExecution = structuredClone(savedPreset.agents.execution);
    delete expectedExecution.reasoningEffort;
    expectedExecution.reasoningMigrationWarning =
      "旧 Harness 思考深度“xhigh”无法精确匹配当前 Gateway/model 选项，已改用 Provider 默认值";
    expect(vi.mocked(createProject).mock.calls[0][0].agents.execution).toEqual(
      expectedExecution
    );
  });

  it("keeps quick launch clickable and reports invalid requirements before contacting the server", async () => {
    vi.mocked(createProject).mockResolvedValue({ ...project, id: "prj_click_to_validate" });
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("option", { name: "系统默认配置" });
    const start = screen.getByRole("button", { name: "提交并继续" });
    expect(start).toBeEnabled();
    await user.click(start);
    expect(screen.getByRole("alert")).toHaveTextContent("请至少输入 10 个字符");
    expect(createProject).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "研究任务需求" }), "修正研究需求后再正式启动项目，不能悄悄忽略点击。");
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
  });

  it.each([2, 3] as const)("starts a quick Git task from v%s without requiring or adding collaboration groups", async schemaVersion => {
    const preset = structuredClone(defaultPreset);
    if (schemaVersion === 3) upgradeLegacyGroups(preset.orchestration);
    vi.mocked(getAgentConfigPresets).mockResolvedValue([preset]);
    vi.mocked(createProject).mockResolvedValue({ ...project, id: "prj_quick_git_without_group" });
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("option", { name: "系统默认配置" });
    const gitSwitch = screen.getByRole("switch", { name: "快速发起启用 Git 机制" });
    await user.click(gitSwitch);
    expect(gitSwitch).toBeChecked();
    expect(gitSwitch).toBeEnabled();
    await user.click(gitSwitch);
    expect(gitSwitch).not.toBeChecked();
    await user.click(gitSwitch);
    await user.type(screen.getByRole("textbox", { name: "研究任务需求" }), "使用 Git 管理普通 Workflow 的研究产物，不创建协作组。");
    const start = screen.getByRole("button", { name: "提交并继续" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createProject).mock.calls[0]![0];
    expect(input.git).toEqual({ enabled: true, provider: "github", accountId: GITHUB_ACCOUNT_ID });
    expect(input.orchestration?.collaborations).toEqual([]);
    expect(input.orchestration?.schemaVersion).toBe(2);
    expect(input.orchestration?.scopedWorkflow).toBeUndefined();
    expect(input.orchestration?.agents).toEqual(DEFAULT_AGENT_ORCHESTRATION.agents);
    expect(input.orchestration?.routes).toEqual(DEFAULT_AGENT_ORCHESTRATION.routes);
  });

  it("starts valid v3 saved tasks and quick presets while rejecting incomplete scoped graphs", async () => {
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
      agents: defaultAgentsWithCatalogHarness, orchestration,
      git: { enabled: true, provider: "github", accountId: GITHUB_ACCOUNT_ID },
      createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z"
    };
    const incomplete = structuredClone(savedTask);
    incomplete.id = "task_scoped_incomplete_0000000001";
    incomplete.title = "未连完的分层草稿";
    incomplete.orchestration.scopedWorkflow!.groups[0]!.workflow.routes = {};
    const preset: AgentConfigPreset = {
      ...defaultPreset, id: "cfg_scoped_start_0000000000000001",
      name: "分层协作配置", builtin: false, agents: savedTask.agents, orchestration
    };
    vi.mocked(getSavedResearchTasks).mockResolvedValue([savedTask, incomplete]);
    vi.mocked(getAgentConfigPresets).mockResolvedValue([defaultPreset, preset]);
    vi.mocked(createProject).mockResolvedValue({ ...project, id: "prj_scoped_start" });
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    const start = await screen.findByRole("button", { name: `启动任务 ${savedTask.title}` });
    await waitFor(() => expect(start).toBeEnabled());
    expect(screen.getByRole("button", { name: `启动任务 ${incomplete.title}` })).toBeEnabled();
    await user.click(start);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0]![0]).toMatchObject({
      title: savedTask.title, orchestration, git: savedTask.git
    });
    await user.selectOptions(screen.getByLabelText("快速启动 Agent 配置"), preset.id);
    const gitSwitch = screen.getByRole("switch", { name: "快速发起启用 Git 机制" });
    await user.click(gitSwitch);
    expect(gitSwitch).toBeChecked();
    expect(gitSwitch).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "研究任务需求" }), savedTask.requirement);
    const quickStart = screen.getByRole("button", { name: "提交并继续" });
    expect(quickStart).toBeEnabled();
    await user.click(quickStart);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createProject).mock.calls[1]![0]).toMatchObject({
      orchestration, git: savedTask.git
    });
  });

  it("imports an SDK visualization in the home preset library without changing the quick task", async () => {
    const imported: AgentConfigPreset = {
      ...structuredClone(defaultPreset), id: "cfg_sdk_preview", name: "SDK preview", builtin: false,
      importSource: { filename: "workflow.json", text: "{\"sdk\":true}", notices: [] }
    };
    imported.agents.idea.skills = ["./skills/not-installed"];
    imported.agents.idea.harness = "codex";
    vi.mocked(importAgentConfigPreset).mockResolvedValue(imported);
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("option", { name: "系统默认配置" });
    const brief = screen.getByPlaceholderText("描述研究问题、数据约束、评价指标和期望产物…");
    fireEvent.change(brief, { target: { value: "Keep the current research task" } });
    const library = screen.getByRole("complementary", { name: "已有 Agent 配置" });
    expect(within(library).getByRole("button", { name: "导入 SDK workflow.json" })).toBeInTheDocument();
    fireEvent.change(within(library).getByLabelText("导入 SDK Workflow 文件"), { target: { files: [new File(["{\"sdk\":true}"], "workflow.json")] } });
    const dialog = await screen.findByRole("dialog", { name: "查看 Workflow：SDK preview" });
    expect(importAgentConfigPreset).toHaveBeenCalledWith("workflow.json", "{\"sdk\":true}");
    expect(within(dialog).getByText("SDK Workflow · 原始配置只读预览")).toBeInTheDocument();
    fireEvent.click(dialog.querySelector('[data-node-id="idea"]')!);
    const harnessSelect = within(dialog).getByLabelText("idea Harness");
    expect(within(harnessSelect).getByRole("option", { name: "Codex" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/该历史 Harness 当前未注册/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("{\"sdk\":true}")).toBeInTheDocument();
    expect(screen.getByLabelText("快速启动 Agent 配置")).toHaveValue("default");
    expect(screen.getByRole("option", { name: "SDK preview" })).toBeInTheDocument();
    expect(brief).toHaveValue("Keep the current research task");
    expect(createProject).not.toHaveBeenCalled();
    expect(createAgentConfigPreset).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭 Workflow 预览" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 Workflow SDK preview" }));
    expect(screen.getByRole("dialog", { name: "查看 Workflow：SDK preview" })).toBeInTheDocument();
  });

  it("keeps imported visualizations visible after reload and reports failed imports in the library", async () => {
    const imported: AgentConfigPreset = {
      ...structuredClone(defaultPreset), id: "cfg_reloaded_sdk", name: "Saved SDK", builtin: false,
      importSource: { filename: "sdk.json", text: "{}", notices: [] }
    };
    vi.mocked(getAgentConfigPresets).mockResolvedValue([defaultPreset, imported]);
    vi.mocked(importAgentConfigPreset).mockRejectedValue(new Error("orchestration.input.target：未知 Agent"));
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("button", { name: "查看 Workflow Saved SDK" });
    expect(getAgentConfigPresets).toHaveBeenCalledWith(true);
    expect(screen.getByRole("option", { name: "Saved SDK" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重命名配置 Saved SDK" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载配置 Saved SDK" }));
    expect(downloadWorkflowSource).toHaveBeenCalledWith(imported);
    fireEvent.change(screen.getByLabelText("导入 SDK Workflow 文件"), { target: { files: [new File(["{}"], "bad.json")] } });
    expect(await screen.findByText("orchestration.input.target：未知 Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 Workflow Saved SDK" })).toBeInTheDocument();
    expect(screen.getByLabelText("快速启动 Agent 配置")).toHaveValue("default");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("loads an SDK preset for quick launch, requires Web gateways and never overwrites the source", async () => {
    const imported: AgentConfigPreset = {
      ...structuredClone(defaultPreset), id: "cfg_sdk_run", name: "SDK run", builtin: false,
      agents: structuredClone(defaultAgentsWithCatalogHarness),
      importSource: { filename: "sdk.json", text: "{\"original\":true}", notices: [] }
    };
    for (const agent of Object.values(imported.agents)) delete agent.gatewayId;
    imported.agents.main.sessionPersistence = false;
    imported.agents.idea.instructions = "Keep the SDK research instructions.";
    imported.orchestration.routes.main = [{ target: "idea", kind: "strong" }];
    const original = structuredClone(imported);
    vi.mocked(getAgentConfigPresets).mockResolvedValue([defaultPreset, imported]);
    vi.mocked(createProject).mockResolvedValue({ ...project, id: "prj_sdk_run" });
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("option", { name: "SDK run" });
    // Exercise the saved-flow entry as well as the dropdown selection.
    fireEvent.click(screen.getByRole("button", { name: "打开 Workflow 画布编辑器" }));
    const editor = screen.getByRole("dialog", { name: "编辑快速发起 Workflow" });
    fireEvent.click(screen.getByRole("button", { name: "载入 SDK run" }));
    expect(screen.getByLabelText("快速启动 Agent 配置")).toHaveValue(imported.id);
    expect(screen.getByText(/已载入 SDK Workflow 的可编辑副本/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("描述研究问题、数据约束、评价指标和期望产物…"), {
      target: { value: "Use the imported SDK research workflow with configured Web gateways." }
    });
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/启动前检查未通过：.*必须选择全局网关/);
    expect(createProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存 SDK run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "修改 SDK run 名称" })).toBeDisabled();
    for (const { name } of imported.orchestration.agents) {
      fireEvent.click(editor.querySelector(`[data-node-id="${name}"]`)!);
      fireEvent.change(screen.getByLabelText(`${name}全局网关`), { target: { value: runtimeGateway.id } });
    }
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(createProject).mock.calls[0][0];
    expect(payload.agents.idea).toMatchObject({ harness: "codex", instructions: imported.agents.idea.instructions, gatewayId: runtimeGateway.id });
    expect(payload.agents.main.sessionPersistence).toBe(true);
    expect(payload.orchestration?.routes.main.every((edge) => edge.kind === "weak")).toBe(true);
    expect(imported).toEqual(original);
    expect(updateAgentConfigPreset).not.toHaveBeenCalled();
  });

  it("does not replace an imported Harness when the local Catalog arrives after selection", async () => {
    const imported: AgentConfigPreset = {
      ...structuredClone(defaultPreset), id: "cfg_sdk_other", name: "SDK other", builtin: false,
      agents: structuredClone(defaultAgentsWithCatalogHarness),
      importSource: { filename: "sdk.json", text: "{}", notices: [] }
    };
    imported.agents.idea.harness = "missing-sdk-harness";
    delete imported.agents.idea.gatewayId;
    const catalog = await getCatalog();
    let resolveCatalog!: (value: typeof catalog) => void;
    vi.mocked(getCatalog).mockImplementation(() => new Promise((resolve) => { resolveCatalog = resolve; }));
    vi.mocked(getAgentConfigPresets).mockResolvedValue([defaultPreset, imported]);
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("option", { name: "SDK other" });
    fireEvent.change(screen.getByLabelText("快速启动 Agent 配置"), { target: { value: imported.id } });
    await act(async () => { resolveCatalog(catalog); });
    expect(screen.getByText(/idea：missing-sdk-harness 不在服务端 Harness 目录中/)).toBeInTheDocument();
    expect(screen.getByText(/idea：必须选择全局网关/)).toBeInTheDocument();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("saves a titled project configuration and downloads it separately from the library", async () => {
    const customTitle = "H200 高思考论文实验配置";
    const exportedPreset: AgentConfigPreset = {
      ...defaultPreset,
      id: "cfg_00000000000000000000000000000002",
      name: customTitle,
      builtin: false,
      sourceProjectId: project.id,
      sourceProjectTitle: project.title,
      agents: {
        ...project.agents,
        main: {
          ...project.agents.main,
          mcpServers: [
            {
              name: "research-docs",
              url: "https://docs.example.test/mcp"
            }
          ]
        }
      }
    };
    vi.mocked(saveProjectAgentConfigPreset).mockResolvedValue(exportedPreset);
    const user = userEvent.setup();
    const { container } = render(
      <ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />
    );

    const quickTaskCard = container.querySelector(".quick-task-section");
    const configLibrary = screen.getByRole("complementary", {
      name: "已有 Agent 配置"
    });
    expect(quickTaskCard).not.toContainElement(configLibrary);
    expect(configLibrary.parentElement).toHaveClass("quick-task-row");

    await user.click(
      await screen.findByRole("button", {
        name: `保存项目 ${project.id} 的 Agent 配置`
      })
    );
    expect(
      screen.queryByRole("button", {
        name: `保存并导出项目 ${project.id} 的 Agent 配置`
      })
    ).not.toBeInTheDocument();
    const titleInput = screen.getByLabelText("Agent 配置标题");
    expect(titleInput).toHaveValue(`${project.title} · Agent 配置`);
    await user.clear(titleInput);
    await user.type(titleInput, customTitle);
    await user.click(screen.getByRole("button", { name: "保存到配置库" }));

    await waitFor(() =>
      expect(saveProjectAgentConfigPreset).toHaveBeenCalledWith(
        project.id,
        customTitle
      )
    );
    expect(downloadAgentConfigPreset).not.toHaveBeenCalled();
    expect(
      screen.getByText(`${customTitle} 已保存到配置库`)
    ).toBeInTheDocument();
    expect(screen.getByText(`来源：${project.title}`)).toBeInTheDocument();
    expect(screen.getByText("1 个 MCP 绑定")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: `下载配置 ${customTitle}` })
    );
    expect(downloadAgentConfigPreset).toHaveBeenCalledWith(exportedPreset);

    expect(
      screen.queryByRole("button", { name: "删除配置 系统默认配置" })
    ).not.toBeInTheDocument();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(
      screen.getByRole("button", { name: `删除配置 ${customTitle}` })
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining(`确定删除配置“${customTitle}”吗？`)
    );
    await waitFor(() =>
      expect(deleteAgentConfigPreset).toHaveBeenCalledWith(exportedPreset.id)
    );
    expect(
      screen.queryByRole("button", { name: `下载配置 ${customTitle}` })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: new RegExp(customTitle) })
    ).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("exposes the three Workflow save actions and protects the default preset", async () => {
    const reusablePreset: AgentConfigPreset = {
      ...defaultPreset,
      id: "cfg_00000000000000000000000000000004",
      name: "可复用 Workflow",
      builtin: false
    };
    const updatedPreset = { ...reusablePreset, name: "可复用 Workflow" };
    const copiedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_00000000000000000000000000000004",
      title: "快速保存课题",
      requirement: "保存当前 Workflow 副本供本次项目使用并保持配置库不变。",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      agents: DEFAULT_AGENTS,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(getAgentConfigPresets).mockResolvedValue([defaultPreset, reusablePreset]);
    vi.mocked(updateAgentConfigPreset).mockResolvedValue(updatedPreset);
    vi.mocked(createAgentConfigPreset).mockResolvedValue({
      ...updatedPreset,
      id: "cfg_00000000000000000000000000000005",
      name: "新 Workflow"
    });
    vi.mocked(createSavedResearchTask).mockResolvedValue(copiedTask);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    const presetSelect = await screen.findByLabelText("快速启动 Agent 配置");
    await user.selectOptions(presetSelect, reusablePreset.id);
    await user.type(
      screen.getByPlaceholderText("描述研究问题、数据约束、评价指标和期望产物…"),
      "验证 Workflow 三种保存动作都连接到统一配置状态。"
    );

    await user.click(screen.getByRole("button", { name: /^保存$/ }));
    expect(screen.getByRole("menuitem", { name: /更新当前配置/ })).not.toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: /更新当前配置/ }));
    await waitFor(() => expect(updateAgentConfigPreset).toHaveBeenCalledWith(
      reusablePreset.id,
      expect.objectContaining({ name: reusablePreset.name })
    ));

    await user.click(screen.getByRole("button", { name: /^保存$/ }));
    await user.click(screen.getByRole("menuitem", { name: /另存为新配置/ }));
    const nameInput = await screen.findByLabelText("Workflow 配置名称");
    await user.clear(nameInput);
    await user.type(nameInput, "新 Workflow");
    await user.click(screen.getByRole("button", { name: "保存新配置" }));
    await waitFor(() => expect(createAgentConfigPreset).toHaveBeenCalledWith(
      expect.objectContaining({ name: "新 Workflow" })
    ));

    await user.click(screen.getByRole("button", { name: /^保存$/ }));
    await user.click(screen.getByRole("menuitem", { name: /仅本次项目使用/ }));
    await waitFor(() => expect(createSavedResearchTask).toHaveBeenCalled());
    await user.selectOptions(presetSelect, "default");
    await user.click(screen.getByRole("button", { name: /^保存$/ }));
    expect(screen.getByRole("menuitem", { name: /更新当前配置/ })).toBeDisabled();
  });

  it("blocks quick submission when the server catalog marks the selected Harness unavailable", async () => {
    const unavailableAgents = structuredClone(DEFAULT_AGENTS);
    unavailableAgents.main.harness = "dsh";
    vi.mocked(getAgentConfigPresets).mockResolvedValue([{
      ...defaultPreset,
      agents: unavailableAgents
    }]);
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: ["nex-agi/Nex-N2-Pro"],
      agentPrompts: {},
      harnesses: [{
        id: "dsh",
        label: "dsh",
        adapterVersion: "1",
        nativeProtocol: "chat-completions",
        purposes: ["workflow", "probe"],
        mode: "workflow",
        notes: "Embedded dsh",
        capabilities: {
          durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
          readOnlyExplainer: false, webSearch: true, skills: true, mcp: true
        },
        available: false,
        availabilityReason: "项目内置 dsh 入口不可执行"
      }]
    });
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    const input = screen.getByPlaceholderText("描述研究问题、数据约束、评价指标和期望产物…");
    await user.type(input, "验证快速入口在 Harness 不可用时不会提交真实项目。 ");
    expect(await screen.findByText(/启动前配置检查未通过：main：dsh 当前不可用/)).toBeVisible();
    expect(screen.getByRole("button", { name: "提交并继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
    expect(screen.getByRole("button", { name: "保存研究任务副本" })).not.toBeDisabled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("blocks a saved task that references a Harness missing from the current Catalog", async () => {
    const retiredAgents = structuredClone(defaultAgentsWithCatalogHarness);
    retiredAgents.main.harness = "retired-harness";
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_retired_harness_000000000001",
      title: "历史 Harness 任务",
      requirement: "保留历史 Harness ID，但在当前 Catalog 未注册时不得启动。",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      agents: retiredAgents,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(getSavedResearchTasks).mockResolvedValue([savedTask]);

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    const start = await screen.findByRole("button", { name: `启动任务 ${savedTask.title}` });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(await screen.findByText(/main：retired-harness 不在服务端 Harness 目录中/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("retired-harness"));
    expect(createProject).not.toHaveBeenCalled();
  });

  it("warns about failed gateway tests but allows quick and saved task starts", async () => {
    const failedTest: GatewayRecord["test"] = {
      status: "failed",
      protocol: "responses",
      model: runtimeGateway.defaultModel,
      error: "上游返回 HTTP 401",
      harness: "codex",
      nativeProtocol: "responses",
      routeMode: "direct",
      probeKind: "route"
    };
    const failedGateway: GatewayRecord = {
      ...runtimeGateway,
      test: failedTest,
      tests: [failedTest]
    };
    const catalog = await getCatalog();
    vi.mocked(getCatalog).mockResolvedValue({ ...catalog, gateways: [failedGateway] });
    const savedTask: SavedResearchTask = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_failed_gateway_000000000000001",
      title: "待尝试的课题",
      requirement: "网关连接验证失败后仍允许尝试启动。",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      agents: defaultAgentsWithCatalogHarness,
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
    };
    vi.mocked(getSavedResearchTasks).mockResolvedValue([savedTask]);
    vi.mocked(createProject).mockResolvedValue(project);
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    const quickInput = screen.getByRole("textbox", { name: "研究任务需求" });
    await user.type(quickInput, "即使网关验证失败，也允许尝试启动快速任务。");
    expect(await within(quickInput.closest("form")!).findByText(/网关连接验证未通过，允许启动：/)).toBeVisible();
    const quickStart = screen.getByRole("button", { name: "提交并继续" });
    expect(quickStart).not.toBeDisabled();
    await user.click(quickStart);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));

    const savedStart = screen.getByRole("button", { name: `启动任务 ${savedTask.title}` });
    expect(savedStart).not.toBeDisabled();
    expect(within(screen.getByRole("region", { name: "已保存科研任务" })).getByText(
      /网关连接验证未通过，允许启动：main：网关尚未通过/
    )).toBeVisible();
    await user.click(savedStart);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2));
  });

  it("pauses active projects and starts paused projects from their list cards", async () => {
    const running: Project = {
      ...project,
      id: "prj_running",
      title: "运行中的项目",
      status: "running",
      phase: "execution:running",
      currentAgent: "execution",
      queuedAgent: undefined,
      queuePosition: undefined
    };
    const paused: Project = {
      ...project,
      id: "prj_paused",
      title: "已暂停的项目",
      status: "paused",
      phase: "paused",
      currentAgent: undefined,
      queuedAgent: "execution",
      queuePosition: undefined
    };
    vi.mocked(getProjects).mockResolvedValue([running, paused]);
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    const pauseButton = await screen.findByRole("button", {
      name: `暂停项目 ${running.id}`
    });
    const startButton = screen.getByRole("button", {
      name: `启动项目 ${paused.id}`
    });
    expect(
      screen.getByRole("group", { name: `项目 ${running.id} 运行控制` })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: `项目 ${paused.id} 运行控制` })
    ).toBeInTheDocument();

    await user.click(pauseButton);
    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(running.id, "pause")
    );

    await user.click(startButton);
    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(paused.id, "resume")
    );
  });

  it("resumes an interrupted project from its project card", async () => {
    const interrupted: Project = {
      ...project,
      status: "interrupted",
      phase: "execution:interrupted",
      interruptedAt: "2026-07-31T07:00:00.000Z",
      queuePosition: undefined,
      queueDepth: 0,
      agentProgress: {
        ...project.agentProgress,
        execution: { state: "interrupted", runs: 1 }
      },
      overallProgress: {
        ...project.overallProgress,
        label: "执行 Agent 运行中断，等待恢复"
      }
    };
    vi.mocked(getProjects).mockResolvedValue([interrupted]);
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: `启动项目 ${interrupted.id}` });
    expect(screen.getByText("已保存到 execution 断点")).toBeInTheDocument();
    expect(
      screen.getByText("启动后重新运行该 Agent 并继续全流程")
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: `启动项目 ${interrupted.id}` })
    );

    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(
        interrupted.id,
        "resume"
      )
    );
  });

  it("marks a paused project that needs user intervention", async () => {
    const intervention: Project = {
      ...project,
      status: "paused",
      phase: "user-intervention-required",
      queuedAgent: "main",
      queuePosition: undefined,
      userIntervention: {
        id: "usr_list",
        status: "pending",
        requestedAt: "2026-07-31T08:00:00.000Z",
        message: "请完成 GitHub 登录。",
        rationale: "账号授权只能由用户完成。",
        successCriteria: ["确认登录成功。"]
      },
      overallProgress: {
        ...project.overallProgress,
        label: "系统调度等待用户介入"
      }
    };
    vi.mocked(getProjects).mockResolvedValue([intervention]);
    const onOpen = vi.fn();
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={onOpen} />);

    expect(await screen.findByText("需要用户介入")).toBeInTheDocument();
    expect(screen.getByText("请完成 GitHub 登录。")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `启动项目 ${intervention.id}` })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看并回复" }));
    expect(onOpen).toHaveBeenCalledWith(intervention.id);
  });

  it("marks exhausted Gateway recovery as actionable and retries from the project card", async () => {
    const gatewayRecovery: Project = {
      ...project,
      status: "paused",
      phase: "gateway-recovery-required",
      queuedAgent: "main",
      queuePosition: undefined,
      overallProgress: {
        ...project.overallProgress,
        label: "网关工具参数异常，等待重新尝试"
      }
    };
    vi.mocked(getProjects).mockResolvedValue([gatewayRecovery]);
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(await screen.findByText("网关工具参数连续异常")).toBeInTheDocument();
    expect(screen.getByText("网关异常，等待重试")).toBeInTheDocument();
    expect(screen.getByText(/重试会保留项目上下文与现有成果/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `启动项目 ${gatewayRecovery.id}` })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "待处理" }));
    expect(screen.getAllByText(gatewayRecovery.title).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "重新尝试" }));
    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(gatewayRecovery.id, "resume")
    );
  });

  it("archives only cancelled projects and can restore them from the archive view", async () => {
    const cancelled: Project = {
      ...project,
      id: "prj_cancelled",
      title: "已取消的研究项目",
      status: "cancelled",
      phase: "cancelled",
      queuedAgent: undefined,
      queuePosition: undefined,
      queueDepth: 0,
      agentProgress: {
        ...project.agentProgress,
        execution: { state: "cancelled", runs: 1 }
      }
    };
    const archived: Project = {
      ...cancelled,
      archivedAt: "2026-07-31T14:00:00.000Z"
    };
    vi.mocked(getProjects)
      .mockReset()
      .mockResolvedValueOnce([cancelled])
      .mockResolvedValueOnce([archived])
      .mockResolvedValue([cancelled]);
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(await screen.findByText("已取消，可安全归档")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "归档项目" }));

    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(cancelled.id, "archive")
    );
    expect(
      await screen.findByText(/已归档，轨迹与产物均已保留/)
    ).toBeInTheDocument();
    expect(getProjects).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "已归档（1）" }));
    expect(await screen.findByText("项目已归档")).toBeInTheDocument();
    expect(screen.getByText("已归档项目不会进入 Agent 队列，数据仍完整保留"))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消归档" }));
    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(cancelled.id, "unarchive")
    );
    expect(await screen.findByText(/已取消归档/)).toBeInTheDocument();
  });

  it("shows archive and restore for paused Git projects and hides archived resume controls", async () => {
    const paused: Project = { ...project, status: "paused", phase: "collaboration:user-cancelled",
      currentAgent: undefined, queuedAgent: undefined,
      git: { enabled: true, status: "ready" } };
    const archived: Project = { ...paused, archivedAt: "2026-10-04T12:00:00.000Z" };
    vi.mocked(getProjects).mockResolvedValueOnce([paused]).mockResolvedValue([archived]);
    const user = userEvent.setup();
    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByText("项目已暂停，可归档保留现场")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "归档项目" }));
    await waitFor(() => expect(projectAction).toHaveBeenCalledWith(paused.id, "archive"));
    await user.click(screen.getByRole("button", { name: "已归档（1）" }));
    expect(await screen.findByText("项目已归档")).toBeVisible();
    expect(screen.getByRole("button", { name: "取消归档" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "启动项目" })).not.toBeInTheDocument();
  });

  it("selects only eligible filtered projects and reports partial batch archive results", async () => {
    const cancelled: Project = {
      ...project,
      id: "prj_batch_cancelled",
      title: "可归档项目",
      status: "cancelled",
      phase: "cancelled",
      currentAgent: undefined,
      queuedAgent: undefined
    };
    const running: Project = {
      ...project,
      id: "prj_batch_running",
      title: "不可归档项目",
      status: "running",
      phase: "execution:running",
      currentAgent: "execution",
      queuedAgent: undefined
    };
    vi.mocked(getProjects).mockResolvedValue([cancelled, running]);
    vi.mocked(archiveProjects).mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      results: [{
        projectId: cancelled.id,
        ok: false,
        error: "项目状态刚刚发生变化"
      }]
    });
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByText(cancelled.title);
    await user.click(screen.getByRole("button", { name: "批量管理" }));

    expect(screen.getByRole("checkbox", { name: `选择项目 ${running.title}` }))
      .toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: `选择项目 ${cancelled.title}` }));
    await user.click(screen.getByRole("button", { name: "归档所选" }));
    expect(screen.getByRole("dialog", { name: "批量归档项目" })).toHaveTextContent(
      "逐项处理 1 个项目"
    );
    await user.click(screen.getByRole("button", { name: "确认归档" }));

    await waitFor(() => expect(archiveProjects).toHaveBeenCalledWith([cancelled.id]));
    expect(await screen.findByText("归档完成：成功 0 个，失败 1 个。")).toBeVisible();
    expect(screen.getByText("项目状态刚刚发生变化")).toBeVisible();
  });

  it("limits batch select-all to the project cards currently rendered by pagination", async () => {
    const cancelledProjects = Array.from({ length: 13 }, (_, index): Project => ({
      ...project,
      id: `prj_visible_${String(index).padStart(2, "0")}`,
      title: `分页归档项目 ${index + 1}`,
      status: "cancelled",
      phase: "cancelled",
      currentAgent: undefined,
      queuedAgent: undefined,
      createdAt: new Date(Date.UTC(2026, 8, 19, 0, 0, index)).toISOString()
    }));
    vi.mocked(getProjects).mockResolvedValue(cancelledProjects);
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByText("分页归档项目 13");
    await user.click(screen.getByRole("button", { name: "批量管理" }));
    const batchBar = screen.getByRole("region", { name: "批量管理项目" });
    await user.click(within(batchBar).getByRole("checkbox", {
      name: "全选当前页面中的可归档项目"
    }));

    expect(batchBar).toHaveTextContent("已选择 12 个");
    expect(screen.getAllByRole("checkbox", { name: /选择项目 分页归档项目/ }))
      .toHaveLength(12);
  });

  it("requires the fixed confirmation before batch deleting archived projects", async () => {
    const archived: Project = {
      ...project,
      id: "prj_batch_archived",
      title: "待永久删除项目",
      status: "cancelled",
      phase: "cancelled",
      currentAgent: undefined,
      queuedAgent: undefined,
      archivedAt: "2026-09-19T00:00:00.000Z"
    };
    vi.mocked(getProjects).mockResolvedValue([archived]);
    vi.mocked(deleteArchivedProjects).mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      results: [{ projectId: archived.id, ok: true }]
    });
    const user = userEvent.setup();

    render(<ProjectListPage onCreate={vi.fn()} onOpen={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "已归档（1）" }));
    await screen.findByText(archived.title);
    await user.click(screen.getByRole("button", { name: "批量管理" }));
    await user.click(screen.getByRole("checkbox", { name: `选择项目 ${archived.title}` }));
    await user.click(screen.getByRole("button", { name: "永久删除所选" }));

    const confirmButton = screen.getByRole("button", { name: "永久删除" });
    expect(confirmButton).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "批量删除确认词" }), "永久删除");
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => expect(deleteArchivedProjects).toHaveBeenCalledWith(
      [archived.id],
      "永久删除"
    ));
    expect(await screen.findByText("永久删除完成：成功 1 个，失败 0 个。")).toBeVisible();
    expect(screen.queryByText(archived.title)).not.toBeInTheDocument();
  });
});
