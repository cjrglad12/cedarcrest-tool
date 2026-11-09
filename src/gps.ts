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
