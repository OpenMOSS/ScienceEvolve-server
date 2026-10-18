import { isDeepStrictEqual } from "node:util";
import type { AgentOrchestrationTemplate, AgentConfigMap } from "./types.js";
import type { WorkflowConfigurationVersion } from "./workflow-adjustments.js";
import { parseWorkflowProposal, type WorkflowProposal } from "./workflow-reconfiguration.js";
import { validateScopedWorkflowContract } from "./scoped-workflow-contract.js";
import { parseAgentOrchestrationProposal, type AgentOrchestrationProposal } from "./agent-orchestration-reconfiguration.js";
import { assertScopedAgentConfigurationRange, type ScopedAgentConfiguration } from "./scoped-agent-configuration.js";

/** Scope restriction on the existing formal workflow.json proposal. Runtime
 * fields, the base hash and document instructions retain the Main parser's
 * exact locks; a Leader gets no alternative approval/configuration path. */
export function assertScopedWorkflowProposalRange(current: AgentOrchestrationTemplate,
  proposed: AgentOrchestrationTemplate, groupId: string): void {
  if (current.schemaVersion !== 3 || proposed.schemaVersion !== 3 || !current.scopedWorkflow || !proposed.scopedWorkflow) {
    throw new Error("Scoped Leader reconfiguration requires an existing v3 workflow");
  }
  const definition = current.scopedWorkflow.groups.find((group) => group.id === groupId);
  const next = proposed.scopedWorkflow.groups.find((group) => group.id === groupId);
  if (!definition || !next || !definition.allowLeaderReconfiguration ||
    next.parentGroupId !== definition.parentGroupId || next.allowLeaderReconfiguration !== definition.allowLeaderReconfiguration) {
    throw new Error("Leader cannot change its scope, ancestry or reconfiguration switch");
  }
  const outer = (value: AgentOrchestrationTemplate) => {
    const { scopedWorkflow: _scopes, collaborations: _groups, ...rest } = value;
    return rest;
  };
  if (!isDeepStrictEqual(outer(current), outer(proposed)) ||
    !isDeepStrictEqual(current.scopedWorkflow.rootAgentIds, proposed.scopedWorkflow.rootAgentIds)) {
    throw new Error("Leader cannot change the outer workflow or shared Agent configuration");
  }
  const oldGroups = new Map(current.scopedWorkflow.groups.map((group) => [group.id, group]));
  const nextGroups = new Map(proposed.scopedWorkflow.groups.map((group) => [group.id, group]));
  for (const group of oldGroups.values()) {
    if (group.id !== groupId && !isDeepStrictEqual(group, nextGroups.get(group.id))) {
      throw new Error("Leader cannot modify another scope, including an existing child's internal graph");
    }
  }
  const permitted = new Set(definition.workflow.nodes.flatMap((node) => node.kind === "agent" ? [node.agentId] : []));
  const permittedLeaders = new Set([...permitted, definition.leaderAgentId, "main"]);
  for (const group of proposed.scopedWorkflow.groups) {
    if (group.id !== groupId && oldGroups.has(group.id)) continue;
    if (group.id !== groupId) {
      const visited = new Set<string>();
      let parent = group.parentGroupId;
      while (parent && parent !== groupId && !visited.has(parent)) {
        visited.add(parent);
        if (oldGroups.has(parent)) throw new Error("Leader cannot create a group inside another existing scope");
        parent = nextGroups.get(parent)?.parentGroupId;
      }
      if (parent !== groupId) throw new Error("Leader can create subgroups only beneath its current scope");
    }
    if (!permittedLeaders.has(group.leaderAgentId) || group.workflow.nodes.some((node) =>
      node.kind === "agent" && !permitted.has(node.agentId))) {
      throw new Error("Leader cannot import or schedule Agents from outside its direct group");
    }
  }
  for (const metadata of current.collaborations ?? []) {
    if (metadata.id !== groupId && !isDeepStrictEqual(metadata, proposed.collaborations?.find((group) => group.id === metadata.id))) {
      throw new Error("Leader cannot change another group's configuration");
    }
  }
  validateScopedWorkflowContract(proposed.scopedWorkflow, new Set(proposed.agents.map((agent) => agent.name)));
}

export function parseScopedWorkflowProposal(raw: string, projectId: string,
  current: AgentOrchestrationTemplate, agents: AgentConfigMap, groupId: string,
  resources?: Pick<ScopedAgentConfiguration, "skillDefinitions" | "mcpDefinitions"> & { baseVersion?: WorkflowConfigurationVersion }): WorkflowProposal & Partial<AgentOrchestrationProposal> {
  const full = (JSON.parse(raw) as { schemaVersion?: unknown }).schemaVersion === 2;
  const proposal = full ? parseAgentOrchestrationProposal(raw, projectId, current, agents, resources)
    : parseWorkflowProposal(raw, projectId, current, agents, resources);
  assertScopedWorkflowProposalRange(current, proposal.orchestration, groupId);
  if (full) assertScopedAgentConfigurationRange(current, groupId, { agents, skillDefinitions: resources?.skillDefinitions ?? {}, mcpDefinitions: resources?.mcpDefinitions ?? {} }, proposal as AgentOrchestrationProposal);
  return proposal;
}
