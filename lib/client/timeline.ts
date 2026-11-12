// Live, the timeline covers the last 24 hours of frames (starting at the oldest one available,
// so the track is never mostly empty), then continues into the nowcast and the model forecast —
// each stretch with its own width per hour, because 3 hours of nowcast deserve more room than
// 3 hours of a 48-hour outlook. A past day is exactly 00:00–24:00 of recorded frames.
import { CFG } from '../shared/risk';
import type { FrameMeta, GridForecast } from '../shared/types';

export type TimeKind = 'observed' | 'nowcast' | 'model';

export interface TimeModel {
  live: boolean;
  t0: number;
  tLast: number;
  tNowcastEnd: number;
  tModelEnd: number;
  /** track fractions where each stretch ends */
  pObs: number;
  pNow: number;
}

export interface DayWindow {
  /** bounds of the view, UTC ms: now−24 h … now when live, 00:00 … 24:00 for a past day */
  start: number;
  end: number;
  live: boolean;
  /** current time (only used when the live day has no frames yet) */
  now: number;
}

export function buildTimeModel(frames: FrameMeta[], grid: GridForecast | null, win: DayWindow): TimeModel {
  if (!win.live) return { live: false, t0: win.start, tLast: win.end, tNowcastEnd: win.end, tModelEnd: win.end, pObs: 1, pNow: 1 };
  const ir = frames.filter((f) => f.channels.ir1 && f.status === 'ok' && Date.parse(f.t) >= win.start);
  const tLast = ir.length ? Date.parse(ir[ir.length - 1].t) : win.now;
  // start at the oldest frame in the window; a lone frame still gets a short stretch to sit on
  const t0 = Math.min(ir.length ? Date.parse(ir[0].t) : tLast, tLast - 30 * 60000);
  const hasNowcast = ir.length >= 2 && tLast - Date.parse(ir[ir.length - 2].t) <= 95 * 60000;
  const tNowcastEnd = hasNowcast ? tLast + CFG.nowcastLeads[CFG.nowcastLeads.length - 1] * 60000 : tLast;
  const gridEnd = grid?.time.length ? Date.parse(grid.time[grid.time.length - 1]) : 0;
  const tModelEnd = gridEnd > tNowcastEnd + 3600e3 ? gridEnd : tNowcastEnd;
  const hasModel = tModelEnd > tNowcastEnd;
  const wObs = 0.58;
  const wNow = hasNowcast ? 0.16 : 0;
  const wModel = hasModel ? 0.26 : 0;
  const sum = wObs + wNow + wModel;
  return { live: true, t0, tLast, tNowcastEnd, tModelEnd, pObs: wObs / sum, pNow: (wObs + wNow) / sum };
}

export function posOf(tm: TimeModel, t: number): number {
  if (t <= tm.tLast) return Math.max(0, ((t - tm.t0) / (tm.tLast - tm.t0)) * tm.pObs);
  if (t <= tm.tNowcastEnd) return tm.pObs + ((t - tm.tLast) / (tm.tNowcastEnd - tm.tLast)) * (tm.pNow - tm.pObs);
  if (tm.tModelEnd <= tm.tNowcastEnd) return 1;
  return Math.min(1, tm.pNow + ((t - tm.tNowcastEnd) / (tm.tModelEnd - tm.tNowcastEnd)) * (1 - tm.pNow));
}

export function timeOf(tm: TimeModel, p: number): number {
  p = Math.min(1, Math.max(0, p));
  if (p <= tm.pObs) return tm.t0 + (p / tm.pObs) * (tm.tLast - tm.t0);
  if (p <= tm.pNow && tm.pNow > tm.pObs) return tm.tLast + ((p - tm.pObs) / (tm.pNow - tm.pObs)) * (tm.tNowcastEnd - tm.tLast);
  if (tm.pNow >= 1) return tm.tNowcastEnd;
  return tm.tNowcastEnd + ((p - tm.pNow) / (1 - tm.pNow)) * (tm.tModelEnd - tm.tNowcastEnd);
}

export function kindAt(tm: TimeModel, t: number): TimeKind {
  return t <= tm.tLast ? 'observed' : t <= tm.tNowcastEnd ? 'nowcast' : 'model';
}

/** Index of the model hour closest to t. */
export function gridHour(grid: GridForecast, t: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < grid.time.length; i++) {
    const d = Math.abs(Date.parse(grid.time[i]) - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const IST_MS = 5.5 * 3600e3;
/** Sri Lanka calendar date (YYYY-MM-DD) of an instant. */
export const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
/** The Sri Lanka date `n` days after `day`. */
export function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
}
