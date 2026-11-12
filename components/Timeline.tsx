'use client';

import { useRef } from 'react';
import { istHour, istTime, istWeekday } from '@/lib/client/format';
import { posOf, timeOf, type TimeModel } from '@/lib/client/timeline';
import type { FrameMeta } from '@/lib/shared/types';

interface Props {
  tm: TimeModel;
  frames: FrameMeta[];
  loaded: Set<string>;
  time: number;
  now: number;
  playing: boolean;
  speed: number;
  hours: number;
  smooth: boolean;
  onSeek: (t: number) => void;
  onPlay: (p: boolean) => void;
  onStep: (dir: -1 | 1) => void;
  onLive: () => void;
  onSpeed: (s: number) => void;
  onHours: (h: number) => void;
  onSmooth: (s: boolean) => void;
}

const RANGES: [number, string][] = [
  [6, '6 h'],
  [12, '12 h'],
  [24, '24 h'],
  [72, '3 d'],
  [168, '7 d'],
];
const SPEEDS = [0.5, 1, 2, 4];

function labels(tm: TimeModel): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  const off = 5.5 * 3600e3;
  const add = (from: number, to: number, share: number) => {
    const hours = (to - from) / 3600e3;
    if (hours <= 0) return;
    const want = Math.max(1, Math.round(share * 9));
    const step = [0.5, 1, 2, 3, 6, 12, 24, 48].find((s) => hours / s <= want) ?? 48;
    for (let t = Math.ceil((from + off) / (step * 3600e3)) * step * 3600e3 - off; t <= to; t += step * 3600e3) {
      if (t - from < (to - from) * 0.04 && from !== tm.t0) continue; // keep clear of the stretch boundary
      out.push({ t, text: istHour(t) === 0 && new Date(t + off).getUTCMinutes() === 0 ? `${istWeekday(t)} 00:00` : istTime(t) });
    }
  };
  add(tm.t0, tm.tLast, tm.pObs);
  add(tm.tLast, tm.tNowcastEnd, tm.pNow - tm.pObs);
  add(tm.tNowcastEnd, tm.tModelEnd, 1 - tm.pNow);
  // drop labels that would run into their left neighbour
  const kept: { t: number; text: string }[] = [];
  let lastPos = -1;
  for (const l of out) {
    const pos = posOf(tm, l.t);
    if (pos - lastPos < 0.055 || pos > 0.975) continue;
    kept.push(l);
    lastPos = pos;
  }
  return kept;
}

export default function Timeline(p: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const seekFromEvent = (e: React.PointerEvent) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    p.onSeek(timeOf(p.tm, (e.clientX - r.left) / r.width));
  };
  const pc = (x: number) => `${(x * 100).toFixed(3)}%`;
  const { tm } = p;
  const nowPos = p.now >= tm.t0 && p.now <= tm.tModelEnd ? posOf(tm, p.now) : null;

  return (
    <div className="timeline">
      <div className="transport">
        <button className="btn icon" onClick={() => p.onStep(-1)} aria-label="Previous frame" title="Previous frame (←)">
          ⏮
        </button>
        <button className="btn icon primary" onClick={() => p.onPlay(!p.playing)} aria-label={p.playing ? 'Pause' : 'Play'} title="Play / pause (space)">
          {p.playing ? '⏸' : '▶'}
        </button>
        <button className="btn icon" onClick={() => p.onStep(1)} aria-label="Next frame" title="Next frame (→)">
          ⏭
        </button>
        <button className="btn" onClick={p.onLive} title="Jump to the latest observation">
          Latest
        </button>
      </div>
      <div
        ref={trackRef}
        className="track"
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={tm.t0}
        aria-valuemax={tm.tModelEnd}
        aria-valuenow={Math.round(p.time)}
        aria-valuetext={`${istTime(p.time)} Sri Lanka time`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          p.onPlay(false);
          seekFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seekFromEvent(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') p.onStep(-1);
          else if (e.key === 'ArrowRight') p.onStep(1);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="band observed" style={{ left: 0, width: pc(tm.pObs) }} />
        {tm.pNow > tm.pObs && <div className="band nowcast" style={{ left: pc(tm.pObs), width: pc(tm.pNow - tm.pObs) }} />}
        {tm.pNow < 1 && <div className="band model" style={{ left: pc(tm.pNow), width: pc(1 - tm.pNow) }} />}
        {p.frames.map((f) => {
          const t = Date.parse(f.t);
          return t >= tm.t0 && f.channels.ir1 ? <div key={f.id} className="frame-tick" data-loaded={p.loaded.has(f.id)} style={{ left: pc(posOf(tm, t)) }} /> : null;
        })}
        {labels(tm).map((l) => (
          <div key={l.t} className="lbl" style={{ left: pc(posOf(tm, l.t)) }}>
            {l.text}
          </div>
        ))}
        {nowPos != null && (
          <div className="now-line" style={{ left: pc(nowPos) }}>
            <span>now</span>
          </div>
        )}
        <div className="thumb" style={{ left: pc(posOf(tm, p.time)) }} />
      </div>
      <div className="tl-opts">
        <span className="key">
          <i style={{ background: 'var(--observed)' }} />
          Observed
        </span>
        {tm.pNow > tm.pObs && (
          <span className="key">
            <i style={{ background: 'var(--nowcast)' }} />
            Nowcast +3 h
          </span>
        )}
        {tm.pNow < 1 && (
          <span className="key">
            <i style={{ background: 'var(--model)' }} />
            Model +48 h
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span>History</span>
        <div className="seg" role="group" aria-label="History length">
          {RANGES.map(([h, label]) => (
            <button key={h} aria-pressed={p.hours === h} onClick={() => p.onHours(h)}>
              {label}
            </button>
          ))}
        </div>
        <span>Speed</span>
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} aria-pressed={p.speed === s} onClick={() => p.onSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Playback style">
          <button aria-pressed={p.smooth} onClick={() => p.onSmooth(true)} title="Clouds glide between frames along their measured motion">
            Smooth motion
          </button>
          <button aria-pressed={!p.smooth} onClick={() => p.onSmooth(false)} title="Show each satellite frame as it was captured">
            Slideshow
          </button>
        </div>
      </div>
    </div>
  );
}
