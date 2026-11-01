import { afterEach, expect, it, vi } from "vitest";
import { cacheResource, clearResourceCache, invalidateResource, loadResource, readCachedResource } from "./resource-cache";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("restores a display snapshot after reload while omitting credential fields", () => {
  cacheResource("project:a", { title: "Saved research", agents: { worker: { instructions: "Real instructions", gatewaySnapshot: { apiKey: "DO_NOT_PERSIST", name: "Gateway" } } } });
  clearResourceCache(false);
  expect(readCachedResource("project:a")).toEqual({ title: "Saved research", agents: { worker: { instructions: "Real instructions", gatewaySnapshot: { name: "Gateway" } } } });
  expect(JSON.stringify(Object.values(sessionStorage))).not.toContain("DO_NOT_PERSIST");
});

it("coalesces concurrent readers and replaces the snapshot with fresh server data", async () => {
  cacheResource("drafts", ["old"]);
  let resolve!: (value: string[]) => void;
  const fetch = vi.fn(() => new Promise<string[]>(done => { resolve = done; }));
  const first = loadResource("drafts", fetch), second = loadResource("drafts", fetch);
  expect(first).toBe(second);
  expect(readCachedResource("drafts")).toEqual(["old"]);
  await Promise.resolve(); resolve(["new"]); await first;
  expect(fetch).toHaveBeenCalledOnce();
  expect(readCachedResource("drafts")).toEqual(["new"]);
});

it("keeps pre-mutation requests from overwriting a later generation", async () => {
  let finishOld!: (value: string[]) => void;
  const old = loadResource("drafts", () => new Promise<string[]>(done => { finishOld = done; }));
  await Promise.resolve();
  invalidateResource("drafts");
  await loadResource("drafts", async () => ["created draft"]);
  finishOld([]); await old;
  expect(readCachedResource("drafts")).toEqual(["created draft"]);
});

it("retains a memory snapshot when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  cacheResource("drafts", ["kept"]);
  expect(readCachedResource("drafts")).toEqual(["kept"]);
});

it("expires persisted snapshots and isolates mounted API paths", () => {
  vi.useFakeTimers();
  cacheResource("drafts", ["old"]);
  vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
  expect(readCachedResource("drafts")).toBeUndefined();
  cacheResource("drafts", ["mounted"]);
  const original = location.href;
  history.replaceState(null, "", "/another-service/");
  expect(readCachedResource("drafts")).toBeUndefined();
  history.replaceState(null, "", original);
  expect(readCachedResource("drafts")).toEqual(["mounted"]);
});
