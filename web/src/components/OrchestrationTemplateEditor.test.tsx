import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cloneAgentsConfig, defaultAgentConfig, DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION, agentOrchestrationError } from "../lib";
import { upgradeLegacyGroups } from "./workflow-canvas/core/scoped-workflow";
import { OrchestrationTemplateEditor } from "./OrchestrationTemplateEditor";

describe("text Workflow Agent configuration", () => {
  it.each([2, 3] as const)("adds an Agent beyond fifty in a v%s workflow and retains its dispatch and scope", schemaVersion => {
    const value = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    const agents = cloneAgentsConfig(DEFAULT_AGENTS);
    for (let index = 0; index < 46; index += 1) {
      const name = `researcher_${index}`;
      value.agents.push({ name, template: "general" });
      value.routes[name] = [{ target: "main", kind: "strong" }];
      value.routes.main.push({ target: name, kind: "weak" });
      value.decisionPlans[name] = "Return verified research to Main.";
      agents[name] = defaultAgentConfig(name, "general");
    }
    if (schemaVersion === 3) upgradeLegacyGroups(value);
    const onChange = vi.fn();
    const onAgentsChange = vi.fn();
    render(<OrchestrationTemplateEditor value={value} agents={agents} onChange={onChange} onAgentsChange={onAgentsChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "新 Agent name" }), { target: { value: "extra_researcher" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 Agent" }));
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]![0] as typeof value;
    expect(next.agents).toHaveLength(52);
    expect(next.routes.main).toContainEqual({ target: "extra_researcher", kind: "weak" });
    expect(next.routes.extra_researcher).toEqual([{ target: "main", kind: "strong" }]);
    expect(onAgentsChange.mock.calls[0]![0].extra_researcher).toBeDefined();
    if (schemaVersion === 3) expect(next.scopedWorkflow!.rootAgentIds).toContain("extra_researcher");
    expect(agentOrchestrationError(next, schemaVersion === 3)).toBeUndefined();
    expect(value.agents).toHaveLength(51);
  });
});
