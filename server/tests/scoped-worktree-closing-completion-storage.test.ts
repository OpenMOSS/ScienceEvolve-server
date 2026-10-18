import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStorage } from "../src/storage.js";
import { EventHub } from "../src/event-hub.js";
import type { ScopedWorktreeClosingCompletionRecord } from "../src/collaboration-state/contracts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(memory: string | undefined = "My separate closing observations") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-closing-supplement-")); roots.push(root);
  const storage = new ProjectStorage(root, new EventHub()); await storage.initialize();
  const projectId = `prj_${"a".repeat(32)}`, projectPath = storage.projectDir(projectId);
  const record: ScopedWorktreeClosingCompletionRecord = { projectId, agentId: "worker", executionId: "original", ownershipEpoch: 2,
    invocationId: "inv_closing", grantInvocationId: "original-leader", grantCallId: "explicit-close", reportHeadSha: "b".repeat(40),
    originalSession: { schemaVersion: 1, harnessId: "pi", adapterVersion: "1", nativeId: "/original/session.jsonl", generation: 0,
      durable: true, createdAt: "2026-10-10T09:00:00.000Z" }, writerLeaseEpoch: 1, callId: "my-closing-finish", capabilityHash: "c".repeat(64),
    requestedAt: "2026-10-10T09:00:00.000Z", acceptedAt: "2026-10-10T09:00:01.000Z", summary: "My actual closing result",
    ...(memory === undefined ? {} : { memory, memorySha256: createHash("sha256").update(memory).digest("hex") }) };
  const retained = [path.join(projectPath, "state.json"), path.join(projectPath, "git-worktrees", "agents", "worker", "agent-memory", "worker", "Memory.md"),
    path.join(projectPath, "runtime", "original", "task-completion.json"), path.join(projectPath, "workspaces", "agent-memory", "worker", "Memory.md")];
  for (const file of retained) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "Retained original business fact\n"); }
  const assertRetained = async () => { for (const file of retained) expect(await fs.readFile(file, "utf8")).toBe("Retained original business fact\n"); };
  return { root, storage, record, projectPath, assertRetained };
}

describe("private original-Agent closing supplement files", () => {
  it("writes only the accepted private snapshot and restores missing files without replacing original facts", async () => {
    const f = await fixture(), saved = await f.storage.saveScopedWorktreeClosingCompletion(f.record);
    expect(saved.receiptPath).toBe(path.join(f.projectPath, "runtime", "inv_closing", "worktree-closing", "finish.json"));
    expect(JSON.parse(await fs.readFile(saved.receiptPath, "utf8"))).toEqual(f.record);
    expect(await fs.readFile(saved.memoryPath!, "utf8")).toBe(f.record.memory);
    const stat = await fs.stat(saved.receiptPath);
    expect(await f.storage.saveScopedWorktreeClosingCompletion(structuredClone(f.record))).toEqual(saved);
    expect((await fs.stat(saved.receiptPath)).mtimeMs).toBe(stat.mtimeMs);
    await fs.unlink(saved.receiptPath); await fs.unlink(saved.memoryPath!);
    const restarted = new ProjectStorage(f.root, new EventHub()); await restarted.initialize();
    expect(await restarted.saveScopedWorktreeClosingCompletion(f.record)).toEqual(saved);
    expect(JSON.parse(await fs.readFile(saved.receiptPath, "utf8"))).toEqual(f.record);
    await f.assertRetained();
  });

  it("does not create an invented supplemental Memory when the Agent omitted memory", async () => {
    const f = await fixture(); delete f.record.memory; delete f.record.memorySha256;
    const saved = await f.storage.saveScopedWorktreeClosingCompletion(f.record);
    expect(saved.memoryPath).toBeUndefined();
    await expect(fs.readFile(path.join(path.dirname(saved.receiptPath), "Memory.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.assertRetained();
  });

  it.each(["receipt", "memory"])("keeps conflicting existing %s as evidence instead of overwriting it", async target => {
    const f = await fixture(), saved = await f.storage.saveScopedWorktreeClosingCompletion(f.record);
    const file = target === "receipt" ? saved.receiptPath : saved.memoryPath!;
    const bytes = target === "receipt" ? JSON.stringify({ ...f.record, summary: "Different accepted record" }) : "Different memory";
    await fs.writeFile(file, bytes);
    await expect(f.storage.saveScopedWorktreeClosingCompletion(f.record)).rejects.toThrow("conflicts");
    expect(await fs.readFile(file, "utf8")).toBe(bytes); await f.assertRetained();
  });

  it.each(["directory", "receipt-symlink", "memory-symlink", "receipt-hardlink", "memory-hardlink"])("rejects a %s alias before materializing accepted data", async mode => {
    const f = await fixture(), saved = await f.storage.saveScopedWorktreeClosingCompletion(f.record);
    const outside = path.join(f.root, "outside"); await fs.mkdir(outside); const sentinel = path.join(outside, "sentinel"); await fs.writeFile(sentinel, "Keep outside");
    if (mode === "directory") { const dir = path.dirname(saved.receiptPath); await fs.rm(dir, { recursive: true }); await fs.symlink(outside, dir); }
    else {
      const file = mode.startsWith("receipt") ? saved.receiptPath : saved.memoryPath!; await fs.unlink(file);
      if (mode.endsWith("symlink")) await fs.symlink(sentinel, file); else await fs.link(sentinel, file);
    }
    await expect(f.storage.saveScopedWorktreeClosingCompletion(f.record)).rejects.toThrow(/trusted project directory|private regular file/);
    expect(await fs.readFile(sentinel, "utf8")).toBe("Keep outside"); await f.assertRetained();
  });

  it.each(["memory-hash", "empty-memory", "missing-memory", "not-durable", "invalid-session", "invalid-agent", "invalid-report", "invalid-time", "invalid-capability"])("rejects an invalid %s accepted record", async mode => {
    const f = await fixture(), record = structuredClone(f.record);
    if (mode === "memory-hash") record.memorySha256 = "d".repeat(64);
    if (mode === "empty-memory") record.memory = " ";
    if (mode === "missing-memory") delete record.memory;
    if (mode === "not-durable") record.originalSession.durable = false;
    if (mode === "invalid-session") record.originalSession.generation = -1;
    if (mode === "invalid-agent") record.agentId = "../worker";
    if (mode === "invalid-report") record.reportHeadSha = "wrong";
    if (mode === "invalid-time") record.acceptedAt = "wrong";
    if (mode === "invalid-capability") record.capabilityHash = "wrong";
    await expect(f.storage.saveScopedWorktreeClosingCompletion(record)).rejects.toThrow("exact accepted"); await f.assertRetained();
    await expect(fs.readdir(path.join(f.projectPath, "runtime", record.invocationId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
