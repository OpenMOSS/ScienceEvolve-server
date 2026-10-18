import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { EventHub } from "../src/event-hub.js";
import { emptyProjectComputeUsage } from "../src/inspire-compute-usage.js";
import {
  CollaborationRuntimeCoordinator,
  type CollaborationGitRuntime,
  type CollaborationResidentLauncher
} from "../src/collaboration-runtime.js";
import { CollaborationStateDatabase, COLLABORATION_STATE_SCHEMA_VERSION } from "../src/collaboration-state/index.js";
import type {
  CollaborationGitFactoryOptions,
  GitHubPullRequestFact
} from "../src/collaboration-git/index.js";
import { ProjectStorage } from "../src/storage.js";
import type {
  ControlAction,
  ControlActionEnvelope,
  MemberExecution,
  ProjectGitState,
  ProjectState
} from "../src/types.js";
import { agentFixtureDelivery, agentFixtureRequests, agentFixtureLeaderResult } from "./helpers/agent-git-native-fixture.js";
import { defaultAgentConfigs } from "../src/validation.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

interface LegacyFixture {
  root: string;
  databasePath: string;
  storage: ProjectStorage;
  state: ProjectState;
  groupRunId: string;
  groupBranch: string;
  finalTaskId: string;
  repair: MemberExecution;
}

interface RuntimeTrace {
  opened: Array<{ role: string | undefined; executionId: string | undefined }>;
  workerSubmits: string[];
  leaderSubmits: string[];
  stoppedExecutions: Array<{ id: string; epoch: number }>;
  openedPulls: Array<{
    executionId: string;
    purpose: MemberExecution["purpose"];
    head: string;
    base: string;
  }>;
}

describe("CollaborationRuntimeCoordinator legacy v1 migration", () => {
  it("returns an exact migrated direct-main lost merge to its original Agent without another PR owner", async () => {
    const fixture = await seedLegacyFinalRepair("trusted-operation");
    const trace = runtimeTrace();
    const remotePull = pullFact({
      providerNumber: 702,
      repositoryName: fixture.state.git!.repository!.name,
      execution: fixture.repair,
      base: "main",
      headSha: "c".repeat(40),
      status: "merged",
      mergeCommitSha: "d".repeat(40)
    });
    const coordinator = new CollaborationRuntimeCoordinator({
      storage: fixture.storage,
      databasePath: fixture.databasePath,
      serviceId: "legacy-runtime-trusted",
      hostId: "host-test",
      leaseDurationMs: 5_000,
      gitFactory: (options) => recoveryGit(options, fixture, trace, remotePull),
      residentLauncher: recoveryResidents(fixture, trace, () => coordinator)
    });
    await coordinator.initialize();
    try {
    expect(migrationFacts(fixture.databasePath)).toEqual({ version: COLLABORATION_STATE_SCHEMA_VERSION, markers: 1 });

    expect(await coordinator.recoverProject(fixture.state)).toBe(true);
    await waitFor(() => fixture.state.status === "completed" || Boolean(fixture.state.lastError));
    await coordinator.shutdown();
    expect(fixture.state.lastError, JSON.stringify({ lastError: fixture.state.lastError,
      executions: fixture.state.executions, tasks: fixture.state.tasks, groups: fixture.state.groupRuns,
      opened: trace.opened, workers: trace.workerSubmits, leaderPrompts: trace.leaderSubmits,
      pulls: fixture.state.pullRequests })).toBeUndefined();

    const repaired = fixture.state.executions?.find((execution) =>
      execution.id === fixture.repair.id
    );
    expect(repaired).toMatchObject({
      ownershipEpoch: fixture.repair.ownershipEpoch + 1,
      status: "succeeded",
      executionBranch: fixture.repair.executionBranch
    });
    expect(fixture.state.executions).toHaveLength(3);
    expect(fixture.state.executions?.some((execution) =>
      execution.predecessorExecutionId === fixture.repair.id
    )).toBe(false);
    expect(fixture.state.pullRequests?.find((pull) =>
      pull.ownerExecutionId === fixture.repair.id
    )).toMatchObject({ id: "pull-702", status: "merged", base: "main" });
    expect(fixture.state.groupRuns?.[0]).toMatchObject({
      status: "completed",
      integrationOwnerExecutionId: fixture.repair.id,
      finalPullRequestId: "pull-702"
    });
    expect(trace.stoppedExecutions).toEqual([{
      id: fixture.repair.id,
      epoch: fixture.repair.ownershipEpoch
    }]);
    expect(trace.opened.filter((entry) => entry.role !== "leader"))
      .toEqual([{ role: "final-integration", executionId: fixture.repair.id }]);
    expect(trace.workerSubmits).toEqual([fixture.repair.id]);
    expect(trace.openedPulls).toEqual([]);
    expect(trace.leaderSubmits).toHaveLength(1);
    } finally { await coordinator.shutdown(); }
  });

  it("routes an unmarked migrated repair through group branch before one fresh canonical main PR", async () => {
    const fixture = await seedLegacyFinalRepair("untrusted");
    const trace = runtimeTrace();
    const coordinator = new CollaborationRuntimeCoordinator({
      storage: fixture.storage,
      databasePath: fixture.databasePath,
      serviceId: "legacy-runtime-untrusted",
      hostId: "host-test",
      leaseDurationMs: 5_000,
      gitFactory: (options) => recoveryGit(options, fixture, trace),
      residentLauncher: recoveryResidents(fixture, trace, () => coordinator)
    });
    await coordinator.initialize();
    try {
    expect(migrationFacts(fixture.databasePath)).toEqual({ version: COLLABORATION_STATE_SCHEMA_VERSION, markers: 0 });

    expect(await coordinator.recoverProject(fixture.state)).toBe(true);
    await waitFor(() => fixture.state.status === "completed" || Boolean(fixture.state.lastError));
    await coordinator.shutdown();
    expect(fixture.state.lastError, JSON.stringify({ lastError: fixture.state.lastError,
      executions: fixture.state.executions, tasks: fixture.state.tasks, groups: fixture.state.groupRuns,
      opened: trace.opened, workers: trace.workerSubmits, leaderPrompts: trace.leaderSubmits,
      pulls: fixture.state.pullRequests })).toBeUndefined();

    expect(trace.stoppedExecutions).toEqual([{
      id: fixture.repair.id,
      epoch: fixture.repair.ownershipEpoch
    }]);
    expect(trace.openedPulls.map(({ purpose, head, base }) => ({ purpose, head, base })))
      .toEqual([
        {
          purpose: "final-integration",
          head: expect.stringMatching(/^executions\//),
          base: fixture.groupBranch
        },
        {
          purpose: "final-integration",
          head: fixture.groupBranch,
          base: "main"
        }
      ]);
    expect(trace.openedPulls[0]?.head).not.toBe(fixture.repair.executionBranch);
    expect(trace.openedPulls.filter((pull) => pull.base === "main")).toHaveLength(1);
    expect(trace.workerSubmits).toHaveLength(2);
    expect(trace.leaderSubmits).toHaveLength(3);

    const executions = fixture.state.executions ?? [];
    const repairSuccessor = executions.find((execution) =>
      execution.predecessorExecutionId === fixture.repair.id
    );
    const canonical = executions.find((execution) =>
      execution.predecessorExecutionId === repairSuccessor?.id
    );
    expect(repairSuccessor).toMatchObject({
      purpose: "final-integration",
      status: "succeeded",
      executionBranch: trace.openedPulls[0]?.head
    });
    expect(canonical).toMatchObject({
      purpose: "final-integration",
      status: "succeeded",
      executionBranch: fixture.groupBranch
    });
    expect(fixture.state.groupRuns?.[0]).toMatchObject({
      status: "completed",
      integrationOwnerExecutionId: canonical?.id,
      finalPullRequestId: fixture.state.pullRequests?.find((pull) =>
        pull.ownerExecutionId === canonical?.id
      )?.id
    });
    expect(fixture.state.executions).toHaveLength(5);
    } finally { await coordinator.shutdown(); }
  });
});

async function seedLegacyFinalRepair(
  mode: "trusted-operation" | "untrusted"
): Promise<LegacyFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openfars-legacy-runtime-${mode}-`));
  temporaryRoots.push(root);
  const storage = new ProjectStorage(root, new EventHub());
  await storage.initialize();
  const projectId = mode === "trusted-operation"
    ? "prj_70707070707070707070707070707070"
    : "prj_71717171717171717171717171717171";
  const state = projectState(projectId, storage, mode);
  await storage.createProject(state);
  const databasePath = path.join(root, "collaboration.sqlite");
  const database = CollaborationStateDatabase.open({
    databasePath,
    serviceId: `legacy-seed-${mode}`,
    instanceId: `legacy-seed-instance-${mode}`,
    hostId: "host-test",
    topology: "single-host",
    leaseDurationMs: 5_000
  });
  database.createProject({
    projectId,
    workflowRevision: 1,
    workflowSnapshot: state.orchestration,
    git: state.git!,
    workerCapacity: 3,
    managementCapacity: 1,
    requestId: `create-${projectId}`
  });
  const repository = repositoryFact(`legacy-runtime-${mode}`);
  database.prepareOperation(projectId, {
    id: `repository-${mode}`,
    kind: "repository.create",
    payloadHash: `repository-${mode}`,
    status: "prepared"
  });
  database.transitionOperation(projectId, {
    id: `repository-${mode}`,
    payloadHash: `repository-${mode}`,
    status: "observed",
    remoteFact: repository
  });
  database.transitionOperation(projectId, {
    id: `repository-${mode}`,
    payloadHash: `repository-${mode}`,
    status: "finalized",
    remoteFact: repository
  });
  const groupRunId = `legacy-group-${mode}`;
  const groupBranch = `groups/${groupRunId}`;
  const activated = database.activateGroup({
    projectId,
    nodeRunId: `legacy-node-${mode}`,
    groupRunId,
    nodeId: "legacy-team",
    groupId: "legacy-team",
    activationRequestId: `activate-${mode}`,
    inputSnapshotRef: `project:${projectId}:requirement`,
    optionalTask: "Recover the migrated final integration",
    memberAgentIds: ["idea", "execution", "writing"],
    origin: { kind: "project-input" },
    baseCommit: "a".repeat(40),
    groupBranch,
    workflowRevision: 1
  });
  database.assignTasks({
    projectId,
    groupRunId,
    actorAgentId: activated.groupRun.leaderAgentId,
    coordinatorEpoch: activated.groupRun.coordinatorEpoch,
    tasks: [{
      id: `legacy-delivery-task-${mode}`,
      assignment: "Seed the retained group branch",
      assigneeAgentId: "writing"
    }]
  });
  const delivery = database.claimNextTask({
    projectId,
    groupRunId,
    agentId: "writing",
    executionId: `legacy-delivery-${mode}`,
    executionBranch: `executions/legacy-delivery-${mode}`,
    worktreePath: path.join(
      storage.projectDir(projectId),
      "git-worktrees",
      `legacy-delivery-${mode}`
    ),
    invocationId: `inv_${"6".repeat(32)}`
  });
  if (!delivery) throw new Error("failed to seed legacy delivery");
  database.observePullRequest({
    projectId,
    executionId: delivery.execution.id,
    ownershipEpoch: delivery.execution.ownershipEpoch,
    pullRequest: pullFact({
      providerNumber: 700,
      repositoryName: repository.name,
      execution: delivery.execution,
      base: groupBranch,
      headSha: "b".repeat(40),
      status: "merged",
      mergeCommitSha: "b".repeat(40)
    })
  });
  database.completeExecution({
    projectId,
    executionId: delivery.execution.id,
    ownershipEpoch: delivery.execution.ownershipEpoch,
    output: "Legacy delivery complete"
  });
  const finalTaskId = `legacy-final-task-${mode}`;
  const canonical = database.startFinalIntegration({
    projectId,
    groupRunId,
    actorAgentId: activated.groupRun.leaderAgentId,
    coordinatorEpoch: activated.groupRun.coordinatorEpoch,
    ownerAgentId: "execution",
    taskId: finalTaskId,
    executionId: `legacy-canonical-${mode}`,
    assignment: "Publish the migrated group result",
    executionBranch: groupBranch,
    worktreePath: path.join(
      storage.projectDir(projectId),
      "git-worktrees",
      `legacy-canonical-${mode}`
    )
  });
  database.requestExecutionStop({
    projectId,
    executionId: canonical.execution.id,
    ownershipEpoch: canonical.execution.ownershipEpoch,
    reason: "legacy canonical failed"
  });
  database.appendEvent({
    projectId,
    groupRunId,
    taskId: finalTaskId,
    executionId: canonical.execution.id,
    ownershipEpoch: canonical.execution.ownershipEpoch,
    type: "execution.terminal_stop.prepared",
    payload: { transition: "handoff", checkpointCommit: "b".repeat(40) }
  });
  database.confirmExecutionStopped({
    projectId,
    executionId: canonical.execution.id,
    ownershipEpoch: canonical.execution.ownershipEpoch,
    stopped: true,
    evidence: { processGroupAbsent: true }
  });
  const invocationId = `inv_${mode === "trusted-operation" ? "7" : "8"}`.padEnd(36, mode === "trusted-operation" ? "7" : "8");
  const repair = database.handoffExecution({
    projectId,
    groupRunId,
    taskId: finalTaskId,
    predecessorExecutionId: canonical.execution.id,
    predecessorOwnershipEpoch: canonical.execution.ownershipEpoch,
    successorAgentId: "idea",
    successorExecutionId: `legacy-repair-${mode}`,
    successorBranch: `executions/legacy-repair-${mode}`,
    successorWorktreePath: path.join(
      storage.projectDir(projectId),
      "git-worktrees",
      `legacy-repair-${mode}`
    ),
    successorInvocationId: invocationId,
    residentLaunchProtocol: "trusted-supervisor-v1",
    actorAgentId: activated.groupRun.leaderAgentId,
    coordinatorEpoch: activated.groupRun.coordinatorEpoch
  }).successor;
  database.transitionExecutionStatus({
    projectId,
    executionId: repair.id,
    ownershipEpoch: repair.ownershipEpoch,
    status: "working",
    invocationId
  });
  database.appendEvent({
    projectId,
    groupRunId,
    taskId: finalTaskId,
    agentId: repair.agentId,
    executionId: repair.id,
    invocationId,
    ownershipEpoch: repair.ownershipEpoch,
    type: "execution.launch.started",
    payload: {
      worktreePath: repair.worktreePath,
      runtimePath: await storage.invocationRuntimePath(projectId, invocationId),
      residentLaunchProtocol: "trusted-supervisor-v1"
    }
  });
  database.relinquishWriterLease();
  database.close();

  downgradeCollaborationSchemaToV1(databasePath);
  if (mode === "trusted-operation") {
    seedLegacyLostCreateOperation(databasePath, repair);
  }
  return { root, databasePath, storage, state, groupRunId, groupBranch, finalTaskId, repair };
}

function projectState(
  id: string,
  storage: ProjectStorage,
  mode: "trusted-operation" | "untrusted"
): ProjectState {
  const now = new Date().toISOString();
  const zero = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    invocations: 0
  };
  const orchestration = cloneAgentOrchestrationTemplate();
  orchestration.collaborations = [{
    id: "legacy-team",
    displayName: "Legacy migration team",
    memberAgentIds: ["idea", "execution", "writing"],
    renamePolicy: "editable"
  }];
  orchestration.input = { source: "input", target: "legacy-team" };
  orchestration.routes = {
    ...orchestration.routes,
    "legacy-team": [{ target: "finish", kind: "strong" }]
  };
  const repositoryName = `legacy-runtime-${mode}`;
  const git: ProjectGitState = {
    enabled: true,
    status: "ready",
    provider: "github",
    repository: {
      owner: "fixture-owner",
      name: repositoryName,
      htmlUrl: `https://github.example/${repositoryName}`,
      private: true,
      defaultBranch: "main",
      localPath: path.join(storage.projectDir(id), "repository")
    }
  };
  return {
    id,
    title: "Legacy migration runtime proof",
    requirement: "Recover the migrated final integration safely.",
    status: "running",
    phase: "legacy-team:coordinating",
    createdAt: now,
    updatedAt: now,
    turn: 0,
    cycle: 1,
    eventSeq: 0,
    consecutiveFailures: 0,
    completionGeneration: 0,
    controlProtocol: "natural-language-tools-v1",
    runCounts: Object.fromEntries(orchestration.agents.map(({ name }) => [name, 0])),
    mainInvocationSeq: 0,
    agents: structuredClone(defaultAgentConfigs),
    orchestration,
    userInputs: [],
    tokenUsage: {
      ...zero,
      byAgent: Object.fromEntries(orchestration.agents.map(({ name }) => [name, { ...zero }]))
    },
    computeUsage: emptyProjectComputeUsage(),
    git,
    workflowRevision: 1
  };
}

function runtimeTrace(): RuntimeTrace {
  return {
    opened: [],
    workerSubmits: [],
    leaderSubmits: [],
    stoppedExecutions: [],
    openedPulls: []
  };
}

function recoveryResidents(
  fixture: LegacyFixture,
  trace: RuntimeTrace,
  coordinator: () => CollaborationRuntimeCoordinator
): CollaborationResidentLauncher {
  let leaderTurn = 0;
  return {
    async stopLeaderForRecovery() {
      return { stopped: true, evidence: { processGroupAbsent: true } };
    },
    async stopForRecovery(input) {
      trace.stoppedExecutions.push({
        id: input.execution.id,
        epoch: input.execution.ownershipEpoch
      });
      return { stopped: true, evidence: { processGroupAbsent: true } };
    },
    async open(input) {
      const context = input.request.executionContext;
      trace.opened.push({ role: context?.role, executionId: context?.executionId });
      return {
        async submit(turn) {
          if (context?.role !== "leader") {
            trace.workerSubmits.push(context?.executionId ?? "missing-execution");
            if (context?.executionId === fixture.repair.id) {
              const requested = await agentFixtureRequests(input, turn, [
                { tool: "github_get_pr", providerNumber: 702 },
                { tool: "github_merge_pr", providerNumber: 702, reason: "Original migrated Agent verifies its already-merged PR" },
                { tool: "finish_task", summary: "Original migrated Agent finished the retained delivery" }
              ]);
              expect(requested.results[0]).toMatchObject({ providerNumber: 702, status: "merged" });
              expect(requested.results[1]).toMatchObject({ providerNumber: 702, status: "merged" });
              return { handoff: "Recovered repair output", controlActions: requested.envelopes };
            }
            return agentFixtureDelivery(input, turn, { handoff: "Recovered repair output" }, coordinator());
          }
          leaderTurn += 1;
          trace.leaderSubmits.push(turn.prompt);
          let action: ControlAction;
          if (turn.prompt.includes("Arrange the continuation")) {
            action = {
              tool: "assign_group_tasks",
              groupRunId: context.groupRunId!,
              coordinatorEpoch: context.coordinatorEpoch!,
              tasks: [{
                taskId: fixture.finalTaskId,
                assignment: "Repair the group branch after an untrusted v1 attempt",
                assigneeAgentId: "writing"
              }]
            };
          } else if (turn.prompt.includes("Arrange the canonical group-to-main retry")) {
            action = {
              tool: "assign_group_tasks",
              groupRunId: context.groupRunId!,
              coordinatorEpoch: context.coordinatorEpoch!,
              tasks: [{
                taskId: fixture.finalTaskId,
                assignment: "Publish the repaired group branch to main",
                assigneeAgentId: "writing"
              }]
            };
          } else {
            action = {
              tool: "complete_group",
              groupRunId: context.groupRunId!,
              coordinatorEpoch: context.coordinatorEpoch!,
              output: "Legacy migration recovery completed"
            };
          }
          const fresh = await input.turnRequestFactory!({
            baseRequest: input.request,
            turn
          });
          const authority = await input.controlAuthorityFactory!({
            request: fresh.request,
            turn
          });
          const envelope: ControlActionEnvelope = {
            projectId: fixture.state.id,
            agent: fresh.request.agent,
            invocationId: turn.invocationId,
            callId: `legacy-call-${leaderTurn}`,
            stateVersion: authority.control.stateVersion,
            capabilityHash: authority.control.capabilityHash,
            receivedAt: new Date().toISOString(),
            action
          };
          return agentFixtureLeaderResult(input, turn, { handoff: "Legacy recovery leader action", controlActions: [envelope] });
        },
        async pause() {},
        async resume() {},
        async close() {}
      };
    }
  };
}

function recoveryGit(
  options: CollaborationGitFactoryOptions,
  fixture: LegacyFixture,
  trace: RuntimeTrace,
  discovered?: GitHubPullRequestFact
): CollaborationGitRuntime {
  let pullNumber = 800;
  let checkpointNumber = 0;
  const pulls = new Map<number, GitHubPullRequestFact>();
  if (discovered) pulls.set(discovered.providerNumber, structuredClone(discovered));
  return {
    async initialize() {
      throw new Error("ready migrated Git must not initialize again");
    },
    async beginGroup(request) {
      return {
        group: {
          groupRunId: request.groupRunId,
          branch: fixture.groupBranch,
          baseCommit: request.baseCommit
        },
        remote: {
          owner: request.repository.owner,
          repository: request.repository.name,
          ref: fixture.groupBranch,
          status: "present" as const,
          sha: request.baseCommit,
          observedAt: new Date().toISOString()
        }
      };
    },
    async observeRemoteRef(repository, ref) {
      return {
        owner: repository.owner,
        repository: repository.name,
        ref,
        status: "present" as const,
        sha: "a".repeat(40),
        observedAt: new Date().toISOString()
      };
    },
    async sessionBegin(execution) {
      await fs.mkdir(execution.worktreePath, { recursive: true });
      return {
        projectId: fixture.state.id,
        executionId: execution.id,
        ownershipEpoch: execution.ownershipEpoch,
        branch: execution.executionBranch,
        worktreePath: execution.worktreePath,
        head: "a".repeat(40),
        retained: true,
        observedAt: new Date().toISOString()
      };
    },
    async observeRetainedExecution(execution) {
      return {
        projectId: fixture.state.id,
        executionId: execution.id,
        ownershipEpoch: execution.ownershipEpoch,
        branch: execution.executionBranch,
        worktreePath: execution.worktreePath,
        head: "a".repeat(40),
        retained: true,
        observedAt: new Date().toISOString()
      };
    },
    async observeExecutionWorktree(execution) {
      return {
        projectId: fixture.state.id,
        executionId: execution.id,
        ownershipEpoch: execution.ownershipEpoch,
        branch: execution.executionBranch,
        worktreePath: execution.worktreePath,
        head: "a".repeat(40),
        retained: true,
        observedAt: new Date().toISOString(),
        pendingPaths: []
      };
    },
    async checkpointAndPush(request) {
      checkpointNumber += 1;
      const commitSha = checkpointNumber.toString(16).padStart(40, "0");
      return {
        checkpoint: {
          projectId: fixture.state.id,
          executionId: request.execution.id,
          ownershipEpoch: request.execution.ownershipEpoch,
          branch: request.execution.executionBranch,
          worktreePath: request.execution.worktreePath,
          head: commitSha,
          retained: true,
          observedAt: new Date().toISOString(),
          commitSha,
          changed: true
        },
        remote: {
          owner: request.repository.owner,
          repository: request.repository.name,
          ref: request.execution.executionBranch,
          status: "present" as const,
          sha: commitSha,
          observedAt: new Date().toISOString()
        }
      };
    },
    async createPullRequest(request) {
      pullNumber += 1;
      trace.openedPulls.push({
        executionId: request.execution.id,
        purpose: request.execution.purpose,
        head: request.execution.executionBranch,
        base: request.base
      });
      const pull = pullFact({
        providerNumber: pullNumber,
        repositoryName: request.repository.name,
        execution: request.execution,
        base: request.base,
        headSha: request.expectedHead,
        status: "open"
      });
      pulls.set(pullNumber, pull);
      return structuredClone(pull);
    },
    async observePullRequest(request) {
      return structuredClone(pulls.get(request.providerNumber));
    },
    async observePullRequestForExecution(request) {
      if (discovered?.ownerExecutionId === request.execution.id) {
        return structuredClone(discovered);
      }
      return undefined;
    },
    async reconcileMergedPullRequest(request) {
      const prior = pulls.get(request.providerNumber);
      if (!prior || prior.status !== "merged" || !prior.mergeCommitSha) {
        throw new Error(`fixture merged pull ${request.providerNumber} is missing`);
      }
      if (
        prior.headSha !== request.expectedHead ||
        prior.base !== request.expectedBase ||
        prior.mergeCommitSha !== request.expectedMergeCommitSha
      ) {
        throw new Error("fixture merged reconciliation identity changed");
      }
      return {
        ...structuredClone(prior),
        localSynchronization: {
          projectId: fixture.state.id,
          operationId: request.operationId,
          targetBranch: request.expectedBase,
          temporaryRef: `refs/openfars/reconcile/${request.execution.id}`,
          expectedSourceHead: request.expectedHead,
          mergeCommitSha: request.expectedMergeCommitSha,
          remoteHead: request.expectedMergeCommitSha,
          localHeadBefore: "a".repeat(40),
          localHeadAfter: request.expectedMergeCommitSha,
          status: "synchronized" as const,
          observedAt: new Date().toISOString()
        }
      };
    },
    async mergePullRequest(request) {
      const prior = pulls.get(request.providerNumber);
      if (!prior) throw new Error(`fixture pull ${request.providerNumber} is missing`);
      const merged: GitHubPullRequestFact = {
        ...prior,
        status: "merged",
        headSha: request.expectedHead,
        mergeCommitSha: "d".repeat(40),
        observedAt: new Date().toISOString()
      };
      pulls.set(request.providerNumber, merged);
      return this.reconcileMergedPullRequest({ ...request, expectedMergeCommitSha: merged.mergeCommitSha! });
    },
    async closePullRequest(request) {
      const prior = pulls.get(request.providerNumber);
      if (!prior) throw new Error(`fixture pull ${request.providerNumber} is missing`);
      const closed: GitHubPullRequestFact = {
        ...prior,
        status: "closed",
        observedAt: new Date().toISOString()
      };
      pulls.set(request.providerNumber, closed);
      return structuredClone(closed);
    },
    async prepareConflictResolution() {
      throw new Error("legacy migration fixture must not enter conflict repair");
    },
    async releaseFinalIntegrationWorktree() {
      return "a".repeat(40);
    },
    async releaseFailedFinalIntegrationWorktree() {
      return "a".repeat(40);
    }
  };
}

function pullFact(input: {
  providerNumber: number;
  repositoryName: string;
  execution: Pick<MemberExecution, "id" | "executionBranch">;
  base: string;
  headSha: string;
  status: GitHubPullRequestFact["status"];
  mergeCommitSha?: string;
}): GitHubPullRequestFact {
  return {
    id: `pull-${input.providerNumber}`,
    providerNumber: input.providerNumber,
    owner: "fixture-owner",
    repository: input.repositoryName,
    htmlUrl: `https://github.example/pulls/${input.providerNumber}`,
    head: input.execution.executionBranch,
    headSha: input.headSha,
    base: input.base,
    ownerExecutionId: input.execution.id,
    status: input.status,
    mergeable: true,
    checks: [],
    ...(input.mergeCommitSha ? { mergeCommitSha: input.mergeCommitSha } : {}),
    observedAt: new Date().toISOString()
  };
}

function repositoryFact(name: string) {
  return {
    provider: "github" as const,
    providerId: 1,
    owner: "fixture-owner",
    name,
    htmlUrl: `https://github.example/${name}`,
    cloneUrl: `https://github.example/${name}.git`,
    private: true as const,
    defaultBranch: "main" as const,
    observedAt: new Date().toISOString()
  };
}

function migrationFacts(databasePath: string): { version: number; markers: number } {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = database.prepare(
      "SELECT schema_version FROM collaboration_state_meta WHERE singleton = 1"
    ).get() as { schema_version: number };
    const markers = database.prepare(
      "SELECT count(*) AS count FROM legacy_v1_direct_main_markers"
    ).get() as { count: number };
    return { version: version.schema_version, markers: markers.count };
  } finally {
    database.close();
  }
}

function seedLegacyLostCreateOperation(databasePath: string, repair: MemberExecution): void {
  const database = new DatabaseSync(databasePath);
  const observedAt = new Date().toISOString();
  const headSha = "c".repeat(40);
  try {
    database.prepare(`
      INSERT INTO operations(
        operation_id, project_id, kind, payload_hash, status,
        owner_execution_id, ownership_epoch, expected_head, expected_base,
        created_at, updated_at
      ) VALUES (?, ?, 'git.push', ?, 'finalized', ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-runtime-push",
      "prj_70707070707070707070707070707070",
      "legacy-runtime-push-payload",
      repair.id,
      repair.ownershipEpoch,
      headSha,
      repair.executionBranch,
      observedAt,
      observedAt
    );
    database.prepare(`
      INSERT INTO operations(
        operation_id, project_id, kind, payload_hash, status,
        owner_execution_id, ownership_epoch, expected_head, expected_base,
        created_at, updated_at
      ) VALUES (?, ?, 'pull.create', ?, 'uncertain', ?, ?, ?, 'main', ?, ?)
    `).run(
      "legacy-runtime-pull-create",
      "prj_70707070707070707070707070707070",
      "legacy-runtime-pull-payload",
      repair.id,
      repair.ownershipEpoch,
      headSha,
      observedAt,
      observedAt
    );
  } finally {
    database.close();
  }
}

function downgradeCollaborationSchemaToV1(databasePath: string): void {
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys=OFF");
  legacy.exec("PRAGMA legacy_alter_table=ON");
  try {
    legacy.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS legacy_v1_direct_main_markers_no_update;
      DROP TRIGGER IF EXISTS legacy_v1_direct_main_markers_no_delete;
      DROP TABLE IF EXISTS legacy_v1_direct_main_markers;
      DROP INDEX IF EXISTS member_executions_one_active_per_group_member;
      DROP INDEX IF EXISTS member_executions_one_active_per_normal_member;
      DROP INDEX IF EXISTS member_executions_one_active_branch;
      ALTER TABLE member_executions RENAME TO member_executions_schema_v2;

      CREATE TABLE member_executions (
        execution_id TEXT PRIMARY KEY CHECK (length(execution_id) > 0),
        project_id TEXT NOT NULL,
        node_run_id TEXT NOT NULL,
        group_run_id TEXT,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
        purpose TEXT NOT NULL CHECK (purpose IN ('delivery', 'final-integration')),
        ownership_epoch INTEGER NOT NULL CHECK (ownership_epoch >= 1),
        status TEXT NOT NULL CHECK (status IN (
          'queued','working','waiting_authorization','waiting_review','pr_open',
          'resolving','merged','stop_requested','stopped','superseded',
          'succeeded','failed','cancelled'
        )),
        execution_branch TEXT NOT NULL CHECK (length(execution_branch) > 0),
        worktree_path TEXT NOT NULL CHECK (length(worktree_path) > 0),
        pull_request_id TEXT,
        invocation_id TEXT,
        session_id TEXT,
        predecessor_execution_id TEXT,
        successor_execution_id TEXT,
        process_stop_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (process_stop_confirmed IN (0, 1)),
        failure_reason TEXT,
        wait_reason TEXT,
        output TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (task_id, ownership_epoch),
        UNIQUE (project_id, execution_branch),
        UNIQUE (project_id, worktree_path),
        FOREIGN KEY (project_id) REFERENCES project_heads(project_id) ON DELETE RESTRICT,
        FOREIGN KEY (node_run_id) REFERENCES node_runs(node_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (group_run_id) REFERENCES group_runs(group_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (task_id) REFERENCES work_tasks(task_id) ON DELETE RESTRICT,
        FOREIGN KEY (pull_request_id)
          REFERENCES pull_requests(pull_request_id) DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (predecessor_execution_id) REFERENCES member_executions(execution_id) ON DELETE RESTRICT,
        FOREIGN KEY (successor_execution_id) REFERENCES member_executions(execution_id) ON DELETE RESTRICT
      ) STRICT;

      INSERT INTO member_executions(
        execution_id, project_id, node_run_id, group_run_id, task_id, agent_id,
        purpose, ownership_epoch, status, execution_branch, worktree_path,
        pull_request_id, invocation_id, session_id, predecessor_execution_id,
        successor_execution_id, process_stop_confirmed, failure_reason,
        wait_reason, output, queued_at, started_at, updated_at, completed_at
      )
      SELECT
        execution_id, project_id, node_run_id, group_run_id, task_id, agent_id,
        purpose, ownership_epoch, status, execution_branch, worktree_path,
        pull_request_id, invocation_id, session_id, predecessor_execution_id,
        successor_execution_id, process_stop_confirmed, failure_reason,
        wait_reason, output, queued_at, started_at, updated_at, completed_at
      FROM member_executions_schema_v2;
      DROP TABLE member_executions_schema_v2;

      CREATE UNIQUE INDEX member_executions_one_active_per_group_member
        ON member_executions(group_run_id, agent_id)
        WHERE group_run_id IS NOT NULL AND status IN (
          'queued','working','waiting_authorization','waiting_review',
          'pr_open','resolving','merged','stop_requested'
        );
      CREATE UNIQUE INDEX member_executions_one_active_per_normal_member
        ON member_executions(node_run_id, agent_id)
        WHERE group_run_id IS NULL AND status IN (
          'queued','working','waiting_authorization','waiting_review',
          'pr_open','resolving','merged','stop_requested'
        );
      UPDATE collaboration_state_meta SET schema_version = 1 WHERE singleton = 1;
      COMMIT;
    `);
  } finally {
    legacy.exec("PRAGMA legacy_alter_table=OFF");
    legacy.exec("PRAGMA foreign_keys=ON");
  }
  try {
    if (legacy.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("runtime legacy fixture contains invalid foreign keys");
    }
  } finally {
    legacy.close();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for legacy migration recovery");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
