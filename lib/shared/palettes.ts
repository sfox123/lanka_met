// Colour look-up tables that turn an 8-bit field into a picture. Each LUT is 256 RGBA entries.
import { CFG } from './risk';

export type PaletteId = 'enhanced' | 'rain' | 'cloud' | 'raw' | 'moisture';

export interface Palette {
  id: PaletteId;
  label: string;
  hint: string;
  lut: Uint8ClampedArray;
  /** legend stops for the colour bar: [value 0–1, label] */
  ticks: [number, string][];
}

type Stop = [number, number, number, number, number]; // value 0–1, r, g, b, a(0–255)

function build(stops: Stop[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const a = stops[k];
    const b = stops[k + 1];
    const t = Math.min(1, Math.max(0, (v - a[0]) / (b[0] - a[0] || 1)));
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * t;
  }
  return lut;
}

const { cloudT, coldT, deepT, convLo } = CFG;

export const PALETTES: Record<PaletteId, Palette> = {
  // Conventional IR enhancement: warm surface is transparent, low cloud is soft grey-white,
  // cold tops step through blue → green → yellow → red → magenta as they get colder.
  enhanced: {
    id: 'enhanced',
    label: 'Enhanced',
    hint: 'Colour-enhanced cloud-top coldness',
    lut: build([
      [0.0, 120, 130, 150, 0],
      [0.25, 130, 140, 160, 0],
      [cloudT, 190, 198, 210, 120],
      [0.62, 236, 240, 245, 205],
      [0.72, 120, 190, 245, 225],
      [coldT, 40, 120, 235, 235],
      [0.87, 30, 190, 140, 240],
      [0.91, 250, 215, 50, 245],
      [deepT, 240, 110, 40, 250],
      [0.985, 215, 40, 60, 255],
      [1.0, 225, 80, 220, 255],
    ]),
    ticks: [
      [cloudT, 'cloud'],
      [0.74, 'cold'],
      [0.97, 'deep'],
    ],
  },
  // Only the cloud that matters for rain: nothing below the convective floor, then a single
  // blue ramp that brightens with convective intensity.
  rain: {
    id: 'rain',
    label: 'Rain potential',
    hint: 'Only cloud cold enough to rain',
    lut: build([
      [0.0, 60, 110, 200, 0],
      [convLo - 0.05, 60, 110, 200, 0],
      [convLo + 0.05, 70, 120, 205, 110],
      [coldT, 57, 135, 229, 215],
      [deepT, 150, 200, 250, 240],
      [1.0, 235, 245, 255, 255],
    ]),
    ticks: [
      [convLo, 'possible'],
      [0.74, 'likely'],
      [0.97, 'heavy'],
    ],
  },
  // Natural-looking white cloud over the map.
  cloud: {
    id: 'cloud',
    label: 'Natural',
    hint: 'White cloud over the map',
    lut: build([
      [0.0, 255, 255, 255, 0],
      [0.22, 255, 255, 255, 0],
      [cloudT, 225, 230, 238, 130],
      [0.7, 245, 247, 250, 215],
      [1.0, 255, 255, 255, 250],
    ]),
    ticks: [
      [cloudT, 'cloud'],
      [coldT, 'cold tops'],
    ],
  },
  // The satellite picture as IMD shows it (overlay graphics removed).
  raw: {
    id: 'raw',
    label: 'Satellite',
    hint: 'Greyscale picture, as observed',
    lut: build([
      [0.0, 0, 0, 0, 255],
      [1.0, 255, 255, 255, 255],
    ]),
    ticks: [
      [0.02, 'warm'],
      [0.98, 'cold'],
    ],
  },
  // Water vapour: dry air in warm brown, moist air in white → teal.
  moisture: {
    id: 'moisture',
    label: 'Moisture',
    hint: 'Dry (brown) to moist (teal) upper air',
    lut: build([
      [0.0, 110, 62, 20, 215],
      [0.3, 170, 115, 60, 190],
      [0.5, 150, 150, 150, 120],
      [0.68, 235, 240, 240, 200],
      [0.85, 60, 185, 175, 230],
      [1.0, 15, 110, 140, 250],
    ]),
    ticks: [
      [0.1, 'dry'],
      [0.9, 'moist'],
    ],
  },
};

/** Paint a field into RGBA pixels with a palette. */
export function colourise(field: ArrayLike<number>, lut: Uint8ClampedArray, out: Uint8ClampedArray, opacity = 1): void {
  for (let i = 0, o = 0; i < field.length; i++, o += 4) {
    const k = field[i] << 2;
    out[o] = lut[k];
    out[o + 1] = lut[k + 1];
    out[o + 2] = lut[k + 2];
    out[o + 3] = lut[k + 3] * opacity;
  }
}

/** Open-Meteo precipitation (mm/h) and cloud cover (%) → RGBA: white haze for cloud, blues for rain. */
export function colourModel(precip: number, cloud: number): [number, number, number, number] {
  if (precip >= 0.1) {
    const t = Math.min(1, Math.sqrt(precip / 12));
    // light blue → strong blue → violet for the heaviest rain
    const r = 150 - 110 * t + (t > 0.75 ? (t - 0.75) * 480 : 0);
    const g = 200 - 120 * t;
    const b = 250 - 20 * t;
    return [r, g, b, 120 + 130 * t];
  }
  return [235, 238, 245, Math.max(0, cloud - 30) * 1.4];
}

/**
 * Smooth and enlarge a field by an integer factor before colouring, so colour bands follow
 * rounded contours instead of the satellite's blocky pixels. `soften` applies a light 3×3 blur
 * first; leave it off to keep the picture exactly as observed.
 */
export function upsample(field: ArrayLike<number>, w: number, h: number, scale: number, soften: boolean, tmp: Float32Array, out: Uint8Array): void {
  if (soften) {
    for (let y = 0; y < h; y++) {
      const ym = y > 0 ? y - 1 : y;
      const yp = y < h - 1 ? y + 1 : y;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : x;
        const xp = x < w - 1 ? x + 1 : x;
        tmp[y * w + x] =
          (field[ym * w + xm] + 2 * field[ym * w + x] + field[ym * w + xp] + 2 * field[y * w + xm] + 4 * field[y * w + x] + 2 * field[y * w + xp] + field[yp * w + xm] + 2 * field[yp * w + x] + field[yp * w + xp]) / 16;
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) tmp[i] = field[i];
  }
  const W = w * scale;
  const H = h * scale;
  for (let Y = 0; Y < H; Y++) {
    let sy = (Y + 0.5) / scale - 0.5;
    if (sy < 0) sy = 0;
    else if (sy > h - 1.001) sy = h - 1.001;
    const y0 = sy | 0;
    const ty = sy - y0;
    for (let X = 0; X < W; X++) {
      let sx = (X + 0.5) / scale - 0.5;
      if (sx < 0) sx = 0;
      else if (sx > w - 1.001) sx = w - 1.001;
      const x0 = sx | 0;
      const tx = sx - x0;
      const k = y0 * w + x0;
      out[Y * W + X] = (tmp[k] * (1 - tx) + tmp[k + 1] * tx) * (1 - ty) + (tmp[k + w] * (1 - tx) + tmp[k + w + 1] * tx) * ty + 0.5;
    }
  }
}

/** CSS gradient for a palette's legend bar. */
export function paletteGradient(p: Palette): string {
  const parts: string[] = [];
  for (let i = 0; i <= 32; i++) {
    const k = Math.round((i / 32) * 255) * 4;
    parts.push(`rgba(${p.lut[k]},${p.lut[k + 1]},${p.lut[k + 2]},${(p.lut[k + 3] / 255).toFixed(2)}) ${((i / 32) * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(',')})`;
}
