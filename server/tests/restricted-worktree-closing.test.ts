import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationGitFacade, ExecFileGitCommandRunner, GitOwnershipStaleError, LocalCollaborationGitService,
  restrictedClosingPaths, type CollaborationGitOperationStore, type GitCommandRequest,
  type GitExecutionAuthority, type RestrictedWorktreeClosingScope } from "../src/collaboration-git/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-restricted-closing-")); roots.push(root);
  const projectRoot = path.join(root, "project"); await fs.mkdir(projectRoot);
  const prepare = vi.fn(async () => { throw new Error("Observation cannot prepare a Git operation"); });
  const transition = vi.fn(async () => { throw new Error("Observation cannot transition a Git operation"); });
  let revoked = false;
  let closing: GitExecutionAuthority["restrictedClosing"];
  const assertExecutionOwnership = vi.fn(async input => {
    if (revoked || input.projectId !== "project" || input.executionId !== "original" || input.ownershipEpoch !== 4 ||
      input.expectedBranch !== "executions/original" ||
      (input.operation !== "retained.observe" && (!closing || JSON.stringify(input.restrictedClosing) !== JSON.stringify(closing)))) throw new GitOwnershipStaleError("original", 4);
  });
  const operationStore: CollaborationGitOperationStore = { prepare, transition, assertExecutionOwnership,
    checkpointInitialization: vi.fn(), recordMergedSynchronization: vi.fn(), recordRestrictedClosingCheckpoint: vi.fn() };
  const commands: GitCommandRequest[] = [];
  const delegate = new ExecFileGitCommandRunner();
  let beforeCommand: ((request: GitCommandRequest) => Promise<void>) | undefined;
  const local = new LocalCollaborationGitService({ projectId: "project", projectRoot, operationStore,
    worktreeMode: "agent", allowLocalRemotes: true, runner: { run: async request => {
      commands.push(request); await beforeCommand?.(request); return delegate.run(request);
    } } });
  await local.initializeMain({ title: "Closing test", operationId: "init" });
  const worktreePath = await local.prepareAgentManagementWorkspace("worker");
  const git = (args: string[], cwd = worktreePath) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "Original Agent", GIT_AUTHOR_EMAIL: "worker@example.test",
      GIT_COMMITTER_NAME: "Original Agent", GIT_COMMITTER_EMAIL: "worker@example.test" }
  }).trim();
  git(["checkout", "-b", "executions/original"]);
  await fs.mkdir(path.join(worktreePath, "agent-memory", "worker"), { recursive: true });
  const memory = "agent-memory/worker/Memory.md";
  await fs.writeFile(path.join(worktreePath, memory), "Original completed work\n");
  await fs.writeFile(path.join(worktreePath, "business.txt"), "Original business result\n");
  const commit = (message: string) => { git(["add", "--all"]); git(["commit", "-m", message]); return git(["rev-parse", "HEAD"]); };
  const reportHeadSha = commit("Original immutable report head");
  const execution: GitExecutionAuthority = { id: "original", agentId: "worker", ownershipEpoch: 4,
    purpose: "delivery", executionBranch: "executions/original", worktreePath };
  const scope = (paths: string[] = [memory], kind: RestrictedWorktreeClosingScope["kind"] = "bound-report-memory") =>
    ({ kind, reportHeadSha, paths });
  const observe = (manifest = scope()) => local.observeRestrictedWorktreeClosing(execution, 4, manifest);
  commands.length = 0;
  return { root, local, projectRoot, worktreePath, git, memory, execution, reportHeadSha, scope, observe, commit,
    prepare, transition, commands, assertExecutionOwnership, operationStore,
    grant: (manifest = scope()): GitExecutionAuthority => {
      closing = { invocationId: "inv_closing", capabilityHash: "d".repeat(64), scope: manifest };
      return { ...execution, restrictedClosing: closing };
    },
    revoke: () => { revoked = true; }, intercept: (callback: typeof beforeCommand) => { beforeCommand = callback; } };
}

describe("read-only discovery of exact original-task closing files", () => {
  const discover = (f: Awaited<ReturnType<typeof fixture>>, kind: RestrictedWorktreeClosingScope["kind"] = "bound-report-memory") =>
    f.local.identifyRestrictedWorktreeClosing(f.execution, 4, { kind, reportHeadSha: f.reportHeadSha });

  it("returns no candidate for clean A without writing the index, refs, files or operation journal", async () => {
    const f = await fixture(), index = f.git(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const before = await fs.readFile(index), memory = await fs.readFile(path.join(f.worktreePath, f.memory));
    const facade = new CollaborationGitFacade({ localGit: f.local, operationStore: f.operationStore, provider: {} as never });
    expect(await facade.identifyRestrictedWorktreeClosing(f.execution, 4, { kind: "bound-report-memory", reportHeadSha: f.reportHeadSha })).toBeUndefined();
    expect(await fs.readFile(index)).toEqual(before); expect(await fs.readFile(path.join(f.worktreePath, f.memory))).toEqual(memory);
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.reportHeadSha); expect(f.prepare).not.toHaveBeenCalled(); expect(f.transition).not.toHaveBeenCalled();
    expect(f.commands.some(request => ["add", "commit", "commit-tree", "update-ref", "push", "reset", "clean", "checkout", "switch", "read-tree"].includes(request.args[0]!))).toBe(false);
    expect(f.assertExecutionOwnership.mock.calls.every(([input]) => input.operation === "retained.observe")).toBe(true);
  });

  it.each([false, true])("identifies necessary original Memory after A (committed=%s)", async committed => {
    const f = await fixture(); await fs.appendFile(path.join(f.worktreePath, f.memory), "Necessary original Memory\n");
    const head = committed ? f.commit("Original necessary B") : f.reportHeadSha;
    const observed = await discover(f);
    expect(observed).toMatchObject({ reportHeadSha: f.reportHeadSha, head, authorizedPaths: [f.memory],
      pendingPaths: committed ? [] : [f.memory], committedPaths: committed ? [f.memory] : [], deliveryRequired: committed });
    expect(f.git(["rev-parse", "HEAD"])).toBe(head); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("identifies the exact union of committed and pending completed-owner files, including both rename sides", async () => {
    const f = await fixture(); f.git(["mv", "business.txt", "renamed result.txt"]); const head = f.commit("Original Agent's retained rename");
    await fs.writeFile(path.join(f.worktreePath, "temporary result.txt"), "Original task leftover\n");
    const observed = await discover(f, "completed-leftovers");
    expect(observed).toMatchObject({ head, committedPaths: ["business.txt", "renamed result.txt"], pendingPaths: ["temporary result.txt"],
      authorizedPaths: ["business.txt", "renamed result.txt", "temporary result.txt"], deliveryRequired: true });
  });

  it("identifies both sides of a pending staged rename without deciding whether it should be kept", async () => {
    const f = await fixture(); f.git(["mv", "business.txt", "pending result.txt"]);
    const observed = await discover(f, "completed-leftovers");
    expect(observed!.authorizedPaths).toEqual(["business.txt", "pending result.txt"]);
    expect(observed!.committedPaths).toEqual([]); expect(observed!.deliveryRequired).toBe(false);
  });

  it.each(["business.txt", "untracked.txt", "agent-memory/other/Memory.md", "runtime/unsafe.txt", "alias.txt"])("refuses unknown, foreign or aliased failed-owner file %s", async file => {
    const f = await fixture(), target = path.join(f.worktreePath, file); await fs.mkdir(path.dirname(target), { recursive: true });
    if (file === "alias.txt") await fs.symlink("business.txt", target); else await fs.writeFile(target, "Uncertain scope\n");
    if (file.startsWith("runtime/")) f.git(["add", "-f", "--", file]);
    await expect(discover(f)).rejects.toThrow(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("refuses excluded-looking runtime files without granting authority or modifying them", async () => {
    const f = await fixture(), target = path.join(f.worktreePath, "runtime/native.json");
    await fs.mkdir(path.dirname(target)); await fs.writeFile(target, "Internal runtime evidence\n");
    await expect(discover(f)).rejects.toThrow("exact owned business file");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("Internal runtime evidence\n");
  });

  it.each(["symlink", "hardlink", "committed-symlink", "committed-submodule"])("does not turn %s into a writable candidate", async kind => {
    const f = await fixture(), target = path.join(f.worktreePath, "alias");
    if (kind === "hardlink") await fs.link(path.join(f.worktreePath, "business.txt"), target);
    else if (kind === "committed-submodule") {
      f.git(["update-index", "--add", "--cacheinfo", `160000,${f.reportHeadSha},alias`]); f.git(["commit", "-m", "Unsupported gitlink"]);
    } else {
      await fs.symlink("business.txt", target); if (kind === "committed-symlink") f.commit("Unsupported symbolic link");
    }
    await expect(discover(f, "completed-leftovers")).rejects.toThrow();
  });

  it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer", "index.lock"])("rejects unfinished %s even when A has no pending paths", async marker => {
    const f = await fixture(), target = f.git(["rev-parse", "--path-format=absolute", "--git-path", marker]);
    if (["rebase-apply", "rebase-merge", "sequencer"].includes(marker)) await fs.mkdir(target); else await fs.writeFile(target, f.reportHeadSha);
    await expect(discover(f)).rejects.toThrow();
  });

  it("refuses a moved head with no changed files instead of treating clean status as settlement", async () => {
    const f = await fixture(); f.git(["commit", "--allow-empty", "-m", "Independent empty B"]);
    await expect(discover(f)).rejects.toThrow("without identifiable file changes");
  });

  it.each(["missing", "divergent", "revoked", "branch"])("refuses %s original authority before identifying files", async fault => {
    const f = await fixture(); await fs.appendFile(path.join(f.worktreePath, f.memory), "Pending Memory\n");
    if (fault === "revoked") f.revoke();
    if (fault === "branch") f.git(["switch", "-c", "other"]);
    if (fault === "divergent") {
      const tree = f.git(["rev-parse", "HEAD^{tree}"]), unrelated = f.git(["commit-tree", tree, "-m", "Unrelated root"]);
      f.git(["reset", "--hard", unrelated]);
    }
    await expect(f.local.identifyRestrictedWorktreeClosing(f.execution, 4, { kind: "bound-report-memory",
      reportHeadSha: fault === "missing" ? "f".repeat(40) : f.reportHeadSha })).rejects.toThrow();
  });

  it.each(["path", "head", "alias", "owner"])("rejects a late %s change between initial status and exact revalidation", async fault => {
    const f = await fixture(); await fs.appendFile(path.join(f.worktreePath, f.memory), "Pending original Memory\n"); let changed = false;
    f.intercept(async request => {
      if (changed || request.args[0] !== "diff-tree") return; changed = true;
      if (fault === "path") await fs.writeFile(path.join(f.worktreePath, "late.txt"), "Not observed earlier");
      if (fault === "head") f.commit("Late head change");
      if (fault === "alias") { await fs.unlink(path.join(f.worktreePath, f.memory)); await fs.symlink("../../business.txt", path.join(f.worktreePath, f.memory)); }
      if (fault === "owner") f.revoke();
    });
    await expect(discover(f)).rejects.toThrow(); expect(f.prepare).not.toHaveBeenCalled();
  });
});

describe("invocation-bound exact closing checkpoints", () => {
  it("commits only the original Agent's Memory on its explicit request and preserves report A", async () => {
    const f = await fixture(), execution = f.grant();
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Necessary closing memory\n");
    const fact = await f.local.checkpointExecution(execution, 4, { kind: "checkpoint", reason: "Save my necessary closing memory", operationMarker: "closing-push" });
    expect(fact).toMatchObject({ changed: true, operationMarker: "closing-push", reportHeadSha: f.reportHeadSha, pendingPaths: [], committedPaths: [f.memory] });
    expect(f.git(["show", `${f.reportHeadSha}:${f.memory}`])).toBe("Original completed work");
    expect(f.git(["show", "-s", "--format=%B", fact.commitSha])).toBe("Save my necessary closing memory");
    expect(f.git(["show", "-s", "--format=%an", fact.commitSha])).toBe("OpenFARS Agent worker");
    expect(f.git(["rev-parse", `${fact.commitSha}^`])).toBe(f.reportHeadSha);
    expect(f.assertExecutionOwnership.mock.calls.filter(([input]) => input.operation === "checkpoint").every(([input]) => input.restrictedClosing === execution.restrictedClosing)).toBe(true);
    const replay = await f.local.checkpointExecution(execution, 4, { kind: "checkpoint", reason: "Publish my retained B" });
    expect(replay.commitSha).toBe(fact.commitSha); expect(replay.changed).toBe(true);
  });

  it("uses report A as the delivery baseline when B was already committed and the directory is clean", async () => {
    const f = await fixture(); await fs.appendFile(path.join(f.worktreePath, f.memory), "Already committed closing\n");
    const head = f.commit("Original Agent's B"), execution = f.grant();
    const fact = await f.local.checkpointExecution(execution, 4, { kind: "checkpoint", reason: "Publish B" });
    expect(fact).toMatchObject({ changed: true, commitSha: head, pendingPaths: [] });
    expect(f.commands.some(request => request.args[0] === "commit-tree")).toBe(false);
  });

  it("adds and deletes exact files, including spaces, without staging a directory", async () => {
    const f = await fixture(), file = "workspace/-my closing file.txt";
    await fs.mkdir(path.dirname(path.join(f.worktreePath, file)), { recursive: true });
    await fs.writeFile(path.join(f.worktreePath, file), "Original Agent chooses to keep this\n");
    await fs.unlink(path.join(f.worktreePath, "business.txt"));
    const execution = f.grant(f.scope([file, "business.txt"], "completed-leftovers"));
    const fact = await f.local.checkpointExecution(execution, 4, { kind: "checkpoint", reason: "Keep my file and remove my obsolete result" });
    expect(fact.changed).toBe(true); expect(f.git(["diff", "--name-only", f.reportHeadSha, fact.commitSha]).split("\n").sort()).toEqual(["business.txt", file]);
    expect(f.commands.find(request => request.args[0] === "add")?.args).toEqual(["add", "--all", "--", ":(literal)business.txt", `:(literal)${file}`]);
  });

  it.each(["extra-untracked", "extra-staged", "extra-committed", "symlink", "hardlink", "filter", "missing-reason", "conflict-kind", "revoked"])("rejects %s before advancing the original ref", async fault => {
    const f = await fixture(), execution = f.grant();
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Pending Memory\n");
    if (fault.startsWith("extra-")) {
      await fs.writeFile(path.join(f.worktreePath, "foreign.txt"), "Other task\n");
      if (fault === "extra-staged") f.git(["add", "--", "foreign.txt"]);
      if (fault === "extra-committed") f.commit("Already unauthorized");
    }
    if (fault === "symlink" || fault === "hardlink") {
      await fs.unlink(path.join(f.worktreePath, f.memory));
      if (fault === "symlink") await fs.symlink("../../business.txt", path.join(f.worktreePath, f.memory));
      else await fs.link(path.join(f.worktreePath, "business.txt"), path.join(f.worktreePath, f.memory));
    }
    if (fault === "filter") {
      f.git(["config", "filter.danger.clean", "touch filter-must-not-run"]);
      await fs.writeFile(path.join(f.local.repositoryPath, "info", "attributes"), `${f.memory} filter=danger\n`);
    }
    if (fault === "revoked") f.revoke();
    const head = f.git(["rev-parse", "HEAD"]);
    await expect(f.local.checkpointExecution(execution, 4, { kind: fault === "conflict-kind" ? "conflict-resolution" : "checkpoint",
      ...(fault === "missing-reason" ? {} : { reason: "Explicit request" }) })).rejects.toThrow();
    expect(f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(f.commands.some(request => request.args[0] === "update-ref")).toBe(false);
    expect(await fs.stat(path.join(f.worktreePath, "filter-must-not-run")).catch(() => undefined)).toBeUndefined();
  });

  it.each(["write-tree", "commit-tree"])("does not commit a foreign index entry injected at %s", async command => {
    const f = await fixture(), execution = f.grant();
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Closing content\n");
    let injected = false;
    f.intercept(async request => {
      if (injected || request.args[0] !== command) return;
      injected = true; await fs.writeFile(path.join(f.worktreePath, "foreign.txt"), "Must stay outside B\n"); f.git(["add", "--", "foreign.txt"]);
    });
    await expect(f.local.checkpointExecution(execution, 4, { kind: "checkpoint", reason: "Save only my Memory" })).rejects.toThrow();
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.reportHeadSha);
    expect(f.git(["status", "--porcelain=v1"])).toContain("foreign.txt");
  });

  it("checks the same live invocation immediately before advancing the ref", async () => {
    const f = await fixture(), execution = f.grant(); await fs.appendFile(path.join(f.worktreePath, f.memory), "Closing\n");
    f.intercept(async request => { if (request.args[0] === "update-ref") f.revoke(); });
    await expect(f.local.checkpointExecution(execution, 4, { kind: "checkpoint", reason: "My closing" })).rejects.toThrow();
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.reportHeadSha);
  });

  it.each(["worktree.create", "merge.prepare", "merge.integrate"])("does not turn the closing binding into %s authority", async operation => {
    const f = await fixture(), execution = f.grant();
    const result = operation === "worktree.create" ? f.local.createDeliveryWorktree(execution, 4, { kind: "main" })
      : operation === "merge.prepare" ? f.local.prepareOwnerResolution(execution, 4, { kind: "main", expectedHead: f.reportHeadSha })
      : f.local.integrateExecutionIntoMain(execution, 4, f.reportHeadSha, f.reportHeadSha);
    await expect(result).rejects.toThrow("general business Git authority");
  });

  it("publishes exactly the checkpoint SHA and refuses a different or dirty head", async () => {
    const f = await fixture(), execution = f.grant(), remote = path.join(f.root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" }); await f.local.configureOrigin(remote);
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Closing publication\n");
    const fact = await f.local.checkpointExecution(execution, 4, { kind: "checkpoint", reason: "My memory delivery" });
    await expect(f.local.pushExecution(execution, 4, undefined, f.reportHeadSha)).rejects.toThrow("exact clean checkpoint");
    expect(await f.local.pushExecution(execution, 4, undefined, fact.commitSha)).toBe(fact.commitSha);
    expect(f.git(["rev-parse", "refs/heads/executions/original"], remote)).toBe(fact.commitSha);
    expect(f.commands.find(request => request.args[0] === "push")?.args.at(-1)).toBe(`${fact.commitSha}:refs/heads/executions/original`);
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Not yet committed\n");
    await expect(f.local.pushExecution(execution, 4, undefined, fact.commitSha)).rejects.toThrow("exact clean checkpoint");
  });

  it.each(["create", "merge", "close"] as const)("fences %s PR by the exact clean closing B and carries native authority to the provider boundary", async operation => {
    const f = await fixture(), execution = f.grant(); await fs.appendFile(path.join(f.worktreePath, f.memory), "B\n");
    const head = f.commit("Original Agent's separate closing B");
    const provider = { openPullRequest: vi.fn(async () => ({ status: "open" })),
      mergePullRequest: vi.fn(async () => ({ status: "conflicted" })), closePullRequest: vi.fn(async () => ({ status: "closed" })) };
    const git = new CollaborationGitFacade({ localGit: f.local, operationStore: f.operationStore,
      provider: provider as unknown as ConstructorParameters<typeof CollaborationGitFacade>[0]["provider"] });
    const repository = { provider: "github" as const, providerId: 1, owner: "example", name: "project", private: true,
      defaultBranch: "main" as const, htmlUrl: "https://github.com/example/project", cloneUrl: "https://github.com/example/project.git", observedAt: new Date().toISOString() };
    const invoke = (expectedHead: string) => operation === "create"
      ? git.createPullRequest({ repository, execution, ownershipEpoch: 4, operationId: "closing-create", expectedHead, base: "main", title: "My closing", body: "Only my authorized files" })
      : operation === "merge" ? git.mergePullRequest({ repository, execution, ownershipEpoch: 4, operationId: "closing-merge", expectedHead, expectedBase: "main", providerNumber: 1 })
      : git.closePullRequest({ repository, execution, ownershipEpoch: 4, operationId: "closing-close", expectedHead, expectedBase: "main", providerNumber: 1 });
    await expect(invoke(f.reportHeadSha)).rejects.toThrow("own exact clean B");
    await invoke(head);
    const mutation = f.assertExecutionOwnership.mock.calls.filter(([input]) => ["provider.mutate", "provider.close_terminal"].includes(input.operation));
    expect(mutation.length).toBeGreaterThan(0); expect(mutation.every(([input]) => input.restrictedClosing === execution.restrictedClosing)).toBe(true);
    Object.values(provider).forEach(spy => spy.mockClear());
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Uncommitted after B\n");
    await expect(invoke(head)).rejects.toThrow("own exact clean B");
    await fs.writeFile(path.join(f.worktreePath, "foreign.txt"), "Another task\n");
    await expect(invoke(head)).rejects.toThrow("outside the manager-authorized manifest");
    expect(Object.values(provider).every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  it.each(["revoked", "head-moved", "late-file"])("refuses %s immediately before the actual closing push", async fault => {
    const f = await fixture(), execution = f.grant(), remote = path.join(f.root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" }); await f.local.configureOrigin(remote);
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Closing B\n");
    const head = f.commit("My separate B");
    f.intercept(async request => {
      if (request.args[0] !== "push") return;
      if (fault === "revoked") f.revoke();
      else {
        await fs.appendFile(path.join(f.worktreePath, f.memory), "Late modification\n");
        if (fault === "head-moved") f.commit("Another B after the request");
      }
    });
    await expect(f.local.pushExecution(execution, 4, undefined, head)).rejects.toThrow();
    expect(f.git(["for-each-ref", "refs/heads"], remote)).toBe("");
  });

  it.each([["--all"], ["-z", "filter", "--", "../foreign"], ["-z", "filter", "--", ".git/config"],
    ["-z", "filter", "--", ":(glob)*"], ["-z", "filter", "--", "/outside"], ["-z", "diff", "--", "Memory.md"]])("refuses check-attr arguments %j outside exact closing observation", async (...args) => {
    const runner = new ExecFileGitCommandRunner();
    await expect(runner.run({ cwd: os.tmpdir(), args: ["check-attr", ...args] })).rejects.toThrow("fixed options");
  });
});

describe("restricted original-task closing observations", () => {
  it("retains the original head, files, index and Git journal while exposing only the requested Memory change", async () => {
    const f = await fixture();
    await fs.appendFile(path.join(f.worktreePath, f.memory), "Original Agent's necessary closing memory\n");
    f.git(["add", "--", f.memory]);
    const status = f.git(["status", "--porcelain=v1"]), index = f.git(["ls-files", "--stage"]);
    const fact = await f.observe();
    expect(fact).toMatchObject({ executionId: "original", ownershipEpoch: 4, head: f.reportHeadSha,
      reportHeadSha: f.reportHeadSha, pendingPaths: [f.memory], committedPaths: [], deliveryRequired: false });
    expect(f.git(["status", "--porcelain=v1"])).toBe(status);
    expect(f.git(["ls-files", "--stage"])).toBe(index);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.transition).not.toHaveBeenCalled();
    expect(f.commands.every(request => !["add", "commit", "reset", "checkout", "update-ref", "push", "merge", "stash", "clean"].includes(request.args[0]!))).toBe(true);
    expect(f.assertExecutionOwnership.mock.calls.every(([input]) => input.operation === "retained.observe")).toBe(true);
  });

  it("requires a separate delivery for a clean descendant closing head without replacing the report", async () => {
    const f = await fixture(); await fs.appendFile(path.join(f.worktreePath, f.memory), "Closing memory\n");
    const closingHead = f.commit("Original Agent closing memory");
    const fact = await f.observe();
    expect(fact).toMatchObject({ head: closingHead, reportHeadSha: f.reportHeadSha,
      committedPaths: [f.memory], pendingPaths: [], deliveryRequired: true });
    expect((await f.observe()).head).toBe(closingHead);
  });

  it("accepts the exact completed-task leftover manifest and its Agent-selected cleanup", async () => {
    const f = await fixture(), files = ["compute/probe.js", "workspace/probe with spaces.js"];
    for (const file of files) { await fs.mkdir(path.dirname(path.join(f.worktreePath, file)), { recursive: true }); await fs.writeFile(path.join(f.worktreePath, file), "temporary probe\n"); }
    const manifest = f.scope(files, "completed-leftovers");
    expect((await f.observe(manifest)).pendingPaths.sort()).toEqual([...files].sort());
    // Fixture models an explicit original-Agent cleanup, never a service exit hook.
    for (const file of files) await fs.unlink(path.join(f.worktreePath, file));
    expect(await f.observe(manifest)).toMatchObject({ pendingPaths: [], committedPaths: [], deliveryRequired: false });
  });

  it("allows an authorized tracked deletion and checks both paths of a rename", async () => {
    const f = await fixture();
    await fs.rename(path.join(f.worktreePath, "business.txt"), path.join(f.worktreePath, "renamed.txt"));
    const head = f.commit("Agent selected necessary closing delivery");
    await expect(f.observe(f.scope(["renamed.txt"], "completed-leftovers"))).rejects.toThrow("outside");
    expect(await f.observe(f.scope(["business.txt", "renamed.txt"], "completed-leftovers")))
      .toMatchObject({ head, committedPaths: ["business.txt", "renamed.txt"], deliveryRequired: true });
  });

  it.each(["staged", "unstaged", "untracked", "committed"])("rejects an extra %s business path", async state => {
    const f = await fixture(); await fs.writeFile(path.join(f.worktreePath, state === "untracked" ? "extra.txt" : "business.txt"), "Extra business edit\n");
    if (state === "staged") f.git(["add", "--", "business.txt"]);
    if (state === "committed") f.commit("Unauthorized business change");
    await expect(f.observe()).rejects.toThrow("outside");
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.transition).not.toHaveBeenCalled();
  });

  it("rejects a divergent head even when its only change is the authorized Memory", async () => {
    const f = await fixture(); f.git(["checkout", "--orphan", "fork"]); f.git(["add", "--all"]); f.git(["commit", "-m", "Unrelated root"]);
    const fork = f.git(["rev-parse", "HEAD"]); f.git(["checkout", "executions/original"]); f.git(["reset", "--hard", fork]);
    await expect(f.observe()).rejects.toThrow("not descended");
  });

  it("rejects a missing report object and a checkout on another branch", async () => {
    const f = await fixture(); await expect(f.observe({ ...f.scope(), reportHeadSha: "f".repeat(40) })).rejects.toThrow("does not exist");
    f.git(["checkout", "-b", "other"]); await expect(f.observe()).rejects.toThrow("another branch");
  });

  it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer", "index.lock"])("rejects an unfinished %s operation without cleaning it", async marker => {
    const f = await fixture(), location = f.git(["rev-parse", "--path-format=absolute", "--git-path", marker]);
    await fs.writeFile(location, `${f.reportHeadSha}\n`);
    await expect(f.observe()).rejects.toThrow("unfinished Git operation");
    expect(await fs.readFile(location, "utf8")).toBe(`${f.reportHeadSha}\n`);
  });

  it("rejects an unresolved index after the marker has been removed", async () => {
    const f = await fixture(), blob = f.git(["rev-parse", `${f.reportHeadSha}:business.txt`]);
    execFileSync("git", ["update-index", "--index-info"], { cwd: f.worktreePath,
      input: `0 ${"0".repeat(40)}\tbusiness.txt\n100644 ${blob} 1\tbusiness.txt\n100644 ${blob} 2\tbusiness.txt\n`, encoding: "utf8" });
    await expect(f.observe(f.scope(["business.txt"], "completed-leftovers"))).rejects.toThrow("index conflicts");
  });

  it.each(["file-symlink", "parent-symlink", "hardlink", "directory"])("rejects an authorized path replaced by a %s", async alias => {
    const f = await fixture(), memoryPath = path.join(f.worktreePath, f.memory), outside = path.join(f.root, "outside.txt");
    await fs.writeFile(outside, "Other owner's file\n");
    if (alias === "parent-symlink") {
      await fs.rename(path.dirname(memoryPath), path.join(f.root, "old-memory"));
      await fs.symlink(path.join(f.root, "old-memory"), path.dirname(memoryPath));
    } else {
      await fs.unlink(memoryPath);
      if (alias === "file-symlink") await fs.symlink(outside, memoryPath);
      if (alias === "hardlink") await fs.link(outside, memoryPath);
      if (alias === "directory") await fs.mkdir(memoryPath);
    }
    await expect(f.observe()).rejects.toThrow("regular files");
    expect(await fs.readFile(outside, "utf8")).toBe("Other owner's file\n");
  });

  it("rejects a committed symlink even when it no longer exists in the checkout", async () => {
    const f = await fixture(); await fs.unlink(path.join(f.worktreePath, f.memory)); await fs.symlink("../../business.txt", path.join(f.worktreePath, f.memory));
    f.commit("Unauthorized type change"); await fs.unlink(path.join(f.worktreePath, f.memory));
    await expect(f.observe()).rejects.toThrow("unsupported");
  });

  it("rejects a submodule change under an authorized name", async () => {
    const f = await fixture(); f.git(["update-index", "--add", "--cacheinfo", `160000,${f.reportHeadSha},module`]);
    f.git(["commit", "-m", "Unauthorized gitlink"]);
    await expect(f.observe(f.scope(["module"], "completed-leftovers"))).rejects.toThrow("unsupported");
  });

  it("rechecks the original owner after async IO and refuses a moved head", async () => {
    const f = await fixture(); let acted = false;
    f.intercept(async request => {
      if (!acted && request.args[0] === "diff-tree") { acted = true; f.revoke(); }
    });
    await expect(f.observe()).rejects.toBeInstanceOf(GitOwnershipStaleError);
    const g = await fixture(); let moved = false;
    g.intercept(async request => {
      if (!moved && request.args[0] === "diff-tree") { moved = true; await fs.appendFile(path.join(g.worktreePath, g.memory), "Late write\n"); g.commit("Concurrent head"); }
    });
    await expect(g.observe()).rejects.toThrow("changed during");
  });

  it("rejects an extra late pending path and cancellation before commands", async () => {
    const f = await fixture(); let acted = false;
    f.intercept(async request => { if (!acted && request.args[0] === "diff-tree") { acted = true; await fs.writeFile(path.join(f.worktreePath, "late.txt"), "Late write\n"); } });
    await expect(f.observe()).rejects.toThrow("changed during");
    const controller = new AbortController(); controller.abort();
    await expect(f.local.observeRestrictedWorktreeClosing(f.execution, 4, f.scope(), controller.signal)).rejects.toThrow();
  });

  it.each(["pending", "committed"])("requires complete %s observations beyond display retention", async state => {
    const f = await fixture(), files = Array.from({ length: 220 }, (_, index) => `${String(index).padStart(4, "0")}-${"f".repeat(75)}.txt`);
    await Promise.all(files.map(file => fs.writeFile(path.join(f.worktreePath, file), "Closing data\n")));
    if (state === "committed") f.commit("Large authorized closing diff");
    if (state === "committed") {
      await expect(f.observe(f.scope(files, "completed-leftovers"))).rejects.toThrow("complete observation limit");
    } else {
      expect(Buffer.byteLength(f.git(["status", "--porcelain=v1", "-z"]))).toBeGreaterThan(16_000);
      expect(await f.observe(f.scope(files, "completed-leftovers"))).toMatchObject({
        pendingPaths: [...files].sort(), authorizedPaths: [...files].sort(), committedPaths: [], deliveryRequired: false
      });
    }
    expect(f.git(["status", "--porcelain=v1"]).split("\n").filter(Boolean)).toHaveLength(state === "pending" ? files.length : 0);
  });

  it("checks the second asynchronous pass for a head change", async () => {
    const f = await fixture(); let diffs = 0;
    f.intercept(async request => {
      if (request.args[0] === "diff-tree" && ++diffs === 2) {
        await fs.appendFile(path.join(f.worktreePath, f.memory), "Late closing edit\n"); f.commit("Late head");
      }
    });
    await expect(f.observe()).rejects.toThrow("changed during");
  });
});

describe("exact manager-authorized closing manifests", () => {
  it.each(["../business.txt", "a/../business.txt", "/business.txt", "a//b", "a/./b", "a\\b", ":(glob)**", "*.js", "a\nb", ".git/config", "a/.GiT/config", ".scienceevolve/inbox", "Memory.md", "runtime/turn", "workflow/definition.json", "agent-memory/other/Memory.md"])("rejects %j", file => {
    expect(() => restrictedClosingPaths({ agentId: "worker" }, { kind: "completed-leftovers", reportHeadSha: "a".repeat(40), paths: [file] })).toThrow();
  });
  it("rejects duplicate, overlapping and overbroad bound-report Memory manifests", () => {
    for (const paths of [["a", "a"], ["a", "a/b"], []]) expect(() => restrictedClosingPaths({ agentId: "worker" },
      { kind: "completed-leftovers", reportHeadSha: "a".repeat(40), paths })).toThrow();
    expect(() => restrictedClosingPaths({ agentId: "worker" }, { kind: "bound-report-memory", reportHeadSha: "a".repeat(40),
      paths: ["agent-memory/worker/Memory.md", "business.txt"] })).toThrow("only");
  });
  it("does not expose general diff-tree options through the fixed Git runner", async () => {
    const runner = new ExecFileGitCommandRunner();
    for (const args of [["diff-tree", "--ext-diff", "HEAD"], ["diff-tree", "--no-commit-id", "-r", "--raw", "-z", "--no-renames", "HEAD", "a".repeat(40), "--"]]) {
      await expect(runner.run({ cwd: "/tmp", args })).rejects.toThrow("two exact commits");
    }
  });
});
