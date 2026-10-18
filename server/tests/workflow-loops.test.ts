import { afterEach, describe, expect, it } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "../src/event-hub.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { ProjectStorage } from "../src/storage.js";
import {
  harnessCatalogRegistry,
  toPublicHarnessDescriptor
} from "../src/harness-runtime/registry.js";
import type {
  AgentOrchestrationTemplate,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  ControlAction,
  TraceSink
} from "../src/types.js";

const roots: string[] = [];
const builtinSkillRoot = fileURLToPath(
  new URL("../../.agents/skills", import.meta.url)
);
const parityFixture = JSON.parse(readFileSync(
  new URL("./fixtures/runtime-parity.json", import.meta.url),
  "utf8"
)) as {
  loopTwoBatches: {
    agentCalls: string[];
    state: Record<string, unknown>;
    events: { batchStarted: number[]; iterationCount: number; exhaustedCount: number };
  };
  terminationReview: {
    agentCalls: string[];
    mainDecisions: Array<Record<string, unknown>>;
    state: Record<string, unknown>;
  };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

type Handler = (
  request: AgentRunRequest,
  index: number,
  signal: AbortSignal,
  onTrace: TraceSink
) => Promise<AgentRunResult>;

class LoopRunner implements AgentRunner {
  readonly calls: AgentRunRequest[] = [];

  constructor(private readonly handler: Handler) {}

  async harnessCatalog() {
    return harnessCatalogRegistry.list().map((descriptor) =>
      toPublicHarnessDescriptor(descriptor, { available: true })
    );
  }

  async run(
    request: AgentRunRequest,
    onTrace: TraceSink,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    this.calls.push({ ...request, project: structuredClone(request.project) });
    return this.handler(request, this.calls.length - 1, signal, onTrace);
  }
}

function loopOrchestration(maxIterations = 2): AgentOrchestrationTemplate {
  const names = ["main", "measure", "assess", "revise"];
  return {
    agents: names.map((name) => ({ name })),
    input: { source: "input", target: "measure" },
    routes: {
      main: names.slice(1).map((target) => ({ target, kind: "weak" })),
      measure: [{ target: "assess", kind: "strong" }],
      assess: [{ target: "revise", kind: "strong" }],
      revise: [{ target: "measure", kind: "strong" }]
    },
    loops: [{
      id: "refinement",
      from: "assess",
      to: "revise",
      maxIterations,
      exitTo: "main"
    }],
    decisionPlans: Object.fromEntries(
      names.map((name) => [name, "Follow evidence and configured routes."])
    ),
    allowUserIntervention: true,
    allowMainReconfiguration: true,
    termination: {
      agent: "main",
      condition: "Main accepts the measured result.",
      decisionBy: "main",
      automatic: false
    },
    resultFormat: { presets: [], custom: "" }
  };
}

function controlResult(
  request: AgentRunRequest,
  action: ControlAction
): AgentRunResult {
  const control = request.control!;
  return {
    handoff: "Recorded loop evidence.",
    threadId: request.agent === "main" ? "loop-main-thread" : undefined,
    controlActions: [{
      projectId: request.project.id,
      agent: request.agent,
      invocationId: request.invocationId,
      callId: `${request.invocationId}-action`,
      stateVersion: control.stateVersion,
      ...(control.capabilityHash
        ? { capabilityHash: control.capabilityHash }
        : {}),
      receivedAt: new Date().toISOString(),
      action
    }]
  };
}

function projectInput(orchestration: AgentOrchestrationTemplate) {
  return {
    title: "Loop runtime",
    requirement: "Run bounded evidence refinement batches.",
    orchestration,
    agents: Object.fromEntries(
      orchestration.agents.map(({ name }) => [
        name,
        { model: "test-model", skills: [], autoSkills: [] }
      ])
    )
  };
}

async function createHarness(root: string, handler: Handler) {
  const runner = new LoopRunner(handler);
  const storage = new ProjectStorage(root, new EventHub());
  const orchestrator = new Orchestrator(
    storage,
    new SkillCatalog([builtinSkillRoot]),
    runner,
    { retryBaseMs: 1, retryMaxMs: 1, agentConcurrency: 2 }
  );
  await orchestrator.initialize();
  return { orchestrator, runner, storage };
}

describe("workflow loop groups", () => {
  it("runs repeatable batches and wakes an autonomous Main at each limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-main-loops-"));
    roots.push(root);
    let mainDecisions = 0;
    const { orchestrator, runner, storage } = await createHarness(
      root,
      async (request) => {
        if (request.agent !== "main") {
          const inbox = await fs.readFile(request.inboxPath, "utf8");
          expect(inbox).toContain("maxIterations=2");
          return { handoff: `${request.agent} recorded evidence.` };
        }
        mainDecisions += 1;
        expect(request.project.pendingMainDecision).toMatchObject({
          reason: "loop-limit",
          capabilities: { controlMode: "autonomous" }
        });
        expect(request.control?.mainCapabilities).toMatchObject({
          controlMode: "autonomous",
          canReconfigure: true,
          canComplete: true,
          canRequestUser: true
        });
        return mainDecisions === 1
          ? controlResult(request, {
              tool: "route_to_agent",
              target: "revise",
              assignment: "Start the next bounded refinement batch."
            })
          : controlResult(request, {
              tool: "complete_project",
              rationale: "Both batches contain sufficient evidence."
            });
      }
    );

    const project = await orchestrator.createProject(
      projectInput(loopOrchestration(2))
    );
    await orchestrator.waitForIdle(project.id);

    expect(runner.calls.map(({ agent }) => agent)).toEqual(parityFixture.loopTwoBatches.agentCalls);
    const finished = await orchestrator.getProject(project.id);
    expect(finished).toMatchObject(parityFixture.loopTwoBatches.state);
    const events = await storage.readEvents(project.id);
    expect(events.filter(({ type }) => type === "workflow.loop.batch.started")
      .map(({ data }) => data?.batch)).toEqual(parityFixture.loopTwoBatches.events.batchStarted);
    expect(events.filter(({ type }) => type === "workflow.loop.iteration"))
      .toHaveLength(parityFixture.loopTwoBatches.events.iterationCount);
    expect(events.filter(({ type }) => type === "workflow.loop.exhausted"))
      .toHaveLength(parityFixture.loopTwoBatches.events.exhaustedCount);
    await orchestrator.shutdown();
  }, 10_000);

  it("migrates legacy counters and preserves them across pause, restart, and retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-main-loop-recovery-"));
    roots.push(root);
    let firstOrchestrator!: Orchestrator;
    const first = await createHarness(root, async (request) => {
      if (request.agent === "revise") {
        await firstOrchestrator.pause(request.project.id);
      }
      return { handoff: "Evidence saved before pause." };
    });
    firstOrchestrator = first.orchestrator;
    const project = await first.orchestrator.createProject(
      projectInput(loopOrchestration(2))
    );
    await first.orchestrator.waitForIdle(project.id);
    expect(await first.orchestrator.getProject(project.id)).toMatchObject({
      status: "paused",
      loopIterations: { refinement: 1 }
    });
    await first.orchestrator.shutdown();

    const statePath = path.join(root, "projects", project.id, "state.json");
    const legacy = JSON.parse(await fs.readFile(statePath, "utf8"));
    delete legacy.loopBatches;
    delete legacy.loopTotalIterations;
    await fs.writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`);

    let failedOnce = false;
    const calls: string[] = [];
    const second = await createHarness(root, async (request) => {
      calls.push(request.agent);
      if (request.agent === "assess" && !failedOnce) {
        failedOnce = true;
        throw new Error("Transient assessment failure");
      }
      return request.agent === "main"
        ? controlResult(request, {
            tool: "complete_project",
            rationale: "Recovered batch evidence is complete."
          })
        : { handoff: "Recovered loop evidence." };
    });
    expect(await second.orchestrator.getProject(project.id)).toMatchObject({
      loopIterations: { refinement: 1 },
      loopBatches: { refinement: 1 },
      loopTotalIterations: { refinement: 1 }
    });
    await second.orchestrator.resume(project.id);
    await second.orchestrator.waitForIdle(project.id);
    expect(await second.orchestrator.getProject(project.id)).toMatchObject({
      status: "completed",
      loopIterations: { refinement: 2 },
      loopBatches: { refinement: 1 },
      loopTotalIterations: { refinement: 2 }
    });
    expect(calls.filter((agent) => agent === "assess")).toHaveLength(3);
    const events = await second.storage.readEvents(project.id);
    expect(events.filter(({ type }) => type === "workflow.loop.iteration")
      .map(({ data }) => data?.iterations)).toEqual([1, 2]);
    await second.orchestrator.shutdown();
  }, 10_000);

  it("keeps loop-limit completion separate from the original termination route", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-main-loop-termination-"));
    roots.push(root);
    const orchestration = loopOrchestration(1);
    orchestration.agents.push({ name: "review", template: "review" });
    orchestration.routes.main.push({ target: "review", kind: "weak" });
    orchestration.routes.review = [
      { target: "main", kind: "weak" },
      { target: "finish", kind: "weak" }
    ];
    orchestration.decisionPlans.review = "Check the original termination condition.";
    orchestration.termination.agent = "review";

    let decisions = 0;
    const observedMainDecisions: Array<Record<string, unknown>> = [];
    const { orchestrator, runner } = await createHarness(root, async (request) => {
      if (request.agent !== "main") {
        return { handoff: `${request.agent} recorded termination evidence.` };
      }
      decisions += 1;
      const reason = request.project.pendingMainDecision?.reason;
      const capabilities = request.control?.mainCapabilities;
      if (decisions === 1) {
        observedMainDecisions.push({
          reason,
          controlMode: capabilities?.controlMode,
          canComplete: capabilities?.canComplete,
          action: "route_to_agent:review"
        });
        return controlResult(request, {
          tool: "route_to_agent",
          target: "review",
          assignment: "Evaluate the original termination condition."
        });
      }
      if (decisions === 2) {
        observedMainDecisions.push({
          reason,
          controlMode: capabilities?.controlMode,
          routeCandidates: capabilities?.routeCandidates,
          canComplete: capabilities?.canComplete,
          action: "route_to_agent:finish"
        });
        return controlResult(request, {
          tool: "route_to_agent",
          target: "finish",
          assignment: "Schedule an autonomous termination review."
        });
      }
      observedMainDecisions.push({
        reason,
        controlMode: capabilities?.controlMode,
        canComplete: capabilities?.canComplete,
        action: "complete_project"
      });
      return controlResult(request, {
        tool: "complete_project",
        rationale: "The review satisfies the original termination condition."
      });
    });

    const project = await orchestrator.createProject(projectInput(orchestration));
    await orchestrator.waitForIdle(project.id);
    expect(runner.calls.map(({ agent }) => agent)).toEqual(parityFixture.terminationReview.agentCalls);
    expect(observedMainDecisions).toEqual(parityFixture.terminationReview.mainDecisions);
    expect(await orchestrator.getProject(project.id)).toMatchObject(parityFixture.terminationReview.state);
    expect(decisions).toBe(3);
    await orchestrator.shutdown();
  }, 10_000);
});
