import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasEdge, CanvasNode } from "./canvas-model";
import { previewCanvasEdges, routeCanvasEdges } from "./canvas-router";
import { CanvasRoutingService, canvasRoutingKey, type CanvasRoutingRequest, type CanvasRoutingResponse } from "./canvas-routing-service";

const nodes: CanvasNode[] = [
  { id: "a", name: "a", kind: "agent", x: 0, y: 0 },
  { id: "b", name: "b", kind: "agent", x: 400, y: 200 },
  { id: "c", name: "c", kind: "agent", x: 800, y: 0 }
];
const edges: CanvasEdge[] = [
  { id: "a-b", source: "a", target: "b", kind: "parallel", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true, fixed: false },
  { id: "b-c", source: "b", target: "c", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: false, targetPortPinned: false, fixed: false }
];
const request = { edges, nodes };

class FakeWorker {
  onmessage: ((event: MessageEvent<CanvasRoutingResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn<(request: CanvasRoutingRequest) => void>();
  terminate = vi.fn();
  complete(geometry = routeCanvasEdges(edges, nodes)) { this.onmessage?.(new MessageEvent<CanvasRoutingResponse>("message", { data: { geometry } })); }
}
afterEach(() => vi.useRealTimers());

describe("canvas routing jobs", () => {
  it("shares one calculation across surfaces and keeps it alive until the final subscriber leaves", () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const service = new CanvasRoutingService(factory);
    const first = vi.fn(), second = vi.fn(), cached = vi.fn();
    const key = canvasRoutingKey(request);
    const cancel = service.subscribe(key, request, first);
    service.subscribe(key, request, second);
    expect(factory).toHaveBeenCalledTimes(1);
    cancel();
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.complete();
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls[0]![0]).toEqual(routeCanvasEdges(edges, nodes));
    service.subscribe(key, request, cached);
    expect(cached.mock.calls[0]![0]).toBe(second.mock.calls[0]![0]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates superseded work and ignores messages from the old layout", () => {
    const workers: FakeWorker[] = [];
    const service = new CanvasRoutingService(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    const old = vi.fn(), current = vi.fn();
    const cancel = service.subscribe("old", request, old);
    const lateMessage = workers[0]!.onmessage!;
    service.subscribe("new", { ...request, nodes: nodes.map((node) => ({ ...node, y: node.y + 120 })) }, current);
    expect(workers).toHaveLength(1);
    cancel();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
    lateMessage(new MessageEvent<CanvasRoutingResponse>("message", { data: { geometry: [] } }));
    expect(current).not.toHaveBeenCalled();
    workers[1]!.complete();
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "blocked", "error"])("finishes the same complete routes cooperatively when the worker is %s", async (failure) => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const service = new CanvasRoutingService(() => {
      if (failure === "blocked") throw new Error("worker-src blocked");
      return failure === "unavailable" ? undefined : worker;
    });
    const complete = vi.fn();
    service.subscribe("fallback", request, complete);
    if (failure === "error") worker.onerror!(new ErrorEvent("error"));
    expect(complete).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(complete.mock.calls[0]![0]).toEqual(routeCanvasEdges(edges, nodes));
  });

  it("keys only real geometry and strips unrelated card configuration before posting", () => {
    const worker = new FakeWorker();
    const service = new CanvasRoutingService(() => worker);
    const renamed = nodes.map((node) => ({ ...node, name: "new name", displayName: "new title", template: "general" as const }));
    expect(canvasRoutingKey({ edges, nodes: renamed })).toBe(canvasRoutingKey(request));
    expect(canvasRoutingKey({ edges, nodes: nodes.map((node) => ({ ...node, height: 160 })) })).not.toBe(canvasRoutingKey(request));
    expect(canvasRoutingKey({ edges: edges.map((edge) => ({ ...edge, fixed: true })), nodes })).not.toBe(canvasRoutingKey(request));
    const cancel = service.subscribe("minimal", { edges, nodes: renamed }, vi.fn());
    expect(worker.postMessage.mock.calls[0]![0].nodes[0]).toEqual({ id: "a", name: "a", kind: "agent", x: 0, y: 0, width: 194, height: 92 });
    cancel();
  });

  it("bounds retained geometry after many different layouts", () => {
    const workers: FakeWorker[] = [];
    const service = new CanvasRoutingService(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    for (let index = 0; index < 12; index++) {
      service.subscribe(String(index), request, vi.fn());
      workers.at(-1)!.complete();
    }
    expect(service.peek("0")).toBeUndefined();
    expect(service.peek("11")).toHaveLength(edges.length);
  });
});

describe("dense first paint", () => {
  it.each([100, 500, 1000])("draws all %i connections with pinned ports and bounded work", (edgeCount) => {
    const denseEdges = Array.from({ length: edgeCount }, (_, index) => ({ ...edges[index % 2]!, id: `edge-${index}` }));
    const started = performance.now();
    const preview = previewCanvasEdges(denseEdges, nodes);
    expect(performance.now() - started).toBeLessThan(250);
    expect(preview).toHaveLength(edgeCount);
    expect(preview.every((edge) => edge.path.startsWith("M ") && edge.samples.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))).toBe(true);
    expect(preview[0]!.sourcePort).toBe("right");
    expect(preview[0]!.sourcePortPinned).toBe(true);
  });
});
