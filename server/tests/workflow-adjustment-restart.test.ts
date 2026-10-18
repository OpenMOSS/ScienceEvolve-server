import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [], workers: Array<{ child: ChildProcess; stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.stop()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const immutable = (record: any) => ({ requestId: record.requestId, source: record.source, submittedAt: record.submittedAt, explanation: record.explanation,
  base: record.base, baseSnapshot: record.baseSnapshot, proposal: record.proposal, changes: record.changes });

async function backend(root: string, mode: string, projectId?: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/workflow-adjustment-restart-worker.ts", root, mode, ...(projectId ? [projectId] : [])],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "", sequence = 0, terminal = false;
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
  const messages: any[] = [], requests = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => {
    terminal = true; for (const request of requests.values()) request.reject(new Error(`Owned backend exited (${code}/${signal}): ${stderr}`));
    requests.clear(); resolve({ code, signal });
  }));
  child.on("message", (message: any) => {
    if (!message.id) { messages.push(message); return; }
    const request = requests.get(message.id); if (!request) return;
    requests.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
  });
  const request = (action: string): Promise<any> => new Promise((resolve, reject) => {
    if (terminal || !child.connected) { reject(new Error(`Owned backend is terminal: ${stderr}`)); return; }
    const id = `parent-${++sequence}`;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Owned backend ${child.pid} timed out during ${action}: ${JSON.stringify(messages)} ${stderr}`)); }, 5_000);
    requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.send({ id, action }, error => { if (error) { requests.delete(id); reject(error); } });
  });
  const waitEvent = async (kind: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const fatal = messages.find(message => message.kind === "fatal"); if (fatal) throw new Error(fatal.error);
      const message = messages.find(message => message.kind === kind); if (message) return message;
      if (terminal || Date.now() >= deadline) throw new Error(`Owned backend ${child.pid} did not reach ${kind}: ${JSON.stringify(messages)} ${stderr}`);
      await delay(20);
    }
  };
  const waitState = async (predicate: (snapshot: any) => boolean, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await request("snapshot"); if (predicate(snapshot)) return snapshot;
      if (snapshot.state.lastError || Date.now() >= deadline)
        throw new Error(`Original backend state did not settle: ${snapshot.state.status}/${snapshot.state.phase}: ${snapshot.state.lastError ?? "timeout"}`);
      await delay(20);
    }
  };
  const stop = async () => {
    let failure: unknown;
    if (!terminal && child.connected) {
      try { await request("shutdown"); } catch (error) { if (!terminal) failure = error; }
    }
    if (!terminal && child.connected) child.disconnect();
    if (failure) throw failure;
    await Promise.race([exited, delay(5_000).then(() => { if (!terminal) throw new Error(`Owned backend ${child.pid} did not exit after shutdown: ${JSON.stringify(messages)} ${stderr}`); })]);
  };
  const worker = { child, request, waitEvent, waitState, stop, exited }; workers.push(worker);
  await waitEvent("ready"); return worker;
}

describe("Workflow adjustment recovery through independent backend processes", () => {
  it.each(["apply", "withdraw", "paused", "twice"])("resumes the original deferred input and durable request after backend restart (%s)", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-adjustment-backend-restart-")); roots.push(root);
    const first = await backend(root, "seed");
    const before = await first.waitState(snapshot => snapshot.state.phase === "collaboration:workflow-adjustment-waiting");
    const id = before.state.id, originalRecord = digest(immutable(before.records[0]));
    expect(before.state.status).toBe("queued"); expect(before.state.lastError).toBeUndefined(); expect(before.openCount).toBe(0);
    expect(before.records).toMatchObject([{ requestId: "original-user-edit", status: "pending" }]);
    expect(before.projection.nodeRuns).toEqual([]); expect(before.projection.executions).toEqual([]);
    expect(before.state.orchestration.allowMainReconfiguration).toBe(false);
    if (mode === "paused") await first.request("pause");
    await first.stop(); expect(await first.exited).toEqual({ code: 0, signal: null });

    let second = await backend(root, mode === "withdraw" || mode === "twice" ? "hold" : "apply", id);
    expect(second.child.pid).not.toBe(first.child.pid);
    if (mode === "twice") {
      const held = await second.waitState(snapshot => snapshot.state.phase === "collaboration:workflow-adjustment-waiting");
      expect(held.openCount).toBe(0); expect(held.records[0].status).toBe("pending"); expect(digest(immutable(held.records[0]))).toBe(originalRecord);
      await second.stop(); expect(await second.exited).toEqual({ code: 0, signal: null });
      second = await backend(root, "apply", id);
    }
    if (mode === "withdraw") {
      const held = await second.waitState(snapshot => snapshot.state.phase === "collaboration:workflow-adjustment-waiting");
      expect(held.openCount).toBe(0); expect(held.state.status).toBe("queued"); expect(held.state.lastError).toBeUndefined();
      expect(digest(immutable(held.records[0]))).toBe(originalRecord);
      await second.request("withdraw");
    }
    if (mode === "paused") {
      await delay(150);
      const paused = await second.request("snapshot");
      expect(paused.state.status).toBe("paused"); expect(paused.state.pauseRequest.settledAt).toBeTruthy();
      expect(paused.records[0].status).toBe("pending"); expect(paused.openCount).toBe(0); expect(paused.projection.nodeRuns).toEqual([]);
      await second.request("resume");
    }
    const input = await second.waitEvent("native-input");
    expect(input.instructions).toBe(mode === "withdraw" ? "Original Main instructions" : "Exact user instructions for the original next Main task");
    const admitted = await second.request("snapshot");
    expect(admitted.lease.epoch).toBeGreaterThan(before.lease.epoch); expect(admitted.lease.instance_id).not.toBe(before.lease.instance_id);
    expect(admitted.state.requirement).toBe(before.state.requirement); expect(admitted.state.cycle).toBe(before.state.cycle);
    expect(digest(immutable(admitted.records[0]))).toBe(originalRecord);
    expect(admitted.records[0].status).toBe(mode === "withdraw" ? "withdrawn" : "applied");
    expect(admitted.projection.workflowRevision).toBe(mode === "withdraw" ? 1 : 2);
    expect(admitted.projection.nodeRuns).toHaveLength(1);
    expect(admitted.projection.nodeRuns[0].inputSnapshotRef).toBe(`project:${id}:requirement:cycle:1`);
    expect(admitted.state.orchestration.allowMainReconfiguration).toBe(false); expect(admitted.openCount).toBe(1);
    await second.request("finish");
    const completed = await second.waitState(snapshot => snapshot.state.status === "completed");
    expect(completed.state.lastError).toBeUndefined(); expect(completed.openCount).toBe(1);
    expect(completed.projection.nodeRuns).toHaveLength(1);
    expect(completed.events.filter((event: any) => event.type === "workflow.adjustment.notification.received")).toEqual([]);
    await second.stop(); expect(await second.exited).toEqual({ code: 0, signal: null });
  }, 45_000);
});
