import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Orchestrator } from "../src/orchestrator.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { defaultDecisionPlan } from "../src/agent-orchestration.js";
import { HarnessRuntimeError } from "../src/harness-runtime/errors.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/harness-runtime/registry.js";
import { compileInvocationPolicy, compileWorkflowPrompt } from "../src/harness-runtime/invocation-policy.js";
import type { AgentRunRequest, AgentRunResult, AgentRunner, ControlAction, ProjectState } from "../src/types.js";
import { serialTaskRecoveryMessage } from "../src/serial-task-recovery.js";
import { serialWorkflowMessages } from "../src/workflow-input.js";

const roots: string[] = [];
const runtimes: Orchestrator[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(handler: (request: AgentRunRequest, index: number) => Promise<AgentRunResult>) {
  const parent = path.resolve("../.scratch/serial-task-recovery-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "recovery-")); roots.push(root);
  const calls: AgentRunRequest[] = [];
  const runner: AgentRunner = {
    harnessCatalog: async () => harnessCatalogRegistry.list().map(entry => toPublicHarnessDescriptor(entry, { available: true })),
    run: async request => {
      calls.push({ ...request, project: structuredClone(request.project) });
      await request.onDurableSessionStarted?.({ schemaVersion: 1, harnessId: "codex", adapterVersion: "fixture",
        nativeId: `original-${request.agent}`, generation: 0, durable: true, createdAt: "2026-11-17T00:00:00Z" }, `original-${request.agent}`);
      return handler(request, calls.length - 1);
    }
  };
  const restart = async () => {
    const storage = new ProjectStorage(root, new EventHub());
    const runtime = new Orchestrator(storage, new SkillCatalog([]), runner, { retryBaseMs: 1, retryMaxMs: 1, agentConcurrency: 1 });
    runtimes.push(runtime); await runtime.initialize();
    return { runtime, storage };
  };
  return { root, calls, restart, ...await restart() };
}

function input(workerFirst = true) {
  return { title: "Original task recovery", requirement: "Inspect measured artifacts; preserve unfinished responsibility.",
    orchestration: {
      agents: [{ name: "main", template: "main" as const }, { name: "worker", template: "general" as const }],
      input: { source: "input" as const, target: workerFirst ? "worker" : "main" },
      routes: { main: [{ target: "worker", kind: "weak" as const }], worker: [{ target: "main", kind: "strong" as const }] },
      decisionPlans: { main: defaultDecisionPlan("main"), worker: defaultDecisionPlan("worker") },
      allowUserIntervention: true, allowMainReconfiguration: false,
      termination: { agent: "main", condition: "Main verifies the result", decisionBy: "main" as const, automatic: false },
      resultFormat: { presets: [], custom: "" }
    }, agents: { main: { model: "test-model", skills: [], autoSkills: [] }, worker: { model: "test-model", skills: [], autoSkills: [], sessionPersistence: false } } };
}

function result(request: AgentRunRequest, action: ControlAction, handoff = "Actual evidence checked."): AgentRunResult {
  return { handoff, threadId: `original-${request.agent}`, controlActions: [{ projectId: request.project.id, agent: request.agent,
    invocationId: request.invocationId, callId: `${request.invocationId}-${action.tool}`, stateVersion: request.control!.stateVersion,
    capabilityHash: request.control!.capabilityHash, receivedAt: new Date().toISOString(), action }] };
}

async function waitUntilIdleOrCalls(runtime: Orchestrator, projectId: string, calls: AgentRunRequest[], maximum: number) {
  // A broken unbounded requeue must fail this test without invoking a real model or hanging the suite.
  for (let i = 0; i < 400; i++) {
    const state = await runtime.getProject(projectId);
    if (["interrupted", "completed"].includes(state.status)) { await runtime.waitForIdle(projectId); return; }
    if (calls.length > maximum) { await runtime.pause(projectId); await runtime.waitForIdle(projectId); throw new Error("Original task exceeded its bounded correction allowance"); }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Original task did not reach a durable bounded boundary");
}

async function actualPrompt(request: AgentRunRequest) {
  return compileWorkflowPrompt(request, { projectPath: request.projectPath, workspacePath: request.workspacePath,
    inboxPath: request.inboxPath, memoryPath: path.join(request.workspacePath, "Memory.md"), runtimePath: request.runtimePath, inboxSha256: "fixture" },
    compileInvocationPolicy(request.project.agents[request.agent], request), { inlineInbox: await fs.readFile(request.inboxPath, "utf8") });
}

describe("retained serial task recovery", () => {
  it("delivers the exact Worker error and preserved-output references after restart/resume without repeating its write", async () => {
    let failedInvocation = "", workerCalls = 0, originalTask = "", resumedPrompt = "";
    const f = await fixture(async request => {
      if (request.agent === "main") return result(request, { tool: "complete_project", rationale: "Verified the retained result." });
      workerCalls++;
      if (workerCalls === 1) {
        originalTask = request.taskSessionId!; failedInvocation = request.invocationId;
        await fs.writeFile(path.join(request.workspacePath, "result.txt"), "Preserved measured result", { flag: "wx" });
        throw new HarnessRuntimeError("HARNESS_CONTRACT_VIOLATION", "handoff is empty; api_key=sk-private-error123456", {}, { source: "adapter", retryable: false });
      }
      expect(request.taskSessionId).toBe(originalTask);
      expect(request.resumeThreadId).toBe("original-worker");
      resumedPrompt = await actualPrompt(request);
      expect(resumedPrompt).toContain(failedInvocation);
      expect(resumedPrompt).toContain("handoff is empty");
      expect(resumedPrompt).toContain("HARNESS_CONTRACT_VIOLATION");
      expect(resumedPrompt).toContain("checkpoints/");
      expect(resumedPrompt).toContain("unverified");
      expect(resumedPrompt).not.toContain("sk-private-error123456");
      expect(resumedPrompt).toContain("repeat only the unfinished part");
      const session = request.project.taskSessionRefs![originalTask];
      const event = { kind: "user.message", invocationId: request.invocationId, message: resumedPrompt };
      await request.onNativeUserInput?.({ ...event, invocationId: "inv_other" }, session);
      await request.onNativeUserInput?.(event, { ...session, nativeId: "another-session" });
      await Promise.all([request.onNativeUserInput?.(event, session), request.onNativeUserInput?.(event, session)]);
      expect(await fs.readFile(path.join(request.workspacePath, "result.txt"), "utf8")).toBe("Preserved measured result");
      return { handoff: "Verified the existing result.txt; no repeated write.", threadId: "original-worker" };
    });
    const project = await f.runtime.createProject(input());
    await f.runtime.waitForIdle(project.id);
    expect(await f.runtime.getProject(project.id)).toMatchObject({ status: "interrupted", phase: "harness-recovery-required" });
    await f.runtime.shutdown();
    const restarted = await f.restart();
    await restarted.runtime.waitForIdle(project.id); expect(workerCalls).toBe(1);
    await restarted.runtime.resume(project.id);
    await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 5);
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "completed", executionCounts: { worker: 1, main: 1 } });
    expect(workerCalls).toBe(2);
    expect(resumedPrompt).toContain(originalTask);
    const events = await restarted.storage.readEvents(project.id);
    const staged = events.filter(event => event.data?.recoveryInput === "staged");
    const received = events.filter(event => event.data?.recoveryInput === "received");
    expect(staged).toHaveLength(1); expect(received).toHaveLength(1);
    expect(received[0].data).toMatchObject({ executionId: originalTask, previousInvocationId: failedInvocation,
      inputSha256: staged[0].data!.inputSha256, nativeSessionId: "original-worker" });
    expect(staged[0].seq).toBeLessThan(received[0].seq);

    const completedWorker = f.calls[1];
    expect(f.calls.map(call => call.agent)).toEqual(["worker", "worker", "main"]);
    const delivery = events.filter(event => ["handoff.saved", "control.action.committed", "invocation.completed"].includes(event.type));
    expect(delivery.filter(event => event.type === "invocation.completed").map(event => event.data?.invocationId))
      .toEqual([completedWorker.invocationId, f.calls[2].invocationId]);
    expect(delivery.some(event => event.type === "control.action.committed" && event.data?.tool === "complete_project")).toBe(true);
    await restarted.runtime.shutdown();
    const reopened = await f.restart();
    await reopened.runtime.waitForIdle(project.id);
    expect(await reopened.storage.readHandoff(project.id, completedWorker.invocationId, "worker"))
      .toContain("Verified the existing result.txt; no repeated write.");
    expect((await reopened.storage.readEvents(project.id)).filter(event =>
      ["handoff.saved", "control.action.committed", "invocation.completed"].includes(event.type))).toEqual(delivery);
    expect(await reopened.runtime.getProject(project.id)).toMatchObject({ status: "completed", executionCounts: { worker: 1, main: 1 } });
    expect(f.calls).toHaveLength(3);
  });

  it("preserves the pending Worker handoff through a failed Main repair and spends no fresh repair after explicit resume", async () => {
    const upstream = "Independent result: measured gap is 0.0521; check report.md.";
    let permitDecision = false, ordinaryMain = 0;
    const f = await fixture(async request => {
      if (request.agent === "worker") return { handoff: upstream, threadId: "original-worker" };
      expect(await fs.readFile(request.inboxPath, "utf8")).toContain(upstream);
      if (!request.terminalControlRepair) ordinaryMain++;
      if (request.terminalControlRepair) {
        expect(await fs.readFile(request.terminalControlRepair.handoffPath!, "utf8")).toBe(request.terminalControlRepair.originalHandoff);
        const compiled = await actualPrompt(request);
        expect(compiled).toContain(request.terminalControlRepair.handoffPath!);
        expect(compiled).not.toContain("Long Main commentary without any routing decision.");
      }
      if (permitDecision) return result(request, { tool: "complete_project", rationale: "Reviewed exact original evidence." });
      return { handoff: "Long Main commentary without any routing decision. ".repeat(600), threadId: "original-main" };
    });
    const project = await f.runtime.createProject(input());
    await waitUntilIdleOrCalls(f.runtime, project.id, f.calls, 3);
    const stopped = await f.runtime.getProject(project.id);
    expect(stopped).toMatchObject({ status: "interrupted", phase: "main-decision-required", latestHandoff: { agent: "worker", body: upstream },
      activeAgentExecution: { terminalControlRecovery: { attempts: 1 } } });
    expect(f.calls.filter(r => r.terminalControlRepair)).toHaveLength(1);
    await f.runtime.shutdown(); const restarted = await f.restart();
    await restarted.runtime.waitForIdle(project.id); expect(ordinaryMain).toBe(1);
    permitDecision = true; await restarted.runtime.resume(project.id);
    await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 4);
    expect(f.calls.at(-1)?.taskSessionId).toBe(stopped.activeAgentExecution?.id);
    expect(f.calls.filter(r => r.terminalControlRepair)).toHaveLength(1);
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "completed", executionCounts: { worker: 1, main: 1 } });
    const events = await restarted.storage.readEvents(project.id);
    expect(events.filter(event => event.data?.recoveryInput === "staged")).toHaveLength(1);
    expect(events.filter(event => event.data?.recoveryInput === "received")).toHaveLength(0);
  });

  it("commits finish_task receipts but bounds same-task no-routing continuations across restart and manual resume", async () => {
    let decide = false;
    const f = await fixture(async request => result(request, decide
      ? { tool: "complete_project", rationale: "Actual decision now made." }
      : { tool: "finish_task", summary: "This native turn ended; no project decision was made." }));
    const mainOnly = input(false);
    const project = await f.runtime.createProject({ ...mainOnly, agents: { main: mainOnly.agents.main },
      orchestration: { ...mainOnly.orchestration, agents: [{ name: "main", template: "main" }], routes: { main: [] },
        decisionPlans: { main: mainOnly.orchestration.decisionPlans.main } } });
    await waitUntilIdleOrCalls(f.runtime, project.id, f.calls, 2);
    const stopped = await f.runtime.getProject(project.id);
    expect(stopped).toMatchObject({ status: "interrupted", phase: "main-decision-required", runCounts: { main: 2 },
      activeAgentExecution: { terminalControlRecovery: { attempts: 1 } } });
    expect(f.calls).toHaveLength(2);
    const events = await f.storage.readEvents(project.id);
    expect(events.filter(e => e.type === "invocation.completed")).toHaveLength(2);
    expect(events.filter(e => e.type === "control.action.committed" && e.data?.tool === "finish_task")).toHaveLength(2);
    expect(events.some(e => e.type === "project.completed")).toBe(false);
    await f.runtime.shutdown(); const restarted = await f.restart();
    await restarted.runtime.waitForIdle(project.id); expect(f.calls).toHaveLength(2);
    await restarted.runtime.resume(project.id); await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 3);
    expect(f.calls).toHaveLength(3);
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "interrupted", activeAgentExecution: { id: stopped.activeAgentExecution!.id, terminalControlRecovery: { attempts: 1 } } });
    decide = true; await restarted.runtime.resume(project.id); await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 4);
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "completed", executionCounts: { main: 1 } });
  });

  it.each(["finish-then-missing", "missing-then-finish"])("shares one correction across %s without a new allowance", async mode => {
    const f = await fixture(async (request, index) => {
      const finish = mode === "finish-then-missing" ? index === 0 : index > 0;
      return finish ? result(request, { tool: "finish_task", summary: "Turn ended but responsibility remains." })
        : { handoff: "No route chosen.", threadId: "original-main" };
    });
    const project = await f.runtime.createProject(input(false));
    await waitUntilIdleOrCalls(f.runtime, project.id, f.calls, 2);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.filter(call => call.terminalControlRepair)).toHaveLength(mode === "finish-then-missing" ? 0 : 1);
    expect(await f.runtime.getProject(project.id)).toMatchObject({ status: "interrupted", phase: "main-decision-required",
      activeAgentExecution: { terminalControlRecovery: { attempts: 1 } } });
    const events = await f.storage.readEvents(project.id);
    expect(events.filter(e => e.type === "control.action.committed" && e.data?.tool === "finish_task")).toHaveLength(1);
  });

  it.each(["missing-control", "finish-only"])("restores a spent %s correction from retained events when its checkpoint has no counter", async mode => {
    const f = await fixture(async request => mode === "finish-only"
      ? result(request, { tool: "finish_task", summary: "Only this native turn ended." })
      : { handoff: "Business evidence retained; no route was chosen.", threadId: "original-main" });
    const project = await f.runtime.createProject(input(false));
    await waitUntilIdleOrCalls(f.runtime, project.id, f.calls, 2);
    await f.runtime.shutdown();
    const state = await f.storage.loadState(project.id), taskId = state.activeAgentExecution!.id;
    delete state.activeAgentExecution!.terminalControlRecovery;
    await f.storage.saveState(state);
    const restarted = await f.restart();
    await restarted.runtime.resume(project.id);
    await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 3);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.at(-1)?.terminalControlRepair).toBeUndefined();
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "interrupted", phase: "main-decision-required",
      activeAgentExecution: { id: taskId, terminalControlRecovery: { attempts: 1 } } });
  });

  it("rehydrates a legacy overwritten Main source from its exact saved handoff, not a summary or a new assignment", async () => {
    let resume = false;
    const sourceBody = "Exact source evidence that must survive a historical overwritten latestHandoff.";
    const f = await fixture(async request => {
      if (request.agent === "worker") return { handoff: sourceBody, threadId: "original-worker" };
      if (!resume) throw new HarnessRuntimeError("HARNESS_CONTRACT_VIOLATION", "empty final", {}, { retryable: false });
      expect(await fs.readFile(request.inboxPath, "utf8")).toContain(sourceBody);
      expect(await fs.readFile(request.inboxPath, "utf8")).not.toContain("UNRELATED_MAIN_SUMMARY");
      expect(request.project.latestHandoff?.invocationId).toBe(request.project.pendingMainDecision?.sourceInvocationId);
      expect(request.project.mainInvocationContext?.handoff).toContain(sourceBody);
      return result(request, { tool: "complete_project", rationale: "Read the exact source." });
    });
    const project = await f.runtime.createProject(input()); await f.runtime.waitForIdle(project.id); await f.runtime.shutdown();
    const persisted = await f.storage.loadState(project.id);
    persisted.latestHandoff = { agent: "main", invocationId: persisted.activeAgentExecution!.latestInvocationId!,
      body: "UNRELATED_MAIN_SUMMARY", markdown: "UNRELATED_MAIN_SUMMARY", excerpt: "UNRELATED_MAIN_SUMMARY", updatedAt: persisted.updatedAt };
    await f.storage.saveState(persisted);
    const restarted = await f.restart(); resume = true;
    await restarted.runtime.resume(project.id); await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 3);
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "completed" });
  });

  it("resolves a retained upstream-Agent/Main-invocation mismatch only from the original committed Main route", async () => {
    let mainTurns = 0, resumed = false, routeInvocation = "", upstreamInvocation = "";
    const f = await fixture(async request => {
      if (request.agent === "worker") {
        upstreamInvocation = request.invocationId;
        return { handoff: "Exact Worker evidence before the weak Main choice.", threadId: "original-worker" };
      }
      mainTurns++;
      if (mainTurns === 1) {
        routeInvocation = request.invocationId;
        return result(request, { tool: "route_to_agent", target: "main", assignment: "Perform autonomous review." });
      }
      if (!resumed) throw new HarnessRuntimeError("HARNESS_CONTRACT_VIOLATION", "empty final", {}, { retryable: false });
      expect(request.project.pendingMainDecision?.sourceInvocationId).toBe(upstreamInvocation);
      expect(await fs.readFile(request.inboxPath, "utf8")).toContain("Exact Worker evidence before the weak Main choice.");
      return result(request, { tool: "complete_project", rationale: "Reviewed the original evidence." });
    });
    const config = input();
    config.orchestration.agents.push({ name: "alternative", template: "general" });
    config.orchestration.routes = { ...config.orchestration.routes,
      worker: [{ target: "main", kind: "weak" }, { target: "alternative", kind: "weak" }],
      alternative: [{ target: "main", kind: "strong" }] } as unknown as typeof config.orchestration.routes;
    const project = await f.runtime.createProject(config); await f.runtime.waitForIdle(project.id); await f.runtime.shutdown();
    const state = await f.storage.loadState(project.id), task = state.activeAgentExecution!.id;
    state.pendingMainDecision!.sourceInvocationId = routeInvocation;
    state.latestHandoff = { agent: "main", invocationId: routeInvocation, body: "Main route, not Worker evidence", markdown: "Main route", excerpt: "Main route", updatedAt: state.updatedAt };
    await f.storage.saveState(state);
    resumed = true; const restarted = await f.restart(); await restarted.runtime.resume(project.id);
    await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 4);
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "completed" });
    expect(f.calls.at(-1)?.taskSessionId).toBe(task);
    expect((await restarted.storage.readEvents(project.id)).filter(event => event.data?.resolvedSourceInvocationId === upstreamInvocation)).toHaveLength(1);
  });

  it.each(["missing", "wrong-agent", "ambiguous", "empty-file", "empty-checkpoint"])("fails explicitly before native launch when original source is %s", async mode => {
    let mainCalls = 0;
    const f = await fixture(async request => {
      if (request.agent === "worker") return { handoff: "Original evidence exists.", threadId: "original-worker" };
      mainCalls++;
      throw new HarnessRuntimeError("HARNESS_CONTRACT_VIOLATION", "empty final", {}, { retryable: false });
    });
    const project = await f.runtime.createProject(input()); await f.runtime.waitForIdle(project.id); await f.runtime.shutdown();
    const persisted = await f.storage.loadState(project.id), source = persisted.pendingMainDecision!;
    const directory = path.join(f.root, "projects", project.id, "messages");
    const handoff = (await fs.readdir(directory)).find(name => name.endsWith(`_worker_${source.sourceInvocationId}_handoff.md`))!;
    expect(handoff).toBeTruthy();
    if (mode === "missing") await fs.rm(path.join(directory, handoff));
    if (mode === "wrong-agent") await fs.rename(path.join(directory, handoff), path.join(directory, handoff.replace("_worker_", "_other_worker_")));
    if (mode === "ambiguous") await fs.copyFile(path.join(directory, handoff), path.join(directory, `9999_worker_${source.sourceInvocationId}_handoff.md`));
    if (mode === "empty-file") await fs.writeFile(path.join(directory, handoff), "\n");
    if (mode === "empty-checkpoint") persisted.latestHandoff!.body = "\n";
    else persisted.latestHandoff = undefined;
    await f.storage.saveState(persisted);
    const restarted = await f.restart(); await restarted.runtime.resume(project.id); await restarted.runtime.waitForIdle(project.id);
    const stopped = await restarted.runtime.getProject(project.id);
    expect(mainCalls).toBe(1);
    expect(stopped).toMatchObject({ status: "interrupted", phase: "harness-recovery-required", activeAgentExecution: { id: persisted.activeAgentExecution!.id } });
    expect(stopped.lastError).toContain(source.sourceInvocationId);
    expect(stopped.agentFailureHistory?.main?.at(-1)).toMatchObject({ errorCode: "INVOCATION_INPUT_STAGING_FAILED", errorSource: "inputs", retryable: false });
  });

  it("does not spend a second correction when its corrected decision later fails at the commit boundary", async () => {
    let attempts = 0, commitFailed = false;
    const f = await fixture(async request => {
      attempts++;
      if (attempts === 1) return { handoff: "Evidence checked; decision still missing.", threadId: "original-main" };
      return result(request, { tool: "complete_project", rationale: "Commit the verified outcome." });
    });
    const originalCommit = f.storage.commitInvocationCommit.bind(f.storage);
    f.storage.commitInvocationCommit = async (...args) => {
      if (!commitFailed) { commitFailed = true; throw new Error("fixture publication failed after repair"); }
      return originalCommit(...args);
    };
    const project = await f.runtime.createProject(input(false));
    await waitUntilIdleOrCalls(f.runtime, project.id, f.calls, 3);
    expect(await f.runtime.getProject(project.id)).toMatchObject({ status: "completed", executionCounts: { main: 1 } });
    expect(f.calls).toHaveLength(3);
    expect(f.calls.filter(call => call.terminalControlRepair)).toHaveLength(1);
    expect(f.calls[2].project.activeAgentExecution?.terminalControlRecovery?.attempts).toBe(1);
    expect(new Set(f.calls.map(call => call.taskSessionId)).size).toBe(1);
  });

  it("retains the correction allowance when a finish_task-only commit is rolled back", async () => {
    let failed = false;
    const f = await fixture(async request => result(request, { tool: "finish_task", summary: "No routing decision made." }));
    const commit = f.storage.commitInvocationCommit.bind(f.storage);
    f.storage.commitInvocationCommit = async (...args) => {
      if (!failed) { failed = true; throw new Error("fixture finish_task publication failure"); }
      return commit(...args);
    };
    const project = await f.runtime.createProject(input(false));
    await waitUntilIdleOrCalls(f.runtime, project.id, f.calls, 2);
    expect(f.calls).toHaveLength(2);
    expect(new Set(f.calls.map(call => call.taskSessionId)).size).toBe(1);
    expect(await f.runtime.getProject(project.id)).toMatchObject({ status: "interrupted", phase: "main-decision-required",
      runCounts: { main: 1 }, activeAgentExecution: { terminalControlRecovery: { attempts: 1 } } });
    const events = await f.storage.readEvents(project.id);
    expect(events.filter(e => e.type === "control.action.committed" && e.data?.tool === "finish_task")).toHaveLength(1);
    expect(events.filter(e => e.type === "invocation.completed")).toHaveLength(1);
  });

  it("retains the spent correction allowance when a user pause arrives before a finish_task commit", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(async request => {
      entered(); await gate;
      return result(request, { tool: "finish_task", summary: "Native turn completed; routing still unresolved." });
    });
    const project = await f.runtime.createProject(input(false)); await started;
    await f.runtime.pause(project.id); release(); await f.runtime.waitForIdle(project.id);
    const paused = await f.runtime.getProject(project.id);
    expect(paused).toMatchObject({ status: "paused", activeAgentExecution: { terminalControlRecovery: { attempts: 1 } } });
    await f.runtime.shutdown(); const restarted = await f.restart(); await restarted.runtime.waitForIdle(project.id);
    expect(f.calls).toHaveLength(1);
    await restarted.runtime.resume(project.id); await waitUntilIdleOrCalls(restarted.runtime, project.id, f.calls, 2);
    expect(f.calls).toHaveLength(2);
    expect(await restarted.runtime.getProject(project.id)).toMatchObject({ status: "interrupted", phase: "main-decision-required", activeAgentExecution: { id: paused.activeAgentExecution!.id } });
  });

  it("does not inject another task's historical error and never silently returns an empty missing source", () => {
    const state = { activeAgentExecution: { id: "exec_new", agent: "worker" }, agentFailureHistory: { worker: [{ invocationId: "inv_old", error: "OLD_ERROR" }] },
      pendingMainDecision: { sourceAgent: "worker", sourceInvocationId: "inv_required" }, latestHandoff: { agent: "main", invocationId: "inv_wrong", body: "not source" },
      orchestration: { routes: {} }, runCounts: { main: 1 } } as unknown as ProjectState;
    expect(serialTaskRecoveryMessage(state, "worker", "inv_new")).toBeUndefined();
    expect(serialTaskRecoveryMessage(state, "main", "inv_old")).toBeUndefined();
    expect(() => serialWorkflowMessages(state, "main")).toThrow("worker/inv_required");
    state.pendingMainDecision!.diagnostic = "Failed Worker has no successful handoff; original trace remains available.";
    expect(() => serialWorkflowMessages(state, "main")).toThrow("worker/inv_required");
    state.userIntervention = { status: "answered", id: "usr_unrelated", response: "Unrelated historical response" } as ProjectState["userIntervention"];
    expect(() => serialWorkflowMessages(state, "main")).toThrow("worker/inv_required");
    state.userIntervention = undefined;
    state.pendingMainDecision!.sourceInvocationId = "inv_old";
    expect(serialWorkflowMessages(state, "main")).toEqual([{ sender: "ScienceEvolve", body: state.pendingMainDecision!.diagnostic }]);
  });
});
