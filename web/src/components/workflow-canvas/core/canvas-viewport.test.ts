import { describe, expect, it } from "vitest";
import {
  canvasContentBounds,
  canvasToScreen,
  fitCanvasViewport,
  fitCompactCanvasViewport,
  panCanvasViewport,
  screenToCanvas,
  zoomCanvasViewportAt
} from "./canvas-viewport";

describe("canvas viewport", () => {
  it("fits and centers node and route bounds with reference padding", () => {
    const bounds = canvasContentBounds(
      [{ x: 20, y: 100 }, { x: 500, y: 400 }],
      [{ x: 380, y: 40 }, { x: 740, y: 300 }]
    );
    expect(bounds).toEqual({ minX: 20, minY: 40, maxX: 740, maxY: 492 });

    const viewport = fitCanvasViewport({ width: 1000, height: 700 }, bounds);
    expect(viewport.zoom).toBe(1.08);
    expect(viewport.x).toBe(90);
    expect(viewport.y).toBe(63);
  });

  it("uses measured card sizes for the shared full and compact fit", () => {
    const bounds = canvasContentBounds([
      { x: 10, y: 20, width: 168, height: 92 },
      { x: 400, y: 200, width: 240, height: 116 }
    ]);
    expect(bounds).toEqual({ minX: 10, minY: 20, maxX: 640, maxY: 316 });

    const full = fitCanvasViewport({ width: 900, height: 600 }, bounds);
    const compact = fitCanvasViewport({ width: 360, height: 220 }, bounds);
    expect(full.zoom).toBe(1.08);
    expect(compact.zoom).toBeLessThan(full.zoom);
  });

  it("keeps compact thumbnails readable without changing world coordinates", () => {
    const bounds = canvasContentBounds([{ x: 120, y: 180, width: 194, height: 92 }], [
      { x: 314, y: 226 },
      { x: 420, y: 226 }
    ]);
    const compact = fitCompactCanvasViewport({ width: 390, height: 180 }, bounds);
    expect(compact.zoom).toBeGreaterThanOrEqual(.12);
    expect(compact.zoom).toBeLessThanOrEqual(1.2);
    expect(canvasContentBounds([{ x: 120, y: 180, width: 194, height: 92 }], [
      { x: 314, y: 226 },
      { x: 420, y: 226 }
    ])).toEqual(bounds);
  });

  it("caps large compositions at the reference minimum zoom", () => {
    const viewport = fitCanvasViewport(
      { width: 320, height: 240 },
      { minX: 0, minY: 0, maxX: 100_000, maxY: 80_000 }
    );
    expect(viewport.zoom).toBe(0.08);
  });

  it("ignores an implausible route outlier without clipping legitimate curves", () => {
    const nodes = [{ x: 100, y: 100, width: 200, height: 100 }];
    const bounds = canvasContentBounds(nodes, [
      { x: 60, y: 80 },
      { x: 430, y: 240 },
      { x: 20_000, y: -30_000 }
    ]);

    expect(bounds).toEqual({ minX: 60, minY: 80, maxX: 430, maxY: 240 });
  });

  it("round-trips coordinates and holds a screen anchor while zooming", () => {
    const viewport = { x: 12, y: -8, zoom: 0.75 };
    const world = { x: 240, y: 160 };
    expect(screenToCanvas(canvasToScreen(world, viewport), viewport)).toEqual(world);

    const anchor = { x: 300, y: 220 };
    const anchoredWorld = screenToCanvas(anchor, viewport);
    const next = zoomCanvasViewportAt(viewport, anchor, 1.5);
    expect(canvasToScreen(anchoredWorld, next)).toEqual(anchor);
    expect(panCanvasViewport(next, { x: 8, y: -3 })).toEqual({ ...next, x: next.x + 8, y: next.y - 3 });
  });
});
