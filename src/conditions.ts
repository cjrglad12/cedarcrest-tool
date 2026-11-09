// Weather (Open-Meteo) and "plays like" distance adjustments.

export interface Conditions {
  windMph: number;
  gustMph: number;
  windFrom: number; // degrees, meteorological (direction the wind blows FROM)
  tempF: number;
  fetchedAt: string | null; // null = entered by hand
  rain24in?: number; // rain in the last 24 hours, inches
  observedAt?: string; // when the weather service measured it
  /** The next few hours, for "wind picking up by 3 PM" style notes. */
  outlook?: { time: string; tempF: number; windMph: number; gustMph: number; windFrom: number; rainPct: number }[];
}

export const CALM: Conditions = { windMph: 0, gustMph: 0, windFrom: 180, tempF: 75, fetchedAt: null };

export async function fetchConditions(lat: number, lon: number): Promise<Conditions> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=mph&temperature_unit=fahrenheit' +
    '&hourly=precipitation,temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability' +
    '&precipitation_unit=inch&past_days=1&forecast_days=2&timezone=auto';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather unavailable (${res.status})`);
  const j = await res.json();
  const c = j.current;
  // Rain over the 24 hours before now.
  let rain24in = 0;
  const times: string[] = j.hourly?.time ?? [], rain: number[] = j.hourly?.precipitation ?? [];
  const now = c.time as string;
  const idx = times.findIndex((t) => t > now);
  const end = idx < 0 ? times.length : idx;
  for (let i = Math.max(0, end - 24); i < end; i++) rain24in += rain[i] ?? 0;
  const hz = j.hourly ?? {};
  const outlook = [];
  for (let i = end; i < Math.min(times.length, end + 6); i++) {
    outlook.push({ time: times[i], tempF: hz.temperature_2m?.[i], windMph: hz.wind_speed_10m?.[i], gustMph: hz.wind_gusts_10m?.[i], windFrom: hz.wind_direction_10m?.[i], rainPct: hz.precipitation_probability?.[i] ?? 0 });
  }
  return {
    windMph: c.wind_speed_10m, gustMph: c.wind_gusts_10m, windFrom: c.wind_direction_10m, tempF: c.temperature_2m,
    fetchedAt: new Date().toISOString(), observedAt: c.time, rain24in: Math.round(rain24in * 100) / 100, outlook,
  };
}

/** Wind relative to a shot heading. head > 0 = into the wind; cross > 0 = blowing left-to-right. */
export function windComponents(c: Conditions, shotBearing: number) {
  const rel = ((c.windFrom - shotBearing) * Math.PI) / 180;
  return { head: c.windMph * Math.cos(rel), cross: -c.windMph * Math.sin(rel) };
}

/**
 * How far a shot actually travels compared with calm, 70°F conditions.
 * Rules of thumb: into the wind costs ~1% per mph, downwind adds ~0.5% per mph,
 * and each 10°F adds or removes ~1.3%.
 */
export function carryFactor(c: Conditions, shotBearing: number): number {
  const { head } = windComponents(c, shotBearing);
  const wind = head > 0 ? -0.01 * head : -0.005 * head;
  const temp = 0.0013 * (c.tempF - 70);
  return Math.max(0.6, 1 + wind + temp);
}

/** Plays-like distance (m) for a target `d` meters away with `rise` meters of elevation change. */
export function playsLike(d: number, rise: number, c: Conditions, shotBearing: number): number {
  return (d + rise) / carryFactor(c, shotBearing);
}

export function compass(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Notable changes coming in the next few hours, in plain words (most important first). */
export function outlookNotes(c: Conditions): string[] {
  const o = c.outlook ?? [];
  const notes: string[] = [];
  const hourText = (t: string) => {
    const h = +t.slice(11, 13);
    return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const rain = o.slice(0, 4).find((h) => h.rainPct >= 40);
  if (rain) notes.push(`Rain likely around ${hourText(rain.time)} (${rain.rainPct}%)`);
  const windy = o.slice(0, 4).reduce<typeof o[number] | null>((m, h) => (!m || h.windMph > m.windMph ? h : m), null);
  if (windy && windy.windMph - c.windMph >= 5) notes.push(`Wind picking up to ${Math.round(windy.windMph)} mph by ${hourText(windy.time)}`);
  else if (windy && c.windMph - windy.windMph >= 5 && c.windMph >= 8) notes.push(`Wind easing to ${Math.round(windy.windMph)} mph by ${hourText(windy.time)}`);
  const turn = o.slice(0, 4).find((h) => h.windMph >= 6 && Math.abs(((h.windFrom - c.windFrom + 540) % 360) - 180) >= 60);
  if (turn && c.windMph >= 6) notes.push(`Wind turning to come from the ${compass(turn.windFrom)} by ${hourText(turn.time)}`);
  const later = o[3];
  if (later && Math.abs(later.tempF - c.tempF) >= 8) notes.push(`${later.tempF > c.tempF ? 'Warming' : 'Cooling'} to ${Math.round(later.tempF)}°F by ${hourText(later.time)}`);
  return notes;
}
