import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createApp } from "../src/app.js";
import { CollaborationStateError } from "../src/collaboration-state/errors.js";
import { AgentInterruptedError } from "../src/codex-runner.js";
import { GatewayStore } from "../src/agent-runtime.js";
import {
  harnessCatalogRegistry,
  toPublicHarnessDescriptor
} from "../src/harness-runtime/registry.js";
import {
  ProjectExplainerBusyError,
  type ProjectExplainerEvent,
  type ProjectExplainerPort
} from "../src/project-explainer.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  ProjectState,
  TraceSink
} from "../src/types.js";

const temporaryRoots: string[] = [];
const AGENT_NAMES = ["main", "idea", "execution", "writing", "review"] as const;
const builtinSkillRoot = fileURLToPath(
  new URL("../../.agents/skills", import.meta.url)
);

function testSkillCatalog(userSkillRoot?: string): SkillCatalog {
  return new SkillCatalog(
    [builtinSkillRoot, ...(userSkillRoot ? [userSkillRoot] : [])],
    userSkillRoot
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

class HoldingRunner implements AgentRunner {
  async harnessCatalog() {
    return harnessCatalogRegistry.list().map((descriptor) =>
      toPublicHarnessDescriptor(descriptor, { available: true })
    );
  }

  async run(
    _request: AgentRunRequest,
    onTrace: TraceSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    await onTrace("status", "holding fake agent");
    return new Promise((_resolve, reject) => {
      const abort = () =>
        reject(new AgentInterruptedError("cancelled in API test"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

describe("HTTP API", () => {
  it("keeps research examples outside the application API and runtime catalog", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-no-example-library-"));
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    await storage.initialize();
    const app = createApp({ orchestrator: {} as Orchestrator, storage, eventHub,
      skills: testSkillCatalog(), config: { modelSuggestions: [], maxEventHistory: 2 } });
    await request(app).get("/api/examples").expect(404);
    await request(app).get("/api/examples/aris").expect(404);
    const catalog = await request(app).get("/api/skills").expect(200);
    expect(catalog.body).not.toHaveProperty("examples");
    expect(catalog.body.skills.some((skill: { name: string }) => skill.name === "scienceevolve-aris")).toBe(false);
  });

  it("reports a Pause superseded by Stop as a lifecycle conflict", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-pause-stop-api-"));
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    await storage.initialize();
    const orchestrator = {
      async pause() {
        throw new CollaborationStateError("INVALID_STATE_TRANSITION",
          "Pause superseded by pending Stop; native stop still requires confirmation");
      }
    } as unknown as Orchestrator;
    const app = createApp({ orchestrator, storage, eventHub, skills: testSkillCatalog(),
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 } });
    await request(app).post("/api/projects/prj_pause_stop/pause").send({}).expect(409, {
      error: "Pause superseded by pending Stop; native stop still requires confirmation",
      code: "INVALID_STATE_TRANSITION"
    });
  });

  it("delegates group rename/dissolve actions and rejects runtime group creation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-group-edit-api-"));
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    await storage.initialize();
    const calls: unknown[] = [];
    const orchestrator = {
      async updateCollaborationGroup(projectId: string, input: unknown) {
        calls.push({ projectId, input });
        return { id: projectId, workflowRevision: 2 };
      },
      async getProjectGitGraph(projectId: string, input: unknown) {
        calls.push({ projectId, gitGraph: input });
        return { commits: [], refs: [], observedAt: "2026-09-24T00:00:00.000Z" };
      }
    } as unknown as Orchestrator;
    const app = createApp({
      orchestrator,
      storage,
      eventHub,
      skills: testSkillCatalog(),
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 }
    });

    await request(app)
      .patch("/api/projects/prj_group/workflow/collaboration-groups")
      .send({
        action: "rename",
        groupId: "research_group",
        displayName: "证据整合组",
        requestId: "workflow-edit-1"
      })
      .expect(200, { project: { id: "prj_group", workflowRevision: 2 } });
    expect(calls).toEqual([{
      projectId: "prj_group",
      input: {
        action: "rename",
        groupId: "research_group",
        displayName: "证据整合组",
        requestId: "workflow-edit-1"
      }
    }]);
    await request(app)
      .patch("/api/projects/prj_group/workflow/collaboration-groups")
      .send({
        action: "dissolve",
        groupId: "research_group",
        expectedWorkflowRevision: 2,
        requestId: "workflow-edit-2"
      })
      .expect(200, { project: { id: "prj_group", workflowRevision: 2 } });
    expect(calls[1]).toEqual({
      projectId: "prj_group",
      input: {
        action: "dissolve",
        groupId: "research_group",
        expectedWorkflowRevision: 2,
        requestId: "workflow-edit-2"
      }
    });
    await request(app)
      .patch("/api/projects/prj_group/workflow/collaboration-groups")
      .send({
        action: "dissolve",
        groupId: "research_group",
        expectedWorkflowRevision: 2
      })
      .expect(400);
    await request(app)
      .patch("/api/projects/prj_group/workflow/collaboration-groups")
      .send({
        action: "dissolve",
        groupId: "research_group",
        requestId: "workflow-edit-without-revision"
      })
      .expect(400);
    await request(app)
      .get("/api/projects/prj_group/git/graph?limit=50&includeTechnical=true")
      .expect(200, { commits: [], refs: [], observedAt: "2026-09-24T00:00:00.000Z" });
    expect(calls[2]).toEqual({
      projectId: "prj_group",
      gitGraph: { limit: 50, includeTechnical: true }
    });
    await request(app)
      .patch("/api/projects/prj_group/workflow/collaboration-groups")
      .send({
        action: "create",
        groupId: "new_group",
        displayName: "New group",
        memberAgentIds: ["one", "two"]
      })
      .expect(400);
    expect(calls).toHaveLength(3);
  });

  it("validates creation, exposes project snapshots, replays SSE, and cancels explicitly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-api-"));
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const userSkillRoot = path.join(root, "skills");
    const skills = testSkillCatalog(userSkillRoot);
    const orchestrator = new Orchestrator(
      storage,
      skills,
      new HoldingRunner(),
      { retryBaseMs: 1, retryMaxMs: 10 }
    );
    await orchestrator.initialize();
    const app = createApp({
      orchestrator,
      storage,
      eventHub,
      skills,
      gatewayStore: new GatewayStore(root, {
        resolveHostname: async () => ["93.184.216.34"],
        fetch: (async () => new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })) as typeof fetch
      }),
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 },
      harnessVersion: "fixture-harness test"
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const discoverModelsResponse = await fetch(`${base}/api/gateway-models/discover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://gateway.example.test/v1",
          apiKey: "discovery-secret",
          protocol: "responses"
        })
      });
      expect(discoverModelsResponse.status).toBe(200);
      expect(await discoverModelsResponse.json()).toEqual({ models: ["discovered-model"] });

      const createGatewayResponse = await fetch(`${base}/api/gateways`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "API gateway",
          url: "https://gateway.example.test/v1",
          apiKey: "api-route-secret",
          models: ["test-model"],
          modelContextWindows: { "test-model": 1_000_000 },
          defaultModel: "test-model",
          protocol: "responses"
        })
      });
      expect(createGatewayResponse.status).toBe(201);
      const createdGateway = (await createGatewayResponse.json()) as {
        gateway: {
          id: string;
          apiKeyConfigured: boolean;
          apiKey?: string;
          modelContextWindows: Record<string, number>;
        };
      };
      expect(createdGateway.gateway.apiKeyConfigured).toBe(true);
      expect(createdGateway.gateway.modelContextWindows).toEqual({ "test-model": 1_000_000 });
      expect(createdGateway.gateway).not.toHaveProperty("apiKey");
      const gatewayCatalogResponse = await fetch(`${base}/api/gateways`);
      const gatewayCatalogText = await gatewayCatalogResponse.text();
      expect(gatewayCatalogResponse.status).toBe(200);
      expect(gatewayCatalogText).not.toContain("api-route-secret");

      const revealCredentialResponse = await fetch(
        `${base}/api/gateways/${createdGateway.gateway.id}/credential/reveal`,
        { method: "POST" }
      );
      expect(revealCredentialResponse.status).toBe(200);
      expect(revealCredentialResponse.headers.get("cache-control")).toContain("no-store");
      expect(await revealCredentialResponse.json()).toEqual({ apiKey: "api-route-secret" });
      const deleteGatewayResponse = await fetch(`${base}/api/gateways/${createdGateway.gateway.id}`, {
        method: "DELETE"
      });
      expect(deleteGatewayResponse.status).toBe(204);

      const createSkillResponse = await fetch(`${base}/api/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: '证据一致性检查 "严格版"',
          content:
            "## When to use\n\nAudit every quantitative claim against durable artifacts."
        })
      });
      expect(createSkillResponse.status).toBe(201);
      const createdUserSkill = (await createSkillResponse.json()) as {
        skill: {
          id: string;
          name: string;
          description: string;
          source: string;
        };
      };
      expect(createdUserSkill.skill).toMatchObject({
        name: '证据一致性检查 "严格版"',
        description: "When to use",
        source: "external"
      });
      const persistedSkill = (await skills.list(true)).find(
        (skill) => skill.id === createdUserSkill.skill.id
      );
      expect(persistedSkill).toBeDefined();
      expect(path.basename(persistedSkill!.path)).toBe("SKILL.md");
      const persistedSkillMarkdown = await fs.readFile(
        persistedSkill!.path,
        "utf8"
      );
      expect(persistedSkillMarkdown).toContain(
        'scienceevolve-title: "证据一致性检查 \\"严格版\\""'
      );
      expect(persistedSkillMarkdown).toContain(
        "Audit every quantitative claim against durable artifacts."
      );
      const reloadedSkills = testSkillCatalog(userSkillRoot);
      expect(
        await reloadedSkills.resolve([createdUserSkill.skill.id])
      ).toEqual([persistedSkill!.path]);

      const invalidCreatedSkillResponse = await fetch(`${base}/api/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "lark-custom", content: "Hidden" })
      });
      expect(invalidCreatedSkillResponse.status).toBe(400);

      const userSkillDirectory = path.join(root, "user-skills", "evidence-audit");
      await fs.mkdir(userSkillDirectory, { recursive: true });
      const userSkillPath = path.join(userSkillDirectory, "SKILL.md");
      await fs.writeFile(
        userSkillPath,
        [
          "---",
          "name: evidence-audit",
          "description: Audit user-supplied research evidence",
          "---",
          "# Evidence audit"
        ].join("\n"),
        "utf8"
      );
      const resolvedSkillResponse = await fetch(`${base}/api/skills/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill: userSkillDirectory })
      });
      expect(resolvedSkillResponse.status).toBe(200);
      const resolvedSkill = (await resolvedSkillResponse.json()) as {
        skill: {
          id: string;
          name: string;
          description: string;
          source: string;
        };
      };
      expect(resolvedSkill.skill).toEqual({
        id: await fs.realpath(userSkillPath),
        name: "evidence-audit",
        description: "Audit user-supplied research evidence",
        source: "external"
      });

      const installedSkillResponse = await fetch(`${base}/api/skills/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill: "idea-agent" })
      });
      expect(installedSkillResponse.status).toBe(200);
      expect(
        ((await installedSkillResponse.json()) as { skill: { id: string } })
          .skill.id
      ).toBe("builtin:idea-agent");

      const missingSkillResponse = await fetch(`${base}/api/skills/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill: path.join(root, "missing-skill") })
      });
      expect(missingSkillResponse.status).toBe(400);

      const invalid = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "", requirement: "short" })
      });
      expect(invalid.status).toBe(400);

      const createdResponse = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "API contract",
          requirement:
            "Verify the HTTP and event-stream contract for a running research project.",
          agents: Object.fromEntries(
            AGENT_NAMES.map((role) => [
              role,
              {
                model: "test-model",
                skills: [],
                ...(role === "idea"
                  ? {
                      mcpServers: [
                        {
                          name: "research-docs",
                          url: "https://docs.example.test/mcp"
                        }
                      ]
                    }
                  : {})
              }
            ])
          )
        })
      });
      expect(createdResponse.status).toBe(202);
      const createdBody = (await createdResponse.json()) as {
        project: { id: string };
      };
      const projectId = createdBody.project.id;

      const savedTaskResponse = await fetch(
        `${base}/api/saved-research-tasks`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "API 保存任务",
            requirement: "保存完整科研需求和五类 Agent 配置，稍后重复启动。",
            agents: {
              execution: {
                model: "saved-task-execution-model",
                reasoningEffort: "xhigh",
                mcpServers: [
                  { name: "saved-data", url: "https://saved.example.test/mcp" }
                ]
              }
            }
          })
        }
      );
      expect(savedTaskResponse.status).toBe(201);
      const savedTaskBody = (await savedTaskResponse.json()) as {
        task: {
          id: string;
          title: string;
          agents: Record<string, { model: string; mcpServers: unknown[] }>;
        };
      };
      expect(savedTaskBody.task).toMatchObject({
        id: expect.stringMatching(/^task_[a-f0-9]{32}$/),
        title: "API 保存任务"
      });
      expect(savedTaskBody.task.agents.execution).toMatchObject({
        model: "saved-task-execution-model",
        mcpServers: [
          { name: "saved-data", url: "https://saved.example.test/mcp" }
        ]
      });
      expect(savedTaskBody.task.agents.execution).not.toHaveProperty("reasoningEffort");

      const savedTaskId = savedTaskBody.task.id;
      const getSavedTaskResponse = await fetch(
        `${base}/api/saved-research-tasks/${savedTaskId}`
      );
      expect(getSavedTaskResponse.status).toBe(200);
      const listSavedTasksResponse = await fetch(
        `${base}/api/saved-research-tasks`
      );
      expect(listSavedTasksResponse.status).toBe(200);
      expect(
        ((await listSavedTasksResponse.json()) as { tasks: unknown[] }).tasks
      ).toHaveLength(1);

      const updateSavedTaskResponse = await fetch(
        `${base}/api/saved-research-tasks/${savedTaskId}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "API 编辑任务",
            requirement: "编辑保存内容以后，应继续保留完整 Agent 配置并能够再次启动。",
            agents: savedTaskBody.task.agents
          })
        }
      );
      expect(updateSavedTaskResponse.status).toBe(200);
      expect(
        ((await updateSavedTaskResponse.json()) as { task: { title: string } })
          .task.title
      ).toBe("API 编辑任务");

      const deleteSavedTaskResponse = await fetch(
        `${base}/api/saved-research-tasks/${savedTaskId}`,
        { method: "DELETE" }
      );
      expect(deleteSavedTaskResponse.status).toBe(204);
      expect(
        await fetch(`${base}/api/saved-research-tasks/${savedTaskId}`)
      ).toMatchObject({ status: 404 });

      const defaultPresetsResponse = await fetch(
        `${base}/api/agent-config-presets`
      );
      expect(defaultPresetsResponse.status).toBe(200);
      const defaultPresets = (await defaultPresetsResponse.json()) as {
        presets: Array<{
          id: string;
          builtin: boolean;
          agents: Record<
            string,
            {
              instructions: string;
              permission: "workspace" | "compute" | "yolo";
              webSearch: boolean;
            }
          >;
        }>;
      };
      expect(defaultPresets.presets).toHaveLength(1);
      expect(defaultPresets.presets[0]).toMatchObject({
        id: "default",
        builtin: true
      });
      expect(defaultPresets.presets[0].agents.main.instructions.length).toBeGreaterThan(0);
      expect(defaultPresets.presets[0].agents.execution).toMatchObject({
        permission: "compute",
        webSearch: true
      });

      const exportPresetResponse = await fetch(
        `${base}/api/projects/${projectId}/agent-config-preset`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        }
      );
      expect(exportPresetResponse.status).toBe(201);
      const exported = (await exportPresetResponse.json()) as {
        preset: {
          id: string;
          name: string;
          sourceProjectId: string;
          agents: Record<
            string,
            {
              model: string;
              instructions: string;
              skills: string[];
              autoSkills: string[];
              mcpServers: Array<{ name: string; url: string }>;
              permission: "workspace" | "compute" | "yolo";
              webSearch: boolean;
            }
          >;
        };
      };
      expect(exported.preset).toMatchObject({
        id: expect.stringMatching(/^cfg_[a-f0-9]{32}$/),
        name: "API contract · Agent 配置",
        sourceProjectId: projectId
      });
      expect(exported.preset.agents.idea).toMatchObject({
        model: "test-model",
        mcpServers: [
          { name: "research-docs", url: "https://docs.example.test/mcp" }
        ],
        permission: "workspace",
        webSearch: true
      });
      expect(exported.preset.agents.idea).not.toHaveProperty("reasoningEffort");
      expect(exported.preset.agents.main.instructions.length).toBeGreaterThan(0);

      const renamedPresetResponse = await fetch(
        `${base}/api/projects/${projectId}/agent-config-preset`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "API 可复用配置" })
        }
      );
      expect(renamedPresetResponse.status).toBe(201);
      const renamed = (await renamedPresetResponse.json()) as {
        preset: { id: string; name: string };
      };
      expect(renamed.preset).toEqual(
        expect.objectContaining({
          id: exported.preset.id,
          name: "API 可复用配置"
        })
      );

      const persistedPresetsResponse = await fetch(
        `${base}/api/agent-config-presets`
      );
      const persistedPresets = (await persistedPresetsResponse.json()) as {
        presets: Array<{ id: string; name: string }>;
      };
      expect(persistedPresets.presets).toHaveLength(2);
      expect(persistedPresets.presets[1]).toEqual(
        expect.objectContaining({
          id: exported.preset.id,
          name: "API 可复用配置"
        })
      );

      const deleteDefaultPresetResponse = await fetch(
        `${base}/api/agent-config-presets/default`,
        { method: "DELETE" }
      );
      expect(deleteDefaultPresetResponse.status).toBe(409);

      const deletePresetResponse = await fetch(
        `${base}/api/agent-config-presets/${exported.preset.id}`,
        { method: "DELETE" }
      );
      expect(deletePresetResponse.status).toBe(204);
      const presetsAfterDeleteResponse = await fetch(
        `${base}/api/agent-config-presets`
      );
      const presetsAfterDelete = (await presetsAfterDeleteResponse.json()) as {
        presets: Array<{ id: string }>;
      };
      expect(presetsAfterDelete.presets).toEqual([
        expect.objectContaining({ id: "default" })
      ]);

      const queueResponse = await fetch(`${base}/api/queue`);
      expect(queueResponse.status).toBe(200);
      const queue = (await queueResponse.json()) as Record<
        string,
        {
          capacity: number;
          activeProjectIds: string[];
          activeProjectId?: string;
          queued: Array<{ projectId: string; position: number }>;
        }
      >;
      expect(queue.worker.capacity).toBe(10);
      expect(
        queue.worker.activeProjectIds.includes(projectId) ||
          queue.worker.queued.some((item) => item.projectId === projectId)
      ).toBe(true);

      const snapshotResponse = await fetch(`${base}/api/projects/${projectId}`);
      expect(snapshotResponse.status).toBe(200);
      const snapshot = (await snapshotResponse.json()) as {
        project: {
          currentAgent?: string;
          status: string;
          queueDepth: number;
        };
        events: Array<{ type: string; seq: number }>;
        artifacts: unknown[];
      };
      expect(snapshot.project.currentAgent).toBe("idea");
      expect(snapshot.project.queueDepth).toBe(0);
      expect(snapshot.events.some((event) => event.type === "agent.started")).toBe(
        true
      );
      expect(snapshot.artifacts).toEqual([
        expect.objectContaining({
          id: "workspace:Memory.md",
          origin: "workspace",
          path: "Memory.md",
          producer: "shared"
        })
      ]);

      const stateOnlyResponse = await fetch(
        `${base}/api/projects/${projectId}?view=state`
      );
      expect(stateOnlyResponse.status).toBe(200);
      const stateOnly = (await stateOnlyResponse.json()) as Record<string, unknown>;
      expect(stateOnly).toHaveProperty("project");
      expect(stateOnly).not.toHaveProperty("events");
      expect(stateOnly).not.toHaveProperty("artifacts");

      const proactiveInputResponse = await fetch(
        `${base}/api/projects/${projectId}/user-inputs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "Run the larger experiment before the next Main decision."
          })
        }
      );
      expect(proactiveInputResponse.status).toBe(202);

      const bootstrapResponse = await fetch(
        `${base}/api/projects/${projectId}/events/bootstrap?limit=1`
      );
      expect(bootstrapResponse.status).toBe(200);
      const bootstrap = (await bootstrapResponse.json()) as {
        events: Array<{ seq: number; type: string }>;
        timelineEvents: Array<{
          seq: number;
          type: string;
          message: string;
          data?: Record<string, unknown>;
        }>;
        totalEvents: number;
        lastSeq: number;
      };
      expect(bootstrap.events).toHaveLength(1);
      expect(bootstrap.totalEvents).toBeGreaterThanOrEqual(2);
      expect(bootstrap.lastSeq).toBe(bootstrap.events[0].seq);
      expect(
        bootstrap.timelineEvents.some((event) => event.type === "agent.started")
      ).toBe(true);
      expect(
        bootstrap.timelineEvents.find(
          (event) => event.type === "user.input.queued"
        )?.data
      ).toMatchObject({
        inputId: expect.stringMatching(/^inp_[a-f0-9]{32}$/),
        targetMainInvocation: 1,
        preview: "Run the larger experiment before the next Main decision."
      });
      expect(
        bootstrap.timelineEvents.every((event) => event.message === "")
      ).toBe(true);

      const historyResponse = await fetch(
        `${base}/api/projects/${projectId}/events/history?before=${bootstrap.events[0].seq}&limit=1`
      );
      expect(historyResponse.status).toBe(200);
      const history = (await historyResponse.json()) as {
        events: Array<{ seq: number }>;
        hasMore: boolean;
      };
      expect(history.events).toHaveLength(1);
      expect(history.events[0].seq).toBeLessThan(bootstrap.events[0].seq);

      const invalidModelUpdate = await fetch(
        `${base}/api/projects/${projectId}/agents/models`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ models: { execution: "" } })
        }
      );
      expect(invalidModelUpdate.status).toBe(400);

      const modelUpdateResponse = await fetch(
        `${base}/api/projects/${projectId}/agents/models`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            models: {
              main: "gpt-5.6-terra",
              execution: "gpt-5.6-sol"
            }
          })
        }
      );
      expect(modelUpdateResponse.status).toBe(409);
      expect(await modelUpdateResponse.json()).toEqual({
        error: "Project configuration is locked after startup"
      });
      const persistedAfterModelUpdate = await storage.loadState(projectId);
      expect(persistedAfterModelUpdate.agents.main.model).toBe("test-model");
      expect(
        (await storage.readEvents(projectId)).some(
          (event) => event.type === "project.config.updated"
        )
      ).toBe(false);

      const incompleteRuntimeConfig = await fetch(
        `${base}/api/projects/${projectId}/agents/config`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agents: { main: { model: "gpt-5.6-sol" } }
          })
        }
      );
      expect(incompleteRuntimeConfig.status).toBe(409);

      const runtimeConfigResponse = await fetch(
        `${base}/api/projects/${projectId}/agents/config`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agents: {
              main: {
                model: "gpt-5.6-sol",
                reasoningEffort: "xhigh",
                instructions: "Custom Main research-director prompt",
                skills: ["builtin:research-director"],
                autoSkills: ["builtin:nature-figure"],
                mcpServers: [
                  {
                    name: "research-docs",
                    url: "https://docs.example.test/mcp"
                  }
                ]
              },
              review: {
                model: "gpt-5.6-terra",
                reasoningEffort: "medium"
              },
              writing: {
                instructions: "Custom scientific-writing prompt",
                skills: [],
                autoSkills: [
                  "builtin:nature-writing",
                  "builtin:latex-writer"
                ]
              }
            }
          })
        }
      );
      expect(runtimeConfigResponse.status).toBe(400);
      const persistedRuntimeConfig = await storage.loadState(projectId);
      expect(persistedRuntimeConfig.agents.main).not.toHaveProperty("reasoningEffort");
      expect(persistedRuntimeConfig.agents.main.model).toBe("test-model");

      const prematureArchive = await fetch(
        `${base}/api/projects/${projectId}/archive`,
        { method: "POST" }
      );
      expect(prematureArchive.status).toBe(409);

      const liveState = await orchestrator.getProject(projectId);
      const executionWorkspace = await storage.roleWorkspace(
        projectId,
        "execution",
        "inv_workspace_api_test"
      );
      await fs.writeFile(
        path.join(executionWorkspace, "workspace-report.md"),
        "# Workspace report\n",
        "utf8"
      );
      await fs.writeFile(
        path.join(executionWorkspace, "model.bin"),
        Buffer.from([0, 1, 2, 3])
      );
      await fs.writeFile(
        path.join(executionWorkspace, "figure.webp"),
        Buffer.from([0, 1, 2, 3])
      );
      await fs.writeFile(
        path.join(executionWorkspace, "sound.mp3"),
        Buffer.from([0, 1, 2, 3])
      );
      await fs.writeFile(
        path.join(executionWorkspace, ".env"),
        "SECRET=must-not-be-readable\n",
        "utf8"
      );
      const workspaceRootDirectoryResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts?view=directory&agent=execution&offset=0&limit=2`
      );
      expect(workspaceRootDirectoryResponse.status).toBe(200);
      const workspaceRootDirectory = (await workspaceRootDirectoryResponse.json()) as {
        directory: string;
        entries: Array<{ type: string; path: string }>;
        total: number;
        hasMore: boolean;
      };
      expect(workspaceRootDirectory).toMatchObject({
        directory: "",
        total: 6,
        hasMore: true
      });
      const rootEntryPaths = workspaceRootDirectory.entries.map((entry) => [
        entry.type,
        entry.path
      ]);
      expect(rootEntryPaths).toHaveLength(2);
      expect(rootEntryPaths).toEqual(
        expect.arrayContaining([
          ["directory", "user_inputs"],
          ["file", "figure.webp"]
        ])
      );
      const hiddenDirectoryResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts?view=directory&agent=execution&directory=.scienceevolve`
      );
      expect(hiddenDirectoryResponse.status).toBe(404);
      const workspaceReportResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=workspace-report.md&origin=workspace&agent=execution`
      );
      expect(workspaceReportResponse.status).toBe(200);
      expect(await workspaceReportResponse.text()).toContain("Workspace report");
      const sharedFile = await fetch(`${base}/api/projects/${projectId}/artifacts/content?path=workspace-report.md&origin=workspace&agent=shared`);
      expect(sharedFile.status).toBe(200);
      expect(await sharedFile.text()).toBe("# Workspace report\n");
      await fs.writeFile(path.join(executionWorkspace, "module.mjs"), "export const result = 1;\n");
      const moduleFile = await fetch(`${base}/api/projects/${projectId}/artifacts/content?path=module.mjs&origin=workspace&agent=shared`);
      expect(moduleFile.status).toBe(200);
      expect(moduleFile.headers.get("content-type")).toContain("text/javascript");
      expect(await moduleFile.text()).toBe("export const result = 1;\n");
      const binaryPreviewResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=model.bin&origin=workspace&agent=execution`
      );
      expect(binaryPreviewResponse.status).toBe(415);
      const binaryDownloadResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=model.bin&origin=workspace&agent=execution&download=1`
      );
      expect(binaryDownloadResponse.status).toBe(200);
      expect(binaryDownloadResponse.headers.get("content-disposition")).toContain(
        "attachment"
      );
      expect(
        Buffer.from(await binaryDownloadResponse.arrayBuffer())
      ).toEqual(Buffer.from([0, 1, 2, 3]));
      const imagePreviewResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=figure.webp&origin=workspace&agent=execution`
      );
      expect(imagePreviewResponse.status).toBe(200);
      expect(imagePreviewResponse.headers.get("content-type")).toContain(
        "image/webp"
      );
      expect(imagePreviewResponse.headers.get("content-disposition")).toContain(
        "inline"
      );
      expect(Buffer.from(await imagePreviewResponse.arrayBuffer())).toEqual(
        Buffer.from([0, 1, 2, 3])
      );
      const audioPreviewResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=sound.mp3&origin=workspace&agent=execution`
      );
      expect(audioPreviewResponse.status).toBe(200);
      expect(audioPreviewResponse.headers.get("content-type")).toContain(
        "audio/mpeg"
      );
      expect(audioPreviewResponse.headers.get("content-disposition")).toContain(
        "inline"
      );
      const hiddenWorkspaceResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=.env&origin=workspace&agent=execution`
      );
      expect(hiddenWorkspaceResponse.status).toBe(404);

      await fs.mkdir(path.join(executionWorkspace, "plots"), { recursive: true });
      await fs.writeFile(
        path.join(executionWorkspace, "plots", "untrusted.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
        "utf8"
      );
      const svgResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=plots%2Funtrusted.svg&origin=workspace&agent=execution`
      );
      expect(svgResponse.headers.get("content-type")).toContain("image/svg+xml");
      expect(svgResponse.headers.get("x-content-type-options")).toBe("nosniff");
      expect(svgResponse.headers.get("content-security-policy")).toContain(
        "script-src 'self'"
      );
      expect(svgResponse.headers.get("content-security-policy")).toContain(
        "frame-src 'self' blob:"
      );
      expect(svgResponse.headers.get("x-frame-options")).toBeNull();
      expect(svgResponse.headers.get("content-security-policy")).not.toContain(
        "frame-ancestors"
      );
      expect(await svgResponse.text()).toContain("<script>alert(1)</script>");

      // Git-on API reads must fail closed. A legacy role workspace is not an
      // accepted execution/PR source and must disappear from both catalog and
      // content endpoints instead of being used as a fallback.
      const priorGit = liveState!.git;
      liveState!.git = { enabled: true, status: "ready", provider: "github" };
      await storage.saveState(liveState!);
      const gitCatalogResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts?agent=execution`
      );
      expect(gitCatalogResponse.status).toBe(200);
      expect(await gitCatalogResponse.json()).toMatchObject({ artifacts: [], total: 0 });
      const gitLegacyFallbackResponse = await fetch(
        `${base}/api/projects/${projectId}/artifacts/content?path=workspace-report.md&origin=workspace&agent=execution`
      );
      expect(gitLegacyFallbackResponse.status).toBe(404);
      liveState!.git = priorGit;
      await storage.saveState(liveState!);

      const streamController = new AbortController();
      const streamResponse = await fetch(
        `${base}/api/projects/${projectId}/events?after=0`,
        { signal: streamController.signal }
      );
      expect(streamResponse.headers.get("content-type")).toContain(
        "text/event-stream"
      );
      const reader = streamResponse.body!.getReader();
      const decoder = new TextDecoder();
      let streamed = "";
      while (!streamed.includes("event: agent.started")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamed += decoder.decode(chunk.value);
      }
      expect(streamed).toContain("id: 1");
      expect(streamed).toContain("event: agent.started");
      await reader.cancel();
      streamController.abort();

      const cancelledResponse = await fetch(
        `${base}/api/projects/${projectId}/cancel`,
        { method: "POST" }
      );
      expect(cancelledResponse.status).toBe(200);
      await orchestrator.waitForIdle(projectId);
      const cancelled = await orchestrator.getProject(projectId);
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.completedAt).toBeUndefined();

      const archivedResponse = await fetch(
        `${base}/api/projects/${projectId}/archive`,
        { method: "POST" }
      );
      expect(archivedResponse.status).toBe(200);
      const archivedBody = (await archivedResponse.json()) as {
        project: { archivedAt?: string };
      };
      expect(archivedBody.project.archivedAt).toBeTruthy();

      const defaultProjects = (await (
        await fetch(`${base}/api/projects`)
      ).json()) as { projects: Array<{ id: string }> };
      expect(defaultProjects.projects).not.toContainEqual(
        expect.objectContaining({ id: projectId })
      );
      const allProjects = (await (
        await fetch(`${base}/api/projects?includeArchived=true`)
      ).json()) as {
        projects: Array<{ id: string; archivedAt?: string }>;
      };
      expect(allProjects.projects).toContainEqual(
        expect.objectContaining({ id: projectId, archivedAt: expect.any(String) })
      );

      const unarchiveResponse = await fetch(
        `${base}/api/projects/${projectId}/unarchive`,
        { method: "POST" }
      );
      expect(unarchiveResponse.status).toBe(200);
      const restoredProjects = (await (
        await fetch(`${base}/api/projects`)
      ).json()) as { projects: Array<{ id: string }> };
      expect(restoredProjects.projects).toContainEqual(
        expect.objectContaining({ id: projectId })
      );

      const activeDeleteResponse = await fetch(
        `${base}/api/projects/${projectId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "API contract" })
        }
      );
      expect(activeDeleteResponse.status).toBe(409);

      await fetch(`${base}/api/projects/${projectId}/archive`, { method: "POST" });
      const wrongDeleteResponse = await fetch(
        `${base}/api/projects/${projectId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "wrong project" })
        }
      );
      expect(wrongDeleteResponse.status).toBe(400);
      const deleteResponse = await fetch(
        `${base}/api/projects/${projectId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "API contract" })
        }
      );
      expect(deleteResponse.status).toBe(204);
      expect((await fetch(`${base}/api/projects/${projectId}`)).status).toBe(404);
      await expect(fs.access(storage.projectDir(projectId))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await orchestrator.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("returns recovery diagnostics without waiting on partially restored files", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-api-recovery-")
    );
    temporaryRoots.push(root);
    class RecoveryStorage extends ProjectStorage {
      stableSnapshotCalls = 0;

      override async withStableProjectSnapshot<T>(
        _projectId: string,
        _read: () => Promise<T>
      ): Promise<T> {
        this.stableSnapshotCalls += 1;
        return new Promise<T>(() => {
          // A recovery response must never enter this unresolved barrier.
        });
      }
    }
    const eventHub = new EventHub();
    const storage = new RecoveryStorage(root, eventHub);
    const now = new Date().toISOString();
    const recoveryProject = {
      id: "prj_00000000000000000000000000000000",
      title: "Storage recovery",
      requirement: "Expose recovery diagnostics without reading partial files.",
      status: "paused",
      phase: "storage-recovery-required",
      createdAt: now,
      updatedAt: now,
      turn: 1,
      cycle: 1,
      eventSeq: 1,
      consecutiveFailures: 1,
      runCounts: {
        idea: 1,
        main: 0,
        execution: 0,
        writing: 0,
        review: 0
      },
      agents: {}
    } as unknown as ProjectState;
    const orchestrator = {
      getProject: async () => structuredClone(recoveryProject)
    } as unknown as Orchestrator;
    const skills = testSkillCatalog();
    const app = createApp({
      orchestrator,
      storage,
      eventHub,
      skills,
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 },
      harnessVersion: "fixture-harness test"
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/projects/${recoveryProject.id}`
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        project: ProjectState;
        events: unknown[];
        artifacts: unknown[];
        storageRecoveryRequired: boolean;
      };
      expect(body.project.phase).toBe("storage-recovery-required");
      expect(body.events).toEqual([]);
      expect(body.artifacts).toEqual([]);
      expect(body.storageRecoveryRequired).toBe(true);
      expect(storage.stableSnapshotCalls).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("validates and forwards user intervention responses to Main", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-api-intervention-")
    );
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const calls: Array<{ projectId: string; message: string }> = [];
    const now = new Date().toISOString();
    const project = {
      id: "prj_00000000000000000000000000000001",
      title: "User intervention API",
      requirement: "Resume Main after the user resolves an authorization blocker.",
      status: "queued",
      phase: "main:queued",
      createdAt: now,
      updatedAt: now,
      queuedAgent: "main",
      turn: 2,
      cycle: 1,
      eventSeq: 4,
      consecutiveFailures: 0,
      runCounts: { idea: 1, main: 1, execution: 0, writing: 0, review: 0 },
      agents: {},
      userIntervention: {
        id: "usr_api",
        status: "answered",
        requestedAt: now,
        answeredAt: now,
        message: "Complete GitHub login.",
        rationale: "User authorization is required.",
        successCriteria: ["Confirm login."],
        response: "Login complete."
      }
    } as unknown as Awaited<ReturnType<Orchestrator["getProject"]>>;
    const orchestrator = {
      respondToUserIntervention: async (projectId: string, message: string) => {
        calls.push({ projectId, message });
        return project;
      }
    } as unknown as Orchestrator;
    const app = createApp({
      orchestrator,
      storage,
      eventHub,
      skills: testSkillCatalog(),
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 },
      harnessVersion: "fixture-harness test"
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const endpoint =
      `http://127.0.0.1:${port}/api/projects/${project!.id}/intervention/respond`;

    try {
      const invalid = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" })
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Login complete." })
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        { projectId: project!.id, message: "Login complete." }
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("accepts project-level user requirements for the next Main invocation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-api-user-input-")
    );
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const calls: Array<{ projectId: string; message: string }> = [];
    const projectId = "prj_00000000000000000000000000000002";
    const orchestrator = {
      addProjectUserInput: async (id: string, message: string) => {
        calls.push({ projectId: id, message });
        return {
          id: projectId,
          userInputs: [
            {
              id: "inp_api",
              status: "pending",
              createdAt: new Date().toISOString(),
              message,
              targetMainInvocation: 3
            }
          ]
        };
      }
    } as unknown as Orchestrator;
    const app = createApp({
      orchestrator,
      storage,
      eventHub,
      skills: testSkillCatalog(),
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 },
      harnessVersion: "fixture-harness test"
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const endpoint =
      `http://127.0.0.1:${port}/api/projects/${projectId}/user-inputs`;

    try {
      const invalid = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" })
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Add a robustness ablation to this research task."
        })
      });
      expect(response.status).toBe(202);
      expect(calls).toEqual([
        {
          projectId,
          message: "Add a robustness ablation to this research task."
        }
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("streams project explainer events as NDJSON and exposes persistent history", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-api-explainer-")
    );
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const projectId = "prj_00000000000000000000000000000003";
    const project = { id: projectId } as Awaited<
      ReturnType<Orchestrator["getProject"]>
    >;
    const orchestrator = {
      getProject: async (id: string) => (id === projectId ? project : undefined)
    } as unknown as Orchestrator;
    const historicalEvent: ProjectExplainerEvent = {
      id: "explainer_event_history",
      projectId,
      turnId: "explainer_turn_history",
      kind: "assistant",
      text: "历史回答",
      ts: "2026-08-08T00:00:00.000Z",
      phase: "completed"
    };
    let active = false;
    let receivedQuestion = "";
    const resetCalls: string[] = [];
    const cancelCalls: string[] = [];
    let releaseCancel!: () => void;
    const waitForCancel = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let cancelStartedResolve!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      cancelStartedResolve = resolve;
    });
    let releaseSecondEvent: (() => void) | undefined;
    const waitForSecondEvent = new Promise<void>((resolve) => {
      releaseSecondEvent = resolve;
    });
    const projectExplainer: ProjectExplainerPort = {
      isActive: () => active,
      async history(id, limit) {
        expect(id).toBe(projectId);
        expect(limit).toBe(17);
        return { events: [historicalEvent], active };
      },
      async reset(id) {
        if (active) throw new ProjectExplainerBusyError();
        resetCalls.push(id);
      },
      async cancel(id) {
        expect(id).toBe(projectId);
        cancelCalls.push(id);
        cancelStartedResolve();
        await waitForCancel;
        active = false;
      },
      async ask(id, question, sink, signal) {
        expect(id).toBe(projectId);
        expect(signal.aborted).toBe(false);
        receivedQuestion = question;
        await sink({
          id: "explainer_event_user",
          projectId,
          turnId: "explainer_turn_stream",
          kind: "user",
          text: question,
          ts: "2026-08-08T00:01:00.000Z",
          phase: "completed"
        });
        await waitForSecondEvent;
        await sink({
          id: "explainer_event_assistant",
          projectId,
          turnId: "explainer_turn_stream",
          itemId: "answer_stream",
          kind: "assistant",
          text: "流式回答",
          ts: "2026-08-08T00:01:01.000Z",
          phase: "delta"
        });
      },
      async getConfig() {
        return {
          schemaVersion: 2,
          harness: "fixture",
          nativeProtocol: "responses",
          gatewayProtocol: "responses",
          model: "test-model",
          reasoningEffort: "high",
          revision: 0,
          updatedAt: "2026-08-08T00:00:00.000Z",
          available: true,
          routeMode: "direct"
        };
      },
      async updateConfig() { return this.getConfig(projectId); },
      async shutdown() {}
    };
    const app = createApp({
      orchestrator,
      storage,
      eventHub,
      skills: testSkillCatalog(),
      projectExplainer,
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 },
      harnessVersion: "fixture-harness test"
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const endpoint =
      `http://127.0.0.1:${port}/api/projects/${projectId}/explainer`;

    try {
      const historyResponse = await fetch(`${endpoint}/history?limit=17`);
      expect(historyResponse.status).toBe(200);
      await expect(historyResponse.json()).resolves.toEqual({
        events: [historicalEvent],
        active: false
      });

      const resetResponse = await fetch(`${endpoint}/reset`, {
        method: "POST"
      });
      expect(resetResponse.status).toBe(204);
      expect(resetCalls).toEqual([projectId]);

      const response = await fetch(`${endpoint}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "这项研究现在完成了什么？" })
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/x-ndjson"
      );
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const reader = response.body!.getReader();
      const firstChunk = await reader.read();
      expect(firstChunk.done).toBe(false);
      const decoder = new TextDecoder();
      const firstLine = decoder.decode(firstChunk.value).trim();
      expect(JSON.parse(firstLine)).toMatchObject({
        kind: "user",
        text: "这项研究现在完成了什么？"
      });
      expect(receivedQuestion).toBe("这项研究现在完成了什么？");

      releaseSecondEvent?.();
      let remaining = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        remaining += decoder.decode(chunk.value, { stream: true });
      }
      remaining += decoder.decode();
      expect(JSON.parse(remaining.trim())).toMatchObject({
        kind: "assistant",
        text: "流式回答",
        phase: "delta"
      });

      active = true;
      const busyResetResponse = await fetch(`${endpoint}/reset`, {
        method: "POST"
      });
      expect(busyResetResponse.status).toBe(409);
      await expect(busyResetResponse.json()).resolves.toEqual({
        error: "Project explainer already has an active turn"
      });
      const busyResponse = await fetch(`${endpoint}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "第二个并发问题" })
      });
      expect(busyResponse.status).toBe(409);
      await expect(busyResponse.json()).resolves.toEqual({
        error: "Project explainer already has an active turn"
      });

      const cancelResponse = fetch(`${endpoint}/turns/cancel`, {
        method: "POST"
      });
      await cancelStarted;
      await expect(
        Promise.race([
          cancelResponse.then(() => "completed"),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25))
        ])
      ).resolves.toBe("pending");
      releaseCancel();
      const completedCancelResponse = await cancelResponse;
      expect(completedCancelResponse.status).toBe(204);
      expect(cancelCalls).toEqual([projectId]);
      expect(active).toBe(false);
    } finally {
      releaseSecondEvent?.();
      releaseCancel();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns durable failure history in the state API projection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-failure-api-"));
    temporaryRoots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    await storage.initialize();
    const projectId = "prj_failure_history";
    const orchestrator = {
      async getProject(id: string) {
        if (id !== projectId) return undefined;
        return {
          id,
          failureAttempts: [{
            attemptId: "attempt-api-1",
            projectId: id,
            scope: "git",
            operation: "initialization",
            status: "failed",
            errorCode: "GITHUB_PROVIDER_FAILED",
            retryable: true,
            redactedMessage: "provider unavailable",
            causeClass: "GitHubProviderError",
            startedAt: "2026-09-24T00:00:00.000Z",
            finishedAt: "2026-09-24T00:00:01.000Z",
            metadata: {}
          }],
          failureSummary: {
            currentStatus: "failed",
            totalAttempts: 1,
            failedAttempts: 1,
            succeededAttempts: 0,
            unresolvedFailures: 1,
            operations: []
          }
        };
      }
    } as unknown as Orchestrator;
    const app = createApp({
      orchestrator,
      storage,
      eventHub,
      skills: testSkillCatalog(),
      config: { modelSuggestions: ["test-model"], maxEventHistory: 2 },
      harnessVersion: "fixture-harness test"
    });

    await request(app)
      .get(`/api/projects/${projectId}?view=state`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.project).toMatchObject({
          id: projectId,
          failureAttempts: [{
            attemptId: "attempt-api-1",
            status: "failed",
            errorCode: "GITHUB_PROVIDER_FAILED"
          }],
          failureSummary: {
            currentStatus: "failed",
            totalAttempts: 1,
            unresolvedFailures: 1
          }
        });
      });
  });
});
