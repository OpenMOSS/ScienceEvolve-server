import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import { CollaborationGitFacade } from "../src/collaboration-git/facade.js";
import { executeAgentGitTool, type AgentGitFacts } from "../src/agent-git-tools.js";
import type { GitExecutionAuthority, GitHubRefFact, GitHubRepositoryFact } from "../src/collaboration-git/contracts.js";
import type { ControlActionEnvelope } from "../src/types.js";
import type { BeginTerminalPushObservationInput, TerminalPushObservationTurn } from "../src/collaboration-state/contracts.js";

const NOW = "2026-10-03T00:00:00.000Z";
const HEAD = "7".repeat(40);
const roots: string[] = [];
const databases: CollaborationStateDatabase[] = [];
afterEach(async () => {
  databases.splice(0).forEach(db => db.close());
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(kind: "legacy" | "scoped" = "legacy", original: "legacy" | "scoped" = "legacy") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-historical-push-")); roots.push(root);
  const databasePath = path.join(root, "state.sqlite");
  const database = CollaborationStateDatabase.open({ databasePath, serviceId: "history-test", instanceId: "a",
    hostId: "test-host", topology: "single-host", now: () => Date.parse(NOW) }); databases.push(database);
  const repository: GitHubRepositoryFact = { owner: "example", name: "retained", private: true,
    defaultBranch: "main", htmlUrl: "https://github.com/example/retained", observedAt: NOW };
  database.createProject({ projectId: "p", workflowRevision: 1, workerCapacity: 2,
    git: { enabled: true, status: "ready", repository: { ...repository, localPath: root } },
    workflowSnapshot: kind === "legacy" ? { schemaVersion: 2, collaborations: [{ id: "G", memberAgentIds: ["worker", "peer"] }] }
      : { schemaVersion: 3, agents: [{ name: "main" }, { name: "worker" }], collaborations: [{ id: "G" }],
        scopedWorkflow: { schemaVersion: 1, rootAgentIds: ["main"], groups: [{ id: "G", leaderAgentId: "main",
          allowLeaderReconfiguration: false, workflow: { nodes: [{ kind: "agent", nodeId: "G_worker", agentId: "worker" }],
            input: { source: "input", edges: [{ kind: "parallel", target: "G_worker" }] },
            routes: { G_worker: [{ kind: "strong", target: "finish" }] } } }] } } });
  const worktreePath = path.join(root, "git-worktrees", "agents", "worker"); await fs.mkdir(worktreePath, { recursive: true });
  const notePath = path.join(worktreePath, "original-memory.txt");
  await fs.writeFile(notePath, "Original native session memory and unfinished note.\n");
  let execution: GitExecutionAuthority;
  if (kind === "legacy") {
    database.activateGroup({ projectId: "p", nodeRunId: "node-G", groupRunId: "run-G", nodeId: "G", groupId: "G",
      activationRequestId: "activate-G", inputSnapshotRef: "input:p", memberAgentIds: ["worker", "peer"],
      origin: { kind: "main-direct" }, baseCommit: HEAD,
      groupBranch: "groups/run-G", workflowRevision: 1 });
    database.assignTasks({ projectId: "p", groupRunId: "run-G", actorAgentId: "main", coordinatorEpoch: 1,
      tasks: [{ id: "current-task", assigneeAgentId: "worker", assignment: "Current business task" }] });
    execution = database.claimNextTask({ projectId: "p", groupRunId: "run-G", agentId: "worker",
      executionId: "current-execution", executionBranch: "executions/current-execution", worktreePath,
      invocationId: "current-native-turn", sessionId: "original-worker-session" })!.execution;
  } else {
    const activated = database.activateScopedGroup({ projectId: "p", groupRunId: "run-G", groupId: "G",
      activationRequestId: "activate-G", workflowRevision: 1, baseCommit: HEAD,
      outer: { nodeRunId: "node-G", inputSnapshotRef: "input:p", activatedByAgentId: "main" } });
    execution = { ...database.claimScopedAgentArrival({ projectId: "p", arrivalRequestId: activated.arrivals[0]!.requestId,
      agentId: "worker", executionId: "current-execution", worktreePath })!.execution, purpose: "delivery" };
  }
  // This fixture represents a retained old-version journal, not a test-side
  // repair: production Facade and SQLite alone must confirm its receipt.
  const raw = new DatabaseSync(databasePath); raw.exec("PRAGMA foreign_keys=ON");
  let oldId = "old-execution";
  if (original === "legacy") {
    raw.prepare(`INSERT INTO node_runs(node_run_id,project_id,node_kind,node_id,agent_id,workflow_revision,
      activation_request_id,activation_payload_hash,input_snapshot_ref,activated_by_agent_id,status,activated_at,updated_at,completed_at)
      VALUES ('old-node','p','agent','worker','worker',1,'old-activation','old-hash','old-input','main','completed',?,?,?)`)
      .run(NOW, NOW, NOW);
    raw.prepare(`INSERT INTO work_tasks(task_id,node_run_id,assignment,queue_ordinal,purpose,status,created_at,updated_at,completed_at)
      VALUES ('old-task','old-node','Already completed original task',1,'delivery','succeeded',?,?,?)`).run(NOW, NOW, NOW);
    raw.prepare(`INSERT INTO member_executions(execution_id,project_id,node_run_id,task_id,agent_id,purpose,ownership_epoch,
      status,execution_branch,worktree_path,queued_at,started_at,updated_at,completed_at,process_stop_confirmed)
      VALUES ('old-execution','p','old-node','old-task','worker','delivery',2,'succeeded','executions/old-execution',?,?,?,?,?,1)`)
      .run(worktreePath, NOW, NOW, NOW, NOW);
  } else {
    oldId = execution.id;
    raw.prepare("UPDATE scoped_executions SET ownership_epoch=2 WHERE project_id='p' AND execution_id=?").run(execution.id);
    execution = { ...execution, ownershipEpoch: 2 };
  }
  const operationId = `push-${oldId}-original-epoch-1`;
  const table = original === "legacy" ? "operations" : "scoped_operations";
  const oldBranch = original === "legacy" ? "executions/old-execution" : execution.executionBranch;
  raw.prepare(`INSERT INTO ${table}(operation_id,project_id,kind,payload_hash,status,owner_execution_id,
    ownership_epoch,expected_head,expected_base,created_at,updated_at)
    VALUES (?,'p','git.push',?,'uncertain',?,1,?,?,?,?)`).run(operationId, "a".repeat(64), oldId, HEAD, oldBranch, NOW, NOW);
  const store = database.operationsForProject("p", kind === "scoped");
  const remote: GitHubRefFact = { owner: repository.owner, repository: repository.name,
    ref: oldBranch, status: "present", sha: HEAD, observedAt: NOW };
  const observe = vi.fn(async () => structuredClone(remote));
  const push = vi.fn(); const checkpoint = vi.fn(); const fastForward = vi.fn();
  const git = new CollaborationGitFacade({ operationStore: store,
    localGit: { projectId: "p", pushRetainedExecution: push, checkpoint, canFastForward: fastForward } as never,
    provider: { observeRef: observe } as never });
  const facts: AgentGitFacts = {};
  const call = (historical = true, retry?: boolean) => executeAgentGitTool({ git, repository, execution,
    base: "groups/run-G", facts, recordedOperation: id => database.recordedGitOperation("p", id),
    envelope: { projectId: "p", agent: "worker", invocationId: "current-native-turn", callId: "original-observation",
      stateVersion: execution.ownershipEpoch, receivedAt: NOW,
      action: { tool: "git_reconcile_push", operationId, historical, ...(retry === undefined ? {} : { retry }) } } as ControlActionEnvelope });
  return { root, raw, database, execution, operationId, oldId, oldBranch, table, store, repository,
    git, call, facts, remote, observe, push, checkpoint, fastForward, notePath };
}

describe("Agent-owned historical push observation", () => {
  it.each([["legacy", "legacy"], ["scoped", "legacy"], ["scoped", "scoped"]] as const)(
    "confirms an older owned receipt from a live %s caller (%s journal) without touching its tasks or Git", async (kind, original) => {
      const f = await fixture(kind, original);
      try {
        const before = f.database.projectState("p"); const originalRecord = f.database.recordedGitOperation("p", f.operationId)!;
        expect(await f.call()).toMatchObject({ status: "confirmed", historicalOwner: { executionId: f.oldId,
          ownershipEpoch: 1, agentId: "worker", executionBranch: f.oldBranch },
          operation: { ...originalRecord, status: "finalized", remoteFact: f.remote } });
        const after = f.database.projectState("p");
        expect(after.executions).toEqual(before.executions); expect(after.tasks).toEqual(before.tasks);
        expect(after.scopedExecutions).toEqual(before.scopedExecutions); expect(after.scopedArrivals).toEqual(before.scopedArrivals);
        expect(f.facts).toEqual({});
        expect(f.observe).toHaveBeenCalledWith(f.repository.owner, f.repository.name, f.oldBranch, undefined);
        expect(f.push).not.toHaveBeenCalled(); expect(f.checkpoint).not.toHaveBeenCalled(); expect(f.fastForward).not.toHaveBeenCalled();
        expect(await fs.readFile(f.notePath, "utf8")).toBe("Original native session memory and unfinished note.\n");
        await expect(f.store.assertExecutionOwnership({ projectId: "p", executionId: f.oldId, ownershipEpoch: 1,
          expectedBranch: f.oldBranch, operation: "provider.mutate" })).rejects.toThrow();
        const finalized = f.database.recordedGitOperation("p", f.operationId);
        f.remote.observedAt = "2026-10-03T00:01:00.000Z";
        expect(await f.call()).toMatchObject({ operation: finalized });
        expect(f.database.recordedGitOperation("p", f.operationId)).toEqual(finalized);
      } finally { f.raw.close(); }
    });

  it.each(["missing", "unknown", "moved", "provider-error", "foreign-ref"] as const)(
    "returns actual %s provider evidence without finalizing or replaying an old push", async mode => {
      const f = await fixture();
      try {
        const original = f.database.recordedGitOperation("p", f.operationId);
        if (mode === "missing" || mode === "unknown") { f.remote.status = mode; delete f.remote.sha; }
        if (mode === "moved") f.remote.sha = "b".repeat(40);
        if (mode === "foreign-ref") f.remote.ref = "executions/another-worker";
        if (mode === "provider-error") f.observe.mockRejectedValue(new Error("GitHub observation unavailable"));
        if (mode === "provider-error" || mode === "foreign-ref") await expect(f.call()).rejects.toThrow();
        else expect(await f.call()).toMatchObject({ status: "unconfirmed", remote: f.remote });
        expect(f.database.recordedGitOperation("p", f.operationId)).toEqual(original);
        expect(f.observe).toHaveBeenCalledTimes(1);
        expect(f.push).not.toHaveBeenCalled(); expect(f.facts).toEqual({});
      } finally { f.raw.close(); }
    });

  it.each(["wrong-agent", "future-record", "retry", "unrequested", "stopped-caller", "frozen", "revoked-during-io", "changed-during-io"] as const)(
    "rejects historical observation outside its exact authority (%s)", async mode => {
      const f = await fixture();
      try {
        if (mode === "wrong-agent") f.raw.exec("UPDATE member_executions SET agent_id='foreign' WHERE execution_id='old-execution'");
        if (mode === "future-record") f.raw.exec("UPDATE operations SET ownership_epoch=3 WHERE owner_execution_id='old-execution'");
        if (mode === "stopped-caller") f.raw.exec("UPDATE member_executions SET status='stopped' WHERE execution_id='current-execution'");
        if (mode === "frozen") f.database.freezeForMainFailure({ projectId: "p", groupRunId: "run-G", expectedFacts: {} });
        if (mode === "revoked-during-io" || mode === "changed-during-io") f.observe.mockImplementation(async () => {
          if (mode === "revoked-during-io") f.raw.exec("UPDATE member_executions SET ownership_epoch=2 WHERE execution_id='current-execution'");
          else f.raw.exec("UPDATE operations SET payload_hash='changed' WHERE owner_execution_id='old-execution'");
          return structuredClone(f.remote);
        });
        const original = f.database.recordedGitOperation("p", f.operationId);
        await expect(f.call(mode !== "unrequested", mode === "retry" ? true : undefined)).rejects.toThrow();
        if (mode !== "changed-during-io") expect(f.database.recordedGitOperation("p", f.operationId)).toEqual(original);
        else expect(f.database.recordedGitOperation("p", f.operationId)?.status).toBe("uncertain");
        expect(f.push).not.toHaveBeenCalled(); expect(f.facts).toEqual({});
        if (["revoked-during-io", "changed-during-io"].includes(mode)) expect(f.observe).toHaveBeenCalledTimes(1);
        else expect(f.observe).not.toHaveBeenCalled();
      } finally { f.raw.close(); }
    });

  it("preserves the current task's confirmed head while observing a separate old receipt", async () => {
    const f = await fixture();
    try {
      f.facts.pushedHeadSha = "d".repeat(40);
      const original = structuredClone(f.facts);
      expect(await f.call()).toMatchObject({ status: "confirmed" });
      expect(f.facts).toEqual(original);
    } finally { f.raw.close(); }
  });

  it("rejects a different project before requesting provider evidence", async () => {
    const f = await fixture();
    try {
      const original = f.database.recordedGitOperation("p", f.operationId);
      const foreign = new CollaborationGitFacade({ operationStore: f.store,
        localGit: { projectId: "another-project" } as never, provider: { observeRef: f.observe } as never });
      await expect(foreign.reconcilePushOperation({ repository: f.repository, execution: f.execution,
        ownershipEpoch: f.execution.ownershipEpoch, operationId: f.operationId, historical: true })).rejects.toThrow("another project");
      expect(f.observe).not.toHaveBeenCalled();
      expect(f.database.recordedGitOperation("p", f.operationId)).toEqual(original);
    } finally { f.raw.close(); }
  });

  it("returns an original failed receipt without inventing success or another provider operation", async () => {
    const f = await fixture();
    try {
      f.raw.exec("UPDATE operations SET status='failed' WHERE owner_execution_id='old-execution'");
      const original = f.database.recordedGitOperation("p", f.operationId);
      expect(await f.call()).toMatchObject({ status: "failed", operation: original });
      expect(f.observe).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
      expect(f.database.recordedGitOperation("p", f.operationId)).toEqual(original); expect(f.facts).toEqual({});
    } finally { f.raw.close(); }
  });
});

async function terminalFixture() {
  const f = await fixture();
  // Retained completed-version fixture: no live business or management owner.
  // The production supplement must leave all these old rows immutable.
  f.raw.exec(`UPDATE member_executions SET status='cancelled' WHERE execution_id='current-execution';
    UPDATE work_tasks SET status='cancelled' WHERE task_id='current-task';
    DELETE FROM lane_leases;
    UPDATE member_executions SET invocation_id='old-native-turn', session_id='original-worker-session'
      WHERE execution_id='old-execution'`);
  const reserveInput = (invocationId = "terminal-observation-1", previousInvocationId = "old-native-turn"): BeginTerminalPushObservationInput => ({
    projectId: "p", executionId: f.oldId, ownershipEpoch: 2, agentId: "worker", invocationId,
    operationId: f.operationId, originalInvocationId: "old-native-turn", previousInvocationId,
    previousRuntimePath: path.join(f.root, "runtime", previousInvocationId),
    runtimePath: path.join(f.root, "runtime", invocationId), residentStopConfirmed: true,
    evidence: { trustedSupervisor: true, exactOriginalNativeAbsent: true }
  });
  const execution: GitExecutionAuthority = { id: f.oldId, agentId: "worker", purpose: "delivery", ownershipEpoch: 2,
    executionBranch: f.oldBranch, worktreePath: path.join(f.root, "git-worktrees", "agents", "worker") };
  const call = (invocationId = "terminal-observation-1", action = { tool: "git_reconcile_push",
    operationId: f.operationId, historical: true } as ControlActionEnvelope["action"]) => executeAgentGitTool({
      git: f.git, repository: f.repository, execution, base: "main", facts: f.facts,
      recordedOperation: id => f.database.recordedGitOperation("p", id),
      envelope: { projectId: "p", agent: "worker", invocationId, callId: "original-terminal-observation",
        stateVersion: 2, receivedAt: NOW, action } });
  const open = (turn: TerminalPushObservationTurn) => f.database.markTerminalPushObservationOpened({ ...turn, nativeProcessOpened: true });
  const close = (turn: TerminalPushObservationTurn) => f.database.stopTerminalPushObservation({ ...turn,
    residentStopConfirmed: true, evidence: { exactSupplementNativeAbsent: true }, output: "Actual Agent receipt-only handoff." });
  return { ...f, execution, reserveInput, call, open, close };
}

describe("Finite original-session terminal push observation", () => {
  it.each([1, 2])("observes the original epoch-%s journal from the completed owner without reopening business", async originalEpoch => {
    const f = await terminalFixture();
    try {
      f.raw.prepare("UPDATE operations SET ownership_epoch=? WHERE operation_id=?").run(originalEpoch, f.operationId);
      const before = f.database.projectState("p"); const original = f.database.recordedGitOperation("p", f.operationId)!;
      const turn = f.database.beginTerminalPushObservation(f.reserveInput())!;
      expect(turn).toMatchObject({ status: "reserved", attempt: 1, ownershipEpoch: 2, originalInvocationId: "old-native-turn" });
      expect(f.database.projectState("p").runtimeActivities).toEqual([expect.objectContaining({
        invocationId: turn.invocationId, scopeKind: "terminal-push-observation", phase: "resident:starting" })]);
      expect(f.database.assertTerminalPushObservationLaunch({ ...turn, runtimePath: turn.runtimePath }))
        .toEqual({ previousRuntimePath: f.reserveInput().previousRuntimePath });
      f.open(turn);
      expect(f.database.projectState("p").runtimeActivities[0]).toMatchObject({ phase: "resident:running" });
      expect(await f.call()).toMatchObject({ status: "confirmed", historicalOwner: {
        executionId: f.oldId, ownershipEpoch: originalEpoch, observationInvocationId: turn.invocationId },
        operation: { ...original, status: "finalized", remoteFact: f.remote } });
      f.close(turn);
      const after = f.database.projectState("p");
      for (const key of ["executions", "tasks", "nodeRuns", "groupRuns", "routes", "pullRequests"] as const) {
        expect(after[key]).toEqual(before[key]);
      }
      expect(after.runtimeActivities).toEqual([]);
      expect(f.database.terminalPushObservationRepairCount("p", f.oldId)).toBe(1);
      expect(f.facts).toEqual({}); expect(f.observe).toHaveBeenCalledTimes(1);
      expect(f.push).not.toHaveBeenCalled(); expect(f.checkpoint).not.toHaveBeenCalled();
      expect(f.fastForward).not.toHaveBeenCalled();
      expect(await fs.readFile(f.notePath, "utf8")).toBe("Original native session memory and unfinished note.\n");
      for (const operation of ["checkpoint", "provider.mutate", "worktree.create", "memory.write", "merge.integrate"] as const) {
        await expect(f.store.assertExecutionOwnership({ projectId: "p", executionId: f.oldId, ownershipEpoch: 2,
          expectedBranch: f.oldBranch, operation })).rejects.toThrow();
      }
    } finally { f.raw.close(); }
  });

  it.each(["wrong-agent", "wrong-epoch", "wrong-original-native", "wrong-previous-native", "same-native", "wrong-runtime",
    "no-stop-proof", "empty-stop-proof", "wrong-operation", "wrong-original-branch", "future-journal", "unfinished-task"] as const)(
    "rejects an unauthorized reservation before any native or provider action (%s)", async mode => {
      const f = await terminalFixture();
      try {
        const input = f.reserveInput();
        if (mode === "wrong-agent") input.agentId = "another-agent";
        if (mode === "wrong-epoch") input.ownershipEpoch = 3;
        if (mode === "wrong-original-native") input.originalInvocationId = "another-native";
        if (mode === "wrong-previous-native") { input.previousInvocationId = "another-native"; input.previousRuntimePath = path.join(f.root, "runtime", "another-native"); }
        if (mode === "same-native") { input.invocationId = input.originalInvocationId; input.runtimePath = input.previousRuntimePath; }
        if (mode === "wrong-runtime") input.runtimePath = path.join(f.root, "other-runtime", input.invocationId);
        if (mode === "no-stop-proof") (input as unknown as Record<string, unknown>).residentStopConfirmed = false;
        if (mode === "empty-stop-proof") input.evidence = {};
        if (mode === "wrong-operation") input.operationId = "foreign-journal";
        if (mode === "wrong-original-branch") f.raw.exec("UPDATE operations SET expected_base='executions/foreign' WHERE owner_execution_id='old-execution'");
        if (mode === "future-journal") f.raw.exec("UPDATE operations SET ownership_epoch=3 WHERE owner_execution_id='old-execution'");
        if (mode === "unfinished-task") f.raw.exec("UPDATE work_tasks SET status='working' WHERE task_id='old-task'");
        const before = f.database.projectState("p");
        expect(() => f.database.beginTerminalPushObservation(input)).toThrow();
        expect(f.database.projectState("p")).toEqual(before);
        expect(f.database.terminalPushObservationTurns("p")).toEqual([]);
        expect(f.observe).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
      } finally { f.raw.close(); }
    });

  it.each(["before-open", "after-close", "another-invocation", "retry", "current-task-mode", "foreign-journal"] as const)(
    "does not grant old write authority or let another turn consume the receipt (%s)", async mode => {
      const f = await terminalFixture();
      try {
        const turn = f.database.beginTerminalPushObservation(f.reserveInput())!;
        if (mode !== "before-open") f.open(turn);
        if (mode === "after-close") f.close(turn);
        const original = f.database.recordedGitOperation("p", f.operationId);
        await expect(f.call(mode === "another-invocation" ? "another-invocation" : turn.invocationId,
          { tool: "git_reconcile_push", operationId: mode === "foreign-journal" ? "another-journal" : f.operationId,
            historical: mode !== "current-task-mode", ...(mode === "retry" ? { retry: true } : {}) })).rejects.toThrow();
        expect(f.database.recordedGitOperation("p", f.operationId)).toEqual(original);
        expect(f.observe).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
        expect(f.facts).toEqual({});
      } finally { f.raw.close(); }
    });

  it.each(["missing", "unknown", "moved", "provider-error", "revoked-during-io"] as const)(
    "preserves terminal completion and the unsettled journal for actual %s evidence", async mode => {
      const f = await terminalFixture();
      try {
        const before = f.database.projectState("p"); const original = f.database.recordedGitOperation("p", f.operationId);
        const turn = f.database.beginTerminalPushObservation(f.reserveInput())!; f.open(turn);
        if (mode === "missing" || mode === "unknown") { f.remote.status = mode; delete f.remote.sha; }
        if (mode === "moved") f.remote.sha = "b".repeat(40);
        if (mode === "provider-error") f.observe.mockRejectedValue(new Error("Actual provider failure"));
        if (mode === "revoked-during-io") f.observe.mockImplementation(async () => { f.close(turn); return f.remote; });
        if (mode === "provider-error" || mode === "revoked-during-io") await expect(f.call()).rejects.toThrow();
        else expect(await f.call()).toMatchObject({ status: "unconfirmed", remote: f.remote });
        expect(f.database.recordedGitOperation("p", f.operationId)).toEqual(original);
        const after = f.database.projectState("p");
        expect(after.executions).toEqual(before.executions); expect(after.tasks).toEqual(before.tasks);
        expect(f.push).not.toHaveBeenCalled(); expect(f.facts).toEqual({});
      } finally { f.raw.close(); }
    });

  it("defers behind existing business without consuming a wake and fences later business while reserved", async () => {
    const f = await terminalFixture();
    try {
      f.raw.exec("UPDATE member_executions SET status='working' WHERE execution_id='current-execution'");
      const busy = f.database.projectState("p");
      expect(f.database.beginTerminalPushObservation(f.reserveInput())).toBeUndefined();
      expect(f.database.projectState("p")).toEqual(busy);
      f.raw.exec("UPDATE member_executions SET status='cancelled' WHERE execution_id='current-execution'");
      const turn = f.database.beginTerminalPushObservation(f.reserveInput())!;
      f.database.assignTasks({ projectId: "p", groupRunId: "run-G", actorAgentId: "main", coordinatorEpoch: 1,
        tasks: [{ id: "next-peer-task", assigneeAgentId: "peer", assignment: "Future business work" }] });
      const reserved = f.database.projectState("p");
      expect(f.database.claimNextTask({ projectId: "p", groupRunId: "run-G", agentId: "peer", executionId: "next-peer-execution",
        executionBranch: "executions/next-peer-execution", worktreePath: path.join(f.root, "peer-worktree") })).toBeUndefined();
      expect(f.database.projectState("p")).toEqual(reserved);
      f.close(turn);
      expect(f.database.claimNextTask({ projectId: "p", groupRunId: "run-G", agentId: "peer", executionId: "next-peer-execution",
        executionBranch: "executions/next-peer-execution", worktreePath: path.join(f.root, "peer-worktree") })).toBeDefined();
    } finally { f.raw.close(); }
  });

  it("counts two physical supplements once and never uses replay or another journal to reset the budget", async () => {
    const f = await terminalFixture();
    try {
      const input = f.reserveInput(); const first = f.database.beginTerminalPushObservation(input)!;
      const reserved = f.database.projectState("p");
      expect(f.database.beginTerminalPushObservation(input)).toBeUndefined();
      expect(f.database.projectState("p")).toEqual(reserved);
      expect(() => f.database.beginTerminalPushObservation({ ...input, evidence: { changed: true } })).toThrow(/changed/);
      f.open(first); f.close(first);
      expect(() => f.database.beginTerminalPushObservation(f.reserveInput("terminal-observation-2"))).toThrow(/last exact stopped/);
      const second = f.database.beginTerminalPushObservation(f.reserveInput("terminal-observation-2", first.invocationId))!;
      expect(second.attempt).toBe(2); f.open(second); f.close(second);
      const complete = f.database.projectState("p");
      expect(f.database.beginTerminalPushObservation(f.reserveInput("terminal-observation-3", second.invocationId))).toBeUndefined();
      expect(f.database.terminalPushObservationRepairCount("p", f.oldId)).toBe(2);
      expect(f.database.projectState("p")).toEqual(complete);
      expect(f.observe).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
    } finally { f.raw.close(); }
  });

  it("revokes tools on freeze but still records actual physical closure without changing old completion", async () => {
    const f = await terminalFixture();
    try {
      const before = f.database.projectState("p");
      const turn = f.database.beginTerminalPushObservation(f.reserveInput())!; f.open(turn);
      f.database.freezeForMainFailure({ projectId: "p", groupRunId: "run-G", expectedFacts: {} });
      await expect(f.call()).rejects.toThrow();
      f.close(turn);
      const after = f.database.projectState("p");
      expect(after.runtimeActivities).toEqual([]);
      expect(after.executions).toEqual(before.executions); expect(after.tasks).toEqual(before.tasks);
      expect(f.observe).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
    } finally { f.raw.close(); }
  });

  it("retains the original automatic supplement count and spends only its remaining wake", async () => {
    const f = await terminalFixture();
    try {
      // Original persisted history, as in P28: one automatic supplement was
      // already consumed before the old successful task became terminal.
      f.raw.prepare(`INSERT INTO project_events(project_id,seq,event_id,request_id,execution_id,
        ownership_epoch,occurred_at,event_type,payload_json)
        SELECT 'p',next_event_seq,'old-mechanism-event','old-mechanism-request','old-execution',2,?,
          'execution.mechanism_repair.requested','{"attempt":1,"missing":["finish_task"]}'
          FROM project_heads WHERE project_id='p'`).run(NOW);
      f.raw.exec("UPDATE project_heads SET next_event_seq=next_event_seq+1 WHERE project_id='p'");
      const turn = f.database.beginTerminalPushObservation(f.reserveInput())!;
      expect(turn.attempt).toBe(2); f.open(turn); f.close(turn);
      const before = f.database.projectState("p");
      expect(f.database.beginTerminalPushObservation(f.reserveInput("terminal-observation-2", turn.invocationId))).toBeUndefined();
      expect(f.database.projectState("p")).toEqual(before);
      expect(f.database.terminalPushObservationRepairCount("p", f.oldId)).toBe(2);
    } finally { f.raw.close(); }
  });

  it("fences a prior writer until fresh physical-stop reconciliation and preserves its spent budget", async () => {
    const f = await terminalFixture();
    try {
      const first = f.database.beginTerminalPushObservation(f.reserveInput())!; f.open(first);
      const oldTasks = f.database.projectState("p").tasks;
      const nextWriterTime = Number((f.raw.prepare("SELECT expires_at_ms FROM writer_service_lease WHERE singleton=1").get() as { expires_at_ms: number }).expires_at_ms) + 1;
      f.database.close();
      const next = CollaborationStateDatabase.open({ databasePath: path.join(f.root, "state.sqlite"), serviceId: "history-test",
        instanceId: "next-writer", hostId: "test-host", topology: "single-host", now: () => nextWriterTime }); databases.push(next);
      expect(next.projectState("p").runtimeActivities[0]).toMatchObject({ leaseState: "recovering", invocationId: first.invocationId });
      expect(() => next.assertTerminalPushObservationLaunch({ ...first, runtimePath: first.runtimePath })).toThrow();
      const original = next.recordedGitOperation("p", f.operationId)!;
      expect(() => next.assertRetainedPushObservation({ projectId: "p", executionId: f.oldId, ownershipEpoch: 2,
        expectedBranch: f.oldBranch, operationId: f.operationId, payloadHash: original.payloadHash, invocationId: first.invocationId })).toThrow();
      expect(next.beginTerminalPushObservation(f.reserveInput("terminal-observation-2", first.invocationId))).toBeUndefined();
      expect(() => next.reconcileTerminalPushObservation({ ...first, priorWriterLeaseEpoch: first.writerLeaseEpoch + 99,
        residentStopConfirmed: true, evidence: { exactSupplementNativeAbsent: true } })).toThrow();
      next.reconcileTerminalPushObservation({ ...first, priorWriterLeaseEpoch: first.writerLeaseEpoch,
        residentStopConfirmed: true, evidence: { exactSupplementNativeAbsent: true } });
      expect(next.projectState("p").runtimeActivities).toEqual([]);
      const second = next.beginTerminalPushObservation(f.reserveInput("terminal-observation-2", first.invocationId))!;
      expect(second).toMatchObject({ attempt: 2, previousInvocationId: first.invocationId, writerLeaseEpoch: first.writerLeaseEpoch + 1 });
      expect(next.projectState("p").tasks).toEqual(oldTasks);
      expect(next.terminalPushObservationRepairCount("p", f.oldId)).toBe(2);
      expect(f.observe).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
    } finally { f.raw.close(); }
  });

  it("retains a completed scoped owner and native stop instead of creating legacy task rows", async () => {
    const f = await fixture("scoped", "scoped");
    try {
      const originalInvocationId = "original-scoped-native";
      f.database.beginScopedAgentTurn({ projectId: "p", executionId: f.oldId, ownershipEpoch: 2,
        invocationId: originalInvocationId, runtimePath: path.join(f.root, "runtime", originalInvocationId), baseCommit: HEAD });
      f.database.markScopedAgentTurnOpened({ projectId: "p", executionId: f.oldId, ownershipEpoch: 2,
        invocationId: originalInvocationId, nativeProcessOpened: true });
      f.database.stopScopedAgentTurn({ projectId: "p", executionId: f.oldId, ownershipEpoch: 2,
        invocationId: originalInvocationId, residentStopConfirmed: true });
      // An original completed scoped-version snapshot, with its exact native
      // proof already stored through the production lifecycle methods above.
      f.raw.exec("UPDATE scoped_executions SET status='completed'; UPDATE scoped_arrivals SET status='completed'; DELETE FROM lane_leases");
      const before = f.database.projectState("p"); const invocationId = "scoped-terminal-observation";
      const turn = f.database.beginTerminalPushObservation({ projectId: "p", executionId: f.oldId, ownershipEpoch: 2,
        agentId: "worker", operationId: f.operationId, originalInvocationId, previousInvocationId: originalInvocationId,
        previousRuntimePath: path.join(f.root, "runtime", originalInvocationId), runtimePath: path.join(f.root, "runtime", invocationId),
        invocationId, residentStopConfirmed: true, evidence: { trustedOriginalNativeAbsent: true } })!;
      f.database.markTerminalPushObservationOpened({ ...turn, nativeProcessOpened: true });
      const result = await executeAgentGitTool({ git: f.git, repository: f.repository, execution: f.execution,
        base: "groups/run-G", facts: f.facts, recordedOperation: id => f.database.recordedGitOperation("p", id),
        envelope: { projectId: "p", agent: "worker", invocationId, callId: "scoped-original-observation",
          stateVersion: 2, receivedAt: NOW, action: { tool: "git_reconcile_push", operationId: f.operationId, historical: true } } });
      expect(result).toMatchObject({ status: "confirmed", historicalOwner: { executionId: f.oldId,
        ownershipEpoch: 1, observationInvocationId: invocationId } });
      f.database.stopTerminalPushObservation({ ...turn, residentStopConfirmed: true, evidence: { trustedSupplementNativeAbsent: true } });
      const after = f.database.projectState("p");
      expect(after.scopedExecutions).toEqual(before.scopedExecutions); expect(after.scopedArrivals).toEqual(before.scopedArrivals);
      expect(after.executions).toEqual(before.executions); expect(after.tasks).toEqual(before.tasks);
      expect(f.database.scopedAgentTurn("p", f.oldId, 2)?.invocationId).toBe(originalInvocationId);
      expect(f.facts).toEqual({}); expect(f.push).not.toHaveBeenCalled();
    } finally { f.raw.close(); }
  });
});
