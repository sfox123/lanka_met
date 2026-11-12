'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FieldEngine } from '@/lib/client/engine';
import { ago, istDayTime, istTime } from '@/lib/client/format';
import { buildTimeModel, kindAt } from '@/lib/client/timeline';
import type { DomainId } from '@/lib/shared/geo';
import { PALETTES, paletteGradient, type PaletteId } from '@/lib/shared/palettes';
import { CFG, nowcastConfidence } from '@/lib/shared/risk';
import { CHANNELS, CHANNEL_LABEL, type AppState, type Channel, type EstateForecast, type ForecastBundle, type WeatherSystem } from '@/lib/shared/types';
import CaveatsModal from './CaveatsModal';
import { ClimateCard, EstateDetail, EstateList, IslandPanel, PointDetail, SystemsPanel } from './Panels';
import Timeline from './Timeline';

const MapView = dynamic(() => import('./MapView'), { ssr: false });

const PALETTES_FOR: Record<Channel, PaletteId[]> = { ir1: ['enhanced', 'rain', 'cloud', 'raw'], vis: ['raw', 'cloud'], wv: ['moisture', 'raw'] };
type Tab = 'estates' | 'island' | 'systems';

export default function Dashboard() {
  const engine = useMemo(() => new FieldEngine(), []);
  const [app, setApp] = useState<AppState | null>(null);
  const [bundle, setBundle] = useState<ForecastBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Sri Lanka date to show; null = live (the last 24 hours) */
  const [day, setDay] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>('ir1');
  const [domain, setDomain] = useState<DomainId>('sl');
  const [palette, setPalette] = useState<PaletteId>('enhanced');
  const [opacity, setOpacity] = useState(0.85);
  const [smooth, setSmooth] = useState(true);
  const [particles, setParticles] = useState(true);
  const [showEstates, setShowEstates] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState<Tab>('estates');
  const [selected, setSelected] = useState<string | null>(null);
  /** a place picked on the map (any point over Sri Lanka) and the forecast fetched for it */
  const [point, setPoint] = useState<{ lon: number; lat: number } | null>(null);
  const [pointFc, setPointFc] = useState<{ data: EstateForecast | null; error: string | null }>({ data: null, error: null });
  const [focusSystem, setFocusSystem] = useState<WeatherSystem | null>(null);
  const [about, setAbout] = useState(false);
  const [uiTime, setUiTime] = useState(0);
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const timeRef = useRef(0);
  const liveRef = useRef(true);
  /** after a day change, move the cursor to the start of that day's frames once they arrive */
  const seekToDayRef = useRef<string | null>(null);

  // ── data ────────────────────────────────────────────────────────────
  const loadState = useCallback(async () => {
    try {
      const res = await fetch(day ? `/api/state?day=${day}` : '/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next: AppState = await res.json();
      // ignore a late response for a day the user has already left
      setApp((cur) => (day && next.day !== day && cur ? cur : next));
      setError(null);
    } catch (err) {
      setError(`Cannot reach the LankaMet server (${(err as Error).message}). Showing the last data received.`);
    }
  }, [day]);
  useEffect(() => {
    void loadState();
    const id = setInterval(loadState, 60000);
    return () => clearInterval(id);
  }, [loadState]);
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/forecast', { cache: 'no-store' });
        if (res.ok) setBundle(await res.json());
      } catch {
        /* keep the previous forecast */
      }
    };
    void load();
    const id = setInterval(load, 20 * 60000);
    return () => clearInterval(id);
  }, []);
  // the estate risks on the server use the cached forecast: refresh once a newer forecast exists
  useEffect(() => {
    if (bundle?.fetchedAt && app && app.forecastFetchedAt !== bundle.fetchedAt) void loadState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.fetchedAt]);

  // forecast for the picked point, refreshed every 30 minutes while it stays selected
  useEffect(() => {
    setPointFc({ data: null, error: null });
    if (!point) return;
    const ctl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/point?lat=${point.lat.toFixed(2)}&lon=${point.lon.toFixed(2)}`, { signal: ctl.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setPointFc({ data: body, error: null });
      } catch (err) {
        // keep a forecast already shown; report the failure only when there is nothing to show
        if (!ctl.signal.aborted) setPointFc((cur) => (cur.data ? cur : { data: null, error: (err as Error).message }));
      }
    };
    void load();
    const id = setInterval(load, 30 * 60000);
    return () => {
      ctl.abort();
      clearInterval(id);
    };
  }, [point]);

  const live = !app || !day || day === app.today;
  const frames = useMemo(() => (app?.frames ?? []).filter((f) => f.status === 'ok'), [app]);
  // when the live day has no frames yet the timeline ends at "now", refreshed once a minute
  const nowMinute = Math.floor(now / 60000) * 60000;
  const tm = useMemo(
    () => (app ? buildTimeModel(frames, live ? (bundle?.grid ?? null) : null, { start: Date.parse(app.dayStart), end: Date.parse(app.dayEnd), live, now: nowMinute }) : null),
    [app, frames, bundle, live, nowMinute],
  );
  const latest = app?.latest ?? null;

  useEffect(() => {
    engine.preload(frames, channel, domain);
  }, [engine, frames, channel, domain]);

  // cursor placement when the data changes: follow the newest frame while live, or land on the
  // first frame of a freshly chosen day
  useEffect(() => {
    if (!tm || !app) return;
    if (seekToDayRef.current && app.day === seekToDayRef.current) {
      seekToDayRef.current = null;
      const first = frames.find((f) => Date.parse(f.t) >= tm.t0);
      timeRef.current = tm.live ? tm.tLast : first ? Date.parse(first.t) : tm.t0;
      setUiTime(timeRef.current);
      return;
    }
    const outside = timeRef.current < tm.t0 || timeRef.current > tm.tModelEnd || timeRef.current === 0;
    if ((tm.live && liveRef.current) || outside) {
      timeRef.current = tm.live ? tm.tLast : tm.t0;
      setUiTime(timeRef.current);
    }
  }, [tm, app, frames]);

  // UI clock: a few times a second is plenty for labels; the map reads timeRef every frame
  useEffect(() => {
    const id = setInterval(() => {
      setUiTime(timeRef.current);
      setVersion(engine.version);
      setNow(Date.now());
    }, 200);
    return () => clearInterval(id);
  }, [engine]);

  // ── playback ────────────────────────────────────────────────────────
  /** first and last frame time of the day shown, for the selected channel */
  const span = useMemo<[number, number] | null>(() => {
    if (!tm) return null;
    const ts = frames.filter((f) => f.channels[channel]).map((f) => Date.parse(f.t)).filter((t) => t >= tm.t0 && t <= tm.tLast);
    return ts.length ? [ts[0], ts[ts.length - 1]] : null;
  }, [tm, frames, channel]);
  useEffect(() => {
    if (!playing || !tm) return;
    let raf = 0;
    let last = performance.now();
    let hold = 0;
    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(100, ts - last);
      last = ts;
      const inModel = timeRef.current > tm.tNowcastEnd + 1;
      // loop over the part of the day that has frames, not the empty hours around it
      const from = inModel ? tm.tNowcastEnd : (span?.[0] ?? tm.t0);
      const to = inModel ? tm.tModelEnd : tm.live ? tm.tNowcastEnd : (span?.[1] ?? tm.tLast);
      if (to <= from) return;
      if (!inModel && timeRef.current < from) timeRef.current = from;
      if (hold > 0) {
        hold -= dt;
        if (hold <= 0) timeRef.current = from;
        return;
      }
      // data time per real second: one frame interval per half second, faster for long stretches
      const perSec = inModel ? 4 * 3600e3 : Math.max(60 * 60000, (to - from) / 25);
      timeRef.current += (dt / 1000) * perSec * speed;
      if (timeRef.current >= to) {
        timeRef.current = to;
        hold = 900;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, tm, speed, span]);

  const seek = useCallback((t: number) => {
    liveRef.current = false;
    timeRef.current = t;
    setUiTime(t);
  }, []);

  const stops = useMemo(() => {
    if (!tm) return [];
    const s = frames.filter((f) => f.channels[channel]).map((f) => Date.parse(f.t)).filter((t) => t >= tm.t0 && t <= tm.tLast);
    if (tm.live) {
      for (const lead of CFG.nowcastLeads) if (tm.tLast + lead * 60000 <= tm.tNowcastEnd) s.push(tm.tLast + lead * 60000);
      for (const t of bundle?.grid?.time ?? []) if (Date.parse(t) > tm.tNowcastEnd && Date.parse(t) <= tm.tModelEnd) s.push(Date.parse(t));
    }
    return s.sort((a, b) => a - b);
  }, [tm, frames, channel, bundle]);
  const step = useCallback(
    (dir: -1 | 1) => {
      setPlaying(false);
      const t = timeRef.current;
      const next = dir > 0 ? stops.find((s) => s > t + 1000) : [...stops].reverse().find((s) => s < t - 1000);
      if (next != null) seek(next);
    },
    [stops, seek],
  );
  const pickDay = useCallback(
    (d: string) => {
      if (!app) return;
      setPlaying(false);
      liveRef.current = d === app.today;
      seekToDayRef.current = d;
      setDay(d === app.today ? null : d);
    },
    [app],
  );
  const goLive = useCallback(() => {
    setPlaying(false);
    liveRef.current = true;
    if (day) {
      seekToDayRef.current = app?.today ?? null;
      setDay(null);
      return;
    }
    if (!tm) return;
    timeRef.current = tm.tLast;
    setUiTime(tm.tLast);
  }, [tm, day, app]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, select, textarea, button, a, [role=slider]')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const pickChannel = (ch: Channel) => {
    setChannel(ch);
    setPalette(PALETTES_FOR[ch][0]);
  };
  const selectEstate = useCallback((slug: string | null) => {
    setSelected(slug);
    setPoint(null);
    if (slug) setTab('estates');
  }, []);
  const pickPoint = useCallback((lon: number, lat: number) => {
    setSelected(null);
    setPoint({ lon, lat });
    setTab('estates');
  }, []);
  const focusOn = useCallback((s: WeatherSystem) => {
    setDomain('region');
    setFocusSystem({ ...s });
  }, []);
  const onSystem = useCallback(
    (id: string) => {
      setTab('systems');
      const s = frames.flatMap((f) => f.systems ?? []).reverse().find((x) => x.id === id);
      if (s) setFocusSystem({ ...s });
    },
    [frames],
  );

  // ── derived UI state ────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loaded = useMemo(() => new Set(frames.filter((f) => engine.get(channel, domain, f.id)).map((f) => f.id)), [frames, channel, domain, version, engine]);
  const kind = tm ? kindAt(tm, uiTime) : 'observed';
  const lastSeen = latest ? Math.max(Date.parse(latest.fetchedAt), Date.parse(latest.t)) : 0;
  const sinceNew = latest ? now - lastSeen : Infinity;
  const ageState = !latest ? 'none' : sinceNew > 120 * 60000 ? 'red' : sinceNew > 60 * 60000 ? 'amber' : 'ok';
  const pal = PALETTES[palette];
  const watchCount = (frames[frames.length - 1]?.systems ?? []).filter((s) => s.level !== 'cluster').length;
  const estate = app?.estates.find((e) => e.slug === selected);
  const leadMin = tm ? Math.round((uiTime - tm.tLast) / 60000) : 0;
  const hasChannel = frames.some((f) => f.channels[channel] && tm && Date.parse(f.t) >= tm.t0);

  return (
    <div className="app">
      <div>
        <header className="header">
          <div className="brand">
            <h1>LankaMet</h1>
            <span>Sri Lanka cloud &amp; rain watch · situational awareness, not an official forecast</span>
          </div>
          <span className="spacer" />
          <span className="attrib">Satellite: IMD / ISRO INSAT-3DS · Weather data by Open-Meteo.com</span>
          <div className="live" data-age={ageState} title={app?.status.lastMessage ? `Last ingest: ${app.status.lastMessage}` : undefined}>
            <span className="dot" />
            {latest ? (
              <span>
                Latest frame <b>{istTime(latest.t)} IST</b> · {ago(now - Date.parse(latest.t))}
              </span>
            ) : (
              <span>Waiting for the first frame</span>
            )}
          </div>
          <button className="btn" onClick={() => setAbout(true)}>
            About &amp; caveats
          </button>
        </header>
        {error && <div className="banner">⚠ {error}</div>}
        {app?.status.warning && <div className="banner">⚠ {app.status.warning}</div>}
        {ageState === 'red' && !error && <div className="banner">⚠ No new satellite frame for over 2 hours. IMD may be late, or the ingest is failing: {app?.status.lastMessage}</div>}
      </div>

      <div className="main">
        <div className="stage">
          <div style={{ position: 'relative', minHeight: 0 }}>
            <div style={{ position: 'absolute', inset: 0, display: 'grid' }}>
              <MapView
                engine={engine}
                timeRef={timeRef}
                frames={frames}
                timeModel={tm}
                grid={live ? (bundle?.grid ?? null) : null}
                channel={channel}
                domain={domain}
                palette={palette}
                opacity={opacity}
                smooth={smooth}
                particles={particles}
                showEstates={showEstates}
                estates={app?.estates ?? []}
                estateState={app?.estateState ?? []}
                selected={selected}
                onSelect={selectEstate}
                point={point}
                onPoint={pickPoint}
                onSystem={onSystem}
                focusSystem={focusSystem}
              />
            </div>
            <div className="map-ui tl">
              <div className="seg" role="group" aria-label="Map area">
                <button aria-pressed={domain === 'sl'} onClick={() => setDomain('sl')}>
                  Sri Lanka
                </button>
                <button aria-pressed={domain === 'region'} onClick={() => setDomain('region')}>
                  Indian Ocean
                </button>
              </div>
              <div className="seg" role="group" aria-label="Satellite channel">
                {CHANNELS.map((ch) => (
                  <button key={ch} aria-pressed={channel === ch} onClick={() => pickChannel(ch)}>
                    {CHANNEL_LABEL[ch]}
                  </button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="Colouring">
                {PALETTES_FOR[channel].map((id) => (
                  <button key={id} aria-pressed={palette === id} onClick={() => setPalette(id)} title={PALETTES[id].hint}>
                    {PALETTES[id].label}
                  </button>
                ))}
              </div>
              <div className="glass layer-menu">
                <label>
                  Opacity
                  <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} aria-label="Cloud layer opacity" />
                </label>
                <label>
                  <input type="checkbox" checked={particles} onChange={(e) => setParticles(e.target.checked)} />
                  Motion streaks
                </label>
                <label>
                  <input type="checkbox" checked={showEstates} onChange={(e) => setShowEstates(e.target.checked)} />
                  Estates
                </label>
              </div>
            </div>
            {tm && (
              <div className="map-ui bl">
                <div className="glass clock">
                  <div className="when num">{istDayTime(uiTime)} IST</div>
                  <div className="what">
                    <span className="kind" data-kind={kind}>
                      {kind === 'observed' ? (tm.live ? 'Observed' : 'Recorded') : kind === 'nowcast' ? `Nowcast +${leadMin} min` : uiTime <= tm.tLast ? 'Model · no satellite image' : 'Model forecast'}
                    </span>
                    <span>
                      {kind === 'observed'
                        ? `INSAT-3DS ${CHANNEL_LABEL[channel].toLowerCase()}${playing && smooth ? ' · motion-interpolated' : ''}`
                        : kind === 'nowcast'
                          ? `cloud moved along its motion · confidence ${Math.round(nowcastConfidence(leadMin) * 100)}%`
                          : 'Open-Meteo rain and cloud'}
                    </span>
                  </div>
                </div>
                <div className="glass legend">
                  {kind === 'model' ? (
                    <>
                      <div className="title">
                        <span>Forecast rain, mm per hour</span>
                      </div>
                      <div className="bar" style={{ backgroundImage: 'linear-gradient(90deg, rgba(235,238,245,0.5), rgb(150,200,250) 12%, rgb(95,140,240) 55%, rgb(120,80,230))' }} />
                      <div className="ticks">
                        <span style={{ left: '6%' }}>cloud</span>
                        <span style={{ left: '30%' }}>1</span>
                        <span style={{ left: '65%' }}>5</span>
                        <span style={{ left: '94%' }}>12+</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="title">
                        <span>{pal.hint}</span>
                      </div>
                      <div className="bar" style={{ backgroundImage: paletteGradient(pal) }} />
                      <div className="ticks">
                        {pal.ticks.map(([v, label]) => (
                          <span key={label} style={{ left: `${Math.min(92, Math.max(8, v * 100))}%` }}>
                            {label}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            {(!tm || !hasChannel) && (
              <div className="empty-map">
                <div className="glass">
                  {!app
                    ? 'Loading…'
                    : !tm || !latest
                      ? `Fetching the first satellite frame from IMD. ${app.status.lastMessage}`
                      : tm.live
                        ? `No ${CHANNEL_LABEL[channel].toLowerCase()} frames in the last 24 hours.${app.hasOlder ? ' Use the date picker to open an earlier day.' : ''}`
                        : `No ${CHANNEL_LABEL[channel].toLowerCase()} frames were recorded on ${app.day}.`}
                </div>
              </div>
            )}
          </div>
          {tm && app && (
            <Timeline
              tm={tm}
              frames={frames}
              loaded={loaded}
              time={uiTime}
              now={now}
              playing={playing}
              speed={speed}
              smooth={smooth}
              day={app.day}
              today={app.today}
              days={app.days}
              showDays={app.hasOlder || !live}
              onSeek={seek}
              onPlay={(p) => {
                if (p) liveRef.current = false;
                setPlaying(p);
              }}
              onStep={step}
              onLive={goLive}
              onSpeed={setSpeed}
              onDay={pickDay}
              onSmooth={setSmooth}
            />
          )}
        </div>

        <aside className="side">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'estates'} onClick={() => setTab('estates')}>
              Estates<span className="count">{app?.estates.length ?? ''}</span>
            </button>
            <button role="tab" aria-selected={tab === 'island'} onClick={() => setTab('island')}>
              Island
            </button>
            <button role="tab" aria-selected={tab === 'systems'} onClick={() => setTab('systems')}>
              Systems{watchCount > 0 && <span className="count">{watchCount} to watch</span>}
            </button>
          </div>
          <div className="side-scroll">
            {!app && <p className="note">Loading…</p>}
            {app && !live && <p className="note">Showing {app.day} (Sri Lanka time). Risk badges and forecasts are always current.</p>}
            {app && tab === 'estates' && !estate && !point && <EstateList app={app} selected={selected} onSelect={selectEstate} />}
            {app && tab === 'estates' && !estate && point && (
              <PointDetail point={point} engine={engine} version={version} app={app} live={live} forecast={pointFc.data} forecastError={pointFc.error} time={uiTime} now={now} onSeek={seek} onBack={() => setPoint(null)} />
            )}
            {app && tab === 'estates' && estate && (
              <>
                <EstateDetail estate={estate} state={app.estateState.find((s) => s.slug === estate.slug)} app={app} forecast={bundle?.estates.find((e) => e.slug === estate.slug)} time={uiTime} now={now} onSeek={seek} onBack={() => setSelected(null)} />
                {bundle && <ClimateCard estate={estate} bundle={bundle} />}
              </>
            )}
            {app && tab === 'island' && <IslandPanel app={app} time={uiTime} now={now} onSeek={seek} onSelect={selectEstate} />}
            {app && tab === 'systems' && <SystemsPanel frames={frames} focus={focusSystem?.id ?? null} onFocus={focusOn} />}
            {bundle?.error && <p className="note">Open-Meteo refresh failed ({bundle.error}); showing the forecast from {bundle.fetchedAt ? istDayTime(bundle.fetchedAt) : 'never'}.</p>}
            <p className="note" style={{ marginTop: 'auto', paddingTop: 8 }}>
              Satellite imagery: IMD / ISRO INSAT-3DS · Weather data by{' '}
              <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
                Open-Meteo.com
              </a>{' '}
              (CC BY 4.0){bundle?.fetchedAt ? ` · forecast updated ${istTime(bundle.fetchedAt)} IST` : ''}
            </p>
          </div>
        </aside>
      </div>
      {about && <CaveatsModal onClose={() => setAbout(false)} />}
    </div>
  );
}
