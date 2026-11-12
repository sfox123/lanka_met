// Browser-side field engine: downloads the 8-bit fields, estimates cloud motion between
// consecutive frames, and renders the field for any instant on the timeline —
// motion-interpolated between observations, extrapolated along the motion after the last one.
import { computeFlow, denseFlow, morph, type Flow } from '../shared/flow';
import { DOMAINS, type DomainId } from '../shared/geo';
import { CFG } from '../shared/risk';
import type { Channel, FrameMeta } from '../shared/types';

export interface RenderInfo {
  kind: 'observed' | 'nowcast' | 'none';
  /** false while the fields needed for this instant are still loading */
  ready: boolean;
  /** minutes past the latest observation (nowcast only) */
  leadMin: number;
}

const FLOW_OPTS = { sl: { radius: 7, half: 9, step: 6 }, region: { radius: 6, half: 8, step: 8 } } as const;
const MAX_GAP_MIN = 95;

async function decode(url: string, w: number, h: number): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  if (bmp.width !== w || bmp.height !== h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
  return out;
}

export class FieldEngine {
  private fields = new Map<string, Uint8Array | null>();
  private loading = new Map<string, Promise<Uint8Array | null>>();
  private flows = new Map<string, Flow | null>();
  private dense = new Map<string, { du: Float32Array; dv: Float32Array }>();
  /** bumps whenever new data arrives, so renderers know to redraw */
  version = 0;

  private key(ch: Channel, domain: DomainId, id: string) {
    return `${ch}/${domain}/${id}`;
  }

  get(ch: Channel, domain: DomainId, id: string): Uint8Array | null | undefined {
    return this.fields.get(this.key(ch, domain, id));
  }

  load(ch: Channel, domain: DomainId, id: string): Promise<Uint8Array | null> {
    const key = this.key(ch, domain, id);
    if (this.fields.has(key)) return Promise.resolve(this.fields.get(key) ?? null);
    let p = this.loading.get(key);
    if (!p) {
      const d = DOMAINS[domain];
      p = decode(`/api/field/${key}`, d.width, d.height)
        .catch(() => null)
        .then((data) => {
          this.fields.set(key, data);
          this.loading.delete(key);
          this.version++;
          return data;
        });
      this.loading.set(key, p);
    }
    return p;
  }

  /** Start loading every frame of a channel (newest first) plus the IR fields used for motion. */
  preload(frames: FrameMeta[], ch: Channel, domain: DomainId): void {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (f.channels[ch]) void this.load(ch, domain, f.id);
      if (ch !== 'ir1' && f.channels.ir1) void this.load('ir1', domain, f.id);
    }
  }

  loadedCount(frames: FrameMeta[], ch: Channel, domain: DomainId): number {
    let n = 0;
    for (const f of frames) if (this.fields.get(this.key(ch, domain, f.id))) n++;
    return n;
  }

  /** Cloud motion from frame a to frame b (field pixels over their time gap), from the IR fields. */
  flow(domain: DomainId, a: FrameMeta, b: FrameMeta): Flow | null {
    const key = `${domain}/${a.id}/${b.id}`;
    if (this.flows.has(key)) return this.flows.get(key) ?? null;
    const gap = (Date.parse(b.t) - Date.parse(a.t)) / 60000;
    if (gap <= 0 || gap > MAX_GAP_MIN) {
      this.flows.set(key, null);
      return null;
    }
    const fa = this.get('ir1', domain, a.id);
    const fb = this.get('ir1', domain, b.id);
    if (!fa || !fb) return null; // not loaded yet — try again later
    const d = DOMAINS[domain];
    const flow = computeFlow(fa, fb, d.width, d.height, FLOW_OPTS[domain]);
    this.flows.set(key, flow);
    return flow;
  }

  private denseFor(domain: DomainId, a: FrameMeta, b: FrameMeta): { du: Float32Array; dv: Float32Array } | null {
    const key = `${domain}/${a.id}/${b.id}`;
    const hit = this.dense.get(key);
    if (hit) return hit;
    const flow = this.flow(domain, a, b);
    if (!flow) return null;
    const dn = denseFlow(flow);
    this.dense.set(key, dn);
    // dense vectors are large on the wide domain: keep only the most recent few
    const limit = domain === 'region' ? 6 : 40;
    const mine = [...this.dense.keys()].filter((k) => k.startsWith(domain));
    if (mine.length > limit) this.dense.delete(mine[0]);
    return dn;
  }

  /** The motion field in force at time tMs (latest pair when past the last frame). */
  flowAt(frames: FrameMeta[], domain: DomainId, tMs: number): { flow: Flow; gapMin: number } | null {
    const ir = frames.filter((f) => f.channels.ir1);
    if (ir.length < 2) return null;
    let i = ir.length - 2;
    for (let k = 0; k < ir.length - 1; k++) {
      if (tMs < Date.parse(ir[k + 1].t)) {
        i = k;
        break;
      }
    }
    const flow = this.flow(domain, ir[i], ir[i + 1]);
    return flow ? { flow, gapMin: (Date.parse(ir[i + 1].t) - Date.parse(ir[i].t)) / 60000 } : null;
  }

  /**
   * Render the field of `ch` at time tMs into `out` (domain-sized).
   * `smooth` turns motion interpolation on; off gives a plain frame-by-frame slideshow.
   */
  render(frames: FrameMeta[], ch: Channel, domain: DomainId, tMs: number, smooth: boolean, out: Uint8Array): RenderInfo {
    const list = frames.filter((f) => f.channels[ch]);
    if (!list.length) return { kind: 'none', ready: true, leadMin: 0 };
    const d = DOMAINS[domain];
    const last = list[list.length - 1];
    const lastMs = Date.parse(last.t);

    if (tMs > lastMs) {
      // extrapolate the latest frame along the latest motion
      const leadMin = (tMs - lastMs) / 60000;
      const field = this.get(ch, domain, last.id);
      if (!field) {
        void this.load(ch, domain, last.id);
        return { kind: 'nowcast', ready: false, leadMin };
      }
      const prev = list[list.length - 2];
      const dn = prev ? this.denseFor(domain, prev, last) : null;
      if (!dn || !prev) {
        out.set(field);
        return { kind: 'nowcast', ready: true, leadMin };
      }
      const n = leadMin / ((lastMs - Date.parse(prev.t)) / 60000);
      const { du, dv } = dn;
      const { width: w, height: h } = d;
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) {
          let sx = x - du[i] * n;
          let sy = y - dv[i] * n;
          if (sx < 0) sx = 0;
          else if (sx > w - 1.001) sx = w - 1.001;
          if (sy < 0) sy = 0;
          else if (sy > h - 1.001) sy = h - 1.001;
          const x0 = sx | 0;
          const y0 = sy | 0;
          const tx = sx - x0;
          const ty = sy - y0;
          const k = y0 * w + x0;
          out[i] = (field[k] * (1 - tx) + field[k + 1] * tx) * (1 - ty) + (field[k + w] * (1 - tx) + field[k + w + 1] * tx) * ty + 0.5;
        }
      }
      return { kind: 'nowcast', ready: true, leadMin };
    }

    // observed: locate the pair of frames around tMs
    let i = 0;
    while (i < list.length - 1 && Date.parse(list[i + 1].t) <= tMs) i++;
    const a = list[i];
    const b = list[Math.min(list.length - 1, i + 1)];
    const fa = this.get(ch, domain, a.id);
    if (fa === undefined) void this.load(ch, domain, a.id);
    const ta = Date.parse(a.t);
    const tb = Date.parse(b.t);
    const frac = tb > ta ? Math.min(1, Math.max(0, (tMs - ta) / (tb - ta))) : 0;
    if (a === b || frac < 0.004 || !smooth) {
      const pick = !smooth && frac >= 0.5 ? b : a;
      const f = this.get(ch, domain, pick.id);
      if (f === undefined) void this.load(ch, domain, pick.id);
      if (!f) return { kind: 'observed', ready: false, leadMin: 0 };
      out.set(f);
      return { kind: 'observed', ready: true, leadMin: 0 };
    }
    const fb = this.get(ch, domain, b.id);
    if (fb === undefined) void this.load(ch, domain, b.id);
    if (!fa || !fb) {
      const any = fa ?? fb;
      if (any) out.set(any);
      return { kind: 'observed', ready: !!any, leadMin: 0 };
    }
    const dn = (tb - ta) / 60000 <= MAX_GAP_MIN ? this.denseFor(domain, a, b) : null;
    if (dn) {
      morph(fa, fb, dn, d.width, d.height, frac, out);
    } else {
      // no usable motion (gap too long or IR not loaded): plain cross-fade
      for (let k = 0; k < out.length; k++) out[k] = fa[k] * (1 - frac) + fb[k] * frac + 0.5;
    }
    return { kind: 'observed', ready: true, leadMin: 0 };
  }

  /** Cloud index (0–1) from the most recent render buffer at a lon/lat is done by the caller. */
  static nowcastLimitMin = CFG.nowcastLeads[CFG.nowcastLeads.length - 1];
}
