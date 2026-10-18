import { collaborationSessionKey } from "../src/internal/shared/collaboration-session-key.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { GatewayStore } from "../src/agent-runtime.js";
import { CollaborationRuntimeCoordinator, type CollaborationRuntimeLifecycle } from "../src/collaboration-runtime.js";
import { EventHub } from "../src/event-hub.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ProjectStorage } from "../src/storage.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { credentialFreeAgentConfiguration } from "../src/scoped-agent-configuration.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/harness-runtime/registry.js";
import type { AgentRunner, ProjectState } from "../src/types.js";
import type { AgentOrchestrationProposal } from "../src/agent-orchestration-reconfiguration.js";
import { WORKFLOW_ADJUSTMENT_STALE_MESSAGE, validateWorkflowAdjustmentSnapshot } from "../src/workflow-adjustments.js";

const roots: string[] = [], orchestrators: Orchestrator[] = [];
afterEach(async () => {
  await Promise.all(orchestrators.splice(0).map(orchestrator => orchestrator.shutdown()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(options: { root?: string; allowMain?: boolean; gateway?: boolean } = {}) {
  const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), "openfars-user-adjustment-api-"));
  if (!options.root) roots.push(root);
  const hub = new EventHub(), storage = new ProjectStorage(root, hub), skills = new SkillCatalog([]);
  const run = vi.fn(async () => { throw new Error("No model invocation is authorized by a queue request"); });
  const runner = { run, harnessCatalog: async () => harnessCatalogRegistry.list().map(descriptor =>
    toPublicHarnessDescriptor(descriptor, { available: true })) } as unknown as AgentRunner;
  const gatewayFetch = vi.fn(async () => { throw new Error("Queue validation must not initiate a connection probe"); });
  const gatewayStore = options.gateway ? new GatewayStore(root, { fetch: gatewayFetch, resolveHostname: async () => ["93.184.216.34"] }) : undefined;
  const gateway = await gatewayStore?.create({ name: "Unprobed configured Gateway", url: "https://gateway.example.com/v1", apiKey: "server-only-gateway-secret",
    models: ["test-model"], defaultModel: "test-model", protocol: "responses" });
  let state!: ProjectState, orchestrator!: Orchestrator;
  const hooks: { validate?: (proposal: AgentOrchestrationProposal) => Promise<void> } = {};
  const validate = vi.fn(async (_state: ProjectState, proposal: AgentOrchestrationProposal) => {
    await orchestrator.prepareWorkflowConfiguration(state, proposal);
    await hooks.validate?.(proposal);
  });
  const coordinator = new CollaborationRuntimeCoordinator({ storage, databasePath: path.join(root, "state.sqlite"),
    serviceId: "user-adjustment-api", hostId: "test", validateWorkflowConfiguration: validate });
  const pause = vi.fn(async () => undefined), resume = vi.fn(async () => undefined), cancel = vi.fn(async () => undefined);
  const lifecycle: CollaborationRuntimeLifecycle = {
    initialize: () => coordinator.initialize(), recoverProject: async recovered => { state = recovered; return true; },
    // Only project creation is a controlled fixture. HTTP, Orchestrator,
    // resource/Harness validation, queue transactions and event mirroring
    // use production code. There is no external Git or native Agent process.
    createProject: async created => {
      state = created; state.status = "paused"; state.phase = "collaboration:user-paused";
      state.pauseRequest = { requestedAt: state.createdAt, settledAt: state.createdAt };
      state.git = { enabled: true, status: "ready" };
      coordinator.database().createProject({ projectId: state.id, workflowRevision: 1, workflowSnapshot: state.orchestration,
        git: state.git, workerCapacity: 4 });
      await storage.saveState(state);
    },
    assertWorkflowRevisionEditable: () => undefined, saveWorkflowRevision: async () => 1,
    retryInitialization: async () => undefined, pauseProject: pause, resumeProject: resume, cancelProject: cancel,
    getWorkflowAdjustments: current => coordinator.getWorkflowAdjustments(current),
    queryWorkflowAdjustments: (current, ifNoneMatch) => coordinator.queryWorkflowAdjustments(current, ifNoneMatch),
    getWorkflowAdjustmentPage: (current, input, ifNoneMatch) => coordinator.getWorkflowAdjustmentPage(current, input, ifNoneMatch),
    getWorkflowAdjustmentDetail: (current, id, version) => coordinator.getWorkflowAdjustmentDetail(current, id, version),
    submitWorkflowAdjustment: (current, input) => coordinator.submitWorkflowAdjustment(current, input),
    withdrawWorkflowAdjustment: (current, input) => coordinator.withdrawWorkflowAdjustment(current, input),
    shutdown: () => coordinator.shutdown()
  };
  orchestrator = new Orchestrator(storage, skills, runner, { retryBaseMs: 1, retryMaxMs: 1 }, gatewayStore, lifecycle);
  orchestrators.push(orchestrator); await orchestrator.initialize();
  const project = options.root ? (await orchestrator.listProjects())[0] : await orchestrator.createProject({ title: "User workflow adjustment", requirement: "Preserve the original task",
    git: { enabled: true }, agents: { main: { model: "test-model", skills: [], autoSkills: [], ...(gateway ? { gatewayId: gateway.id } : {}) } }, orchestration: {
      agents: [{ name: "main", template: "main" }], input: { source: "input", target: "main" }, routes: { main: [] },
      decisionPlans: { main: "Original plan" }, allowMainReconfiguration: options.allowMain ?? false, allowUserIntervention: true,
      termination: { agent: "main", condition: "Main verifies completion", decisionBy: "main", automatic: false }, resultFormat: { presets: [], custom: "" }
    } });
  const app = createApp({ orchestrator, storage, eventHub: hub, skills, config: { modelSuggestions: ["test-model"], maxEventHistory: 10 } });
  const url = `/api/projects/${project.id}/workflow/adjustments`, database = coordinator.database();
  const body = async (id = "user-one") => {
    const context = (await request(app).get(url).expect(200)).body;
    context.current.snapshot.agents.main.instructions = `Exact user instructions ${id}`;
    return { requestId: id, base: context.current.version, proposal: context.current.snapshot, explanation: `User explanation ${id}` };
  };
  const changeConfiguration = (instructions: string) => {
    database.initializeScopedConfiguration(state.id, { agents: state.agents, skillDefinitions: {}, mcpDefinitions: {} });
    const configuration = credentialFreeAgentConfiguration(database.scopedConfiguration(state.id)!);
    configuration.agents.main.instructions = instructions;
    database.appendEvent({ projectId: state.id, type: "scoped.configuration.applied", payload: { configuration } });
  };
  const queueNativeTrace = () => {
    // Exercise the actual native-event reservation and Orchestrator queue.
    // This fixture has no native process or external model invocation.
    const transport = orchestrator as unknown as {
      runtimes: Map<string, { state: ProjectState }>;
      emit(runtime: { state: ProjectState }, draft: { type: "agent.trace"; level: "info"; agent: "main"; message: string }): Promise<unknown>;
    };
    return transport.emit(transport.runtimes.get(state.id)!, {
      type: "agent.trace", level: "info", agent: "main", message: "Concurrent native event remains transportable"
    });
  };
  return { root, state, storage, skills, orchestrator, coordinator, app, url, database, body, validate, hooks, changeConfiguration, gatewayFetch, run, pause, resume, cancel, queueNativeTrace };
}

describe("workflow adjustment public API", () => {
  it.each([true, false, undefined])("transports the explicit retained-budget Resume option (%s)", async preserveRecoveryBudget => {
    const f = await fixture();
    await request(f.app).post(`/api/projects/${f.state.id}/resume`)
      .send(preserveRecoveryBudget === undefined ? {} : { preserveRecoveryBudget }).expect(200);
    expect(f.resume).toHaveBeenCalledOnce();
    if (preserveRecoveryBudget) expect(f.resume).toHaveBeenCalledWith(f.state, { preserveRecoveryBudget: true });
    else expect(f.resume).toHaveBeenCalledWith(f.state);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous retained-budget Resume option before lifecycle dispatch", async () => {
    const f = await fixture();
    await request(f.app).post(`/api/projects/${f.state.id}/resume`).send({ preserveRecoveryBudget: "true" }).expect(400);
    expect(f.resume).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["submit", "withdraw"] as const)("does not block native event transport while publishing a user workflow %s", async action => {
    const f = await fixture(), input = await f.body("native-event-race");
    if (action === "withdraw") await request(f.app).post(f.url).send(input).expect(202);
    const originalRead = f.storage.readEvents.bind(f.storage);
    const originalReserve = f.storage.reserveProjectMutation.bind(f.storage);
    let releaseReservation: (() => void) | undefined, trace: Promise<unknown> | undefined;
    vi.spyOn(f.storage, "reserveProjectMutation").mockImplementation(projectId => {
      const release = originalReserve(projectId); releaseReservation = release; return release;
    });
    vi.spyOn(f.storage, "readEvents").mockImplementationOnce((...args) => {
      trace = f.queueNativeTrace();
      return originalRead(...args);
    });
    const response = (action === "submit"
      ? request(f.app).post(f.url).send(input)
      : request(f.app).post(`${f.url}/${input.requestId}/withdraw`).send({ operationId: "native-event-withdraw" })).then(value => value);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([response, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("User workflow publication blocked behind its own queued native event")), 1000);
      })]);
      expect(result.status).toBe(action === "submit" ? 202 : 200);
      expect(result.body.record.status).toBe(action === "submit" ? "pending" : "withdrawn");
      await trace;
      const events = await originalRead(f.state.id);
      expect(events.filter(event => event.message === "Concurrent native event remains transportable")).toHaveLength(1);
      for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      // Release only for failed-regression cleanup; a passing test has already
      // transported and released this reservation through production code.
      releaseReservation?.(); await Promise.allSettled([response, trace]);
    }
  });

  it("persists and reloads a valid complete proposal with near-limit project resources and multibyte instructions", async () => {
    const f = await fixture(), input = await f.body("large-complete-proposal");
    const current = (await request(f.app).get(f.url).expect(200)).body.current.snapshot;
    input.proposal.agents.main.instructions = "配置".repeat(10_000);
    input.proposal.skillDefinitions = { large: { files: { "SKILL.md": "# Large project reference\n",
      "first.txt": "a".repeat(500_000), "second.txt": "b".repeat(500_000), "third.txt": "c".repeat(16_000) } } };
    input.proposal.mcpDefinitions = { large: { command: "node", entrypoint: "tool.mjs", args: [], envFrom: {},
      files: { "tool.mjs": "// Isolated unselected project resource\n", "first.txt": "d".repeat(500_000),
        "second.txt": "e".repeat(500_000), "third.txt": "f".repeat(16_000) } } };
    const remaining = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(input.proposal));
    expect(remaining).toBeGreaterThan(0);
    input.proposal.skillDefinitions.large.files["third.txt"] += "g".repeat(remaining);
    expect(Buffer.byteLength(JSON.stringify(input.proposal))).toBe(2 * 1024 * 1024);
    expect(validateWorkflowAdjustmentSnapshot(input.proposal, current)).toEqual(input.proposal);
    input.explanation = "说明".repeat(10_000);
    const bytes = Buffer.byteLength(JSON.stringify(input));
    expect(bytes).toBeGreaterThan(2 * 1024 * 1024);
    const result = await request(f.app).post(f.url).send(input);
    console.info(JSON.stringify({ experiment: "large-workflow-adjustment-http", bytes, status: result.status, error: result.body.error }));
    expect(result.status).toBe(202);
    expect(result.body.record.status).toBe("pending");
    expect(result.body.record.proposal).toEqual(input.proposal);
    const reloaded = await request(f.app).get(`${f.url}/requests/${input.requestId}`).expect(200);
    expect(reloaded.body.record.proposal).toEqual(input.proposal);
    expect(f.database.workflowAdjustmentCurrent(f.state.id).version).toEqual(input.base);
    // A full proposal is accepted only by its own endpoint. Other control
    // requests keep their small body limit and cannot disturb this queue.
    await request(f.app).post(`${f.url}/${input.requestId}/withdraw`).send(input).expect(413)
      .expect(({ body }) => expect(body.code).toBe("request_body_too_large"));
    expect(f.database.workflowAdjustment(f.state.id, input.requestId)?.status).toBe("pending");
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  const runnable = (f: Awaited<ReturnType<typeof fixture>>) => { f.state.status = "queued"; delete f.state.pauseRequest; };
  const retainSavedSession = (f: Awaited<ReturnType<typeof fixture>>) => {
    const binding = { projectId: f.state.id, agentId: "main", invocationId: "saved-original-main",
      runtimePath: path.join(f.root, "runtime", "saved-original-main"), worktreePath: path.join(f.root, "worktrees", "main"),
      executionContext: { role: "leader" as const, nodeRunId: "original-main-node", routeScopeId: "original-route", coordinatorEpoch: 1 },
      session: { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "test", nativeId: "private-saved-original-session", generation: 0, durable: true, createdAt: f.state.createdAt } };
    f.database.recordAgentNativeSessionBinding(binding); return binding;
  };

  it.each([false, true])("uses S's retained Session before its runtime mapping is restored (projection lag=%s)", async lagged => {
    const f = await fixture(); f.database.initializeScopedConfiguration(f.state.id, { agents: f.state.agents, skillDefinitions: {}, mcpDefinitions: {} });
    const input = await f.body(); input.proposal.agents.main.harness = "claude-code";
    const sessions = structuredClone({ refs: f.state.agentSessions, ids: f.state.agentSessionIds });
    const original = retainSavedSession(f); if (lagged) f.state.agents.main.harness = "claude-code";
    for (const url of [f.url, `${f.url}/history`]) {
      const current = await request(f.app).get(url).expect(200);
      expect(current.body.constraints?.agentHarnesses.main.harnessId).toBe("codex");
      expect(JSON.stringify(current.body.constraints)).not.toContain(original.session.nativeId);
    }
    await request(f.app).post(f.url).send(input).expect(400);
    expect(f.database.workflowAdjustments(f.state.id)).toEqual([]);
    expect({ refs: f.state.agentSessions, ids: f.state.agentSessionIds }).toEqual(sessions);
    expect(f.database.latestAgentNativeSessionBinding(f.state.id, "main")).toEqual(original);
  });

  it("rejects a new incompatible request if only S's native binding appears during asynchronous validation", async () => {
    const f = await fixture(), input = await f.body(); input.proposal.agents.main.harness = "claude-code";
    const before = f.database.scopedConfiguration(f.state.id);
    f.hooks.validate = async () => { retainSavedSession(f); };
    const result = await request(f.app).post(f.url).send(input);
    console.log(JSON.stringify({ experiment: "saved-session-during-validation", status: result.status, records: (await request(f.app).get(f.url)).body.records.length }));
    expect(result.status).toBe(400); expect(f.database.scopedConfiguration(f.state.id)).toEqual(before);
    expect((await request(f.app).get(f.url).expect(200)).body.records).toEqual([]);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the original pending user request when a replacement conflicts with S's retained Session", async () => {
    const f = await fixture(), first = await f.body("original-pending"); await request(f.app).post(f.url).send(first).expect(202);
    const original = f.database.workflowAdjustment(f.state.id, first.requestId)!;
    const next = await f.body("incompatible-replacement"); next.proposal.agents.main.harness = "claude-code";
    f.hooks.validate = async () => { retainSavedSession(f); };
    await request(f.app).post(f.url).send({ ...next, replacesRequestId: first.requestId }).expect(400);
    expect(f.database.workflowAdjustment(f.state.id, first.requestId)).toEqual(original);
    expect(f.database.workflowAdjustments(f.state.id)).toHaveLength(1);
    expect(f.database.workflowAdjustment(f.state.id, next.requestId)).toBeUndefined();
  });

  it("refreshes full and paged constraints and rejects an old detail journal when a retained S Session appears", async () => {
    const f = await fixture(), input = await f.body("archived-full-proposal");
    await request(f.app).post(f.url).send(input).expect(202);
    await request(f.app).post(`${f.url}/${input.requestId}/withdraw`).send({ operationId: "archive-original" }).expect(200);
    const full = await request(f.app).get(f.url).expect(200), page = await request(f.app).get(`${f.url}/history`).expect(200);
    const archived = f.database.workflowAdjustment(f.state.id, input.requestId)!, binding = retainSavedSession(f);
    const changed = await request(f.app).get(f.url).set("If-None-Match", full.headers.etag).expect(200);
    const fresh = await request(f.app).get(`${f.url}/history`).set("If-None-Match", page.headers.etag).expect(200);
    expect(changed.headers.etag).not.toBe(full.headers.etag); expect(fresh.body.journalVersion).not.toBe(page.body.journalVersion);
    expect(changed.body.current.version).toEqual(full.body.current.version);
    expect(fresh.body.constraints.agentHarnesses.main.harnessId).toBe("codex");
    expect(JSON.stringify(fresh.body.constraints)).not.toContain(binding.session.nativeId);
    await request(f.app).get(`${f.url}/history`).query({ before: page.body.records[0].submissionSequence, expectedVersion: page.body.journalVersion }).expect(409);
    await request(f.app).get(`${f.url}/requests/${input.requestId}`).query({ expectedVersion: page.body.journalVersion }).expect(409);
    const detail = await request(f.app).get(`${f.url}/requests/${input.requestId}`).query({ expectedVersion: fresh.body.journalVersion }).expect(200);
    expect(detail.body.record).toEqual(archived);
    await request(f.app).get(`${f.url}/history`).set("If-None-Match", fresh.headers.etag).expect(304);
  });

  it("publishes an already safe full user request through the production validator without Main editing or a model wake", async () => {
    const f = await fixture(), input = await f.body(); runnable(f);
    const accepted = (await request(f.app).post(f.url).send(input).expect(202)).body;
    expect(accepted.record).toMatchObject({ status: "applied", base: input.base, proposal: input.proposal });
    expect(accepted.record.history.at(-1)).toMatchObject({ status: "applied", appliedVersion: f.database.workflowAdjustmentCurrent(f.state.id).version });
    expect(f.state.agents.main.instructions).toBe(input.proposal.agents.main.instructions);
    expect(f.state.orchestration.allowMainReconfiguration).toBe(false); expect(f.state.workflowRevision).toBe(2);
    const mirrored = await f.storage.readEvents(f.state.id, 0, 1000);
    expect(mirrored.filter(event => event.data?.sourceType === "workflow.adjustment.transitioned" &&
      (event.data?.transition as { status?: string } | undefined)?.status === "applied")).toHaveLength(1);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("retains a waiting request on fresh resource validation failure and applies only after a later real boundary passes", async () => {
    const f = await fixture(), input = await f.body(); await request(f.app).post(f.url).send(input).expect(202); runnable(f);
    f.hooks.validate = async () => { throw new Error("Configured Harness is temporarily unavailable"); };
    await f.coordinator.applyWaitingWorkflowAdjustments(f.state);
    expect(f.database.workflowAdjustments(f.state.id)[0]).toMatchObject({ status: "pending", waitingReason: expect.stringContaining("Harness is temporarily unavailable") });
    expect(f.database.workflowAdjustmentCurrent(f.state.id).version).toEqual(input.base); expect(f.state.status).toBe("queued");
    delete f.hooks.validate; await f.coordinator.applyWaitingWorkflowAdjustments(f.state);
    expect(f.database.workflowAdjustments(f.state.id)[0].status).toBe("applied");
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it.each(["withdraw", "replace", "stale", "pause"] as const)("rechecks %s after asynchronous publication validation", async change => {
    const f = await fixture(), input = await f.body(); await request(f.app).post(f.url).send(input).expect(202); runnable(f);
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    f.hooks.validate = async () => { entered(); await held; };
    const publishing = f.coordinator.applyWaitingWorkflowAdjustments(f.state); await entry;
    if (change === "withdraw") f.database.withdrawWorkflowAdjustment({ projectId: f.state.id, requestId: input.requestId, operationId: "withdraw-during-publish" });
    if (change === "replace") f.database.submitUserWorkflowAdjustment({ ...input, projectId: f.state.id, requestId: "replacement-during-publish", replacesRequestId: input.requestId });
    if (change === "stale") f.changeConfiguration("Actual newer authority during publication validation");
    if (change === "pause") { f.state.status = "paused"; f.state.pauseRequest = { requestedAt: f.state.createdAt }; }
    delete f.hooks.validate; release(); await publishing;
    const expected = { withdraw: "withdrawn", replace: "replaced", stale: "needs_resubmission", pause: "pending" }[change];
    expect(f.database.workflowAdjustments(f.state.id)[0].status).toBe(expected);
    expect(f.database.projectState(f.state.id).workflowRevision).toBe(1);
    expect(f.state.agents.main.instructions).not.toBe(input.proposal.agents.main.instructions);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("reads a complete legacy baseline without writes, including for a completed project", async () => {
    const f = await fixture(), before = f.database.projectState(f.state.id), events = f.database.eventsAfter(f.state.id, 0, 1000);
    const first = await request(f.app).get(f.url).expect(200);
    expect(first.headers["cache-control"]).toBe("no-store, private");
    expect(first.body.current.snapshot.orchestration.allowMainReconfiguration).toBe(false); expect(first.body.records).toEqual([]);
    f.state.status = "completed";
    expect((await request(f.app).get(f.url).expect(200)).body).toEqual(first.body);
    expect(f.database.projectState(f.state.id)).toEqual(before); expect(f.database.eventsAfter(f.state.id, 0, 1000)).toEqual(events);
    expect(f.database.scopedConfiguration(f.state.id)).toBeUndefined(); expect(f.validate).not.toHaveBeenCalled();
  });

  it("queues and replays a full user request independently of Main permission without applying or waking work", async () => {
    const f = await fixture(), input = await f.body(), original = structuredClone(input), pause = structuredClone(f.state.pauseRequest);
    const accepted = (await request(f.app).post(f.url).send(input).expect(202)).body;
    expect(accepted).toMatchObject({ replay: false, record: { source: { kind: "user" }, status: "pending", base: input.base, explanation: input.explanation } });
    expect((await request(f.app).post(f.url).send(input).expect(200)).body).toMatchObject({ replay: true, record: { requestId: input.requestId, status: "pending" } });
    expect(input).toEqual(original); expect(f.validate).toHaveBeenCalledTimes(1);
    expect(f.database.workflowAdjustmentCurrent(f.state.id).version).toEqual(input.base);
    expect(f.state.workflowRevision).toBe(1); expect(f.state.status).toBe("paused"); expect(f.state.pauseRequest).toEqual(pause);
    expect(f.state.agents.main.instructions).not.toBe(input.proposal.agents.main.instructions);
    const mirrored = await f.storage.readEvents(f.state.id, 0, 1000);
    expect(mirrored.filter(event => event.data?.sourceType === "workflow.adjustment.submitted")).toHaveLength(1);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("requires exact replacement confirmation and preserves the old request on invalid new content", async () => {
    const f = await fixture(), first = await f.body(); await request(f.app).post(f.url).send(first).expect(202);
    const next = await f.body("user-two"), conflict = await request(f.app).post(f.url).send(next).expect(409);
    expect(conflict.body).toMatchObject({ code: "WORKFLOW_ADJUSTMENT_CONFLICT", details: { currentRequestId: first.requestId } });
    expect(f.validate).toHaveBeenCalledTimes(1);
    const bad = structuredClone(next); bad.proposal.agents.main.skills = ["missing-project-skill"];
    await request(f.app).post(f.url).send({ ...bad, replacesRequestId: first.requestId }).expect(400);
    expect(f.database.workflowAdjustments(f.state.id).map(record => record.status)).toEqual(["pending"]);
    await request(f.app).post(f.url).send({ ...next, replacesRequestId: first.requestId }).expect(202);
    const records = (await request(f.app).get(f.url).expect(200)).body.records;
    expect(records.map((record: { status: string }) => record.status)).toEqual(["replaced", "pending"]);
    expect(records[0].proposal).toEqual(first.proposal); expect(records[1].replacesRequestId).toBe(first.requestId);
  });

  it("rejects an already stale base before parsing content or calling resource validation", async () => {
    const f = await fixture(), input = await f.body(); f.changeConfiguration("New authority");
    const result = await request(f.app).post(f.url).send({ ...input, proposal: null }).expect(409);
    expect(result.body).toMatchObject({ error: WORKFLOW_ADJUSTMENT_STALE_MESSAGE, code: "STALE_WORKFLOW_CONFIGURATION",
      details: { currentSnapshot: { agents: { main: { instructions: "New authority" } } } } });
    expect(f.validate).not.toHaveBeenCalled(); expect(f.database.workflowAdjustments(f.state.id)).toEqual([]);
  });

  it("rechecks the base after async validation and does not replace the original request", async () => {
    const f = await fixture(), first = await f.body(); await request(f.app).post(f.url).send(first).expect(202);
    const next = await f.body("user-two");
    f.hooks.validate = async () => { await Promise.resolve(); f.changeConfiguration("Accepted during resource validation"); };
    await request(f.app).post(f.url).send({ ...next, replacesRequestId: first.requestId }).expect(409);
    const records = f.database.workflowAdjustments(f.state.id);
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ requestId: first.requestId, status: "needs_resubmission", proposal: first.proposal });
  });

  it("does not seed legacy configuration when full resource validation fails", async () => {
    const f = await fixture(), input = await f.body(), before = f.database.projectState(f.state.id);
    input.proposal.agents.main.skills = ["missing-project-skill"];
    await request(f.app).post(f.url).send(input).expect(400);
    expect(f.database.scopedConfiguration(f.state.id)).toBeUndefined(); expect(f.database.projectState(f.state.id)).toEqual(before);
  });

  it("uses the existing Harness and durable Session validation", async () => {
    const f = await fixture(), input = await f.body();
    f.state.agentSessions!.main = { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "original-session",
      generation: 0, durable: true, createdAt: f.state.createdAt };
    const session = structuredClone(f.state.agentSessions!.main);
    const before = f.database.projectState(f.state.id).stateRevision;
    const context = (await request(f.app).get(f.url).expect(200)).body;
    expect(context.constraints.agentHarnesses.main).toMatchObject({ harnessId: "codex", reason: expect.stringContaining("已有原生会话") });
    expect(JSON.stringify(context)).not.toContain("original-session");
    expect(f.database.projectState(f.state.id).stateRevision).toBe(before);
    input.proposal.agents.main.harness = "claude-code";
    const result = await request(f.app).post(f.url).send(input).expect(400);
    expect(result.body.error).toContain("现有 session"); expect(f.state.agentSessions!.main).toEqual(session);
    delete f.state.agentSessions!.main;
    f.state.agentSessionIds = { ...f.state.agentSessionIds, main: "legacy-private-native-id" };
    delete f.state.agents.main.harness;
    const legacy = (await request(f.app).get(f.url).expect(200)).body;
    expect(legacy.constraints.agentHarnesses.main.harnessId).toBe("codex");
    expect(JSON.stringify(legacy)).not.toContain("legacy-private-native-id");
    expect(f.database.scopedConfiguration(f.state.id)).toBeUndefined();
  });

  it("accepts an unverified Gateway while preserving locked credentials and keeping them out of public snapshots", async () => {
    const f = await fixture({ gateway: true }), input = await f.body();
    expect(f.state.agents.main.gatewaySnapshot?.apiKey).toBe("server-only-gateway-secret");
    expect(JSON.stringify(input)).not.toContain("server-only-gateway-secret");
    const result = await request(f.app).post(f.url).send(input).expect(202);
    expect(JSON.stringify(result.body)).not.toContain("server-only-gateway-secret");
    expect(f.gatewayFetch).not.toHaveBeenCalled();
    expect(f.state.agents.main.gatewaySnapshot?.apiKey).toBe("server-only-gateway-secret");
    expect(f.database.workflowAdjustmentContext(f.state.id, { agents: f.state.agents, skillDefinitions: {}, mcpDefinitions: {} }).records).toHaveLength(1);
  });

  it("serializes two browser replacements and accepts only the explicitly named current request", async () => {
    const f = await fixture(), first = await f.body(); await request(f.app).post(f.url).send(first).expect(202);
    const left = { ...await f.body("left"), replacesRequestId: first.requestId }, right = { ...await f.body("right"), replacesRequestId: first.requestId };
    const responses = await Promise.all([request(f.app).post(f.url).send(left), request(f.app).post(f.url).send(right)]);
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    expect(f.database.workflowAdjustments(f.state.id).filter(record => record.status === "pending")).toHaveLength(1);
  });

  it("withdraws one exact pending request durably and preserves its full snapshot and original pause", async () => {
    const f = await fixture(), input = await f.body(); await request(f.app).post(f.url).send(input).expect(202);
    const url = `${f.url}/${input.requestId}/withdraw`, body = { operationId: "withdraw-one", note: "Preserve the original task" };
    expect((await request(f.app).post(url).send(body).expect(200)).body).toMatchObject({ withdrawn: true, replay: false, record: { status: "withdrawn", proposal: input.proposal } });
    expect((await request(f.app).post(url).send(body).expect(200)).body).toMatchObject({ withdrawn: true, replay: true });
    await request(f.app).post(url).send({ ...body, note: "Different operation content" }).expect(409);
    expect(f.database.workflowAdjustments(f.state.id)[0].history.at(-1)?.note).toBe(body.note);
    expect(f.state.status).toBe("paused"); for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("rolls back the first seed and submission on an actual SQLite persistence failure", async () => {
    const f = await fixture(), input = await f.body(), before = f.database.projectState(f.state.id);
    const sql = new DatabaseSync(path.join(f.root, "state.sqlite"));
    try { sql.exec("CREATE TRIGGER reject_api_adjustment BEFORE INSERT ON project_events WHEN NEW.event_type = 'workflow.adjustment.submitted' BEGIN SELECT RAISE(ABORT, 'isolated API persistence failure'); END"); }
    finally { sql.close(); }
    await request(f.app).post(f.url).send(input).expect(500);
    expect(f.database.scopedConfiguration(f.state.id)).toBeUndefined(); expect(f.database.projectState(f.state.id)).toEqual(before);
  });

  it.each([false, true])("restores the exact durable queue across a real writer restart (withdrawn=%s)", async withdrawn => {
    const f = await fixture(), input = await f.body(); await request(f.app).post(f.url).send(input).expect(202);
    const withdrawal = { operationId: "restart-withdrawal", note: "Original durable operation" };
    if (withdrawn) await request(f.app).post(`${f.url}/${input.requestId}/withdraw`).send(withdrawal).expect(200);
    const context = (await request(f.app).get(f.url).expect(200)).body, epoch = f.database.writerLease().epoch;
    await f.orchestrator.shutdown(); orchestrators.splice(orchestrators.indexOf(f.orchestrator), 1);
    const restarted = await fixture({ root: f.root });
    expect(restarted.database.writerLease().epoch).toBeGreaterThan(epoch);
    expect((await request(restarted.app).get(f.url).expect(200)).body).toEqual(context);
    expect((await request(restarted.app).post(f.url).send(input).expect(200)).body).toMatchObject({ replay: true, record: { status: withdrawn ? "withdrawn" : "pending" } });
    if (withdrawn) expect((await request(restarted.app).post(`${f.url}/${input.requestId}/withdraw`).send(withdrawal).expect(200)).body.replay).toBe(true);
    expect(restarted.validate).not.toHaveBeenCalled(); expect(restarted.run).not.toHaveBeenCalled();
  });

  it("withdraws a formal Main proposal through the same API while preserving its original accepted tool fact", async () => {
    const f = await fixture({ allowMain: true }), database = f.database;
    database.initializeScopedConfiguration(f.state.id, { agents: f.state.agents, skillDefinitions: {}, mcpDefinitions: {} });
    const current = database.workflowAdjustmentCurrent(f.state.id), graph = structuredClone(current.snapshot.orchestration);
    graph.decisionPlans.main = "Main's exact formal proposed change";
    const { orchestration: _graph, ...configuration } = current.snapshot;
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
    const semanticInputHash = "a".repeat(64), requestId = `accepted-main-control-${semanticInputHash}-0`;
    database.activateNode({ projectId: f.state.id, nodeRunId: "original-main", node: { kind: "agent", nodeId: "main", agentId: "main" },
      activationRequestId: "original-main-activation", inputSnapshotRef: "original-main-input", activatedByAgentId: "main", workflowRevision: 1 });
    database.appendEvent({ projectId: f.state.id, nodeRunId: "original-main", agentId: "main", invocationId: "original-main-invocation", coordinatorEpoch: 1,
      type: "main.route.attempt", payload: { attempt: 1 } });
    database.revalidateMainRouteControl({ projectId: f.state.id, nodeRunId: "original-main", invocationId: "original-main-invocation", routeEpoch: 1, stateVersion: 1,
      candidateNodeIds: ["finish"], canComplete: true, allowFinishRoute: false, action: { tool: "apply_workflow", path: "workflow.json", rationale: "Main's public reason" },
      accepted: { requestId, inputId: "original-main-input", invocationId: "original-main-invocation", callId: "original-main-tool", semanticInputHash,
        workflowProposal: { orchestration: graph, configuration, baseConfigurationHash: database.scopedConfigurationHash(f.state.id), affectedGroupIds: [],
          prestateWorkflowRevision: 1, prestateWorkflowHash: hash(current.snapshot.orchestration), targetWorkflowRevision: 2, proposalHash: hash(graph) } } });
    const original = database.eventByRequestId(f.state.id, requestId);
    expect((await request(f.app).post(`${f.url}/${requestId}/withdraw`).send({ operationId: "withdraw-main" }).expect(200)).body)
      .toMatchObject({ withdrawn: true, record: { source: { kind: "main", acceptedEventId: original?.eventId }, status: "withdrawn" } });
    expect(database.eventByRequestId(f.state.id, requestId)).toEqual(original);
    expect(database.projectState(f.state.id).workflowRevision).toBe(1); expect(f.validate).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });

  it("keeps original request replay available after completion while rejecting new submissions", async () => {
    const f = await fixture(), input = await f.body(); await request(f.app).post(f.url).send(input).expect(202); f.state.status = "completed";
    await request(f.app).post(f.url).send(input).expect(200);
    await request(f.app).post(f.url).send({ ...input, requestId: "new-after-completion", replacesRequestId: input.requestId }).expect(409);
    expect(f.validate).toHaveBeenCalledTimes(1);
  });

  it("rejects path identity spoofing, source forgery, credentials and removed proxy fields", async () => {
    const f = await fixture(), input = await f.body();
    for (const extra of [{ projectId: "another-project" }, { source: { kind: "main" } }])
      await request(f.app).post(f.url).send({ ...input, ...extra }).expect(400);
    for (const extra of [{ gatewaySnapshot: { apiKey: "private-server-credential" } }, { proxy: { mode: "direct" } }]) {
      const bad = structuredClone(input); Object.assign(bad.proposal.agents.main, extra);
      const result = await request(f.app).post(f.url).send(bad).expect(400);
      expect(JSON.stringify(result.body)).not.toContain("private-server-credential");
    }
    await request(f.app).post(`${f.url}/missing/withdraw`).send({ operationId: "withdraw", requestId: "spoof" }).expect(400);
    await request(f.app).post(`${f.url}/missing/withdraw`).send({ operationId: "withdraw" }).expect(404);
    await request(f.app).get("/api/projects/prj_00000000000000000000000000000000/workflow/adjustments").expect(404);
    expect(f.validate).not.toHaveBeenCalled(); expect(f.database.scopedConfiguration(f.state.id)).toBeUndefined();
  });
  it("conditionally returns the complete history only when its immutable journal changes", async () => {
    const f = await fixture(), first = await request(f.app).get(f.url).expect(200), etag = first.headers.etag;
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const before = f.database.projectState(f.state.id);
    const same = await request(f.app).get(f.url).set("If-None-Match", etag).expect(304);
    expect(same.text).toBe(""); expect(same.headers.etag).toBe(etag); expect(same.headers["cache-control"]).toBe("no-store, private");
    expect(f.database.projectState(f.state.id)).toEqual(before);
    const input = await f.body(); await request(f.app).post(f.url).send(input).expect(202);
    const changed = await request(f.app).get(f.url).set("If-None-Match", etag).expect(200);
    expect(changed.headers.etag).not.toBe(etag); expect(changed.body.records[0]).toMatchObject({ requestId: input.requestId, proposal: input.proposal, status: "pending" });
    await request(f.app).get(f.url).set("If-None-Match", `"foreign", W/${changed.headers.etag}`).expect(304);
    await request(f.app).post(`${f.url}/${encodeURIComponent(input.requestId)}/withdraw`).send({ operationId: "conditional-withdraw" }).expect(200);
    const terminal = await request(f.app).get(f.url).set("If-None-Match", changed.headers.etag).expect(200);
    expect(terminal.body.records[0].status).toBe("withdrawn");
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("invalidates conditional reads for formal configuration and public original Harness constraints", async () => {
    const f = await fixture(), first = await request(f.app).get(f.url).expect(200);
    f.changeConfiguration("Actual newer authority");
    const changed = await request(f.app).get(f.url).set("If-None-Match", first.headers.etag).expect(200);
    expect(changed.body.current.snapshot.agents.main.instructions).toBe("Actual newer authority");
    f.state.agentSessionIds = { main: "private-native-session-never-exposed-in-constraints" };
    const bound = await request(f.app).get(f.url).set("If-None-Match", changed.headers.etag).expect(200);
    expect(bound.body.constraints.agentHarnesses.main.harnessId).toBe("codex");
    expect(JSON.stringify(bound.body)).not.toContain("private-native-session-never-exposed-in-constraints");
    await request(f.app).get(f.url).set("If-None-Match", bound.headers.etag).expect(304);
  });

  it("preserves unknown-project errors with a wildcard conditional read", async () => {
    const f = await fixture();
    await request(f.app).get("/api/projects/nonexistent-conditional-project/workflow/adjustments").set("If-None-Match", "*").expect(400);
    await request(f.app).get(f.url).set("If-None-Match", "*").expect(304);
  });

  it("serves bounded history metadata and a version-bound exact full proposal without a lifecycle operation", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) {
      const body = await f.body(`paged-api-${i}`); await request(f.app).post(f.url).send(body).expect(202);
      await request(f.app).post(`${f.url}/${body.requestId}/withdraw`).send({ operationId: `paged-withdraw-${i}`, note: `Actual note ${i}` }).expect(200);
    }
    const before = f.database.projectState(f.state.id);
    const first = await request(f.app).get(`${f.url}/history`).query({ limit: 2 }).expect(200);
    expect(first.body.records.map((record: { requestId: string }) => record.requestId)).toEqual(["paged-api-2", "paged-api-1"]);
    expect(first.body.total).toBe(3); expect(first.body.records[0]).not.toHaveProperty("proposal");
    await request(f.app).get(`${f.url}/history`).query({ limit: 2 }).set("If-None-Match", first.headers.etag).expect(304);
    const second = await request(f.app).get(`${f.url}/history`).query({ limit: 2, before: first.body.nextBefore, expectedVersion: first.body.journalVersion }).expect(200);
    expect(second.body.records[0].requestId).toBe("paged-api-0"); expect(second.body.nextBefore).toBeUndefined(); expect(second.body.current).toBeUndefined();
    const detail = await request(f.app).get(`${f.url}/requests/paged-api-0`).query({ expectedVersion: first.body.journalVersion }).expect(200);
    expect(detail.body.record).toEqual(f.database.workflowAdjustment(f.state.id, "paged-api-0"));
    expect(detail.body.record.history.at(-1).note).toBe("Actual note 0");
    const fresh = await f.body("after-page"); await request(f.app).post(f.url).send(fresh).expect(202);
    await request(f.app).get(`${f.url}/history`).query({ before: first.body.nextBefore, expectedVersion: first.body.journalVersion }).expect(409);
    await request(f.app).get(`${f.url}/requests/paged-api-0`).query({ expectedVersion: first.body.journalVersion }).expect(409);
    expect(before.workflowRevision).toBe(f.database.projectState(f.state.id).workflowRevision);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("validates history cursors and detail queries while retaining accurate missing-record errors", async () => {
    const f = await fixture(), before = f.database.projectState(f.state.id);
    for (const query of [{ limit: 0 }, { limit: 101 }, { before: 10 }, { before: "invalid" }, { expectedVersion: "invalid" }, { unknown: "field" }])
      await request(f.app).get(`${f.url}/history`).query(query).expect(400);
    await request(f.app).get(`${f.url}/requests/missing-history-request`).expect(404);
    await request(f.app).get(`${f.url}/requests/missing-history-request`).query({ limit: 5 }).expect(400);
    expect(f.database.projectState(f.state.id)).toEqual(before);
  });

  it("keeps reserved-looking and encoded original request identities addressable independently of history routes", async () => {
    const f = await fixture();
    for (const id of ["history", "requests", "原请求 /?"]) {
      const body = await f.body(id); await request(f.app).post(f.url).send(body).expect(202);
      const detail = await request(f.app).get(`${f.url}/requests/${encodeURIComponent(id)}`).expect(200);
      expect(detail.body.record.requestId).toBe(id); expect(detail.body.record.proposal).toEqual(body.proposal);
      await request(f.app).post(`${f.url}/${encodeURIComponent(id)}/withdraw`).send({ operationId: `withdraw-${id}` }).expect(200);
    }
    const history = await request(f.app).get(`${f.url}/history`).expect(200);
    expect(history.body.total).toBe(3);
  });

  it.each(["structured", "legacy"])("rejects a Harness-changing first submission when an original %s Session binds during validation", async kind => {
    const f = await fixture(), input = await f.body(), before = f.database.projectState(f.state.id);
    input.proposal.agents.main.harness = "claude-code";
    const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "test", nativeId: "late-original-session", generation: 0, durable: true, createdAt: f.state.createdAt };
    f.hooks.validate = async () => {
      if (kind === "structured") f.state.agentSessions!.main = session;
      else f.state.agentSessionIds.main = session.nativeId;
    };
    const result = await request(f.app).post(f.url).send(input).expect(400);
    expect(result.body.error).toMatch(/现有 session.*Harness/);
    expect((await request(f.app).get(f.url).expect(200)).body.records).toEqual([]); expect(f.database.scopedConfiguration(f.state.id)).toBeUndefined();
    expect(f.database.projectState(f.state.id)).toEqual(before);
    if (kind === "structured") expect(f.state.agentSessions!.main).toEqual(session); else expect(f.state.agentSessionIds.main).toBe(session.nativeId);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it.each(["structured", "legacy"])("retains a pending request when an original %s Session binds during publication validation", async kind => {
    const f = await fixture(), input = await f.body(); input.proposal.agents.main.harness = "claude-code";
    await request(f.app).post(f.url).send(input).expect(202); runnable(f);
    const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "test", nativeId: "publication-original-session", generation: 0, durable: true, createdAt: f.state.createdAt };
    f.hooks.validate = async () => {
      if (kind === "structured") f.state.agentSessions!.main = session;
      else f.state.agentSessionIds.main = session.nativeId;
    };
    let failure: unknown;
    try { await f.coordinator.applyWaitingWorkflowAdjustments(f.state); } catch (error) { failure = error; }
    console.info(JSON.stringify({ experiment: "late-session-publication", kind,
      workflowRevision: f.database.projectState(f.state.id).workflowRevision,
      recordStatus: f.database.workflowAdjustments(f.state.id)[0].status,
      error: failure instanceof Error ? failure.message : failure ?? null }));
    expect(f.database.workflowAdjustments(f.state.id)[0]).toMatchObject({ requestId: input.requestId, status: "pending", proposal: input.proposal,
      waitingReason: expect.stringMatching(/现有 session.*Harness/) });
    expect(failure).toBeUndefined();
    expect(f.database.projectState(f.state.id).workflowRevision).toBe(1);
    expect(f.state.agents.main.harness ?? "codex").toBe("codex"); expect(f.state.status).toBe("queued"); expect(f.state.pauseRequest).toBeUndefined();
    if (kind === "structured") expect(f.state.agentSessions!.main).toEqual(session); else expect(f.state.agentSessionIds.main).toBe(session.nativeId);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("rechecks actual Session binding after the shared asynchronous resource validator", async () => {
    const f = await fixture(), input = await f.body(); input.proposal.agents.main.harness = "claude-code";
    const resolve = f.skills.resolveConfigured.bind(f.skills);
    vi.spyOn(f.skills, "resolveConfigured").mockImplementationOnce(async (...args) => {
      const result = await resolve(...args);
      f.state.agentSessions!.main = { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "bound-during-skill-validation", generation: 0, durable: true, createdAt: f.state.createdAt };
      return result;
    });
    await expect(f.orchestrator.prepareWorkflowConfiguration(f.state, input.proposal)).rejects.toThrow(/现有 session.*Harness/);
    expect((await request(f.app).get(f.url).expect(200)).body.records).toEqual([]);
  });

  it("derives the public Harness constraint from the actual Session and refuses a conflicting projected configuration", async () => {
    const f = await fixture(); f.state.agents.main.harness = "claude-code";
    f.state.agentSessions!.main = { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "actual-bound-session", generation: 0, durable: true, createdAt: f.state.createdAt };
    const current = await request(f.app).get(f.url).expect(200);
    expect(current.body.constraints.agentHarnesses.main.harnessId).toBe("codex");
    expect(JSON.stringify(current.body.constraints)).not.toContain("actual-bound-session");
    const input = await f.body(); await request(f.app).post(f.url).send(input).expect(400);
    expect((await request(f.app).get(f.url).expect(200)).body.records).toEqual([]);
  });

  it.each(["structured", "legacy"])("protects the canonical legacy collaboration %s Session for the same Agent", async kind => {
    const f = await fixture(), key = collaborationSessionKey("main", { role: "leader", nodeRunId: "original-node", groupRunId: "original-group", coordinatorEpoch: 1 });
    const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "test", nativeId: "original-role-session", generation: 0, durable: true, createdAt: f.state.createdAt };
    if (kind === "structured") f.state.agentSessions![key] = session; else f.state.agentSessionIds[key] = session.nativeId;
    const context = await request(f.app).get(f.url).expect(200);
    const input = await f.body(); input.proposal.agents.main.harness = "claude-code";
    const result = await request(f.app).post(f.url).send(input);
    console.info(JSON.stringify({ experiment: "legacy-session-harness-guard", kind, status: result.status,
      constraints: context.body.constraints ?? null }));
    expect(result.status).toBe(400); expect(context.body.constraints.agentHarnesses.main.harnessId).toBe("codex");
    expect(f.state.agentSessionIds[key] ?? f.state.agentSessions![key]?.nativeId).toBe(session.nativeId);
    expect((await request(f.app).get(f.url).expect(200)).body.records).toEqual([]);
  });

  it.each(["structured", "legacy"])("allows compatible instruction edits when an original %s Session binds during validation", async kind => {
    const f = await fixture(), input = await f.body(); input.proposal.agents.main.instructions = "Accepted future instructions with original Harness";
    const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "test", nativeId: "retained-compatible-session", generation: 0, durable: true, createdAt: f.state.createdAt };
    f.hooks.validate = async () => { if (kind === "structured") f.state.agentSessions!.main = session; else f.state.agentSessionIds.main = session.nativeId; };
    await request(f.app).post(f.url).send(input).expect(202); runnable(f);
    await f.coordinator.applyWaitingWorkflowAdjustments(f.state);
    expect(f.database.workflowAdjustments(f.state.id)[0]).toMatchObject({ status: "applied", proposal: input.proposal });
    expect(f.database.projectState(f.state.id).workflowRevision).toBe(2);
    expect(f.state.agents.main.instructions).toBe(input.proposal.agents.main.instructions);
    if (kind === "structured") expect(f.state.agentSessions!.main).toEqual(session); else expect(f.state.agentSessionIds.main).toBe(session.nativeId);
    for (const spy of [f.run, f.pause, f.resume, f.cancel]) expect(spy).not.toHaveBeenCalled();
  });

  it("retains the immutable Harness proposal even when validation mutates its temporary copy", async () => {
    const f = await fixture(), input = await f.body(); input.proposal.agents.main.harness = "claude-code";
    await request(f.app).post(f.url).send(input).expect(202); runnable(f);
    f.hooks.validate = async proposal => {
      f.state.agentSessions!.main = { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "original-before-publication", generation: 0, durable: true, createdAt: f.state.createdAt };
      proposal.agents.main.harness = "codex";
    };
    await f.coordinator.applyWaitingWorkflowAdjustments(f.state);
    expect(f.database.workflowAdjustments(f.state.id)[0]).toMatchObject({ status: "pending", proposal: input.proposal,
      waitingReason: expect.stringMatching(/现有 session.*Harness/) });
    expect(f.database.projectState(f.state.id).workflowRevision).toBe(1);
  });

  it("preserves a real withdrawal that wins while publication validation observes a late Session", async () => {
    const f = await fixture(), input = await f.body(); input.proposal.agents.main.harness = "claude-code";
    await request(f.app).post(f.url).send(input).expect(202); runnable(f);
    f.hooks.validate = async () => {
      f.state.agentSessions!.main = { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "retained-after-withdrawal", generation: 0, durable: true, createdAt: f.state.createdAt };
      await request(f.app).post(`${f.url}/${encodeURIComponent(input.requestId)}/withdraw`).send({ operationId: "during-validation", note: "原撤回说明" }).expect(200);
    };
    await f.coordinator.applyWaitingWorkflowAdjustments(f.state);
    const record = f.database.workflowAdjustments(f.state.id)[0];
    expect(record).toMatchObject({ status: "withdrawn", proposal: input.proposal });
    expect(record.history.at(-1)).toMatchObject({ status: "withdrawn", operationId: "during-validation", note: "原撤回说明" });
    expect(f.database.projectState(f.state.id).workflowRevision).toBe(1); expect(f.state.pauseRequest).toBeUndefined();
  });

});
