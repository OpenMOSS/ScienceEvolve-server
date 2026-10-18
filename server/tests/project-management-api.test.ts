import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { ZodError } from "zod";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { SkillCatalog } from "../src/skill-catalog.js";
import type { GitHubAccountStore } from "../src/github-accounts.js";
import type { ProjectState } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("project archive and deletion HTTP APIs", () => {
  it("serves compact list facts while preserving complete project details for existing callers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-list-summary-")); roots.push(root);
    const eventHub = new EventHub();
    const project = {
      id: "prj_summary", title: "Summary", status: "running", requirement: "Research", cycle: 1,
      runtime: { stateRevision: 3, status: "running" },
      orchestration: { agents: [{ name: "main" }], collaborations: [] },
      overallProgress: { percent: 10 },
      tokenUsage: { totalTokens: 42, inputTokens: 40, outputTokens: 2, byAgent: { main: { history: "x".repeat(100_000) } } },
      collaboration: { formalState: "x".repeat(100_000) }, operations: [{ payload: "x".repeat(100_000) }],
      agents: { main: { prompt: "private configuration" } },
      git: { enabled: true, repository: { name: "demo" } }, pullRequests: [{ id: "pr_1", htmlUrl: "https://github.com/a/demo/pull/1" }]
    };
    const app = createApp({
      orchestrator: { listProjects: vi.fn(async () => [project]) } as unknown as Orchestrator,
      storage: new ProjectStorage(root, eventHub), eventHub, skills: {} as SkillCatalog,
      config: { modelSuggestions: [], maxEventHistory: 100 }
    });
    const full = await request(app).get("/api/projects").expect(200);
    const summary = await request(app).get("/api/projects?view=summary&includeArchived=true").expect(200);
    expect(summary.body.projects[0]).toMatchObject({ id: project.id, status: "running", tokenUsage: { totalTokens: 42 },
      git: project.git, pullRequests: project.pullRequests, runtime: project.runtime });
    expect(summary.body.projects[0]).not.toHaveProperty("collaboration");
    expect(summary.body.projects[0]).not.toHaveProperty("operations");
    expect(summary.body.projects[0]).not.toHaveProperty("agents");
    expect(JSON.stringify(summary.body).length).toBeLessThan(JSON.stringify(full.body).length / 100);
    expect(full.body.projects[0]).toEqual(project);
  });

  it("maps both legacy and current active-project archive conflicts to HTTP 409", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-archive-conflict-api-"));
    roots.push(root);
    const eventHub = new EventHub();
    const legacyProjectId = "prj_11111111111111111111111111111111";
    const currentProjectId = "prj_22222222222222222222222222222222";
    const archive = vi.fn(async (projectId: string) => {
      throw new Error(projectId === legacyProjectId
        ? "Only cancelled projects can be archived"
        : "Only completed or cancelled projects can be archived");
    });
    const app = createApp({
      orchestrator: { archive } as unknown as Orchestrator,
      storage: new ProjectStorage(root, eventHub),
      eventHub,
      skills: {} as SkillCatalog,
      config: { modelSuggestions: [], maxEventHistory: 100 }
    });

    await request(app)
      .post(`/api/projects/${legacyProjectId}/archive`)
      .expect(409, { error: "Only cancelled projects can be archived" });
    await request(app)
      .post(`/api/projects/${currentProjectId}/archive`)
      .expect(409, { error: "Only completed or cancelled projects can be archived" });
    expect(archive).toHaveBeenCalledTimes(2);
  });

  it("publishes a credential-free GitHub account catalog and fails closed before OAuth setup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-github-api-"));
    roots.push(root);
    const eventHub = new EventHub();
    const app = createApp({
      orchestrator: {} as Orchestrator,
      storage: new ProjectStorage(root, eventHub),
      eventHub,
      skills: {} as SkillCatalog,
      config: { modelSuggestions: [], maxEventHistory: 100 }
    });

    const catalog = await request(app).get("/api/github/accounts").expect(200);
    expect(catalog.body).toEqual({
      accounts: [],
      oauthConfigured: false
    });
    expect(JSON.stringify(catalog.body)).not.toMatch(/token|secret/i);
    await request(app)
      .post("/api/github/auth/start")
      .set("Origin", "https://openfars.example.test")
      .send({})
      .expect(503, {
        error: "GitHub OAuth 尚未配置，请设置 SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID、SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET 和 SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL"
      });
  });

  it("publishes the live GitHub repository observation for a bound project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-github-repository-api-"));
    roots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    vi.spyOn(storage, "tryLoadState").mockResolvedValue({
      id: "prj_11111111111111111111111111111111",
      git: {
        enabled: true,
        status: "ready",
        provider: "github",
        account: { id: "gha_11111111111111111111111111111111", login: "alice", providerUserId: 7 },
        repository: {
          owner: "alice",
          name: "deleted-project",
          htmlUrl: "https://github.com/alice/deleted-project",
          private: true,
          defaultBranch: "main",
          localPath: "repository"
        }
      }
    } as ProjectState);
    const observeRepository = vi.fn(async () => ({
      exists: false,
      observedAt: "2026-09-24T08:00:00.000Z"
    }));
    const githubAccounts = {
      observeRepository,
      list: vi.fn(async () => []),
      oauthConfigured: vi.fn(() => true)
    } as unknown as GitHubAccountStore;
    const app = createApp({
      orchestrator: {} as Orchestrator,
      storage,
      eventHub,
      skills: {} as SkillCatalog,
      githubAccounts,
      config: { modelSuggestions: [], maxEventHistory: 100 }
    });

    const response = await request(app)
      .get("/api/github/projects/prj_11111111111111111111111111111111/repository-status")
      .expect(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toEqual({
      repository: { exists: false, observedAt: "2026-09-24T08:00:00.000Z" }
    });
    expect(observeRepository).toHaveBeenCalledWith(
      "gha_11111111111111111111111111111111",
      "alice",
      "deleted-project"
    );
  });

  it("validates structured cancellation and retains the legacy empty request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-cancel-api-")); roots.push(root);
    const eventHub = new EventHub();
    const cancel = vi.fn(async () => ({ id: "prj_11111111111111111111111111111111", status: "cancelled" }));
    const app = createApp({ orchestrator: { cancel } as unknown as Orchestrator, storage: new ProjectStorage(root, eventHub), eventHub, skills: {} as SkillCatalog, config: { modelSuggestions: [], maxEventHistory: 100 } });
    const url = "/api/projects/prj_11111111111111111111111111111111/cancel";
    await request(app).post(url).send({ actor: "deadline-monitor", reason: "arm_timeout", waitForSettlement: true }).expect(200);
    expect(cancel).toHaveBeenLastCalledWith("prj_11111111111111111111111111111111", { actor: "deadline-monitor", reason: "arm_timeout", waitForSettlement: true });
    await request(app).post(url).expect(200);
    expect(cancel).toHaveBeenLastCalledWith("prj_11111111111111111111111111111111", {});
    await request(app).post(url).send({ reason: "invented" }).expect(400);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("returns actionable Zod issue paths instead of a generic invalid-request message", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-create-validation-api-"));
    roots.push(root);
    const eventHub = new EventHub();
    const createProject = vi.fn(async () => {
      throw new ZodError([
        {
          code: "custom",
          path: ["agents", "main"],
          message: "main Agent 的全局网关网络目标校验失败：网关域名不存在"
        },
        {
          code: "custom",
          path: ["agents", "idea"],
          message: "idea Agent 的全局网关网络目标校验失败：网关域名不存在"
        }
      ]);
    });
    const app = createApp({
      orchestrator: { createProject } as unknown as Orchestrator,
      storage: new ProjectStorage(root, eventHub),
      eventHub,
      skills: {} as SkillCatalog,
      config: { modelSuggestions: [], maxEventHistory: 100 }
    });

    const response = await request(app)
      .post("/api/projects")
      .send({ title: "测试", requirement: "测试请求" })
      .expect(400);

    expect(response.body.error).toContain("请求参数无效：agents.main：main Agent");
    expect(response.body.error).toContain("agents.idea：idea Agent");
    expect(response.body.error).not.toBe("Invalid request");
    expect(response.body.issues).toHaveLength(2);
  });

  it("processes batch items independently and enforces destructive confirmations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-management-api-"));
    roots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const first = "prj_11111111111111111111111111111111";
    const second = "prj_22222222222222222222222222222222";
    const archive = vi.fn(async (projectId: string) => {
      if (projectId === second) throw new Error("Only cancelled projects can be archived");
      return { id: projectId, archivedAt: "2026-09-19T00:00:00.000Z" };
    });
    const deleteArchivedConfirmed = vi.fn(async (projectId: string) => {
      if (projectId === second) throw new Error("Project deletion is already in progress");
    });
    const deleteArchived = vi.fn(async () => undefined);
    const app = createApp({
      orchestrator: {
        archive,
        deleteArchivedConfirmed,
        deleteArchived
      } as unknown as Orchestrator,
      storage,
      eventHub,
      skills: {} as SkillCatalog,
      config: { modelSuggestions: [], maxEventHistory: 100 }
    });

    const archived = await request(app)
      .post("/api/projects/archive/batch")
      .send({ projectIds: [first, second, first] })
      .expect(200);
    expect(archive.mock.calls.map(([projectId]) => projectId)).toEqual([first, second]);
    expect(archived.body).toMatchObject({
      successCount: 1,
      failureCount: 1,
      results: [
        { projectId: first, ok: true },
        { projectId: second, ok: false, error: "Only cancelled projects can be archived" }
      ]
    });

    await request(app)
      .post("/api/projects/delete/batch")
      .send({ projectIds: [first], confirmation: "delete" })
      .expect(400);
    const deleted = await request(app)
      .post("/api/projects/delete/batch")
      .send({ projectIds: [first, second], confirmation: "永久删除" })
      .expect(200);
    expect(deleted.body).toMatchObject({ successCount: 1, failureCount: 1 });
    expect(deleteArchivedConfirmed).toHaveBeenCalledTimes(2);

    await request(app)
      .delete(`/api/projects/${first}`)
      .send({ confirmation: "项目名称" })
      .expect(204);
    expect(deleteArchived).toHaveBeenCalledWith(first, "项目名称");
  });
});
