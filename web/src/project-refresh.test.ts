import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRefreshScheduler } from "./project-refresh";

describe("project snapshot refresh scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces continuous updates without starving the next refresh", async () => {
    const load = vi.fn(async () => undefined);
    const refresh = createProjectRefreshScheduler(load);
    await refresh.refresh();
    for (let index = 0; index < 20; index++) {
      refresh.schedule();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(load).toHaveBeenCalledTimes(2);
    refresh.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps background loads and performs one trailing load for changes received in flight", async () => {
    let finish!: () => void;
    const load = vi.fn<() => Promise<void>>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const refresh = createProjectRefreshScheduler(load);
    const initial = refresh.refresh();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 20; index++) refresh.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await initial;
    await vi.advanceTimersByTimeAsync(120);
    expect(load).toHaveBeenCalledTimes(2);
    refresh.dispose();
  });

  it("shares one immediate fresh follow-up for explicit actions during an active load", async () => {
    let finish!: () => void;
    const load = vi.fn<() => Promise<void>>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const refresh = createProjectRefreshScheduler(load);
    const initial = refresh.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const firstAction = refresh.refresh();
    expect(refresh.refresh()).toBe(firstAction);
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([initial, firstAction]);
    expect(load).toHaveBeenCalledTimes(2);
    refresh.dispose();
  });

  it("drops scheduled work and explicit follow-ups on disposal", async () => {
    let finish!: () => void;
    const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const refresh = createProjectRefreshScheduler(load);
    const initial = refresh.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const followUp = refresh.refresh();
    refresh.schedule();
    refresh.dispose();
    finish();
    await Promise.all([initial, followUp]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can refresh again after a failed request", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue(undefined);
    const refresh = createProjectRefreshScheduler(load);
    await expect(refresh.refresh()).rejects.toThrow("temporary outage");
    refresh.schedule();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(2);
    refresh.dispose();
  });
});
