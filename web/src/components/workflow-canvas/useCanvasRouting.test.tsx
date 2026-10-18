import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCanvasRouting } from "./useCanvasRouting";
import * as router from "./core/canvas-router";
import type { CanvasNode, CanvasEdge } from "./core/canvas-model";
import type { CanvasRoutingRequest, CanvasRoutingResponse } from "./core/canvas-routing-service";

const nodes: CanvasNode[] = Array.from({ length: 24 }, (_, index) => ({ id: `a-${index}`, name: `a-${index}`, kind: "agent", x: 300 * (index % 4), y: 180 * Math.floor(index / 4) }));
const edges: CanvasEdge[] = Array.from({ length: 72 }, (_, index) => ({ id: `e-${index}`, source: nodes[index % 24]!.id, target: nodes[(index + 7) % 24]!.id, kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: false, targetPortPinned: false, fixed: false }));
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: MessageEvent<CanvasRoutingResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request?: CanvasRoutingRequest;
  constructor() { workers.push(this); }
  postMessage(request: CanvasRoutingRequest) { this.request = request; }
  terminate = vi.fn();
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); workers.length = 0; });

describe("background canvas routing", () => {
  it("paints every edge immediately, reuses geometry across runtime clones and rejects stale results", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const fullRoute = vi.spyOn(router, "routeCanvasEdges");
    const view = renderHook(({ nodes, edges }) => useCanvasRouting(edges, nodes), { initialProps: { nodes, edges } });
    expect(view.result.current.pending).toBe(true);
    expect(view.result.current.geometry).toHaveLength(72);
    expect(fullRoute).not.toHaveBeenCalled();
    const preview = view.result.current.geometry;
    view.rerender({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    expect(view.result.current.geometry).toBe(preview);
    expect(workers).toHaveLength(1);
    const obsolete = workers[0]!.onmessage!;
    view.rerender({ nodes: nodes.map((node) => ({ ...node, x: node.x + 10 })), edges });
    expect(workers[0]!.terminate).toHaveBeenCalled();
    expect(workers).toHaveLength(2);
    act(() => obsolete(new MessageEvent<CanvasRoutingResponse>("message", { data: { geometry: [] } })));
    expect(view.result.current.geometry).toHaveLength(72);
    expect(view.result.current.pending).toBe(true);
    const refined = router.previewCanvasEdges(edges, workers[1]!.request!.nodes).map((edge) => ({ ...edge, label: "refined" }));
    act(() => workers[1]!.onmessage!(new MessageEvent<CanvasRoutingResponse>("message", { data: { geometry: refined } })));
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.geometry).toBe(refined);
    view.rerender({ nodes: structuredClone([...workers[1]!.request!.nodes]), edges: structuredClone(edges) });
    expect(view.result.current.geometry).toBe(refined);
    expect(workers).toHaveLength(2);
    view.unmount();
  });

  it("suspends jobs while a gesture owns the routes and releases them on unmount", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const view = renderHook(({ enabled }) => useCanvasRouting(edges, nodes, { enabled }), { initialProps: { enabled: false } });
    expect(workers).toHaveLength(0);
    view.rerender({ enabled: true });
    expect(workers).toHaveLength(1);
    view.rerender({ enabled: false });
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    view.rerender({ enabled: true });
    expect(workers).toHaveLength(2);
    view.unmount();
    expect(workers[1]!.terminate).toHaveBeenCalledTimes(1);
  });
});
