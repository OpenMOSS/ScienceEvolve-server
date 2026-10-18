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
  const request = { invocationId: "inv-native", agent: "worker_a", onTokenUsage: vi.fn() } as unknown as AgentRunRequest;
  dispatcher.decorate({ state, request });
  async function send(phase: "started" | "delta" | "completed", seconds: number, text?: string) {
    vi.setSystemTime(new Date(at(seconds)));
    await request.onModelStreamEvent!({ phase, requestId: "request-native", timestamp: at(seconds),
      streaming: true, deliveryMode: "native-stream", text });
  }
  return { storage, state, dispatcher, request, send };
}

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
