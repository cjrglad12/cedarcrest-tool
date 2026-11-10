import type { TeeSet } from './store';

/**
 * Printed card that matches the ratings already shipped with this app
 * (Black 71.7/133, Gold 69.3/128). Yardages are that card, not OpenStreetMap lengths.
 * Hole 10 is a par 4 from Black, Gold and Silver, and a par 5 from Ruby.
 * Replace this table if the pro shop card in hand is different.
 * Source cross-check: Golfify scorecard for Cedar Crest, Dallas, totals 6526 / 6130 / 5651 / 4969.
 */
export interface Plate {
  name: string;
  rating: number;
  slope: number;
  yards: number;
  par: number;
  stroke: number;
}

type Row = { stroke: number; par: number; rubyPar?: number; black: number; gold: number; silver: number; ruby: number };

const ROWS: Row[] = [
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

export const CARD_SOURCE = 'Published card matching Black 71.7/133 and Gold 69.3/128. Hole shape still comes from the map.';

const META: Record<TeeSet, { name: string; rating: number; slope: number }> = {
  black: { name: 'Black', rating: 71.7, slope: 133 },
  gold: { name: 'Gold', rating: 69.3, slope: 128 },
  silver: { name: 'Silver', rating: 67.6, slope: 123 },
  ruby: { name: 'Ruby', rating: 65.3, slope: 118 },
};

export const TEE_SETS: TeeSet[] = ['black', 'gold', 'silver', 'ruby'];

export function cardHole(ref: number, set: TeeSet): Plate {
  const row = ROWS[ref - 1];
  const meta = META[set];
  if (!row) return { ...meta, yards: 0, par: 4, stroke: ref };
  const par = set === 'ruby' && row.rubyPar ? row.rubyPar : row.par;
  return { ...meta, yards: row[set], par, stroke: row.stroke };
}

export function cardTotal(set: TeeSet): number {
  return ROWS.reduce((sum, row) => sum + row[set], 0);
}
