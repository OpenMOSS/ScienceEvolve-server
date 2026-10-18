import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import { agentGitOperationJournal, type AgentGitOperationRequest } from "../src/agent-git-operation-journal.js";
import { executeAgentGitTool } from "../src/agent-git-tools.js";
import type { AgentNativeSessionBinding } from "../src/collaboration-state/contracts.js";

const roots: string[] = [];
const databases: CollaborationStateDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-git-request-")); roots.push(root);
  let now = Date.parse("2026-10-09T00:00:00.000Z");
  const open = () => {
    const database = CollaborationStateDatabase.open({ databasePath: path.join(root, "state.sqlite"),
      serviceId: "request-fixture", instanceId: "original-writer", hostId: "fixture", topology: "single-host",
      leaseDurationMs: 1_000, now: () => now });
    databases.push(database); return database;
  };
  const database = open();
  database.createProject({ projectId: "project", workflowRevision: 1, workflowSnapshot: { schemaVersion: 2 },
    git: { enabled: false, status: "disabled" }, workerCapacity: 1 });
  const request: AgentGitOperationRequest = { operationId: "agent-git-task-epoch-2-original-create", projectId: "project",
    executionId: "task", ownershipEpoch: 2, executionBranch: "executions/task", integrationTarget: "groups/direct",
    repository: { owner: "team", name: "original" }, agentId: "worker", invocationId: "original-native-turn", callId: "original",
    requestedAt: "2026-10-09T00:00:00.000Z", expectedHead: "a".repeat(40),
    action: { tool: "github_create_pr", base: "groups/direct", title: "Original request", body: "Exact original body" } };
  const binding: AgentNativeSessionBinding = { projectId: "project", agentId: "worker", invocationId: request.invocationId,
    runtimePath: path.join(root, "runtime", request.invocationId), worktreePath: path.join(root, "worker"),
    session: { schemaVersion: 1, harnessId: "codex", adapterVersion: "4", generation: 0,
      nativeId: "01a1120a-d4a4-79b3-bae4-64b63dbfe2cd", durable: true, createdAt: request.requestedAt },
    executionContext: { role: "delivery", nodeRunId: "original-node", executionId: "task", ownershipEpoch: 2,
      executionWorktree: path.join(root, "worker") } };
  return { root, database, open, request, binding, advance: () => { now += 2_000; }, journal: agentGitOperationJournal(database, request.projectId) };
}

describe("Agent Git original request provenance", () => {
  it("retains separate original business and closing requests when the original Agent reuses its callId", async () => {
    const f = await fixture(); f.database.recordAgentNativeSessionBinding(f.binding);
    const original = f.journal.recordRequest(f.request);
    const invocationId = "closing-native-turn", capabilityHash = "c".repeat(64);
    const binding = { ...f.binding, invocationId, runtimePath: path.join(f.root, "runtime", invocationId) };
    f.database.recordAgentNativeSessionBinding(binding);
    const operationId = `agent-closing-git-${invocationId}-${f.request.executionId}-epoch-2-${f.request.callId}-create`;
    const git = { checkpointAndPush: vi.fn(), mergePullRequest: vi.fn(), createPullRequest: vi.fn(async () => {
      expect(f.journal.recordedRequest(operationId)).toMatchObject({ invocationId, callId: f.request.callId,
        expectedHead: "b".repeat(40), nativeBinding: binding, operationAlreadyExisted: false });
      return { id: "closing-pr", providerNumber: 2, owner: "team", repository: "original", head: f.request.executionBranch,
        base: f.request.integrationTarget, headSha: "b".repeat(40), ownerExecutionId: "task", status: "open" as const,
        htmlUrl: "https://github.com/team/original/pull/2", observedAt: f.request.requestedAt };
    }) };
    const input = { git, repository: { ...f.request.repository, private: true, defaultBranch: "main",
      htmlUrl: "https://github.com/team/original", observedAt: f.request.requestedAt },
      execution: { id: "task", agentId: "worker", ownershipEpoch: 2, purpose: "delivery" as const,
        executionBranch: f.request.executionBranch, worktreePath: binding.worktreePath, restrictedClosing: { invocationId, capabilityHash,
          scope: { kind: "bound-report-memory" as const, reportHeadSha: "a".repeat(40), paths: ["agent-memory/worker/Memory.md"] } } },
      base: f.request.integrationTarget, facts: { pushedHeadSha: "b".repeat(40) }, envelope: { projectId: "project", agent: "worker", invocationId,
        callId: f.request.callId, receivedAt: f.request.requestedAt, stateVersion: 2, capabilityHash, action: f.request.action }, ...f.journal };
    await executeAgentGitTool(input); await executeAgentGitTool(input);
    expect(git.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ operationId }));
    expect(f.journal.recordedRequest(f.request.operationId)).toEqual(original);
    expect(f.journal.recordedRequest(operationId)).toMatchObject({ invocationId, nativeBinding: binding });
    expect(f.database.eventsAfter("project").filter(event => event.type === "agent.git.operation.requested")).toHaveLength(2);
  });
  it("retains exact arguments/caller/native Session across writer close/reopen and later physical-turn replay", async () => {
    const f = await fixture(); f.database.recordAgentNativeSessionBinding(f.binding);
    const original = f.journal.recordRequest(f.request);
    expect(original).toMatchObject({ operationAlreadyExisted: false, nativeBinding: f.binding });
    f.database.close(); f.advance(); const reopened = f.open(); const journal = agentGitOperationJournal(reopened, "project");
    expect(journal.recordedRequest(f.request.operationId)).toEqual(original);
    expect(journal.recordRequest({ ...f.request, invocationId: "later-reconciliation-turn",
      requestedAt: "2026-10-10T00:00:00.000Z" })).toEqual(original);
    expect(reopened.eventsAfter("project").filter(event => event.type === "agent.git.operation.requested")).toHaveLength(1);
    expect(() => journal.recordRequest({ ...f.request, action: { ...f.request.action, body: "Changed body" } } as AgentGitOperationRequest))
      .toThrow("different payload");
    expect(journal.recordedRequest(f.request.operationId)?.invocationId).toBe(f.request.invocationId);
  });

  it("distinguishes a previously recorded historical operation from an originally captured request", async () => {
    const f = await fixture();
    const journal = agentGitOperationJournal({ eventByRequestId: f.database.eventByRequestId.bind(f.database),
      appendEvent: f.database.appendEvent.bind(f.database), recordedGitOperation: vi.fn(() => ({ id: f.request.operationId,
        kind: "pull.create", status: "uncertain", payloadHash: "b".repeat(64) })) }, "project");
    const recorded = journal.recordRequest(f.request);
    expect(recorded.operationAlreadyExisted).toBe(true);
    expect(recorded.nativeBinding).toBeUndefined();
    expect(recorded.invocationId).toBe(f.request.invocationId);
  });

  it.each(["agent", "invocation", "execution", "epoch", "role"] as const)("rejects a mismatching %s native binding", async field => {
    const f = await fixture();
    if (field === "agent") f.binding.agentId = "another-worker";
    if (field === "invocation") f.binding.invocationId = "another-native-turn";
    if (field === "execution") f.binding.executionContext = { ...f.binding.executionContext, executionId: "another-task" } as typeof f.binding.executionContext;
    if (field === "epoch") f.binding.executionContext = { ...f.binding.executionContext, ownershipEpoch: 3 } as typeof f.binding.executionContext;
    if (field === "role") f.binding.executionContext = { role: "leader", nodeRunId: "node", groupRunId: "group", coordinatorEpoch: 2 };
    // A malformed stored source is not rewritten or treated as current.
    f.database.appendEvent({ projectId: "project", agentId: "worker", invocationId: f.request.invocationId,
      requestId: `agent-native-binding:${f.request.invocationId}`, type: "agent.native_binding.opened", payload: { binding: f.binding } });
    expect(() => f.journal.recordRequest(f.request)).toThrow("exact native session binding");
    expect(f.journal.recordedRequest(f.request.operationId)).toBeUndefined();
  });

  it("records the original create request before the provider runs and keeps it after an uncertain result", async () => {
    const f = await fixture(); f.database.recordAgentNativeSessionBinding(f.binding);
    const git = { checkpointAndPush: vi.fn(), mergePullRequest: vi.fn(), createPullRequest: vi.fn(async () => {
      expect(f.journal.recordedRequest(f.request.operationId)).toMatchObject({ action: f.request.action,
        invocationId: f.request.invocationId, nativeBinding: f.binding });
      throw new Error("provider result unknown");
    }) };
    const invoke = () => executeAgentGitTool({ git, repository: { ...f.request.repository, private: true, defaultBranch: "main",
      htmlUrl: "https://github.com/team/original", observedAt: f.request.requestedAt },
      execution: { id: f.request.executionId, agentId: "worker", ownershipEpoch: 2, purpose: "delivery",
        executionBranch: f.request.executionBranch, worktreePath: f.binding.worktreePath }, base: f.request.integrationTarget,
      facts: { pushedHeadSha: f.request.expectedHead }, envelope: { projectId: "project", agent: "worker", invocationId: f.request.invocationId,
        callId: f.request.callId, receivedAt: f.request.requestedAt, stateVersion: 2, action: f.request.action }, ...f.journal });
    await expect(invoke()).rejects.toThrow("provider result unknown");
    expect(git.createPullRequest).toHaveBeenCalledOnce();
    expect(f.journal.recordedRequest(f.request.operationId)?.action).toEqual(f.request.action);
    const query = await executeAgentGitTool({ git,
      repository: { ...f.request.repository, private: true, defaultBranch: "main", htmlUrl: "https://github.com/team/original",
        observedAt: f.request.requestedAt },
      execution: { id: f.request.executionId, agentId: "worker", ownershipEpoch: 2, purpose: "delivery",
        executionBranch: f.request.executionBranch, worktreePath: f.binding.worktreePath }, base: f.request.integrationTarget,
      facts: {}, envelope: { projectId: "project", agent: "worker", invocationId: "later-query-turn", callId: "query-only",
        receivedAt: f.request.requestedAt, stateVersion: 2, action: { tool: "git_get_operation", operationId: f.request.operationId } },
      recordedOperation: () => ({ id: f.request.operationId, kind: "pull.create", status: "uncertain", payloadHash: "b".repeat(64),
        ownerExecutionId: "task", ownershipEpoch: 2, expectedHead: f.request.expectedHead, expectedBase: f.request.integrationTarget }),
      ...f.journal });
    expect(query).toMatchObject({ status: "outcome_unknown", request: { action: f.request.action,
      invocationId: f.request.invocationId, nativeBinding: f.binding } });
    expect(git.createPullRequest).toHaveBeenCalledOnce();
    f.database.close();
    await expect(invoke()).rejects.toThrow();
    expect(git.createPullRequest).toHaveBeenCalledOnce(); // Persistence failure cannot begin another mutation.
  });
});
