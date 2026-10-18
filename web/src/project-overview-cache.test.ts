import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheProjectOverview, readCachedProjectOverview, type ProjectOverview } from "./project-overview-cache";

const overview: ProjectOverview = { total: 3, archived: 2, totalCycles: 9,
  statusCounts: { active: 1, attention: 1, stopping: 0, terminal: 1 } };

describe("project overview cache", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

  it("isolates statistics from different mounted project services", () => {
    window.history.replaceState(null, "", "/service-a/");
    cacheProjectOverview(overview);
    window.history.replaceState(null, "", "/service-b/");
    expect(readCachedProjectOverview()).toBeUndefined();
    window.history.replaceState(null, "", "/service-a/#/projects");
    expect(readCachedProjectOverview()).toEqual(overview);
  });

  it("discards corrupt or inconsistent cache data", () => {
    cacheProjectOverview(overview);
    const key = localStorage.key(0)!;
    localStorage.setItem(key, "invalid JSON");
    expect(readCachedProjectOverview()).toBeUndefined();
    localStorage.setItem(key, JSON.stringify({ version: 1, overview: { ...overview, total: 99 } }));
    expect(readCachedProjectOverview()).toBeUndefined();
    localStorage.setItem(key, JSON.stringify({ version: 1, overview: { ...overview, totalCycles: -1 } }));
    expect(readCachedProjectOverview()).toBeUndefined();
  });

  it("keeps the page usable when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    expect(readCachedProjectOverview()).toBeUndefined();
    expect(() => cacheProjectOverview(overview)).not.toThrow();
  });
});
