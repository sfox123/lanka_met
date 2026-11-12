// Estate list and precomputed pixel masks on the Sri Lanka domain.
import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS, domainLonLat, haversineKm, inMultiPolygon } from '../shared/geo';
import type { Estate } from '../shared/types';

interface Masks {
  estates: Estate[];
  /** pixel indices (sl domain) inside each estate's analysis area: estate extent + buffer */
  estatePixels: Record<string, Uint32Array>;
  /** pixel indices over the island of Sri Lanka */
  island: Uint32Array;
  mtime: number;
}

const g = globalThis as unknown as { __lankamet_masks?: Masks };

export function getMasks(): Masks {
  const file = path.join(process.cwd(), 'data', 'estates.json');
  const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  if (g.__lankamet_masks && g.__lankamet_masks.mtime === mtime) return g.__lankamet_masks;

  const estates: Estate[] = mtime ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const d = DOMAINS.sl;
  const estatePixels: Record<string, Uint32Array> = {};
  for (const e of estates) {
    const reach = e.radiusKm + e.bufferKm;
    const px: number[] = [];
    for (let j = 0; j < d.height; j++) {
      for (let i = 0; i < d.width; i++) {
        const [lon, lat] = domainLonLat(d, i, j);
        if (Math.abs(lat - e.centroid[1]) > 0.5 || Math.abs(lon - e.centroid[0]) > 0.5) continue;
        if (haversineKm(lon, lat, e.centroid[0], e.centroid[1]) <= reach) px.push(j * d.width + i);
      }
    }
    estatePixels[e.slug] = Uint32Array.from(px);
  }

  let island: number[] = [];
  try {
    const sl = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'data', 'sri-lanka.geojson'), 'utf8'));
    const polys = sl.geometry.coordinates as number[][][][];
    for (let j = 0; j < d.height; j++) {
      for (let i = 0; i < d.width; i++) {
        const [lon, lat] = domainLonLat(d, i, j);
        if (lon < 79.4 || lon > 82.1 || lat < 5.8 || lat > 9.95) continue;
        if (inMultiPolygon(lon, lat, polys)) island.push(j * d.width + i);
      }
    }
  } catch {
    island = [];
  }
  g.__lankamet_masks = { estates, estatePixels, island: Uint32Array.from(island), mtime };
  return g.__lankamet_masks;
}
