import { afterEach, describe, expect, it } from "vitest";
import { P, cleanupClosingFixtures } from "./helpers/scoped-worktree-closing-fixture.js";

import { deliveredClosingFixture as delivered } from "./helpers/scoped-worktree-closing-delivery-fixture.js";

afterEach(cleanupClosingFixtures);


describe("read-only original A and independent B delivery proof", () => {
  it.each(["completed", "failed"] as const)("proves %s A and real B independently, without releasing or altering the original task", async status => {
    const f = await delivered(status), before = f.snapshot(), events = f.db.eventsAfter(P), counts = [f.provider.observeRef.mock.calls.length,
      f.provider.openPullRequest.mock.calls.length, f.provider.mergePullRequest.mock.calls.length];
    const result = f.inspect();
    expect(result.missing).toEqual([]);
    expect(result.proof).toMatchObject({ business: { report: { headSha: f.A, output: "Immutable original business report" },
      pullRequest: { providerNumber: 1, headSha: f.A }, finish: { callId: "original-finish", memory: "Original submitted Memory" } },
      supplement: { headSha: f.observation.head, pullRequest: { providerNumber: 11, headSha: f.observation.head, status: "merged" },
        receiptIds: expect.arrayContaining([expect.any(String)]) } });
    expect(result.proof!.supplement!.receiptIds).toHaveLength(3);
    expect(f.rawGit(["merge-base", "--is-ancestor", f.A, f.observation.head])).toBe("");
    expect(f.rawGit(["status", "--porcelain"])).toBe("");
    const target = f.rawGit(["rev-parse", "refs/heads/groups/run-G"]);
    expect(f.rawGit(["merge-base", "--is-ancestor", f.observation.head, target])).toBe("");
    expect(target).toBe(f.rawGit(["rev-parse", "refs/heads/groups/run-G"], f.remote));
    expect(f.inspect()).toEqual(result); expect(f.snapshot()).toEqual(before); expect(f.db.eventsAfter(P)).toEqual(events);
    expect([f.provider.observeRef.mock.calls.length, f.provider.openPullRequest.mock.calls.length, f.provider.mergePullRequest.mock.calls.length]).toEqual(counts);
    expect(f.db.scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true);
    expect(f.db.scopedWorktreeClosingCandidates(P)).toHaveLength(1);
    if (status === "failed") expect(() => f.db.completeScopedAgentArrivalAfterMerge({ projectId: P, executionId: f.execution.id,
      arrivalRequestId: f.execution.arrivalRequestId, ownershipEpoch: 1, ...f.businessDelivery! })).toThrow("not eligible");
  }, 30_000);

  it("requires actual original-Session reception of all three B results", async () => {
    const f = await delivered("failed", false), result = f.inspect();
    expect(result.proof).toBeUndefined(); expect(result.missing).toHaveLength(3);
    expect(result.missing.every(value => value.includes("reception"))).toBe(true);
  }, 30_000);

  it.each(["push", "create", "merge"])("does not borrow A or another native receipt when the B %s receipt is missing", async callId => {
    const f = await delivered();
    f.edit("DELETE FROM project_events WHERE project_id=? AND event_type='control.result.received' AND json_extract(payload_json,'$.receiptId') IN (SELECT json_extract(payload_json,'$.receipt.id') FROM project_events WHERE event_type='control.result.recorded' AND json_extract(payload_json,'$.receipt.callId')=?)", P, callId);
    const result = f.inspect(); expect(result.proof).toBeUndefined(); expect(result.missing.some(value => value.includes("independent B"))).toBe(true);
    expect(f.db.scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true);
  }, 30_000);

  it.each(["original finish", "supplemental finish", "actual output", "A merge", "A sync", "B sync", "native binding", "unsettled journal"])(
    "rejects missing or mismatched %s without inventing delivery", async variant => {
      const f = await delivered();
      if (variant === "original finish") f.edit("DELETE FROM scoped_agent_task_completions WHERE execution_id=?", f.execution.id);
      if (variant === "supplemental finish") f.edit("DELETE FROM project_events WHERE request_id=?", `scoped-worktree-closing:${f.closing.invocationId}:finish_task`);
      if (variant === "actual output") f.edit("DELETE FROM project_events WHERE request_id=?", `scoped-worktree-closing:${f.closing.invocationId}:result`);
      if (variant === "A merge") f.edit("DELETE FROM scoped_operations WHERE operation_id='original-business-pull.merge'");
      if (variant === "A sync") f.edit("DELETE FROM project_events WHERE event_type='scoped.execution.merged_local_sync.recorded'");
      if (variant === "B sync") f.edit("DELETE FROM project_events WHERE event_type='scoped.worktree_closing.merged_local_sync.recorded'");
      if (variant === "native binding") f.edit("UPDATE project_events SET payload_json=json_set(payload_json,'$.binding.session.nativeId','another-native-session') WHERE request_id=?", `agent-native-binding:${f.closing.invocationId}`);
      if (variant === "unsettled journal") f.edit("UPDATE scoped_operations SET status='uncertain' WHERE operation_id='original-business-git.push'");
      expect(f.inspect().proof).toBeUndefined(); expect(f.inspect().missing.length).toBeGreaterThan(0);
      expect(f.db.scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true);
    }, 30_000);
});
