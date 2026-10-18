import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvocationPerformanceTracker,
  updatedPerformanceAggregate
} from "../src/orchestrator.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("invocation performance metrics", () => {
  it("retains exact aggregate timing after ten thousand completed provider requests", () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-17T00:00:00Z");
    vi.setSystemTime(start);
    const tracker = new InvocationPerformanceTracker("long-resident", "main", start, () => undefined);
    for (let index = 0; index < 10_000; index++) {
      const requestId = `request-${index}`;
      tracker.observe({ requestId, phase: "started", timestamp: new Date(start + index * 10).toISOString(), streaming: false, deliveryMode: "buffered-json" });
      tracker.observe({ requestId, phase: "completed", timestamp: new Date(start + index * 10 + 5).toISOString(), streaming: false, deliveryMode: "buffered-json", estimatedOutputTokens: 1 });
    }
    expect(tracker.finish("completed")).toMatchObject({
      startedAt: new Date(start).toISOString(), outputTokens: 10_000,
      outputDurationMs: 99_995, requestActive: false, averageTokensPerSecond: 100
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops current speed between provider requests and retains the latest measured first-token latency", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const published = vi.fn();
    const tracker = new InvocationPerformanceTracker("inv-multi", "idea", Date.now(), published);
    const send = (requestId: string, phase: "started" | "delta" | "completed", seconds: number, text?: string) => {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 9, 0, 0, seconds)));
      tracker.observe({ requestId, phase, timestamp: new Date().toISOString(), streaming: true, deliveryMode: "native-stream", text });
      return published.mock.calls.at(-1)![0];
    };
    send("r1", "started", 0);
    expect(send("r1", "delta", 1, "abcd")).toMatchObject({ requestActive: true, firstTokenLatencyMs: 1000 });
    const idle = send("r1", "completed", 2);
    expect(idle).toMatchObject({ status: "active", requestActive: false, firstTokenLatencyMs: 1000, averageTokensPerSecond: 1 });
    expect(idle.currentTokensPerSecond).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const waiting = send("r2", "started", 10);
    expect(waiting.firstTokenLatencyMs).toBe(1000);
    expect(waiting.currentTokensPerSecond).toBeUndefined();
    expect(send("r2", "delta", 12, "efgh")).toMatchObject({ firstTokenLatencyMs: 2000, firstTokenAt: "2026-10-09T00:00:12.000Z" });
    send("r2", "completed", 13);
    tracker.finish("completed");
  });

  it("measures first-token latency from the real provider request and prefers official usage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T00:00:01.000Z"));
    const published = vi.fn();
    const tracker = new InvocationPerformanceTracker(
      "inv_stream",
      "execution",
      Date.now(),
      published
    );
    tracker.observe({
      phase: "started",
      requestId: "request-1",
      timestamp: "2026-09-19T00:00:01.000Z",
      streaming: true,
      deliveryMode: "native-stream"
    });
    tracker.observe({
      phase: "delta",
      requestId: "request-1",
      timestamp: "2026-09-19T00:00:01.500Z",
      streaming: true,
      deliveryMode: "native-stream",
      deltaKind: "visible-text",
      text: "a".repeat(40)
    });
    tracker.observe({
      phase: "delta",
      requestId: "request-1",
      timestamp: "2026-09-19T00:00:02.500Z",
      streaming: true,
      deliveryMode: "native-stream",
      deltaKind: "tool-arguments",
      text: "b".repeat(40)
    });
    tracker.recordUsage({
      usageId: "usage-1",
      protocol: "responses",
      model: "model-alpha",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 40,
      totalTokens: 50
    });
    tracker.observe({
      phase: "completed",
      requestId: "request-1",
      timestamp: "2026-09-19T00:00:03.000Z",
      streaming: true,
      deliveryMode: "native-stream"
    });
    vi.setSystemTime(new Date("2026-09-19T00:00:03.000Z"));

    expect(tracker.finish("completed")).toMatchObject({
      invocationId: "inv_stream",
      attempt: 0,
      firstTokenLatencyMs: 500,
      outputDurationMs: 1_500,
      outputTokens: 40,
      averageTokensPerSecond: 26.7,
      tokenSource: "official",
      streaming: true,
      status: "completed"
    });
    expect(published.mock.calls.some(([value]) =>
      value.status === "active" && value.currentTokensPerSecond > 0
    )).toBe(true);
  });

  it("does not invent first-token or current speed for buffered JSON delivery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T00:00:01.000Z"));
    const tracker = new InvocationPerformanceTracker(
      "inv_buffered",
      "writing",
      Date.now(),
      () => undefined
    );
    tracker.observe({
      phase: "started",
      requestId: "request-buffered",
      timestamp: "2026-09-19T00:00:01.000Z",
      streaming: false,
      deliveryMode: "buffered-json"
    });
    tracker.recordUsage({
      usageId: "usage-buffered",
      protocol: "chat-completions",
      model: "model-beta",
      inputTokens: 4,
      cachedInputTokens: 0,
      outputTokens: 20,
      totalTokens: 24
    });
    tracker.observe({
      phase: "completed",
      requestId: "request-buffered",
      timestamp: "2026-09-19T00:00:03.000Z",
      streaming: false,
      deliveryMode: "buffered-json",
      estimatedOutputTokens: 99
    });
    vi.setSystemTime(new Date("2026-09-19T00:00:03.000Z"));

    const result = tracker.finish("completed");
    expect(result).toMatchObject({
      averageTokensPerSecond: 10,
      outputDurationMs: 2_000,
      outputTokens: 20,
      tokenSource: "official",
      streaming: false
    });
    expect(result).not.toHaveProperty("firstTokenLatencyMs");
    expect(result).not.toHaveProperty("currentTokensPerSecond");
  });

  it("computes an estimated completed average for buffered output without Provider usage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T00:00:01.000Z"));
    const tracker = new InvocationPerformanceTracker(
      "inv_buffered_estimated",
      "review",
      Date.now(),
      () => undefined
    );
    tracker.observe({
      phase: "started",
      requestId: "request-buffered-estimated",
      timestamp: "2026-09-19T00:00:01.000Z",
      streaming: false,
      deliveryMode: "buffered-json"
    });
    tracker.observe({
      phase: "completed",
      requestId: "request-buffered-estimated",
      timestamp: "2026-09-19T00:00:03.000Z",
      streaming: false,
      deliveryMode: "buffered-json",
      estimatedOutputTokens: 20
    });
    vi.setSystemTime(new Date("2026-09-19T00:00:03.000Z"));

    expect(tracker.finish("completed")).toMatchObject({
      averageTokensPerSecond: 10,
      outputDurationMs: 2_000,
      outputTokens: 20,
      tokenSource: "estimated",
      streaming: false
    });
  });

  it("estimates fragmented streaming text cumulatively instead of rounding every chunk up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T00:00:00.000Z"));
    const tracker = new InvocationPerformanceTracker(
      "inv_fragmented",
      "idea",
      Date.now(),
      () => undefined
    );
    tracker.observe({
      phase: "started",
      requestId: "request-fragmented",
      timestamp: "2026-09-19T00:00:00.000Z",
      streaming: true,
      deliveryMode: "native-stream"
    });
    for (let index = 0; index < 40; index += 1) {
      tracker.observe({
        phase: "delta",
        requestId: "request-fragmented",
        timestamp: `2026-09-19T00:00:00.${String(index + 1).padStart(3, "0")}Z`,
        streaming: true,
        deliveryMode: "native-stream",
        deltaKind: "visible-text",
        text: "字"
      });
    }
    tracker.observe({
      phase: "completed",
      requestId: "request-fragmented",
      timestamp: "2026-09-19T00:00:01.000Z",
      streaming: true,
      deliveryMode: "native-stream"
    });
    vi.setSystemTime(new Date("2026-09-19T00:00:01.000Z"));

    expect(tracker.finish("completed")).toMatchObject({
      outputTokens: 10,
      tokenSource: "estimated",
      streaming: true
    });
  });

  it("aggregates only terminal samples and keeps mixed estimation provenance visible", () => {
    const first = updatedPerformanceAggregate(undefined, {
      invocationId: "inv-1",
      agent: "idea",
      attempt: 0,
      status: "completed",
      startedAt: "2026-09-19T00:00:00.000Z",
      completedAt: "2026-09-19T00:00:02.000Z",
      firstTokenLatencyMs: 500,
      averageTokensPerSecond: 10,
      outputDurationMs: 2_000,
      outputTokens: 20,
      tokenSource: "official",
      streaming: true
    });
    const second = updatedPerformanceAggregate(first, {
      invocationId: "inv-2",
      agent: "idea",
      attempt: 0,
      status: "completed",
      startedAt: "2026-09-19T00:00:03.000Z",
      completedAt: "2026-09-19T00:00:04.000Z",
      firstTokenLatencyMs: 1_500,
      averageTokensPerSecond: 20,
      outputDurationMs: 1_000,
      outputTokens: 20,
      tokenSource: "estimated",
      streaming: true
    });

    expect(second).toMatchObject({
      invocations: 2,
      outputTokens: 40,
      outputDurationMs: 3_000,
      averageFirstTokenLatencyMs: 1_000,
      averageTokensPerSecond: 13.3,
      tokenSource: "mixed"
    });
  });
});
