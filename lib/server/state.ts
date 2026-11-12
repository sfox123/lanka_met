// Assembles what the dashboard needs in one payload.
import { estateStateFor } from '../shared/place-state';
import { CFG } from '../shared/risk';
import type { AppState } from '../shared/types';
import { getIngestStatus, getNowcast } from './ingest';
import { getMasks } from './masks';
import { peekForecast } from './openmeteo';
import { listFrames } from './store';

const IST_MS = 5.5 * 3600e3;
/** Sri Lanka calendar date (YYYY-MM-DD) of an instant. */
export const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);

/** Length of the live view. */
export const LIVE_HOURS = 24;

/**
 * Dashboard payload. Without a day (or with today's date) it is the live view: the last 24 hours
 * up to now. With an earlier Sri Lanka date it is that calendar day, 00:00–24:00.
 */
export async function buildState(day?: string | null): Promise<AppState> {
  const nowMs = Date.now();
  const all = await listFrames();
  const today = istDate(nowMs);
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day < today ? day : today;
  const live = d === today;
  const liveStart = nowMs - LIVE_HOURS * 3600e3;
  const dayStart = live ? liveStart : Date.parse(`${d}T00:00:00Z`) - IST_MS;
  const dayEnd = live ? nowMs : dayStart + 86400e3;
  const frames = all.filter((f) => {
    const t = Date.parse(f.t);
    return t >= dayStart && t <= dayEnd;
  });
  const ok = all.filter((f) => f.status === 'ok' && f.channels.ir1);
  const newest = ok[ok.length - 1];
  const nowcast = await getNowcast();
  const forecast = await peekForecast();
  const { estates } = getMasks();
  return {
    now: new Date(nowMs).toISOString(),
    day: d,
    dayStart: new Date(dayStart).toISOString(),
    dayEnd: new Date(dayEnd).toISOString(),
    today,
    days: [...new Set(ok.map((f) => istDate(Date.parse(f.t))))].sort(),
    hasOlder: ok.some((f) => Date.parse(f.t) < liveStart),
    latest: newest ? { id: newest.id, t: newest.t, fetchedAt: newest.fetchedAt } : null,
    frames,
    estates,
    estateState: estates.map((e) => estateStateFor(e.slug, all.slice(-8), nowcast, forecast?.estates.find((f) => f.slug === e.slug), nowMs)),
    nowcast,
    status: await getIngestStatus(),
    forecastFetchedAt: forecast?.fetchedAt ?? null,
  };
}

export { CFG, estateStateFor };
