import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { SavedTaskLauncher, type SavedTaskLaunchInput } from "../src/saved-task-launcher.js";
import type { SavedResearchTask } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-batch-launch-")); roots.push(root);
  const tasks = new SavedResearchTaskStore(root);
  const saved = await Promise.all(["A", "B", "C"].map(title => tasks.create({ title,
    requirement: "调研全自动 AI 短剧制作流水线，保留各份独立 Workflow 配置" })));
  let sequence = 0;
  const launch = vi.fn(async (_task: SavedResearchTask) => ({ id: `prj_${String(++sequence).padStart(32, "0")}` }));
  const service = new SavedTaskLauncher(root, tasks, launch);
  const input: SavedTaskLaunchInput = { operationId: "launch-selected-drafts", tasks: saved.slice(0, 2).map(task => ({
    taskId: task.id, expectedUpdatedAt: task.updatedAt
  })) };
  return { root, tasks, saved, launch, service, input };
}

describe("saved draft batch launch receipts", () => {
  it("starts two distinct snapshots once across concurrent retries and a service restart", async () => {
    const f = await setup();
    const [first, retry] = await Promise.all([f.service.start(f.input), f.service.start(f.input)]);
    expect(first).toEqual(retry);
    expect(first.results.map(result => result.status)).toEqual(["started", "started"]);
    expect(new Set(first.results.map(result => result.projectId)).size).toBe(2);
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls.map(call => call[0].id)).toEqual(f.saved.slice(0, 2).map(task => task.id));
    const restarted = new SavedTaskLauncher(f.root, f.tasks, f.launch);
    expect(await restarted.start(f.input)).toEqual(first);
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(await f.tasks.list()).toHaveLength(3);
    await expect(restarted.start({ ...f.input, tasks: [f.input.tasks[1]!] })).rejects.toMatchObject({ status: 409 });
  });

  it("returns individual missing/stale errors while continuing to start the other selected drafts", async () => {
    const f = await setup();
    const stale = f.saved[1]!;
    await f.tasks.update(stale.id, { title: "其他窗口更新", requirement: stale.requirement,
      agents: stale.agents, orchestration: stale.orchestration, git: stale.git });
    const result = await f.service.start({ ...f.input, tasks: [f.input.tasks[0]!,
      { taskId: `task_${"f".repeat(32)}`, expectedUpdatedAt: stale.updatedAt }, f.input.tasks[1]!,
      { taskId: f.saved[2]!.id, expectedUpdatedAt: f.saved[2]!.updatedAt }] });
    expect(result.results.map(item => item.status)).toEqual(["started", "failed", "failed", "started"]);
    expect(result.results[1]!.error).toContain("不存在");
    expect(result.results[2]!.error).toContain("新的修改");
    expect(f.launch).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate tasks or malformed requests before any project is started", async () => {
    const f = await setup();
    await expect(f.service.start({ ...f.input, tasks: [f.input.tasks[0]!, f.input.tasks[0]!] })).rejects.toThrow("重复启动");
    await expect(f.service.start({ ...f.input, operationId: "../escape-operation" })).rejects.toThrow();
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("preserves completed starts and stops submitting further drafts after cancellation", async () => {
    const f = await setup(), controller = new AbortController();
    f.launch.mockImplementationOnce(async () => { controller.abort(); return { id: `prj_${"a".repeat(32)}` }; });
    const result = await f.service.start(f.input, controller.signal);
    expect(result.results.map(item => item.status)).toEqual(["started", "failed"]);
    expect(result.results[1]!.error).toContain("尚未提交");
    expect(f.launch).toHaveBeenCalledOnce();
    expect(await f.service.start(f.input)).toEqual(result);
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it("does not resubmit a launch interrupted between project creation and its receipt", async () => {
    const f = await setup();
    const directory = path.join(f.root, ".saved-task-launches"); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, `${f.input.operationId}.json`), JSON.stringify({
      signature: createHash("sha256").update(JSON.stringify(f.input.tasks)).digest("hex"),
      results: [{ taskId: f.saved[0]!.id, status: "starting" }, { taskId: f.saved[1]!.id, status: "pending" }]
    }));
    const result = await f.service.start(f.input);
    expect(result.results.map(item => item.status)).toEqual(["unconfirmed", "started"]);
    expect(result.results[0]!.error).toContain("避免重复创建");
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it("reports a launch with an unknown outcome honestly and never automatically submits it twice", async () => {
    const f = await setup();
    f.launch.mockRejectedValueOnce(new Error("connection closed after submission"));
    const result = await f.service.start(f.input);
    expect(result.results.map(item => item.status)).toEqual(["unconfirmed", "started"]);
    expect(result.results[0]!.error).toContain("connection closed");
    expect(await f.service.start(f.input)).toEqual(result);
    expect(f.launch).toHaveBeenCalledTimes(2);
  });
});
