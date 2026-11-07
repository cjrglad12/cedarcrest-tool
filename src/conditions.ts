// Weather (Open-Meteo) and "plays like" distance adjustments.

export interface Conditions {
  windMph: number;
  gustMph: number;
  windFrom: number; // degrees, meteorological (direction the wind blows FROM)
  tempF: number;
  fetchedAt: string | null; // null = entered by hand
}

export const CALM: Conditions = { windMph: 0, gustMph: 0, windFrom: 180, tempF: 75, fetchedAt: null };

export async function fetchConditions(lat: number, lon: number): Promise<Conditions> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=mph&temperature_unit=fahrenheit';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather unavailable (${res.status})`);
  const c = (await res.json()).current;
  return { windMph: c.wind_speed_10m, gustMph: c.wind_gusts_10m, windFrom: c.wind_direction_10m, tempF: c.temperature_2m, fetchedAt: new Date().toISOString() };
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
