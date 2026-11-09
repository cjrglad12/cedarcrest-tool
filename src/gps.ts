// GPS helpers.
import type { XY } from './course';

/**
 * Blend the last few seconds of GPS readings: keep the sharpest ones and average them,
 * weighting each by how precise the phone says it is. Standing still for a few seconds
 * tightens the position noticeably.
 */
export function bestFix(fixes: { xy: XY; acc: number; at: number }[]) {
  if (!fixes.length) return null;
  const best = Math.min(...fixes.map((f) => f.acc));
  const good = fixes.filter((f) => f.acc <= best * 1.5 + 1);
  let w = 0, x = 0, y = 0;
  for (const f of good) { const k = 1 / (f.acc * f.acc); w += k; x += f.xy[0] * k; y += f.xy[1] * k; }
  // Averaging n independent readings shrinks the error by about √n.
  return { xy: [x / w, y / w] as XY, acc: best / Math.sqrt(good.length), at: Math.max(...good.map((f) => f.at)) };
}

/** Handicap index as golfers write it: plus handicaps (better than scratch) show as "+2.1". */
export function fmtHcp(h: number): string {
  const v = Math.round(Math.abs(h) * 10) / 10;
  return (h < 0 ? '+' : '') + (Number.isInteger(v) ? String(v) : v.toFixed(1));
}

/** Parse "12.4", "+2.1" or "-2.1" (both mean plus 2.1). Returns null if it isn't a handicap. */
export function parseHcp(text: string): number | null {
  const t = text.trim().replace(',', '.');
  const m = /^([+-]?)(\d{1,2}(?:\.\d)?)$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[2]);
  if (v > 54) return null;
  return m[1] ? -v : v;
}

/** A rough Handicap Index from a usual 18-hole score (for golfers who don't have one). */
export function handicapFromScore(score: number) {
  return Math.max(0, Math.min(54, Math.round((score - 72) * 0.85)));
}
