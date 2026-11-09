// Putting: roll a ball across the measured green surface.
// A rolling ball slows from friction (set by green speed) and is pulled downhill
// by gravity. For a ball that rolls without sliding, the downhill pull is 5/7 of
// gravity times the slope.
import type { XY } from './course';

export interface PuttGreen {
  height(x: number, y: number): number; // meters
  hole: XY;
  stimp: number; // green speed in feet
  /** Bermuda grain: the compass direction it grows toward. Down-grain rolls faster and nudges the ball that way. */
  grainToward?: number | null;
}

/** How strongly grain acts: about like a 0.4% slope plus ±10% speed with/against it. */
const GRAIN_PULL = (5 / 7) * 9.81 * 0.004;
const GRAIN_SPEED = 0.1;

export interface PuttResult {
  path: XY[];
  holed: boolean;
  stop: XY; // where it stops; for a holed putt, where it would have stopped
  /** Closest the ball's center came to the hole (m). */
  closest: number;
  /** How far past (+) or short (−) of the hole it finished (or would have, if it dropped), along the line to the hole (m). */
  pastHole: number;
}

const G = 9.81;
const STIMP_SPEED = 1.83; // m/s: speed of a ball leaving a Stimpmeter
const CUP_R = 0.054; // 4.25 in cup radius
const DT = 0.004;

/** Friction slowdown (m/s²) for a green that rolls `stimp` feet on the Stimpmeter. */
export function friction(stimp: number) {
  return (STIMP_SPEED * STIMP_SPEED) / (2 * stimp * 0.3048);
}

/** Starting speed for a putt that would roll `d` meters on a flat green. */
export function speedFor(stimp: number, d: number) {
  return Math.sqrt(2 * friction(stimp) * Math.max(0.05, d));
}

/** Downhill direction and steepness at a point (slope as rise/run). */
export function slopeAt(g: PuttGreen, p: XY): XY {
  const e = 0.5;
  return [
    (g.height(p[0] + e, p[1]) - g.height(p[0] - e, p[1])) / (2 * e),
    (g.height(p[0], p[1] + e) - g.height(p[0], p[1] - e)) / (2 * e),
  ];
}

/** Roll a putt struck toward compass bearing `brg` (degrees) with starting speed `v0` (m/s). */
export function roll(g: PuttGreen, ball: XY, brg: number, v0: number): PuttResult {
  const a = friction(g.stimp);
  const r = (brg * Math.PI) / 180;
  let x = ball[0], y = ball[1];
  let vx = Math.sin(r) * v0, vy = Math.cos(r) * v0;
  const path: XY[] = [[x, y]];
  let closest = Math.hypot(x - g.hole[0], y - g.hole[1]);
  let holed = false;
  for (let t = 0; t < 30; t += DT) {
    const v = Math.hypot(vx, vy);
    if (v < 0.01) {
      // Stopped: stays put unless the slope is steep enough to restart it (rare on a green).
      break;
    }
    const [sx, sy] = slopeAt(g, [x, y]);
    let ax = (-5 / 7) * G * sx, ay = (-5 / 7) * G * sy;
    let fr = a;
    if (g.grainToward !== undefined && g.grainToward !== null) {
      const gr = (g.grainToward * Math.PI) / 180, gx = Math.sin(gr), gy = Math.cos(gr);
      const along = (vx * gx + vy * gy) / v; // +1 rolling down-grain
      fr = a * (1 - GRAIN_SPEED * along);
      ax += GRAIN_PULL * gx; ay += GRAIN_PULL * gy;
    }
    ax -= (fr * vx) / v; ay -= (fr * vy) / v;
    const nx = x + vx * DT, ny = y + vy * DT;
    // Closest approach to the hole along this little step.
    const dx = nx - x, dy = ny - y, L = dx * dx + dy * dy;
    const k = L ? Math.max(0, Math.min(1, ((g.hole[0] - x) * dx + (g.hole[1] - y) * dy) / L)) : 0;
    const d = Math.hypot(x + dx * k - g.hole[0], y + dy * k - g.hole[1]);
    closest = Math.min(closest, d);
    // Drops if it crosses the cup slowly enough; a ball catching the edge must be slower.
    if (!holed && d < CUP_R && v < 1.6 * Math.sqrt(Math.max(0, 1 - (d / CUP_R) ** 2)) + 0.05) {
      // It drops. Keep rolling it on paper to know where it would have finished (its pace).
      holed = true;
      path.push([g.hole[0], g.hole[1]]);
    }
    x = nx; y = ny;
    vx += ax * DT; vy += ay * DT;
    // Friction can't reverse the ball: if it would, it has stopped.
    if (vx * (vx - ax * DT) + vy * (vy - ay * DT) < 0 && Math.hypot(vx, vy) < 0.05) break;
    if (!holed && path.length < 4000 && Math.hypot(x - path[path.length - 1][0], y - path[path.length - 1][1]) > 0.08) path.push([x, y]);
  }
  if (!holed) path.push([x, y]);
  const toHole: XY = [g.hole[0] - ball[0], g.hole[1] - ball[1]];
  const len = Math.hypot(...toHole) || 1;
  const pastHole = ((x - ball[0]) * toHole[0] + (y - ball[1]) * toHole[1]) / len - len;
  return { path, holed, stop: [x, y], closest, pastHole };
}

export interface PuttRead {
  aim: XY; // the aim point: direction to start it on, at the distance to hit it "as if flat"
  brg: number;
  flatDistance: number; // m: hit it like a flat putt of this length
  result: PuttResult;
  breakM: number; // aim offset at the hole, + = aim right of the hole
}

/**
 * Find the line: the aim and pace that hole the putt and would finish about 1½ ft past
 * (a good speed that holds its line).
 */
export function findLine(g: PuttGreen, ball: XY): PuttRead | null {
  const d = Math.hypot(g.hole[0] - ball[0], g.hole[1] - ball[1]);
  if (d < 0.15) return null;
  const direct = (Math.atan2(g.hole[0] - ball[0], g.hole[1] - ball[1]) * 180) / Math.PI;
  const target = 0.45; // m past the hole
  let best: { brg: number; flat: number; res: PuttResult; score: number } | null = null;
  const consider = (brg: number, flat: number) => {
    const res = roll(g, ball, brg, speedFor(g.stimp, flat));
    // Holed putts that finish near 1½ ft past win; otherwise the nearest miss with good pace.
    const score = res.holed ? Math.abs(res.pastHole - target) * 0.2 : 1 + res.closest * 4 + Math.abs(res.pastHole - target) * 0.5;
    if (!best || score < best.score) best = { brg, flat, res, score };
  };
  const maxAngle = Math.min(40, 8 + 300 / Math.max(1, d)); // short putts can need a wide aim on steep slopes
  for (let ang = -maxAngle; ang <= maxAngle; ang += 1) for (let f = 0.7; f <= 2.6; f += 0.15) consider(direct + ang, d * f + target);
  for (let pass = 0; pass < 2; pass++) {
    const b0 = best!;
    const step = pass === 0 ? 0.25 : 0.06;
    for (let ang = -1.2; ang <= 1.2; ang += step) for (let f = -0.12; f <= 0.12; f += 0.03) consider(b0.brg + ang * (pass === 0 ? 1 : 0.3), b0.flat * (1 + f * (pass === 0 ? 1 : 0.4)));
  }
  const b = best as unknown as { brg: number; flat: number; res: PuttResult };
  // The aim point carries the pace too: it sits as far away as the putt is hit "on a flat green".
  const aim: XY = [ball[0] + Math.sin((b.brg * Math.PI) / 180) * b.flat, ball[1] + Math.cos((b.brg * Math.PI) / 180) * b.flat];
  const off = ((b.brg - direct + 540) % 360) - 180; // + = aim right of the hole
  return { aim, brg: b.brg, flatDistance: b.flat, result: b.res, breakM: Math.tan((off * Math.PI) / 180) * d };
}

/** Uphill (+) or downhill (−) from ball to hole, in meters. */
export function rise(g: PuttGreen, ball: XY) {
  return g.height(g.hole[0], g.hole[1]) - g.height(ball[0], ball[1]);
}

export const M_TO_FT = 3.28084;
export const CUP_IN = 4.25;

/** "2½ cups left" style aim description from an offset in meters (+ = right). */
export function describeAim(breakM: number) {
  const inches = Math.abs(breakM) * 39.37;
  if (inches < 2) return 'Straight at the hole (inside the cup)';
  const cups = inches / CUP_IN;
  const cupText = cups < 1.25 ? 'just outside the edge' : `${Math.round(cups * 2) / 2} cups`;
  return `Aim ${cupText} ${breakM > 0 ? 'right' : 'left'} (${Math.round(inches)} in)`;
}

/**
 * Learn today's green speed from how a putt finished. Roll distance is proportional to
 * green speed for a given strike, so a putt that finished `missFt` feet past (+) or
 * short (−) of where the read said it would means the green is that much faster/slower.
 * Blends with what we already believed (each putt counts for about a third).
 */
export function learnStimp(current: number, predictedRollFt: number, missFt: number) {
  if (predictedRollFt < 3) return current;
  const observed = current * Math.max(0.5, Math.min(1.6, (predictedRollFt + missFt) / predictedRollFt));
  return Math.round((current * 0.65 + observed * 0.35) * 10) / 10;
}
