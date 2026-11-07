// Course data: loading, terrain heights, lies and yardage helpers.
// Coordinates are local meters: x = east, y = north, from the course center.

export type XY = [number, number];
export type Kind = 'fairway' | 'green' | 'bunker' | 'tee' | 'rough' | 'water' | 'wood' | 'range' | 'building';
export type Lie = 'tee' | 'fairway' | 'rough' | 'sand' | 'recovery' | 'green' | 'water' | 'ob';

export interface Feature {
  id: string;
  kind: Kind;
  rings: XY[][];
  holes: XY[][];
  ref?: string;
  bbox?: [number, number, number, number];
}

export interface TeeBox { id: string; center: XY; lengthYds: number }

export interface Hole {
  ref: number;
  par: number;
  handicap: number | null;
  line: XY[];
  lengthYds: number;
  tees: TeeBox[];
  greenId: string | null;
  pin: XY;
}

export interface CourseData {
  name: string;
  fetched: string;
  source: string;
  origin: { lat: number; lon: number };
  metersPerDeg: { x: number; y: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  terrain: { file: string; cols: number; rows: number; cell: number; minX: number; minY: number; minH: number; maxH: number; scale: number };
  boundary: XY[][];
  holes: Hole[];
  features: Feature[];
  paths: XY[][];
  trees: XY[];
}

export const YD = 0.9144;
export const toYds = (m: number) => m / YD;
export const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Compass bearing in degrees (0 = north, 90 = east) from a to b. */
export const bearing = (a: XY, b: XY) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
export const fromBearing = (p: XY, deg: number, m: number): XY => {
  const r = (deg * Math.PI) / 180;
  return [p[0] + Math.sin(r) * m, p[1] + Math.cos(r) * m];
};

export function pointInRing(p: XY, ring: XY[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function pointInFeature(p: XY, f: Feature): boolean {
  const b = f.bbox!;
  if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) return false;
  return f.rings.some((r) => pointInRing(p, r)) && !f.holes.some((r) => pointInRing(p, r));
}

export function ringCentroid(ring: XY[]): XY {
  // area-weighted centroid
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

const LIE_PRIORITY: Record<string, number> = { water: 0, bunker: 1, green: 2, tee: 3, fairway: 4, wood: 5, building: 6, rough: 7, range: 8 };

export class Course {
  data: CourseData;
  heights: Float32Array;
  features: Feature[];
  private byId = new Map<string, Feature>();
  private boundary: Feature;

  constructor(data: CourseData, raw: Uint16Array) {
    this.data = data;
    const t = data.terrain;
    this.heights = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.heights[i] = raw[i] * t.scale; // height above minH
    this.features = data.features
      .map((f) => ({ ...f, holes: f.holes ?? [], bbox: bboxOf(f.rings) }))
      .sort((a, b) => (LIE_PRIORITY[a.kind] ?? 9) - (LIE_PRIORITY[b.kind] ?? 9));
    for (const f of this.features) this.byId.set(f.id, f);
    this.boundary = { id: 'boundary', kind: 'rough', rings: data.boundary, holes: [], bbox: bboxOf(data.boundary) };
  }

  static async load(base = './data/'): Promise<Course> {
    const data: CourseData = await (await fetch(base + 'course.json')).json();
    const buf = await (await fetch(base + data.terrain.file)).arrayBuffer();
    return new Course(data, new Uint16Array(buf));
  }

  get holes() { return this.data.holes; }
  hole(ref: number) { return this.data.holes.find((h) => h.ref === ref)!; }
  feature(id: string | null) { return id ? this.byId.get(id) : undefined; }

  /** Ground height (meters above the course's lowest point), bilinear. */
  height(x: number, y: number): number {
    const t = this.data.terrain;
    let gx = (x - t.minX) / t.cell, gy = (y - t.minY) / t.cell;
    gx = Math.max(0, Math.min(t.cols - 1.001, gx));
    gy = Math.max(0, Math.min(t.rows - 1.001, gy));
    const c = Math.floor(gx), r = Math.floor(gy), fx = gx - c, fy = gy - r;
    const i = r * t.cols + c, H = this.heights;
    return (H[i] * (1 - fx) + H[i + 1] * fx) * (1 - fy) + (H[i + t.cols] * (1 - fx) + H[i + t.cols + 1] * fx) * fy;
  }

  kindAt(p: XY): Kind | 'ob' {
    if (!pointInFeature(p, this.boundary)) return 'ob';
    for (const f of this.features) if (f.kind !== 'range' && pointInFeature(p, f)) return f.kind;
    return 'rough';
  }

  /** Lie for strokes-gained purposes. `green` only counts as green for this hole's green. */
  lieAt(p: XY, hole?: Hole): Lie {
    const k = this.kindAt(p);
    switch (k) {
      case 'ob': return 'ob';
      case 'water': return 'water';
      case 'bunker': return 'sand';
      case 'wood': case 'building': return 'recovery';
      case 'fairway': case 'tee': return 'fairway';
      case 'green': {
        const g = hole && this.feature(hole.greenId);
        return !g || pointInFeature(p, g) ? 'green' : 'fairway';
      }
      default: return 'rough';
    }
  }

  greenOf(hole: Hole) { return this.feature(hole.greenId); }

  /** Distances (m) from a point to the front, center and back of the green along the line to the pin. */
  greenDistances(hole: Hole, from: XY, pin: XY = hole.pin) {
    const g = this.greenOf(hole);
    const toPin = dist(from, pin);
    if (!g) return { front: toPin - 12, center: toPin, back: toPin + 12, pin: toPin };
    const dir: XY = [(pin[0] - from[0]) / toPin, (pin[1] - from[1]) / toPin];
    const ts: number[] = [];
    for (const ring of g.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const t = raySegment(from, dir, ring[j], ring[i]);
        if (t !== null) ts.push(t);
      }
    }
    const center = dist(from, ringCentroid(g.rings[0]));
    if (ts.length < 2) return { front: toPin - 10, center, back: toPin + 10, pin: toPin };
    return { front: Math.min(...ts), center, back: Math.max(...ts), pin: toPin };
  }

  /** Bunkers and water near the line from `from` to the pin, with reach/carry distances. */
  hazards(hole: Hole, from: XY, pin: XY = hole.pin) {
    const toPin = dist(from, pin);
    const brg = bearing(from, pin);
    const out: { id: string; kind: Kind; side: 'left' | 'right' | 'center'; reach: number; carry: number; offset: number }[] = [];
    for (const f of this.features) {
      if (f.kind !== 'bunker' && f.kind !== 'water') continue;
      if (f.id === hole.greenId) continue;
      let reach = Infinity, carry = -Infinity, minOff = Infinity, offSum = 0, n = 0, alongMin = Infinity;
      for (const ring of f.rings) for (const p of ring) {
        const d = dist(from, p);
        const rel = ((bearing(from, p) - brg + 540) % 360) - 180;
        const along = d * Math.cos((rel * Math.PI) / 180);
        const off = d * Math.sin((rel * Math.PI) / 180);
        reach = Math.min(reach, d); carry = Math.max(carry, d);
        minOff = Math.min(minOff, Math.abs(off)); offSum += off; n++;
        alongMin = Math.min(alongMin, along);
      }
      // Only hazards ahead, within play, and not far past the pin.
      if (alongMin < 5 || reach > toPin + 25 || minOff > 45) continue;
      const mean = offSum / n;
      out.push({ id: f.id, kind: f.kind, side: Math.abs(mean) < 8 ? 'center' : mean < 0 ? 'left' : 'right', reach, carry, offset: mean });
    }
    return out.sort((a, b) => a.reach - b.reach);
  }

  /** Point along the hole's center line `m` meters from its start (clamped to the end). */
  alongLine(hole: Hole, start: XY, m: number): XY {
    const pts = [start, ...hole.line.slice(1)];
    let left = m;
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1], pts[i]);
      if (left <= seg) {
        const f = left / seg;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      }
      left -= seg;
    }
    return pts[pts.length - 1];
  }

  // ---- GPS ----
  toXY(lat: number, lon: number): XY {
    const { origin, metersPerDeg } = this.data;
    return [(lon - origin.lon) * metersPerDeg.x, (lat - origin.lat) * metersPerDeg.y];
  }
  toLatLon(p: XY) {
    const { origin, metersPerDeg } = this.data;
    return { lat: origin.lat + p[1] / metersPerDeg.y, lon: origin.lon + p[0] / metersPerDeg.x };
  }
}

function bboxOf(rings: XY[][]): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const p of r) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
  return [a, b, c, d];
}

function raySegment(o: XY, d: XY, a: XY, b: XY): number | null {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
  const u = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : null;
}

/** Default tee for a set: back = longest, forward = shortest, middle = median. */
export function teeFor(hole: Hole, set: 'back' | 'middle' | 'forward'): TeeBox {
  const t = hole.tees;
  if (set === 'back') return t[0];
  if (set === 'forward') return t[t.length - 1];
  return t[Math.floor((t.length - 1) / 2)];
}
