// Finds large cold-cloud clusters in the regional field and scores how organised they look.
//
// The organisation score is a heuristic for "does this look like a developing low / cyclone":
//   size       – cold-cloud shield area (15,000 → 200,000 km²)
//   roundness  – minor / major axis ratio of the shield (cyclones are compact, squall lines are not)
//   depth      – share of the shield with very cold (deep convective) tops
//   spin       – cyclonic turning of the cloud motion around the centre
// scaled down near the equator, where the Coriolis force is too weak for cyclones to form.
// It is NOT an intensity estimate (no Dvorak analysis) — the UI says so.
import { DOMAINS, SL_CENTRE, bearingDeg, domainLonLat, haversineKm, pxKm } from '../shared/geo';
import { sampleFlow, type Flow } from '../shared/flow';
import { CFG, smoothstep } from '../shared/risk';
import type { WeatherSystem } from '../shared/types';

const MIN_AREA_KM2 = 8000;
const MAX_SYSTEMS = 8;

export function detectSystems(field: Uint8Array, flow: Flow | null, frameMinutes: number, prev: WeatherSystem[] | undefined, frameId: string): WeatherSystem[] {
  const d = DOMAINS.region;
  const { width: w, height: h } = d;
  const cold = Math.round(CFG.coldT * 255);
  const deep = Math.round(CFG.deepT * 255);

  // light 3×3 smoothing so thin bridges and speckle do not decide the cluster shapes
  const sm = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w) continue;
          s += field[yy * w + xx];
          n++;
        }
      }
      sm[y * w + x] = s / n;
    }
  }

  const rowArea = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const k = pxKm(d, domainLonLat(d, 0, y)[1]);
    rowArea[y] = k.x * k.y;
  }

  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const found: WeatherSystem[] = [];
  const o = new Float32Array(2);

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || sm[start] < cold) continue;
    seen[start] = 1;
    stack.push(start);
    let n = 0;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let sIdx = 0;
    let nDeep = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (stack.length) {
      const idx = stack.pop() as number;
      const x = idx % w;
      const y = (idx - x) / w;
      n++;
      area += rowArea[y];
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      sIdx += field[idx];
      if (field[idx] >= deep) nDeep++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (!seen[k] && sm[k] >= cold) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    if (area < MIN_AREA_KM2) continue;

    const cx = sx / n;
    const cy = sy / n;
    const [lon, lat] = domainLonLat(d, cx, cy);
    const k = pxKm(d, lat);
    // shape from second moments, in km
    const vxx = (sxx / n - cx * cx) * k.x * k.x;
    const vyy = (syy / n - cy * cy) * k.y * k.y;
    const vxy = (sxy / n - cx * cy) * k.x * k.y;
    const tr = vxx + vyy;
    const det = vxx * vyy - vxy * vxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = Math.max(0, tr / 2 - disc);
    const roundness = l1 > 0 ? Math.sqrt(l2 / l1) : 0;
    const deepFrac = nDeep / n;

    // motion and rotation from the cloud-motion field (field pixels per frame → km/h)
    let speedKmh: number | undefined;
    let heading: number | undefined;
    let closingKmh: number | undefined;
    let spin = 0;
    if (flow) {
      const perHour = 60 / frameMinutes;
      // average the flow over the cluster core for a steady estimate
      let mu = 0;
      let mv = 0;
      let mn = 0;
      const rPx = Math.sqrt(n / Math.PI);
      for (let a = 0; a < 12; a++) {
        for (const rr of [0.3, 0.6]) {
          sampleFlow(flow, cx + Math.cos((a * Math.PI) / 6) * rPx * rr, cy + Math.sin((a * Math.PI) / 6) * rPx * rr, o);
          mu += o[0];
          mv += o[1];
          mn++;
        }
      }
      mu /= mn;
      mv /= mn;
      const east = mu * k.x * perHour;
      const north = -mv * k.y * perHour;
      speedKmh = Math.hypot(east, north);
      heading = (Math.atan2(east, north) * 180) / Math.PI;
      if (heading < 0) heading += 360;
      // component of the motion that points at Sri Lanka
      const toSl = (bearingDeg(lon, lat, SL_CENTRE[0], SL_CENTRE[1]) * Math.PI) / 180;
      closingKmh = east * Math.sin(toSl) + north * Math.cos(toSl);
      // tangential motion around the centre, relative to the cluster's own movement
      let tang = 0;
      let tn = 0;
      for (let a = 0; a < 16; a++) {
        for (const rr of [0.7, 1.0, 1.3]) {
          const ang = (a * Math.PI) / 8;
          const rx = Math.cos(ang) * rPx * rr;
          const ry = Math.sin(ang) * rPx * rr; // image y (south positive)
          const px = cx + rx;
          const py = cy + ry;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          sampleFlow(flow, px, py, o);
          const ue = (o[0] - mu) * k.x * perHour;
          const vn = -(o[1] - mv) * k.y * perHour;
          const re = rx * k.x;
          const rn = -ry * k.y;
          const len = Math.hypot(re, rn) || 1;
          tang += (ue * -rn + vn * re) / len; // counter-clockwise positive
          tn++;
        }
      }
      const ccw = tn ? tang / tn : 0;
      const cyclonic = lat >= 0 ? ccw : -ccw;
      spin = smoothstep(4, 25, cyclonic);
    }

    const sizeScore = smoothstep(15000, 200000, area);
    const depthScore = smoothstep(0.08, 0.55, deepFrac);
    const coriolis = smoothstep(3, 6.5, Math.abs(lat));
    const org = coriolis * (0.35 * sizeScore + 0.25 * roundness + 0.25 * depthScore + 0.15 * spin) + (1 - coriolis) * 0.25 * (sizeScore + depthScore) * 0.5;
    const [west, north] = domainLonLat(d, minX - 0.5, minY - 0.5);
    const [east, south] = domainLonLat(d, maxX + 0.5, maxY + 0.5);
    const r2 = (x: number) => Math.round(x * 100) / 100;

    found.push({
      id: '',
      lon: r2(lon),
      lat: r2(lat),
      areaKm2: Math.round(area / 100) * 100,
      meanIdx: r2(sIdx / n / 255),
      deepFrac: r2(deepFrac),
      roundness: r2(roundness),
      spin: r2(spin),
      org: r2(org),
      level: org < 0.45 ? 'cluster' : org < 0.7 ? 'watch' : 'organised',
      distKm: Math.round(haversineKm(SL_CENTRE[0], SL_CENTRE[1], lon, lat)),
      bearing: Math.round(bearingDeg(SL_CENTRE[0], SL_CENTRE[1], lon, lat)),
      bbox: [r2(west), r2(south), r2(east), r2(north)],
      speedKmh: speedKmh == null ? undefined : Math.round(speedKmh),
      heading: heading == null ? undefined : Math.round(heading),
      closingKmh: closingKmh == null ? undefined : Math.round(closingKmh),
    });
  }

  found.sort((a, b) => b.areaKm2 - a.areaKm2);
  const top = found.slice(0, MAX_SYSTEMS);
  // carry identities forward from the previous frame: closest pairs first, within 300 km
  const pairs: { s: WeatherSystem; p: WeatherSystem; dist: number }[] = [];
  for (const s of top) {
    for (const p of prev ?? []) {
      const dist = haversineKm(s.lon, s.lat, p.lon, p.lat);
      if (dist < 300) pairs.push({ s, p, dist });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);
  const used = new Set<string>();
  for (const { s, p } of pairs) {
    if (s.id || used.has(p.id)) continue;
    s.id = p.id;
    used.add(p.id);
  }
  let counter = 0;
  for (const s of top) {
    if (s.id) continue;
    do s.id = `${frameId}-${++counter}`;
    while (used.has(s.id));
    used.add(s.id);
  }
  return top;
}
