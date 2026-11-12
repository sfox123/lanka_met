'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { istDay, istDayTime, istHour, istTime } from '@/lib/client/format';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Width of a container, tracked with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useIsoLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    setW(Math.floor(ref.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── sparkline ──────────────────────────────────────────────────────────
export function Sparkline({ values, max = 1, width = 84, height = 26, label }: { values: number[]; max?: number; width?: number; height?: number; label: string }) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={`${label}: not enough frames yet`}>
        <line x1={0} x2={width} y1={height - 1} y2={height - 1} stroke="var(--axis)" />
        {values.length === 1 && <circle cx={width - 5} cy={height - 3 - (values[0] / max) * (height - 8)} r={3.5} fill="var(--observed)" />}
      </svg>
    );
  }
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 8);
  const y = (v: number) => height - 3 - Math.min(1, v / max) * (height - 8);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = values.length - 1;
  return (
    <svg width={width} height={height} role="img" aria-label={`${label}: ${values.map((v) => v.toFixed(2)).join(', ')}`}>
      <path d={`${d}L${x(last)},${height - 1}L${x(0)},${height - 1}Z`} fill="var(--observed)" opacity={0.12} />
      <path d={d} fill="none" stroke="var(--observed)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last])} r={3.5} fill="var(--observed)" stroke="var(--panel-2)" strokeWidth={2} />
    </svg>
  );
}

// ── multi-panel time chart ─────────────────────────────────────────────
export interface Series {
  label: string;
  colour: string;
  kind: 'line' | 'area' | 'dash' | 'bar';
  /** [time ms, value] */
  points: [number, number | null][];
  format?: (v: number) => string;
}
export interface StripCell {
  t0: number;
  t1: number;
  colour: string;
  label: string;
}
export interface Panel {
  title: string;
  height: number;
  max: number;
  ticks: number[];
  tickFormat: (v: number) => string;
  series?: Series[];
  /** categorical strip (e.g. risk level per hour) instead of a value axis */
  strip?: StripCell[];
}

interface TimeChartProps {
  panels: Panel[];
  tMin: number;
  tMax: number;
  /** "now" marker */
  now?: number;
  /** the instant shown on the map */
  cursor?: number;
  onPick?: (t: number) => void;
}

const M = { left: 34, right: 10, top: 14, gap: 20, axis: 20 };

function timeTicks(tMin: number, tMax: number, width: number): { t: number; label: string; major: boolean }[] {
  const hours = (tMax - tMin) / 3600e3;
  const maxTicks = Math.max(2, Math.floor(width / 58));
  const step = [1, 2, 3, 6, 12, 24, 48].find((s) => hours / s <= maxTicks) ?? 48;
  const out: { t: number; label: string; major: boolean }[] = [];
  // align to Sri Lanka clock hours (UTC+05:30)
  const off = 5.5 * 3600e3;
  let t = Math.ceil((tMin + off) / (step * 3600e3)) * step * 3600e3 - off;
  for (; t <= tMax; t += step * 3600e3) {
    const midnight = istHour(t) === 0;
    out.push({ t, label: step >= 24 || midnight ? istDay(t).replace(/,/g, '') : istTime(t), major: midnight });
  }
  return out;
}

function nearest(points: [number, number | null][], t: number, tol: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bd = tol;
  for (const [pt, v] of points) {
    if (v == null) continue;
    const d = Math.abs(pt - t);
    if (d <= bd) {
      bd = d;
      best = [pt, v];
    }
  }
  return best;
}

/**
 * Several small charts stacked on one shared time axis — each measure keeps its own scale
 * in its own panel, instead of squeezing two scales onto one plot.
 */
export function TimeChart({ panels, tMin, tMax, now, cursor, onPick }: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ t: number; x: number; y: number } | null>(null);
  const innerW = Math.max(10, width - M.left - M.right);
  const x = (t: number) => M.left + ((t - tMin) / (tMax - tMin)) * innerW;
  const tops = useMemo(() => {
    let y = M.top + 12;
    return panels.map((p) => {
      const top = y;
      y += p.height + M.gap;
      return top;
    });
  }, [panels]);
  const height = tops.length ? tops[tops.length - 1] + panels[panels.length - 1].height + M.axis : 0;
  const ticks = timeTicks(tMin, tMax, innerW);
  const inRange = (t: number | undefined): t is number => t != null && t >= tMin && t <= tMax;

  const tol = Math.max(35 * 60000, ((tMax - tMin) / innerW) * 12);
  const rows: { colour: string; label: string; value: string }[] = [];
  let hoverT = hover?.t ?? 0;
  if (hover) {
    // snap to the nearest real data time so every row refers to the same instant
    let snap: number | null = null;
    for (const p of panels) for (const s of p.series ?? []) {
      const n = nearest(s.points, hover.t, tol);
      if (n && (snap == null || Math.abs(n[0] - hover.t) < Math.abs(snap - hover.t))) snap = n[0];
    }
    if (snap != null) hoverT = snap;
    for (const p of panels) {
      for (const s of p.series ?? []) {
        const n = nearest(s.points, hoverT, 31 * 60000);
        if (n) rows.push({ colour: s.colour, label: s.label, value: (s.format ?? p.tickFormat)(n[1]) });
      }
      const cell = p.strip?.find((c) => hoverT >= c.t0 && hoverT < c.t1);
      if (cell) rows.push({ colour: cell.colour, label: p.title, value: cell.label });
    }
  }

  return (
    <div
      ref={ref}
      className="chart"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - r.left;
        if (px < M.left - 4 || px > M.left + innerW + 4) return setHover(null);
        setHover({ t: tMin + ((px - M.left) / innerW) * (tMax - tMin), x: px, y: e.clientY - r.top });
      }}
      onPointerLeave={() => setHover(null)}
      onClick={() => hover && onPick?.(hoverT)}
      style={{ cursor: onPick ? 'crosshair' : undefined }}
    >
      {width > 0 && (
        <svg height={height} role="img" aria-label={panels.map((p) => p.title).join('; ')}>
          {panels.map((p, pi) => {
            const top = tops[pi];
            const y = (v: number) => top + p.height - (Math.min(p.max, Math.max(0, v)) / p.max) * p.height;
            return (
              <g key={p.title}>
                <text className="panel-title" x={M.left} y={top - 5}>
                  {p.title}
                </text>
                {!p.strip &&
                  p.ticks.map((tv) => (
                    <g key={tv}>
                      <line x1={M.left} x2={M.left + innerW} y1={y(tv)} y2={y(tv)} stroke={tv === 0 ? 'var(--axis)' : 'var(--grid)'} />
                      <text x={M.left - 6} y={y(tv) + 3.5} textAnchor="end">
                        {p.tickFormat(tv)}
                      </text>
                    </g>
                  ))}
                {p.strip?.map((c) => {
                  const x0 = Math.max(M.left, x(c.t0));
                  const x1 = Math.min(M.left + innerW, x(c.t1));
                  return x1 - x0 > 0.5 ? <rect key={c.t0} x={x0 + 0.5} y={top} width={Math.max(1, x1 - x0 - 1)} height={p.height} rx={2} fill={c.colour} /> : null;
                })}
                {p.series?.map((s) => {
                  const pts = s.points.filter((q): q is [number, number] => q[1] != null && q[0] >= tMin && q[0] <= tMax);
                  if (!pts.length) return null;
                  if (s.kind === 'bar') {
                    const bw = Math.max(1.5, Math.min(24, innerW / ((tMax - tMin) / 3600e3) - 2));
                    return (
                      <g key={s.label}>
                        {pts.map(([t, v]) => {
                          const hgt = top + p.height - y(v);
                          if (hgt < 0.4) return null;
                          const r = Math.min(4, bw / 2, hgt);
                          const bx = x(t) - bw / 2;
                          const by = y(v);
                          return <path key={t} d={`M${bx},${by + hgt}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + bw - r}Q${bx + bw},${by} ${bx + bw},${by + r}V${by + hgt}Z`} fill={s.colour} />;
                        })}
                      </g>
                    );
                  }
                  const d = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
                  const end = pts[pts.length - 1];
                  return (
                    <g key={s.label}>
                      {s.kind === 'area' && pts.length > 1 && <path d={`${d}L${x(end[0]).toFixed(1)},${top + p.height}L${x(pts[0][0]).toFixed(1)},${top + p.height}Z`} fill={s.colour} opacity={0.1} />}
                      <path d={d} fill="none" stroke={s.colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.kind === 'dash' ? '2 5' : undefined} />
                      {(pts.length === 1 || s.kind !== 'dash') && <circle cx={x(end[0])} cy={y(end[1])} r={4} fill={s.colour} stroke="var(--panel-2)" strokeWidth={2} />}
                    </g>
                  );
                })}
              </g>
            );
          })}
          {/* shared time axis */}
          {ticks.map((tk) => (
            <g key={tk.t}>
              <line x1={x(tk.t)} x2={x(tk.t)} y1={height - M.axis} y2={height - M.axis + 4} stroke="var(--axis)" />
              <text x={x(tk.t)} y={height - 4} textAnchor="middle" style={tk.major ? { fill: 'var(--text-2)' } : undefined}>
                {tk.label}
              </text>
            </g>
          ))}
          {inRange(now) && (
            <g>
              <line x1={x(now)} x2={x(now)} y1={12} y2={height - M.axis} stroke="var(--text-2)" strokeDasharray="3 3" />
              <text x={Math.max(M.left + 10, Math.min(x(now), M.left + innerW - 10))} y={9} textAnchor="middle" style={{ fill: 'var(--text-2)' }}>
                now
              </text>
            </g>
          )}
          {inRange(cursor) && <line x1={x(cursor)} x2={x(cursor)} y1={M.top + 10} y2={height - M.axis} stroke="#fff" strokeWidth={1.5} opacity={0.85} />}
          {hover && <line x1={x(hoverT)} x2={x(hoverT)} y1={M.top + 10} y2={height - M.axis} stroke="var(--muted)" />}
        </svg>
      )}
      {hover && rows.length > 0 && (
        <div className="tooltip" style={{ left: Math.min(Math.max(0, hover.x + 12), Math.max(0, width - 190)), top: Math.max(0, hover.y - 10 - rows.length * 9) }}>
          <div className="t">{istDayTime(hoverT)} IST</div>
          {rows.map((r) => (
            <div className="r" key={r.label}>
              <i style={{ background: r.colour }} />
              {r.label}
              <b className="num">{r.value}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── heatmap: rows × time ───────────────────────────────────────────────
// one hue, light = more (on a dark surface the ramp runs dark → light)
const HEAT = ['#16233b', '#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
export const heatColour = (v: number, max = 1) => HEAT[Math.min(HEAT.length - 1, Math.max(0, Math.floor((v / max) * HEAT.length)))];

export function Heatmap({ rows, times, format, onPickRow, cursor }: { rows: { key: string; label: string; values: (number | null)[] }[]; times: number[]; format: (v: number) => string; onPickRow?: (key: string) => void; cursor?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const labelW = 86;
  const rowH = 18;
  const innerW = Math.max(10, width - labelW - 4);
  const cw = times.length ? innerW / times.length : 0;
  const gap = cw > 5 ? 2 : cw > 2.5 ? 1 : 0;
  const height = rows.length * rowH + 18;
  let cursorCol = -1;
  if (cursor != null && times.length) {
    let bd = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(t - cursor);
      if (d < bd && d <= 20 * 60000) {
        bd = d;
        cursorCol = i;
      }
    });
  }
  const labelEvery = Math.max(1, Math.ceil(52 / Math.max(1, cw)));
  return (
    <div
      ref={ref}
      className="chart"
      onPointerLeave={() => setHover(null)}
      onPointerMove={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        const c = Math.floor((e.clientX - b.left - labelW) / cw);
        const r = Math.floor((e.clientY - b.top) / rowH);
        setHover(c >= 0 && c < times.length && r >= 0 && r < rows.length ? { r, c, x: e.clientX - b.left, y: e.clientY - b.top } : null);
      }}
      onClick={() => hover && onPickRow?.(rows[hover.r].key)}
    >
      {width > 0 && (
        <svg height={height} role="img" aria-label="Cloud index by estate over time">
          {rows.map((row, r) => (
            <g key={row.key}>
              <text x={0} y={r * rowH + 12.5} style={{ fill: 'var(--text-2)', fontSize: 11.5 }}>
                {row.label}
              </text>
              {row.values.map((v, c) => (v == null ? null : <rect key={c} x={labelW + c * cw} y={r * rowH + 1} width={Math.max(1, cw - gap)} height={rowH - 2} rx={cw > 6 ? 2 : 0} fill={heatColour(v)} />))}
            </g>
          ))}
          {cursorCol >= 0 && <rect x={labelW + cursorCol * cw - 1} y={0} width={Math.max(2, cw - gap + 2)} height={rows.length * rowH} fill="none" stroke="#fff" strokeWidth={1.5} rx={2} />}
          {times.map((t, c) => (c % labelEvery === 0 && labelW + c * cw + 30 < width ? (
            <text key={t} x={labelW + c * cw} y={height - 4}>
              {istTime(t)}
            </text>
          ) : null))}
        </svg>
      )}
      {hover && rows[hover.r].values[hover.c] != null && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 12, Math.max(0, width - 170)), top: hover.y + 14 }}>
          <div className="t">{istDayTime(times[hover.c])} IST</div>
          <div className="r">
            <i style={{ background: heatColour(rows[hover.r].values[hover.c] as number) }} />
            {rows[hover.r].label}
            <b className="num">{format(rows[hover.r].values[hover.c] as number)}</b>
          </div>
        </div>
      )}
    </div>
  );
}

export function HeatLegend({ low, high }: { low: string; high: string }) {
  return (
    <div className="legend-row">
      <span>{low}</span>
      <span style={{ gap: 2 }}>
        {HEAT.map((c) => (
          <i key={c} style={{ background: c, width: 14 }} />
        ))}
      </span>
      <span>{high}</span>
    </div>
  );
}

// ── part-to-whole bar ──────────────────────────────────────────────────
export function SegmentBar({ parts, unit }: { parts: { name: string; value: number; colour: string }[]; unit: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div ref={ref}>
      <div className="segbar" role="img" aria-label={parts.map((p) => `${p.name} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {parts.map((p) => {
          const share = p.value / total;
          const w = share * (width - (parts.length - 1) * 2);
          return (
            <div key={p.name} style={{ width: `${share * 100}%`, background: p.colour, color: p.colour === '#c98500' ? '#0b0b0b' : '#fff' }} title={`${p.name}: ${p.value.toFixed(0)} ${unit} (${(share * 100).toFixed(0)}%)`}>
              {w > 38 ? `${Math.round(share * 100)}%` : ''}
            </div>
          );
        })}
      </div>
      <div className="legend-row">
        {parts.map((p) => (
          <span key={p.name}>
            <i style={{ background: p.colour }} />
            {p.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; colour: string; kind?: 'line' | 'dash' | 'box' }[] }) {
  return (
    <div className="legend-row">
      {items.map((it) => (
        <span key={it.label}>
          <i className={it.kind === 'line' ? 'line' : it.kind === 'dash' ? 'dash' : undefined} style={it.kind === 'dash' ? { borderColor: it.colour } : { background: it.colour }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function Card({ title, sub, action, children }: { title: string; sub?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
