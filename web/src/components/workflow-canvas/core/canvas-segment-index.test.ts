import { describe, expect, it } from "vitest";
import { CanvasProximityIndex, CanvasSegmentIndex, type CanvasSegment } from "./canvas-segment-index";
import type { CanvasPoint } from "./canvas-model";

const horizontal = (x1: number, x2: number, y: number): CanvasSegment => ({ a: { x: x1, y }, b: { x: x2, y } });
const vertical = (y1: number, y2: number, x: number): CanvasSegment => ({ a: { x, y: y1 }, b: { x, y: y2 } });

function exhaustivePenalty(samples: CanvasPoint[], segments: CanvasSegment[], limit: number): number {
  let score = 0;
  for (const p of samples.slice(3, -3)) for (const { a, b } of segments) {
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length < .0001 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
    if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) < 12) score += 18;
  }
  return Math.min(score, limit);
}

describe("CanvasProximityIndex", () => {
  it("matches full curve scoring across cells, duplicate lanes, short and diagonal segments", () => {
    let seed = 126;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    const segments: CanvasSegment[] = [horizontal(-256, 256, 0), horizontal(-256, 256, 0),
      vertical(-256, 256, -128), { a: { x: 0, y: 0 }, b: { x: .001, y: .001 } },
      horizontal(-1e20, 1e20, 12), horizontal(1e20, 1e20, 1e20),
      ...Array.from({ length: 400 }, () => ({ a: { x: random() * 800 - 400, y: random() * 800 - 400 },
        b: { x: random() * 800 - 400, y: random() * 800 - 400 } }))];
    const index = new CanvasProximityIndex(segments);
    for (let trial = 0; trial < 30; trial++) {
      const samples = [{ x: -128, y: 11.999 }, { x: 128, y: 12 }, { x: 1e20, y: 1e20 },
        ...Array.from({ length: 40 }, () => ({ x: random() * 1000 - 500, y: random() * 1000 - 500 })),
        { x: -128, y: -12 }, { x: 0, y: 0 }, { x: 128, y: -11.999 }];
      for (const limit of [120, Infinity]) expect(index.penalty(samples, limit)).toBe(exhaustivePenalty(samples, segments, limit));
    }
  });
});

function exhaustiveCount(query: CanvasSegment, segments: CanvasSegment[]): number {
  const horizontal = Math.abs(query.a.y - query.b.y) < .5;
  return segments.filter((segment) => {
    if ((Math.abs(segment.a.y - segment.b.y) < .5) !== horizontal) return false;
    const cross = horizontal ? "y" : "x", along = horizontal ? "x" : "y";
    if (Math.abs(query.a[cross] - segment.a[cross]) >= 8) return false;
    return Math.max(Math.min(query.a[along], query.b[along]), Math.min(segment.a[along], segment.b[along]))
      <= Math.min(Math.max(query.a[along], query.b[along]), Math.max(segment.a[along], segment.b[along]));
  }).length;
}

describe("CanvasSegmentIndex", () => {
  it("counts touching, reversed and repeated intervals across negative lane boundaries", () => {
    const index = new CanvasSegmentIndex([
      horizontal(0, 10, -8), horizontal(20, 10, -8), horizontal(20, 10, -8),
      horizontal(0, 20, -.25), horizontal(0, 20, 0), vertical(-20, 20, 10)
    ]);
    expect(index.count(horizontal(10, 10, -8))).toBe(4);
    expect(index.count(horizontal(0, 20, -16))).toBe(0);
    expect(index.count(horizontal(0, 20, -15.99))).toBe(3);
    expect(index.count(vertical(20, 30, 17.99))).toBe(1);
    expect(index.count(vertical(20, 30, 18))).toBe(0);
    index.add([horizontal(10, 20, -8)]);
    expect(index.count(horizontal(10, 10, -8))).toBe(5);
    const distant = new CanvasSegmentIndex([horizontal(0, 10, 1e20)]);
    expect(distant.count(horizontal(5, 15, 1e20))).toBe(1);
  });

  it("matches exhaustive scoring during incremental routing with fractional and diagonal segments", () => {
    let seed = 1777;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    const segment = (): CanvasSegment => {
      const x = Math.round((random() - .5) * 300), y = Math.round((random() - .5) * 300);
      const length = Math.round((random() - .5) * 200);
      if (random() < .5) return { a: { x, y }, b: { x: x + length, y: y + random() * .6 } };
      return { a: { x, y }, b: { x: x + random() * .6, y: y + length } };
    };
    const index = new CanvasSegmentIndex(), reserved: CanvasSegment[] = [];
    for (let batch = 0; batch < 25; batch += 1) {
      const added = Array.from({ length: 80 }, segment);
      index.add(added); reserved.push(...added);
      for (let query = 0; query < 50; query += 1) {
        const value = segment();
        expect(index.count(value)).toBe(exhaustiveCount(value, reserved));
      }
    }
  });

  it("queries shared lanes without reading every reserved segment again", () => {
    let reads = 0;
    const reserved = Array.from({ length: 10000 }, (_, index) => ({
      get a() { reads += 1; return { x: 0, y: index % 2 ? -8 : 0 }; },
      get b() { reads += 1; return { x: 100, y: index % 2 ? -8 : 0 }; }
    }));
    const index = new CanvasSegmentIndex(reserved);
    reads = 0;
    for (let query = 0; query < 100; query += 1) expect(index.count(horizontal(20, 80, -4))).toBe(10000);
    expect(reads).toBe(0);
  });
});
