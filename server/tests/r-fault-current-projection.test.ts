import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import { buildManifest } from "../../scripts/r-projects/catalog.mjs";
import { armFault } from "../../scripts/r-projects/arm-fault.mjs";

const roots: string[] = [];
const databases: CollaborationStateDatabase[] = [];
afterEach(async () => {
  databases.splice(0).forEach(database => database.close());
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(mode: "initial" | "reserved" | "repair" | "returned" | "foreign-input" | "completed" | "multiple-inputs" | "stale-writer" = "initial", code = "R03") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-arm-current-")); roots.push(root);
  const projectId = `prj_${"a".repeat(32)}`, invocationId = "inv_initial_scoped";
  const manifest = buildManifest({ runId: "current-projection", gatewayId: `gwy_${"b".repeat(32)}`,
    model: "model", harness: "pi", githubAccountId: `gha_${"c".repeat(32)}`,
    observedAt: new Date().toISOString(), evidencePath: "fixture-only.json" });
  const entry = manifest.cases.find(entry => entry.code === code)!;
  const repository = { provider: "github", providerId: 42, owner: "test", name: entry.payload.git.repositoryName,
    private: true, defaultBranch: "main", htmlUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git", observedAt: new Date().toISOString() };
  const databasePath = path.join(root, "state.sqlite"), projectDirectory = path.join(root, "project");
  const database = CollaborationStateDatabase.open({ databasePath, serviceId: "arming-test", hostId: "test",
    topology: "single-host", instanceId: "test-writer" }); databases.push(database);
  database.createProject({ projectId, workflowRevision: 1, workerCapacity: 1,
    git: { enabled: true, status: "ready", repository: { ...repository, localPath: projectDirectory } },
    workflowSnapshot: { schemaVersion: 3, agents: [{ name: "main" }, { name: "implementer" }, { name: "child_leader" }],
      collaborations: [{ id: "G_child" }], scopedWorkflow: { schemaVersion: 1, rootAgentIds: ["main"], groups: [{
        id: "G_child", leaderAgentId: "child_leader", allowLeaderReconfiguration: false, workflow: {
          nodes: [{ kind: "agent", nodeId: "G_child_impl", agentId: "implementer" }],
          input: { source: "input", edges: [{ kind: "parallel", target: "G_child_impl" }] },
          routes: { G_child_impl: [{ kind: "strong", target: "finish" }] }
        }
      }] } } });
  const group = database.activateScopedGroup({ projectId, groupRunId: "run-child", groupId: "G_child",
    activationRequestId: "activate-child", workflowRevision: 1, baseCommit: "a".repeat(40),
    outer: { nodeRunId: "root-child", inputSnapshotRef: "input", activatedByAgentId: "main" } });
  const execution = database.claimScopedAgentArrival({ projectId, arrivalRequestId: group.arrivals[0]!.requestId,
    agentId: "implementer", executionId: "scoped-first", worktreePath: path.join(projectDirectory, "git-worktrees", "agents", "implementer") })!.execution;
  const identity = { projectId, executionId: execution.id, ownershipEpoch: 1, invocationId };
  database.beginScopedAgentTurn({ ...identity, runtimePath: path.join(root, "runtime"), baseCommit: "a".repeat(40) });
  if (mode !== "reserved") database.markScopedAgentTurnOpened({ ...identity, nativeProcessOpened: true });
  if (mode === "repair") database.reserveScopedAgentMechanismRepair({ ...identity, missing: ["finish_task"] });
  if (mode === "returned") database.recordScopedAgentNativeOutput({ ...identity, agentId: "implementer",
    inputId: `scoped:${execution.arrivalRequestId}:epoch:1`, output: "Actual first turn returned" });
  if (mode === "completed") database.recordScopedAgentTaskCompletion({ ...identity, agentId: "implementer",
    callId: "accepted-finish", summary: "Actual accepted completion", requestedAt: new Date().toISOString() });
  await fs.mkdir(projectDirectory);
  const native = { schemaVersion: 1, eventId: "native-original-user", invocationId: mode === "foreign-input" ? "inv_foreign" : invocationId,
    timestamp: new Date().toISOString(), harnessId: "pi", kind: "user.message", message: "Actual original assignment" };
  const inputLine = JSON.stringify({ agent: "implementer", data: { event: native } }) + "\n";
  await fs.writeFile(path.join(projectDirectory, "events.jsonl"), inputLine + (mode === "multiple-inputs" ? inputLine : ""));
  const projection = database.projectState(projectId);
  if (mode === "stale-writer") projection.runtimeActivities[0]!.writerLeaseEpoch++;
  const project = { id: projectId, title: entry.payload.title, status: "running", agents: entry.payload.agents,
    scopedExecutions: projection.scopedExecutions, scopedGroupRuns: projection.scopedGroupRuns,
    git: { repository }, operations: [{ kind: "repository.create", status: "finalized", remoteFact: repository }],
    runtime: { activities: projection.runtimeActivities } };
  const options = { code, directory: path.join(root, "controller"), manifest,
    submission: { status: "accepted", code, base: manifest.serviceUrl, projectId, payloadSha256: entry.payloadSha256 },
    project, executionId: execution.id, invocationId, nativeEvidencePaths: { databasePath, projectDirectory } };
  return { options, database, execution, native };
}

it.each(["R03", "R04", "R12", "R14"])("arms %s from the actual current scoped resident projection after its original native input was received", async code => {
  const f = await fixture("initial", code);
  expect(f.options.project.runtime.activities).toEqual([expect.objectContaining({ kind: "resident", scopeKind: "scoped-agent", phase: "resident:running" })]);
  const result = await armFault(f.options);
  expect(result.arm.target).toMatchObject({ executionId: f.execution.id, invocationId: f.native.invocationId, ownershipEpoch: 1 });
  expect(result.arm.nativeInputProof).toMatchObject({ nativeEventId: f.native.eventId,
    inputId: `scoped:${f.execution.arrivalRequestId}:epoch:1`, source: "current-scoped-native-and-public-user-input" });
  expect(result.arm.nativeInputProof.eventsPrefixSha256).toBe(createHash("sha256")
    .update(await fs.readFile(path.join(f.options.nativeEvidencePaths.projectDirectory, "events.jsonl"))).digest("hex"));
});

it.each(["reserved", "repair", "returned", "foreign-input", "completed", "multiple-inputs", "stale-writer"] as const)("refuses a %s scoped resident without publishing an arm", async mode => {
  const f = await fixture(mode);
  await expect(armFault(f.options)).rejects.toThrow(/exact live|initial native|original native input|completion already/);
  await expect(fs.stat(f.options.directory)).rejects.toThrow(/ENOENT/);
});
