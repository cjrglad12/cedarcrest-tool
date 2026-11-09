// Shot advice: simulate many shots for each club and aim point using your
// distance and left/right spread, then pick the one with the lowest expected score.
import { Course, Hole, XY, Lie, YD, TREE_M, dist, bearing, fromBearing, pointInFeature, toYds } from './course';
import { Conditions, carryFactor } from './conditions';
import { groundFactor } from './tips';
import { expected } from './sg';
import type { Club, PlanStep } from './store';

export interface Ctx {
  course: Course;
  hole: Hole;
  from: XY;
  lie: Lie; // 'tee' for the tee shot
  pin: XY;
  cond: Conditions;
  bag: Club[];
  handicap: number;
  leftHanded?: boolean;
  wet?: boolean; // soft ground: less roll
}

/**
 * How the slope under the ball changes a shot. Uphill lies fly higher and shorter,
 * downhill lower and longer. With the ball above your feet it tends to go left
 * (for a right-hander), below your feet to the right.
 */
export function lieEffect(ctx: Ctx, brg: number) {
  if (ctx.lie === 'tee' || ctx.lie === 'green') return { distance: 1, pullDeg: 0, spread: 1, slope: { along: 0, across: 0 } };
  const slope = ctx.course.lieSlope(ctx.from, brg);
  const up = Math.max(-12, Math.min(12, slope.along));
  const distance = 1 - (up > 0 ? 0.012 * up : 0.01 * up); // ~1% per degree
  // Ball above the feet (ground rising on the far side of the ball) pulls it toward the golfer's front side.
  const aboveFeet = ctx.leftHanded ? -slope.across : slope.across;
  const pullDeg = Math.max(-6, Math.min(6, aboveFeet * 0.45)) * (ctx.leftHanded ? 1 : -1);
  const spread = 1 + Math.min(0.4, (Math.abs(slope.along) + Math.abs(slope.across)) * 0.03);
  return { distance: Math.max(0.85, Math.min(1.12, distance)), pullDeg, spread, slope };
}

export interface Option {
  club: string;
  aim: XY; // average landing spot
  brg: number; // direction the shot is started on
  carryYds: number; // how far you'd hit it in these conditions
  expected: number; // expected strokes to hole out, including this shot
  pGreen: number;
  pFairway: number;
  pTrouble: number; // water, out of bounds, under trees
  pSand: number;
  pOther: number; // ends up on another hole
  leaveYds: number; // distance from aim point to pin
  swing: number; // 1 = full swing, less for a partial wedge
}

const LIE_DISTANCE: Record<Lie, number> = { tee: 1, fairway: 1, rough: 0.92, sand: 0.8, recovery: 0.55, green: 1, water: 1, ob: 1 };
const WOODS = new Set(['Driver', '3 Wood', '5 Wood', 'Hybrid']);
const WEDGES = new Set(['PW', 'GW', 'SW', 'LW', '9 Iron']);

// Deterministic random numbers so the same situation gives the same advice.
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
}
function gauss(r: () => number) {
  let u = 0; while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Expected strokes after the ball comes to rest at `p` (not counting the shot that got it there). */
export function outcome(ctx: Ctx, p: XY): { e: number; lie: Lie } {
  const { course, hole, pin, handicap, from, lie: startLie } = ctx;
  const lie = course.lieAt(p, hole);
  if (lie === 'ob') return { e: 1 + expected(toYds(dist(from, pin)), startLie, handicap), lie };
  if (lie === 'water') {
    // Drop near where it crossed into the hazard.
    const d = dist(from, p), brg = bearing(p, from);
    let drop = p;
    for (let m = 3; m < d; m += 3) {
      drop = fromBearing(p, brg, m);
      const l = course.lieAt(drop, hole);
      if (l !== 'water') break;
    }
    const dropLie = course.lieAt(drop, hole);
    const useLie: Lie = dropLie === 'water' || dropLie === 'ob' || dropLie === 'green' ? 'rough' : dropLie;
    return { e: 1 + expected(toYds(dist(drop, pin)), useLie, handicap), lie };
  }
  return { e: expected(toYds(dist(p, pin)), lie, handicap) + offHolePenalty(ctx, p), lie };
}

/**
 * Extra strokes for finishing away from the hole you're playing: on another hole's
 * fairway or green (blocked angles, waiting on other groups, safety), or far off
 * this hole's line of play.
 */
export function offHolePenalty(ctx: Ctx, p: XY): number {
  const { course, hole } = ctx;
  let pen = course.onOtherHole(p, hole) ? 0.3 : 0;
  const off = course.offLine(p, hole);
  if (off > 35) pen += Math.min(0.6, (off - 35) * 0.015);
  return pen;
}

/** Peak height (m) of a shot of this length; low punches from under trees. */
function apexFor(d: number, lie: Lie) {
  return lie === 'recovery' ? 5 : Math.max(8, Math.min(30, d * 0.13));
}

/**
 * Follow the ball's flight and return where it stops if a tree gets in the way
 * (it drops a few meters short, under the tree), or null if the path is clear.
 */
export function treeStop(ctx: Ctx, to: XY, apex: number): XY | null {
  const { course, from } = ctx;
  const d = dist(from, to);
  const h0 = course.height(from[0], from[1]), h1 = course.height(to[0], to[1]);
  const steps = Math.max(4, Math.ceil(d / 5));
  for (let i = 1; i < steps; i++) {
    const s = i / steps;
    if (s * d < 8) continue; // the first few meters: the ball starts under/around the player
    const q: XY = [from[0] + (to[0] - from[0]) * s, from[1] + (to[1] - from[1]) * s];
    const tree = course.treeAt(q[0], q[1]);
    if (tree < TREE_M) continue;
    const ball = h0 + (h1 - h0) * s + 4 * apex * s * (1 - s);
    if (ball < course.height(q[0], q[1]) + tree * 0.9) return [from[0] + (to[0] - from[0]) * Math.max(0, s - 2 / steps), from[1] + (to[1] - from[1]) * Math.max(0, s - 2 / steps)];
  }
  return null;
}

/**
 * Fairway woods and long hybrids off the ground (not a tee) are much harder for higher
 * handicaps: misses get wider and more of them come up short. Scratch players barely notice.
 */
export function offTheDeck(club: string, lie: Lie, handicap: number) {
  if (lie === 'tee') return 1;
  const wood = club.includes('Wood') ? 1 : club === 'Hybrid' ? 0.4 : 0;
  if (!wood) return 1;
  return 1 + wood * Math.max(0, handicap) * (lie === 'rough' ? 0.03 : 0.02);
}

/** Average carry-and-roll in meters for a shot on this bearing, after wind, temperature, lie and slope. */
export function meanDistance(ctx: Ctx, club: Club, brg: number, swing = 1): number {
  const { course, from, cond } = ctx;
  // Topped and thin fairway-wood shots cost higher handicaps distance on average, too.
  const deckLoss = 1 - (offTheDeck(club.name, ctx.lie, ctx.handicap) - 1) * 0.25;
  const base = club.yds * YD * swing * LIE_DISTANCE[ctx.lie] * carryFactor(cond, brg) * lieEffect(ctx, brg).distance * groundFactor(club.name, !!ctx.wet, cond) * deckLoss;
  const h0 = course.height(from[0], from[1]);
  let d = base;
  for (let k = 0; k < 3; k++) {
    const p = fromBearing(from, brg, d);
    d = Math.max(5, base - (course.height(p[0], p[1]) - h0));
  }
  return d;
}

/** Simulate shots hit on bearing `brg`. The option's `aim` is the average landing spot. */
export function evaluate(ctx: Ctx, club: Club, brg: number, swing = 1, n = 160): Option {
  const { course, hole, from, cond } = ctx;
  const meanM = meanDistance(ctx, club, brg, swing);
  const slopeFx = lieEffect(ctx, brg);
  const deck = offTheDeck(club.name, ctx.lie, ctx.handicap);
  const sdM = ((club.sdYds * YD * (swing < 1 ? 0.8 : 1)) / (ctx.lie === 'recovery' ? 0.7 : 1)) * deck;
  const sdDeg = club.sdDeg * (ctx.lie === 'recovery' ? 1.8 : ctx.lie === 'rough' ? 1.15 : 1) * slopeFx.spread * deck;
  // Crosswind drift: about 1% of the distance per mph; plus the pull from a sidehill lie.
  const rel = ((cond.windFrom - brg) * Math.PI) / 180;
  const cross = -cond.windMph * Math.sin(rel);
  const driftDeg = (Math.atan(cross * 0.01) * 180) / Math.PI + slopeFx.pullDeg;
  const r = rng(Math.round(brg * 1000 + club.yds * 31 + swing * 97 + from[0] * 7 + from[1] * 13));
  const green = course.greenOf(hole);
  const apex = apexFor(meanM, ctx.lie);
  let sum = 0, g = 0, fw = 0, tr = 0, sd = 0, other = 0;
  for (let i = 0; i < n; i++) {
    const d = meanM + gauss(r) * sdM;
    const a = brg + driftDeg + gauss(r) * sdDeg;
    let p = fromBearing(from, a, Math.max(1, d));
    const stop = treeStop(ctx, p, apex);
    if (stop) p = stop;
    const o = outcome(ctx, p);
    sum += o.e;
    if (course.onOtherHole(p, hole)) other++;
    if (o.lie === 'green' && green && pointInFeature(p, green)) g++;
    else if (o.lie === 'fairway' && !course.onOtherHole(p, hole)) fw++;
    else if (o.lie === 'water' || o.lie === 'ob' || o.lie === 'recovery') tr++;
    else if (o.lie === 'sand') sd++;
  }
  const aim = fromBearing(from, brg + driftDeg, meanM);
  return {
    club: club.name, aim, brg, carryYds: toYds(meanM), expected: 1 + sum / n,
    pGreen: g / n, pFairway: fw / n, pTrouble: tr / n, pSand: sd / n, pOther: other / n,
    leaveYds: toYds(dist(aim, ctx.pin)), swing,
  };
}

/** Candidate clubs, aims and (for wedges) partial swings. Returns options best-first. */
export function suggest(ctx: Ctx, limit = 5): Option[] {
  const { hole, from, pin, lie } = ctx;
  const toPin = dist(from, pin);
  const options: Option[] = [];
  const clubs = ctx.bag.filter((c) => c.on).filter((c) => {
    if (c.name === 'Driver' && lie !== 'tee') return false;
    if (lie === 'sand' && WOODS.has(c.name)) return false;
    return true;
  });
  const pinBrg = bearing(from, pin);
  for (const club of clubs) {
    const full = meanDistance(ctx, club, pinBrg);
    if (full > toPin * 1.25 + 15 && !WEDGES.has(club.name)) continue; // way too much club
    // Wedges can be hit softer to land at (or just short of) the pin.
    const swings = WEDGES.has(club.name) && full > toPin ? [toPin / full, (toPin * 0.92) / full].map((s) => Math.max(0.3, s)) : [1];
    for (const swing of swings) {
      const reach = Math.min(full * swing, toPin);
      // Aim along the hole's line at that distance, and straight at the pin.
      const bases = [bearing(from, pointOnLineAt(hole, from, reach)), pinBrg];
      const seen = new Set<number>();
      for (const base of bases) {
        for (let off = -15; off <= 15; off += 2.5) {
          const key = Math.round((base + off) * 2);
          if (seen.has(key)) continue;
          seen.add(key);
          options.push(evaluate(ctx, club, base + off, swing, 200));
        }
      }
    }
  }
  // Never pick a target that is itself under a tree or on another hole.
  const rank = (o: Option) => o.expected + (ctx.course.lieAt(o.aim, hole) === 'recovery' || ctx.course.onOtherHole(o.aim, hole) ? 0.25 : 0);
  options.sort((a, b) => rank(a) - rank(b));
  // Keep the best aim per club so the list shows real alternatives.
  const best = new Map<string, Option>();
  for (const o of options) if (!best.has(o.club)) best.set(o.club, o);
  // Re-check the finalists with more simulated shots.
  return [...best.values()].slice(0, limit + 2)
    .map((o) => evaluate(ctx, ctx.bag.find((c) => c.name === o.club)!, o.brg, o.swing, 800))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

/** Point the given distance from `from`, following the hole's center line toward the green. */
function pointOnLineAt(hole: Hole, from: XY, m: number): XY {
  // Use the part of the line still ahead of us.
  const line = hole.line;
  let startIdx = 1;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = dist(from, line[i]);
    if (d < best && dist(line[i], hole.pin) <= dist(from, hole.pin) + 5) { best = d; startIdx = i; }
  }
  const pts: XY[] = [from, ...line.slice(startIdx)];
  for (let i = 1; i < pts.length; i++) {
    // find where circle of radius m around from crosses this segment
    if (dist(from, pts[i]) >= m) {
      const a = pts[i - 1], b = pts[i];
      let lo = 0, hi = 1;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        const p: XY = [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid];
        if (dist(from, p) < m) lo = mid; else hi = mid;
      }
      return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
    }
  }
  return pts[pts.length - 1];
}

/** Chain best shots from the tee to the green into a plan. */
export function buildPlan(ctx: Ctx): { steps: PlanStep[]; expected: number } {
  const steps: PlanStep[] = [];
  let from = ctx.from, lie = ctx.lie;
  let total = 0;
  const green = ctx.course.greenOf(ctx.hole);
  for (let i = 0; i < 6; i++) {
    const opt = suggest({ ...ctx, from, lie }, 1)[0];
    if (!opt) break;
    steps.push({ club: opt.club, target: opt.aim });
    if (i === 0) total = opt.expected;
    const onGreen = green ? pointInFeature(opt.aim, green) : dist(opt.aim, ctx.pin) < 12;
    if (onGreen || dist(opt.aim, ctx.pin) < 15) break;
    from = opt.aim;
    lie = ctx.course.lieAt(from, ctx.hole);
    if (lie === 'water' || lie === 'ob') lie = 'rough';
  }
  return { steps, expected: total };
}
