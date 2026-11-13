// Everything you record lives here, saved in the phone's local storage.
import type { XY, Lie } from './course';
import { CALM, type Conditions } from './conditions';

export interface Club {
  name: string;
  yds: number; // typical total distance
  carry?: number; // typical carry, when known
  sdYds: number; // distance spread (1 standard deviation)
  sdDeg: number; // left/right spread in degrees
  on: boolean;
}

/**
 * Your bag, from the Toptracer sessions (club-distances one-pager, updated Nov 12, 2026).
 * `yds` is total (carry and roll, which the advice uses); `carry` is the mat carry.
 * Clubs not hit on Nov 12 keep their Nov 7 numbers. Mat numbers, not grass.
 */
export const BAG_VERSION = '2026-11-12';
const club = (name: string, carry: number, yds: number, sdDeg: number): Club =>
  ({ name, carry, yds, sdYds: Math.max(7, Math.round(yds * (name === 'Driver' ? 0.075 : 0.068))), sdDeg, on: true });
export const DEFAULT_BAG: Club[] = [
  club('Driver', 225, 272, 6.5),
  club('3 Wood', 192, 229, 6),
  club('5 Wood', 219, 243, 6),
  club('7 Wood', 237, 268, 5.5),
  club('9 Wood', 204, 226, 5.5),
  club('Hybrid', 207, 223, 5.5),
  club('4 Iron', 218, 237, 5.5),
  club('5 Iron', 194, 209, 5.5),
  club('6 Iron', 180, 189, 5),
  club('7 Iron', 154, 167, 5),
  club('8 Iron', 159, 164, 4.5),
  club('9 Iron', 156, 160, 4.5),
  club('PW', 125, 128, 4.5),
  club('GW', 126, 127, 4.5),
  club('54°', 100, 100, 5),
  club('SW', 88, 89, 5),
  club('LW', 76, 77, 5.5),
];
export const PUTTER = 'Putter';

export interface PlanStep { club: string; target: XY }
export interface HolePlan { steps: PlanStep[]; notes: string; updated: string }

export interface ShotRec {
  club: string;
  start: XY;
  lie: Lie;
  acc: number | null; // GPS accuracy in meters (null = placed by hand)
  penalty: number;
  t: string;
}

export interface HoleRec {
  ref: number;
  teeId: string;
  pin: XY;
  shots: ShotRec[];
  greenMark: XY | null;
  putts: number;
  holedFromOff: boolean;
  followedPlan: boolean | null;
  done: boolean;
  /** Quick scoring: total strokes typed in instead of tracking each shot. */
  strokes?: number;
  quick?: boolean;
  fairway?: 'left' | 'hit' | 'right' | null;
  penalties?: number; // quick scoring: penalty strokes (already in the score)
  missedGreen?: 'short' | 'long' | 'left' | 'right' | null;
}

export interface Round {
  id: string;
  date: string;
  teeSet: TeeSet;
  conditions: Conditions;
  holes: Record<number, HoleRec>;
  finished: boolean;
  trackShots?: boolean;
  /** Which course this round was played on. Missing means Cedar Crest. */
  courseId?: string;
}

export type TeeSet = 'black' | 'gold' | 'silver' | 'ruby';
export type CourseKey = 'cedar' | 'sherrill1' | 'sherrill2' | 'waterchase';
export const COURSE_KEYS: CourseKey[] = ['cedar', 'sherrill1', 'sherrill2', 'waterchase'];
const courseKey = (v: unknown): CourseKey => (COURSE_KEYS.includes(v as CourseKey) ? (v as CourseKey) : 'cedar');

export interface Settings {
  handicap: number;
  teeSet: TeeSet;
  exaggerate: number;
  simulateGps: boolean;
  useMyNumbers: boolean;
  showWind: boolean;
  onboarded: boolean;
  trackShots: boolean;
  measureHint: boolean;
  /** Course rating and slope per tee set, from the scorecard, for score differentials. */
  ratings: Partial<Record<TeeSet, { rating: number; slope: number }>>;
  lastBackup: string | null;
  leftHanded: boolean;
  stimp: number; // green speed (feet on the Stimpmeter)
  wet: 'auto' | 'wet' | 'dry';
  manualWeather: boolean; // true = you entered conditions; live updates paused
  grainToward: number | null; // bermuda grain direction for putting (null = ignore)
  stimpToday: { date: string; value: number } | null; // green speed learned from today's putts
  sgBaseline: 'me' | 'scratch' | 'tour'; // who strokes gained compares you with
  installDismissed: boolean;
  simple: boolean; // plain words, fewer numbers
  bigText: boolean;
  /** cedar, sherrill1, or sherrill2. */
  courseId: CourseKey;
  /** Which bag update has been applied (see BAG_VERSION). */
  bagVersion?: string;
  /** Show the big hole card instead of the map. */
  caddie?: boolean;
  /** Tees picked on each course (teeSet is the one for the course in use). */
  teeByCourse?: Record<string, TeeSet>;
  /** Tee rating overrides belong to one course. */
  ratingsCourse?: string;
}

export interface State {
  version: 1;
  settings: Settings;
  bag: Club[];
  plans: Record<string, HolePlan>;
  pins: Record<string, XY>; // pin positions for planning (default: mapped pin)
  rounds: Round[];
  activeRoundId: string | null;
  conditions: Conditions; // last weather used for planning
}

const KEY = 'cedarcrest.v1';

export function freshState(): State {
  return {
    version: 1,
    settings: { handicap: 15, teeSet: 'gold', exaggerate: 1.5, simulateGps: false, useMyNumbers: true, showWind: false, onboarded: false, trackShots: false, measureHint: true, ratings: {}, lastBackup: null, bagVersion: BAG_VERSION, leftHanded: false, stimp: 10, wet: 'auto', manualWeather: false, grainToward: null, stimpToday: null, sgBaseline: 'me', installDismissed: false, simple: true, bigText: false, courseId: 'cedar' },
    bag: DEFAULT_BAG.map((c) => ({ ...c })),
    plans: {},
    pins: {},
    rounds: [],
    activeRoundId: null,
    conditions: { ...CALM },
  };
}

/** Set when saved data couldn't be read; the unreadable copy is kept under this key. */
export let recoveredFrom: string | null = null;

export function loadState(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): State {
  let raw: string | null = null;
  try {
    raw = storage.getItem(KEY);
    if (!raw) return freshState();
    return migrate(JSON.parse(raw));
  } catch {
    // Never throw away rounds: keep the unreadable copy before starting fresh.
    if (raw) {
      recoveredFrom = `${KEY}.unreadable-${Date.now()}`;
      try { storage.setItem(recoveredFrom, raw); } catch { /* storage unavailable */ }
    }
    return freshState();
  }
}

const LEGACY_TEE: Record<string, TeeSet> = { back: 'black', middle: 'gold', forward: 'ruby', black: 'black', gold: 'gold', silver: 'silver', ruby: 'ruby' };
export function normalizeTee(v: unknown): TeeSet {
  return LEGACY_TEE[String(v)] ?? 'gold';
}

export function migrate(s: Partial<State>): State {
  const base = freshState();
  const courseId = courseKey(s.settings?.courseId);
  const teeSet = normalizeTee(s.settings?.teeSet ?? base.settings.teeSet);
  const teeByCourse: Record<string, TeeSet> = {};
  for (const [k, v] of Object.entries(s.settings?.teeByCourse ?? {})) teeByCourse[k] = normalizeTee(v);
  teeByCourse[courseId] = teeSet;
  const settings = { ...base.settings, ...(s.settings ?? {}), teeSet, courseId, teeByCourse };
  // A newer bag (new distances) replaces the saved one once; edits after that are kept.
  const bagVersion = (s.settings as Partial<Settings> | undefined)?.bagVersion;
  settings.bagVersion = bagVersion;
  const tag = (bag: Record<string, unknown> | undefined) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bag ?? {})) out[k.includes(':') ? k : `cedar:${k}`] = v;
    return out;
  };
  const rounds = (s.rounds ?? base.rounds).map((r) => ({ ...r, teeSet: normalizeTee(r.teeSet), courseId: courseKey(r.courseId) }));
  const out = { ...base, ...s, settings, rounds, plans: tag(s.plans as unknown as Record<string, unknown>) as State['plans'], pins: tag(s.pins as unknown as Record<string, unknown>) as State['pins'], bag: s.bag?.length && settings.bagVersion === BAG_VERSION ? s.bag : base.bag.map((c) => ({ ...c })) };
  out.settings.bagVersion = BAG_VERSION;
  return out;
}

/** Called when the phone refuses to save (for example, storage is full). */
export let onSaveError: (e: unknown) => void = (e) => console.error('save failed', e);
export function setSaveErrorHandler(fn: (e: unknown) => void) { onSaveError = fn; }

/** Save right away: the data is small, and a delayed save can be lost if the app is closed. */
/** Remember the tees for the course in use, and switch to another course with its own tees. */
export function setTee(s: State, t: TeeSet) {
  s.settings.teeSet = t;
  s.settings.teeByCourse = { ...(s.settings.teeByCourse ?? {}), [s.settings.courseId]: t };
}
export function switchCourse(s: State, id: CourseKey) {
  setTee(s, s.settings.teeSet);
  s.settings.courseId = id;
  s.settings.teeSet = s.settings.teeByCourse?.[id] ?? 'gold';
}

export function saveState(s: State, storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(KEY, JSON.stringify(s)); } catch (e) { onSaveError(e); }
}
export function saveNow(s: State) { saveState(s); }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
