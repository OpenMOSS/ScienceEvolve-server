import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { registerExplainerAssistantRoutes } from "../src/explainer-assistant-api.js";
import { ExplainerAssistantStore } from "../src/explainer-assistant.js";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import type { ProjectExplainerAssistantPort, ProjectExplainerPort, ProjectExplainerEvent } from "../src/project-explainer.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "explainer-assistant-api-")); roots.push(root);
  const tasks = new SavedResearchTaskStore(root);
  const store = new ExplainerAssistantStore(root, { tasks, skills: new SkillCatalog([]), project: async () => undefined,
    catalog: async () => ({ availableRoutes: [{ harness: "codex", gatewayId: `gwy_${"a".repeat(32)}`, model: "exact-route-model" }] }) });
  const config = { harness: "codex", model: "exact-route-model", reasoningEffort: "high", available: true };
  const agent = { assistant: store, createAssistantContext: vi.fn(input => store.create(input)), isActive: vi.fn(() => false),
    history: vi.fn(async () => ({ active: false, events: [] })), getConfig: vi.fn(async () => config),
    updateConfig: vi.fn(async (_id, input) => ({ ...config, ...input })), cancel: vi.fn(async () => undefined), reset: vi.fn(async () => undefined),
    ask: vi.fn(async (id: string, _question: string, sink: (event: ProjectExplainerEvent) => Promise<void>) => {
      const context = await store.get(id);
      await store.call(id, "update_draft", { expectedRevision: context.revision, operationId: "native-agent-edit",
        patch: { title: "真实保存结果", requirement: "原生 Agent 的工具操作结果应通过流传回前端" } });
      const saved = await store.call(id, "save_draft", { expectedRevision: context.revision + 1, operationId: "native-agent-save" });
      await sink({ id: "saved-event", projectId: id, turnId: "turn", ts: new Date().toISOString(), kind: "status", phase: "completed",
        text: saved.action!.summary, data: { assistantAction: saved.action } });
      await sink({ id: "complete-event", projectId: id, turnId: "turn", ts: new Date().toISOString(), kind: "status", phase: "completed",
        text: "回答完成", data: { turnComplete: true } });
    }) };
  const app = express(); app.use(express.json());
  registerExplainerAssistantRoutes(app, agent as unknown as ProjectExplainerPort & ProjectExplainerAssistantPort);
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof ZodError ? 400 : 500).json({ error: error.message });
  });
  const created = await request(app).post("/api/explainer/conversations").send({}).expect(201);
  const base = `/api/explainer/conversations/${created.body.id}`;
  return { app, agent, store, tasks, base, context: created.body };
}

describe("interactive Explainer API", () => {
  it.each(["", " \t\n "])("accepts an unfinished Git repository name from the editor and lets the Agent continue (%j)", async repositoryName => {
    const f = await setup(), accountId = `gha_${"b".repeat(32)}`;
    const response = await request(f.app).patch(`${f.base}/context`).send({ expectedRevision: 0,
      draft: { ...f.context.draft, git: { enabled: true, provider: "github", accountId, repositoryName, repositoryVisibility: "private" } }
    }).expect(200);
    expect(response.body.draft.git).toEqual({ enabled: true, provider: "github", accountId, repositoryVisibility: "private" });
    await request(f.app).post(`${f.base}/turns`).send({ question: "继续完善这个项目草稿" }).expect(200);
    expect(f.agent.ask).toHaveBeenCalledOnce();
    const [saved] = await f.tasks.list();
    expect(saved.git).toEqual({ enabled: true, provider: "github", accountId, repositoryVisibility: "private" });
    const current = await f.store.get(f.context.id);
    await request(f.app).patch(`${f.base}/context`).send({ expectedRevision: current.revision,
      draft: { ...current.draft, git: { ...current.draft.git, repositoryName: "invalid/name" } }
    }).expect(400);
    expect((await f.store.get(f.context.id)).revision).toBe(current.revision);
  });

  it("streams confirmed saved-draft actions with a user navigation link and exposes no project launcher", async () => {
    const f = await setup();
    const response = await request(f.app).post(`${f.base}/turns`).send({ question: "请创建并保存一个研究草稿" }).expect(200);
    const events = response.text.trim().split("\n").map(line => JSON.parse(line));
    expect(events[0].data.assistantAction.href).toMatch(/^\/saved-tasks\/task_[a-f0-9]{32}\/edit$/);
    expect(events[1].data.turnComplete).toBe(true); expect(await f.tasks.list()).toHaveLength(1);
    await request(f.app).post(`${f.base}/launch`).send({}).expect(404);
    expect(f.agent.ask).toHaveBeenCalledOnce();
  });

  it("allows incomplete manual drafts, rejects stale writes with 409, and validates strict model settings", async () => {
    const f = await setup();
    await request(f.app).patch(`${f.base}/context`).send({ expectedRevision: 0, draft: { ...f.context.draft, title: "手动编辑" } }).expect(200);
    await request(f.app).patch(`${f.base}/context`).send({ expectedRevision: 0, draft: f.context.draft }).expect(409);
    expect((await f.store.get(f.context.id)).draft.title).toBe("手动编辑");
    await request(f.app).patch(`${f.base}/config`).send({ harness: "pi", model: "other-model", reasoningEffort: "medium" }).expect(200);
    expect(f.agent.updateConfig).toHaveBeenCalledWith(f.context.id, { harness: "pi", model: "other-model", reasoningEffort: "medium" });
    await request(f.app).patch(`${f.base}/config`).send({ harness: "pi", model: "other-model", available: true }).expect(400);
  });

  it("keeps active turns mutually exclusive and lets missing feature deployments return a clear error", async () => {
    const f = await setup(); f.agent.isActive.mockReturnValue(true);
    await request(f.app).post(`${f.base}/turns`).send({ question: "再来一次" }).expect(409);
    expect(f.agent.ask).not.toHaveBeenCalled();
    await request(f.app).post(`${f.base}/cancel`).send({}).expect(204); expect(f.agent.cancel).toHaveBeenCalledWith(f.context.id);
    const app = express(); app.use(express.json()); registerExplainerAssistantRoutes(app);
    const missing = await request(app).post("/api/explainer/conversations").send({}).expect(503);
    expect(missing.body.error).toContain("尚未配置");
  });
});
