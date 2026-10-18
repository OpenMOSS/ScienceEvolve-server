import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { P, cleanupClosingFixtures, authorizedClosingFixture } from "./helpers/scoped-worktree-closing-fixture.js";
import { deliveredClosingFixture } from "./helpers/scoped-worktree-closing-delivery-fixture.js";

afterEach(cleanupClosingFixtures);
describe("read-only actual closing integration target", () => {
  it.each(["completed", "failed"] as const)("observes the actual %s owner's common local/remote base containing A and B", async status => {
    const f = await deliveredClosingFixture(status), { git, provider } = f.makeGit(), before = f.snapshot(), events = f.db.eventsAfter(P);
    const proof = f.inspect().proof!, heads = [f.A, proof.business.pullRequest.mergeCommitSha!,
      proof.supplement!.headSha, proof.supplement!.pullRequest.mergeCommitSha!];
    const target = await git.observeRestrictedWorktreeClosingTarget(f.repository, { ...f.execution, purpose: "delivery" }, 1, "groups/run-G", heads);
    expect(target).toMatchObject({ projectId: P, executionId: f.execution.id, ownershipEpoch: 1, owner: "example", repository: "project",
      targetBranch: "groups/run-G", localHead: proof.supplement!.synchronization.localHeadAfter,
      remoteHead: proof.supplement!.synchronization.remoteHead, includedHeads: [...new Set(heads)].sort() });
    expect(provider.observeRef).toHaveBeenCalledTimes(2); expect(provider.openPullRequest).not.toHaveBeenCalled();
    expect(provider.mergePullRequest).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before); expect(f.db.eventsAfter(P)).toEqual(events);
    expect(f.db.scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true);
  }, 30_000);

  it.each(["missing-remote", "wrong-repository", "wrong-ref", "local-behind", "missing-local", "missing-source", "unmerged-source", "wrong-owner", "wrong-epoch", "unsafe-target"])(
    "rejects %s without fetching, synchronizing or releasing", async fault => {
      const f = await authorizedClosingFixture({ businessDelivery: true }), { git, provider } = f.makeGit();
      const execution = { ...f.execution, purpose: "delivery" as const }, heads = [f.A, f.businessDelivery!.pullRequest.mergeCommitSha!];
      let branch = "groups/run-G", epoch = 1;
      if (fault === "missing-remote") provider.observeRef.mockResolvedValue({ owner: "example", repository: "project", ref: branch, status: "missing", observedAt: f.time() });
      if (fault === "wrong-repository") provider.observeRef.mockResolvedValue({ owner: "example", repository: "other", ref: branch,
        status: "present", sha: f.businessDelivery!.pullRequest.mergeCommitSha!, observedAt: f.time() });
      if (fault === "wrong-ref") provider.observeRef.mockResolvedValue({ owner: "example", repository: "project", ref: "groups/other",
        status: "present", sha: f.businessDelivery!.pullRequest.mergeCommitSha!, observedAt: f.time() });
      if (fault === "local-behind") f.rawGit(["update-ref", "refs/heads/groups/run-G", f.A]);
      if (fault === "missing-local") f.rawGit(["update-ref", "-d", "refs/heads/groups/run-G"]);
      if (fault === "missing-source") heads.push("f".repeat(40));
      if (fault === "unmerged-source") heads.push(f.rawGit(["commit-tree", f.rawGit(["rev-parse", `${f.A}^{tree}`]), "-p", f.A, "-m", "Unmerged real commit"]));
      if (fault === "wrong-owner") execution.id = "foreign";
      if (fault === "wrong-epoch") epoch = 2;
      if (fault === "unsafe-target") branch = "groups/run-G^{commit}";
      const before = f.snapshot(), events = f.db.eventsAfter(P), refs = f.rawGit(["show-ref"]), files = await fs.readFile(f.memory, "utf8");
      await expect(git.observeRestrictedWorktreeClosingTarget(f.repository, execution, epoch, branch, heads)).rejects.toThrow();
      expect(f.snapshot()).toEqual(before); expect(f.db.eventsAfter(P)).toEqual(events); expect(f.rawGit(["show-ref"])).toBe(refs);
      expect(await fs.readFile(f.memory, "utf8")).toBe(files);
      expect(provider.openPullRequest).not.toHaveBeenCalled(); expect(provider.mergePullRequest).not.toHaveBeenCalled();
    }, 30_000);

  it.each(["local", "remote"])("rejects an actual %s target change during observation", async where => {
    const f = await authorizedClosingFixture({ businessDelivery: true }), { git, provider } = f.makeGit();
    const merge = f.businessDelivery!.pullRequest.mergeCommitSha!, branch = "groups/run-G";
    provider.observeRef.mockResolvedValueOnce({ owner: "example", repository: "project", ref: branch, status: "present", sha: merge, observedAt: f.time() });
    provider.observeRef.mockImplementationOnce(async () => {
      if (where === "local") f.rawGit(["update-ref", "refs/heads/groups/run-G", f.A]);
      return { owner: "example", repository: "project", ref: branch, status: "present", sha: where === "remote" ? f.A : merge, observedAt: f.time() };
    });
    await expect(git.observeRestrictedWorktreeClosingTarget(f.repository, { ...f.execution, purpose: "delivery" }, 1, branch, [f.A, merge]))
      .rejects.toThrow(where === "local" ? "local branch differs" : "remote group target changed");
    expect(provider.observeRef).toHaveBeenCalledTimes(2); expect(f.db.scopedAgentHasUnreleasedActivity(P, "worker")).toBe(true);
  }, 30_000);
});
