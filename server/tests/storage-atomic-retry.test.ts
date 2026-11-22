import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";

const roots: string[] = [];

class AtomicTestStorage extends ProjectStorage {
  writeJson(filePath: string, value: unknown, beforeCommit?: () => void): Promise<void> {
    return this.atomicJson(filePath, value, beforeCommit);
  }
}

async function checkpoint(root: string, status: string) {
  const storage = new AtomicTestStorage(root, new EventHub());
  const state = { status };
  const target = path.join(root, "state.json");
  await storage.writeJson(target, state);
  return { storage, state, target, original: await fs.readFile(target, "utf8") };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("retries a transient replacement failure without losing the existing state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-atomic-retry-"));
  roots.push(root);
  const { storage, state, target, original } = await checkpoint(root, "old");
  const realRename = fs.rename.bind(fs);
  let attempts = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    attempts += 1;
    if (attempts <= 2) {
      expect(await fs.readFile(target, "utf8")).toBe(original);
      throw Object.assign(new Error("file temporarily busy"), { code: "EPERM" });
    }
    return realRename(source, destination);
  });

  state.status = "new";
  await storage.writeJson(target, state);

  expect(attempts).toBe(3);
  expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ status: "new" });
});

it.each([["EDQUOT", -122], ["EIO", -5]] as const)("preserves the last committed file after a partial %s write", async (code, errno) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-partial-write-"));
  roots.push(root);
  const { storage, state, target, original } = await checkpoint(root, "confirmed");
  const write = fs.writeFile.bind(fs);
  const error = Object.assign(new Error(code), { code, errno });
  const attempted = vi.spyOn(fs, "writeFile").mockImplementationOnce(async file => {
    await write(file, '{"status":');
    throw error;
  });
  state.status = "new";
  await expect(storage.writeJson(target, state)).rejects.toBe(error);
  expect(attempted).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(target, "utf8")).toBe(original);
  expect(await fs.readdir(root)).toEqual(["state.json"]);
  state.status = "restored";
  await storage.writeJson(target, state);
  expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ status: "restored" });
});

it("checks authority again before a transient replacement retry and removes the stale temporary file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-atomic-authority-")); roots.push(root);
  const { storage, state, target, original } = await checkpoint(root, "original");
  const rename = fs.rename.bind(fs); let current = true, attempts = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    attempts += 1;
    if (attempts === 1) { current = false; throw Object.assign(new Error("temporarily busy"), { code: "EBUSY" }); }
    await rename(...args);
  });
  state.status = "stale";
  await expect(storage.writeJson(target, state, () => {
    if (!current) throw new Error("Authority changed before replacement");
  })).rejects.toThrow("Authority changed before replacement");
  expect(attempts).toBe(1); expect(await fs.readFile(target, "utf8")).toBe(original);
  expect(await fs.readdir(root)).toEqual(["state.json"]);
});

it("silently skips a workflow reference that becomes stale after its temporary file is ready", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-reference-authority-")); roots.push(root);
  const storage = new ProjectStorage(root, new EventHub()); await storage.initialize();
  const document = { projectId: "prj_" + "a".repeat(32), original: true };
  const target = await storage.writeMainAgentOrchestrationSnapshot(document.projectId, "workflow.json", document);
  const reference = path.join(path.dirname(target), ".scienceevolve", "workflow-current.json");
  const original = await fs.readFile(reference, "utf8"), write = fs.writeFile.bind(fs); let current = true;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await write(...args);
    if (String(args[0]).includes(".workflow-current.json.")) current = false;
  });
  await storage.writeMainAgentOrchestrationCurrentSnapshot(document.projectId, { ...document, original: false }, () => current);
  expect(current).toBe(false); expect(await fs.readFile(reference, "utf8")).toBe(original);
  expect((await fs.readdir(path.dirname(reference))).some(name => name.startsWith(".workflow-current.json."))).toBe(false);
});
