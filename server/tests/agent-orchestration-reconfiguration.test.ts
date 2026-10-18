import { describe, expect, it } from "vitest";
import { defaultDecisionPlan } from "../src/agent-orchestration.js";
import type { AgentOrchestrationTemplate } from "../src/types.js";
import { mergeAgentConfigs, normalizeAgentOrchestrationTemplate } from "../src/validation.js";
import {
  mainAgentOrchestrationDocument,
  parseAgentOrchestrationProposal
} from "../src/agent-orchestration-reconfiguration.js";

function orchestration(): AgentOrchestrationTemplate {
  return {
    agents: [{ name: "main", template: "main" }],
    input: { source: "input", target: "main" },
    routes: { main: [] },
    decisionPlans: { main: defaultDecisionPlan("main") },
    allowUserIntervention: true,
    allowMainReconfiguration: true,
    termination: {
      agent: "main",
      condition: "Main has completed the bounded task.",
      decisionBy: "main",
      automatic: false
    },
    resultFormat: { presets: [], custom: "" }
  };
}

function loopOrchestration(): AgentOrchestrationTemplate {
  const names = ["main", "measure", "assess", "revise"];
  return {
    agents: names.map((name) => ({ name })),
    input: { source: "input", target: "measure" },
    routes: {
      main: names.slice(1).map((target) => ({ target, kind: "weak" })),
      measure: [{ target: "assess", kind: "strong" }],
      assess: [{ target: "revise", kind: "strong" }],
      revise: [{ target: "measure", kind: "strong" }]
    },
    loops: [{
      id: "refinement",
      from: "assess",
      to: "revise",
      maxIterations: 2,
      exitTo: "main"
    }],
    decisionPlans: Object.fromEntries(
      names.map((name) => [name, defaultDecisionPlan(name)])
    ),
    allowUserIntervention: true,
    allowMainReconfiguration: true,
    termination: {
      agent: "main",
      condition: "Main accepts the measured result.",
      decisionBy: "main",
      automatic: false
    },
    resultFormat: { presets: [], custom: "" }
  };
}

function agents(template = orchestration()) {
  return mergeAgentConfigs(
    {
      main: {
        model: "glm-5.3",
        harness: "codex",
        gatewayReasoningOption: "reasoning-high",
        skills: [],
        autoSkills: [],
        instructions: "Current Main prompt",
        permission: "yolo",
        sessionPersistence: true,
        decisionBy: "main"
      }
    },
    template
  );
}

describe("Main Agent orchestration document", () => {
  it.each([false, true])("preserves the user intervention choice (%s) and rejects Main changing it", allowed => {
    const current = orchestration(); current.allowUserIntervention = allowed;
    const currentAgents = agents(current);
    const document = mainAgentOrchestrationDocument("prj_test", current, currentAgents);
    document.agents.main.model = "updated-model";
    expect(parseAgentOrchestrationProposal(JSON.stringify(document), "prj_test", current, currentAgents).orchestration.allowUserIntervention).toBe(allowed);
    document.orchestration.allowUserIntervention = !allowed;
    expect(() => parseAgentOrchestrationProposal(JSON.stringify(document), "prj_test", current, currentAgents))
      .toThrow("Main cannot change the user's intervention setting");
  });

  it("preserves the scoped proposal contract while applying a group Loop revision", () => {
    const base = loopOrchestration();
    const current = normalizeAgentOrchestrationTemplate({ ...base, schemaVersion: 3,
      collaborations: [{ id: "G", displayName: "G", memberAgentIds: [], renamePolicy: "editable" }],
      routes: { ...base.routes, G: [{ target: "main", kind: "strong" }] },
      scopedWorkflow: { schemaVersion: 1, rootAgentIds: base.agents.map(agent => agent.name), groups: [{
        id: "G", leaderAgentId: "main", allowLeaderReconfiguration: false,
        workflow: { nodes: [{ kind: "agent", nodeId: "G_measure", agentId: "measure" },
          { kind: "agent", nodeId: "G_assess", agentId: "assess" }, { kind: "agent", nodeId: "G_revise", agentId: "revise" }],
          input: { source: "input", edges: [{ target: "G_measure", kind: "parallel" }] },
          routes: { G_measure: [{ target: "G_assess", kind: "strong" }], G_assess: [{ target: "G_measure", kind: "strong" }], G_revise: [{ target: "finish", kind: "strong" }] },
          loops: [{ id: "G_rounds", from: "G_assess", to: "G_measure", exitTo: "G_revise", maxIterations: 1 }] }
      }] } });
    const currentAgents = mergeAgentConfigs({}, current);
    const document = mainAgentOrchestrationDocument("prj_test", current, currentAgents);
    expect(document.editingInstructions.routes).toContain("scopedWorkflow");
    expect(document.editingInstructions.invariants.join(" ")).not.toContain("fresh batch");
    expect(document.orchestration).toEqual(current);
    document.orchestration.scopedWorkflow!.groups[0]!.workflow.loops![0]!.maxIterations = 2;
    const proposal = parseAgentOrchestrationProposal(JSON.stringify(document), "prj_test", current, currentAgents);
    expect(proposal.orchestration.scopedWorkflow!.groups[0]!.workflow.loops![0]!.maxIterations).toBe(2);
    expect(proposal.orchestration.input).toEqual(current.input);
    expect(proposal.agents).toEqual(currentAgents);
  });
  it("contains a server-generated Agent snapshot and locked runtime values", () => {
    const currentOrchestration = orchestration();
    const currentAgents = agents(currentOrchestration);
    const document = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );

    expect(document.schemaVersion).toBe(2);
    expect(document.editableFields).toEqual([
      "orchestration",
      "agents",
      "skillDefinitions",
      "mcpDefinitions"
    ]);
    expect(document.agents.main).toMatchObject({
      instructions: "Current Main prompt",
      model: "glm-5.3",
      harness: "codex"
    });
    expect(document.lockedRuntime.main).toMatchObject({
      currentModel: "glm-5.3",
      gatewayReasoningOption: "reasoning-high",
      currentHarness: "codex",
      permission: "yolo",
      sessionPersistence: true
    });
    expect(document.editingInstructions.invariants.join(" ")).toContain(
      "allowMainReconfiguration"
    );
    expect(document.editingInstructions.invariants.join(" ")).toContain(
      "orchestration.loops"
    );
    expect(Object.prototype.hasOwnProperty.call(document, "gatewaySnapshot")).toBe(false);
  });

  it("accepts a validated Loop batch-size change in the Main proposal", () => {
    const currentOrchestration = loopOrchestration();
    const currentAgents = agents(currentOrchestration);
    const document = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    document.orchestration.loops![0].maxIterations = 4;

    const proposal = parseAgentOrchestrationProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    expect(proposal.orchestration.loops).toEqual([{
      id: "refinement",
      from: "assess",
      to: "revise",
      maxIterations: 4,
      exitTo: "main"
    }]);
  });

  it("accepts model and Gateway route changes while preserving locked policy fields", () => {
    const currentOrchestration = orchestration();
    const currentAgents = agents(currentOrchestration);
    const document = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    document.agents.main.instructions = "Updated Main prompt";
    document.agents.main.model = "glm-6";
    document.agents.main.gatewayId = "gwy_0123456789abcdef0123456789abcdef";
    document.agents.main.skills = ["builtin:ccf-idea-optimizer"];
    document.orchestration.agents.push({
      name: "analyst",
      template: "general",
      description: "Dynamically added analyst"
    });
    document.orchestration.input.target = "analyst";
    document.orchestration.routes.analyst = [
      { target: "main", kind: "strong" }
    ];
    document.orchestration.decisionPlans.analyst =
      "Return the verified evidence to Main.";
    document.agents.analyst = {
      ...document.agents.main,
      instructions: "Analyst prompt",
      experimentMcp: true
    };

    const proposal = parseAgentOrchestrationProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );

    expect(proposal.agents.main).toMatchObject({
      model: "glm-6",
      gatewayId: "gwy_0123456789abcdef0123456789abcdef",
      gatewayReasoningOption: "reasoning-high",
      permission: "yolo",
      sessionPersistence: true,
      instructions: "Updated Main prompt",
      skills: ["builtin:ccf-idea-optimizer"]
    });
    expect(proposal.agents.analyst).toMatchObject({
      model: "glm-6",
      gatewayId: "gwy_0123456789abcdef0123456789abcdef",
      permission: "workspace",
      sessionPersistence: false,
      instructions: "Analyst prompt",
      experimentMcp: true
    });
    expect(proposal.agents.analyst.gatewayReasoningOption).toBeUndefined();
    const next = mainAgentOrchestrationDocument("prj_test", proposal.orchestration, proposal.agents);
    next.agents.analyst.experimentMcp = false;
    const disabled = parseAgentOrchestrationProposal(JSON.stringify(next), "prj_test", proposal.orchestration, proposal.agents);
    expect(disabled.agents.analyst.experimentMcp).toBe(false);
    expect(disabled.agents.analyst.permission).toBe("workspace");
    expect(proposal.agents.main).not.toHaveProperty("reasoningEffort");
    expect(proposal.agents.analyst).not.toHaveProperty("reasoningEffort");
  });

  it("accepts decision ownership while rejecting other locked runtime changes", () => {
    const currentOrchestration = orchestration();
    const currentAgents = agents(currentOrchestration);
    const document = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );

    for (const field of [
      "reasoningEffort",
      "gatewayReasoningOption",
      "gatewaySnapshot",
      "permission",
      "webSearch",
      "sessionPersistence"
    ]) {
      const changed = structuredClone(document) as unknown as Record<string, unknown>;
      (changed.agents as Record<string, Record<string, unknown>>).main[field] =
        field === "reasoningEffort" ? "xhigh" : "changed";
      expect(() =>
        parseAgentOrchestrationProposal(JSON.stringify(changed), "prj_test", currentOrchestration, currentAgents)
      ).toThrow(`agents.main.${field} is locked`);
    }

    const unauthorized = structuredClone(document);
    unauthorized.orchestration.allowMainReconfiguration = false;
    expect(() =>
      parseAgentOrchestrationProposal(JSON.stringify(unauthorized), "prj_test", currentOrchestration, currentAgents)
    ).toThrow("cannot change its workflow-reconfiguration authority");

    const stale = structuredClone(document);
    stale.baseHash = "0".repeat(64);
    expect(() =>
      parseAgentOrchestrationProposal(JSON.stringify(stale), "prj_test", currentOrchestration, currentAgents)
    ).toThrow("workflow.json is stale");

    const changedMetadata = structuredClone(document);
    changedMetadata.editableFields = ["agents"] as never;
    expect(() =>
      parseAgentOrchestrationProposal(JSON.stringify(changedMetadata), "prj_test", currentOrchestration, currentAgents)
    ).toThrow("editableFields is server-owned");

    const changedLockedRuntime = structuredClone(document);
    changedLockedRuntime.lockedRuntime.main.currentModel = "forged-model";
    expect(() =>
      parseAgentOrchestrationProposal(JSON.stringify(changedLockedRuntime), "prj_test", currentOrchestration, currentAgents)
    ).toThrow("lockedRuntime is server-owned");
  });

  it("allows Main to change an ordinary Agent's decision owner", () => {
    const currentOrchestration = {
      ...orchestration(),
      agents: [
        { name: "main", template: "main" as const },
        { name: "worker", template: "general" as const }
      ],
      routes: { main: [{ target: "worker", kind: "weak" as const }], worker: [{ target: "main", kind: "weak" as const }, { target: "finish", kind: "weak" as const }] },
      input: { source: "input" as const, target: "worker" },
      decisionPlans: { main: defaultDecisionPlan("main"), worker: defaultDecisionPlan("worker") },
      termination: { ...orchestration().termination, agent: "worker" }
    } satisfies AgentOrchestrationTemplate;
    const currentAgents = mergeAgentConfigs({
      main: agents().main,
      worker: { ...agents().main, permission: "workspace", sessionPersistence: false, decisionBy: "main" }
    }, currentOrchestration);
    const document = mainAgentOrchestrationDocument("prj_test", currentOrchestration, currentAgents);
    document.agents.worker.decisionBy = "agent";
    const proposal = parseAgentOrchestrationProposal(JSON.stringify(document), "prj_test", currentOrchestration, currentAgents);
    expect(proposal.agents.worker.decisionBy).toBe("agent");
  });

  it("accepts project-owned Skill and MCP definitions referenced by Agents", () => {
    const currentOrchestration = orchestration();
    const currentAgents = agents(currentOrchestration);
    const document = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    document.skillDefinitions = {
      "analysis-tools": {
        files: { "SKILL.md": "Use the analysis tools and report evidence." }
      }
    };
    document.mcpDefinitions = {
      "task-tools": {
        files: { "server.cjs": "console.log('stdio MCP');" },
        entrypoint: "server.cjs",
        command: "node",
        args: [],
        envFrom: {}
      }
    };
    document.agents.main.skills = ["project:analysis-tools"];
    document.agents.main.mcpServers = [
      { name: "task-tools", project: "task-tools" }
    ];

    const proposal = parseAgentOrchestrationProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );

    expect(proposal.skillDefinitions).toEqual(document.skillDefinitions);
    expect(proposal.mcpDefinitions).toEqual(document.mcpDefinitions);
    expect(proposal.agents.main.skills).toEqual(["project:analysis-tools"]);
    expect(proposal.agents.main.mcpServers).toEqual([
      { name: "task-tools", project: "task-tools" }
    ]);
  });

  it("rejects a no-op and preserves a server-owned Gateway snapshot", () => {
    const currentOrchestration = orchestration();
    const currentAgents = agents(currentOrchestration);
    const snapshot = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "Locked gateway",
      url: "https://gateway.example.com/v1",
      apiKey: "server-only",
      models: ["glm-5.3"],
      defaultModel: "glm-5.3",
      protocol: "responses" as const,
      nativeProtocol: "responses" as const,
      routeMode: "direct" as const
    };
    currentAgents.main.gatewayId = snapshot.id;
    currentAgents.main.gatewaySnapshot = snapshot;
    const document = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    expect(() =>
      parseAgentOrchestrationProposal(JSON.stringify(document), "prj_test", currentOrchestration, currentAgents)
    ).toThrow("does not contain a configuration change");

    document.agents.main.instructions = "changed";
    const proposal = parseAgentOrchestrationProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    expect(proposal.agents.main.gatewaySnapshot).toEqual(snapshot);

    const changedRoute = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    changedRoute.agents.main.model = "glm-6";
    expect(parseAgentOrchestrationProposal(
      JSON.stringify(changedRoute),
      "prj_test",
      currentOrchestration,
      currentAgents
    ).agents.main.gatewaySnapshot).toBeUndefined();
  });

  it("keeps existing runtime values when an Agent template changes", () => {
    const currentOrchestration: AgentOrchestrationTemplate = {
      ...orchestration(),
      agents: [
        { name: "main", template: "main" },
        { name: "worker", template: "general" }
      ],
      routes: {
        main: [{ target: "worker", kind: "weak" }],
        worker: [{ target: "main", kind: "strong" }]
      },
      decisionPlans: {
        main: defaultDecisionPlan("main"),
        worker: "Return verified evidence."
      }
    };
    const currentAgents = mergeAgentConfigs(
      {
        main: { model: "glm-5.3", skills: [], autoSkills: [] },
        worker: {
          model: "glm-5.3",
          harness: "codex",
          skills: ["custom:worker-skill"],
          autoSkills: [],
          permission: "workspace",
          sessionPersistence: true
        }
      },
      currentOrchestration
    );
    const document = mainAgentOrchestrationDocument(
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    document.orchestration.agents[1].template = "execution";
    const proposal = parseAgentOrchestrationProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    expect(proposal.agents.worker).toMatchObject({
      model: "glm-5.3",
      harness: "codex",
      skills: ["custom:worker-skill"],
      permission: "workspace",
      sessionPersistence: true
    });
  });
});
