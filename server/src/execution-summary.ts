import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectStorage } from "./storage.js";
import type { EventHub } from "./event-hub.js";
import { redactTrace } from "./utils.js";

// An Explainer turn can require multiple gateway round trips. Keep the
// background deadline above the per-request stream timeouts without allowing a
// stalled summarizer to occupy the single summary queue indefinitely.
const EXECUTION_SUMMARY_TIMEOUT_MS = 360_000;

export interface ExecutionSummary {
  invocationId: string;
  status: "queued" | "running" | "completed" | "failed";
  text?: string;
  error?: string;
  updatedAt: string;
  sourceHash: string;
}

/** A separate queue/cache, never part of research scheduling or conversation history. */
export class ExecutionSummaryService {
  private readonly preparing = new Map<string, Promise<ExecutionSummary>>();
  private readonly active = new Map<string, ExecutionSummary>();
  private tail: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly storage: ProjectStorage,
    hub: EventHub,
    private readonly summarize: (projectId: string, output: string, signal: AbortSignal) => Promise<string>
  ) {
    this.unsubscribe = hub.subscribeAll((event) => {
      if (event.type !== "handoff.saved" || typeof event.data?.invocationId !== "string") return;
      // Detached: a summary failure must never reject publication of a research event.
      void this.ensure(event.projectId, event.data.invocationId).catch(() => undefined);
    });
  }

  ensure(projectId: string, invocationId: string, retry = false): Promise<ExecutionSummary> {
    const key = `${projectId}/${invocationId}`;
    const pending = this.preparing.get(key);
    if (pending) return pending;
    const preparation = this.prepare(projectId, invocationId, key, retry)
      .finally(() => { this.preparing.delete(key); });
    this.preparing.set(key, preparation);
    return preparation;
  }

  private async prepare(projectId: string, invocationId: string, key: string, retry: boolean): Promise<ExecutionSummary> {
    if (this.controller.signal.aborted) throw new Error("摘要服务已停止");
    if (!await this.storage.tryLoadState(projectId)) throw new Error("Project not found");
    const current = this.active.get(key);
    if (current) return { ...current };
    const output = await this.storage.readHandoff(projectId, invocationId);
    const sourceHash = createHash("sha256").update(output).digest("hex");
    const directory = path.join(this.storage.projectDir(projectId), "runtime", "execution-summaries");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const projectRoot = await fs.realpath(this.storage.projectDir(projectId));
    const cacheRoot = await fs.realpath(directory);
    const relative = path.relative(projectRoot, cacheRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid summary cache path");
    const file = path.join(cacheRoot, `${invocationId}.json`);
    try {
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw new Error("Invalid summary cache file");
      const saved = JSON.parse(await fs.readFile(file, "utf8")) as ExecutionSummary;
      if (saved?.invocationId === invocationId && saved.sourceHash === sourceHash &&
          ((saved.status === "completed" && typeof saved.text === "string") || (saved.status === "failed" && !retry))) return saved;
      // Old queued/running records are recoverable after restart, not stuck forever.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const record: ExecutionSummary = { invocationId, sourceHash, status: "queued", updatedAt: new Date().toISOString() };
    const save = async () => {
      // Do not recreate a project deleted while the background task was running.
      if (!await this.storage.tryLoadState(projectId)) return;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    };
    await save();
    this.active.set(key, record);
    // One summarizer at a time limits additional gateway load; research agents remain independent.
    this.tail = this.tail.then(async () => {
      let timeoutSignal: AbortSignal | undefined;
      try {
        if (this.controller.signal.aborted) throw new Error("摘要生成已中断，可重试");
        record.status = "running";
        record.updatedAt = new Date().toISOString();
        await save();
        timeoutSignal = AbortSignal.timeout(EXECUTION_SUMMARY_TIMEOUT_MS);
        const signal = AbortSignal.any([this.controller.signal, timeoutSignal]);
        record.text = await this.summarize(projectId, output, signal);
        if (signal.aborted) throw new Error("摘要生成超时或已中断，可重试");
        record.status = "completed";
      } catch (error) {
        record.status = "failed";
        const message = timeoutSignal?.aborted && !this.controller.signal.aborted
          ? "摘要生成超过 6 分钟，已停止本次任务；可重试或更换响应更快的项目解说模型"
          : error instanceof Error ? error.message : String(error);
        record.error = redactTrace(message).slice(0, 500);
        delete record.text;
      } finally {
        record.updatedAt = new Date().toISOString();
        try { await save(); } finally { this.active.delete(key); }
      }
    }).catch(() => undefined);
    return { ...record };
  }

  async shutdown(): Promise<void> {
    this.unsubscribe();
    this.controller.abort();
    await Promise.allSettled(this.preparing.values());
    await this.tail;
  }
}
