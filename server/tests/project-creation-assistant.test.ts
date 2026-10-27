import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp, type AppDependencies } from "../src/app.js";
import { AgentInterruptedError } from "../src/codex-runner.js";
import { EventHub } from "../src/event-hub.js";
import { ExplainerAssistantStore } from "../src/explainer-assistant.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/harness-runtime/registry.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { ProjectStorage } from "../src/storage.js";
import type { AgentRunResult, AgentRunner } from "../src/types.js";
import { SavedTaskLauncher, savedTaskProjectInput } from "../src/saved-task-launcher.js";

describe("project creation and assistant handoff", () => {
  it("creates two independent drafts and starts both through the real project queue with durable batch retries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-batch-projects-"));
    const eventHub = new EventHub(), storage = new ProjectStorage(root, eventHub);
    const skills = new SkillCatalog([], path.join(root, "skills"));
    const runner: AgentRunner = {
      harnessCatalog: async () => harnessCatalogRegistry.list().map(descriptor =>
        toPublicHarnessDescriptor(descriptor, { available: true })),
      run: vi.fn(async (_input, _trace, signal) => new Promise<AgentRunResult>((_resolve, reject) => {
        const abort = () => reject(new AgentInterruptedError("isolated batch test finished"));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      }))
    };
    const orchestrator = new Orchestrator(storage, skills, runner, { retryBaseMs: 1, retryMaxMs: 10 });
    try {
      await orchestrator.initialize();
      const tasks = new SavedResearchTaskStore(root);
      const launcher = new SavedTaskLauncher(root, tasks, task => orchestrator.createProject(savedTaskProjectInput(task)));
      const assistant = new ExplainerAssistantStore(root, { tasks, skills, project: id => storage.tryLoadState(id),
        catalog: async () => ({ availableRoutes: [{ harness: "codex", gatewayId: `gwy_${"a".repeat(32)}`, model: "test-model" }] }),
        startProjects: (input, signal) => launcher.start(input, signal) });
      const context = await assistant.create();
      const created = [];
      for (const [index, title] of ["A", "B"].entries()) {
        const result = await assistant.call(context.id, "create_draft", { expectedRevision: index,
          operationId: `create-independent-${title}`, patch: { title, requirement: "验证两份独立草稿进入同一现有队列，保留各自配置" } });
        created.push(result.action!.savedTask!);
      }
      const input = { expectedRevision: 2, operationId: "start-both-reviewed-drafts",
        tasks: created.map(task => ({ taskId: task.id, expectedUpdatedAt: task.updatedAt })) };
      const result = await assistant.call(context.id, "start_projects", input);
      expect(result.action!.launches!.results.map(item => item.status)).toEqual(["started", "started"]);
      const projectIds = result.action!.launches!.results.map(item => item.projectId!);
      expect(new Set(projectIds).size).toBe(2);
      expect((await storage.listStates()).map(state => state.title).sort()).toEqual(["A", "B"]);
      expect(await tasks.list()).toHaveLength(2);
      expect(await assistant.get(context.id)).toMatchObject({ revision: 3, draft: { title: "" } });
      expect((await assistant.get(context.id)).projectId).toBeUndefined();
      expect(await assistant.call(context.id, "start_projects", input)).toEqual(result);
      expect(await storage.listStates()).toHaveLength(2);

      const app = createApp({ orchestrator, storage, eventHub, skills, savedResearchTasks: tasks, savedTaskLauncher: launcher,
        config: { modelSuggestions: [], maxEventHistory: 100 } });
      const operationId = result.action!.launches!.operationId;
      const replay = await request(app).post("/api/saved-research-tasks/start/batch").send({ operationId, tasks: input.tasks }).expect(202);
      expect(replay.body.results.map((item: any) => item.projectId)).toEqual(projectIds);
      expect(await storage.listStates()).toHaveLength(2);
      await request(app).post("/api/saved-research-tasks/start/batch").send({ operationId, tasks: [input.tasks[0]] }).expect(409);
      await request(app).post("/api/saved-research-tasks/start/batch").send({ operationId: "reject-duplicate-batch", tasks: [input.tasks[0], input.tasks[0]] }).expect(400);
    } finally { await orchestrator.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { name: "manual saved task", source: true, direct: false, associated: false },
    { name: "saved assistant draft", source: true, direct: false, associated: true },
    { name: "explicit assistant conversation", source: false, direct: true, associated: true },
    { name: "saved draft with explicit conversation", source: true, direct: true, associated: true }
  ])("starts a $name through the real creation validator", async ({ source, direct, associated }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-project-assistant-handoff-"));
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const skills = new SkillCatalog([], path.join(root, "skills"));
    const runner: AgentRunner = {
      harnessCatalog: async () => harnessCatalogRegistry.list().map(descriptor =>
        toPublicHarnessDescriptor(descriptor, { available: true })),
      run: vi.fn(async (_input, _trace, signal) => new Promise<AgentRunResult>((_resolve, reject) => {
        const abort = () => reject(new AgentInterruptedError("isolated launch test finished"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }))
    };
    const orchestrator = new Orchestrator(storage, skills, runner, { retryBaseMs: 1, retryMaxMs: 10 });
    try {
      await orchestrator.initialize();
      const tasks = new SavedResearchTaskStore(root);
      const task = await tasks.create({ title: "Reviewed draft", requirement: "Start the user-reviewed draft and retain its assistant.",
        agents: Object.fromEntries(["main", "idea", "execution", "writing", "review"].map(agent =>
          [agent, { model: "test-model", skills: [] }])) });
      const host = { tasks, skills, project: (id: string) => storage.loadState(id),
        catalog: async () => ({ availableRoutes: [] }) };
      const assistant = new ExplainerAssistantStore(root, host);
      const context = associated ? await assistant.create(source ? { taskId: task.id } : {}) : undefined;
      const bindAssistantProject = vi.fn((conversationId: string, projectId: string) => assistant.bindProject(conversationId, projectId));
      const app = createApp({ orchestrator, storage, eventHub, skills,
        projectExplainer: { assistant, bindAssistantProject } as AppDependencies["projectExplainer"],
        config: { modelSuggestions: [], maxEventHistory: 100 } });

      const response = await request(app).post("/api/projects").send({
        title: task.title, requirement: task.requirement, agents: task.agents,
        orchestration: task.orchestration, git: task.git,
        ...(source ? { sourceSavedTaskId: task.id } : {}),
        ...(direct ? { explainerConversationId: context!.id } : {})
      }).expect(202);
      const projectId = response.body.project.id as string;
      await vi.waitFor(() => expect(runner.run).toHaveBeenCalledOnce());
      expect((await storage.loadState(projectId)).title).toBe(task.title);
      expect((await tasks.get(task.id)).requirement).toBe(task.requirement);
      if (context) {
        expect(bindAssistantProject).toHaveBeenCalledExactlyOnceWith(context.id, projectId);
        const reopened = new ExplainerAssistantStore(root, host);
        expect(await reopened.resolve(projectId)).toBe(context.id);
        expect(await reopened.get(projectId)).toMatchObject({ id: context.id, projectId });
        if (source) expect(await reopened.resolve(task.id)).toBe(context.id);
      } else {
        expect(bindAssistantProject).not.toHaveBeenCalled();
        expect(await assistant.resolve(projectId)).toBe(projectId);
      }
    } finally {
      await orchestrator.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
