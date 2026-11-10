export interface ClubLike { name: string; yds: number; on: boolean }

/** One caddie sentence for the club. No expected-score decimals. */
export function clubSentence(plays: number, clubs: ClubLike[]): string {
  const bag = clubs.filter((c) => c.on).sort((a, b) => a.yds - b.yds);
  if (!bag.length || plays < 30) return 'On the green.';
  const longer = bag.find((c) => c.yds >= plays - 3);
  const club = longer ?? bag[bag.length - 1]!;
  const prev = bag[bag.indexOf(club) - 1];
  const gap = club.yds - plays;
  if (prev && gap > 6 && plays - prev.yds <= 10) {
    return `${club.name}. Your ${short(club.name)} is ${club.yds} and this plays ${plays}, so it is a smooth ${short(club.name)} or a light ${short(prev.name)}.`;
  }
  if (Math.abs(gap) <= 4) return `${club.name}. Your ${short(club.name)} is ${club.yds} and this plays ${plays}.`;
  if (gap > 0) return `${club.name}. Your ${short(club.name)} is ${club.yds} and this plays ${plays}, so take a little off.`;
  if (gap < -12) return `${club.name}. Yours goes ${club.yds}.`;
  return `${club.name}. It plays ${plays} and your ${short(club.name)} is ${club.yds}, so it is a full ${short(club.name)} and then some.`;
}

/** Par 5 tee. One sentence, from the bag, not a fitting printout. */
export function par5Sentence(plays: number, clubs: ClubLike[]): string {
  const bag = clubs.filter((c) => c.on).sort((a, b) => b.yds - a.yds);
  if (bag.length < 2 || plays < 350) return '';
  const driver = bag[0]!;
  const rest = plays - driver.yds;
  const seconds = bag.filter((c) => c !== driver);
  const home = seconds.find((c) => c.yds + 15 >= rest);
  const lay = [...seconds].sort((a, b) => Math.abs(rest - a.yds - 100) - Math.abs(rest - b.yds - 100))[0]!;
  const leave = Math.max(40, Math.round(rest - lay.yds));
  if (home && home !== lay) return `You can get there in two with a ${home.name}, or lay up to about ${leave} with a ${lay.name}.`;
  if (home) return `You can get there in two with a ${home.name}.`;
  if (/wood|hybrid/i.test(lay.name) && leave < 160) return `Second shot is a ${lay.name}, leaving about ${leave}.`;
  return `Lay up with a ${lay.name} after the drive. That leaves about ${leave}.`;
}

export function decisionLines(d: { plays: number; raw: number; front: number; back: number; club: string; miss: string; wind: string; extra: string }): string[] {
  const lines = [`Plays ${d.plays}`, d.plays !== d.raw ? `${d.raw} yards` : '', `Front ${d.front}`, `Back ${d.back}`, d.club, d.miss, d.wind, d.extra];
  return lines.filter(Boolean);
}

/** True when copy still sounds like the fitting lab. */
export function looksLikeLab(text: string): boolean {
  return /expected score|strokes gained|stimpmeter|trees\/water\/ob/i.test(text) || /\b\d+\.\d{2}\b/.test(text);
}

function short(name: string): string {
  return name.replace(' Iron', '').replace(' Wood', 'W');
}
