import { workflowAdjustmentPageFixture } from "../test/workflow-adjustment-history";
import { runtimeProjectFixture } from "../test/runtime-project";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addProjectUserInput,
  cancelProjectExplainer,
  createUserSkill,
  getArtifact,
  getArtifactDirectory,
  getArtifactPage,
  getArtifactSummary,
  getArtifacts,
  getCatalog,
  getAgentToolRecommendationCatalog,
  getRecommendationExplainerConfig,
  recommendAgentTools,
  getProject,
  getWorkflowAdjustmentPage, getWorkflowAdjustmentDetail,
  submitWorkflowAdjustment,
  withdrawWorkflowAdjustment,
  getProjectExplainerConfig,
  getProjectExplainerHistory,
  getQueue,
  projectAction,
  refreshGatewayModels,
  respondToUserIntervention,
  resetProjectExplainer,
  streamProjectExplainerQuestion,
  updateProjectExplainerConfig,
  updateProjectAgentConfigs,
  updateProjectCollaborationGroup
} from "../api";
import {
  DEFAULT_AGENT_ORCHESTRATION,
  DEFAULT_AGENTS,
  normalizeEvent
} from "../lib";
import { addScopedGroup, upgradeLegacyGroups } from "../components/workflow-canvas/core/scoped-workflow";
import type {
  AgentEvent,
  GatewayRecord,
  HarnessCatalogEntry,
  InvocationPerformance,
  Project,
  ProjectRuntimeProjection,
  ProjectExplainerEvent,
  ProjectExplainerRuntimeConfig,
  QueueSnapshot
} from "../types";
const AGENT_ROLES = ["main", "idea", "execution", "writing", "review"] as const;
import { AgentRoster, ProjectExplainerPanel, TraceView, WorkspacePage } from "./WorkspacePage";

const agentPrompts = {
  main: "你是 main Agent。",
  idea: "Built-in Idea prompt",
  execution: "Built-in Execution prompt",
  writing: "Built-in Writing prompt",
  review: "Built-in Review prompt"
};

const explainerHarnesses: HarnessCatalogEntry[] = [
  ["codex", "Codex", "responses"],
  ["dsh", "dsh", "chat-completions"],
  ["pi", "pi", "chat-completions"],
  ["claude-code", "Claude Code", "anthropic-messages"]
].map(([id, label, nativeProtocol]) => ({
  id: id as HarnessCatalogEntry["id"],
  label,
  adapterVersion: "1",
  nativeProtocol: nativeProtocol as HarnessCatalogEntry["nativeProtocol"],
  purposes: id === "claude-code" ? ["workflow", "explainer", "probe"] : ["workflow", "probe"],
  mode: "workflow",
  notes: `Embedded ${label}`,
  capabilities: {
    durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
    readOnlyExplainer: id === "claude-code", webSearch: true, skills: true, mcp: true
  },
  available: true
}));

const explainerGatewayA: GatewayRecord = {
  id: "gwy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Responses Gateway",
  url: "https://responses.example.test/v1",
  models: ["model-a"],
  defaultModel: "model-a",
  protocol: "responses",
  revision: 1,
  apiKeyConfigured: true,
  test: {
    status: "passed", protocol: "responses", model: "model-a", harness: "claude-code",
    nativeProtocol: "anthropic-messages", routeMode: "proxy",
    routeDirection: "anthropic-messages->responses", probeKind: "adapter-smoke",
    cacheKey: "claude-model-a", adapterVersion: "1", executableFingerprint: "fixture-claude",
    gatewayRevision: 1, routerCompatibilityVersion: "1"
  },
  tests: [
    {
      status: "passed", protocol: "responses", model: "model-a", harness: "claude-code",
      nativeProtocol: "anthropic-messages", routeMode: "proxy",
      routeDirection: "anthropic-messages->responses", probeKind: "route"
    },
    {
      status: "passed", protocol: "responses", model: "model-a", harness: "claude-code",
      nativeProtocol: "anthropic-messages", routeMode: "proxy",
      routeDirection: "anthropic-messages->responses", probeKind: "adapter-smoke",
      cacheKey: "claude-model-a", adapterVersion: "1", executableFingerprint: "fixture-claude",
      gatewayRevision: 1, routerCompatibilityVersion: "1"
    },
    {
      status: "passed", protocol: "responses", model: "model-a", harness: "codex",
      nativeProtocol: "responses", routeMode: "direct", probeKind: "route"
    },
    {
      status: "passed", protocol: "responses", model: "model-a", harness: "codex",
      nativeProtocol: "responses", routeMode: "direct", probeKind: "adapter-smoke",
      cacheKey: "codex-model-a", adapterVersion: "1", executableFingerprint: "fixture-codex",
      gatewayRevision: 1, routerCompatibilityVersion: "1"
    },
    {
      status: "passed",
      protocol: "responses",
      model: "model-a",
      harness: "pi",
      nativeProtocol: "chat-completions",
      routeMode: "proxy",
      routeDirection: "chat-completions->responses",
      probeKind: "route"
    },
    {
      status: "passed",
      protocol: "responses",
      model: "model-a",
      harness: "pi",
      nativeProtocol: "chat-completions",
      routeMode: "proxy",
      routeDirection: "chat-completions->responses",
      probeKind: "adapter-smoke",
      cacheKey: "pi-model-a",
      adapterVersion: "1",
      executableFingerprint: "fixture-pi",
      gatewayRevision: 1,
      routerCompatibilityVersion: "1"
    }
  ],
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z"
};

const explainerGatewayB: GatewayRecord = {
  ...explainerGatewayA,
  id: "gwy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  name: "Chat Gateway",
  url: "https://chat.example.test/v1",
  models: ["stale-model-b"],
  defaultModel: "stale-model-b",
  protocol: "chat-completions",
  test: { status: "passed", protocol: "chat-completions", model: "stale-model-b" },
  tests: [{ status: "passed", protocol: "chat-completions", model: "stale-model-b" }]
};

const initialExplainerConfig: ProjectExplainerRuntimeConfig = {
  schemaVersion: 2,
  harness: "claude-code",
  gatewayId: explainerGatewayA.id,
  nativeProtocol: "anthropic-messages",
  gatewayProtocol: "responses",
  model: "model-a",
  reasoningEffort: "high",
  revision: 1,
  updatedAt: "2026-09-12T00:00:00.000Z",
  available: true,
  routeMode: "proxy",
  routeDirection: "anthropic-messages->responses"
};

const eventStreamMock = vi.hoisted(() => ({
  events: [] as AgentEvent[],
  performance: undefined as InvocationPerformance | undefined,
  runtime: undefined as ProjectRuntimeProjection | undefined
}));

vi.mock("../api", async original => ({
  ...await original<typeof import("../api")>(),
  getArtifact: vi.fn(),
  getArtifactDirectory: vi.fn(),
  getArtifactPage: vi.fn(),
  getArtifactSummary: vi.fn(),
  getCatalog: vi.fn(),
  getAgentToolRecommendationCatalog: vi.fn(),
  getRecommendationExplainerConfig: vi.fn(),
  recommendAgentTools: vi.fn(),
  getArtifacts: vi.fn(),
  getProject: vi.fn(),
  getWorkflowAdjustmentPage: vi.fn(), getWorkflowAdjustmentDetail: vi.fn(), submitWorkflowAdjustment: vi.fn(), withdrawWorkflowAdjustment: vi.fn(),
  getProjectExplainerConfig: vi.fn(),
  getProjectExplainerHistory: vi.fn(),
  getQueue: vi.fn(),
  projectAction: vi.fn(),
  refreshGatewayModels: vi.fn(),
  createUserSkill: vi.fn(),
  addProjectUserInput: vi.fn(),
  respondToUserIntervention: vi.fn(),
  cancelProjectExplainer: vi.fn(),
  resetProjectExplainer: vi.fn(),
  streamProjectExplainerQuestion: vi.fn(),
  updateProjectExplainerConfig: vi.fn(),
  updateProjectAgentConfigs: vi.fn(),
  updateProjectCollaborationGroup: vi.fn()
}));

vi.mock("../useProjectEvents", () => ({
  useProjectEvents: () => ({
    events: eventStreamMock.events,
    timelineEvents: eventStreamMock.events,
    totalEvents: eventStreamMock.events.length,
    connection: "live",
    hasOlder: false,
    historyLoading: false,
    historyError: "",
    live: { projectId: "prj_workspace", streams: [], events: [], performance: eventStreamMock.performance,
      ...(eventStreamMock.runtime ? { runtime: eventStreamMock.runtime } : {}) },
    loadOlder: vi.fn(),
    reset: vi.fn()
  })
}));

const project: Project = {
  id: "prj_workspace",
  title: "队列可观测性研究",
  requirement: "验证角色级共享队列的公平性和可观测性。",
  status: "retrying",
  phase: "execution:retrying",
  queuedAgent: "execution",
  turn: 4,
  cycle: 2,
  queuePosition: 2,
  queueDepth: 4,
  agentProgress: {
    main: { state: "completed", runs: 2 },
    idea: { state: "completed", runs: 1 },
    execution: { state: "retrying", runs: 7, executions: 3, queuePosition: 2 },
    writing: { state: "waiting", runs: 0 },
    review: { state: "waiting", runs: 0 }
  },
  overallProgress: {
    percent: 48,
    label: "执行智能体等待重试",
    estimated: true,
    successfulCalls: 18
  },
  tokenUsage: {
    inputTokens: 6_380,
    cachedInputTokens: 200,
    outputTokens: 1_274,
    totalTokens: 7_654,
    invocations: 8,
    unknownRequests: 2,
    complete: false,
    updatedAt: "2026-07-31T03:10:00.000Z",
    byAgent: {
      idea: { inputTokens: 600, cachedInputTokens: 0, outputTokens: 200, totalTokens: 800, invocations: 1 },
      main: { inputTokens: 1_200, cachedInputTokens: 100, outputTokens: 350, totalTokens: 1_550, invocations: 2 },
      execution: { inputTokens: 4_000, cachedInputTokens: 100, outputTokens: 500, totalTokens: 4_500, invocations: 3 },
      writing: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 200, totalTokens: 700, invocations: 1 },
      review: { inputTokens: 80, cachedInputTokens: 0, outputTokens: 24, totalTokens: 104, invocations: 1 }
    }
  },
  mainCapabilities: {
    schemaVersion: 1,
    controlMode: "weak-branch",
    routeCandidates: ["writing", "finish"],
    canReconfigure: false,
    canComplete: false,
    canRequestUser: false
  },
  computeUsage: {
    source: "inspire",
    totalCardHours: 12.8,
    byAccelerator: [
      { type: "H100", cardHours: 10.5 },
      { type: "H200", cardHours: 2.3 }
    ],
    workloadCount: 4,
    activeWorkloadCount: 1,
    updatedAt: "2026-07-31T03:12:00.000Z"
  },
  agents: DEFAULT_AGENTS,
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION),
  artifacts: [{
    id: "art_verified",
    path: "results/verified.md",
    name: "verified.md",
    kind: "markdown",
    sha256: "a".repeat(64)
  }, {
    id: "art_legacy",
    path: "results/legacy.md",
    name: "legacy.md",
    kind: "markdown"
  }],
  updatedAt: "2026-07-31T03:00:00.000Z"
};

function collaborationProject(finalPullStatus: "open" | "merged"): Project {
  return {
    ...project,
    git: { enabled: true, status: "ready", provider: "github" },
    workflowRevision: 1,
    orchestration: {
      ...structuredClone(DEFAULT_AGENT_ORCHESTRATION),
      schemaVersion: 2,
      collaborations: [{
        id: "research_group",
        displayName: "证据协作组",
        memberAgentIds: ["idea", "execution"],
        renamePolicy: "editable"
      }],
      input: { source: "input", target: "research_group" },
      routes: {
        main: [
          { target: "research_group", kind: "weak" },
          { target: "writing", kind: "weak" },
          { target: "review", kind: "weak" }
        ],
        research_group: [{ target: "main", kind: "strong" }],
        writing: [{ target: "main", kind: "strong" }],
        review: [
          { target: "main", kind: "weak" },
          { target: "finish", kind: "weak" }
        ]
      },
      decisionPlans: {
        main: "Main dispatches work.",
        research_group: "Integrate group evidence.",
        writing: "Write the report.",
        review: "Review the report."
      }
    },
    nodeRuns: [{
      id: "node-research-group-1",
      node: {
        kind: "collaboration",
        nodeId: "research_group",
        groupId: "research_group"
      },
      workflowRevision: 1,
      activationRequestId: "activate-research-group-1",
      inputSnapshotRef: "project:prj_workspace:requirement",
      activatedByAgentId: "main",
      status: "completed"
    }],
    groupRuns: [{
      id: "group-run-research-1",
      nodeRunId: "node-research-group-1",
      memberSnapshot: ["idea", "execution"],
      leaderAgentId: "idea",
      coordinatorEpoch: 1,
      baseCommit: "a".repeat(40),
      groupBranch: "groups/group-run-research-1",
      integrationTarget: "main",
      finalPullRequestId: "pull-final-research-1",
      taskIds: [],
      status: "completed"
    }],
    pullRequests: [{
      id: "pull-final-research-1",
      providerNumber: 17,
      htmlUrl: "https://github.com/example/openfars/pull/17",
      head: "groups/group-run-research-1",
      base: "main",
      ownerExecutionId: "execution-final-research-1",
      status: finalPullStatus,
      ...(finalPullStatus === "merged" ? { mergeCommitSha: "f".repeat(40) } : {}),
      observedAt: "2026-07-31T03:00:00.000Z"
    }]
  };
}

const queue: QueueSnapshot = {
  main: { capacity: 10, activeProjectIds: [], queued: [] },
  idea: { capacity: 10, activeProjectIds: [], queued: [] },
  execution: {
    capacity: 10,
    activeProjectIds: ["prj_active"],
    queued: [
      {
        projectId: "prj_workspace",
        position: 2,
        enteredAt: "2026-07-31T03:00:00.000Z"
      }
    ]
  },
  writing: { capacity: 10, activeProjectIds: [], queued: [] },
  review: { capacity: 10, activeProjectIds: [], queued: [] }
};

function canonicalTraceFixture(harnessId: string): AgentEvent[] {
  const base = {
    type: "agent.trace",
    agent: "execution",
    ts: "2026-09-16T08:00:00.000Z"
  } as const;
  return [
    {
      ...base,
      seq: 1,
      message: "正在核对固定 sentinel 文件。",
      data: {
        canonicalEvent: {
          schemaVersion: 1,
          eventId: "event-summary",
          invocationId: "inv-canonical-ui",
          harnessId,
          kind: "assistant.message",
          message: "正在核对固定 sentinel 文件。"
        }
      }
    },
    {
      ...base,
      seq: 2,
      message: "Read",
      data: {
        canonicalEvent: {
          schemaVersion: 1,
          eventId: "event-tool-start",
          invocationId: "inv-canonical-ui",
          harnessId,
          kind: "tool.started",
          tool: {
            callId: "call-sentinel",
            name: "Read",
            status: "started",
            input: { path: "sentinel.txt" }
          }
        }
      }
    },
    {
      ...base,
      seq: 3,
      message: "Read",
      data: {
        canonicalEvent: {
          schemaVersion: 1,
          eventId: "event-tool-update",
          invocationId: "inv-canonical-ui",
          harnessId,
          kind: "tool.updated",
          tool: {
            callId: "call-sentinel",
            name: "Read",
            status: "updated"
          }
        }
      }
    },
    {
      ...base,
      seq: 4,
      message: "Read",
      data: {
        canonicalEvent: {
          schemaVersion: 1,
          eventId: "event-tool-complete",
          invocationId: "inv-canonical-ui",
          harnessId,
          kind: "tool.completed",
          tool: {
            callId: "call-sentinel",
            // Claude's official tool_result frame has no tool name, so its
            // canonical mapper emits the neutral placeholder.
            name: harnessId === "claude-code" ? "tool" : "Read",
            status: "completed",
            outputPreview: "OPENFARS_SMOKE_SENTINEL",
            truncated: true
          }
        }
      }
    },
    {
      ...base,
      seq: 5,
      message: "Protocol proxy forwarded request",
      data: {
        canonicalEvent: {
          schemaVersion: 1,
          eventId: "event-diagnostic",
          invocationId: "inv-canonical-ui",
          harnessId,
          kind: "diagnostic",
          diagnostic: {
            source: "proxy",
            level: "info",
            message: "Protocol proxy forwarded request"
          }
        }
      }
    },
    {
      ...base,
      seq: 6,
      message: "RAW_CANONICAL_REASONING_MUST_NOT_RENDER",
      data: {
        canonicalEvent: {
          schemaVersion: 1,
          eventId: "event-activity",
          invocationId: "inv-canonical-ui",
          harnessId,
          kind: "activity",
          message: "RAW_CANONICAL_REASONING_MUST_NOT_RENDER"
        }
      }
    },
    {
      ...base,
      seq: 7,
      message: "RAW_LEGACY_REASONING_MUST_NOT_RENDER",
      data: {
        invocationId: "inv-canonical-ui",
        kind: "message",
        itemType: "reasoning"
      }
    }
  ];
}

describe("Workspace task progress", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getWorkflowAdjustmentPage).mockReset(); vi.mocked(getWorkflowAdjustmentDetail).mockReset(); vi.mocked(submitWorkflowAdjustment).mockReset(); vi.mocked(withdrawWorkflowAdjustment).mockReset();
    eventStreamMock.events = [];
    eventStreamMock.performance = undefined;
    eventStreamMock.runtime = undefined;
    vi.mocked(getProject).mockReset().mockResolvedValue(project);
    vi.mocked(getArtifact).mockReset();
    vi.mocked(getArtifactDirectory).mockReset().mockResolvedValue({
      agent: "idea",
      directory: "",
      entries: [],
      offset: 0,
      limit: 50,
      total: 0,
      hasMore: false
    });
    vi.mocked(getArtifactSummary).mockReset().mockResolvedValue({
      groups: { idea: 0, main: 0, execution: 0, writing: 0, review: 0 },
      total: 0
    });
    vi.mocked(getArtifactPage).mockReset().mockResolvedValue({
      groups: { idea: 0, main: 0, execution: 0, writing: 0, review: 0 },
      total: 0,
      artifacts: [],
      offset: 0,
      limit: 100,
      hasMore: false
    });
    vi.mocked(getCatalog).mockReset().mockResolvedValue({
      skills: [],
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      gateways: [explainerGatewayA],
      harnesses: explainerHarnesses,
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getArtifacts).mockReset().mockResolvedValue([]);
    vi.mocked(getRecommendationExplainerConfig).mockReset().mockResolvedValue({
      fingerprint: "e".repeat(64), config: initialExplainerConfig
    });
    vi.mocked(getAgentToolRecommendationCatalog).mockReset().mockResolvedValue({ fingerprint: "c".repeat(64) });
    vi.mocked(recommendAgentTools).mockReset().mockImplementation(async input => ({
      targetAgent: input.targetAgent, contextFingerprint: input.contextFingerprint,
      configurationFingerprint: input.configurationFingerprint, catalogFingerprint: input.catalogFingerprint,
      selection: { skills: [], autoSkills: [], mcpServers: [], experimentMcp: false },
      reasons: ["当前任务不需要额外业务工具。"], warnings: []
    }));
    vi.mocked(getProjectExplainerHistory).mockReset().mockResolvedValue({
      events: [],
      active: false
    });
    vi.mocked(getProjectExplainerConfig).mockReset().mockResolvedValue({
      schemaVersion: 2,
      harness: "claude-code",
      gatewayId: explainerGatewayA.id,
      nativeProtocol: "anthropic-messages",
      gatewayProtocol: "responses",
      model: "nex-agi/Nex-N2-Pro",
      reasoningEffort: "high",
      revision: 0,
      updatedAt: "2026-09-10T00:00:00.000Z",
      available: true,
      routeMode: "proxy",
      routeDirection: "anthropic-messages->responses"
    });
    vi.mocked(streamProjectExplainerQuestion).mockReset().mockResolvedValue();
    vi.mocked(updateProjectExplainerConfig).mockReset();
    vi.mocked(cancelProjectExplainer).mockReset().mockResolvedValue();
    vi.mocked(resetProjectExplainer).mockReset().mockResolvedValue();
    vi.mocked(getQueue).mockReset().mockResolvedValue(queue);
    vi.mocked(projectAction).mockReset().mockResolvedValue(undefined);
    vi.mocked(refreshGatewayModels).mockReset();
    vi.mocked(createUserSkill).mockReset();
    vi.mocked(addProjectUserInput).mockReset();
    vi.mocked(respondToUserIntervention).mockReset();
    vi.mocked(updateProjectAgentConfigs).mockReset();
    vi.mocked(updateProjectCollaborationGroup).mockReset();
  });

  it("coalesces slow artifact refreshes and skips overlapping queue polls", async () => {
    let finishSummary!: (value: Awaited<ReturnType<typeof getArtifactSummary>>) => void;
    let finishQueue!: (value: QueueSnapshot) => void;
    vi.mocked(getArtifactSummary).mockImplementation(() => new Promise(resolve => { finishSummary = resolve; }));
    vi.mocked(getQueue).mockImplementation(() => new Promise(resolve => { finishQueue = resolve; }));
    vi.useFakeTimers();
    const view = render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    try {
      await act(async () => undefined);
      await act(async () => { fireEvent.click(screen.getByRole("tab", { name: /研究产物/ })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(getArtifactSummary).toHaveBeenCalledTimes(1);
      expect(getQueue).toHaveBeenCalledTimes(1);
      view.unmount();
      await act(async () => { finishSummary({ groups: {}, total: 0 }); finishQueue(queue); });
      expect(getArtifactSummary).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("renders complete scoped group details from authoritative recursive execution facts", () => {
    const scoped = structuredClone(project);
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    upgradeLegacyGroups(orchestration);
    orchestration.agents.push({ name: "analysis", template: "execution" }, { name: "packaging", template: "writing" });
    scoped.agents = {
      ...structuredClone(DEFAULT_AGENTS),
      analysis: structuredClone(DEFAULT_AGENTS.execution),
      packaging: structuredClone(DEFAULT_AGENTS.writing)
    };
    addScopedGroup(orchestration, {
      id: "research", displayName: "Research", leaderAgentId: "main",
      memberAgentIds: ["idea", "execution", "writing", "review", "analysis", "packaging"]
    });
    addScopedGroup(orchestration, {
      id: "inner", displayName: "Inner Review", parentGroupId: "research", leaderAgentId: "main",
      memberAgentIds: ["idea", "execution"]
    });
    addScopedGroup(orchestration, {
      id: "audit", displayName: "Audit", leaderAgentId: "main", memberAgentIds: ["idea", "review"]
    });
    scoped.orchestration = orchestration;
    scoped.scopedGroupRuns = [
      { id: "research-old", projectId: scoped.id, groupId: "research", activationRequestId: "activate-old", workflowRevision: 1, leaderAgentId: "main", baseCommit: "a", groupBranch: "groups/research-old", integrationTarget: "main", status: "completed" },
      { id: "research-current", projectId: scoped.id, groupId: "research", activationRequestId: "activate-current", workflowRevision: 2, leaderAgentId: "main", baseCommit: "b", groupBranch: "groups/research-current", integrationTarget: "main", status: "running" },
      { id: "inner-current", projectId: scoped.id, groupId: "inner", parentGroupRunId: "research-current", parentArrivalRequestId: "inner-arrival", activationRequestId: "activate-inner", workflowRevision: 1, leaderAgentId: "main", baseCommit: "c", groupBranch: "groups/inner-current", integrationTarget: "groups/research-current", status: "completed" },
      { id: "audit-current", projectId: scoped.id, groupId: "audit", activationRequestId: "activate-audit", workflowRevision: 1, leaderAgentId: "main", baseCommit: "d", groupBranch: "groups/audit-current", integrationTarget: "main", status: "completed" }
    ];
    scoped.scopedExecutions = [
      { id: "exec-idea-old", projectId: scoped.id, groupRunId: "research-old", arrivalRequestId: "idea-old", agentId: "idea", ownershipEpoch: 1, executionBranch: "executions/idea-old", worktreePath: "/tmp/idea-old", status: "completed" },
      // A replayed durable fact must not increase the displayed count.
      { id: "exec-idea-old", projectId: scoped.id, groupRunId: "research-old", arrivalRequestId: "idea-old-replay", agentId: "idea", ownershipEpoch: 1, executionBranch: "executions/idea-old", worktreePath: "/tmp/idea-old", status: "completed" },
      { id: "exec-idea-current", projectId: scoped.id, groupRunId: "research-current", arrivalRequestId: "idea-current", agentId: "idea", ownershipEpoch: 2, executionBranch: "executions/idea-current", worktreePath: "/tmp/idea-current", status: "running" },
      { id: "exec-review-current", projectId: scoped.id, groupRunId: "research-current", arrivalRequestId: "review-current", agentId: "review", ownershipEpoch: 1, executionBranch: "executions/review-current", worktreePath: "/tmp/review-current", status: "failed" },
      { id: "exec-inner", projectId: scoped.id, groupRunId: "inner-current", arrivalRequestId: "inner-execution", agentId: "execution", ownershipEpoch: 1, executionBranch: "executions/inner", worktreePath: "/tmp/execution-inner", status: "completed" },
      { id: "exec-audit-idea", projectId: scoped.id, groupRunId: "audit-current", arrivalRequestId: "audit-idea", agentId: "idea", ownershipEpoch: 1, executionBranch: "executions/audit-idea", worktreePath: "/tmp/audit-idea", status: "completed" }
    ];
    render(<AgentRoster project={scoped} events={[]} onEditModels={vi.fn()} onEditGroups={vi.fn()} />);

    const research = document.querySelector<HTMLElement>('[data-roster-group="research"]')!;
    expect(research).toHaveTextContent("7 个成员 · 共执行 3 次");
    expect(research.querySelector('[data-member-agent="idea"]')).toHaveTextContent("执行 2 次 · 运行中");
    expect(research.querySelector('[data-member-agent="review"]')).toHaveTextContent("执行 1 次 · 故障");
    expect(research.querySelector('[data-member-agent="analysis"]')).toBeInTheDocument();
    expect(research.querySelector('[data-member-agent="packaging"]')).toBeInTheDocument();
    const inner = research.querySelector<HTMLElement>('[data-roster-group="inner"]');
    expect(inner).toHaveTextContent("execution");

    const audit = document.querySelector<HTMLElement>('[data-roster-group="audit"]')!;
    expect(audit.querySelector('[data-member-agent="idea"]')).toHaveTextContent("执行 1 次 · 已完成");
    expect(audit.querySelector('[data-member-agent="review"]')).toHaveTextContent("执行 0 次 · 等待执行");
  });

  it("keeps average speed and the latest TTFT visible between requests and across Agent changes", async () => {
    const measured: InvocationPerformance = { invocationId: "inv-first", agent: "idea", attempt: 0, status: "completed",
      startedAt: "2026-10-09T00:00:00Z", firstTokenAt: "2026-10-09T00:00:01Z", completedAt: "2026-10-09T00:00:03Z",
      firstTokenLatencyMs: 420, averageTokensPerSecond: 12, outputTokens: 24, tokenSource: "official", streaming: true };
    const fixture: Project = { ...project, status: "running", currentAgent: "main", performance: {
      latest: measured, history: [measured], byAgent: { idea: measured }, aggregate: {
        invocations: 2, outputTokens: 60, outputDurationMs: 4000, firstTokenSamples: 2,
        totalFirstTokenLatencyMs: 1998, averageFirstTokenLatencyMs: 999, averageTokensPerSecond: 15,
        tokenSource: "official", updatedAt: measured.completedAt!
      }
    } };
    vi.mocked(getProject).mockResolvedValue(fixture);
    const view = render(<WorkspacePage projectId={fixture.id} onBack={vi.fn()} />);
    await screen.findByRole("region", { name: "当前输出性能" });
    const value = (label: string) => within(screen.getByRole("region", { name: "当前输出性能" }))
      .getByText(label).parentElement!.querySelector("strong")!.textContent;
    expect(value("平均速度")).toBe("15.0 tok/s");
    expect(value("首 Token 延迟")).toBe("420 ms");
    expect(value("当前速度")).toBe("—");
    eventStreamMock.performance = { invocationId: "inv-worker", agent: "execution", attempt: 0,
      status: "active", requestActive: true, startedAt: "2026-10-09T00:00:05Z", currentTokensPerSecond: 8,
      outputTokens: 2, tokenSource: "estimated", streaming: true };
    view.rerender(<WorkspacePage projectId={fixture.id} onBack={vi.fn()} />);
    expect(value("当前速度")).toBe("≈8.0 tok/s");
    expect(value("平均速度")).toBe("15.0 tok/s");
    expect(value("首 Token 延迟")).toBe("420 ms");
    eventStreamMock.performance = { ...eventStreamMock.performance, requestActive: false,
      firstTokenAt: "2026-10-09T00:00:06Z", firstTokenLatencyMs: 250 };
    view.rerender(<WorkspacePage projectId={fixture.id} onBack={vi.fn()} />);
    expect(value("当前速度")).toBe("—");
    expect(value("首 Token 延迟")).toBe("250 ms");
    eventStreamMock.performance = undefined;
    view.rerender(<WorkspacePage projectId={fixture.id} onBack={vi.fn()} />);
    expect(value("平均速度")).toBe("15.0 tok/s");
    expect(value("首 Token 延迟")).toBe("250 ms");
    expect(value("当前速度")).toBe("—");
    const nextProject = { ...fixture, id: "prj_second", title: "新项目", performance: undefined };
    vi.mocked(getProject).mockResolvedValue(nextProject);
    eventStreamMock.performance = { ...measured, status: "active", currentTokensPerSecond: 8 };
    view.rerender(<WorkspacePage projectId={nextProject.id} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: nextProject.title });
    expect(value("平均速度")).toBe("—");
    expect(value("首 Token 延迟")).toBe("—");
    expect(value("当前速度")).toBe("—");
  });

  it("keeps nested member badges, the compact workflow and its expanded canvas consistent through live pause", async () => {
    const fixture = runtimeProjectFixture();
    vi.mocked(getProject).mockResolvedValue(fixture);
    const view = render(<WorkspacePage projectId={fixture.id} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: fixture.title });
    const roster = view.container.querySelector(".agent-roster")!;
    expect(roster.querySelectorAll("[data-member-agent].member-running")).toHaveLength(2);
    expect(roster).toHaveTextContent("Inner");
    expect(roster).toHaveTextContent("执行 1 次 · 运行中");
    fireEvent.click(screen.getByRole("button", { name: "打开大型运行 Workflow 画布" }));
    const frame = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(send.mock.calls.at(-1)?.[0].snapshot.nodeStates.research).toBe("running");

    eventStreamMock.runtime = { ...fixture.runtime!, stateRevision: 13, status: "paused", activities: [] };
    view.rerender(<WorkspacePage projectId={fixture.id} onBack={vi.fn()} />);
    await waitFor(() => expect(roster.querySelectorAll("[data-member-agent].member-paused")).toHaveLength(2));
    expect(send.mock.calls.at(-1)?.[0].snapshot.nodeStates.research).toBe("paused");
    expect(view.container.querySelector('[data-runtime-surface-mode="preview"] [data-runtime-state="paused"]')).not.toBeNull();
    expect(roster.querySelectorAll("[data-member-agent].member-running")).toHaveLength(0);
  });

  it("uses the same recovery label and reason in the workspace header and workflow rail", async () => {
    const reason = "等待恢复：opportunity 的 Git 操作结果待确认";
    const waiting: Project = { ...project, status: "queued", currentAgent: undefined, queuedAgent: undefined,
      runtime: { stateRevision: 3, status: "queued", phase: "collaboration:scoped-recovery-waiting", executionCount: 2, activities: [],
        waiting: { kind: "recovery", reason, agentId: "opportunity", executionId: "exec-a", operationId: "original-push" } } };
    vi.mocked(getProject).mockResolvedValue(waiting);
    render(<WorkspacePage projectId={waiting.id} onBack={vi.fn()} />);
    expect(await screen.findAllByText("等待恢复")).not.toHaveLength(0);
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    expect(document.querySelector(".workflow-rail-status")).toHaveTextContent("等待恢复");
  });

  it("shows task id, overall progress and authoritative per-agent progress", async () => {
    vi.mocked(getProject).mockResolvedValue({
      ...project,
      orchestration: {
        ...structuredClone(DEFAULT_AGENT_ORCHESTRATION),
        loops: [{ id: "review-cycle", from: "review", to: "writing", exitTo: "main", maxIterations: 3 }]
      },
      loopIterations: { "review-cycle": 1 },
      loopBatches: { "review-cycle": 2 },
      loopTotalIterations: { "review-cycle": 4 }
    });
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: project.title })).toBeInTheDocument();
    expect(screen.getAllByText(project.id).length).toBeGreaterThan(0);
    expect(screen.getAllByText("执行智能体等待重试").length).toBeGreaterThan(0);
    expect(screen.getAllByText("流程进度 48%").length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent("里程碑");
    expect(
      screen.getAllByText("nex-agi/Nex-N2-Pro · 网关思考强度 Provider 默认").length
    ).toBeGreaterThan(0);
    expect(document.body).toHaveTextContent("3 次执行");
    expect(document.body).toHaveTextContent("已执行 3 次");
    expect(document.body).not.toHaveTextContent("7 次执行");
    expect(screen.getAllByText("队列 #2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Turn 4").length).toBeGreaterThan(0);
    const tokenUsage = screen.getByRole("region", {
      name: "项目 Token 消耗"
    });
    expect(tokenUsage).toHaveTextContent("7,654");
    expect(tokenUsage).toHaveTextContent("项目累计 tokens");
    expect(tokenUsage).toHaveTextContent("仅展示项目累计用量");
    expect(tokenUsage).not.toHaveTextContent("输入 4,000");
    const integrity = screen.getByRole("region", { name: "运行合同与完整性" });
    expect(integrity).toHaveTextContent("weak-branch · 受限分支");
    expect(integrity).toHaveTextContent("review-cycle: B2 · 1/3 · Σ4");
    expect(integrity).toHaveTextContent("2 个 Provider 请求 usage 未知");
    expect(integrity).toHaveTextContent("1 项旧 Artifact 未绑定 SHA-256");
    expect(getQueue).toHaveBeenCalled();
  });

  it("shows the exact Artifact integrity failure reported by the server", async () => {
    vi.mocked(getProject).mockResolvedValue({
      ...project,
      displayError: "Published artifact content changed after publication: art_verified"
    });
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const integrity = await screen.findByRole("region", { name: "运行合同与完整性" });
    expect(integrity).toHaveTextContent(
      "Published artifact content changed after publication: art_verified"
    );
  });

  it("shows timeout cancellation and an explicitly unverified recovery manifest", async () => {
    const checkpointId = `chk_${"a".repeat(32)}`;
    vi.mocked(getProject).mockResolvedValue({
      ...project, status: "cancelled", phase: "cancelled", cancelledBy: "deadline-monitor", cancelReason: "arm_timeout",
      cancellationSettledAt: "2026-09-22T00:00:00Z",
      overallProgress: { ...project.overallProgress, label: "运行超时，任务已取消" },
      workspaceCheckpoints: [{ id: checkpointId, agent: "execution", createdAt: "2026-09-22T00:00:00Z", fileCount: 6, incomplete: false, status: "unverified_partial_output" }]
    });
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    expect(await screen.findByText("可恢复工作区文件（未验收）")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /6 个文件/ })).toHaveAttribute("href", `/api/projects/${project.id}/checkpoints/${checkpointId}`);
    expect(screen.getByText(/取消已收尾/)).toHaveTextContent("运行超时");
    expect(screen.getByText(/这些文件不代表正式交付/)).toBeInTheDocument();
  });

  it("keeps a retired Agent selectable and filters its original trace without restoring it to the workflow", async () => {
    const archived = { agentId: "retired_researcher", harnesses: ["codex"], workflowRevision: 3, sessionCount: 1 };
    const history = [{ seq: 1, type: "agent.output", agent: archived.agentId, message: "Retained original researcher result", ts: "2026-10-11T00:00:00Z" },
      { seq: 2, type: "agent.output", agent: "main", message: "Current Main result", ts: "2026-10-11T00:00:01Z" }];
    render(<TraceView events={history} liveStreams={[]} liveEvents={[]} project={{ ...project, archivedAgentSessions: [archived, { ...archived, workflowRevision: 4 }] }}
      connection="offline" totalEventCount={2} hasOlder={false} historyLoading={false} historyError="" onLoadOlder={async () => undefined} />);
    const filter = screen.getByLabelText("按智能体筛选");
    expect(within(filter).getAllByRole("option", { name: /retired_researcher.*已退役/ })).toHaveLength(1);
    await userEvent.setup().selectOptions(filter, archived.agentId);
    expect(screen.getByText("Retained original researcher result")).toBeVisible();
    expect(screen.queryByText("Current Main result")).not.toBeInTheDocument();
    expect(project.orchestration.agents.some(agent => agent.name === archived.agentId)).toBe(false);
  });

  it("keeps retired nonpersistent Agent history without claiming that a Session exists", () => {
    render(<TraceView events={[]} liveStreams={[]} liveEvents={[]} project={{ ...project, archivedAgentSessions: [{ agentId: "retired_nonpersistent", harnesses: ["codex"], workflowRevision: 3, sessionCount: 0 }] }}
      connection="offline" totalEventCount={0} hasOlder={false} historyLoading={false} historyError="" onLoadOlder={async () => undefined} />);
    expect(within(screen.getByLabelText("按智能体筛选")).getByRole("option", { name: "retired_nonpersistent · 已退役" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /retired_nonpersistent.*原会话保留/ })).not.toBeInTheDocument();
  });

  it("keeps one active trace filter when an archived Agent is explicitly reintroduced", () => {
    const agentId = project.orchestration.agents[0].name;
    render(<TraceView events={[]} liveStreams={[]} liveEvents={[]} project={{ ...project, archivedAgentSessions: [{ agentId, harnesses: ["codex"], workflowRevision: 3, sessionCount: 1 }] }}
      connection="offline" totalEventCount={0} hasOlder={false} historyLoading={false} historyError="" onLoadOlder={async () => undefined} />);
    const options = within(screen.getByLabelText("按智能体筛选")).getAllByRole("option") as HTMLOptionElement[];
    expect(options.filter(option => option.value === agentId)).toHaveLength(1);
    expect(options.find(option => option.value === agentId)!.textContent).not.toContain("已退役");
  });

  it.each(["codex", "dsh", "pi", "claude-code"])("restores resident %s history bodies and tool details without live snapshots", harness => {
    const events = canonicalTraceFixture(harness).map(event => event.data?.canonicalEvent
      ? normalizeEvent({ ...event, message: "Resident Harness event", data: { resident: true, event: event.data.canonicalEvent } })!
      : event);
    const view = render(<TraceView events={events} liveStreams={[]} liveEvents={[]} project={project}
      connection="offline" totalEventCount={events.length} hasOlder={false} historyLoading={false} historyError="" onLoadOlder={async () => undefined} />);
    expect(screen.getByText("正在核对固定 sentinel 文件。")).toBeVisible();
    fireEvent.click(screen.getByText("查看工具结果"));
    expect(screen.getByText("OPENFARS_SMOKE_SENTINEL")).toBeVisible();
    expect(view.container.querySelectorAll(".agent-tool-item")).toHaveLength(1);
    expect(view.container.querySelector(".trace-list")).not.toHaveTextContent("Resident Harness event");
    expect(view.container.querySelector(".trace-list")).not.toHaveTextContent("RAW_CANONICAL_REASONING_MUST_NOT_RENDER");
  });

  it("keeps an expanded live tool result open when durable history replaces it", () => {
    const tools = canonicalTraceFixture("codex").filter(event =>
      String((event.data?.canonicalEvent as Record<string, unknown> | undefined)?.kind).startsWith("tool."));
    const props = { project, connection: "live" as const, totalEventCount: tools.length, hasOlder: false,
      historyLoading: false, historyError: "", onLoadOlder: async () => undefined, liveStreams: [] };
    const view = render(<TraceView {...props} events={[]} liveEvents={tools.map(event => ({ ...event, seq: 8_000_000_000 + event.seq }))} />);
    fireEvent.click(screen.getByText("查看工具结果"));
    const details = screen.getByText("OPENFARS_SMOKE_SENTINEL").closest("details");
    expect(details).toHaveAttribute("open");
    view.rerender(<TraceView {...props} events={tools} liveEvents={[]} />);
    expect(screen.getByText("OPENFARS_SMOKE_SENTINEL").closest("details")).toBe(details);
    expect(details).toHaveAttribute("open");
  });

  it("renders tool details that arrive as an update to an existing event sequence", () => {
    const [start, , complete] = canonicalTraceFixture("codex").filter(event =>
      String((event.data?.canonicalEvent as Record<string, unknown> | undefined)?.kind).startsWith("tool."));
    const canonical = complete!.data!.canonicalEvent as Record<string, unknown> & { tool: Record<string, unknown> };
    const { outputPreview: _output, ...tool } = canonical.tool;
    const pendingResult = { ...complete!, data: { canonicalEvent: { ...canonical, tool } } };
    const props = { project, connection: "live" as const, totalEventCount: 2, hasOlder: false,
      historyLoading: false, historyError: "", onLoadOlder: async () => undefined, liveStreams: [], liveEvents: [] };
    const view = render(<TraceView {...props} events={[start!, pendingResult]} />);
    expect(screen.queryByText("查看工具结果")).not.toBeInTheDocument();
    view.rerender(<TraceView {...props} events={[start!, complete!]} />);
    fireEvent.click(screen.getByText("查看工具结果"));
    expect(screen.getByText("OPENFARS_SMOKE_SENTINEL")).toBeVisible();
  });

  it("renders one canonical trace DOM for every Harness and collapses results and diagnostics", () => {
    const structures: string[] = [];
    for (const harnessId of ["codex", "dsh", "pi", "claude-code"]) {
      const events = canonicalTraceFixture(harnessId);
      const view = render(
        <TraceView
          events={events}
          liveStreams={[]}
          liveEvents={[]}
          project={project}
          connection="offline"
          totalEventCount={events.length}
          hasOlder={false}
          historyLoading={false}
          historyError=""
          onLoadOlder={async () => undefined}
        />
      );
      const trace = view.container.querySelector<HTMLElement>(".trace-list");
      expect(trace).not.toBeNull();
      expect(trace?.querySelectorAll(".agent-tool-item")).toHaveLength(1);
      expect(trace?.querySelector(".agent-tool-item strong")).toHaveTextContent("Read");
      expect(trace?.querySelector(".agent-thought-panel")).toHaveTextContent("Agent 过程摘要");
      expect(trace?.querySelector(".agent-tool-result")).not.toHaveAttribute("open");
      expect(trace?.querySelector(".agent-tool-result")).toHaveTextContent("OPENFARS_SMOKE_SENTINEL");
      expect(trace?.querySelector(".agent-tool-result")).toHaveTextContent("已截断至 40,000 字符");
      expect(trace?.querySelector(".trace-diagnostics")).not.toHaveAttribute("open");
      expect(trace?.querySelector(".trace-diagnostics")).toHaveTextContent("运行诊断");
      expect(trace).not.toHaveTextContent("RAW_CANONICAL_REASONING_MUST_NOT_RENDER");
      expect(trace).not.toHaveTextContent("RAW_LEGACY_REASONING_MUST_NOT_RENDER");

      const normalized = trace!.cloneNode(true) as HTMLElement;
      const harnessTag = normalized.querySelector(".trace-harness-tag");
      expect(harnessTag).toHaveTextContent(harnessId);
      if (harnessTag) harnessTag.textContent = "<harness>";
      structures.push(normalized.innerHTML);
      view.unmount();
    }
    expect(new Set(structures).size).toBe(1);
  });

  it("replaces a live delta in place with one durable final message", () => {
    const view = render(
      <TraceView
        events={[]}
        liveStreams={[{
          projectId: project.id,
          invocationId: "inv_live_final",
          agent: "execution",
          harnessId: "fixture",
          attempt: 0,
          itemId: "assistant-0-0",
          content: "**尚未闭合",
          phase: "streaming",
          role: "active",
          updatedAt: "2026-09-19T00:00:00.000Z"
        }]}
        liveEvents={[]}
        project={project}
        connection="live"
        totalEventCount={0}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );
    expect(view.getByText("Agent 正在输出")).toBeVisible();
    expect(view.container.querySelector(".agent-streaming-text")).toHaveTextContent("**尚未闭合");
    expect(view.container.querySelector(".agent-streaming-text strong")).toBeNull();

    view.rerender(
      <TraceView
        events={[]}
        liveStreams={[{
          projectId: project.id,
          invocationId: "inv_live_final",
          agent: "execution",
          harnessId: "fixture",
          attempt: 0,
          itemId: "assistant-0-0",
          content: "**尚未闭合",
          phase: "streaming",
          role: "process",
          updatedAt: "2026-09-19T00:00:00.500Z"
        }]}
        liveEvents={[{
          seq: 8_000_000_001,
          type: "agent.trace",
          agent: "execution",
          message: "read",
          ts: "2026-09-19T00:00:00.500Z",
          data: {
            invocationId: "inv_live_final",
            liveEphemeral: true,
            canonicalEvent: {
              schemaVersion: 1,
              eventId: "live-tool",
              invocationId: "inv_live_final",
              harnessId: "fixture",
              kind: "tool.started",
              phase: "started",
              attempt: 0,
              parentItemId: "assistant-0-0",
              tool: { callId: "call-live", name: "read", status: "started" }
            }
          }
        }]}
        project={project}
        connection="live"
        totalEventCount={0}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );
    expect(view.getByText("Agent 过程摘要")).toBeVisible();
    expect(view.container.querySelectorAll(".agent-tool-item")).toHaveLength(1);

    const completeMessage: AgentEvent = {
      seq: 10,
      type: "agent.trace",
      agent: "execution",
      message: "**完整结果**",
      ts: "2026-09-19T00:00:01.000Z",
      data: {
        invocationId: "inv_live_final",
        canonicalEvent: {
          schemaVersion: 1,
          eventId: "terminal-message",
          invocationId: "inv_live_final",
          harnessId: "fixture",
          kind: "assistant.message",
          phase: "completed",
          attempt: 0,
          itemId: "assistant-0-0",
          message: "**完整结果**"
        }
      }
    };
    view.rerender(
      <TraceView
        events={[completeMessage, {
          seq: 11,
          type: "invocation.completed",
          agent: "execution",
          message: "completed",
          ts: "2026-09-19T00:00:02.000Z",
          data: { invocationId: "inv_live_final" }
        }]}
        liveStreams={[{
          projectId: project.id,
          invocationId: "inv_live_final",
          agent: "execution",
          harnessId: "fixture",
          attempt: 0,
          itemId: "assistant-0-0",
          content: "**完整结果**",
          phase: "complete",
          role: "final",
          updatedAt: "2026-09-19T00:00:02.000Z"
        }]}
        liveEvents={[]}
        project={project}
        connection="live"
        totalEventCount={2}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );

    expect(view.getByText("Agent 最终结果")).toBeVisible();
    expect(view.getAllByText("完整结果")).toHaveLength(1);
    expect(view.container.querySelectorAll(".agent-thought-panel")).toHaveLength(1);
    expect(view.container.querySelector(".agent-message-markdown strong")).toHaveTextContent("完整结果");
  });

  it("keeps the trace pinned through live event updates and exposes the follow control", async () => {
    const stream = {
      projectId: project.id,
      invocationId: "inv_follow",
      agent: "execution" as const,
      harnessId: "fixture",
      attempt: 0,
      itemId: "assistant-follow",
      content: "正在输出",
      phase: "streaming" as const,
      role: "active" as const,
      updatedAt: "2026-09-19T00:00:00.000Z"
    };
    const view = render(
      <TraceView
        events={[]}
        liveStreams={[stream]}
        liveEvents={[]}
        project={project}
        connection="live"
        totalEventCount={0}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );
    const scroll = view.container.querySelector<HTMLElement>(".trace-scroll");
    expect(scroll).not.toBeNull();
    const followButton = screen.getByRole("button", { name: "跟随" });
    expect(followButton).toBeVisible();
    expect(followButton).toHaveAttribute("aria-pressed", "true");

    let scrollTop = 0;
    let scrollHeight = 1_200;
    Object.defineProperties(scroll!, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
          // Browsers emit this event for programmatic scrolling as well. The
          // component must ignore it while its own settling loop is active.
          fireEvent.scroll(scroll!);
        }
      }
    });

    await waitFor(() => expect(scrollTop).toBe(800));
    expect(followButton).toHaveClass("active");
    // The pin uses a few settling frames so streamed Markdown can finish
    // measuring before the next user scroll is evaluated.
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    // A real user scroll disables follow mode.
    fireEvent.wheel(scroll!, { deltaY: -600 });
    scrollTop = 200;
    fireEvent.scroll(scroll!);
    expect(followButton).not.toHaveClass("active");
    expect(followButton).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(followButton);
    await waitFor(() => expect(followButton).toHaveClass("active"));
    await waitFor(() => expect(scrollTop).toBe(800));

    // A tool event can arrive without changing the assistant stream. It still
    // changes the rendered trace and must trigger another bottom pin.
    scrollHeight = 1_600;
    view.rerender(
      <TraceView
        events={[]}
        liveStreams={[stream]}
        liveEvents={[{
          seq: 8_000_000_001,
          type: "agent.trace",
          agent: "execution",
          message: "read",
          ts: "2026-09-19T00:00:01.000Z",
          data: { liveEphemeral: true }
        }]}
        project={project}
        connection="live"
        totalEventCount={0}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );
    await waitFor(() => expect(scrollTop).toBe(1_200));
  });

  it("keeps pre-tool and post-tool Assistant segments separate", () => {
    const base = {
      type: "agent.trace",
      agent: "execution" as const,
      ts: "2026-09-19T00:00:00.000Z"
    };
    const canonical = (eventId: string, kind: string, itemId: string, extra: Record<string, unknown>) => ({
      schemaVersion: 1,
      eventId,
      invocationId: "inv_segments",
      harnessId: "fixture",
      kind,
      attempt: 0,
      itemId,
      ...extra
    });
    const events: AgentEvent[] = [{
      ...base,
      seq: 1,
      message: "先读取数据。",
      data: { canonicalEvent: canonical("m1", "assistant.message", "assistant-0-0", {
        phase: "completed", message: "先读取数据。"
      }) }
    }, {
      ...base,
      seq: 2,
      message: "read",
      data: { canonicalEvent: canonical("t1", "tool.started", "tool-event", {
        phase: "started",
        parentItemId: "assistant-0-0",
        tool: { callId: "call-1", name: "read", status: "started" }
      }) }
    }, {
      ...base,
      seq: 3,
      message: "read",
      data: { canonicalEvent: canonical("t2", "tool.completed", "tool-event", {
        phase: "completed",
        parentItemId: "assistant-0-0",
        tool: { callId: "call-1", name: "read", status: "completed", outputPreview: "ok" }
      }) }
    }, {
      ...base,
      seq: 4,
      message: "读取完成。",
      data: { canonicalEvent: canonical("m2", "assistant.message", "assistant-0-1", {
        phase: "completed", message: "读取完成。"
      }) }
    }, {
      ...base,
      seq: 5,
      type: "invocation.completed",
      message: "completed",
      data: { invocationId: "inv_segments" }
    }];
    const view = render(
      <TraceView
        events={events}
        liveStreams={[]}
        liveEvents={[]}
        project={project}
        connection="offline"
        totalEventCount={events.length}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );

    const panels = view.container.querySelectorAll(".agent-thought-panel");
    expect(panels).toHaveLength(2);
    expect(panels[0]).toHaveTextContent("Agent 过程摘要");
    expect(panels[0]).toHaveTextContent("先读取数据。");
    expect(panels[1]).toHaveTextContent("Agent 最终结果");
    expect(panels[1]).toHaveTextContent("读取完成。");
    expect(view.container.querySelectorAll(".agent-tool-item")).toHaveLength(1);
  });

  it("shows per-invocation token speed provenance without inventing a buffered current rate", () => {
    const events: AgentEvent[] = [{
      seq: 1,
      type: "invocation.completed",
      agent: "writing",
      message: "writing invocation committed",
      ts: "2026-09-19T00:00:03.000Z",
      data: {
        invocationId: "inv_perf",
        performance: {
          invocationId: "inv_perf",
          agent: "writing",
          attempt: 0,
          status: "completed",
          startedAt: "2026-09-19T00:00:01.000Z",
          completedAt: "2026-09-19T00:00:03.000Z",
          averageTokensPerSecond: 10,
          outputDurationMs: 2_000,
          outputTokens: 20,
          tokenSource: "official",
          streaming: false
        }
      }
    }];
    render(
      <TraceView
        events={events}
        liveStreams={[]}
        liveEvents={[]}
        project={project}
        connection="offline"
        totalEventCount={1}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );

    const metrics = screen.getByLabelText("单次调用性能");
    expect(metrics).toHaveTextContent("10.0 tok/s");
    expect(metrics).toHaveTextContent("Provider usage");
    expect(metrics).toHaveTextContent("缓冲/非流式");
    expect(metrics).not.toHaveTextContent("当前 10.0 tok/s");
  });

  it("renders an explicit empty result when a canonical tool completed with an empty preview", () => {
    const events = canonicalTraceFixture("claude-code").map((event) =>
      event.seq === 4
        ? {
            ...event,
            data: {
              ...event.data,
              canonicalEvent: {
                ...(event.data?.canonicalEvent as Record<string, unknown>),
                tool: {
                  ...((event.data?.canonicalEvent as { tool?: Record<string, unknown> })?.tool ?? {}),
                  outputPreview: "",
                  truncated: false
                }
              }
            }
          }
        : event
    );

    const view = render(
      <TraceView
        events={events}
        liveStreams={[]}
        liveEvents={[]}
        project={project}
        connection="offline"
        totalEventCount={events.length}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );

    const result = view.container.querySelector(".agent-tool-result");
    expect(result).not.toHaveAttribute("open");
    expect(result).toHaveTextContent("（空结果）");
  });

  it("bounds diagnostics separately so a diagnostic flood cannot evict primary trace events", () => {
    const primary = Array.from({ length: 5 }, (_, index): AgentEvent => ({
      seq: index + 1,
      type: "workflow.tick",
      agent: "execution",
      message: `关键过程 ${index + 1}`,
      ts: "2026-09-16T08:00:00.000Z"
    }));
    const diagnostics = Array.from({ length: 1_100 }, (_, index): AgentEvent => ({
      seq: index + 6,
      type: "agent.trace",
      agent: "execution",
      message: `Protocol proxy diagnostic ${index + 1}`,
      ts: "2026-09-16T08:00:01.000Z",
      data: { diagnostic: true, diagnosticSource: "proxy" }
    }));
    const events = [...primary, ...diagnostics];
    const view = render(
      <TraceView
        events={events}
        liveStreams={[]}
        liveEvents={[]}
        project={project}
        connection="offline"
        totalEventCount={events.length}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );

    for (const event of primary) expect(view.container).toHaveTextContent(event.message);
    expect(view.container.querySelector(".trace-diagnostics")).not.toHaveAttribute("open");
    expect(view.container.querySelectorAll(".trace-diagnostic-list .trace-event")).toHaveLength(1_000);
  });

  it("folds historical CLI stderr traces into the diagnostic disclosure", () => {
    const events: AgentEvent[] = [{
      seq: 1,
      type: "workflow.tick",
      agent: "execution",
      message: "保留在主轨迹的过程更新",
      ts: "2026-09-16T08:00:00.000Z"
    }, {
      seq: 2,
      type: "agent.trace",
      agent: "execution",
      message: "CLI stderr diagnostic",
      ts: "2026-09-16T08:00:01.000Z",
      data: { kind: "stderr" }
    }];

    const view = render(
      <TraceView
        events={events}
        liveStreams={[]}
        liveEvents={[]}
        project={project}
        connection="offline"
        totalEventCount={events.length}
        hasOlder={false}
        historyLoading={false}
        historyError=""
        onLoadOlder={async () => undefined}
      />
    );

    const diagnosticDisclosure = view.container.querySelector(".trace-diagnostics");
    expect(diagnosticDisclosure).not.toHaveAttribute("open");
    expect(diagnosticDisclosure).toHaveTextContent("CLI stderr diagnostic");
    expect(view.container.querySelectorAll(".trace-list > .trace-event")).toHaveLength(1);
  });

  it("hides the project explainer when no visible read-only Harness is available", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [explainerGatewayA],
      harnesses: explainerHarnesses.filter((item) => item.id !== "claude-code"),
      agentPrompts
    });
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: project.title })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "项目解说 Agent" })).not.toBeInTheDocument();
  });

  it("offers Codex, Pi and DSH as visible read-only Project Explainer Harnesses", async () => {
    const harnesses = explainerHarnesses
      .filter((item) => item.id !== "claude-code")
      .map((item) => ({
        ...item,
        purposes: ["workflow", "explainer", "probe"] as HarnessCatalogEntry["purposes"],
        capabilities: { ...item.capabilities, readOnlyExplainer: true }
      }));
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [explainerGatewayA],
      harnesses,
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue({
      ...initialExplainerConfig,
      harness: "codex",
      nativeProtocol: "responses",
      routeMode: "direct",
      routeDirection: undefined
    });
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const explainer = await screen.findByRole("region", { name: "项目解说 Agent" });
    await waitFor(() => expect(explainer).toHaveTextContent("PROJECT EXPLAINER · Codex"));
    expect(within(explainer).getByLabelText("向项目解说 Agent 提问")).toBeEnabled();
    const selector = within(explainer).getByLabelText("Project Explainer Harness");
    expect(within(selector).getByRole("option", { name: "Codex" })).toBeEnabled();
    expect(within(selector).getByRole("option", { name: "pi" })).toBeEnabled();
    expect(within(selector).getByRole("option", { name: "dsh" })).toBeEnabled();
    expect(within(selector).queryByRole("option", { name: "Claude Code" })).not.toBeInTheDocument();
  });

  it.each([false, true])("collapses Explainer lifecycle logs into one reply status across history reloads (active: %s)", async active => {
    const base = { projectId: project.id, turnId: "explainer_status_turn", ts: "2026-10-14T00:00:00Z" };
    const logs = ["继续项目解说会话…", "Invocation gateway route ready", "Starting Codex process for __explainer__",
      "Codex thread started", "item.completed: error", "Codex turn started", "Protocol proxy forwarded request",
      "Protocol proxy received upstream response", "模型正在生成回复…", "Protocol proxy stream finished", "Codex turn completed"];
    const events: ProjectExplainerEvent[] = [
      { ...base, id: "previous-answer", turnId: "previous-turn", kind: "assistant", text: "上一次的项目说明。", phase: "completed" },
      { ...base, id: "previous-finished", turnId: "previous-turn", kind: "status", text: "回答完成", phase: "completed", data: { turnComplete: true } },
      { ...base, id: "question", kind: "user", text: "当前是什么状态？", phase: "completed" },
      ...logs.map((text, index): ProjectExplainerEvent => ({ ...base, id: `status-${index}`, kind: "status", text, phase: "delta", data: { diagnostic: true } })),
      { ...base, id: "answer", itemId: "answer", kind: "assistant", text: "当前研究正在进行中。", phase: active ? "delta" : "completed" },
      ...(!active ? [{ ...base, id: "finished", kind: "status" as const, text: "回答完成", phase: "completed" as const, data: { turnComplete: true } }] : [])
    ];
    const original = JSON.stringify(events);
    vi.mocked(getProjectExplainerHistory).mockResolvedValue({ events, active });
    render(<ProjectExplainerPanel projectId={project.id} />);
    const panel = screen.getByRole("region", { name: "项目解说 Agent" });
    await within(panel).findByText("当前研究正在进行中。");
    for (const text of logs) expect(within(panel).queryByText(text)).not.toBeInTheDocument();
    expect(within(panel).getAllByLabelText("Project Explainer 回复状态")).toHaveLength(1);
    expect(within(panel).getByRole("status", { name: "Project Explainer 回复状态" }))
      .toHaveTextContent(active ? "正在生成回复…" : "回答完成");
    expect(JSON.stringify(events)).toBe(original);
  });

  it("retains actual Explainer errors while hiding lifecycle diagnostics", async () => {
    vi.mocked(getProjectExplainerHistory).mockResolvedValue({ active: false, events: [{
      id: "fatal-error", projectId: project.id, turnId: "failed-turn", ts: "2026-10-14T00:00:00Z", kind: "error",
      text: "网关连接失败，请稍后重试。", phase: "completed", data: { diagnostic: true }
    }] });
    render(<ProjectExplainerPanel projectId={project.id} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("网关连接失败，请稍后重试。");
    expect(screen.getByRole("status", { name: "Project Explainer 回复状态" })).toHaveTextContent("回答失败");
  });

  it("places a read-only project explainer beside proactive input and renders native streamed events", async () => {
    vi.mocked(streamProjectExplainerQuestion).mockImplementation(
      async (_projectId, _question, onEvent) => {
        const base = {
          projectId: project.id,
          turnId: "explainer_turn_ui",
          ts: "2026-08-08T00:00:00.000Z"
        };
        await onEvent({
          ...base,
          id: "explainer_user_ui",
          kind: "user",
          text: "论文结论由什么支持？",
          phase: "completed"
        });
        await onEvent({
          ...base,
          id: "explainer_reasoning_delta_ui",
          itemId: "reasoning_ui",
          kind: "reasoning",
          text: "正在核对实验记录。",
          phase: "delta"
        });
        await onEvent({
          ...base,
          id: "explainer_reasoning_done_ui",
          itemId: "reasoning_ui",
          kind: "reasoning",
          text: "",
          phase: "completed"
        });
        await onEvent({
          ...base,
          id: "explainer_tool_start_ui",
          itemId: "tool_ui",
          kind: "tool",
          text: "rg --files writing/shared",
          phase: "started"
        });
        await onEvent({
          ...base,
          id: "explainer_tool_output_ui",
          itemId: "tool_ui",
          kind: "tool_output",
          text: "writing/shared/paper.tex\n",
          phase: "delta"
        });
        await onEvent({
          ...base,
          id: "explainer_tool_done_ui",
          itemId: "tool_ui",
          kind: "tool",
          text: "rg --files writing/shared",
          phase: "completed"
        });
        await onEvent({
          ...base,
          id: "explainer_answer_a_ui",
          itemId: "answer_ui",
          kind: "assistant",
          text: "结论由",
          phase: "delta"
        });
        await onEvent({
          ...base,
          id: "explainer_answer_b_ui",
          itemId: "answer_ui",
          kind: "assistant",
          text: "消融实验支持。",
          phase: "delta"
        });
        await onEvent({
          ...base,
          id: "explainer_answer_done_ui",
          itemId: "answer_ui",
          kind: "assistant",
          text: "",
          phase: "completed"
        });
        await onEvent({
          ...base,
          id: "explainer_status_ui",
          kind: "status",
          text: "回答完成",
          phase: "completed"
        });
      }
    );
    const user = userEvent.setup();
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const explainer = await screen.findByRole("region", {
      name: "项目解说 Agent"
    });
    await within(explainer).findByText(
      "可直接询问项目现状、实验、论文或评审依据"
    );
    vi.mocked(getProjectExplainerHistory).mockImplementation(
      () => new Promise(() => {})
    );
    expect(explainer).toHaveTextContent("只读 · 无 Skills · 无 MCP");
    await waitFor(() => {
      expect(explainer).toHaveTextContent("PROJECT EXPLAINER · Claude Code");
      expect(explainer).toHaveTextContent("Responses Gateway · OpenAI Responses");
      expect(explainer).toHaveTextContent("Anthropic Messages → OpenAI Responses");
    });
    const interactionGrid = explainer.closest(".project-interaction-grid");
    expect(interactionGrid).not.toBeNull();
    expect(interactionGrid?.children[1]).toBe(explainer);
    expect(interactionGrid?.children[0]).toHaveAttribute(
      "aria-label",
      "项目主动需求输入"
    );

    await user.type(
      within(explainer).getByLabelText("向项目解说 Agent 提问"),
      "论文结论由什么支持？"
    );
    await user.click(
      within(explainer).getByRole("button", { name: "询问解说" })
    );

    await waitFor(() =>
      expect(streamProjectExplainerQuestion).toHaveBeenCalledWith(
        project.id,
        "论文结论由什么支持？",
        expect.any(Function),
        expect.any(AbortSignal)
      )
    );
    expect(await within(explainer).findByText("结论由消融实验支持。"))
      .toBeInTheDocument();
    expect(explainer).toHaveTextContent("正在核对实验记录。");
    expect(explainer).toHaveTextContent("rg --files writing/shared");
    expect(explainer).toHaveTextContent("writing/shared/paper.tex");
    expect(explainer).toHaveTextContent("回答完成");

    await user.click(
      within(explainer).getByRole("button", { name: "刷新解说上下文" })
    );
    await waitFor(() =>
      expect(resetProjectExplainer).toHaveBeenCalledWith(project.id)
    );
    expect(explainer).toHaveTextContent("解说上下文已刷新，可以重新询问。");
    expect(explainer).toHaveTextContent(
      "可直接询问项目现状、实验、论文或评审依据"
    );
    expect(within(explainer).queryByText("结论由消融实验支持。"))
      .not.toBeInTheDocument();
  });

  it("refreshes the selected gateway models immediately and requires an explicit compatible model", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [explainerGatewayA, explainerGatewayB],
      defaultGatewayId: explainerGatewayA.id,
      harnesses: explainerHarnesses,
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue(initialExplainerConfig);
    let resolveRefresh!: (gateway: GatewayRecord) => void;
    vi.mocked(refreshGatewayModels).mockReturnValue(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const updatedGateway = {
      ...explainerGatewayB,
      models: ["model-b", "model-b-fast"],
      defaultModel: "model-b",
      test: {
        status: "passed" as const,
        protocol: "chat-completions" as const,
        model: "model-b",
        harness: "claude-code" as const,
        nativeProtocol: "anthropic-messages" as const,
        routeMode: "proxy" as const,
        routeDirection: "anthropic-messages->chat-completions" as const,
        probeKind: "adapter-smoke" as const,
        cacheKey: "claude-model-b",
        adapterVersion: "1",
        executableFingerprint: "fixture-claude",
        gatewayRevision: 1,
        routerCompatibilityVersion: "1"
      },
      tests: [
        {
          status: "passed" as const,
          protocol: "chat-completions" as const,
          model: "model-b",
          harness: "claude-code" as const,
          nativeProtocol: "anthropic-messages" as const,
          routeMode: "proxy" as const,
          routeDirection: "anthropic-messages->chat-completions" as const,
          probeKind: "route" as const
        },
        {
          status: "passed" as const,
          protocol: "chat-completions" as const,
          model: "model-b",
          harness: "claude-code" as const,
          nativeProtocol: "anthropic-messages" as const,
          routeMode: "proxy" as const,
          routeDirection: "anthropic-messages->chat-completions" as const,
          probeKind: "adapter-smoke" as const,
          cacheKey: "claude-model-b",
          adapterVersion: "1",
          executableFingerprint: "fixture-claude",
          gatewayRevision: 1,
          routerCompatibilityVersion: "1"
        }
      ],
      updatedAt: "2026-09-12T00:01:00.000Z"
    };
    vi.mocked(updateProjectExplainerConfig).mockResolvedValue({
      ...initialExplainerConfig,
      gatewayId: updatedGateway.id,
      gatewayProtocol: "chat-completions",
      model: "model-b",
      revision: 2,
      routeMode: "proxy",
      routeDirection: "anthropic-messages->chat-completions"
    });
    const user = userEvent.setup();

    render(<ProjectExplainerPanel projectId={project.id} />);

    const gatewaySelect = await screen.findByLabelText("Project Explainer 全局网关");
    const modelInput = screen.getByLabelText("Project Explainer Model");
    await user.selectOptions(gatewaySelect, updatedGateway.id);

    expect(refreshGatewayModels).toHaveBeenCalledWith(updatedGateway.id);
    expect(modelInput).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在刷新 model 列表");
    expect(screen.getByRole("button", { name: "保存问答配置" })).toBeDisabled();

    await act(async () => resolveRefresh(updatedGateway));

    await waitFor(() => expect(modelInput).not.toBeDisabled());
    expect(modelInput).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("切换网关后需要重新选择 model");
    expect(document.querySelector('option[value="model-b"]')).not.toBeNull();
    expect(screen.getByText(/自动路由：Anthropic Messages → OpenAI Chat Completions/)).toBeInTheDocument();

    await user.selectOptions(modelInput, "model-b");
    await user.click(screen.getByRole("button", { name: "保存问答配置" }));

    await waitFor(() => expect(updateProjectExplainerConfig).toHaveBeenCalledWith(
      project.id,
      {
        harness: "claude-code",
        gatewayId: updatedGateway.id,
        model: "model-b",
        reasoningEffort: "high"
      }
    ));
    expect(screen.getByText(/配置已保存/)).toBeInTheDocument();
  });

  it("blocks saving when the selected gateway model refresh fails", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [explainerGatewayA, explainerGatewayB],
      harnesses: explainerHarnesses,
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue(initialExplainerConfig);
    vi.mocked(refreshGatewayModels).mockRejectedValue(new Error("上游 models 接口超时"));
    const user = userEvent.setup();

    render(<ProjectExplainerPanel projectId={project.id} />);
    await user.selectOptions(
      await screen.findByLabelText("Project Explainer 全局网关"),
      explainerGatewayB.id
    );

    expect(await screen.findByText(/model 列表刷新失败：上游 models 接口超时/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存问答配置" })).toBeDisabled();
    expect(updateProjectExplainerConfig).not.toHaveBeenCalled();
  });

  it.each(["failed", "untested"] as const)("shows a %s matrix warning and allows saving the Project Explainer draft", async (status) => {
    const failedGateway: GatewayRecord = {
      ...explainerGatewayA,
      test: {
        status,
        protocol: "responses",
        model: "model-a",
        error: "上游返回 HTTP 401"
      },
      tests: [{
        status,
        protocol: "responses",
        model: "model-a",
        harness: "claude-code",
        nativeProtocol: "anthropic-messages",
        routeMode: "proxy",
        routeDirection: "anthropic-messages->responses",
        probeKind: "route",
        error: "上游返回 HTTP 401"
      }]
    };
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [failedGateway],
      defaultGatewayId: failedGateway.id,
      harnesses: explainerHarnesses,
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue({
      ...initialExplainerConfig,
      available: true,
      validationWarning: "当前组合尚未通过验证，仍可使用，但运行可能失败。"
    });
    vi.mocked(updateProjectExplainerConfig).mockResolvedValue({ ...initialExplainerConfig, revision: 2 });

    render(<ProjectExplainerPanel projectId={project.id} />);

    expect(await screen.findByText(
      status === "failed"
        ? "当前 Harness / 网关 / model 组合验证失败：上游返回 HTTP 401；仍可使用，但运行可能失败。"
        : "当前 Harness / 网关 / model 组合尚未验证；仍可使用，但运行可能失败。"
    )).toHaveAttribute("role", "status");
    expect(within(screen.getByLabelText("Project Explainer Model")).getByRole("option", {
      name: status === "failed" ? "model-a · 验证失败" : "model-a · 未验证"
    })).toBeEnabled();
    expect(within(screen.getByLabelText("Project Explainer 全局网关")).getByRole("option", {
      name: status === "failed" ? "Responses Gateway · 连接验证失败" : "Responses Gateway · 当前 Harness 未验证"
    })).toBeEnabled();
    if (status === "failed") expect(screen.getByText(/以下 model 验证失败，仍可选择并使用：model-a.*HTTP 401/)).toBeVisible();
    expect(screen.getByRole("button", { name: "保存问答配置" })).toBeEnabled();
    expect(screen.getByLabelText("向项目解说 Agent 提问")).toBeEnabled();
    fireEvent.submit(screen.getByRole("dialog", { name: "Project Explainer 运行配置" }));
    await waitFor(() => expect(updateProjectExplainerConfig).toHaveBeenCalledWith(project.id, expect.objectContaining({
      harness: initialExplainerConfig.harness, gatewayId: failedGateway.id, model: "model-a"
    })));
  });

  it("labels a registered workflow-only Harness as unsupported instead of historical", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [explainerGatewayA],
      harnesses: explainerHarnesses,
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue({
      ...initialExplainerConfig,
      harness: "codex",
      nativeProtocol: "responses",
      routeMode: "direct",
      routeDirection: undefined,
      available: false
    });

    render(<ProjectExplainerPanel projectId={project.id} />);

    const selector = await screen.findByLabelText("Project Explainer Harness");
    expect(within(selector).getByRole("option", { name: "Claude Code" })).toBeEnabled();
    expect(within(selector).getByRole("option", {
      name: /Codex（Codex 未声明 Project Explainer purpose）/
    })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Codex 未声明 Project Explainer purpose"
    );
    expect(screen.getByRole("button", { name: "保存问答配置" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("dialog", { name: "Project Explainer 运行配置" }));
    expect(updateProjectExplainerConfig).not.toHaveBeenCalled();
  });

  it("does not infer a direct Explainer route for a historical Harness without Catalog metadata", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [explainerGatewayA],
      harnesses: explainerHarnesses,
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue({
      ...initialExplainerConfig,
      harness: "retired-harness",
      available: false
    });

    render(<ProjectExplainerPanel projectId={project.id} />);

    expect(await screen.findByText("Harness 目录待确认")).toBeVisible();
    expect(screen.queryByText("直连")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存问答配置" })).toBeDisabled();
    expect(updateProjectExplainerConfig).not.toHaveBeenCalled();
  });

  it("fails closed when the Catalog has no compatible Project Explainer Harness", async () => {
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [explainerGatewayA],
      harnesses: explainerHarnesses.map((item) => ({
        ...item,
        purposes: item.purposes.filter((purpose) => purpose !== "explainer"),
        capabilities: { ...item.capabilities, readOnlyExplainer: false }
      })),
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue({
      ...initialExplainerConfig,
      available: false
    });

    render(<ProjectExplainerPanel projectId={project.id} />);

    expect(await screen.findByText(
      "当前服务端没有注册可用的只读 Project Explainer Harness。"
    )).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "保存问答配置" })).toBeDisabled();
  });

  it("confirms an active harness switch and keeps the visible product-session history", async () => {
    const alternateExplainer: HarnessCatalogEntry = {
      ...explainerHarnesses.find((item) => item.id === "claude-code")!,
      id: "fixture-explainer",
      label: "Fixture Explainer"
    };
    const switchGateway: GatewayRecord = {
      ...explainerGatewayA,
      tests: [
        ...(explainerGatewayA.tests ?? []),
        {
          status: "passed",
          protocol: "responses",
          model: "model-a",
          harness: alternateExplainer.id,
          nativeProtocol: "anthropic-messages",
          routeMode: "proxy",
          routeDirection: "anthropic-messages->responses",
          probeKind: "route"
        },
        {
          status: "passed",
          protocol: "responses",
          model: "model-a",
          harness: alternateExplainer.id,
          nativeProtocol: "anthropic-messages",
          routeMode: "proxy",
          routeDirection: "anthropic-messages->responses",
          probeKind: "adapter-smoke",
          cacheKey: "fixture-explainer-model-a",
          adapterVersion: "1",
          executableFingerprint: "fixture-claude",
          gatewayRevision: 1,
          routerCompatibilityVersion: "1"
        }
      ]
    };
    const historyBase = {
      projectId: project.id,
      turnId: "explainer_turn_before_switch",
      ts: "2026-09-12T00:00:00.000Z",
      phase: "completed" as const
    };
    const priorEvents: ProjectExplainerEvent[] = [
      { ...historyBase, id: "question_before_switch", kind: "user", text: "此前结论是什么？" },
      { ...historyBase, id: "answer_before_switch", kind: "assistant", text: "此前完整回答仍然保留。" }
    ];
    const switchedEvents: ProjectExplainerEvent[] = [
      ...priorEvents,
      {
        ...historyBase,
        id: "interrupted_switch",
        kind: "status",
        text: "当前回答已中断。",
        data: { interrupted: true }
      },
      {
        ...historyBase,
        id: "harness_switch",
        kind: "status",
        text: "已切换 harness，历史上下文已带入新会话",
        data: { previousHarness: "claude-code", harness: alternateExplainer.id, nativeSessionRebuilt: true }
      }
    ];
    vi.mocked(getCatalog).mockResolvedValue({
      skills: [],
      models: [],
      gateways: [switchGateway],
      harnesses: [...explainerHarnesses, alternateExplainer],
      protocols: ["responses", "chat-completions", "anthropic-messages"],
      agentPrompts
    });
    vi.mocked(getProjectExplainerConfig).mockResolvedValue(initialExplainerConfig);
    vi.mocked(getProjectExplainerHistory)
      .mockResolvedValueOnce({ events: priorEvents, active: true })
      .mockResolvedValue({ events: switchedEvents, active: false });
    const conflict = Object.assign(new Error("需要确认 harness 切换"), {
      status: 409,
      details: { code: "explainer_harness_switch_confirmation_required" }
    });
    const switchedConfig: ProjectExplainerRuntimeConfig = {
      ...initialExplainerConfig,
      harness: alternateExplainer.id,
      nativeProtocol: "anthropic-messages",
      revision: 2,
      routeMode: "proxy",
      routeDirection: "anthropic-messages->responses"
    };
    vi.mocked(updateProjectExplainerConfig)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(switchedConfig);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProjectExplainerPanel projectId={project.id} />);

    expect(await screen.findByText("此前完整回答仍然保留。")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Project Explainer Harness"), alternateExplainer.id);
    await user.click(screen.getByRole("button", { name: "保存问答配置" }));

    await waitFor(() => expect(updateProjectExplainerConfig).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledWith("当前回答会终止，已有历史将带入新会话。是否继续切换 harness？");
    expect(vi.mocked(updateProjectExplainerConfig).mock.calls[0][1]).toEqual({
      harness: alternateExplainer.id,
      gatewayId: explainerGatewayA.id,
      model: "model-a",
      reasoningEffort: "high"
    });
    expect(vi.mocked(updateProjectExplainerConfig).mock.calls[1][1]).toEqual({
      harness: alternateExplainer.id,
      gatewayId: explainerGatewayA.id,
      model: "model-a",
      reasoningEffort: "high",
      confirmHarnessSwitch: true
    });
    expect(await screen.findByText("已切换 harness，历史上下文已带入新会话")).toBeInTheDocument();
    expect(screen.getByText("当前回答已中断。")).toBeInTheDocument();
    expect(screen.getByText("此前结论是什么？")).toBeInTheDocument();
    expect(screen.getByText("此前完整回答仍然保留。")).toBeInTheDocument();
    expect(screen.getByText(/已切换 harness 并重建底层会话/)).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("keeps Enter inside an active IME composition and sends only a normal Enter", async () => {
    const user = userEvent.setup();
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const explainer = await screen.findByRole("region", {
      name: "项目解说 Agent"
    });
    const input = within(explainer).getByLabelText("向项目解说 Agent 提问");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "English draft");

    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing: true
    });
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      keyCode: 229
    });
    expect(streamProjectExplainerQuestion).not.toHaveBeenCalled();
    expect(input).toHaveValue("English draft");

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(streamProjectExplainerQuestion).toHaveBeenCalledWith(
        project.id,
        "English draft",
        expect.any(Function),
        expect.any(AbortSignal)
      )
    );
  });

  it("confirms a backend stop before discarding the local explainer stream", async () => {
    const user = userEvent.setup();
    let emit!: (event: ProjectExplainerEvent) => Promise<void> | void;
    let localStreamAborted = false;
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    vi.mocked(cancelProjectExplainer).mockImplementation(() => cancellation);
    vi.mocked(streamProjectExplainerQuestion).mockImplementation(
      (_projectId, _question, onEvent, signal) => {
        emit = onEvent;
        return new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              localStreamAborted = true;
              resolve();
            },
            { once: true }
          );
        });
      }
    );
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const explainer = await screen.findByRole("region", {
      name: "项目解说 Agent"
    });
    await waitFor(() =>
      expect(
        within(explainer).getByLabelText("向项目解说 Agent 提问")
      ).toBeEnabled()
    );
    await user.type(
      within(explainer).getByLabelText("向项目解说 Agent 提问"),
      "请解释当前证据。"
    );
    await user.click(within(explainer).getByRole("button", { name: "询问解说" }));
    await waitFor(() => expect(streamProjectExplainerQuestion).toHaveBeenCalled());

    const stopButton = within(explainer).getByRole("button", { name: "停止" });
    await user.click(stopButton);
    await waitFor(() =>
      expect(cancelProjectExplainer).toHaveBeenCalledWith(project.id)
    );
    expect(stopButton).toHaveTextContent("停止中");
    expect(localStreamAborted).toBe(false);

    await act(async () => {
      await emit({
        id: "explainer_event_after_stop",
        projectId: project.id,
        turnId: "explainer_turn_stop",
        itemId: "answer_after_stop",
        kind: "assistant",
        text: "这段输出不应在停止后显示。",
        ts: "2026-08-19T00:00:00.000Z",
        phase: "delta"
      });
    });
    expect(explainer).not.toHaveTextContent("这段输出不应在停止后显示。");

    releaseCancellation();
    await waitFor(() => expect(localStreamAborted).toBe(true));
    await waitFor(() =>
      expect(
        within(explainer).getByLabelText("向项目解说 Agent 提问")
      ).not.toBeDisabled()
    );
  });

  it("round-trips runtime experiment selection through single and batch saves", async () => {
    const draft = { ...structuredClone(project), status: "draft" as const, configurationLocked: false };
    vi.mocked(getProject).mockResolvedValue(draft);
    vi.mocked(updateProjectAgentConfigs).mockImplementation(async (_id, changes) => {
      for (const [agent, config] of Object.entries(changes)) Object.assign(draft.agents[agent], config);
      return structuredClone(draft);
    });
    const user = userEvent.setup();
    render(<WorkspacePage projectId={draft.id} onBack={vi.fn()} />);
    const open = () => user.click(screen.getByRole("button", { name: "编辑 Agent 模型、Prompt、Skills 与 MCP" }));
    await screen.findAllByText("Main Agent");
    await open();
    let dialog = screen.getByRole("dialog", { name: "编辑 Agent 完整配置" });
    expect(within(dialog).queryByLabelText("main SII 实验工具")).not.toBeInTheDocument();
    const ideaRow = within(dialog).getByLabelText("idea SII 实验工具").closest(".agent-model-edit-row")! as HTMLElement;
    await user.click(within(ideaRow).getByLabelText("idea SII 实验工具"));
    await user.click(within(ideaRow).getByRole("button", { name: "应用到该 Agent" }));
    await waitFor(() => expect(updateProjectAgentConfigs).toHaveBeenCalledWith(draft.id,
      { idea: expect.objectContaining({ experimentMcp: true, permission: "workspace" }) }));
    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    await open();
    dialog = screen.getByRole("dialog", { name: "编辑 Agent 完整配置" });
    expect(within(dialog).getByLabelText("idea SII 实验工具")).toBeChecked();
    await user.click(within(dialog).getByLabelText("execution SII 实验工具"));
    await user.click(within(dialog).getByLabelText("选择idea"));
    await user.click(within(dialog).getByLabelText("选择execution"));
    fireEvent.change(within(dialog).getByLabelText("批量模型"), { target: { value: "gpt-5.6-terra" } });
    await user.click(within(dialog).getByRole("button", { name: "同时应用到已选" }));
    await waitFor(() => expect(updateProjectAgentConfigs).toHaveBeenCalledTimes(2));
    const batch = vi.mocked(updateProjectAgentConfigs).mock.calls[1][1];
    expect(Object.keys(batch).sort()).toEqual(["execution", "idea"]);
    expect(batch.idea).toMatchObject({ experimentMcp: true, model: "gpt-5.6-terra" });
    expect(batch.execution).toMatchObject({ experimentMcp: true, model: "gpt-5.6-terra" });
    expect(draft.agents.writing).toEqual(project.agents.writing);
  });

  it("uses all unsaved runtime drafts and the nested graph, then applies only target tools", async () => {
    const draft = { ...structuredClone(project), status: "draft" as const, configurationLocked: false };
    upgradeLegacyGroups(draft.orchestration);
    addScopedGroup(draft.orchestration, { id: "outer", displayName: "Outer", leaderAgentId: "review", memberAgentIds: ["idea", "execution", "writing"] });
    addScopedGroup(draft.orchestration, { id: "inner", displayName: "Inner", parentGroupId: "outer", leaderAgentId: "idea", memberAgentIds: ["execution", "writing"] });
    draft.agents.idea.skills = ["manual-skill"];
    draft.agents.idea.autoSkills = ["manual-auto"];
    draft.agents.idea.mcpServers = [{ name: "manual", url: "https://manual.example.test/mcp" }];
    vi.mocked(getProject).mockResolvedValue(draft);
    vi.mocked(updateProjectAgentConfigs).mockResolvedValue(draft);
    vi.mocked(recommendAgentTools).mockImplementation(async input => ({
      targetAgent: input.targetAgent, contextFingerprint: input.contextFingerprint,
      configurationFingerprint: input.configurationFingerprint, catalogFingerprint: input.catalogFingerprint,
      selection: { skills: ["project:recommended-reader"], autoSkills: [], mcpServers: [], experimentMcp: true },
      reasons: ["为完整任务中的实验 Worker 选择 SII。"], warnings: []
    }));
    const user = userEvent.setup();
    render(<WorkspacePage projectId={draft.id} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "编辑 Agent 模型、Prompt、Skills 与 MCP" }));
    const dialog = screen.getByRole("dialog", { name: "编辑 Agent 完整配置" });
    fireEvent.change(within(dialog).getByLabelText("idea自定义 Prompt"), { target: { value: "最新实验任务指令" } });
    fireEvent.change(within(dialog).getByLabelText("writing自定义 Prompt"), { target: { value: "另一个身份尚未保存的写作要求" } });
    const ideaRow = within(dialog).getByLabelText("idea自定义 Prompt").closest(".agent-model-edit-row")! as HTMLElement;
    const recommend = within(ideaRow).getByRole("button", { name: "推荐 Skill / MCP" });
    await waitFor(() => expect(recommend).toBeEnabled());
    await user.click(recommend);
    const preview = await within(dialog).findByRole("region", { name: "idea 工具推荐预览" });
    const input = vi.mocked(recommendAgentTools).mock.calls[0][0];
    expect(input).toMatchObject({ projectId: draft.id, targetAgent: "idea", title: draft.title,
      agents: { idea: { instructions: "最新实验任务指令", skills: ["manual-skill"] },
        writing: { instructions: "另一个身份尚未保存的写作要求" } } });
    expect(input.orchestration).toEqual(draft.orchestration);
    expect(updateProjectAgentConfigs).not.toHaveBeenCalled();
    await user.click(within(preview).getByRole("button", { name: "应用工具推荐" }));
    await waitFor(() => expect(within(ideaRow).getByLabelText("idea SII 实验工具")).toBeChecked());
    expect(within(ideaRow).getByRole("checkbox", { name: "recommended-reader" })).toBeChecked();
    expect(updateProjectAgentConfigs).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText("writing自定义 Prompt")).toHaveValue("另一个身份尚未保存的写作要求");
    await user.click(within(ideaRow).getByRole("button", { name: "应用到该 Agent" }));
    await waitFor(() => expect(updateProjectAgentConfigs).toHaveBeenCalledOnce());
    expect(vi.mocked(updateProjectAgentConfigs).mock.calls[0][1]).toEqual({ idea: {
      model: draft.agents.idea.model, gatewayReasoningOption: null, instructions: "最新实验任务指令",
      skills: ["project:recommended-reader"], autoSkills: [], mcpServers: [], experimentMcp: true,
      permission: draft.agents.idea.permission, webSearch: draft.agents.idea.webSearch
    } });
    expect(streamProjectExplainerQuestion).not.toHaveBeenCalled();
  });

  it("rejects stale runtime previews while preserving manual configuration drafts", async () => {
    const draft = { ...structuredClone(project), status: "draft" as const, configurationLocked: false };
    vi.mocked(getProject).mockResolvedValue(draft);
    const user = userEvent.setup();
    render(<WorkspacePage projectId={draft.id} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "编辑 Agent 模型、Prompt、Skills 与 MCP" }));
    const dialog = screen.getByRole("dialog", { name: "编辑 Agent 完整配置" });
    const ideaRow = within(dialog).getByLabelText("idea自定义 Prompt").closest(".agent-model-edit-row")! as HTMLElement;
    const recommend = within(ideaRow).getByRole("button", { name: "推荐 Skill / MCP" });
    await waitFor(() => expect(recommend).toBeEnabled());
    await user.click(recommend);
    await within(dialog).findByRole("region", { name: "idea 工具推荐预览" });
    await user.click(within(ideaRow).getByLabelText("idea SII 实验工具"));
    await waitFor(() => expect(within(dialog).queryByRole("region", { name: "idea 工具推荐预览" })).not.toBeInTheDocument());
    await user.click(recommend);
    const preview = await within(dialog).findByRole("region", { name: "idea 工具推荐预览" });
    vi.mocked(getRecommendationExplainerConfig).mockResolvedValue({ config: initialExplainerConfig, fingerprint: "f".repeat(64) });
    await user.click(within(preview).getByRole("button", { name: "应用工具推荐" }));
    await waitFor(() => expect(within(dialog).queryByRole("region", { name: "idea 工具推荐预览" })).not.toBeInTheDocument());
    expect(within(ideaRow).getByLabelText("idea SII 实验工具")).toBeChecked();
    expect(updateProjectAgentConfigs).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves existing Explainer harness-switch confirmation in runtime recommendations: %s", async confirmed => {
    const draft = { ...structuredClone(project), status: "draft" as const, configurationLocked: false };
    vi.mocked(getProject).mockResolvedValue(draft);
    const catalog = await getCatalog();
    vi.mocked(getCatalog).mockResolvedValue({ ...catalog, harnesses: explainerHarnesses.map(h => ({
      ...h, purposes: ["workflow", "explainer", "probe"], capabilities: { ...h.capabilities, readOnlyExplainer: true }
    })) });
    vi.mocked(updateProjectExplainerConfig).mockRejectedValueOnce(Object.assign(new Error("需要确认切换"), {
      status: 409, details: { code: "explainer_harness_switch_confirmation_required" }
    })).mockResolvedValue({ ...initialExplainerConfig, harness: "codex" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(confirmed);
    try {
      const user = userEvent.setup();
      render(<WorkspacePage projectId={draft.id} onBack={vi.fn()} />);
      await user.click(await screen.findByRole("button", { name: "编辑 Agent 模型、Prompt、Skills 与 MCP" }));
      const dialog = screen.getByRole("dialog", { name: "编辑 Agent 完整配置" });
      await waitFor(() => expect(within(dialog).getByLabelText("推荐 Explainer Harness")).toBeEnabled());
      await user.click(within(dialog).getByRole("button", { name: "调整推荐模型" }));
      await user.selectOptions(within(dialog).getByLabelText("推荐 Explainer Harness"), "codex");
      await user.click(within(dialog).getByRole("button", { name: "保存设置" }));
      await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      if (confirmed) {
        await waitFor(() => expect(updateProjectExplainerConfig).toHaveBeenCalledTimes(2));
        expect(vi.mocked(updateProjectExplainerConfig).mock.calls[1]).toEqual([draft.id, {
          harness: "codex", gatewayId: initialExplainerConfig.gatewayId, model: initialExplainerConfig.model,
          reasoningEffort: initialExplainerConfig.reasoningEffort, confirmHarnessSwitch: true
        }]);
      } else {
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("需要确认切换");
        expect(updateProjectExplainerConfig).toHaveBeenCalledOnce();
      }
      expect(updateProjectAgentConfigs).not.toHaveBeenCalled();
      expect(streamProjectExplainerQuestion).not.toHaveBeenCalled();
    } finally { confirm.mockRestore(); }
  });

  it("locks every Agent configuration after the project starts", async () => {
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    expect((await screen.findAllByText("Main Agent")).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", {
        name: "编辑 Agent 模型、Prompt、Skills 与 MCP"
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "编辑 Agent 完整配置" })
    ).not.toBeInTheDocument();
    expect(updateProjectAgentConfigs).not.toHaveBeenCalled();
  });

  it.each(["open", "merged"] as const)("submits future group edits through the unified complete window and preserves original PR/node facts (%s)", async finalStatus => {
    const original = collaborationProject(finalStatus), before = structuredClone(original);
    const context: import("../workflowAdjustments").WorkflowAdjustmentContext = { current: { version: { revision: 1, hash: "1".repeat(64) },
      snapshot: { orchestration: structuredClone(original.orchestration), agents: structuredClone(original.agents), skillDefinitions: {}, mcpDefinitions: {} } }, records: [] };
    vi.mocked(getProject).mockResolvedValue(original);
    vi.mocked(getWorkflowAdjustmentPage).mockImplementation(async (_id, input) => workflowAdjustmentPageFixture(context, input));
    vi.mocked(submitWorkflowAdjustment).mockImplementation(async (_id, input) => {
      const status = finalStatus === "open" ? "pending" as const : "applied" as const;
      const appliedVersion = { revision: 2, hash: "2".repeat(64) };
      const record: import("../workflowAdjustments").WorkflowAdjustmentRecord = { ...input, explanation: input.explanation ?? "", projectId: original.id,
        source: { kind: "user" }, submittedAt: "2026-10-10T22:00:00Z", baseSnapshot: structuredClone(context.current.snapshot), changes: [], status,
        currentVersion: status === "applied" ? appliedVersion : context.current.version,
        ...(status === "pending" ? { waitingReason: "原最终 PR 尚未终结" } : {}),
        history: [{ requestId: input.requestId, status, at: "2026-10-10T22:00:00Z", ...(status === "applied" ? { appliedVersion } : {}) }] };
      context.records.push(record); if (status === "applied") context.current = { version: appliedVersion, snapshot: structuredClone(input.proposal) };
      return { record, revision: 50, replay: false };
    });
    const user = userEvent.setup();
    render(<WorkspacePage projectId={original.id} onBack={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "查看与调整 Workflow" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "编辑协作组配置" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "查看与调整 Workflow" }));
    const dialog = await screen.findByRole("dialog", { name: "查看与调整当前 Workflow" });
    const name = await within(dialog).findByLabelText("协作组显示名称");
    expect(name).toBeEnabled(); fireEvent.change(name, { target: { value: "证据整合组" } });
    await user.click(within(dialog).getByRole("button", { name: "提交完整修改" }));
    await waitFor(() => expect(submitWorkflowAdjustment).toHaveBeenCalledOnce());
    expect(vi.mocked(submitWorkflowAdjustment).mock.calls[0]).toEqual([original.id, expect.objectContaining({ base: { revision: 1, hash: "1".repeat(64) },
      proposal: expect.objectContaining({ orchestration: expect.objectContaining({ collaborations: [expect.objectContaining({ id: "research_group", displayName: "证据整合组" })] }) }) })]);
    expect(await within(dialog).findByText(finalStatus === "open" ? "已提交，等待安全时机应用" : "已应用，实际接受版本 r2")).toBeVisible();
    expect(original.groupRuns).toEqual(before.groupRuns); expect(original.nodeRuns).toEqual(before.nodeRuns); expect(original.pullRequests).toEqual(before.pullRequests);
    expect(updateProjectCollaborationGroup).not.toHaveBeenCalled(); expect(projectAction).not.toHaveBeenCalled();
  });

  it("renders the shared runtime workflow canvas and logical invocation ledger to the right of the workspace tabs", async () => {
    eventStreamMock.events = [
      {
        seq: 1,
        type: "agent.started",
        agent: "idea",
        message: "idea agent started",
        ts: "2026-07-31T03:00:01.000Z",
        data: { invocationId: "inv_graph_idea", cycle: 1 }
      },
      {
        seq: 2,
        type: "agent.started",
        agent: "main",
        message: "main agent started",
        ts: "2026-07-31T03:01:00.000Z",
        data: { invocationId: "inv_graph_main_1", cycle: 1 }
      },
      {
        seq: 3,
        type: "agent.started",
        agent: "execution",
        message: "execution agent started",
        ts: "2026-07-31T03:02:00.000Z",
        data: { invocationId: "inv_graph_execution", cycle: 1 }
      },
      {
        seq: 4,
        type: "agent.started",
        agent: "main",
        message: "main agent started",
        ts: "2026-07-31T03:03:00.000Z",
        data: { invocationId: "inv_graph_main_2", cycle: 1 }
      },
      {
        seq: 5,
        type: "agent.started",
        agent: "writing",
        message: "writing agent started",
        ts: "2026-07-31T03:04:00.000Z",
        data: { invocationId: "inv_graph_writing", cycle: 1 }
      },
      {
        seq: 6,
        type: "agent_run_started",
        agent: "writing",
        message: "duplicate legacy replay",
        ts: "2026-07-31T03:04:01.000Z",
        data: { invocationId: "inv_graph_writing", cycle: 1 }
      }
    ];

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const graph = await screen.findByRole("region", {
      name: "Agent 调用轨迹图"
    });
    const center = document.querySelector(".workspace-center");
    expect(center?.nextElementSibling).toBe(graph);
    const runtimeMap = graph.querySelector(".agent-call-runtime-map");
    expect(runtimeMap).not.toBeNull();
    expect(runtimeMap?.querySelector('[data-runtime-surface-mode="preview"]')).not.toBeNull();
    expect(runtimeMap?.querySelector('[data-runtime-node-count="7"]')).not.toBeNull();
    expect(runtimeMap?.querySelector('[data-runtime-edge-count="10"]')).not.toBeNull();
    expect(graph.querySelector(".agent-call-svg")).toBeNull();
    expect(graph.querySelectorAll(".agent-call-sequence-number")).toHaveLength(5);
    expect(graph.querySelectorAll(".agent-call-route")).toHaveLength(0);
    expect(graph.querySelector('[data-node-id="main"]')).not.toBeNull();
    expect(graph.querySelector('[data-node-id="idea"]')).not.toBeNull();
    expect(graph).toHaveTextContent("5");
    expect(graph).toHaveTextContent("Main Agent");
  });

  it("draws user intervention between the requesting Main and the resumed Main", async () => {
    eventStreamMock.events = [
      {
        seq: 1,
        type: "agent.started",
        agent: "main",
        message: "main agent started",
        ts: "2026-07-31T03:00:00.000Z",
        data: { invocationId: "inv_main_before_user", cycle: 1 }
      },
      {
        seq: 2,
        type: "agent.completed",
        agent: "main",
        message: "Main requested user intervention",
        ts: "2026-07-31T03:00:30.000Z",
        data: { invocationId: "inv_main_before_user", cycle: 1 }
      },
      {
        seq: 3,
        type: "user.intervention.requested",
        agent: "main",
        message: "Main requires user intervention",
        ts: "2026-07-31T03:00:31.000Z",
        data: { requestId: "usr_graph_intervention" }
      },
      {
        seq: 4,
        type: "user.intervention.answered",
        agent: "main",
        message: "User responded; Main queued",
        ts: "2026-07-31T03:01:00.000Z",
        data: { requestId: "usr_graph_intervention" }
      },
      {
        seq: 5,
        type: "agent.started",
        agent: "main",
        message: "main agent started",
        ts: "2026-07-31T03:01:01.000Z",
        data: { invocationId: "inv_main_after_user", cycle: 1 }
      }
    ];

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const graph = await screen.findByRole("region", {
      name: "Agent 调用轨迹图"
    });
    expect(graph.querySelector(".agent-call-event-ledger")).not.toBeNull();
    expect(graph).toHaveTextContent("用户介入");
    expect(graph.querySelectorAll(".agent-call-sequence-number")).toHaveLength(2);
    expect(graph.querySelectorAll(".agent-call-route")).toHaveLength(0);
    expect(graph.querySelector(".agent-call-event-row")?.textContent).toContain("已回复");
    expect(graph).toHaveTextContent(
      "用户介入与主动需求不占用 Agent 调用编号"
    );
  });

  it("draws a proactive user requirement into the Main invocation that receives it", async () => {
    eventStreamMock.events = [
      {
        seq: 1,
        type: "agent.started",
        agent: "main",
        message: "main agent started",
        ts: "2026-07-31T03:00:00.000Z",
        data: {
          invocationId: "inv_main_before_requirement",
          cycle: 1,
          mainInvocation: 1
        }
      },
      {
        seq: 2,
        type: "agent.completed",
        agent: "main",
        message: "main agent completed",
        ts: "2026-07-31T03:00:20.000Z",
        data: { invocationId: "inv_main_before_requirement", cycle: 1 }
      },
      {
        seq: 3,
        type: "agent.started",
        agent: "execution",
        message: "execution agent started",
        ts: "2026-07-31T03:01:00.000Z",
        data: { invocationId: "inv_execution_during_requirement", cycle: 1 }
      },
      {
        seq: 4,
        type: "user.input.queued",
        agent: "main",
        message: "User added a project-level requirement",
        ts: "2026-07-31T03:01:10.000Z",
        data: {
          inputId: "inp_graph_proactive",
          targetMainInvocation: 2,
          preview: "先完成大实验，再决定模型架构修改方向"
        }
      },
      {
        seq: 5,
        type: "agent.completed",
        agent: "execution",
        message: "execution agent completed",
        ts: "2026-07-31T03:02:00.000Z",
        data: { invocationId: "inv_execution_during_requirement", cycle: 1 }
      },
      {
        seq: 6,
        type: "agent.started",
        agent: "main",
        message: "main started with proactive input",
        ts: "2026-07-31T03:02:01.000Z",
        data: {
          invocationId: "inv_main_receives_requirement",
          cycle: 1,
          mainInvocation: 2
        }
      },
      {
        seq: 7,
        type: "user.input.delivered",
        agent: "main",
        message: "1 project-level user input was delivered to main",
        ts: "2026-07-31T03:03:00.000Z",
        data: {
          invocationId: "inv_main_receives_requirement",
          mainInvocation: 2,
          inputIds: ["inp_graph_proactive"]
        }
      }
    ];

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const graph = await screen.findByRole("region", {
      name: "Agent 调用轨迹图"
    });
    const marker = graph.querySelector(".agent-call-event-row");
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent("R1");
    expect(marker).toHaveTextContent("已进入流程");
    expect(marker).toHaveTextContent("先完成大实验，再决定模型架构修改方向");
    expect(graph).toHaveTextContent("介入与主动需求");
    // Main invocations are public and remain part of the user-facing call count.
    expect(graph.querySelectorAll(".agent-call-sequence-number")).toHaveLength(3);
  });

  it("merges failed retries and checkpoint restarts into one logical Agent call", async () => {
    eventStreamMock.events = [
      {
        seq: 1,
        type: "agent.started",
        agent: "main",
        message: "main agent started",
        ts: "2026-07-31T03:00:00.000Z",
        data: { invocationId: "inv_retry_main", cycle: 1 }
      },
      {
        seq: 2,
        type: "agent.completed",
        agent: "main",
        message: "Main agent completed its progress audit",
        ts: "2026-07-31T03:00:30.000Z",
        data: { invocationId: "inv_retry_main", cycle: 1 }
      },
      {
        seq: 3,
        type: "agent.started",
        agent: "execution",
        message: "execution agent started",
        ts: "2026-07-31T03:01:00.000Z",
        data: { invocationId: "inv_execution_original", cycle: 1 }
      },
      {
        seq: 4,
        type: "agent.failed",
        agent: "execution",
        message: "execution failed; automatic retry 1 scheduled",
        ts: "2026-07-31T03:02:00.000Z"
      },
      {
        seq: 5,
        type: "agent.started",
        agent: "execution",
        message: "execution agent started",
        ts: "2026-07-31T03:02:01.000Z",
        data: { invocationId: "inv_execution_retry", cycle: 1 }
      },
      {
        seq: 6,
        type: "project.status",
        agent: "execution",
        message: "Recovered checkpoint after service interruption",
        ts: "2026-07-31T03:03:00.000Z"
      },
      {
        seq: 7,
        type: "agent.started",
        agent: "execution",
        message: "execution agent started",
        ts: "2026-07-31T03:03:01.000Z",
        data: { invocationId: "inv_execution_recovered", cycle: 1 }
      },
      {
        seq: 8,
        type: "agent.completed",
        agent: "execution",
        message: "execution agent completed; main audit is mandatory next",
        ts: "2026-07-31T03:04:00.000Z",
        data: { invocationId: "inv_execution_recovered", cycle: 1 }
      },
      {
        seq: 9,
        type: "agent.started",
        agent: "main",
        message: "main agent started",
        ts: "2026-07-31T03:04:01.000Z",
        data: { invocationId: "inv_retry_main_after", cycle: 1 }
      }
    ];

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const graph = await screen.findByRole("region", {
      name: "Agent 调用轨迹图"
    });
    expect(graph.querySelectorAll(".agent-call-sequence-number")).toHaveLength(3);
    expect(graph.querySelectorAll(".agent-call-route")).toHaveLength(0);
    expect(graph.querySelector('[title="inv_execution_original"]')).not.toBeNull();
    expect(graph.querySelector('[title="inv_execution_retry"]')).toBeNull();
    expect(graph.querySelector('[title="inv_execution_recovered"]')).toBeNull();
    expect(graph).toHaveTextContent(
      "失败重试和中断恢复合并为同一次调用"
    );
  });

  it("paginates the full invocation history independently of the trace display limit and filter", async () => {
    const invocationEvents = Array.from({ length: 12 }, (_, index) => {
      const role = AGENT_ROLES[index % AGENT_ROLES.length];
      const seq = index + 1;
      return {
        seq,
        type: "agent.started",
        agent: role,
        message: `${role} agent started`,
        ts: new Date(Date.UTC(2026, 6, 31, 3, 0, seq)).toISOString(),
        data: { invocationId: `inv_full_graph_${seq}`, cycle: 1 }
      } satisfies AgentEvent;
    });
    const traceEvents = Array.from({ length: 1_100 }, (_, index) => {
      const seq = invocationEvents.length + index + 1;
      return {
        seq,
        type: "workflow.tick",
        agent: seq % 2 === 0 ? "execution" : "main",
        message: `后续轨迹事件 ${seq}`,
        ts: new Date(Date.UTC(2026, 6, 31, 4, 0, seq)).toISOString()
      } satisfies AgentEvent;
    });
    eventStreamMock.events = [...invocationEvents, ...traceEvents];
    const user = userEvent.setup();

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const graph = await screen.findByRole("region", {
      name: "Agent 调用轨迹图"
    });
    expect(
      within(graph).getByLabelText("调用记录")
    ).toBeInTheDocument();
    expect(graph.querySelectorAll(".agent-call-sequence-number")).toHaveLength(2);
    expect(graph.querySelectorAll(".agent-call-route")).toHaveLength(0);
    expect(
      Array.from(graph.querySelectorAll(".agent-call-sequence-number")).map((node) =>
        Number(node.textContent)
      )
    ).toEqual([11, 12]);
    expect(graph).toHaveTextContent("11–12 / 12");
    expect(graph).toHaveTextContent("编号按逻辑调用顺序生成");

    const displayLimit = screen.getByLabelText("显示最新轨迹条数");
    const agentFilter = screen.getByLabelText("按智能体筛选");
    expect(displayLimit).toHaveValue("1000");
    await user.selectOptions(displayLimit, "100");
    await user.selectOptions(agentFilter, "execution");

    expect(graph.querySelectorAll(".agent-call-sequence-number")).toHaveLength(2);
    expect(graph.querySelectorAll(".agent-call-route")).toHaveLength(0);
    expect(
      within(graph).getByLabelText("调用记录")
    ).toBeInTheDocument();

    await user.click(
      within(graph).getByRole("button", { name: "查看上一组调用" })
    );
    expect(graph.querySelectorAll(".agent-call-sequence-number")).toHaveLength(10);
    expect(graph.querySelectorAll(".agent-call-route")).toHaveLength(0);
    expect(
      Array.from(graph.querySelectorAll(".agent-call-sequence-number")).map((node) =>
        Number(node.textContent)
      )
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(graph).toHaveTextContent("1–10 / 12");
  });

  it("pairs agent thought summaries with tool calls and shows the active dispatch", async () => {
    const running: Project = {
      ...project,
      status: "running",
      phase: "execution:running",
      currentAgent: "execution",
      queuedAgent: undefined,
      queuePosition: undefined,
      agentProgress: {
        ...project.agentProgress,
        execution: { state: "running", runs: 4 }
      }
    };
    eventStreamMock.events = [
      {
        seq: 1,
        type: "agent.started",
        agent: "execution",
        message: "execution agent started",
        ts: "2026-07-31T04:00:00.000Z",
        data: {
          invocationId: "inv_ui_trace",
          assignedTask: "下载固定版本数据并完成可复现审计。",
          inputSources: ["流程最新安排及其验收条件", "项目产物索引"],
          successCriteria: ["生成非空 manifest。"]
        }
      },
      {
        seq: 2,
        type: "agent.trace",
        agent: "execution",
        message: "正在验证数据版本和下载路径。",
        ts: "2026-07-31T04:00:01.000Z",
        data: {
          invocationId: "inv_ui_trace",
          kind: "message",
          itemType: "agent_message"
        }
      },
      {
        seq: 3,
        type: "agent.trace",
        agent: "execution",
        message: "curl -I https://example.test/data · in_progress",
        ts: "2026-07-31T04:00:02.000Z",
        data: {
          invocationId: "inv_ui_trace",
          kind: "tool",
          itemType: "command_execution",
          itemId: "item_download",
          command: "curl -I https://example.test/data",
          status: "in_progress"
        }
      },
      {
        seq: 4,
        type: "agent.trace",
        agent: "execution",
        message: "curl -I https://example.test/data · completed",
        ts: "2026-07-31T04:00:03.000Z",
        data: {
          invocationId: "inv_ui_trace",
          kind: "tool",
          itemType: "command_execution",
          itemId: "item_download",
          command: "curl -I https://example.test/data",
          status: "completed"
        }
      }
    ];
    vi.mocked(getProject).mockResolvedValue(running);

    render(<WorkspacePage projectId={running.id} onBack={vi.fn()} />);

    expect(await screen.findByText("Agent 过程摘要")).toBeInTheDocument();
    const actionRow = document.querySelector(".agent-action-row");
    expect(actionRow).not.toBeNull();
    expect(actionRow?.children[0]).toHaveTextContent("正在验证数据版本和下载路径");
    expect(actionRow?.children[1]).toHaveTextContent("工具调用");
    expect(actionRow?.children[1]).toHaveTextContent("curl -I https://example.test/data");
    expect(actionRow?.children[1]).toHaveTextContent("完成");
    expect(document.querySelectorAll(".agent-tool-item")).toHaveLength(1);

    const currentAgent = screen.getByRole("region", {
      name: "当前 Agent 工作信息"
    });
    expect(currentAgent).toHaveTextContent("执行智能体");
    expect(currentAgent).toHaveTextContent("下载固定版本数据并完成可复现审计");
    expect(currentAgent).toHaveTextContent("流程最新安排及其验收条件");
    expect(currentAgent).toHaveTextContent("正在验证数据版本和下载路径");
    expect(currentAgent).toHaveTextContent("生成非空 manifest");
  });

  it("presents normal harness stdout as a neutral Agent output", async () => {
    eventStreamMock.events = [{
      seq: 1,
      type: "agent.trace",
      agent: "execution",
      message: "External harness completed its handoff.",
      ts: "2026-07-31T04:00:00.000Z",
      data: { kind: "output", invocationId: "inv_stdout" }
    }];

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const title = await screen.findByText("智能体输出");
    expect(title.closest(".trace-event")).toHaveClass("trace-neutral");
    expect(screen.queryByText("运行诊断")).not.toBeInTheDocument();
  });

  it("shows the latest 1000 trace events by default and lets users change the limit", async () => {
    eventStreamMock.events = Array.from({ length: 1_205 }, (_, index) => {
      const seq = index + 1;
      return {
        seq,
        type: "workflow.tick",
        agent: seq % 2 === 0 ? "execution" : "main",
        message: `轨迹事件 ${seq}`,
        ts: new Date(Date.UTC(2026, 6, 31, 4, 0, seq)).toISOString()
      } satisfies AgentEvent;
    });
    const user = userEvent.setup();

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: project.title });
    const agentFilter = screen.getByLabelText("按智能体筛选");
    const displayLimit = screen.getByLabelText("显示最新轨迹条数");
    expect(agentFilter).toHaveValue("all");
    expect(displayLimit).toHaveValue("1000");
    expect(screen.getByText("显示最新 1,000 / 1,205 条")).toBeInTheDocument();
    expect(document.querySelectorAll(".trace-event")).toHaveLength(1_000);
    expect(screen.queryByText("轨迹事件 205")).not.toBeInTheDocument();
    expect(screen.getByText("轨迹事件 206")).toBeInTheDocument();
    expect(screen.getByText("轨迹事件 1205")).toBeInTheDocument();

    await user.selectOptions(displayLimit, "100");
    expect(document.querySelectorAll(".trace-event")).toHaveLength(100);
    expect(screen.queryByText("轨迹事件 1105")).not.toBeInTheDocument();
    expect(screen.getByText("轨迹事件 1106")).toBeInTheDocument();

    await user.selectOptions(agentFilter, "execution");
    expect(agentFilter).toHaveValue("execution");
    expect(document.querySelectorAll(".trace-event")).toHaveLength(100);
    expect(screen.queryByText("轨迹事件 1205")).not.toBeInTheDocument();
    expect(screen.getByText("轨迹事件 1204")).toBeInTheDocument();
    expect(screen.getByText("轨迹事件 1006")).toBeInTheDocument();
  });

  it("offers a project-level checkpoint resume action", async () => {
    const interrupted: Project = {
      ...project,
      status: "interrupted",
      phase: "execution:interrupted",
      interruptedAt: "2026-07-31T07:00:00.000Z",
      queuePosition: undefined,
      queueDepth: 0,
      agentProgress: {
        ...project.agentProgress,
        execution: { state: "interrupted", runs: 3 }
      },
      overallProgress: {
        ...project.overallProgress,
        label: "执行 Agent 运行中断，等待恢复"
      }
    };
    vi.mocked(getProject).mockResolvedValue(interrupted);
    const user = userEvent.setup();

    render(<WorkspacePage projectId={interrupted.id} onBack={vi.fn()} />);

    expect(
      await screen.findByRole("region", { name: "项目断点恢复" })
    ).toHaveTextContent("执行智能体运行时被中断");
    expect(screen.getAllByText("待恢复").length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: "一键恢复科研流程" })
    );

    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(
        interrupted.id,
        "resume"
      )
    );
  });

  it("explains exhausted Gateway Session recovery and lets the user retry", async () => {
    const gatewayRecovery: Project = {
      ...project,
      status: "paused",
      phase: "gateway-recovery-required",
      queuedAgent: "main",
      error: "Gateway continued to return invalid JSON tool arguments after one automatic Session recovery",
      queuePosition: undefined,
      queueDepth: 0,
      overallProgress: {
        ...project.overallProgress,
        label: "网关工具参数异常，等待重新尝试"
      }
    };
    vi.mocked(getProject).mockResolvedValue(gatewayRecovery);
    const user = userEvent.setup();

    render(<WorkspacePage projectId={gatewayRecovery.id} onBack={vi.fn()} />);

    const banner = await screen.findByRole("region", { name: "网关恢复" });
    expect(banner).toHaveTextContent("网关工具参数连续异常");
    expect(banner).toHaveTextContent("系统已自动更换一次同 Harness Session");
    expect(banner).toHaveTextContent("保留项目上下文与现有成果");
    expect(document.body).toHaveTextContent("网关工具参数异常，等待重新尝试");

    await user.click(within(banner).getByRole("button", { name: "重新尝试" }));
    await waitFor(() =>
      expect(projectAction).toHaveBeenCalledWith(gatewayRecovery.id, "resume")
    );
  });

  it("shows a Main intervention request and sends the user reply back to Main", async () => {
    const waiting: Project = {
      ...project,
      status: "paused",
      phase: "user-intervention-required",
      queuedAgent: "main",
      agentProgress: {
        ...project.agentProgress,
        main: { state: "paused", runs: 3 }
      },
      overallProgress: {
        ...project.overallProgress,
        label: "系统调度等待用户介入"
      },
      userIntervention: {
        id: "usr_test",
        status: "pending",
        requestedAt: "2026-07-31T08:00:00.000Z",
        message: "请在外部终端完成 GitHub 登录，然后确认结果。",
        rationale: "只有用户可以授权 GitHub 账号。",
        successCriteria: ["确认 GitHub 登录成功。"]
      }
    };
    const answered: Project = {
      ...waiting,
      status: "queued",
      phase: "main:queued",
      userIntervention: {
        ...waiting.userIntervention!,
        status: "answered",
        answeredAt: "2026-07-31T08:05:00.000Z",
        response: "已完成登录，请重新检查。"
      }
    };
    vi.mocked(getProject)
      .mockReset()
      .mockResolvedValueOnce(waiting)
      .mockResolvedValue(answered);
    vi.mocked(respondToUserIntervention).mockResolvedValue(answered);
    const user = userEvent.setup();

    render(<WorkspacePage projectId={waiting.id} onBack={vi.fn()} />);

    const intervention = await screen.findByRole("region", {
      name: "用户介入请求"
    });
    expect(intervention).toHaveTextContent(
      "请在外部终端完成 GitHub 登录，然后确认结果。"
    );
    expect(
      screen.queryByRole("button", { name: "继续" })
    ).not.toBeInTheDocument();

    await user.type(
      screen.getByLabelText("回复流程"),
      "已完成登录，请重新检查。"
    );
    await user.click(
      screen.getByRole("button", { name: "回复并继续科研流程" })
    );

    await waitFor(() =>
      expect(respondToUserIntervention).toHaveBeenCalledWith(
        waiting.id,
        "已完成登录，请重新检查。"
      )
    );
  });

  it("queues proactive project requirements for the next Main invocation", async () => {
    const updated: Project = {
      ...project,
      userInputs: [
        {
          id: "inp_test",
          status: "pending",
          createdAt: "2026-07-31T12:00:00.000Z",
          message: "新增不同训练数据规模下的消融实验。",
          targetMainInvocation: 4
        }
      ]
    };
    vi.mocked(addProjectUserInput).mockResolvedValue(updated);
    const user = userEvent.setup();

    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    const panel = await screen.findByRole("region", {
      name: "项目主动需求输入"
    });
    expect(panel).toHaveTextContent("不中断正在工作的 Agent");
    await user.type(
      screen.getByLabelText("补充要求、调整方向或添加约束"),
      "新增不同训练数据规模下的消融实验。"
    );
    await user.click(
      screen.getByRole("button", { name: "提交给 main" })
    );

    await waitFor(() =>
      expect(addProjectUserInput).toHaveBeenCalledWith(
        project.id,
        "新增不同训练数据规模下的消融实验。"
      )
    );
    expect(await screen.findByText("待投递 1 条")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "将在下一次 main 调度时自动送达"
    );
  });

  it("explains that input submitted during Main refreshes its live context", async () => {
    const runningMain: Project = {
      ...project,
      status: "running",
      phase: "main:running",
      currentAgent: "main",
      queuedAgent: undefined,
      userInputs: []
    };
    const updated: Project = {
      ...runningMain,
      userInputs: [
        {
          id: "inp_live_main",
          status: "pending",
          createdAt: "2026-08-03T05:00:00.000Z",
          message: "立即把鲁棒性限制纳入当前判断。",
          targetMainInvocation: 5
        }
      ]
    };
    vi.mocked(getProject).mockResolvedValue(runningMain);
    vi.mocked(addProjectUserInput).mockResolvedValue(updated);
    const user = userEvent.setup();

    render(<WorkspacePage projectId={runningMain.id} onBack={vi.fn()} />);

    const panel = await screen.findByRole("region", {
      name: "项目主动需求输入"
    });
    expect(panel).toHaveTextContent("直接进入新一轮工作上下文");
    await user.type(
      screen.getByLabelText("补充要求、调整方向或添加约束"),
      "立即把鲁棒性限制纳入当前判断。"
    );
    await user.click(
      screen.getByRole("button", { name: "提交给 main" })
    );

    await waitFor(() =>
      expect(addProjectUserInput).toHaveBeenCalledWith(
        runningMain.id,
        "立即把鲁棒性限制纳入当前判断。"
      )
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "包含该输入的新上下文重新启动"
    );
  });

  it("loads only direct workspace children and opens folders on demand", async () => {
    vi.mocked(getArtifactSummary).mockResolvedValue({
      groups: { idea: 3, main: 0, execution: 0, writing: 0, review: 0 },
      total: 3
    });
    vi.mocked(getArtifactDirectory).mockImplementation(
      async (_projectId, options) =>
        options.directory === "results"
          ? {
              agent: "idea",
              directory: "results",
              parent: "",
              entries: [
                {
                  type: "file",
                  path: "results/metrics.json",
                  name: "metrics.json",
                  kind: "text",
                  agent: "idea",
                  origin: "workspace",
                  size: 17,
                  mediaType: "application/json"
                }
              ],
              offset: 0,
              limit: 50,
              total: 1,
              hasMore: false
            }
          : {
              agent: "idea",
              directory: "",
              entries: [
                {
                  type: "directory",
                  path: "results",
                  name: "results",
                  kind: "text",
                  agent: "idea",
                  origin: "workspace"
                },
                {
                  type: "file",
                  path: "proposal.md",
                  name: "proposal.md",
                  kind: "markdown",
                  agent: "idea",
                  origin: "workspace",
                  size: 24,
                  mediaType: "text/markdown"
                }
              ],
              offset: 0,
              limit: 50,
              total: 2,
              hasMore: false
            }
    );
    const user = userEvent.setup();
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);

    await user.click(await screen.findByRole("tab", { name: /研究产物/ }));
    await waitFor(() =>
      expect(getArtifactDirectory).toHaveBeenCalledWith(project.id, {
        scope: "project",
        directory: "",
        offset: 0,
        limit: 50
      })
    );
    expect(screen.getAllByText("proposal.md")).toHaveLength(2);
    expect(screen.queryByText("metrics.json")).not.toBeInTheDocument();

    await user.click(screen.getByTitle("打开文件夹 results"));
    await waitFor(() =>
      expect(getArtifactDirectory).toHaveBeenLastCalledWith(project.id, {
        scope: "project",
        directory: "results",
        offset: 0,
        limit: 50
      })
    );
    expect(await screen.findByText("metrics.json")).toBeInTheDocument();
    expect(screen.queryByText("proposal.md")).not.toBeInTheDocument();
    expect(getArtifactPage).not.toHaveBeenCalled();
  });

  it("refreshes an open artifact directory after a Git projection publishes its first file", async () => {
    const user = userEvent.setup();
    const view = render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: /研究产物/ }));
    await screen.findByText("当前文件夹为空。");
    vi.mocked(getArtifactSummary).mockResolvedValue({ groups: { idea: 1 }, total: 1 });
    vi.mocked(getArtifactDirectory).mockResolvedValue({ agent: "idea", directory: "", entries: [{ type: "file", path: "accepted.md", name: "accepted.md", kind: "markdown", agent: "idea" }], offset: 0, limit: 50, total: 1, hasMore: false });
    vi.mocked(getProject).mockResolvedValue({ ...project, artifacts: [{ id: "new-publication", path: "accepted.md", name: "accepted.md", kind: "markdown", agent: "idea" }] });
    eventStreamMock.events = [{ projectId: project.id, seq: 1, type: "collaboration.project.updated", agent: "idea", message: "Git publication projected", ts: "2026-10-13T12:00:00Z" }];
    view.rerender(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    // Full snapshots coalesce at two seconds; live Agent status stays immediate.
    await waitFor(() => expect(screen.getAllByText("accepted.md")).toHaveLength(2), { timeout: 3_000 });
    await waitFor(() => expect(getArtifactDirectory).toHaveBeenLastCalledWith(project.id, expect.objectContaining({ scope: "project", directory: "" })));
  });

  it("reloads directory contents when a publication changes without changing its file count", async () => {
    vi.mocked(getArtifactSummary).mockResolvedValue({ groups: { idea: 1 }, total: 1 });
    vi.mocked(getArtifactDirectory).mockResolvedValue({ agent: "idea", directory: "", entries: [{ type: "file", path: "old.md", name: "old.md", kind: "markdown", agent: "idea" }], offset: 0, limit: 50, total: 1, hasMore: false });
    const user = userEvent.setup(), view = render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: /研究产物/ }));
    await screen.findAllByText("old.md");
    vi.mocked(getArtifactDirectory).mockResolvedValue({ agent: "idea", directory: "", entries: [{ type: "file", path: "updated.md", name: "updated.md", kind: "markdown", agent: "idea" }], offset: 0, limit: 50, total: 1, hasMore: false });
    eventStreamMock.events = [{ projectId: project.id, seq: 1, type: "artifact.published", agent: "idea", message: "Revised publication", ts: "2026-10-13T12:00:00Z" }];
    view.rerender(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    // Publication refreshes share the bounded background refresh interval.
    await waitFor(() => expect(screen.getAllByText("updated.md")).toHaveLength(2), { timeout: 3_000 });
    expect(screen.queryByText("old.md")).not.toBeInTheDocument();
  });

  it("offers shared workspace files even when no configured Agent is their producer", async () => {
    vi.mocked(getArtifactSummary).mockResolvedValue({ groups: { shared: 1 }, total: 1 });
    vi.mocked(getArtifactDirectory).mockResolvedValue({ agent: "shared", directory: "", entries: [{ type: "file", path: "shared.md", name: "shared.md", kind: "markdown", agent: "shared" }], offset: 0, limit: 50, total: 1, hasMore: false });
    vi.mocked(getArtifact).mockResolvedValue({ path: "shared.md", name: "shared.md", kind: "markdown", agent: "shared", content: "# Shared publication" });
    const user = userEvent.setup();
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: /研究产物/ }));
    expect(screen.queryByRole("tablist", { name: "按智能体筛选研究产物" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /shared\.md/ }));
    expect(await screen.findByRole("heading", { name: "Shared publication" })).toBeVisible();
    expect(getArtifact).toHaveBeenCalledWith(project.id, expect.objectContaining({ agent: "shared" }));
  });

  it("shows one file per path and lets the user read each Git workspace source", async () => {
    const primary = { id: "workspace:repository:report.md", path: "report.md", name: "report.md", kind: "markdown" as const,
      agent: "shared", workspaceId: "repository", workspaceLabel: "项目文件" };
    const working = { ...primary, id: "workspace:working:report.md", agent: "writer", workspaceId: `worktree_${"a".repeat(24)}`, workspaceLabel: "工作区 · writer" };
    const variants = [primary, working];
    vi.mocked(getArtifactDirectory).mockResolvedValue({ agent: "shared", directory: "", entries: [{ ...primary, variants, type: "file" }],
      offset: 0, limit: 50, total: 1, hasMore: false });
    vi.mocked(getArtifactSummary).mockResolvedValue({ groups: { shared: 1 }, total: 1 });
    vi.mocked(getArtifact).mockImplementation(async (_id, artifact) => ({ ...artifact,
      content: artifact.workspaceId === "repository" ? "# Project version" : "# Working version" }));
    const user = userEvent.setup();
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: /研究产物/ }));
    await user.click(await screen.findByRole("button", { name: /report\.md/ }));
    expect(await screen.findByRole("heading", { name: "Project version" })).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "选择文件来源" }), screen.getByRole("option", { name: "工作区 · writer" }));
    expect(await screen.findByRole("heading", { name: "Working version" })).toBeVisible();
    expect(getArtifact).toHaveBeenLastCalledWith(project.id, expect.objectContaining({ workspaceId: working.workspaceId }));
  });

  it("keeps the newer binary file source selected when an older preview finishes", async () => {
    const slow = { path: "slow.md", name: "slow.md", kind: "markdown" as const, workspaceId: "repository" };
    const primary = { id: "workspace:repository:results.zip", path: "results.zip", name: "results.zip", kind: "text" as const,
      mediaType: "application/zip", workspaceId: "repository", workspaceLabel: "项目文件" };
    const working = { ...primary, id: "workspace:working:results.zip", workspaceId: `worktree_${"a".repeat(24)}`, workspaceLabel: "工作区 · writer" };
    vi.mocked(getArtifactDirectory).mockResolvedValue({ agent: "shared", directory: "", entries: [
      { ...slow, type: "file" }, { ...primary, type: "file", variants: [primary, working] }
    ], offset: 0, limit: 50, total: 2, hasMore: false });
    let finishRead!: (value: Awaited<ReturnType<typeof getArtifact>>) => void;
    vi.mocked(getArtifact).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const user = userEvent.setup();
    render(<WorkspacePage projectId={project.id} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: /研究产物/ }));
    await user.click(await screen.findByRole("button", { name: /slow\.md/ }));
    await user.click(await screen.findByRole("button", { name: /results\.zip/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "选择文件来源" }), screen.getByRole("option", { name: "工作区 · writer" }));
    await act(async () => { finishRead({ ...slow, content: "# Stale preview" }); });
    expect(screen.queryByRole("heading", { name: "Stale preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "工作区 · writer" })).toHaveProperty("selected", true);
    expect(getArtifact).toHaveBeenCalledTimes(1);
  });

  it("accepts user input after completion and restarts Main with fresh termination and artifact gates", async () => {
    const completed: Project = {
      ...project,
      status: "completed",
      phase: "accepted",
      queuedAgent: undefined,
    };
    const reopened: Project = {
      ...completed,
      status: "queued",
      phase: "main:queued",
      queuedAgent: "main",
      cycle: 3,
      userInputs: [
        {
          id: "inp_reopen",
          status: "pending",
          createdAt: "2026-08-01T07:00:00.000Z",
          message: "新增一组鲁棒性实验。",
          targetMainInvocation: 7
        }
      ]
    };
    vi.mocked(getProject).mockResolvedValue(completed);
    vi.mocked(addProjectUserInput).mockResolvedValue(reopened);
    const user = userEvent.setup();

    render(<WorkspacePage projectId={completed.id} onBack={vi.fn()} />);

    const panel = await screen.findByRole("region", {
      name: "项目主动需求输入"
    });
    expect(panel).toHaveTextContent("历史结果仍可查看");
    expect(
      screen.getByRole("button", { name: "提交给 main" })
    ).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("补充要求、调整方向或添加约束"),
      "新增一组鲁棒性实验。"
    );
    await user.click(
      screen.getByRole("button", { name: "提交给 main" })
    );

    await waitFor(() =>
      expect(addProjectUserInput).toHaveBeenCalledWith(
        completed.id,
        "新增一组鲁棒性实验。"
      )
    );
    expect(await screen.findByText("待投递 1 条")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "科研流程已重新启动"
    );
    expect(panel).toHaveTextContent("历史结果仍可查看");
  });
});
