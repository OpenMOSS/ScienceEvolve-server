import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { CollaborationStateDatabase } from "../src/collaboration-state/index.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { createApp } from "../src/app.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { ProjectState, TimelineEvent } from "../src/types.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { defaultAgentConfigs } from "../src/validation.js";
import { compactWorkflowReplayEvent, isWorkflowReplayEvent } from "../src/workflow-replay.js";

const roots: string[] = [];
const databases: CollaborationStateDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-workflow-replay-")); roots.push(root);
  const hub = new EventHub(), storage = new ProjectStorage(root, hub);
  const state = { id: "prj_" + "a".repeat(32), title: "Replay fixture", requirement: "Replay actual events", status: "running",
    phase: "agent:idea:running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventSeq: 0,
    turn: 0, cycle: 1, runCounts: {}, userInputs: [], agents: structuredClone(defaultAgentConfigs), orchestration: cloneAgentOrchestrationTemplate()
  } as unknown as ProjectState;
  await storage.createProject(state);
  return { root, storage, hub, state };
}

describe("read-only Workflow replay history", () => {
  it("pages durable workflow facts at a fixed boundary while excluding trace bodies", async () => {
    const { storage, state } = await fixture();
    await storage.appendEvent(state, { type: "agent.started", agent: "idea", message: "started" });
    await storage.appendEvent(state, { type: "agent.trace", message: "private trace" });
    await storage.appendEvent(state, { type: "workflow.node.updated", message: "new node", data: { sourceType: "node.activated" } });
    const first = await storage.readWorkflowReplayHistory(state.id, { limit: 1 });
    expect(first).toMatchObject({ throughSeq: 3, hasMore: true });
    expect(first.events.map(event => event.seq)).toEqual([3]);
    await storage.appendEvent(state, { type: "agent.completed", agent: "idea", message: "completed after review opened" });
    const earlier = await storage.readWorkflowReplayHistory(state.id, { limit: 10, through: first.throughSeq, before: first.events[0]!.seq });
    expect(earlier.events.map(event => event.seq)).toEqual([1]);
    expect(earlier.hasMore).toBe(false);
    expect((await storage.readWorkflowReplayHistory(state.id, { limit: 10, through: 3 })).events.map(event => event.seq)).toEqual([1, 3]);
    await expect(storage.readWorkflowReplayHistory(state.id, { limit: 10, through: 999 })).rejects.toThrow("boundary");
  });

  it("retains scoped execution identity without exposing native sessions or Gateway secrets", () => {
    const event = { seq: 1, type: "workflow.node.updated", ts: new Date().toISOString(), message: "native opened", data: {
      sourceType: "agent.native_binding.opened", binding: { agentId: "a", invocationId: "i", session: { nativeId: "private-session" },
        executionContext: { groupRunId: "g", executionId: "e", ownershipEpoch: 2 } }, gatewaySnapshot: { apiKey: "server-only" }
    } } as TimelineEvent;
    expect(isWorkflowReplayEvent(event)).toBe(true);
    expect(compactWorkflowReplayEvent(event).data).toMatchObject({ agentId: "a", invocationId: "i", groupRunId: "g", executionId: "e", ownershipEpoch: 2 });
    expect(JSON.stringify(compactWorkflowReplayEvent(event))).not.toContain("private-session");
    expect(JSON.stringify(compactWorkflowReplayEvent(event))).not.toContain("server-only");
    expect(isWorkflowReplayEvent({ ...event, type: "agent.trace", data: {} })).toBe(false);
    const routed = compactWorkflowReplayEvent({ ...event, data: { sourceType: "scoped.agent.merged_route",
      route: { kind: "activate", activation: { requestId: "next-arrival", targetNodeId: "review" } },
      loop: { id: "verification", exhausted: false, batch: 1, iterations: 2, totalIterations: 4 } } });
    expect(routed.data).toMatchObject({ targetNodeId: "review", nextArrivalRequestId: "next-arrival",
      loopId: "verification", batch: 1, iterations: 2, totalIterations: 4, loopExhausted: false });
  });

  it("reads immutable topology versions and configuration without appending events", async () => {
    const { root, state } = await fixture();
    const database = CollaborationStateDatabase.open({ databasePath: path.join(root, "state.sqlite"),
      serviceId: "replay-test", instanceId: "test", hostId: "local", topology: "single-host", leaseDurationMs: 60_000 });
    databases.push(database);
    database.createProject({ projectId: state.id, workflowRevision: 1, workflowSnapshot: state.orchestration,
      git: { enabled: false, status: "disabled" }, workerCapacity: 1, managementCapacity: 1, requestId: "create" });
    database.initializeScopedConfiguration(state.id, { agents: state.agents, skillDefinitions: {}, mcpDefinitions: {} });
    const next = structuredClone(state.orchestration); next.agents[0]!.description = "Updated responsibility";
    database.saveWorkflowRevision({ projectId: state.id, workflowRevision: 2, snapshot: next, affectedGroupIds: [] });
    const before = database.projectState(state.id).stateRevision;
    const history = database.workflowReplayConfigurationHistory(state.id);
    expect(history.revisions.map(entry => entry.revision)).toEqual([1, 2]);
    expect(history.revisions[0]!.orchestration.agents[0]!.description).not.toBe("Updated responsibility");
    expect(history.revisions[1]!.orchestration.agents[0]!.description).toBe("Updated responsibility");
    expect(history.configurations[0]!.agents.main.model).toBe(state.agents.main.model);
    expect(database.projectState(state.id).stateRevision).toBe(before);
    expect(() => database.workflowReplayConfigurationHistory("missing")).toThrow();
  });

  it("validates paging queries, reports missing projects, and only calls read operations", async () => {
    const { storage, hub, state } = await fixture();
    const readConfiguration = vi.fn(() => ({ revisions: [], configurations: [] }));
    const app = createApp({ orchestrator: { getProject: async (id: string) => id === state.id ? state : undefined,
      getWorkflowReplayConfigurationHistory: readConfiguration } as unknown as Orchestrator,
      storage, eventHub: hub, skills: new SkillCatalog([]), config: { modelSuggestions: [], maxEventHistory: 1 } });
    const url = `/api/projects/${state.id}/workflow/replay`;
    await request(app).get(`${url}/events?limit=0`).expect(400);
    await request(app).get(`${url}/events?through=-1`).expect(400);
    await request(app).get(`${url}/events?before=bad`).expect(400);
    await request(app).get(`/api/projects/missing/workflow/replay/events`).expect(404);
    const response = await request(app).get(`${url}/configuration`).expect(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(readConfiguration).toHaveBeenCalledWith(state.id);
    expect((await request(app).get(`${url}/events`).expect(200)).body).toMatchObject({ events: [], hasMore: false, throughSeq: 0 });
  });
});
