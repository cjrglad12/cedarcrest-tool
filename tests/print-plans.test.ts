import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Course, dist, toYds, teeFor } from '../src/course';
import { CALM } from '../src/conditions';
import { buildPlan } from '../src/advice';
import { freshState } from '../src/store';
it.skipIf(!process.env.PRINT)('prints plans', () => {
  const data = JSON.parse(readFileSync('public/data/course.json', 'utf8'));
  const raw = readFileSync('public/data/terrain.bin'), can = readFileSync('public/data/canopy.bin');
  const course = new Course(data, new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2), new Uint8Array(can.buffer, can.byteOffset, can.byteLength));
  const bag = freshState().bag;
  let tot = 0;
  for (const h of course.holes) {
    const t = teeFor(h, 'gold').center;
    const p = buildPlan({ course, hole: h, from: t, lie: 'tee', pin: h.pin, cond: CALM, bag, handicap: 15 });
    let from = t;
    const s = p.steps.map((x) => { const d = Math.round(toYds(dist(from, x.target))); from = x.target; return `${x.club} ${d} (${course.lieAt(x.target, h)}${course.treeAt(...x.target) ? ' tree' + course.treeAt(...x.target) : ''}, off ${course.offLine(x.target, h).toFixed(0)}m)`; }).join(' → ');
    tot += p.expected;
    console.log(`#${h.ref} par ${h.par} E=${p.expected.toFixed(2)}  ${s}`);
  }
  console.log('expected total', tot.toFixed(1));
});
