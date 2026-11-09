import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Course, CourseData, dist, toYds, teeFor } from '../src/course';
import { expected, tourExpected, categorize } from '../src/sg';
import { carryFactor, windComponents, playsLike, CALM } from '../src/conditions';
import { suggest, buildPlan } from '../src/advice';
import { analyzeHole, clubStats, effectiveBag } from '../src/stats';
import { freshState, migrate, DEFAULT_BAG, HoleRec } from '../src/store';
import { bestFix, fmtHcp, parseHcp } from '../src/gps';
import { differential, spreadFactor, scoringStats } from '../src/stats';

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
