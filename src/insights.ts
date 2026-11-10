// Turning rounds into advice: handicap estimate, round recap, and where to miss.
import { XY, bearing, fromBearing, pointInFeature, dist, toYds, YD } from './course';
import { Ctx, outcome, suggest, treeStop } from './advice';
import type { RoundView } from './stats';
import { CATEGORY_LABEL, Category } from './sg';

export interface Recap {
  headline: string;
  good: string[];
  cost: { label: string; strokes: number }[];
  focus: string;
}

/** What went well, what cost shots, and one thing to work on. */
export function roundRecap(v: RoundView): Recap {
  const hs = v.holes;
  const toPar = v.score - v.par;
  const doubles = hs.filter((h) => h.score - h.par >= 2).length;
  const headline = `${v.score} (${toPar === 0 ? 'even par' : toPar > 0 ? `+${toPar}` : `${toPar}`}) over ${hs.length} holes${doubles ? ` · ${doubles} double${doubles > 1 ? 's' : ''} or worse` : ''}`;

  const good: string[] = [];
  const birdies = hs.filter((h) => h.score < h.par);
  if (birdies.length) good.push(`Under par on ${birdies.map((h) => h.ref).join(', ')}`);
  const pars = hs.filter((h) => h.score === h.par).length;
  if (pars) good.push(`${pars} par${pars > 1 ? 's' : ''}`);
  if (v.fairways[1] && v.fairways[0] / v.fairways[1] >= 0.5) good.push(`${v.fairways[0]} of ${v.fairways[1]} fairways`);
  if (v.gir[0]) good.push(`${v.gir[0]} green${v.gir[0] > 1 ? 's' : ''} in regulation`);
  const onePutts = hs.filter((h) => h.putts === 1).length;
  if (onePutts >= 2) good.push(`${onePutts} one-putts`);

  const penalties = hs.reduce((a, h) => a + h.penalties, 0);
  const extraPutts = hs.reduce((a, h) => a + Math.max(0, h.putts - 2), 0);
  const notSaved = hs.filter((h) => !h.gir && h.score > h.par && h.putts <= 2 && !h.penalties).length;
  const cost = [
    { label: 'Penalty strokes', strokes: penalties },
    { label: 'Three-putts (extra putts)', strokes: extraPutts },
    { label: 'Missed greens you didn\'t get up and down', strokes: notSaved },
  ].filter((c) => c.strokes > 0).sort((a, b) => b.strokes - a.strokes);

  const tracked = hs.filter((h) => h.shots.length > 0);
  let focus: string;
  if (tracked.length >= 9) {
    const cats = Object.keys(CATEGORY_LABEL) as Category[];
    const worst = cats.map((k) => [k, tracked.reduce((a, h) => a + h.sg[k], 0)] as const).sort((a, b) => a[1] - b[1])[0];
    focus = `${CATEGORY_LABEL[worst[0]]} cost you the most (${worst[1].toFixed(1)} strokes). ${FOCUS_TIP[worst[0]]}`;
  } else if (!cost.length) {
    focus = 'A clean round: no penalties, no three-putts. Keep playing to your plan.';
  } else if (cost[0].label.startsWith('Penalty')) {
    focus = `Penalties cost ${penalties} stroke${penalties > 1 ? 's' : ''}. On those holes, take the club that keeps the trouble out of reach.`;
  } else if (cost[0].label.startsWith('Three')) {
    focus = `${extraPutts} extra putt${extraPutts > 1 ? 's' : ''} from three-putting. Practice lag putts from 30–40 ft: pace matters more than line.`;
  } else {
    focus = `${notSaved} missed green${notSaved > 1 ? 's' : ''} turned into bogey or worse. Work on chips inside 30 yards, and check "where to miss" before approaches.`;
  }
  return { headline, good, cost, focus };
}

const FOCUS_TIP: Record<Category, string> = {
  ott: 'Pick the tee club that keeps you in play, even if it leaves a longer approach.',
  app: 'Aim at the middle of the green and take enough club; most misses are short.',
  arg: 'Practice chips inside 30 yards and pick the simplest shot that gets on the green.',
  putt: 'Practice lag putts from 30–40 ft: pace matters more than line.',
};

export type Side = 'short' | 'long' | 'left' | 'right';
export interface MissAdvice { best: Side; worst: Side; why: string; spread: number; points: Record<Side, XY> }

/**
 * Where to miss the green from here: compares how many strokes it usually takes
 * to finish from just off each side (short, long, left, right of the green, as you face it).
 */
export function whereToMiss(ctx: Ctx): MissAdvice | null {
  const g = ctx.course.greenOf(ctx.hole);
  if (!g) return null;
  const toward = bearing(ctx.from, ctx.pin);
  const dirs: Record<Side, number> = { short: toward + 180, long: toward, left: toward - 90, right: toward + 90 };
  const res = {} as Record<Side, { e: number; lies: string[] }>;
  const points = {} as Record<Side, XY>;
  for (const side of Object.keys(dirs) as Side[]) {
    let sum = 0;
    const lies: string[] = [];
    for (const off of [-25, 0, 25]) {
      // Walk out from the pin to the edge of the green, then 9 m (10 yds) past it.
      let edge: XY = ctx.pin;
      for (let m = 1; m < 60; m += 1) { const p = fromBearing(ctx.pin, dirs[side] + off, m); if (!pointInFeature(p, g)) break; edge = p; }
      const p = fromBearing(edge, dirs[side] + off, 9);
      const o = outcome(ctx, p);
      if (off === 0) points[side] = p;
      sum += o.e; lies.push(o.lie);
    }
    res[side] = { e: sum / 3, lies };
  }
  const order = (Object.keys(res) as Side[]).sort((a, b) => res[a].e - res[b].e);
  const best = order[0], worst = order[3];
  const spread = res[worst].e - res[best].e;
  if (spread < 0.15) return null;
  const count = (l: string) => res[worst].lies.filter((x) => x === l).length;
  const why = count('water') ? 'water' : count('ob') ? 'out of bounds' : count('recovery') ? 'trees' : count('sand') ? 'sand' : 'a tough up-and-down';
  return { best, worst, why, spread, points };
}

export interface SideAdvice { favor: 'left' | 'right'; why: string; spread: number; target: XY; brg: number }

/**
 * For a tee shot or layup aimed at `target`: is it better to finish left or right of it?
 * Plays the next shot from 20 yards either side, so trees that block the line to the
 * green and a worse angle both count, not just the lie.
 */
export function whichSide(ctx: Ctx, target: XY): SideAdvice | null {
  const brg = bearing(ctx.from, target);
  const res = {} as Record<'left' | 'right', { e: number; lie: string; trouble: number }>;
  for (const side of ['left', 'right'] as const) {
    // Average three spots 10, 20 and 27 yards to that side.
    let e = 0, trouble = 0;
    const lies: string[] = [];
    for (const off of [9, 18, 25]) {
      const p = fromBearing(target, brg + (side === 'left' ? -90 : 90), off);
      const o = outcome(ctx, p);
      lies.push(o.lie);
      if (o.lie === 'water' || o.lie === 'ob') { e += o.e; trouble += 1; continue; }
      const next = suggest({ ...ctx, from: p, lie: o.lie }, 1)[0];
      e += next ? next.expected : o.e;
      trouble += next ? next.pTrouble : 0;
    }
    const worstLie = ['water', 'ob', 'recovery', 'sand'].find((l) => lies.includes(l)) ?? lies[1];
    res[side] = { e: e / 3, lie: worstLie, trouble: trouble / 3 };
  }
  const favor = res.left.e <= res.right.e ? 'left' : 'right';
  const bad = res[favor === 'left' ? 'right' : 'left'], good = res[favor];
  const spread = bad.e - good.e;
  if (spread < 0.07) return null;
  const why = bad.lie === 'water' ? 'water' : bad.lie === 'ob' ? 'out of bounds' : bad.lie === 'recovery' ? "you're under the trees" : bad.lie === 'sand' ? 'sand'
    : bad.trouble - good.trouble > 0.06 ? 'trees block your line to the green' : 'a worse angle and lie for the next shot';
  return { favor, why, spread, target, brg };
}

export interface BlockedPlay { club: string; yds: number; dir: 'left' | 'right' | 'straight'; leave: number; aim: XY }

/**
 * Are trees between you and the green? Checks the flight of a normal shot on the direct
 * line. If it's blocked, returns the best play from here (which already accounts for the trees).
 */
export function blockedPlay(ctx: Ctx): BlockedPlay | null {
  const d = dist(ctx.from, ctx.pin);
  if (d < 25 || ctx.lie === 'tee' || ctx.lie === 'green') return null;
  const longest = Math.max(0, ...ctx.bag.filter((c) => c.on && c.name !== 'Driver').map((c) => c.yds)) * YD;
  const reach = Math.min(d, longest || d);
  const direct = bearing(ctx.from, ctx.pin);
  const apex = ctx.lie === 'recovery' ? 5 : Math.max(8, Math.min(30, reach * 0.13));
  if (!treeStop(ctx, fromBearing(ctx.from, direct, reach), apex)) return null;
  const o = suggest(ctx, 1)[0];
  if (!o) return null;
  const turn = ((o.brg - direct + 540) % 360) - 180;
  return { club: o.club, yds: Math.round(o.carryYds), dir: turn > 4 ? 'right' : turn < -4 ? 'left' : 'straight', leave: Math.round(toYds(dist(o.aim, ctx.pin))), aim: o.aim };
}
