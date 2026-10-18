import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { P, authorizedClosingFixture, cleanupClosingFixtures } from "./helpers/scoped-worktree-closing-fixture.js";

afterEach(cleanupClosingFixtures);

describe("scoped retry admission while original-Agent closing is pending", () => {
  it.each([false, true])("retains a failed successor's epoch, FIFO and stopped reservation until closing settles (file removed=%s)", async removed => {
    // Reproduce late closing discovery after a successor was already admitted
    // and failed before its native process opened, as in the historical N10.
    const f = await authorizedClosingFixture({ identify: false, originalStatus: "completed", businessDelivery: true, nextArrival: true });
    const arrival = f.db.scopedArrivals("run-G").find(entry => entry.targetNodeId === "G_worker_next")!;
    const next = f.db.claimScopedAgentArrival({ projectId: P, arrivalRequestId: arrival.requestId,
      executionId: "next", agentId: "worker", worktreePath: f.worktree })!.execution;
    const identity = { projectId: P, executionId: next.id, ownershipEpoch: 1, invocationId: "inv_unopened_next" };
    const runtimePath = path.join(f.projectPath, "runtime", identity.invocationId);
    f.db.beginScopedAgentTurn({ ...identity, runtimePath, baseCommit: f.A });
    f.db.stopScopedAgentTurn({ ...identity, residentStopConfirmed: true });
    f.db.failScopedAgentArrival({ ...identity, arrivalRequestId: arrival.requestId,
      reason: "Original Agent's retained file blocks the successor checkout", residentStopConfirmed: true });
    const issue = f.db.recordScopedWorktreeClosingIssue({ projectId: P, executionId: f.execution.id,
      ownershipEpoch: 1, agentId: "worker", observation: f.observation, originalStop: f.originalStop });
    // A clean directory by itself cannot replace A/B/native-result settlement.
    if (removed) await fs.rm(f.memory);
    const before = f.db.projectState(P), originalReport = f.db.scopedAgentReport(P, f.execution.id, 1);
    const refs = f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"]);
    const retry = { projectId: P, executionId: next.id, arrivalRequestId: arrival.requestId, failedOwnershipEpoch: 1 };
    expect(f.db.retryScopedAgentArrival(retry)).toBeUndefined();
    expect(f.db.retryScopedAgentArrival(retry)).toBeUndefined();
    expect(f.db.projectState(P)).toEqual(before);
    expect(f.db.scopedExecution(P, next.id)).toMatchObject({ status: "failed", ownershipEpoch: 1 });
    expect(f.db.scopedAgentTurn(P, next.id, 2)).toBeUndefined();
    expect(f.db.scopedAgentTurn(P, next.id, 1)).toMatchObject({ status: "stopped", invocationId: identity.invocationId });
    expect(f.db.scopedRecoveryCandidates(P, "run-G").some(candidate => candidate.incidentId === issue.incidentId)).toBe(true);
    expect(f.db.scopedAgentReport(P, f.execution.id, 1)).toEqual(originalReport);
    expect(f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs);
  }, 30_000);

  it("does not turn an original failed owner's closing grant into an ordinary business retry", async () => {
    const f = await authorizedClosingFixture({ originalStatus: "failed" });
    const before = f.db.projectState(P);
    expect(f.db.retryScopedAgentArrival({ projectId: P, executionId: f.execution.id,
      arrivalRequestId: f.execution.arrivalRequestId, failedOwnershipEpoch: 1 })).toBeUndefined();
    expect(f.db.projectState(P)).toEqual(before);
    expect(f.db.scopedWorktreeClosingAuthorizations(P)).toHaveLength(1);
    expect(f.db.scopedAgentTurn(P, f.execution.id, 2)).toBeUndefined();
  }, 30_000);
});
