import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openCollaborationStateWorker, type AsyncCollaborationStateStore } from "../src/collaboration-state/database-worker.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { restoreSerialWorkflowConfiguration } from "../src/serial-workflow-projection.js";
import type { ProjectState } from "../src/types.js";
import { CollaborationRuntimeCoordinator } from "../src/collaboration-runtime.js";
import type { ProjectStateDocumentStore } from "../src/project-state-documents.js";

const resources: Array<{ root: string; database: AsyncCollaborationStateStore }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.database.close();
    await fs.rm(resource.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-serial-publication-worker-"));
  const options = { databasePath: path.join(root, "state.sqlite"), serviceId: "serial-publication-test",
    hostId: "test", topology: "single-host" as const, leaseDurationMs: 180_000 };
  const resource = { root, database: await openCollaborationStateWorker(options) }; resources.push(resource);
  const storage = new ProjectStorage(path.join(root, "data"), new EventHub()); await storage.initialize();
  const orchestration = cloneAgentOrchestrationTemplate(), agents = mergeAgentConfigs(undefined, orchestration);
  const state: ProjectState = { id: "prj_" + "e".repeat(32), title: "Serial publication worker regression",
    requirement: "Preserve original tasks and sessions while restoring the accepted configuration",
    status: "paused", phase: "paused", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    turn: 0, cycle: 0, eventSeq: 0, completionGeneration: 0, consecutiveFailures: 0, mainInvocationSeq: 0,
    runCounts: {}, agents, orchestration, skillDefinitions: {}, mcpDefinitions: {}, controlProtocol: "natural-language-tools-v1",
    git: { enabled: false, status: "disabled" } };
  await storage.createProject(state);
  await resource.database.createProject({ projectId: state.id, workflowRevision: 1, workflowSnapshot: orchestration,
    workerCapacity: 1, git: state.git! });
  await resource.database.initializeScopedConfiguration(state.id, { agents, skillDefinitions: {}, mcpDefinitions: {} });
  await resource.database.initializeSerialWorkflowJournal(state.id);
  await resource.database.initializeProjectStateDomain({ projectId: state.id, scheduler: "serial", checkpoint: state,
    publishView: document => storage.publishProjectStateView(document) });
  const documents: ProjectStateDocumentStore = {
    domain: id => resource.database.projectStateDomain(id),
    read: (id, name) => resource.database.projectStateDocument(id, name),
    write: (...args) => resource.database.writeProjectStateDocument(...args)
  };
  await storage.configureProjectStateStore(documents);
  state.agentSessions = { idea: { schemaVersion: 1, harnessId: "codex", adapterVersion: "test", nativeId: "original-session",
    generation: 2, durable: true, createdAt: state.createdAt } };
  state.agentSessionIds = { idea: "original-session" };
  state.activeAgentExecution = { id: "original-task", agent: "idea", source: "configured-route", createdAt: state.createdAt,
    startedAt: state.createdAt, firstInvocationId: "original-invocation", latestInvocationId: "original-invocation" };
  state.runCounts = { main: 11, idea: 4 }; state.turn = 15; state.cycle = 3;
  state.loopIterations = { original: 2 }; state.loopTotalIterations = { original: 5 };
  await storage.saveState(state);
  const apply = async (instructions: string) => {
    const current = (await resource.database.serialWorkflowAdjustmentCurrent(state.id))!, proposal = structuredClone(current.snapshot);
    proposal.agents.writing.instructions = instructions;
    const requestId = `accepted-${current.version.revision}`;
    await resource.database.submitUserWorkflowAdjustment({ projectId: state.id, requestId, base: current.version, proposal,
      explanation: "Explicit test configuration adjustment" });
    const prepared = await resource.database.prepareSerialWorkflowAdjustmentPublication(state.id, requestId);
    if (!prepared.ready) throw new Error("Test adjustment unexpectedly waits");
    await resource.database.publishSerialWorkflowAdjustment(state.id, requestId, prepared.validationToken,
      { sessions: state, waitingReason: () => undefined });
    return (await resource.database.serialWorkflowAdjustmentCurrent(state.id))!;
  };
  const reopen = async () => {
    await resource.database.relinquishWriterLease(); await resource.database.close();
    resource.database = await openCollaborationStateWorker(options);
    return resource.database;
  };
  const file = path.join(storage.projectDir(state.id), "state.json");
  return { resource, storage, state, apply, reopen, file, documents };
}

function business(state: ProjectState) {
  const { agents: _agents, orchestration: _orchestration, skillDefinitions: _skills, mcpDefinitions: _mcp,
    workflowRevision: _revision, updatedAt: _updated, archivedAgentSessions: _archive, ...facts } = state;
  return structuredClone(facts);
}

it("restores a serial checkpoint through the real database worker and reopens without replaying work", async () => {
  const f = await fixture(), original = business(f.state), accepted = await f.apply("Accepted worker-backed configuration");
  await expect(restoreSerialWorkflowConfiguration(f.resource.database, f.storage, f.state, async () => undefined))
    .resolves.toEqual({ changed: true });
  expect(f.state.workflowRevision).toBe(accepted.version.revision);
  expect(f.state.agents.writing.instructions).toBe(accepted.snapshot.agents.writing.instructions);
  expect(business(f.state)).toEqual(original);
  const saved = (await f.resource.database.projectStateDocument(f.state.id, "project.checkpoint"))!;
  expect(business(saved.value as ProjectState)).toEqual(original);
  expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toMatchObject({ formalState: { version: saved.version }, view: saved.value });
  const events = await f.resource.database.eventsAfter(f.state.id, 0, 1000);
  const database = await f.reopen(), loaded = await f.storage.loadState(f.state.id);
  await expect(restoreSerialWorkflowConfiguration(database, f.storage, loaded, async () => undefined)).resolves.toEqual({ changed: false });
  expect(business(loaded)).toEqual(original);
  expect(await database.eventsAfter(f.state.id, 0, 1000)).toEqual(events);
});

it.each([false, true])("rejects a workflow change queued after preflight, including A-to-B-to-A (cycle=%s)", async cycle => {
  const f = await fixture(), original = business(f.state), accepted = await f.apply("Configuration A");
  const prior = await f.resource.database.projectStateDocument(f.state.id, "project.checkpoint"), bytes = await fs.readFile(f.file);
  const write = f.documents.write.bind(f.documents);
  vi.spyOn(f.documents, "write").mockImplementationOnce(async (...args) => {
    await f.apply("Configuration B");
    if (cycle) await f.apply("Configuration A");
    return write(...args);
  });
  await expect(restoreSerialWorkflowConfiguration(f.resource.database, f.storage, f.state, async () => undefined))
    .rejects.toThrow("authority changed during serial persistence");
  const current = (await f.resource.database.serialWorkflowAdjustmentCurrent(f.state.id))!;
  expect(current.version.revision).toBe(accepted.version.revision + (cycle ? 2 : 1));
  if (cycle) expect(current.version.hash).toBe(accepted.version.hash);
  expect(await f.resource.database.projectStateDocument(f.state.id, "project.checkpoint")).toEqual(prior);
  expect(await fs.readFile(f.file)).toEqual(bytes);
  expect(business(f.state)).toEqual(original);
  expect((await fs.readdir(path.dirname(f.file))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  const database = await f.reopen(), loaded = await f.storage.loadState(f.state.id);
  await expect(restoreSerialWorkflowConfiguration(database, f.storage, loaded, async () => undefined)).resolves.toEqual({ changed: true });
  expect(loaded.workflowRevision).toBe(current.version.revision);
  expect(loaded.agents.writing.instructions).toBe(current.snapshot.agents.writing.instructions);
  expect(business(loaded)).toEqual(original);
});

it.each(["view failure", "late session", "writer fence"] as const)("rolls back a worker-backed checkpoint on %s and retains its accepted journal", async failure => {
  const f = await fixture(), original = business(f.state), accepted = await f.apply("Configuration requiring durable projection");
  const prior = await f.resource.database.projectStateDocument(f.state.id, "project.checkpoint"), bytes = await fs.readFile(f.file);
  const write = f.documents.write.bind(f.documents);
  vi.spyOn(f.documents, "write").mockImplementationOnce(async (id, name, value, version, publish, workflowVersion) => {
    if (failure === "writer fence") await f.resource.database.relinquishWriterLease();
    return write(id, name, value, version, document => {
      if (failure === "view failure") throw new Error("View publication failed");
      if (failure === "late session") {
        f.state.agentSessions!.idea.nativeId = "late-original-session";
        f.state.agentSessionIds!.idea = "late-original-session";
      }
      publish!(document);
    }, workflowVersion);
  });
  await expect(restoreSerialWorkflowConfiguration(f.resource.database, f.storage, f.state, async () => undefined))
    .rejects.toThrow(failure === "view failure" ? /View publication failed/ : failure === "late session" ? /Original Session changed/ : /writer epoch\/expiry fence/);
  expect(await f.resource.database.projectStateDocument(f.state.id, "project.checkpoint")).toEqual(prior);
  expect(await fs.readFile(f.file)).toEqual(bytes);
  expect(await f.resource.database.serialWorkflowAdjustmentCurrent(f.state.id)).toEqual(accepted);
  expect((await fs.readdir(path.dirname(f.file))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  if (failure === "late session") {
    expect(f.state.agentSessions!.idea.nativeId).toBe("late-original-session");
    const retained = business(f.state);
    await expect(restoreSerialWorkflowConfiguration(f.resource.database, f.storage, f.state, async () => undefined)).resolves.toEqual({ changed: true });
    expect(business((await f.resource.database.projectStateDocument(f.state.id, "project.checkpoint"))!.value as ProjectState)).toEqual(retained);
  } else {
    expect(business(f.state)).toEqual(original);
    const database = await f.reopen(), loaded = await f.storage.loadState(f.state.id);
    await expect(restoreSerialWorkflowConfiguration(database, f.storage, loaded, async () => undefined)).resolves.toEqual({ changed: true });
    expect(loaded.workflowRevision).toBe(accepted.version.revision);
    expect(business(loaded)).toEqual(original);
  }
});

it("forwards the exact workflow fence through the production coordinator document store", async () => {
  const f = await fixture(), accepted = await f.apply("Coordinator recovery");
  await f.resource.database.relinquishWriterLease(); await f.resource.database.close();
  const coordinator = new CollaborationRuntimeCoordinator({ storage: f.storage,
    databasePath: path.join(f.resource.root, "state.sqlite"), serviceId: "serial-publication-test", hostId: "test",
    validateWorkflowConfiguration: async () => undefined });
  try {
    await coordinator.initialize();
    await expect(coordinator.recoverSerialWorkflowConfiguration(f.state)).resolves.toEqual({ changed: true });
    const document = (await coordinator.projectStateDocuments().read(f.state.id, "project.checkpoint"))!;
    let published = false;
    await expect(coordinator.projectStateDocuments().write(f.state.id, "project.checkpoint", document.value, document.version,
      () => { published = true; }, { ...accepted.version, revision: accepted.version.revision - 1 })).rejects.toThrow("authority changed during serial persistence");
    expect(published).toBe(false);
    expect(await coordinator.projectStateDocuments().read(f.state.id, "project.checkpoint")).toEqual(document);
  } finally { await coordinator.shutdown(); }
});

it("propagates an asynchronous request-snapshot guard failure without publishing a file", async () => {
  const f = await fixture(), request = path.join(f.storage.projectDir(f.state.id), "request.md"), bytes = await fs.readFile(request);
  f.state.agents.writing.instructions = "Must not be published";
  await expect(f.storage.refreshRequestSnapshot(f.state, async () => {
    await f.resource.database.assertWriterLeaseHeld();
    throw new Error("Asynchronous authority validation failed");
  })).rejects.toThrow("Asynchronous authority validation failed");
  expect(await fs.readFile(request)).toEqual(bytes);
  expect((await fs.readdir(path.dirname(request))).some(name => name.startsWith(".request.md."))).toBe(false);
});
