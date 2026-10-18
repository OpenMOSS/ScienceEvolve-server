import { describe, expect, it } from "vitest";
import {
  createBlankWorkflow,
  agentOrchestrationError,
  agentRuntimeConfigurationErrors,
  agentRuntimeConfigurationWarnings,
  applyCatalogDefaultHarness,
  catalogDefaultHarnessId,
  constrainAgentConfigToHarness,
  DEFAULT_AGENT_ORCHESTRATION,
  DEFAULT_AGENTS,
  gatewayCombinationTestState,
  gatewayHarnessTestState,
  gatewayModelTestOptions,
  harnessOptionsForPurpose,
  harnessOptionsWithHistorical,
  mergeEvents,
  normalizeAgentOrchestration,
  normalizeAgents,
  normalizeAgentConfigPresets,
  normalizeArtifacts,
  normalizeEvent,
  normalizeProject,
  normalizeQueueSnapshot,
  normalizeStatus,
  orchestrationWithoutGit,
  protocolLabel
} from "./lib";
import type { AgentEvent, GatewayRecord, HarnessCatalogEntry } from "./types";

describe("ordinary workflows without Git", () => {
  it("removes only an empty scoped envelope, retaining all Agent identities, routes, Loops and layout", () => {
    const original = normalizeAgentOrchestration(DEFAULT_AGENT_ORCHESTRATION);
    const scoped = { ...original, schemaVersion: 3 as const, scopedWorkflow: {
      schemaVersion: 1 as const, rootAgentIds: original.agents.map(agent => agent.name), groups: []
    } };
    expect(orchestrationWithoutGit(scoped)).toEqual(original);
    expect(scoped.schemaVersion).toBe(3);
    expect(scoped.scopedWorkflow.groups).toEqual([]);
    expect(orchestrationWithoutGit(original)).toBe(original);
  });

  it("never drops groups or changes graph membership to disable Git", () => {
    const original = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    original.collaborations = [{ id: "research", displayName: "Research", memberAgentIds: ["idea", "execution"], renamePolicy: "editable" }];
    expect(() => orchestrationWithoutGit(original)).toThrow("请先移除所有协作组");
    const unplaced = { ...original, collaborations: [], schemaVersion: 3 as const, scopedWorkflow: {
      schemaVersion: 1 as const, rootAgentIds: ["main"], groups: []
    } };
    expect(() => orchestrationWithoutGit(unplaced)).toThrow("请将所有已配置的 Agent 放回普通 Workflow");
    expect(unplaced.scopedWorkflow.rootAgentIds).toEqual(["main"]);
    expect(unplaced.agents).toEqual(DEFAULT_AGENT_ORCHESTRATION.agents);
  });
});

describe("API data normalization", () => {
  it("keeps the formal lifecycle, experiment stages and proven reception separate from business claims and clones the shared view", () => {
    const formalState = { domain: { scheduler: "serial", protocol: "project-state-v1" },
      checkpoint: { version: "a".repeat(64), revision: 4, lifecycle: { status: "running", phase: "agent:running" } },
      invocationCommit: { status: "in_progress", invocationId: "original-invocation" }, experiments: { version: "b".repeat(64), revision: 3,
        ledger: { experiments: [{ id: "experiment-a", agent: "worker", taskId: "task-a", runId: "run-a", status: "resource_ready", required: true, resultReceived: false }] } } };
    const project = normalizeProject({ id: "project", status: "running", collaboration: { stateRevision: 24, formalState } });
    expect(project.collaboration?.formalState).toEqual(formalState); expect(project.status).toBe("running");
    project.collaboration!.formalState!.experiments.ledger.experiments[0].resultReceived = true;
    expect(formalState.experiments.ledger.experiments[0].resultReceived).toBe(false);
    expect(normalizeProject({ id: "project", collaboration: { stateRevision: 24, formalState: { ...formalState,
      experiments: { ...formalState.experiments, ledger: { experiments: [null] } } } } }).collaboration?.formalState).toBeUndefined();
  });

  it("keeps authoritative business extensions for the state view without treating their claims as core completion", () => {
    const record = { object: { kind: "agent", id: "worker" }, sequence: 23, updatedAt: "2026-10-13T00:00:00.000Z",
      extensions: { analysis_stage: "reviewing", custom: { samples: [1, null, true], new_field: "allowed" }, status: "completed", pr_delivered: true } };
    const project = normalizeProject({ id: "project", status: "running", collaboration: { stateRevision: 24,
      businessState: [record, { ...record, object: { kind: "agent" } }, { ...record, extensions: [] }] } });
    expect(project.collaboration).toEqual({ stateRevision: 24, businessState: [record] });
    expect(project.status).toBe("running");
    project.collaboration!.businessState![0].extensions.analysis_stage = "changed-view";
    expect(record.extensions.analysis_stage).toBe("reviewing");
    expect(normalizeProject({ id: "old-project" }).collaboration).toBeUndefined();
  });

  it("exposes only archive summaries while preserving retired Agent identity and actual Session counts", () => {
    const archive = { agentId: "retired_researcher", harnessId: "codex", workflowRevision: 4,
      sessions: { retired_researcher: { legacyId: "original-legacy-id" },
        "retired_researcher::collaboration:delivery:scope": { session: { harnessId: "claude-code", nativeId: "original-native-id" } } } };
    const project = normalizeProject({ id: "archived-session-fixture", archivedAgentSessions: [archive, { ...archive, workflowRevision: 0 }, { ...archive, sessions: {} },
        { ...archive, agentId: "retired_nonpersistent", definition: { name: "retired_nonpersistent" }, sessions: {} }],
      tokenUsage: { totalTokens: 20, byAgent: { retired_researcher: { inputTokens: 10, outputTokens: 3, totalTokens: 13, invocations: 1 },
        retired_nonpersistent: { inputTokens: 5, outputTokens: 2, totalTokens: 7, invocations: 1 } } },
      performance: { byAgent: { retired_researcher: { invocationId: "inv_original", agent: "retired_researcher", startedAt: "2026-10-11T00:00:00Z", status: "completed", outputTokens: 3 } } } });
    expect(project.archivedAgentSessions).toEqual([{ agentId: "retired_researcher", harnesses: ["codex", "claude-code"], workflowRevision: 4, sessionCount: 2 },
      { agentId: "retired_nonpersistent", harnesses: ["codex"], workflowRevision: 4, sessionCount: 0 }]);
    expect(JSON.stringify(project.archivedAgentSessions)).not.toContain("original-native-id");
    expect(project.tokenUsage!.byAgent.retired_researcher.totalTokens).toBe(13); expect(project.tokenUsage!.totalTokens).toBe(20);
    expect(project.tokenUsage!.byAgent.retired_nonpersistent.totalTokens).toBe(7);
    expect(project.performance!.byAgent.retired_researcher.invocationId).toBe("inv_original");
    expect(normalizeProject({ id: "old-project" }).archivedAgentSessions).toEqual([]);
  });

  it("reads an imported old preset without an Agent proxy or aliases to its retained original", () => {
    const preset = { schemaVersion: 2, kind: "scienceevolve-agent-config-preset", id: "preset-old", name: "Original import",
      agents: { main: { ...structuredClone(DEFAULT_AGENTS.main), proxy: { mode: "inherit" }, skills: ["retained-skill"] } },
      orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION), importSource: { filename: "original.json", text: "original exact source", notices: [] } };
    const original = structuredClone(preset);
    const [current] = normalizeAgentConfigPresets({ presets: [preset] });
    expect(current.agents.main).not.toHaveProperty("proxy");
    expect(current.importSource).toEqual(preset.importSource);
    expect(current.agents.main.skills).toEqual(["retained-skill"]);
    current.agents.main.skills.push("local-draft-change");
    expect(preset).toEqual(original);
  });

  it("preserves superseded push inclusion evidence without counting it as provider success or failure", () => {
    const operation = { id: "old-unknown-push", kind: "git.push", status: "superseded", payloadHash: "original",
      ownerExecutionId: "original-task", ownershipEpoch: 1, expectedHead: "a".repeat(40), expectedBase: "executions/original-task",
      remoteFact: { kind: "included_in_later_publication", originalStatus: "uncertain", publicationOperationId: "later-push" } };
    const project = normalizeProject({ id: "project", operations: [operation, { ...operation, id: "invalid", kind: "pull.merge" }] });
    expect(project.operations).toEqual([operation]);
    expect(project.operations?.filter(item => item.status === "failed" || item.status === "finalized")).toEqual([]);
  });
  it("round-trips explicit experiment choices without deriving them from permissions", () => {
    const agents = normalizeAgents({ execution: { experimentMcp: true, permission: "workspace" },
      writing: { experimentMcp: false, permission: "compute" }, review: { permission: "yolo" } });
    expect(agents.execution).toMatchObject({ experimentMcp: true, permission: "workspace" });
    expect(agents.writing).toMatchObject({ experimentMcp: false, permission: "compute" });
    expect(agents.review).not.toHaveProperty("experimentMcp");
    const unsupported = { capabilities: { mcp: false } } as HarnessCatalogEntry;
    expect(constrainAgentConfigToHarness(agents.execution, unsupported)).toMatchObject({ experimentMcp: false, permission: "workspace" });
    expect(normalizeAgents(JSON.parse(JSON.stringify(agents))).execution.experimentMcp).toBe(true);
  });
  it("migrates legacy custom Agents into templates without promoting copies", () => {
    const legacy = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    legacy.agents.push({ name: "verifier_agent", template: "review", description: "核验结果" });
    legacy.agents.push({ name: "idea_copy1", template: "idea" });

    expect(normalizeAgentOrchestration(legacy).agentTemplates).toEqual([
      { name: "verifier_agent", template: "review", description: "核验结果" }
    ]);
    legacy.agentTemplates = [];
    expect(normalizeAgentOrchestration(legacy).agentTemplates).toEqual([]);
  });

  it("preserves cancellation causes and unverified checkpoint summaries", () => {
    const checkpoint = { id: `chk_${"a".repeat(32)}`, agent: "main", createdAt: "2026-09-22T00:00:00Z", fileCount: 2, incomplete: false, status: "unverified_partial_output" };
    const project = normalizeProject({ id: "fixture", status: "cancelled", cancelReason: "arm_timeout", cancelledBy: "deadline-monitor", cancellationSettledAt: "2026-09-22T00:00:01Z", workspaceCheckpoints: [checkpoint, { id: "../invalid" }] });
    expect(project).toMatchObject({ cancelReason: "arm_timeout", cancelledBy: "deadline-monitor", cancellationSettledAt: "2026-09-22T00:00:01Z", workspaceCheckpoints: [checkpoint] });
    expect(project.workspaceCheckpoints).toHaveLength(1);
  });

  it("normalizes Loop definitions and keeps counters scoped to configured Loop IDs", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.routes.idea = [{ target: "execution", kind: "strong" }];
    orchestration.routes.execution = [{ target: "idea", kind: "strong" }];
    orchestration.loops = [{
      id: "drafting",
      from: "execution",
      to: "idea",
      maxIterations: 3,
      exitTo: "writing"
    }];
    const project = normalizeProject({
      id: "prj_loop",
      status: "running",
      orchestration,
      loopIterations: { drafting: 2.9, stale: 99 },
      loopBatches: { drafting: 4 },
      loopTotalIterations: { drafting: 11 }
    });

    expect(project.orchestration.loops).toEqual(orchestration.loops);
    expect(project.loopIterations).toEqual({ drafting: 2 });
    expect(project.loopBatches).toEqual({ drafting: 4 });
    expect(project.loopTotalIterations).toEqual({ drafting: 11 });
  });

  it("preserves advanced workflow controls and project-owned resources", () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.termination.automatic = true;
    orchestration.allowMainReconfiguration = true;
    const project = normalizeProject({
      id: "prj_advanced",
      status: "draft",
      orchestration,
      skillDefinitions: {
        protocol: { files: { "SKILL.md": "# Protocol" } }
      },
      mcpDefinitions: {
        metrics: {
          files: { "server.cjs": "process.stdin.resume();" },
          command: "node",
          entrypoint: "server.cjs",
          envFrom: { API_TOKEN: "METRICS_API_TOKEN" }
        }
      },
      agents: {
        main: {
          ...DEFAULT_AGENTS.main,
          proxy: { mode: "inherit" },
          skills: ["project:protocol"],
          mcpServers: [{ name: "metrics", project: "metrics" }]
        }
      },
      mainCapabilities: {
        schemaVersion: 1,
        controlMode: "weak-branch",
        routeCandidates: ["idea", "finish", "not-configured"],
        canReconfigure: false,
        canComplete: false,
        canRequestUser: false
      },
      tokenUsage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        totalTokens: 15,
        invocations: 2,
        unknownRequests: 1,
        complete: false,
        byAgent: {}
      },
      artifacts: [{
        id: "art_1",
        path: "results/report.md",
        name: "report.md",
        kind: "markdown",
        sha256: "a".repeat(64)
      }]
    });

    expect(project.orchestration.termination.automatic).toBe(true);
    expect(project.orchestration.allowMainReconfiguration).toBe(true);
    expect(project.agents.main).not.toHaveProperty("proxy");
    expect(project.agents.main.skills).toContain("project:protocol");
    expect(project.agents.main.mcpServers).toContainEqual({ name: "metrics", project: "metrics" });
    expect(project.skillDefinitions).toEqual({
      protocol: { files: { "SKILL.md": "# Protocol" } }
    });
    expect(project.mcpDefinitions).toEqual({
      metrics: {
        files: { "server.cjs": "process.stdin.resume();" },
        command: "node",
        entrypoint: "server.cjs",
        envFrom: { API_TOKEN: "METRICS_API_TOKEN" }
      }
    });
    expect(project.mainCapabilities).toEqual({
      schemaVersion: 1,
      controlMode: "weak-branch",
      routeCandidates: ["idea", "finish"],
      canReconfigure: false,
      canComplete: false,
      canRequestUser: false
    });
    expect(project.tokenUsage).toMatchObject({ unknownRequests: 1, complete: false });
    expect(project.artifacts?.[0]?.sha256).toBe("a".repeat(64));
  });

  it("blocks unavailable Harnesses but only warns about untested gateway/model combinations", () => {
    const gatewayId = "gwy_0123456789abcdef0123456789abcdef";
    const gateway: GatewayRecord = {
      id: gatewayId,
      name: "真实网关",
      url: "https://gateway.example.test/v1",
      models: ["nex-agi/Nex-N2-Pro"],
      defaultModel: "nex-agi/Nex-N2-Pro",
      protocol: "responses",
      revision: 1,
      apiKeyConfigured: true,
      test: {
        status: "failed",
        protocol: "responses",
        model: "nex-agi/Nex-N2-Pro",
        error: "上游返回 HTTP 401"
      },
      tests: [],
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z"
    };
    const harnesses: HarnessCatalogEntry[] = [{
      id: "claude-code",
      label: "Claude Code",
      adapterVersion: "1",
      nativeProtocol: "anthropic-messages",
      purposes: ["workflow", "explainer", "probe"],
      mode: "workflow",
      notes: "Embedded adapter",
      capabilities: {
        durableSession: true,
        officialEvents: true,
        toolEvents: true,
        usageEvents: true,
        readOnlyExplainer: true,
        webSearch: true,
        skills: true,
        mcp: true
      },
      available: false,
      availabilityReason: "项目内置入口不可执行"
    }, {
      id: "codex",
      label: "Codex",
      adapterVersion: "1",
      nativeProtocol: "responses",
      purposes: ["workflow", "explainer", "probe"],
      default: true,
      mode: "workflow",
      notes: "Embedded adapter",
      capabilities: {
        durableSession: true,
        officialEvents: true,
        toolEvents: true,
        usageEvents: true,
        readOnlyExplainer: true,
        webSearch: true,
        skills: true,
        mcp: true
      },
      available: true
    }];
    const agents = {
      main: {
        ...structuredClone(DEFAULT_AGENTS.main),
        harness: "claude-code" as const,
        gatewayId
      }
    };

    expect(gatewayCombinationTestState(
      gateway,
      "codex",
      "nex-agi/Nex-N2-Pro",
      harnesses
    )).toMatchObject({
      status: "failed",
      error: "上游返回 HTTP 401",
      protocol: "responses",
      model: "nex-agi/Nex-N2-Pro"
    });
    expect(gatewayCombinationTestState(
      gateway,
      "claude-code",
      "nex-agi/Nex-N2-Pro",
      harnesses
    )).toMatchObject({
      status: "untested",
      routeMode: "proxy",
      routeDirection: "anthropic-messages->responses"
    });
    expect(gatewayHarnessTestState(gateway, "codex", harnesses)).toMatchObject({
      status: "failed",
      error: "上游返回 HTTP 401"
    });
    expect(gatewayHarnessTestState(gateway, "claude-code", harnesses)).toEqual({ status: "untested" });
    expect(gatewayModelTestOptions(gateway, "codex", harnesses)[0]).toMatchObject({
      model: "nex-agi/Nex-N2-Pro",
      test: { status: "failed" }
    });

    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      agents,
      [gateway],
      harnesses
    )).toEqual([
      "main：Claude Code 当前不可用（项目内置入口不可执行）"
    ]);
    expect(agentRuntimeConfigurationWarnings(
      { agents: [{ name: "main", template: "main" }] },
      agents,
      [gateway],
      harnesses
    )).toEqual([
      "main：网关尚未通过当前协议和 model 的连接测试；尚未通过 Anthropic Messages → OpenAI Responses 协议路由探测；仍可启动，但运行可能失败"
    ]);

    harnesses[0] = { ...harnesses[0]!, available: true, availabilityReason: undefined };
    gateway.test = {
      status: "passed",
      protocol: "responses",
      model: "nex-agi/Nex-N2-Pro"
    };
    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      agents,
      [gateway],
      harnesses
    )).toEqual([]);

    gateway.tests = [
      {
        status: "passed",
        protocol: "responses",
        model: "nex-agi/Nex-N2-Pro",
        harness: "claude-code",
        nativeProtocol: "anthropic-messages",
        routeMode: "proxy",
        routeDirection: "anthropic-messages->responses",
        probeKind: "route"
      },
      {
        status: "passed",
        protocol: "responses",
        model: "nex-agi/Nex-N2-Pro",
        harness: "claude-code",
        nativeProtocol: "anthropic-messages",
        routeMode: "proxy",
        routeDirection: "anthropic-messages->responses",
        probeKind: "adapter-smoke",
        cacheKey: "claude-code-route",
        adapterVersion: "1",
        executableFingerprint: "fixture-claude-code",
        gatewayRevision: 1,
        routerCompatibilityVersion: "1"
      }
    ];
    expect(gatewayCombinationTestState(
      gateway,
      "claude-code",
      "nex-agi/Nex-N2-Pro",
      harnesses
    ).status).toBe("passed");
    expect(gatewayHarnessTestState(gateway, "claude-code", harnesses)).toEqual({ status: "passed" });
    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      agents,
      [gateway],
      harnesses
    )).toEqual([]);

    expect(gatewayCombinationTestState(
      gateway,
      "claude-code",
      "nex-agi/Nex-N2-Pro",
      harnesses.map((entry) => entry.id === "claude-code"
        ? { ...entry, adapterVersion: "2" }
        : entry)
    ).status).toBe("untested");
    expect(gatewayCombinationTestState(
      gateway,
      "claude-code",
      "nex-agi/Nex-N2-Pro",
      harnesses.map((entry) => entry.id === "claude-code"
        ? { ...entry, executableFingerprint: "replacement-claude-code" }
        : entry)
    ).status).toBe("untested");
    expect(gatewayCombinationTestState(
      gateway,
      "claude-code",
      "nex-agi/Nex-N2-Pro",
      harnesses.map((entry) => entry.id === "claude-code"
        ? { ...entry, routerCompatibilityVersion: "2" }
        : entry)
    ).status).toBe("untested");

    harnesses[0] = {
      ...harnesses[0]!,
      capabilities: { ...harnesses[0]!.capabilities, webSearch: false }
    };
    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      { main: { ...agents.main, webSearch: true } },
      [gateway],
      harnesses
    )).toContain("main：Claude Code 不支持 Web Search");
    harnesses[0] = {
      ...harnesses[0]!,
      capabilities: { ...harnesses[0]!.capabilities, webSearch: true }
    };

    expect(gatewayCombinationTestState(
      { ...gateway, revision: 2 },
      "claude-code",
      "nex-agi/Nex-N2-Pro",
      harnesses
    ).status).toBe("untested");

    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      { main: { ...agents.main, gatewayId: undefined } },
      [gateway],
      harnesses
    )).toEqual(["main：使用 claude-code 时必须选择全局网关"]);

    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      { main: { ...structuredClone(DEFAULT_AGENTS.main), harness: "codex", gatewayId: undefined } },
      [],
      [{
        ...harnesses[0]!,
        id: "codex",
        label: "Codex",
        nativeProtocol: "responses",
        available: true
      }],
      true
    )).toEqual(["main：必须选择全局网关"]);
  });

  it("shows an exact Harness route failure instead of a legacy direct pass or stale smoke", () => {
    const model = "nex-agi/Nex-N2-Pro";
    const gateway: GatewayRecord = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "真实网关",
      url: "https://gateway.example.test/v1",
      models: [model],
      defaultModel: model,
      protocol: "responses",
      revision: 1,
      apiKeyConfigured: true,
      test: { status: "failed", protocol: "responses", model },
      tests: [
        {
          status: "passed",
          protocol: "responses",
          model,
          routeMode: "direct",
          probeKind: "route"
        },
        {
          status: "passed",
          protocol: "responses",
          model,
          harness: "codex",
          nativeProtocol: "responses",
          routeMode: "direct",
          probeKind: "adapter-smoke",
          cacheKey: "stale-codex-smoke",
          adapterVersion: "1",
          executableFingerprint: "stale-codex-executable",
          gatewayRevision: 1,
          routerCompatibilityVersion: "1"
        },
        {
          status: "failed",
          protocol: "responses",
          model,
          harness: "codex",
          nativeProtocol: "responses",
          routeMode: "direct",
          probeKind: "route",
          error: "exact Harness route failed"
        }
      ],
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z"
    };

    expect(gatewayCombinationTestState(gateway, "codex", model)).toMatchObject({
      status: "failed",
      harness: "codex",
      error: "exact Harness route failed"
    });
    expect(gatewayHarnessTestState(gateway, "codex")).toEqual({
      status: "failed",
      error: "exact Harness route failed"
    });

    const latestSmokeFailure: GatewayRecord = {
      ...gateway,
      tests: [
        {
          status: "passed",
          protocol: "responses",
          model,
          harness: "codex",
          nativeProtocol: "responses",
          routeMode: "direct",
          probeKind: "route"
        },
        gateway.tests![1]!,
        {
          ...gateway.tests![1]!,
          status: "failed",
          error: "newer smoke failed"
        }
      ]
    };
    expect(gatewayCombinationTestState(
      latestSmokeFailure,
      "codex",
      model
    )).toMatchObject({ status: "failed", error: "newer smoke failed" });
  });

  it("derives workflow choices and capability validation entirely from the catalog", () => {
    const workflowHarness: HarnessCatalogEntry = {
      id: "fixture-workflow",
      label: "Fixture Workflow",
      adapterVersion: "1",
      nativeProtocol: "responses",
      purposes: ["workflow", "probe"],
      default: true,
      notes: "capability fixture",
      capabilities: {
        structuredEvents: false,
        toolResults: false,
        durableSession: false,
        permissionPrompts: ["workspace"],
        workspaceInputs: false,
        autoSkills: false,
        officialEvents: false,
        toolEvents: false,
        usageEvents: false,
        readOnlyExplainer: false,
        webSearch: false,
        skills: false,
        mcp: false
      },
      available: true
    };
    const explainerOnly: HarnessCatalogEntry = {
      ...workflowHarness,
      id: "fixture-explainer",
      label: "Fixture Explainer",
      purposes: ["explainer"]
    };
    const catalog = [workflowHarness, explainerOnly];
    const configured = {
      ...structuredClone(DEFAULT_AGENTS.main),
      harness: workflowHarness.id,
      permission: "yolo" as const,
      webSearch: true,
      autoSkills: ["builtin:auto"],
      mcpServers: [{ name: "docs", url: "https://docs.example.test/mcp" }]
    };

    expect(catalogDefaultHarnessId(catalog, explainerOnly.id)).toBe(workflowHarness.id);
    expect(harnessOptionsForPurpose(catalog, "workflow").map((entry) => entry.id)).toEqual([
      workflowHarness.id
    ]);
    expect(harnessOptionsForPurpose(catalog, "workflow", explainerOnly.id)).toEqual([
      workflowHarness,
      expect.objectContaining({
        id: explainerOnly.id,
        available: false,
        availabilityReason: "Fixture Explainer 未声明 Workflow purpose"
      })
    ]);

    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      { main: configured },
      [],
      catalog
    )).toEqual(expect.arrayContaining([
      "main：Fixture Workflow 不支持统一结构化事件",
      "main：Fixture Workflow 不支持统一工具结果",
      "main：Fixture Workflow 不支持受控工作区输入",
      "main：Fixture Workflow 不支持持续 session",
      "main：Fixture Workflow 不支持 Web Search",
      "main：Fixture Workflow 不支持 Skills",
      "main：Fixture Workflow 不支持 Auto Skills",
      "main：Fixture Workflow 不支持 MCP",
      "main：Fixture Workflow 不支持 yolo 权限约束"
    ]));

    expect(constrainAgentConfigToHarness(configured, workflowHarness)).toMatchObject({
      harness: workflowHarness.id,
      permission: "workspace",
      webSearch: false,
      skills: [],
      autoSkills: [],
      mcpServers: []
    });
    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      { main: structuredClone(DEFAULT_AGENTS.main) },
      [],
      []
    )).toEqual([]);
  });

  it("distinguishes registered unsupported Explainers from historical unknown Harnesses", () => {
    const registeredUnsupported: HarnessCatalogEntry = {
      id: "fixture-workflow-only",
      label: "Fixture Workflow Only",
      adapterVersion: "1",
      nativeProtocol: "responses",
      purposes: ["workflow", "probe"],
      notes: "Purpose-aware option fixture",
      capabilities: {
        structuredEvents: true,
        toolResults: true,
        durableSession: true,
        permissionPrompts: ["workspace"],
        workspaceInputs: true,
        autoSkills: false,
        officialEvents: true,
        toolEvents: true,
        usageEvents: true,
        readOnlyExplainer: false,
        webSearch: false,
        skills: false,
        mcp: false
      },
      available: true
    };
    const claudeExplainer: HarnessCatalogEntry = {
      ...registeredUnsupported,
      id: "fixture-claude",
      label: "Fixture Claude",
      nativeProtocol: "anthropic-messages",
      purposes: ["workflow", "explainer", "probe"],
      capabilities: {
        ...registeredUnsupported.capabilities,
        readOnlyExplainer: true
      }
    };

    const registered = harnessOptionsForPurpose(
      [registeredUnsupported, claudeExplainer],
      "explainer",
      registeredUnsupported.id
    );
    expect(registered.map((entry) => entry.id)).toEqual([
      claudeExplainer.id,
      registeredUnsupported.id
    ]);
    expect(registered.at(-1)).toMatchObject({
      label: registeredUnsupported.label,
      available: false,
      availabilityReason: `${registeredUnsupported.label} 未声明 Project Explainer purpose`
    });

    const historical = harnessOptionsForPurpose(
      [claudeExplainer],
      "explainer",
      "removed-explainer"
    );
    expect(historical.at(-1)).toMatchObject({
      id: "removed-explainer",
      label: "removed-explainer",
      available: false,
      availabilityReason: expect.stringContaining("当前未注册")
    });
  });

  it("uses one protocol label mapping for every UI", () => {
    expect(protocolLabel("responses")).toBe("OpenAI Responses");
    expect(protocolLabel("chat-completions")).toBe("OpenAI Chat Completions");
    expect(protocolLabel("anthropic-messages")).toBe("Anthropic Messages");
  });

  it("keeps Gateway reasoning probes isolated by the exact selected option", () => {
    const model = "reasoning-model";
    const gateway: GatewayRecord = {
      id: "gwy_0123456789abcdef0123456789abcdef",
      name: "Reasoning gateway",
      url: "https://gateway.example.test/v1",
      models: [model],
      modelReasoning: {
        [model]: {
          parameter: "chat_template_kwargs.reasoning_effort",
          options: [{ id: "high", label: "高", value: "high" }]
        }
      },
      defaultModel: model,
      protocol: "responses",
      revision: 1,
      apiKeyConfigured: true,
      test: { status: "untested" },
      tests: [{
        status: "failed",
        protocol: "responses",
        model,
        harness: "codex",
        nativeProtocol: "responses",
        routeMode: "direct",
        probeKind: "route",
        error: "default failed"
      }, {
        status: "failed",
        protocol: "responses",
        model,
        harness: "codex",
        nativeProtocol: "responses",
        routeMode: "direct",
        probeKind: "route",
        reasoningOptionId: "high",
        error: "high failed"
      }],
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z"
    };

    expect(gatewayCombinationTestState(gateway, "codex", model)).toMatchObject({
      status: "failed",
      error: "default failed"
    });
    expect(gatewayCombinationTestState(gateway, "codex", model, [], "high")).toMatchObject({
      status: "failed",
      error: "high failed",
      reasoningOptionId: "high"
    });

    const agents = {
      main: {
        ...structuredClone(DEFAULT_AGENTS.main),
        harness: "codex",
        gatewayId: gateway.id,
        model,
        gatewayReasoningOption: "missing"
      }
    };
    expect(agentRuntimeConfigurationErrors(
      { agents: [{ name: "main", template: "main" }] },
      agents,
      [gateway],
      []
    )).toContain("main：所选网关思考强度不属于当前 model");
  });

  it("keeps only public gateway snapshot metadata in normalized Agent configs", () => {
    const gatewayId = "gwy_0123456789abcdef0123456789abcdef";
    const normalized = normalizeAgents({
      main: {
        model: "nex-agi/Nex-N2-Pro",
        gatewayId,
        gatewayReasoningOption: "high",
        gatewaySnapshot: {
          id: gatewayId,
          name: "运行快照网关",
          url: "https://gateway.example.test/v1",
          models: ["nex-agi/Nex-N2-Pro"],
          modelReasoning: {
            "nex-agi/Nex-N2-Pro": {
              parameter: "reasoning_effort",
              options: [{ id: "high", label: "高", value: "high" }]
            }
          },
          reasoning: {
            mode: "option",
            optionId: "high",
            label: "高",
            value: "high",
            parameter: "reasoning_effort",
            fingerprint: "a".repeat(64)
          },
          defaultModel: "nex-agi/Nex-N2-Pro",
          protocol: "responses",
          nativeProtocol: "responses",
          routeMode: "direct",
          testedAt: "2026-09-12T00:00:00.000Z",
          apiKey: "must-not-survive"
        }
      }
    });

    expect(normalized.main.gatewaySnapshot).toEqual({
      id: gatewayId,
      name: "运行快照网关",
      url: "https://gateway.example.test/v1",
      models: ["nex-agi/Nex-N2-Pro"],
      modelReasoning: {
        "nex-agi/Nex-N2-Pro": {
          parameter: "reasoning_effort",
          options: [{ id: "high", label: "高", value: "high" }]
        }
      },
      reasoning: {
        mode: "option",
        optionId: "high",
        label: "高",
        value: "high",
        parameter: "reasoning_effort",
        fingerprint: "a".repeat(64)
      },
      defaultModel: "nex-agi/Nex-N2-Pro",
      protocol: "responses",
      nativeProtocol: "responses",
      routeMode: "direct",
      deliveryMode: "native-stream",
      testedAt: "2026-09-12T00:00:00.000Z"
    });
    expect(normalized.main.gatewayReasoningOption).toBe("high");
    expect(normalized.main.gatewaySnapshot).not.toHaveProperty("apiKey");
  });

  it("preserves project-owned MCP references in normalized Agent configs", () => {
    const normalized = normalizeAgents({
      main: {
        mcpServers: [{ name: "task-tools", project: "task-tools" }]
      }
    }, {
      ...structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      agents: [{ name: "main", template: "main" }]
    });

    expect(normalized.main.mcpServers).toEqual([
      { name: "task-tools", project: "task-tools" }
    ]);
  });

  it("reports disconnected presentation anchors before a workflow can start", () => {
    const orchestration = normalizeAgentOrchestration(undefined);
    orchestration.canvas = {
      ...orchestration.canvas!,
      connections: { input: false, termination: true }
    };
    expect(agentOrchestrationError(orchestration)).toBe("用户输入尚未连接到 Agent");
    orchestration.canvas.connections = { input: true, termination: false };
    expect(agentOrchestrationError(orchestration)).toBe("结束节点尚未连接到 Agent");
  });

  it("keeps runtime preferences in Agent configs instead of the workflow", () => {
    const normalized = normalizeAgentOrchestration({
      agents: [
        { name: "worker", template: "general" },
        { name: "main", template: "general" },
        { name: "reviewer", template: "review" }
      ],
      input: { source: "input", target: "worker" },
      routes: {
        main: [{ target: "finish", kind: "strong" }],
        worker: [{ target: "reviewer", kind: "weak" }],
        reviewer: [{ target: "finish", kind: "weak" }]
      },
      decisionPlans: {},
      termination: {
        agent: "reviewer",
        condition: "Review complete.",
        decisionBy: "main",
        automatic: false
      }
    });

    expect(normalized.agents[0]).toEqual({ name: "main", template: "main" });
    expect(normalized).not.toHaveProperty("sessionPersistence");
    expect(normalized).not.toHaveProperty("weakDecisionBy");
  });

  it("preserves the legacy termination mode while normalizing to v2", () => {
    const normalized = normalizeAgentOrchestration({
      agents: [
        { name: "main", template: "main" },
        { name: "writer", template: "writing" }
      ],
      input: { source: "input", target: "writer" },
      routes: {
        main: [{ target: "writer", kind: "weak" }],
        writer: [{ target: "finish", kind: "weak" }]
      },
      termination: {
        agent: "writer",
        condition: "A final report exists.",
        decisionBy: "main",
        automatic: true
      }
    });

    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.collaborations).toEqual([]);
    expect(normalized.termination.automatic).toBe(true);
  });

  it("preserves and bounds custom Agent role descriptions", () => {
    const longDescription = "x".repeat(240);
    const normalized = normalizeAgentOrchestration({
      agents: [
        { name: "main", template: "main", description: "  主调度  " },
        { name: "idea", template: "idea", description: `  ${longDescription}  ` }
      ],
      input: { source: "input", target: "idea" },
      routes: { idea: [{ target: "main", kind: "strong" }] },
      decisionPlans: {},
      termination: { agent: "idea", condition: "完成", decisionBy: "main", automatic: false }
    });

    expect(normalized.agents).toEqual([
      { name: "main", template: "main", description: "主调度" },
      { name: "idea", template: "idea", description: "x".repeat(180) }
    ]);
  });

  it("creates a blank workflow with one Main Agent", () => {
    const blank = createBlankWorkflow();

    expect(Object.keys(blank.agents)).toEqual(["main"]);
    expect(blank.orchestration.agents).toEqual([{ name: "main", template: "main" }]);
    expect(blank.orchestration.allowMainReconfiguration).toBe(false);
  });

  it("preserves the canonical server workflow states", () => {
    expect(normalizeStatus("retrying")).toBe("retrying");
    expect(normalizeStatus("interrupted")).toBe("interrupted");
    expect(normalizeStatus("cancelling")).toBe("cancelling");
    expect(normalizeStatus("cancelled")).toBe("cancelled");
    expect(normalizeStatus("completed")).toBe("completed");
  });

  it("preserves an unknown historical Harness id and exposes it as unavailable", () => {
    const normalized = normalizeAgents({
      main: { harness: "retired-harness" }
    }, {
      ...structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      agents: [{ name: "main", template: "main" }]
    });
    const options = harnessOptionsWithHistorical([], normalized.main.harness);

    expect(normalized.main.harness).toBe("retired-harness");
    expect(options).toEqual([
      expect.objectContaining({
        id: "retired-harness",
        label: "retired-harness",
        available: false,
        availabilityReason: expect.stringContaining("原 ID 已保留")
      })
    ]);
  });

  it("replaces a hidden Harness in an old draft with the visible default", () => {
    const codex: HarnessCatalogEntry = {
      id: "codex", label: "Codex", adapterVersion: "1", nativeProtocol: "responses",
      purposes: ["workflow"], default: true, notes: "", available: true,
      capabilities: {
        durableSession: true, permissionPrompts: ["workspace", "compute", "yolo"],
        officialEvents: true, toolEvents: true, usageEvents: true,
        readOnlyExplainer: false, webSearch: true, skills: true, mcp: true
      }
    };
    const hidden = { ...codex, id: "claude-code", label: "Claude Code", default: false, userSelectable: false };
    const agents = { main: { ...DEFAULT_AGENTS.main, harness: hidden.id } };
    expect(applyCatalogDefaultHarness(agents, [codex, hidden]).main.harness).toBe("codex");
    expect(harnessOptionsForPurpose([codex, hidden], "workflow", hidden.id).map((item) => item.id))
      .toEqual(["codex"]);
  });

  it("normalizes an interrupted checkpoint for manual project resume", () => {
    const project = normalizeProject({
      id: "prj_checkpoint",
      title: "断点恢复",
      requirement: "从执行智能体断点恢复科研流程。",
      status: "interrupted",
      phase: "execution:interrupted",
      queuedAgent: "execution",
      interruptedAt: "2026-07-31T07:00:00.000Z",
      runCounts: {
        idea: 1,
        main: 1,
        execution: 0
      },
      agents: {}
    });

    expect(project).toMatchObject({
      status: "interrupted",
      phase: "execution:interrupted",
      queuedAgent: "execution",
      interruptedAt: "2026-07-31T07:00:00.000Z"
    });
    expect(project.agentProgress.execution.state).toBe("interrupted");
    expect(project.agentProgress.idea.state).toBe("completed");
  });

  it("normalizes canonical project progress without conflating queued and active agents", () => {
    const project = normalizeProject({
      id: "prj_1",
      title: "稀疏注意力研究",
      requirement: "验证长文本推理效率",
      status: "retrying",
      phase: "idea:retrying",
      queuedAgent: "idea",
      turn: 3,
      cycle: 2,
      queuePosition: 2,
      queueDepth: 4,
      queueEnteredAt: "2026-07-30T10:00:00.000Z",
      runCounts: {
        main: 1,
        idea: 1
      },
      executionCounts: {
        main: 1,
        idea: 2
      },
      agentProgress: {
        main: { state: "completed", runs: 1 },
        idea: { state: "retrying", runs: 1, queuePosition: 2 }
      },
      overallProgress: {
        percent: 38,
        label: "构思智能体等待重试",
        estimated: true,
        successfulCalls: 13
      },
      agents: {
        idea: {
        model: "model-a",
        reasoningEffort: "xhigh",
        permission: "workspace",
          skills: ["builtin:idea-agent"],
          mcpServers: [
            { name: "research-docs", url: "https://docs.example.test/mcp" }
          ]
        }
      },
      tokenUsage: {
        inputTokens: 120,
        cachedInputTokens: 30,
        outputTokens: 45,
        totalTokens: 165,
        invocations: 2,
        updatedAt: "2026-07-31T03:10:00.000Z",
        byAgent: {
          idea: {
            inputTokens: 50,
            cachedInputTokens: 10,
            outputTokens: 15,
            totalTokens: 65,
            invocations: 1
          },
          main: {
            inputTokens: 70,
            cachedInputTokens: 20,
            outputTokens: 30,
            totalTokens: 100,
            invocations: 1
          }
        }
      },
      computeUsage: {
        source: "inspire",
        totalCardHours: 12.8,
        workloadCount: 4,
        activeWorkloadCount: 1,
        updatedAt: "2026-07-31T03:12:00.000Z",
        byAccelerator: [
          { type: "H100", cardHours: 10.5 },
          { type: "H200", cardHours: 2.3 }
        ]
      },
      lastError: "transient failure"
    });

    expect(project.status).toBe("retrying");
    expect(project.phase).toBe("idea:retrying");
    expect(project.currentAgent).toBeUndefined();
    expect(project.queuedAgent).toBe("idea");
    expect(project.turn).toBe(3);
    expect(project.queuePosition).toBe(2);
    expect(project.queueDepth).toBe(4);
    expect(project.queueEnteredAt).toBe("2026-07-30T10:00:00.000Z");
    expect(project.agentProgress.idea).toEqual({
      state: "retrying",
      runs: 1,
      executions: 2,
      queuePosition: 2
    });
    expect(project.agentProgress.main).toEqual({
      state: "completed",
      runs: 1,
      executions: 1
    });
    expect(project.agentProgress.execution).toEqual({
      state: "waiting",
      runs: 0,
      executions: 0
    });
    expect(project.overallProgress).toEqual({
      percent: 38,
      label: "构思智能体等待重试",
      estimated: true,
      successfulCalls: 13
    });
    expect(project.agents.idea).toEqual({
      model: "model-a",
      legacyReasoningEffort: "xhigh",
      reasoningMigrationWarning: "旧 Harness 思考深度“xhigh”无法精确匹配当前 Gateway/model 选项，已改用 Provider 默认值",
      permission: "workspace",
      skills: ["builtin:idea-agent"],
      autoSkills: [],
      mcpServers: [
        { name: "research-docs", url: "https://docs.example.test/mcp" }
      ],
      instructions: "",
      webSearch: true,
      sessionPersistence: false,
      decisionBy: "main"
    });
    expect(project.agents.execution).not.toHaveProperty("reasoningEffort");
    expect(project.agents.execution).not.toHaveProperty("gatewayReasoningOption");
    expect(project.tokenUsage).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 45,
      totalTokens: 165,
      invocations: 2,
      updatedAt: "2026-07-31T03:10:00.000Z"
    });
    expect(project.tokenUsage?.byAgent.idea.totalTokens).toBe(65);
    expect(project.tokenUsage?.byAgent.execution.totalTokens).toBe(0);
    expect(project.computeUsage).toEqual({
      source: "inspire",
      totalCardHours: 12.8,
      workloadCount: 4,
      activeWorkloadCount: 1,
      updatedAt: "2026-07-31T03:12:00.000Z",
      byAccelerator: [
        { type: "H100", cardHours: 10.5 },
        { type: "H200", cardHours: 2.3 }
      ]
    });
    expect(project.error).toBe("transient failure");
  });

  it("normalizes a complete per-role queue snapshot", () => {
    const snapshot = normalizeQueueSnapshot({
      queue: {
        idea: {
          capacity: 10,
          activeProjectIds: ["prj_active", "prj_active_2"],
          queued: [
            {
              projectId: "prj_waiting",
              position: 1,
              enteredAt: "2026-07-30T10:00:00.000Z"
            }
          ]
        }
      }
    });

    expect(snapshot.idea).toEqual({
      capacity: 10,
      activeProjectIds: ["prj_active", "prj_active_2"],
      queued: [
        {
          projectId: "prj_waiting",
          position: 1,
          enteredAt: "2026-07-30T10:00:00.000Z"
        }
      ]
    });
    expect(snapshot.main).toEqual({
      capacity: 10,
      activeProjectIds: [],
      queued: []
    });
    expect(snapshot.worker).toEqual({
      capacity: 10,
      activeProjectIds: [],
      queued: []
    });
  });

  it("retains multiple queue calls and waiting identities from one project", () => {
    const snapshot = normalizeQueueSnapshot({ worker: { capacity: 10, activeProjectIds: ["project"], activeTasks: [
      { id: "call-a", projectId: "project", agentId: "alice", state: "running" }, { id: "call-b", projectId: "project", agentId: "bob", state: "starting" }
    ], recoveringTasks: [{ id: "old-call", projectId: "old", state: "recovering" }],
    queued: [{ id: "arrival-1", projectId: "project", agentId: "alice", poolId: "pool", reason: "等待 Agent 空闲", position: 1 }, { id: "arrival-2", projectId: "project", position: 2 }],
    pools: [{ id: "pool", scope: "project", projectId: "project", capacity: 2, occupied: 2 }] } });
    expect(snapshot.worker.activeTasks).toHaveLength(2);
    expect(snapshot.worker.recoveringTasks).toHaveLength(1);
    expect(snapshot.worker.queued).toMatchObject([{ id: "arrival-1", reason: "等待 Agent 空闲" }, { id: "arrival-2" }]);
    expect(snapshot.worker.pools?.[0]?.capacity).toBe(2);
  });

  it("normalizes shared-workspace file metadata", () => {
    const artifacts = normalizeArtifacts([
        {
          path: "paper/main.tex",
          producer: "writing",
          size: 1024,
          updatedAt: "2026-07-30T11:00:00.000Z"
        },
        {
          path: "paper/main.tex",
          producer: "writing",
          size: 2048,
          updatedAt: "2026-07-30T12:00:00.000Z"
        }
    ]);

    expect(artifacts).toEqual([
      expect.objectContaining({
        path: "paper/main.tex",
        name: "main.tex",
        kind: "latex",
        agent: "writing",
        size: 2048
      })
    ]);
  });

  it("preserves a complete immutable display binding and rejects a partial one", () => {
    const commitSha = "b".repeat(40);
    const bound = normalizeProject({
      id: "prj_bound_display",
      git: { enabled: true },
      display: {
        primary: {
          agent: "main",
          path: "results/report.md",
          title: "Accepted report",
          artifactId: "artifact_accepted",
          commitSha
        },
        items: []
      }
    });
    expect(bound.display?.primary).toEqual({
      agent: "main",
      path: "results/report.md",
      title: "Accepted report",
      artifactId: "artifact_accepted",
      commitSha
    });

    const partial = normalizeProject({
      id: "prj_partial_display",
      git: { enabled: true },
      display: {
        primary: {
          agent: "main",
          path: "results/report.md",
          title: "Unsafe partial binding",
          artifactId: "artifact_without_commit"
        },
        items: []
      }
    });
    expect(partial.display).toBeUndefined();
  });
});

describe("timeline event handling", () => {
  const event = (seq: number, type = "agent.trace"): AgentEvent => ({
    seq,
    type,
    agent: "execution",
    message: `event ${seq}`,
    data: {},
    ts: "2026-07-30T12:00:00.000Z"
  });

  it("deduplicates and orders replayed SSE events by sequence", () => {
    const result = mergeEvents([event(2), event(4)], [
      event(3),
      { ...event(2), message: "updated event 2" },
      event(5)
    ]);

    expect(result.map((item) => item.seq)).toEqual([2, 3, 4, 5]);
    expect(result[0].message).toBe("updated event 2");
  });

  it("deduplicates replayed SSE events by stable eventId even when the cursor changes", () => {
    const result = mergeEvents(
      [{ ...event(2), eventId: "evt-stable" }],
      [
        { ...event(3), eventId: "evt-new" },
        { ...event(4), eventId: "evt-stable", message: "latest durable copy" },
        { ...event(5), eventId: "evt-new", message: "latest incoming copy" }
      ]
    );

    expect(result.map((item) => [item.seq, item.eventId])).toEqual([
      [4, "evt-stable"],
      [5, "evt-new"]
    ]);
    expect(result.map((item) => item.message)).toEqual([
      "latest durable copy",
      "latest incoming copy"
    ]);
  });

  it("normalizes persisted resident public messages and tool envelopes after live cache cleanup", () => {
    const canonical = { schemaVersion: 1, eventId: "resident-message", invocationId: "inv-resident",
      harnessId: "codex", kind: "assistant.message", message: "已读取实验结果。" };
    const normalized = normalizeEvent({ seq: 1, type: "agent.trace", agent: "review", message: "Resident Harness event",
      data: { resident: true, event: canonical } });
    expect(normalized?.message).toBe("已读取实验结果。");
    expect(normalized?.data?.canonicalEvent).toEqual(canonical);
    const tool = { ...canonical, eventId: "resident-tool", kind: "tool.completed", message: undefined,
      tool: { callId: "read", name: "read_file", status: "completed", outputPreview: "实际工具返回内容" } };
    expect(normalizeEvent({ seq: 2, type: "agent.trace", message: "Resident Harness event",
      data: { resident: true, event: tool } })).toMatchObject({ message: "read_file", data: { canonicalEvent: tool } });
    const diagnostic = { ...canonical, kind: "diagnostic", message: undefined,
      diagnostic: { source: "adapter", level: "warning", message: "公开诊断详情" } };
    expect(normalizeEvent({ seq: 3, type: "agent.trace", message: "Resident Harness event",
      data: { resident: true, canonicalEvent: diagnostic } })?.message).toBe("公开诊断详情");
  });

  it("does not treat arbitrary nested records as public Harness events or overwrite canonical records", () => {
    const malformed = { kind: "assistant.message", message: "not a public envelope" };
    expect(normalizeEvent({ seq: 1, message: "original", data: { resident: true, event: malformed } }))
      .toMatchObject({ message: "original", data: { event: malformed } });
    expect(normalizeEvent({ seq: 1, data: { resident: true, event: malformed } })?.data).not.toHaveProperty("canonicalEvent");
    const other = { schemaVersion: 1, eventId: "other", invocationId: "inv", harnessId: "codex", kind: "assistant.message", message: "other" };
    expect(normalizeEvent({ seq: 2, message: "canonical", data: { resident: true, event: other, canonicalEvent: { id: "preferred" } } }))
      .toMatchObject({ message: "canonical", data: { canonicalEvent: { id: "preferred" } } });
  });

  it("normalizes natural-language worker result events without a score protocol", () => {
    const normalized = normalizeEvent({
      seq: 8,
      type: "agent.completed",
      agent: "review",
      message: "Review completed",
      data: {
        summary: "需要补充证据",
        markdown: "当前结果与限制",
        recommendation: "继续执行"
      },
      ts: "2026-07-30T12:00:00.000Z"
    });
    expect(normalized?.data).toMatchObject({ summary: "需要补充证据" });
    expect(normalized?.data).not.toHaveProperty("score");
  });
});
