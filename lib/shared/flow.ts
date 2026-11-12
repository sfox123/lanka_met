// Cloud-motion estimation and advection on small 8-bit fields.
// Pure TypeScript with no dependencies, so the same code runs in the ingest (nowcast, system
// tracking) and in the browser (motion-interpolated playback, particles, future frames).

export interface Flow {
  /** size of the field the flow was estimated on */
  w: number;
  h: number;
  /** coarse grid: node (gx, gy) sits at pixel (gx·step + step/2, gy·step + step/2) */
  gw: number;
  gh: number;
  step: number;
  /** displacement in field pixels per frame interval, previous → current */
  u: Float32Array;
  v: Float32Array;
}

export interface FlowOptions {
  /** search radius in pixels */
  radius?: number;
  /** half-size of the matching window */
  half?: number;
  /** spacing of flow nodes */
  step?: number;
}

function boxBlur(src: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Block-matching optical flow. For every node, find the shift of a window from `prev` that best
 * matches `cur` (sum of absolute differences, sub-pixel refined), then clean the vector field
 * with a confidence-weighted smoothing so featureless areas inherit their neighbours' motion.
 */
export function computeFlow(prev: ArrayLike<number>, cur: ArrayLike<number>, w: number, h: number, opts: FlowOptions = {}): Flow {
  const R = opts.radius ?? 6;
  const half = opts.half ?? 8;
  const step = opts.step ?? 6;
  const a = boxBlur(prev, w, h, 1);
  const b = boxBlur(cur, w, h, 1);
  const gw = Math.max(1, Math.floor(w / step));
  const gh = Math.max(1, Math.floor(h / step));
  const u = new Float32Array(gw * gh);
  const v = new Float32Array(gw * gh);
  const conf = new Float32Array(gw * gh);
  const side = 2 * R + 1;
  const sad = new Float32Array(side * side);

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cx = Math.floor(gx * step + step / 2);
      const cy = Math.floor(gy * step + step / 2);
      const x0 = Math.max(0, cx - half);
      const x1 = Math.min(w - 1, cx + half);
      const y0 = Math.max(0, cy - half);
      const y1 = Math.min(h - 1, cy + half);
      // texture: skip flat windows (clear sky / uniform deck) — nothing to track
      let m = 0;
      let m2 = 0;
      let n = 0;
      for (let y = y0; y <= y1; y += 2) {
        for (let x = x0; x <= x1; x += 2) {
          const val = a[y * w + x];
          m += val;
          m2 += val * val;
          n++;
        }
      }
      const variance = m2 / n - (m / n) ** 2;
      const g = gy * gw + gx;
      if (variance < 30) {
        conf[g] = 0;
        continue;
      }
      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      let sum = 0;
      let cnt = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          let s = 0;
          let k = 0;
          for (let y = y0; y <= y1; y += 2) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let x = x0; x <= x1; x += 2) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              s += Math.abs(a[y * w + x] - b[yy * w + xx]);
              k++;
            }
          }
          // require most of the window to overlap, and gently prefer small shifts on ties
          const val = k > n * 0.6 ? s / k + 0.04 * Math.hypot(dx, dy) : Infinity;
          sad[(dy + R) * side + dx + R] = val;
          if (val < Infinity) {
            sum += val;
            cnt++;
          }
          if (val < best) {
            best = val;
            bdx = dx;
            bdy = dy;
          }
        }
      }
      if (!cnt) continue;
      // parabolic sub-pixel refinement
      let fx = bdx;
      let fy = bdy;
      const at = (dx: number, dy: number) => sad[(dy + R) * side + dx + R];
      if (bdx > -R && bdx < R) {
        const l = at(bdx - 1, bdy);
        const r = at(bdx + 1, bdy);
        const den = l - 2 * best + r;
        if (Number.isFinite(den) && den > 1e-6) fx += Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
      }
      if (bdy > -R && bdy < R) {
        const t = at(bdx, bdy - 1);
        const d = at(bdx, bdy + 1);
        const den = t - 2 * best + d;
        if (Number.isFinite(den) && den > 1e-6) fy += Math.max(-0.5, Math.min(0.5, (0.5 * (t - d)) / den));
      }
      u[g] = fx;
      v[g] = fy;
      // confident when the best match is clearly better than the average candidate
      const mean = sum / cnt;
      const distinct = mean > 0 ? (mean - best) / mean : 0;
      const edge = Math.abs(bdx) === R || Math.abs(bdy) === R ? 0.3 : 1;
      conf[g] = Math.max(0, distinct) * Math.min(1, variance / 300) * edge;
    }
  }

  // reject outliers against the local median, then diffuse with confidence weights
  const mu = new Float32Array(u);
  const mv = new Float32Array(v);
  const buf: number[] = [];
  const med = (arr: Float32Array, gx: number, gy: number) => {
    buf.length = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const x = gx + i;
        const y = gy + j;
        if (x < 0 || y < 0 || x >= gw || y >= gh || conf[y * gw + x] <= 0) continue;
        buf.push(arr[y * gw + x]);
      }
    }
    if (!buf.length) return 0;
    buf.sort((p, q) => p - q);
    return buf[buf.length >> 1];
  };
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const g = gy * gw + gx;
      if (conf[g] <= 0) continue;
      const du = u[g] - med(u, gx, gy);
      const dv = v[g] - med(v, gx, gy);
      if (Math.hypot(du, dv) > 2.5) conf[g] *= 0.05;
      mu[g] = u[g];
      mv[g] = v[g];
    }
  }
  let su = mu;
  let sv = mv;
  let sc = conf;
  for (let pass = 0; pass < 4; pass++) {
    const nu = new Float32Array(gw * gh);
    const nv = new Float32Array(gw * gh);
    const nc = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let wu = 0;
        let wv = 0;
        let ws = 0;
        let wn = 0;
        for (let j = -2; j <= 2; j++) {
          for (let i = -2; i <= 2; i++) {
            const x = gx + i;
            const y = gy + j;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            const k = Math.exp(-(i * i + j * j) / 3);
            const c = sc[y * gw + x] * k;
            wu += su[y * gw + x] * c;
            wv += sv[y * gw + x] * c;
            ws += c;
            wn += k;
          }
        }
        const g = gy * gw + gx;
        if (ws > 1e-6) {
          nu[g] = wu / ws;
          nv[g] = wv / ws;
        }
        // keep a floor so empty regions fill in from their neighbours on later passes
        nc[g] = Math.max(ws / wn, ws > 1e-6 ? 0.02 : 0);
      }
    }
    su = nu;
    sv = nv;
    sc = nc;
  }
  return { w, h, gw, gh, step, u: su, v: sv };
}

/** Bilinear sample of the flow at a pixel position. Writes into `out` to avoid allocations. */
export function sampleFlow(f: Flow, x: number, y: number, out: Float32Array | number[]): void {
  let gx = (x - f.step / 2) / f.step;
  let gy = (y - f.step / 2) / f.step;
  if (gx < 0) gx = 0;
  else if (gx > f.gw - 1) gx = f.gw - 1;
  if (gy < 0) gy = 0;
  else if (gy > f.gh - 1) gy = f.gh - 1;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(f.gw - 1, x0 + 1);
  const y1 = Math.min(f.gh - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const i00 = y0 * f.gw + x0;
  const i10 = y0 * f.gw + x1;
  const i01 = y1 * f.gw + x0;
  const i11 = y1 * f.gw + x1;
  out[0] = (f.u[i00] * (1 - tx) + f.u[i10] * tx) * (1 - ty) + (f.u[i01] * (1 - tx) + f.u[i11] * tx) * ty;
  out[1] = (f.v[i00] * (1 - tx) + f.v[i10] * tx) * (1 - ty) + (f.v[i01] * (1 - tx) + f.v[i11] * tx) * ty;
}

/** Expand the coarse flow to one vector per pixel (for fast warping). */
export function denseFlow(f: Flow): { du: Float32Array; dv: Float32Array } {
  const du = new Float32Array(f.w * f.h);
  const dv = new Float32Array(f.w * f.h);
  const o = new Float32Array(2);
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      sampleFlow(f, x, y, o);
      du[y * f.w + x] = o[0];
      dv[y * f.w + x] = o[1];
    }
  }
  return { du, dv };
}

function bilinear(src: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = x - x0;
  const ty = y - y0;
  return (src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx) * (1 - ty) + (src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx) * ty;
}

/**
 * Motion-compensated blend between two consecutive frames at fraction t ∈ [0, 1]:
 * each frame is warped part-way along the flow before cross-fading, so clouds travel
 * instead of fading in and out.
 */
export function morph(a: ArrayLike<number>, b: ArrayLike<number>, dense: { du: Float32Array; dv: Float32Array }, w: number, h: number, t: number, out: Uint8Array | Uint8ClampedArray): void {
  const { du, dv } = dense;
  const s = 1 - t;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const ux = du[i];
      const vy = dv[i];
      const va = bilinear(a, w, h, x - ux * t, y - vy * t);
      const vb = bilinear(b, w, h, x + ux * s, y + vy * s);
      out[i] = va * s + vb * t + 0.5;
    }
  }
}

/**
 * Semi-Lagrangian extrapolation: move `field` forward by `frames` frame intervals along the
 * flow. Each output pixel traces its trajectory backwards in sub-steps and samples the source once.
 * `decay` (0–1 per frame) relaxes extrapolated cloud towards the background, reflecting that
 * convective cells do not persist unchanged.
 */
export function advect(field: ArrayLike<number>, flow: Flow, frames: number, out: Uint8Array | Uint8ClampedArray | Float32Array, decay = 0): void {
  const { w, h } = flow;
  const steps = Math.max(1, Math.ceil(frames));
  const dt = frames / steps;
  const o = new Float32Array(2);
  const keep = Math.pow(1 - decay, frames);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      let px = x;
      let py = y;
      for (let s = 0; s < steps; s++) {
        sampleFlow(flow, px, py, o);
        px -= o[0] * dt;
        py -= o[1] * dt;
      }
      // trajectories that start outside the field carry no information: fade them out
      const outside = px < 0 || py < 0 || px > w - 1 || py > h - 1;
      const val = bilinear(field, w, h, px, py);
      out[i] = outside ? val * 0.5 : decay ? val * keep : val;
    }
  }
}

/** Mean flow vector over a set of pixel indices (or the whole field). */
export function meanFlow(f: Flow, x0 = 0, y0 = 0, x1 = f.w, y1 = f.h): { u: number; v: number } {
  let su = 0;
  let sv = 0;
  let n = 0;
  const o = new Float32Array(2);
  for (let y = y0 + f.step / 2; y < y1; y += f.step) {
    for (let x = x0 + f.step / 2; x < x1; x += f.step) {
      sampleFlow(f, x, y, o);
      su += o[0];
      sv += o[1];
      n++;
    }
  }
  return n ? { u: su / n, v: sv / n } : { u: 0, v: 0 };
}
