import type { ConfigRecommendationResponse } from "../api";
import type { GatewayRecord, HarnessCatalogEntry } from "../types";
import { workflowOuterNodes } from "./workflow-canvas/core/workflow-nodes";

type Configuration = ConfigRecommendationResponse["recommendation"];
export interface ConfigurationChangeSummary {
  introduction: string;
  workflowOverview: string;
  addedAgents: Array<{ name: string; description: string }>;
  removedAgents: string[];
  updatedAgents: Array<{ name: string; description?: string; changes: string[] }>;
  workflowChanges: string[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export function summarizeConfigurationChanges(before: Configuration, after: Configuration,
  catalog: { gateways?: GatewayRecord[]; harnesses?: HarnessCatalogEntry[] } = {}): ConfigurationChangeSummary {
  const summary: ConfigurationChangeSummary = { introduction: "", workflowOverview: "", addedAgents: [], removedAgents: [], updatedAgents: [], workflowChanges: [] };
  const oldDefinitions = new Map(before.orchestration.agents.map(agent => [agent.name, agent]));
  const newNames = new Set(after.orchestration.agents.map(agent => agent.name));
  for (const definition of before.orchestration.agents) {
    if (!newNames.has(definition.name)) summary.removedAgents.push(definition.name);
  }
  for (const definition of after.orchestration.agents) {
    const name = definition.name, previous = before.agents[name], next = after.agents[name];
    if (!oldDefinitions.has(name) || !previous) {
      summary.addedAgents.push({ name, description: [definition.description, next?.model].filter(Boolean).join(" · ").slice(0, 180) });
      continue;
    }
    if (!next) continue;
    const changes: string[] = [];
    const display = (value: unknown) => typeof value === "string" && value.trim() ? value : "默认";
    if (previous.model !== next.model) changes.push(`模型：${display(previous.model)} → ${display(next.model)}`);
    if (previous.harness !== next.harness) {
      const label = (id: string | undefined) => catalog.harnesses?.find(item => item.id === id)?.label ?? display(id);
      changes.push(`Harness：${label(previous.harness)} → ${label(next.harness)}`);
    }
    if (previous.gatewayId !== next.gatewayId) {
      const label = (id: string | undefined) => catalog.gateways?.find(item => item.id === id)?.name ?? (id ? "其他网关" : "未选择");
      changes.push(`网关：${label(previous.gatewayId)} → ${label(next.gatewayId)}`);
    }
    if (previous.instructions !== next.instructions) changes.push("职责提示词已更新");
    if (oldDefinitions.get(name)?.template !== definition.template) changes.push("角色模板已调整");
    if (oldDefinitions.get(name)?.description !== definition.description) changes.push("角色说明已更新");
    for (const [field, label] of [["skills", "固定 Skills"], ["autoSkills", "自动 Skills"]] as const) {
      const oldValues = new Set(previous[field] ?? []), newValues = new Set(next[field] ?? []);
      const added = [...newValues].filter(value => !oldValues.has(value)).length;
      const removed = [...oldValues].filter(value => !newValues.has(value)).length;
      if (added || removed) changes.push(`${label}：${[added ? `新增 ${added} 项` : "", removed ? `移除 ${removed} 项` : ""].filter(Boolean).join("、")}`);
    }
    if (!same([...(previous.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
      [...(next.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name)))) changes.push(`MCP 工具已调整，当前 ${(next.mcpServers ?? []).length} 项`);
    for (const [field, label] of [["experimentMcp", "SII 实验工具"], ["webSearch", "网页搜索"], ["sessionPersistence", "会话持久化"]] as const) {
      if (Boolean(previous[field]) !== Boolean(next[field])) changes.push(`${label}：${next[field] ? "开启" : "关闭"}`);
    }
    if (previous.permission !== next.permission) changes.push("运行权限已调整");
    if (previous.gatewayReasoningOption !== next.gatewayReasoningOption) changes.push("网关思考强度已调整");
    if (previous.decisionBy !== next.decisionBy) changes.push("决策方式已调整");
    if (changes.length) summary.updatedAgents.push({ name, changes,
      ...(definition.description?.trim() ? { description: definition.description.trim().slice(0, 180) } : {}) });
  }
  for (const [field, label] of [
    ["input", "输入入口"], ["routes", "执行路由"], ["loops", "循环规则"], ["decisionPlans", "决策规则"],
    ["termination", "终止条件"], ["resultFormat", "交付形式"], ["collaborations", "协作组"],
    ["scopedWorkflow", "嵌套工作流"], ["agentTemplates", "角色模板库"]
  ] as const) {
    const fallback = field === "loops" || field === "collaborations" || field === "agentTemplates" ? [] : undefined;
    if (!same(before.orchestration[field] ?? fallback, after.orchestration[field] ?? fallback)) summary.workflowChanges.push(label);
  }
  for (const [field, label] of [["allowUserIntervention", "人工介入"], ["allowMainReconfiguration", "Main 动态重配置"]] as const) {
    if (Boolean(before.orchestration[field]) !== Boolean(after.orchestration[field])) summary.workflowChanges.push(label);
  }
  if (!same(before.orchestration.agents.map(agent => agent.name), after.orchestration.agents.map(agent => agent.name))) summary.workflowChanges.unshift("Agent 编排");
  const changes = [
    summary.addedAgents.length ? `新增 ${summary.addedAgents.length} 个 Agent` : "",
    summary.updatedAgents.length ? `调整 ${summary.updatedAgents.length} 个 Agent` : "",
    summary.removedAgents.length ? `移除 ${summary.removedAgents.length} 个 Agent` : "",
    summary.workflowChanges.length ? `更新 ${summary.workflowChanges.length} 项 Workflow 设置` : ""
  ].filter(Boolean);
  summary.introduction = changes.length ? `本次推荐${changes.join("，")}。` : "推荐结果与当前配置一致，没有需要修改的内容。";
  const nodes = workflowOuterNodes(after.orchestration);
  const label = (id: string) => nodes.find(node => node.id === id)?.displayName ?? id;
  summary.workflowOverview = `推荐团队共 ${after.orchestration.agents.length} 个 Agent，任务入口为 ${label(after.orchestration.input.target)}，终止节点为 ${label(after.orchestration.termination.agent)}。`;
  return summary;
}
