import { describe, expect, it } from "vitest";
import {
  AgentQueueAbortedError,
  AgentScheduler
} from "../src/agent-scheduler.js";

describe("AgentScheduler", () => {
  it("grants ten concurrent leases per role and queues the eleventh", async () => {
    const scheduler = new AgentScheduler();
    const active = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        scheduler.acquire(
          "idea",
          `project-${index + 1}`,
          `2026-07-31T00:00:${String(index).padStart(2, "0")}.000Z`,
          index + 1,
          new AbortController().signal
        )
      )
    );
    let eleventhGranted = false;
    const eleventhPromise = scheduler
      .acquire(
        "idea",
        "project-11",
        "2026-07-31T00:00:10.000Z",
        11,
        new AbortController().signal
      )
      .then((lease) => {
        eleventhGranted = true;
        return lease;
      });

    await Promise.resolve();
    expect(eleventhGranted).toBe(false);
    expect(scheduler.snapshot().idea).toMatchObject({
      capacity: 10,
      activeProjectIds: Array.from(
        { length: 10 },
        (_, index) => `project-${index + 1}`
      ),
      queued: [{ projectId: "project-11", position: 1 }]
    });

    active[4].release();
    const eleventh = await eleventhPromise;
    expect(eleventhGranted).toBe(true);
    expect(scheduler.snapshot().idea.activeProjectIds).toHaveLength(10);

    active.forEach((lease, index) => {
      if (index !== 4) lease.release();
    });
    eleventh.release();
    expect(scheduler.snapshot().idea).toEqual({
      capacity: 10,
      activeProjectIds: [],
      queued: []
    });
  });

  it("grants one FIFO lease per role", async () => {
    const scheduler = new AgentScheduler(1);
    const first = await scheduler.acquire(
      "idea",
      "project-a",
      "2026-07-31T00:00:00.000Z",
      1,
      new AbortController().signal
    );
    let secondGranted = false;
    let thirdGranted = false;
    const secondPromise = scheduler
      .acquire(
        "idea",
        "project-b",
        "2026-07-31T00:00:01.000Z",
        2,
        new AbortController().signal
      )
      .then((lease) => {
        secondGranted = true;
        return lease;
      });
    const thirdPromise = scheduler
      .acquire(
        "idea",
        "project-c",
        "2026-07-31T00:00:02.000Z",
        3,
        new AbortController().signal
      )
      .then((lease) => {
        thirdGranted = true;
        return lease;
      });

    expect(scheduler.snapshot().idea).toEqual({
      capacity: 1,
      activeProjectIds: ["project-a"],
      queued: [
        {
          projectId: "project-b",
          position: 1,
          enteredAt: "2026-07-31T00:00:01.000Z"
        },
        {
          projectId: "project-c",
          position: 2,
          enteredAt: "2026-07-31T00:00:02.000Z"
        }
      ]
    });
    expect(secondGranted).toBe(false);
    expect(thirdGranted).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(secondGranted).toBe(true);
    expect(thirdGranted).toBe(false);
    second.release();
    const third = await thirdPromise;
    expect(thirdGranted).toBe(true);
    third.release();
    expect(scheduler.snapshot().idea).toEqual({
      capacity: 1,
      activeProjectIds: [],
      queued: []
    });
  });

  it("preserves enqueue order when timestamps are identical", async () => {
    const scheduler = new AgentScheduler(1);
    const active = await scheduler.acquire(
      "idea",
      "project-active",
      "2026-07-31T00:00:00.000Z",
      1,
      new AbortController().signal
    );
    const sameTimestamp = "2026-07-31T00:00:01.000Z";
    const firstWaiting = scheduler.acquire(
      "idea",
      "project-z",
      sameTimestamp,
      2,
      new AbortController().signal
    );
    let laterGranted = false;
    const laterWaiting = scheduler
      .acquire(
        "idea",
        "project-a",
        sameTimestamp,
        3,
        new AbortController().signal
      )
      .then((lease) => {
        laterGranted = true;
        return lease;
      });

    expect(
      scheduler.snapshot().idea.queued.map((item) => item.projectId)
    ).toEqual(["project-z", "project-a"]);
    active.release();
    const first = await firstWaiting;
    expect(laterGranted).toBe(false);
    first.release();
    const later = await laterWaiting;
    later.release();
  });

  it("removes an aborted waiter without creating a ghost owner", async () => {
    const scheduler = new AgentScheduler(1);
    const active = await scheduler.acquire(
      "review",
      "project-a",
      "2026-07-31T00:00:00.000Z",
      1,
      new AbortController().signal
    );
    const waitingController = new AbortController();
    const waiting = scheduler.acquire(
      "review",
      "project-b",
      "2026-07-31T00:00:01.000Z",
      2,
      waitingController.signal
    );
    waitingController.abort();

    await expect(waiting).rejects.toBeInstanceOf(AgentQueueAbortedError);
    expect(scheduler.snapshot().review).toEqual({
      capacity: 1,
      activeProjectIds: ["project-a"],
      queued: []
    });
    active.release();
    expect(scheduler.snapshot().review).toEqual({
      capacity: 1,
      activeProjectIds: [],
      queued: []
    });
  });

  it("does not release an active lease merely because its signal aborts", async () => {
    const scheduler = new AgentScheduler(1);
    const activeController = new AbortController();
    const active = await scheduler.acquire(
      "writing",
      "project-a",
      "2026-07-31T00:00:00.000Z",
      1,
      activeController.signal
    );
    let nextGranted = false;
    const nextPromise = scheduler
      .acquire(
        "writing",
        "project-b",
        "2026-07-31T00:00:01.000Z",
        2,
        new AbortController().signal
      )
      .then((lease) => {
        nextGranted = true;
        return lease;
      });

    activeController.abort();
    await Promise.resolve();
    expect(nextGranted).toBe(false);
    expect(scheduler.snapshot().writing.activeProjectIds).toEqual(["project-a"]);

    active.release();
    const next = await nextPromise;
    expect(nextGranted).toBe(true);
    next.release();
  });

  it("grants different roles independently", async () => {
    const scheduler = new AgentScheduler(1);
    const idea = await scheduler.acquire(
      "idea",
      "project-a",
      "2026-07-31T00:00:00.000Z",
      1,
      new AbortController().signal
    );
    const writing = await scheduler.acquire(
      "writing",
      "project-b",
      "2026-07-31T00:00:00.000Z",
      2,
      new AbortController().signal
    );

    expect(scheduler.snapshot().idea.activeProjectIds).toEqual(["project-a"]);
    expect(scheduler.snapshot().writing.activeProjectIds).toEqual(["project-b"]);
    idea.release();
    writing.release();
  });
});
