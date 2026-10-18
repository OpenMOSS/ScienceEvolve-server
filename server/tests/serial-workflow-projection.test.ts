import { applyGatewayUsageReport, createProjectTokenUsage } from "../src/internal/shared/token-usage-ledger.js";
import { archiveRemovedWorkflowAgentSessions } from "../src/workflow-session-archive.js";
import { assertWorkflowSessionHarnesses } from "../src/workflow-session-compatibility.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { MAIN_AGENT_ORCHESTRATION_CURRENT_FILE, mainAgentOrchestrationDocument, parseAgentOrchestrationProposal } from "../src/agent-orchestration-reconfiguration.js";
import { sameWorkflowConfigurationVersion } from "../src/workflow-adjustments.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";
import { CollaborationRuntimeCoordinator } from "../src/collaboration-runtime.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { emptyProjectComputeUsage } from "../src/inspire-compute-usage.js";
import { restoreSerialWorkflowConfiguration } from "../src/serial-workflow-projection.js";
import { credentialFreeAgentConfiguration } from "../src/scoped-agent-configuration.js";
import type { AgentRunner, ProjectState } from "../src/types.js";
import type { WorkflowAdjustmentSnapshot } from "../src/workflow-adjustments.js";

const roots: string[] = [], stores: CollaborationStateDatabase[] = [], runtimes: Orchestrator[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown()));
  stores.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(marked = true) {
  const root = await mkdtemp(join(tmpdir(), "openfars-serial-projection-")); roots.push(root);
  let clock = Date.now();
  const options = { databasePath: join(root, "journal.sqlite"), serviceId: "serial-projection", hostId: "test", instanceId: "fixture", topology: "single-host" as const, now: () => clock };
  let database = CollaborationStateDatabase.open(options); stores.push(database);
  const storage = new ProjectStorage(join(root, "data"), new EventHub()); await storage.initialize();
  const orchestration = cloneAgentOrchestrationTemplate(), agents = mergeAgentConfigs(undefined, orchestration);
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, invocations: 0 };
  const counts = Object.fromEntries(orchestration.agents.map(agent => [agent.name, 7]));
  const session = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "controlled", nativeId: "original-sdk-thread", generation: 2, durable: true, createdAt: new Date(clock).toISOString() };
  const state: ProjectState = { id: "prj_" + "d".repeat(32), title: "SDK configuration roll-forward", requirement: "Keep the original SDK task and all its runtime state.",
    status: "paused", phase: "paused", createdAt: session.createdAt, updatedAt: session.createdAt, configurationLocked: true,
    queuedAgent: "idea", queueEnteredAt: session.createdAt, queueOrder: 29, activeAgentExecution: { id: "original-sdk-business-task", agent: "idea", source: "configured-route", createdAt: session.createdAt, startedAt: session.createdAt, firstInvocationId: "original-first", latestInvocationId: "original-latest" },
    turn: 13, cycle: 3, eventSeq: 0, consecutiveFailures: 2, completionGeneration: 1, runCounts: { ...counts, retired: 17 },
    executionCounts: { ...counts, retired: 23 }, loopIterations: { original: 4 }, loopBatches: { original: 2 }, loopTotalIterations: { original: 9 },
    mainInvocationSeq: 8, mainContextSeq: 5, controlProtocol: "natural-language-tools-v1", agentSessions: { idea: session }, agentSessionIds: { idea: session.nativeId },
    agentSessionMeta: { idea: { generation: 2, contextSeq: 5, resumeFailureCount: 1 } }, agents, orchestration, skillDefinitions: {}, mcpDefinitions: {},
    userInputs: [], tokenUsage: { ...totals, byAgent: Object.fromEntries(orchestration.agents.map(agent => [agent.name, { ...totals }])) }, computeUsage: emptyProjectComputeUsage(), git: { enabled: false, status: "disabled" } };
  await storage.createProject(state);
  database.createProject({ projectId: state.id, workflowRevision: 1, workflowSnapshot: orchestration, workerCapacity: 2, git: state.git! });
  database.initializeScopedConfiguration(state.id, { agents, skillDefinitions: {}, mcpDefinitions: {} });
  if (marked) database.initializeSerialWorkflowJournal(state.id);
  const apply = (instructions = "Exact accepted SDK configuration", harness?: string, edit?: (proposal: WorkflowAdjustmentSnapshot) => void) => {
    const current = database.workflowAdjustmentCurrent(state.id), proposal = structuredClone(current.snapshot);
    proposal.agents.writing.instructions = instructions;
    if (harness) proposal.agents.writing.harness = harness;
    edit?.(proposal);
    const requestId = `sdk-user-${current.version.revision}`;
    database.submitUserWorkflowAdjustment({ projectId: state.id, requestId, base: current.version, proposal, explanation: "Original public user explanation" });
    const prepared = database.prepareSerialWorkflowAdjustmentPublication(state.id, requestId);
    if (!prepared.ready) throw new Error("Controlled serial publication unexpectedly waits");
    database.publishSerialWorkflowAdjustment(state.id, requestId, prepared.validationToken, { sessions: state, waitingReason: () => undefined });
    return database.workflowAdjustmentCurrent(state.id);
  };
  const reopen = () => { database.close(); clock += 100_000; database = CollaborationStateDatabase.open(options); stores.push(database); return database; };
  const events = () => database.eventsAfter(state.id, 0, 1000);
  const request = () => readFile(join(storage.projectDir(state.id), "request.md"), "utf8");
  const persisted = () => storage.loadState(state.id);
  return { root, options, database, storage, state, session, apply, reopen, events, request, persisted, advance: () => { clock += 100_000; } };
}
function business(state: ProjectState) {
  const { agents: _a, orchestration: _o, skillDefinitions: _s, mcpDefinitions: _m, workflowRevision: _r, updatedAt: _u, archivedAgentSessions: _archive, ...original } = state;
  return structuredClone(original);
}
function removeWriting(proposal: WorkflowAdjustmentSnapshot) {
  proposal.orchestration.agents = proposal.orchestration.agents.filter(agent => agent.name !== "writing");
  delete proposal.agents.writing; delete proposal.orchestration.routes.writing; delete proposal.orchestration.decisionPlans.writing;
  for (const key of Object.keys(proposal.orchestration.routes)) proposal.orchestration.routes[key] = proposal.orchestration.routes[key].filter(edge => edge.target !== "writing");
}
const validator = () => vi.fn(async () => undefined);

describe("actual SDK configuration roll-forward from an explicitly registered serial journal", () => {
  it("does not treat the runtime reasoning migration diagnostic as a formal startup change", async () => {
    const f = await fixture();
    f.state.agents.idea.reasoningMigrationWarning = "Legacy runtime diagnostic";
    const current = f.database.serialWorkflowAdjustmentCurrent(f.state.id)!;
    expect(credentialFreeAgentConfiguration({ agents: f.state.agents, skillDefinitions: f.state.skillDefinitions!, mcpDefinitions: f.state.mcpDefinitions! }))
      .toEqual({ agents: current.snapshot.agents, skillDefinitions: current.snapshot.skillDefinitions, mcpDefinitions: current.snapshot.mcpDefinitions });
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator())).resolves.toEqual({ changed: false });
    expect(f.state.agents.idea.reasoningMigrationWarning).toBe("Legacy runtime diagnostic");
  });

  it("fences an actual replacement writer before the old publisher replaces an unchanged-version file", async () => {
    const f = await fixture(), original = business(f.state), request = join(f.storage.projectDir(f.state.id), "request.md");
    const bytes = await readFile(request), accepted = f.apply("Accepted configuration before writer handoff");
    const write = fs.writeFile.bind(fs); let replacement: CollaborationStateDatabase | undefined;
    const fault = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (!replacement && String(args[0]).includes(".request.md.")) {
        f.advance(); replacement = CollaborationStateDatabase.open({ ...f.options, instanceId: "replacement-writer" }); stores.push(replacement);
      }
    });
    try {
      await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator())).rejects.toThrow(/writer epoch\/expiry fence/);
      expect(replacement).toBeDefined(); expect(replacement!.writerLease().epoch).toBeGreaterThan(f.database.writerLease().epoch);
      expect(await readFile(request)).toEqual(bytes); expect(business(f.state)).toEqual(original);
      expect(replacement!.serialWorkflowAdjustmentCurrent(f.state.id)).toEqual(accepted);
      fault.mockRestore(); const events = replacement!.eventsAfter(f.state.id, 0, 1000);
      await restoreSerialWorkflowConfiguration(replacement!, f.storage, f.state, validator());
      expect((await f.persisted()).agents.writing.instructions).toBe(accepted.snapshot.agents.writing.instructions);
      expect(business(await f.persisted())).toEqual(original); expect(replacement!.eventsAfter(f.state.id, 0, 1000)).toEqual(events);
    } finally { fault.mockRestore(); }
  });

  it.each(["queued owner", "original Session", "retired Session", "private snapshot"])(
    "retains a late %s during persistence and never rolls it back with the old publisher", async mode => {
      const f = await fixture(), original = business(f.state);
      const gateway = { id: "gwy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Accepted route", url: "https://controlled.invalid", apiKey: "prepared-private-secret",
        models: [f.state.agents.writing.model], defaultModel: f.state.agents.writing.model, protocol: "responses" as const };
      f.apply("Accepted safe configuration", mode === "original Session" ? "claude-code" : undefined, proposal => {
        if (mode === "queued owner" || mode === "retired Session") removeWriting(proposal);
        if (mode === "private snapshot") proposal.agents.writing.gatewayId = gateway.id;
      });
      const validate = vi.fn(async (_state, proposal) => {
        if (mode === "private snapshot" && !proposal.agents.writing.gatewaySnapshot) proposal.agents.writing.gatewaySnapshot = structuredClone(gateway);
      });
      const request = f.storage.refreshRequestSnapshot.bind(f.storage); let arrived = false;
      const fault = vi.spyOn(f.storage, "refreshRequestSnapshot").mockImplementation(async (...args) => {
        await request(...args);
        if (arrived) return; arrived = true;
        if (mode === "queued owner") { f.state.queuedAgent = "writing"; f.state.queueOrder = 99; }
        if (mode === "original Session" || mode === "retired Session") {
          f.state.agentSessions!.writing = { ...f.session, nativeId: "late-original-writing-session", generation: 5 };
          f.state.agentSessionIds!.writing = "late-original-writing-session";
          f.state.agentSessionMeta!.writing = { generation: 5, contextSeq: 31, resumeFailureCount: 2 };
        }
        if (mode === "private snapshot") f.state.agents.writing.gatewaySnapshot = { ...gateway, apiKey: "late-original-private-secret" };
      });
      try {
        await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).rejects.toThrow(
          mode === "queued owner" ? /writing/ : mode === "original Session" ? /Harness|harness|Session/ : mode === "retired Session" ? /Original Session changed during serial persistence/ : /Original configuration changed during serial persistence/);
        expect(arrived).toBe(true);
        const events = f.events(), formal = f.database.serialWorkflowAdjustmentCurrent(f.state.id);
        if (mode === "queued owner") {
          expect(business(f.state)).toEqual({ ...original, queuedAgent: "writing", queueOrder: 99 });
          expect(f.state.orchestration.agents.some(agent => agent.name === "writing")).toBe(true);
        }
        if (mode === "original Session") {
          expect(f.state.agentSessions!.writing.nativeId).toBe("late-original-writing-session");
          expect(f.state.agentSessionIds!.writing).toBe("late-original-writing-session");
          expect(f.state.agentSessionMeta!.writing).toEqual({ generation: 5, contextSeq: 31, resumeFailureCount: 2 });
          expect(f.state.agents.writing.harness ?? "codex").toBe("codex");
          expect(f.state.activeAgentExecution).toEqual(original.activeAgentExecution); expect(f.state.runCounts).toEqual(original.runCounts);
        }
        if (mode === "private snapshot") {
          expect(f.state.agents.writing.gatewaySnapshot?.apiKey).toBe("late-original-private-secret");
          expect((await f.persisted()).agents.writing.gatewaySnapshot).toBeUndefined();
          fault.mockRestore();
          expect(await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).toEqual({ changed: true });
          expect(validate).toHaveBeenCalledTimes(2); expect(business(await f.persisted())).toEqual(original);
          expect((await f.persisted()).agents.writing.gatewaySnapshot?.apiKey).toBe("late-original-private-secret");
          expect(await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).toEqual({ changed: false });
        }
        if (mode === "retired Session") {
          const originalWithSession = business(f.state); fault.mockRestore();
          expect(f.state.agentSessions!.writing.nativeId).toBe("late-original-writing-session");
          await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate);
          const persisted = await f.persisted(); expect(business(persisted)).toEqual(originalWithSession);
          expect(persisted.archivedAgentSessions).toEqual([expect.objectContaining({ agentId: "writing",
            sessions: { writing: { session: f.state.agentSessions!.writing, legacyId: "late-original-writing-session" } },
            meta: { generation: 5, contextSeq: 31, resumeFailureCount: 2 } })]);
        }
        expect(f.events()).toEqual(events); expect(f.database.serialWorkflowAdjustmentCurrent(f.state.id)).toEqual(formal);
        expect(JSON.stringify(formal)).not.toContain("private-secret");
      } finally { fault.mockRestore(); }
    });

  it.each(["refreshRequestSnapshot", "writeMainAgentOrchestrationCurrentSnapshot", "saveState"].flatMap(step => [false, true].map(cycle => ({ step, cycle }))))(
    "rejects authority changes after $step and retries the current exact version (cycle=$cycle)", async ({ step, cycle }) => {
      const f = await fixture(), original = business(f.state);
      const draft = await f.storage.writeMainAgentOrchestrationSnapshot(f.state.id, "workflow.json", mainAgentOrchestrationDocument(f.state.id, f.state.orchestration, f.state.agents));
      const bytes = await readFile(draft), accepted = f.apply("Accepted configuration A");
      const method = f.storage[step].bind(f.storage); let advanced = false;
      const fault = vi.spyOn(f.storage, step).mockImplementation(async (...args) => {
        await method(...args);
        if (!advanced) { advanced = true; f.apply("Accepted configuration B"); if (cycle) f.apply("Accepted configuration A"); }
      });
      try {
        await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator())).rejects.toThrow(/authority changed during serial persistence/);
        expect(advanced).toBe(true); expect(business(f.state)).toEqual(original); expect(f.state.workflowRevision).toBeUndefined();
        const latest = f.database.serialWorkflowAdjustmentCurrent(f.state.id)!;
        expect(latest.version.revision).toBe(cycle ? 4 : 3); if (cycle) expect(latest.version.hash).toBe(accepted.version.hash);
        fault.mockRestore(); const events = f.events();
        await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator());
        expect(f.state.workflowRevision).toBe(latest.version.revision); expect(f.state.agents.writing.instructions).toBe(latest.snapshot.agents.writing.instructions);
        expect(business(await f.persisted())).toEqual(original); expect(f.events()).toEqual(events); expect(await readFile(draft)).toEqual(bytes);
        const reference = join(await f.storage.roleWorkspace(f.state.id, "main", "inv_persistence_reference"), MAIN_AGENT_ORCHESTRATION_CURRENT_FILE);
        expect(JSON.parse(await readFile(reference, "utf8")).baseVersion).toEqual(latest.version);
      } finally { fault.mockRestore(); }
    });

  it.each(["request.md", "workflow-current.json", "state.json", "state retry"])(
    "rejects a stale configuration before replacing %s and preserves the original file", async target => {
      const f = await fixture(), original = business(f.state);
      await f.storage.writeMainAgentOrchestrationSnapshot(f.state.id, "workflow.json", mainAgentOrchestrationDocument(f.state.id, f.state.orchestration, f.state.agents));
      const reference = join(await f.storage.roleWorkspace(f.state.id, "main", "inv_atomic_reference"), MAIN_AGENT_ORCHESTRATION_CURRENT_FILE);
      const file = target === "workflow-current.json" ? reference : join(f.storage.projectDir(f.state.id), target === "state retry" ? "state.json" : target);
      const bytes = await readFile(file), accepted = f.apply("Accepted configuration A"); let advanced = false;
      const write = fs.writeFile.bind(fs), rename = fs.rename.bind(fs);
      const tempPrefix = join(file.slice(0, file.lastIndexOf('/')), `.${file.slice(file.lastIndexOf('/') + 1)}.`);
      const writeFault = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await write(...args);
        if (target !== "state retry" && !advanced && String(args[0]).startsWith(tempPrefix)) { advanced = true; f.apply("Accepted configuration B"); }
      });
      const renameFault = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (target === "state retry" && !advanced && String(args[1]) === file) {
          advanced = true; f.apply("Accepted configuration B"); throw Object.assign(new Error("State replacement temporarily busy"), { code: "EBUSY" });
        }
        await rename(...args);
      });
      try {
        await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator())).rejects.toThrow(/authority changed during serial persistence/);
        expect(advanced).toBe(true); expect(await readFile(file)).toEqual(bytes); expect(business(f.state)).toEqual(original);
        const latest = f.database.serialWorkflowAdjustmentCurrent(f.state.id)!; expect(latest.version.revision).toBe(accepted.version.revision + 1);
        expect((await fs.readdir(file.slice(0, file.lastIndexOf('/')))).some(name => name.startsWith(tempPrefix.slice(tempPrefix.lastIndexOf('/') + 1)))).toBe(false);
        writeFault.mockRestore(); renameFault.mockRestore(); const events = f.events();
        await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator());
        expect(f.state.workflowRevision).toBe(latest.version.revision); expect((await f.persisted()).agents.writing.instructions).toBe("Accepted configuration B");
        expect(business(await f.persisted())).toEqual(original); expect(f.events()).toEqual(events);
      } finally { writeFault.mockRestore(); renameFault.mockRestore(); }
    });

  it.each(["recover", "existing", "unavailable", "no validator", "empty validation", "wrong route", "late snapshot", "persistence failure"])(
    "recovers an unchanged formal gateway route without replacing original runtime facts (%s)", async mode => {
      const f = await fixture();
      const agent = f.state.agents.idea; agent.gatewayId = "gwy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; agent.model = "recovery-model";
      const snapshot = { id: agent.gatewayId, name: "Original accepted gateway", url: "https://controlled.invalid", apiKey: "recovered-server-secret",
        models: [agent.model], defaultModel: agent.model, protocol: "responses" as const };
      if (mode === "existing") agent.gatewaySnapshot = { ...snapshot, apiKey: "original-locked-secret" };
      f.database.appendEvent({ projectId: f.state.id, type: "scoped.configuration.applied", payload: {
        configuration: credentialFreeAgentConfiguration({ agents: f.state.agents, skillDefinitions: {}, mcpDefinitions: {} }) } });
      await f.storage.saveState(f.state);
      const original = business(f.state), events = f.events(), formal = f.database.serialWorkflowAdjustmentCurrent(f.state.id);
      let retry = false;
      const validate = vi.fn(async (_state, proposal) => {
        if (mode === "unavailable" && !retry) throw new Error("Selected gateway unavailable");
        if (mode === "empty validation" && !retry) return;
        if (mode === "late snapshot" && !retry) {
          f.state.agents.idea.gatewaySnapshot = { ...snapshot, apiKey: "late-original-locked-secret" };
          await f.storage.saveState(f.state);
        }
        if (mode === "wrong route" && !retry) proposal.agents.idea.gatewayId = "gwy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        proposal.agents.idea.gatewaySnapshot = structuredClone(snapshot);
      });
      const save = f.storage.saveState.bind(f.storage);
      const persistence = vi.spyOn(f.storage, "saveState").mockImplementation(async next => {
        if (mode === "persistence failure" && !retry && next.agents.idea.gatewaySnapshot) throw new Error("Private snapshot persistence failed");
        await save(next);
      });
      const restore = () => restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, mode === "no validator" ? undefined : validate);
      try {
        if (["unavailable", "no validator", "empty validation", "wrong route", "late snapshot", "persistence failure"].includes(mode)) {
          const reason = mode === "unavailable" ? /Selected gateway unavailable/ : mode === "no validator" ? /validator/ :
            mode === "late snapshot" ? /changed during serial recovery/ : mode === "persistence failure" ? /Private snapshot persistence failed/ : /网关.*快照/;
          await expect(restore()).rejects.toThrow(reason);
          expect(f.state.agents.idea.gatewaySnapshot).toEqual(mode === "late snapshot" ? { ...snapshot, apiKey: "late-original-locked-secret" } : undefined);
          if (mode !== "no validator") { retry = true; await restore(); }
        } else await restore();
        expect(business(f.state)).toEqual(original); expect(f.events()).toEqual(events);
        expect(f.database.serialWorkflowAdjustmentCurrent(f.state.id)).toEqual(formal);
        const persisted = await f.persisted();
        expect(business(persisted)).toEqual(original);
        if (mode !== "no validator") {
          const expected = mode === "existing" ? { ...snapshot, apiKey: "original-locked-secret" } :
            mode === "late snapshot" ? { ...snapshot, apiKey: "late-original-locked-secret" } : snapshot;
          expect(persisted.agents.idea.gatewaySnapshot).toEqual(expected);
          const calls = validate.mock.calls.length; expect(await restore()).toEqual({ changed: false }); expect(validate).toHaveBeenCalledTimes(calls);
        }
        expect(validate).toHaveBeenCalledTimes(mode === "existing" || mode === "no validator" ? 0 :
          ["recover", "late snapshot"].includes(mode) ? 1 : 2);
        expect(JSON.stringify(formal)).not.toContain("server-secret"); expect(JSON.stringify(formal)).not.toContain("locked-secret");
      } finally { persistence.mockRestore(); }
    });

  it("rejects the retained original version after A-to-B-to-A publication even when the exact configuration hash matches again", async () => {
    const f = await fixture(), version = f.database.workflowAdjustmentCurrent(f.state.id).version;
    const document = mainAgentOrchestrationDocument(f.state.id, f.state.orchestration, f.state.agents, {}, {}, version);
    const draft = await f.storage.writeMainAgentOrchestrationSnapshot(f.state.id, "workflow.json", document); const original = await readFile(draft);
    const instructions = f.state.agents.writing.instructions;
    f.apply("Intervening B configuration"); await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => undefined);
    f.apply(instructions); await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => undefined);
    const current = f.database.workflowAdjustmentCurrent(f.state.id), referencePath = join(await f.storage.roleWorkspace(f.state.id, "main", "inv_read_aba"), MAIN_AGENT_ORCHESTRATION_CURRENT_FILE);
    const reference = JSON.parse(await readFile(referencePath, "utf8"));
    expect(reference.baseHash).toBe(document.baseHash); expect(current.version.revision).toBe(3); expect(reference.baseVersion).toEqual(current.version);
    expect(() => parseAgentOrchestrationProposal(original.toString("utf8"), f.state.id, f.state.orchestration, f.state.agents, { baseVersion: current.version })).toThrow("original configuration version");
    await f.storage.writeMainAgentOrchestrationCurrentSnapshot(f.state.id, document,
      () => sameWorkflowConfigurationVersion(f.database.serialWorkflowAdjustmentCurrent(f.state.id)!.version, version));
    expect(JSON.parse(await readFile(referencePath, "utf8")).baseVersion).toEqual(current.version);
    expect(await readFile(draft)).toEqual(original);
  });

  it("preserves a legacy draft without an exact version and requires explicit reconciliation before a serial tool can accept it", async () => {
    const f = await fixture(), current = f.database.workflowAdjustmentCurrent(f.state.id);
    const legacy = mainAgentOrchestrationDocument(f.state.id, f.state.orchestration, f.state.agents);
    legacy.agents.main.instructions = "Original legacy unsent edits";
    expect(() => parseAgentOrchestrationProposal(JSON.stringify(legacy), f.state.id, f.state.orchestration, f.state.agents, { baseVersion: current.version })).toThrow("original configuration version");
    const reconciled = mainAgentOrchestrationDocument(f.state.id, f.state.orchestration, f.state.agents, {}, {}, current.version);
    reconciled.agents.main.instructions = legacy.agents.main.instructions;
    expect(parseAgentOrchestrationProposal(JSON.stringify(reconciled), f.state.id, f.state.orchestration, f.state.agents, { baseVersion: current.version }).agents.main.instructions).toBe(legacy.agents.main.instructions);
  });

  it("refreshes the accepted reference during configuration publication without waiting for Main or changing its original draft", async () => {
    const f = await fixture();
    const document = mainAgentOrchestrationDocument(f.state.id, f.state.orchestration, f.state.agents);
    const draft = await f.storage.writeMainAgentOrchestrationSnapshot(f.state.id, "workflow.json", document);
    const original = Buffer.from("Original unfinished Main authoring bytes, including 原草稿"); await writeFile(draft, original);
    const before = business(f.state); f.apply("Current user-accepted instructions");
    await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => undefined);
    expect(await readFile(draft)).toEqual(original);
    const current = JSON.parse(await readFile(join(await f.storage.roleWorkspace(f.state.id, "main", "inv_read_current"), MAIN_AGENT_ORCHESTRATION_CURRENT_FILE), "utf8"));
    expect(current.agents.writing.instructions).toBe("Current user-accepted instructions");
    expect(current.baseHash).not.toBe(document.baseHash); expect(business(f.state)).toEqual(before);
  });

  it("keeps the original draft and accepted journal fact when current-reference persistence fails, then repairs the same accepted version", async () => {
    const f = await fixture(), before = structuredClone(f.state);
    const draft = await f.storage.writeMainAgentOrchestrationSnapshot(f.state.id, "workflow.json", mainAgentOrchestrationDocument(f.state.id, f.state.orchestration, f.state.agents));
    const original = await readFile(draft); f.apply("Accepted reference recovery instructions");
    vi.spyOn(f.storage, "writeMainAgentOrchestrationCurrentSnapshot").mockRejectedValueOnce(new Error("Original current-reference persistence failed"));
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => undefined)).rejects.toThrow("Original current-reference persistence failed");
    expect(f.state.workflowRevision).toBe(before.workflowRevision); expect(f.state.agents).toEqual(before.agents); expect(await readFile(draft)).toEqual(original);
    expect(f.database.workflowAdjustmentCurrent(f.state.id).version.revision).toBe(2);
    await restoreSerialWorkflowConfiguration(f.reopen(), f.storage, f.state, async () => undefined);
    expect(f.state.workflowRevision).toBe(2); expect(await readFile(draft)).toEqual(original);
    const current = JSON.parse(await readFile(join(await f.storage.roleWorkspace(f.state.id, "main", "inv_read_recovered_current"), MAIN_AGENT_ORCHESTRATION_CURRENT_FILE), "utf8"));
    expect(current.agents.writing.instructions).toBe("Accepted reference recovery instructions");
  });

  it("does not enroll or write an ordinary unregistered SDK project", async () => {
    const f = await fixture(false), validate = validator(), before = await f.persisted(), events = f.events(), request = await f.request();
    expect(f.database.serialWorkflowAdjustmentCurrent("absent-project")).toBeUndefined();
    expect(await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).toBeUndefined();
    expect(validate).not.toHaveBeenCalled(); expect(await f.persisted()).toEqual(before); expect(f.events()).toEqual(events); expect(await f.request()).toBe(request);
  });

  it("restores only the exact accepted configuration while preserving actual SDK-owned task, Session, FIFO, Loop and budgets", async () => {
    const f = await fixture(), accepted = f.apply(), before = business(f.state), events = f.events(), validate = validator();
    const owner = f.state.activeAgentExecution, sessions = f.state.agentSessions, counts = f.state.runCounts;
    expect(await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).toEqual({ changed: true });
    expect(f.state.agents.writing.instructions).toBe(accepted.snapshot.agents.writing.instructions); expect(f.state.workflowRevision).toBe(2);
    expect(business(f.state)).toEqual(before); expect(business(await f.persisted())).toEqual(before);
    expect(f.state.activeAgentExecution).toBe(owner); expect(f.state.agentSessions).toBe(sessions); expect(f.state.runCounts).toBe(counts);
    expect(await f.request()).toContain(accepted.snapshot.agents.writing.instructions); expect(f.events()).toEqual(events); expect(validate).toHaveBeenCalledOnce();
    const currentRequest = await f.request(); validate.mockClear();
    expect(await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).toEqual({ changed: false });
    expect(validate).not.toHaveBeenCalled(); expect(await f.request()).toBe(currentRequest); expect(f.events()).toEqual(events);
  });

  it("keeps the immutable formal configuration when the resource validator changes its disposable copy", async () => {
    const f = await fixture(), accepted = f.apply();
    await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async (_state, proposal) => {
      proposal.agents.writing.instructions = "A disposable validator must not rewrite the accepted proposal";
      proposal.orchestration.allowMainReconfiguration = !proposal.orchestration.allowMainReconfiguration;
      proposal.agents.writing.gatewaySnapshot = { id: "controlled-route", name: "Controlled route", url: "http://127.0.0.1:1", apiKey: "controlled-server-private-key", models: [proposal.agents.writing.model], defaultModel: proposal.agents.writing.model, protocol: "responses" };
    });
    expect(f.state.agents.writing.instructions).toBe(accepted.snapshot.agents.writing.instructions);
    expect(f.state.orchestration).toEqual(accepted.snapshot.orchestration); expect(f.database.workflowAdjustmentCurrent(f.state.id)).toEqual(accepted);
    expect(f.state.agents.writing.gatewaySnapshot?.apiKey).toBe("controlled-server-private-key");
    expect(JSON.stringify(f.database.workflowAdjustmentCurrent(f.state.id))).not.toContain("controlled-server-private-key");
    expect(await f.request()).not.toContain("controlled-server-private-key");
  });

  for (const step of ["refreshRequestSnapshot", "saveState"] as const) it(`retries the exact original accepted revision after ${step} fails and the database writer reopens`, async () => {
    const f = await fixture(), accepted = f.apply(), before = structuredClone(f.state), events = f.events();
    const fault = vi.spyOn(f.storage, step).mockRejectedValueOnce(new Error(`Injected ${step} failure`));
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator())).rejects.toThrow(`Injected ${step} failure`);
    expect(f.state).toEqual(before); expect(await f.persisted()).toEqual(before); expect(f.database.workflowAdjustmentCurrent(f.state.id)).toEqual(accepted); expect(f.events()).toEqual(events);
    fault.mockRestore();
    const reopened = f.reopen(), loaded = await f.persisted();
    await restoreSerialWorkflowConfiguration(reopened, f.storage, loaded, validator());
    expect((await f.persisted()).agents.writing.instructions).toBe(accepted.snapshot.agents.writing.instructions); expect(loaded.workflowRevision).toBe(2);
    expect(business(loaded)).toEqual(business(before)); expect(f.events()).toEqual(events);
  });

  it("rejects a version change during async resource validation and recovers the new exact version on retry", async () => {
    const f = await fixture(); f.apply("First accepted revision"); const before = structuredClone(f.state);
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => { f.apply("Newer accepted revision"); })).rejects.toThrow("authority changed");
    expect(f.state).toEqual(before); expect(await f.persisted()).toEqual(before);
    await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator());
    expect(f.state.workflowRevision).toBe(3); expect(f.state.agents.writing.instructions).toBe("Newer accepted revision"); expect(business(f.state)).toEqual(business(before));
  });

  it("rechecks a Session bound during validation without replacing it or silently recovering another Harness", async () => {
    const f = await fixture(); f.apply("A formally accepted route", "claude-code"); const agents = f.state.agents;
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => {
      f.state.agentSessions!.writing = { ...f.session, nativeId: "late-original-worker-session" };
    })).rejects.toThrow(/Harness/);
    expect(f.state.agents).toBe(agents); expect(f.state.workflowRevision).toBeUndefined();
    expect(f.state.agentSessions!.writing.nativeId).toBe("late-original-worker-session"); expect((await f.persisted()).agents).toEqual(agents);
  });

  it("does not overwrite an SDK configuration changed during async recovery validation", async () => {
    const f = await fixture(); f.apply(); const request = await f.request();
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => {
      f.state.agents.writing.instructions = "Newer actual SDK configuration";
    })).rejects.toThrow("SDK configuration changed");
    expect(f.state.agents.writing.instructions).toBe("Newer actual SDK configuration");
    expect(f.state.workflowRevision).toBeUndefined(); expect(await f.request()).toBe(request);
  });

  it("rechecks retained Session authority even when the SDK configuration already matches the journal", async () => {
    const f = await fixture(); f.apply("Accepted route before the late Session", "claude-code");
    await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator());
    f.state.agentSessions!.writing = { ...f.session, nativeId: "late-original-matching-projection-session" };
    const validate = validator(), request = await f.request();
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).rejects.toThrow(/Harness/);
    expect(validate).not.toHaveBeenCalled(); expect(await f.request()).toBe(request);
    expect(f.state.agentSessions!.writing.nativeId).toBe("late-original-matching-projection-session");
  });

  for (const late of [false, true]) it(`archives a removed Agent's exact original Session ${late ? "bound during validation" : "already present before validation"} and reloads it without replacing the original task`, async () => {
    const f = await fixture();
    f.apply("Remove only the Agent configuration", undefined, proposal => {
      proposal.orchestration.agents = proposal.orchestration.agents.filter(agent => agent.name !== "writing");
      delete proposal.agents.writing; delete proposal.orchestration.routes.writing; delete proposal.orchestration.decisionPlans.writing;
      for (const key of Object.keys(proposal.orchestration.routes)) proposal.orchestration.routes[key] = proposal.orchestration.routes[key].filter(edge => edge.target !== "writing");
    });
    const bind = () => { f.state.agentSessions!.writing = { ...f.session, nativeId: "retained-removed-agent-session" };
      f.state.agentSessionIds!.writing = "retained-removed-agent-session"; };
    if (!late) bind();
    const validate = vi.fn(async () => { if (late) bind(); });
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).resolves.toEqual({ changed: true });
    expect(validate).toHaveBeenCalledOnce();
    expect(f.state.agentSessions!.writing.nativeId).toBe("retained-removed-agent-session"); expect(f.state.agents.writing).toBeUndefined();
    expect(f.state.archivedAgentSessions).toEqual([expect.objectContaining({ agentId: "writing", harnessId: "codex", workflowRevision: 2,
      sessions: { writing: { session: f.state.agentSessions!.writing, legacyId: "retained-removed-agent-session" } } })]);
    const persisted = await f.persisted(); expect(persisted.agents.writing).toBeUndefined();
    expect(persisted.archivedAgentSessions).toEqual(f.state.archivedAgentSessions);
    expect(persisted.activeAgentExecution).toEqual(f.state.activeAgentExecution); expect(persisted.runCounts.writing).toBe(7);
    const events = f.events();
    await expect(restoreSerialWorkflowConfiguration(f.reopen(), f.storage, persisted, validate)).resolves.toEqual({ changed: false });
    expect(persisted.archivedAgentSessions).toHaveLength(1); expect(f.events()).toEqual(events);
    f.state.agentSessions!.writing.nativeId = "later-native-binding";
    expect(f.state.archivedAgentSessions![0].sessions.writing.session!.nativeId).toBe("retained-removed-agent-session");
  });

  it("fails resource validation before writing either mirror and refuses missing validation authority", async () => {
    const f = await fixture(); f.apply(); const before = structuredClone(f.state), request = await f.request();
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, async () => { throw new Error("Actual resource unavailable"); })).rejects.toThrow("Actual resource unavailable");
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, undefined)).rejects.toThrow("validator");
    expect(f.state).toEqual(before); expect(await f.persisted()).toEqual(before); expect(await f.request()).toBe(request);
  });

  it.each(["refreshRequestSnapshot", "writeMainAgentOrchestrationCurrentSnapshot", "saveState"] as const)("rolls back retirement metadata after %s fails and archives the same accepted revision on retry", async method => {
    const f = await fixture(); f.state.agentSessions!.writing = { ...f.session, nativeId: "original-writing-session" };
    await f.storage.saveState(f.state); f.apply("Remove writing", undefined, removeWriting);
    const sessions = structuredClone(f.state.agentSessions), original = business(f.state);
    const failed = vi.spyOn(f.storage, method).mockRejectedValueOnce(new Error("Controlled archive publication failure"));
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator())).rejects.toThrow("Controlled archive publication failure");
    expect(f.state.archivedAgentSessions).toBeUndefined(); expect(f.state.agents.writing).toBeDefined();
    expect(business(f.state)).toEqual(original); expect((await f.persisted()).agentSessions).toEqual(sessions);
    expect(f.database.serialWorkflowAdjustmentCurrent(f.state.id)!.version.revision).toBe(2);
    failed.mockRestore();
    await restoreSerialWorkflowConfiguration(f.reopen(), f.storage, f.state, validator());
    expect((await f.persisted()).archivedAgentSessions).toEqual(f.state.archivedAgentSessions);
    expect(f.state.archivedAgentSessions).toHaveLength(1); expect(f.state.agentSessions).toEqual(sessions);
  });

  it.each(["activeAgentExecution", "currentAgent", "queuedAgent"] as const)("does not archive or delete an original unfinished %s owner", async field => {
    const f = await fixture(); f.apply("Remove writing", undefined, removeWriting);
    if (field === "activeAgentExecution") f.state.activeAgentExecution!.agent = "writing";
    else f.state[field] = "writing";
    const validate = validator();
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).rejects.toThrow(/writing.*原未结束任务/);
    expect(validate).not.toHaveBeenCalled(); expect(f.state.archivedAgentSessions).toBeUndefined(); expect(f.state.agents.writing).toBeDefined();
  });

  it("preserves legacy-only and scoped original bindings, metadata and files without creating a replacement Session", async () => {
    const f = await fixture(), originalConfig = structuredClone(f.state.agents.writing);
    f.state.agentSessionIds!.writing = "legacy-original-writing";
    const scopedKey = "writing::collaboration:delivery:original-scope";
    f.state.agentSessions![scopedKey] = { ...f.session, nativeId: "original-scoped-writing" };
    f.state.agentSessionMeta!.writing = { generation: 4, contextSeq: 17, resumeFailureCount: 2 };
    const workspace = await f.storage.roleWorkspace(f.state.id, "writing", "inv_original_archive_memory");
    const memory = join(workspace, "original-memory.txt"); await writeFile(memory, "Original business memory 原记录");
    f.apply("Remove writing", undefined, removeWriting);
    await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator());
    const archive = f.state.archivedAgentSessions![0];
    expect(archive.sessions.writing).toEqual({ legacyId: "legacy-original-writing" });
    expect(archive.sessions[scopedKey].session).toEqual(f.state.agentSessions![scopedKey]);
    expect(archive.meta).toEqual({ generation: 4, contextSeq: 17, resumeFailureCount: 2 });
    expect(await readFile(memory, "utf8")).toBe("Original business memory 原记录");
    expect((await f.persisted()).archivedAgentSessions).toEqual([archive]);
    expect(() => assertWorkflowSessionHarnesses(f.state, { ...f.state.agents, writing: { ...originalConfig, harness: "claude-code" } })).toThrow(/codex/);
    expect(() => assertWorkflowSessionHarnesses(f.state, { ...f.state.agents, independent_new_agent: { ...originalConfig, harness: "claude-code" } })).not.toThrow();
  });

  it("preserves readable legacy partial Session metadata without inventing missing counters", async () => {
    const f = await fixture(); f.state.agentSessions!.writing = { ...f.session, nativeId: "original-partial-metadata-session" };
    f.state.agentSessionMeta!.writing = { generation: 4 } as NonNullable<ProjectState["agentSessionMeta"]>[string];
    await f.storage.saveState(f.state); expect((await f.persisted()).agentSessionMeta!.writing).toEqual({ generation: 4 });
    f.apply("Remove writing", undefined, removeWriting); await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator());
    expect((await f.persisted()).archivedAgentSessions![0].meta).toEqual({ generation: 4 });
    expect(f.state.agentSessionMeta!.writing).toEqual({ generation: 4 });
  });

  it.each(["missing", "native-id", "legacy-id", "wrong-agent", "invalid-scope", "revision"] as const)("rejects a %s archive instead of treating an unrelated Session as retained", async corruption => {
    const f = await fixture(); f.state.agentSessions!.writing = { ...f.session, nativeId: "original-writing" };
    f.state.agentSessionIds!.writing = "original-writing";
    f.apply("Remove writing", undefined, removeWriting); await restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validator());
    const state = structuredClone(f.state), archive = state.archivedAgentSessions![0];
    if (corruption === "missing") delete state.archivedAgentSessions;
    else if (corruption === "native-id") archive.sessions.writing.session!.nativeId = "different-native-session";
    else if (corruption === "legacy-id") state.agentSessionIds!.writing = "different-legacy-session";
    else if (corruption === "wrong-agent") archive.agentId = "idea";
    else if (corruption === "revision") archive.workflowRevision = 0;
    else archive.sessions["writing::collaboration:unsupported:scope"] = { legacyId: "not-an-original-role" };
    await writeFile(join(f.storage.projectDir(state.id), "state.json"), JSON.stringify(state));
    await expect(f.persisted()).rejects.toThrow(/incompatible/i);
  });

  it("archives a legal Unicode Agent identity without mutating its native reference or accounting", async () => {
    const f = await fixture(); f.state.agents["研究员"] = f.state.agents.writing;
    f.state.orchestration.agents.push({ name: "研究员", template: "writing" });
    f.state.agentSessions!["研究员"] = { ...f.session, nativeId: "original-unicode-session" };
    const next = { ...f.state.agents }; delete next["研究员"];
    const original = business(f.state); archiveRemovedWorkflowAgentSessions(f.state, next, 2);
    expect(business(f.state)).toEqual(original);
    expect(f.state.archivedAgentSessions![0].agentId).toBe("研究员");
    archiveRemovedWorkflowAgentSessions(f.state, next, 2); expect(f.state.archivedAgentSessions).toHaveLength(1);
  });

  it("refuses another scheduler, an ahead SDK revision and removal of the actual original unfinished owner", async () => {
    const f = await fixture(); f.apply(); const validate = validator();
    f.state.git = { enabled: true, status: "ready", provider: "github" };
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).rejects.toThrow("scheduler");
    f.state.git = { enabled: false, status: "disabled" }; f.state.workflowRevision = 3;
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).rejects.toThrow("ahead");
    f.state.workflowRevision = undefined; f.state.activeAgentExecution!.agent = "removed-original-owner";
    await expect(restoreSerialWorkflowConfiguration(f.database, f.storage, f.state, validate)).rejects.toThrow(/removed-original-owner.*原未结束任务/);
    expect(validate).not.toHaveBeenCalled(); expect(f.state.agents.writing.instructions).not.toBe("Exact accepted SDK configuration");
  });

  it.each(["idle", "unbound", "active", "queued"] as const)("uses the real ordinary user submission and scheduler retirement gate (%s original owner)", async owner => {
    const f = await fixture(); if (owner !== "unbound") f.state.agentSessions!.writing = { ...f.session, nativeId: "original-writing-session" };
    f.state.tokenUsage = createProjectTokenUsage(Object.keys(f.state.agents));
    applyGatewayUsageReport(f.state.tokenUsage, "writing", { usageId: "original-writing-usage", protocol: "responses", model: "controlled",
      inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 13 }, f.session.createdAt);
    const originalUsage = structuredClone(f.state.tokenUsage);
    await f.storage.saveState(f.state); f.database.close(); f.advance();
    const storage = new ProjectStorage(join(f.root, "data"), new EventHub());
    const coordinator = new CollaborationRuntimeCoordinator({ storage, databasePath: f.options.databasePath, serviceId: f.options.serviceId,
      hostId: f.options.hostId, now: f.options.now, validateWorkflowConfiguration: validator() });
    const run = vi.fn<AgentRunner["run"]>(async () => { throw new Error("Configuration submission cannot wake a model"); });
    const orchestrator = new Orchestrator(storage, new SkillCatalog([]), { run, harnessCatalog: async () => [] } as AgentRunner,
      { retryBaseMs: 1, retryMaxMs: 1 }, undefined, coordinator); runtimes.push(orchestrator); await orchestrator.initialize();
    const runtime = (orchestrator as unknown as { runtimes: Map<string, { state: ProjectState }> }).runtimes.get(f.state.id)!;
    runtime.state.status = "running"; runtime.state.pauseRequest = undefined;
    if (owner === "active") runtime.state.activeAgentExecution!.agent = "writing";
    if (owner === "queued") { runtime.state.activeAgentExecution = undefined; runtime.state.queuedAgent = "writing"; }
    const originalTask = structuredClone(runtime.state.activeAgentExecution);
    const context = coordinator.getWorkflowAdjustments(runtime.state), proposal = structuredClone(context.current.snapshot); removeWriting(proposal);
    const result = await orchestrator.submitWorkflowAdjustment(f.state.id, { projectId: f.state.id, requestId: "actual-retire-writing", base: context.current.version, proposal });
    if (owner === "idle" || owner === "unbound") {
      expect(result.record.status).toBe("applied"); expect(runtime.state.agents.writing).toBeUndefined();
      expect((await storage.loadState(f.state.id)).archivedAgentSessions).toHaveLength(1);
    } else {
      expect(result.record.status).toBe("pending"); expect(result.record.waitingReason).toMatch(/writing.*原未结束任务/);
      expect(runtime.state.archivedAgentSessions).toBeUndefined(); expect(runtime.state.agents.writing).toBeDefined();
    }
    expect(runtime.state.activeAgentExecution).toEqual(originalTask); expect(runtime.state.agentSessions!.writing?.nativeId).toBe(owner === "unbound" ? undefined : "original-writing-session");
    if (owner === "unbound") expect(runtime.state.archivedAgentSessions![0].sessions).toEqual({});
    expect(runtime.state.tokenUsage).toEqual(originalUsage);
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the production coordinator hook before original SDK startup, preserves retired accounting on repeated restarts and never wakes paused Main", async () => {
    const f = await fixture(), accepted = f.apply(), original = business(f.state); f.database.close(); f.advance();
    const run = vi.fn<AgentRunner["run"]>(async () => { throw new Error("Paused SDK project must never run"); });
    const runner = { run, harnessCatalog: async () => [] } as AgentRunner;
    const validate = validator();
    const restart = async () => {
      const storage = new ProjectStorage(join(f.root, "data"), new EventHub());
      const coordinator = new CollaborationRuntimeCoordinator({ storage, databasePath: f.options.databasePath, serviceId: f.options.serviceId, hostId: f.options.hostId, now: f.options.now, validateWorkflowConfiguration: validate });
      const orchestrator = new Orchestrator(storage, new SkillCatalog([]), runner, { retryBaseMs: 1, retryMaxMs: 1 }, undefined, coordinator);
      runtimes.push(orchestrator); await orchestrator.initialize(); return { orchestrator, storage };
    };
    const first = await restart(), loaded = await first.storage.loadState(f.state.id);
    expect(loaded.agents.writing.instructions).toBe(accepted.snapshot.agents.writing.instructions); expect(loaded.workflowRevision).toBe(2);
    expect(loaded.agentSessions).toEqual(original.agentSessions); expect(loaded.activeAgentExecution).toEqual(original.activeAgentExecution);
    expect(loaded.runCounts.retired).toBe(17); expect(loaded.executionCounts!.retired).toBe(23);
    expect(loaded.loopIterations!.original).toBe(4); expect(loaded.queueOrder).toBe(29); expect(run).not.toHaveBeenCalled();
    const events = await readFile(join(first.storage.projectDir(f.state.id), "events.jsonl"), "utf8");
    await first.orchestrator.shutdown(); f.advance(); validate.mockClear();
    const second = await restart(), again = await second.storage.loadState(f.state.id);
    expect(again.agentSessions).toEqual(loaded.agentSessions); expect(again.activeAgentExecution).toEqual(loaded.activeAgentExecution);
    expect(again.runCounts.retired).toBe(17); expect(again.executionCounts!.retired).toBe(23);
    expect(await readFile(join(second.storage.projectDir(f.state.id), "events.jsonl"), "utf8")).toBe(events);
    expect(validate).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
});
