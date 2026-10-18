import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./types";
import { useProjectEvents } from "./useProjectEvents";

const apiMocks = vi.hoisted(() => ({
  getProjectEventBootstrap: vi.fn(),
  getProjectEventHistory: vi.fn(),
  eventStreamUrl: vi.fn(
    (projectId: string, after: number) => `stream:${projectId}:after:${after}`
  )
}));

vi.mock("./api", () => apiMocks);

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<
    string,
    Set<(event: MessageEvent<string>) => void>
  >();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, listeners);
  }

  close(): void {}

  emit(type: string, event: unknown): void {
    const message = { data: JSON.stringify(event) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  }
}

function event(
  seq: number,
  type: string,
  agent: AgentEvent["agent"] = "execution"
): AgentEvent {
  return {
    seq,
    type,
    agent,
    message: `${type} ${seq}`,
    ts: new Date(Date.UTC(2026, 7, 3, 0, 0, seq)).toISOString(),
    data: { invocationId: `inv_${seq}` }
  };
}

describe("useProjectEvents bounded event stream", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    apiMocks.getProjectEventBootstrap.mockReset().mockResolvedValue({
      events: [event(99, "agent.trace"), event(100, "agent.trace")],
      timelineEvents: [event(1, "agent.started", "idea")],
      totalEvents: 100,
      lastSeq: 100
    });
    apiMocks.getProjectEventHistory.mockReset().mockResolvedValue({
      events: [event(98, "agent.trace")],
      hasMore: false
    });
    apiMocks.eventStreamUrl.mockClear();
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("receives failure history and accepted workflow updates as named SSE events", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_updates"));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    act(() => {
      MockEventSource.instances[0].emit("failure.attempt.recorded", event(101, "failure.attempt.recorded"));
      MockEventSource.instances[0].emit("workflow.reconfigured", event(102, "workflow.reconfigured"));
    });
    await waitFor(() => expect(result.current.events.map(item => item.type)).toContain("failure.attempt.recorded"));
    expect(result.current.events.at(-1)?.type).toBe("workflow.reconfigured");
    expect(result.current.totalEvents).toBe(102);
  });

  it("reuses unchanged runtime and performance across live text updates", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_stable"));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const snapshot = {
      projectId: "prj_stable", streams: [], events: [],
      runtime: { stateRevision: 5, status: "running", phase: "model:running", executionCount: 1, activities: [] },
      performance: { invocationId: "inv_live", agent: "execution", attempt: 0, status: "active",
        startedAt: "2026-10-17T00:00:00Z", outputTokens: 1, tokenSource: "estimated", streaming: true }
    };
    act(() => MockEventSource.instances[0].emit("live.snapshot", snapshot));
    const runtime = result.current.live.runtime;
    const performance = result.current.live.performance;
    expect(runtime).toBeDefined();
    expect(performance).toBeDefined();
    act(() => MockEventSource.instances[0].emit("live.snapshot", snapshot));
    expect(result.current.live.runtime).toBe(runtime);
    expect(result.current.live.performance).toBe(performance);
    act(() => MockEventSource.instances[0].emit("live.snapshot", {
      ...snapshot, runtime: { ...snapshot.runtime, phase: "tool:running" }
    }));
    expect(result.current.live.runtime?.phase).toBe("tool:running");
    expect(result.current.live.runtime).not.toBe(runtime);
  });

  it("bootstraps once, resumes from the cursor and batches live events", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_fast"));

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(result.current.events.map((item) => item.seq)).toEqual([99, 100]);
    expect(result.current.timelineEvents.map((item) => item.seq)).toEqual([1]);
    expect(result.current.totalEvents).toBe(100);
    expect(result.current.hasOlder).toBe(true);
    expect(apiMocks.eventStreamUrl).toHaveBeenCalledWith("prj_fast", 100);

    const source = MockEventSource.instances[0];
    act(() => source.onopen?.(new Event("open")));
    expect(result.current.connection).toBe("live");

    act(() => {
      source.emit("live.snapshot", {
        projectId: "prj_fast",
        streams: [{
          projectId: "prj_fast",
          invocationId: "inv_live",
          agent: "execution",
          harnessId: "fixture",
          attempt: 1,
          itemId: "assistant-1-0",
          content: "正在流式输出",
          phase: "streaming",
          role: "active",
          updatedAt: "2026-08-03T00:02:00.000Z"
        }],
        events: [{
          id: "live:tool-1",
          seq: 8_000_000_001,
          projectId: "prj_fast",
          ts: "2026-08-03T00:02:00.100Z",
          type: "agent.trace",
          level: "info",
          agent: "execution",
          message: "read",
          data: { invocationId: "inv_live", liveEphemeral: true }
        }],
        performance: {
          invocationId: "inv_live",
          agent: "execution",
          attempt: 1,
          status: "active",
          startedAt: "2026-08-03T00:01:59.000Z",
          firstTokenLatencyMs: 420,
          currentTokensPerSecond: 12.5,
          outputTokens: 8,
          tokenSource: "estimated",
          streaming: true
        },
        runtime: {
          stateRevision: 12,
          status: "running",
          phase: "model:running",
          currentAgent: "execution",
          activeInvocationId: "inv_live",
          activityStartedAt: "2026-08-03T00:01:59.000Z",
          nodeRunId: "node_live",
          executionId: "execution_live",
          ownershipEpoch: 2,
          leaseState: "current",
          executionCount: 1,
          primaryActivity: {
            activityId: "evt_runtime_live",
            projectId: "prj_fast",
            kind: "turn",
            phase: "model:running",
            invocationId: "inv_live",
            agentId: "execution",
            nodeRunId: "node_live",
            executionId: "execution_live",
            ownershipEpoch: 2,
            inputId: "input_live",
            startedAt: "2026-08-03T00:01:59.000Z",
            writerLeaseEpoch: 4,
            leaseState: "current"
          },
          activities: []
        }
      });
    });
    expect(result.current.live).toMatchObject({
      projectId: "prj_fast",
      streams: [expect.objectContaining({ itemId: "assistant-1-0", content: "正在流式输出" })],
      events: [expect.objectContaining({ seq: 8_000_000_001, message: "read" })],
      performance: expect.objectContaining({ currentTokensPerSecond: 12.5 }),
      runtime: expect.objectContaining({
        stateRevision: 12,
        status: "running",
        currentAgent: "execution",
        activeInvocationId: "inv_live",
        primaryActivity: expect.objectContaining({ activityId: "evt_runtime_live" })
      })
    });

    act(() => {
      source.emit("agent.trace", event(101, "agent.trace"));
      source.emit("agent.started", event(102, "agent.started", "main"));
      source.emit("user.input.queued", {
        ...event(103, "user.input.queued", "main"),
        data: {
          inputId: "inp_live",
          targetMainInvocation: 3,
          preview: "Run the larger experiment first"
        }
      });
      source.emit("route.queued", {
        ...event(104, "route.queued", "main"),
        data: { sourceAgent: "main", targetAgent: "writing", invocationId: "inv_104" }
      });
      source.emit("main.assignment.queued", {
        ...event(105, "main.assignment.queued", "main"),
        data: { sourceAgent: "main", target: "review", invocationId: "inv_105" }
      });
    });
    expect(result.current.events.map((item) => item.seq)).toEqual([99, 100]);

    await waitFor(() =>
      expect(result.current.events.map((item) => item.seq)).toEqual([
        99,
        100,
        101,
        102,
        103,
        104,
        105
      ])
    );
    expect(result.current.totalEvents).toBe(105);
    expect(result.current.timelineEvents.map((item) => item.seq)).toEqual([
      1,
      102,
      103,
      104,
      105
    ]);

    await act(async () => {
      await result.current.loadOlder();
    });
    expect(apiMocks.getProjectEventHistory).toHaveBeenCalledWith(
      "prj_fast",
      99,
      1_000
    );
    expect(result.current.events.map((item) => item.seq)).toEqual([
      98,
      99,
      100,
      101,
      102,
      103,
      104,
      105
    ]);
    expect(result.current.hasOlder).toBe(false);
  });

  it("receives checkpoint and cancellation settlement events so project metadata can refresh", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_cancelled"));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    act(() => {
      MockEventSource.instances[0].emit("workspace.checkpoint.saved", event(101, "workspace.checkpoint.saved"));
      MockEventSource.instances[0].emit("project.cancellation.settled", event(102, "project.cancellation.settled"));
    });
    await waitFor(() => expect(result.current.events.slice(-2).map((item) => item.type)).toEqual(["workspace.checkpoint.saved", "project.cancellation.settled"]));
  });

  it("retains performance completion events in the timeline after live metrics clear", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_performance"));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const performanceEvent = { ...event(101, "invocation.performance"), data: { performance: {
      invocationId: "inv-metrics", agent: "execution", attempt: 0, status: "completed",
      startedAt: "2026-10-09T00:00:00Z", completedAt: "2026-10-09T00:00:03Z",
      firstTokenLatencyMs: 420, averageTokensPerSecond: 10, outputTokens: 20, tokenSource: "official", streaming: true
    } } };
    act(() => {
      MockEventSource.instances[0].emit("invocation.performance", performanceEvent);
      MockEventSource.instances[0].emit("live.snapshot", { projectId: "prj_performance", streams: [], events: [] });
    });
    await waitFor(() => expect(result.current.timelineEvents.at(-1)).toEqual(performanceEvent));
    expect(result.current.live.performance).toBeUndefined();
  });

  it("subscribes to route and Main freeze/recovery collaboration facts", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_collaboration_routes"));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit("collaboration.route.emitted", event(101, "collaboration.route.emitted", "main"));
      source.emit("collaboration.main.frozen", event(102, "collaboration.main.frozen", "main"));
      source.emit("collaboration.main.recovered", event(103, "collaboration.main.recovered", "main"));
    });

    await waitFor(() => expect(result.current.events.slice(-3).map((item) => item.type)).toEqual([
      "collaboration.route.emitted",
      "collaboration.main.frozen",
      "collaboration.main.recovered"
    ]));
    expect(result.current.timelineEvents.slice(-3).map((item) => item.type)).toEqual([
      "collaboration.route.emitted",
      "collaboration.main.frozen",
      "collaboration.main.recovered"
    ]);
  });

  it("observes durable workflow submission and terminal changes for the shared record window", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_workflow_adjustments"));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    act(() => {
      MockEventSource.instances[0].emit("workflow.adjustment.submitted", event(101, "workflow.adjustment.submitted", "main"));
      MockEventSource.instances[0].emit("workflow.adjustment.transitioned", event(102, "workflow.adjustment.transitioned", "main"));
    });
    await waitFor(() => expect(result.current.events.slice(-2).map(item => item.type)).toEqual(["workflow.adjustment.submitted", "workflow.adjustment.transitioned"]));
  });

  it("receives named collaboration events, deduplicates eventId/seq and resumes after reconnect", async () => {
    const { result } = renderHook(() => useProjectEvents("prj_group"));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0];
    const started = {
      ...event(101, "collaboration.execution.started", "worker_a"),
      eventId: "evt_execution_started",
      executionId: "execution_1",
      groupRunId: "group_run_1"
    };

    act(() => {
      source.emit("collaboration.execution.started", started);
      source.emit("collaboration.execution.started", started);
      source.emit("collaboration.execution.updated", {
        ...started,
        seq: 102,
        type: "collaboration.execution.updated",
        message: "replayed with a newer cursor"
      });
    });

    await waitFor(() => {
      expect(result.current.events.filter((item) => item.eventId === started.eventId))
        .toEqual([expect.objectContaining({ seq: 102 })]);
    });
    expect(result.current.timelineEvents.filter((item) => item.eventId === started.eventId))
      .toHaveLength(1);
    expect(result.current.totalEvents).toBe(101);

    act(() => source.onerror?.(new Event("error")));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2), {
      timeout: 3_000
    });
    expect(apiMocks.eventStreamUrl).toHaveBeenLastCalledWith("prj_group", 102);
  });
});
