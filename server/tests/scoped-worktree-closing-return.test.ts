import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScopedLeaderActionInput } from "../src/collaboration-state/contracts.js";
import type { ControlAction, ControlActionEnvelope } from "../src/types.js";
import { P, openedClosingFixture, cleanupClosingFixtures } from "./helpers/scoped-worktree-closing-fixture.js";

afterEach(cleanupClosingFixtures);

async function stoppedFixture(originalStatus: "completed" | "failed" = "failed") {
  const f = await openedClosingFixture({ originalStatus });
  f.db.stopScopedWorktreeClosingTurn({ ...f.closing, residentStopConfirmed: true, evidence: { exactNativeClosed: true } });
  const observation = await f.ordinaryGit.observeRestrictedWorktreeClosing({ ...f.execution, purpose: "delivery" }, 1,
    { kind: f.closing.kind, reportHeadSha: f.A, paths: f.files });
  const input = { projectId: P, executionId: f.execution.id, ownershipEpoch: 1, agentId: "worker", invocationId: f.closing.invocationId, observation };
  const manager = () => {
    const invocationId = "inv_next_manager", claim = f.db.claimScopedLeaderTurn({ projectId: P, groupRunId: "run-G", agentId: "main", invocationId,
      runtimePath: path.join(f.projectPath, "runtime", invocationId), allowStoppedRepairFaults: true })!;
    const identity = { projectId: P, groupRunId: "run-G", agentId: "main", invocationId, coordinatorEpoch: claim.coordinatorEpoch };
    f.db.markScopedLeaderOpened(identity);
    const envelope = (action: ControlAction, callId: string): ControlActionEnvelope => ({ projectId: P, agent: "main", invocationId, callId,
      stateVersion: claim.coordinatorEpoch, capabilityHash: "d".repeat(64), receivedAt: f.time(), action });
    f.db.recordScopedLeaderTaskCompletion({ ...identity, envelope: envelope({ tool: "finish_task", summary: "My new formal decision" }, "finish") });
    const action: ControlAction = { tool: "coordinate_group_task", groupRunId: "run-G", coordinatorEpoch: claim.coordinatorEpoch,
      arrivalRequestId: f.execution.arrivalRequestId, operation: "close_worktree", rationale: "Inspect my original unresolved Memory only once",
      closing: { executionId: f.execution.id, ownershipEpoch: 1, paths: f.files } };
    return { ...identity, envelope: envelope(action, "close"), residentStopConfirmed: true } satisfies ScopedLeaderActionInput;
  };
  const edit = (sql: string, ...args: (string | number)[]) => {
    const raw = new DatabaseSync(f.databasePath); try { raw.prepare(sql).run(...args); } finally { raw.close(); }
  };
  return { ...f, input, manager, edit };
}

describe("stopped closing returns and fresh formal continuation", () => {
  it.each(["completed", "failed"] as const)("retains %s output/finish and immutable A, returns once without granting or releasing FIFO", async status => {
    const f = await stoppedFixture(status), before = f.snapshot();
    const returned = f.db.returnScopedWorktreeClosingToLeader(f.input);
    expect(returned).toMatchObject({ reportHeadSha: f.A, bindingInvocationId: f.closing.invocationId,
      observation: { pendingPaths: f.files }, missing: expect.arrayContaining(["actual original Agent output", "original Agent finish_task"]) });
    const [candidate] = f.db.scopedRecoveryCandidates(P, "run-G");
    expect(candidate!.pendingOperation).toBeUndefined();
    expect(candidate!.closingAttempts).toMatchObject([{ turn: { status: "stopped" }, returned, operations: [], results: [] }]);
    expect(f.db.returnScopedWorktreeClosingToLeader(f.input)).toEqual(returned);
    expect(() => f.db.returnScopedWorktreeClosingToLeader({ ...f.input, observation: { ...f.input.observation, observedAt: new Date(Date.parse(f.time()) + 1).toISOString() } })).toThrow("changed on replay");
    expect(f.db.eventsAfter(P).filter(event => event.type === "scoped.group.issue.returned")).toHaveLength(1);
    expect(f.db.scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true);
    expect(f.db.scopedWorktreeClosingAuthorizations(P)).toHaveLength(1); expect(f.db.scopedWorktreeClosingTurns(P)).toHaveLength(1);
    expect(f.snapshot()).toEqual(before);
    expect(() => f.db.assertScopedWorktreeClosingControl({ ...f.closing, capabilityHash: f.closing.capabilityHash })).toThrow();
  });

  it.each(["completed", "failed"] as const)("requires the %s owner's returned stopped attempt before any new grant and never reuses the old manager decision", async status => {
    const f = await stoppedFixture(status), next = f.manager(), before = f.snapshot();
    expect(() => f.db.revalidateScopedLeaderAction(next)).toThrow("pending grant");
    f.db.returnScopedWorktreeClosingToLeader(f.input);
    f.db.acceptScopedLeaderAction(next);
    const grants = f.db.scopedWorktreeClosingAuthorizations(P);
    expect(grants).toHaveLength(2); expect(grants[1]!.continuation).toMatchObject({ invocationId: f.closing.invocationId,
      bindingInvocationId: f.closing.invocationId, bindingRuntimePath: f.closing.runtimePath });
    expect(grants[0]!.continuation).toBeUndefined();
    const input = { ...f.input, invocationId: "inv_next_closing", runtimePath: path.join(f.projectPath, "runtime/inv_next_closing"),
      grantInvocationId: next.invocationId, grantCallId: next.envelope.callId, capabilityHash: "e".repeat(64),
      originalStop: { ...f.originalStop, invocationId: f.closing.invocationId, runtimePath: f.closing.runtimePath } };
    expect(f.db.beginScopedWorktreeClosingTurn(input)).toBeUndefined(); // Exact manager remains active.
    f.db.releaseScopedLeaderTurn(next);
    const reserved = f.db.beginScopedWorktreeClosingTurn(input)!;
    expect(reserved.turn).toMatchObject({ status: "reserved", previousInvocationId: f.closing.invocationId, originalSession: f.session, reportHeadSha: f.A });
    expect(f.db.beginScopedWorktreeClosingTurn(input)!.replay).toBe(true);
    expect(() => f.db.beginScopedWorktreeClosingTurn({ ...input, invocationId: "inv_extra", runtimePath: path.join(f.projectPath, "runtime/inv_extra") })).toThrow();
    expect(f.db.scopedWorktreeClosingTurns(P)).toHaveLength(2);
    expect(f.snapshot()).toEqual(before);
  });

  it("carries the real stopped Git read failure to hierarchy and rejects further file authority", async () => {
    const f = await stoppedFixture();
    const { observation, ...identity } = f.input;
    f.db.returnScopedWorktreeClosingToLeader({ ...identity, observationFailure: {
      reason: "Actual Git rejected an extra path of uncertain source", errorCode: "GIT_PATH_VIOLATION", errorClass: "GitPathViolationError" } });
    expect(f.db.scopedRecoveryCandidates(P, "run-G")[0]!.closingAttempts![0]!.returned!.observation).toBeUndefined();
    expect(() => f.db.revalidateScopedLeaderAction(f.manager())).toThrow("untrusted closing return");
    expect(f.db.scopedWorktreeClosingAuthorizations(P)).toHaveLength(1);
    expect(f.db.scopedGroupIssues(P)).toHaveLength(1);
  });

  it.each(["owner", "epoch", "agent", "invocation", "both", "neither", "stale", "extra-path", "head", "A", "branch", "worktree", "session", "frozen", "empty-error", "unknown-owner"] as const)("rejects an invalid %s return without changing the hierarchy", async fault => {
    const f = await stoppedFixture(), input = structuredClone(f.input) as Parameters<typeof f.db.returnScopedWorktreeClosingToLeader>[0];
    if (fault === "owner") input.executionId = "another";
    if (fault === "epoch") input.ownershipEpoch = 2;
    if (fault === "agent") input.agentId = "main";
    if (fault === "invocation") input.invocationId = "inv_other";
    if (fault === "both" || fault === "empty-error") input.observationFailure = { reason: fault === "empty-error" ? "" : "Actual reason", errorCode: "GIT_PATH_VIOLATION", errorClass: "GitPathViolationError" };
    if (fault === "neither" || fault === "empty-error") delete input.observation;
    if (fault === "stale") f.advance(60_001);
    if (fault === "extra-path") input.observation!.pendingPaths.push("other.txt");
    if (fault === "head") input.observation!.head = "not-a-sha";
    if (fault === "A") input.observation!.reportHeadSha = "b".repeat(40);
    if (fault === "branch") input.observation!.branch = "another";
    if (fault === "worktree") input.observation!.worktreePath = path.join(f.root, "other");
    if (fault === "session") f.db.recordAgentNativeSessionBinding({ ...f.binding, invocationId: "inv_foreign", runtimePath: path.join(f.projectPath, "runtime/inv_foreign"), session: { ...f.session, nativeId: "foreign" } });
    if (fault === "frozen") f.edit("UPDATE project_heads SET frozen = 1 WHERE project_id = ?", P);
    if (fault === "unknown-owner") f.edit("UPDATE scoped_executions SET ownership_epoch = 2 WHERE execution_id = ?", f.execution.id);
    expect(() => f.db.returnScopedWorktreeClosingToLeader(input)).toThrow();
    expect(f.db.scopedWorktreeClosingReturn(P, f.closing.invocationId)).toBeUndefined();
    expect(f.db.eventsAfter(P).filter(event => event.type === "scoped.group.issue.returned")).toEqual([]);
  });

  it("does not return an opened native process whose physical Stop is unproven", async () => {
    const f = await openedClosingFixture();
    expect(() => f.db.returnScopedWorktreeClosingToLeader({ ...f.closing, observation: f.observation })).toThrow("stopped original owner");
    expect(f.db.scopedRecoveryCandidates(P, "run-G")[0]!.pendingOperation).toBe("close_worktree");
  });

  it("keeps exhausted automatic management and Agent supplement budgets across the returned issue and new formal grant", async () => {
    const f = await stoppedFixture();
    const append = (requestId: string, type: string, payload: Record<string, unknown>) => f.db.appendEvent({ projectId: P, requestId, type, payload });
    append("old-agent-budget", "scoped.agent.mechanism_repair.requested", { executionId: f.execution.id, attempt: 2 });
    append("old-manager-budget", "scoped.management.failure", { groupRunId: "run-G", managerAgentId: "main", globalMain: false,
      purpose: "recover", managerInvocationId: "earlier", coordinatorEpoch: 1, failedArrivalRequestId: f.execution.arrivalRequestId,
      executionId: f.execution.id, incidentId: f.db.scopedWorktreeClosingCandidates(P)[0]!.incidentId, ownershipEpoch: 1,
      failureKey: "preserved-key", attempt: 2, budget: 2, exhausted: true, reason: "Actual earlier technical failure" });
    const before = f.db.scopedManagementFailures(P), count = f.db.scopedAgentMechanismRepairCount(P, f.execution.id);
    f.db.returnScopedWorktreeClosingToLeader(f.input); f.db.acceptScopedLeaderAction(f.manager());
    expect(f.db.scopedManagementFailures(P)).toEqual(before); expect(f.db.scopedAgentMechanismRepairCount(P, f.execution.id)).toBe(count);
    expect(f.db.scopedManagementRecoveryBlocked(P, "run-G", f.db.scopedRecoveryCandidates(P, "run-G")[0]!)).toBe(true);
  });
});
