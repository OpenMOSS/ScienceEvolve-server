import type {
  AgentDefinition,
  AgentName,
  AgentOrchestrationTemplate
} from "./types.js";
import {
  MAIN_AGENT_NAME
} from "./types.js";

/** Compatibility exports; all runtime identity is the public `main` name. */
export const SYSTEM_CONTROLLER_AGENT = MAIN_AGENT_NAME;
export const SYSTEM_CONTROLLER_ROUTE_TARGET = MAIN_AGENT_NAME;

export function agentDefinitionFor(
  template: AgentOrchestrationTemplate,
  agent: AgentName
): AgentDefinition {
  if (agent === MAIN_AGENT_NAME) {
    return {
      name: MAIN_AGENT_NAME,
      template: "main"
    };
  }
  const definition = template.agents.find((entry) => entry.name === agent);
  if (!definition) throw new Error(`Unknown Agent name: ${agent}`);
  return definition;
}

export function mainAgentName(template: AgentOrchestrationTemplate): AgentName {
  void template;
  return MAIN_AGENT_NAME;
}

export function isSystemController(agent: AgentName): boolean {
  return agent === MAIN_AGENT_NAME;
}
