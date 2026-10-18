import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentConfigPresetStore,
  DEFAULT_AGENT_CONFIG_PRESET_ID
} from "../src/agent-config-presets.js";
import { BUILTIN_AGENT_PROMPTS } from "../src/prompt.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";

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

function nestedOrchestration() {
  const orchestration = cloneAgentOrchestrationTemplate();
  orchestration.schemaVersion = 3;
  orchestration.collaborations = ["parent", "child"].map((id) => ({
    id, displayName: id, memberAgentIds: ["idea", "execution"], renamePolicy: "editable" as const
  }));
  orchestration.scopedWorkflow = {
    schemaVersion: 1,
    rootAgentIds: orchestration.agents.map((agent) => agent.name),
    groups: ["parent", "child"].map((id) => ({
      id,
      ...(id === "child" ? { parentGroupId: "parent" } : {}),
      leaderAgentId: id === "parent" ? "review" : "writing",
      allowLeaderReconfiguration: false,
      workflow: {
        nodes: [
          ...["idea", "execution"].map((agentId) => ({ kind: "agent" as const, nodeId: `${id}_${agentId}`, agentId })),
          ...(id === "parent" ? [{ kind: "collaboration" as const, nodeId: "child", groupId: "child" }] : [])
        ],
        input: { source: "input", edges: [...[`${id}_idea`, `${id}_execution`], ...(id === "parent" ? ["child"] : [])]
          .map((target) => ({ target, kind: "parallel" as const })) },
        routes: Object.fromEntries([...[`${id}_idea`, `${id}_execution`], ...(id === "parent" ? ["child"] : [])]
          .map((nodeId) => [nodeId, [{ target: "finish", kind: "strong" as const }]]))
      }
    }))
  };
  orchestration.routes.parent = [{ target: "review", kind: "strong" }];
  orchestration.decisionPlans.parent = "Use the completed parent result.";
  orchestration.routes.main.push({ target: "parent", kind: "weak" });
  return orchestration;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("AgentConfigPresetStore", () => {
  it("reads old Agent proxy fields without rewriting the library and omits them from a saved current preset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-old-proxy-presets-")); temporaryRoots.push(root);
    const store = new AgentConfigPresetStore(root), orchestration = cloneAgentOrchestrationTemplate();
    const created = await store.create({ name: "Original preset", agents: mergeAgentConfigs(undefined, orchestration), orchestration });
    const file = path.join(root, "agent-config-presets.json"), raw = JSON.parse(await fs.readFile(file, "utf8"));
    for (const config of Object.values(raw.presets[0].agents) as Record<string, unknown>[]) config.proxy = { mode: "direct" };
    await fs.writeFile(file, JSON.stringify(raw)); const original = await fs.readFile(file);
    const restored = (await new AgentConfigPresetStore(root).list()).find(entry => entry.id === created.id)!;
    expect(restored).toBeTruthy(); for (const config of Object.values(restored.agents)) expect(config).not.toHaveProperty("proxy");
    expect(await fs.readFile(file)).toEqual(original);
    const updated = await store.update(created.id, { name: "Current preset", agents: restored.agents, orchestration });
    expect(updated).toBeTruthy();
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    for (const config of Object.values(saved.presets[0].agents)) expect(config).not.toHaveProperty("proxy");
    expect((await new AgentConfigPresetStore(root).list()).find(entry => entry.id === created.id)?.agents).toEqual(restored.agents);
  });

  it("provides the current defaults and persists one complete updatable preset per project", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-agent-presets-")
    );
    temporaryRoots.push(root);
    const store = new AgentConfigPresetStore(root);
    const agents = mergeAgentConfigs({
      execution: {
        model: "custom-execution-model",
        reasoningEffort: "xhigh",
        instructions: "Run the exported experiment configuration.",
        skills: ["builtin:experiment-runner", "builtin:inspire"],
        autoSkills: ["builtin:nature-figure"],
        mcpServers: [
          { name: "metrics", url: "https://metrics.example.test/mcp" }
        ],
        permission: "compute",
        webSearch: true
      }
    });
    const orchestration = cloneAgentOrchestrationTemplate();
    orchestration.input.target = "execution";
    orchestration.routes.execution = [{ target: "writing", kind: "strong" }];
    agents.execution.skills.push("project:experiment-protocol");
    agents.execution.mcpServers.push({ name: "local-metrics", project: "local-metrics" });
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
    const project = {
      id: "prj_00000000000000000000000000000001",
      title: "可复用实验配置",
      agents,
      orchestration,
      skillDefinitions,
      mcpDefinitions
    };

    const initial = await store.list();
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      id: DEFAULT_AGENT_CONFIG_PRESET_ID,
      name: "系统默认配置",
      builtin: true
    });
    expect(initial[0].agents.main.instructions).toContain("structured routing decision");
    expect(initial[0].agents).toHaveProperty("main");
    expect(initial[0].agents).not.toHaveProperty("__system_controller__");
    expect(initial[0].agents.execution).toMatchObject({
      permission: "compute",
      webSearch: true
    });
    const saved = await store.saveFromProject(project);
    expect(saved).toMatchObject({
      id: expect.stringMatching(/^cfg_[a-f0-9]{32}$/),
      name: "可复用实验配置 · Agent 配置",
      builtin: false,
      sourceProjectId: project.id,
      sourceProjectTitle: project.title
    });
    expect(saved.agents.execution.mcpServers).toEqual([
      { name: "metrics", url: "https://metrics.example.test/mcp" },
      { name: "local-metrics", project: "local-metrics" }
    ]);
    expect(saved.agents).not.toHaveProperty("__system_controller__");
    expect(saved.agents.main.permission).toBe("yolo");
    expect(saved.agents.execution).toEqual(agents.execution);
    expect(saved.orchestration).toEqual(orchestration);
    expect(saved.skillDefinitions).toEqual(skillDefinitions);
    expect(saved.mcpDefinitions).toEqual(mcpDefinitions);
    expect(saved.agents.execution).toMatchObject({
      model: "custom-execution-model",
      instructions: "Run the exported experiment configuration.",
      permission: "compute",
      webSearch: true
    });
    expect(saved.agents.execution).not.toHaveProperty("reasoningEffort");

    agents.execution.model = "updated-execution-model";
    const updated = await store.saveFromProject(project, "更新后的配置");
    expect(updated.id).toBe(saved.id);
    expect(updated.name).toBe("更新后的配置");
    expect(updated.agents.execution.model).toBe("updated-execution-model");
    expect(updated.skillDefinitions).toEqual(skillDefinitions);
    expect(updated.mcpDefinitions).toEqual(mcpDefinitions);

    const reloaded = await new AgentConfigPresetStore(root).list();
    expect(reloaded).toHaveLength(2);
    expect(reloaded[1]).toEqual(updated);
    expect(
      (await fs.stat(path.join(root, "agent-config-presets.json"))).mode & 0o777
    ).toBe(0o600);

    expect(await store.delete(DEFAULT_AGENT_CONFIG_PRESET_ID)).toBe(false);
    expect(await store.delete(updated.id)).toBe(true);
    expect(await store.delete(updated.id)).toBe(false);
    expect(await new AgentConfigPresetStore(root).list()).toEqual([
      expect.objectContaining({
        id: DEFAULT_AGENT_CONFIG_PRESET_ID,
        builtin: true
      })
    ]);
  });

  it("hides legacy presets that omit the public Main orchestration contract", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-agent-presets-invalid-")
    );
    temporaryRoots.push(root);
    const agents = structuredClone(
      mergeAgentConfigs(undefined)
    ) as unknown as Record<string, Record<string, unknown>>;
    for (const config of Object.values(agents)) delete config.mcpServers;
    await fs.writeFile(
      path.join(root, "agent-config-presets.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        presets: [
          {
            schemaVersion: 1,
            kind: "scienceevolve-agent-config-preset",
            id: "cfg_00000000000000000000000000000009",
            name: "旧版无 MCP 配置",
            builtin: false,
            sourceProjectId: "prj_00000000000000000000000000000009",
            sourceProjectTitle: "旧版项目",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            agents
          }
        ]
      })}\n`,
      "utf8"
    );

    const listed = await new AgentConfigPresetStore(root).list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: DEFAULT_AGENT_CONFIG_PRESET_ID,
      builtin: true
    });
  });

  it("reloads v2 collaboration presets using outer-node Main routes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-agent-presets-collaboration-")
    );
    temporaryRoots.push(root);
    const orchestration = groupedOrchestration();
    const store = new AgentConfigPresetStore(root);
    const saved = await store.saveFromProject({
      id: "prj_00000000000000000000000000000007",
      title: "Collaboration preset",
      agents: mergeAgentConfigs(undefined, orchestration),
      orchestration
    });

    const reloaded = await new AgentConfigPresetStore(root).list();
    expect(reloaded).toContainEqual(saved);
    expect(saved.orchestration.routes.main.map((edge) => edge.target)).toEqual([
      "delivery_group",
      "writing",
      "review"
    ]);
  });

  it.each(["create", "project", "subset-root"] as const)("reloads, updates and deletes a nested v3 preset saved through %s", async (source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-agent-presets-nested-"));
    temporaryRoots.push(root);
    const orchestration = nestedOrchestration();
    if (source === "subset-root") {
      orchestration.scopedWorkflow!.rootAgentIds = ["main", "review"];
      orchestration.input.target = "parent";
      orchestration.routes = {
        main: [{ target: "review", kind: "weak" }, { target: "parent", kind: "weak" }],
        parent: orchestration.routes.parent!, review: orchestration.routes.review!
      };
      orchestration.decisionPlans = Object.fromEntries(["main", "review", "parent"]
        .map((id) => [id, orchestration.decisionPlans[id]!]));
    }
    const agents = mergeAgentConfigs({ idea: { instructions: "Shared nested prompt", experimentMcp: false } }, orchestration);
    const input = { name: "Nested preset", agents, orchestration };
    const store = new AgentConfigPresetStore(root);
    const saved = source !== "project" ? await store.create(input) : await store.saveFromProject({
      id: "prj_00000000000000000000000000000008", title: input.name, agents, orchestration
    }, input.name);
    expect(await new AgentConfigPresetStore(root).list()).toContainEqual(saved);
    expect(saved.orchestration.routes.main.map((edge) => edge.target)).toEqual(source === "subset-root"
      ? ["review", "parent"] : ["idea", "execution", "writing", "review", "parent"]);
    expect(saved.orchestration.scopedWorkflow).toEqual(orchestration.scopedWorkflow);
    const updated = await new AgentConfigPresetStore(root).update(saved.id, { ...input, name: "Updated nested preset" });
    expect(updated?.id).toBe(saved.id);
    expect(updated?.agents.idea.instructions).toBe("Shared nested prompt");
    expect(await new AgentConfigPresetStore(root).list()).toContainEqual(updated);
    expect(await new AgentConfigPresetStore(root).delete(saved.id)).toBe(true);
    expect(await new AgentConfigPresetStore(root).list()).toHaveLength(1);
  });

  it.each(["missing", "nested-target", "order", "strong", "invalid-graph"])("still hides a malformed v3 preset: %s", async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-agent-presets-nested-invalid-"));
    temporaryRoots.push(root);
    const orchestration = nestedOrchestration();
    const store = new AgentConfigPresetStore(root);
    const saved = await store.create({ name: "Nested preset", orchestration });
    const routes = saved.orchestration.routes.main;
    if (kind === "missing") routes.pop();
    if (kind === "nested-target") routes.push({ target: "child", kind: "weak" });
    if (kind === "order") routes.reverse();
    if (kind === "strong") routes[0]!.kind = "strong";
    if (kind === "invalid-graph") saved.orchestration.scopedWorkflow!.groups[0]!.workflow.input.edges[0]!.target = "review";
    await fs.writeFile(path.join(root, "agent-config-presets.json"), JSON.stringify({ schemaVersion: 2, presets: [saved] }));
    expect(await new AgentConfigPresetStore(root).list()).toHaveLength(1);
  });

  it("hides persisted presets whose Main fixed routes are not canonical", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-agent-presets-main-routes-")
    );
    temporaryRoots.push(root);
    const orchestration = cloneAgentOrchestrationTemplate();
    orchestration.routes.main = [{ target: "idea", kind: "strong" }];
    const agents = mergeAgentConfigs(undefined, orchestration);
    await fs.writeFile(
      path.join(root, "agent-config-presets.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        presets: [{
          schemaVersion: 1,
          kind: "scienceevolve-agent-config-preset",
          id: "cfg_00000000000000000000000000000003",
          name: "固定边异常预设",
          builtin: false,
          sourceProjectId: "prj_00000000000000000000000000000003",
          sourceProjectTitle: "固定边异常项目",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          agents,
          orchestration
        }]
      })}\n`,
      "utf8"
    );

    expect(await new AgentConfigPresetStore(root).list()).toEqual([
      expect.objectContaining({ id: DEFAULT_AGENT_CONFIG_PRESET_ID })
    ]);
  });
});
