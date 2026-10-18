import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentInterruptedError } from "../src/codex-runner.js";
import { EventHub } from "../src/event-hub.js";
import { emptyProjectComputeUsage } from "../src/inspire-compute-usage.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { ProjectStorage } from "../src/storage.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import {
  harnessCatalogRegistry,
  toPublicHarnessDescriptor
} from "../src/harness-runtime/registry.js";
import type {
  AgentName,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  ProjectState,
  TraceSink,
  WorkerResult
} from "../src/types.js";

const temporaryRoots: string[] = [];
const AGENT_NAMES = ["main", "idea", "execution", "writing", "review"] as const;
const builtinSkillRoot = fileURLToPath(
  new URL("../../.agents/skills", import.meta.url)
);

function testSkillCatalog(): SkillCatalog {
  return new SkillCatalog([builtinSkillRoot]);
}

function availableHarnessCatalog() {
  return harnessCatalogRegistry.list().map((descriptor) =>
    toPublicHarnessDescriptor(descriptor, { available: true })
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

class QueueProbeRunner implements AgentRunner {
  readonly starts: Array<{ title: string; agent: AgentName }> = [];
  readonly active = new Map<AgentName, number>();
  readonly maxActive = new Map<AgentName, number>();
  readonly projectAIdeaStarted = deferred<void>();
  readonly projectBIdeaStarted = deferred<void>();
  readonly projectAMainStarted = deferred<void>();
  private readonly projectAIdeaRelease = deferred<void>();

  async harnessCatalog() { return availableHarnessCatalog(); }

  releaseProjectAIdea(): void {
    this.projectAIdeaRelease.resolve(undefined);
  }

  async run(
    request: AgentRunRequest,
    _onTrace: TraceSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const count = (this.active.get(request.agent) ?? 0) + 1;
    this.active.set(request.agent, count);
    this.maxActive.set(
      request.agent,
      Math.max(this.maxActive.get(request.agent) ?? 0, count)
    );
    this.starts.push({ title: request.project.title, agent: request.agent });
    try {
      if (request.project.title === "Queue project A" && request.agent === "idea") {
        this.projectAIdeaStarted.resolve(undefined);
        await this.projectAIdeaRelease.promise;
        return { handoff: ideaResult().markdown };
      }
      if (request.project.title === "Queue project B" && request.agent === "idea") {
        this.projectBIdeaStarted.resolve(undefined);
      }
      if (
        request.project.title === "Queue project A" &&
        request.agent === "main"
      ) {
        this.projectAMainStarted.resolve(undefined);
      }
      return await holdUntilAbort(signal);
    } finally {
      this.active.set(request.agent, (this.active.get(request.agent) ?? 1) - 1);
    }
  }
}

class RecoveryQueueRunner implements AgentRunner {
  readonly starts: Array<{ projectId: string; agent: AgentName }> = [];
  readonly requests = new Map<string, AgentRunRequest>();

  async harnessCatalog() { return availableHarnessCatalog(); }

  async run(
    request: AgentRunRequest,
    _onTrace: TraceSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    this.requests.set(request.project.id, request);
    this.starts.push({
      projectId: request.project.id,
      agent: request.agent
    });
    return holdUntilAbort(signal);
  }
}

class BlockingQueueEventStorage extends ProjectStorage {
  readonly queueEventBlocked = deferred<void>();
  readonly releaseQueueEvent = deferred<void>();
  blockedState?: ProjectState;
  blockNextAgentQueued = true;

  override async appendEvent(
    state: ProjectState,
    draft: Parameters<ProjectStorage["appendEvent"]>[1]
  ) {
    if (this.blockNextAgentQueued && draft.type === "agent.queued") {
      this.blockNextAgentQueued = false;
      this.blockedState = state;
      this.queueEventBlocked.resolve(undefined);
      await this.releaseQueueEvent.promise;
    }
    return super.appendEvent(state, draft);
  }
}

class FailingMainStartStorage extends ProjectStorage {
  failed = false;

  override async appendEvent(
    state: ProjectState,
    draft: Parameters<ProjectStorage["appendEvent"]>[1]
  ) {
    if (!this.failed && draft.type === "agent.execution.started" && draft.agent === "main") {
      this.failed = true;
      throw Object.assign(new Error("transient state write failure"), { code: "EPERM" });
    }
    return super.appendEvent(state, draft);
  }
}

describe("Orchestrator agent-role queues", () => {
  it("releases an unfinished experiment task's slot and queues its same-task continuation fairly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-sii-queue-"));
    temporaryRoots.push(root);
    const storage = new ProjectStorage(root, new EventHub());
    const runner = new RecoveryQueueRunner();
    const orchestrator = new Orchestrator(storage, testSkillCatalog(), runner, { agentConcurrency: 1 });
    await orchestrator.initialize();
    const a = await orchestrator.createProject(input("Pending experiment A"));
    await waitUntil(() => runner.requests.has(a.id));
    const b = await orchestrator.createProject(input("Independent task B"));
    await waitUntil(() => orchestrator.getQueueSnapshot().worker.queued.some(item => item.projectId === b.id));
    try {
      const original = runner.requests.get(a.id)!;
      await original.onExperimentWait!(true);
      await waitUntil(() => runner.requests.has(b.id));
      expect(await orchestrator.getProject(a.id)).toMatchObject({ status: "running", phase: "idea:awaiting-experiment-result", currentAgent: "idea", activeInvocationId: original.invocationId });
      expect(orchestrator.getQueueSnapshot().worker.activeProjectIds).toEqual([b.id]);
      const continuation = original.onExperimentWait!(false);
      await waitUntil(() => orchestrator.getQueueSnapshot().worker.queued.some(item => item.projectId === a.id));
      expect(runner.starts.filter(item => item.projectId === a.id)).toHaveLength(1);
      await orchestrator.cancel(b.id);
      await continuation;
      expect(orchestrator.getQueueSnapshot().worker.activeProjectIds).toEqual([a.id]);
      expect(await orchestrator.getProject(a.id)).toMatchObject({ status: "running", phase: "idea:running", activeInvocationId: original.invocationId });
      expect((await storage.readEvents(a.id)).map(event => event.type)).toEqual(expect.arrayContaining(["agent.experiment.waiting", "agent.experiment.resumed"]));
    } finally {
      await Promise.all([orchestrator.cancel(a.id), orchestrator.cancel(b.id)]);
      await Promise.all([orchestrator.waitForIdle(a.id), orchestrator.waitForIdle(b.id)]);
      await orchestrator.shutdown();
    }
    expect(orchestrator.getQueueSnapshot().worker.activeProjectIds).toEqual([]);
  });

  it("releases Main's slot when startup persistence fails before invocation cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-main-slot-"));
    temporaryRoots.push(root);
    const storage = new FailingMainStartStorage(root, new EventHub());
    const project = queueState({
      id: "prj_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      title: "Main startup retry",
      status: "queued",
      phase: "main:queued",
      createdAt: "2026-07-31T00:00:00.000Z",
      queueEnteredAt: "2026-07-31T00:00:00.000Z",
      queueOrder: 1,
      queuedAgent: "main"
    });
    await storage.createProject(project);
    const runner = new RecoveryQueueRunner();
    const orchestrator = new Orchestrator(
      storage,
      testSkillCatalog(),
      runner,
      { retryBaseMs: 1, retryMaxMs: 10, agentConcurrency: 1 }
    );
    await orchestrator.initialize();

    await waitUntil(() => runner.starts.some((start) => start.projectId === project.id));
    expect(storage.failed).toBe(true);
    expect(orchestrator.getQueueSnapshot().main.activeProjectIds).toEqual([project.id]);
    expect((await storage.readEvents(project.id)).some((event) =>
      event.message.includes("already owns or awaits the main agent slot")
    )).toBe(false);

    await orchestrator.cancel(project.id);
    await orchestrator.waitForIdle(project.id);
    expect(orchestrator.getQueueSnapshot().main.activeProjectIds).toEqual([]);
    await orchestrator.shutdown();
  });

  it("serializes the same role while allowing different roles to run together", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-queue-"));
    temporaryRoots.push(root);
    const runner = new QueueProbeRunner();
    const storage = new ProjectStorage(root, new EventHub());
    const orchestrator = new Orchestrator(
      storage,
      testSkillCatalog(),
      runner,
      { retryBaseMs: 1, retryMaxMs: 10, agentConcurrency: 1 }
    );
    await orchestrator.initialize();

    const projectA = await orchestrator.createProject(input("Queue project A"));
    await runner.projectAIdeaStarted.promise;
    const projectB = await orchestrator.createProject(input("Queue project B"));

    await waitUntil(
      () =>
        orchestrator
          .getQueueSnapshot()
          .worker.queued.some((item) => item.projectId === projectB.id)
    );
    const queuedB = await orchestrator.getProject(projectB.id);
    expect(queuedB).toMatchObject({
      status: "queued",
      queuedAgent: "idea",
      queuePosition: 1,
      queueDepth: 1
    });
    expect(queuedB?.agentProgress.idea).toMatchObject({
      state: "queued",
      queuePosition: 1,
      runs: 0
    });
    expect(orchestrator.getQueueSnapshot().worker).toMatchObject({
      activeProjectIds: [projectA.id],
      queued: [{ projectId: projectB.id, position: 1 }]
    });
    expect(
      runner.starts.filter((start) => start.title === "Queue project B")
    ).toEqual([]);

    // A pause immediately withdrawn while waiting must re-enter the queue,
    // not turn the intentional queue abort into a failed Agent retry.
    await Promise.all([
      orchestrator.pause(projectB.id),
      orchestrator.resume(projectB.id)
    ]);
    await waitUntil(
      () =>
        orchestrator
          .getQueueSnapshot()
          .worker.queued.some((item) => item.projectId === projectB.id)
    );
    expect(
      (await storage.readEvents(projectB.id)).some(
        (event) => event.type === "agent.failed"
      )
    ).toBe(false);

    runner.releaseProjectAIdea();
    await Promise.all([
      runner.projectBIdeaStarted.promise,
      runner.projectAMainStarted.promise
    ]);

    expect(runner.maxActive.get("idea")).toBe(1);
    expect(runner.active.get("idea")).toBe(1);
    expect(runner.active.get("main")).toBe(1);
    expect(orchestrator.getQueueSnapshot().worker.activeProjectIds).toEqual([projectB.id]);
    expect(orchestrator.getQueueSnapshot().main.activeProjectIds).toEqual([projectA.id]);

    await Promise.all([
      orchestrator.cancel(projectA.id),
      orchestrator.cancel(projectB.id)
    ]);
    await Promise.all([
      orchestrator.waitForIdle(projectA.id),
      orchestrator.waitForIdle(projectB.id)
    ]);
    expect((await orchestrator.getProject(projectA.id))?.status).toBe("cancelled");
    expect((await orchestrator.getProject(projectB.id))?.status).toBe("cancelled");
    expect(orchestrator.getQueueSnapshot().worker).toMatchObject({
      capacity: 1,
      activeProjectIds: [],
      queued: [],
      activeTasks: [],
      recoveringTasks: []
    });
    expect(orchestrator.getQueueSnapshot().main).toMatchObject({
      capacity: 1,
      activeProjectIds: [],
      queued: [],
      activeTasks: [],
      recoveringTasks: []
    });
  });

  it("keeps durable waiters ahead of an automatically resumed role after restart", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-queue-recovery-")
    );
    temporaryRoots.push(root);
    const storage = new ProjectStorage(root, new EventHub());
    const activeBeforeRestart = queueState({
      id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Interrupted active task",
      status: "running",
      phase: "idea:running",
      createdAt: "2026-07-31T00:00:00.000Z",
      queueEnteredAt: "2026-07-31T00:00:00.000Z",
      queueOrder: 1,
      currentAgent: "idea",
      activeInvocationId: "inv_interrupted"
    });
    const waitingBeforeRestart = queueState({
      id: "prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Durable waiting task",
      status: "queued",
      phase: "idea:queued",
      createdAt: "2026-07-31T00:00:01.000Z",
      queueEnteredAt: "2026-07-31T00:00:01.000Z",
      queueOrder: 2,
      queuedAgent: "idea"
    });
    await storage.createProject(activeBeforeRestart);
    await storage.createProject(waitingBeforeRestart);

    const runner = new RecoveryQueueRunner();
    const orchestrator = new Orchestrator(
      storage,
      testSkillCatalog(),
      runner,
      { retryBaseMs: 1, retryMaxMs: 10, agentConcurrency: 1 }
    );
    await orchestrator.initialize();

    await waitUntil(() => runner.starts.length === 1);
    expect(runner.starts[0]).toEqual({
      projectId: waitingBeforeRestart.id,
      agent: "idea"
    });
    expect(await orchestrator.getProject(activeBeforeRestart.id)).toMatchObject({
      status: "queued",
      phase: "idea:queued",
      queuedAgent: "idea",
      currentAgent: undefined,
      activeInvocationId: undefined
    });
    expect(orchestrator.getQueueSnapshot().worker).toMatchObject({
      activeProjectIds: [waitingBeforeRestart.id],
      queued: [{ projectId: activeBeforeRestart.id, position: 1 }]
    });

    await orchestrator.cancel(waitingBeforeRestart.id);
    await waitUntil(() => runner.starts.length === 2);
    expect(runner.starts[1]).toEqual({
      projectId: activeBeforeRestart.id,
      agent: "idea"
    });
    await orchestrator.cancel(activeBeforeRestart.id);
    await Promise.all([
      orchestrator.waitForIdle(waitingBeforeRestart.id),
      orchestrator.waitForIdle(activeBeforeRestart.id)
    ]);
    await orchestrator.shutdown();
  });

  it("runs ten projects in the same role and queues the eleventh", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-queue-capacity-")
    );
    temporaryRoots.push(root);
    const storage = new ProjectStorage(root, new EventHub());
    const runner = new RecoveryQueueRunner();
    const orchestrator = new Orchestrator(
      storage,
      testSkillCatalog(),
      runner,
      { retryBaseMs: 1, retryMaxMs: 10 }
    );
    await orchestrator.initialize();

    const projects = [];
    for (let index = 0; index < 11; index += 1) {
      projects.push(
        await orchestrator.createProject(
          input(`Capacity project ${index + 1}`)
        )
      );
    }

    await waitUntil(() => {
      const idea = orchestrator.getQueueSnapshot().worker;
      return (
        idea.activeProjectIds.length === 10 &&
        idea.queued.length === 1 &&
        runner.starts.length === 10
      );
    });
    const idea = orchestrator.getQueueSnapshot().worker;
    expect(idea.capacity).toBe(10);
    expect(idea.activeProjectIds).toEqual(
      projects.slice(0, 10).map((project) => project.id)
    );
    expect(idea.queued).toMatchObject([
      { projectId: projects[10].id, position: 1 }
    ]);
    expect(runner.starts).toHaveLength(10);

    await Promise.all(
      projects.map((project) => orchestrator.cancel(project.id))
    );
    await Promise.all(
      projects.map((project) => orchestrator.waitForIdle(project.id))
    );
    expect(orchestrator.getQueueSnapshot().worker).toMatchObject({
      capacity: 10,
      activeProjectIds: [],
      queued: [],
      activeTasks: [],
      recoveringTasks: []
    });
    await orchestrator.shutdown();
  });

  it("does not enqueue a project paused while its queue event is persisting", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceevolve-queue-control-race-")
    );
    temporaryRoots.push(root);
    const storage = new BlockingQueueEventStorage(root, new EventHub());
    const active = queueState({
      id: "prj_cccccccccccccccccccccccccccccccc",
      title: "Role owner",
      status: "queued",
      phase: "idea:queued",
      createdAt: "2026-07-31T00:00:00.000Z",
      queueEnteredAt: "2026-07-31T00:00:00.000Z",
      queueOrder: 1,
      queuedAgent: "idea"
    });
    const retrying = queueState({
      id: "prj_dddddddddddddddddddddddddddddddd",
      title: "Pause during queue persistence",
      status: "retrying",
      phase: "idea:retrying",
      createdAt: "2026-07-31T00:00:01.000Z",
      queuedAgent: "idea",
      retryAt: new Date(Date.now() + 100).toISOString()
    });
    await storage.createProject(active);
    await storage.createProject(retrying);

    const runner = new RecoveryQueueRunner();
    const orchestrator = new Orchestrator(
      storage,
      testSkillCatalog(),
      runner,
      { retryBaseMs: 1, retryMaxMs: 10, agentConcurrency: 1 }
    );
    await orchestrator.initialize();
    await waitUntil(
      () => runner.starts[0]?.projectId === active.id
    );
    await storage.queueEventBlocked.promise;

    const pausePromise = orchestrator.pause(retrying.id);
    await waitUntil(() => storage.blockedState?.status === "paused");
    storage.releaseQueueEvent.resolve(undefined);
    const paused = await pausePromise;

    expect(paused.status).toBe("paused");
    expect(
      orchestrator
        .getQueueSnapshot()
        .worker.queued.some((item) => item.projectId === retrying.id)
    ).toBe(false);
    expect(runner.starts).toEqual([{ projectId: active.id, agent: "idea" }]);

    await Promise.all([
      orchestrator.cancel(active.id),
      orchestrator.cancel(retrying.id)
    ]);
    await Promise.all([
      orchestrator.waitForIdle(active.id),
      orchestrator.waitForIdle(retrying.id)
    ]);
    await orchestrator.shutdown();
  });
});

function input(title: string) {
  return {
    title,
    requirement:
      "Verify global per-role FIFO scheduling across concurrent research tasks.",
    agents: Object.fromEntries(
      AGENT_NAMES.map((role) => [
        role,
        { model: "test-model", skills: [] }
      ])
    )
  };
}

function ideaResult(): WorkerResult {
  return {
    summary: "A queue test idea was completed.",
    markdown:
      "## Result\nHypothesis: Agent scheduling is FIFO and independently keyed.\n\n## Evidence\nThe queue runner recorded the dispatch order.\n\n## Risks and Unresolved Issues\nNo unresolved blocker is known.",
    recommendation: "Continue to Main."
  };
}

function queueState(
  input: Pick<
    ProjectState,
    | "id"
    | "title"
    | "status"
    | "phase"
    | "createdAt"
    | "queueEnteredAt"
    | "queueOrder"
    | "currentAgent"
    | "queuedAgent"
    | "activeInvocationId"
    | "retryAt"
  >
): ProjectState {
  const orchestration = cloneAgentOrchestrationTemplate();
  const agents = mergeAgentConfigs(undefined, orchestration);
  const names = orchestration.agents.map((definition) => definition.name);
  const emptyTotals = () => ({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    invocations: 0
  });
  return {
    id: input.id,
    title: input.title,
    requirement: "Verify durable FIFO ordering during service recovery.",
    status: input.status,
    phase: input.phase,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    currentAgent: input.currentAgent,
    queuedAgent: input.queuedAgent,
    queueEnteredAt: input.queueEnteredAt,
    queueOrder: input.queueOrder,
    activeInvocationId: input.activeInvocationId,
    retryAt: input.retryAt,
    turn: 0,
    cycle: 1,
    eventSeq: 0,
    consecutiveFailures: 0,
    completionGeneration: 0,
    controlProtocol: "natural-language-tools-v1",
    runCounts: Object.fromEntries(
      names.map((name) => [name, 0])
    ),
    mainInvocationSeq: 0,
    agents,
    orchestration,
    userInputs: [],
    tokenUsage: {
      ...emptyTotals(),
      byAgent: Object.fromEntries(
        names.map((name) => [
          name,
          emptyTotals()
        ])
      ) as ProjectState["tokenUsage"]["byAgent"]
    },
    computeUsage: emptyProjectComputeUsage()
  };
}

function holdUntilAbort(signal: AbortSignal): Promise<AgentRunResult> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(new AgentInterruptedError("queue probe cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
