import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProject } from "./lib";
import { workflowOuterNodes } from "./components/workflow-canvas/core/workflow-nodes";
import { cacheProjectList, cacheProjectQueue, clearProjectListMemoryCache, readCachedProjectList, readCachedProjectQueue } from "./project-list-cache";
import type { Project, QueueSnapshot } from "./types";

function project(): Project {
  const value = normalizeProject({ id: "project-1", title: "Cached research", requirement: "Research requirement",
    status: "paused", phase: "user-intervention-required", cycle: 3, archivedAt: "2026-10-12T00:00:00Z",
    tokenUsage: { totalTokens: 1234 },
    userIntervention: { id: "question-1", status: "pending", requestedAt: "2026-10-12T00:00:00Z", message: "Choose a direction" },
    git: { enabled: true, status: "ready" } });
  value.agents.main.instructions = "SECRET_AGENT_PROMPT";
  value.skillDefinitions = { secret: { files: { "SKILL.md": "SECRET_SKILL_DEFINITION" } } };
  value.orchestration.decisionPlans = { main: "SECRET_DECISION_PLAN" };
  return value;
}

describe("project list cache", () => {
  beforeEach(() => { clearProjectListMemoryCache(); localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); window.history.replaceState(null, "", "/"); });

  it("reuses complete memory snapshots and queue data without storing configurations", () => {
    const projects = [project()];
    const queue: QueueSnapshot = { main: { capacity: 2, activeProjectIds: ["project-1"], queued: [] } };
    cacheProjectList(projects, 123);
    cacheProjectQueue(queue);
    expect(readCachedProjectList()?.projects).toBe(projects);
    expect(readCachedProjectList()?.tokenRefreshedAt).toBe(123);
    expect(readCachedProjectQueue()).toBe(queue);
    const serialized = localStorage.getItem(localStorage.key(0)!)!;
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("skillDefinitions");
    expect(serialized).not.toContain("mcpDefinitions");
  });

  it("restores safe display fields after a reload without a TTL", () => {
    const original = project();
    cacheProjectList([original], 1);
    clearProjectListMemoryCache();
    const snapshot = readCachedProjectList()!;
    expect(snapshot.tokenRefreshedAt).toBe(1);
    expect(snapshot.projects[0]).toMatchObject({ id: original.id, title: original.title,
      requirement: original.requirement, status: original.status, phase: original.phase, cycle: 3,
      archivedAt: original.archivedAt, tokenUsage: { totalTokens: 1234 }, git: { enabled: true },
      userIntervention: { status: "pending", message: "Choose a direction" } });
    expect(workflowOuterNodes(snapshot.projects[0].orchestration)).toEqual(workflowOuterNodes(original.orchestration));
    expect(snapshot.projects[0].agents).toEqual({});
    expect(readCachedProjectQueue()).toBeUndefined();
  });

  it("preserves scoped collaboration card order and member counts without workflow policy", () => {
    const original = project();
    original.orchestration.schemaVersion = 3;
    original.orchestration.collaborations = [{ id: "team", displayName: "Research team", memberAgentIds: ["worker"], renamePolicy: "locked" }];
    original.orchestration.scopedWorkflow = { schemaVersion: 1, rootAgentIds: ["main"], groups: [{ id: "team",
      leaderAgentId: "worker", allowLeaderReconfiguration: true,
      workflow: { nodes: [], routes: {}, input: { source: "input", edges: [] } } }] };
    cacheProjectList([original], 10);
    clearProjectListMemoryCache();
    expect(workflowOuterNodes(readCachedProjectList()!.projects[0].orchestration)).toEqual(workflowOuterNodes(original.orchestration));
  });

  it("replaces stale projects with an authoritative empty snapshot", () => {
    cacheProjectList([project()], 1);
    cacheProjectList([], 2);
    expect(readCachedProjectList()).toEqual({ projects: [], tokenRefreshedAt: 2 });
    clearProjectListMemoryCache();
    expect(readCachedProjectList()).toEqual({ projects: [], tokenRefreshedAt: 2 });
  });

  it("isolates snapshots by resolved API service including mounted paths", () => {
    window.history.replaceState(null, "", "/service-a/");
    cacheProjectList([project()], 1);
    cacheProjectQueue({});
    window.history.replaceState(null, "", "/service-b/");
    expect(readCachedProjectList()).toBeUndefined();
    expect(readCachedProjectQueue()).toBeUndefined();
    window.history.replaceState(null, "", "/service-a/#/projects");
    expect(readCachedProjectList()?.projects).toHaveLength(1);
    expect(readCachedProjectQueue()).toEqual({});
    vi.stubEnv("VITE_API_BASE", "https://different.example");
    expect(readCachedProjectList()).toBeUndefined();
    expect(readCachedProjectQueue()).toBeUndefined();
  });

  it.each(["invalid JSON", JSON.stringify({ version: 0, projects: [], tokenRefreshedAt: 1 }),
    JSON.stringify({ version: 1, projects: [{}], tokenRefreshedAt: 1 }),
    JSON.stringify({ version: 1, projects: [], tokenRefreshedAt: -1 })])("ignores corrupt or obsolete snapshots: %s", (corrupt) => {
    cacheProjectList([], 1);
    const key = localStorage.key(0)!;
    clearProjectListMemoryCache();
    localStorage.setItem(key, corrupt);
    expect(readCachedProjectList()).toBeUndefined();
  });

  it("keeps memory caching available when storage is disabled or full", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Disabled"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    expect(readCachedProjectList()).toBeUndefined();
    const projects = [project()];
    expect(() => cacheProjectList(projects, 100)).not.toThrow();
    expect(readCachedProjectList()?.projects).toBe(projects);
  });
});
