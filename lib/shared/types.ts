export type Channel = 'ir1' | 'vis' | 'wv';
export const CHANNELS: Channel[] = ['ir1', 'vis', 'wv'];
export const CHANNEL_LABEL: Record<Channel, string> = { ir1: 'Infrared', vis: 'Visible', wv: 'Water vapour' };

/** Cloud statistics over an area, all 0–1, from the IR cloud index. */
export interface CloudStats {
  /** mean cloud index */
  mean: number;
  /** highest cloud index */
  max: number;
  /** fraction of pixels that are cloudy (index ≥ cloud threshold) */
  cover: number;
  /** fraction with cold, high cloud tops (index ≥ cold threshold) */
  cold: number;
  /** fraction with very cold, deep convective tops */
  deep: number;
  /** convective intensity: mean of a ramp from the convective floor to its ceiling */
  conv: number;
}

export type SystemLevel = 'cluster' | 'watch' | 'organised';

/** A large cold-cloud cluster found in the regional field. */
export interface WeatherSystem {
  id: string;
  lon: number;
  lat: number;
  areaKm2: number;
  meanIdx: number;
  deepFrac: number;
  /** 0–1, minor/major axis ratio of the cluster (1 = circular) */
  roundness: number;
  /** cyclonic rotation estimate from cloud motion, 0–1 (0 when unknown) */
  spin: number;
  /** 0–1 organisation score — see lib/server/systems.ts */
  org: number;
  level: SystemLevel;
  distKm: number;
  /** compass bearing from Sri Lanka to the system */
  bearing: number;
  bbox: [number, number, number, number];
  /** movement over the last frame interval */
  speedKmh?: number;
  heading?: number;
  /** positive when the system is getting closer to Sri Lanka */
  closingKmh?: number;
  /** Open-Meteo surface analysis at the centre */
  model?: { pressure: number | null; wind: number | null; gust: number | null };
}

export interface FrameMeta {
  /** scan start, UTC, yyyyMMdd_HHmm */
  id: string;
  /** scan start as ISO string */
  t: string;
  fetchedAt: string;
  /** where the scan time came from: read off the image header, or estimated from the fetch time */
  timeSource?: 'header' | 'estimated';
  channels: Partial<Record<Channel, { sha256: string; bytes: number }>>;
  status: 'ok' | 'needs_review';
  reason?: string;
  /** per-frame georeferencing fitted to the image's own grid lines; labelled = city-label variant */
  geo?: { x0: number; kx: number; y0: number; ky: number; labelled: boolean };
  /** grey-level percentiles of the IR frame (QA of IMD's per-image stretch) */
  qa?: { p01: number; p50: number; p99: number };
  island?: CloudStats;
  domain?: CloudStats;
  estates?: Record<string, CloudStats>;
  systems?: WeatherSystem[];
  /** mean cloud motion over Sri Lanka since the previous frame */
  motion?: { speedKmh: number; heading: number };
}

export interface Estate {
  slug: string;
  name: string;
  centroid: [number, number];
  bbox: [number, number, number, number];
  areaHa: number;
  radiusKm: number;
  bufferKm: number;
  polygons: number;
  landuse: { name: string; areaHa: number }[];
}

export type RiskLevel = 'low' | 'moderate' | 'high' | 'very-high';

export interface LeadRisk {
  /** minutes ahead of the latest frame */
  leadMin: number;
  /** valid time, ISO UTC */
  t: string;
  sat: number | null;
  model: number | null;
  risk: number;
  level: RiskLevel;
}

export interface EstateNowcast {
  slug: string;
  leads: (CloudStats & { leadMin: number })[];
}

export interface Nowcast {
  baseId: string;
  createdAt: string;
  /** frames used for the motion estimate */
  from: string[];
  motion: { speedKmh: number; heading: number };
  estates: EstateNowcast[];
  island: (CloudStats & { leadMin: number })[];
}

export interface HourlyForecast {
  time: string[]; // ISO UTC
  precipitation: (number | null)[];
  precipitation_probability: (number | null)[];
  rain: (number | null)[];
  showers: (number | null)[];
  cloud_cover: (number | null)[];
  cloud_cover_low: (number | null)[];
  cloud_cover_mid: (number | null)[];
  cloud_cover_high: (number | null)[];
  cape: (number | null)[];
  relative_humidity_2m: (number | null)[];
  temperature_2m: (number | null)[];
  wind_speed_10m: (number | null)[];
  wind_direction_10m: (number | null)[];
  weather_code: (number | null)[];
}

export interface DailyForecast {
  time: string[]; // local dates
  precipitation_sum: (number | null)[];
  precipitation_probability_max: (number | null)[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  weather_code: (number | null)[];
}

export interface EstateForecast {
  slug: string;
  elevation: number | null;
  current: Record<string, number | null> & { time?: string };
  hourly: HourlyForecast;
  daily: DailyForecast;
}

export interface GridForecast {
  fetchedAt: string;
  west: number;
  east: number;
  south: number;
  north: number;
  cols: number;
  rows: number;
  time: string[]; // ISO UTC
  /** [hour][row·cols + col], row 0 = north */
  precipitation: number[][];
  cloud_cover: number[][];
}

export interface Climatology {
  /** mean monthly rainfall total (mm), index 0 = January */
  monthly: number[];
  years: [number, number];
}

export interface ForecastBundle {
  fetchedAt: string | null;
  estates: EstateForecast[];
  grid: GridForecast | null;
  climatology: Record<string, Climatology>;
  calls: number;
  error?: string;
}

export interface EstateState {
  slug: string;
  current: CloudStats | null;
  trend1h: number | null;
  satProb: number | null;
  /** GPI-style rough rain-rate guess (mm/h) — relative, not calibrated */
  gpi: number | null;
  risks: LeadRisk[];
  risk3h: number;
  level: RiskLevel;
  rain24h: number | null;
}

export interface IngestStatus {
  running: boolean;
  lastRun: string | null;
  lastOk: string | null;
  lastMessage: string;
  log: { ts: string; ok: boolean; message: string }[];
}

export interface AppState {
  now: string;
  frames: FrameMeta[];
  estates: Estate[];
  estateState: EstateState[];
  nowcast: Nowcast | null;
  status: IngestStatus;
  forecastFetchedAt: string | null;
}
