// Georeferencing for IMD's "3Dasiasec" Mercator display images, plus small geodesy helpers.
//   x = x0 + kx·lon            y = y0 − ky·ψ(lat)        ψ = Mercator latitude in degrees
// IMD publishes the same 2002×2242 picture in more than one horizontal extent (seen on
// 12 Nov 2026: kx 28.56 on the plain frames, 30.54 on the frames with city labels), so the
// ingest fits these four numbers to the dotted 10° grid lines of every frame — see
// lib/server/process.ts. The constants below are the plain layout, used as the reference grid
// for the output domains and as documentation of a known-good fit (< 1 px residual on all
// 11 grid lines; coastline check within 1 px, docs/calibration_check.png).

export const CAL = {
  layout: 'asiasec_2002x2242',
  width: 2002,
  height: 2242,
  x0: -1142.0,
  kx: 28.56,
  y0: 1912.0,
  ky: 32.635,
  headerRows: 240,
} as const;

const D2R = Math.PI / 180;

/** Mercator latitude ψ in degrees. */
export function psi(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / D2R;
}
export function latFromPsi(p: number): number {
  return (2 * Math.atan(Math.exp(p * D2R)) - Math.PI / 2) / D2R;
}

export interface Calibration {
  x0: number;
  kx: number;
  y0: number;
  ky: number;
}

/** Source-image pixel of a lon/lat (fractional, pixel centres at integer coordinates). */
export function srcPx(lon: number, lat: number, cal: Calibration = CAL): [number, number] {
  return [cal.x0 + cal.kx * lon, cal.y0 - cal.ky * psi(lat)];
}

export type DomainId = 'sl' | 'region';

export interface Domain {
  id: DomainId;
  label: string;
  west: number;
  east: number;
  south: number;
  north: number;
  /** output pixels per source pixel */
  scale: number;
  width: number;
  height: number;
}

function makeDomain(id: DomainId, label: string, west: number, east: number, south: number, north: number, scale: number): Domain {
  return {
    id,
    label,
    west,
    east,
    south,
    north,
    scale,
    width: Math.round((east - west) * CAL.kx * scale),
    height: Math.round((psi(north) - psi(south)) * CAL.ky * scale),
  };
}

export const DOMAINS: Record<DomainId, Domain> = {
  // Sri Lanka plus ~2° of surrounding sea, at the source resolution (~3.9 km / px)
  sl: makeDomain('sl', 'Sri Lanka', 77.5, 84.0, 4.5, 11.0, 1),
  // North Indian Ocean basin, at half resolution (~7.8 km / px) — used for systems and the wide view
  region: makeDomain('region', 'Indian Ocean', 60.0, 100.0, -5.0, 27.0, 0.5),
};

/** Fractional pixel position inside a domain grid (pixel centres at i + 0.5). */
export function domainPx(d: Domain, lon: number, lat: number): [number, number] {
  const x = ((lon - d.west) / (d.east - d.west)) * d.width;
  const y = ((psi(d.north) - psi(lat)) / (psi(d.north) - psi(d.south))) * d.height;
  return [x, y];
}

/** Lon/lat of the centre of pixel (i, j). */
export function domainLonLat(d: Domain, i: number, j: number): [number, number] {
  const lon = d.west + ((i + 0.5) / d.width) * (d.east - d.west);
  const p = psi(d.north) - ((j + 0.5) / d.height) * (psi(d.north) - psi(d.south));
  return [lon, latFromPsi(p)];
}

/** Ground size of one domain pixel at a latitude, in km. */
export function pxKm(d: Domain, lat: number): { x: number; y: number } {
  const c = 111.32 * Math.cos(lat * D2R);
  return { x: c / (CAL.kx * d.scale), y: c / (CAL.ky * d.scale) };
}

/** Corner coordinates in MapLibre image/canvas-source order: TL, TR, BR, BL. */
export function domainCorners(d: Domain): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [d.west, d.north],
    [d.east, d.north],
    [d.east, d.south],
    [d.west, d.south],
  ];
}

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial compass bearing from point 1 to point 2 (0 = north, 90 = east). */
export function bearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const y = Math.sin((lon2 - lon1) * D2R) * Math.cos(lat2 * D2R);
  const x = Math.cos(lat1 * D2R) * Math.sin(lat2 * D2R) - Math.sin(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lon2 - lon1) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Even–odd point-in-polygon test for a GeoJSON MultiPolygon coordinate array. */
export function inMultiPolygon(lon: number, lat: number, polys: number[][][][]): boolean {
  for (const poly of polys) {
    let inside = false;
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

/** Centre of Sri Lanka, used as the reference point for distances to weather systems. */
export const SL_CENTRE: [number, number] = [80.7, 7.75];
