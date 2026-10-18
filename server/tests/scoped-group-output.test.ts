import { describe, expect, it } from "vitest";
import { scopedGroupOutput, scopedPredecessorOutput } from "../src/scoped-group-output.js";
import type { CredentialFreeProjectStateProjection, ScopedArrivalRecord } from "../src/collaboration-state/contracts.js";

describe("verified scoped group handoffs", () => {
  it("includes current merged descendant results and explicit skips, but excludes failed/old/unmerged/outside reports", () => {
    const projection = {
      scopedGroupRuns: [{ id: "G" }, { id: "H", parentGroupRunId: "G" }, { id: "outside" }],
      scopedExecutions: [{ id: "good", groupRunId: "H", ownershipEpoch: 2, status: "completed" },
        { id: "failed", groupRunId: "G", ownershipEpoch: 1, status: "failed" },
        { id: "unmerged", groupRunId: "G", ownershipEpoch: 1, status: "completed" },
        { id: "outside", groupRunId: "outside", ownershipEpoch: 1, status: "completed" }],
      scopedAgentReports: [{ executionId: "good", ownershipEpoch: 2, output: "current merged result" },
        { executionId: "good", ownershipEpoch: 1, output: "obsolete result" },
        { executionId: "failed", ownershipEpoch: 1, output: "failed result" },
        { executionId: "unmerged", ownershipEpoch: 1, output: "not integrated" },
        { executionId: "outside", ownershipEpoch: 1, output: "outside result" }],
      scopedAgentMerges: [{ executionId: "good" }, { executionId: "outside" }],
      scopedArrivals: [{ groupRunId: "H", targetNodeId: "skipped-worker", requestId: "skip-1", status: "skipped" }]
    } as unknown as CredentialFreeProjectStateProjection;
    const output = scopedGroupOutput(projection, "G");
    expect(output).toContain("current merged result"); expect(output).toContain("Explicitly skipped (not successful work): skipped-worker/skip-1");
    for (const text of ["obsolete result", "failed result", "not integrated", "outside result"]) expect(output).not.toContain(text);
  });
  it("resolves an Agent predecessor by its same-scope arrival and only returns a current merged report", () => {
    const projection = { scopedArrivals: [{ requestId: "source", groupRunId: "G", targetKind: "agent", status: "completed" }],
      scopedExecutions: [{ id: "execution", arrivalRequestId: "source", groupRunId: "G", status: "completed", ownershipEpoch: 2 }],
      scopedAgentMerges: [{ executionId: "execution" }], scopedAgentReports: [{ executionId: "execution", ownershipEpoch: 1, output: "old" },
        { executionId: "execution", ownershipEpoch: 2, output: "current" }] } as unknown as CredentialFreeProjectStateProjection;
    const successor = { sourceRunId: "source", groupRunId: "G" } as ScopedArrivalRecord;
    expect(scopedPredecessorOutput(projection, successor)).toBe("current");
    expect(scopedPredecessorOutput(projection, { ...successor, groupRunId: "outside" })).toBeUndefined();
    projection.scopedAgentMerges = []; expect(scopedPredecessorOutput(projection, successor)).toBeUndefined();
    projection.scopedArrivals![0].status = "skipped";
    expect(scopedPredecessorOutput(projection, successor)).toContain("Explicitly skipped (not successful work)");
  });
  it("does not deliver a completed child's reports before its exact final PR proof exists", () => {
    const projection = { scopedArrivals: [{ requestId: "child-source", groupRunId: "G", targetKind: "collaboration", status: "completed" }],
      scopedGroupRuns: [{ id: "H", parentArrivalRequestId: "child-source", parentGroupRunId: "G", status: "completed" }],
      scopedExecutions: [{ id: "worker", groupRunId: "H", status: "completed", ownershipEpoch: 1 }],
      scopedAgentMerges: [{ executionId: "worker" }], scopedAgentReports: [{ executionId: "worker", ownershipEpoch: 1, output: "child result" }] } as unknown as CredentialFreeProjectStateProjection;
    const successor = { sourceRunId: "child-source", groupRunId: "G" } as ScopedArrivalRecord;
    expect(scopedPredecessorOutput(projection, successor)).toBeUndefined();
    projection.scopedGroupFinalMerges = [{ groupRunId: "H" }] as NonNullable<CredentialFreeProjectStateProjection["scopedGroupFinalMerges"]>;
    expect(scopedPredecessorOutput(projection, successor)).toBe("child result");
  });
});
