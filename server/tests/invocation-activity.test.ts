import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ACTIVITY_IDLE_WINDOW_MS,
  DEFAULT_TOOL_ACTIVITY_IDLE_WINDOW_MS,
  InvocationActivityTracker
} from "../src/internal/shared/invocation-activity.js";

describe("shared invocation activity", () => {
  it("uses separate default model and tool inactivity windows", () => {
    expect(DEFAULT_MODEL_ACTIVITY_IDLE_WINDOW_MS).toBe(20 * 60_000);
    expect(DEFAULT_TOOL_ACTIVITY_IDLE_WINDOW_MS).toBe(120 * 60_000);
  });

  it("tracks every active tool independently and starts a fresh model window", () => {
    const tracker = new InvocationActivityTracker(10);
    tracker.beginModelWait(100);
    tracker.record({ kind: "model", phase: "delta", source: "gateway", observedAt: 120 });
    tracker.record({ kind: "tool", phase: "started", source: "harness", callId: "a", name: "read", observedAt: 130 });
    tracker.record({ kind: "tool", phase: "started", source: "harness", callId: "b", name: "write", observedAt: 140 });
    tracker.record({ kind: "tool", phase: "updated", source: "harness", callId: "a", observedAt: 150 });
    tracker.record({ kind: "tool", phase: "completed", source: "harness", callId: "a", observedAt: 160 });

    expect(tracker.snapshot()).toEqual({
      lastModelActivityAt: 120,
      lastModelActivitySource: "gateway",
      activeTools: [{
        callId: "b",
        name: "write",
        startedAt: 140,
        lastActivityAt: 140
      }]
    });

    tracker.record({ kind: "tool", phase: "failed", source: "harness", callId: "b", observedAt: 200 });
    expect(tracker.snapshot()).toEqual({
      lastModelActivityAt: 200,
      lastModelActivitySource: "harness",
      activeTools: []
    });
  });

  it("wakes only for classified activity or cancellation", async () => {
    const tracker = new InvocationActivityTracker(0);
    const controller = new AbortController();
    const changed = tracker.waitForChange(1_000, controller.signal);
    tracker.record({ kind: "model", phase: "completed", source: "harness", observedAt: 10 });
    await expect(changed).resolves.toBe("changed");

    const aborted = tracker.waitForChange(1_000, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBe("aborted");
  });
});
