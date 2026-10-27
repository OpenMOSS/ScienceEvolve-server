import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addProjectUserInput,
  archiveProjects,
  cancelProjectExplainer,
  createProject,
  uploadProjectInputFile,
  removeProjectInputFile,
  openProjectInputDirectory,
  createSavedResearchTask,
  createUserSkill,
  getAgentToolRecommendationCatalog,
  recommendAgentTools,
  deleteAgentConfigPreset,
  deleteArchivedProject,
  deleteArchivedProjects,
  deleteSavedResearchTask,
  eventStreamUrl,
  getAgentConfigPresets,
  getArtifact,
  getArtifactDirectory,
  getArtifactDownloadUrl,
  getArtifactPage,
  getArtifactSummary,
  getDisplayedFile,
  getCatalog,
  getGitHubAccounts,
  getProject,
  getProjectExplainerHistory,
  getRecommendationExplainerConfig,
  getProjectEventBootstrap,
  getProjectEventHistory,
  getProjects,
  getQueue,
  getSavedResearchTask,
  getSavedResearchTasks,
  recommendProjectConfig,
  respondToUserIntervention,
  revealGatewayCredential,
  resetProjectExplainer,
  saveProjectAgentConfigPreset,
  setDefaultGitHubAccount,
  startGitHubAuthorization,
  startGitHubRepositoryDeletionAuthorization,
  previewGitHubRepositoryDeletion,
  deleteGitHubRepositories,
  syncExplainerConversation,
  streamProjectExplainerQuestion,
  testGateway,
  testGatewayMatrix,
  updateProjectAgentConfigs,
  updateRecommendationExplainerConfig,
  updateProjectCollaborationGroup,
  updateProjectAgentModels,
  updateSavedResearchTask,
  verifyGitHubAccount,
  deleteGitHubAccount
} from "./api";
import {
  DEFAULT_AGENT_ORCHESTRATION,
  DEFAULT_AGENTS,
  normalizeAgentOrchestration,
  normalizeAgents
} from "./lib";
import { addScopedGroup, upgradeLegacyGroups } from "./components/workflow-canvas/core/scoped-workflow";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("frontend API contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses account-scoped deletion authorization and preview receipts without forwarding repository names at confirmation", async () => {
    const accountId = `gha_${"a".repeat(32)}`, previewId = "b".repeat(48);
    const repositories = [{ projectId: `prj_${"c".repeat(32)}`, owner: "alice", name: "demo" }];
    const preview = { accountId, accountLogin: "alice", previewId, expiresAt: "2026-10-25T12:00:00.000Z", confirmationText: "永久删除",
      accessToken: "must-not-enter-client-state", repositories: repositories.map(item => ({ ...item, status: "ready", credential: "server-only" })) };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ authorizationUrl: "https://github.com/login/oauth/authorize?scope=repo+delete_repo", expiresAt: preview.expiresAt }))
      .mockResolvedValueOnce(jsonResponse(preview)).mockResolvedValueOnce(jsonResponse({ ...preview, repositories: repositories.map(item => ({ ...item, status: "deleted" })) }));
    vi.stubGlobal("fetch", fetchMock);
    await startGitHubRepositoryDeletionAuthorization(accountId);
    const prepared = await previewGitHubRepositoryDeletion(accountId, repositories);
    expect(JSON.stringify(prepared)).not.toMatch(/credential|accessToken|server-only/);
    const result = await deleteGitHubRepositories(accountId, prepared.previewId, prepared.confirmationText);
    expect(result.repositories[0]!.status).toBe("deleted");
    expect(fetchMock.mock.calls[0]![0]).toBe(`./api/github/accounts/${accountId}/repository-deletion-authorization`);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ repositories });
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({ previewId, confirmationText: "永久删除" });
  });

  it("rejects malformed repository deletion outcomes instead of rendering them as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ previewId: "a".repeat(48), accountId: `gha_${"b".repeat(32)}`,
      accountLogin: "alice", expiresAt: "2026-10-25T12:00:00.000Z", confirmationText: "永久删除",
      repositories: [{ projectId: "project", owner: "alice", name: "demo", status: "success" }] })));
    await expect(deleteGitHubRepositories(`gha_${"b".repeat(32)}`, "a".repeat(48), "永久删除")).rejects.toThrow("有效的仓库删除结果");
  });

  it.each([["", undefined], [" \t\n ", undefined], [" research-draft ", "research-draft"], ["invalid/name", "invalid/name"]])(
    "syncs an unfinished Git draft without sending a blank repository name (%j)", async (repositoryName, expected) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);
      const git = { enabled: true, provider: "github" as const, accountId: `gha_${"b".repeat(32)}`,
        repositoryVisibility: "private" as const, repositoryName };
      await syncExplainerConversation(`exp_${"a".repeat(32)}`, { expectedRevision: 4,
        draft: { title: "待完善的研究草稿", requirement: "稍后填写仓库名", agents: DEFAULT_AGENTS,
          orchestration: DEFAULT_AGENT_ORCHESTRATION, git } });
      const payload = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
      expect(payload.expectedRevision).toBe(4);
      expect(payload.draft.git).toEqual({ enabled: true, provider: "github", accountId: git.accountId,
        repositoryVisibility: "private", ...(expected ? { repositoryName: expected } : {}) });
      expect(git.repositoryName).toBe(repositoryName);
    }
  );

  it("preserves Unicode and special characters in input paths and uses the generic directory endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const relativePath = "研究 资料/图表 &+#%.png";
    const file = new File(["image bytes"], "图表 &+#%.png", { type: "image/png" });
    await uploadProjectInputFile("upload-token", relativePath, file);
    await removeProjectInputFile("upload-token", relativePath);
    await openProjectInputDirectory("upload-token");
    for (const call of fetchMock.mock.calls.slice(0, 2)) {
      const url = new URL(call[0], "http://localhost/");
      expect(url.pathname).toBe("/api/project-input-uploads/upload-token/files");
      expect([...url.searchParams]).toEqual([["path", relativePath]]);
    }
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "PUT", body: file });
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock.mock.calls[2]).toEqual([
      "./api/project-input-uploads/upload-token/open-directory", expect.objectContaining({ method: "POST" })
    ]);
  });

  it("uses proxy-relative Agent recommendation endpoints and returns only allowed tool fields", async () => {
    const fingerprint = "c".repeat(64);
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ fingerprint }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getAgentToolRecommendationCatalog()).toMatchObject({ fingerprint });
    expect(fetchMock.mock.calls[0]![0]).toBe("./api/agent-tool-recommendations/catalog");
    const projectId = `prj_${"b".repeat(32)}`;
    await getAgentToolRecommendationCatalog(projectId);
    expect(fetchMock.mock.calls[1]![0]).toBe(`./api/agent-tool-recommendations/catalog?projectId=${projectId}`);
    const selection = { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false };
    fetchMock.mockImplementation(async () => jsonResponse({ targetAgent: "idea", contextFingerprint: "request-token",
      configurationFingerprint: "e".repeat(64), catalogFingerprint: fingerprint,
      selection: { ...selection, permission: "yolo", instructions: "unexpected" }, reasons: ["无需额外工具"], warnings: [] }));
    const input = { title: "Research", requirement: "Inspect evidence", agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION,
      targetAgent: "idea", contextFingerprint: "request-token", configurationFingerprint: "e".repeat(64), catalogFingerprint: fingerprint };
    expect((await recommendAgentTools(input)).selection).toEqual(selection);
    expect(fetchMock.mock.calls[2]![0]).toBe("./api/agent-tool-recommendations");
    const body = JSON.parse(fetchMock.mock.calls[2]![1].body);
    expect(body).toMatchObject({ targetAgent: "idea", contextFingerprint: "request-token", configurationFingerprint: input.configurationFingerprint });
    expect(body).not.toHaveProperty("advisor");
    fetchMock.mockImplementation(async () => jsonResponse({ selection: { ...selection, skills: [42] }, reasons: [], warnings: [] }));
    await expect(recommendAgentTools(input)).rejects.toThrow("返回格式无效");
  });

  it("reads the shared draft/project Explainer config and preserves its recommendation fingerprint", async () => {
    const config = { schemaVersion: 2, harness: "codex", gatewayId: "gateway", nativeProtocol: "responses", gatewayProtocol: "responses",
      model: "explainer-model", reasoningEffort: "high", revision: 3, updatedAt: "", available: true, routeMode: "direct" };
    const fingerprint = "e".repeat(64);
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ config, fingerprint }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getRecommendationExplainerConfig()).toMatchObject({ config: { harness: "codex", model: "explainer-model" }, fingerprint });
    expect(fetchMock.mock.calls[0]![0]).toBe("./api/config-recommendations/explainer");
    const projectId = `prj_${"b".repeat(32)}`;
    await getRecommendationExplainerConfig(projectId);
    expect(fetchMock.mock.calls[1]![0]).toBe(`./api/config-recommendations/explainer?projectId=${projectId}`);
    const input = { harness: "codex", gatewayId: "gateway", model: "explainer-model", reasoningEffort: "high" as const };
    expect(await updateRecommendationExplainerConfig(input)).toMatchObject({ fingerprint });
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: "PATCH", body: JSON.stringify(input) });
    fetchMock.mockImplementation(async () => jsonResponse({ config, fingerprint: "invalid" }));
    await expect(getRecommendationExplainerConfig()).rejects.toThrow("配置版本无效");
  });

  it("recommends from attachments and a scoped Git draft while stripping runtime Agent metadata", async () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    const agents = structuredClone(DEFAULT_AGENTS);
    Object.assign(agents.main, { reasoningEffort: "high", legacyReasoningEffort: "high", reasoningMigrationWarning: "old setting", gatewaySnapshot: { apiKey: "secret-must-not-be-sent" } });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ recommendation: { agents: DEFAULT_AGENTS, orchestration }, warnings: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await recommendProjectConfig({ title: "Attached scoped task", requirement: "Analyze supplied files and images.",
      agents, orchestration, git: { enabled: true }, advisor: { gatewayId: "gateway", model: "advisor" },
      inputUploadId: "upload-token", inputDescription: "Reference measurements and design." });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ inputUploadId: "upload-token", inputDescription: "Reference measurements and design.",
      git: { enabled: true }, orchestration: { schemaVersion: 3, scopedWorkflow: orchestration.scopedWorkflow } });
    expect(body.agents.main).not.toHaveProperty("gatewaySnapshot");
    expect(body.agents.main).not.toHaveProperty("reasoningEffort");
    expect(body.agents.main).not.toHaveProperty("legacyReasoningEffort");
    expect(body.agents.main).not.toHaveProperty("reasoningMigrationWarning");
    expect(JSON.stringify(body)).not.toContain("secret-must-not-be-sent");
  });

  it("reads real recommendation phases and the result across split UTF-8 stream chunks", async () => {
    const phases = [
      { type: "progress", phase: "preparing", message: "正在准备材料" },
      { type: "progress", phase: "generation", message: "正在生成推荐" },
      { type: "progress", phase: "validation", message: "正在校验推荐" }
    ];
    const result = { recommendation: { agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION }, warnings: [], configurationFingerprint: "e".repeat(64) };
    const bytes = new TextEncoder().encode([...phases, { type: "complete", result }].map(event => JSON.stringify(event)).join("\r\n"));
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < bytes.length; index += 17) controller.enqueue(bytes.slice(index, index + 17));
      controller.close();
    } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "application/x-ndjson" } }));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn(), signal = new AbortController().signal;
    const value = await recommendProjectConfig({ title: "研究任务", requirement: "分析给定材料并输出方案", agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION }, signal, progress);
    expect(value).toEqual(result);
    expect(progress.mock.calls.map(([event]) => event)).toEqual(phases.map(({ type: _type, ...event }) => event));
    expect(fetchMock).toHaveBeenCalledWith("./api/config-recommendations", expect.objectContaining({ signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" } }));
  });

  it.each(["error", "interrupted"])("rejects a recommendation %s stream instead of returning a partial result", async (kind) => {
    const payload = kind === "error" ? { type: "error", message: "模型暂时不可用", status: 503 } : { type: "progress", phase: "generation", message: "正在生成推荐" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "content-type": "application/x-ndjson" } })));
    const result = recommendProjectConfig({ title: "研究任务", requirement: "分析给定材料并输出方案", agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION }, undefined, vi.fn());
    if (kind === "error") await expect(result).rejects.toMatchObject({ message: "模型暂时不可用", status: 503 });
    else await expect(result).rejects.toThrow("连接已中断");
  });

  it.each(["immediate", "pending"])("returns the complete recommendation without waiting for connection shutdown or %s cleanup", async (cleanup) => {
    const result = { recommendation: { agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION }, warnings: [], configurationFingerprint: "e".repeat(64) };
    let connection!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => cleanup === "pending" ? new Promise<void>(() => {}) : undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connection = controller;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "complete", result }) + "\n"));
      },
      cancel
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "application/x-ndjson" } })));
    let received: unknown;
    const pending = recommendProjectConfig({ title: "研究任务", requirement: "分析给定材料并输出方案", agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION }, undefined, vi.fn())
      .then(value => { received = value; });
    try {
      await vi.waitFor(() => expect(received).toEqual(result), { timeout: 500 });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      if (!cancel.mock.calls.length) connection.close();
      await pending;
    }
  });

  it("stops consuming recommendation progress when the request is cancelled", async () => {
    const abort = new AbortController();
    const payload = [
      { type: "progress", phase: "generation", message: "正在生成推荐" },
      { type: "progress", phase: "validation", message: "不应显示的迟到进度" }
    ].map(event => JSON.stringify(event)).join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload, { headers: { "content-type": "application/x-ndjson" } })));
    const progress = vi.fn(() => abort.abort());
    await expect(recommendProjectConfig({ title: "研究任务", requirement: "分析给定材料并输出方案", agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION }, abort.signal, progress)).rejects.toThrow();
    expect(progress).toHaveBeenCalledOnce();
  });

  it("bounds an unresponsive Explainer configuration lookup", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const pending = getRecommendationExplainerConfig().catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await pending).message).toContain("30 秒");
      expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("ends an open recommendation stream that never sends a terminal result", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"progress","phase":"generation","message":"正在生成"}\n')); },
      cancel
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "application/x-ndjson" } }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = recommendProjectConfig({ title: "研究任务", requirement: "分析给定材料并输出方案", agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION }, undefined, vi.fn()).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(630_001);
      expect((await pending).message).toContain("10 分 30 秒");
      expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("preserves scoped v3 definitions when saving and reading a research task", async () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    addScopedGroup(orchestration, { id: "research", displayName: "Research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
    const task = {
      schemaVersion: 2, kind: "scienceevolve-saved-research-task", id: "task_scoped_000000000000000000000001",
      title: "Scoped draft", requirement: "Save a scoped workflow draft", agents: DEFAULT_AGENTS,
      orchestration, createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task }));
    vi.stubGlobal("fetch", fetchMock);
    const saved = await createSavedResearchTask({ title: task.title, requirement: task.requirement, agents: DEFAULT_AGENTS, orchestration });
    const payload = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(payload.orchestration.schemaVersion).toBe(3);
    expect(payload.orchestration.scopedWorkflow.groups[0].leaderAgentId).toBe("main");
    expect(payload.orchestration.scopedWorkflow.groups[0].workflow.input.edges).toHaveLength(2);
    expect(saved.orchestration.schemaVersion).toBe(3);
    expect(saved.orchestration.scopedWorkflow?.rootAgentIds).toContain("idea");
  });

  it("surfaces structured validation issues from older generic server errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: "Invalid request",
      issues: [{
        code: "custom",
        path: ["agents", "main"],
        message: "main Agent 的全局网关网络目标校验失败：网关域名不存在"
      }]
    }, 400)));

    await expect(createProject({
      title: "自动科研",
      requirement: "完成端到端研究和论文评审",
      agents: DEFAULT_AGENTS
    })).rejects.toThrow(
      "请求参数无效：agents.main：main Agent 的全局网关网络目标校验失败：网关域名不存在"
    );
  });

  it("posts the five-agent project payload unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_123",
          title: "自动科研",
          requirement: "完成端到端研究和论文评审",
          status: "queued",
          cycle: 1,
          agents: DEFAULT_AGENTS
        }
      }, 202)
    );
    vi.stubGlobal("fetch", fetchMock);

    const project = await createProject({
      title: "自动科研",
      requirement: "完成端到端研究和论文评审",
      agents: DEFAULT_AGENTS
    });

    expect(project.id).toBe("prj_123");
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "自动科研",
          requirement: "完成端到端研究和论文评审",
          agents: DEFAULT_AGENTS
        })
      })
    );
  });

  it("requests a gateway credential only through the explicit reveal action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ apiKey: "temporary-visible-secret" })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(revealGatewayCredential("gwy_credential/test")).resolves.toBe(
      "temporary-visible-secret"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/gateways/gwy_credential%2Ftest/credential/reveal",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("normalizes credential-free GitHub accounts and uses dedicated account actions", async () => {
    const account = {
      id: "gha_11111111111111111111111111111111",
      login: "alice",
      providerUserId: 7,
      status: "ready",
      scopes: ["repo"],
      isDefault: true,
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      accessToken: "must-not-cross-the-api"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        accounts: [account, { id: "malformed" }],
        defaultAccountId: account.id,
        oauthConfigured: true
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
        expiresAt: "2026-09-24T08:10:00.000Z"
      }))
      .mockResolvedValueOnce(jsonResponse({ account }))
      .mockResolvedValueOnce(jsonResponse({ account }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await getGitHubAccounts();
    expect(catalog.accounts).toHaveLength(1);
    expect(catalog.accounts[0]).not.toHaveProperty("accessToken");
    await expect(startGitHubAuthorization()).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining("github.com/login/oauth/authorize")
    });
    await expect(verifyGitHubAccount(account.id)).resolves.toMatchObject({ login: "alice" });
    await expect(setDefaultGitHubAccount(account.id)).resolves.toMatchObject({ isDefault: true });
    await expect(deleteGitHubAccount(account.id)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(2, "./api/github/auth/start", expect.objectContaining({
      method: "POST"
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      `./api/github/accounts/${account.id}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("sends batch archive and destructive deletion confirmations through their dedicated APIs", async () => {
    const first = "prj_11111111111111111111111111111111";
    const second = "prj_22222222222222222222222222222222";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        successCount: 99,
        failureCount: 99,
        results: [
          { projectId: first, ok: true },
          { projectId: second, ok: false, error: "状态已变化" }
        ]
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ projectId: first, ok: true }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(archiveProjects([first, second])).resolves.toMatchObject({
      successCount: 1,
      failureCount: 1,
      results: [
        { projectId: first, ok: true },
        { projectId: second, ok: false, error: "状态已变化" }
      ]
    });
    await expect(deleteArchivedProject(first, "待删除项目")).resolves.toBeUndefined();
    await expect(deleteArchivedProjects([first], "永久删除")).resolves.toMatchObject({
      successCount: 1,
      failureCount: 0
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "./api/projects/archive/batch", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ projectIds: [first, second] })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `./api/projects/${first}`, expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ confirmation: "待删除项目" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "./api/projects/delete/batch", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ projectIds: [first], confirmation: "永久删除" })
    }));
  });

  it("keeps canvas layout but omits frontend-only runtime preferences from server payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_canvas",
          title: "Canvas contract",
          requirement: "Verify frontend-only fields.",
          status: "queued",
          cycle: 1,
          agents: DEFAULT_AGENTS
        }
      }, 202)
    );
    vi.stubGlobal("fetch", fetchMock);
    const orchestration = normalizeAgentOrchestration(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.allowMainReconfiguration = true;
    orchestration.routes.idea = [{ target: "execution", kind: "strong" }];
    orchestration.routes.execution = [{ target: "idea", kind: "strong" }];
    orchestration.loops = [{
      id: "drafting",
      from: "execution",
      to: "idea",
      maxIterations: 3,
      exitTo: "writing"
    }];
    const agents = structuredClone(DEFAULT_AGENTS);
    agents.main.gatewaySnapshot = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "只读运行快照",
      url: "https://gateway.example.test/v1",
      models: ["nex-agi/Nex-N2-Pro"],
      defaultModel: "nex-agi/Nex-N2-Pro",
      protocol: "responses"
    };
    await createProject({
      title: "Canvas contract",
      requirement: "Verify frontend-only fields.",
      agents,
      orchestration
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as {
      agents: Record<string, Record<string, unknown>>;
      orchestration: Record<string, unknown>;
    };
    expect(payload.orchestration).not.toHaveProperty("sessionPersistence");
    expect(payload.orchestration).not.toHaveProperty("weakDecisionBy");
    expect(payload.orchestration).toHaveProperty("canvas");
    expect(payload.orchestration).toHaveProperty(
      "allowMainReconfiguration",
      true
    );
    expect(payload.orchestration).toHaveProperty("loops", orchestration.loops);
    expect((payload.orchestration.routes as Record<string, unknown>)).not.toHaveProperty("main");
    expect(payload.agents.main).not.toHaveProperty("gatewaySnapshot");
  });

  it("sends custom Agent role descriptions while preserving canvas layout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_description",
          title: "Description contract",
          requirement: "Verify role descriptions.",
          status: "queued",
          cycle: 1,
          agents: DEFAULT_AGENTS
        }
      }, 202)
    );
    vi.stubGlobal("fetch", fetchMock);
    const orchestration = normalizeAgentOrchestration(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.agents = orchestration.agents.map((entry) =>
      entry.name === "idea" ? { ...entry, description: "  研究问题与假设  " } : entry
    );
    orchestration.agentTemplates = [{ name: "verifier_agent", template: "review", description: "核验交付质量" }];
    orchestration.canvas = {
      schemaVersion: 1,
      nodes: { idea: { x: 12, y: 34 } },
      edges: {},
      viewport: { x: 0, y: 0, zoom: 0.82 },
      layoutMode: "free"
    };

    await createProject({
      title: "Description contract",
      requirement: "Verify role descriptions.",
      agents: DEFAULT_AGENTS,
      orchestration
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as { orchestration: { agents: Array<Record<string, unknown>>; agentTemplates: Array<Record<string, unknown>>; canvas: unknown } };
    expect(payload.orchestration.agents.find((entry) => entry.name === "idea")).toEqual({
      name: "idea",
      template: "idea",
      description: "研究问题与假设"
    });
    expect(payload.orchestration.canvas).toEqual(orchestration.canvas);
    expect(payload.orchestration.agentTemplates).toEqual(orchestration.agentTemplates);
  });

  it("reads skills and model suggestions from the shared catalog endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          skills: [
            {
              id: "builtin:latex-writer",
              name: "latex-writer",
              description: "Write LaTeX"
            }
          ],
          models: ["model-a", "model-b"],
          defaultHarnessId: "fixture-harness",
          routerCompatibilityVersion: "5",
          harnesses: [
            {
              schemaVersion: 1,
              id: "fixture-harness",
              label: "Fixture Harness",
              adapterVersion: "test-1",
              nativeProtocol: "responses",
              purposes: ["workflow", "explainer", "probe"],
              // A legacy or malformed payload must not reintroduce private
              // execution metadata into the normalized browser Catalog.
              executableEnv: "SCIENCEEVOLVE_FIXTURE_HARNESS_BIN",
              defaultCommand: "/private/bin/fixture-harness",
              route: { requireMainControlTools: true },
              default: true,
              mode: "workflow",
              notes: "Contract fixture adapter",
              capabilities: {
                structuredEvents: true,
                toolResults: true,
                durableSession: true,
                permissionPrompts: ["workspace", "compute", "yolo"],
                workspaceInputs: true,
                autoSkills: true,
                officialEvents: true,
                toolEvents: true,
                usageEvents: true,
                readOnlyExplainer: true,
                webSearch: true,
                skills: true,
                mcp: true
              },
              available: false,
              availabilityReason: "测试入口不可执行"
            }
          ]
        })
      )
    );

    await expect(getCatalog()).resolves.toEqual({
      skills: [
        {
          id: "builtin:latex-writer",
          name: "latex-writer",
          description: "Write LaTeX",
          category: undefined
        }
      ],
      models: ["model-a", "model-b"],
      defaultHarnessId: "fixture-harness",
      routerCompatibilityVersion: "5",
      harnesses: [
        {
          schemaVersion: 1,
          id: "fixture-harness",
          label: "Fixture Harness",
          adapterVersion: "test-1",
          nativeProtocol: "responses",
          purposes: ["workflow", "explainer", "probe"],
          default: true,
          mode: "workflow",
          notes: "Contract fixture adapter",
          capabilities: {
            structuredEvents: true,
            toolResults: true,
            durableSession: true,
            permissionPrompts: ["workspace", "compute", "yolo"],
            workspaceInputs: true,
            autoSkills: true,
            officialEvents: true,
            toolEvents: true,
            usageEvents: true,
            readOnlyExplainer: true,
            webSearch: true,
            skills: true,
            mcp: true,
            assistantStreaming: "native"
          },
          available: false,
          availabilityReason: "测试入口不可执行",
          routerCompatibilityVersion: "5"
        }
      ],
      agentPrompts: {}
    });
  });

  it("keeps an unselectable built-in Harness in Catalog metadata without making it the default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      skills: [], models: [], defaultHarnessId: "claude-code",
      harnesses: ["codex", "dsh", "pi", "claude-code"].map((id) => ({
        id, label: id, nativeProtocol: "responses",
        ...(id === "claude-code" ? { userSelectable: false } : {}),
        purposes: ["workflow", "probe"], capabilities: {}, available: true
      }))
    })));
    const catalog = await getCatalog();
    expect(catalog.harnesses?.map((item) => item.id)).toEqual(["codex", "dsh", "pi", "claude-code"]);
    expect(catalog.harnesses?.at(-1)).toMatchObject({ id: "claude-code", selectable: false });
    expect(catalog.defaultHarnessId).toBeUndefined();
  });

  it("loads project explainer history and streams split NDJSON deltas", async () => {
    const userEvent = {
      id: "explainer_event_user",
      projectId: "prj_123",
      turnId: "explainer_turn_1",
      kind: "user",
      text: "当前项目进展如何？",
      ts: "2026-08-08T00:00:00.000Z",
      phase: "completed"
    } as const;
    const assistantDelta = {
      id: "explainer_event_delta",
      projectId: "prj_123",
      turnId: "explainer_turn_1",
      itemId: "answer_1",
      kind: "assistant",
      text: "已经完成实验。",
      ts: "2026-08-08T00:00:01.000Z",
      phase: "delta"
    } as const;
    const encoder = new TextEncoder();
    const streamPayload = `${JSON.stringify(userEvent)}\n${JSON.stringify(
      assistantDelta
    )}\n`;
    const splitAt = streamPayload.indexOf("assistant") + 4;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [userEvent, { invalid: true }],
          active: true
        })
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(streamPayload.slice(0, splitAt)));
              controller.enqueue(encoder.encode(streamPayload.slice(splitAt)));
              controller.close();
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson" }
          }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjectExplainerHistory("prj_123", 25)).resolves.toEqual({
      events: [userEvent],
      active: true
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "./api/projects/prj_123/explainer/history?limit=25",
      expect.objectContaining({ headers: expect.any(Object) })
    );

    const streamed: unknown[] = [];
    await streamProjectExplainerQuestion(
      "prj_123",
      "当前项目进展如何？",
      (event) => {
        streamed.push(event);
      }
    );
    expect(streamed).toEqual([userEvent, assistantDelta]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "./api/projects/prj_123/explainer/turns",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/x-ndjson, application/json",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ question: "当前项目进展如何？" })
      })
    );

    await expect(resetProjectExplainer("prj_123")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "./api/projects/prj_123/explainer/reset",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "application/json" })
      })
    );

    await expect(cancelProjectExplainer("prj_123")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "./api/projects/prj_123/explainer/turns/cancel",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "application/json" })
      })
    );
  });

  it("lists reusable Agent presets and saves a complete project configuration", async () => {
    const customAgents = {
      ...DEFAULT_AGENTS,
      execution: {
        ...DEFAULT_AGENTS.execution,
        model: "preset-execution-model",
        reasoningEffort: "xhigh" as const,
        instructions: "Preset execution prompt",
        skills: ["builtin:experiment-runner", "builtin:inspire"],
        autoSkills: ["builtin:nature-figure"],
        mcpServers: [
          { name: "metrics", url: "https://metrics.example.test/mcp" }
        ],
        webSearch: true
      }
    };
    const preset = {
      schemaVersion: 2,
      kind: "scienceevolve-agent-config-preset",
      id: "cfg_00000000000000000000000000000001",
      name: "实验配置预设",
      builtin: false,
      sourceProjectId: "prj_00000000000000000000000000000001",
      sourceProjectTitle: "实验项目",
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      agents: customAgents,
      orchestration: normalizeAgentOrchestration(DEFAULT_AGENT_ORCHESTRATION)
    };
    const normalizedPreset = {
      ...preset,
      agents: normalizeAgents(preset.agents, preset.orchestration)
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ preset }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAgentConfigPresets()).resolves.toEqual([normalizedPreset]);
    await expect(
      saveProjectAgentConfigPreset(preset.sourceProjectId, "用户命名配置")
    ).resolves.toEqual(normalizedPreset);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `./api/projects/${preset.sourceProjectId}/agent-config-preset`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "用户命名配置" })
      })
    );

    await expect(deleteAgentConfigPreset(preset.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `./api/agent-config-presets/${preset.id}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("creates, reads, updates and deletes reusable saved research tasks", async () => {
    const task = {
      schemaVersion: 2,
      kind: "scienceevolve-saved-research-task",
      id: "task_00000000000000000000000000000001",
      title: "可复用科研任务",
      requirement: "保存任务内容以及全部五类智能体的完整配置。",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      agents: DEFAULT_AGENTS,
      orchestration: normalizeAgentOrchestration(DEFAULT_AGENT_ORCHESTRATION),
      git: { enabled: false }
    } as const;
    const updated = {
      ...task,
      title: "编辑后的科研任务",
      updatedAt: "2026-08-08T01:00:00.000Z"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tasks: [task] }))
      .mockResolvedValueOnce(jsonResponse({ task }))
      .mockResolvedValueOnce(jsonResponse({ task }, 201))
      .mockResolvedValueOnce(jsonResponse({ task: updated }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSavedResearchTasks()).resolves.toEqual([task]);
    await expect(getSavedResearchTask(task.id)).resolves.toEqual(task);
    const input = {
      title: task.title,
      requirement: task.requirement,
      agents: DEFAULT_AGENTS
    };
    await expect(createSavedResearchTask(input)).resolves.toEqual(task);
    await expect(
      updateSavedResearchTask(task.id, { ...input, title: updated.title })
    ).resolves.toEqual(updated);
    await expect(deleteSavedResearchTask(task.id)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "./api/saved-research-tasks",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `./api/saved-research-tasks/${task.id}`,
      expect.objectContaining({ method: "PUT" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      `./api/saved-research-tasks/${task.id}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("loads lightweight project state and paged event history", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          project: {
            id: "prj_fast",
            title: "Fast workspace",
            requirement: "Keep event bootstrap bounded.",
            status: "running",
            phase: "execution:running",
            cycle: 1,
            agents: DEFAULT_AGENTS
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            {
              seq: 100,
              type: "agent.trace",
              agent: "execution",
              message: "latest trace",
              ts: "2026-08-03T00:00:00.000Z"
            }
          ],
          timelineEvents: [
            {
              seq: 1,
              type: "agent.started",
              agent: "idea",
              message: "",
              ts: "2026-08-02T00:00:00.000Z",
              data: { invocationId: "inv_idea" }
            }
          ],
          totalEvents: 100,
          lastSeq: 100
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            {
              seq: 99,
              type: "agent.trace",
              agent: "execution",
              message: "older trace",
              ts: "2026-08-02T23:59:59.000Z"
            }
          ],
          hasMore: true
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProject("prj_fast")).resolves.toMatchObject({
      id: "prj_fast",
      status: "running"
    });
    await expect(getProjectEventBootstrap("prj_fast", 1_000)).resolves.toMatchObject({
      totalEvents: 100,
      lastSeq: 100,
      events: [{ seq: 100 }],
      timelineEvents: [{ seq: 1 }]
    });
    await expect(getProjectEventHistory("prj_fast", 100, 1_000)).resolves.toMatchObject({
      hasMore: true,
      events: [{ seq: 99 }]
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "./api/projects/prj_fast?view=state",
      "./api/projects/prj_fast/events/bootstrap?limit=1000",
      "./api/projects/prj_fast/events/history?before=100&limit=1000"
    ]);
  });

  it("creates a user-authored SKILL.md before adding it to the checkbox candidates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        skill: {
          id: "external:user:evidence-audit-a1b2c3",
          name: "证据一致性检查",
          description: "Audit research evidence",
          source: "external"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createUserSkill("证据一致性检查", "Audit research evidence")).resolves.toEqual({
      id: "external:user:evidence-audit-a1b2c3",
      name: "证据一致性检查",
      description: "Audit research evidence",
      category: undefined
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/skills",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "证据一致性检查",
          content: "Audit research evidence"
        })
      })
    );
  });

  it("reads the per-role scheduler queue snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        queue: {
          main: { capacity: 10, activeProjectIds: [], queued: [] },
          worker: {
            capacity: 10,
            activeProjectIds: ["prj_active", "prj_active_2"],
            queued: [
              {
                projectId: "prj_waiting",
                position: 1,
                enteredAt: "2026-07-30T10:00:00.000Z"
              }
            ]
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getQueue()).resolves.toEqual({
      worker: {
        capacity: 10,
        activeProjectIds: ["prj_active", "prj_active_2"],
        queued: [
          {
            projectId: "prj_waiting",
            position: 1,
            enteredAt: "2026-07-30T10:00:00.000Z"
          }
        ]
      },
      main: { capacity: 10, activeProjectIds: [], queued: [] }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/queue",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" })
      })
    );
  });

  it.each([false, true])("requests display summaries with archived projects enabled: %s", async (includeArchived) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjects(includeArchived)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      includeArchived ? "./api/projects?view=summary&includeArchived=true" : "./api/projects?view=summary",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" })
      })
    );
  });

  it("uses the shared-workspace artifact content query", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("\\\\section{Method}", {
          status: 200,
          headers: { "content-type": "text/plain" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getArtifact("prj_123", {
      path: "paper/main.tex",
      name: "main.tex",
      kind: "latex",
    });

    expect(result.content).toBe("\\\\section{Method}");
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/projects/prj_123/artifacts/content?path=paper%2Fmain.tex&origin=workspace",
      expect.objectContaining({
        headers: { Accept: "text/plain, application/json" }
      })
    );
  });

  it("uses explicit workspace sources for live project files and keeps all source variants", async () => {
    const live = { id: "workspace:repository:report.md", path: "report.md", producer: "shared", workspaceId: "repository", workspaceLabel: "项目文件" };
    const branch = { ...live, id: "workspace:branch:report.md", workspaceId: `worktree_${"a".repeat(24)}`, workspaceLabel: "工作区 · writer" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ agent: "shared", directory: "", entries: [{ ...live, type: "file", variants: [live, branch] }], total: 1, offset: 0, limit: 50, hasMore: false }))
      .mockResolvedValueOnce(new Response("# Live report", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const directory = await getArtifactDirectory("prj_123", { scope: "project" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("./api/projects/prj_123/artifacts?view=directory&scope=project");
    expect(directory.entries[0].variants).toHaveLength(2);
    expect(directory.entries[0].variants?.[1].workspaceId).toBe(branch.workspaceId);
    const content = await getArtifact("prj_123", directory.entries[0]);
    expect(content.content).toBe("# Live report");
    const url = new URL(String(fetchMock.mock.calls[1][0]), "https://fixture.test");
    expect(url.searchParams.get("workspaceId")).toBe("repository");
    expect(url.searchParams.has("artifactId")).toBe(false);
    const download = new URL(getArtifactDownloadUrl("prj_123", directory.entries[0]), "https://fixture.test");
    expect(download.searchParams.get("workspaceId")).toBe("repository");
    expect(download.searchParams.get("download")).toBe("1");
    expect(download.searchParams.has("artifactId")).toBe(false);
  });

  it("loads artifact counts/pages on demand and addresses workspace content by agent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          groups: { idea: 2, main: 1, execution: 0, writing: 0, review: 0 },
          total: 3,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          agent: "idea",
          directory: "",
          entries: [
            {
              type: "directory",
              name: "results",
              path: "results",
              producer: "idea",
              origin: "workspace",
              updatedAt: "2026-08-01T00:00:00.000Z"
            },
            {
              type: "file",
              name: "proposal.md",
              path: "proposal.md",
              producer: "idea",
              origin: "workspace",
              size: 19,
              updatedAt: "2026-08-01T00:00:00.000Z",
              mediaType: "text/markdown"
            }
          ],
          offset: 0,
          limit: 50,
          total: 2,
          hasMore: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          groups: { idea: 2, main: 1, execution: 0, writing: 0, review: 0 },
          total: 3,
          artifacts: [
            {
              id: "art_idea",
              path: "proposal.md",
              producer: "idea",
              origin: "workspace",
              size: 19,
              updatedAt: "2026-08-01T00:00:00.000Z"
            }
          ],
          offset: 0,
          limit: 100,
          hasMore: false
        })
      )
      .mockResolvedValueOnce(
        new Response("# proposal", {
          status: 200,
          headers: { "content-type": "text/markdown" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getArtifactSummary("prj_123")).resolves.toMatchObject({
      total: 3,
      groups: { idea: 2, main: 1 }
    });
    const directory = await getArtifactDirectory("prj_123", {
      agent: "idea",
      offset: 0,
      limit: 50
    });
    expect(directory).toMatchObject({
      agent: "idea",
      directory: "",
      total: 2,
      hasMore: false
    });
    expect(directory.entries).toEqual([
      expect.objectContaining({ type: "directory", path: "results" }),
      expect.objectContaining({
        type: "file",
        path: "proposal.md",
        kind: "markdown",
        agent: "idea"
      })
    ]);
    const page = await getArtifactPage("prj_123", {
      agent: "idea",
      offset: 0,
      limit: 100
    });
    expect(page.artifacts[0]).toMatchObject({
      path: "proposal.md",
      agent: "idea",
      origin: "workspace"
    });
    await expect(
      getArtifact("prj_123", page.artifacts[0]!)
    ).resolves.toMatchObject({ content: "# proposal" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "./api/projects/prj_123/artifacts?view=summary",
      "./api/projects/prj_123/artifacts?view=directory&agent=idea&offset=0&limit=50",
      "./api/projects/prj_123/artifacts?agent=idea&offset=0&limit=100",
      "./api/projects/prj_123/artifacts/content?path=proposal.md&origin=workspace&agent=idea&artifactId=art_idea"
    ]);
  });

  it("reads an accepted display through its immutable artifact and commit binding", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("# accepted version", {
        status: 200,
        headers: { "content-type": "text/markdown" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDisplayedFile("prj_123", {
      agent: "idea",
      path: "results/report.md",
      title: "Accepted report",
      artifactId: "artifact_accepted",
      commitSha: "a".repeat(40)
    })).resolves.toMatchObject({
      id: "artifact_accepted",
      commitSha: "a".repeat(40),
      content: "# accepted version"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `./api/projects/prj_123/artifacts/content?path=results%2Freport.md&origin=workspace&agent=idea&artifactId=artifact_accepted&commitSha=${"a".repeat(40)}`,
      expect.objectContaining({
        headers: { Accept: "text/plain, application/json" }
      })
    );
  });

  it("builds a scoped streaming-download URL for a shared workspace file", () => {
    expect(
      getArtifactDownloadUrl("prj_123", {
        path: "results/model final.bin",
        name: "model final.bin",
        kind: "text",
        agent: "execution",
        origin: "workspace"
      })
    ).toBe(
      "./api/projects/prj_123/artifacts/content?path=results%2Fmodel+final.bin&download=1&origin=workspace&agent=execution"
    );
  });

  it("keeps the event stream relative to a notebook proxy prefix", () => {
    expect(eventStreamUrl("prj_123", 9)).toBe(
      "./api/projects/prj_123/events?after=9"
    );
  });

  it("posts a user intervention response to the project Main endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_123",
          title: "等待授权",
          requirement: "用户完成 GitHub 登录后继续研究。",
          status: "queued",
          phase: "main:queued",
          cycle: 1,
          agents: DEFAULT_AGENTS,
          userIntervention: {
            id: "usr_123",
            status: "answered",
            requestedAt: "2026-07-31T08:00:00.000Z",
            answeredAt: "2026-07-31T08:05:00.000Z",
            message: "请完成 GitHub 登录。",
            rationale: "需要用户授权。",
            successCriteria: ["确认登录成功。"],
            response: "已经登录。"
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const project = await respondToUserIntervention(
      "prj_123",
      "已经登录。"
    );

    expect(project.userIntervention?.status).toBe("answered");
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/projects/prj_123/intervention/respond",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "已经登录。" })
      })
    );
  });

  it("queues a project-level requirement for the next Main invocation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_123",
          title: "主动需求",
          requirement: "继续当前科研流程。",
          status: "running",
          phase: "execution:running",
          cycle: 1,
          agents: DEFAULT_AGENTS,
          userInputs: [
            {
              id: "inp_123",
              status: "pending",
              createdAt: "2026-07-31T12:00:00.000Z",
              message: "新增不同数据规模的消融实验。",
              targetMainInvocation: 4
            }
          ]
        }
      }, 202)
    );
    vi.stubGlobal("fetch", fetchMock);

    const project = await addProjectUserInput(
      "prj_123",
      "新增不同数据规模的消融实验。"
    );

    expect(project.userInputs).toMatchObject([
      { status: "pending", targetMainInvocation: 4 }
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/projects/prj_123/user-inputs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "新增不同数据规模的消融实验。" })
      })
    );
  });

  it("patches selected Agent models for an existing project", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_123",
          title: "模型更新",
          requirement: "批量更新项目中选定 Agent 的模型配置。",
          status: "running",
          phase: "execution:running",
          cycle: 1,
          agents: {
            ...DEFAULT_AGENTS,
            main: { ...DEFAULT_AGENTS.main, model: "gpt-5.6-terra" },
            execution: {
              ...DEFAULT_AGENTS.execution,
              model: "gpt-5.6-terra"
            }
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateProjectAgentModels("prj_123", {
      main: "gpt-5.6-terra",
      execution: "gpt-5.6-terra"
    });

    expect(updated.agents.main.model).toBe("gpt-5.6-terra");
    expect(updated.agents.execution.model).toBe("gpt-5.6-terra");
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/projects/prj_123/agents/models",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          models: {
            main: "gpt-5.6-terra",
            execution: "gpt-5.6-terra"
          }
        })
      })
    );
  });

  it("patches model, reasoning and explicit experiment selection without a legacy Harness field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_123",
          title: "推理配置更新",
          requirement: "同时更新模型和思考深度。",
          status: "running",
          phase: "execution:running",
          cycle: 1,
          agents: {
            ...DEFAULT_AGENTS,
            execution: {
              ...DEFAULT_AGENTS.execution,
              model: "gpt-5.6-terra",
              gatewayReasoningOption: "xhigh",
              experimentMcp: true,
              mcpServers: [
                { name: "metrics", url: "https://metrics.example.test/mcp" }
              ]
            }
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateProjectAgentConfigs("prj_123", {
      execution: {
        model: "gpt-5.6-terra",
        gatewayReasoningOption: "xhigh",
        experimentMcp: true,
        mcpServers: [
          { name: "metrics", url: "https://metrics.example.test/mcp" }
        ]
      }
    });

    expect(updated.agents.execution).toMatchObject({
      model: "gpt-5.6-terra",
      gatewayReasoningOption: "xhigh",
      experimentMcp: true,
      mcpServers: [
        { name: "metrics", url: "https://metrics.example.test/mcp" }
      ]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/projects/prj_123/agents/config",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          agents: {
            execution: {
              model: "gpt-5.6-terra",
              gatewayReasoningOption: "xhigh",
              experimentMcp: true,
              mcpServers: [
                { name: "metrics", url: "https://metrics.example.test/mcp" }
              ]
            }
          }
        })
      })
    );
  });

  it("patches collaboration groups through the revisioned workflow endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          id: "prj_123",
          title: "协作组更新",
          requirement: "更新当前模板。",
          status: "completed",
          phase: "completed",
          cycle: 1,
          workflowRevision: 2,
          git: { enabled: true, status: "ready", provider: "github" },
          agents: DEFAULT_AGENTS,
          orchestration: {
            ...DEFAULT_AGENT_ORCHESTRATION,
            schemaVersion: 2,
            collaborations: []
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateProjectCollaborationGroup("prj_123", {
      action: "rename",
      groupId: "research_group",
      displayName: "证据整合组",
      requestId: "ui-workflow-1"
    });

    expect(updated.workflowRevision).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "./api/projects/prj_123/workflow/collaboration-groups",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          action: "rename",
          groupId: "research_group",
          displayName: "证据整合组",
          requestId: "ui-workflow-1"
        })
      })
    );
  });

  it("streams gateway connection progress events from ndjson responses", async () => {
    const resultEvent = {
      status: "passed",
      protocol: "responses",
      model: "model-a",
      reasoningOptionId: "high",
      reasoningFingerprint: "a".repeat(64),
      durationMs: 2800,
      stageResults: [
        { stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 2800, httpStatus: 200 },
        { stage: "adapter_smoke", label: "Harness 真实探测", expectation: "harness", stream: false, status: "passed", durationMs: 800 }
      ]
    };
    const gateway = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "Stream gateway",
      url: "https://gateway.example.test/v1",
      models: ["model-a"],
      modelReasoning: {
        "model-a": {
          parameter: "reasoning_effort",
          options: [{ id: "high", label: "高", value: "high" }]
        }
      },
      defaultModel: "model-a",
      protocol: "responses",
      apiKeyConfigured: true,
      test: resultEvent,
      tests: [],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      { type: "stage", stage: { stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "running" } },
      { type: "stage", stage: { stage: "adapter_smoke", label: "Harness 真实探测", expectation: "harness", stream: false, status: "running" } },
      { type: "result", result: resultEvent },
      { type: "complete", gateway, result: resultEvent }
    ].map((event) => JSON.stringify(event)).join("\n"), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const events: Array<{ type: string }> = [];

    const checked = await testGateway("gwy_stream", "model-a", undefined, {
      onProgress: (event) => events.push(event),
      gatewayReasoningOption: "high"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "./api/gateways/gwy_stream/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "model-a", gatewayReasoningOption: "high" }),
        headers: expect.objectContaining({ Accept: "application/x-ndjson" })
      })
    );
    expect(events.map((event) => event.type)).toEqual(["stage", "stage", "result", "complete"]);
    expect(checked.test.stageResults?.[0]).toMatchObject({ stage: "text_ordinary", status: "passed", durationMs: 2800 });
    expect(checked.test.stageResults?.[1]).toMatchObject({ stage: "adapter_smoke", expectation: "harness", status: "passed" });
    expect(checked.test).toMatchObject({ reasoningOptionId: "high", reasoningFingerprint: "a".repeat(64) });
    expect(checked.modelReasoning?.["model-a"]?.options[0]).toEqual({ id: "high", label: "高", value: "high" });
  });

  it("streams gateway matrix progress events from ndjson responses", async () => {
    const gateway = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "Stream gateway",
      url: "https://gateway.example.test/v1",
      models: ["model-a"],
      defaultModel: "model-a",
      protocol: "responses",
      apiKeyConfigured: true,
      test: { status: "untested" },
      tests: [],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z"
    };
    const resultEvent = {
      status: "passed",
      protocol: "responses",
      model: "model-a",
      harness: "codex",
      durationMs: 1200,
      stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 1200, httpStatus: 200 }]
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      { type: "combination-start", harness: "codex", model: "model-a", stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "queued" }] },
      { type: "stage", harness: "codex", model: "model-a", stage: { stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "running" } },
      { type: "result", harness: "codex", model: "model-a", result: resultEvent },
      { type: "complete", gateway, results: [resultEvent] }
    ].map((event) => JSON.stringify(event)).join("\n"), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const events: Array<{ type: string }> = [];

    const matrix = await testGatewayMatrix("gwy_stream", { harnesses: ["codex"], models: ["model-a"] }, {
      onProgress: (event) => events.push(event)
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "./api/gateways/gwy_stream/test-matrix",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "application/x-ndjson" })
      })
    );
    expect(events.map((event) => event.type)).toEqual(["combination-start", "stage", "result", "complete"]);
    expect(matrix.results[0]?.stageResults?.[0]).toMatchObject({ stage: "text_ordinary", status: "passed", durationMs: 1200 });
  });
});
