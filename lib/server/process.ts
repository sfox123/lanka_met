// Turns an IMD display JPG into clean, georeferenced 8-bit fields.
import sharp from 'sharp';
import { CAL, DOMAINS, domainLonLat, psi, srcPx, type Calibration, type Domain } from '../shared/geo';

export interface Decoded {
  data: Buffer; // RGB, 3 bytes per pixel
  w: number;
  h: number;
}

export async function decodeJpeg(buf: Buffer): Promise<Decoded> {
  const { data, info } = await sharp(buf).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`unexpected channel count ${info.channels}`);
  return { data, w: info.width, h: info.height };
}

const lum = (img: Decoded, x: number, y: number) => {
  const i = (y * img.w + x) * 3;
  return (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
};

/** Strongest thin bright lines along one axis: [position, score], sorted by position. */
function gridLines(img: Decoded, vertical: boolean): number[] {
  const len = vertical ? img.w : img.h;
  const from = vertical ? 4 : CAL.headerRows + 12;
  const to = vertical ? img.w - 4 : img.h - 64;
  const score = new Float32Array(len);
  for (let p = from; p < to; p++) {
    let s = 0;
    let n = 0;
    if (vertical) {
      for (let y = CAL.headerRows + 12; y < img.h - 64; y += 2) {
        const c = lum(img, p, y);
        s += Math.max(0, Math.min(c - lum(img, p - 3, y), c - lum(img, p + 3, y)));
        n++;
      }
    } else {
      for (let x = 8; x < img.w - 8; x += 2) {
        const c = lum(img, x, p);
        s += Math.max(0, Math.min(c - lum(img, x, p - 3), c - lum(img, x, p + 3)));
        n++;
      }
    }
    score[p] = s / n;
  }
  const lines: number[] = [];
  for (let k = 0; k < 9; k++) {
    let best = 0;
    for (let p = from; p < to; p++) if (score[p] > score[best]) best = p;
    // a dotted grid line scores 50–100 here; cloud edges and labels stay under 10
    if (score[best] < 25) break;
    lines.push(best);
    for (let p = Math.max(0, best - 120); p < Math.min(len, best + 120); p++) score[p] = 0;
  }
  return lines.sort((x, y) => x - y);
}

function linearFit(xs: number[], ys: number[]): { a: number; b: number; maxErr: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(a + b * xs[i] - ys[i]));
  return { a, b, maxErr };
}

/**
 * Georeference one frame from its own dotted lat/lon grid.
 *
 * Longitude: the lines are evenly spaced, so spacing gives the scale; in every layout seen so
 * far the leftmost line is 50°E, and the fit is rejected if that reading gives an implausible
 * scale or origin. Latitude: Mercator spacing grows with latitude, so trying the lowest line
 * as 10°S, the equator or 10°N and keeping the best fit identifies the lines unambiguously.
 *
 * Returns the calibration, or a reason string for the review queue.
 */
export function calibrate(img: Decoded): Calibration | string {
  if (img.w !== CAL.width || img.h !== CAL.height) return `size ${img.w}×${img.h}, expected ${CAL.width}×${CAL.height}`;
  // the strip just above the data area is black in the known layouts
  let sum = 0;
  let n = 0;
  for (let y = CAL.headerRows - 10; y < CAL.headerRows - 2; y++) {
    for (let x = 100; x < img.w - 100; x += 7) {
      sum += lum(img, x, y);
      n++;
    }
  }
  if (sum / n > 40) return 'header strip is not where it used to be';

  const cols = gridLines(img, true);
  const rows = gridLines(img, false);
  if (cols.length < 4 || rows.length < 4) return `found only ${cols.length} longitude and ${rows.length} latitude grid lines`;
  const fx = linearFit(
    cols.map((_, i) => 50 + 10 * i),
    cols,
  );
  if (fx.maxErr > 2) return 'longitude grid lines are not evenly spaced';
  if (fx.b < 25 || fx.b > 34 || cols[0] < 80 || cols[0] > 420) return `unfamiliar longitude scale (${fx.b.toFixed(2)} px/°, first line at x=${cols[0]})`;

  let best: { a: number; b: number; maxErr: number } | null = null;
  const bottomUp = [...rows].reverse();
  for (const lowest of [-10, 0, 10]) {
    const f = linearFit(
      bottomUp.map((_, i) => psi(lowest + 10 * i)),
      bottomUp,
    );
    if (!best || f.maxErr < best.maxErr) best = f;
  }
  if (!best || best.maxErr > 2) return 'latitude grid lines do not fit a Mercator grid';
  if (-best.b < 28 || -best.b > 38) return `unfamiliar latitude scale (${(-best.b).toFixed(2)} px/°)`;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { x0: r(fx.a), kx: r(fx.b), y0: r(best.a), ky: r(-best.b) };
}

export interface CleanBox {
  grey: Uint8Array;
  x0: number;
  y0: number;
  w: number;
  h: number;
  cal: Calibration;
  /** grey-level percentiles of the cleaned box (QA of IMD's per-image stretch) */
  qa: { p01: number; p50: number; p99: number };
  maskedFraction: number;
  /** true when the frame carries city labels and markers (they are removed, less cleanly than lines) */
  labelled: boolean;
}

/**
 * Extract the source box that covers every domain, remove IMD's overlay graphics (coloured
 * coastlines, borders and city labels, white city markers, dotted white grid lines) and fill
 * the holes from surrounding pixels.
 */
export function cleanBox(img: Decoded, cal: Calibration): CleanBox {
  const r = DOMAINS.region;
  const [xa, ya] = srcPx(r.west, r.north, cal);
  const [xb, yb] = srcPx(r.east, r.south, cal);
  const x0 = Math.max(0, Math.floor(xa) - 2);
  const y0 = Math.max(CAL.headerRows + 1, Math.floor(ya) - 2);
  const x1 = Math.min(img.w - 1, Math.ceil(xb) + 2);
  const y1 = Math.min(img.h - 1, Math.ceil(yb) + 2);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const grey = new Uint8Array(w * h);
  const raw = new Uint8Array(w * h); // 1 = overlay pixel
  let orange = 0;

  for (let y = 0; y < h; y++) {
    let i = ((y + y0) * img.w + x0) * 3;
    for (let x = 0; x < w; x++, i += 3) {
      const R = img.data[i];
      const G = img.data[i + 1];
      const B = img.data[i + 2];
      const mx = R > G ? (R > B ? R : B) : G > B ? G : B;
      const mn = R < G ? (R < B ? R : B) : G < B ? G : B;
      grey[y * w + x] = (R + G + B + 1) / 3;
      if (mx - mn > 14) raw[y * w + x] = 1;
      if (R > 200 && G > 90 && G < 175 && B < 70) orange++;
    }
  }
  // orange text means the "city labels" variant, which also draws a white square at each city
  const labelled = orange > 400;
  if (labelled) maskMarkers(grey, raw, w, h);

  // JPEG chroma subsampling smears overlay colour into neighbours: grow the mask by one pixel
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!raw[y * w + x]) continue;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          if (xx >= 0 && xx < w) mask[yy * w + xx] = 1;
        }
      }
    }
  }
  // dotted grid lines every 10°: one pixel wide, masked with a one-pixel margin
  for (let lon = -180; lon <= 180; lon += 10) {
    const cx = Math.round(srcPx(lon, 0, cal)[0]) - x0;
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || x >= w) continue;
      for (let y = 0; y < h; y++) mask[y * w + x] = 1;
    }
  }
  for (let lat = -60; lat <= 60; lat += 10) {
    const cy = Math.round(srcPx(0, lat, cal)[1]) - y0;
    for (let y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= h) continue;
      mask.fill(1, y * w, y * w + w);
    }
  }

  // fill masked pixels inwards from valid neighbours
  let masked = 0;
  for (let i = 0; i < mask.length; i++) masked += mask[i];
  const maskedFraction = masked / mask.length;
  let frontier: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) frontier.push(i);
  for (let pass = 0; pass < 14 && frontier.length; pass++) {
    const filled: [number, number][] = [];
    const rest: number[] = [];
    for (const idx of frontier) {
      const x = idx % w;
      const y = (idx - x) / w;
      let s = 0;
      let n = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w || mask[yy * w + xx]) continue;
          s += grey[yy * w + xx];
          n++;
        }
      }
      if (n >= 2 || (n && pass > 3)) filled.push([idx, s / n]);
      else rest.push(idx);
    }
    for (const [idx, val] of filled) {
      grey[idx] = val;
      mask[idx] = 0;
    }
    frontier = rest;
  }

  const hist = new Uint32Array(256);
  for (let i = 0; i < grey.length; i++) hist[grey[i]]++;
  const pct = (p: number) => {
    let acc = 0;
    const target = grey.length * p;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  return { grey, x0, y0, w, h, cal, qa: { p01: pct(0.01), p50: pct(0.5), p99: pct(0.99) }, maskedFraction, labelled };
}

/**
 * City markers are solid white squares about 8 px across. Mask small, solid, near-white blobs
 * that stand out sharply from their surroundings; a marker sitting inside equally bright cloud
 * is left alone (and does no harm there).
 */
function maskMarkers(grey: Uint8Array, mask: Uint8Array, w: number, h: number): void {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const blob: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || grey[start] < 236) continue;
    seen[start] = 1;
    stack.push(start);
    blob.length = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (stack.length) {
      const idx = stack.pop() as number;
      const x = idx % w;
      const y = (idx - x) / w;
      // large bright areas are cloud: stop collecting once the blob is clearly too big
      if (blob.length <= 200) blob.push(idx);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const k of [idx - 1, idx + 1, idx - w, idx + w]) {
        if (k < 0 || k >= w * h || seen[k] || grey[k] < 236) continue;
        if ((k === idx - 1 && x === 0) || (k === idx + 1 && x === w - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 5 || bh < 5 || bw > 12 || bh > 12 || Math.abs(bw - bh) > 2 || blob.length < bw * bh * 0.85) continue;
    // contrast against a ring two pixels outside the blob
    let ring = 0;
    let rn = 0;
    for (let y = minY - 3; y <= maxY + 3; y++) {
      for (let x = minX - 3; x <= maxX + 3; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (x >= minX - 1 && x <= maxX + 1 && y >= minY - 1 && y <= maxY + 1) continue;
        if (mask[y * w + x]) continue;
        ring += grey[y * w + x];
        rn++;
      }
    }
    if (!rn || ring / rn > 205) continue;
    for (let y = minY - 1; y <= maxY + 1; y++) {
      for (let x = minX - 1; x <= maxX + 1; x++) {
        if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
      }
    }
  }
}

/** Resample the cleaned box onto a domain grid (bilinear; at scale 0.5 this averages 2×2 blocks). */
export function resample(box: CleanBox, d: Domain): Uint8Array {
  const out = new Uint8Array(d.width * d.height);
  // x is linear in longitude and y is linear in Mercator latitude, so both axes are separable
  const xs = new Float32Array(d.width);
  const ys = new Float32Array(d.height);
  for (let i = 0; i < d.width; i++) xs[i] = srcPx(domainLonLat(d, i, 0)[0], 0, box.cal)[0] - box.x0;
  for (let j = 0; j < d.height; j++) ys[j] = srcPx(0, domainLonLat(d, 0, j)[1], box.cal)[1] - box.y0;
  const { grey, w, h } = box;
  for (let j = 0; j < d.height; j++) {
    const y = Math.min(h - 1.001, Math.max(0, ys[j]));
    const yi = y | 0;
    const ty = y - yi;
    for (let i = 0; i < d.width; i++) {
      const x = Math.min(w - 1.001, Math.max(0, xs[i]));
      const xi = x | 0;
      const tx = x - xi;
      const a = grey[yi * w + xi];
      const b = grey[yi * w + xi + 1];
      const c = grey[(yi + 1) * w + xi];
      const e = grey[(yi + 1) * w + xi + 1];
      out[j * d.width + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty + 0.5;
    }
  }
  return out;
}

/** Mean absolute difference between two fields — used to spot re-published duplicates. */
export function fieldDifference(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
