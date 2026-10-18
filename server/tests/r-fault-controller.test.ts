import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { withholdR12MergeResponse } from "../src/acceptance-r12.js";
import { withholdR14ReportHead } from "../src/acceptance-r14.js";
import { rejectR03InitialFinish } from "../src/acceptance-r03.js";
import { requestR04PendingFile, observeR04PendingFile } from "../src/acceptance-r04-pending.js";
import { armR12 } from "../../scripts/r-projects/arm-r12.mjs";
import { armFault } from "../../scripts/r-projects/arm-fault.mjs";
import { armR04Preparation } from "../../scripts/r-projects/arm-r04-preparation.mjs";
import { buildManifest } from "../../scripts/r-projects/catalog.mjs";
import { agentGitOperationId } from "../src/agent-git-tools.js";
import type { ControlActionEnvelope, OperationRecord } from "../src/types.js";
import type { SynchronizedPullRequestFact } from "../src/collaboration-git/facade.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });
async function fixture(code = "R12") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r12-controller-")); roots.push(root);
  const directory = path.join(root, "controller"), projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const projectId = `prj_${"a".repeat(32)}`;
  const manifest = buildManifest({ runId: "fixture-r12", gatewayId: `gwy_${"a".repeat(32)}`, model: "model", harness: "pi",
    githubAccountId: `gha_${"b".repeat(32)}`, observedAt: new Date().toISOString(), evidencePath: "fixture-only.json" });
  const entry = manifest.cases.find((e) => e.code === code)!;
  const repository = { provider: "github" as const, providerId: 42, owner: "test", name: entry.payload.git.repositoryName,
    private: true, defaultBranch: "main", htmlUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git", observedAt: "2026-10-06T00:00:00Z" };
  const execution = { projectId, id: "scoped-exec-first", agentId: "implementer", groupRunId: "run-child",
    arrivalRequestId: "arrival-first", ownershipEpoch: 1, executionBranch: "executions/scoped-exec-first",
    worktreePath: projectRoot, purpose: "delivery" as const, status: "running" };
  const base = "groups/run-child";
  const project = { id: projectId, title: entry.payload.title, status: "running", agents: entry.payload.agents, scopedExecutions: [execution],
    scopedGroupRuns: [{ id: execution.groupRunId, groupId: "G_child", groupBranch: base }],
    git: { repository }, operations: [{ kind: "repository.create", status: "finalized", remoteFact: repository }],
    runtime: { activities: [{ kind: "turn", scopeKind: "scoped-agent", projectId, agentId: execution.agentId,
      executionId: execution.id, invocationId: "inv-first", ownershipEpoch: 1, leaseState: "current", inputId: `scoped:${execution.arrivalRequestId}:epoch:1` }] } };
  const submission = { status: "accepted", code, base: manifest.serviceUrl, projectId, payloadSha256: entry.payloadSha256 };
  const options = { code, directory, manifest, submission, project, executionId: execution.id, invocationId: "inv-first" };
  const envelope: ControlActionEnvelope = { schemaVersion: 1, projectId, agent: execution.agentId, invocationId: "inv-first",
    stateVersion: 1, callId: "merge-request", capabilityHash: "d".repeat(64), receivedAt: repository.observedAt,
    action: { tool: "github_merge_pr", providerNumber: 5 } };
  const result: SynchronizedPullRequestFact = { id: "pull-5", providerNumber: 5, owner: repository.owner, repository: repository.name,
    htmlUrl: "https://github.com/test/repo/pull/5",
    ownerExecutionId: execution.id, head: execution.executionBranch, base, headSha: "b".repeat(40),
    status: "merged", mergeCommitSha: "c".repeat(40), observedAt: repository.observedAt,
    localSynchronization: { projectId, operationId: "sync-exact", targetBranch: base, expectedSourceHead: "b".repeat(40),
      temporaryRef: "refs/openfars/sync", localHeadBefore: "a".repeat(40), observedAt: repository.observedAt,
      mergeCommitSha: "c".repeat(40), localHeadAfter: "c".repeat(40), remoteHead: "c".repeat(40), status: "synchronized" } };
  const input = { directory, projectTitle: project.title, projectRoot, execution, arrivalRequestId: execution.arrivalRequestId,
    groupRunId: execution.groupRunId, base, repository, envelope, result,
    operation: { id: `agent-git-${execution.id}-epoch-1-merge-request-merge`, kind: "pull.merge", status: "finalized",
      ownerExecutionId: execution.id, ownershipEpoch: 1, expectedHead: result.headSha, expectedBase: base, payloadHash: "a".repeat(64) } as OperationRecord };
  const consumed = path.join(directory, `${projectId}.consumed.json`);
  return { options, input, consumed, directory };
}

it.each([
  ["R04", "bounded"], ["R12", "bounded"], ["R04", "recorded-legacy"], ["R12", "recorded-legacy"]
] as const)("%s retains exact merge ownership for an oversized call ID using %s markers", async (code, identity) => {
  const f = await fixture(code);
  await armFault(f.options);
  f.input.envelope.receivedAt = new Date().toISOString();
  f.input.envelope.callId = `merge-${"a".repeat(120)}`;
  const legacy = `agent-git-${f.input.execution.id}-epoch-1-${f.input.envelope.callId}-merge`;
  expect(legacy.length).toBeGreaterThan(160);
  const bounded = agentGitOperationId(f.input, "merge");
  expect(bounded.length).toBeLessThanOrEqual(160);
  f.input.operation.id = identity === "bounded" ? bounded : legacy;
  const input = { ...f.input, inputId: `scoped:${f.input.arrivalRequestId}:epoch:1` };
  const foreign = { ...input, operation: { ...input.operation, id: `${bounded}-foreign` } };
  if (code === "R12") {
    await expect(withholdR12MergeResponse(foreign)).resolves.toBeUndefined();
    await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
    await expect(withholdR12MergeResponse(input)).rejects.toThrow(/ETIMEDOUT/);
    const receipt = JSON.parse(await fs.readFile(f.consumed, "utf8"));
    expect(receipt.operationId).toBe(input.operation.id);
    expect(receipt.result).toEqual(input.result);
    await expect(withholdR12MergeResponse(input)).resolves.toBeUndefined();
  } else {
    await expect(requestR04PendingFile(foreign)).rejects.toThrow(/bound delivery/);
    await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
    const result = await requestR04PendingFile(input) as any;
    expect(result.acceptancePendingFile).toBeDefined();
    const receipt = JSON.parse(await fs.readFile(f.consumed, "utf8"));
    expect(receipt.operation).toEqual(input.operation);
    expect(receipt.result).toEqual(input.result);
    await expect(requestR04PendingFile(input)).resolves.toEqual(input.result);
  }
});

it("R04 issues one request without writing workspace files, and separately records only the exact observed pending file", async () => {
  const f = await fixture("R04"); await armFault(f.options);
  f.input.envelope.receivedAt = new Date().toISOString();
  const input = { ...f.input, inputId: `scoped:${f.input.arrivalRequestId}:epoch:1` };
  const returns = await Promise.all([requestR04PendingFile(input), requestR04PendingFile(input)]) as any[];
  expect(returns.filter((r) => r.acceptancePendingFile)).toHaveLength(1);
  const request = returns.find((r) => r.acceptancePendingFile).acceptancePendingFile;
  expect(returns.find((r) => r.acceptancePendingFile)).toMatchObject(f.input.result);
  const target = path.join(f.input.execution.worktreePath, request.file);
  await expect(fs.stat(target)).rejects.toThrow(/ENOENT/);
  const observed = path.join(f.directory, `${f.input.execution.projectId}.observed.json`);
  const observation = { ...input, invocationId: input.envelope.invocationId, git: { observeExecutionWorktree: async () => ({
    projectId: input.execution.projectId, executionId: input.execution.id, ownershipEpoch: 1, branch: input.execution.executionBranch,
    worktreePath: input.execution.worktreePath, head: input.result.headSha!, retained: true as const,
    observedAt: new Date().toISOString(), pendingPaths: [request.file]
  }) } };
  await observeR04PendingFile(observation);
  await expect(fs.stat(observed)).rejects.toThrow(/ENOENT/);
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, "Different Agent file");
  await observeR04PendingFile(observation);
  await expect(fs.stat(observed)).rejects.toThrow(/ENOENT/);
  await fs.writeFile(target, request.content);
  await observeR04PendingFile({ ...observation, inputId: input.inputId + ":mechanism-repair:1" });
  await expect(fs.stat(observed)).rejects.toThrow(/ENOENT/);
  const clean = await observation.git.observeExecutionWorktree();
  await observeR04PendingFile({ ...observation, git: { observeExecutionWorktree: async () => ({ ...clean, pendingPaths: [] }) } });
  await expect(fs.stat(observed)).rejects.toThrow(/ENOENT/);
  await Promise.all([observeR04PendingFile(observation), observeR04PendingFile(observation)]);
  expect(JSON.parse(await fs.readFile(observed, "utf8"))).toMatchObject({ status: "pending-file-observed",
    inputId: input.inputId, file: request.file, bytes: Buffer.byteLength(request.content) });
  await fs.rm(target);
  expect(await requestR04PendingFile(input)).toEqual(f.input.result);
  await expect(fs.stat(target)).rejects.toThrow(/ENOENT/);
});

it("R04 rejects foreign/late turns, successful-merge mismatches and preexisting/symlinked diagnostic files", async () => {
  const f = await fixture("R04");
  const input = { ...f.input, inputId: `scoped:${f.input.arrivalRequestId}:epoch:1` };
  expect(await requestR04PendingFile(input)).toEqual(input.result);
  await armFault(f.options); input.envelope.receivedAt = new Date().toISOString();
  for (const override of [{ inputId: input.inputId + ":mechanism-repair:1" },
    { execution: { ...input.execution, ownershipEpoch: 2 } }, { projectTitle: "N03 old project" },
    { envelope: { ...input.envelope, invocationId: "inv-foreign" } },
    { envelope: { ...input.envelope, receivedAt: "2020-01-01T00:00:00Z" } },
    { operation: { ...input.operation, status: "uncertain" as const } }]) {
    expect(await requestR04PendingFile({ ...input, ...override })).toEqual(input.result);
  }
  await expect(requestR04PendingFile({ ...input, result: { ...input.result, head: "executions/foreign" } })).rejects.toThrow(/bound delivery/);
  await fs.mkdir(path.join(input.execution.worktreePath, "evidence"));
  const target = path.join(input.execution.worktreePath, "evidence/pending-owned.json");
  await fs.writeFile(target, "Preserve previous work");
  expect(await requestR04PendingFile(input)).toEqual(input.result);
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
  await fs.rm(target);
  const result: any = await requestR04PendingFile(input);
  const external = path.join(f.directory, "outside.json"); await fs.writeFile(external, result.acceptancePendingFile.content);
  await fs.symlink(external, target);
  await expect(observeR04PendingFile({ ...input, invocationId: input.envelope.invocationId, git: {} })).rejects.toThrow(/symlink/);
  const broken = await fs.readFile(f.consumed, "utf8"); await fs.writeFile(f.consumed, '{"interrupted":');
  await expect(observeR04PendingFile({ ...input, invocationId: input.envelope.invocationId, git: {} })).rejects.toThrow();
  expect(await fs.readFile(f.consumed, "utf8")).not.toBe(broken);
});

it("R04 arming refuses an already merged PR and a supplement model input", async () => {
  const f = await fixture("R04");
  await expect(armFault({ ...f.options, project: { ...f.options.project,
    scopedPullRequests: [{ ownerExecutionId: f.input.execution.id, status: "merged" }] } })).rejects.toThrow(/already merged/);
  const project = structuredClone(f.options.project); project.runtime.activities[0].inputId += ":mechanism-repair:1";
  await expect(armFault({ ...f.options, project })).rejects.toThrow(/exact live/);
  await expect(fs.stat(f.directory)).rejects.toThrow(/ENOENT/);
});

it("persists one exact merge/sync receipt before throwing, survives restart/concurrency and leaves inputs intact", async () => {
  const f = await fixture();
  await armR12(f.options);
  f.input.envelope.receivedAt = new Date().toISOString();
  const before = structuredClone(f.input);
  const attempts = await Promise.allSettled([withholdR12MergeResponse(f.input), withholdR12MergeResponse(f.input)]);
  expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((attempts.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ name: "TimeoutError", message: expect.stringContaining("ETIMEDOUT") });
  expect(f.input).toEqual(before);
  const receipt = JSON.parse(await fs.readFile(f.consumed, "utf8"));
  expect(receipt).toMatchObject({ case: "R12", runId: "fixture-r12", projectId: f.input.envelope.projectId,
    target: { executionId: f.input.execution.id, invocationId: "inv-first" }, result: f.input.result, callId: "merge-request" });
  expect(receipt.operationId).toBe(`agent-git-${f.input.execution.id}-epoch-1-merge-request-merge`);
  await expect(withholdR12MergeResponse(structuredClone(f.input))).resolves.toBeUndefined();
  expect(JSON.parse(await fs.readFile(f.consumed, "utf8"))).toEqual(receipt);
  await expect(armR12(f.options)).rejects.toThrow(/EEXIST/);
});

it("passes ordinary projects, absent arms, unrelated ownership and unsuccessful merges without consuming the fault", async () => {
  const f = await fixture();
  await expect(withholdR12MergeResponse(f.input)).resolves.toBeUndefined();
  await fs.mkdir(f.directory);
  await expect(withholdR12MergeResponse(f.input)).resolves.toBeUndefined();
  await armR12(f.options);
  f.input.envelope.receivedAt = new Date().toISOString();
  const variants = [
    { projectTitle: "N03 historical project" }, { envelope: { ...f.input.envelope, projectId: `prj_${"b".repeat(32)}` } },
    { execution: { ...f.input.execution, id: "another-execution" } },
    { execution: { ...f.input.execution, ownershipEpoch: 2 } },
    { envelope: { ...f.input.envelope, invocationId: "inv-next" } },
    { envelope: { ...f.input.envelope, receivedAt: "2026-01-01T00:00:00Z" } },
    { operation: { ...f.input.operation, status: "uncertain" as const } },
    { envelope: { ...f.input.envelope, action: { tool: "github_get_pr" as const, providerNumber: 5 } } },
    { groupRunId: "another-group" }, { arrivalRequestId: "another-arrival" },
    { repository: { ...f.input.repository, providerId: 99 } },
    { result: { ...f.input.result, status: "conflicted" } },
    { result: { ...f.input.result, localSynchronization: undefined } }
  ];
  for (const override of variants) await expect(withholdR12MergeResponse({ ...f.input, ...override })).resolves.toBeUndefined();
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
  await expect(withholdR12MergeResponse(f.input)).rejects.toThrow(/ETIMEDOUT/);
});

it("rejects a mismatched successful PR and never re-arms an interrupted latch", async () => {
  const f = await fixture(); await armR12(f.options);
  f.input.envelope.receivedAt = new Date().toISOString();
  await expect(withholdR12MergeResponse({ ...f.input, result: { ...f.input.result, head: "executions/foreign" } })).rejects.toThrow(/bound delivery/);
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
  await fs.writeFile(f.consumed, '{"interrupted":');
  await expect(withholdR12MergeResponse(f.input)).resolves.toBeUndefined();
  expect(await fs.readFile(f.consumed, "utf8")).toBe('{"interrupted":');
});

it("refuses title-only adoption, old turns, later arrivals and already merged/reporting executions before arming", async () => {
  const f = await fixture();
  const options = [
    { submission: { ...f.options.submission, status: "pending" } },
    { submission: { ...f.options.submission, payloadSha256: "b".repeat(64) } },
    { project: { ...f.options.project, title: "OpenFARS R12 foreign: title" } },
    { invocationId: "inv-old" },
    { project: { ...f.options.project, scopedExecutions: [...f.options.project.scopedExecutions, f.input.execution] } },
    { project: { ...f.options.project, scopedAgentReports: [{ executionId: f.input.execution.id }] } },
    { project: { ...f.options.project, scopedPullRequests: [{ ownerExecutionId: f.input.execution.id, status: "merged" }] } }
  ];
  for (const override of options) await expect(armR12({ ...f.options, ...override })).rejects.toThrow();
  await expect(fs.stat(f.directory)).rejects.toThrow(/ENOENT/);
});

it("refuses controller state inside Agent project files", async () => {
  const f = await fixture();
  await expect(withholdR12MergeResponse({ ...f.input, directory: f.input.projectRoot })).rejects.toThrow(/outside Agent project/);
});

it("R14 preserves exact report bytes and delivery while withholding one head only after native stop", async () => {
  const f = await fixture("R14");
  // A merged PR is required for this fault, and does not prevent arming a
  // still-running first invocation before its report is accepted.
  await armFault({ ...f.options, project: { ...f.options.project, scopedPullRequests: [f.input.result] } });
  const input = { ...f.input, invocationId: f.input.envelope.invocationId, output: "原始报告\nMissing: 1; sum: 30\n",
    repair: false, selectedWeakTarget: "finish", facts: { pushedHeadSha: f.input.result.headSha, merged: f.input.result },
    nativeTurn: { projectId: f.input.execution.projectId, executionId: f.input.execution.id, ownershipEpoch: 1,
      invocationId: f.input.envelope.invocationId, writerLeaseEpoch: 1, runtimePath: "fixture-runtime",
      baseCommit: "a".repeat(40), status: "stopped" as const, openedAt: new Date().toISOString(), stoppedAt: new Date().toISOString() } };
  const snapshot = structuredClone(input);
  expect(await withholdR14ReportHead({ ...input, nativeTurn: { ...input.nativeTurn, status: "opened" } })).toBe(false);
  expect(await withholdR14ReportHead({ ...input, repair: true })).toBe(false);
  expect(await withholdR14ReportHead({ ...input, invocationId: "another-invocation" })).toBe(false);
  expect(await withholdR14ReportHead({ ...input, nativeTurn: { ...input.nativeTurn, stoppedAt: "2026-01-01T00:00:00Z" } })).toBe(false);
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
  expect(await withholdR14ReportHead(input)).toBe(true);
  const receipt = JSON.parse(await fs.readFile(f.consumed, "utf8"));
  expect(receipt).toMatchObject({ case: "R14", status: "report-head-withheld", omittedHeadSha: f.input.result.headSha,
    report: { output: input.output, selectedWeakTarget: "finish" }, delivery: f.input.result });
  expect(input).toEqual(snapshot);
  expect(await withholdR14ReportHead(structuredClone(input))).toBe(false);
});

it("R03 refuses completion only for its initial model turn and preserves its random marker across repeated attempts", async () => {
  const f = await fixture("R03"); await armFault(f.options);
  const input = { ...f.input, envelope: { ...f.input.envelope, action: { tool: "finish_task" as const }, receivedAt: new Date().toISOString() },
    inputId: `scoped:${f.input.arrivalRequestId}:epoch:1`, completionAlreadyAccepted: false,
    facts: { pushedHeadSha: f.input.result.headSha, merged: f.input.result } };
  await expect(rejectR03InitialFinish({ ...input, completionAlreadyAccepted: true })).resolves.toBeUndefined();
  await expect(fs.stat(f.consumed)).rejects.toThrow(/ENOENT/);
  await expect(rejectR03InitialFinish(input)).rejects.toThrow(/no finish_task receipt was recorded/);
  const receipt = JSON.parse(await fs.readFile(f.consumed, "utf8"));
  expect(receipt.marker).toMatch(/^[a-f0-9-]{36}$/);
  expect(receipt.deliveryAtAttempt.merged).toEqual(f.input.result);
  await expect(rejectR03InitialFinish({ ...input, envelope: { ...input.envelope, callId: "another-attempt" } })).rejects.toThrow(receipt.marker);
  expect(JSON.parse(await fs.readFile(f.consumed, "utf8"))).toEqual(receipt);
  await expect(rejectR03InitialFinish({ ...input, inputId: input.inputId + ":mechanism-repair:1" })).resolves.toBeUndefined();
  await expect(rejectR03InitialFinish({ ...input, envelope: { ...input.envelope, invocationId: "inv-other" } })).resolves.toBeUndefined();
});

it("R03 refuses to arm after a completion receipt or a supplementary model turn exists", async () => {
  const f = await fixture("R03");
  await expect(armFault({ ...f.options, project: { ...f.options.project, taskCompletions: { [f.input.execution.id]: { status: "accepted" } } } })).rejects.toThrow(/completion already/);
  f.options.project.runtime.activities[0].inputId += ":mechanism-repair:1";
  await expect(armFault(f.options)).rejects.toThrow(/No exact live/);
  await expect(fs.stat(f.directory)).rejects.toThrow(/ENOENT/);
});

it("R04 binds an observed queued arrival without inventing a future execution/native identity", async () => {
  const f = await fixture("R04");
  const arrival = { requestId: "queued-r04", sequence: 12, status: "queued", targetKind: "agent", agentId: "implementer",
    groupRunId: "run-child", targetNodeId: "G_child_impl" };
  const project = { ...f.options.project, scopedExecutions: [], scopedArrivals: [arrival],
    scopedGroupRuns: f.options.project.scopedGroupRuns.map((g) => ({ ...g, status: "running" })) };
  const options = { ...f.options, project, arrivalRequestId: arrival.requestId };
  await expect(armR04Preparation({ ...options, project: { ...project, scopedExecutions: [{ arrivalRequestId: arrival.requestId }] } })).rejects.toThrow(/already has an execution/);
  await expect(armR04Preparation({ ...options, arrivalRequestId: "another-arrival" })).rejects.toThrow(/observed queued/);
  const { arm } = await armR04Preparation(options);
  expect(arm.target).toMatchObject({ selection: "queued-arrival", arrivalRequestId: arrival.requestId, arrivalSequence: 12,
    agentId: "implementer", ownershipEpoch: 1 });
  expect(arm.target).not.toHaveProperty("executionId");
  expect(arm.target).not.toHaveProperty("invocationId");
  await expect(armR04Preparation(options)).rejects.toThrow(/EEXIST/);
});
