import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlAction, ControlActionEnvelope } from "../src/types.js";
import { CollaborationGitError } from "../src/collaboration-git/errors.js";
import { P, authorizedClosingFixture, cleanupClosingFixtures } from "./helpers/scoped-worktree-closing-fixture.js";

afterEach(cleanupClosingFixtures);

async function fixture(status: "completed" | "failed" = "failed") {
  const f = await authorizedClosingFixture({ originalStatus: status });
  await fs.writeFile(path.join(f.worktree, "unknown.txt"), "Actual late path of uncertain source");
  let error: CollaborationGitError | undefined;
  try { await f.ordinaryGit.observeRestrictedWorktreeClosing({ ...f.execution, purpose: "delivery" }, 1,
    { kind: f.observation.kind, reportHeadSha: f.A, paths: f.files }); }
  catch (actual) { expect(actual).toBeInstanceOf(CollaborationGitError); error = actual as CollaborationGitError; }
  expect(error).toBeDefined();
  const input = { projectId: P, executionId: f.execution.id, ownershipEpoch: 1, agentId: "worker",
    grantInvocationId: f.manager.invocationId, grantCallId: "close", originalStop: f.originalStop,
    reason: error!.message, errorCode: error!.code, errorClass: error!.name };
  const edit = (sql: string, ...args: (string | number)[]) => {
    const raw = new DatabaseSync(f.databasePath); try { raw.prepare(sql).run(...args); } finally { raw.close(); }
  };
  return { ...f, input, edit };
}

describe("unused exact closing grant refusal", () => {
  it.each(["completed", "failed"] as const)("returns a real %s read refusal once, preserving files and every accepted fact without inventing a native call", async status => {
    const f = await fixture(status), before = f.snapshot(), grants = f.db.scopedWorktreeClosingAuthorizations(P);
    const failure = f.db.recordScopedWorktreeClosingGrantFailure(f.input);
    expect(failure).toMatchObject({ executionId: f.execution.id, reportHeadSha: f.A, errorCode: "GIT_PATH_VIOLATION", originalStop: f.originalStop });
    expect(f.db.recordScopedWorktreeClosingGrantFailure(f.input)).toEqual(failure);
    expect(() => f.db.recordScopedWorktreeClosingGrantFailure({ ...f.input, reason: "Replace actual reason" })).toThrow("changed on replay");
    const [candidate] = f.db.scopedRecoveryCandidates(P, "run-G");
    expect(candidate!.pendingOperation).toBeUndefined(); expect(candidate!.closingGrantFailure).toEqual(failure);
    expect(f.db.scopedWorktreeClosingTurns(P)).toEqual([]); expect(f.db.scopedWorktreeClosingAuthorizations(P)).toEqual(grants);
    expect(f.db.scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true); expect(f.snapshot()).toEqual(before);
    expect(f.db.eventsAfter(P).filter(event => event.type === "scoped.worktree_closing.grant.failed")).toHaveLength(1);
    expect(f.db.eventsAfter(P).filter(event => event.type === "scoped.group.issue.returned")).toHaveLength(1);
    expect(await fs.readFile(path.join(f.worktree, "unknown.txt"), "utf8")).toBe("Actual late path of uncertain source");
  });

  it.each(["execution", "epoch", "agent", "grant", "call", "stop-id", "stop-path", "stop-unconfirmed", "stop-empty", "reason", "code", "class", "session", "frozen", "owner-changed"] as const)("rejects an inaccurate %s refusal before returning any hierarchy issue", async fault => {
    const f = await fixture(), input = structuredClone(f.input);
    if (fault === "execution") input.executionId = "other";
    if (fault === "epoch") input.ownershipEpoch = 2;
    if (fault === "agent") input.agentId = "main";
    if (fault === "grant") input.grantInvocationId = "other";
    if (fault === "call") input.grantCallId = "other";
    if (fault === "stop-id") input.originalStop.invocationId = "other";
    if (fault === "stop-path") input.originalStop.runtimePath = path.join(f.root, "other");
    if (fault === "stop-unconfirmed") Object.assign(input.originalStop, { residentStopConfirmed: false });
    if (fault === "stop-empty") Object.assign(input.originalStop, { evidence: {} });
    if (fault === "reason") input.reason = "   ";
    if (fault === "code") Object.assign(input, { errorCode: "" });
    if (fault === "class") input.errorClass = "";
    if (fault === "session") f.db.recordAgentNativeSessionBinding({ ...f.binding, invocationId: "inv_other", runtimePath: path.join(f.projectPath, "runtime/inv_other"), session: { ...f.session, nativeId: "other" } });
    if (fault === "frozen") f.edit("UPDATE project_heads SET frozen = 1 WHERE project_id = ?", P);
    if (fault === "owner-changed") f.edit("UPDATE scoped_executions SET ownership_epoch = 2 WHERE execution_id = ?", f.execution.id);
    expect(() => f.db.recordScopedWorktreeClosingGrantFailure(input)).toThrow();
    expect(f.db.scopedWorktreeClosingGrantFailure(P, f.manager.invocationId, "close")).toBeUndefined();
    expect(f.db.eventsAfter(P).filter(event => event.type === "scoped.group.issue.returned")).toEqual([]);
  });

  it("cannot describe an already reserved supplement as an unused grant", async () => {
    const f = await fixture();
    f.db.beginScopedWorktreeClosingTurn({ projectId: P, executionId: f.execution.id, ownershipEpoch: 1, agentId: "worker", invocationId: "inv_reserved",
      runtimePath: path.join(f.projectPath, "runtime/inv_reserved"), capabilityHash: "e".repeat(64), grantInvocationId: f.manager.invocationId,
      grantCallId: "close", originalStop: f.originalStop, observation: f.observation });
    expect(() => f.db.recordScopedWorktreeClosingGrantFailure(f.input)).toThrow("exact released grant");
    expect(f.db.scopedWorktreeClosingTurns(P)[0]!.status).toBe("reserved");
  });

  it("requires escalation instead of restoring the refused grant or widening its manifest", async () => {
    const f = await fixture(); f.db.recordScopedWorktreeClosingGrantFailure(f.input);
    const invocationId = "inv_next_manager", claim = f.db.claimScopedLeaderTurn({ projectId: P, groupRunId: "run-G", agentId: "main", invocationId,
      runtimePath: path.join(f.projectPath, "runtime", invocationId), allowStoppedRepairFaults: true })!;
    const identity = { projectId: P, groupRunId: "run-G", agentId: "main", invocationId, coordinatorEpoch: claim.coordinatorEpoch };
    f.db.markScopedLeaderOpened(identity);
    const envelope = (action: ControlAction, callId: string): ControlActionEnvelope => ({ projectId: P, agent: "main", invocationId, callId,
      stateVersion: claim.coordinatorEpoch, capabilityHash: "d".repeat(64), receivedAt: f.time(), action });
    const action: ControlAction = { tool: "coordinate_group_task", groupRunId: "run-G", coordinatorEpoch: claim.coordinatorEpoch,
      arrivalRequestId: f.execution.arrivalRequestId, operation: "close_worktree", rationale: "Do not restore an untrusted manifest",
      closing: { executionId: f.execution.id, ownershipEpoch: 1, paths: f.files } };
    expect(() => f.db.revalidateScopedLeaderAction({ ...identity, envelope: envelope(action, "close") })).toThrow(expect.objectContaining({
      code: "INVALID_STATE_TRANSITION", details: expect.objectContaining({ invalidField: "operation", recoveryOptions: [expect.objectContaining({
        arrivalRequestId: f.execution.arrivalRequestId, allowedOperations: ["escalate"],
        blockedOperations: { close_worktree: expect.stringContaining("trusted original-owner file manifest") }
      })] })
    }));
    f.db.recordScopedLeaderTaskCompletion({ ...identity, envelope: envelope({ tool: "finish_task", summary: "My actual escalation" }, "finish") });
    const { closing, ...escalation } = action;
    f.db.acceptScopedLeaderAction({ ...identity, residentStopConfirmed: true, envelope: envelope({ ...escalation, operation: "escalate" }, "escalate") });
    f.db.releaseScopedLeaderTurn({ ...identity, residentStopConfirmed: true });
    expect(f.db.scopedRecoveryCandidates(P, "run-G")).toEqual([]);
    expect(f.db.scopedRecoveryCandidates(P, "run-G", true)[0]!.closingGrantFailure).toMatchObject({ errorCode: "GIT_PATH_VIOLATION" });
    expect(f.db.scopedWorktreeClosingAuthorizations(P)).toHaveLength(1);
  });
});
