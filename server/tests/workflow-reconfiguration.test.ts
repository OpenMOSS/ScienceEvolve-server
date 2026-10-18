import { describe, expect, it } from "vitest";
import { defaultDecisionPlan } from "../src/agent-orchestration.js";
import type { AgentOrchestrationTemplate } from "../src/types.js";
import { mergeAgentConfigs } from "../src/validation.js";
import {
  mainWorkflowDocument,
  parseWorkflowProposal,
  workflowBaseHash
} from "../src/workflow-reconfiguration.js";

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

describe("Main workflow reconfiguration document", () => {
  it.each(["missing", "older", "extra"] as const)("rejects a %s original version even when configuration content has returned to the same hash", kind => {
    const current = orchestration(), agents = mergeAgentConfigs(undefined, current);
    const version = { revision: 3, hash: "a".repeat(64) };
    const draft = mainWorkflowDocument("prj_test", current, version);
    draft.orchestration.decisionPlans.main = "Explicitly revised Main task";
    if (kind === "missing") delete draft.baseVersion;
    else if (kind === "older") draft.baseVersion!.revision = 1;
    else Object.assign(draft.baseVersion!, { unexpected: true });
    expect(() => parseWorkflowProposal(JSON.stringify(draft), "prj_test", current, agents, { baseVersion: version }))
      .toThrow(/original configuration version/);
  });

  it("retains the original full version and accepts an explicitly reconciled proposal regardless of metadata key order", () => {
    const current = orchestration(), agents = mergeAgentConfigs(undefined, current);
    const version = { revision: 3, hash: "a".repeat(64) };
    const draft = mainWorkflowDocument("prj_test", current, version);
    version.revision = 4;
    expect(draft.baseVersion!.revision).toBe(3);
    draft.baseVersion = { hash: version.hash, revision: 3 };
    draft.orchestration.decisionPlans.main = "Explicitly revised Main task";
    expect(parseWorkflowProposal(JSON.stringify(draft), "prj_test", current, agents,
      { baseVersion: { revision: 3, hash: version.hash } }).orchestration.decisionPlans.main).toBe("Explicitly revised Main task");
  });

  it("keeps the formal base hash stable across SQLite/JSON object key ordering", () => {
    const current = orchestration();
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverse(entry)])) : value;
    expect(workflowBaseHash(reverse(current) as AgentOrchestrationTemplate)).toBe(workflowBaseHash(current));
  });
  it("exposes only macro orchestration and no Agent runtime configuration", () => {
    const currentOrchestration = orchestration();
    const document = mainWorkflowDocument("prj_test", currentOrchestration);

    expect(document.editableFields).toEqual(["orchestration"]);
    expect(document.editingInstructions.routes).toContain(
      '{ target, kind }'
    );
    expect(document.editingInstructions.routes).toContain('"kind": "strong"');
    expect(document.editingInstructions.invariants.join(" ")).toContain(
      "harness"
    );
    expect(Object.prototype.hasOwnProperty.call(document, "agents")).toBe(false);
  });

  it("accepts macro changes while preserving existing Agent runtime settings", () => {
    const currentOrchestration = orchestration();
    const currentAgents = mergeAgentConfigs(
      { main: { model: "glm-5.3", skills: [], autoSkills: [] } },
      currentOrchestration
    );
    currentAgents.main.harness = "codex";
    const document = mainWorkflowDocument("prj_test", currentOrchestration);
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
      "Return verified evidence to Main.";
    document.orchestration.allowUserIntervention = false;
    document.orchestration.termination = {
      agent: "main",
      condition: "Main accepts the analyst's verified evidence.",
      decisionBy: "main",
      automatic: true
    };
    document.orchestration.resultFormat = {
      presets: ["markdown"],
      custom: "Include a verification section."
    };
    const proposal = parseWorkflowProposal(
      `${JSON.stringify(document)}\n`,
      "prj_test",
      currentOrchestration,
      currentAgents
    );

    expect(proposal.orchestration).toMatchObject({
      input: { target: "analyst" },
      allowUserIntervention: false,
      allowMainReconfiguration: true,
      termination: {
        agent: "main",
        automatic: true,
        condition: "Main accepts the analyst's verified evidence."
      },
      resultFormat: {
        presets: ["markdown"],
        custom: "Include a verification section."
      }
    });
    expect(proposal.orchestration.agents.map(({ name }) => name)).toEqual([
      "main",
      "analyst"
    ]);
    expect(proposal.agents.main.model).toBe("glm-5.3");
    expect(proposal.agents.main.harness).toBe(currentAgents.main.harness);
    expect(proposal.agents.analyst).toMatchObject({
      permission: "workspace",
      sessionPersistence: false
    });
  });

  it("does not apply a new template's runtime defaults to an existing Agent", () => {
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
        main: { model: "glm-5.3", harness: "codex", skills: [], autoSkills: [] },
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
    const document = mainWorkflowDocument("prj_test", currentOrchestration);
    document.orchestration.agents = [
      { name: "main", template: "main" },
      { name: "worker", template: "execution" }
    ];
    const proposal = parseWorkflowProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );

    expect(proposal.orchestration.agents[1]).toEqual({
      name: "worker",
      template: "execution"
    });
    expect(proposal.agents.worker).toMatchObject({
      model: "glm-5.3",
      harness: "codex",
      skills: ["custom:worker-skill"],
      permission: "workspace",
      sessionPersistence: true
    });
  });

  it("rejects stale, no-op, and self-authorizing proposals", () => {
    const currentOrchestration = orchestration();
    const currentAgents = mergeAgentConfigs(
      { main: { skills: [], autoSkills: [] } },
      currentOrchestration
    );
    const noOp = mainWorkflowDocument(
      "prj_test",
      currentOrchestration
    );
    expect(() =>
      parseWorkflowProposal(
        JSON.stringify(noOp),
        "prj_test",
        currentOrchestration,
        currentAgents
      )
    ).toThrow("does not contain a configuration change");

    // A legacy unversioned serial document and its normalized v2 form are the
    // same workflow, not a macro change introduced by the v2 migration.
    const normalizedNoOp = mainWorkflowDocument(
      "prj_test",
      currentOrchestration
    );
    normalizedNoOp.orchestration = {
      ...normalizedNoOp.orchestration,
      schemaVersion: 2,
      collaborations: []
    };
    expect(() =>
      parseWorkflowProposal(
        JSON.stringify(normalizedNoOp),
        "prj_test",
        currentOrchestration,
        currentAgents
      )
    ).toThrow("does not contain a configuration change");

    const unauthorized = structuredClone(noOp);
    unauthorized.orchestration.allowMainReconfiguration = false;
    expect(() =>
      parseWorkflowProposal(
        JSON.stringify(unauthorized),
        "prj_test",
        currentOrchestration,
        currentAgents
      )
    ).toThrow("cannot change its workflow-reconfiguration authority");

    const stale = structuredClone(noOp);
    stale.baseHash = "0".repeat(64);
    expect(() =>
      parseWorkflowProposal(
        JSON.stringify(stale),
        "prj_test",
        currentOrchestration,
        currentAgents
      )
    ).toThrow("workflow.json is stale");

    const withRuntimeConfig = structuredClone(noOp) as typeof noOp & {
      agents: Record<string, unknown>;
    };
    withRuntimeConfig.agents = { main: { harness: "some-other-harness" } };
    expect(() =>
      parseWorkflowProposal(
        JSON.stringify(withRuntimeConfig),
        "prj_test",
        currentOrchestration,
        currentAgents
      )
    ).toThrow("must not contain Agent runtime configuration");

    const changedMetadata = structuredClone(noOp);
    changedMetadata.editableFields = ["agents"] as never;
    expect(() =>
      parseWorkflowProposal(
        JSON.stringify(changedMetadata),
        "prj_test",
        currentOrchestration,
        currentAgents
      )
    ).toThrow("editableFields is server-owned and immutable");

    const changedInstructions = structuredClone(noOp);
    changedInstructions.editingInstructions.routes = "anything";
    expect(() =>
      parseWorkflowProposal(
        JSON.stringify(changedInstructions),
        "prj_test",
        currentOrchestration,
        currentAgents
      )
    ).toThrow("editingInstructions is server-owned and immutable");
  });

  it("preserves locked Gateway snapshots for existing and newly added Agents", () => {
    const currentOrchestration = orchestration();
    const currentAgents = mergeAgentConfigs(
      {
        main: {
          model: "glm-5.3",
          harness: "codex",
          gatewayId: "gwy_0123456789abcdef0123456789abcdef",
          skills: [],
          autoSkills: []
        }
      },
      currentOrchestration
    );
    const reasoningMigrationWarning =
      "旧 Harness 思考深度“high”无法精确匹配当前 Gateway/model 选项，已改用 Provider 默认值";
    const snapshot = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "Locked gateway",
      url: "https://gateway.example.com/v1",
      apiKey: "server-only",
      models: ["glm-5.3"],
      modelContextWindows: {},
      modelReasoning: {},
      reasoningMigrationWarning,
      defaultModel: "glm-5.3",
      protocol: "responses" as const,
      nativeProtocol: "responses" as const,
      routeMode: "direct" as const
    };
    currentAgents.main.gatewaySnapshot = snapshot;
    currentAgents.main.reasoningMigrationWarning = reasoningMigrationWarning;

    const document = mainWorkflowDocument("prj_test", currentOrchestration);
    document.orchestration.agents.push({ name: "analyst", template: "general" });
    document.orchestration.routes.analyst = [
      { target: "main", kind: "strong" }
    ];
    document.orchestration.decisionPlans.analyst = "Return evidence.";

    const proposal = parseWorkflowProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    expect(proposal.agents.main.gatewaySnapshot).toEqual(snapshot);
    expect(proposal.agents.analyst.gatewaySnapshot).toEqual(snapshot);
    expect(proposal.agents.analyst.gatewayId).toBe(snapshot.id);
    expect(proposal.agents.main.reasoningMigrationWarning).toBe(
      reasoningMigrationWarning
    );
    expect(proposal.agents.analyst.reasoningMigrationWarning).toBe(
      reasoningMigrationWarning
    );
  });

  it("allows Main to remove an ordinary Agent when the resulting graph is valid", () => {
    const currentOrchestration: AgentOrchestrationTemplate = {
      ...orchestration(),
      agents: [
        { name: "main", template: "main" },
        { name: "obsolete", template: "general" }
      ],
      routes: {
        main: [{ target: "obsolete", kind: "weak" }],
        obsolete: [{ target: "main", kind: "strong" }]
      },
      decisionPlans: {
        main: defaultDecisionPlan("main"),
        obsolete: "Return to Main."
      }
    };
    const currentAgents = mergeAgentConfigs(
      {
        main: { skills: [], autoSkills: [] },
        obsolete: { skills: [], autoSkills: [] }
      },
      currentOrchestration
    );
    const document = mainWorkflowDocument(
      "prj_test",
      currentOrchestration
    );
    document.orchestration.agents = [{ name: "main", template: "main" }];
    document.orchestration.input.target = "main";
    document.orchestration.routes = { main: [] };
    document.orchestration.decisionPlans = {
      main: defaultDecisionPlan("main")
    };
    const proposal = parseWorkflowProposal(
      JSON.stringify(document),
      "prj_test",
      currentOrchestration,
      currentAgents
    );
    expect(proposal.orchestration.agents).toEqual([
      { name: "main", template: "main" }
    ]);
    expect(proposal.agents.obsolete).toBeUndefined();
  });

});
