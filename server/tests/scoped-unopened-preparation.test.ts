import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopedAgentExecutionRunner, ScopedAgentTurnFailure, type ScopedAgentTurnInput } from "../src/scoped-agent-execution.js";
import { P, authorizedClosingFixture, cleanupClosingFixtures } from "./helpers/scoped-worktree-closing-fixture.js";

afterEach(cleanupClosingFixtures);

async function preparedFixture() {
  const f = await authorizedClosingFixture({ identify: false, originalStatus: "completed", businessDelivery: true, nextArrival: true });
  const arrival = f.db.projectState(P).scopedArrivals!.find(entry => entry.targetNodeId === "G_worker_next")!;
  const next = f.db.claimScopedAgentArrival({ projectId: P, arrivalRequestId: arrival.requestId, agentId: "worker",
    executionId: "next", worktreePath: f.worktree })!.execution;
  const authority = { ...next, purpose: "delivery" as const };
  const absentSnapshot = f.snapshot(), branch = f.rawGit(["symbolic-ref", "--short", "HEAD"]), dirtyMemory = await fs.readFile(f.memory, "utf8");
  const absent = await f.ordinaryGit.observeDeliveryPreparation(authority, 1);
  expect(absent.head).toBeUndefined(); expect(absent.activationBase).toBeUndefined();
  expect(f.snapshot()).toEqual(absentSnapshot); expect(f.rawGit(["symbolic-ref", "--short", "HEAD"])).toBe(branch);
  expect(await fs.readFile(f.memory, "utf8")).toBe(dirtyMemory);
  // This isolated sample models the original Agent restoring its A Memory;
  // it is separate from the B-delivery and production reservation scenarios.
  await fs.writeFile(f.memory, f.rawGit(["show", `${f.A}:agent-memory/worker/Memory.md`]) + "\n");
  const repository = { ...f.repository, provider: "github" as const, providerId: 1, cloneUrl: "https://github.com/example/project.git" };
  const input = { projectId: P, executionId: next.id, ownershipEpoch: 1, repository };
  const sessionBegin = f.ordinaryGit.sessionBegin.bind(f.ordinaryGit);
  const prepared = vi.spyOn(f.ordinaryGit, "sessionBegin").mockImplementationOnce(async (...args) => {
    await sessionBegin(...args); throw Error("Actual checkout created before native launch was interrupted");
  });
  const invoke = vi.fn(async () => { throw Error("No native process should open during preparation"); });
  const runner = new ScopedAgentExecutionRunner(f.db, f.ordinaryGit, { invoke }, () => f.projectPath, { automaticCheckpoint: false });
  await expect(runner.prepareDelivery(input)).rejects.toThrow("checkout created before native launch");
  expect(invoke).not.toHaveBeenCalled(); prepared.mockRestore();
  const retained = f.db.scopedAgentTurn(P, next.id, 1)!;
  expect(retained.status).toBe("stopped"); expect(retained.openedAt).toBeUndefined();
  const retry = f.db.retryScopedAgentArrival({ projectId: P, executionId: next.id, arrivalRequestId: arrival.requestId, failedOwnershipEpoch: 1 })!.execution;
  return { ...f, next, retry, input: { ...input, ownershipEpoch: 2 }, retained, authority: { ...retry, purpose: "delivery" as const } };
}

describe("unopened delivery reservation and actual preparation history", () => {
  it("preserves an actually created branch and activation base across later group advancement", async () => {
    const f = await preparedFixture(), before = f.snapshot(), events = f.db.eventsAfter(P);
    const refs = f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"]);
    const fact = await f.ordinaryGit.observeDeliveryPreparation(f.authority, 2);
    expect(fact).toMatchObject({ projectId: P, executionId: f.next.id, ownershipEpoch: 2, branch: f.next.executionBranch,
      worktreePath: f.worktree, head: f.retained.baseCommit, activationBase: f.retained.baseCommit });
    expect(f.snapshot()).toEqual(before); expect(f.db.eventsAfter(P)).toEqual(events);
    expect(f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs);
    const tree = f.rawGit(["rev-parse", `${fact.head}^{tree}`]);
    const later = f.rawGit(["commit-tree", tree, "-p", fact.head!, "-m", "Later independent group delivery"]);
    f.rawGit(["push", "origin", `${later}:refs/heads/groups/run-G`]);
    const observeRemote = vi.spyOn(f.ordinaryGit, "observeRemoteRef");
    const invoke = vi.fn(async (input: ScopedAgentTurnInput) => {
      expect(input.baseCommit).toBe(f.retained.baseCommit); input.onOpened();
      throw new ScopedAgentTurnFailure("Verified retained preparation boundary", true);
    });
    const runner = new ScopedAgentExecutionRunner(f.db, f.ordinaryGit, { invoke }, () => f.projectPath, { automaticCheckpoint: false });
    await expect(runner.prepareDelivery(f.input)).rejects.toThrow("Verified retained preparation boundary");
    expect(invoke).toHaveBeenCalledTimes(1); expect(observeRemote).not.toHaveBeenCalled();
    expect(f.rawGit(["rev-parse", `refs/heads/${f.next.executionBranch}`])).toBe(f.retained.baseCommit);
    expect(f.rawGit(["rev-parse", `refs/openfars/execution-bases/${f.next.id}`])).toBe(f.retained.baseCommit);
    expect(f.rawGit(["rev-parse", "refs/heads/groups/run-G"], f.remote)).toBe(later);
    expect(f.db.scopedAgentTurn(P, f.next.id, 1)).toEqual(f.retained);
  }, 30_000);

  it.each(["changed-head", "missing-branch", "changed-base"] as const)("refuses unexplained %s without reserving a new turn, switching or rewriting history", async mode => {
    const f = await preparedFixture();
    if (mode === "missing-branch") f.rawGit(["update-ref", "-d", `refs/heads/${f.next.executionBranch}`]);
    else {
      const tree = f.rawGit(["rev-parse", `${f.retained.baseCommit}^{tree}`]);
      const changed = f.rawGit(["commit-tree", tree, "-p", f.retained.baseCommit, "-m", "Unexplained preparation change"]);
      f.rawGit(["update-ref", mode === "changed-head" ? `refs/heads/${f.next.executionBranch}` : `refs/openfars/execution-bases/${f.next.id}`, changed]);
    }
    const before = f.snapshot(), events = f.db.eventsAfter(P), branch = f.rawGit(["symbolic-ref", "--short", "HEAD"]);
    const refs = f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"]);
    const invoke = vi.fn(async () => { throw Error("No unproved preparation may open a native process"); });
    const runner = new ScopedAgentExecutionRunner(f.db, f.ordinaryGit, { invoke }, () => f.projectPath, { automaticCheckpoint: false });
    await expect(runner.prepareDelivery(f.input)).rejects.toThrow("differs from its original reserved bases");
    expect(invoke).not.toHaveBeenCalled(); expect(f.db.scopedAgentTurn(P, f.next.id, 2)).toBeUndefined();
    expect(f.snapshot()).toEqual(before); expect(f.db.eventsAfter(P)).toEqual(events);
    expect(f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs);
    expect(f.rawGit(["symbolic-ref", "--short", "HEAD"])).toBe(branch);
  }, 30_000);

  it("rejects stale ownership, wrong directory and non-delivery authority without writing refs", async () => {
    const f = await preparedFixture(), before = f.snapshot(), refs = f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"]);
    await expect(f.ordinaryGit.observeDeliveryPreparation({ ...f.authority, ownershipEpoch: 1 }, 1)).rejects.toThrow();
    await expect(f.ordinaryGit.observeDeliveryPreparation({ ...f.authority, worktreePath: f.projectPath }, 2)).rejects.toThrow("fixed project path");
    await expect(f.ordinaryGit.observeDeliveryPreparation({ ...f.authority, purpose: "final-integration" }, 2)).rejects.toThrow("delivery execution");
    expect(f.snapshot()).toEqual(before); expect(f.rawGit(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs);
  }, 30_000);

  it.each(["branch", "base"] as const)("rejects an actual %s ref change during its read instead of accepting a mixed preparation fact", async mode => {
    const f = await preparedFixture(), journal = f.db.operationsForProject(P, true), before = f.snapshot();
    const tree = f.rawGit(["rev-parse", `${f.retained.baseCommit}^{tree}`]);
    const changed = f.rawGit(["commit-tree", tree, "-p", f.retained.baseCommit, "-m", "Concurrent real ref change"]);
    const ref = mode === "branch" ? `refs/heads/${f.next.executionBranch}` : `refs/openfars/execution-bases/${f.next.id}`;
    let checks = 0;
    const originalAssert = journal.assertExecutionOwnership.bind(journal);
    vi.spyOn(journal, "assertExecutionOwnership").mockImplementation(async assertion => {
      await originalAssert(assertion);
      if (++checks === 2) f.rawGit(["update-ref", ref, changed]);
    });
    const { git } = f.makeGit(undefined, journal);
    await expect(git.observeDeliveryPreparation(f.authority, 2)).rejects.toThrow("refs changed during observation");
    expect(checks).toBe(2); expect(f.snapshot()).toEqual(before); expect(f.rawGit(["rev-parse", ref])).toBe(changed);
  }, 30_000);
});
