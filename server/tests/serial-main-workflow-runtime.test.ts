import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishAgentContextIndex, type AgentContextSource } from "../src/agent-context-index.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Orchestrator } from "../src/orchestrator.js";
import { CollaborationRuntimeCoordinator } from "../src/collaboration-runtime.js";
import { ControlActionService, startControlActionBridge } from "../src/orchestration-control-bridge.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { defaultDecisionPlan } from "../src/agent-orchestration.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/harness-runtime/registry.js";
import type { MainAgentOrchestrationDocument } from "../src/agent-orchestration-reconfiguration.js";
import { MAIN_AGENT_ORCHESTRATION_CURRENT_FILE } from "../src/agent-orchestration-reconfiguration.js";
import type { AgentRunRequest, AgentRunner, ControlActionEnvelope, ProjectState } from "../src/types.js";
import { serializeInvocationControlContext } from "../src/harness-runtime/runtime-support.js";

const roots: string[] = [], running: Orchestrator[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(runtime => runtime.shutdown())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openfars-serial-main-")); roots.push(root);
  const storage = new ProjectStorage(root, new EventHub()), calls: ProjectState[] = [];
  let authority!: ControlActionService;
  const hooks: { beforeRun?: (request: AgentRunRequest, service: ControlActionService) => Promise<void>; afterAccepted?: (request: AgentRunRequest, service: ControlActionService, envelope: ControlActionEnvelope) => Promise<void> } = {};
  let orchestrator!: Orchestrator;
  const coordinator = new CollaborationRuntimeCoordinator({ storage, databasePath: join(root, "journal.sqlite"),
    validateWorkflowConfiguration: (state, proposal) => orchestrator.prepareWorkflowConfiguration(state, proposal) });
  const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "controlled-backend", nativeId: "original-main-session", generation: 0, durable: true, createdAt: new Date().toISOString() };
  const runner: AgentRunner = {
    harnessCatalog: async () => harnessCatalogRegistry.list().map(entry => toPublicHarnessDescriptor(entry, { available: true })),
    run: async (request: AgentRunRequest) => {
      calls.push(structuredClone(request.project));
      await request.onDurableSessionStarted?.(session, session.nativeId);
      await hooks.beforeRun?.(request, authority);
      if (calls.length === 1) {
        const workflow = join(request.workspacePath, "workflow.json");
        const proposal = JSON.parse(await readFile(workflow, "utf8")) as MainAgentOrchestrationDocument;
        proposal.agents.main.instructions = "Exact Main instructions accepted at the live tool boundary";
        await writeFile(workflow, JSON.stringify(proposal));
        const accepted = await authority.stageWithResult(request.control!.capability, "original-main-workflow-call", { tool: "apply_workflow", path: "workflow.json", rationale: "Original Main public explanation" });
        proposal.agents.main.instructions = "Changed file after the original tool was accepted";
        await writeFile(workflow, JSON.stringify(proposal));
        await hooks.afterAccepted?.(request, authority, accepted.envelope);
        return { threadId: session.nativeId, handoff: "Original Main handoff", controlActions: [accepted.envelope] };
      }
      const accepted = await authority.stageWithResult(request.control!.capability, "original-main-completion", { tool: "complete_project", rationale: "The bounded backend check is complete" });
      return { threadId: session.nativeId, handoff: "Original Main continuation completed", controlActions: [accepted.envelope] };
    }
  };
  orchestrator = new Orchestrator(storage, new SkillCatalog([]), runner, { retryBaseMs: 1, retryMaxMs: 1,
    controlBridgeFactory: async (service, path) => { authority = service; return startControlActionBridge(service, path); } }, undefined, coordinator);
  running.push(orchestrator); await orchestrator.initialize();
  return { root, orchestrator, coordinator, storage, calls, session, hooks };
}

async function create(f: Awaited<ReturnType<typeof fixture>>) {
  return f.orchestrator.createProject({ title: "Immutable Main workflow", requirement: "Preserve the actual accepted Main proposal.",
    orchestration: { agents: [{ name: "main", template: "main" }], input: { source: "input", target: "main" }, routes: { main: [] }, decisionPlans: { main: defaultDecisionPlan("main") },
      allowMainReconfiguration: true, allowUserIntervention: true, termination: { agent: "main", condition: "Original Main completes the bounded check", decisionBy: "main", automatic: false }, resultFormat: { presets: [], custom: "" } },
    agents: { main: { model: "test-model", instructions: "Original configured Main instructions", skills: [], autoSkills: [] } } });
}

describe("Main workflow proposals on the actual serial backend path", () => {
  it("workflow continuity: retries an accepted configuration publication without rerunning Main's committed proposal", async () => {
    const f = await fixture();
    const publish = f.coordinator.publishSerialMainWorkflowAdjustment.bind(f.coordinator);
    let publicationAttempts = 0;
    vi.spyOn(f.coordinator, "publishSerialMainWorkflowAdjustment").mockImplementation(async (...args) => {
      publicationAttempts++;
      if (publicationAttempts <= 2) throw new Error("Temporary configuration publication failure");
      return publish(...args);
    });
    const project = await create(f);
    await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id);
    expect(state.status).toBe("completed");
    expect(state.workflowRevision).toBe(2);
    expect(state.agentSessions!.main).toEqual(f.session);
    expect(f.calls).toHaveLength(2);
    expect(state.runCounts.main).toBe(2);
    expect(f.coordinator.getWorkflowAdjustments(state).records).toHaveLength(1);
    expect(publicationAttempts).toBe(3);
    const events = await f.storage.readEvents(project.id, 0, 1000);
    expect(events.filter(event => event.message.includes("publication recovery will retry automatically"))).toHaveLength(2);
    expect(events.filter(event => event.type === "agent.failed")).toHaveLength(0);
    expect(state.workflowRecovery).toBeUndefined();
  });

  it("automatically binds the formal state MCP on the real serial backend, shares system writes and preserves the original Session through configuration changes", async () => {
    const f = await fixture(); let originalService!: ControlActionService, originalCapability = "";
    f.hooks.beforeRun = async (run, service) => {
      expect(run.control?.projectState).toBe(true); expect(run.onProjectStateRequest).toBeTypeOf("function");
      const object = { kind: "project", id: run.project.id };
      if (f.calls.length === 2) {
        const current = await run.onProjectStateRequest!({ operation: "get", object }) as { extensions: unknown };
        expect(current.extensions).toEqual({ completed: true, business_progress: { processed: 2, notes: ["first Main assessment"] } });
        return;
      }
      originalService = service; originalCapability = run.control!.capability;
      const before = await service.requestProjectState(originalCapability, { operation: "get", object }) as { version: string };
      const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("../src/orchestration-control-mcp.ts", import.meta.url))], { cwd: run.projectPath,
        env: { ...process.env, SCIENCEEVOLVE_CONTROL_CAPABILITY: originalCapability,
          SCIENCEEVOLVE_CONTROL_CONTEXT: serializeInvocationControlContext(run.control!, { projectId: run.project.id, agent: run.agent,
            invocationId: run.invocationId, kind: run.kind, workspacePath: run.workspacePath }) }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      const finished = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(stderr))); });
      child.stdin.end([{ id: 1, method: "tools/list" },
        { id: 2, method: "tools/call", params: { name: "state_patch", arguments: { object, expectedVersion: before.version,
          set: { completed: true, business_progress: { processed: 2, notes: ["first Main assessment"] } }, reason: "Main's own bounded business fields", callId: "shared-state-progress" } } },
        { id: 3, method: "tools/call", params: { name: "state_get", arguments: { object } } },
        { id: 4, method: "tools/call", params: { name: "state_list", arguments: { projectId: "foreign-project" } } }
      ].map(r => JSON.stringify(r)).join("\n") + "\n");
      await finished;
      const responses = stdout.trim().split("\n").map(line => JSON.parse(line));
      const names = responses[0].result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["state_list", "state_get", "state_patch"]));
      expect(names).not.toContain("state_reconcile_pull");
      expect(responses[1].result.isError).not.toBe(true);
      expect(responses[2].result.structuredContent.core.formalState.checkpoint.lifecycle.status).toBe("running");
      expect(responses[3].result.isError).toBe(true);
    };
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id), document = f.coordinator.projectStateDocuments().read(project.id, "project.checkpoint")!;
    expect(state.status).toBe("completed"); expect(state.agentSessions!.main).toEqual(f.session); expect(f.calls).toHaveLength(2);
    const view = JSON.parse(await readFile(join(f.storage.projectDir(project.id), "state.json"), "utf8"));
    expect(view.formalState).toMatchObject({ source: "sqlite", version: document.version }); expect(view.view.status).toBe("completed");
    await expect(originalService.requestProjectState(originalCapability, { operation: "get", object: { kind: "project", id: project.id } })).rejects.toThrow(/revoked|sealed/);
  });

  it("retains unfinished authoring bytes on the actual next Main call and rejects their stale base before accepting another proposal", async () => {
    const f = await fixture(); let original: Buffer | undefined, staleRejected = false;
    f.hooks.afterAccepted = async run => { original = await readFile(join(run.workspacePath, "workflow.json")); };
    f.hooks.beforeRun = async (run, service) => {
      if (f.calls.length !== 2) return;
      expect(await readFile(join(run.workspacePath, "workflow.json"))).toEqual(original);
      const current = JSON.parse(await readFile(join(run.workspacePath, MAIN_AGENT_ORCHESTRATION_CURRENT_FILE), "utf8"));
      expect(current.agents.main.instructions).toBe("Exact Main instructions accepted at the live tool boundary");
      expect(current.baseHash).not.toBe(JSON.parse(original!.toString("utf8")).baseHash);
      expect(current.baseVersion).toEqual(f.coordinator.getWorkflowAdjustments(run.project).current.version);
      expect(current.baseVersion.revision).toBe(2); expect(JSON.parse(original!.toString("utf8")).baseVersion.revision).toBe(1);
      await expect(service.stageWithResult(run.control!.capability, "stale-original-main-draft", { tool: "apply_workflow", path: "workflow.json", rationale: "Attempt to apply the retained old base" })).rejects.toThrow("workflow.json is stale");
      staleRejected = true;
      expect((await readFile(run.inboxPath, "utf8")).includes(MAIN_AGENT_ORCHESTRATION_CURRENT_FILE)).toBe(true);
    };
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id);
    expect(staleRejected).toBe(true); expect(f.calls).toHaveLength(2); expect(state.status).toBe("completed");
    expect(f.coordinator.getWorkflowAdjustments(state).records).toHaveLength(1);
    expect(state.agentSessions!.main).toEqual(f.session); expect(state.runCounts.main).toBe(2);
  });

  it("attaches notifications to the next actual original Main continuation without starting an additional task or Session", async () => {
    const f = await fixture(); const inputs: string[] = [];
    f.hooks.beforeRun = async request => {
      expect(request.onPrepareWorkflowAdjustmentInput).toBeTypeOf("function");
      expect(request.onWorkflowAdjustmentInputReceived).toBeTypeOf("function");
      const inputId = `actual-original-input-${inputs.length}`;
      const published: AgentContextSource[] = [];
      const text = await request.onPrepareWorkflowAdjustmentInput!({ inputId, expectedSession: f.session,
        publishContext: async sources => {
          published.push(...sources);
          return (await publishAgentContextIndex(request.inboxPath, sources))?.preview ?? "";
        } });
      inputs.push(text);
      if (text) {
        expect(text).toContain("source=workflow-updates");
        expect(text).toContain("Context index:");
        expect(text).not.toContain("Original Main public explanation");
        expect(published.find(source => source.key === "workflow-updates")?.records).toMatchObject([
          { record: { explanation: "Original Main public explanation" }, transition: { status: "applied" } }
        ]);
        await request.onWorkflowAdjustmentInputReceived!({ kind: "user.message", eventId: "controlled-native-reception",
          invocationId: request.invocationId, harnessId: f.session.harnessId, message: `${text}\nOriginal continuation input` }, f.session, inputId);
        expect(await request.onPrepareWorkflowAdjustmentInput!({ inputId: "same-session-next-legal-input", expectedSession: f.session })).toBe("");
      }
    };
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id);
    expect(inputs).toHaveLength(2); expect(inputs[0]).toBe(""); expect(inputs[1]).not.toBe("");
    expect(state.status).toBe("completed"); expect(state.agentSessions!.main).toEqual(f.session);
    expect(state.runCounts.main).toBe(2); expect(state.executionCounts!.main).toBe(2);
  });

  it("uses the exact proposal accepted by the live tool after the mutable file changes, preserving the original Session and actual version history", async () => {
    const f = await fixture();
    const project = await create(f);
    await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id);
    expect(state.status).toBe("completed"); expect(f.calls).toHaveLength(2);
    expect(state.agents.main.instructions).toBe("Exact Main instructions accepted at the live tool boundary");
    expect(state.agentSessions!.main).toEqual(f.session); expect(state.runCounts.main).toBe(2); expect(state.executionCounts!.main).toBe(2);
    expect(state.workflowRevision).toBe(2);
    const context = f.coordinator.getWorkflowAdjustments(state);
    expect(context.records).toHaveLength(1); expect(context.records[0]).toMatchObject({ status: "applied", explanation: "Original Main public explanation",
      source: { kind: "main", invocationId: f.calls[0].activeInvocationId, callId: "original-main-workflow-call", scope: { kind: "serial" } },
      proposal: { agents: { main: { instructions: "Exact Main instructions accepted at the live tool boundary" } } } });
    expect(context.records[0].history.at(-1)?.appliedVersion).toEqual(context.current.version);
  });

  it("persists acceptance before returning the live tool receipt and publishes only after the original result commit", async () => {
    const f = await fixture(); let committed = false, accepted = false;
    const commit = f.storage.commitInvocationCommit.bind(f.storage);
    vi.spyOn(f.storage, "commitInvocationCommit").mockImplementation(async (...args) => {
      if (!committed) {
        const context = f.coordinator.getWorkflowAdjustments(args[0]);
        expect(context.records[0].status).toBe("pending"); expect(context.current.version.revision).toBe(1);
      }
      await commit(...args); committed = true;
    });
    const publish = f.coordinator.publishSerialMainWorkflowAdjustment.bind(f.coordinator);
    vi.spyOn(f.coordinator, "publishSerialMainWorkflowAdjustment").mockImplementation(async (...args) => {
      expect(accepted).toBe(true); expect(committed).toBe(true);
      expect(f.storage.hasActiveInvocationCommit(args[0].id)).toBe(false);
      return publish(...args);
    });
    f.hooks.afterAccepted = async request => {
      const context = f.coordinator.getWorkflowAdjustments(request.project);
      expect(context.records[0]).toMatchObject({ status: "pending", explanation: "Original Main public explanation" });
      expect(context.current.version.revision).toBe(1);
      expect(request.project.agents.main.instructions).toBe("Original configured Main instructions");
      accepted = true;
    };
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    expect(accepted).toBe(true); expect((await f.storage.loadState(project.id)).workflowRevision).toBe(2);
  });

  it("returns the original accepted record for an equivalent live retry without rereading the changed file", async () => {
    const f = await fixture(); let replayed = false;
    f.hooks.afterAccepted = async (request, authority, original) => {
      const replay = await authority.stageWithResult(request.control!.capability, "equivalent-new-native-call",
        { tool: "apply_workflow", path: "workflow.json", rationale: "Original Main public explanation" });
      expect(replay.envelope).toEqual(original);
      expect(f.coordinator.getWorkflowAdjustments(request.project).records).toHaveLength(1); replayed = true;
    };
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    expect(replayed).toBe(true);
    expect((await f.storage.loadState(project.id)).agents.main.instructions).toBe("Exact Main instructions accepted at the live tool boundary");
  });

  it("preserves the accepted request and original Main continuation while paused, then publishes after explicit resume", async () => {
    const f = await fixture(); f.hooks.afterAccepted = async request => { await f.orchestrator.pause(request.project.id); };
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const paused = await f.storage.loadState(project.id), before = f.coordinator.getWorkflowAdjustments(paused);
    expect(paused.status).toBe("paused"); expect(paused.workflowRevision).toBe(1); expect(f.calls).toHaveLength(1);
    expect(before.records[0]).toMatchObject({ status: "pending", waitingReason: expect.stringContaining("暂停") });
    expect(paused.agentSessions!.main).toEqual(f.session); expect(paused.executionCounts!.main).toBe(1);
    const continuation = paused.activeAgentExecution!.id, requestId = before.records[0].requestId;
    await f.orchestrator.resume(project.id); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id), after = f.coordinator.getWorkflowAdjustments(state);
    expect(state.status).toBe("completed"); expect(state.workflowRevision).toBe(2); expect(f.calls).toHaveLength(2);
    expect(f.calls[1].activeAgentExecution!.id).toBe(continuation);
    expect(after.records[0]).toMatchObject({ requestId, status: "applied" }); expect(state.agentSessions!.main).toEqual(f.session);
  });

  it("keeps the exact accepted request pending when the original result transaction rolls back", async () => {
    const f = await fixture(), commit = f.storage.commitInvocationCommit.bind(f.storage);
    let failed = false;
    vi.spyOn(f.storage, "commitInvocationCommit").mockImplementation(async (...args) => {
      if (!failed) { failed = true; throw new Error("Original result commit failed before persistence"); }
      return commit(...args);
    });
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id), context = f.coordinator.getWorkflowAdjustments(state);
    expect(failed).toBe(true); expect(state.workflowRevision).toBe(1);
    expect(state.agents.main.instructions).toBe("Original configured Main instructions");
    expect(context.records).toHaveLength(1);
    expect(context.records[0]).toMatchObject({ status: "pending", proposal: { agents: { main: { instructions: "Exact Main instructions accepted at the live tool boundary" } } } });
    expect((await f.storage.readEvents(project.id, 0, 1000)).filter(event => event.type === "workflow.reconfigured")).toHaveLength(0);
  });

  it("recovers the exact committed original boundary across a real writer restart without waking a completed Main", async () => {
    const f = await fixture(); vi.spyOn(f.coordinator, "recordSerialMainWorkflowBoundary").mockImplementation(() => {});
    vi.spyOn(f.coordinator, "recoverSerialMainWorkflowBoundaries").mockImplementation(async () => {});
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const before = await f.storage.loadState(project.id), original = f.coordinator.getWorkflowAdjustments(before).records[0];
    expect(before.status).toBe("completed"); expect(before.workflowRevision).toBe(1); expect(original.status).toBe("pending");
    await f.orchestrator.shutdown();
    const storage = new ProjectStorage(f.root, new EventHub()); let restarted!: Orchestrator;
    const coordinator = new CollaborationRuntimeCoordinator({ storage, databasePath: join(f.root, "journal.sqlite"),
      validateWorkflowConfiguration: (state, proposal) => restarted.prepareWorkflowConfiguration(state, proposal) });
    const run = vi.fn(async () => { throw new Error("Completed original Main must not be woken by recovery"); });
    restarted = new Orchestrator(storage, new SkillCatalog([]), { run,
      harnessCatalog: async () => harnessCatalogRegistry.list().map(entry => toPublicHarnessDescriptor(entry, { available: true }))
    }, { retryBaseMs: 1, retryMaxMs: 1 }, undefined, coordinator);
    running.push(restarted); await restarted.initialize();
    const state = await storage.loadState(project.id);
    expect(run).not.toHaveBeenCalled(); expect(state.agentSessions).toEqual(before.agentSessions);
    expect(state.runCounts).toEqual(before.runCounts); expect(state.executionCounts).toEqual(before.executionCounts);
    expect(coordinator.getWorkflowAdjustments(state).records[0]).toEqual(original);
    const observed = vi.fn(() => "Original project remains completed");
    const retained = await coordinator.publishSerialMainWorkflowAdjustment(state, original.requestId, { sessions: state, waitingReason: observed });
    expect(observed).toHaveBeenCalledOnce(); expect(retained.status).toBe("pending"); expect(state.workflowRevision).toBe(1);
  });

  it("keeps a successfully committed Main result and its original continuation when projecting the applied revision fails", async () => {
    const f = await fixture(), refresh = f.storage.refreshRequestSnapshot.bind(f.storage);
    let failed = false, continuation = "";
    vi.spyOn(f.storage, "refreshRequestSnapshot").mockImplementation(async (...args) => {
      if (!failed && args[0].workflowRevision === 2) {
        failed = true; continuation = args[0].activeAgentExecution!.id;
        expect(args[0].runCounts.main).toBe(1);
        throw new Error("Applied workflow file projection failed");
      }
      return refresh(...args);
    });
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id), context = f.coordinator.getWorkflowAdjustments(state);
    expect(failed).toBe(true);
    expect(context.records[0].status).toBe("applied"); expect(context.current.version.revision).toBe(2);
    expect(state.status).toBe("completed"); expect(state.workflowRevision).toBe(2); expect(state.runCounts.main).toBe(2);
    expect(state.executionCounts!.main).toBe(2); expect(state.agentSessions!.main).toEqual(f.session);
    expect(f.calls).toHaveLength(2); expect(f.calls[1].activeAgentExecution!.id).toBe(continuation);
    expect(f.calls[1].agents.main.instructions).toBe("Exact Main instructions accepted at the live tool boundary");
    const events = await f.storage.readEvents(project.id, 0, 1000);
    expect(events.filter(event => event.type === "invocation.completed")).toHaveLength(2);
    expect(events.filter(event => event.type === "agent.failed")).toHaveLength(0);
  });

  it("automatically recovers a failed boundary write from the original committed event without retrying the successful Main", async () => {
    const f = await fixture();
    let continuation = "", requestId = "";
    vi.spyOn(f.coordinator, "recordSerialMainWorkflowBoundary").mockImplementationOnce((state, originalRequestId) => {
      continuation = state.activeAgentExecution!.id; requestId = originalRequestId;
      expect(state.runCounts.main).toBe(1);
      expect(f.coordinator.getWorkflowAdjustments(state).records[0].status).toBe("pending");
      throw new Error("Original boundary journal write failed");
    });
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id), record = f.coordinator.getWorkflowAdjustments(state).records[0];
    expect(state.status).toBe("completed"); expect(record).toMatchObject({ requestId, status: "applied" });
    expect(state.workflowRevision).toBe(2); expect(state.runCounts.main).toBe(2); expect(state.executionCounts!.main).toBe(2);
    expect(f.calls).toHaveLength(2); expect(f.calls[1].activeAgentExecution!.id).toBe(continuation);
    expect(state.agentSessions!.main).toEqual(f.session);
  });

  it("honors an HTTP withdrawal after the original Main tool was accepted and carries its real terminal status into the same continuation", async () => {
    const f = await fixture(); let withdrawn = false, requestId = "";
    const app = createApp({ orchestrator: f.orchestrator, storage: f.storage, eventHub: f.storage.hub,
      skills: new SkillCatalog([]), config: { modelSuggestions: ["test-model"], maxEventHistory: 10 } });
    f.hooks.afterAccepted = async run => {
      const original = f.coordinator.getWorkflowAdjustments(run.project).records[0]; requestId = original.requestId;
      const result = await request(app).post(`/api/projects/${run.project.id}/workflow/adjustments/${encodeURIComponent(requestId)}/withdraw`)
        .send({ operationId: "original-main-proposal-withdrawal", note: "User withdraws the exact accepted Main proposal" }).expect(200);
      expect(result.body).toMatchObject({ withdrawn: true, record: { requestId, status: "withdrawn", proposal: original.proposal } });
      expect(f.calls).toHaveLength(1); withdrawn = true;
    };
    const project = await create(f); await f.orchestrator.waitForIdle(project.id);
    const state = await f.storage.loadState(project.id), record = f.coordinator.getWorkflowAdjustments(state).records[0];
    expect(withdrawn).toBe(true); expect(state.status).toBe("completed"); expect(state.workflowRevision).toBe(1);
    expect(state.agents.main.instructions).toBe("Original configured Main instructions"); expect(record).toMatchObject({ requestId, status: "withdrawn" });
    expect(f.calls).toHaveLength(2); expect(f.calls[1].pendingMainDecision).toMatchObject({ reason: "workflow-reconfiguration-rejected", diagnostic: expect.stringContaining("withdrawn") });
    expect(f.calls[1].pendingMainDecision!.diagnostic).toContain("User withdraws the exact accepted Main proposal");
    expect(state.agentSessions!.main).toEqual(f.session); expect(state.runCounts.main).toBe(2); expect(state.executionCounts!.main).toBe(2);
  });
});
