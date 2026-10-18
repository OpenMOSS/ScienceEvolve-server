import { useEffect, useMemo, useState } from "react";
import type { CanvasEdge, CanvasNode } from "./core/canvas-model";
import { previewCanvasEdges, routeCanvasEdges, type CanvasRouteOptions, type EdgeGeometry } from "./core/canvas-router";
import { canvasRoutingKey, canvasRoutingService, needsBackgroundRouting } from "./core/canvas-routing-service";

/** Geometry identity deliberately ignores object identity: runtime snapshots
 * and configuration edits commonly clone the same graph without moving it. */
export function useCanvasRouting(
  edges: readonly CanvasEdge[], nodes: readonly CanvasNode[],
  { enabled = true, ...options }: CanvasRouteOptions & { enabled?: boolean } = {}
): { geometry: EdgeGeometry[]; pending: boolean } {
  const key = canvasRoutingKey({ edges, nodes, options });
  const background = needsBackgroundRouting(edges, nodes);
  const [completed, setCompleted] = useState<{ key: string; geometry: EdgeGeometry[] }>();
  const cached = canvasRoutingService.peek(key);
  const resolved = cached ?? (completed?.key === key ? completed.geometry : undefined);
  const initial = useMemo(() => !enabled || resolved ? [] : background
    ? previewCanvasEdges(edges, nodes)
    : routeCanvasEdges(edges, nodes, options), [key, enabled, background, resolved]);

  useEffect(() => {
    if (!enabled || !background || resolved) return;
    let current = true;
    const cancel = canvasRoutingService.subscribe(key, { edges, nodes, options }, (geometry) => {
      if (current) setCompleted({ key, geometry });
    });
    return () => { current = false; cancel(); };
  }, [key, enabled, background, resolved]);
  return { geometry: resolved ?? initial, pending: enabled && background && !resolved };
}
