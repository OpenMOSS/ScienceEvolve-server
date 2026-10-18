import type { CanvasPoint } from "./canvas-model";

export interface CanvasSegment { a: CanvasPoint; b: CanvasPoint; }

/** Exact point-to-segment proximity queries for candidate curve scoring.
 * The radius is fixed by the renderer. Index expanded segment bounds once,
 * rather than scanning every reserved lane for every sample of every curve. */
export class CanvasProximityIndex {
  private readonly cells = new Map<string, CanvasSegment[]>();
  private readonly broad: CanvasSegment[] = [];
  constructor(segments: readonly CanvasSegment[], private readonly radius = 12) {
    for (const segment of segments) {
      const left = Math.floor((Math.min(segment.a.x, segment.b.x) - radius) / 128);
      const right = Math.floor((Math.max(segment.a.x, segment.b.x) + radius) / 128);
      const top = Math.floor((Math.min(segment.a.y, segment.b.y) - radius) / 128);
      const bottom = Math.floor((Math.max(segment.a.y, segment.b.y) + radius) / 128);
      const width = right - left + 1, height = bottom - top + 1;
      if (![left, right, top, bottom].every(Number.isSafeInteger) || width * height > 4096) {
        this.broad.push(segment); continue;
      }
      for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
        const key = `${x},${y}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(segment); else this.cells.set(key, [segment]);
      }
    }
  }

  penalty(samples: readonly CanvasPoint[], limit = Infinity): number {
    let score = 0;
    for (let index = 3; index < samples.length - 3; index++) {
      const sample = samples[index]!;
      const nearby = this.cells.get(`${Math.floor(sample.x / 128)},${Math.floor(sample.y / 128)}`);
      for (const candidates of [nearby, this.broad]) {
        if (!candidates) continue;
        for (const { a, b } of candidates) {
          if (sample.x < Math.min(a.x, b.x) - this.radius || sample.x > Math.max(a.x, b.x) + this.radius
            || sample.y < Math.min(a.y, b.y) - this.radius || sample.y > Math.max(a.y, b.y) + this.radius) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const length = dx * dx + dy * dy;
          const t = length >= .0001 ? Math.max(0, Math.min(1, ((sample.x - a.x) * dx + (sample.y - a.y) * dy) / length)) : 0;
          if (Math.hypot(sample.x - (a.x + t * dx), sample.y - (a.y + t * dy)) < this.radius) {
            score += 18;
            if (score >= limit) return limit;
          }
        }
      }
    }
    return Math.min(score, limit);
  }
}

interface Intervals { starts: number[]; ends: number[]; }
type Lanes = Map<number, Map<number, Intervals>>;

/** Exact overlap counts for the router's reserved planning segments. Nearby
 * parallel lanes conflict when they are less than eight pixels apart; their
 * closed intervals must overlap. Index each axis and count interval endpoints
 * so shared lanes do not require scanning every previously routed edge. */
export class CanvasSegmentIndex {
  private readonly horizontal: Lanes = new Map();
  private readonly vertical: Lanes = new Map();

  constructor(segments: readonly CanvasSegment[] = []) {
    this.add(segments);
  }

  add(segments: readonly CanvasSegment[]): void {
    for (const { a, b } of segments) {
      const horizontal = Math.abs(a.y - b.y) < .5;
      const coordinate = horizontal ? a.y : a.x;
      if (!Number.isFinite(coordinate)) continue;
      const axis = horizontal ? this.horizontal : this.vertical;
      const bucket = Math.floor(coordinate / 8);
      let lanes = axis.get(bucket);
      if (!lanes) { lanes = new Map(); axis.set(bucket, lanes); }
      let intervals = lanes.get(coordinate);
      if (!intervals) { intervals = { starts: [], ends: [] }; lanes.set(coordinate, intervals); }
      const start = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
      const end = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
      intervals.starts.splice(lowerBound(intervals.starts, start), 0, start);
      intervals.ends.splice(lowerBound(intervals.ends, end), 0, end);
    }
  }

  count({ a, b }: CanvasSegment): number {
    const horizontal = Math.abs(a.y - b.y) < .5;
    const coordinate = horizontal ? a.y : a.x;
    if (!Number.isFinite(coordinate)) return 0;
    const axis = horizontal ? this.horizontal : this.vertical;
    const bucket = Math.floor(coordinate / 8);
    const start = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
    const end = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
    let count = 0;
    let previous: number | undefined;
    for (let offset = -1; offset <= 1; offset += 1) {
      const nearby = bucket + offset;
      // Large finite coordinates can round neighbouring buckets to the same
      // number. Visit each once and keep the loop bounded at three lookups.
      if (nearby === previous) continue;
      previous = nearby;
      const lanes = axis.get(nearby);
      if (!lanes) continue;
      for (const [position, intervals] of lanes) {
        if (Math.abs(coordinate - position) >= 8) continue;
        count += upperBound(intervals.starts, end) - lowerBound(intervals.ends, start);
      }
    }
    return count;
  }
}

function lowerBound(values: readonly number[], value: number): number {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: readonly number[], value: number): number {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}
