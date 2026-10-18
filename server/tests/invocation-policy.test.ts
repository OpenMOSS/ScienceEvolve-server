import { describe, expect, it } from "vitest";
import {
  assertInvocationPolicySupported,
  compileInvocationPolicy,
  compileWorkflowPrompt,
  sessionRecoveryNote
} from "../src/harness-runtime/invocation-policy.js";
import { BUILTIN_HARNESS_DESCRIPTORS } from "../src/harness-runtime/registry.js";
import type { AgentRunRequest } from "../src/types.js";

describe("invocation policy", () => {
  it("provides the complete current research requirement and acceptance directly on resident business turns", () => {
    const config = { instructions: "Current role", skills: [], autoSkills: [], mcpServers: [], permission: "workspace", webSearch: false } as AgentRunRequest["project"]["agents"][string];
    const requirement = "Complete canonical research requirement. ".repeat(300);
    const request = { agent: "main", kind: "main", permission: "workspace", skillPaths: [], project: { requirement,
      inputDescription: "Use only the provided dataset", agents: { main: config }, orchestration: { allowUserIntervention: false,
        termination: { condition: "Verify all required results" }, resultFormat: { kind: "paper", description: "Chinese report" } } } } as unknown as AgentRunRequest;
    const inputs = { projectPath: "/project", workspacePath: "/workspace", inboxPath: "/inputs/inbox", memoryPath: "/workspace/Memory.md", runtimePath: "/runtime", inboxSha256: "fixture" };
    const prompt = compileWorkflowPrompt(request, inputs, compileInvocationPolicy(config, request));
    expect(prompt).toContain(requirement); expect(prompt).toContain("Use only the provided dataset");
    expect(prompt).toContain("Verify all required results"); expect(prompt).toContain("Chinese report");
    const inline = compileWorkflowPrompt(request, inputs, compileInvocationPolicy(config, request), { inlineInbox: requirement });
    expect(inline.split(requirement)).toHaveLength(2);
  });
  it.each(["main", "worker", "leader"] as const)("gives %s the project-wide autonomous policy before conflicting old instructions", role => {
    const config = { instructions: "Wait for the user to supply a topic before doing research.", skills: [], autoSkills: [],
      mcpServers: [], permission: "workspace", webSearch: false } as AgentRunRequest["project"]["agents"][string];
    const request = { agent: role, kind: role === "main" ? "main" : "worker", permission: "workspace", skillPaths: [],
      project: { agents: { [role]: config }, orchestration: { allowUserIntervention: false } },
      ...(role === "leader" ? { executionContext: { role: "leader", executionId: "group", groupRunId: "G" } } : {}) } as unknown as AgentRunRequest;
    const prompt = compileWorkflowPrompt(request, { projectPath: "/project", workspacePath: "/workspace",
      inboxPath: "/inputs/inbox", memoryPath: "/workspace/Memory.md", runtimePath: "/runtime", inboxSha256: "fixture" }, compileInvocationPolicy(config, request));
    expect(prompt).toContain("user intervention is disabled for every Main, Leader and Worker");
    expect(prompt).toContain("continue the assigned research through a final deliverable without user intervention");
    expect(prompt).toContain("Never invent data, citations or successful experiments");
    expect(prompt.indexOf("Project execution policy:")).toBeLessThan(prompt.indexOf("Standing Agent mandate:"));
    expect(config.instructions).toBe("Wait for the user to supply a topic before doing research.");
  });
  it.each(["workspace", "compute", "yolo"] as const)("worktree closing removes %s business capabilities and names only the exact closing scope", permission => {
    const config = { instructions: "Implement my whole business mandate", experimentMcp: true,
      mcpServers: [{ name: "business", url: "https://example.invalid/mcp" }], webSearch: true, reasoningEffort: "high" } as AgentRunRequest["project"]["agents"][string];
    const original = structuredClone(config);
    const worktreeClosing = { kind: "bound-report-memory" as const, reportHeadSha: "a".repeat(40), paths: ["agent-memory/worker/Memory.md"],
      executionId: "old", ownershipEpoch: 2, grantInvocationId: "leader", grantCallId: "explicit-close" };
    const request = { permission, worktreeClosing, agent: "worker", kind: "worker", skillPaths: ["/missing/SKILL.md"],
      autoSkillPaths: ["/missing/auto/SKILL.md"], siiMcp: { url: "http://127.0.0.1:12345/sii/forbidden" }, siiResumePrompt: "forbidden resume instruction",
      project: { agents: { worker: config }, git: { enabled: true } }, executionContext: { role: "delivery", executionId: "old" },
      control: { stagingPath: "/runtime/actions.json", capability: "server", stateVersion: 2, candidates: [], decisionBy: "agent",
        allowUserIntervention: false, canComplete: false, allowAgentGitActions: true, requireBridge: true, worktreeClosing } } as unknown as AgentRunRequest;
    const policy = compileInvocationPolicy(config, request);
    expect(policy).toMatchObject({ permission: "workspace", skillPaths: [], autoSkillPaths: [], mcpServers: [], webSearch: false });
    const prompt = compileWorkflowPrompt(request, { projectPath: "/project", workspacePath: "/worktree", inboxPath: "/runtime/inbox",
      memoryPath: "/worktree/agent-memory/worker/Memory.md", runtimePath: "/runtime", inboxSha256: "fixture" }, policy);
    expect(prompt).toContain("- wake reason: worktree-closing");
    expect(prompt).toContain(`Immutable original report A: ${worktreeClosing.reportHeadSha}`);
    expect(prompt).toContain(JSON.stringify(worktreeClosing.paths));
    expect(prompt).toContain("git_push with your own nonempty reason");
    expect(prompt).toContain("separate finish_task");
    expect(prompt).not.toContain("Implement my whole business mandate");
    expect(prompt).not.toContain("has business/delivery authority");
    expect(prompt).not.toContain("forbidden resume instruction");
    expect(prompt).not.toContain("run_experiment");
    expect(config).toEqual(original);
  });
  it("drops user-supplied SII endpoints and accepts only the trusted invocation binding", () => {
    const config = { mcpServers: [{ name: "ScienceEvolve-SII", url: "https://example.invalid/sii" },
      { name: "business", url: "https://example.invalid/mcp" }], webSearch: false } as AgentRunRequest["project"]["agents"][string];
    const request = { permission: "compute", skillPaths: [] } as AgentRunRequest;
    expect(compileInvocationPolicy(config, request).mcpServers).toEqual([{ name: "business", url: "https://example.invalid/mcp" }]);
    expect(compileInvocationPolicy(config, { ...request, siiMcp: { url: "http://127.0.0.1:12345/sii/task" } }).mcpServers)
      .toEqual([{ name: "business", url: "https://example.invalid/mcp" }, { name: "scienceevolve-sii", url: "http://127.0.0.1:12345/sii/task" }]);
  });
  it.each(["workspace", "compute", "yolo"] as const)("terminal push receipt overrides %s business capabilities without changing the Agent configuration", (permission) => {
    const config = { instructions: "Implement the whole business product and publish it", sessionPersistence: false,
      mcpServers: [{ name: "business", url: "https://example.invalid/mcp" }], webSearch: true, reasoningEffort: "high" } as AgentRunRequest["project"]["agents"][string];
    const original = structuredClone(config);
    const observation = { operationId: "original-push" };
    const request = { permission, terminalPushObservation: observation, skillPaths: ["/missing/SKILL.md"],
      autoSkillPaths: ["/missing/auto/SKILL.md"], agent: "worker", kind: "worker", taskSessionId: "completed-original",
      project: { agents: { worker: config }, git: { enabled: true }, pendingMainDecision: { reason: "old-business-error" } },
      executionContext: { role: "delivery", executionId: "completed-original" },
      control: { stagingPath: "/runtime/actions.json", capability: "server-only", stateVersion: 2, candidates: [],
        decisionBy: "agent", allowUserIntervention: false, canComplete: false, allowAgentGitActions: true,
        terminalPushObservation: observation, requireBridge: true } } as unknown as AgentRunRequest;
    const policy = compileInvocationPolicy(config, request);
    expect(policy).toMatchObject({ permission: "workspace", skillPaths: [], autoSkillPaths: [], mcpServers: [],
      webSearch: false, reasoningEffort: "high" });
    const prompt = compileWorkflowPrompt(request, { projectPath: "/fixture/project", workspacePath: "/fixture/workspace",
      inboxPath: "/runtime/inbox.md", memoryPath: "/fixture/workspace/agent-memory/worker/Memory.md", runtimePath: "/runtime", inboxSha256: "fixture" }, policy);
    expect(prompt).toContain("- wake reason: terminal-push-observation");
    expect(prompt).toContain("same persistent session");
    expect(prompt).toContain('operationId="original-push", historical=true');
    expect(prompt).toContain("provider returns its actual result directly to you");
    expect(prompt).toContain("finish_task for this supplement");
    expect(prompt).toContain("/runtime/inbox.md");
    expect(prompt).toContain("agent-memory/worker/Memory.md");
    expect(prompt).toContain("exposes exactly: `finish_task`, `git_reconcile_push`");
    expect(prompt).not.toContain("Implement the whole business product");
    expect(prompt).not.toContain("call git_push");
    expect(prompt).not.toContain("github_create_pr");
    expect(prompt).not.toContain("has business/delivery authority");
    expect(config).toEqual(original);
  });

  it("adds side-effect verification only to an actual Session continuation", () => {
    const note = sessionRecoveryNote("the native Session was replaced");
    expect(note).toContain("A missing tool response does not mean the operation did not run");
    expect(note).toContain("files, logs, published artifacts, handoff, checkpoint, and Memory.md");
    expect(note).toContain("repeat only the unfinished part");
    expect(note).toContain("Recovery reason: the native Session was replaced");
  });

  it.each(["workspace", "compute", "yolo"] as const)(
    "injects the common %s constraint and readable inputs",
    (permission) => {
      const config = {
        instructions: "fixture mandate",
        mcpServers: [],
        webSearch: false
      } as AgentRunRequest["project"]["agents"][string];
      const request = {
        permission,
        skillPaths: ["/fixture/SKILL.md"],
        autoSkillPaths: [],
        kind: "worker",
        agent: "worker",
        project: { agents: { worker: config } }
      } as AgentRunRequest;
      const policy = compileInvocationPolicy(config, request);
      const prompt = compileWorkflowPrompt(request, {
        projectPath: "/fixture/project",
        workspacePath: "/fixture/workspace",
        inboxPath: "/fixture/workspace/.scienceevolve/inbox/inv.md",
        memoryPath: "/fixture/workspace/Memory.md",
        userInputsPath: "/fixture/project/workspaces/user_inputs",
        runtimePath: "/fixture/runtime",
        inboxSha256: "fixture"
      }, policy);
      expect(policy.constraintPrompt).toContain(`permission mode: ${permission}`);
      expect(prompt).toContain(".scienceevolve/inbox/inv.md");
      expect(prompt).toContain("Memory.md");
      expect(prompt).toContain("/fixture/project/workspaces/user_inputs");
      expect(prompt).toContain("preserve originals");
      expect(prompt).not.toContain("Session continuation safety");
    }
  );

  it.each(["codex", "dsh", "pi"])("allows configured Web Search for %s", (id) => {
    const harness = BUILTIN_HARNESS_DESCRIPTORS.find((item) => item.id === id)!;
    expect(() => assertInvocationPolicySupported(harness, {
      permission: "workspace",
      constraintPrompt: "fixture",
      skillPaths: [],
      autoSkillPaths: [],
      mcpServers: [],
      webSearch: true
    })).not.toThrow();
  });

  it.each(["main", "worker"] as const)("keeps normal %s capabilities while repairing a missing terminal action", (kind) => {
    const config = {
      instructions: "Inspect the whole repository and write a report.",
      mcpServers: [{ name: "external", url: "https://example.invalid/mcp" }],
      webSearch: true
    } as AgentRunRequest["project"]["agents"][string];
    const request = {
      permission: "compute",
      skillPaths: ["/fixture/selected/SKILL.md"],
      autoSkillPaths: ["/fixture/auto/SKILL.md"],
      availableSkillPaths: ["/fixture/available/SKILL.md"],
      kind,
      agent: "main",
      terminalControlRepair: { originalHandoff: "The analysis is complete" },
      project: { agents: { main: config } },
      control: {
        stagingPath: "/fixture/runtime/control-actions.json",
        capability: "fixture",
        stateVersion: 1,
        candidates: ["worker"],
        decisionBy: "main",
        allowUserIntervention: true,
        canComplete: true
      }
    } as AgentRunRequest;
    const policy = compileInvocationPolicy(config, request);
    const prompt = compileWorkflowPrompt(request, {
      projectPath: "/fixture/project",
      workspacePath: "/fixture/workspace",
      inboxPath: "/fixture/workspace/.scienceevolve/inbox/inv.md",
      memoryPath: "/fixture/workspace/Memory.md",
      runtimePath: "/fixture/runtime",
      inboxSha256: "fixture"
    }, policy, { inlineInbox: "large normal invocation context" });

    expect(policy).toMatchObject({
      skillPaths: ["/fixture/selected/SKILL.md"],
      autoSkillPaths: ["/fixture/auto/SKILL.md"],
      mcpServers: [{ name: "external", url: "https://example.invalid/mcp" }],
      webSearch: true
    });
    expect(prompt).toContain("returned a handoff without a required terminal control action");
    expect(prompt).toContain("Re-read the Inbox, workspace and project evidence");
    expect(prompt).not.toContain("The analysis is complete");
    expect(prompt).toContain('source="terminal-control-repair"');
    expect(prompt).toContain("commit exactly one currently legal terminal action");
    expect(prompt).toContain(".scienceevolve/inbox");
    expect(prompt).toContain("Memory.md");
    expect(prompt).not.toContain("large normal invocation context");
    expect(prompt).toContain("Inspect the whole repository");
    expect(prompt).toContain("/fixture/selected/SKILL.md");
    expect(prompt).toContain("Web Search is enabled");
    expect(prompt).toContain("## Current role and execution stage");
    expect(prompt).toContain(`- role: ${kind}`);
    expect(prompt).toContain("- stage: unknown");
    expect(prompt).toContain("The authoritative orchestration tools/list for this invocation exposes exactly:");
    if (kind === "main") expect(prompt).toContain("`route_to_agent`");
    else expect(prompt).not.toContain("`route_to_agent`");
    expect(prompt).toContain("`publish_artifact`");
    expect(prompt).not.toContain("`coordinate_group_task`");
  });
});
