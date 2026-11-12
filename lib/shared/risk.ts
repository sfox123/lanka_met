// Transparent, tunable heuristics that turn cloud statistics and model output into a rain risk.
// Nothing here is calibrated against gauges yet — see the "About & caveats" panel.
import type { CloudStats, LeadRisk, RiskLevel } from './types';

export const CFG = {
  /** minutes between satellite frames */
  frameMinutes: 30,
  /** cloud index at or above which a pixel counts as cloudy */
  cloudT: 0.45,
  /** cold, high cloud tops — the cloud that usually rains over Sri Lanka */
  coldT: 0.82,
  /** very cold tops: deep convection / overshooting */
  deepT: 0.96,
  /** convective-intensity ramp: 0 at convLo, 1 at convHi */
  convLo: 0.55,
  convHi: 0.95,
  /** satellite rain likelihood = 1 − exp(−satK · conv) */
  satK: 3.2,
  /** extra likelihood when the cloud is growing (per unit of 1-hour index trend) */
  growthGain: 0.8,
  /** weight of the satellite signal by lead time (hours → weight); 0 beyond the last entry */
  wSat: [
    [0, 0.8],
    [0.5, 0.7],
    [1, 0.5],
    [3, 0.3],
  ] as [number, number][],
  /** risk level boundaries */
  levels: [0.3, 0.55, 0.75] as [number, number, number],
  /** GPI-style rate: mm/h attributed to an area fully covered by cold cloud */
  gpiRate: 3,
  nowcastLeads: [30, 60, 90, 120, 150, 180],
};

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Summarise a set of cloud-index samples (0–255). */
export function cloudStats(values: ArrayLike<number>, indices?: ArrayLike<number>): CloudStats {
  const n = indices ? indices.length : values.length;
  if (!n) return { mean: 0, max: 0, cover: 0, cold: 0, deep: 0, conv: 0 };
  let sum = 0;
  let max = 0;
  let cover = 0;
  let cold = 0;
  let deep = 0;
  let conv = 0;
  const span = CFG.convHi - CFG.convLo;
  for (let k = 0; k < n; k++) {
    const v = values[indices ? indices[k] : k] / 255;
    sum += v;
    if (v > max) max = v;
    if (v >= CFG.cloudT) cover++;
    if (v >= CFG.coldT) cold++;
    if (v >= CFG.deepT) deep++;
    conv += clamp01((v - CFG.convLo) / span);
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { mean: r(sum / n), max: r(max), cover: r(cover / n), cold: r(cold / n), deep: r(deep / n), conv: r(conv / n) };
}

/** Likelihood (0–1) that it is raining under the observed cloud, from satellite alone. */
export function satProbability(s: CloudStats, trend1h: number | null = null): number {
  const base = 1 - Math.exp(-CFG.satK * s.conv);
  const growth = trend1h && trend1h > 0 ? Math.min(0.15, trend1h * CFG.growthGain) : 0;
  return clamp01(base + growth * (s.mean > CFG.cloudT ? 1 : 0.5));
}

/** GPI-style rain-rate guess in mm/h: a fixed rate times the cold-cloud fraction. */
export function gpiRate(s: CloudStats): number {
  return Math.round(CFG.gpiRate * (s.cold + s.deep) * 10) / 10;
}

/**
 * Model signal from Open-Meteo: the chance of rain, weighted by how much rain is forecast.
 * A 100% chance of a trace (< 0.2 mm/h) counts for 0.7; the full probability applies from 3 mm/h.
 */
export function modelSignal(probabilityPct: number | null, precipMm: number | null): number | null {
  if (probabilityPct == null && precipMm == null) return null;
  const p = (probabilityPct ?? 0) / 100;
  const amount = 0.7 + 0.3 * smoothstep(0.2, 3, precipMm ?? 0);
  return clamp01(p * amount);
}

export function satWeight(leadHours: number): number {
  const w = CFG.wSat;
  if (leadHours > w[w.length - 1][0]) return 0;
  for (let i = 1; i < w.length; i++) {
    if (leadHours <= w[i][0]) {
      const t = (leadHours - w[i - 1][0]) / (w[i][0] - w[i - 1][0]);
      return w[i - 1][1] + t * (w[i][1] - w[i - 1][1]);
    }
  }
  return 0;
}

export function riskLevel(r: number): RiskLevel {
  const [a, b, c] = CFG.levels;
  return r < a ? 'low' : r < b ? 'moderate' : r < c ? 'high' : 'very-high';
}

export const RISK_LABEL: Record<RiskLevel, string> = { low: 'Low', moderate: 'Moderate', high: 'High', 'very-high': 'Very high' };

/** Blend satellite and model signals for one lead time. Falls back to whichever is available. */
export function blendRisk(leadMin: number, sat: number | null, model: number | null): Omit<LeadRisk, 't'> {
  const w = satWeight(leadMin / 60);
  let risk: number;
  if (sat != null && model != null) risk = w * sat + (1 - w) * model;
  else if (sat != null) risk = sat * Math.max(w, 0.5);
  else risk = model ?? 0;
  risk = Math.round(clamp01(risk) * 1000) / 1000;
  return { leadMin, sat, model, risk, level: riskLevel(risk) };
}

/** Confidence in the cloud-motion nowcast, fading with lead time. */
export function nowcastConfidence(leadMin: number): number {
  return clamp01(1 - leadMin / 240) ** 1.3;
}
