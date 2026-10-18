import { describe, expect, it } from "vitest";
import {
  assertCollaborationRoleOwner,
  deriveCollaborationLeaderAgentId,
  isConfiguredWorkflowNode,
  isValidCollaborationRoleOwner,
  workflowAgentCandidates,
  workflowOuterNodeIds,
  workflowOuterNodeRefs,
  workflowRoutesFor,
  workflowTargetAllowsTasklessActivation
} from "../src/agent-orchestration.js";
import type {
  AgentOrchestrationTemplateV2,
  CollaborationExecutionContext,
  ControlAction,
  GroupRun,
  MemberExecution,
  NodeRun,
  OperationRecord,
  PullRequestRecord,
  WorkTask
} from "../src/types.js";
import {
  createProjectSchema,
  savedResearchTaskInputSchema,
  normalizeAgentOrchestrationTemplate,
  normalizeProjectGitState
} from "../src/validation.js";
import { configRecommendationInputSchema } from "../src/config-recommendations.js";

function validCollaboration(): AgentOrchestrationTemplateV2 {
  return {
    schemaVersion: 2,
    agents: [
      { name: "main", template: "main" },
      { name: "caller", template: "general" },
      { name: "analyst", template: "idea" },
      { name: "builder", template: "execution" },
      { name: "reviewer", template: "review" }
    ],
    collaborations: [{
      id: "delivery_group",
      displayName: "Delivery group",
      memberAgentIds: ["analyst", "builder"],
      renamePolicy: "editable"
    }],
    input: { source: "input", target: "caller" },
    routes: {
      main: [{ target: "caller", kind: "weak" }],
      caller: [{ target: "delivery_group", kind: "strong" }],
      delivery_group: [{ target: "reviewer", kind: "strong" }],
      reviewer: [{ target: "finish", kind: "weak" }]
    },
    decisionPlans: {},
    allowUserIntervention: true,
    allowMainReconfiguration: false,
    termination: {
      agent: "reviewer",
      condition: "The integrated result has been reviewed.",
      decisionBy: "main",
      automatic: true
    }
  };
}

function createInput(orchestration: unknown, gitEnabled = true) {
  return {
    title: "Collaboration contract",
    requirement: "Exercise the frozen collaboration contract.",
    orchestration,
    git: { enabled: gitEnabled }
  };
}

describe("Git opt-in and collaboration dependency", () => {
  it.each([
    ["project creation", createProjectSchema],
    ["saved task", savedResearchTaskInputSchema],
    ["recommendation", configRecommendationInputSchema]
  ] as const)("%s allows Git without groups and requires it for groups", (_name, schema) => {
    for (const enabled of [false, true]) {
      const parsed = schema.parse(createInput(undefined, enabled));
      expect(parsed.git.enabled).toBe(enabled);
      expect(parsed.orchestration.collaborations).toEqual([]);
    }
    expect(schema.parse(createInput(validCollaboration(), true)).orchestration.collaborations).toHaveLength(1);
    expect(() => schema.parse(createInput(validCollaboration(), false))).toThrow("协作组要求启用 Git 机制");
  });
});

describe("OpenFARS collaboration contract v2", () => {
  it("normalizes one canonical outer-node projection and excludes members everywhere", () => {
    const parsed = createProjectSchema.parse(createInput(validCollaboration()));

    expect(parsed.orchestration.schemaVersion).toBe(2);
    expect(workflowOuterNodeIds(parsed.orchestration)).toEqual([
      "main",
      "caller",
      "delivery_group",
      "reviewer"
    ]);
    expect(workflowOuterNodeRefs(parsed.orchestration)).toEqual([
      { kind: "agent", nodeId: "main", agentId: "main" },
      { kind: "agent", nodeId: "caller", agentId: "caller" },
      { kind: "collaboration", nodeId: "delivery_group", groupId: "delivery_group" },
      { kind: "agent", nodeId: "reviewer", agentId: "reviewer" }
    ]);
    expect(parsed.orchestration.routes.main).toEqual([
      { target: "caller", kind: "weak" },
      { target: "delivery_group", kind: "weak" },
      { target: "reviewer", kind: "weak" }
    ]);
    expect(Object.keys(workflowRoutesFor(parsed.orchestration))).toEqual([
      "main",
      "caller",
      "delivery_group",
      "reviewer"
    ]);
    expect(workflowAgentCandidates(parsed.orchestration, "main")).not.toContain("analyst");
    expect(workflowAgentCandidates(parsed.orchestration, "main")).not.toContain("builder");
    expect(isConfiguredWorkflowNode(parsed.orchestration, "analyst")).toBe(false);
    expect(isConfiguredWorkflowNode(parsed.orchestration, "delivery_group")).toBe(true);
    expect(workflowTargetAllowsTasklessActivation(parsed.orchestration, "delivery_group")).toBe(true);
    expect(workflowTargetAllowsTasklessActivation(parsed.orchestration, "reviewer")).toBe(false);
  });

  it("normalizes an unversioned serial workflow without changing its legacy semantics", () => {
    const legacy = {
      agents: [
        { name: "main", template: "main" },
        { name: "researcher", template: "idea" },
        { name: "writer", template: "writing" }
      ],
      input: { source: "input" as const, target: "researcher" },
      routes: {
        main: [
          { target: "researcher", kind: "weak" as const },
          { target: "writer", kind: "weak" as const }
        ],
        researcher: [{ target: "writer", kind: "strong" as const }],
        writer: [{ target: "finish", kind: "weak" as const }]
      },
      decisionPlans: {},
      allowUserIntervention: true,
      termination: {
        agent: "writer",
        condition: "A final report exists.",
        decisionBy: "main" as const,
        automatic: true
      }
    };

    const normalized = normalizeAgentOrchestrationTemplate(legacy);
    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.collaborations).toEqual([]);
    expect(normalized.agents).toEqual(legacy.agents);
    expect(normalized.input).toEqual(legacy.input);
    expect(normalized.routes).toEqual(legacy.routes);
    expect(normalized.decisionPlans).toEqual(legacy.decisionPlans);
    expect(normalized.termination).toEqual(legacy.termination);
    expect(workflowOuterNodeIds(normalized)).toEqual(["main", "researcher", "writer"]);

    const project = createProjectSchema.parse({
      title: "Legacy serial",
      requirement: "Keep the serial path unchanged.",
      orchestration: legacy
    });
    expect(project.git).toEqual({ enabled: false });
  });

  it("derives leader identity and prevents leaders from owning delivery", () => {
    const orchestration = validCollaboration();
    const caller = { kind: "agent", nodeId: "caller", agentId: "caller" } as const;
    const sourceGroup = {
      kind: "collaboration",
      nodeId: "prior_group",
      groupId: "prior_group"
    } as const;

    expect(deriveCollaborationLeaderAgentId({ sourceNode: caller, activatedByAgentId: "caller" })).toBe("caller");
    expect(deriveCollaborationLeaderAgentId({ sourceNode: caller, activatedByAgentId: "main" })).toBe("main");
    expect(deriveCollaborationLeaderAgentId({ sourceNode: sourceGroup, activatedByAgentId: "main" })).toBe("main");
    expect(deriveCollaborationLeaderAgentId({ activatedByAgentId: "main" })).toBe("main");

    expect(isValidCollaborationRoleOwner(orchestration, {
      groupId: "delivery_group",
      leaderAgentId: "caller",
      agentId: "caller",
      role: "leader"
    })).toBe(true);
    expect(isValidCollaborationRoleOwner(orchestration, {
      groupId: "delivery_group",
      leaderAgentId: "caller",
      agentId: "analyst",
      role: "delivery"
    })).toBe(true);
    expect(isValidCollaborationRoleOwner(orchestration, {
      groupId: "delivery_group",
      leaderAgentId: "caller",
      agentId: "builder",
      role: "final-integration"
    })).toBe(true);
    expect(() => assertCollaborationRoleOwner(orchestration, {
      groupId: "delivery_group",
      leaderAgentId: "caller",
      agentId: "caller",
      role: "delivery"
    })).toThrow(/non-leader group member/i);
  });

  it("rejects every illegal membership and outer-route shape", () => {
    const cases: Array<[string, (value: AgentOrchestrationTemplateV2) => void, RegExp]> = [
      ["shared Agent/group id", (value) => { value.collaborations[0]!.id = "caller"; }, /唯一节点命名空间/],
      ["duplicate member ownership", (value) => {
        value.agents.splice(4, 0, { name: "tester", template: "general" });
        value.collaborations.push({ id: "second_group", displayName: "Second", memberAgentIds: ["builder", "tester"], renamePolicy: "locked" });
      }, /多个协作组/],
      ["duplicate member in one group", (value) => { value.collaborations[0]!.memberAgentIds[1] = "analyst"; }, /重复包含同一 Agent/],
      ["unknown member", (value) => { value.collaborations[0]!.memberAgentIds[1] = "missing"; }, /已配置的 Agent/],
      ["nested group", (value) => {
        value.agents.splice(4, 0, { name: "tester", template: "general" });
        value.collaborations.push({ id: "second_group", displayName: "Second", memberAgentIds: ["delivery_group", "tester"], renamePolicy: "locked" });
      }, /不能包含另一个协作组/],
      ["Main membership", (value) => { value.collaborations[0]!.memberAgentIds[0] = "main"; }, /Main 不能成为/],
      ["member route source", (value) => { value.routes.analyst = [{ target: "reviewer", kind: "strong" }]; }, /不能作为外层路由源/],
      ["member route target", (value) => { value.routes.caller = [{ target: "analyst", kind: "strong" }]; }, /不能指向协作组成员/],
      ["member Main candidate", (value) => { value.routes.main = [{ target: "builder", kind: "weak" }]; }, /Main 候选不能包含/],
      ["member input", (value) => { value.input.target = "analyst"; }, /输入目标不能指向/],
      ["member termination", (value) => { value.termination.agent = "builder"; }, /终止节点不能指向/],
      ["forbidden group goal", (value) => {
        (value.collaborations[0] as unknown as Record<string, unknown>).goalPrompt = "Do work";
      }, /Unrecognized key.*goalPrompt/],
      ["forbidden leader mode", (value) => {
        (value.collaborations[0] as unknown as Record<string, unknown>).leaderMode = "selectable";
      }, /Unrecognized key.*leaderMode/]
    ];

    for (const [label, mutate, diagnostic] of cases) {
      const invalid = validCollaboration();
      mutate(invalid);
      expect(
        () => createProjectSchema.parse(createInput(invalid)),
        label
      ).toThrow(diagnostic);
    }
  });

  it("requires explicit v2 versioning and Git opt-in for collaboration groups", () => {
    const gitOff = validCollaboration();
    expect(() => createProjectSchema.parse(createInput(gitOff, false))).toThrow(/要求启用 Git 机制/);

    const missingCollaborations = validCollaboration() as unknown as Record<string, unknown>;
    delete missingCollaborations.collaborations;
    expect(() => normalizeAgentOrchestrationTemplate(missingCollaborations)).toThrow(/v2 配置必须包含 collaborations/);

    const unversionedGroup = validCollaboration() as unknown as Record<string, unknown>;
    delete unversionedGroup.schemaVersion;
    expect(() => normalizeAgentOrchestrationTemplate(unversionedGroup)).toThrow(/必须显式声明 schemaVersion: 2/);

    expect(() => normalizeAgentOrchestrationTemplate({
      ...validCollaboration(),
      schemaVersion: 3
    })).toThrow(/v3 配置必须包含 scopedWorkflow/);
  });

  it("defaults omitted public Git state and rejects credential-bearing projections", () => {
    expect(normalizeProjectGitState(undefined)).toEqual({ enabled: false, status: "disabled" });
    expect(() => normalizeProjectGitState({
      enabled: true,
      status: "ready",
      provider: "github",
      token: "must-not-cross-public-boundary"
    })).toThrow(/Unrecognized key.*token/);
    expect(normalizeProjectGitState({
      enabled: true,
      status: "ready",
      provider: "github",
      repository: {
        owner: "octocat",
        name: "public-project",
        htmlUrl: "https://github.com/octocat/public-project",
        private: false,
        defaultBranch: "main",
        localPath: "/srv/openfars/projects/prj_1/repository"
      },
      branches: [{
        name: "executions/execution_1",
        head: "abc123",
        base: "groups/grun_1",
        ownerExecutionId: "execution_1",
        worktreePath: "/srv/openfars/projects/prj_1/git-worktrees/execution_1",
        status: "retained",
        retained: true,
        observedAt: "2026-09-23T00:00:00.000Z"
      }],
      commits: [{
        sha: "abc123",
        htmlUrl: "https://github.com/octocat/public-project/commit/abc123",
        message: "Deliver report",
        observedAt: "2026-09-23T00:00:00.000Z"
      }],
      blockers: ["waiting_for_github"],
      observedAt: "2026-09-23T00:00:00.000Z",
      capacity: {
        retainedWorktreeCount: 1,
        warningThreshold: 20
      }
    })).toMatchObject({
      status: "ready",
      repository: { name: "public-project", private: false },
      branches: [{ ownerExecutionId: "execution_1", retained: true }],
      capacity: { retainedWorktreeCount: 1 }
    });
    expect(() => normalizeProjectGitState({
      enabled: true,
      status: "ready",
      provider: "github",
      commits: [{ sha: "abc123", htmlUrl: "https://token@github.com/o/r/commit/abc123" }]
    })).toThrow(/无凭证 HTTPS URL/);
    expect(() => normalizeProjectGitState({ enabled: false, status: "ready" })).toThrow(/必须为 disabled/);
    expect(() => createProjectSchema.parse({
      title: "Credential rejection",
      requirement: "Never accept a provider credential in public project input.",
      git: { enabled: true, token: "must-not-enter-project-input" }
    })).toThrow(/Unrecognized key.*token/);
  });

  it("keeps runtime, execution-context, operation, and group-control identities separate", () => {
    const nodeRun: NodeRun = {
      id: "nr_1",
      node: { kind: "collaboration", nodeId: "delivery_group", groupId: "delivery_group" },
      workflowRevision: 3,
      activationRequestId: "activate_1",
      inputSnapshotRef: "messages/input.json",
      activatedByAgentId: "caller",
      status: "running"
    };
    const groupRun: GroupRun = {
      id: "gr_1",
      nodeRunId: nodeRun.id,
      memberSnapshot: ["analyst", "builder"],
      leaderAgentId: "caller",
      coordinatorEpoch: 1,
      baseCommit: "1".repeat(40),
      groupBranch: "groups/gr_1",
      integrationTarget: "main",
      taskIds: ["task_1"],
      status: "running"
    };
    const task: WorkTask = {
      id: "task_1",
      nodeRunId: nodeRun.id,
      groupRunId: groupRun.id,
      assignment: "Implement the accepted design.",
      assigneeAgentId: "builder",
      dependencyTaskIds: [],
      queueOrdinal: 1,
      currentExecutionId: "exec_1",
      status: "working"
    };
    const execution: MemberExecution = {
      id: "exec_1",
      nodeRunId: nodeRun.id,
      groupRunId: groupRun.id,
      taskId: task.id,
      agentId: "builder",
      purpose: "delivery",
      ownershipEpoch: 1,
      status: "pr_open",
      executionBranch: "executions/exec_1",
      worktreePath: "git-worktrees/exec_1",
      pullRequestId: "pr_1"
    };
    const pullRequest: PullRequestRecord = {
      id: "pr_1",
      providerNumber: 7,
      htmlUrl: "https://github.example/pull/7",
      head: execution.executionBranch,
      base: groupRun.groupBranch,
      ownerExecutionId: execution.id,
      status: "open",
      observedAt: "2026-09-22T00:00:00.000Z"
    };
    const operation: OperationRecord = {
      id: "op_1",
      kind: "pull.create",
      payloadHash: "sha256:payload",
      status: "observed",
      ownerExecutionId: execution.id,
      ownershipEpoch: execution.ownershipEpoch,
      expectedHead: pullRequest.head,
      expectedBase: pullRequest.base
    };
    const leaderContext: CollaborationExecutionContext = {
      nodeRunId: nodeRun.id,
      groupRunId: groupRun.id,
      role: "leader",
      coordinatorEpoch: 1
    };
    const deliveryContext: CollaborationExecutionContext = {
      nodeRunId: nodeRun.id,
      groupRunId: groupRun.id,
      taskId: task.id,
      executionId: execution.id,
      role: "delivery",
      ownershipEpoch: 1,
      coordinatorEpoch: 1,
      executionWorktree: execution.worktreePath
    };
    const completeGroup: ControlAction = {
      tool: "complete_group",
      groupRunId: groupRun.id,
      coordinatorEpoch: 1,
      output: "Integrated output"
    };

    expect(new Set([nodeRun.id, groupRun.id, task.id, execution.id, pullRequest.id, operation.id]).size).toBe(6);
    expect(nodeRun).not.toHaveProperty("optionalTask");
    expect(leaderContext).not.toHaveProperty("executionId");
    expect(deliveryContext.executionWorktree).toBe("git-worktrees/exec_1");
    expect(completeGroup.tool).toBe("complete_group");
    expect(completeGroup.tool).not.toBe("complete_project");
  });
});
