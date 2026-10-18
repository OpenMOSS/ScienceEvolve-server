import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { AgentToolRecommendationService, agentToolRecommendationInputSchema } from "../src/agent-tool-recommendations.js";
import { createApp, type AppDependencies } from "../src/app.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/harness-runtime/registry.js";
import type { ExplainerRecommendationInput, ExplainerRecommendationConfiguration } from "../src/project-explainer.js";

const empty = () => ({ skills: [], autoSkills: [], mcpServers: [], experimentMcp: false, reasons: ["当前任务不需要额外业务工具。"] });
const skills = [{ id: "builtin:verify", name: "Verify", description: "Verify results", source: "builtin" as const, path: "/private/catalog/SKILL.md" }];
function setup(output: unknown = empty()) {
  const harnesses = harnessCatalogRegistry.list().map(item => toPublicHarnessDescriptor(item, { available: true }));
  const config: ExplainerRecommendationConfiguration = { fingerprint: "a".repeat(64), config: {
    schemaVersion: 2, harness: "codex", gatewayId: `gwy_${"b".repeat(32)}`, nativeProtocol: "responses", gatewayProtocol: "responses",
    model: "explainer-model", reasoningEffort: "high", revision: 0, updatedAt: "", available: true, routeMode: "direct"
  } };
  const explainer = {
    getRecommendationConfig: vi.fn(async (_id?: string) => structuredClone(config)), updateDraftConfig: vi.fn(),
    generateRecommendation: vi.fn(async (_input: ExplainerRecommendationInput, _signal: AbortSignal) => ({ answer: JSON.stringify(output), configurationFingerprint: config.fingerprint }))
  };
  const list = vi.fn(async () => skills);
  const service = new AgentToolRecommendationService({ harnessCatalog: async () => harnesses }, { list }, explainer);
  return { service, config, explainer, list, harnesses };
}
async function input(service: AgentToolRecommendationService) {
  const orchestration = cloneAgentOrchestrationTemplate();
  const agents = mergeAgentConfigs(undefined, orchestration);
  for (const config of Object.values(agents)) config.harness = "codex";
  agents.idea!.instructions = "读取给定材料，制定可验证的研究方案";
  return agentToolRecommendationInputSchema.parse({ title: "新任务", requirement: "完成可验证的研究流程", agents, orchestration,
    targetAgent: "idea", contextFingerprint: "local-context-v1", configurationFingerprint: "a".repeat(64), catalogFingerprint: (await service.catalog()).fingerprint });
}

describe("single Agent tool recommendations", () => {
  it("uses the actual Explainer and returns an empty preview without modifying any Agent, graph or configuration", async () => {
    const { service, explainer } = setup(); const current = await input(service); const before = structuredClone(current);
    const result = await service.recommend(current, new AbortController().signal);
    expect(result).toMatchObject({ targetAgent: "idea", selection: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false }, contextFingerprint: current.contextFingerprint });
    expect(current).toEqual(before); expect(explainer.updateDraftConfig).not.toHaveBeenCalled();
    const call = explainer.generateRecommendation.mock.calls[0]![0];
    expect(call.configurationFingerprint).toBe(current.configurationFingerprint);
    expect(call.evidence).toMatchObject({ targetAgent: "idea", task: { agents: { idea: { instructions: before.agents!.idea!.instructions } } } });
    expect(call.instructions).not.toContain(before.agents!.idea!.instructions);
    expect(JSON.stringify(call.evidence)).not.toContain("/private/catalog");
  });

  it("allows an unverified Explainer and includes its warning in the tool recommendation", async () => {
    const { service, config, explainer } = setup();
    config.config.validationWarning = "当前组合尚未通过验证，仍可使用，但运行可能失败。";
    const result = await service.recommend(await input(service), new AbortController().signal);
    expect(explainer.generateRecommendation).toHaveBeenCalledOnce();
    expect(result.warnings).toContain(config.config.validationWarning);
  });

  it("provides the complete nested graph, loops and all shared identity roles", async () => {
    const { service, explainer } = setup({ ...empty(), experimentMcp: true }); const current = await input(service);
    current.orchestration.schemaVersion = 3;
    current.orchestration.scopedWorkflow = { schemaVersion: 1, rootAgentIds: ["main", "idea"], groups: [
      { id: "parent", leaderAgentId: "review", allowLeaderReconfiguration: true, workflow: { nodes: [{ kind: "collaboration", nodeId: "child", groupId: "child" }],
        input: { source: "input", edges: [{ target: "child", kind: "parallel" }] }, routes: { child: [{ target: "finish", kind: "strong" }] } } },
      { id: "child", parentGroupId: "parent", leaderAgentId: "idea", allowLeaderReconfiguration: false, workflow: {
        nodes: [{ kind: "agent", nodeId: "same_worker", agentId: "execution" }], input: { source: "input", edges: [{ target: "same_worker", kind: "parallel" }] },
        routes: { same_worker: [{ target: "finish", kind: "strong" }] }, loops: [{ id: "repeat", from: "same_worker", to: "same_worker", exitTo: "finish", maxIterations: 2 }] } }
    ] };
    expect((await service.recommend(current, new AbortController().signal)).selection.experimentMcp).toBe(true);
    expect(explainer.generateRecommendation.mock.calls[0]![0].evidence).toMatchObject({ businessWorker: true,
      task: { orchestration: { scopedWorkflow: current.orchestration.scopedWorkflow } } });
    // Remove the Worker occurrence but retain the same identity as a Leader.
    current.orchestration.scopedWorkflow.rootAgentIds = ["main"];
    current.orchestration.scopedWorkflow.groups[1]!.workflow.nodes = [];
    await expect(service.recommend(current, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
  });

  it("uses only accepted sanitized project resources and the target's own custom MCP", async () => {
    const output = { skills: ["project:check"], autoSkills: ["builtin:verify"], mcpServers: [{ name: "check", project: "check" }, { name: "custom", url: "https://custom.example/mcp" }], experimentMcp: true, reasons: ["验证任务使用项目检查工具。"] };
    const { service, explainer } = setup(output); const current = await input(service);
    const resources = async () => ({ skillDefinitions: { check: { files: { "SKILL.md": "---\nname: check\ndescription: Check results\n---\nprivate-skill" } } },
      mcpDefinitions: { check: { entrypoint: "server.cjs", args: ["private-argument"], envFrom: { TOKEN: "PRIVATE_TOKEN" }, files: { "server.cjs": "private-source", "README.md": "# Check results" } } } });
    current.agents!.idea!.mcpServers = [{ name: "custom", url: "https://custom.example/mcp" }];
    current.catalogFingerprint = (await service.catalog(resources)).fingerprint;
    const result = await service.recommend(current, new AbortController().signal, [], resources);
    const { reasons: _reasons, ...expectedSelection } = output;
    expect(result.selection).toEqual(expectedSelection);
    expect(Object.keys(result.selection).sort()).toEqual(["autoSkills", "experimentMcp", "mcpServers", "skills"]);
    const evidence = JSON.stringify(explainer.generateRecommendation.mock.calls[0]![0].evidence);
    for (const value of ["private-source", "private-skill", "private-argument", "PRIVATE_TOKEN"]) expect(evidence).not.toContain(value);
  });

  it.each([
    { ...empty(), skills: ["invented"] }, { ...empty(), skills: ["builtin:verify"], autoSkills: ["builtin:verify"] },
    { ...empty(), mcpServers: [{ name: "other-agent", url: "https://other.example/mcp" }] },
    { ...empty(), mcpServers: [{ name: "scienceevolve-sii", url: "https://invented.example/mcp" }] },
    { ...empty(), permission: "yolo" }, { ...empty(), instructions: "replace the user's prompt" },
    { skills: [], autoSkills: [], mcpServers: [], reasons: ["missing choice"] }
  ])("rejects invalid references, extra fields and incomplete contracts with one bounded regeneration", async output => {
    const { service, explainer } = setup(output); const current = await input(service);
    current.agents!.review!.mcpServers = [{ name: "other-agent", url: "https://other.example/mcp" }];
    await expect(service.recommend(current, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    expect(explainer.generateRecommendation).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported target Harness capabilities and Main experiment selection", async () => {
    const { service, harnesses } = setup({ ...empty(), skills: ["builtin:verify"] }); const current = await input(service);
    harnesses.find(item => item.id === "codex")!.capabilities.skills = false;
    current.catalogFingerprint = (await service.catalog()).fingerprint;
    await expect(service.recommend(current, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    const main = setup({ ...empty(), experimentMcp: true }); const mainInput = await input(main.service); mainInput.targetAgent = "main";
    await expect(main.service.recommend(mainInput, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
  });

  it("gives its one regeneration a precise missing-field diagnostic without changing the draft", async () => {
    const { service, explainer } = setup(); const current = await input(service);
    const before = structuredClone(current);
    explainer.generateRecommendation.mockImplementationOnce(async () => ({
      answer: JSON.stringify({ skills: [], autoSkills: [], mcpServers: [], reasons: ["无额外业务工具"] }),
      configurationFingerprint: current.configurationFingerprint
    }));
    const result = await service.recommend(current, new AbortController().signal);
    expect(explainer.generateRecommendation).toHaveBeenCalledTimes(2);
    expect(explainer.generateRecommendation.mock.calls[1]![0].evidence).toMatchObject({
      recovery: { previousFailure: expect.stringContaining("experimentMcp") },
      outputShape: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false }
    });
    expect(result.selection.experimentMcp).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(current).toEqual(before);
  });

  it("reports the failed contract without disclosing unknown model keys or values", async () => {
    const { service, explainer } = setup({ ...empty(), "private-credential-field": "private-model-token" });
    const current = await input(service);
    const error = await service.recommend(current, new AbortController().signal).catch(error => error);
    expect(error).toMatchObject({ status: 502, message: expect.stringContaining("输出字段仅限") });
    for (const value of ["private-credential-field", "private-model-token"]) {
      expect(error.message).not.toContain(value);
      expect(JSON.stringify(explainer.generateRecommendation.mock.calls[1]![0].evidence.recovery)).not.toContain(value);
    }
    expect(explainer.generateRecommendation).toHaveBeenCalledTimes(2);
  });

  it("preserves actual Explainer media gaps in the validated target preview", async () => {
    const { service, explainer } = setup(); const current = await input(service);
    const warning = "当前只读 Explainer 未解析 image.png 图片内容。";
    explainer.generateRecommendation.mockResolvedValue(Object.assign({ answer: JSON.stringify(empty()),
      configurationFingerprint: current.configurationFingerprint }, { inputWarnings: [warning, warning] }));
    expect((await service.recommend(current, new AbortController().signal)).warnings).toEqual([warning]);
  });

  it("rejects stale config/catalog before and during invocation without retrying transport/config failures", async () => {
    const { service, config, explainer } = setup(); const current = await input(service);
    await expect(service.recommend({ ...current, catalogFingerprint: "f".repeat(64) }, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    expect(explainer.generateRecommendation).not.toHaveBeenCalled();
    explainer.generateRecommendation.mockImplementation(async () => { config.fingerprint = "c".repeat(64); return { answer: JSON.stringify(empty()), configurationFingerprint: config.fingerprint }; });
    await expect(service.recommend(current, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    expect(explainer.generateRecommendation).toHaveBeenCalledOnce();
    const transport = setup(); const transportInput = await input(transport.service);
    transport.explainer.generateRecommendation.mockRejectedValue(new Error("private transport token"));
    await expect(transport.service.recommend(transportInput, new AbortController().signal)).rejects.toMatchObject({ status: 502, message: "Project Explainer 工具推荐失败；现有配置未更改。" });
    expect(transport.explainer.generateRecommendation).toHaveBeenCalledOnce();
  });

  it("passes read-only attachments and cancels the original Explainer invocation on shutdown", async () => {
    const { service, explainer } = setup(); const current = await input(service); const attachments = [{ path: "notes.txt", kind: "text" as const, text: "用户输入" }];
    explainer.generateRecommendation.mockImplementation((_request, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const pending = service.recommend(current, new AbortController().signal, attachments);
    await vi.waitFor(() => expect(explainer.generateRecommendation).toHaveBeenCalledOnce());
    expect(explainer.generateRecommendation.mock.calls[0]![0].attachments).toEqual(attachments);
    service.shutdown(); await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it("validates API input and resolves existing resources without creating a project", async () => {
    const { service } = setup(); const current = await input(service); const projectId = `prj_${"d".repeat(32)}`;
    const createProject = vi.fn(); const getProject = vi.fn(async (id: string) => id === projectId ? { id, skillDefinitions: {}, mcpDefinitions: {} } : undefined);
    const app = createApp({ storage: { root: process.cwd() }, orchestrator: { createProject, getProject }, skills: {}, eventHub: {}, agentToolRecommendations: service,
      config: { modelSuggestions: [], maxEventHistory: 10 } } as unknown as AppDependencies);
    const catalog = await request(app).get("/api/agent-tool-recommendations/catalog").expect(200);
    expect(catalog.body.fingerprint).toBe(current.catalogFingerprint);
    await request(app).post("/api/agent-tool-recommendations").send(current).expect(200);
    await request(app).post("/api/agent-tool-recommendations").send({ ...current, title: "", requirement: "" }).expect(200);
    await request(app).post("/api/agent-tool-recommendations").send({ ...current, skillDefinitions: { invented: {} } }).expect(400);
    await request(app).post("/api/agent-tool-recommendations").send({ ...current, targetAgent: "absent" }).expect(400);
    await request(app).get(`/api/agent-tool-recommendations/catalog?projectId=prj_${"e".repeat(32)}`).expect(404);
    await request(app).get("/api/agent-tool-recommendations/catalog?projectId=../other").expect(400);
    await request(app).post("/api/agent-tool-recommendations").send({ ...current, projectId }).expect(200);
    expect(getProject).toHaveBeenCalledWith(projectId); expect(createProject).not.toHaveBeenCalled();
  });
});
