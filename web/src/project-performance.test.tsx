import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mergePerformanceResults, resolvePerformanceMetrics, useProjectPerformance } from "./project-performance";
import { normalizeProjectPerformance } from "./lib";
import type { AgentEvent, InvocationPerformance, ProjectPerformance } from "./types";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 9, 0, 0, seconds)).toISOString();
const measured: InvocationPerformance = {
  invocationId: "inv-first", agent: "idea", attempt: 0, status: "completed", startedAt: at(0),
  firstTokenAt: at(1), completedAt: at(3), firstTokenLatencyMs: 420,
  averageTokensPerSecond: 12, outputTokens: 24, tokenSource: "official", streaming: true
};
const saved: ProjectPerformance = { history: [measured], byAgent: { idea: measured }, latest: measured,
  aggregate: { invocations: 2, outputTokens: 60, outputDurationMs: 4000, firstTokenSamples: 2,
    totalFirstTokenLatencyMs: 1998, averageFirstTokenLatencyMs: 999, averageTokensPerSecond: 15,
    tokenSource: "official", updatedAt: at(3) } };
const active: InvocationPerformance = { invocationId: "inv-worker", agent: "worker_a", attempt: 0,
  status: "active", requestActive: true, startedAt: at(5), currentTokensPerSecond: 8,
  outputTokens: 2, tokenSource: "estimated", streaming: true };

describe("persistent project performance", () => {
  it("keeps the project average and last actual TTFT when another Agent starts without a measurement", () => {
    const metrics = resolvePerformanceMetrics(saved, active, "running");
    expect(metrics.current).toEqual(active);
    expect(metrics.average?.averageTokensPerSecond).toBe(15);
    expect(metrics.latestToken?.firstTokenLatencyMs).toBe(420);
    expect(resolvePerformanceMetrics({ byAgent: {}, aggregate: saved.aggregate }, undefined, "running").latestToken).toBeUndefined();
  });

  it("shows current speed only during a live request in a running project", () => {
    for (const status of ["paused", "completed", "cancelled"] as const) {
      expect(resolvePerformanceMetrics(saved, active, status).current).toBeUndefined();
    }
    expect(resolvePerformanceMetrics(saved, { ...active, requestActive: false }, "running").current).toBeUndefined();
    expect(resolvePerformanceMetrics(saved, active, "running", "idea").current).toBeUndefined();
    const terminal = { ...active, status: "completed" as const, completedAt: at(8) };
    const results = mergePerformanceResults(saved, undefined, [terminal]);
    expect(resolvePerformanceMetrics(results, active, "running").current).toBeUndefined();
    expect(resolvePerformanceMetrics(results, { ...active, startedAt: at(9) }, "running").current).toBeDefined();
  });

  it("uses the most recent first token even when an older parallel request finishes later", () => {
    const recent = { ...measured, invocationId: "recent", firstTokenAt: at(6), firstTokenLatencyMs: 0, completedAt: at(7) };
    const old = { ...measured, invocationId: "old", completedAt: at(10) };
    const buffered = { ...active, status: "completed" as const, completedAt: at(11), streaming: false };
    const results = mergePerformanceResults(saved, undefined, [recent, old, buffered]);
    expect(resolvePerformanceMetrics(results, undefined, "running").latestToken?.firstTokenLatencyMs).toBe(0);
  });

  it("retains measurements after many buffered calls and does not replace terminal results with stale live values", () => {
    const buffered = Array.from({ length: 120 }, (_, index) => ({ ...active, agent: "idea", invocationId: `buffered-${index}`,
      status: "completed" as const, startedAt: at(index + 10), completedAt: at(index + 11), streaming: false }));
    const results = mergePerformanceResults(saved, undefined, buffered);
    expect(results.history).toHaveLength(101);
    expect(resolvePerformanceMetrics(results, undefined, "running").latestToken).toEqual(measured);
    const restored = normalizeProjectPerformance(results);
    expect(resolvePerformanceMetrics(restored, undefined, "running").latestToken?.firstTokenLatencyMs).toBe(420);
    expect(mergePerformanceResults(saved, undefined, [{ ...measured, status: "active" }]).latest?.status).toBe("completed");
  });

  it("bridges cleared live snapshots and delayed server snapshots, restores saved results and resets on project changes", () => {
    const events: AgentEvent[] = [];
    const { result, rerender, unmount } = renderHook(({ id, snapshot, live, timeline }) =>
      useProjectPerformance(id, snapshot, timeline, live), {
      initialProps: { id: "project-1", snapshot: saved as ProjectPerformance | undefined,
        live: active as InvocationPerformance | undefined, timeline: events }
    });
    const measuredLive = { ...active, firstTokenAt: at(6), firstTokenLatencyMs: 250 };
    rerender({ id: "project-1", snapshot: undefined, live: measuredLive, timeline: events });
    rerender({ id: "project-1", snapshot: undefined, live: undefined, timeline: events });
    let metrics = resolvePerformanceMetrics(result.current, undefined, "running");
    expect(metrics.average?.averageTokensPerSecond).toBe(15);
    expect(metrics.latestToken?.firstTokenLatencyMs).toBe(250);
    const terminal = { ...measuredLive, status: "completed" as const, completedAt: at(8), averageTokensPerSecond: 10 };
    rerender({ id: "project-1", snapshot: undefined, live: undefined,
      timeline: [{ seq: 1, type: "invocation.performance", ts: at(8), message: "Performance", data: { performance: terminal } }] });
    expect(result.current.latest?.averageTokensPerSecond).toBe(10);
    rerender({ id: "project-2", snapshot: undefined, live: undefined, timeline: events });
    metrics = resolvePerformanceMetrics(result.current, undefined, "running");
    expect(metrics.average).toBeUndefined();
    expect(metrics.latestToken).toBeUndefined();
    unmount();
    const refreshed = renderHook(() => useProjectPerformance("project-1", saved, events, undefined));
    expect(resolvePerformanceMetrics(refreshed.result.current, undefined, "running").latestToken?.firstTokenLatencyMs).toBe(420);
  });
});
