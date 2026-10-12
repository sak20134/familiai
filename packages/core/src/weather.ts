// Weather from Open-Meteo: free, no account, no key. Picked from the public-apis catalogue
// because a family app is asked "will it rain?" more than anything else.

export const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST = 'https://api.open-meteo.com/v1/forecast';

export const geocodeUrl = (place: string): string =>
  `${GEOCODE}?name=${encodeURIComponent(place.trim())}&count=1&language=en&format=json`;

export const forecastUrl = (lat: number, lon: number): string =>
  `${FORECAST}?latitude=${lat}&longitude=${lon}` +
  '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
  '&forecast_days=3&timezone=auto';

export interface Place {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

/** Reads the first match out of a geocoding reply. */
export function firstPlace(json: unknown): Place | null {
  const results = (json as { results?: unknown[] } | null)?.results;
  const r = Array.isArray(results) ? (results[0] as Record<string, unknown> | undefined) : undefined;
  if (!r || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return null;
  return {
    name: typeof r.name === 'string' ? r.name : 'there',
    country: typeof r.country === 'string' ? r.country : '',
    latitude: r.latitude,
    longitude: r.longitude,
  };
}

/** Open-Meteo weather codes, in words a child would understand. */
export function describeWeather(code: number): string {
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code <= 48) return 'foggy';
  if (code <= 57) return 'drizzle';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'rain showers';
  if (code <= 86) return 'snow showers';
  return 'thunderstorms';
}

export interface Forecast {
  nowC: number | null;
  nowText: string;
  days: Array<{ date: string; minC: number; maxC: number; text: string; rainChance: number }>;
}

/** Turns the forecast reply into something the AI can read out in one or two sentences. */
export function readForecast(json: unknown): Forecast | null {
  const j = json as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] };
  } | null;
  const d = j?.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) return null;
  const days = d.time.slice(0, 3).map((date, i) => ({
    date,
    minC: Math.round(d.temperature_2m_min?.[i] ?? 0),
    maxC: Math.round(d.temperature_2m_max?.[i] ?? 0),
    text: describeWeather(d.weather_code?.[i] ?? 0),
    rainChance: Math.round(d.precipitation_probability_max?.[i] ?? 0),
  }));
  return {
    nowC: typeof j?.current?.temperature_2m === 'number' ? Math.round(j.current.temperature_2m) : null,
    nowText: describeWeather(j?.current?.weather_code ?? 0),
    days,
  };
}

/** One short line per day, ready to speak. */
export function forecastLines(place: Place, f: Forecast): string {
  const where = place.country ? `${place.name}, ${place.country}` : place.name;
  const now = f.nowC === null ? `${where}: ${f.nowText}` : `${where}: ${f.nowC}°C and ${f.nowText} right now`;
  const rest = f.days.map((day, i) => {
    const when = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : day.date;
    const rain = day.rainChance >= 30 ? `, ${day.rainChance}% chance of rain` : '';
    return `${when}: ${day.minC}–${day.maxC}°C, ${day.text}${rain}`;
  });
  return [now, ...rest].join('. ');
}
