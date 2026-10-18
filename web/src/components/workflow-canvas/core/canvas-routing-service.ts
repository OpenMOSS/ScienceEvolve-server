import { canvasNodeSize, type CanvasEdge, type CanvasNode } from "./canvas-model";
import { canvasRouteTopologyKey, previewCanvasEdges, routeCanvasEdgesInSteps, type CanvasRouteOptions, type EdgeGeometry } from "./canvas-router";

export interface CanvasRoutingRequest {
  edges: readonly CanvasEdge[];
  nodes: readonly CanvasNode[];
  options?: CanvasRouteOptions;
}
export type CanvasRoutingResponse = { geometry: EdgeGeometry[] } | { error: string };

export function canvasRoutingKey({ edges, nodes, options }: CanvasRoutingRequest): string {
  return JSON.stringify([
    canvasRouteTopologyKey(edges), edges.filter((edge) => edge.fixed).map((edge) => edge.id).sort(),
    // Dispatch fan-out uses node order. Keep it in the key, along with the
    // effective card size, but exclude labels, models and runtime state.
    nodes.map((node) => [node.id, node.x, node.y, canvasNodeSize(node).width, canvasNodeSize(node).height]),
    options?.lockRoutes ?? false, options?.fastEvaluation ?? false, options?.smoothFallback ?? false
  ]);
}

export function needsBackgroundRouting(edges: readonly CanvasEdge[], nodes: readonly CanvasNode[]): boolean {
  return edges.length >= 20 || edges.length * nodes.length >= 200;
}

interface RoutingWorker {
  onmessage: ((event: MessageEvent<CanvasRoutingResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: CanvasRoutingRequest): void;
  terminate(): void;
}
type Listener = (geometry: EdgeGeometry[]) => void;
type Job = {
  key: string;
  request: CanvasRoutingRequest;
  listeners: Set<Listener>;
  worker?: RoutingWorker;
  timer?: ReturnType<typeof setTimeout>;
};

/** One bounded queue shared by preview, editor and dialog. Identical frames
 * share a job; superseded frames are cancelled instead of accumulating CPU
 * work behind the current pointer position. No workflow data is sent away. */
export class CanvasRoutingService {
  private jobs = new Map<string, Job>();
  private cache = new Map<string, EdgeGeometry[]>();
  private active?: Job;

  constructor(private createWorker: () => RoutingWorker | undefined) {}

  peek(key: string): EdgeGeometry[] | undefined { return this.cache.get(key); }

  subscribe(key: string, request: CanvasRoutingRequest, listener: Listener): () => void {
    const cached = this.cache.get(key);
    if (cached) { listener(cached); return () => {}; }
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, request, listeners: new Set() };
      this.jobs.set(key, job);
    }
    job.listeners.add(listener);
    this.pump();
    return () => {
      job.listeners.delete(listener);
      if (job.listeners.size || this.jobs.get(key) !== job) return;
      this.stop(job);
      this.jobs.delete(key);
      if (this.active === job) this.active = undefined;
      this.pump();
    };
  }

  private stop(job: Job) {
    if (job.worker) {
      job.worker.onmessage = null;
      job.worker.onerror = null;
      job.worker.terminate();
      job.worker = undefined;
    }
    if (job.timer !== undefined) clearTimeout(job.timer);
  }

  private finish(job: Job, geometry: EdgeGeometry[]) {
    if (this.active !== job || !job.listeners.size) return;
    this.stop(job);
    this.cache.set(job.key, geometry);
    // Bound retained frames and samples, not just the number of entries.
    let edgeCount = [...this.cache.values()].reduce((count, frame) => count + frame.length, 0);
    while (this.cache.size > 8 || (edgeCount > 2000 && this.cache.size > 1)) {
      const oldest = this.cache.keys().next().value!;
      edgeCount -= this.cache.get(oldest)!.length;
      this.cache.delete(oldest);
    }
    this.jobs.delete(job.key);
    this.active = undefined;
    for (const listener of job.listeners) listener(geometry);
    job.listeners.clear();
    this.pump();
  }

  private cooperative(job: Job) {
    this.stop(job);
    const iterator = routeCanvasEdgesInSteps(job.request.edges, job.request.nodes, job.request.options);
    const geometry: EdgeGeometry[] = [];
    const step = () => {
      if (this.active !== job || !job.listeners.size) return;
      try {
        const next = iterator.next();
        if (next.done) { this.finish(job, geometry); return; }
        geometry.push(next.value);
        job.timer = setTimeout(step, 0);
      } catch {
        // A malformed legacy layout must still be viewable/editable. Keep
        // the complete preview rather than a partial graph or a stuck job.
        this.finish(job, previewCanvasEdges(job.request.edges, job.request.nodes));
      }
    };
    job.timer = setTimeout(step, 0);
  }

  private pump() {
    if (this.active) return;
    const job = this.jobs.values().next().value as Job | undefined;
    if (!job) return;
    this.active = job;
    try {
      const worker = this.createWorker();
      if (!worker) { this.cooperative(job); return; }
      job.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.active !== job) return;
        if ("error" in data) this.cooperative(job);
        else this.finish(job, data.geometry);
      };
      worker.onerror = (event) => { event.preventDefault(); if (this.active === job) this.cooperative(job); };
      // Strip unrelated project configuration from the structured clone.
      worker.postMessage({ ...job.request, nodes: job.request.nodes.map((node) => ({
        id: node.id, name: node.id, kind: node.kind, x: node.x, y: node.y, ...canvasNodeSize(node)
      })) });
    } catch { this.cooperative(job); }
  }
}

export const canvasRoutingService = new CanvasRoutingService(() => typeof Worker === "undefined" ? undefined
  : new Worker(new URL("./canvas-router.worker.ts", import.meta.url), { type: "module" }));
