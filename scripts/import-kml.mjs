// Converts the estate KML files (data/*.kml or data/kml/*.kml) into:
//   public/data/estates.geojson  – simplified land-use polygons for the map
//   data/estates.json            – one summary record per estate (centroid, area, land use)
// Run with:  npm run import-kml
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [path.join(root, 'data'), path.join(root, 'data', 'kml')];
const files = dirs
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => fs.readdirSync(d).filter((f) => /\.kml$/i.test(f)).map((f) => path.join(d, f)));

if (!files.length) {
  console.error('No KML files found in data/ or data/kml/');
  process.exit(1);
}

const TOL = 0.00004; // ~4.5 m simplification tolerance (degrees)

function parseCoords(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((t) => t.split(',').map(Number))
    .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(([x, y]) => [x, y]);
}

// Douglas–Peucker on an open line
function simplifyLine(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(ring) {
  if (ring.length < 5) return ring;
  // split the closed ring at its farthest point so both halves simplify independently
  let far = 1;
  let farD = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(ring.slice(0, far + 1), TOL);
  const b = simplifyLine(ring.slice(far), TOL);
  const out = a.concat(b.slice(1)).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
  return out.length >= 4 ? out : ring.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
}

// signed planar area (ha) and centroid of a ring, using a local equirectangular approximation
function ringAreaCentroid(ring) {
  const lat0 = ring[0][1];
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.574;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * kx;
    const y1 = ring[i][1] * ky;
    const x2 = ring[i + 1][0] * kx;
    const y2 = ring[i + 1][1] * ky;
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  a /= 2;
  if (Math.abs(a) < 1e-12) return { areaHa: 0, lon: ring[0][0], lat: ring[0][1] };
  return { areaHa: Math.abs(a) * 100, lon: cx / (6 * a) / kx, lat: cy / (6 * a) / ky };
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleCase = (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

const features = [];
const estates = [];

// Pass 1: work out a display name for every ESTATE attribute value. A file that holds a single
// estate lends its file name; a combined file (several ESTATE values) names only the estate
// whose attribute matches the file name. Anything else falls back to the attribute itself.
const docs = files.map((file) => {
  const xml = fs.readFileSync(file, 'utf8');
  const fileName = path.basename(file).replace(/\.kml$/i, '').replace(/\s+estate.*$/i, '').trim();
  const attrs = new Set([...xml.matchAll(/<SimpleData name="ESTATE">([^<]*)</g)].map((m) => m[1].trim()));
  return { file, xml, fileName, attrs };
});
const displayName = new Map();
for (const d of docs) {
  if (d.attrs.size <= 1) displayName.set([...d.attrs][0] ?? d.fileName, d.fileName);
}
for (const d of docs) {
  for (const a of d.attrs) {
    if (!displayName.has(a)) displayName.set(a, slugify(a) === slugify(d.fileName) ? d.fileName : titleCase(a));
  }
}

// Pass 2: collect polygons per estate, skipping polygons repeated across files.
const acc = new Map();
const seen = new Set();
for (const d of docs) {
  for (const pm of d.xml.match(/<Placemark[\s\S]*?<\/Placemark>/g) ?? []) {
    const prop = (k) => pm.match(new RegExp(`<SimpleData name="${k}">([^<]*)</SimpleData>`))?.[1]?.trim();
    const attr = prop('ESTATE') || d.fileName;
    const name = displayName.get(attr) ?? d.fileName;
    const slug = slugify(name);
    const lu = titleCase(prop('New_luse') || prop('LANDUSE') || 'Unclassified');
    for (const poly of pm.match(/<Polygon[\s\S]*?<\/Polygon>/g) ?? []) {
      const outer = poly.match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/)?.[1];
      if (!outer) continue;
      const rings = [parseCoords(outer)];
      for (const m of poly.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) {
        rings.push(parseCoords(m[1]));
      }
      if (rings[0].length < 4) continue;
      const key = `${slug}|${rings[0].length}|${rings[0][0].join(',')}|${rings[0][1].join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const o = ringAreaCentroid(rings[0]);
      let areaHa = o.areaHa;
      for (const hole of rings.slice(1)) areaHa -= ringAreaCentroid(hole).areaHa;
      areaHa = Math.max(0, areaHa);
      let e = acc.get(slug);
      if (!e) {
        e = { slug, name, landuse: new Map(), sumArea: 0, sumLon: 0, sumLat: 0, minLon: 180, minLat: 90, maxLon: -180, maxLat: -90, polyCount: 0 };
        acc.set(slug, e);
      }
      e.sumArea += areaHa;
      e.sumLon += o.lon * areaHa;
      e.sumLat += o.lat * areaHa;
      e.landuse.set(lu, (e.landuse.get(lu) ?? 0) + areaHa);
      for (const [x, y] of rings[0]) {
        if (x < e.minLon) e.minLon = x;
        if (x > e.maxLon) e.maxLon = x;
        if (y < e.minLat) e.minLat = y;
        if (y > e.maxLat) e.maxLat = y;
      }
      e.polyCount++;
      features.push({
        type: 'Feature',
        properties: { slug, estate: name, landuse: lu, areaHa: +areaHa.toFixed(2) },
        geometry: { type: 'Polygon', coordinates: rings.map(simplifyRing) },
      });
    }
  }
}

for (const e of acc.values()) {
  const { slug, name, sumArea, minLon, minLat, maxLon, maxLat, polyCount, landuse } = e;
  const centroid = [+(e.sumLon / sumArea).toFixed(5), +(e.sumLat / sumArea).toFixed(5)];
  // radius of the circle that encloses the estate's bounding box, measured from the centroid
  const kx = 111.32 * Math.cos((centroid[1] * Math.PI) / 180);
  const radiusKm = Math.max(
    ...[
      [minLon, minLat],
      [minLon, maxLat],
      [maxLon, minLat],
      [maxLon, maxLat],
    ].map(([x, y]) => Math.hypot((x - centroid[0]) * kx, (y - centroid[1]) * 110.574)),
  );
  estates.push({
    slug,
    name,
    centroid,
    bbox: [minLon, minLat, maxLon, maxLat].map((v) => +v.toFixed(5)),
    areaHa: +sumArea.toFixed(1),
    radiusKm: +radiusKm.toFixed(2),
    bufferKm: 12,
    polygons: polyCount,
    landuse: [...landuse.entries()]
      .map(([k, v]) => ({ name: k, areaHa: +v.toFixed(1) }))
      .sort((a, b) => b.areaHa - a.areaHa),
  });
  console.log(`${name.padEnd(14)} ${String(polyCount).padStart(5)} polygons  ${sumArea.toFixed(0).padStart(6)} ha  centroid ${centroid.join(', ')}  r=${radiusKm.toFixed(1)} km`);
}

estates.sort((a, b) => a.name.localeCompare(b.name));
fs.mkdirSync(path.join(root, 'public', 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'data', 'estates.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
fs.writeFileSync(path.join(root, 'data', 'estates.json'), JSON.stringify(estates, null, 2));
const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0);
console.log(`\nWrote public/data/estates.geojson (${kb(path.join(root, 'public', 'data', 'estates.geojson'))} KB, ${features.length} polygons) and data/estates.json (${estates.length} estates)`);
