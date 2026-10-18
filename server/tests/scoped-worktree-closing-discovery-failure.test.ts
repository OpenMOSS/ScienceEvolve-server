import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { P, authorizedClosingFixture, cleanupClosingFixtures } from "./helpers/scoped-worktree-closing-fixture.js";

afterEach(cleanupClosingFixtures);

async function fixture(originalStatus: "completed" | "failed" = "failed") {
  const f = await authorizedClosingFixture({ identify: false, originalStatus });
  const input = { projectId: P, executionId: f.execution.id, agentId: "worker", ownershipEpoch: 1,
    executionBranch: f.execution.executionBranch, worktreePath: f.worktree, reportHeadSha: f.A,
    originalSession: f.session, originalStop: f.originalStop, reason: "Actual read refused unknown paths",
    errorCode: "GIT_PATH_VIOLATION", errorClass: "GitPathViolationError", trustedReadFailed: true as const };
  return { ...f, input };
}

describe("trusted read-failure facts without a writable closing manifest", () => {
  it("retains exact immutable failure facts for hierarchy coordination without changing business status or granting files", async () => {
    const f = await fixture(), before = f.snapshot();
    const issue = f.db.recordScopedWorktreeClosingDiscoveryFailure(f.input), eventCount = f.db.eventsAfter(P).length;
    expect(issue).toMatchObject({ kind: "worktree-closing", executionId: f.execution.id, ownershipEpoch: 1 });
    expect(f.db.recordScopedWorktreeClosingDiscoveryFailure(f.input)).toEqual(issue);
    expect(f.db.eventsAfter(P)).toHaveLength(eventCount); expect(f.snapshot()).toEqual(before);
    expect(f.db.scopedWorktreeClosingCandidates(P)).toEqual([]); expect(f.db.scopedWorktreeClosingAuthorizations(P)).toEqual([]);
    expect(f.db.scopedWorktreeClosingTurns(P)).toEqual([]); expect(f.db.scopedWorktreeClosingDiscoveryOwners(P)).toEqual([]);
    expect(f.db.scopedRecoveryCandidates(P, "run-G")[0]).toMatchObject({ incidentId: issue.id, executionId: f.execution.id, kind: "worktree-closing", closing: undefined });
    expect(() => f.db.recordScopedWorktreeClosingDiscoveryFailure({ ...f.input, reason: "Replacement explanation" })).toThrow("immutable observation");
    expect(f.snapshot()).toEqual(before); expect(f.db.eventsAfter(P)).toHaveLength(eventCount);
  });

  it("holds the completed original Agent FIFO and refuses a newer business native reservation while read-failure coordination is open", async () => {
    const f = await fixture("completed");
    expect((f.db as any).scopedAgentHasUnreleasedActivity(P, "worker")).toBe(false);
    f.db.recordScopedWorktreeClosingDiscoveryFailure(f.input);
    expect((f.db as any).scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true);
    const raw = new DatabaseSync(f.databasePath);
    try {
      const copy = (table: string, overrides: Record<string, string | number | null>, omit?: string) => {
        const row = { ...raw.prepare(`SELECT * FROM ${table} LIMIT 1`).get(), ...overrides } as Record<string, string | number | null>;
        if (omit) delete row[omit]; const fields = Object.keys(row);
        raw.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(row));
      };
      copy("scoped_arrivals", { request_id: "next-arrival", source_run_id: "after-original", node_run_id: null, status: "queued" }, "arrival_seq");
    } finally { raw.close(); }
    const queued = f.snapshot();
    expect(f.db.claimScopedAgentArrival({ projectId: P, arrivalRequestId: "next-arrival", agentId: "worker", executionId: "next", worktreePath: f.worktree })).toBeUndefined();
    expect(f.snapshot()).toEqual(queued);
    const retained = new DatabaseSync(f.databasePath);
    try {
      const row = { ...retained.prepare("SELECT * FROM scoped_executions LIMIT 1").get(), execution_id: "registered-next", arrival_request_id: "next-arrival",
        execution_branch: "executions/registered-next", status: "running", completed_at: null };
      const fields = Object.keys(row); retained.prepare(`INSERT INTO scoped_executions (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(row));
    } finally { retained.close(); }
    const before = f.snapshot();
    expect(() => f.db.beginScopedAgentTurn({ projectId: P, executionId: "registered-next", ownershipEpoch: 1, invocationId: "inv_registered_next",
      runtimePath: path.join(f.projectPath, "runtime/inv_registered_next"), baseCommit: f.A })).toThrow("closing must settle");
    expect(f.snapshot()).toEqual(before); expect(f.db.scopedAgentTurn(P, "registered-next", 1)).toBeUndefined();
  });

  it.each(["owner", "epoch", "agent", "branch", "worktree", "report", "session", "invocation", "runtime", "stop", "evidence", "empty-reason", "oversize", "code", "class", "trusted"])("rejects %s failure evidence without creating an issue", async fault => {
    const f = await fixture(), input = structuredClone(f.input), before = f.snapshot(), events = f.db.eventsAfter(P).length;
    if (fault === "owner") input.executionId = "another-owner";
    if (fault === "epoch") input.ownershipEpoch++;
    if (fault === "agent") input.agentId = "another-agent";
    if (fault === "branch") input.executionBranch = "executions/another";
    if (fault === "worktree") input.worktreePath += "/another";
    if (fault === "report") input.reportHeadSha = "f".repeat(40);
    if (fault === "session") input.originalSession.nativeId = "replacement";
    if (fault === "invocation") input.originalStop.invocationId = "inv_another";
    if (fault === "runtime") input.originalStop.runtimePath += "/another";
    if (fault === "stop") (input.originalStop as any).residentStopConfirmed = false;
    if (fault === "evidence") input.originalStop.evidence = {};
    if (fault === "empty-reason") input.reason = "  ";
    if (fault === "oversize") input.reason = "a".repeat(4001);
    if (fault === "code") input.errorCode = "";
    if (fault === "class") input.errorClass = "";
    if (fault === "trusted") (input as any).trustedReadFailed = false;
    expect(() => f.db.recordScopedWorktreeClosingDiscoveryFailure(input)).toThrow();
    expect(f.snapshot()).toEqual(before); expect(f.db.eventsAfter(P)).toHaveLength(events);
    expect(f.db.scopedGroupIssues(P)).toEqual([]); expect(f.db.scopedWorktreeClosingAuthorizations(P)).toEqual([]);
  });

  it.each(["retry", "close_worktree"] as const)("refuses the Leader's %s for an issue without a trusted writable manifest", async operation => {
    const f = await fixture(); f.db.recordScopedWorktreeClosingDiscoveryFailure(f.input);
    const claimed = f.db.claimScopedLeaderTurn({ projectId: P, groupRunId: "run-G", agentId: "main", invocationId: "inv_uncertain",
      runtimePath: f.originalStop.runtimePath.replace("inv_original", "inv_uncertain"), allowStoppedRepairFaults: true })!;
    const manager = { projectId: P, groupRunId: "run-G", agentId: "main", invocationId: "inv_uncertain", coordinatorEpoch: claimed.coordinatorEpoch };
    f.db.markScopedLeaderOpened(manager);
    expect(() => f.db.revalidateScopedLeaderAction({ ...manager, envelope: { projectId: P, agent: "main", invocationId: "inv_uncertain", callId: "forbidden",
      capabilityHash: "c".repeat(64), stateVersion: claimed.coordinatorEpoch, receivedAt: f.time(), action: {
        tool: "coordinate_group_task", groupRunId: "run-G", coordinatorEpoch: claimed.coordinatorEpoch, arrivalRequestId: f.execution.arrivalRequestId,
        operation, rationale: "Cannot substitute guessed paths", ...(operation === "close_worktree" ? { closing: { executionId: f.execution.id, ownershipEpoch: 1, paths: f.files } } : {}) } } })).toThrow(/closing issue|original direct Leader/);
    expect(f.db.scopedWorktreeClosingAuthorizations(P)).toEqual([]);
  });
});
