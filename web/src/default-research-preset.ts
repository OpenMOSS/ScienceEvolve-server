import { DEFAULT_RESEARCH_WORKFLOW as workflow, DEFAULT_RESEARCH_AGENT_OVERRIDES } from "../../server/src/internal/shared/default-research-workflow.js";
import { defaultAgentConfig, normalizeAgentOrchestration } from "./lib";
import type { AgentsConfig } from "./types";

export const DEFAULT_RESEARCH_WORKFLOW = normalizeAgentOrchestration(workflow);

export function defaultResearchAgents(): AgentsConfig {
  return Object.fromEntries(DEFAULT_RESEARCH_WORKFLOW.agents.map(({ name, template }) => {
    const base = defaultAgentConfig(name, template ?? "general");
    const settings = DEFAULT_RESEARCH_AGENT_OVERRIDES[name];
    return [name, { ...base, ...settings, instructions: `${base.instructions}\n\n${settings.instructions}` }];
  }));
}
