// Satellite data for a point picked on the map. The estates get their cloud statistics from the
// server; for any other place the browser works them out from the same 8-bit fields it already
// has for the map: the pixels within 12 km of the point, for every frame, plus the same
// cloud-motion nowcast the map shows.
import { DOMAINS, POINT_RADIUS_KM, POINT_SLUG, domainPx, pxKm } from '../shared/geo';
import { CFG, cloudStats } from '../shared/risk';
import type { CloudStats, FrameMeta, Nowcast } from '../shared/types';
import type { FieldEngine } from './engine';

const D = DOMAINS.sl;

/** Indices of the Sri Lanka field pixels within `radiusKm` of a lon/lat. */
function pixelsAround(lon: number, lat: number, radiusKm: number): number[] {
  const [fx, fy] = domainPx(D, lon, lat);
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  const km = pxKm(D, lat);
  const rx = Math.ceil(radiusKm / km.x);
  const ry = Math.ceil(radiusKm / km.y);
  const out: number[] = [];
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= D.width || y >= D.height) continue;
      if ((dx * km.x) ** 2 + (dy * km.y) ** 2 <= radiusKm ** 2) out.push(y * D.width + x);
    }
  }
  return out;
}

export interface PointData {
  /** the frames whose field has loaded, each carrying the point's statistics under POINT_SLUG */
  frames: FrameMeta[];
  /** the cloud-motion nowcast at the point, when the last two frames allow one */
  nowcast: Nowcast | null;
  /** frames still downloading */
  pending: number;
}

/**
 * Cloud statistics at a point for every frame given, shaped like an estate's so the same panels
 * and risk rules apply. Frames not downloaded yet are requested and counted as pending.
 */
export function buildPointData(engine: FieldEngine, frames: FrameMeta[], lon: number, lat: number, withNowcast: boolean): PointData {
  const idx = pixelsAround(lon, lat, POINT_RADIUS_KM);
  const ir = frames.filter((f) => f.status === 'ok' && f.channels.ir1);
  const out: FrameMeta[] = [];
  let pending = 0;
  for (const f of ir) {
    const field = engine.get('ir1', 'sl', f.id);
    if (field === undefined) {
      void engine.load('ir1', 'sl', f.id);
      pending++;
    } else if (field && idx.length) {
      out.push({ ...f, estates: { [POINT_SLUG]: cloudStats(field, idx) } });
    }
  }

  let nowcast: Nowcast | null = null;
  const last = ir[ir.length - 1];
  const prev = ir[ir.length - 2];
  if (withNowcast && last && prev && out[out.length - 1]?.id === last.id && engine.flow('sl', prev, last)) {
    const scratch = new Uint8Array(D.width * D.height);
    const leads: (CloudStats & { leadMin: number })[] = [];
    for (const leadMin of CFG.nowcastLeads) {
      const info = engine.render(ir, 'ir1', 'sl', Date.parse(last.t) + leadMin * 60000, true, scratch, true);
      if (info.ready && info.kind === 'nowcast') leads.push({ ...cloudStats(scratch, idx), leadMin });
    }
    if (leads.length) {
      nowcast = { baseId: last.id, createdAt: new Date().toISOString(), from: [prev.id, last.id], motion: { speedKmh: 0, heading: 0 }, estates: [{ slug: POINT_SLUG, leads }], island: [] };
    }
  }
  return { frames: out, nowcast, pending };
}
