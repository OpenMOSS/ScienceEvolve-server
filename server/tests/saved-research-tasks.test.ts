import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs, normalizeDraftAgentOrchestrationTemplate, normalizeNewGitOrchestration } from "../src/validation.js";

const temporaryRoots: string[] = [];

function groupedOrchestration() {
  const orchestration = cloneAgentOrchestrationTemplate();
  orchestration.schemaVersion = 2;
  orchestration.collaborations = [{
    id: "delivery_group",
    displayName: "Delivery group",
    memberAgentIds: ["idea", "execution"],
    renamePolicy: "editable"
  }];
  orchestration.input.target = "delivery_group";
  delete orchestration.routes.idea;
  delete orchestration.routes.execution;
  orchestration.routes.delivery_group = [{ target: "writing", kind: "strong" }];
  delete orchestration.decisionPlans.idea;
  delete orchestration.decisionPlans.execution;
  orchestration.decisionPlans.delivery_group = "Coordinate member delivery.";
  orchestration.routes.main = [
    { target: "delivery_group", kind: "weak" },
    { target: "writing", kind: "weak" },
    { target: "review", kind: "weak" }
  ];
  return orchestration;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("SavedResearchTaskStore", () => {
  it.each([2, 3] as const)("round-trips a v%s task with more than fifty Agents and their configurations", async schemaVersion => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-large-team-")); temporaryRoots.push(root);
    const store = new SavedResearchTaskStore(root);
    let orchestration = cloneAgentOrchestrationTemplate();
    for (let index = 0; index < 60; index += 1) {
      const name = `researcher_${index}`;
      orchestration.agents.push({ name, template: "general" });
      orchestration.routes[name] = [{ target: "main", kind: "strong" }];
      orchestration.decisionPlans[name] = "Return verified evidence to Main.";
    }
    if (schemaVersion === 3) orchestration = normalizeNewGitOrchestration(orchestration);
    const created = await store.create({ title: "Large research team", requirement: "Retain the complete configured team without a count cap.",
      orchestration, agents: mergeAgentConfigs(undefined, orchestration), git: { enabled: schemaVersion === 3 } });
    const reloaded = await new SavedResearchTaskStore(root).get(created.id);
    expect(reloaded.orchestration.agents).toHaveLength(65);
    expect(reloaded.orchestration.routes.main).toHaveLength(64);
    expect(Object.keys(reloaded.agents)).toHaveLength(65);
    expect(reloaded).toEqual(created);
  });

  it("keeps an old saved task readable without restoring proxy or rewriting its source, then saves only current fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-old-proxy-tasks-")); temporaryRoots.push(root);
    const store = new SavedResearchTaskStore(root), orchestration = cloneAgentOrchestrationTemplate();
    const created = await store.create({ title: "Original saved task", requirement: "Retain the original task", orchestration,
      agents: mergeAgentConfigs(undefined, orchestration) });
    const file = path.join(root, "saved-research-tasks.json"), raw = JSON.parse(await fs.readFile(file, "utf8"));
    for (const config of Object.values(raw.tasks[0].agents) as Record<string, unknown>[]) config.proxy = { mode: "inherit" };
    await fs.writeFile(file, JSON.stringify(raw)); const original = await fs.readFile(file);
    const restored = (await new SavedResearchTaskStore(root).list()).find(entry => entry.id === created.id)!;
    expect(restored).toBeTruthy(); for (const config of Object.values(restored.agents)) expect(config).not.toHaveProperty("proxy");
    expect(await fs.readFile(file)).toEqual(original);
    await store.update(created.id, { title: restored.title, requirement: restored.requirement, orchestration: restored.orchestration,
      agents: restored.agents, git: restored.git });
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    for (const config of Object.values(saved.tasks[0].agents)) expect(config).not.toHaveProperty("proxy");
    expect((await new SavedResearchTaskStore(root).list()).find(entry => entry.id === created.id)?.agents).toEqual(restored.agents);
  });

  it.each([false, true])("reloads and updates a v3 Git draft with nested groups %s", async (nested) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-saved-tasks-v3-"));
    temporaryRoots.push(root);
    let orchestration = normalizeNewGitOrchestration(cloneAgentOrchestrationTemplate());
    if (nested) {
      const strong = (target: string) => [{ target, kind: "strong" }];
      orchestration = normalizeDraftAgentOrchestrationTemplate({ ...orchestration,
        collaborations: ["G", "H"].map(id => ({ id, displayName: id, memberAgentIds: [], renamePolicy: "editable" })),
        scopedWorkflow: { schemaVersion: 1, rootAgentIds: ["main", "idea", "review"], groups: [
          { id: "G", leaderAgentId: "main", allowLeaderReconfiguration: true,
            workflow: { nodes: [{ kind: "collaboration", nodeId: "child_h", groupId: "H" },
              { kind: "agent", nodeId: "writing_in", agentId: "writing" }],
              input: { source: "input", edges: [{ target: "child_h", kind: "parallel" }] },
              routes: { child_h: strong("writing_in"), writing_in: strong("finish") } } },
          { id: "H", parentGroupId: "G", leaderAgentId: "main", allowLeaderReconfiguration: false,
            workflow: { nodes: [{ kind: "agent", nodeId: "idea_in", agentId: "idea" },
              { kind: "agent", nodeId: "execution_in", agentId: "execution" }],
              input: { source: "input", edges: [{ target: "idea_in", kind: "parallel" }] },
              routes: { idea_in: strong("execution_in"), execution_in: strong("finish") } } }
        ] },
        routes: { main: [], idea: strong("G"), G: strong("review"), review: strong("finish") },
        decisionPlans: { main: "start", idea: "contract", G: "nested work", review: "verify" }
      });
    }
    const input = { title: "Saved scoped draft", requirement: "Preserve nested shared identities and pending edits.",
      agents: mergeAgentConfigs(undefined, orchestration), orchestration,
      git: { enabled: true, provider: "github" as const, repositoryName: "saved-scoped-draft" } };
    const created = await new SavedResearchTaskStore(root).create(input);
    const reloaded = new SavedResearchTaskStore(root);
    expect(await reloaded.get(created.id)).toEqual(created);
    expect(await reloaded.list()).toEqual([created]);
    const updated = await reloaded.update(created.id, { ...input, title: "Updated scoped draft" });
    expect(updated?.orchestration).toEqual(created.orchestration);
    expect((await new SavedResearchTaskStore(root).get(created.id))?.title).toBe("Updated scoped draft");

    const disconnected = structuredClone(orchestration);
    disconnected.routes.review = [];
    const unfinished = await reloaded.update(created.id, { ...input, orchestration: disconnected });
    expect(await new SavedResearchTaskStore(root).get(created.id)).toEqual(unfinished);

    const filename = path.join(root, "saved-research-tasks.json");
    const persisted = JSON.parse(await fs.readFile(filename, "utf8"));
    persisted.tasks[0].orchestration.routes.main[0].kind = "strong";
    await fs.writeFile(filename, JSON.stringify(persisted));
    expect(await new SavedResearchTaskStore(root).list()).toEqual([]);
  });

  it("persists, updates, lists and deletes a complete reusable task", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-saved-tasks-")
    );
    temporaryRoots.push(root);
    const store = new SavedResearchTaskStore(root);
    const agents = mergeAgentConfigs({
      execution: {
        model: "saved-task-model",
        reasoningEffort: "xhigh",
        instructions: "Run the saved task experiments.",
        skills: ["builtin:inspire"],
        autoSkills: ["builtin:nature-figure"],
        mcpServers: [
          { name: "datasets", url: "https://datasets.example.test/mcp" }
        ],
        permission: "compute",
        webSearch: true
      }
    });

    const orchestration = cloneAgentOrchestrationTemplate();
    orchestration.input.target = "execution";
    orchestration.routes.execution = [{ target: "writing", kind: "strong" }];
    agents.execution.skills.push("project:experiment-protocol");
    agents.execution.mcpServers.push({
      name: "local-metrics",
      project: "local-metrics"
    });
    const skillDefinitions = {
      "experiment-protocol": {
        files: { "SKILL.md": "# Experiment protocol\n\nRun the local protocol." }
      }
    };
    const mcpDefinitions = {
      "local-metrics": {
        files: { "server.cjs": "process.stdin.resume();\n" },
        command: "node",
        entrypoint: "server.cjs",
        args: [],
        envFrom: {}
      }
    };
    expect(await store.list()).toEqual([]);
    const created = await store.create({
      title: "可重复启动的科研任务",
      requirement: "验证保存后的任务能够携带完整智能体配置再次启动。",
      agents,
      orchestration,
      skillDefinitions,
      mcpDefinitions
    });
    expect(created).toMatchObject({
      id: expect.stringMatching(/^task_[a-f0-9]{32}$/),
      kind: "scienceevolve-saved-research-task",
      title: "可重复启动的科研任务"
    });
    expect(created.agents.execution).toEqual(agents.execution);
    expect(created.agents.main.permission).toBe("yolo");
    expect(created.agents).not.toHaveProperty("__system_controller__");
    expect(created.orchestration).toEqual(orchestration);
    expect(created.skillDefinitions).toEqual(skillDefinitions);
    expect(created.mcpDefinitions).toEqual(mcpDefinitions);
    expect(await store.get(created.id)).toEqual(created);

    const updated = await store.update(created.id, {
      title: "编辑后的科研任务",
      requirement: "修改需求后仍需保留模型、Prompt、Skills 与 MCP 配置。",
      agents: {
        ...agents,
        review: { ...agents.review, model: "updated-review-model" }
      },
      orchestration,
      skillDefinitions,
      mcpDefinitions
    });
    expect(updated).toMatchObject({
      id: created.id,
      title: "编辑后的科研任务",
      createdAt: created.createdAt
    });
    expect(updated!.agents.review.model).toBe("updated-review-model");
    expect(updated!.skillDefinitions).toEqual(skillDefinitions);
    expect(updated!.mcpDefinitions).toEqual(mcpDefinitions);
    expect(await new SavedResearchTaskStore(root).list()).toEqual([updated]);
    expect(
      (await fs.stat(path.join(root, "saved-research-tasks.json"))).mode & 0o777
    ).toBe(0o600);

    expect(await store.delete(created.id)).toBe(true);
    expect(await store.delete(created.id)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("hides legacy Controller tasks without blocking valid task reads", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-saved-tasks-legacy-")
    );
    temporaryRoots.push(root);
    const currentOrchestration = cloneAgentOrchestrationTemplate();
    const currentAgents = mergeAgentConfigs(undefined, currentOrchestration);
    const timestamp = "2026-08-01T00:00:00.000Z";
    await fs.writeFile(
      path.join(root, "saved-research-tasks.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        tasks: [
          {
            schemaVersion: 2,
            kind: "scienceevolve-saved-research-task",
            id: "task_00000000000000000000000000000001",
            title: "旧 Controller 任务",
            requirement: "不应暴露",
            createdAt: timestamp,
            updatedAt: timestamp,
            agents: { ...currentAgents, __system_controller__: currentAgents.main },
            orchestration: currentOrchestration
          },
          {
            schemaVersion: 2,
            kind: "scienceevolve-saved-research-task",
            id: "task_00000000000000000000000000000002",
            title: "公开 Main 任务",
            requirement: "应正常读取",
            createdAt: timestamp,
            updatedAt: timestamp,
            agents: currentAgents,
            orchestration: currentOrchestration
          }
        ]
      })}\n`,
      "utf8"
    );

    const listed = await new SavedResearchTaskStore(root).list();
    expect(listed.map((task) => task.title)).toEqual(["公开 Main 任务"]);
  });

  it("round-trips a collaboration task's required Git creation choice", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-saved-tasks-collaboration-")
    );
    temporaryRoots.push(root);
    const store = new SavedResearchTaskStore(root);
    const orchestration = groupedOrchestration();
    const input = {
      title: "Git collaboration task",
      requirement: "Retain the explicit Git choice with the reusable draft.",
      agents: mergeAgentConfigs(undefined, orchestration),
      orchestration
    };

    await expect(store.create(input)).rejects.toThrow(/要求启用 Git 机制/);
    const created = await store.create({
      ...input,
      git: {
        enabled: true,
        provider: "github",
        repositoryName: "collaboration-task",
        repositoryVisibility: "public"
      }
    });
    expect(created.git).toEqual({
      enabled: true,
      provider: "github",
      repositoryName: "collaboration-task",
      repositoryVisibility: "public"
    });
    expect(await new SavedResearchTaskStore(root).get(created.id)).toEqual(created);
  });

  it("hides persisted tasks whose Main fixed routes are not canonical", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-saved-tasks-main-routes-")
    );
    temporaryRoots.push(root);
    const orchestration = cloneAgentOrchestrationTemplate();
    orchestration.routes.main = [{ target: "idea", kind: "strong" }];
    const agents = mergeAgentConfigs(undefined, orchestration);
    await fs.writeFile(
      path.join(root, "saved-research-tasks.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        tasks: [{
          schemaVersion: 1,
          kind: "scienceevolve-saved-research-task",
          id: "task_00000000000000000000000000000003",
          title: "固定边异常任务",
          requirement: "不应自动修复",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          agents,
          orchestration
        }]
      })}\n`,
      "utf8"
    );

    expect(await new SavedResearchTaskStore(root).list()).toEqual([]);
  });
});
