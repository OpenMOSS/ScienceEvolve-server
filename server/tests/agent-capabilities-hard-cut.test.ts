import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_ORCHESTRATION_TEMPLATE,
  cloneAgentOrchestrationTemplate,
  workflowAgentCandidates,
  workflowAutomaticReturnTarget,
  workflowDirectTarget,
  workflowRequiresMainChoice
} from "../src/agent-orchestration.js";
import {
  agentDefinitionFor,
  SYSTEM_CONTROLLER_AGENT
} from "../src/system-controller.js";
import {
  MainDecisionValidationError,
  resolveMainDecision
} from "../src/orchestrator.js";
import {
  agentOrchestrationTemplateSchema,
  mergeAgentConfigs,
  publicAgentConfigs,
  naturalLanguageHandoffSchema
} from "../src/validation.js";
import type { ProjectState, TokenUsageTotals } from "../src/types.js";

function totals(): TokenUsageTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, invocations: 0 };
}

function stateFor(orchestration = cloneAgentOrchestrationTemplate(), overrides: Partial<ProjectState> = {}): ProjectState {
  const agents = mergeAgentConfigs(undefined, orchestration);
  const names = [...orchestration.agents.map((entry) => entry.name), SYSTEM_CONTROLLER_AGENT];
  return {
    id: "prj_hard_cut_test",
    title: "Hard-cut contract test",
    requirement: "Verify the Worker protocol.",
    status: "running",
    phase: "worker:running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turn: 0,
    cycle: 1,
    eventSeq: 0,
    consecutiveFailures: 0,
    completionGeneration: 0,
    runCounts: Object.fromEntries(names.map((name) => [name, 0])),
    mainInvocationSeq: 0,
    agents,
    orchestration,
    userInputs: [],
    tokenUsage: { ...totals(), byAgent: Object.fromEntries(names.map((name) => [name, totals()])) },
    computeUsage: { source: "inspire", totalCardHours: 0, byAccelerator: [], workloadCount: 0, activeWorkloadCount: 0, workloads: [] },
    ...overrides
  };
}

describe("public Main and generic Worker contract", () => {
  it("keeps the required Main visible alongside configured Workers", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    expect(orchestration.agents[0]).toEqual({ name: "main", template: "main" });
    expect(agentDefinitionFor(orchestration, "main").name).toBe("main");
    expect(agentDefinitionFor(orchestration, SYSTEM_CONTROLLER_AGENT).template).toBe("main");
    const runtime = mergeAgentConfigs(undefined, orchestration);
    expect(runtime).toHaveProperty(SYSTEM_CONTROLLER_AGENT);
    expect(publicAgentConfigs(runtime)).toHaveProperty(SYSTEM_CONTROLLER_AGENT);
  });

  it("accepts one natural-language Worker handoff and keeps publication in control actions", () => {
    const handoff = "## Result\nThe result is recorded in the shared workspace.";
    expect(naturalLanguageHandoffSchema.parse(handoff)).toBe(handoff);
    expect(() => naturalLanguageHandoffSchema.parse({ summary: "legacy" })).toThrow();
  });

  it("supports arbitrary Worker names without role capabilities", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    orchestration.agents.push({ name: "auditor", template: "general" });
    orchestration.routes.auditor = [{ target: "main", kind: "strong" }];
    orchestration.decisionPlans.auditor = "Inspect the evidence.";
    expect(agentOrchestrationTemplateSchema.parse(orchestration).agents.at(-1)).toMatchObject({ name: "auditor", template: "general" });
  });

  it("distinguishes deterministic routes from weak Main choices", () => {
    const direct = cloneAgentOrchestrationTemplate();
    direct.routes.execution = [{ target: "writing", kind: "strong" }];
    expect(workflowDirectTarget(direct, "execution")).toBe("writing");
    expect(workflowRequiresMainChoice(direct, "execution")).toBe(false);
    const branched = cloneAgentOrchestrationTemplate();
    branched.routes.execution = [{ target: "writing", kind: "weak" }, { target: "review", kind: "weak" }];
    expect(workflowRequiresMainChoice(branched, "execution")).toBe(true);
    expect(workflowAgentCandidates(branched, "execution")).toEqual(["writing", "review"]);
    expect(workflowAgentCandidates(direct, "review")).toContain("finish");
  });

  it("only bypasses Main for an automatic judge with one ordinary repair target", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    orchestration.termination.automatic = true;
    orchestration.routes.review = [
      { target: "writing", kind: "weak" },
      { target: "finish", kind: "weak" }
    ];
    expect(workflowAutomaticReturnTarget(orchestration, "review")).toBe("writing");
    expect(workflowAutomaticReturnTarget(orchestration, "writing")).toBeUndefined();

    orchestration.termination.automatic = false;
    expect(workflowAutomaticReturnTarget(orchestration, "review")).toBeUndefined();
    orchestration.termination.automatic = true;
    for (const targets of [
      ["finish"],
      ["main", "finish"],
      ["writing", "idea", "finish"]
    ]) {
      orchestration.routes.review = targets.map((target) => ({
        target,
        kind: "weak" as const
      }));
      expect(workflowAutomaticReturnTarget(orchestration, "review")).toBeUndefined();
    }
  });

  it("allows Main to finish when the pending route exposes finish", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    const pending = {
      sourceAgent: "review",
      sourceInvocationId: "inv_review",
      decisionPlan: "Choose finish or continue.",
      requestedAt: new Date().toISOString(),
      candidateAgents: ["writing", "finish"],
      allowAnyAgent: false,
      reason: "termination" as const
    };
    const decision = {
      assessment: "The condition is satisfied.",
      nextAgent: "finish" as const,
      message: "Complete the project.",
      rationale: "The termination Worker supplied evidence.",
      successCriteria: ["The project is complete."]
    };
    expect(resolveMainDecision(stateFor(orchestration, { pendingMainDecision: pending }), decision)).toEqual(decision);
  });

  it("lets a termination review reassign any configured ordinary Agent but rejects unknown names", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    const pending = {
      sourceAgent: "review",
      sourceInvocationId: "inv_review",
      decisionPlan: "Accept or assign precise rework.",
      requestedAt: new Date().toISOString(),
      candidateAgents: ["idea", "execution", "writing", "review", "finish"],
      allowAnyAgent: true,
      reason: "termination" as const
    };
    const rework = {
      assessment: "The final evidence is incomplete.",
      nextAgent: "execution" as const,
      message: "Repair the missing experiment evidence.",
      rationale: "Execution owns the incomplete result.",
      successCriteria: ["Publish the corrected evidence."]
    };
    expect(resolveMainDecision(
      stateFor(orchestration, { pendingMainDecision: pending }),
      rework
    )).toEqual(rework);
    expect(() => resolveMainDecision(
      stateFor(orchestration, { pendingMainDecision: pending }),
      { ...rework, nextAgent: "not-configured" }
    )).toThrow("unknown Agent name");
  });

  it("rejects finish when the pending source has no finish candidate", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    const pending = {
      sourceAgent: "main",
      sourceInvocationId: "inv_main",
      decisionPlan: "Choose a Worker.",
      requestedAt: new Date().toISOString(),
      candidateAgents: ["idea", "execution", "writing", "review"],
      allowAnyAgent: false,
      reason: "weak-branch" as const
    };
    const decision = {
      assessment: "The work appears complete.",
      nextAgent: "finish" as const,
      message: "Complete the project.",
      rationale: "The output looks sufficient.",
      successCriteria: ["The project is complete."]
    };
    expect(() => resolveMainDecision(stateFor(orchestration, { pendingMainDecision: pending }), decision)).toThrow(
      "Main selected finish outside a configured termination decision"
    );
  });

  it("rejects a forged finish candidate when the source route has no finish edge", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    const pending = {
      sourceAgent: "execution",
      sourceInvocationId: "inv_execution",
      decisionPlan: "Choose a Worker or finish.",
      requestedAt: new Date().toISOString(),
      candidateAgents: ["finish" as const],
      allowAnyAgent: false,
      reason: "weak-branch" as const
    };
    const decision = {
      assessment: "The work appears complete.",
      nextAgent: "finish" as const,
      task: "Complete the project.",
      rationale: "The output looks sufficient.",
      successCriteria: ["The project is complete."]
    };
    expect(() => resolveMainDecision(stateFor(orchestration, { pendingMainDecision: pending }), decision)).toThrow(
      "Main cannot finish because execution has no configured finish edge"
    );
  });

  it("rejects Main user intervention when the workflow disables it", () => {
    const orchestration = cloneAgentOrchestrationTemplate();
    orchestration.allowUserIntervention = false;
    const decision = {
      assessment: "A user decision is needed.",
      nextAgent: "user" as const,
      message: "Provide the missing input.",
      rationale: "The workflow does not have enough information.",
      successCriteria: ["The user supplies the missing input."]
    };
    expect(() => resolveMainDecision(stateFor(orchestration), decision)).toThrow(MainDecisionValidationError);
  });

  it("rejects self-loops and legacy loop configuration", () => {
    const selfLoop = cloneAgentOrchestrationTemplate();
    selfLoop.routes.execution = [{ target: "execution", kind: "strong" }];
    expect(() => agentOrchestrationTemplateSchema.parse(selfLoop)).toThrow("出边不能指向自身");
    const legacy = { ...DEFAULT_AGENT_ORCHESTRATION_TEMPLATE, loop: { execution: "writing" } };
    expect(() => agentOrchestrationTemplateSchema.parse(legacy)).toThrow();
  });
});
