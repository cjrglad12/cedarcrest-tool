import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Course, CourseData, dist, toYds, teeFor } from '../src/course';
import { expected, tourExpected, categorize } from '../src/sg';
import { carryFactor, windComponents, playsLike, CALM } from '../src/conditions';
import { suggest, buildPlan } from '../src/advice';
import { analyzeHole, clubStats, effectiveBag } from '../src/stats';
import { freshState, migrate, DEFAULT_BAG, HoleRec } from '../src/store';
import { bestFix, fmtHcp, parseHcp } from '../src/gps';
import { differential, spreadFactor, scoringStats, courseHandicap, strokesOnHole, adjustedGross } from '../src/stats';

const data: CourseData = JSON.parse(readFileSync(new URL('../public/data/course.json', import.meta.url), 'utf8'));
const raw = readFileSync(new URL('../public/data/terrain.bin', import.meta.url));
const can = readFileSync(new URL('../public/data/canopy.bin', import.meta.url));
const course = new Course(data, new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2), new Uint8Array(can.buffer, can.byteOffset, can.byteLength));

describe('course data', () => {
  it('has all 18 holes with tees and greens', () => {
    expect(course.holes.map((h) => h.ref)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    for (const h of course.holes) {
      expect(h.tees.length).toBeGreaterThan(0);
      expect(h.greenId).toBeTruthy();
      expect([3, 4, 5]).toContain(h.par);
      const len = teeFor(h, 'middle').lengthYds;
      expect(len).toBeGreaterThan(h.par === 3 ? 100 : 250);
      expect(len).toBeLessThan(h.par === 3 ? 260 : 650);
    }
  });
  it('finds lies: the pin is on the green and the tee is fairway-like', () => {
    for (const h of course.holes) {
      expect(course.lieAt(h.pin, h)).toBe('green');
      expect(course.lieAt(teeFor(h, 'middle').center, h)).not.toBe('ob');
    }
  });
  it('has sensible terrain heights', () => {
    const h = course.hole(1);
    const z = course.height(h.pin[0], h.pin[1]);
    expect(z).toBeGreaterThanOrEqual(0);
    expect(z).toBeLessThan(80);
  });
  it('front of green is closer than the back', () => {
    for (const h of course.holes) {
      const g = course.greenDistances(h, teeFor(h, 'middle').center);
      expect(g.front).toBeLessThan(g.back);
      expect(g.pin).toBeGreaterThan(g.front - 5);
    }
  });
  it('round-trips GPS coordinates', () => {
    const p = course.hole(5).pin;
    const ll = course.toLatLon(p);
    const back = course.toXY(ll.lat, ll.lon);
    expect(dist(p, back)).toBeLessThan(0.01);
    expect(ll.lat).toBeGreaterThan(32.7);
    expect(ll.lon).toBeLessThan(-96.7);
  });
});

describe('trees and holes', () => {
  it('loads the canopy map', () => {
    let trees = 0;
    for (const v of course.canopy) if (v >= 4) trees++;
    expect(trees / course.canopy.length).toBeGreaterThan(0.1);
  });
  it('the 1 m lie grid matches the exact shapes', () => {
    const b = course.data.bounds;
    let x = 12345, diff = 0;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const p: [number, number] = [b.minX + rnd() * (b.maxX - b.minX), b.minY + rnd() * (b.maxY - b.minY)];
      if (course.kindAt(p) !== course.kindAtExact(p)) diff++;
    }
    expect(diff / N).toBeLessThan(0.01); // only right on the edges
  });
  it('assigns each green to its own hole', () => {
    for (const h of course.holes) expect(course.owner.get(h.greenId!)).toBe(h.ref);
  });
  it('treats ground under tall trees as a recovery lie', () => {
    const t = course.data.terrain;
    const i = course.canopy.findIndex((v, k) => v >= 10 && course.kindAt([t.minX + (k % t.cols) * t.cell, t.minY + Math.floor(k / t.cols) * t.cell]) === 'rough');
    const p: [number, number] = [t.minX + (i % t.cols) * t.cell, t.minY + Math.floor(i / t.cols) * t.cell];
    expect(course.lieAt(p)).toBe('recovery');
  });
});

describe('strokes gained baseline', () => {
  it('matches known tour values', () => {
    expect(tourExpected(400, 'tee')).toBeCloseTo(3.99, 2);
    expect(tourExpected(150, 'fairway')).toBeCloseTo(2.945, 2);
    expect(tourExpected(10 / 3, 'green')).toBeCloseTo(1.61, 2);
  });
  it('a 15 handicap expects more strokes than tour, scratch ~ tour', () => {
    expect(expected(400, 'tee', 15)).toBeGreaterThan(tourExpected(400, 'tee') + 0.5);
    expect(expected(400, 'tee', 0)).toBeCloseTo(tourExpected(400, 'tee'), 5);
  });
  it('trouble lies cost more than fairway', () => {
    for (const d of [60, 120, 180]) {
      expect(expected(d, 'rough', 15)).toBeGreaterThan(expected(d, 'fairway', 15));
      expect(expected(d, 'recovery', 15)).toBeGreaterThan(expected(d, 'rough', 15));
    }
  });
  it('categorizes shots', () => {
    expect(categorize(0, 4, 'tee', 400)).toBe('ott');
    expect(categorize(0, 3, 'tee', 170)).toBe('app');
    expect(categorize(2, 4, 'rough', 30)).toBe('arg');
    expect(categorize(3, 4, 'green', 5)).toBe('putt');
  });
});

describe('conditions', () => {
  it('headwind shortens, tailwind lengthens', () => {
    const c = { ...CALM, tempF: 70, windMph: 10, windFrom: 0 };
    expect(carryFactor(c, 0)).toBeCloseTo(0.9, 3); // hitting north into a north wind
    expect(carryFactor(c, 180)).toBeCloseTo(1.05, 3);
    expect(windComponents(c, 90).cross).toBeCloseTo(10, 5); // wind from N while hitting E pushes right
  });
  it('uphill plays longer', () => {
    const c = { ...CALM, tempF: 70 };
    expect(playsLike(140, 5, c, 0)).toBeCloseTo(145, 5);
  });
});

describe('advice', () => {
  const state = freshState();
  const ctxFor = (ref: number) => {
    const h = course.hole(ref);
    return { course, hole: h, from: teeFor(h, 'middle').center, lie: 'tee' as const, pin: h.pin, cond: CALM, bag: state.bag, handicap: 15 };
  };
  it('suggests a reasonable club on a par 3', () => {
    const h = course.hole(9);
    const yds = toYds(dist(teeFor(h, 'middle').center, h.pin));
    const opts = suggest(ctxFor(9), 3);
    expect(opts.length).toBeGreaterThan(0);
    const club = DEFAULT_BAG.find((c) => c.name === opts[0].club)!;
    expect(Math.abs(club.yds - yds)).toBeLessThan(35);
    expect(opts[0].expected).toBeGreaterThan(2.5);
    expect(opts[0].expected).toBeLessThan(4.5);
  });
  it('keeps planned shots out of trees and off other holes', () => {
    for (const h of course.holes) {
      for (const s of buildPlan(ctxFor(h.ref)).steps) {
        expect(course.lieAt(s.target, h), `hole ${h.ref}`).not.toBe('recovery');
        expect(course.onOtherHole(s.target, h), `hole ${h.ref}`).toBe(false);
      }
    }
  });
  it('builds a plan that reaches the green on every hole', () => {
    for (const h of course.holes) {
      const plan = buildPlan(ctxFor(h.ref));
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.length).toBeLessThanOrEqual(h.par);
      const last = plan.steps[plan.steps.length - 1].target;
      expect(toYds(dist(last, h.pin))).toBeLessThan(40);
      expect(plan.expected).toBeGreaterThan(h.par - 0.8);
      expect(plan.expected).toBeLessThan(h.par + 2);
    }
  });
});

describe('stats', () => {
  const h = course.hole(4);
  const t = teeFor(h, 'middle').center;
  const lerp = (k: number): [number, number] => [t[0] + (h.pin[0] - t[0]) * k, t[1] + (h.pin[1] - t[1]) * k];
  const rec: HoleRec = {
    ref: 4, teeId: '', pin: h.pin, greenMark: lerp(0.985), putts: 2, holedFromOff: false, followedPlan: true, done: true,
    shots: [
      { club: 'Driver', start: t, lie: 'tee', acc: 4, penalty: 0, t: '' },
      { club: '7 Iron', start: lerp(0.55), lie: course.lieAt(lerp(0.55), h), acc: 4, penalty: 0, t: '' },
    ],
  };
  it('scores the hole and splits strokes gained', () => {
    const v = analyzeHole(course, rec, 15);
    expect(v.score).toBe(4);
    expect(v.shots[0].category).toBe('ott');
    expect(v.shots[1].category).toBe('app');
    // Total strokes gained = expected from tee minus actual score
    const total = Object.values(v.sg).reduce((a, b) => a + b, 0);
    const eTee = expected(toYds(dist(t, h.pin)), 'tee', 15);
    expect(total).toBeCloseTo(eTee - 4, 6);
  });
  it('counts penalties', () => {
    const r2 = { ...rec, shots: rec.shots.map((s, i) => ({ ...s, penalty: i === 0 ? 1 : 0 })) };
    expect(analyzeHole(course, r2, 15).score).toBe(5);
  });
  it('handles a chip-in (no putts, no green mark)', () => {
    const r3 = { ...rec, putts: 0, greenMark: null };
    const v = analyzeHole(course, r3, 15);
    expect(v.score).toBe(2);
    expect(v.shots[1].end).toEqual(h.pin);
  });
  it('builds club distances and uses them after 5 shots', () => {
    const s = freshState();
    s.rounds = Array.from({ length: 5 }, (_, i) => ({ id: String(i), date: `2026-10-0${i + 1}`, teeSet: 'middle' as const, conditions: CALM, finished: true, holes: { 4: rec } }));
    const st = clubStats(course, s);
    const drv = st.find((x) => x.club === 'Driver')!;
    expect(drv.n).toBe(5);
    expect(drv.median).toBeCloseTo(toYds(dist(t, lerp(0.55))), 3);
    const bag = effectiveBag(s, st);
    expect(bag.find((c) => c.name === 'Driver')!.yds).toBe(Math.round(drv.median));
  });
});

describe('store', () => {
  it('migrates partial saved data', () => {
    const s = migrate({ rounds: [], settings: { handicap: 9 } as any });
    expect(s.settings.handicap).toBe(9);
    expect(s.settings.teeSet).toBe('middle');
    expect(s.bag.length).toBe(DEFAULT_BAG.length);
  });
});

describe('gps', () => {
  it('blends sharp readings and ignores poor ones', () => {
    const f = bestFix([
      { xy: [0, 0], acc: 4, at: 1 },
      { xy: [2, 0], acc: 4, at: 2 },
      { xy: [40, 40], acc: 30, at: 3 },
    ])!;
    expect(f.xy[0]).toBeCloseTo(1, 5);
    expect(f.xy[1]).toBeCloseTo(0, 5);
    expect(f.acc).toBeCloseTo(4 / Math.sqrt(2), 5);
  });
});

describe('handicaps and posting', () => {
  it('reads and writes plus and decimal handicaps', () => {
    expect(parseHcp('12.4')).toBe(12.4);
    expect(parseHcp('+2.1')).toBe(-2.1);
    expect(parseHcp('-2.1')).toBe(-2.1);
    expect(parseHcp('abc')).toBeNull();
    expect(fmtHcp(-2.1)).toBe('+2.1');
    expect(fmtHcp(15)).toBe('15');
  });
  it('computes a USGA score differential', () => {
    expect(differential(85, 70.1, 125)).toBe(13.5);
  });
  it('tightens the default spread for better players', () => {
    expect(spreadFactor(0)).toBeLessThan(spreadFactor(15));
    expect(spreadFactor(-4)).toBeGreaterThanOrEqual(0.5);
  });
  it('counts scrambling and putts per GIR', () => {
    const base = { shots: [], sg: { ott: 0, app: 0, arg: 0, putt: 0 }, firstPuttFt: null, firstPuttEstimated: false, followedPlan: null, fairway: null, fairwayMiss: null, missedGreen: null, penalties: 0 };
    const st = scoringStats([
      { ...base, ref: 1, par: 4, score: 4, putts: 2, gir: true },
      { ...base, ref: 2, par: 4, score: 4, putts: 1, gir: false },
      { ...base, ref: 3, par: 4, score: 5, putts: 2, gir: false },
    ]);
    expect(st.scramblePct).toBeCloseTo(0.5);
    expect(st.puttsPerGir).toBe(2);
  });
});

describe('net double bogey', () => {
  it('works out course handicap and strokes per hole', () => {
    expect(courseHandicap(12.4, 71.7, 133, 71)).toBe(15); // 12.4 × 133/113 + 0.7 = 15.3
    expect(strokesOnHole(15, 1)).toBe(1);
    expect(strokesOnHole(15, 16)).toBe(0);
    expect(strokesOnHole(20, 2)).toBe(2);
    expect(strokesOnHole(-2, 18)).toBe(-1); // plus 2 gives back on the two easiest holes
    expect(strokesOnHole(-2, 16)).toBe(0);
  });
  it('caps a blow-up hole', () => {
    // 15 course handicap, par 4 with stroke index 1: cap = 4 + 2 + 1 = 7
    expect(adjustedGross([{ score: 10, par: 4, strokeIndex: 1 }, { score: 5, par: 4, strokeIndex: 18 }], 15)).toBe(12);
  });
  it('has par 71 and a stroke index on every hole', () => {
    expect(course.holes.reduce((a, h) => a + h.par, 0)).toBe(71);
    expect(new Set(course.holes.map((h) => h.handicap)).size).toBe(18);
  });
});

describe('slope under the ball', () => {
  it('reads uphill along the line and the opposite way back', () => {
    // Find a sloped spot on hole 1 and check the reading flips when you turn around.
    const h = course.hole(1);
    const t = teeFor(h, 'middle').center;
    let found = false;
    for (let k = 0.2; k < 0.9 && !found; k += 0.05) {
      const p = course.alongLine(h, t, dist(t, h.pin) * k);
      const a = course.lieSlope(p, 0), b = course.lieSlope(p, 180);
      if (Math.abs(a.along) > 1) {
        expect(b.along).toBeCloseTo(-a.along, 5);
        expect(b.across).toBeCloseTo(-a.across, 5);
        found = true;
      }
    }
    expect(found).toBe(true);
  });
  it('an uphill lie makes the ball go shorter', async () => {
    const { lieEffect } = await import('../src/advice');
    const fake = { ...course, lieSlope: () => ({ along: 6, across: 0 }) } as unknown as typeof course;
    const ctx = { course: fake, hole: course.hole(1), from: [0, 0] as [number, number], lie: 'fairway' as const, pin: course.hole(1).pin, cond: CALM, bag: [], handicap: 15 };
    expect(lieEffect(ctx, 0).distance).toBeLessThan(0.95);
    const fake2 = { ...course, lieSlope: () => ({ along: 0, across: 5 }) } as unknown as typeof course;
    expect(lieEffect({ ...ctx, course: fake2 }, 0).pullDeg).toBeLessThan(0); // right-hander, ball above feet: pulls left
    // Same slope for a left-hander means the ball is below the feet, which also tends left.
    expect(lieEffect({ ...ctx, course: fake2, leftHanded: true }, 0).pullDeg).toBeLessThan(0);
    // Ground rising to the left puts the ball above a left-hander's feet: it goes right.
    const fake3 = { ...course, lieSlope: () => ({ along: 0, across: -5 }) } as unknown as typeof course;
    expect(lieEffect({ ...ctx, course: fake3, leftHanded: true }, 0).pullDeg).toBeGreaterThan(0);
  });
});

describe('putting physics', () => {
  it('a flat putt rolls the stimp distance', async () => {
    const { roll, speedFor } = await import('../src/putt');
    const flat = { height: () => 0, hole: [100, 100] as [number, number], stimp: 10 };
    const r = roll(flat, [0, 0], 0, speedFor(10, 3.048));
    expect(r.stop[1]).toBeCloseTo(3.048, 1);
    expect(Math.abs(r.stop[0])).toBeLessThan(0.01);
  });
  it('a ball rolling across a slope breaks downhill', async () => {
    const { roll, speedFor } = await import('../src/putt');
    // Ground falls toward +x (east) at 2%: a putt hit north curls east.
    const tilted = { height: (x: number) => -0.02 * x, hole: [100, 100] as [number, number], stimp: 10 };
    const r = roll(tilted, [0, 0], 0, speedFor(10, 6));
    expect(r.stop[0]).toBeGreaterThan(0.3);
  });
  it('finds a line that holes a breaking putt, aiming uphill of the hole', async () => {
    const { findLine } = await import('../src/putt');
    const g = { height: (x: number) => -0.02 * x, hole: [0, 5] as [number, number], stimp: 10 };
    const read = findLine(g, [0, 0])!;
    expect(read.result.holed).toBe(true);
    expect(read.breakM).toBeLessThan(0); // slope falls to the right, so aim left
    expect(read.result.pastHole).toBeGreaterThan(0);
    expect(read.result.pastHole).toBeLessThan(1);
  });
  it('re-rolling from the best aim point gives the same result', async () => {
    const { findLine, roll, speedFor } = await import('../src/putt');
    const g = { height: (x: number) => -0.02 * x, hole: [0, 5] as [number, number], stimp: 10 };
    const read = findLine(g, [0, 0])!;
    const brg = (Math.atan2(read.aim[0], read.aim[1]) * 180) / Math.PI;
    const again = roll(g, [0, 0], brg, speedFor(10, Math.hypot(...read.aim)));
    expect(again.holed).toBe(true);
  });
  it('downhill putts need less pace than uphill ones', async () => {
    const { findLine } = await import('../src/putt');
    const down = findLine({ height: (_x: number, y: number) => -0.03 * y, hole: [0, 5], stimp: 10 }, [0, 0])!;
    const up = findLine({ height: (_x: number, y: number) => 0.03 * y, hole: [0, 5], stimp: 10 }, [0, 0])!;
    expect(down.flatDistance).toBeLessThan(up.flatDistance);
  });
  it('reads a real Cedar Crest green quickly', async () => {
    const { findLine } = await import('../src/putt');
    const h = course.hole(2);
    const g = { height: (x: number, y: number) => course.height(x, y), hole: h.pin, stimp: 10 };
    const t0 = Date.now();
    const read = findLine(g, [h.pin[0] - 4, h.pin[1] - 5]);
    expect(read).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('live weather outlook', () => {
  it('calls out rain, rising wind and a temperature swing', async () => {
    const { outlookNotes } = await import('../src/conditions');
    const now = { windMph: 6, gustMph: 10, windFrom: 180, tempF: 70, fetchedAt: 'x', outlook: [
      { time: '2026-11-09T14:00', tempF: 72, windMph: 8, gustMph: 12, windFrom: 185, rainPct: 10 },
      { time: '2026-11-09T15:00', tempF: 75, windMph: 15, gustMph: 22, windFrom: 190, rainPct: 55 },
      { time: '2026-11-09T16:00', tempF: 77, windMph: 12, gustMph: 20, windFrom: 200, rainPct: 30 },
      { time: '2026-11-09T17:00', tempF: 80, windMph: 10, gustMph: 15, windFrom: 200, rainPct: 10 },
    ] };
    const notes = outlookNotes(now);
    expect(notes[0]).toBe('Rain likely around 3 PM (55%)');
    expect(notes).toContain('Wind picking up to 15 mph by 3 PM');
    expect(notes).toContain('Warming to 80°F by 5 PM');
  });
});

describe('putting extras', () => {
  it('learns a slower green from putts that come up short', async () => {
    const { learnStimp } = await import('../src/putt');
    let st = 10;
    for (let i = 0; i < 4; i++) st = learnStimp(st, 20, -3); // 3 ft short on 20-footers
    expect(st).toBeLessThan(9.2);
    expect(learnStimp(10, 20, 0)).toBe(10);
  });
  it('grain nudges the ball the way it grows and speeds it down-grain', async () => {
    const { roll, speedFor } = await import('../src/putt');
    const flat = { height: () => 0, hole: [100, 100] as [number, number], stimp: 10 };
    const plain = roll(flat, [0, 0], 0, speedFor(10, 5));
    const west = roll({ ...flat, grainToward: 270 }, [0, 0], 0, speedFor(10, 5));
    expect(west.stop[0]).toBeLessThan(plain.stop[0] - 0.05);
    const downGrain = roll({ ...flat, grainToward: 0 }, [0, 0], 0, speedFor(10, 5));
    expect(downGrain.stop[1]).toBeGreaterThan(plain.stop[1]);
  });
});
