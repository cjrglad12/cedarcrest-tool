// Everything you record lives here, saved in the phone's local storage.
import type { XY, Lie } from './course';
import { CALM, type Conditions } from './conditions';

export interface Club {
  name: string;
  yds: number; // typical total distance
  sdYds: number; // distance spread (1 standard deviation)
  sdDeg: number; // left/right spread in degrees
  on: boolean;
}

export const DEFAULT_BAG: Club[] = [
  { name: 'Driver', yds: 230, sdYds: 18, sdDeg: 6.5, on: true },
  { name: '3 Wood', yds: 210, sdYds: 16, sdDeg: 6, on: true },
  { name: 'Hybrid', yds: 190, sdYds: 14, sdDeg: 5.5, on: true },
  { name: '5 Iron', yds: 172, sdYds: 12, sdDeg: 5.5, on: false },
  { name: '6 Iron', yds: 162, sdYds: 11, sdDeg: 5, on: true },
  { name: '7 Iron', yds: 152, sdYds: 10, sdDeg: 5, on: true },
  { name: '8 Iron', yds: 141, sdYds: 9, sdDeg: 4.5, on: true },
  { name: '9 Iron', yds: 130, sdYds: 8, sdDeg: 4.5, on: true },
  { name: 'PW', yds: 118, sdYds: 7, sdDeg: 4.5, on: true },
  { name: 'GW', yds: 102, sdYds: 7, sdDeg: 4.5, on: true },
  { name: 'SW', yds: 85, sdYds: 7, sdDeg: 5, on: true },
  { name: 'LW', yds: 65, sdYds: 7, sdDeg: 5.5, on: false },
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
  trackShots?: boolean; // false = quick scoring by default
}

export type TeeSet = 'back' | 'middle' | 'forward';

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
}

export interface State {
  version: 1;
  settings: Settings;
  bag: Club[];
  plans: Record<number, HolePlan>;
  pins: Record<number, XY>; // pin positions for planning (default: mapped pin)
  rounds: Round[];
  activeRoundId: string | null;
  conditions: Conditions; // last weather used for planning
}

const KEY = 'cedarcrest.v1';

export function freshState(): State {
  return {
    version: 1,
    settings: { handicap: 15, teeSet: 'middle', exaggerate: 1.5, simulateGps: false, useMyNumbers: true, showWind: false, onboarded: false, trackShots: true, measureHint: true, ratings: {}, lastBackup: null, leftHanded: false, stimp: 10, wet: 'auto' },
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

export function migrate(s: Partial<State>): State {
  const base = freshState();
  return { ...base, ...s, settings: { ...base.settings, ...(s.settings ?? {}) }, bag: s.bag?.length ? s.bag : base.bag } as State;
}

/** Called when the phone refuses to save (for example, storage is full). */
export let onSaveError: (e: unknown) => void = (e) => console.error('save failed', e);
export function setSaveErrorHandler(fn: (e: unknown) => void) { onSaveError = fn; }

/** Save right away: the data is small, and a delayed save can be lost if the app is closed. */
export function saveState(s: State, storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(KEY, JSON.stringify(s)); } catch (e) { onSaveError(e); }
}
export function saveNow(s: State) { saveState(s); }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
