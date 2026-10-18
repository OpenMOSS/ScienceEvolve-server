import { expect, it } from "vitest";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION, normalizeAgentConfigPresets } from "./lib";

it("keeps validated SDK routes and session settings when loading visualization presets", () => {
  const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
  orchestration.routes.main = [{ target: "idea", kind: "strong" }];
  const agents = structuredClone(DEFAULT_AGENTS);
  agents.main.sessionPersistence = false;
  const [preset] = normalizeAgentConfigPresets({ presets: [{
    schemaVersion: 2, kind: "scienceevolve-agent-config-preset", id: "cfg_sdk", name: "SDK", builtin: false,
    agents, orchestration, importSource: { filename: "workflow.json", text: "{}", notices: [] }
  }] });
  expect(preset.orchestration.routes.main).toEqual(orchestration.routes.main);
  expect(preset.agents.main.sessionPersistence).toBe(false);
});
