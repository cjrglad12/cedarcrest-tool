import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Course, CourseData, toYds, teeFor } from '../src/course';
import { COURSES, setActiveCourse, cardHole, TEE_SETS } from '../src/card';
import { migrate, setTee, switchCourse } from '../src/store';

function load(dir: string) {
  const base = new URL(`../public/${dir}`, import.meta.url);
  const data: CourseData = JSON.parse(readFileSync(new URL('course.json', base), 'utf8'));
  const raw = readFileSync(new URL('terrain.bin', base));
  const can = readFileSync(new URL('canopy.bin', base));
  return new Course(data, new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2), new Uint8Array(can.buffer, can.byteOffset, can.byteLength));
}

const courses = COURSES.filter((c) => existsSync(new URL(`../public/${c.path}course.json`, import.meta.url)));

describe.each(courses.map((c) => [c.id, c] as const))('%s', (id, info) => {
  const course = load(info.path);
  setActiveCourse(id);
  course.fitTeesToCard((ref) => TEE_SETS.map((t) => cardHole(ref, t).yards));
  beforeEach(() => setActiveCourse(id));

  it('has 18 holes whose pars match the card', () => {
    expect(course.holes.map((h) => h.ref)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    for (const h of course.holes) expect([cardHole(h.ref, 'black').par, cardHole(h.ref, 'ruby').par], `hole ${h.ref}`).toContain(h.par);
  });

  it('never reports a hazard reach or carry past the back of the green', () => {
    for (const h of course.holes) {
      for (const set of ['black', 'gold', 'silver', 'ruby'] as const) {
        const t = teeFor(h, set).center;
        const total = toYds(course.playLine(h, t).length);
        for (const z of course.hazards(h, t)) {
          expect(toYds(z.carry), `hole ${h.ref} ${set} ${z.id}`).toBeLessThanOrEqual(total + 45);
          expect(z.carry).toBeGreaterThanOrEqual(z.reach);
        }
      }
    }
  });

  it('mapped hole lengths are close to the card', () => {
    const off: string[] = [];
    for (const h of course.holes) {
      const card = cardHole(h.ref, 'gold').yards;
      const mapYds = teeFor(h, 'gold', card).lengthYds;
      if (Math.abs(mapYds - card) > Math.max(12, card * 0.03)) off.push(`${h.ref}: map ${Math.round(mapYds)} card ${card}`);
    }
    expect(off, off.join('; ')).toEqual([]);
  });
});

describe('the reported Sherrill carries', () => {
  const cases: [string, number, number][] = [['sherrill1', 5, 466], ['sherrill1', 10, 332], ['sherrill1', 12, 330], ['sherrill1', 17, 351], ['sherrill2', 8, 103], ['sherrill2', 7, 337]];
  for (const [id, ref, yds] of cases) {
    it(`${id} hole ${ref}: carries stay within the hole`, () => {
      const info = COURSES.find((c) => c.id === id)!;
      setActiveCourse(id as never);
      const course = load(info.path);
      const h = course.holes.find((x) => x.ref === ref)!;
      const t = teeFor(h, 'silver', yds).center;
      for (const z of course.hazards(h, t)) expect(toYds(z.carry), z.id).toBeLessThanOrEqual(yds + 40);
    });
  }
});

describe('tees are remembered per course', () => {
  it('keeps each course on its own tees', () => {
    const s = migrate({ settings: { teeSet: 'gold', courseId: 'cedar' } } as never);
    switchCourse(s, 'sherrill1');
    expect(s.settings.teeSet).toBe('gold');
    setTee(s, 'silver');
    switchCourse(s, 'cedar');
    expect(s.settings.teeSet).toBe('gold');
    switchCourse(s, 'sherrill1');
    expect(s.settings.teeSet).toBe('silver');
    const back = migrate(JSON.parse(JSON.stringify(s)));
    expect(back.settings.teeByCourse).toEqual({ cedar: 'gold', sherrill1: 'silver' });
  });
  it('keeps Waterchase as a course choice after reload', () => {
    expect(migrate({ settings: { courseId: 'waterchase' } } as never).settings.courseId).toBe('waterchase');
    expect(migrate({ settings: { courseId: 'nowhere' } } as never).settings.courseId).toBe('cedar');
  });
});
