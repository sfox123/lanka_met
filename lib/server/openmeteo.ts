// Open-Meteo client: estate forecasts, a 0.25° grid over Sri Lanka, ERA5 climatology and
// spot analyses at weather-system centres. Results are cached on disk and refreshed every 3 h.
// Weather data by Open-Meteo.com (CC BY 4.0). The free tier is for non-commercial use.
import { getMasks } from './masks';
import { readJson, storagePath, writeJson } from './store';
import type { Climatology, DailyForecast, EstateForecast, ForecastBundle, GridForecast, HourlyForecast, WeatherSystem } from '../shared/types';

const BASE = process.env.OPEN_METEO_BASE ?? 'https://api.open-meteo.com';
const ARCHIVE = process.env.OPEN_METEO_ARCHIVE ?? 'https://archive-api.open-meteo.com';
const REFRESH_MS = 3 * 3600 * 1000;
const UA = { 'User-Agent': process.env.LANKAMET_USER_AGENT ?? 'LankaMet/0.1 (Sri Lanka cloud & rain dashboard)' };

const HOURLY: (keyof HourlyForecast)[] = [
  'precipitation',
  'precipitation_probability',
  'rain',
  'showers',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'cape',
  'relative_humidity_2m',
  'temperature_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'weather_code',
];
const DAILY = ['precipitation_sum', 'precipitation_probability_max', 'temperature_2m_max', 'temperature_2m_min', 'weather_code'];
const CURRENT = ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'precipitation', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl', 'weather_code', 'is_day'];

// 0.25° grid covering the island
const GRID = { west: 79.25, east: 82.25, south: 5.5, north: 10.0, step: 0.25 };

interface Shared {
  bundle: ForecastBundle | null;
  pending: Promise<ForecastBundle> | null;
  callsToday: { day: string; n: number };
}
const g = globalThis as unknown as { __lankamet_om?: Shared };
const shared: Shared = (g.__lankamet_om ??= { bundle: null, pending: null, callsToday: { day: '', n: 0 } });

async function getJson(url: string, weight: number): Promise<any> {
  const day = new Date().toISOString().slice(0, 10);
  if (shared.callsToday.day !== day) shared.callsToday = { day, n: 0 };
  // stay far below the 10,000 calls/day free-tier limit
  if (shared.callsToday.n + weight > 8000) throw new Error('Open-Meteo daily call budget reached');
  shared.callsToday.n += weight;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const asList = (j: any): any[] => (Array.isArray(j) ? j : [j]);

async function fetchEstates(): Promise<EstateForecast[]> {
  const { estates } = getMasks();
  if (!estates.length) return [];
  const url =
    `${BASE}/v1/forecast?latitude=${estates.map((e) => e.centroid[1]).join(',')}&longitude=${estates.map((e) => e.centroid[0]).join(',')}` +
    `&hourly=${HOURLY.join(',')}&daily=${DAILY.join(',')}&current=${CURRENT.join(',')}` +
    `&timezone=Asia%2FColombo&timeformat=unixtime&past_days=1&forecast_days=7`;
  const list = asList(await getJson(url, estates.length * 2));
  return list.map((loc, i) => {
    const hourly = { time: (loc.hourly.time as number[]).map(iso) } as HourlyForecast;
    for (const k of HOURLY) (hourly as any)[k] = loc.hourly[k] ?? [];
    const off = loc.utc_offset_seconds ?? 19800;
    const daily = { time: (loc.daily.time as number[]).map((t) => iso(t + off).slice(0, 10)) } as DailyForecast;
    for (const k of DAILY) (daily as any)[k] = loc.daily[k] ?? [];
    const current: EstateForecast['current'] = {};
    for (const k of CURRENT) current[k] = loc.current?.[k] ?? null;
    if (loc.current?.time) current.time = iso(loc.current.time);
    return { slug: estates[i].slug, elevation: loc.elevation ?? null, current, hourly, daily };
  });
}

async function fetchGrid(): Promise<GridForecast> {
  const cols = Math.round((GRID.east - GRID.west) / GRID.step) + 1;
  const rows = Math.round((GRID.north - GRID.south) / GRID.step) + 1;
  const lats: number[] = [];
  const lons: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lats.push(GRID.north - r * GRID.step);
      lons.push(GRID.west + c * GRID.step);
    }
  }
  const url = `${BASE}/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&hourly=precipitation,cloud_cover&timeformat=unixtime&forecast_days=3`;
  const list = asList(await getJson(url, lats.length));
  const all = (list[0].hourly.time as number[]).map(iso);
  // keep from the current hour to +48 h
  const from = Math.max(0, all.findIndex((t) => Date.parse(t) >= Date.now() - 3600e3));
  const to = Math.min(all.length, from + 49);
  const time = all.slice(from, to);
  const pick = (key: string) =>
    time.map((_, hi) => list.map((loc) => Math.round(((loc.hourly[key]?.[from + hi] as number | null) ?? 0) * 10) / 10));
  return {
    fetchedAt: new Date().toISOString(),
    west: GRID.west - GRID.step / 2,
    east: GRID.east + GRID.step / 2,
    south: GRID.south - GRID.step / 2,
    north: GRID.north + GRID.step / 2,
    cols,
    rows,
    time,
    precipitation: pick('precipitation'),
    cloud_cover: pick('cloud_cover'),
  };
}

/** Mean monthly rainfall per estate from ERA5 (Open-Meteo Historical Weather API). Fetched once. */
async function getClimatology(): Promise<Record<string, Climatology>> {
  const file = storagePath('climatology.json');
  const cached = await readJson<{ data: Record<string, Climatology>; triedAt?: string } | null>(file, null);
  const { estates } = getMasks();
  if (cached && estates.every((e) => cached.data[e.slug])) return cached.data;
  if (cached?.triedAt && Date.now() - Date.parse(cached.triedAt) < 24 * 3600e3) return cached.data;
  const y1 = new Date().getUTCFullYear() - 1;
  const y0 = y1 - 9;
  const data: Record<string, Climatology> = { ...(cached?.data ?? {}) };
  try {
    const url =
      `${ARCHIVE}/v1/archive?latitude=${estates.map((e) => e.centroid[1]).join(',')}&longitude=${estates.map((e) => e.centroid[0]).join(',')}` +
      `&start_date=${y0}-01-01&end_date=${y1}-12-31&daily=precipitation_sum&timezone=Asia%2FColombo`;
    const list = asList(await getJson(url, estates.length * 30));
    list.forEach((loc, i) => {
      const sums = new Array(12).fill(0);
      (loc.daily.time as string[]).forEach((day, k) => {
        sums[+day.slice(5, 7) - 1] += loc.daily.precipitation_sum[k] ?? 0;
      });
      data[estates[i].slug] = { monthly: sums.map((s) => Math.round(s / (y1 - y0 + 1))), years: [y0, y1] };
    });
  } catch (err) {
    console.warn('[lankamet] climatology fetch failed:', (err as Error).message);
  }
  await writeJson(file, { data, triedAt: new Date().toISOString() });
  return data;
}

async function refresh(): Promise<ForecastBundle> {
  const before = shared.callsToday.n;
  const prev = shared.bundle ?? (await readJson<ForecastBundle | null>(storagePath('forecast.json'), null));
  try {
    const [estates, grid] = await Promise.all([fetchEstates(), fetchGrid()]);
    const climatology = await getClimatology();
    const bundle: ForecastBundle = { fetchedAt: new Date().toISOString(), estates, grid, climatology, calls: shared.callsToday.n - before };
    await writeJson(storagePath('forecast.json'), bundle);
    return bundle;
  } catch (err) {
    const message = (err as Error).message;
    console.warn('[lankamet] Open-Meteo refresh failed:', message);
    // keep serving the previous forecast, flagged with the error
    return { ...(prev ?? { fetchedAt: null, estates: [], grid: null, climatology: {}, calls: 0 }), error: message };
  }
}

/** Latest forecast bundle; refreshes when older than 3 h (or when forced). Never throws. */
export async function getForecast(force = false): Promise<ForecastBundle> {
  if (!shared.bundle) shared.bundle = await readJson<ForecastBundle | null>(storagePath('forecast.json'), null);
  const b = shared.bundle;
  const { estates } = getMasks();
  const fresh = b?.fetchedAt && Date.now() - Date.parse(b.fetchedAt) < REFRESH_MS && estates.every((e) => b.estates.some((f) => f.slug === e.slug));
  // after a failure, wait 10 minutes before trying again
  const backoff = b?.error && (b as any).__failedAt && Date.now() - (b as any).__failedAt < 600e3;
  if ((fresh || backoff) && !force) return b as ForecastBundle;
  if (!shared.pending) {
    shared.pending = refresh()
      .then((nb) => {
        if (nb.error) (nb as any).__failedAt = Date.now();
        shared.bundle = nb;
        return nb;
      })
      .finally(() => {
        shared.pending = null;
      });
  }
  // serve stale data immediately when we have it; otherwise wait for the first fetch
  return b && b.estates.length && !force ? b : shared.pending;
}

/** Cached bundle only — never triggers a network call. */
export async function peekForecast(): Promise<ForecastBundle | null> {
  if (!shared.bundle) shared.bundle = await readJson<ForecastBundle | null>(storagePath('forecast.json'), null);
  return shared.bundle;
}

/** Surface pressure and wind from the model at the centre of each system (one request). */
export async function annotateSystems(systems: WeatherSystem[]): Promise<void> {
  const top = systems.slice(0, 5);
  if (!top.length) return;
  try {
    const url = `${BASE}/v1/forecast?latitude=${top.map((s) => s.lat).join(',')}&longitude=${top.map((s) => s.lon).join(',')}&current=pressure_msl,wind_speed_10m,wind_gusts_10m`;
    const list = asList(await getJson(url, top.length));
    list.forEach((loc, i) => {
      top[i].model = {
        pressure: loc.current?.pressure_msl ?? null,
        wind: loc.current?.wind_speed_10m ?? null,
        gust: loc.current?.wind_gusts_10m ?? null,
      };
    });
  } catch (err) {
    console.warn('[lankamet] system annotation failed:', (err as Error).message);
  }
}

export function openMeteoCallsToday(): number {
  return shared.callsToday.n;
}
