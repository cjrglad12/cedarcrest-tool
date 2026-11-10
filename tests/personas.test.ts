import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Course, dist, toYds, teeFor } from '../src/course';
import { CALM } from '../src/conditions';
import { buildPlan, suggest } from '../src/advice';
import { freshState } from '../src/store';
import { effectiveBag } from '../src/stats';
it.skipIf(!process.env.PRINT)('personas', () => {
  const data = JSON.parse(readFileSync('public/data/course.json', 'utf8'));
  const raw = readFileSync('public/data/terrain.bin'), can = readFileSync('public/data/canopy.bin'), gr = readFileSync('public/data/greens.bin');
  const course = new Course(data, new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2), new Uint8Array(can.buffer, can.byteOffset, can.byteLength), new Uint16Array(gr.buffer, gr.byteOffset, gr.byteLength / 2));
  const personas: [string, number, number, 'black' | 'gold' | 'ruby'][] = [['Beginner', 36, 175, 'ruby'], ['Senior', 22, 190, 'ruby'], ['Mid 15', 15, 230, 'gold'], ['Low 3', 3, 265, 'black'], ['Pro +3', -3, 300, 'black']];
  for (const [name, hcp, drv, tees] of personas) {
    const st = freshState();
    st.settings.handicap = hcp;
    const k = drv / 230;
    st.bag = st.bag.map((c) => ({ ...c, yds: Math.round(c.yds * k) }));
    const bag = effectiveBag(st, []);
    let tot = 0;
    const lines: string[] = [];
    for (const h of course.holes) {
      const t = teeFor(h, tees).center;
      const p = buildPlan({ course, hole: h, from: t, lie: 'tee', pin: h.pin, cond: CALM, bag, handicap: hcp });
      tot += p.expected;
      if ([1, 3, 4, 8].includes(h.ref)) {
        let from = t;
        const s = p.steps.map((x) => { const d = Math.round(toYds(dist(from, x.target))); from = x.target; return `${x.club} ${d}→${course.lieAt(x.target, h)}`; }).join(', ');
        lines.push(`  #${h.ref} par ${h.par} ${teeFor(h, tees).lengthYds}y E=${p.expected.toFixed(2)}: ${s}`);
      }
    }
    // Par 3 #3 tee options, to see water respect
    const h3 = course.hole(3), t3 = teeFor(h3, tees).center;
    const o = suggest({ course, hole: h3, from: t3, lie: 'tee', pin: h3.pin, cond: CALM, bag, handicap: hcp }, 3);
    console.log(`${name} (hcp ${hcp}, driver ${drv}, ${tees} tees): expected round ${tot.toFixed(1)}\n${lines.join('\n')}\n  #3 options: ${o.map((x) => `${x.club} E${x.expected.toFixed(2)} green ${Math.round(x.pGreen * 100)}% trouble ${Math.round(x.pTrouble * 100)}%`).join(' | ')}`);
  }
});
