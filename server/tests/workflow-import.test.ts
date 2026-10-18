import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { parseWorkflowImport } from "../src/workflow-import.js";
import { AgentConfigPresetStore } from "../src/agent-config-presets.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs, normalizeAgentOrchestrationTemplate } from "../src/validation.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { Orchestrator } from "../src/orchestrator.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
function document() {
  return { schemaVersion: 2, name: "SDK example", agents: Object.fromEntries(Object.entries(mergeAgentConfigs(undefined)).map(([name, config]) => [name, { ...config, gatewaySource: "profile", gatewayReasoningOption: "sdk-option" }])), orchestration: cloneAgentOrchestrationTemplate() };
}
function parse(value: unknown) { return parseWorkflowImport({ filename: "workflow.json", text: JSON.stringify(value) }); }

function collaborationDocument(version: 2 | 3) {
  const raw = document();
  const selected = version === 3 ? ["main", "idea", "execution", "writing"] : ["main", "idea", "execution"];
  raw.agents = Object.fromEntries(Object.entries(raw.agents).filter(([name]) => selected.includes(name)));
  raw.orchestration.agents = raw.orchestration.agents.filter((agent) => selected.includes(agent.name));
  raw.orchestration.schemaVersion = version;
  raw.orchestration.collaborations = [{
    id: "integration", displayName: "Integration", memberAgentIds: version === 3 ? ["idea"] : ["idea", "execution"], renamePolicy: "locked"
  }];
  raw.orchestration.input.target = "integration";
  raw.orchestration.routes = {
    main: [{ target: "integration", kind: "strong" }],
    integration: [{ target: "finish", kind: "strong" }]
  };
  raw.orchestration.termination.agent = "integration";
  raw.orchestration.decisionPlans = {main: "Keep SDK routes", integration: "Integrate deliveries"};
  if (version === 3) {
    raw.orchestration.collaborations.push({
      id: "feature_team", displayName: "Features", memberAgentIds: ["execution", "writing"], renamePolicy: "locked"
    });
    raw.orchestration.scopedWorkflow = {
      schemaVersion: 1, rootAgentIds: ["main"], groups: [{
        id: "integration", leaderAgentId: "main", allowLeaderReconfiguration: false,
        workflow: {
          nodes: [{kind: "agent", nodeId: "foundation", agentId: "idea"}, {kind: "collaboration", nodeId: "features", groupId: "feature_team"}],
          input: {source: "input", edges: [{target: "foundation", kind: "parallel"}]},
          routes: {foundation: [{target: "features", kind: "strong"}], features: [{target: "finish", kind: "strong"}]}
        }
      }, {
        id: "feature_team", parentGroupId: "integration", leaderAgentId: "main", allowLeaderReconfiguration: false,
        workflow: {
          nodes: [{kind: "agent", nodeId: "feature_a", agentId: "execution"}, {kind: "agent", nodeId: "feature_b", agentId: "writing"}],
          input: {source: "input", edges: [{target: "feature_a", kind: "parallel"}, {target: "feature_b", kind: "parallel"}]},
          routes: {feature_a: [{target: "finish", kind: "strong"}], feature_b: [{target: "finish", kind: "strong"}]}
        }
      }]
    };
  }
  return raw;
}

describe("SDK Workflow import", () => {
  it.each([2, 3] as const)("imports v%s collaboration references without normalizing SDK routes", (version) => {
    const raw = collaborationDocument(version);
    const imported = parse(raw);
    expect(imported.orchestration).toEqual(raw.orchestration);
    expect(imported.orchestration.routes.main).toEqual([{target: "integration", kind: "strong"}]);
    expect(() => normalizeAgentOrchestrationTemplate(imported.orchestration)).not.toThrow();
  });

  it.each(["feature_team", "feature_a", "execution"])("rejects scoped child %s as a root route", (target) => {
    const raw = collaborationDocument(3);
    raw.orchestration.routes.main = [{target, kind: "strong"}];
    expect(() => parse(raw)).toThrow(z.ZodError);
  });

  it("checks group input, termination and loop references against the root scope", () => {
    const raw = collaborationDocument(3);
    raw.orchestration.input.target = "feature_team";
    raw.orchestration.termination.agent = "execution";
    raw.orchestration.loops = [{id: "root_loop", from: "integration", to: "main", maxIterations: 1, exitTo: "feature_team"}];
    try { parse(raw); throw new Error("validation did not reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
        "orchestration.input.target", "orchestration.termination.agent", "orchestration.loops.0.exitTo"
      ]));
    }
  });

  it("validates HTTP imports atomically and returns persistent source metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-import-api-"));
    roots.push(root);
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub);
    const skills = new SkillCatalog([]);
    const orchestrator = new Orchestrator(storage, skills, { run: async () => { throw new Error("Import must not run an Agent"); } }, { retryBaseMs: 1, retryMaxMs: 10 });
    const app = createApp({ storage, eventHub, skills, orchestrator, config: { modelSuggestions: [], maxEventHistory: 10 } });
    const raw = document();
    const malformed = structuredClone(raw);
    Object.assign(malformed.agents.idea, { model: 123 });
    const bad = await request(app).post("/api/agent-config-presets/import").send({ filename: "workflow.json", text: JSON.stringify(malformed) });
    expect(bad.status).toBe(400);
    expect(bad.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["agents", "idea", "model"] })]));
    expect((await request(app).get("/api/agent-config-presets")).body.presets).toHaveLength(1);
    raw.agents.idea.skills = ["../skills/missing"];
    const text = JSON.stringify(raw, null, 2);
    const good = await request(app).post("/api/agent-config-presets/import").send({ filename: "workflow.json", text });
    expect(good.status).toBe(201);
    expect(good.body.preset.importSource.text).toBe(text);
    expect((await request(app).get("/api/agent-config-presets")).body.presets).toHaveLength(1);
    const listed = (await request(app).get("/api/agent-config-presets?includeVisualizations=true")).body.presets;
    expect(listed).toHaveLength(2);
    expect(listed[1].importSource).toEqual(good.body.preset.importSource);
    const update = await request(app).put(`/api/agent-config-presets/${good.body.preset.id}`).send({ name: "Edited", agents: good.body.preset.agents, orchestration: good.body.preset.orchestration });
    expect(update.status).toBe(400);
    expect(update.body.error).toContain("read-only");
  });

  it("preserves SDK routes and settings across storage without resolving runtime resources", async () => {
    const raw = document();
    raw.agents.idea.skills = ["./skills/method", "project:not-installed"];
    raw.agents.main.sessionPersistence = false;
    raw.orchestration.routes.main = [{ target: "idea", kind: "strong" }];
    raw.agents.idea.mcpServers = [{ name: "not-installed", project: "not-installed" }];
    const text = `\uFEFF${JSON.stringify(raw, null, 2)}\n`;
    const input = parseWorkflowImport({ filename: "workflow.json", text });
    expect(input.agents.idea.skills).toEqual(raw.agents.idea.skills);
    expect(input.agents.main).not.toHaveProperty("gatewaySource");
    expect(input.agents.main).not.toHaveProperty("gatewayId");
    expect(input.agents.main).not.toHaveProperty("gatewayReasoningOption");
    expect(input.importSource.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "agents.main.gatewaySource" }),
      expect.objectContaining({ path: "agents.main.gatewayReasoningOption" })
    ]));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-import-"));
    roots.push(root);
    const store = new AgentConfigPresetStore(root);
    const saved = await store.create(input);
    const reloaded = (await new AgentConfigPresetStore(root).list()).find((item) => item.id === saved.id)!;
    expect(reloaded.importSource?.text).toBe(text);
    expect(reloaded.agents.idea.skills).toEqual(raw.agents.idea.skills);
    expect(reloaded.orchestration.routes.main).toEqual(raw.orchestration.routes.main);
    expect(reloaded.agents.main.sessionPersistence).toBe(false);
    expect(reloaded.agents.idea.mcpServers).toEqual(raw.agents.idea.mcpServers);
    await expect(store.update(saved.id, { ...input, name: "Edited" })).rejects.toThrow("read-only");
    expect((await store.list()).find((item) => item.id === saved.id)?.importSource?.text).toBe(text);
  });

  it.each([
    ["model type", (raw: ReturnType<typeof document>) => { Object.assign(raw.agents.idea, { model: 123 }); }, "agents.idea.model"],
    ["nested unknown", (raw: ReturnType<typeof document>) => { Object.assign(raw.orchestration.input, { extra: true }); }, "orchestration.input"],
    ["malformed Main routes", (raw: ReturnType<typeof document>) => { Object.assign(raw.orchestration.routes, { main: "wrong" }); }, "orchestration.routes.main"],
    ["missing Agent", (raw: ReturnType<typeof document>) => { delete raw.agents.idea; }, "agents.idea"],
    ["undefined route", (raw: ReturnType<typeof document>) => { raw.orchestration.input.target = "missing"; }, "orchestration.input.target"],
    ["unsupported gateway", (raw: ReturnType<typeof document>) => { Object.assign(raw.agents.idea, { gatewayId: "secret" }); }, "agents.idea"],
    ["invalid Skill contents", (raw: ReturnType<typeof document>) => { Object.assign(raw, { skillDefinitions: { bad: { files: {} } } }); }, "skillDefinitions.bad.files"]
  ])("rejects %s with a precise path", (_label, mutate, expectedPath) => {
    const raw = document();
    mutate(raw);
    try { parse(raw); throw new Error("validation did not reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues.some((issue) => issue.path.join(".") === expectedPath)).toBe(true);
    }
  });

  it("rejects invalid JSON and unsupported root fields", () => {
    expect(() => parseWorkflowImport({ filename: "workflow.json", text: "{broken" })).toThrow("不是有效的 JSON");
    expect(() => parse({ ...document(), unsupported: true })).toThrow("unsupported");
  });
});
