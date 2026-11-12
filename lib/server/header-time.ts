// Reads the scan time printed in the header of an IMD image, e.g.
//   GMT:12-11-2026/(0530-0557)  IST:12-11-2026/(1100-1127)
// The server re-stamps Last-Modified every five minutes, so the header is the only reliable
// source of the scan time. The text is bright on black in a fixed-pitch-digit font, which makes
// a tiny template matcher enough: split the line into glyphs, classify the digit positions, and
// accept a scan start only when at least two of the four printed times (start/end, GMT/IST) agree.
import templates from './digit-templates.json';
import type { Decoded } from './process';

const BAND_TOP = 45;
const BAND_BOTTOM = 105;
const LEFT = 200; // skip the emblem
const INK = 110;
// "GMT:dd-mm-yyyy/(HHMM-HHMM)" → glyph offsets of the digits
const GROUP = 26;
const DAY = [4, 5];
const MONTH = [7, 8];
const YEAR = [10, 11, 12, 13];
const START = [16, 17, 18, 19];
const END = [21, 22, 23, 24];

const TW = templates.w;
const TH = templates.h;
const DIGITS = Object.entries(templates.digits as Record<string, { aspect: number; grid: number[] }>);

interface Glyph {
  x0: number;
  x1: number;
}

function classify(ink: Uint8Array, bw: number, bh: number, gl: Glyph): { digit: number; score: number } {
  let y0 = bh;
  let y1 = -1;
  for (let y = 0; y < bh; y++) {
    for (let x = gl.x0; x <= gl.x1; x++) {
      if (ink[y * bw + x]) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        break;
      }
    }
  }
  const w = gl.x1 - gl.x0 + 1;
  const h = y1 - y0 + 1;
  if (h < 8) return { digit: -1, score: 9 };
  const grid = new Float32Array(TW * TH);
  for (let j = 0; j < TH; j++) {
    for (let i = 0; i < TW; i++) {
      let acc = 0;
      for (let sj = 0; sj < 4; sj++) {
        for (let si = 0; si < 4; si++) {
          const y = Math.min(h - 1, Math.floor(((j + (sj + 0.5) / 4) / TH) * h));
          const x = Math.min(w - 1, Math.floor(((i + (si + 0.5) / 4) / TW) * w));
          acc += ink[(y0 + y) * bw + gl.x0 + x];
        }
      }
      grid[j * TW + i] = acc / 16;
    }
  }
  const aspect = w / h;
  let best = -1;
  let bestScore = Infinity;
  for (const [d, t] of DIGITS) {
    let s = 0;
    for (let k = 0; k < grid.length; k++) s += Math.abs(grid[k] - t.grid[k]);
    const score = s / grid.length + 0.6 * Math.abs(aspect - t.aspect);
    if (score < bestScore) {
      bestScore = score;
      best = +d;
    }
  }
  return { digit: best, score: bestScore };
}

/** Scan start (UTC) read from the image header, or null when it cannot be read with confidence. */
export function readHeaderTime(img: Decoded): Date | null {
  if (img.h < BAND_BOTTOM + 10 || img.w < LEFT + 400) return null;
  const bw = img.w;
  const isInk = (x: number, y: number) => {
    const i = (y * img.w + x) * 3;
    return img.data[i] > INK || img.data[i + 1] > INK || img.data[i + 2] > INK;
  };
  // the time stamp is the middle line of three: keep only its rows, so stray pixels from the
  // lines above and below cannot stretch a glyph's bounding box
  const rowInk = new Uint16Array(BAND_BOTTOM - BAND_TOP);
  for (let y = BAND_TOP; y < BAND_BOTTOM; y++) {
    for (let x = LEFT; x < bw; x += 2) if (isInk(x, y)) rowInk[y - BAND_TOP]++;
  }
  let top = 0;
  let bottom = -1;
  for (let y = 0, start = -1; y <= rowInk.length; y++) {
    const on = y < rowInk.length && rowInk[y] > 0;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (y - start > bottom - top + 1) {
        top = start;
        bottom = y - 1;
      }
      start = -1;
    }
  }
  if (bottom - top < 12) return null;
  const y0 = BAND_TOP + top;
  const bh = bottom - top + 1;

  const ink = new Uint8Array(bw * bh);
  const cols = new Uint16Array(bw);
  for (let y = 0; y < bh; y++) {
    for (let x = LEFT; x < bw; x++) {
      if (isInk(x, y + y0)) {
        ink[y * bw + x] = 1;
        cols[x]++;
      }
    }
  }
  const glyphs: Glyph[] = [];
  let start = -1;
  for (let x = LEFT; x <= bw; x++) {
    const on = x < bw && cols[x] > 0;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      glyphs.push({ x0: start, x1: x - 1 });
      start = -1;
    }
  }
  if (glyphs.length < GROUP * 2) return null;

  const read = (base: number, offsets: number[]): number | null => {
    let v = 0;
    for (const o of offsets) {
      const { digit, score } = classify(ink, bw, bh, glyphs[base + o]);
      if (digit < 0 || score > 0.4) return null;
      v = v * 10 + digit;
    }
    return v;
  };
  const clock = (d: number | null, m: number | null, y: number | null, hm: number | null): number | null => {
    if (d == null || m == null || y == null || hm == null) return null;
    const hh = Math.floor(hm / 100);
    const mm = hm % 100;
    if (d < 1 || d > 31 || m < 1 || m > 12 || y < 2020 || y > 2100 || hh > 23 || mm > 59) return null;
    return Date.UTC(y, m - 1, d, hh, mm);
  };
  // The header states the scan four times over: start and end, in GMT and in IST. Turn each
  // into a candidate scan start and accept a value that at least two of them agree on.
  const candidates: number[] = [];
  for (const [base, offsetMs] of [
    [0, 0],
    [GROUP, 5.5 * 3600e3],
  ] as [number, number][]) {
    const d = read(base, DAY);
    const m = read(base, MONTH);
    const y = read(base, YEAR);
    const startAt = clock(d, m, y, read(base, START));
    const endAt = clock(d, m, y, read(base, END));
    if (startAt != null) candidates.push(startAt - offsetMs);
    // a scan runs 27 minutes; the end can fall on the next calendar day only for the 23:30 scan
    if (endAt != null) candidates.push(endAt - offsetMs - 27 * 60000);
  }
  let best: number | null = null;
  let votes = 0;
  for (const c of candidates) {
    if (new Date(c).getUTCMinutes() % 30 !== 0) continue; // scans start on the hour and half hour
    const n = candidates.filter((x) => x === c).length;
    if (n > votes) {
      votes = n;
      best = c;
    }
  }
  return best != null && votes >= 2 ? new Date(best) : null;
}
