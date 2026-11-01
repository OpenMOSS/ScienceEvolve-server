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
import { isExplainerMcp, explainerToolNames } from "../src/internal/shared/explainer-tools.js";
import { workflowAdjustmentSubmissionBodySchema } from "../src/workflow-adjustments.js";
import { SavedTaskLauncher } from "../src/saved-task-launcher.js";
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
    workflowAdjustmentSubmissionBodySchema.parse(input);
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
  it("creates a new roster on the first call without inheriting unrelated Agent settings or routes", async () => {
    const f = await setup(), before = structuredClone(f.context.draft);
    const graph = { ...before.orchestration, agents: [{ name: "main", template: "main" }, { name: "coder", template: "execution" }, { name: "auditor", template: "review" }],
      input: { source: "input", target: "coder" }, routes: { main: [{ target: "coder", kind: "weak" }, { target: "auditor", kind: "weak" }],
        coder: [{ target: "auditor", kind: "strong" }], auditor: [{ target: "finish", kind: "strong" }] },
      decisionPlans: { main: "协调当前设计", coder: "实现并交给审核", auditor: "确认后结束" },
      termination: { ...before.orchestration.termination, agent: "auditor" } };
    const patch = { title: "独立三角色设计", requirement: "实现公开题目并审核交付", orchestration: graph,
      agents: { coder: before.agents!.execution, auditor: before.agents!.review } };
    const input = mutation(0, "create-fresh-roster-first-try", patch);
    const created = await f.store.call(f.context.id, "create_draft", input);
    const saved = (await f.tasks.get(created.action!.savedTask!.id))!;
    expect(Object.keys(saved.agents).sort()).toEqual(["auditor", "coder", "main"]);
    expect(Object.keys(saved.orchestration.routes).sort()).toEqual(["auditor", "coder", "main"]);
    expect((await f.store.get(f.context.id)).draft).toEqual(before);
    expect(await f.store.call(f.context.id, "create_draft", input)).toEqual(created);
    expect(await f.tasks.list()).toHaveLength(1);
    await expect(f.store.call(f.context.id, "create_draft", mutation(1, "create-explicit-unknown-role", {
      ...patch, agents: { ...patch.agents, writing: before.agents!.writing }
    }))).rejects.toThrow("unknown Agent: writing");
    // Existing-target editing keeps RFC 7396: omitted fields cannot be deleted.
    await expect(f.store.call(f.context.id, "update_draft", mutation(1, "edit-does-not-prune-roles", patch))).rejects.toThrow("unknown Agent");
    expect(await f.tasks.list()).toHaveLength(1);
  });

  it("exposes selected structural schemas from the real validators without loading the resource catalog", async () => {
    const f = await setup();
    f.store.host.catalog = vi.fn(async () => { throw new Error("Catalog must not be loaded for schemas"); });
    const overview = (await f.store.call(f.context.id, "get_context", {})).result as any;
    expect(overview.schemaAccess).toMatchObject({ section: "schema" });
    expect(overview).not.toHaveProperty("schema");
    const keys = (await f.store.call(f.context.id, "get_context", { section: "schema" })).result as any;
    expect(keys.data.fields).toContain("orchestration");
    const graph = (await f.store.call(f.context.id, "get_context", { section: "schema", key: "orchestration" })).result as any;
    expect(graph.data.schema.properties).toHaveProperty("resultFormat");
    const termination = (await f.store.call(f.context.id, "get_context", { section: "schema", key: "orchestration", entry: "termination" })).result as any;
    expect(termination.data.schema.properties).toHaveProperty("agent");
    expect(termination.data.schema.properties).not.toHaveProperty("resultFormat");
    expect(termination.data.schema.additionalProperties).toBe(false);
    const requirement = (await f.store.call(f.context.id, "get_context", { section: "schema", key: "draft", entry: "requirement" })).result as any;
    expect(requirement.data.schema.minLength).toBe(1);
    await expect(f.store.call(f.context.id, "get_context", { section: "schema", key: "__proto__" })).rejects.toThrow("未找到配置结构");
    expect(f.store.host.catalog).not.toHaveBeenCalled();
  });

  it("accepts a once-encoded object patch over MCP without an error retry and preserves revision guards", async () => {
    const f = await setup(), controller = new AbortController();
    const endpoint = await openExplainerAssistantMcp(f.store, f.context.id, controller.signal, async () => undefined);
    const client = new Client({ name: "encoded-patch-regression", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      const patch = { title: "编码兼容草稿", requirement: "验证 JSON 对象的重复编码不再触发一次工具失败" };
      const args = { ...mutation(0, "encoded-patch-first-call"), patch: JSON.stringify(patch) };
      const first = await client.callTool({ name: "create_draft", arguments: args });
      expect(first.isError).not.toBe(true);
      const replay = await client.callTool({ name: "create_draft", arguments: { ...args, patch } });
      expect(replay).toEqual(first); expect(await f.tasks.list()).toHaveLength(1);
      const stale = await client.callTool({ name: "create_draft", arguments: { ...args, operationId: "encoded-patch-stale-revision" } });
      expect(stale.isError).toBe(true); expect(JSON.stringify(stale.content)).toContain("草稿在读取后已有修改");
      for (const encoded of ['[]', 'null', '"quoted again"', '{broken']) {
        const invalid = await client.callTool({ name: "create_draft", arguments: { ...args, expectedRevision: 1, operationId: "encoded-patch-invalid", patch: encoded } });
        expect(invalid.isError).toBe(true);
      }
      expect(await f.tasks.list()).toHaveLength(1);
      expect((await f.store.get(f.context.id)).revision).toBe(1);
    } finally { controller.abort(); await client.close(); await endpoint.close(); }
  });

  it("prepares conversation evidence without loading the full catalog and retains on-demand access to every entry", async () => {
    const f = await setup();
    const catalog = vi.fn(async () => ({ skills: Array.from({ length: 899 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}` })) }));
    f.store.host.catalog = catalog;
    const evidence = await f.store.contextEvidence(f.context.id);
    expect(catalog).not.toHaveBeenCalled();
    expect(evidence).not.toHaveProperty("catalog");
    expect(evidence.contextAccess).toEqual({ tool: "get_context", sections: ["catalog", "drafts", "project", "workflow", "evidence"] });
    const result = (await f.store.call(f.context.id, "get_context", { section: "catalog", key: "skills" })).result as any;
    expect(catalog).toHaveBeenCalledOnce();
    expect(result.data.total).toBe(899);
    expect(result.data.entries.at(-1)).toMatchObject({ id: "skill-898" });
  });

  it.each(["update_saved_draft", "delete_drafts"])("does not undo an unrelated older current-draft edit after %s", async name => {
    const f = await setup();
    await f.store.call(f.context.id, "update_draft", mutation(0, "undo-bound-draft-initial", { title: "Current A", requirement: "防止对其他草稿的操作导致撤销误改当前草稿" }));
    const current = await f.store.call(f.context.id, "update_draft", mutation(1, "undo-bound-draft-second", { title: "Current A edited" }));
    expect(current.action!.context.canUndo).toBe(true);
    const created = await f.store.call(f.context.id, "create_draft", mutation(2, "undo-other-draft-created", { title: "Other B" }));
    const task = created.action!.savedTask!;
    const selected = { taskId: task.id, expectedUpdatedAt: task.updatedAt };
    const result = await f.store.call(f.context.id, name, { expectedRevision: 3, operationId: "undo-other-draft-operation",
      ...(name === "delete_drafts" ? { tasks: [selected] } : { ...selected, patch: { title: "Other B edited" } }) });
    expect(result.action!.context.canUndo).toBe(false);
    await expect(f.store.call(f.context.id, "undo_draft", mutation(4, "undo-unrelated-should-reject"))).rejects.toThrow("没有可撤销");
    expect((await f.tasks.get(current.action!.context.taskId!))?.title).toBe("Current A edited");
  });

  it("deletes only selected latest draft versions atomically and replays durable receipts", async () => {
    const f = await setup();
    for (const [revision, title] of ["A", "B", "Keep"].entries()) await f.store.call(f.context.id, "create_draft",
      mutation(revision, `create-delete-fixture-${title}`, { title, requirement: "检查批量删除、版本冲突与独立草稿保护" }));
    const tasks = await f.tasks.list(), a = tasks.find(task => task.title === "A")!, b = tasks.find(task => task.title === "B")!;
    const latestB = (await f.tasks.update(b.id, { ...f.context.draft, title: "B edited manually", requirement: b.requirement }, b.updatedAt))!;
    const input = { expectedRevision: 3, operationId: "delete-selected-fixture-drafts", tasks: [a, b].map(task => ({ taskId: task.id, expectedUpdatedAt: task.updatedAt })) };
    await expect(f.store.call(f.context.id, "delete_drafts", input)).rejects.toThrow("新的修改");
    expect(await f.tasks.list()).toHaveLength(3);
    input.tasks[1]!.expectedUpdatedAt = latestB.updatedAt;
    const result = await f.store.call(f.context.id, "delete_drafts", input);
    expect(result.action).toMatchObject({ kind: "drafts.deleted", deletedTasks: [{ id: a.id }, { id: b.id }], context: { revision: 4 } });
    expect((await f.tasks.list()).map(task => task.title)).toEqual(["Keep"]);
    const restarted = new ExplainerAssistantStore(f.root, f.store.host);
    expect(await restarted.call(f.context.id, "delete_drafts", input)).toEqual(result);
    await expect(restarted.call(f.context.id, "delete_drafts", { ...input, tasks: [input.tasks[0]] })).rejects.toThrow("同一操作编号");
    await f.tasks.create({ ...f.context.draft, title: "New unrelated task", requirement: a.requirement });
    expect(await restarted.call(f.context.id, "delete_drafts", input)).toEqual(result);
    expect(await f.tasks.list()).toHaveLength(2);
    await expect(f.tasks.create({ ...f.context.draft, title: a.title, requirement: a.requirement }, a.id)).rejects.toThrow("已被删除");
  });

  it("detaches a deleted current draft, preserves its unsaved content, and never resurrects its ID", async () => {
    const f = await setup();
    const edited = await f.store.call(f.context.id, "update_draft", mutation(0, "create-bound-delete-fixture", {
      title: "Bound draft", requirement: "删除草稿后保留会话及未保存内容，后续保存使用新身份" }));
    const task = (await f.tasks.get(edited.action!.context.taskId!))!;
    const result = await f.store.call(f.context.id, "delete_drafts", { expectedRevision: 1, operationId: "delete-bound-draft-fixture",
      tasks: [{ taskId: task.id, expectedUpdatedAt: task.updatedAt }] });
    expect(result.action!.context).toMatchObject({ revision: 2, deletedTaskId: task.id, draft: edited.action!.context.draft, canUndo: false });
    expect(result.action!.context.taskId).toBeUndefined();
    expect(result.action!.context).not.toHaveProperty("saveIdentity");
    await expect(f.store.create({ taskId: task.id })).rejects.toThrow("已被删除");
    const restarted = new ExplainerAssistantStore(f.root, f.store.host);
    const saved = await restarted.call(f.context.id, "update_draft", mutation(2, "save-independent-after-delete", { title: "New copy" }));
    expect(saved.action!.context.taskId).not.toBe(task.id);
    expect(saved.action!.context.deletedTaskId).toBeUndefined();
    expect((await f.tasks.list()).map(task => task.title)).toEqual(["New copy"]);
  });

  it("recovers a committed deletion after a conversation-write failure without changing newer user edits", async () => {
    const f = await setup();
    await f.store.call(f.context.id, "create_draft", mutation(0, "create-crash-delete-fixture", { title: "Crash fixture", requirement: "删除回执与重试必须一致" }));
    const [task] = await f.tasks.list();
    const input = { expectedRevision: 1, operationId: "delete-with-lost-context-receipt", tasks: [{ taskId: task!.id, expectedUpdatedAt: task!.updatedAt }] };
    vi.spyOn(f.store as any, "write").mockRejectedValueOnce(new Error("injected context write failure"));
    await expect(f.store.call(f.context.id, "delete_drafts", input)).rejects.toThrow("injected context write");
    expect(await f.tasks.list()).toHaveLength(0);
    const restarted = new ExplainerAssistantStore(f.root, f.store.host);
    await restarted.sync(f.context.id, { expectedRevision: 1, draft: { ...f.context.draft, title: "New manual edit", requirement: "保留已提交删除之后发生的新编辑与撤销记录" } });
    const newer = await restarted.call(f.context.id, "update_draft", mutation(2, "newer-edit-after-deletion-commit", { title: "New edit after deletion" }));
    expect(newer.action!.context.canUndo).toBe(true);
    await expect(restarted.call(f.context.id, "delete_drafts", { ...input, expectedRevision: 2 })).rejects.toThrow("同一删除操作编号");
    const replay = await restarted.call(f.context.id, "delete_drafts", input);
    expect(replay.action!.context).toMatchObject({ revision: 3, canUndo: true, draft: { title: "New edit after deletion" } });
    expect(replay.action!.deletedTasks?.map(task => task.id)).toEqual([task!.id]);
  });

  it("edits a selected library draft without replacing another editor target and rejects stale versions", async () => {
    const f = await setup();
    const created = await f.store.call(f.context.id, "create_draft", mutation(0, "create-foreign-edit-fixture", { title: "Library draft", requirement: "保持科研要求以及当前编辑器内容" }));
    const task = (await f.tasks.get(created.action!.savedTask!.id))!;
    const before = await f.store.get(f.context.id);
    const input = { expectedRevision: 1, operationId: "edit-selected-library-draft", taskId: task.id, expectedUpdatedAt: task.updatedAt, patch: { title: "Renamed from homepage" } };
    const edited = await f.store.call(f.context.id, "update_saved_draft", input);
    expect(edited.action!.context.draft).toEqual(before.draft);
    expect(edited.action!.targetTaskId).toBe(task.id);
    expect((await f.tasks.get(task.id))!).toMatchObject({ title: "Renamed from homepage", requirement: task.requirement });
    expect(edited.action!.changedFields).toEqual(["title"]);
    expect(await f.store.call(f.context.id, "update_saved_draft", input)).toEqual(edited);
    await expect(f.store.call(f.context.id, "update_saved_draft", { ...input, expectedRevision: 2, operationId: "edit-stale-library-draft" })).rejects.toThrow("新的修改");
  });

  it("keeps a running project intact when its saved source draft is deleted", async () => {
    const f = await setup();
    const edited = await f.store.call(f.context.id, "update_draft", mutation(0, "save-project-source-fixture", { title: "Source draft", requirement: "删除保存来源草稿不能修改或停止已运行项目" }));
    const task = (await f.tasks.get(edited.action!.context.taskId!))!;
    const projectId = `prj_${"f".repeat(32)}`;
    f.project.mockResolvedValue({ ...edited.action!.context.draft, id: projectId, git: { enabled: false }, status: "running" } as unknown as ProjectState);
    await f.store.bindProject(f.context.id, projectId);
    const before = await f.store.get(projectId);
    const result = await f.store.call(projectId, "delete_drafts", { expectedRevision: before.revision, operationId: "delete-running-project-source",
      tasks: [{ taskId: task.id, expectedUpdatedAt: task.updatedAt }] });
    expect(result.action!.context.projectId).toBe(projectId);
    expect(result.action!.context.draft).toEqual(before.draft);
    expect(f.submitWorkflow).not.toHaveBeenCalled();
    expect(await f.tasks.get(task.id)).toBeUndefined();
  });

  it("exposes complete draft CRUD over native MCP and advertises only enabled capabilities", async () => {
    const f = await setup(), controller = new AbortController();
    const endpoint = await openExplainerAssistantMcp(f.store, f.context.id, controller.signal, async () => undefined);
    const client = new Client({ name: "draft-crud-agent", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      const tools = (await client.listTools()).tools;
      expect(new Set(explainerToolNames({ startProjects: true, submitWorkflow: true }))).toEqual(new Set(EXPLAINER_TOOLS.map(tool => tool.name)));
      const overview = (await f.store.call(f.context.id, "get_context", {})).result as any;
      expect(tools.map(tool => tool.name).sort()).toEqual(overview.tools.sort());
      expect(tools.find(tool => tool.name === "delete_drafts")?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
      expect(tools.map(tool => tool.name)).not.toContain("submit_workflow_adjustment");
      const invoke = async (name: string, args: unknown) => {
        const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
        expect(result.isError).not.toBe(true); return JSON.parse((result.content as { text: string }[])[0]!.text);
      };
      const created = await invoke("create_draft", mutation(0, "native-crud-create-operation", { title: "Native draft", requirement: "验证真实原生 MCP 的新建、读取、修改与删除" }));
      const edited = await invoke("update_saved_draft", { expectedRevision: 1, operationId: "native-crud-update-operation", taskId: created.savedTask.id,
        expectedUpdatedAt: created.savedTask.updatedAt, patch: { title: "Native renamed" } });
      const deleted = await invoke("delete_drafts", { expectedRevision: 2, operationId: "native-crud-delete-operation",
        tasks: [{ taskId: edited.savedTask.id, expectedUpdatedAt: edited.savedTask.updatedAt }] });
      expect(deleted.kind).toBe("drafts.deleted"); expect(await f.tasks.list()).toHaveLength(0);
      expect(deleted.deletedTasks).toEqual([{ id: edited.savedTask.id, title: "Native renamed", updatedAt: edited.savedTask.updatedAt }]);
      expect(edited.targetTaskId).toBe(created.savedTask.id);
      const invalid = await client.callTool({ name: "delete_drafts", arguments: { expectedRevision: 3, operationId: "native-invalid-project-delete",
        tasks: [{ taskId: `prj_${"a".repeat(32)}`, expectedUpdatedAt: edited.savedTask.updatedAt }] } });
      expect(invalid.isError).toBe(true);
    } finally { await client.close(); await endpoint.close(); }
  });

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

  it("saves one real draft and replays exact operations without launching research", async () => {
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

  it("creates two independent drafts in one conversation and replays each creation without overwriting either", async () => {
    const f = await setup();
    const requirement = "调研全自动 AI 短剧制作流水线，两份设计共享同一个研究课题";
    const firstInput = mutation(0, "create-independent-draft-a", { title: "草案 A", requirement,
      orchestration: { decisionPlans: { main: "按 A 方案组织取证和评审" } } });
    const first = await f.store.call(f.context.id, "create_draft", firstInput);
    const second = await f.store.call(f.context.id, "create_draft", mutation(1, "create-independent-draft-b", {
      title: "草案 B", requirement, orchestration: { decisionPlans: { main: "按 B 方案组织双路分析和成稿" } }
    }));
    const a = first.action!.savedTask!, b = second.action!.savedTask!;
    expect(a.id).not.toBe(b.id);
    expect(await f.tasks.list()).toHaveLength(2);
    expect((await f.tasks.get(a.id))!).toMatchObject({ title: "草案 A", requirement,
      orchestration: { decisionPlans: { main: "按 A 方案组织取证和评审" } } });
    expect((await f.tasks.get(b.id))!).toMatchObject({ title: "草案 B", requirement,
      orchestration: { decisionPlans: { main: "按 B 方案组织双路分析和成稿" } } });
    expect(await f.store.call(f.context.id, "create_draft", firstInput)).toEqual(first);
    const restarted = new ExplainerAssistantStore(f.root, f.store.host);
    expect(await restarted.call(f.context.id, "create_draft", firstInput)).toEqual(first);
    await expect(restarted.call(f.context.id, "create_draft", { ...firstInput, patch: { title: "覆盖 A" } }))
      .rejects.toThrow("同一操作编号");
    const list = (await restarted.call(f.context.id, "get_context", { section: "drafts" })).result as any;
    expect(list.data.entries.map((entry: any) => entry.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await restarted.call(f.context.id, "get_context", { section: "drafts", entry: a.id })).result)
      .toMatchObject({ data: { id: a.id, title: "草案 A", requirement } });
    const aContext = await restarted.create({ taskId: a.id });
    expect(aContext.id).not.toBe(f.context.id);
    await restarted.call(aContext.id, "update_draft", mutation(0, "edit-only-created-draft-a", { title: "仅修改 A" }));
    expect((await f.tasks.get(b.id))!.title).toBe("草案 B");
    expect(await restarted.get(f.context.id)).toMatchObject({ revision: 2, draft: { title: "", requirement: "" } });
    expect(await fs.readdir(f.root)).not.toContain("projects");
  });

  it("creates a new draft from a running project without changing its target, proposal or original saved task", async () => {
    const f = await setup(), projectId = `prj_${"d".repeat(32)}`;
    const original = await f.store.call(f.context.id, "update_draft", mutation(0, "save-original-project-b", {
      title: "草案 B", requirement: "保留已启动的 B，另建同课题的独立 A 草稿"
    }));
    f.project.mockResolvedValue({ id: projectId, title: "运行 B", requirement: original.action!.context.draft.requirement,
      agents: original.action!.context.draft.agents, orchestration: original.action!.context.draft.orchestration } as ProjectState);
    await f.store.bindProject(f.context.id, projectId);
    const before = await f.store.get(f.context.id);
    const result = await f.store.call(f.context.id, "create_draft", mutation(before.revision, "create-alternative-project-a", {
      title: "草案 A", orchestration: { decisionPlans: { main: "独立 A 方案" } }
    }));
    expect(result.action).toMatchObject({ kind: "draft.created", context: { projectId, taskId: before.taskId,
      draft: before.draft, workflowBase: before.workflowBase }, savedTask: { title: "草案 A" } });
    expect(result.action!.savedTask!.id).not.toBe(before.taskId);
    expect((await f.tasks.get(before.taskId!))!.title).toBe("草案 B");
    expect((await f.tasks.get(result.action!.savedTask!.id))!.requirement).toBe(before.draft.requirement);
    expect(await f.store.resolve(projectId)).toBe(f.context.id);
    expect(f.submitWorkflow).not.toHaveBeenCalled();
    expect(await f.tasks.list()).toHaveLength(2);
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

  it("submits the current proposal through the real strict HTTP-body schema without a duplicate projectId", async () => {
    const f = await setup(), projectId = `prj_${"f".repeat(32)}`;
    f.project.mockResolvedValue({ id: projectId, title: "运行 B", requirement: "应用用户明确要求的 Workflow 调整",
      agents: f.context.draft.agents, orchestration: f.context.draft.orchestration } as ProjectState);
    await f.store.bindProject(f.context.id, projectId);
    const result = await f.store.call(f.context.id, "submit_workflow_adjustment", mutation(1, "submit-valid-workflow-body"));
    expect(result.action!.kind).toBe("workflow.submitted");
    expect(f.submitWorkflow).toHaveBeenCalledOnce();
    expect(f.submitWorkflow.mock.calls[0][0]).toBe(projectId);
    expect(f.submitWorkflow.mock.calls[0][1]).not.toHaveProperty("projectId");
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
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain("update_draft"); expect(names).toContain("create_draft");
      expect(names).not.toContain("start_projects");
      const error = await client.callTool({ name: "save_draft", arguments: mutation(0, "invalid-save-operation") });
      expect(error.isError).toBe(true); expect(actions).toHaveLength(0);
      const result = await client.callTool({ name: "update_draft", arguments: mutation(0, "native-edit-operation", { title: "原生工具", requirement: "由真正的原生 MCP 工具保存项目草稿" }) });
      expect(result.isError).not.toBe(true); expect(actions).toHaveLength(1);
      const [task] = await f.tasks.list();
      const deleted = await client.callTool({ name: "delete_drafts", arguments: { expectedRevision: 1, operationId: "native-delete-bound-operation",
        tasks: [{ taskId: task!.id, expectedUpdatedAt: task!.updatedAt }] } });
      expect(deleted.isError).not.toBe(true);
      expect(JSON.parse((deleted.content as { text: string }[])[0]!.text).context).toMatchObject({ deletedTaskId: task!.id, canUndo: false });
      controller.abort();
      const blocked = await fetch(endpoint.url, { method: "POST", body: "{}" }); expect(blocked.status).toBe(404);
    } finally { await client.close(); await endpoint.close(); }
  });

  it("returns new draft IDs and each batch launch result through the actual native MCP response", async () => {
    const f = await setup(), controller = new AbortController(), actions: any[] = [];
    let sequence = 0;
    const launch = vi.fn(async () => ({ id: `prj_${String(++sequence).padStart(32, "0")}` }));
    const launcher = new SavedTaskLauncher(f.root, f.tasks, launch);
    f.store.host.startProjects = (input, signal) => launcher.start(input, signal);
    const endpoint = await openExplainerAssistantMcp(f.store, f.context.id, controller.signal, async action => { actions.push(action); });
    const client = new Client({ name: "test-native-batch-agent", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("start_projects");
      const saved = [];
      for (const [index, title] of ["A", "B"].entries()) {
        const result = await client.callTool({ name: "create_draft", arguments: mutation(index, `native-create-draft-${title}`, {
          title, requirement: "从真实 MCP 回执获取新草稿 ID，并按用户要求批量启动"
        }) });
        expect(result.isError).not.toBe(true);
        const receipt = JSON.parse((result.content as { text: string }[])[0]!.text);
        expect(receipt.kind).toBe("draft.created");
        expect(receipt.href).toBe(`/saved-tasks/${receipt.savedTask.id}/edit`);
        saved.push(receipt.savedTask);
      }
      expect(saved[0].id).not.toBe(saved[1].id);
      const args = { expectedRevision: 2, operationId: "native-start-reviewed-drafts",
        tasks: saved.map(task => ({ taskId: task.id, expectedUpdatedAt: task.updatedAt })) };
      const result = await client.callTool({ name: "start_projects", arguments: args });
      expect(result.isError).not.toBe(true);
      const receipt = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(receipt.launches.results.map((item: any) => item.status)).toEqual(["started", "started"]);
      expect(new Set(receipt.launches.results.map((item: any) => item.projectId)).size).toBe(2);
      await client.callTool({ name: "start_projects", arguments: args });
      expect(launch).toHaveBeenCalledTimes(2);
      expect(actions.map(action => action.kind)).toEqual(["draft.created", "draft.created", "projects.started", "projects.started"]);
    } finally { await client.close(); await endpoint.close(); }
  });

  it("keeps manual edits and other conversations usable while a batch is submitting", async () => {
    const f = await setup();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.store.host.startProjects = async input => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return { operationId: input.operationId, results: [] };
    };
    const batch = f.store.call(f.context.id, "start_projects", { expectedRevision: 0, operationId: "slow-batch-launch-operation",
      tasks: [{ taskId: `task_${"a".repeat(32)}`, expectedUpdatedAt: new Date().toISOString() }] });
    await ready;
    try {
      await f.store.sync(f.context.id, { expectedRevision: 0, draft: { ...f.context.draft, title: "用户刚改的草稿" } });
      const other = await f.store.create();
      expect(other.id).not.toBe(f.context.id);
    } finally { release(); }
    const result = await batch;
    expect(result.action!.context.draft.title).toBe("用户刚改的草稿");
    expect(result.action!.context.revision).toBe(2);
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
