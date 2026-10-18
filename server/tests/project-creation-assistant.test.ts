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

describe("project creation and assistant handoff", () => {
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
