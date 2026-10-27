import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SavedResearchTaskStore } from "./saved-research-tasks.js";
import type { SavedResearchTask } from "./types.js";
import { createProjectSchema } from "./validation.js";
import { redactTrace } from "./utils.js";

export const savedTaskLaunchSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/),
  tasks: z.array(z.object({
    taskId: z.string().regex(/^task_[a-f0-9]{32}$/),
    expectedUpdatedAt: z.string().datetime()
  }).strict()).min(1).max(100).refine(tasks => new Set(tasks.map(task => task.taskId)).size === tasks.length,
    "同一批次不能重复启动同一份草稿")
}).strict();
export type SavedTaskLaunchInput = z.infer<typeof savedTaskLaunchSchema>;
export interface SavedTaskLaunchItem {
  taskId: string;
  title?: string;
  status: "started" | "failed" | "unconfirmed";
  projectId?: string;
  href?: string;
  error?: string;
}
export interface SavedTaskLaunchResult { operationId: string; results: SavedTaskLaunchItem[] }
type PendingItem = Omit<SavedTaskLaunchItem, "status"> & { status: SavedTaskLaunchItem["status"] | "pending" | "starting" };
interface LaunchReceipt { signature: string; results: PendingItem[] }

export function savedTaskProjectInput(task: SavedResearchTask) {
  return createProjectSchema.parse({ sourceSavedTaskId: task.id, title: task.title, requirement: task.requirement,
    agents: task.agents, orchestration: task.orchestration, git: task.git,
    skillDefinitions: task.skillDefinitions ?? {}, mcpDefinitions: task.mcpDefinitions ?? {} });
}

/** Submits saved snapshots to the existing project queue. Individual failures
 * are durable results; an exact retry never resubmits successful items. */
export class SavedTaskLauncher {
  private readonly inFlight = new Map<string, { signature: string; result: Promise<SavedTaskLaunchResult> }>();
  constructor(private readonly root: string, private readonly tasks: SavedResearchTaskStore,
    private readonly launch: (task: SavedResearchTask) => Promise<{ id: string }>) {}

  async start(input: SavedTaskLaunchInput, signal?: AbortSignal): Promise<SavedTaskLaunchResult> {
    const parsed = savedTaskLaunchSchema.parse(input);
    const signature = createHash("sha256").update(JSON.stringify(parsed.tasks)).digest("hex");
    const existing = this.inFlight.get(parsed.operationId);
    if (existing) {
      this.assertSignature(existing.signature, signature);
      return existing.result;
    }
    const result = this.run(parsed, signature, signal);
    this.inFlight.set(parsed.operationId, { signature, result });
    try { return await result; }
    finally { this.inFlight.delete(parsed.operationId); }
  }

  private async run(input: SavedTaskLaunchInput, signature: string, signal?: AbortSignal): Promise<SavedTaskLaunchResult> {
    const file = path.join(this.root, ".saved-task-launches", `${input.operationId}.json`);
    let receipt: LaunchReceipt;
    try {
      receipt = JSON.parse(await fs.readFile(file, "utf8")) as LaunchReceipt;
      this.assertSignature(receipt.signature, signature);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      receipt = { signature, results: input.tasks.map(task => ({ taskId: task.taskId, status: "pending" })) };
      await this.write(file, receipt);
    }
    for (const [index, item] of receipt.results.entries()) {
      if (item.status === "starting") {
        // The process may have stopped after project creation and before its
        // receipt. Preserve uncertainty instead of creating a duplicate project.
        item.status = "unconfirmed";
        item.error = "服务中断前已提交启动，结果尚未确认；请在项目列表核对，避免重复创建。";
        await this.write(file, receipt);
      }
      if (item.status !== "pending") continue;
      try {
        if (signal?.aborted) throw new Error("批量启动已停止，这份草稿尚未提交。");
        const task = await this.tasks.get(item.taskId);
        if (!task) throw new Error("项目草稿不存在或已被删除。");
        item.title = task.title;
        if (task.updatedAt !== input.tasks[index]!.expectedUpdatedAt)
          throw new Error("草稿已有新的修改，请读取最新内容后重新决定是否启动。");
        savedTaskProjectInput(task);
        item.status = "starting";
        await this.write(file, receipt);
        const project = await this.launch(task);
        if (!/^prj_[a-f0-9]{32}$/.test(project.id)) throw new Error("启动请求未返回有效项目 ID。");
        Object.assign(item, { status: "started", projectId: project.id, href: `/projects/${project.id}` });
      } catch (error) {
        item.status = item.status === "starting" && !(error instanceof z.ZodError) ? "unconfirmed" : "failed";
        item.error = redactTrace(error instanceof Error ? error.message : String(error));
      }
      await this.write(file, receipt);
    }
    return { operationId: input.operationId, results: structuredClone(receipt.results) as SavedTaskLaunchItem[] };
  }

  private assertSignature(actual: string, expected: string) {
    if (actual !== expected) throw Object.assign(new Error("同一启动操作编号不能用于不同草稿或版本。"), { status: 409 });
  }
  private async write(file: string, value: LaunchReceipt) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
