import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExplainerAssistantStore, assistantInstructions } from "../src/explainer-assistant.js";
import { EXPLAINER_TOOLS, openExplainerAssistantMcp } from "../src/explainer-assistant-mcp.js";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { fixedMcpDefinition } from "../src/mcp-directory.js";
import { isExplainerMcp } from "../src/internal/shared/explainer-tools.js";
import type { ProjectState } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-assistant-")); roots.push(root);
  const tasks = new SavedResearchTaskStore(root);
  const skills = new SkillCatalog([path.join(root, "builtin-skills")], path.join(root, "user-skills"));
  const route = { harness: "fixture-harness", gatewayId: `gwy_${"a".repeat(32)}`, model: "configured/exact-model" };
  let official = { revision: 7, hash: "a".repeat(64) };
  const submitWorkflow = vi.fn(async (_id: string, input: Record<string, unknown>) => {
    if (JSON.stringify(input.base) !== JSON.stringify(official)) throw new Error("stale official Workflow version");
    return { record: { requestId: input.requestId, status: "pending" } };
  });
  const project = vi.fn(async () => undefined as ProjectState | undefined);
  const store = new ExplainerAssistantStore(root, { tasks, skills, catalog: async () => ({ availableRoutes: [route] }), project,
    workflow: async () => ({ current: { version: official, snapshot: {} } }), submitWorkflow });
  const context = await store.create();
  return { root, tasks, skills, store, context, route, project, submitWorkflow, setOfficial: (version: typeof official) => { official = version; } };
}
const mutation = (revision: number, operationId: string, patch?: unknown) => ({ expectedRevision: revision, operationId, ...(patch ? { patch } : {}) });

describe("Project Explainer agent tools and durable project drafts", () => {
  it("returns a small context overview and opens only the selected Agent or draft field", async () => {
    const f = await setup();
    const requirement = "CANONICAL_RESEARCH_REQUIREMENT";
    const instructions = "SELECTED_AGENT_DETAIL".repeat(900);
    await f.store.sync(f.context.id, { expectedRevision: 0, draft: { ...f.context.draft, requirement,
      agents: { ...f.context.draft.agents, idea: { ...f.context.draft.agents?.idea, instructions } } } });
    const overview = (await f.store.call(f.context.id, "get_context", {})).result as any;
    expect(overview.revision).toBe(1); expect(JSON.stringify(overview)).not.toContain(requirement);
    expect(JSON.stringify(overview)).not.toContain("SELECTED_AGENT_DETAIL");
    expect(JSON.stringify(overview).length).toBeLessThan(5000);
    expect((await f.store.call(f.context.id, "get_context", { section: "agent", key: "idea" })).result).toMatchObject({
      revision: 1, agentId: "idea", data: { instructions } });
    expect((await f.store.call(f.context.id, "get_context", { section: "draft", key: "requirement" })).result).toMatchObject({ data: requirement });
    expect(JSON.stringify((await f.store.call(f.context.id, "get_context", { section: "draft", key: "agents" })).result))
      .not.toContain("SELECTED_AGENT_DETAIL");
  });

  it("returns complete Agent and catalog indexes while opening only a selected detail", async () => {
    const f = await setup();
    await f.store.sync(f.context.id, { expectedRevision: 0, draft: { ...f.context.draft,
      agents: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`agent${index}`, { instructions: `DETAIL-${index}` }])) } });
    const first = (await f.store.call(f.context.id, "get_context", {})).result as any;
    expect(first.agents).toMatchObject({ total: 65 }); expect(first.agents.entries).toHaveLength(65);
    expect(first.agents.entries.at(-1).agentId).toBe("agent64"); expect(first.agents.nextPage).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("DETAIL-");
    const legacy = (await f.store.call(f.context.id, "get_context", { limit: 7, offset: 7 })).result as any;
    expect(legacy.agents).toEqual(first.agents);
    f.store.host.catalog = async () => ({ availableRoutes: Array.from({ length: 65 }, (_, index) => ({ ...f.route, id: `route-${index}`, instructions: "ROUTE_DETAIL_BODY".repeat(1000) })) });
    const routes = (await f.store.call(f.context.id, "get_context", { section: "catalog", key: "availableRoutes" })).result as any;
    expect(JSON.stringify(routes)).toContain(f.route.model); expect(JSON.stringify(routes)).not.toContain("ROUTE_DETAIL_BODY");
    expect(routes.data.entries).toHaveLength(65); expect(routes.data.nextPage).toBeUndefined();
    expect((await f.store.call(f.context.id, "get_context", { section: "catalog", key: "availableRoutes", entry: routes.data.entries.at(-1).entry })).result)
      .toMatchObject({ data: { ...f.route, id: "route-64" } });
    expect(EXPLAINER_TOOLS.find(tool => tool.name === "get_context")!.inputSchema.properties).not.toHaveProperty("offset");
    expect(EXPLAINER_TOOLS.find(tool => tool.name === "get_context")!.inputSchema.properties).not.toHaveProperty("limit");
    await expect(f.store.call(f.context.id, "get_context", { section: "catalog", key: "__proto__" })).rejects.toThrow("上下文字段");
    expect((await f.store.get(f.context.id)).revision).toBe(1);
  });

  it("lists project evidence fields and records before opening a selected history detail", async () => {
    const f = await setup(), id = `prj_${"e".repeat(32)}`;
    f.project.mockResolvedValue({ id, title: "运行项目", requirement: "按需检查历史记录",
      agents: f.context.draft.agents, orchestration: f.context.draft.orchestration } as ProjectState);
    const output = "SELECTED_HISTORICAL_DETAIL".repeat(1000);
    f.store.host.evidence = async () => ({ history: [{ id: "old", output }], status: "running" });
    await f.store.bindProject(f.context.id, id);
    const fields = (await f.store.call(id, "get_context", { section: "evidence" })).result as any;
    expect(fields.data.fields).toEqual(["history", "status"]);
    expect(JSON.stringify(fields)).not.toContain("SELECTED_HISTORICAL_DETAIL");
    const list = (await f.store.call(id, "get_context", { section: "evidence", key: "history" })).result as any;
    expect(list.data.entries[0]).toMatchObject({ id: "old", entry: "0" });
    expect(JSON.stringify(list)).not.toContain("SELECTED_HISTORICAL_DETAIL");
    expect((await f.store.call(id, "get_context", { section: "evidence", key: "history", entry: "0" })).result)
      .toMatchObject({ data: { id: "old", output } });
  });

  it("preserves the research brief on configuration edits and reports an explicit research-task change separately", async () => {
    const f = await setup();
    const requirement = "比较多智能体 workflow 的故障恢复机制，基于可复现实验给出研究报告。";
    await f.store.call(f.context.id, "update_draft", mutation(0, "research-task-initial", { title: "Workflow 恢复研究", requirement }));
    const configured = await f.store.call(f.context.id, "update_draft", mutation(1, "configuration-only-edit", {
      agents: { main: { instructions: "按照研究目标协调证据分析和实验，保持任务边界。" } }, git: { enabled: true }
    }));
    expect(configured.action!.context.draft.requirement).toBe(requirement);
    expect(configured.action!.changedFields).not.toContain("requirement");
    expect((await f.tasks.list())[0].requirement).toBe(requirement);
    const evidence = await f.store.contextEvidence(f.context.id);
    expect(evidence.draftFieldGuidance.requirement).toContain("workflow's research Agents");
    expect(evidence.draftFieldGuidance.orchestration).toContain("instead of appending them to requirement");
    const refined = `${requirement} 重点量化并行任务的恢复耗时。`;
    const changed = await f.store.call(f.context.id, "update_draft", mutation(2, "research-task-refined", { requirement: refined }));
    expect(changed.action!.changedFields).toContain("requirement");
    expect((await f.tasks.list())[0].requirement).toBe(refined);
    expect(assistantInstructions(changed.action!.context)).toContain("judge the user's intent, not keywords");
    const patch = EXPLAINER_TOOLS.find(tool => tool.name === "update_draft")!.inputSchema.properties.patch as any;
    expect(patch.additionalProperties).toBe(false);
    expect(patch.properties.requirement.description).toContain("Preserve it on configuration-only edits");
    await f.store.call(f.context.id, "update_draft", mutation(3, "unused-definition-added", {
      skillDefinitions: { research_notes: { files: { "SKILL.md": "# Research notes" } } }
    }));
    const cleaned = await f.store.call(f.context.id, "update_draft", mutation(4, "unused-definition-removed", { skillDefinitions: null }));
    expect(cleaned.action!.changedFields).toContain("skillDefinitions");
    expect(cleaned.action!.context.draft.requirement).toBe(refined);
  });
  it("saves and resumes Agent-created Git drafts with an empty optional repository name", async () => {
    const f = await setup();
    const edited = await f.store.call(f.context.id, "update_draft", mutation(0, "blank-repository-edit", {
      title: "待完善的 Git 草稿", requirement: "先设计研究流程，仓库名称由用户稍后填写", git: { enabled: true, repositoryName: "   " }
    }));
    expect(edited.action!.context.draft.git).toEqual({ enabled: true });
    const [saved] = await f.tasks.list();
    expect(saved.git).toEqual({ enabled: true });
    const restarted = new ExplainerAssistantStore(f.root, f.store.host);
    expect((await restarted.create({ taskId: saved.id })).draft.git).toEqual({ enabled: true });
    const updated = await restarted.call(f.context.id, "update_draft", mutation(1, "named-repository-edit", { git: { repositoryName: "research-draft" } }));
    expect(updated.action!.context.draft.git.repositoryName).toBe("research-draft");
    expect((await f.tasks.get(saved.id))!.git.repositoryName).toBe("research-draft");
  });

  it.each(["open", "bind"] as const)("imports editable Agent settings from a real runtime project without its gateway snapshots (%s)", async mode => {
    const f = await setup(), projectId = `prj_${"d".repeat(32)}`;
    const agents = structuredClone(f.context.draft.agents);
    for (const agent of Object.values(agents)) Object.assign(agent, { gatewaySnapshot: {
      id: f.route.gatewayId, name: "Runtime gateway", protocol: "responses", nativeProtocol: "responses", routeMode: "direct",
      url: "https://gateway.example.test/v1", apiKey: "server-only-secret", models: [f.route.model], defaultModel: f.route.model
    } });
    const project = { id: projectId, title: "现有研究项目", requirement: "导入真实运行配置后继续使用同一个助手",
      agents, orchestration: f.context.draft.orchestration, status: "completed", phase: "accepted" } as unknown as ProjectState;
    f.project.mockResolvedValue(project);
    if (mode === "bind") await f.store.bindProject(f.context.id, projectId);
    const context = mode === "open" ? await f.store.create({ projectId }) : await f.store.get(projectId);
    expect(context.draft.agents.main).toMatchObject(f.route);
    expect(context.draft.agents.main).not.toHaveProperty("gatewaySnapshot");
    expect(context.workflowBase).toEqual({ revision: 7, hash: "a".repeat(64) });
    const stored = await fs.readFile(path.join(f.store.directory(context.id), "context.json"), "utf8");
    expect(stored).not.toContain("gatewaySnapshot"); expect(stored).not.toContain("server-only-secret");
    expect(project.agents.main.gatewaySnapshot?.apiKey).toBe("server-only-secret");
  });

  it("saves one real draft, replays exact operations and never exposes a launch tool", async () => {
    const f = await setup();
    const input = mutation(0, "edit-operation-1", { title: "分析草稿", requirement: "分析合成数据并生成可复现验证报告" });
    const edited = await f.store.call(f.context.id, "update_draft", input);
    expect(edited.action?.context.revision).toBe(1);
    expect(edited.action?.href).toMatch(/^\/saved-tasks\/task_[a-f0-9]{32}\/edit$/);
    expect(await f.tasks.list()).toHaveLength(1);
    expect(await f.store.call(f.context.id, "update_draft", input)).toEqual(edited);
    await expect(f.store.call(f.context.id, "update_draft", { ...input, patch: { title: "另一份请求" } })).rejects.toThrow("同一操作编号");
    const save = mutation(1, "save-operation-1"), result = await f.store.call(f.context.id, "save_draft", save);
    await f.store.call(f.context.id, "save_draft", save);
    expect(await f.tasks.list()).toHaveLength(1);
    expect(result.action?.href).toMatch(/^\/saved-tasks\/task_[a-f0-9]{32}\/edit$/);
    expect(result.action?.summary).toContain("尚未启动");
    expect(EXPLAINER_TOOLS.map(tool => tool.name)).not.toContain("create_project");
    expect(await fs.readdir(f.root)).not.toContain("projects");
    const restarted = new ExplainerAssistantStore(f.root, f.store.host);
    expect((await restarted.create({ taskId: result.action!.context.taskId })).id).toBe(f.context.id);
  });

  it("rejects a stale agent edit after the user has changed the draft and preserves user text", async () => {
    const f = await setup();
    await f.store.sync(f.context.id, { expectedRevision: 0, draft: { ...f.context.draft, title: "用户最新草稿", requirement: "用户正在核对最新的研究需求" } });
    await expect(f.store.call(f.context.id, "update_draft", mutation(0, "stale-operation", { title: "过时回答" }))).rejects.toThrow("不要覆盖用户");
    expect((await f.store.get(f.context.id)).draft.title).toBe("用户最新草稿");
    await expect(f.store.call(f.context.id, "undo_draft", mutation(1, "undo-operation"))).rejects.toThrow("没有可撤销");
  });

  it("lets the agent form and save a real three-member collaboration while keeping research unstarted", async () => {
    const f = await setup();
    const graph = structuredClone(f.context.draft.orchestration);
    graph.collaborations = [{ id: "analysis_group", displayName: "并行分析", memberAgentIds: ["idea", "execution", "writing"], renamePolicy: "editable" }];
    graph.input.target = "analysis_group";
    graph.routes.main = [{ target: "analysis_group", kind: "weak" }, { target: "review", kind: "weak" }];
    for (const name of ["idea", "execution", "writing"]) { (graph.routes as Record<string, unknown>)[name] = null; (graph.decisionPlans as Record<string, unknown>)[name] = null; }
    graph.routes.analysis_group = [{ target: "review", kind: "strong" }]; graph.decisionPlans.analysis_group = "汇总三名成员证据后交给独立复核。";
    await f.store.call(f.context.id, "update_draft", mutation(0, "group-operation", { title: "并行分析", requirement: "三个 Agent 并行分析后独立复核", git: { enabled: true }, orchestration: graph }));
    await f.store.call(f.context.id, "save_draft", mutation(1, "save-group-operation"));
    const [task] = await f.tasks.list();
    expect(task.orchestration.collaborations[0].memberAgentIds).toEqual(["idea", "execution", "writing"]);
    expect(task.orchestration.routes.main.map(edge => edge.target)).toEqual(["analysis_group", "review"]);
    expect(task.git.enabled).toBe(true); expect(await fs.readdir(f.root)).not.toContain("projects");
  });

  it("keeps a saved draft updated and makes undo persistent instead of only changing the chat text", async () => {
    const f = await setup();
    await f.store.call(f.context.id, "update_draft", mutation(0, "first-operation", { title: "原草稿", requirement: "可复现的实验分析与验证" }));
    const saved = await f.store.call(f.context.id, "save_draft", mutation(1, "save-first-operation"));
    await f.store.call(f.context.id, "update_draft", mutation(1, "second-operation", { title: "修改后草稿" }));
    expect((await f.tasks.get(saved.action!.context.taskId!))?.title).toBe("修改后草稿");
    await f.store.call(f.context.id, "undo_draft", mutation(2, "undo-second-operation"));
    expect((await f.tasks.get(saved.action!.context.taskId!))?.title).toBe("原草稿");
  });

  it("rejects invented model routes without changing the prior draft", async () => {
    const f = await setup();
    await expect(f.store.call(f.context.id, "update_draft", mutation(0, "wrong-model-operation", {
      title: "错误路由", requirement: "验证模型路由不能被助手随意编造", agents: { main: { model: "invented-model" } }
    }))).rejects.toThrow("availableRoutes");
    expect((await f.store.get(f.context.id)).revision).toBe(0);
  });

  it.each([
    ["skills", "builtin:citation-check"], ["autoSkills", "builtin:citation-check"],
    ["skills", "builtin:invented-review-tool"], ["autoSkills", "builtin:invented-review-tool"]
  ] as const)("rejects unavailable %s references before changing a saved draft (%s)", async (field, reference) => {
    const f = await setup();
    await f.store.call(f.context.id, "update_draft", mutation(0, "initial-resource-draft", {
      title: "有效草稿", requirement: "配置实际存在的 Skill 并保持用户草稿不被错误操作覆盖"
    }));
    const before = await f.store.get(f.context.id), task = await f.tasks.get(before.taskId!);
    await expect(f.store.call(f.context.id, "update_draft", mutation(1, "invalid-resource-edit", {
      agents: { review: { [field]: [reference] } }
    }))).rejects.toThrow(`Agent review 的 ${field} 配置无效`);
    expect(await f.store.get(f.context.id)).toEqual(before);
    expect(await f.tasks.get(before.taskId!)).toEqual(task);
    await expect(fs.access(path.join(f.store.directory(f.context.id), "actions", "invalid-resource-edit.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses fresh installed Skill discovery and accepts real paths, project Skills and correctly typed MCPs", async () => {
    const f = await setup();
    expect(await f.skills.list()).toEqual([]);
    const installed = path.join(f.root, "builtin-skills", "installed-audit");
    const external = path.join(f.root, "external-audit");
    for (const directory of [installed, external]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: installed-audit\ndescription: Check evidence.\n---\n# Evidence checks\n");
    }
    const mcp = fixedMcpDefinition("citation-check")!;
    const result = await f.store.call(f.context.id, "update_draft", mutation(0, "valid-resource-edit", {
      title: "真实业务工具", requirement: "使用已安装 Skill、真实路径及项目定义，MCP 仍保留自己的类型",
      agents: { review: { skills: ["builtin:installed-audit", "project:evidence_check"], autoSkills: [path.join(external, "SKILL.md")],
        mcpServers: [{ name: mcp.name, url: mcp.url }, { name: "local-check", project: "local_check" }] },
        execution: { skills: ["installed-audit"] } },
      skillDefinitions: { evidence_check: { files: { "SKILL.md": "# Check project evidence" } } },
      mcpDefinitions: { local_check: { files: { "index.mjs": "throw new Error('configuration must not execute MCP');" }, entrypoint: "index.mjs" } }
    }));
    const task = (await f.tasks.get(result.action!.context.taskId!))!;
    expect(task.agents.review.skills).toEqual(["builtin:installed-audit", "project:evidence_check"]);
    expect(task.agents.review.autoSkills).toEqual([path.join(external, "SKILL.md")]);
    expect(task.agents.review.mcpServers[0]).toEqual({ name: mcp.name, url: mcp.url });
    expect(await fs.readdir(f.root)).not.toContain("projects");
  });

  it.each([
    { agents: { review: { skills: ["project:missing_check"] } } },
    { agents: { review: { mcpServers: [{ name: "missing-check", project: "missing_check" }] } } }
  ])("rejects undefined project resources before saving (%j)", async patch => {
    const f = await setup();
    await expect(f.store.call(f.context.id, "update_draft", mutation(0, "missing-project-resource", {
      title: "未定义工具", requirement: "不能保存未定义的项目工具引用", ...patch
    }))).rejects.toThrow("undefined project");
    expect((await f.store.get(f.context.id)).revision).toBe(0);
    expect(await f.tasks.list()).toEqual([]);
  });

  it("returns a repairable error when saving a manually synchronized invalid Skill selection", async () => {
    const f = await setup();
    const draft = structuredClone(f.context.draft);
    draft.title = "待修正草稿"; draft.requirement = "用户编辑过程中可以暂存尚未修正的工具引用";
    draft.agents!.review!.autoSkills = ["builtin:invented-review-tool"];
    await f.store.sync(f.context.id, { expectedRevision: 0, draft });
    await expect(f.store.call(f.context.id, "save_draft", mutation(1, "invalid-resource-save")))
      .rejects.toThrow("Agent review 的 autoSkills 配置无效");
    expect((await f.store.get(f.context.id)).revision).toBe(1);
    expect(await f.tasks.list()).toEqual([]);
  });

  it("keeps the repaired draft when undo would restore an old missing Skill", async () => {
    const f = await setup();
    const draft = structuredClone(f.context.draft);
    draft.title = "旧草稿"; draft.requirement = "撤销不应恢复旧的无效 Skill 配置";
    draft.agents!.review!.skills = ["builtin:invented-review-tool"];
    await f.store.sync(f.context.id, { expectedRevision: 0, draft });
    await f.store.call(f.context.id, "update_draft", mutation(1, "repair-old-skill", { agents: { review: { skills: [] } } }));
    const before = await f.store.get(f.context.id), task = await f.tasks.get(before.taskId!);
    await expect(f.store.call(f.context.id, "undo_draft", mutation(2, "undo-invalid-skill"))).rejects.toThrow("Agent review 的 skills 配置无效");
    expect(await f.store.get(f.context.id)).toEqual(before);
    expect(await f.tasks.get(before.taskId!)).toEqual(task);
  });

  it("validates Skills before submitting a manually synchronized runtime adjustment", async () => {
    const f = await setup(), id = `prj_${"e".repeat(32)}`;
    f.project.mockResolvedValue({ id, title: "运行项目", requirement: "提交运行配置之前核对真实工具引用",
      agents: f.context.draft.agents, orchestration: f.context.draft.orchestration } as ProjectState);
    await f.store.bindProject(f.context.id, id);
    const draft = (await f.store.get(id)).draft;
    draft.agents!.review!.skills = ["builtin:invented-review-tool"];
    await f.store.sync(id, { expectedRevision: 1, draft });
    await expect(f.store.call(id, "submit_workflow_adjustment", mutation(2, "submit-invalid-skill"))).rejects.toThrow("Agent review 的 skills 配置无效");
    expect(f.submitWorkflow).not.toHaveBeenCalled();
    expect((await f.store.get(id)).revision).toBe(2);
  });

  it("lets the native MCP loop repair a missing Skill without a false success receipt or duplicate draft", async () => {
    const f = await setup(), actions: unknown[] = [], controller = new AbortController();
    const endpoint = await openExplainerAssistantMcp(f.store, f.context.id, controller.signal, async action => { actions.push(action); });
    const client = new Client({ name: "resource-validation-agent", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      const bad = await client.callTool({ name: "update_draft", arguments: mutation(0, "native-invalid-skill", {
        title: "工具修正", requirement: "原生 Agent 根据真实错误修正 Skill 与 MCP 的区别",
        agents: { review: { skills: ["builtin:citation-check"] } }
      }) });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain("Agent review 的 skills 配置无效");
      expect(JSON.stringify(bad.content)).toContain("get_context");
      expect(actions).toHaveLength(0); expect(await f.tasks.list()).toEqual([]);
      const good = await client.callTool({ name: "update_draft", arguments: mutation(0, "native-repaired-skill", {
        title: "工具修正", requirement: "原生 Agent 根据真实错误修正 Skill 与 MCP 的区别", agents: { review: { skills: [] } }
      }) });
      expect(good.isError).not.toBe(true);
      expect(actions).toHaveLength(1); expect(await f.tasks.list()).toHaveLength(1);
      expect((await f.store.get(f.context.id)).revision).toBe(1);
    } finally { await client.close(); await endpoint.close(); }
  });

  it("detects edits saved by another window and gives the agent the actual latest draft", async () => {
    const f = await setup();
    await f.store.call(f.context.id, "update_draft", mutation(0, "initial-task-edit", { title: "原始草稿", requirement: "保护其他编辑窗口保存的配置与用户需求" }));
    const saved = await f.store.call(f.context.id, "save_draft", mutation(1, "initial-task-save"));
    const taskId = saved.action!.context.taskId!, task = (await f.tasks.get(taskId))!;
    await f.tasks.update(taskId, { ...taskDraftInput(task), title: "其他窗口新保存" });
    await expect(f.store.call(f.context.id, "update_draft", mutation(1, "outdated-task-edit", { title: "助手过时内容" }))).rejects.toThrow("最新草稿");
    const refreshed = await f.store.get(f.context.id);
    expect(refreshed.draft.title).toBe("其他窗口新保存"); expect(refreshed.revision).toBe(2);
    await expect(f.store.call(f.context.id, "undo_draft", mutation(2, "outdated-task-undo"))).rejects.toThrow("没有可撤销");
    await f.store.call(f.context.id, "update_draft", mutation(2, "fresh-task-edit", { requirement: "基于最新保存内容继续完善实验与核验要求" }));
    expect((await f.tasks.get(taskId))!.title).toBe("其他窗口新保存");
  });

  it("does not execute a cancelled mutation after it has waited behind another operation", async () => {
    const f = await setup(), controller = new AbortController();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const catalog = f.store.host.catalog;
    f.store.host.catalog = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return catalog(); };
    const first = f.store.call(f.context.id, "update_draft", mutation(0, "first-queued-edit", { title: "保留操作", requirement: "取消后面的工具操作不应修改草稿内容" }));
    await ready;
    const queued = f.store.call(f.context.id, "update_draft", mutation(1, "cancelled-queued-edit", { title: "不应发生" }), controller.signal);
    const rejected = expect(queued).rejects.toThrow(); controller.abort(); release(); await first; await rejected;
    expect((await f.store.get(f.context.id)).draft.title).toBe("保留操作");
  });

  it("retains the original Workflow base and rejects submission after an intervening official change", async () => {
    const f = await setup(), id = `prj_${"b".repeat(32)}`;
    f.project.mockResolvedValue({ id, title: "运行项目", requirement: "运行中的研究项目必须保留并发修改", agents: f.context.draft.agents,
      orchestration: f.context.draft.orchestration, status: "running", phase: "main:running" } as ProjectState);
    await f.store.bindProject(f.context.id, id);
    f.setOfficial({ revision: 8, hash: "b".repeat(64) });
    await expect(f.store.call(f.context.id, "submit_workflow_adjustment", mutation(1, "submit-operation"))).rejects.toThrow("stale official");
    expect(f.submitWorkflow.mock.calls[0][1].base).toEqual({ revision: 7, hash: "a".repeat(64) });
    expect(await f.store.resolve(id)).toBe(f.context.id);
  });

  it("restores the matching original Workflow base when an assistant rebase is undone", async () => {
    const f = await setup(), id = `prj_${"c".repeat(32)}`;
    f.project.mockResolvedValue({ id, title: "研究项目", requirement: "保留运行项目实际接受的配置与每份草稿的基础版本",
      agents: f.context.draft.agents, orchestration: f.context.draft.orchestration } as ProjectState); await f.store.bindProject(f.context.id, id);
    f.setOfficial({ revision: 8, hash: "b".repeat(64) });
    await f.store.call(f.context.id, "update_draft", { ...mutation(1, "rebase-operation", { title: "核对后新草稿", requirement: "保留每份运行配置草稿对应的正式基础版本" }), workflowBase: { revision: 8, hash: "b".repeat(64) } });
    await f.store.call(f.context.id, "undo_draft", mutation(2, "undo-rebase-operation"));
    expect((await f.store.get(f.context.id)).workflowBase?.revision).toBe(7);
  });

  it("exposes native MCP tools and structured errors for the Harness's own agent loop", async () => {
    const f = await setup(), actions: unknown[] = [], controller = new AbortController();
    const endpoint = await openExplainerAssistantMcp(f.store, f.context.id, controller.signal, async action => { actions.push(action); });
    const client = new Client({ name: "test-native-agent", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("update_draft");
      const error = await client.callTool({ name: "save_draft", arguments: mutation(0, "invalid-save-operation") });
      expect(error.isError).toBe(true); expect(actions).toHaveLength(0);
      const result = await client.callTool({ name: "update_draft", arguments: mutation(0, "native-edit-operation", { title: "原生工具", requirement: "由真正的原生 MCP 工具保存项目草稿" }) });
      expect(result.isError).not.toBe(true); expect(actions).toHaveLength(1);
      controller.abort();
      const blocked = await fetch(endpoint.url, { method: "POST", body: "{}" }); expect(blocked.status).toBe(404);
    } finally { await client.close(); await endpoint.close(); }
  });

  it("admits only the invocation-bound tool endpoint into a read-only Explainer", () => {
    const local = { name: "openfars-project-explainer", url: `http://127.0.0.1:43199/mcp/${"a".repeat(48)}` };
    expect(isExplainerMcp(local)).toBe(true);
    expect(isExplainerMcp({ ...local, url: "https://external.example/mcp" })).toBe(false);
    expect(isExplainerMcp({ ...local, name: "research-tool" })).toBe(false);
  });
});

function taskDraftInput(task: Awaited<ReturnType<SavedResearchTaskStore["create"]>>) {
  const { title, requirement, agents, orchestration, git, skillDefinitions, mcpDefinitions } = task;
  return { title, requirement, agents, orchestration, git, skillDefinitions, mcpDefinitions };
}
