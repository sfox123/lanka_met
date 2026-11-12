// The timeline has up to three stretches with different meaning — and different width per hour,
// because 3 hours of nowcast deserve more room than 3 hours of a 48-hour model outlook.
import { CFG } from '../shared/risk';
import type { FrameMeta, GridForecast } from '../shared/types';

export type TimeKind = 'observed' | 'nowcast' | 'model';

export interface TimeModel {
  t0: number;
  tLast: number;
  tNowcastEnd: number;
  tModelEnd: number;
  /** track fractions where each stretch ends */
  pObs: number;
  pNow: number;
}

export function buildTimeModel(frames: FrameMeta[], grid: GridForecast | null): TimeModel | null {
  const ir = frames.filter((f) => f.channels.ir1 && f.status === 'ok');
  if (!ir.length) return null;
  const tLast = Date.parse(ir[ir.length - 1].t);
  const first = Date.parse(ir[0].t);
  // a single frame still gets a short stretch so the track has something to show
  const t0 = first < tLast ? first : tLast - 30 * 60000;
  const hasNowcast = ir.length >= 2 && tLast - Date.parse(ir[ir.length - 2].t) <= 95 * 60000;
  const tNowcastEnd = hasNowcast ? tLast + CFG.nowcastLeads[CFG.nowcastLeads.length - 1] * 60000 : tLast;
  const gridEnd = grid?.time.length ? Date.parse(grid.time[grid.time.length - 1]) : 0;
  const tModelEnd = gridEnd > tNowcastEnd + 3600e3 ? gridEnd : tNowcastEnd;
  const hasModel = tModelEnd > tNowcastEnd;
  const wObs = 0.58;
  const wNow = hasNowcast ? 0.16 : 0;
  const wModel = hasModel ? 0.26 : 0;
  const sum = wObs + wNow + wModel;
  return { t0, tLast, tNowcastEnd, tModelEnd, pObs: wObs / sum, pNow: (wObs + wNow) / sum };
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
