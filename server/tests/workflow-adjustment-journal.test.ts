import { COLLABORATION_STATE_SCHEMA_VERSION } from "../src/collaboration-state/contracts.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import type { AcceptedMainRouteAction } from "../src/collaboration-state/contracts.js";
import type { ControlAction } from "../src/types.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs, normalizeAgentOrchestrationTemplate } from "../src/validation.js";
import { WORKFLOW_ADJUSTMENT_STALE_MESSAGE, validateWorkflowAdjustmentSnapshot, workflowAdjustmentChanges, workflowAdjustmentsConflict, type SubmitUserWorkflowAdjustmentInput } from "../src/workflow-adjustments.js";

const roots: string[] = [], stores: CollaborationStateDatabase[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

async function concurrentWorkflowWorkers(worker: string, config: string, operations: string[]): Promise<any[]> {
  const running: Array<{ child: ReturnType<typeof execFile>; result: Promise<string> }> = [];
  try {
    for (const operation of operations) {
      let ready!: () => void, rejectReady!: (error: Error) => void, announced = false;
      const opened = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
      let child!: ReturnType<typeof execFile>;
      const result = new Promise<string>((resolve, reject) => {
        child = execFile(process.execPath, ["--import", "tsx", worker, config, operation], {
          cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15_000
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      result.catch(() => undefined);
      let output = "";
      child.stdout!.on("data", data => { output += String(data); if (!announced && output.startsWith("ready\n")) { announced = true; ready(); } });
      child.once("error", rejectReady);
      child.once("close", () => { if (!announced) rejectReady(new Error("Workflow worker closed before its database was ready")); });
      running.push({ child, result });
      await opened;
    }
    for (const entry of running) entry.child.stdin!.end("go\n");
    return await Promise.all(running.map(entry => entry.result.then(output => JSON.parse(output.slice("ready\n".length)))));
  } finally { for (const entry of running) if (entry.child.exitCode === null) entry.child.kill(); }
}

async function fixture(allowMain = true, initialized = true) {
  const root = await mkdtemp(join(tmpdir(), "openfars-adjustment-journal-")); roots.push(root);
  const clock = { now: 1_000_000 };
  const options = { databasePath: join(root, "state.sqlite"), serviceId: "test", hostId: "test", topology: "single-host" as const,
    instanceId: "original-writer", leaseDurationMs: 30_000, now: () => clock.now };
  const database = CollaborationStateDatabase.open(options); stores.push(database);
  const orchestration = cloneAgentOrchestrationTemplate(); orchestration.allowMainReconfiguration = allowMain;
  database.createProject({ projectId: "p", workflowRevision: 1, workflowSnapshot: orchestration, git: { enabled: true, status: "ready" }, workerCapacity: 4 });
  if (initialized) database.initializeScopedConfiguration("p", { agents: mergeAgentConfigs(undefined, orchestration), skillDefinitions: {}, mcpDefinitions: {} });
  const input = (requestId = "user-one"): SubmitUserWorkflowAdjustmentInput => {
    const current = database.workflowAdjustmentCurrent("p"), proposal = structuredClone(current.snapshot);
    proposal.agents.idea.instructions = `Exact user instructions ${requestId}`;
    return { projectId: "p", requestId, base: current.version, proposal, explanation: `User explanation ${requestId}` };
  };
  const acceptMain = (suffix = "one", edit?: (snapshot: ReturnType<typeof database.workflowAdjustmentCurrent>["snapshot"]) => void) => {
    const current = database.workflowAdjustmentCurrent("p");
    database.activateNode({ projectId: "p", nodeRunId: "main-node", node: { kind: "agent", nodeId: "main", agentId: "main" },
      activationRequestId: "main-activation", inputSnapshotRef: "original-input", activatedByAgentId: "main", workflowRevision: 1 });
    database.appendEvent({ projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "main-native", coordinatorEpoch: 1,
      type: "main.route.attempt", payload: { attempt: 1 } });
    const semanticInputHash = hash(suffix), requestId = `accepted-main-control-${semanticInputHash}-0`;
    const next = structuredClone(current.snapshot);
    if (edit) edit(next); else next.agents.idea.instructions = "Actual Main proposal content";
    const { orchestration: graph, ...configuration } = next;
    const action = { tool: "apply_workflow" as const, path: "workflow.json", rationale: "Exact public Main rationale" };
    database.revalidateMainRouteControl({ projectId: "p", nodeRunId: "main-node", invocationId: "main-native", routeEpoch: 1, stateVersion: 1,
      candidateNodeIds: ["finish"], canComplete: true, allowFinishRoute: false, action,
      accepted: { requestId, inputId: "original-input", invocationId: "main-native", callId: "main-apply", semanticInputHash,
        workflowProposal: { orchestration: graph, configuration, baseConfigurationHash: database.scopedConfigurationHash("p"), affectedGroupIds: [],
          prestateWorkflowRevision: 1, prestateWorkflowHash: hash(current.snapshot.orchestration), targetWorkflowRevision: 2, proposalHash: hash(graph) } } });
    return { requestId, semanticInputHash };
  };
  return { root, clock, options, database, input, acceptMain };
}

async function legacyGroupFixture() {
  const f = await fixture(), { database } = f, graph = cloneAgentOrchestrationTemplate();
  graph.collaborations = [{ id: "G", displayName: "Original group", memberAgentIds: ["idea", "execution"], renamePolicy: "editable" }];
  graph.input = { source: "input", target: "G" };
  graph.routes = Object.fromEntries(graph.agents.filter(agent => !["idea", "execution"].includes(agent.name))
    .map(agent => [agent.name, [{ kind: "strong" as const, target: "G" }]]));
  graph.routes.G = [{ kind: "strong", target: "finish" }]; graph.decisionPlans = {};
  graph.termination.agent = "G";
  database.saveWorkflowRevision({ projectId: "p", workflowRevision: 2, snapshot: normalizeAgentOrchestrationTemplate(graph), affectedGroupIds: [] });
  database.activateGroup({ projectId: "p", nodeRunId: "original-node", groupRunId: "original-group", nodeId: "G", groupId: "G",
    activationRequestId: "original-activation", inputSnapshotRef: "original-input", memberAgentIds: ["idea", "execution"],
    origin: { kind: "project-input" }, baseCommit: "a".repeat(40), groupBranch: "groups/original-group", workflowRevision: 2 });
  const launch = () => database.appendEvent({ projectId: "p", requestId: "original-launch", nodeRunId: "original-node",
    groupRunId: "original-group", agentId: "main", coordinatorEpoch: 1, invocationId: "original-leader",
    workflowRevision: database.projectState("p").workflowRevision, type: "group.leader.launch.started", payload: { original: true } });
  const assign = (agents: string[]) => database.assignTasks({ projectId: "p", groupRunId: "original-group", actorAgentId: "main",
    coordinatorEpoch: 1, tasks: agents.map((agent, index) => ({ id: `original-task-${index}`, assignment: `Original work ${index}`, assigneeAgentId: agent })) });
  const claimInput = (agentId = "idea", executionId = `execution-${agentId}`) => ({ projectId: "p", groupRunId: "original-group", agentId,
    executionId, executionBranch: `executions/${executionId}`, worktreePath: join(f.root, executionId) });
  const finalInput = { projectId: "p", groupRunId: "original-group", actorAgentId: "main", coordinatorEpoch: 1, ownerAgentId: "execution",
    taskId: "original-final-task", executionId: "original-final", assignment: "Original final integration",
    executionBranch: "groups/original-group", worktreePath: join(f.root, "original-final") };
  const deliver = (executionId: string) => {
    const execution = database.projectState("p").executions.find(execution => execution.id === executionId)!;
    database.observePullRequest({ projectId: "p", executionId, ownershipEpoch: execution.ownershipEpoch,
      pullRequest: { id: `pull-${executionId}`, ownerExecutionId: executionId,
        providerNumber: database.projectState("p").pullRequests.length + 1, head: execution.executionBranch,
        base: execution.purpose === "final-integration" ? "main" : "groups/original-group", status: "merged", mergeCommitSha: "f".repeat(40),
        headSha: "b".repeat(40), htmlUrl: "https://github.com/fixture/original/pull/1", observedAt: new Date(1_000_000).toISOString() } });
    database.completeExecution({ projectId: "p", executionId, ownershipEpoch: execution.ownershipEpoch, output: `Original delivery ${executionId}` });
  };
  return { ...f, launch, assign, claimInput, finalInput, deliver };
}

describe("durable shared workflow adjustment journal", () => {
  it("keeps an activated root Agent's configuration bound before execution or asynchronous Git preparation", async () => {
    const { database, input } = await fixture();
    database.activateNode({ projectId: "p", nodeRunId: "original-root", node: { kind: "agent", nodeId: "idea", agentId: "idea" },
      activationRequestId: "original-root-activation", inputSnapshotRef: "original-root-input", activatedByAgentId: "main", workflowRevision: 1 });
    const request = input(); database.submitUserWorkflowAdjustment(request);
    expect(database.prepareUserWorkflowAdjustmentPublication("p", request.requestId)).toMatchObject({ ready: false });
    expect(database.workflowAdjustments("p")[0].waitingReason).toContain("original-root");
    expect(database.projectState("p").executions).toEqual([]); expect(database.projectState("p").operations).toEqual([]);
    expect(database.projectState("p").runtimeActivities).toEqual([]);
    expect(database.workflowAdjustmentCurrent("p").version).toEqual(request.base);
  });

  it.each([1, 2, 3])("serializes a legacy claim against actual independent-process user publication (%s)", async () => {
    const f = await legacyGroupFixture(), { database, root, options } = f; f.launch(); f.assign(["idea"]);
    const request = f.input(), claim = f.claimInput();
    const worker = join(root, "legacy-claim-publication.mjs"), config = join(root, "legacy-claim-publication.json");
    await writeFile(config, JSON.stringify({ options: { ...options, now: undefined, writerLease: database.writerLease() }, request, claim }));
    await writeFile(worker, `import { readFileSync } from "node:fs";
import { CollaborationStateDatabase } from ${JSON.stringify(new URL("../src/collaboration-state/store.ts", import.meta.url).href)};
const { options, request, claim } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const database = CollaborationStateDatabase.open({ ...options, now: () => 1000000 });
process.stdout.write("ready\\n"); await new Promise(resolve => process.stdin.once("data", resolve));
try {
  let result;
  if (process.argv[3] === "claim") { try { result = { claimed: database.claimNextTask(claim) }; }
    catch (error) { result = { error: error.code }; } }
  else { database.submitUserWorkflowAdjustment(request); const prepared = database.prepareUserWorkflowAdjustmentPublication("p", request.requestId);
    result = prepared.ready ? database.publishUserWorkflowAdjustment("p", request.requestId, prepared.validationToken) : prepared.publication; }
  process.stdout.write(JSON.stringify(result));
} finally { database.close(); }
`);
    const [claimed, publication] = await concurrentWorkflowWorkers(worker, config, ["claim", "publish"]);
    const record = database.workflowAdjustments("p")[0], projection = database.projectState("p");
    expect(publication.status).toBe(record.status); expect(record.base).toEqual(request.base); expect(record.proposal).toEqual(request.proposal);
    if (claimed.error) { expect(claimed.error).toBe("WORKFLOW_ADJUSTMENT_PENDING"); expect(projection.executions).toEqual([]); }
    else {
      expect(projection.executions).toHaveLength(1); expect(claimed.claimed.task.id).toBe("original-task-0");
      const event = database.eventsAfter("p", 0, 1000).find(event => event.type === "group.task.claimed")!;
      if (record.status === "pending") { expect(event.workflowRevision).toBe(2); expect(record.waitingReason).toContain(claim.executionId); }
      else { expect(record.status).toBe("applied"); expect(event.workflowRevision).toBe(3); }
    }
    expect(projection.operations).toEqual([]); expect(projection.runtimeActivities).toEqual([]);
  });

  it("holds an eligible legacy FIFO claim atomically while independent assigned work can run", async () => {
    const f = await legacyGroupFixture(), { database } = f; f.launch(); f.assign(["idea", "execution", "idea"]);
    database.submitUserWorkflowAdjustment(f.input());
    const before = database.projectState("p");
    expect(() => database.claimNextTask(f.claimInput())).toThrow(expect.objectContaining({ code: "WORKFLOW_ADJUSTMENT_PENDING" }));
    expect(database.projectState("p")).toEqual(before);
    expect(database.claimNextTask(f.claimInput("execution"))?.task.id).toBe("original-task-1");
    database.withdrawWorkflowAdjustment({ projectId: "p", requestId: "user-one", operationId: "original-withdraw" });
    expect(database.claimNextTask(f.claimInput())?.task.id).toBe("original-task-0");
    expect(database.projectState("p").tasks.find(task => task.id === "original-task-2")?.currentExecutionId).toBeUndefined();
  });

  it("retains a claimed legacy task and its original ownership instead of reclassifying it as a new claim", async () => {
    const f = await legacyGroupFixture(), { database } = f; f.launch(); f.assign(["idea", "idea"]);
    const original = database.claimNextTask(f.claimInput())!;
    database.submitUserWorkflowAdjustment(f.input());
    expect(database.claimNextTask(f.claimInput("idea", "replacement-execution"))).toBeUndefined();
    const publication = database.prepareUserWorkflowAdjustmentPublication("p", "user-one");
    expect(publication).toMatchObject({ ready: false, publication: { status: "pending" } });
    expect(database.workflowAdjustments("p")[0].waitingReason).toContain(original.execution.id);
    expect(database.projectState("p").executions).toEqual([original.execution]);
  });

  it("preserves the remaining original batch needed to coordinate a historical failed delivery owner", async () => {
    const f = await legacyGroupFixture(), { database } = f; f.launch(); f.assign(["idea", "execution"]);
    database.claimNextTask(f.claimInput());
    database.requestExecutionStop({ projectId: "p", executionId: "execution-idea", ownershipEpoch: 1, reason: "Original controlled failure" });
    database.confirmExecutionStopped({ projectId: "p", executionId: "execution-idea", ownershipEpoch: 1, stopped: true, evidence: { fixtureSupervisorStopped: true } });
    // Older journals represented this still-owned failure as failed rather
    // than continuation_pending. Preserve that historical scene in this
    // isolated fixture; no PR/finish/merge/completion proof is introduced.
    const raw = new DatabaseSync(f.options.databasePath);
    try { raw.exec("UPDATE work_tasks SET status = 'failed' WHERE task_id = 'original-task-0'; UPDATE member_executions SET status = 'failed' WHERE execution_id = 'execution-idea'"); }
    finally { raw.close(); }
    const request = f.input(); request.proposal.agents.execution.instructions = "Future Worker configuration";
    database.submitUserWorkflowAdjustment(request);
    expect(database.prepareUserWorkflowAdjustmentPublication("p", request.requestId)).toMatchObject({ ready: false });
    expect(database.workflowAdjustments("p")[0].waitingReason).toContain("execution-idea");
    expect(database.claimNextTask(f.claimInput("execution"))?.task.id).toBe("original-task-1");
    expect(database.projectState("p").tasks.find(task => task.id === "original-task-0")?.status).toBe("failed");
    expect(database.projectState("p").pullRequests).toEqual([]);
    expect(database.workflowAdjustmentCurrent("p").version).toEqual(request.base);
  });

  it("gates the first legacy Leader launch and protects its pre-native management owner after acceptance", async () => {
    const f = await legacyGroupFixture(), { database } = f, request = f.input();
    request.proposal.agents.main.instructions = "User's next Main instructions";
    database.submitUserWorkflowAdjustment(request); const before = database.projectState("p");
    expect(f.launch).toThrow(expect.objectContaining({ code: "WORKFLOW_ADJUSTMENT_PENDING" }));
    expect(database.projectState("p")).toEqual(before);
    const prepared = database.prepareUserWorkflowAdjustmentPublication("p", request.requestId);
    if (!prepared.ready) throw new Error("Unclaimed configuration should be ready");
    expect(database.publishUserWorkflowAdjustment("p", request.requestId, prepared.validationToken).status).toBe("applied");
    const launch = f.launch();
    const next = f.input("next-main"); next.proposal.agents.main.instructions = "Later unaccepted instructions";
    database.submitUserWorkflowAdjustment(next);
    expect(database.prepareUserWorkflowAdjustmentPublication("p", next.requestId)).toMatchObject({ ready: false });
    expect(database.workflowAdjustments("p").at(-1)?.waitingReason).toContain("原组管理任务");
    expect(database.projectState("p").runtimeActivities).toEqual([]);
    expect(f.launch()).toMatchObject({ replay: true, event: launch.event });
    f.assign(["idea"]);
    expect(database.claimNextTask(f.claimInput())?.task.id).toBe("original-task-0");
  });

  it("does not release an original legacy management task merely because its native resident closed", async () => {
    const f = await legacyGroupFixture(), { database } = f; f.launch();
    const scope = { projectId: "p", nodeRunId: "original-node", groupRunId: "original-group", agentId: "main",
      coordinatorEpoch: 1, invocationId: "original-leader" };
    database.startRuntimeActivity({ ...scope, kind: "resident", phase: "resident:running" });
    database.closeRuntimeActivity({ ...scope, kind: "resident", outcome: "completed" });
    const request = f.input(); request.proposal.agents.main.instructions = "Next Main configuration";
    database.submitUserWorkflowAdjustment(request);
    expect(database.projectState("p").runtimeActivities).toEqual([]);
    expect(database.prepareUserWorkflowAdjustmentPublication("p", request.requestId)).toMatchObject({ ready: false });
    expect(database.workflowAdjustments("p")[0].waitingReason).toContain("original-group");
    expect(database.workflowAdjustmentCurrent("p").version).toEqual(request.base);
  });

  it("holds a new legacy final integration but preserves the exact already claimed final replay", async () => {
    const f = await legacyGroupFixture(), { database } = f; f.launch(); f.assign(["idea"]);
    database.claimNextTask(f.claimInput()); f.deliver("execution-idea");
    const request = f.input(); request.proposal.agents.execution.instructions = "Next integration configuration";
    database.submitUserWorkflowAdjustment(request); const before = database.projectState("p");
    expect(() => database.startFinalIntegration(f.finalInput)).toThrow(expect.objectContaining({ code: "WORKFLOW_ADJUSTMENT_PENDING" }));
    expect(database.projectState("p")).toEqual(before);
    database.withdrawWorkflowAdjustment({ projectId: "p", requestId: request.requestId, operationId: "withdraw-final" });
    const final = database.startFinalIntegration(f.finalInput);
    database.submitUserWorkflowAdjustment({ ...f.input("after-final"), proposal: request.proposal });
    const claimed = database.projectState("p");
    expect(database.startFinalIntegration(f.finalInput).execution).toEqual(final.execution);
    expect(database.projectState("p")).toEqual(claimed);
  });

  it("lets an original legacy group finish necessary delivery and outer routing before its graph/Main edit", async () => {
    const f = await legacyGroupFixture(), { database } = f; f.launch(); f.assign(["idea"]);
    const request = f.input(); request.proposal.agents.main.instructions = "Next Main configuration";
    request.proposal.orchestration.collaborations![0].displayName = "Next group name";
    database.submitUserWorkflowAdjustment(request);
    expect(database.prepareUserWorkflowAdjustmentPublication("p", request.requestId)).toMatchObject({ ready: false });
    database.claimNextTask(f.claimInput()); f.deliver("execution-idea");
    database.startFinalIntegration(f.finalInput); f.deliver("original-final");
    database.decideGroupCompletion({ projectId: "p", groupRunId: "original-group", actorAgentId: "main", coordinatorEpoch: 1, output: "Original group result" });
    expect(database.rootMainWorkflowAdjustmentAdmission("p", "original-node")).toBeUndefined();
    expect(database.prepareUserWorkflowAdjustmentPublication("p", request.requestId)).toMatchObject({ ready: false });
    database.completeGroup({ projectId: "p", groupRunId: "original-group", nodeRunId: "original-node", coordinatorEpoch: 1,
      routeEmissionId: "original-completion", route: { kind: "fixed", targetNodeId: "finish" } });
    const prepared = database.prepareUserWorkflowAdjustmentPublication("p", request.requestId);
    if (!prepared.ready) throw new Error("Original completion should release its binding");
    expect(database.publishUserWorkflowAdjustment("p", request.requestId, prepared.validationToken).status).toBe("applied");
    expect(database.pendingRoutes("p")).toMatchObject([{ routeEmissionId: "original-completion", targetNodeId: "finish" }]);
  });

  it("recovers the same legacy launch and held FIFO from durable facts on a new database connection", async () => {
    const f = await legacyGroupFixture(), { database } = f; f.launch(); f.assign(["idea"]);
    const request = f.input(); database.submitUserWorkflowAdjustment(request);
    const recovered = CollaborationStateDatabase.open({ ...f.options, writerLease: database.writerLease() }); stores.push(recovered);
    const before = recovered.projectState("p");
    expect(() => recovered.claimNextTask(f.claimInput())).toThrow(expect.objectContaining({ code: "WORKFLOW_ADJUSTMENT_PENDING" }));
    expect(recovered.projectState("p")).toEqual(before);
    expect(recovered.latestGroupLeaderLaunch("p", "original-group", "main", 1)?.invocationId).toBe("original-leader");
    const prepared = recovered.prepareUserWorkflowAdjustmentPublication("p", "user-one");
    if (!prepared.ready) throw new Error("Unclaimed Worker configuration should be ready");
    recovered.publishUserWorkflowAdjustment("p", "user-one", prepared.validationToken);
    expect(recovered.claimNextTask(f.claimInput())?.task.id).toBe("original-task-0");
    expect(recovered.workflowAdjustments("p")[0].base).toEqual(request.base);
  });

  it("projects a legacy baseline without writing and seeds only its first valid submission atomically", async () => {
    const f = await fixture(false, false), database = f.database;
    const seed = { agents: mergeAgentConfigs(undefined, cloneAgentOrchestrationTemplate()), skillDefinitions: {}, mcpDefinitions: {} };
    const before = database.projectState("p"), events = database.eventsAfter("p", 0, 1000);
    const context = database.workflowAdjustmentContext("p", seed);
    expect(context.records).toEqual([]); expect(database.scopedConfiguration("p")).toBeUndefined();
    const request = { projectId: "p", requestId: "legacy-first", base: context.current.version, proposal: context.current.snapshot };
    expect(database.prepareUserWorkflowAdjustment(request, seed).replay).toBe(false);
    expect(database.projectState("p")).toEqual(before); expect(database.eventsAfter("p", 0, 1000)).toEqual(events);
    expect(database.submitUserWorkflowAdjustment(request, seed).record).toMatchObject({ status: "pending", base: context.current.version });
    expect(database.workflowAdjustmentCurrent("p").version).toEqual(context.current.version);
    expect(database.scopedConfiguration("p")).toEqual(seed);
    expect(database.prepareUserWorkflowAdjustment(request, seed)).toMatchObject({ replay: true, result: { replay: true } });
  });

  it("rejects stale or invalid legacy submissions without seeding or replacing authority", async () => {
    const f = await fixture(false, false), database = f.database;
    const seed = { agents: mergeAgentConfigs(undefined, cloneAgentOrchestrationTemplate()), skillDefinitions: {}, mcpDefinitions: {} };
    const context = database.workflowAdjustmentContext("p", seed), before = database.projectState("p");
    const stale = { projectId: "p", requestId: "stale-first", base: { ...context.current.version, revision: 2 }, proposal: { apiKey: "not-a-valid-proposal" } };
    expect(() => database.prepareUserWorkflowAdjustment(stale as unknown as SubmitUserWorkflowAdjustmentInput, seed)).toThrow(WORKFLOW_ADJUSTMENT_STALE_MESSAGE);
    expect(() => database.submitUserWorkflowAdjustment({ ...stale, base: context.current.version } as unknown as SubmitUserWorkflowAdjustmentInput, seed)).toThrow();
    expect(database.scopedConfiguration("p")).toBeUndefined(); expect(database.projectState("p")).toEqual(before);
  });

  it("rolls back a legacy configuration seed together with a failed formal submission", async () => {
    const f = await fixture(false, false), database = f.database;
    const seed = { agents: mergeAgentConfigs(undefined, cloneAgentOrchestrationTemplate()), skillDefinitions: {}, mcpDefinitions: {} };
    const current = database.workflowAdjustmentContext("p", seed).current, before = database.projectState("p"), events = database.eventsAfter("p", 0, 1000);
    const sql = new DatabaseSync(f.options.databasePath);
    try { sql.exec("CREATE TRIGGER reject_first_adjustment BEFORE INSERT ON project_events WHEN NEW.event_type = 'workflow.adjustment.submitted' BEGIN SELECT RAISE(ABORT, 'reject first adjustment'); END"); }
    finally { sql.close(); }
    expect(() => database.submitUserWorkflowAdjustment({ projectId: "p", requestId: "first-fails", base: current.version, proposal: current.snapshot }, seed)).toThrow(/reject first adjustment/);
    expect(database.scopedConfiguration("p")).toBeUndefined(); expect(database.projectState("p")).toEqual(before);
    expect(database.eventsAfter("p", 0, 1000)).toEqual(events); expect(database.verifyHealth().integrity).toBe("ok");
  });

  it("records the full user/base snapshots and truthful diff independently of Main permission without applying configuration", async () => {
    const { database, input } = await fixture(false), request = input();
    const before = database.workflowAdjustmentCurrent("p"), result = database.submitUserWorkflowAdjustment(request);
    expect(result.record).toMatchObject({ source: { kind: "user" }, status: "pending", base: request.base, explanation: request.explanation,
      proposal: request.proposal, baseSnapshot: before.snapshot });
    expect(result.record.changes).toEqual([{ path: ["agents", "idea", "instructions"], kind: "changed",
      before: before.snapshot.agents.idea.instructions, after: request.proposal.agents.idea.instructions }]);
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
    expect(database.projectState("p").workflowRevision).toBe(1);
    request.proposal.agents.idea.instructions = "Later unsubmitted draft";
    result.record.proposal.agents.idea.skills.push("unsubmitted-draft");
    expect(database.workflowAdjustments("p")[0].proposal.agents.idea.instructions).toBe("Exact user instructions user-one");
    expect(database.workflowAdjustments("p")[0].proposal.agents.idea.skills).not.toContain("unsubmitted-draft");
  });

  it("keeps configuration version stable across queue facts, heartbeat and waiting reasons", async () => {
    const { database, input } = await fixture(), version = database.workflowAdjustmentCurrent("p").version;
    database.submitUserWorkflowAdjustment(input());
    database.appendEvent({ projectId: "p", type: "runtime.heartbeat", payload: { live: true } });
    database.recordWorkflowAdjustmentWaiting({ projectId: "p", requestId: "user-one", reason: "idea's logical task still owns its original result" });
    expect(database.workflowAdjustmentCurrent("p").version).toEqual(version);
    expect(database.workflowAdjustments("p")[0].waitingReason).toBe("idea's logical task still owns its original result");
    const revision = database.projectState("p").revision;
    expect(database.recordWorkflowAdjustmentWaiting({ projectId: "p", requestId: "user-one", reason: "idea's logical task still owns its original result" }).changed).toBe(false);
    expect(database.projectState("p").revision).toBe(revision);
  });

  it("deduplicates identical submission and rejects changed contents without modifying the immutable request", async () => {
    const { database, input } = await fixture(), request = input();
    const first = database.submitUserWorkflowAdjustment(request), events = database.eventsAfter("p", 0, 100);
    expect(database.submitUserWorkflowAdjustment(structuredClone(request))).toMatchObject({ replay: true, record: first.record });
    expect(() => database.submitUserWorkflowAdjustment({ ...request, explanation: "Different reason" })).toThrow(/changed on replay/);
    expect(database.eventsAfter("p", 0, 100)).toEqual(events);
  });

  it("requires the exact explicit replacement and atomically keeps only one current user request across connections", async () => {
    const { database, input, options } = await fixture(); database.submitUserWorkflowAdjustment(input());
    const another = CollaborationStateDatabase.open({ ...options, writerLease: database.writerLease() }); stores.push(another);
    const next = input("user-two");
    expect(() => another.submitUserWorkflowAdjustment(next)).toThrow("已有一条待应用修改，本次提交将覆盖它");
    expect(() => another.submitUserWorkflowAdjustment({ ...next, replacesRequestId: "wrong" })).toThrow();
    const old = database.workflowAdjustments("p")[0];
    expect(another.submitUserWorkflowAdjustment({ ...next, replacesRequestId: old.requestId }).record.status).toBe("pending");
    const competing = input("user-three");
    expect(() => database.submitUserWorkflowAdjustment({ ...competing, replacesRequestId: old.requestId })).toThrow(/覆盖/);
    const records = another.workflowAdjustments("p");
    expect(records.filter(record => record.source.kind === "user" && record.status === "pending")).toHaveLength(1);
    expect(records[0]).toMatchObject({ proposal: old.proposal, explanation: old.explanation, status: "replaced",
      history: [expect.anything(), expect.objectContaining({ replacedByRequestId: "user-two" })] });
    expect(records[1].replacesRequestId).toBe("user-one");
  });

  it.each(["validation", "persistence"] as const)("keeps the old request and all events if replacement fails at %s", async failure => {
    const { database, input, options } = await fixture(); database.submitUserWorkflowAdjustment(input());
    const before = database.workflowAdjustments("p"), events = database.eventsAfter("p", 0, 100), revision = database.projectState("p").revision;
    const next = { ...input("replacement"), replacesRequestId: "user-one" };
    if (failure === "validation") (next.proposal.agents.idea as unknown as Record<string, unknown>).proxy = { mode: "inherit" };
    else {
      const raw = new DatabaseSync(options.databasePath);
      raw.exec(`CREATE TRIGGER fixture_reject_adjustment BEFORE INSERT ON project_events
        WHEN NEW.event_type = 'workflow.adjustment.submitted' AND json_extract(NEW.payload_json, '$.submission.requestId') = 'replacement'
        BEGIN SELECT RAISE(ABORT, 'fixture rejected durable new request'); END;`); raw.close();
    }
    expect(() => database.submitUserWorkflowAdjustment(next)).toThrow();
    expect(database.workflowAdjustments("p")).toEqual(before); expect(database.eventsAfter("p", 0, 100)).toEqual(events);
    expect(database.projectState("p").revision).toBe(revision);
  });

  it("serializes two actual processes replacing the same user request, accepting only one complete snapshot", async () => {
    const { database, options, input, root } = await fixture(); database.submitUserWorkflowAdjustment(input());
    const worker = join(root, "replace.mjs"), config = join(root, "worker.json");
    await writeFile(config, JSON.stringify({ options: { ...options, now: undefined, writerLease: database.writerLease() },
      requests: ["window-one", "window-two"].map(id => ({ ...input(id), replacesRequestId: "user-one" })) }));
    await writeFile(worker, `import { readFileSync } from "node:fs";
import { CollaborationStateDatabase } from ${JSON.stringify(new URL("../src/collaboration-state/store.ts", import.meta.url).href)};
const { options, requests } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const database = CollaborationStateDatabase.open({ ...options, now: () => 1000000 });
process.stdout.write("ready\\n"); await new Promise(resolve => process.stdin.once("data", resolve));
try { const result = database.submitUserWorkflowAdjustment(requests[Number(process.argv[3])]);
  process.stdout.write(JSON.stringify({ accepted: true, requestId: result.record.requestId }));
} catch (error) { process.stdout.write(JSON.stringify({ accepted: false, code: error.code })); }
finally { database.close(); }
`);
    const outcomes = await concurrentWorkflowWorkers(worker, config, ["0", "1"]);
    expect(outcomes.filter(result => result.accepted)).toHaveLength(1);
    expect(outcomes.find(result => !result.accepted).code).toBe("WORKFLOW_ADJUSTMENT_CONFLICT");
    const records = database.workflowAdjustments("p"), active = records.filter(record => record.status === "pending");
    expect(active).toHaveLength(1); expect(active[0].requestId).toBe(outcomes.find(result => result.accepted).requestId);
    expect(records[0].history.at(-1)?.replacedByRequestId).toBe(active[0].requestId);
    expect(database.verifyHealth().integrity).toBe("ok");
  }, 20_000);

  it("rejects an old base at submission and preserves the caller's draft and existing request", async () => {
    const { database, input } = await fixture(); const request = input(); database.submitUserWorkflowAdjustment(request);
    const current = database.workflowAdjustmentCurrent("p");
    database.saveWorkflowRevision({ projectId: "p", workflowRevision: 2, snapshot: current.snapshot.orchestration, affectedGroupIds: [] });
    const draft = { ...input("user-two"), base: request.base, replacesRequestId: "user-one" }, original = structuredClone(draft);
    const events = database.eventsAfter("p", 0, 100);
    expect(() => database.submitUserWorkflowAdjustment(draft)).toThrow(WORKFLOW_ADJUSTMENT_STALE_MESSAGE);
    expect(draft).toEqual(original); expect(database.eventsAfter("p", 0, 100)).toEqual(events);
    const [record] = database.workflowAdjustments("p");
    expect(record).toMatchObject({ status: "needs_resubmission", proposal: request.proposal, base: request.base });
    expect(record.currentVersion.revision).toBe(2);
    expect(database.synchronizeWorkflowAdjustmentVersions("p").changed).toBe(true);
    expect(database.synchronizeWorkflowAdjustmentVersions("p").changed).toBe(false);
    expect(database.workflowAdjustments("p")[0].history.at(-1)).toMatchObject({ status: "needs_resubmission", currentVersion: record.currentVersion });
    expect(database.withdrawWorkflowAdjustment({ projectId: "p", requestId: request.requestId, operationId: "stale-withdraw" }).withdrawn).toBe(false);
    expect(database.submitUserWorkflowAdjustment({ ...input("user-revised"), replacesRequestId: request.requestId }).record.status).toBe("pending");
    expect(database.workflowAdjustments("p")[0].status).toBe("replaced");
  });

  it("withdraws only the selected pending snapshot, preserves its content, and cannot revive it through replay", async () => {
    const { database, input } = await fixture(), request = input(); database.submitUserWorkflowAdjustment(request);
    const operation = { projectId: "p", requestId: request.requestId, operationId: "withdraw-one" };
    const first = database.withdrawWorkflowAdjustment(operation);
    expect(first).toMatchObject({ withdrawn: true, replay: false, record: { status: "withdrawn", proposal: request.proposal } });
    expect(first.record.history.at(-1)).not.toHaveProperty("note");
    expect(database.withdrawWorkflowAdjustment(operation)).toMatchObject({ withdrawn: true, replay: true });
    expect(() => database.withdrawWorkflowAdjustment({ ...operation, note: "Changed on replay" })).toThrow(/changed on replay/);
    expect(database.submitUserWorkflowAdjustment(request)).toMatchObject({ replay: true, record: { status: "withdrawn" } });
    expect(database.submitUserWorkflowAdjustment(input("next-user")).record.status).toBe("pending");
  });

  it("detects configuration content changes even if the Workflow revision integer is unchanged", async () => {
    const { database, input } = await fixture(); const request = input(); database.submitUserWorkflowAdjustment(request);
    const { orchestration: _workflow, ...configuration } = database.workflowAdjustmentCurrent("p").snapshot;
    configuration.agents.writing.instructions = "Another actually persisted configuration";
    database.appendEvent({ projectId: "p", type: "scoped.configuration.applied", payload: { configuration } });
    const current = database.workflowAdjustmentCurrent("p").version;
    expect(current.revision).toBe(request.base.revision); expect(current.hash).not.toBe(request.base.hash);
    expect(database.workflowAdjustments("p")[0].status).toBe("needs_resubmission");
    expect(() => database.submitUserWorkflowAdjustment({ ...request, requestId: "old-base", replacesRequestId: request.requestId })).toThrow(WORKFLOW_ADJUSTMENT_STALE_MESSAGE);
  });

  it("registers actual Main receipts separately from the user request and keeps original call, Session and public rationale", async () => {
    const { database, input, acceptMain, root } = await fixture();
    database.submitUserWorkflowAdjustment(input());
    const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "test", generation: 1, nativeId: "original-main-session", durable: true,
      createdAt: "2026-10-10T00:00:00Z" };
    database.recordAgentNativeSessionBinding({ projectId: "p", agentId: "main", invocationId: "main-native", runtimePath: join(root, "runtime", "main-native"),
      worktreePath: join(root, "main"), session, executionContext: { role: "leader", nodeRunId: "main-node", groupRunId: "independent-main", coordinatorEpoch: 1 } });
    const main = acceptMain();
    const original = database.eventByRequestId("p", main.requestId)!;
    const registered = database.registerAcceptedMainWorkflowAdjustment("p", main.requestId);
    expect(registered.record).toMatchObject({ requestId: main.requestId, source: { kind: "main", acceptedRequestId: main.requestId,
      acceptedEventId: original.eventId, invocationId: "main-native", callId: "main-apply", session }, explanation: "Exact public Main rationale", status: "pending" });
    expect(database.workflowAdjustments("p")).toHaveLength(2);
    const withdrawn = database.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "withdraw-main", note: "Keep my current task constraints" });
    expect(withdrawn.record.history.at(-1)?.note).toBe("Keep my current task constraints");
    expect(database.registerAcceptedMainWorkflowAdjustment("p", main.requestId)).toMatchObject({ replay: true, record: { status: "withdrawn" } });
    expect(database.eventByRequestId("p", main.requestId)).toEqual(original);
    expect(database.workflowAdjustments("p")[0].status).toBe("pending");
  });

  it("does not register a fabricated Main reference or another control action", async () => {
    const { database } = await fixture();
    expect(() => database.registerAcceptedMainWorkflowAdjustment("p", "unknown")).toThrow(/does not exist/);
    database.appendEvent({ projectId: "p", requestId: "not-a-tool", type: "model.output", payload: { text: "apply workflow" } });
    expect(() => database.registerAcceptedMainWorkflowAdjustment("p", "not-a-tool")).toThrow(/malformed/);
    expect(database.workflowAdjustments("p")).toEqual([]);
  });

  it("does not let user request identities occupy Main's accepted tool receipt namespace", async () => {
    const { database, input, acceptMain } = await fixture(), main = acceptMain();
    const events = database.eventsAfter("p", 0, 100);
    expect(() => database.submitUserWorkflowAdjustment({ ...input(), requestId: main.requestId })).toThrow(/reserved/);
    expect(database.eventsAfter("p", 0, 100)).toEqual(events);
    expect(database.registerAcceptedMainWorkflowAdjustment("p", main.requestId).record.source.kind).toBe("main");
  });

  it("reads old S runtime metadata without altering its original configuration/hash or exposing proxy and Gateway fields", async () => {
    const { database, input } = await fixture(), { orchestration: _graph, ...configuration } = database.workflowAdjustmentCurrent("p").snapshot;
    const legacy = { ...configuration, agents: Object.fromEntries(Object.entries(configuration.agents).map(([id, config]) =>
      [id, { ...config, proxy: { mode: "direct" }, reasoningMigrationWarning: "Original diagnostic" }])) };
    database.appendEvent({ projectId: "p", type: "scoped.configuration.applied", payload: { configuration: legacy } });
    const original = database.scopedConfiguration("p"), configurationHash = database.scopedConfigurationHash("p");
    const current = database.workflowAdjustmentCurrent("p");
    for (const config of Object.values(current.snapshot.agents)) {
      expect(config).not.toHaveProperty("proxy"); expect(config).not.toHaveProperty("reasoningMigrationWarning"); expect(config).not.toHaveProperty("gatewaySnapshot");
    }
    expect(database.scopedConfiguration("p")).toEqual(original); expect(database.scopedConfigurationHash("p")).toBe(configurationHash);
    expect(database.submitUserWorkflowAdjustment(input()).record.base).toEqual(current.version);
    expect(database.scopedConfiguration("p")).toEqual(original);
  });

  it("maps a Main recovery rebind back to its withdrawn original instead of creating a live replacement", async () => {
    const { database, acceptMain } = await fixture(), main = acceptMain();
    database.registerAcceptedMainWorkflowAdjustment("p", main.requestId);
    database.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "withdraw-main" });
    const original = database.eventByRequestId("p", main.requestId)!;
    database.appendEvent({ projectId: "p", nodeRunId: "main-node", agentId: "main", coordinatorEpoch: 1,
      type: "main.route.recovered", payload: { residentStopConfirmed: true } });
    database.appendEvent({ projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "recovered-native", coordinatorEpoch: 2,
      type: "main.route.attempt", payload: { attempt: 2 } });
    const newHash = hash("recovered-main"), reboundId = `accepted-main-control-${newHash}-0`;
    database.revalidateMainRouteControl({ projectId: "p", nodeRunId: "main-node", invocationId: "recovered-native", routeEpoch: 2, stateVersion: 2,
      candidateNodeIds: ["finish"], canComplete: true, allowFinishRoute: false, action: original.payload.action as ControlAction,
      accepted: { requestId: reboundId, inputId: "recovered-input", invocationId: "recovered-native", callId: "recovered-apply", semanticInputHash: newHash,
        workflowProposal: original.payload.workflowProposal as AcceptedMainRouteAction["workflowProposal"], reboundFrom: { routeEpoch: 1, semanticInputHash: main.semanticInputHash, sequence: 0 } } });
    expect(database.registerAcceptedMainWorkflowAdjustment("p", reboundId)).toMatchObject({ replay: true,
      record: { requestId: main.requestId, status: "withdrawn", source: { invocationId: "main-native", callId: "main-apply" } } });
    expect(database.workflowAdjustments("p")).toHaveLength(1); expect(database.eventByRequestId("p", main.requestId)).toEqual(original);
    expect(database.rollForwardAcceptedMainWorkflow({ projectId: "p", nodeRunId: "main-node", routeEpoch: 2,
      semanticInputHash: newHash, sequence: 0 })).toMatchObject({ requestId: main.requestId, status: "withdrawn", workflowRevision: 1 });
    expect(database.workflowAdjustmentCurrent("p").snapshot.agents.idea.instructions).not.toBe("Actual Main proposal content");
  });

  it("restores pending, replacement and withdrawal facts after writer restart without resetting versions", async () => {
    const { database, options, clock, input } = await fixture(); database.submitUserWorkflowAdjustment(input());
    database.submitUserWorkflowAdjustment({ ...input("user-two"), replacesRequestId: "user-one" });
    database.withdrawWorkflowAdjustment({ projectId: "p", requestId: "user-two", operationId: "withdraw" });
    const records = database.workflowAdjustments("p"), current = database.workflowAdjustmentCurrent("p"); database.close(); clock.now += 30_001;
    const restarted = CollaborationStateDatabase.open({ ...options, instanceId: "next-writer" }); stores.push(restarted);
    expect(restarted.workflowAdjustments("p")).toEqual(records); expect(restarted.workflowAdjustmentCurrent("p")).toEqual(current);
    expect(restarted.verifyHealth().integrity).toBe("ok");
  });

  it("fences a stale writer before it can replace or withdraw a current request", async () => {
    const { database, options, clock, input } = await fixture(), request = input(); database.submitUserWorkflowAdjustment(request);
    const replacement = { ...input("replacement"), replacesRequestId: "user-one" }; clock.now += 30_001;
    const current = CollaborationStateDatabase.open({ ...options, instanceId: "new-writer" }); stores.push(current);
    const events = current.eventsAfter("p", 0, 100);
    expect(() => database.submitUserWorkflowAdjustment(replacement)).toThrow(/writer epoch/);
    expect(() => database.withdrawWorkflowAdjustment({ projectId: "p", requestId: "user-one", operationId: "withdraw" })).toThrow(/writer epoch/);
    expect(current.eventsAfter("p", 0, 100)).toEqual(events); expect(current.workflowAdjustments("p")[0].status).toBe("pending");
  });

  it.each(["missing-agent", "extra-agent", "unknown-field", "undefined-resource", "credential"] as const)("rejects an invalid complete submission (%s) without creating a queue record", async invalid => {
    const { database, input } = await fixture(), request = input();
    if (invalid === "missing-agent") delete request.proposal.agents.idea;
    if (invalid === "extra-agent") request.proposal.agents.invented = structuredClone(request.proposal.agents.idea);
    if (invalid === "unknown-field") (request.proposal.agents.idea as unknown as Record<string, unknown>).proxy = { mode: "direct" };
    if (invalid === "undefined-resource") request.proposal.agents.idea.skills = ["project:undefined"];
    if (invalid === "credential") (request.proposal as unknown as Record<string, unknown>).apiKey = "inline-secret";
    const events = database.eventsAfter("p", 0, 100);
    expect(() => database.submitUserWorkflowAdjustment(request)).toThrow();
    expect(database.workflowAdjustments("p")).toEqual([]); expect(database.eventsAfter("p", 0, 100)).toEqual(events);
  });

  it.each(["source", "explanation", "base", "requestId"] as const)("rejects an invalid submission envelope (%s) without changing the current user request", async field => {
    const { database, input } = await fixture(); database.submitUserWorkflowAdjustment(input());
    const request = { ...input("user-two"), replacesRequestId: "user-one" } as unknown as Record<string, unknown>;
    request[field] = field === "source" ? { kind: "main" } : field === "explanation" ? { invented: true } : field === "base" ? { revision: -1, hash: "bad" } : " ambiguous-id ";
    const events = database.eventsAfter("p", 0, 100);
    expect(() => database.submitUserWorkflowAdjustment(request as unknown as SubmitUserWorkflowAdjustmentInput)).toThrow();
    expect(database.eventsAfter("p", 0, 100)).toEqual(events); expect(database.workflowAdjustments("p")[0].status).toBe("pending");
  });

  it("keeps diff paths unambiguous for names containing dots and preserves entire route/Loop arrays", () => {
    const before = { agents: { "a.b": { instructions: "old" } }, orchestration: { routes: { main: [{ kind: "weak", target: "a.b" }] }, loops: [] } };
    const after = { agents: { "a.b": { instructions: "new" } }, orchestration: { routes: { main: [{ kind: "strong", target: "a.b" }] }, loops: [{ id: "loop" }] } };
    const original = structuredClone(after), changes = workflowAdjustmentChanges(before, after);
    expect(changes.map(change => change.path)).toEqual([["agents", "a.b", "instructions"], ["orchestration", "loops"], ["orchestration", "routes", "main"]]);
    (changes[1].after as unknown[]).push("local-preview-only"); expect(after).toEqual(original);
  });

  it("retains existing project resources and permits new named resources in the full snapshot", async () => {
    const { database } = await fixture(), current = database.workflowAdjustmentCurrent("p").snapshot;
    current.skillDefinitions.kept = { files: { "SKILL.md": "Original Skill" } };
    current.mcpDefinitions.kept = { files: { "main.mjs": "console.log('original')" }, entrypoint: "main.mjs" };
    const next = structuredClone(current); next.skillDefinitions.added = { files: { "SKILL.md": "New Skill" } };
    next.agents.idea.skills = ["project:added"];
    expect(validateWorkflowAdjustmentSnapshot(next, current).agents.idea.skills).toContain("project:added");
    for (const field of ["skillDefinitions", "mcpDefinitions"] as const) {
      const deleted = structuredClone(next); delete deleted[field].kept;
      expect(() => validateWorkflowAdjustmentSnapshot(deleted, current)).toThrow(/immutable/);
      const changed = structuredClone(next); changed[field].kept.files = field === "skillDefinitions" ? { "SKILL.md": "Changed" } : { "main.mjs": "console.log('changed')" };
      expect(() => validateWorkflowAdjustmentSnapshot(changed, current)).toThrow(/immutable/);
    }
  });
});

describe("user workflow publication consumes the immutable shared journal", () => {
  const prepare = (database: CollaborationStateDatabase, requestId = "user-one") => {
    const prepared = database.prepareUserWorkflowAdjustmentPublication("p", requestId);
    expect(prepared.ready).toBe(true);
    if (!prepared.ready) throw new Error("Expected a real safe user boundary");
    return prepared;
  };

  it("atomically publishes the complete user snapshot with Main editing disabled and replays the real applied version", async () => {
    const { database, input } = await fixture(false), request = input();
    request.proposal.orchestration.decisionPlans.idea = "Exact user graph decision plan";
    database.submitUserWorkflowAdjustment(request); const prepared = prepare(database);
    const applied = database.publishUserWorkflowAdjustment("p", request.requestId, prepared.validationToken);
    expect(applied).toMatchObject({ status: "applied", replay: false, workflowRevision: 2, appliedVersion: database.workflowAdjustmentCurrent("p").version });
    expect(database.workflowAdjustmentCurrent("p").snapshot).toEqual(request.proposal);
    const record = database.workflowAdjustments("p")[0]; expect(record.base).toEqual(request.base);
    expect(record.history.at(-1)).toMatchObject({ status: "applied", appliedVersion: applied.appliedVersion });
    const events = database.eventsAfter("p", 0, 1000), revision = database.projectState("p").stateRevision;
    expect(database.publishUserWorkflowAdjustment("p", request.requestId, prepared.validationToken)).toMatchObject({ status: "applied", replay: true, appliedVersion: applied.appliedVersion });
    expect(database.eventsAfter("p", 0, 1000)).toEqual(events); expect(database.projectState("p").stateRevision).toBe(revision);
  });

  it("rejects a validation token for different content without partial publication", async () => {
    const { database, input } = await fixture(); database.submitUserWorkflowAdjustment(input()); prepare(database);
    const before = database.projectState("p"), events = database.eventsAfter("p", 0, 1000);
    expect(() => database.publishUserWorkflowAdjustment("p", "user-one", "different-snapshot")).toThrow(/immutable submission/);
    expect(database.projectState("p")).toEqual(before); expect(database.eventsAfter("p", 0, 1000)).toEqual(events);
  });

  it("serializes user publication and withdrawal in actual separate processes with one immutable terminal result", async () => {
    const { database, input, options, root } = await fixture(false), request = input(); database.submitUserWorkflowAdjustment(request);
    const prepared = prepare(database), worker = join(root, "user-publication-race.mjs"), config = join(root, "user-publication-race.json");
    await writeFile(config, JSON.stringify({ options: { ...options, now: undefined, writerLease: database.writerLease() }, token: prepared.validationToken }));
    await writeFile(worker, `import { readFileSync } from "node:fs";
import { CollaborationStateDatabase } from ${JSON.stringify(new URL("../src/collaboration-state/store.ts", import.meta.url).href)};
const { options, token } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const database = CollaborationStateDatabase.open({ ...options, now: () => 1000000 });
process.stdout.write("ready\\n"); await new Promise(resolve => process.stdin.once("data", resolve));
try { const result = process.argv[3] === "publish" ? database.publishUserWorkflowAdjustment("p", "user-one", token)
  : database.withdrawWorkflowAdjustment({ projectId: "p", requestId: "user-one", operationId: "user-publication-race" });
  process.stdout.write(JSON.stringify(result)); } finally { database.close(); }
`);
    const [publication, withdrawal] = await concurrentWorkflowWorkers(worker, config, ["publish", "withdraw"]);
    const record = database.workflowAdjustments("p")[0]; expect(["applied", "withdrawn"]).toContain(record.status);
    expect(publication.status).toBe(record.status); expect(withdrawal.record.status).toBe(record.status);
    expect(withdrawal.withdrawn).toBe(record.status === "withdrawn");
    expect(record.history.filter(item => ["applied", "withdrawn"].includes(item.status))).toHaveLength(1);
    expect(database.workflowAdjustmentCurrent("p").snapshot).toEqual(record.status === "applied" ? request.proposal : prepared.record.baseSnapshot);
    expect(database.projectState("p").workflowRevision).toBe(record.status === "applied" ? 2 : 1);
    expect(record.base).toEqual(request.base); expect(record.proposal).toEqual(request.proposal);
  });

  it("serializes a new Git preparation against user submission and publication in actual separate processes", async () => {
    const { database, input, options, root } = await fixture(false);
    const graph = cloneAgentOrchestrationTemplate(); graph.schemaVersion = 3;
    graph.collaborations = [{ id: "G", displayName: "G", memberAgentIds: [], renamePolicy: "editable" }];
    graph.input.target = "G"; graph.termination.agent = "G"; graph.routes.G = [{ kind: "strong", target: "finish" }];
    for (const [source, edges] of Object.entries(graph.routes)) if (source !== "G") graph.routes[source] = edges.filter(edge => edge.target !== "finish");
    graph.scopedWorkflow = { schemaVersion: 1, rootAgentIds: graph.agents.map(agent => agent.name), groups: [{ id: "G", leaderAgentId: "main",
      allowLeaderReconfiguration: false, workflow: { nodes: ["idea", "execution"].map(agentId => ({ kind: "agent", nodeId: `G_${agentId}`, agentId })),
        input: { source: "input", edges: ["G_idea", "G_execution"].map(target => ({ kind: "parallel", target })) },
        routes: { G_idea: [{ kind: "strong", target: "finish" }], G_execution: [{ kind: "strong", target: "finish" }] } } }] };
    database.saveWorkflowRevision({ projectId: "p", workflowRevision: 2, snapshot: normalizeAgentOrchestrationTemplate(graph), affectedGroupIds: [] });
    const request = input(); request.proposal.orchestration.scopedWorkflow!.groups[0].workflow.input.edges.reverse();
    const activation = { projectId: "p", groupRunId: "original-G", groupId: "G", activationRequestId: "original-birth", workflowRevision: 2,
      outer: { nodeRunId: "original-node", inputSnapshotRef: "original-input", activatedByAgentId: "main" } };
    const worker = join(root, "preparation-publication-race.mjs"), config = join(root, "preparation-publication-race.json");
    await writeFile(config, JSON.stringify({ options: { ...options, now: undefined, writerLease: database.writerLease() }, request, activation }));
    await writeFile(worker, `import { readFileSync } from "node:fs";
import { CollaborationStateDatabase } from ${JSON.stringify(new URL("../src/collaboration-state/store.ts", import.meta.url).href)};
const { options, request, activation } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const database = CollaborationStateDatabase.open({ ...options, now: () => 1000000 });
process.stdout.write("ready\\n"); await new Promise(resolve => process.stdin.once("data", resolve));
try {
  let result;
  if (process.argv[3] === "prepare") { try { result = { preparation: database.prepareScopedGroupActivation(activation) }; }
    catch (error) { result = { error: error.code }; } }
  else { database.submitUserWorkflowAdjustment(request); const prepared = database.prepareUserWorkflowAdjustmentPublication("p", request.requestId);
    result = prepared.ready ? database.publishUserWorkflowAdjustment("p", request.requestId, prepared.validationToken) : prepared.publication; }
  process.stdout.write(JSON.stringify(result));
} finally { database.close(); }
`);
    const [prepared, published] = await concurrentWorkflowWorkers(worker, config, ["prepare", "publish"]);
    const record = database.workflowAdjustments("p")[0], preparations = database.scopedGroupActivationPreparations("p");
    expect(published.status).toBe(record.status); expect(record.base).toEqual(request.base); expect(record.proposal).toEqual(request.proposal);
    if (record.status === "pending") {
      expect(prepared.preparation.input.workflowRevision).toBe(2); expect(preparations).toHaveLength(1);
      expect(record.waitingReason).toContain("原Git激活准备"); expect(database.projectState("p").workflowRevision).toBe(2);
    } else {
      expect(record.status).toBe("applied"); expect(database.projectState("p").workflowRevision).toBe(3);
      if (prepared.error) { expect(prepared.error).toBe("WORKFLOW_ADJUSTMENT_PENDING"); expect(preparations).toEqual([]); }
      else { expect(prepared.preparation.input.workflowRevision).toBe(3); expect(preparations).toHaveLength(1); }
    }
    expect(database.projectState("p").scopedArrivals).toEqual([]); expect(database.projectState("p").activeNodeRunId).toBeUndefined();
    expect(record.history.filter(transition => transition.status === "applied")).toHaveLength(record.status === "applied" ? 1 : 0);
  });

  it.each(["withdrawn", "replaced"] as const)("keeps %s truth when the original request changes during asynchronous validation", async terminal => {
    const { database, input } = await fixture(); database.submitUserWorkflowAdjustment(input()); const prepared = prepare(database);
    if (terminal === "withdrawn") database.withdrawWorkflowAdjustment({ projectId: "p", requestId: "user-one", operationId: "withdraw-during-validation", note: "Original user note" });
    else database.submitUserWorkflowAdjustment({ ...input("user-two"), replacesRequestId: "user-one" });
    expect(database.publishUserWorkflowAdjustment("p", "user-one", prepared.validationToken)).toMatchObject({ status: terminal });
    expect(database.workflowAdjustmentCurrent("p").version).toEqual(prepared.record.base);
    expect(database.workflowAdjustments("p")[0].proposal).toEqual(prepared.record.proposal);
    if (terminal === "replaced") expect(database.workflowAdjustments("p")[1].status).toBe("pending");
  });

  it("persists stale without rebasing after configuration changes during validation", async () => {
    const { database, input } = await fixture(); database.submitUserWorkflowAdjustment(input()); const prepared = prepare(database);
    const configuration = structuredClone(database.scopedConfiguration("p")!); configuration.agents.idea.instructions = "Actual newer authority";
    database.appendEvent({ projectId: "p", type: "scoped.configuration.applied", payload: { configuration } });
    expect(database.publishUserWorkflowAdjustment("p", "user-one", prepared.validationToken)).toMatchObject({ status: "needs_resubmission", reason: WORKFLOW_ADJUSTMENT_STALE_MESSAGE });
    expect(database.workflowAdjustmentCurrent("p").snapshot.agents.idea.instructions).toBe("Actual newer authority");
    expect(database.workflowAdjustments("p")[0].history.at(-1)?.status).toBe("needs_resubmission");
  });

  it("rolls graph, configuration and applied receipt back together on a journal failure", async () => {
    const { database, input, options } = await fixture(); database.submitUserWorkflowAdjustment(input()); const prepared = prepare(database);
    const sql = new DatabaseSync(options.databasePath);
    try { sql.exec("CREATE TRIGGER reject_user_publication BEFORE INSERT ON project_events WHEN NEW.event_type = 'workflow.adjustment.transitioned' AND json_extract(NEW.payload_json, '$.transition.status') = 'applied' BEGIN SELECT RAISE(ABORT, 'reject applied receipt'); END"); }
    finally { sql.close(); }
    const before = database.projectState("p"), events = database.eventsAfter("p", 0, 1000);
    expect(() => database.publishUserWorkflowAdjustment("p", "user-one", prepared.validationToken)).toThrow(/reject applied receipt/);
    expect(database.projectState("p")).toEqual(before); expect(database.eventsAfter("p", 0, 1000)).toEqual(events);
    expect(database.verifyHealth().integrity).toBe("ok");
  });

  it("blocks a new affected root task atomically while allowing an unrelated Agent", async () => {
    const { database, input } = await fixture(); database.submitUserWorkflowAdjustment(input());
    const activate = (agentId: string) => database.activateNode({ projectId: "p", nodeRunId: `node-${agentId}`,
      node: { kind: "agent", nodeId: agentId, agentId }, activationRequestId: `activate-${agentId}`, inputSnapshotRef: "original-input",
      activatedByAgentId: "main", workflowRevision: 1 });
    expect(() => activate("idea")).toThrow(/用户修改/); expect(database.projectState("p").nodeRuns).toEqual([]);
    expect(activate("execution").nodeRun.node.agentId).toBe("execution");
    const prepared = prepare(database); expect(database.publishUserWorkflowAdjustment("p", "user-one", prepared.validationToken).status).toBe("applied");
    expect(database.projectState("p").nodeRuns[0].workflowRevision).toBe(1);
  });

  it("gives the valid user request priority and retains the conflicting Main proposal as stale", async () => {
    const { database, input, acceptMain } = await fixture(); const main = acceptMain();
    database.submitUserWorkflowAdjustment(input()); const prepared = prepare(database);
    expect(database.publishUserWorkflowAdjustment("p", "user-one", prepared.validationToken).status).toBe("applied");
    const original = database.workflowAdjustments("p").find(record => record.requestId === main.requestId)!;
    expect(original.status).toBe("needs_resubmission"); expect(original.source.kind).toBe("main");
    expect(original.proposal.agents.idea.instructions).toBe("Actual Main proposal content");
  });

  it("lets the original Main task finish, rechecks a reopened native owner, then blocks the next task until publication", async () => {
    const { database, input } = await fixture(false);
    database.activateNode({ projectId: "p", nodeRunId: "main-node", node: { kind: "agent", nodeId: "main", agentId: "main" },
      activationRequestId: "main-activation", inputSnapshotRef: "original-input", activatedByAgentId: "main", workflowRevision: 1 });
    const request = input(); request.proposal.agents.main.instructions = "User's future Main instructions";
    database.submitUserWorkflowAdjustment(request);
    const own = { projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "main-native", coordinatorEpoch: 1 };
    // This is the already activated original task, not a new notification wake.
    database.appendEvent({ ...own, type: "main.route.attempt", payload: { attempt: 1, inputId: "original-input" } });
    database.startRuntimeActivity({ ...own, kind: "resident", phase: "resident:running" });
    expect(database.prepareUserWorkflowAdjustmentPublication("p", "user-one").ready).toBe(false);
    database.appendEvent({ ...own, type: "main.route.task_completion.committed", payload: { taskId: "original-task", inputId: "original-input" } });
    database.closeRuntimeActivity({ ...own, kind: "resident", outcome: "completed" });
    const prepared = prepare(database), prior = database.projectState("p").nodeRuns;
    expect(() => database.appendEvent({ ...own, requestId: "next-main-task", invocationId: "next-native", coordinatorEpoch: 2,
      type: "main.route.attempt", payload: { attempt: 2, inputId: "next-input" } })).toThrow(/用户修改/);
    database.startRuntimeActivity({ ...own, kind: "resident", phase: "resident:running", requestId: "reopened-original-native" });
    expect(database.publishUserWorkflowAdjustment("p", "user-one", prepared.validationToken)).toMatchObject({ status: "pending", reason: expect.stringContaining("原调用停止事实") });
    expect(database.workflowAdjustmentCurrent("p").version).toEqual(request.base);
    database.closeRuntimeActivity({ ...own, kind: "resident", outcome: "completed" });
    expect(database.publishUserWorkflowAdjustment("p", "user-one", prepare(database).validationToken).status).toBe("applied");
    expect(database.projectState("p").nodeRuns).toEqual(prior);
    expect(database.workflowAdjustments("p")[0].proposal).toEqual(request.proposal);
  });
});

describe("root Main workflow publication consumes the shared journal", () => {
  const publish = (database: CollaborationStateDatabase, main: { semanticInputHash: string }, routeEpoch = 1) =>
    database.rollForwardAcceptedMainWorkflow({ projectId: "p", nodeRunId: "main-node", routeEpoch, semanticInputHash: main.semanticInputHash, sequence: 0 });

  it("rechecks an actually retained native Harness at final Main publication after initial acceptance", async () => {
    const { database, acceptMain, root, options } = await fixture();
    const main = acceptMain("late-main-harness", snapshot => { snapshot.agents.idea.harness = "claude-code"; });
    const original = database.workflowAdjustment("p", main.requestId)!, before = database.workflowAdjustmentCurrent("p");
    database.recordAgentNativeSessionBinding({ projectId: "p", agentId: "idea", invocationId: "original-worker",
      runtimePath: join(root, "runtime", "original-worker"), worktreePath: join(root, "worktrees", "idea"),
      executionContext: { role: "delivery", nodeRunId: "original-worker-node", executionId: "original-execution", ownershipEpoch: 1, executionWorktree: join(root, "worktrees", "idea") },
      session: { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "retained-original-worker", generation: 0, durable: true, createdAt: "2026-10-11T00:00:00.000Z" } });
    const result = publish(database, main);
    console.log(JSON.stringify({ experiment: "late-main-native-harness", status: result.status, revision: result.workflowRevision }));
    expect(result).toMatchObject({ status: "pending", workflowRevision: 1, reason: expect.stringContaining("Harness") });
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
    expect(database.workflowAdjustment("p", main.requestId)!.proposal).toEqual(original.proposal);
    expect(database.latestAgentNativeSessionBinding("p", "idea")!.session.nativeId).toBe("retained-original-worker");
    expect(publish(database, main)).toMatchObject({ status: "pending", workflowRevision: 1, replay: true });
    const writerLease = database.writerLease(); database.close();
    const reopened = CollaborationStateDatabase.open({ ...options, writerLease }); stores.push(reopened);
    expect(publish(reopened, main)).toMatchObject({ status: "pending", workflowRevision: 1, replay: true });
    expect(reopened.workflowAdjustmentCurrent("p")).toEqual(before);
  });

  it("rechecks a native binding written after a user publication token was prepared", async () => {
    const { database, input, root } = await fixture(), request = input("late-user-native-harness"); request.proposal.agents.idea.harness = "claude-code";
    database.submitUserWorkflowAdjustment(request);
    const prepared = database.prepareUserWorkflowAdjustmentPublication("p", request.requestId);
    expect(prepared.ready).toBe(true); if (!prepared.ready) throw new Error("Expected original ready token");
    const before = database.workflowAdjustmentCurrent("p");
    database.recordAgentNativeSessionBinding({ projectId: "p", agentId: "idea", invocationId: "original-after-token",
      runtimePath: join(root, "runtime", "original-after-token"), worktreePath: join(root, "worktrees", "idea"),
      executionContext: { role: "delivery", nodeRunId: "original-worker-node", executionId: "original-execution", ownershipEpoch: 1, executionWorktree: join(root, "worktrees", "idea") },
      session: { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "retained-after-token", generation: 0, durable: true, createdAt: "2026-10-11T00:00:00.000Z" } });
    const result = database.publishUserWorkflowAdjustment("p", request.requestId, prepared.validationToken);
    console.log(JSON.stringify({ experiment: "late-user-native-harness", status: result.status, revision: result.workflowRevision }));
    expect(result).toMatchObject({ status: "pending", workflowRevision: 1, reason: expect.stringContaining("Harness") });
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
    expect(database.workflowAdjustment("p", request.requestId)!.proposal).toEqual(request.proposal);
  });

  it("rechecks S Session bindings when submitting an earlier prepared user request without altering its seed", async () => {
    const { database, input, root } = await fixture(), request = input("prepared-before-saved-session"); request.proposal.agents.idea.harness = "claude-code";
    expect(database.prepareUserWorkflowAdjustment(request).replay).toBe(false);
    const before = database.workflowAdjustmentCurrent("p");
    database.recordAgentNativeSessionBinding({ projectId: "p", agentId: "idea", invocationId: "saved-before-submit",
      runtimePath: join(root, "runtime", "saved-before-submit"), worktreePath: join(root, "worktrees", "idea"),
      executionContext: { role: "delivery", nodeRunId: "original-node", executionId: "original-execution", ownershipEpoch: 1, executionWorktree: join(root, "worktrees", "idea") },
      session: { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "saved-before-submit", generation: 0, durable: true, createdAt: "2026-10-11T00:00:00.000Z" } });
    const original = database.eventsAfter("p", 0, 1000);
    expect(() => database.submitUserWorkflowAdjustment(request)).toThrow(/Harness/);
    expect(database.workflowAdjustments("p")).toEqual([]); expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
    expect(database.eventsAfter("p", 0, 1000)).toEqual(original);
  });

  it("preserves every original native Harness rather than only the newest binding", async () => {
    const { database, acceptMain, root } = await fixture();
    const main = acceptMain("multiple-native-harnesses", snapshot => { snapshot.agents.idea.harness = "claude-code"; });
    const before = database.workflowAdjustmentCurrent("p");
    for (const [index, harnessId] of ["codex", "claude-code"].entries()) database.recordAgentNativeSessionBinding({ projectId: "p", agentId: "idea", invocationId: `retained-${index}`,
      runtimePath: join(root, "runtime", `retained-${index}`), worktreePath: join(root, "worktrees", "idea"),
      executionContext: { role: "leader", nodeRunId: "original-idea-node", routeScopeId: `original-role-${index}`, coordinatorEpoch: 1 },
      session: { schemaVersion: 1, harnessId, adapterVersion: "test", nativeId: `retained-session-${index}`, generation: 0, durable: true, createdAt: "2026-10-11T00:00:00.000Z" } });
    expect(database.latestAgentNativeSessionBinding("p", "idea")!.session.harnessId).toBe("claude-code");
    expect(publish(database, main)).toMatchObject({ status: "pending", workflowRevision: 1, reason: expect.stringContaining("codex") });
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
  });

  it("allows compatible instruction edits while retaining original S Session bindings", async () => {
    const { database, acceptMain, root } = await fixture();
    const main = acceptMain("compatible-native-harness", snapshot => {
      snapshot.agents.idea.harness = "codex"; snapshot.agents.idea.instructions = "Compatible future instructions";
    });
    database.recordAgentNativeSessionBinding({ projectId: "p", agentId: "idea", invocationId: "compatible-original",
      runtimePath: join(root, "runtime", "compatible-original"), worktreePath: join(root, "worktrees", "idea"),
      executionContext: { role: "delivery", nodeRunId: "original-idea-node", executionId: "original-idea", ownershipEpoch: 1, executionWorktree: join(root, "worktrees", "idea") },
      session: { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "compatible-original-session", generation: 0, durable: true, createdAt: "2026-10-11T00:00:00.000Z" } });
    const original = database.latestAgentNativeSessionBinding("p", "idea");
    expect(publish(database, main)).toMatchObject({ status: "applied", workflowRevision: 2 });
    expect(database.workflowAdjustmentCurrent("p").snapshot.agents.idea.instructions).toBe("Compatible future instructions");
    expect(database.latestAgentNativeSessionBinding("p", "idea")).toEqual(original);
  });

  it("requires the affected Main task's exact independent finish and resident close before changing its configuration", async () => {
    const { database, acceptMain } = await fixture(), main = acceptMain("main-config", snapshot => { snapshot.agents.main.instructions += " Future configuration."; });
    const before = database.workflowAdjustmentCurrent("p"), original = database.eventByRequestId("p", main.requestId), nodeBefore = database.projectState("p").nodeRuns[0];
    const activity = { projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "main-native", coordinatorEpoch: 1 };
    database.startRuntimeActivity({ ...activity, kind: "resident", phase: "resident:running" });
    expect(publish(database, main)).toMatchObject({ status: "pending", reason: expect.stringContaining("逻辑节点 main-node") });
    database.appendEvent({ ...activity, type: "main.route.task_completion.committed", payload: { taskId: "wrong-task", inputId: "another-input" } });
    expect(publish(database, main).status).toBe("pending");
    database.appendEvent({ ...activity, type: "main.route.task_completion.committed", payload: { taskId: "own-task", inputId: "original-input" } });
    expect(publish(database, main).status).toBe("pending");
    database.closeRuntimeActivity({ ...activity, kind: "resident", outcome: "completed" });
    expect(publish(database, main)).toMatchObject({ status: "applied", workflowRevision: 2 });
    expect(database.workflowAdjustmentCurrent("p").snapshot.agents.main.instructions).not.toBe(before.snapshot.agents.main.instructions);
    expect(database.eventByRequestId("p", main.requestId)).toEqual(original);
    expect(database.projectState("p").nodeRuns[0]).toEqual(nodeBefore);
  });

  it("does not exempt a different live native invocation of the same Main identity", async () => {
    const { database, acceptMain } = await fixture(), main = acceptMain("shared-main", snapshot => { snapshot.agents.main.instructions += " Changed future instructions."; });
    const own = { projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "main-native", coordinatorEpoch: 1 };
    database.appendEvent({ ...own, type: "main.route.task_completion.committed", payload: { taskId: "own-task", inputId: "original-input" } });
    database.startRuntimeActivity({ ...own, kind: "resident", phase: "resident:running" });
    database.closeRuntimeActivity({ ...own, kind: "resident", outcome: "completed" });
    const other = { ...own, invocationId: "other-original-main" };
    database.appendEvent({ ...other, type: "main.route.attempt", payload: { attempt: 1 } });
    database.startRuntimeActivity({ ...other, kind: "resident", phase: "resident:running" });
    // The public scheduler projection omits the now-outdated invocation;
    // its native close fact is still absent and publication must see it.
    database.appendEvent({ ...own, type: "main.route.attempt", payload: { attempt: 1 } });
    const before = database.workflowAdjustmentCurrent("p");
    expect(database.projectState("p").runtimeActivities).toEqual([]);
    expect(publish(database, main)).toMatchObject({ status: "pending", reason: expect.stringContaining("other-original-main") });
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
    expect(database.projectState("p").runtimeActivities).toEqual([]);
    database.closeRuntimeActivity({ ...other, kind: "resident", outcome: "completed" });
    expect(publish(database, main).status).toBe("applied");
  });

  it("checks Agent definition changes even when the configuration map is unchanged", async () => {
    const { database, acceptMain } = await fixture(), main = acceptMain("main-definition", snapshot => {
      snapshot.orchestration.agents.find(agent => agent.name === "main")!.description = "Changed shared management responsibility";
    });
    const before = database.workflowAdjustmentCurrent("p");
    expect(publish(database, main)).toMatchObject({ status: "pending", reason: expect.stringContaining("逻辑节点 main-node") });
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
  });

  it("does not use another task's completion to excuse a changed root decision plan", async () => {
    const { database, acceptMain } = await fixture(), main = acceptMain("main-route-context", snapshot => {
      snapshot.orchestration.decisionPlans.main = "Changed future routing instructions";
    });
    const wrong = { projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "previous-main", coordinatorEpoch: 1 };
    database.appendEvent({ ...wrong, type: "main.route.task_completion.committed", payload: { taskId: "old-task", inputId: "original-input" } });
    const resident = { ...wrong, invocationId: "main-native" };
    database.startRuntimeActivity({ ...resident, kind: "resident", phase: "resident:running" });
    database.closeRuntimeActivity({ ...resident, kind: "resident", outcome: "completed" });
    expect(publish(database, main)).toMatchObject({ status: "pending", reason: expect.stringContaining("逻辑节点 main-node") });
    expect(database.projectState("p").workflowRevision).toBe(1);
  });

  it("allows a future configuration after the original standalone owner is explicitly stopped and cancelled", async () => {
    const { database, acceptMain, root } = await fixture();
    database.activateNode({ projectId: "p", nodeRunId: "cancelled-original", node: { kind: "agent", nodeId: "idea", agentId: "idea" },
      activationRequestId: "old-arrival", inputSnapshotRef: "old-input", activatedByAgentId: "main", workflowRevision: 1 });
    database.startStandaloneExecution({ projectId: "p", nodeRunId: "cancelled-original", taskId: "old-task", executionId: "old-execution", agentId: "idea",
      assignment: "Original task retained", executionBranch: "executions/old-execution", worktreePath: join(root, "old-worktree"), invocationId: "old-native" });
    const owner = { projectId: "p", nodeRunId: "cancelled-original", executionId: "old-execution", taskId: "old-task", agentId: "idea", ownershipEpoch: 1, invocationId: "old-native" };
    database.startRuntimeActivity({ ...owner, kind: "resident", phase: "resident:running" });
    database.requestExecutionStop({ projectId: "p", executionId: "old-execution", ownershipEpoch: 1, reason: "Actual explicit cancellation" });
    database.confirmExecutionStopped({ projectId: "p", executionId: "old-execution", ownershipEpoch: 1, stopped: true, evidence: { controlledSupervisorStop: true } });
    database.cancelStandaloneNode({ projectId: "p", nodeRunId: "cancelled-original", reason: "Actual explicit node cancellation" });
    const main = acceptMain("after-cancellation"), before = database.projectState("p");
    expect(publish(database, main)).toMatchObject({ status: "applied", workflowRevision: 2 });
    const after = database.projectState("p");
    expect(after.tasks).toEqual(before.tasks); expect(after.executions).toEqual(before.executions);
    expect(after.nodeRuns.find(node => node.id === "cancelled-original")).toEqual(before.nodeRuns.find(node => node.id === "cancelled-original"));
    expect(after.runtimeActivities).toEqual([]);
  });

  it("accepts the real tool receipt and immutable queue snapshot atomically", async () => {
    const { database, acceptMain } = await fixture(); const before = database.workflowAdjustmentCurrent("p");
    const main = acceptMain(), record = database.workflowAdjustments("p")[0];
    expect(record).toMatchObject({ requestId: main.requestId, status: "pending", base: before.version, baseSnapshot: before.snapshot,
      source: { kind: "main", callId: "main-apply", invocationId: "main-native" } });
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
    expect(database.registerAcceptedMainWorkflowAdjustment("p", main.requestId)).toMatchObject({ replay: true, record });
    const events = database.eventsAfter("p", 0, 100);
    expect(events.findIndex(event => event.type === "workflow.adjustment.submitted"))
      .toBe(events.findIndex(event => event.type === "main.route_action.accepted") + 1);
  });

  it("rolls back the accepted tool receipt if its queue snapshot cannot persist", async () => {
    const { database, acceptMain, options } = await fixture(), before = database.workflowAdjustmentCurrent("p");
    const raw = new DatabaseSync(options.databasePath);
    raw.exec(`CREATE TRIGGER fixture_reject_main_journal BEFORE INSERT ON project_events
      WHEN NEW.event_type = 'workflow.adjustment.submitted' BEGIN SELECT RAISE(ABORT, 'fixture journal failure'); END;`); raw.close();
    expect(() => acceptMain()).toThrow("fixture journal failure");
    expect(database.eventsAfter("p", 0, 100).filter(event => event.type === "main.route_action.accepted")).toEqual([]);
    expect(database.workflowAdjustments("p")).toEqual([]); expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
  });

  it("never publishes a withdrawn accepted proposal or rewrites its finish/tool facts", async () => {
    const { database, acceptMain } = await fixture(), before = database.workflowAdjustmentCurrent("p"), main = acceptMain();
    const accepted = database.eventByRequestId("p", main.requestId)!;
    const finish = database.appendEvent({ projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "main-native", coordinatorEpoch: 1,
      requestId: "original-finish", type: "main.route.task_completion.committed", payload: { taskId: "original-task", summary: "Main-authored memory" } }).event;
    database.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "withdraw" });
    const events = database.eventsAfter("p", 0, 100);
    expect(publish(database, main)).toMatchObject({ requestId: main.requestId, status: "withdrawn", workflowRevision: 1, replay: true });
    expect(publish(database, main).appliedVersion).toBeUndefined();
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before); expect(database.eventsAfter("p", 0, 100)).toEqual(events);
    expect(database.eventByRequestId("p", main.requestId)).toEqual(accepted); expect(database.eventByRequestId("p", "original-finish")).toEqual(finish);
  });

  it("returns the actual accepted version if publication wins the withdrawal race", async () => {
    const { database, acceptMain, clock } = await fixture(), main = acceptMain(); clock.now += 2000;
    const result = publish(database, main), current = database.workflowAdjustmentCurrent("p");
    expect(result).toMatchObject({ status: "applied", workflowRevision: 2, currentVersion: current.version, appliedVersion: current.version, replay: false });
    expect(current.snapshot.agents.idea.instructions).toBe("Actual Main proposal content");
    const withdrawal = database.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "too-late" });
    expect(withdrawal).toMatchObject({ withdrawn: false, record: { status: "applied" } });
    expect(withdrawal.record.history.at(-1)).toMatchObject({ status: "applied", at: new Date(clock.now).toISOString(), appliedVersion: current.version });
    const events = database.eventsAfter("p", 0, 100);
    expect(publish(database, main)).toMatchObject({ status: "applied", replay: true, appliedVersion: current.version });
    expect(database.eventsAfter("p", 0, 100)).toEqual(events);
  });

  it("rolls back the complete workflow/configuration publication when its applied transition fails", async () => {
    const { database, acceptMain, options } = await fixture(), main = acceptMain();
    const before = database.workflowAdjustmentCurrent("p"), events = database.eventsAfter("p", 0, 100), revision = database.projectState("p").revision;
    const raw = new DatabaseSync(options.databasePath);
    raw.exec(`CREATE TRIGGER fixture_reject_applied BEFORE INSERT ON project_events
      WHEN NEW.event_type = 'workflow.adjustment.transitioned' AND json_extract(NEW.payload_json, '$.transition.status') = 'applied'
      BEGIN SELECT RAISE(ABORT, 'fixture applied failure'); END;`); raw.close();
    expect(() => publish(database, main)).toThrow("fixture applied failure");
    expect(database.workflowAdjustmentCurrent("p")).toEqual(before); expect(database.eventsAfter("p", 0, 100)).toEqual(events);
    expect(database.projectState("p").revision).toBe(revision); expect(database.workflowAdjustments("p")[0].status).toBe("pending");
  });

  it.each(["user-first", "main-first"] as const)("gives a same-base conflicting user request priority (%s) without applying either snapshot", async order => {
    const { database, input, acceptMain } = await fixture();
    if (order === "user-first") database.submitUserWorkflowAdjustment(input());
    const main = acceptMain(); if (order === "main-first") database.submitUserWorkflowAdjustment(input());
    const before = database.workflowAdjustmentCurrent("p"), accepted = database.eventByRequestId("p", main.requestId);
    expect(publish(database, main)).toMatchObject({ status: "pending", workflowRevision: 1, reason: expect.stringContaining("user-one") });
    expect(database.workflowAdjustments("p").every(record => record.status === "pending")).toBe(true);
    const events = database.eventsAfter("p", 0, 100); publish(database, main);
    expect(database.eventsAfter("p", 0, 100)).toEqual(events); expect(database.workflowAdjustmentCurrent("p")).toEqual(before);
    expect(database.eventByRequestId("p", main.requestId)).toEqual(accepted);
    database.withdrawWorkflowAdjustment({ projectId: "p", requestId: "user-one", operationId: "withdraw-user" });
    expect(publish(database, main).status).toBe("applied");
    expect(database.workflowAdjustments("p").find(record => record.requestId === "user-one")?.status).toBe("withdrawn");
  });

  it("does not give an unrelated field a false priority lock and records the old full user snapshot as stale", async () => {
    const { database, input, acceptMain } = await fixture(); database.submitUserWorkflowAdjustment(input());
    const main = acceptMain("different-field", proposal => { proposal.agents.idea.model = "different-model"; });
    const user = database.workflowAdjustments("p").find(record => record.source.kind === "user")!;
    expect(publish(database, main).status).toBe("applied");
    const stale = database.workflowAdjustments("p").find(record => record.source.kind === "user")!;
    expect(stale).toMatchObject({ status: "needs_resubmission", proposal: user.proposal, base: user.base, waitingReason: WORKFLOW_ADJUSTMENT_STALE_MESSAGE });
    expect(stale.history.at(-1)?.status).toBe("needs_resubmission");
    expect(database.workflowAdjustmentCurrent("p").snapshot.agents.idea.instructions).toBe(user.baseSnapshot.agents.idea.instructions);
  });

  it.each(["configuration-only", "same-graph-new-revision"] as const)("never mistakes another accepted version for this proposal's publication (%s)", async change => {
    const { database, acceptMain } = await fixture(), main = acceptMain(), original = database.workflowAdjustments("p")[0];
    const current = database.workflowAdjustmentCurrent("p");
    if (change === "configuration-only") {
      const { orchestration: _graph, ...configuration } = structuredClone(current.snapshot); configuration.agents.idea.instructions = "Another actual version";
      database.appendEvent({ projectId: "p", type: "scoped.configuration.applied", payload: { configuration } });
    } else database.saveWorkflowRevision({ projectId: "p", workflowRevision: 2, snapshot: current.snapshot.orchestration, affectedGroupIds: [], requestId: "other-version" });
    const changed = database.workflowAdjustmentCurrent("p");
    expect(publish(database, main)).toMatchObject({ status: "needs_resubmission", currentVersion: changed.version, reason: WORKFLOW_ADJUSTMENT_STALE_MESSAGE });
    expect(publish(database, main).appliedVersion).toBeUndefined(); expect(database.workflowAdjustmentCurrent("p")).toEqual(changed);
    const stale = database.workflowAdjustments("p")[0]; expect(stale.proposal).toEqual(original.proposal); expect(stale.base).toEqual(original.base);
    expect(stale.history.at(-1)?.status).toBe("needs_resubmission");
    expect(database.eventsAfter("p", 0, 100).filter(event => event.requestId?.startsWith("accepted-main-workflow-"))).toEqual([]);
  });

  it("restores exact withdrawal and applied outcomes after real SQLite writer restart", async () => {
    const { database, options, clock, acceptMain } = await fixture(), main = acceptMain(); publish(database, main);
    const applied = database.workflowAdjustments("p")[0], before = database.workflowAdjustmentCurrent("p");
    database.close(); clock.now += 30_001;
    const restarted = CollaborationStateDatabase.open({ ...options, instanceId: "restart" }); stores.push(restarted);
    expect(publish(restarted, main)).toMatchObject({ status: "applied", replay: true, appliedVersion: before.version });
    expect(restarted.workflowAdjustments("p")[0]).toEqual(applied);
    expect(restarted.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "late-withdraw" }).withdrawn).toBe(false);
  });

  it("compares individual graph identities and changed fields without conflating unrelated nodes", async () => {
    const { database, input } = await fixture(), submitted = database.submitUserWorkflowAdjustment(input()).record;
    const base = submitted.baseSnapshot, left = structuredClone(submitted), right = structuredClone(submitted);
    left.proposal = structuredClone(base); right.proposal = structuredClone(base);
    left.proposal.orchestration.agents[0].label += " left";
    right.proposal.orchestration.agents[1].label += " right";
    expect(workflowAdjustmentsConflict(left, right)).toBe(false);
    right.proposal.orchestration.agents[0].label += " conflict";
    expect(workflowAdjustmentsConflict(left, right)).toBe(true);
  });
  it("serializes actual competing publication and withdrawal processes into one truthful terminal state", async () => {
    const { database, options, root, acceptMain } = await fixture(), main = acceptMain();
    const worker = join(root, "race.mjs"), config = join(root, "race.json");
    await writeFile(config, JSON.stringify({ options: { ...options, now: undefined, writerLease: database.writerLease() }, main }));
    await writeFile(worker, `import { readFileSync } from "node:fs";
import { CollaborationStateDatabase } from ${JSON.stringify(new URL("../src/collaboration-state/store.ts", import.meta.url).href)};
const { options, main } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const database = CollaborationStateDatabase.open({ ...options, now: () => 1000000 });
process.stdout.write("ready\\n"); await new Promise(resolve => process.stdin.once("data", resolve));
try { const result = process.argv[3] === "publish" ? database.rollForwardAcceptedMainWorkflow({ projectId: "p", nodeRunId: "main-node", routeEpoch: 1,
  semanticInputHash: main.semanticInputHash, sequence: 0 }) : database.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "race" });
  process.stdout.write(JSON.stringify(result)); } finally { database.close(); }
`);
    const [publication, withdrawal] = await concurrentWorkflowWorkers(worker, config, ["publish", "withdraw"]);
    const terminal = database.workflowAdjustments("p")[0];
    expect(["applied", "withdrawn"]).toContain(terminal.status); expect(publication.status).toBe(terminal.status);
    expect(withdrawal.withdrawn).toBe(terminal.status === "withdrawn"); expect(withdrawal.record.status).toBe(terminal.status);
    expect(database.projectState("p").workflowRevision).toBe(terminal.status === "applied" ? 2 : 1);
    expect(terminal.history.filter(transition => ["applied", "withdrawn"].includes(transition.status))).toHaveLength(1);
    expect(database.verifyHealth().integrity).toBe("ok");
  });

  it.each(["pending", "withdrawn", "applied"] as const)("allows a workflow projection success receipt only after real application (%s)", async status => {
    const { database, acceptMain } = await fixture(), main = acceptMain();
    if (status === "withdrawn") database.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "withdraw" });
    if (status === "applied") publish(database, main);
    const receipt = () => database.recordAcceptedMainControlEffect({ projectId: "p", nodeRunId: "main-node", routeEpoch: 1,
      semanticInputHash: main.semanticInputHash, sequence: 0, effect: "workflow_projection" });
    if (status !== "applied") {
      const events = database.eventsAfter("p", 0, 100); expect(receipt).toThrow(/actual accepted configuration version/);
      expect(database.eventsAfter("p", 0, 100)).toEqual(events);
    } else { expect(receipt().event.type).toBe("main.workflow_projection.committed"); expect(receipt().replay).toBe(true); }
  });

  it("recognizes an exact legacy publication from its immutable receipt and original base even after a later version", async () => {
    const source = await fixture(), main = source.acceptMain();
    const original = source.database.eventByRequestId("p", main.requestId)!;
    const proposal = original.payload.workflowProposal as NonNullable<AcceptedMainRouteAction["workflowProposal"]>;
    const { database, clock } = await fixture();
    database.activateNode({ projectId: "p", nodeRunId: "main-node", node: { kind: "agent", nodeId: "main", agentId: "main" },
      activationRequestId: "main-activation", inputSnapshotRef: "original-input", activatedByAgentId: "main", workflowRevision: 1 });
    database.appendEvent({ projectId: "p", nodeRunId: "main-node", agentId: "main", invocationId: "main-native", coordinatorEpoch: 1,
      type: "main.route.attempt", payload: { attempt: 1 } });
    // Isolated fixture represents the earlier service's immutable accepted and
    // published facts; it does not delete or amend any event to create them.
    const accepted = database.appendEvent({ ...original, eventId: "historical-accepted-main" }).event;
    database.saveWorkflowRevision({ projectId: "p", workflowRevision: 2, snapshot: proposal.orchestration, affectedGroupIds: [], requestId: "historical-version" });
    database.appendEvent({ projectId: "p", workflowRevision: 2, type: "scoped.configuration.applied", payload: { configuration: proposal.configuration } });
    clock.now += 500;
    const publication = database.appendEvent({ projectId: "p", workflowRevision: 2, type: "workflow.revision.created", payload: {
      acceptedSemanticInputHash: main.semanticInputHash, acceptedSequence: 0, proposalHash: proposal.proposalHash, prestateWorkflowRevision: 1 } }).event;
    const published = database.workflowAdjustmentCurrent("p").version;
    const next = structuredClone(proposal.orchestration); next.decisionPlans.main = "A later unrelated formal version";
    database.saveWorkflowRevision({ projectId: "p", workflowRevision: 3, snapshot: next, affectedGroupIds: [], requestId: "later-version" });
    expect(database.workflowAdjustments("p")).toEqual([]);
    expect(publish(database, main)).toMatchObject({ status: "applied", workflowRevision: 3, appliedVersion: published, replay: true });
    const record = database.workflowAdjustments("p")[0];
    expect(record.base.revision).toBe(1); expect(record.baseSnapshot.agents.idea.instructions).not.toBe(proposal.configuration!.agents.idea.instructions);
    expect(record.history.at(-1)).toMatchObject({ status: "applied", at: publication.ts, appliedVersion: published });
    expect(database.eventByRequestId("p", main.requestId)).toEqual(accepted);
    expect(database.withdrawWorkflowAdjustment({ projectId: "p", requestId: main.requestId, operationId: "late" }).withdrawn).toBe(false);
  });

  it("reads one complete request and only the active queue without decoding archived large proposals", async () => {
    const f = await fixture(false), marker = "immutable-archive-", startedAt = performance.now();
    for (let i = 0; i < 80; i++) {
      const request = f.input(`${marker}${i}`);
      request.proposal.agents.idea.instructions = `${marker}${i}\n${"完整历史科学说明".repeat(1800)}`;
      f.database.submitUserWorkflowAdjustment(request);
      f.database.withdrawWorkflowAdjustment({ projectId: "p", requestId: request.requestId, operationId: `withdraw-${i}` });
    }
    const request = f.input("active-user"); f.database.submitUserWorkflowAdjustment(request);
    const all = f.database.workflowAdjustments("p"), before = f.database.projectState("p");
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(f.database.workflowAdjustment("p", `${marker}37`)).toEqual(all[37]);
      expect(parse.mock.calls.filter(([raw]) => raw.includes(marker) && raw.includes('"submission":'))).toHaveLength(1);
      parse.mockClear();
      const active = f.database.activeWorkflowAdjustments("p", undefined, "user");
      expect(active).toEqual([all[80]]);
      expect(parse.mock.calls.filter(([raw]) => raw.includes(marker) && raw.includes('"submission":'))).toHaveLength(0);
      const next = { ...f.input("active-next"), replacesRequestId: request.requestId };
      f.database.submitUserWorkflowAdjustment(next);
      expect(parse.mock.calls.filter(([raw]) => raw.includes(marker) && raw.includes('"submission":'))).toHaveLength(0);
      active[0]!.proposal.agents.idea.instructions = "Caller mutation";
      expect(f.database.workflowAdjustment("p", request.requestId)).toMatchObject({ status: "replaced", proposal: request.proposal });
    } finally { parse.mockRestore(); }
    expect(before.workflowRevision).toBe(f.database.projectState("p").workflowRevision);
    expect(f.database.workflowAdjustments("p").slice(0, 80)).toEqual(all.slice(0, 80));
    console.info(JSON.stringify({ experiment: "indexed-workflow-adjustment-history", archivedRequests: 80,
      archivedInstructionUtf8Bytes: Buffer.byteLength(all[37]!.proposal.agents.idea.instructions),
      elapsedMs: Math.round(performance.now() - startedAt), completeArchivedPayloadsDecodedBySingleRead: 1,
      completeArchivedPayloadsDecodedByActiveReadAndReplacement: 0 }));
  }, 60_000);

  it("does not retain a rolled-back submission when its event sequence is reused", async () => {
    const f = await fixture(), before = f.database.projectState("p"), events = f.database.eventsAfter("p", 0, 1000);
    const raw = new DatabaseSync(f.options.databasePath);
    raw.exec("CREATE TRIGGER fail_adjustment_head BEFORE UPDATE OF revision ON project_heads BEGIN SELECT RAISE(ABORT, 'injected head update failure'); END");
    try {
      expect(() => f.database.submitUserWorkflowAdjustment(f.input("rolled-back"))).toThrow("injected head update failure");
      expect(f.database.workflowAdjustment("p", "rolled-back")).toBeUndefined();
      expect(f.database.activeWorkflowAdjustments("p")).toEqual([]);
      expect(f.database.projectState("p")).toEqual(before);
      expect(f.database.eventsAfter("p", 0, 1000)).toEqual(events);
      raw.exec("DROP TRIGGER fail_adjustment_head");
      const request = f.input("replacement-at-same-seq"), result = f.database.submitUserWorkflowAdjustment(request);
      expect(result.record).toEqual(f.database.workflowAdjustment("p", request.requestId));
      expect(f.database.eventsAfter("p", events.at(-1)!.seq, 1000)).toHaveLength(1);
      expect(f.database.workflowAdjustment("p", "rolled-back")).toBeUndefined();
      expect(f.database.activeWorkflowAdjustments("p")).toEqual([result.record]);
    } finally { raw.close(); }
  });

  it("observes withdrawal and replacement from another writer connection without leaking caller mutations", async () => {
    const f = await fixture(), request = f.input(); f.database.submitUserWorkflowAdjustment(request);
    const another = CollaborationStateDatabase.open({ ...f.options, writerLease: f.database.writerLease() }); stores.push(another);
    const read = f.database.workflowAdjustment("p", request.requestId)!;
    read.history[0]!.status = "applied"; read.proposal.agents.idea.instructions = "Changed caller copy";
    another.withdrawWorkflowAdjustment({ projectId: "p", requestId: request.requestId, operationId: "another-withdraw" });
    expect(f.database.activeWorkflowAdjustments("p")).toEqual([]);
    expect(f.database.workflowAdjustment("p", request.requestId)).toEqual(another.workflowAdjustments("p")[0]);
    expect(f.database.submitUserWorkflowAdjustment(request)).toMatchObject({ replay: true, record: { status: "withdrawn", proposal: request.proposal } });
    const second = another.submitUserWorkflowAdjustment(f.input("second"));
    expect(f.database.activeWorkflowAdjustments("p", undefined, "user")).toEqual([second.record]);
  });

  it("uses metadata indexes for latest status and exact request transitions", async () => {
    const f = await fixture(); f.database.submitUserWorkflowAdjustment(f.input());
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    let activeSql: string, detailSql: string;
    try {
      f.database.activeWorkflowAdjustments("p", undefined, "user");
      activeSql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.includes("FROM project_events AS s INDEXED BY"))!;
      detailSql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.includes("SELECT * FROM project_events INDEXED BY workflow_adjustment_transitions"))!;
    } finally { prepare.mockRestore(); }
    expect(activeSql!).toBeTruthy(); expect(detailSql!).toBeTruthy();
    const raw = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      const activePlan = JSON.stringify(raw.prepare(`EXPLAIN QUERY PLAN ${activeSql!}`).all("p", "user"));
      expect(activePlan).toContain("SEARCH s USING INDEX workflow_adjustment_submissions");
      expect(activePlan).toContain("SEARCH t USING INDEX workflow_adjustment_transitions");
      expect(JSON.stringify(raw.prepare(`EXPLAIN QUERY PLAN ${detailSql!}`).all("p", "user-one")))
        .toContain("SEARCH project_events USING INDEX workflow_adjustment_transitions");
    } finally { raw.close(); }
  });

  it("migrates v19 journal indexes without rewriting any complete request, head or configuration", async () => {
    const f = await fixture(); f.database.submitUserWorkflowAdjustment(f.input());
    f.database.recordWorkflowAdjustmentWaiting({ projectId: "p", requestId: "user-one", reason: "Original waiting reason" });
    const expected = f.database.workflowAdjustments("p"); f.database.close();
    const raw = new DatabaseSync(f.options.databasePath);
    const tables = ["project_events", "project_heads", "workflow_revisions", "node_runs", "work_tasks"];
    const before = tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    raw.exec("DROP INDEX workflow_adjustment_submissions; DROP INDEX workflow_adjustment_transitions; DROP INDEX IF EXISTS workflow_adjustment_summary; DROP INDEX IF EXISTS workflow_native_session_harness; UPDATE collaboration_state_meta SET schema_version = 19");
    raw.close();
    f.clock.now += 30_001;
    const reopened = CollaborationStateDatabase.open({ ...f.options, instanceId: "index-migration-writer" }); stores.push(reopened);
    expect(reopened.workflowAdjustment("p", "user-one")).toEqual(expected[0]);
    expect(reopened.activeWorkflowAdjustments("p")).toEqual(expected);
    const inspect = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: COLLABORATION_STATE_SCHEMA_VERSION });
      expect(tables.map(table => inspect.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
      expect(inspect.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(inspect.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally { inspect.close(); }
  });

  it("rolls back the entire v19 index migration when an index cannot be created", async () => {
    const f = await fixture(); f.database.submitUserWorkflowAdjustment(f.input()); f.database.close();
    const raw = new DatabaseSync(f.options.databasePath);
    const events = raw.prepare("SELECT * FROM project_events ORDER BY seq").all();
    raw.exec("DROP INDEX workflow_adjustment_submissions; DROP INDEX workflow_adjustment_transitions; DROP INDEX IF EXISTS workflow_adjustment_summary; DROP INDEX IF EXISTS workflow_native_session_harness; UPDATE collaboration_state_meta SET schema_version = 19; CREATE TABLE workflow_adjustment_transitions (failure TEXT)");
    raw.close();
    f.clock.now += 30_001;
    expect(() => CollaborationStateDatabase.open({ ...f.options, instanceId: "failed-index-migration-writer" })).toThrow(/table|index/i);
    const inspect = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: 19 });
      expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name = 'workflow_adjustment_submissions'").all()).toEqual([]);
      expect(inspect.prepare("SELECT * FROM project_events ORDER BY seq").all()).toEqual(events);
    } finally { inspect.close(); }
  });

  it("does not migrate v19 under another unexpired writer lease", async () => {
    const f = await fixture(), raw = new DatabaseSync(f.options.databasePath);
    try {
      raw.exec("DROP INDEX workflow_adjustment_submissions; DROP INDEX workflow_adjustment_transitions; DROP INDEX IF EXISTS workflow_adjustment_summary; DROP INDEX IF EXISTS workflow_native_session_harness; UPDATE collaboration_state_meta SET schema_version = 19");
      expect(() => CollaborationStateDatabase.open({ ...f.options, instanceId: "foreign-writer" })).toThrow(/lease|writer/i);
      expect(raw.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: 19 });
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'workflow_adjustment_%'").all()).toEqual([]);
    } finally { raw.close(); }
  });

  it("checks immutable snapshot integrity on a targeted read as well as a full history read", async () => {
    const f = await fixture(), requestId = "corrupt-target", input = f.input(requestId);
    f.database.appendEvent({ projectId: "p", requestId: `workflow-adjustment-submission:${hash(requestId)}`,
      type: "workflow.adjustment.submitted", payload: { protocol: "workflow-adjustment-v1", snapshotHash: "wrong",
        submission: { ...input, source: { kind: "user" }, submittedAt: "original-time", baseSnapshot: f.database.workflowAdjustmentCurrent("p").snapshot, changes: [] } } });
    expect(() => f.database.workflowAdjustment("p", requestId)).toThrow(/snapshot is inconsistent/);
    expect(() => f.database.activeWorkflowAdjustments("p")).toThrow(/snapshot is inconsistent/);
    expect(() => f.database.workflowAdjustments("p")).toThrow(/snapshot is inconsistent/);
  });

  it("matches an unchanged complete journal without decoding any archived proposal and invalidates changed facts", async () => {
    const f = await fixture(), request = f.input("conditional-archived");
    request.proposal.agents.idea.instructions = "archive-must-not-be-decoded".repeat(600);
    f.database.submitUserWorkflowAdjustment(request);
    f.database.withdrawWorkflowAdjustment({ projectId: "p", requestId: request.requestId, operationId: "conditional-withdraw" });
    const first = f.database.workflowAdjustmentQuery("p"), before = f.database.projectState("p");
    expect(first.context).toEqual(f.database.workflowAdjustmentContext("p"));
    const parse = vi.spyOn(JSON, "parse");
    try {
      f.database.appendEvent({ projectId: "p", type: "unrelated.workflow.query.fixture", payload: { note: "Keep original query valid" } });
      expect(f.database.workflowAdjustmentQuery("p", undefined, first.etag)).toEqual({ etag: first.etag });
      expect(f.database.workflowAdjustmentQuery("p", undefined, `"foreign", W/${first.etag}`)).toEqual({ etag: first.etag });
      expect(parse.mock.calls.filter(([raw]) => raw.includes("archive-must-not-be-decoded"))).toHaveLength(0);
    } finally { parse.mockRestore(); }
    const next = f.database.submitUserWorkflowAdjustment(f.input("conditional-new"));
    const changed = f.database.workflowAdjustmentQuery("p", undefined, first.etag);
    expect(changed.etag).not.toBe(first.etag); expect(changed.context?.records).toEqual([first.context!.records[0], next.record]);
    f.database.recordWorkflowAdjustmentWaiting({ projectId: "p", requestId: next.record.requestId, reason: "Actual new waiting reason" });
    const waiting = f.database.workflowAdjustmentQuery("p", undefined, changed.etag);
    expect(waiting.context?.records[1].waitingReason).toBe("Actual new waiting reason");
    expect(waiting.etag).not.toBe(changed.etag);
    const constraints = { agentHarnesses: { idea: { harnessId: "codex", reason: "Original bound Harness" } } };
    const bound = f.database.workflowAdjustmentQuery("p", undefined, waiting.etag, constraints);
    expect(bound.etag).not.toBe(waiting.etag); expect(bound.context?.constraints).toEqual(constraints);
    expect(f.database.workflowAdjustmentQuery("p", undefined, bound.etag, constraints)).toEqual({ etag: bound.etag });
    expect(f.database.projectState("p").workflowRevision).toBe(before.workflowRevision);
  });

  it("pages only metadata for large immutable proposals and reads a selected full record exactly", async () => {
    const f = await fixture(), original = [];
    for (let i = 0; i < 80; i++) {
      const request = f.input(`paged-${i}`); request.proposal.agents.idea.instructions = `paged-full-instructions-${i}:` + "完整不可变历史".repeat(1800);
      f.database.submitUserWorkflowAdjustment(request);
      f.database.withdrawWorkflowAdjustment({ projectId: "p", requestId: request.requestId, operationId: `paged-withdraw-${i}` });
      original.push(f.database.workflowAdjustment("p", request.requestId)!);
    }
    const before = f.database.projectState("p"), parse = vi.spyOn(JSON, "parse");
    let first: NonNullable<ReturnType<typeof f.database.workflowAdjustmentPage>["page"]>;
    const ids: string[] = [];
    try {
      first = f.database.workflowAdjustmentPage("p", { limit: 17 }).page!;
      expect(first.current).toBeDefined(); expect(first.total).toBe(80); expect(first.records).toHaveLength(17);
      let page = first;
      while (true) {
        for (const summary of page.records) {
          const full = original.find(record => record.requestId === summary.requestId)!;
          expect(summary).toMatchObject({ requestId: full.requestId, source: full.source, base: full.base, currentVersion: full.currentVersion,
            status: full.status, changeCount: full.changes.length, submittedAt: full.submittedAt });
          expect(summary).not.toHaveProperty("proposal"); expect(summary).not.toHaveProperty("baseSnapshot");
          ids.push(summary.requestId);
        }
        if (!page.nextBefore) break;
        page = f.database.workflowAdjustmentPage("p", { limit: 17, before: page.nextBefore, expectedVersion: first.journalVersion }).page!;
        expect(page.current).toBeUndefined(); expect(page.journalVersion).toBe(first.journalVersion);
      }
      expect(parse.mock.calls.filter(([raw]) => raw.includes("paged-full-instructions-"))).toHaveLength(0);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(30_000);
    } finally { parse.mockRestore(); }
    expect(ids).toEqual(original.map(record => record.requestId).reverse()); expect(new Set(ids).size).toBe(80);
    expect(f.database.workflowAdjustmentDetail("p", "paged-37", first!.journalVersion).record).toEqual(original[37]);
    expect(f.database.workflowAdjustments("p")).toEqual(original); expect(f.database.projectState("p")).toEqual(before);
  }, 60_000);

  it("keeps the user's active request and an exact operation visible outside the current history page", async () => {
    const f = await fixture(); f.database.submitUserWorkflowAdjustment(f.input("old-active-user"));
    const main = f.acceptMain(); f.database.registerAcceptedMainWorkflowAdjustment("p", main.requestId);
    const page = f.database.workflowAdjustmentPage("p", { limit: 1, watchRequestId: "old-active-user" }).page!;
    expect(page.records[0].requestId).toBe(main.requestId); expect(page.userRequest?.requestId).toBe("old-active-user");
    expect(page.operationRecord).toEqual(page.userRequest);
    f.database.withdrawWorkflowAdjustment({ projectId: "p", requestId: "old-active-user", operationId: "watch-withdraw" });
    const terminal = f.database.workflowAdjustmentPage("p", { limit: 1, watchRequestId: "old-active-user" }).page!;
    expect(terminal.userRequest).toBeNull(); expect(terminal.operationRecord?.status).toBe("withdrawn");
    expect(f.database.workflowAdjustmentPage("p", { watchRequestId: "not-submitted" }).page!.operationRecord).toBeNull();
  });

  it("rejects stale page/detail anchors after new journal facts and projects formal changes without rebasing", async () => {
    const f = await fixture(), input = f.input(); f.database.submitUserWorkflowAdjustment(input);
    const first = f.database.workflowAdjustmentPage("p", { limit: 1 }).page!;
    f.database.recordWorkflowAdjustmentWaiting({ projectId: "p", requestId: input.requestId, reason: "New actual waiting fact" });
    expect(() => f.database.workflowAdjustmentPage("p", { before: first.records[0].submissionSequence, expectedVersion: first.journalVersion })).toThrow(/读取期间已有更新/);
    expect(() => f.database.workflowAdjustmentDetail("p", input.requestId, first.journalVersion)).toThrow(/读取期间已有更新/);
    const { orchestration: _graph, ...configuration } = structuredClone(f.database.workflowAdjustmentCurrent("p").snapshot);
    configuration.agents.idea.instructions = "Actual new formal authority";
    f.database.appendEvent({ projectId: "p", type: "scoped.configuration.applied", payload: { configuration } });
    const before = f.database.projectState("p"), page = f.database.workflowAdjustmentPage("p").page!;
    expect(page.records[0]).toMatchObject({ status: "needs_resubmission", base: input.base, waitingReason: WORKFLOW_ADJUSTMENT_STALE_MESSAGE });
    expect(page.userRequest).toEqual(page.records[0]);
    expect(f.database.workflowAdjustmentDetail("p", input.requestId, page.journalVersion).record).toMatchObject({ base: input.base, proposal: input.proposal });
    expect(f.database.projectState("p")).toEqual(before);
    expect(() => f.database.workflowAdjustmentPage("p", { before: 10 })).toThrow(/missing journal version/);
  });

  it("uses the ordered covering metadata index without sorting or loading proposal payload columns", async () => {
    const f = await fixture(); f.database.submitUserWorkflowAdjustment(f.input());
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"); let summarySql: string, pageSql: string;
    try {
      f.database.workflowAdjustmentPage("p");
      summarySql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.includes("AS source_json"))!;
      pageSql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.includes("SELECT seq FROM project_events INDEXED BY workflow_adjustment_summary"))!;
    } finally { prepare.mockRestore(); }
    const raw = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      const seq = f.database.workflowAdjustmentPage("p").page!.records[0].submissionSequence;
      const plan = JSON.stringify(raw.prepare(`EXPLAIN QUERY PLAN ${pageSql!}`).all("p", 26));
      expect(plan).toContain("workflow_adjustment_summary"); expect(plan).not.toContain("TEMP B-TREE");
      const tableRoot = raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'project_events'").get()!.rootpage;
      const program = raw.prepare(`EXPLAIN ${summarySql!}`).all("p", seq) as Array<Record<string, unknown>>;
      const tableCursors = program.filter(row => row.opcode === "OpenRead" && row.p2 === tableRoot).map(row => row.p1);
      expect(program.some(row => row.opcode === "Column" && tableCursors.includes(row.p1))).toBe(false);
    } finally { raw.close(); }
  });

  it("upgrades v20 browsing indexes without changing original project, task, session or journal bytes", async () => {
    const f = await fixture(); f.database.submitUserWorkflowAdjustment(f.input()); const expected = f.database.workflowAdjustments("p");
    f.database.close(); const raw = new DatabaseSync(f.options.databasePath);
    const tables = ["project_heads", "project_events", "workflow_revisions", "work_tasks", "member_executions"];
    const before = tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    raw.exec("DROP INDEX workflow_adjustment_summary; DROP INDEX IF EXISTS workflow_native_session_harness; UPDATE collaboration_state_meta SET schema_version = 20"); raw.close();
    f.clock.now += 30_001;
    const reopened = CollaborationStateDatabase.open({ ...f.options, instanceId: "paged-index-writer" }); stores.push(reopened);
    expect(reopened.workflowAdjustments("p")).toEqual(expected); expect(reopened.workflowAdjustmentPage("p").page!.records[0].requestId).toBe(expected[0].requestId);
    const inspect = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: COLLABORATION_STATE_SCHEMA_VERSION });
      expect(tables.map(table => inspect.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
      expect(inspect.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(inspect.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { inspect.close(); }
  });

  it("rolls back a failed v20 browsing-index migration and rejects a foreign unexpired writer", async () => {
    const f = await fixture(), raw = new DatabaseSync(f.options.databasePath);
    raw.exec("DROP INDEX workflow_adjustment_summary; DROP INDEX IF EXISTS workflow_native_session_harness; UPDATE collaboration_state_meta SET schema_version = 20");
    expect(() => CollaborationStateDatabase.open({ ...f.options, instanceId: "foreign-page-writer" })).toThrow(/writer|lease/i);
    expect(raw.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: 20 });
    f.database.close(); f.clock.now += 30_001; raw.exec("CREATE TABLE workflow_adjustment_summary (failure TEXT)");
    try {
      expect(() => CollaborationStateDatabase.open({ ...f.options, instanceId: "failed-page-writer" })).toThrow(/table|index/i);
      expect(raw.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: 20 });
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workflow_adjustment_summary'").all()).toEqual([]);
    } finally { raw.close(); }
  });

  it("upgrades v21 with an indexed native Harness guard while preserving all original Session and request bytes", async () => {
    const f = await fixture(), request = f.input("v21-retained-harness"); request.proposal.agents.idea.harness = "claude-code";
    f.database.submitUserWorkflowAdjustment(request);
    f.database.recordAgentNativeSessionBinding({ projectId: "p", agentId: "idea", invocationId: "v21-original-native",
      runtimePath: join(f.root, "runtime", "v21-original"), worktreePath: join(f.root, "worktrees", "idea"),
      executionContext: { role: "delivery", nodeRunId: "original-node", executionId: "original-execution", ownershipEpoch: 1, executionWorktree: join(f.root, "worktrees", "idea") },
      session: { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "v21-original-session", generation: 0, durable: true, createdAt: "2026-10-11T00:00:00.000Z" } });
    f.database.close();
    const raw = new DatabaseSync(f.options.databasePath), tables = ["project_heads", "project_events", "workflow_revisions", "work_tasks", "member_executions"];
    const before = tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    raw.exec("DROP INDEX workflow_native_session_harness; UPDATE collaboration_state_meta SET schema_version = 21"); raw.close();
    f.clock.now += 30_001;
    const reopened = CollaborationStateDatabase.open({ ...f.options, instanceId: "native-harness-index-writer" }); stores.push(reopened);
    const inspect = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: COLLABORATION_STATE_SCHEMA_VERSION });
      expect(tables.map(table => inspect.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
      expect(inspect.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]); expect(inspect.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const spy = vi.spyOn((reopened as any).database, "prepare");
      expect(reopened.prepareUserWorkflowAdjustmentPublication("p", request.requestId)).toMatchObject({ ready: false, publication: { status: "pending", workflowRevision: 1 } });
      const sql = spy.mock.calls.map(([sql]) => sql as string).find(sql => sql.includes("SELECT DISTINCT agent_id"))!; spy.mockRestore();
      expect(sql).toBeTruthy();
      const plan = JSON.stringify(inspect.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("p"));
      expect(plan).toContain("workflow_native_session_harness"); expect(plan).not.toContain("TEMP B-TREE");
      const bytecode = inspect.prepare(`EXPLAIN ${sql}`).all("p"), rootpage = inspect.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'project_events'").get()!.rootpage;
      const tableCursors = new Set(bytecode.filter(row => row.opcode === "OpenRead" && row.p2 === rootpage).map(row => row.p1));
      expect(bytecode.filter(row => row.opcode === "Column" && tableCursors.has(row.p1))).toEqual([]);
      console.log(JSON.stringify({ experiment: "native-harness-covering-index", plan, projectEventTableColumnReads: 0 }));
      expect(reopened.latestAgentNativeSessionBinding("p", "idea")!.session.nativeId).toBe("v21-original-session");
    } finally { inspect.close(); }
  });

  it("keeps v21 unchanged if the native Harness index migration fails or has a foreign unexpired writer", async () => {
    const f = await fixture(), raw = new DatabaseSync(f.options.databasePath);
    const before = raw.prepare("SELECT * FROM project_events ORDER BY seq").all();
    raw.exec("DROP INDEX workflow_native_session_harness; UPDATE collaboration_state_meta SET schema_version = 21");
    expect(() => CollaborationStateDatabase.open({ ...f.options, instanceId: "foreign-native-index-writer" })).toThrow(/writer|lease/i);
    expect(raw.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: 21 });
    f.database.close(); f.clock.now += 30_001; raw.exec("CREATE TABLE workflow_native_session_harness (failure TEXT)");
    try {
      expect(() => CollaborationStateDatabase.open({ ...f.options, instanceId: "failed-native-index-writer" })).toThrow(/table|index/i);
      expect(raw.prepare("SELECT schema_version FROM collaboration_state_meta").get()).toEqual({ schema_version: 21 });
      expect(raw.prepare("SELECT * FROM project_events ORDER BY seq").all()).toEqual(before);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workflow_native_session_harness'").all()).toEqual([]);
    } finally { raw.close(); }
  });

});
