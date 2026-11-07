// Turns recorded rounds into shot distances, strokes gained and history.
import { Course, XY, Lie, dist, bearing, toYds } from './course';
import { expected, categorize, Category } from './sg';
import type { Club, HoleRec, Round, State } from './store';

export interface ShotView {
  idx: number;
  club: string;
  start: XY;
  end: XY;
  endEstimated: boolean;
  startLie: Lie;
  endLie: Lie;
  yds: number;
  sg: number;
  category: Category;
  penalty: number;
  lateralDeg: number | null;
}

export interface HoleView {
  ref: number;
  par: number;
  score: number;
  putts: number;
  firstPuttFt: number | null;
  firstPuttEstimated: boolean;
  shots: ShotView[];
  sg: Record<Category, number>;
  fairway: boolean | null; // null on par 3s
  gir: boolean;
  followedPlan: boolean | null;
}

const ASSUMED_FIRST_PUTT_FT = 25;
const emptySg = (): Record<Category, number> => ({ ott: 0, app: 0, arg: 0, putt: 0 });

export function analyzeHole(course: Course, rec: HoleRec, handicap: number): HoleView {
  const hole = course.hole(rec.ref);
  const pin = rec.pin;
  const sg = emptySg();
  const shots: ShotView[] = [];
  const holedOut = rec.putts === 0;
  let strokes = 0;
  let reachedGreenAt: number | null = null;

  rec.shots.forEach((s, i) => {
    const next = rec.shots[i + 1];
    let end: XY, endEstimated = false;
    if (next) end = next.start;
    else if (rec.greenMark) end = rec.greenMark;
    else if (holedOut) end = pin;
    else {
      // No mark on the green: assume a typical first-putt distance.
      const d = (ASSUMED_FIRST_PUTT_FT / 3) * 0.9144, b = bearing(pin, s.start);
      end = [pin[0] + Math.sin((b * Math.PI) / 180) * d, pin[1] + Math.cos((b * Math.PI) / 180) * d];
      endEstimated = true;
    }
    const startLie: Lie = i === 0 ? 'tee' : s.lie;
    const lastShot = !next;
    const endLie: Lie = lastShot && (rec.greenMark || !holedOut) ? 'green' : next ? next.lie : 'green';
    const startYds = toYds(dist(s.start, pin));
    const eStart = expected(startYds, startLie, handicap);
    const holed = lastShot && holedOut;
    const eEnd = holed ? 0 : expected(toYds(dist(end, pin)), endLie === 'water' || endLie === 'ob' ? 'rough' : endLie, handicap);
    const value = eStart - eEnd - 1 - s.penalty;
    const category = categorize(i, hole.par, startLie, startYds);
    sg[category] += value;
    strokes += 1 + s.penalty;
    if (endLie === 'green' && reachedGreenAt === null) reachedGreenAt = strokes;

    let lateralDeg: number | null = null;
    if (category !== 'arg' && dist(s.start, end) > 40) {
      const target = i === 0 && hole.par >= 4 ? course.alongLine(hole, s.start, dist(s.start, end)) : pin;
      const d = ((bearing(s.start, end) - bearing(s.start, target) + 540) % 360) - 180;
      lateralDeg = d;
    }
    shots.push({ idx: i, club: s.club, start: s.start, end, endEstimated, startLie, endLie, yds: toYds(dist(s.start, end)), sg: value, category, penalty: s.penalty, lateralDeg });
  });

  let firstPuttFt: number | null = null;
  let firstPuttEstimated = false;
  if (rec.putts > 0) {
    if (rec.greenMark) firstPuttFt = toYds(dist(rec.greenMark, pin)) * 3;
    else { firstPuttFt = ASSUMED_FIRST_PUTT_FT; firstPuttEstimated = true; }
    sg.putt += expected(firstPuttFt / 3, 'green', handicap) - rec.putts;
  }

  const tee = rec.shots[0];
  return {
    ref: rec.ref,
    par: hole.par,
    score: strokes + rec.putts,
    putts: rec.putts,
    firstPuttFt,
    firstPuttEstimated,
    shots,
    sg,
    fairway: hole.par >= 4 && tee ? shots[0]?.endLie === 'fairway' : null,
    gir: reachedGreenAt !== null ? reachedGreenAt <= hole.par - 2 : holedOut && strokes <= hole.par - 2,
    followedPlan: rec.followedPlan,
  };
}

export interface RoundView {
  round: Round;
  holes: HoleView[];
  score: number;
  par: number;
  putts: number;
  sg: Record<Category, number>;
  fairways: [number, number];
  gir: [number, number];
}

export function analyzeRound(course: Course, round: Round, handicap: number): RoundView {
  const holes = Object.values(round.holes).filter((h) => h.done).sort((a, b) => a.ref - b.ref).map((h) => analyzeHole(course, h, handicap));
  const sg = emptySg();
  for (const h of holes) for (const k of Object.keys(sg) as Category[]) sg[k] += h.sg[k];
  return {
    round, holes, sg,
    score: holes.reduce((s, h) => s + h.score, 0),
    par: holes.reduce((s, h) => s + h.par, 0),
    putts: holes.reduce((s, h) => s + h.putts, 0),
    fairways: [holes.filter((h) => h.fairway).length, holes.filter((h) => h.fairway !== null).length],
    gir: [holes.filter((h) => h.gir).length, holes.length],
  };
}

export interface ClubStat { club: string; n: number; median: number; p25: number; p75: number; sd: number; nLat: number; sdDeg: number | null; missBias: number | null }

const quantile = (s: number[], q: number) => {
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

export function clubStats(course: Course, state: State): ClubStat[] {
  const byClub = new Map<string, { d: number[]; lat: number[] }>();
  for (const r of state.rounds) {
    for (const h of Object.values(r.holes)) {
      if (!h.done) continue;
      for (const s of analyzeHole(course, h, state.settings.handicap).shots) {
        if (s.penalty || s.endEstimated || s.startLie === 'sand' || s.startLie === 'recovery' || s.category === 'arg') continue;
        const e = byClub.get(s.club) ?? { d: [], lat: [] };
        e.d.push(s.yds);
        if (s.lateralDeg !== null) e.lat.push(s.lateralDeg);
        byClub.set(s.club, e);
      }
    }
  }
  const order = state.bag.map((c) => c.name);
  return [...byClub.entries()].map(([club, { d, lat }]) => {
    const s = d.slice().sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
    const ls = lat.slice().sort((a, b) => a - b);
    const med = quantile(ls, 0.5);
    const mad = quantile(ls.map((x) => Math.abs(x - med)).sort((a, b) => a - b), 0.5);
    return {
      club, n: s.length, median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), sd,
      nLat: ls.length, sdDeg: ls.length >= 3 ? 1.4826 * mad : null, missBias: ls.length >= 3 ? med : null,
    };
  }).sort((a, b) => order.indexOf(a.club) - order.indexOf(b.club));
}

/** The bag used for advice: your measured numbers once a club has at least 5 clean shots. */
export function effectiveBag(state: State, stats: ClubStat[]): Club[] {
  if (!state.settings.useMyNumbers) return state.bag;
  return state.bag.map((c) => {
    const s = stats.find((x) => x.club === c.name);
    if (!s || s.n < 5) return c;
    return { ...c, yds: Math.round(s.median), sdYds: Math.max(4, Math.round(s.sd)), sdDeg: s.sdDeg !== null && s.nLat >= 5 ? Math.max(2, +s.sdDeg.toFixed(1)) : c.sdDeg };
  });
}

export function holeHistory(course: Course, state: State, ref: number) {
  const out: { date: string; roundId: string; view: HoleView }[] = [];
  for (const r of state.rounds) {
    const h = r.holes[ref];
    if (h?.done) out.push({ date: r.date, roundId: r.id, view: analyzeHole(course, h, state.settings.handicap) });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
