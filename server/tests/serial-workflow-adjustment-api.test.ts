import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Orchestrator } from "../src/orchestrator.js";
import { CollaborationRuntimeCoordinator } from "../src/collaboration-runtime.js";
import { startControlActionBridge, type ControlActionService } from "../src/orchestration-control-bridge.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { defaultDecisionPlan } from "../src/agent-orchestration.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/harness-runtime/registry.js";
import type { AgentRunner, ProjectState } from "../src/types.js";
import type { WorkflowAdjustmentContext } from "../src/workflow-adjustments.js";

const roots: string[] = [], runtimes: Orchestrator[] = [], releases: Array<() => void> = [];
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openfars-serial-user-api-")); roots.push(root);
  const entered = deferred(), release = deferred(); releases.push(release.resolve);
  const hub = new EventHub(), storage = new ProjectStorage(root, hub), skills = new SkillCatalog([]), calls: ProjectState[] = [];
  let orchestrator!: Orchestrator, authority!: ControlActionService;
  const coordinator = new CollaborationRuntimeCoordinator({ storage, databasePath: join(root, "journal.sqlite"),
    validateWorkflowConfiguration: (state, proposal) => orchestrator.prepareWorkflowConfiguration(state, proposal) });
  const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "controlled-backend", nativeId: "original-worker-session", generation: 0, durable: true, createdAt: new Date().toISOString() };
  const runner: AgentRunner = {
    harnessCatalog: async () => harnessCatalogRegistry.list().map(entry => toPublicHarnessDescriptor(entry, { available: true })),
    run: async run => {
      calls.push(structuredClone(run.project));
      if (run.agent === "idea") {
        await run.onDurableSessionStarted?.(session, session.nativeId);
        entered.resolve(); await release.promise;
        return { threadId: session.nativeId, handoff: "Original Worker handoff after its own task finishes" };
      }
      const accepted = await authority.stageWithResult(run.control!.capability, "original-main-completion",
        { tool: "complete_project", rationale: "The controlled original workflow is complete" });
      return { handoff: "Original Main completes the bounded backend check", controlActions: [accepted.envelope] };
    }
  };
  const bridgeFactory = async (service: ControlActionService, path: string) => { authority = service; return startControlActionBridge(service, path); };
  orchestrator = new Orchestrator(storage, skills, runner, { retryBaseMs: 1, retryMaxMs: 1, controlBridgeFactory: bridgeFactory }, undefined, coordinator);
  runtimes.push(orchestrator); await orchestrator.initialize();
  const project = await orchestrator.createProject({ title: "Non Git live workflow", requirement: "Preserve the original running task and Session.",
    orchestration: { agents: [{ name: "main", template: "main" }, { name: "idea", template: "idea" }], input: { source: "input", target: "idea" },
      routes: { main: [{ target: "idea", kind: "weak" }], idea: [{ target: "main", kind: "strong" }] },
      decisionPlans: { main: defaultDecisionPlan("main"), idea: defaultDecisionPlan("idea") }, allowMainReconfiguration: false,
      allowUserIntervention: true, termination: { agent: "main", condition: "Main completes the bounded check", decisionBy: "main", automatic: false }, resultFormat: { presets: [], custom: "" } },
    agents: { main: { model: "test-model", instructions: "Original Main instructions", skills: [], autoSkills: [] },
      idea: { model: "test-model", instructions: "Original Worker instructions", skills: [], autoSkills: [] } } });
  await entered.promise;
  const app = createApp({ orchestrator, storage, eventHub: hub, skills, config: { modelSuggestions: ["test-model"], maxEventHistory: 10 } });
  const url = `/api/projects/${project.id}/workflow/adjustments`;
  const body = async (id: string, agent = "idea") => {
    const context = (await request(app).get(url).expect(200)).body as WorkflowAdjustmentContext;
    context.current.snapshot.agents[agent].instructions = `Exact immutable user proposal ${id}`;
    return { requestId: id, base: context.current.version, proposal: context.current.snapshot, explanation: `Original user explanation ${id}` };
  };
  return { root, app, url, project, orchestrator, coordinator, storage, skills, runner, bridgeFactory, session, calls, release, body };
}

describe("Non Git workflow adjustments through the actual HTTP and backend path", () => {
  it("exposes the shared current version, paged records and conditional reads for the original live project", async () => {
    const f = await fixture(), response = await request(f.app).get(f.url).expect(200);
    expect(response.body.current.version.revision).toBe(1); expect(response.body.records).toEqual([]);
    expect(response.body.constraints.agentHarnesses.idea.harnessId).toBe("codex");
    await request(f.app).get(f.url).set("If-None-Match", response.headers.etag).expect(304);
    const page = await request(f.app).get(`${f.url}/history`).expect(200);
    expect(page.body.records).toEqual([]);
    expect(f.calls).toHaveLength(1);
    const projection = f.coordinator.database().projectState(f.project.id);
    expect(projection.nodeRuns).toEqual([]); expect(projection.groupRuns).toEqual([]); expect(projection.executions).toEqual([]);
  });

  it("accepts an immutable user proposal while its affected original Worker runs, without waking Main, and applies after that task ends", async () => {
    const f = await fixture(), input = await f.body("original-user-request"), before = await f.storage.loadState(f.project.id);
    const accepted = await request(f.app).post(f.url).send(input).expect(202);
    expect(accepted.body.record).toMatchObject({ requestId: input.requestId, status: "pending", source: { kind: "user" } });
    expect(f.calls).toHaveLength(1);
    const running = await f.storage.loadState(f.project.id);
    expect(running.status).toBe("running"); expect(running.activeAgentExecution).toEqual(before.activeAgentExecution);
    expect(running.agentSessions!.idea).toEqual(f.session); expect(running.agents.idea.instructions).toBe("Original Worker instructions");
    input.proposal.agents.idea.instructions = "Later browser draft must not alter acceptance";
    f.release.resolve(); await f.orchestrator.waitForIdle(f.project.id);
    const state = await f.storage.loadState(f.project.id), result = await request(f.app).get(`${f.url}/requests/${encodeURIComponent(input.requestId)}`).expect(200);
    expect(state.status).toBe("completed"); expect(state.workflowRevision).toBe(2);
    expect(state.agents.idea.instructions).toBe("Exact immutable user proposal original-user-request");
    expect(state.agentSessions!.idea).toEqual(f.session); expect(state.executionCounts!.idea).toBe(1); expect(state.runCounts.idea).toBe(1);
    expect(f.calls).toHaveLength(2); expect(f.calls[1].workflowRevision).toBe(2);
    expect(result.body.record).toMatchObject({ status: "applied", explanation: input.explanation });
  });

  it("can apply an unrelated Agent edit during the original invocation even when Main modification permission is disabled", async () => {
    const f = await fixture(), input = await f.body("unrelated-user-request", "main"), before = await f.storage.loadState(f.project.id);
    const result = await request(f.app).post(f.url).send(input).expect(202);
    expect(result.body.record.status).toBe("applied"); expect(result.body.record.history.at(-1).appliedVersion.revision).toBe(2);
    const state = await f.storage.loadState(f.project.id);
    expect(state.orchestration.allowMainReconfiguration).toBe(false); expect(state.agents.main.instructions).toBe(input.proposal.agents.main.instructions);
    expect(state.activeAgentExecution).toEqual(before.activeAgentExecution); expect(state.agentSessions!.idea).toEqual(f.session);
    expect(state.executionCounts).toEqual(before.executionCounts); expect(state.runCounts).toEqual(before.runCounts); expect(f.calls).toHaveLength(1);
  });

  it("withdraws the exact pending user request idempotently and never revives it when the original task ends", async () => {
    const f = await fixture(), input = await f.body("withdraw-original-user");
    await request(f.app).post(f.url).send(input).expect(202);
    const url = `${f.url}/${input.requestId}/withdraw`, operation = { operationId: "original-withdrawal", note: "Original user withdrawal explanation" };
    const result = await request(f.app).post(url).send(operation).expect(200);
    expect(result.body).toMatchObject({ withdrawn: true, record: { status: "withdrawn", proposal: input.proposal } });
    expect((await request(f.app).post(url).send(operation).expect(200)).body.replay).toBe(true);
    expect(f.calls).toHaveLength(1);
    f.release.resolve(); await f.orchestrator.waitForIdle(f.project.id);
    const state = await f.storage.loadState(f.project.id), record = (await request(f.app).get(`${f.url}/requests/${input.requestId}`).expect(200)).body.record;
    expect(state.status).toBe("completed"); expect(state.workflowRevision).toBe(1); expect(state.agents.idea.instructions).toBe("Original Worker instructions");
    expect(record.status).toBe("withdrawn"); expect(record.history.at(-1).note).toBe(operation.note); expect(state.agentSessions!.idea).toEqual(f.session);
  });

  it("replaces only the user's exact pending request and keeps an old replay replaced through publication", async () => {
    const f = await fixture(), first = await f.body("original-user-first");
    await request(f.app).post(f.url).send(first).expect(202);
    const second = { ...await f.body("original-user-second"), replacesRequestId: first.requestId };
    await request(f.app).post(f.url).send(second).expect(202);
    const replay = await request(f.app).post(f.url).send(first).expect(200);
    expect(replay.body).toMatchObject({ replay: true, record: { status: "replaced", requestId: first.requestId } });
    const records = (await request(f.app).get(f.url).expect(200)).body.records;
    expect(records.filter((record: { status: string }) => record.status === "pending").map((record: { requestId: string }) => record.requestId)).toEqual([second.requestId]);
    expect(f.calls).toHaveLength(1); f.release.resolve(); await f.orchestrator.waitForIdle(f.project.id);
    const state = await f.storage.loadState(f.project.id);
    expect(state.agents.idea.instructions).toBe(second.proposal.agents.idea.instructions); expect(state.workflowRevision).toBe(2);
    expect(state.executionCounts!.idea).toBe(1); expect(state.agentSessions!.idea).toEqual(f.session);
  });

  it("rejects an old formal base after a real unrelated publication and requires the user to submit against the new version", async () => {
    const f = await fixture(), stale = await f.body("old-browser-base");
    const published = await f.body("published-other-agent", "main");
    await request(f.app).post(f.url).send(published).expect(202);
    await request(f.app).post(f.url).send(stale).expect(409);
    expect((await request(f.app).get(f.url).expect(200)).body.records).toHaveLength(1);
    const current = await f.body("explicit-new-base"); expect(current.base.revision).toBe(2);
    await request(f.app).post(f.url).send(current).expect(202);
    f.release.resolve(); await f.orchestrator.waitForIdle(f.project.id);
    const state = await f.storage.loadState(f.project.id);
    expect(state.workflowRevision).toBe(3); expect(state.agents.idea.instructions).toBe(current.proposal.agents.idea.instructions);
    expect(state.agents.main.instructions).toBe(published.proposal.agents.main.instructions);
  });

  it("preserves a pending user request and the original next task across a real paused writer restart", async () => {
    const f = await fixture(), input = await f.body("original-user-restart");
    await f.orchestrator.pause(f.project.id); await request(f.app).post(f.url).send(input).expect(202);
    f.release.resolve(); await f.orchestrator.waitForIdle(f.project.id);
    const paused = await f.storage.loadState(f.project.id), original = (await request(f.app).get(`${f.url}/requests/${input.requestId}`).expect(200)).body.record;
    expect(paused.status).toBe("paused"); expect(original.status).toBe("pending"); expect(f.calls).toHaveLength(1);
    const taskId = paused.activeAgentExecution!.id;
    await f.orchestrator.shutdown();
    const storage = new ProjectStorage(f.root, new EventHub()); let restarted!: Orchestrator;
    const coordinator = new CollaborationRuntimeCoordinator({ storage, databasePath: join(f.root, "journal.sqlite"),
      validateWorkflowConfiguration: (state, proposal) => restarted.prepareWorkflowConfiguration(state, proposal) });
    restarted = new Orchestrator(storage, new SkillCatalog([]), f.runner, { retryBaseMs: 1, retryMaxMs: 1, controlBridgeFactory: f.bridgeFactory }, undefined, coordinator);
    runtimes.push(restarted); await restarted.initialize();
    const recovered = await storage.loadState(f.project.id);
    expect(recovered.status).toBe("paused"); expect(recovered.activeAgentExecution!.id).toBe(taskId); expect(f.calls).toHaveLength(1);
    expect(coordinator.getWorkflowAdjustmentDetail(recovered, input.requestId).record).toEqual(original);
    expect(recovered.agentSessions!.idea).toEqual(f.session); expect(recovered.executionCounts).toEqual(paused.executionCounts);
    await restarted.resume(f.project.id); await restarted.waitForIdle(f.project.id);
    const state = await storage.loadState(f.project.id);
    expect(state.status).toBe("completed"); expect(state.workflowRevision).toBe(2); expect(f.calls).toHaveLength(2);
    expect(f.calls[1].activeAgentExecution!.id).toBe(taskId); expect(state.agentSessions!.idea).toEqual(f.session);
    expect(state.executionCounts!.idea).toBe(1); expect(state.runCounts.idea).toBe(1);
    expect(coordinator.getWorkflowAdjustmentDetail(state, input.requestId).record.status).toBe("applied");
  });
});
