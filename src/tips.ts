// Plain-language tips for today's conditions, chosen for where you are (planning,
// on a shot, or on the green). Rules of thumb, not physics: kept short and specific.
import { Conditions, windComponents } from './conditions';

export type Wetness = 'auto' | 'wet' | 'dry';

export interface TipContext {
  cond: Conditions;
  wetSetting: Wetness;
  where: 'plan' | 'shot' | 'putt';
  shotYds?: number; // distance of the shot being played
  shotBearing?: number; // compass direction of the shot
  puttFt?: number;
  puttRiseIn?: number; // + uphill to the hole, inches
  stimp?: number;
  hour?: number; // local hour of day
}

export interface Tip { icon: string; text: string }

/** Wet if the player says so, or (on auto) if it rained a tenth of an inch or more in the last day. */
export function isWet(cond: Conditions, setting: Wetness) {
  if (setting !== 'auto') return setting === 'wet';
  return (cond.rain24in ?? 0) >= 0.1;
}

export function tipsFor(ctx: TipContext): Tip[] {
  const { cond, where } = ctx;
  const wet = isWet(cond, ctx.wetSetting);
  const out: Tip[] = [];
  const t = Math.round(cond.tempF);
  const yds = ctx.shotYds ?? 150;

  if (where !== 'putt') {
    if (t >= 85) {
      const pct = Math.round(0.13 * (t - 70));
      out.push({ icon: '🌡', text: `Hot (${t}°F): warm air is thinner, so the ball carries about ${pct}% farther than at 70°F, roughly ${Math.max(1, Math.round((yds * pct) / 100))} yds on a ${Math.round(yds)}-yd shot.${wet ? '' : ' Dry ground also runs out more.'}` });
    } else if (t <= 55) {
      const pct = Math.round(0.13 * (70 - t));
      out.push({ icon: '🥶', text: `Cold (${t}°F): the ball flies about ${pct}% shorter, roughly ${Math.max(1, Math.round((yds * pct) / 100))} yds on a ${Math.round(yds)}-yd shot. Take more club when it's close.` });
    }
    if (cond.windMph >= 6 && ctx.shotBearing !== undefined) {
      const { head, cross } = windComponents(cond, ctx.shotBearing);
      if (head >= 6) out.push({ icon: '💨', text: `Into the wind (${Math.round(head)} mph): about ${Math.round(head)}% shorter, ~${Math.round((yds * head) / 100)} yds here. Take more club and swing smoother; hitting harder adds spin and balloons it.` });
      else if (head <= -6) out.push({ icon: '💨', text: `Downwind (${Math.round(-head)} mph): it flies farther and lands with less spin, so it releases. Land it short of the pin.` });
      if (Math.abs(cross) >= 6) out.push({ icon: '↔️', text: `Crosswind from the ${cross > 0 ? 'left' : 'right'}: about ${Math.round((yds * Math.abs(cross)) / 100)} yds of drift on this shot. Aim ${cross > 0 ? 'left' : 'right'} of where you want it to finish.` });
    } else if (cond.windMph >= 10 && where === 'plan') {
      out.push({ icon: '💨', text: `Breezy (${Math.round(cond.windMph)} mph): plan on about 1% shorter per mph into it and half that helping. Lower, smoother swings hold their line.` });
    }
    if (cond.gustMph - cond.windMph >= 8) out.push({ icon: '🌬', text: `Gusty (up to ${Math.round(cond.gustMph)} mph): club for the gust on approaches over trouble, or wait for a lull.` });
    if (wet) out.push({ icon: '💧', text: `Wet course${cond.rain24in ? ` (${cond.rain24in}" of rain in the last day)` : ''}: drives roll out less, so plan on 10–20 yds less off the tee. Soft greens hold, so fly it closer to the pin.` });
    else if (t >= 85 && (cond.rain24in ?? 0) === 0 && where === 'plan') out.push({ icon: '☀️', text: 'Hot and dry: fairways run and greens firm up through the afternoon. Land approaches short and let them release.' });
  }

  if (where === 'putt') {
    const ft = ctx.puttFt ?? 20, rise = ctx.puttRiseIn ?? 0;
    if (wet) out.push({ icon: '💧', text: 'Wet greens roll slower and break less. On long putts, hit it firmer and play a bit less break than it looks.' });
    else if (t >= 85) out.push({ icon: '☀️', text: `Hot, dry greens (${t}°F) get faster as the day goes on, and faster greens break more. Favor the high side.` });
    if (rise <= -3) out.push({ icon: '⬇️', text: `Downhill (${Math.round(-rise)} in): it'll be quick and break more. Let it die at the hole and play extra break.` });
    else if (rise >= 3) out.push({ icon: '⬆️', text: `Uphill (${Math.round(rise)} in): be firm. A firmer putt breaks less, so play a little less break.` });
    if (ft >= 30) out.push({ icon: '🎯', text: 'From 30+ ft, pace matters more than line: get it inside a 3-ft circle.' });
    out.push({ icon: '🌱', text: 'Bermuda grain: shiny grass (down-grain) rolls faster, dull grass (into the grain) slower. Grain tends to grow toward the setting sun and toward drainage; the ragged edge of the cup is the down-grain side.' });
    if ((ctx.hour ?? 12) >= 15) out.push({ icon: '🌇', text: 'Late afternoon: bermuda grain is at its strongest, so down-grain putts are noticeably quicker.' });
  }
  return out.slice(0, where === 'plan' ? 4 : 3);
}

/** How wet ground changes total distance (less roll). */
export function groundFactor(club: string, wet: boolean, cond: Conditions) {
  const woods = club === 'Driver' || club.includes('Wood') || club === 'Hybrid';
  if (wet) return woods ? 0.94 : 0.98;
  if (cond.tempF >= 85 && (cond.rain24in ?? 0) === 0 && woods) return 1.02;
  return 1;
}
