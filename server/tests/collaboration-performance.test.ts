import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionCollaborationInvocationDispatcher } from "../src/collaboration-runtime.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import { recordTerminalPerformance } from "../src/invocation-performance.js";
import type { AgentRunRequest, InvocationPerformance, ProjectState } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 9, 0, 0, seconds)).toISOString();

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "openfars-performance-")); roots.push(root);
  const storage = new ProjectStorage(root, new EventHub());
  const state = { id: "prj_12345678901234567890123456789012", eventSeq: 0, cycle: 1, updatedAt: at(0) } as ProjectState;
  await mkdir(storage.projectDir(state.id), { recursive: true });
  await writeFile(path.join(storage.projectDir(state.id), "events.jsonl"), "");
  const dispatcher = new ProductionCollaborationInvocationDispatcher(storage);
  const request = { invocationId: "inv_native", agent: "worker_a", onTokenUsage: vi.fn() } as unknown as AgentRunRequest;
  dispatcher.decorate({ state, request });
  async function send(phase: "started" | "delta" | "completed", seconds: number, text?: string) {
    vi.setSystemTime(new Date(at(seconds)));
    await request.onModelStreamEvent!({ phase, requestId: "request-native", timestamp: at(seconds),
      streaming: true, deliveryMode: "native-stream", text });
  }
  return { storage, state, dispatcher, request, send };
}

function fragment(request: AgentRunRequest, seq: number) {
  return { schemaVersion: 1 as const, eventId: `fragment-${seq}`, seq, timestamp: at(0),
    invocationId: request.invocationId, harnessId: "fixture", attempt: 0,
    kind: "assistant.delta" as const, phase: "delta" as const, itemId: "message", message: `fragment ${seq}` };
}

describe("collaboration audit batching", () => {
  it("combines ordinary traces and native fragments into one checkpoint at a tool boundary", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    state.turn = 0;
    await mkdir(path.join(storage.projectDir(state.id), "traces"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at(0)));
    const writes = vi.spyOn(storage, "appendEvents");
    const sink = dispatcher.trace({ state, agentId: request.agent, invocationId: request.invocationId });
    for (let index = 0; index < 80; index++) await sink("status", `status ${index}`);
    await request.onOfficialHarnessEvent!(fragment(request, 1));
    expect(storage.hub.liveSnapshot(state.id).streams).toContainEqual(expect.objectContaining({ content: "fragment 1", phase: "streaming" }));
    expect(writes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(writes).not.toHaveBeenCalled();
    await request.onOfficialHarnessEvent!({ ...fragment(request, 2), kind: "tool.started", phase: "started",
      tool: { callId: "call", name: "read_file", toolType: "file", status: "started" } });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][1]).toHaveLength(82);
    const events = await storage.readEvents(state.id);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: 82 }, (_, index) => index + 1));
    expect(events.slice(0, 80).map(event => event.message)).toEqual(Array.from({ length: 80 }, (_, index) => `status ${index}`));
    const trace = await readFile(path.join(storage.projectDir(state.id), "traces", "0001_worker_a_inv_native.md"), "utf8");
    expect(trace.match(/### /g)).toHaveLength(80);
    expect(trace).toContain(at(0));
    expect(JSON.parse(await readFile(path.join(storage.projectDir(state.id), "state.json"), "utf8")).eventSeq).toBe(82);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("flushes process records on the batching window and flushes errors immediately", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    await mkdir(path.join(storage.projectDir(state.id), "traces"));
    vi.useFakeTimers();
    const writes = vi.spyOn(storage, "appendEvents");
    const sink = dispatcher.trace({ state, agentId: request.agent, invocationId: request.invocationId });
    await sink("status", "request started");
    await request.onOfficialHarnessEvent!(fragment(request, 1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    // Wait for the real filesystem append without advancing another window.
    await dispatcher.finish(state, request.invocationId, "completed");
    await sink("message", "more output");
    await sink("stderr", "original adapter failure");
    expect(writes).toHaveBeenCalledTimes(2);
    expect((await storage.readEvents(state.id)).map(event => event.message))
      .toEqual(["request started", "fragment 1", "more output", "original adapter failure"]);
  });

  it("coalesces records arriving during a slow write instead of accumulating timed write jobs", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    vi.useFakeTimers();
    const original = storage.appendEvents.bind(storage);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const writes = vi.spyOn(storage, "appendEvents").mockImplementationOnce(async (...args) => {
      await blocked;
      return original(...args);
    });
    await request.onOfficialHarnessEvent!(fragment(request, 0));
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveBeenCalledTimes(1);
    for (let index = 1; index <= 20; index++) {
      await request.onOfficialHarnessEvent!(fragment(request, index));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(writes).toHaveBeenCalledTimes(1);
    const finished = dispatcher.finish(state, request.invocationId, "completed");
    release();
    await finished;
    expect(writes.mock.calls.map(call => call[1].length)).toEqual([1, 20]);
    expect((await storage.readEvents(state.id)).map(event => event.message))
      .toEqual(Array.from({ length: 21 }, (_, index) => `fragment ${index}`));
  });

  it("applies backpressure when a pending batch fills behind a slow write", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    vi.useFakeTimers();
    const original = storage.appendEvents.bind(storage);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const writes = vi.spyOn(storage, "appendEvents").mockImplementationOnce(async (...args) => {
      await blocked;
      return original(...args);
    });
    await request.onOfficialHarnessEvent!(fragment(request, 0));
    await vi.advanceTimersByTimeAsync(1000);
    for (let index = 1; index < 128; index++) await request.onOfficialHarnessEvent!(fragment(request, index));
    let accepted = false;
    const capacity = request.onOfficialHarnessEvent!(fragment(request, 128)).then(() => { accepted = true; });
    await Promise.resolve();
    expect(accepted).toBe(false);
    expect(writes).toHaveBeenCalledTimes(1);
    release();
    await capacity;
    await dispatcher.finish(state, request.invocationId, "completed");
    expect(writes.mock.calls.map(call => call[1].length)).toEqual([1, 128]);
    expect((await storage.readEvents(state.id)).map(event => event.seq)).toEqual(Array.from({ length: 129 }, (_, index) => index + 1));
  });

  it("reports a timer-driven audit failure at settlement instead of acknowledging completion", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    vi.useFakeTimers();
    const failure = new Error("fixture audit write failed");
    vi.spyOn(storage, "appendEvents").mockRejectedValueOnce(failure);
    await request.onOfficialHarnessEvent!(fragment(request, 1));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(dispatcher.finish(state, request.invocationId, "completed")).rejects.toBe(failure);
  });

  it("does not keep writing a newer pending batch after the active audit write fails", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    vi.useFakeTimers();
    const failure = new Error("fixture active audit failure");
    let reject!: (error: Error) => void;
    const blocked = new Promise<never>((_resolve, fail) => { reject = fail; });
    const writes = vi.spyOn(storage, "appendEvents").mockImplementationOnce(() => blocked);
    await request.onOfficialHarnessEvent!(fragment(request, 1));
    await vi.advanceTimersByTimeAsync(1000);
    await request.onOfficialHarnessEvent!(fragment(request, 2));
    reject(failure);
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveBeenCalledTimes(1);
    await expect(dispatcher.finish(state, request.invocationId, "completed")).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("flushes one project's lifecycle boundary and drains all remaining projects for shutdown", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    vi.useFakeTimers();
    const second = { ...state, id: "prj_" + "d".repeat(32) };
    await mkdir(storage.projectDir(second.id), { recursive: true });
    await writeFile(path.join(storage.projectDir(second.id), "events.jsonl"), "");
    const next = { invocationId: "inv_second", agent: "worker_b" } as AgentRunRequest;
    dispatcher.decorate({ state: second, request: next });
    await request.onOfficialHarnessEvent!(fragment(request, 1));
    await next.onOfficialHarnessEvent!(fragment(next, 2));
    await dispatcher.flush(state.id);
    expect((await storage.readEvents(state.id)).map(event => event.message)).toEqual(["fragment 1"]);
    expect(await storage.readEvents(second.id)).toEqual([]);
    expect(storage.hub.liveSnapshot(state.id).streams).toHaveLength(1);
    await dispatcher.flush();
    expect((await storage.readEvents(second.id)).map(event => event.message)).toEqual(["fragment 2"]);
  });
});

describe("collaboration model performance", () => {
  it("persists resident tool details in the canonical envelope before retiring their live copy", async () => {
    const { storage, state, request } = await fixture();
    const tool = { schemaVersion: 1 as const, eventId: "resident-result", seq: 2, timestamp: at(0),
      invocationId: request.invocationId, harnessId: "fixture", attempt: 0,
      kind: "tool.completed" as const, phase: "completed" as const,
      tool: { callId: "call", name: "read_file", toolType: "file" as const, status: "completed" as const,
        input: { path: "report.md" }, outputPreview: "Saved report content" } };
    await request.onOfficialHarnessEvent!(tool);
    await request.onLiveHarnessEvent!(tool);
    const events = await storage.readEvents(state.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "agent.trace", message: "read_file", data: { canonicalEvent: tool } });
    expect(storage.hub.liveSnapshot(state.id).events).toEqual([]);
    expect((await storage.readEventBootstrap(state.id, 1)).events[0]?.data?.canonicalEvent).toEqual(tool);
    await request.onOfficialHarnessEvent!({ ...tool, eventId: "resident-diagnostic", seq: 3, kind: "diagnostic", tool: undefined,
      diagnostic: { source: "adapter", level: "warning", message: "Public adapter detail" } });
    expect((await storage.readEvents(state.id)).at(-1)?.message).toBe("Public adapter detail");
  });

  it("clears finished resident live output even when no model performance tracker was created", async () => {
    const { storage, state, dispatcher, request } = await fixture();
    await request.onLiveHarnessEvent!({
      schemaVersion: 1, eventId: "pending-tool", seq: 1, timestamp: at(0),
      invocationId: request.invocationId, harnessId: "fixture", attempt: 0,
      kind: "tool.started", phase: "started",
      tool: { callId: "call", name: "read", toolType: "file", status: "started" }
    });
    expect(storage.hub.liveSnapshot(state.id).events).toHaveLength(1);
    await dispatcher.finish(state, request.invocationId, "completed");
    expect(storage.hub.liveSnapshot(state.id).events).toEqual([]);
  });

  it("publishes request activity, persists completed metrics and emits a telemetry event without completing business work", async () => {
    const { storage, state, dispatcher, request, send } = await fixture();
    vi.useFakeTimers();
    await send("started", 0);
    await send("delta", 1, "abcdefgh");
    expect(storage.hub.liveSnapshot(state.id).performance).toMatchObject({ requestActive: true, firstTokenLatencyMs: 1000 });
    const usage = { usageId: "usage-native", protocol: "responses" as const, model: "test-model",
      inputTokens: 10, cachedInputTokens: 0, outputTokens: 20, totalTokens: 30 };
    await request.onTokenUsage!(usage);
    await request.onTokenUsage!(usage);
    await send("completed", 3);
    const idle = storage.hub.liveSnapshot(state.id).performance!;
    expect(idle).toMatchObject({ status: "active", requestActive: false, outputTokens: 20, averageTokensPerSecond: 10 });
    expect(idle.currentTokensPerSecond).toBeUndefined();
    await dispatcher.finish(state, request.invocationId, "completed");
    await dispatcher.finish(state, request.invocationId, "completed");
    const saved = JSON.parse(await readFile(path.join(storage.projectDir(state.id), "state.json"), "utf8")) as ProjectState;
    expect(saved.performance?.latest).toMatchObject({ status: "completed", firstTokenLatencyMs: 1000, requestActive: false });
    expect(saved.performance?.aggregate).toMatchObject({ invocations: 1, outputTokens: 20, averageTokensPerSecond: 10 });
    expect(saved.performance?.aggregateByAgent?.worker_a?.averageTokensPerSecond).toBe(10);
    const events = await storage.readEvents(state.id);
    expect(events.filter((event) => event.type === "invocation.performance")).toHaveLength(1);
    expect(events.some((event) => event.type === "invocation.completed")).toBe(false);
    const bootstrap = await storage.readEventBootstrap(state.id, 1);
    expect(bootstrap.timelineEvents.find((event) => event.type === "invocation.performance")?.data?.performance)
      .toEqual(saved.performance?.latest);
    storage.hub.clearInvocation(state.id, request.invocationId);
    expect(storage.hub.liveSnapshot(state.id).performance).toBeUndefined();
    expect(saved.performance?.latest?.firstTokenLatencyMs).toBe(1000);
  });

  it("retains interrupted measurements and resets attempts without counting failed output in the successful average", async () => {
    const { storage, state, dispatcher, request, send } = await fixture();
    vi.useFakeTimers();
    await send("started", 0);
    await send("delta", 1, "abcd");
    await request.onHarnessAttemptReset!(1);
    expect(state.performance?.history?.[0]).toMatchObject({ status: "incomplete", firstTokenLatencyMs: 1000 });
    expect(state.performance?.aggregate).toBeUndefined();
    await send("started", 4);
    await send("delta", 6, "abcdefgh");
    await dispatcher.finish(state, request.invocationId, "incomplete");
    expect(state.performance?.latest).toMatchObject({ attempt: 1, status: "incomplete", firstTokenLatencyMs: 2000 });
    expect(state.performance?.aggregate).toBeUndefined();
    expect(storage.hub.liveSnapshot(state.id).performance?.currentTokensPerSecond).toBeUndefined();
  });

  it("keeps the last measured TTFT durable after more than 100 buffered invocations", () => {
    const state = {} as ProjectState;
    const measured: InvocationPerformance = { invocationId: "streamed", agent: "idea", attempt: 0, status: "completed",
      startedAt: at(0), firstTokenAt: at(1), firstTokenLatencyMs: 420, completedAt: at(2),
      outputTokens: 2, outputDurationMs: 1000, averageTokensPerSecond: 2, tokenSource: "estimated", streaming: true };
    recordTerminalPerformance(state, measured, true);
    for (let index = 0; index < 120; index++) {
      const { firstTokenAt, firstTokenLatencyMs, ...buffered } = measured;
      recordTerminalPerformance(state, { ...buffered, invocationId: `buffered-${index}`, startedAt: at(index + 3),
        completedAt: at(index + 4), streaming: false }, true);
    }
    expect(state.performance?.history).toHaveLength(101);
    expect(state.performance?.history?.find((value) => value.firstTokenLatencyMs !== undefined)).toEqual(measured);
    expect(state.performance?.aggregate?.invocations).toBe(121);
  });
});
