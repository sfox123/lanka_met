// Assembles what the dashboard needs in one payload.
import { CFG, blendRisk, gpiRate, modelSignal, riskLevel, satProbability } from '../shared/risk';
import type { AppState, EstateForecast, EstateState, FrameMeta, LeadRisk, Nowcast } from '../shared/types';
import { getIngestStatus, getNowcast } from './ingest';
import { getMasks } from './masks';
import { peekForecast } from './openmeteo';
import { listFrames } from './store';

function hourIndex(fc: EstateForecast, tMs: number): number {
  // hourly values describe the hour ending at the timestamp for precipitation; pick the nearest slot
  const times = fc.hourly.time;
  let best = -1;
  let bestD = 45 * 60000;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(Date.parse(times[i]) - tMs);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function estateStateFor(slug: string, frames: FrameMeta[], nowcast: Nowcast | null, fc: EstateForecast | undefined, nowMs: number): EstateState {
  const ok = frames.filter((f) => f.estates?.[slug]);
  const latest = ok[ok.length - 1];
  const current = latest?.estates?.[slug] ?? null;
  let trend1h: number | null = null;
  if (latest) {
    const target = Date.parse(latest.t) - 3600e3;
    const ref = ok.find((f) => Math.abs(Date.parse(f.t) - target) <= 16 * 60000);
    if (ref?.estates?.[slug]) trend1h = Math.round((current!.mean - ref.estates[slug].mean) * 1000) / 1000;
  }
  const satProb = current ? satProbability(current, trend1h) : null;
  // satellite observations older than 2 h say little about now
  const satFresh = latest ? nowMs - Date.parse(latest.t) < 2.5 * 3600e3 : false;

  const model = (tMs: number) => {
    if (!fc) return null;
    const i = hourIndex(fc, tMs);
    return i < 0 ? null : modelSignal(fc.hourly.precipitation_probability[i], fc.hourly.precipitation[i]);
  };

  const risks: LeadRisk[] = [];
  if (latest) {
    const base = Date.parse(latest.t);
    risks.push({ ...blendRisk(0, satFresh ? satProb : null, model(base)), t: latest.t });
    const nc = nowcast?.baseId === latest.id ? nowcast.estates.find((e) => e.slug === slug) : undefined;
    for (const lead of nc?.leads ?? []) {
      const t = base + lead.leadMin * 60000;
      risks.push({ ...blendRisk(lead.leadMin, satFresh ? satProbability(lead) : null, model(t)), t: new Date(t).toISOString() });
    }
  }
  // model-only hours after the nowcast window, out to 24 h from now
  if (fc) {
    const after = risks.length ? Date.parse(risks[risks.length - 1].t) : nowMs - 3600e3;
    const base = latest ? Date.parse(latest.t) : nowMs;
    for (let i = 0; i < fc.hourly.time.length; i++) {
      const t = Date.parse(fc.hourly.time[i]);
      if (t <= after || t > nowMs + 24 * 3600e3) continue;
      const m = modelSignal(fc.hourly.precipitation_probability[i], fc.hourly.precipitation[i]);
      risks.push({ ...blendRisk(Math.round((t - base) / 60000), null, m), t: fc.hourly.time[i] });
    }
  }
  // headline: the worst risk between now (minus a little slack) and three hours ahead
  const window = risks.filter((r) => {
    const t = Date.parse(r.t);
    return t >= nowMs - 30 * 60000 && t <= nowMs + 3 * 3600e3;
  });
  const pool = window.length ? window : risks.slice(-1);
  const risk3h = pool.reduce((m, r) => Math.max(m, r.risk), 0);

  let rain24h: number | null = null;
  if (fc) {
    rain24h = 0;
    for (let i = 0; i < fc.hourly.time.length; i++) {
      const t = Date.parse(fc.hourly.time[i]);
      if (t > nowMs && t <= nowMs + 24 * 3600e3) rain24h += fc.hourly.precipitation[i] ?? 0;
    }
    rain24h = Math.round(rain24h * 10) / 10;
  }
  return { slug, current, trend1h, satProb, gpi: current ? gpiRate(current) : null, risks, risk3h, level: riskLevel(risk3h), rain24h };
}

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

export { CFG };
