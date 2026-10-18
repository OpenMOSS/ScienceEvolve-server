import { describe, expect, it } from "vitest";
import { agentConfigSchema, agentConfigPresetInputSchema, createProjectSchema, mergeAgentConfigs,
  publicAgentConfigs, updateAgentConfigsSchema } from "../src/validation.js";
import { mainAgentOrchestrationDocument, parseAgentOrchestrationProposal } from "../src/agent-orchestration-reconfiguration.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { parseWorkflowImport } from "../src/workflow-import.js";

describe("removed Agent network configuration", () => {
  it.each([{ mode: "direct" }, { mode: "inherit" }, { mode: "custom", url: "http://legacy.invalid" }])(
    "rejects a new Agent proxy selection at every current configuration boundary (%j)", proxy => {
      expect(agentConfigSchema.parse({})).not.toHaveProperty("proxy");
      expect(createProjectSchema.parse({ title: "New project", requirement: "Retain the accepted task" }).agents).toBeUndefined();
      expect(agentConfigPresetInputSchema.parse({ name: "New config", agents: { main: {} } }).agents!.main).not.toHaveProperty("proxy");
      expect(() => agentConfigSchema.parse({ proxy })).toThrow();
      expect(() => updateAgentConfigsSchema.parse({ agents: { main: { proxy } } })).toThrow();
      expect(() => agentConfigPresetInputSchema.parse({ name: "New config", agents: { main: { proxy } } })).toThrow();
      expect(() => createProjectSchema.parse({ title: "New project", requirement: "Retain the accepted task", agents: { main: { proxy } } })).toThrow();
    });

  it.each([false, true])("reads old files without restoring proxy or mutating their original fields (runtime=%s)", restoreRuntimeState => {
    const orchestration = cloneAgentOrchestrationTemplate(), input = mergeAgentConfigs(undefined, orchestration);
    const legacy = Object.fromEntries(Object.entries(input).map(([name, config], index) => [name, {
      ...config, proxy: { mode: index % 2 ? "direct" : "inherit" }
    }]));
    const original = structuredClone(legacy), normalized = mergeAgentConfigs(legacy, orchestration, { restoreRuntimeState });
    expect(normalized).toEqual(input); expect(legacy).toEqual(original);
    for (const config of Object.values(publicAgentConfigs(legacy))) expect(config).not.toHaveProperty("proxy");
    expect(legacy).toEqual(original);
  });

  it("keeps Main's existing editing and model authority while rejecting proxy changes", () => {
    const orchestration = cloneAgentOrchestrationTemplate(); orchestration.allowMainReconfiguration = true;
    const agents = mergeAgentConfigs(undefined, orchestration);
    const legacy = Object.fromEntries(Object.entries(agents).map(([name, config]) => [name, { ...config, proxy: { mode: "direct" } }]));
    const document = mainAgentOrchestrationDocument("prj_proxy_test", orchestration, legacy);
    for (const config of Object.values(document.agents)) expect(config).not.toHaveProperty("proxy");
    expect(JSON.stringify(document.editingInstructions)).not.toMatch(/Bash|proxy/);
    document.agents.main.instructions = "Updated coordination instructions";
    const accepted = parseAgentOrchestrationProposal(JSON.stringify(document), "prj_proxy_test", orchestration, legacy);
    expect(accepted.agents.main.instructions).toBe("Updated coordination instructions");
    expect(accepted.agents.main.gatewayId).toBe(agents.main.gatewayId);
    for (const config of Object.values(accepted.agents)) expect(config).not.toHaveProperty("proxy");
    for (const proxy of [{ mode: "direct" }, { mode: "inherit" }]) {
      const changed = structuredClone(document) as unknown as { agents: Record<string, Record<string, unknown>> };
      changed.agents.main.proxy = proxy;
      expect(() => parseAgentOrchestrationProposal(JSON.stringify(changed), "prj_proxy_test", orchestration, legacy)).toThrow(/unsupported field: proxy/);
    }
  });

  it("imports an original old file as a current config without rewriting its retained source", () => {
    const orchestration = cloneAgentOrchestrationTemplate(), agents = mergeAgentConfigs(undefined, orchestration);
    const text = JSON.stringify({ schemaVersion: 2, kind: "scienceevolve-agent-config-preset", name: "Original preset", orchestration,
      agents: Object.fromEntries(Object.entries(agents).map(([name, config]) => [name, { ...config, proxy: { mode: "inherit" } }])) });
    const imported = parseWorkflowImport({ filename: "original.json", text });
    expect(imported.importSource.text).toBe(text);
    for (const config of Object.values(imported.agents)) expect(config).not.toHaveProperty("proxy");
    expect(imported.importSource.notices.some(notice => notice.path === "agents.main.proxy")).toBe(true);
  });
});
