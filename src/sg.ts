// Strokes gained: expected strokes to hole out from a distance and lie.
// Baseline is the PGA Tour table from Mark Broadie's "Every Shot Counts",
// scaled up for a handicap golfer (an approximation, labeled as such in the UI).
import type { Lie } from './course';

type Row = [number, number];
// Distances in yards (putts in feet). Values = average strokes to hole out.
const T: Record<'tee' | 'fairway' | 'rough' | 'sand' | 'recovery', Row[]> = {
  tee: [[100, 2.92], [120, 2.99], [140, 2.97], [160, 2.99], [180, 3.05], [200, 3.12], [220, 3.17], [240, 3.25], [260, 3.45], [280, 3.65], [300, 3.71], [320, 3.79], [340, 3.86], [360, 3.92], [380, 3.96], [400, 3.99], [420, 4.02], [440, 4.08], [460, 4.17], [480, 4.28], [500, 4.41], [520, 4.54], [540, 4.65], [560, 4.74], [580, 4.79], [600, 4.82], [700, 5.2]],
  fairway: [[0, 1.5], [5, 2.1], [10, 2.18], [20, 2.4], [40, 2.6], [60, 2.7], [80, 2.75], [100, 2.8], [120, 2.85], [140, 2.91], [160, 2.98], [180, 3.08], [200, 3.19], [220, 3.32], [240, 3.45], [260, 3.58], [280, 3.69], [300, 3.78], [320, 3.84], [340, 3.88], [360, 3.95], [380, 4.03], [400, 4.11], [450, 4.25], [500, 4.53], [550, 4.82], [600, 4.94], [700, 5.3]],
  rough: [[0, 1.6], [5, 2.15], [10, 2.34], [20, 2.59], [40, 2.78], [60, 2.91], [80, 2.96], [100, 3.02], [120, 3.08], [140, 3.15], [160, 3.23], [180, 3.31], [200, 3.42], [220, 3.53], [240, 3.64], [260, 3.74], [280, 3.83], [300, 3.9], [320, 3.95], [340, 4.02], [360, 4.11], [380, 4.21], [400, 4.3], [450, 4.43], [500, 4.72], [550, 5.01], [600, 5.13], [700, 5.5]],
  sand: [[0, 2.2], [5, 2.43], [10, 2.43], [20, 2.53], [40, 2.82], [60, 3.15], [80, 3.24], [100, 3.23], [120, 3.21], [140, 3.22], [160, 3.28], [180, 3.4], [200, 3.55], [220, 3.7], [240, 3.84], [260, 3.93], [280, 4.0], [300, 4.04], [350, 4.3], [400, 4.69], [500, 5.11], [600, 5.52], [700, 5.9]],
  recovery: [[0, 2.6], [20, 3.12], [40, 3.15], [60, 3.21], [80, 3.28], [100, 3.38], [120, 3.3], [140, 3.48], [160, 3.62], [180, 3.69], [200, 3.75], [220, 3.86], [240, 3.94], [260, 4.06], [280, 4.15], [300, 4.24], [350, 4.4], [400, 4.6], [500, 5.03], [600, 5.43], [700, 5.8]],
};
const PUTT: Row[] = [[0, 1.0], [2, 1.01], [3, 1.04], [4, 1.13], [5, 1.23], [6, 1.34], [7, 1.42], [8, 1.5], [9, 1.56], [10, 1.61], [15, 1.78], [20, 1.87], [30, 1.98], [40, 2.06], [50, 2.14], [60, 2.21], [90, 2.4], [150, 2.7]];

function interp(rows: Row[], x: number): number {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    if (x <= rows[i][0]) {
      const [x0, y0] = rows[i - 1], [x1, y1] = rows[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return rows[rows.length - 1][1];
}

/** Tour-average strokes to hole out. `yds` is yards to the pin; on the green we convert to feet. */
export function tourExpected(yds: number, lie: Lie): number {
  if (lie === 'green') return interp(PUTT, yds * 3);
  if (lie === 'tee') return yds < 100 ? interp(T.fairway, yds) : interp(T.tee, yds);
  if (lie === 'water' || lie === 'ob') return interp(T.rough, yds) + 1; // caller should apply the penalty properly
  return interp(T[lie], yds);
}

/** Scale the tour baseline toward a handicap golfer. ~+16 strokes per round at 15 handicap. */
export function expected(yds: number, lie: Lie, handicap: number): number {
  const e = tourExpected(yds, lie);
  return 1 + (e - 1) * (1 + 0.02 * Math.max(-8, handicap));
}

export type Category = 'ott' | 'app' | 'arg' | 'putt';
export const CATEGORY_LABEL: Record<Category, string> = { ott: 'Off the tee', app: 'Approach', arg: 'Around the green', putt: 'Putting' };

export function categorize(shotIndex: number, par: number, startLie: Lie, startYds: number): Category {
  if (startLie === 'green') return 'putt';
  if (shotIndex === 0 && par >= 4) return 'ott';
  if (startYds <= 50) return 'arg';
  return 'app';
}
