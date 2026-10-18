import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from "./canvas-layout";
import type { CanvasBounds, CanvasNode, CanvasPoint, CanvasSize, CanvasViewport } from "./canvas-model";
import { canvasNodeSize } from "./canvas-model";

export const CANVAS_FIT_PADDING = 48;
export const CANVAS_ROUTE_PADDING = 24;
export const CANVAS_FIT_MAX_ZOOM = 1.08;
export const COMPACT_CANVAS_FIT_PADDING = 18;
export const COMPACT_CANVAS_ROUTE_PADDING = 12;
export const COMPACT_CANVAS_FIT_MAX_ZOOM = 1.2;

export interface FitCanvasViewportOptions {
  padding?: number;
  boundsPadding?: number;
  minZoom?: number;
  maxZoom?: number;
}

export interface CanvasNodeMeasurement extends Pick<CanvasNode, "x" | "y"> {
  width?: number;
  height?: number;
}

export interface CanvasContentBoundsOptions {
  /** Ignore decorative/failed-route samples implausibly far from all cards. */
  routeOutlierMargin?: number;
}

/** Bounds for all cards plus optional sampled edge-route points. */
export function canvasContentBounds(
  nodes: readonly CanvasNodeMeasurement[],
  routePoints: readonly CanvasPoint[] = [],
  options: CanvasContentBoundsOptions = {}
): CanvasBounds | undefined {
  if (!nodes.length && !routePoints.length) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const { width: nodeWidth, height: nodeHeight } = canvasNodeSize(node);
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + nodeWidth);
    maxY = Math.max(maxY, node.y + nodeHeight);
  }
  const hasNodeBounds = [minX, minY, maxX, maxY].every(Number.isFinite);
  const nodeBounds = hasNodeBounds ? { minX, minY, maxX, maxY } : undefined;
  const routeOutlierMargin = finiteNonNegative(options.routeOutlierMargin, 420);
  for (const point of routePoints) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (nodeBounds && (
      point.x < nodeBounds.minX - routeOutlierMargin
      || point.x > nodeBounds.maxX + routeOutlierMargin
      || point.y < nodeBounds.minY - routeOutlierMargin
      || point.y > nodeBounds.maxY + routeOutlierMargin
    )) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return [minX, minY, maxX, maxY].every(Number.isFinite)
    ? { minX, minY, maxX, maxY }
    : undefined;
}

/**
 * Center complete graph bounds in a screen-sized viewport. Defaults match the
 * reference canvas' "fit viewport" command (48px inset and 1.08 zoom cap).
 */
export function fitCanvasViewport(
  viewportSize: CanvasSize,
  contentBounds: CanvasBounds | undefined,
  options: FitCanvasViewportOptions = {}
): CanvasViewport {
  if (!contentBounds) return { x: 0, y: 0, zoom: 1 };
  const padding = finiteNonNegative(options.padding, CANVAS_FIT_PADDING);
  const boundsPadding = finiteNonNegative(options.boundsPadding, CANVAS_ROUTE_PADDING);
  const minZoom = finitePositive(options.minZoom, MIN_CANVAS_ZOOM);
  const maxZoom = Math.max(minZoom, finitePositive(options.maxZoom, CANVAS_FIT_MAX_ZOOM));
  const width = finitePositive(viewportSize.width, 1);
  const height = finitePositive(viewportSize.height, 1);
  const minX = contentBounds.minX - boundsPadding;
  const minY = contentBounds.minY - boundsPadding;
  const graphWidth = Math.max(1, contentBounds.maxX - contentBounds.minX + boundsPadding * 2);
  const graphHeight = Math.max(1, contentBounds.maxY - contentBounds.minY + boundsPadding * 2);
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const zoom = clamp(
    Math.min(maxZoom, availableWidth / graphWidth, availableHeight / graphHeight),
    minZoom,
    Math.min(maxZoom, MAX_CANVAS_ZOOM)
  );
  return {
    x: Math.round((width - graphWidth * zoom) / 2 - minX * zoom),
    y: Math.round((height - graphHeight * zoom) / 2 - minY * zoom),
    zoom
  };
}

/** Fit used by thumbnails/previews; it is intentionally not persisted. */
export function fitCompactCanvasViewport(
  viewportSize: CanvasSize,
  contentBounds: CanvasBounds | undefined
): CanvasViewport {
  return fitCanvasViewport(viewportSize, contentBounds, {
    padding: COMPACT_CANVAS_FIT_PADDING,
    boundsPadding: COMPACT_CANVAS_ROUTE_PADDING,
    minZoom: .12,
    maxZoom: COMPACT_CANVAS_FIT_MAX_ZOOM
  });
}

export function canvasToScreen(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}

export function screenToCanvas(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  const zoom = clamp(viewport.zoom, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
  return { x: (point.x - viewport.x) / zoom, y: (point.y - viewport.y) / zoom };
}

export function zoomCanvasViewportAt(
  viewport: CanvasViewport,
  screenAnchor: CanvasPoint,
  nextZoom: number
): CanvasViewport {
  const worldAnchor = screenToCanvas(screenAnchor, viewport);
  const zoom = clamp(nextZoom, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
  return {
    x: screenAnchor.x - worldAnchor.x * zoom,
    y: screenAnchor.y - worldAnchor.y * zoom,
    zoom
  };
}

export function panCanvasViewport(
  viewport: CanvasViewport,
  delta: CanvasPoint
): CanvasViewport {
  return {
    x: viewport.x + (Number.isFinite(delta.x) ? delta.x : 0),
    y: viewport.y + (Number.isFinite(delta.y) ? delta.y : 0),
    zoom: clamp(viewport.zoom, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM)
  };
}

export function clampCanvasZoom(zoom: number): number {
  return clamp(finitePositive(zoom, 1), MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
