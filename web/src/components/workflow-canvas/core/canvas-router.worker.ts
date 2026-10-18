import { routeCanvasEdges } from "./canvas-router";
import type { CanvasRoutingRequest, CanvasRoutingResponse } from "./canvas-routing-service";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<CanvasRoutingRequest>) => void;
  postMessage: (response: CanvasRoutingResponse) => void;
};
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ geometry: routeCanvasEdges(data.edges, data.nodes, data.options) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
