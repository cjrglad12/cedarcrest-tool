import type { TeeSet } from './store';

/**
 * Printed cards. The header uses these yardages. The hole shape comes from the map.
 * Cedar Crest matches Black 71.7/133 and Gold 69.3/128.
 * Sherrill Park yardages are the pro-shop card. Ratings are the published men's tees
 * where a men's number is printed. Sherrill 2 forward uses the published forward rating.
 */
export type CourseId = 'cedar' | 'sherrill1' | 'sherrill2';

export interface Plate {
  name: string;
  rating: number;
  slope: number;
  yards: number;
  par: number;
  stroke: number;
}

type Row = { stroke: number; par: number; rubyPar?: number; black: number; gold: number; silver: number; ruby: number };
type Meta = Record<TeeSet, { name: string; rating: number; slope: number }>;

interface CourseCard {
  id: CourseId;
  name: string;
  path: string;
  source: string;
  meta: Meta;
  rows: Row[];
}

const cedarRows: Row[] = [
  { stroke: 2, par: 5, black: 602, gold: 584, silver: 561, ruby: 483 },
  { stroke: 17, par: 4, black: 356, gold: 336, silver: 323, ruby: 281 },
  { stroke: 3, par: 3, black: 202, gold: 174, silver: 160, ruby: 134 },
  { stroke: 6, par: 4, black: 463, gold: 434, silver: 415, ruby: 330 },
  { stroke: 13, par: 4, black: 382, gold: 367, silver: 343, ruby: 290 },
  { stroke: 10, par: 3, black: 185, gold: 169, silver: 153, ruby: 136 },
  { stroke: 9, par: 5, black: 547, gold: 501, silver: 445, ruby: 414 },
  { stroke: 16, par: 4, black: 312, gold: 295, silver: 289, ruby: 260 },
  { stroke: 12, par: 3, black: 178, gold: 165, silver: 139, ruby: 124 },
  { stroke: 1, par: 4, rubyPar: 5, black: 476, gold: 459, silver: 451, ruby: 443 },
  { stroke: 4, par: 3, black: 210, gold: 187, silver: 165, ruby: 137 },
  { stroke: 15, par: 4, black: 334, gold: 308, silver: 281, ruby: 274 },
  { stroke: 18, par: 4, black: 404, gold: 377, silver: 357, ruby: 348 },
  { stroke: 8, par: 5, black: 542, gold: 519, silver: 482, ruby: 423 },
  { stroke: 7, par: 3, black: 201, gold: 192, silver: 167, ruby: 128 },
  { stroke: 11, par: 5, black: 534, gold: 506, silver: 475, ruby: 415 },
  { stroke: 5, par: 3, black: 192, gold: 176, silver: 149, ruby: 120 },
  { stroke: 14, par: 4, black: 406, gold: 381, silver: 296, ruby: 229 },
];

function rows(spec: number[][]): Row[] {
  return spec.map(([par, stroke, black, gold, silver, ruby]) => ({ par, stroke, black, gold, silver, ruby }));
}

export const COURSES: CourseCard[] = [
  {
    id: 'cedar',
    name: 'Cedar Crest',
    path: 'data/',
    source: 'Printed card. Black 71.7/133, Gold 69.3/128. Hole 10 is a par 5 from the ruby tees only.',
    meta: {
      black: { name: 'Black', rating: 71.7, slope: 133 },
      gold: { name: 'Gold', rating: 69.3, slope: 128 },
      silver: { name: 'Silver', rating: 67.6, slope: 123 },
      ruby: { name: 'Ruby', rating: 65.3, slope: 118 },
    },
    rows: cedarRows,
  },
  {
    id: 'sherrill1',
    name: 'Sherrill 1',
    path: 'data/sherrill1/',
    source: 'Sherrill Park course 1 card. Pro 74.3/130, Champ 71.2/128, Middle 68.0/121, Forward 64.6/109.',
    meta: {
      black: { name: 'Pro', rating: 74.3, slope: 130 },
      gold: { name: 'Champ', rating: 71.2, slope: 128 },
      silver: { name: 'Middle', rating: 68.0, slope: 121 },
      ruby: { name: 'Forward', rating: 64.6, slope: 109 },
    },
    rows: rows([
      [5, 10, 524, 504, 484, 441],
      [4, 2, 389, 345, 303, 274],
      [3, 18, 197, 177, 142, 95],
      [4, 14, 336, 311, 295, 261],
      [5, 6, 541, 504, 466, 440],
      [3, 16, 177, 156, 139, 109],
      [4, 8, 423, 386, 350, 326],
      [4, 4, 437, 407, 321, 298],
      [4, 12, 403, 361, 328, 295],
      [4, 5, 412, 362, 332, 247],
      [5, 3, 524, 488, 459, 408],
      [4, 11, 400, 375, 330, 275],
      [3, 17, 174, 148, 123, 101],
      [5, 9, 599, 564, 515, 412],
      [3, 15, 188, 167, 125, 105],
      [4, 13, 436, 401, 342, 316],
      [4, 1, 433, 411, 351, 326],
      [4, 7, 423, 395, 321, 281],
    ]),
  },
  {
    id: 'sherrill2',
    name: 'Sherrill 2',
    path: 'data/sherrill2/',
    source: 'Sherrill Park course 2 card. Pro 71.1/132, Champ 68.7/127, Middle 66.8/124, Forward 66.7/114.',
    meta: {
      black: { name: 'Pro', rating: 71.1, slope: 132 },
      gold: { name: 'Champ', rating: 68.7, slope: 127 },
      silver: { name: 'Middle', rating: 66.8, slope: 124 },
      ruby: { name: 'Forward', rating: 66.7, slope: 114 },
    },
    rows: rows([
      [4, 8, 373, 347, 325, 247],
      [4, 4, 350, 331, 319, 265],
      [4, 6, 437, 417, 389, 344],
      [3, 17, 189, 170, 152, 120],
      [5, 2, 555, 543, 522, 462],
      [4, 13, 332, 313, 298, 277],
      [4, 9, 378, 363, 337, 262],
      [3, 18, 154, 135, 103, 83],
      [4, 7, 425, 401, 372, 331],
      [4, 11, 356, 338, 322, 282],
      [4, 3, 405, 390, 371, 310],
      [3, 14, 183, 163, 143, 122],
      [4, 10, 390, 325, 310, 270],
      [4, 12, 365, 348, 330, 290],
      [5, 1, 573, 530, 516, 492],
      [3, 15, 187, 157, 129, 112],
      [4, 16, 323, 301, 287, 253],
      [4, 5, 400, 362, 348, 288],
    ]),
  },
];

let active: CourseId = 'cedar';

export function courseList() { return COURSES; }
export function courseInfo(id: CourseId = active) { return COURSES.find((c) => c.id === id) ?? COURSES[0]; }
export function setActiveCourse(id: CourseId) { active = COURSES.some((c) => c.id === id) ? id : 'cedar'; }
export function activeCourse(): CourseId { return active; }

export const CARD_SOURCE = '';
export function cardSource() { return courseInfo().source; }

export const TEE_SETS: TeeSet[] = ['black', 'gold', 'silver', 'ruby'];

export function cardHole(ref: number, set: TeeSet): Plate {
  const card = courseInfo();
  const row = card.rows[ref - 1];
  const meta = card.meta[set];
  if (!row) return { ...meta, yards: 0, par: 4, stroke: ref };
  const par = set === 'ruby' && row.rubyPar ? row.rubyPar : row.par;
  return { ...meta, yards: row[set], par, stroke: row.stroke };
}

export function cardTotal(set: TeeSet): number {
  return courseInfo().rows.reduce((sum, row) => sum + row[set], 0);
}
