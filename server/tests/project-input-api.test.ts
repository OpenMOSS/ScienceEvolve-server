import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createApp, type AppDependencies } from "../src/app.js";
import { ProjectInputUploads, ProjectInputUploadError } from "../src/project-input-uploads.js";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { ExplainerAssistantStore } from "../src/explainer-assistant.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/harness-runtime/registry.js";
import type { AgentRunRequest, AgentRunner, ProjectState } from "../src/types.js";

describe("project creation with uploaded inputs", () => {
  it("keeps upload, listing and deletion available when the desktop launcher fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-project-input-api-"));
    const opener = vi.spyOn(ProjectInputUploads.prototype, "openDirectory").mockRejectedValue(
      new ProjectInputUploadError("无法打开系统文件管理器", 503));
    try {
      const app = createApp({ storage: { root }, orchestrator: {}, eventHub: {}, skills: {},
        config: { modelSuggestions: [], maxEventHistory: 10 } } as unknown as AppDependencies);
      const upload = await request(app).post("/api/project-input-uploads").expect(201);
      const base = `/api/project-input-uploads/${upload.body.uploadId}`;
      await request(app).post(`${base}/open-directory`).expect(503);
      const filename = "资料/notes &+#%.txt";
      await request(app).put(`${base}/files`).query({ path: filename })
        .set("content-type", "application/octet-stream").send(Buffer.from("research inputs")).expect(204);
      expect((await request(app).get(`${base}/files`).expect(200)).body.files)
        .toEqual([expect.objectContaining({ path: filename })]);
      await request(app).delete(`${base}/files`).query({ path: filename }).expect(204);
      expect((await request(app).get(`${base}/files`).expect(200)).body.files).toEqual([]);
    } finally {
      opener.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["conversation", "saved-task", "both"] as const)("creates from %s metadata, installs inputs and retains the actual Explainer context", async (source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-project-input-git-"));
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const skills = new SkillCatalog([], path.join(root, "skills"));
    const runner: AgentRunner = {
      harnessCatalog: async () => harnessCatalogRegistry.list().map((descriptor) => toPublicHarnessDescriptor(descriptor, { available: true })),
      run: vi.fn()
    };
    const collaborationRuntime = {
      initialize: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
      recoverProject: vi.fn(async () => false),
      createProject: vi.fn(async (state: ProjectState) => {
        expect(state.orchestration.schemaVersion).toBe(3);
        expect(state.inputFiles).toEqual(["dataset/table.csv"]);
        expect(state.inputDescription).toBe("Use these measured samples.");
        expect(await fs.readFile(path.join(storage.projectDir(state.id), "workspaces", "user_inputs", "dataset", "table.csv"), "utf8"))
          .toBe("sample,value\n1,42");
        expect((await storage.loadState(state.id)).inputFiles).toEqual(state.inputFiles);
      })
    } as unknown as NonNullable<ConstructorParameters<typeof Orchestrator>[5]>;
    const orchestrator = new Orchestrator(storage, skills, runner, { retryBaseMs: 1, retryMaxMs: 10 }, undefined, collaborationRuntime);
    try {
      await orchestrator.initialize();
      const tasks = new SavedResearchTaskStore(root);
      const agents = Object.fromEntries(["main", "idea", "execution", "writing", "review"].map((agent) => [agent, { model: "test-model", skills: [] }]));
      const task = await tasks.create({ title: "Git collaboration inputs", requirement: "Analyze the measured samples.", git: { enabled: true }, agents });
      const assistant = new ExplainerAssistantStore(root, { tasks, catalog: async () => ({}), project: id => storage.tryLoadState(id) });
      const context = await assistant.create({ taskId: task.id });
      const bindAssistantProject = vi.fn((conversationId: string, projectId: string) => assistant.bindProject(conversationId, projectId));
      const app = createApp({ orchestrator, storage, eventHub, skills, config: { modelSuggestions: [], maxEventHistory: 100 },
        projectExplainer: { assistant, bindAssistantProject } as unknown as AppDependencies["projectExplainer"] });
      const upload = await request(app).post("/api/project-input-uploads").expect(201);
      const uploadId = upload.body.uploadId as string;
      await request(app).put(`/api/project-input-uploads/${uploadId}/files?path=dataset%2Ftable.csv`)
        .set("content-type", "application/octet-stream").send(Buffer.from("sample,value\n1,42")).expect(204);
      const created = await request(app).post("/api/projects").send({
        title: "Git collaboration inputs", requirement: "Analyze the measured samples.",
        inputUploadId: uploadId, inputDescription: "Use these measured samples.", git: { enabled: true },
        agents,
        ...(source !== "saved-task" ? { explainerConversationId: context.id } : {}),
        ...(source !== "conversation" ? { sourceSavedTaskId: task.id } : {})
      }).expect(202);
      expect(collaborationRuntime.createProject).toHaveBeenCalledOnce();
      expect(runner.run).not.toHaveBeenCalled();
      expect(bindAssistantProject).toHaveBeenCalledExactlyOnceWith(context.id, created.body.project.id);
      const reloaded = new ExplainerAssistantStore(root, assistant.host);
      expect(await reloaded.resolve(created.body.project.id)).toBe(context.id);
      expect(await reloaded.get(created.body.project.id)).toMatchObject({ id: context.id, taskId: task.id, projectId: created.body.project.id });
    } finally { await orchestrator.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps the staged inputs available when project creation fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-project-input-api-"));
    try {
      const app = createApp({ storage: { root }, orchestrator: { createProject: async () => { throw new Error("test creation failure"); } },
        eventHub: {}, skills: {}, config: { modelSuggestions: [], maxEventHistory: 10 } } as unknown as AppDependencies);
      const upload = await request(app).post("/api/project-input-uploads").expect(201);
      const uploadId = upload.body.uploadId as string;
      await fs.writeFile(path.join(root, ".project-input-uploads", uploadId, "user_inputs", "notes.txt"), "retry data");
      await request(app).post("/api/projects").send({ title: "Retry", requirement: "Use these inputs", inputUploadId: uploadId }).expect(500);
      expect((await request(app).get(`/api/project-input-uploads/${uploadId}/files`).expect(200)).body.files)
        .toEqual([expect.objectContaining({ path: "notes.txt", size: Buffer.byteLength("retry data") })]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("puts an image in the common workspace before the first Agent invocation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-project-input-api-"));
    let resolveRun!: (run: AgentRunRequest) => void;
    const firstRun = new Promise<AgentRunRequest>((resolve) => { resolveRun = resolve; });
    const runner: AgentRunner = {
      harnessCatalog: async () => harnessCatalogRegistry.list().map((descriptor) =>
        toPublicHarnessDescriptor(descriptor, { available: true })),
      run: async (run, _onTrace, signal) => {
        resolveRun(run);
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new Error("test finished"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    };
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const skills = new SkillCatalog([fileURLToPath(new URL("../../.agents/skills", import.meta.url))], path.join(root, "skills"));
    const orchestrator = new Orchestrator(storage, skills, runner, { retryBaseMs: 1, retryMaxMs: 10 });
    try {
      await orchestrator.initialize();
      const app = createApp({ orchestrator, storage, eventHub, skills, config: { modelSuggestions: [], maxEventHistory: 100 } });
      const session = await request(app).post("/api/project-input-uploads").expect(201);
      const uploadId = session.body.uploadId as string;
      const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x80]);
      await request(app)
        .put(`/api/project-input-uploads/${uploadId}/files?path=reference%2Ffigure.png`)
        .set("content-type", "application/octet-stream")
        .send(image)
        .expect(204);
      await request(app)
        .put(`/api/project-input-uploads/${uploadId}/files?path=..%2Fescape.png`)
        .set("content-type", "application/octet-stream")
        .send(image)
        .expect(400);

      const openDirectory = vi.spyOn(ProjectInputUploads.prototype, "openDirectory").mockResolvedValue();
      await request(app).post(`/api/project-input-uploads/${uploadId}/open-directory`).expect(204);
      expect(openDirectory).toHaveBeenCalledWith(uploadId);
      await request(app).post(`/api/project-input-uploads/${uploadId}/open-explorer`).expect(204);
      expect(openDirectory).toHaveBeenCalledTimes(2);
      openDirectory.mockRestore();
      await fs.writeFile(path.join(root, ".project-input-uploads", uploadId, "user_inputs", "manual.txt"), "由系统文件管理器添加");
      const listed = await request(app).get(`/api/project-input-uploads/${uploadId}/files`).expect(200);
      expect(listed.body.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "reference/figure.png", size: image.length }),
        expect.objectContaining({ path: "manual.txt", size: Buffer.byteLength("由系统文件管理器添加") })
      ]));

      const created = await request(app).post("/api/projects").send({
        title: "Image input integration",
        requirement: "Analyze the supplied image as supporting research evidence.",
        inputUploadId: uploadId,
        inputDescription: "The image shows the reference design.",
        agents: Object.fromEntries(["main", "idea", "execution", "writing", "review"].map((agent) =>
          [agent, { model: "test-model", skills: [] }]))
      }).expect(202);
      const run = await Promise.race([firstRun, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Agent did not start")), 5000))]);
      expect(run.workspacePath).toBe(path.join(root, "projects", created.body.project.id, "workspaces"));
      expect(await fs.readFile(path.join(run.workspacePath, "user_inputs", "reference", "figure.png"))).toEqual(image);
      expect(await fs.readFile(path.join(run.workspacePath, "user_inputs", "manual.txt"), "utf8")).toBe("由系统文件管理器添加");
      const inbox = await fs.readFile(run.inboxPath, "utf8");
      expect(inbox).toContain("user_inputs/reference/figure.png");
      expect(inbox).toContain("The image shows the reference design.");
      const savedRequest = await fs.readFile(path.join(root, "projects", created.body.project.id, "request.md"), "utf8");
      expect(savedRequest).toContain("user_inputs/reference/figure.png");
      expect(savedRequest).toContain("The image shows the reference design.");
    } finally {
      await orchestrator.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
