import { z } from "zod";
import { agentConfigSchema, orchestrationShapeSchema } from "./validation.js";
import { skillDefinitionsSchema } from "./project-skills.js";
import { mcpDefinitionsSchema } from "./project-mcp.js";
import { workflowOuterNodeIds } from "./agent-orchestration.js";
import type { WorkflowImportSource } from "./types.js";

export const workflowImportRequestSchema = z.object({
  filename: z.string().min(1).max(255).regex(/\.json$/i),
  text: z.string().min(1).max(1_000_000)
}).strict();

export const workflowImportSourceSchema = workflowImportRequestSchema.extend({
  notices: z.array(z.object({ path: z.string(), message: z.string() }).strict())
});

const sdkAgentSchema = agentConfigSchema.omit({ gatewayId: true }).partial().extend({
  // Compatibility for original files only; the parsed current config omits it.
  proxy: z.unknown().optional(),
  gatewaySource: z.enum(["env", "profile"]).optional()
}).strict();

const documentSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  kind: z.literal("scienceevolve-agent-config-preset").optional(),
  name: z.string().trim().min(1).max(160).optional(),
  id: z.string().optional(),
  builtin: z.boolean().optional(),
  sourceProjectId: z.string().optional(),
  sourceProjectTitle: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  agents: z.record(z.string(), sdkAgentSchema),
  // Validate the SDK shape without applying Web runtime normalization.
  orchestration: orchestrationShapeSchema,
  skillDefinitions: skillDefinitionsSchema.optional(),
  mcpDefinitions: mcpDefinitionsSchema.optional()
}).strict().superRefine((value, context) => {
  const names = new Set(value.orchestration.agents.map((agent) => agent.name));
  if (!names.has("main")) context.addIssue({ code: "custom", path: ["orchestration", "agents"], message: "必须包含 main Agent" });
  for (const name of names) {
    if (!Object.hasOwn(value.agents, name)) context.addIssue({ code: "custom", path: ["agents", name], message: "缺少 Agent 配置" });
  }
  for (const name of Object.keys(value.agents)) {
    if (!names.has(name)) context.addIssue({ code: "custom", path: ["agents", name], message: "未在 orchestration.agents 中声明" });
  }
  value.orchestration.agents.forEach((agent, index, agents) => {
    if (agents.findIndex((item) => item.name === agent.name) !== index) context.addIssue({ code: "custom", path: ["orchestration", "agents", index, "name"], message: "Agent 名称不能重复" });
  });
  const outerNodeIds = new Set(workflowOuterNodeIds(value.orchestration));
  for (const [name, edges] of Object.entries(value.orchestration.routes)) {
    if (!outerNodeIds.has(name)) context.addIssue({ code: "custom", path: ["orchestration", "routes", name], message: "未知外层 Workflow 节点" });
    edges.forEach((edge, index) => {
      if (edge.target !== "finish" && !outerNodeIds.has(edge.target)) context.addIssue({ code: "custom", path: ["orchestration", "routes", name, index, "target"], message: "未知外层 Workflow 节点" });
    });
  }
  if (!outerNodeIds.has(value.orchestration.input.target)) context.addIssue({ code: "custom", path: ["orchestration", "input", "target"], message: "未知外层 Workflow 节点" });
  if (!outerNodeIds.has(value.orchestration.termination.agent)) context.addIssue({ code: "custom", path: ["orchestration", "termination", "agent"], message: "未知外层 Workflow 节点" });
  value.orchestration.loops?.forEach((loop, index) => {
    for (const field of ["from", "to", "exitTo"] as const) {
      if (!outerNodeIds.has(loop[field])) context.addIssue({ code: "custom", path: ["orchestration", "loops", index, field], message: "未知外层 Workflow 节点" });
    }
  });
});

/** Visualization only: never normalize SDK routes to Web scheduling rules. */
export function parseWorkflowImport(input: unknown) {
  const source = workflowImportRequestSchema.parse(input);
  let raw: unknown;
  try { raw = JSON.parse(source.text.replace(/^\uFEFF/, "")); }
  catch { throw new z.ZodError([{ code: "custom", path: ["text"], message: "workflow.json 不是有效的 JSON 文件" }]); }
  const document = documentSchema.parse(raw);
  const notices: WorkflowImportSource["notices"] = [{ path: "workflow", message: "原文预览不执行 Skills、MCP 或网关。可在快速发起中载入副本，配置网页网关后按网页端调度规则运行。" }];
  const agents = Object.fromEntries(Object.entries(document.agents).map(([name, config]) => {
    const { proxy: legacyProxy, gatewaySource, gatewayReasoningOption, ...agent } = config;
    if (legacyProxy !== undefined) notices.push({ path: `agents.${name}.proxy`, message: "已忽略旧 Agent 网络代理配置；后续调用使用服务环境。" });
    for (const [key, value] of Object.entries({ gatewaySource, gatewayReasoningOption })) {
      if (value !== undefined) notices.push({ path: `agents.${name}.${key}`, message: "保留在原始文件中，预览不会配置或连接网关。" });
    }
    return [name, agentConfigSchema.parse(agent)];
  }));
  return {
    name: document.name ?? (source.filename.replace(/\.json$/i, "").trim() || "导入的 Workflow").slice(0, 160),
    agents, orchestration: document.orchestration,
    skillDefinitions: document.skillDefinitions,
    mcpDefinitions: document.mcpDefinitions,
    importSource: { ...source, notices }
  };
}
