'use client';

import { useMemo } from 'react';
import { ago, istDayTime, istTime, istWeekday, num, pct, weatherText } from '@/lib/client/format';
import { compass } from '@/lib/shared/geo';
import { CFG, RISK_LABEL, nowcastConfidence, satProbability } from '@/lib/shared/risk';
import type { AppState, Estate, EstateForecast, EstateState, ForecastBundle, FrameMeta, RiskLevel, WeatherSystem } from '@/lib/shared/types';
import { Card, HeatLegend, Heatmap, Legend, SegmentBar, Sparkline, TimeChart, type Panel, type StripCell } from './charts';

const RISK_COLOUR: Record<RiskLevel, string> = { low: '#0ca30c', moderate: '#fab219', high: '#ec835a', 'very-high': '#d03b3b' };
const C = { observed: '#3987e5', nowcast: '#9085e9', model: '#199e70', cold: '#d95926' };
const pctFmt = (v: number) => `${Math.round(v * 100)}%`;

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className="badge" data-level={level}>
      <i />
      {RISK_LABEL[level]}
    </span>
  );
}

// ── estate list ────────────────────────────────────────────────────────
export function EstateList({ app, selected, onSelect }: { app: AppState; selected: string | null; onSelect: (slug: string) => void }) {
  const order = useMemo(() => {
    const st = new Map(app.estateState.map((s) => [s.slug, s]));
    return [...app.estates].sort((a, b) => (st.get(b.slug)?.risk3h ?? 0) - (st.get(a.slug)?.risk3h ?? 0) || a.name.localeCompare(b.name));
  }, [app.estates, app.estateState]);
  const recent = app.frames.filter((f) => f.estates).slice(-13);
  return (
    <div className="estate-list">
      {order.map((e) => {
        const s = app.estateState.find((x) => x.slug === e.slug);
        const spark = recent.map((f) => f.estates?.[e.slug]?.mean).filter((v): v is number => v != null);
        return (
          <button key={e.slug} className="estate-row" aria-pressed={selected === e.slug} onClick={() => onSelect(e.slug)}>
            <span style={{ minWidth: 0 }}>
              <div className="name">{e.name}</div>
              <div className="meta">
                {s?.current ? `Cloud ${s.current.mean.toFixed(2)}` : 'No satellite data yet'}
                {s?.rain24h != null ? ` · ${num(s.rain24h, 1)} mm next 24 h` : ''}
              </div>
            </span>
            <Sparkline values={spark} label={`${e.name} cloud index, last 6 hours`} />
            {s ? <RiskBadge level={s.level} /> : <span />}
          </button>
        );
      })}
      <p className="note">Sorted by rain risk for the next 3 hours. The small chart is the cloud index over the last 6 hours.</p>
    </div>
  );
}

// ── estate detail ──────────────────────────────────────────────────────
const LANDUSE_COLOUR: Record<string, string> = { Rubber: '#3987e5', 'Built Up/ Village': '#d95926', Forest: '#199e70', Tea: '#c98500' };

function MonthBars({ monthly, current }: { monthly: number[]; current: number }) {
  const max = Math.max(...monthly, 1);
  const W = 12 * 22;
  return (
    <svg viewBox={`0 0 ${W} 58`} style={{ width: '100%', maxWidth: 340, display: 'block' }} role="img" aria-label={`Typical monthly rainfall: ${monthly.map((m, i) => `${'JFMAMJJASOND'[i]} ${m} mm`).join(', ')}`}>
      {monthly.map((m, i) => {
        const h = (m / max) * 40;
        return (
          <g key={i}>
            <title>{`${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i]}: ${m} mm`}</title>
            <path d={`M${i * 22 + 3},44V${44 - h + 3}q0,-3 3,-3h10q3,0 3,3V44Z`} fill={i === current ? 'var(--model)' : '#3a4763'} />
            <text x={i * 22 + 11} y={55} textAnchor="middle" style={{ fill: i === current ? 'var(--text)' : 'var(--muted)', fontSize: 9.5 }}>
              {'JFMAMJJASOND'[i]}
            </text>
          </g>
        );
      })}
      <line x1={0} x2={W} y1={44} y2={44} stroke="var(--axis)" />
    </svg>
  );
}

export function EstateDetail({ estate, state, app, forecast, time, now, onSeek, onBack }: { estate: Estate; state: EstateState | undefined; app: AppState; forecast: EstateForecast | undefined; time: number; now: number; onSeek: (t: number) => void; onBack: () => void }) {
  const frames = app.frames.filter((f) => f.estates?.[estate.slug]);
  const latest = frames[frames.length - 1];
  const nc = app.nowcast?.baseId === latest?.id ? app.nowcast?.estates.find((e) => e.slug === estate.slug) : undefined;

  // two charts, two questions: what has the cloud been doing, and what is forecast
  const base = latest ? Date.parse(latest.t) : now;
  const satMin = Math.max(base - 9 * 3600e3, frames.length ? Date.parse(frames[0].t) - 900e3 : base - 3600e3);
  const satMax = Math.max(now, base + (nc ? 180 : 30) * 60000) + 900e3;
  const fcMin = now - 2 * 3600e3;
  const fcMax = now + 24 * 3600e3;
  const satPanels = useMemo<Panel[]>(() => {
    const obs: [number, number][] = frames.map((f) => [Date.parse(f.t), f.estates![estate.slug].mean]);
    const like: [number, number][] = frames.map((f) => [Date.parse(f.t), satProbability(f.estates![estate.slug])]);
    const now1: [number, number][] = nc && latest ? [[base, latest.estates![estate.slug].mean], ...nc.leads.map((l): [number, number] => [base + l.leadMin * 60000, l.mean])] : [];
    const now2: [number, number][] = nc && latest ? [[base, satProbability(latest.estates![estate.slug])], ...nc.leads.map((l): [number, number] => [base + l.leadMin * 60000, satProbability(l)])] : [];
    return [
      {
        title: 'Cloud index (0 = clear, 1 = coldest cloud tops)',
        height: 84,
        max: 1,
        ticks: [0, 0.5, 1],
        tickFormat: (v) => v.toFixed(v === 0 || v === 1 ? 0 : 1),
        series: [
          { label: 'Cloud index', colour: C.observed, kind: 'area', points: obs, format: (v) => v.toFixed(2) },
          { label: 'Cloud index, nowcast', colour: C.nowcast, kind: 'dash', points: now1, format: (v) => v.toFixed(2) },
        ],
      },
      {
        title: 'Rain likelihood from satellite alone',
        height: 64,
        max: 1,
        ticks: [0, 0.5, 1],
        tickFormat: pctFmt,
        series: [
          { label: 'Satellite likelihood', colour: C.cold, kind: 'line', points: like },
          { label: 'Satellite likelihood, nowcast', colour: C.nowcast, kind: 'dash', points: now2 },
        ],
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.frames, app.nowcast, estate.slug]);
  const fcPanels = useMemo<Panel[]>(() => {
    const out: Panel[] = [];
    if (state?.risks.length) {
      const cells: StripCell[] = state.risks.map((r, i) => {
        const t = Date.parse(r.t);
        const next = state.risks[i + 1] ? Date.parse(state.risks[i + 1].t) : t + 3600e3;
        return { t0: t, t1: next, colour: RISK_COLOUR[r.level], label: `${RISK_LABEL[r.level]} (${Math.round(r.risk * 100)}%)` };
      });
      out.push({ title: 'Rain risk (satellite + model blend)', height: 16, max: 1, ticks: [], tickFormat: pctFmt, strip: cells });
    }
    if (forecast) {
      const h = forecast.hourly;
      const rain: [number, number | null][] = h.time.map((t, i) => [Date.parse(t), h.precipitation[i]]);
      const prob: [number, number | null][] = h.time.map((t, i) => [Date.parse(t), h.precipitation_probability[i] == null ? null : (h.precipitation_probability[i] as number) / 100]);
      const maxRain = Math.max(0, ...rain.filter(([t]) => t >= fcMin && t <= fcMax).map(([, v]) => v ?? 0));
      const top = maxRain <= 2 ? 2 : maxRain <= 5 ? 5 : maxRain <= 10 ? 10 : Math.ceil(maxRain / 10) * 10;
      out.push(
        { title: 'Rain, mm per hour', height: 70, max: top, ticks: [0, top / 2, top], tickFormat: (v) => String(v), series: [{ label: 'Rain', colour: C.model, kind: 'bar', points: rain, format: (v) => `${v.toFixed(1)} mm` }] },
        { title: 'Chance of rain', height: 56, max: 1, ticks: [0, 0.5, 1], tickFormat: pctFmt, series: [{ label: 'Chance of rain', colour: C.model, kind: 'line', points: prob }] },
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecast, state, Math.round(now / 600000)]);

  const cur = forecast?.current;
  const total = estate.landuse.reduce((s, l) => s + l.areaHa, 0);
  const main = estate.landuse.filter((l) => LANDUSE_COLOUR[l.name] && l.areaHa / total >= 0.015);
  const other = total - main.reduce((s, l) => s + l.areaHa, 0);
  const parts = [...main.map((l) => ({ name: l.name.replace('Built Up/ Village', 'Built-up'), value: l.areaHa, colour: LANDUSE_COLOUR[l.name] })), ...(other > 0.5 ? [{ name: 'Other', value: other, colour: '#55617a' }] : [])];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn ghost" onClick={onBack} aria-label="Back to all estates">
          ← All estates
        </button>
        <span style={{ flex: 1 }} />
        <a className="btn" href={`/api/estates/${estate.slug}/csv`} download>
          Download CSV
        </a>
      </div>
      <section className="card">
        <div className="hero">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: 17 }}>{estate.name}</h3>
            <div className="sub">
              {num(estate.areaHa)} ha · {estate.centroid[1].toFixed(3)}°N {estate.centroid[0].toFixed(3)}°E{forecast?.elevation != null ? ` · ${Math.round(forecast.elevation)} m` : ''}
            </div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              {state && <RiskBadge level={state.level} />}
              <span className="sub">rain risk, next 3 hours</span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="big">
              {state ? Math.round(state.risk3h * 100) : '–'}
              <small>%</small>
            </div>
          </div>
        </div>
      </section>
      <div className="tiles">
        <div className="tile">
          <div className="label">Cloud index now</div>
          <div className="value">{state?.current ? state.current.mean.toFixed(2) : '–'}</div>
          <div className="delta">{state?.trend1h == null ? 'trend after 1 h' : `${state.trend1h >= 0 ? '▲ +' : '▼ −'}${Math.abs(state.trend1h).toFixed(2)} in 1 h`}</div>
        </div>
        <div className="tile">
          <div className="label" title={`Within ${Math.round(estate.radiusKm + estate.bufferKm)} km of the estate centre`}>Cold cloud nearby</div>
          <div className="value">{pct(state?.current?.cold)}</div>
          <div className="delta">cloud cover {pct(state?.current?.cover)}</div>
        </div>
        <div className="tile">
          <div className="label" title="Rain likelihood from the satellite picture alone">Raining now?</div>
          <div className="value">{pct(state?.satProb)}</div>
          <div className="delta">{state?.gpi ? `≈ ${state.gpi.toFixed(1)} mm/h if so` : 'no cold tops'}</div>
        </div>
      </div>
      {cur && (
        <Card title="Weather at the estate" sub={`Open-Meteo analysis${cur.time ? ` · ${istTime(cur.time)} IST` : ''}`}>
          <div className="tiles" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
            <div>
              <div className="note">Conditions</div>
              <b>{weatherText(cur.weather_code)}</b>
            </div>
            <div>
              <div className="note">Temperature</div>
              <b>{num(cur.temperature_2m, 1)} °C</b>
            </div>
            <div>
              <div className="note">Humidity</div>
              <b>{num(cur.relative_humidity_2m)}%</b>
            </div>
            <div>
              <div className="note">Wind</div>
              <b>
                {num(cur.wind_speed_10m)} km/h {cur.wind_direction_10m != null ? compass(cur.wind_direction_10m) : ''}
              </b>
            </div>
          </div>
        </Card>
      )}
      <Card title="Cloud over the estate" sub="Satellite, last hours, and the cloud-motion nowcast. Click to move the map to that time.">
        {frames.length ? <TimeChart panels={satPanels} tMin={satMin} tMax={satMax} now={now} cursor={time} onPick={onSeek} /> : <p className="note">No satellite frames yet.</p>}
        <Legend
          items={[
            { label: 'Cloud index', colour: C.observed, kind: 'line' },
            { label: 'Rain likelihood', colour: C.cold, kind: 'line' },
            ...(nc ? [{ label: 'Nowcast', colour: C.nowcast, kind: 'dash' as const }] : []),
          ]}
        />
        {nc ? (
          <p className="note" style={{ marginTop: 6 }}>
            Nowcast confidence fades with lead time: about {pct(nowcastConfidence(60))} at +1 h, {pct(nowcastConfidence(120))} at +2 h, {pct(nowcastConfidence(180))} at +3 h.
          </p>
        ) : (
          <p className="note" style={{ marginTop: 6 }}>The nowcast starts once two consecutive frames are available.</p>
        )}
      </Card>
      <Card title="Next 24 hours" sub="Open-Meteo forecast, with the blended rain risk on top">
        {fcPanels.length ? <TimeChart panels={fcPanels} tMin={fcMin} tMax={fcMax} now={now} cursor={time} onPick={onSeek} /> : <p className="note">Open-Meteo forecast not loaded yet.</p>}
        <div className="legend-row">
          <span>Risk:</span>
          {(Object.keys(RISK_LABEL) as RiskLevel[]).map((l) => (
            <span key={l}>
              <i style={{ background: RISK_COLOUR[l] }} />
              {RISK_LABEL[l]}
            </span>
          ))}
        </div>
      </Card>
      {forecast && <WeekOutlook fc={forecast} />}
      <Card title="Land use" sub={`${num(estate.areaHa)} ha in ${estate.polygons} mapped parcels`}>
        <SegmentBar parts={parts} unit="ha" />
      </Card>
    </>
  );
}

function WeekOutlook({ fc }: { fc: EstateForecast }) {
  const d = fc.daily;
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const rows = d.time.map((day, i) => ({ day, i })).filter((r) => r.day >= today).slice(0, 7);
  const max = Math.max(10, ...rows.map((r) => d.precipitation_sum[r.i] ?? 0));
  return (
    <Card title="7-day outlook" sub="Open-Meteo daily totals">
      <table className="data">
        <thead>
          <tr>
            <th>Day</th>
            <th style={{ textAlign: 'left' }}>Rain</th>
            <th>mm</th>
            <th>Chance</th>
            <th>°C</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ day, i }) => {
            const mm = d.precipitation_sum[i] ?? 0;
            return (
              <tr key={day}>
                <td title={weatherText(d.weather_code[i])}>{day === today ? 'Today' : istWeekday(`${day}T06:00:00Z`)}</td>
                <td style={{ width: '42%' }}>
                  <div style={{ height: 8, width: `${Math.max(mm > 0 ? 2 : 0, (mm / max) * 100)}%`, background: 'var(--model)', borderRadius: '0 4px 4px 0' }} />
                </td>
                <td className="num">{mm.toFixed(1)}</td>
                <td className="num">{d.precipitation_probability_max[i] == null ? '–' : `${d.precipitation_probability_max[i]}%`}</td>
                <td className="num">
                  {num(d.temperature_2m_min[i])}–{num(d.temperature_2m_max[i])}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

export function ClimateCard({ estate, bundle }: { estate: Estate; bundle: ForecastBundle }) {
  const clim = bundle.climatology[estate.slug];
  const fc = bundle.estates.find((e) => e.slug === estate.slug);
  if (!clim || !fc) return null;
  const month = new Date(Date.now() + 5.5 * 3600e3).getUTCMonth();
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const next7 = fc.daily.time.reduce((s, day, i) => (day >= today ? s + (fc.daily.precipitation_sum[i] ?? 0) : s), 0);
  const daysInMonth = new Date(Date.UTC(new Date().getUTCFullYear(), month + 1, 0)).getUTCDate();
  const typicalWeek = (clim.monthly[month] / daysInMonth) * 7;
  const ratio = typicalWeek > 0 ? next7 / typicalWeek : 0;
  const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month];
  return (
    <Card title="Compared with normal" sub={`ERA5 reanalysis, ${clim.years[0]}–${clim.years[1]} monthly means`}>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))', marginBottom: 10 }}>
        <div>
          <div className="note">Forecast, next 7 days</div>
          <div style={{ fontSize: 19, fontWeight: 650 }}>{num(next7)} mm</div>
        </div>
        <div>
          <div className="note">Typical {monthName} week</div>
          <div style={{ fontSize: 19, fontWeight: 650 }}>{num(typicalWeek)} mm</div>
        </div>
      </div>
      <p className="note" style={{ marginBottom: 8 }}>
        {ratio >= 1.25 ? `Wetter than normal — about ${ratio.toFixed(1)}× a typical week.` : ratio <= 0.75 ? `Drier than normal — about ${Math.round(ratio * 100)}% of a typical week.` : 'Close to a typical week for this month.'}
      </p>
      <MonthBars monthly={clim.monthly} current={month} />
    </Card>
  );
}

// ── island overview ────────────────────────────────────────────────────
export function IslandPanel({ app, time, now, onSeek, onSelect }: { app: AppState; time: number; now: number; onSeek: (t: number) => void; onSelect: (slug: string) => void }) {
  const frames = app.frames.filter((f) => f.island);
  const latest = frames[frames.length - 1];
  const prev = frames[frames.length - 2];
  const base = latest ? Date.parse(latest.t) : 0;
  const nc = app.nowcast?.baseId === latest?.id ? app.nowcast : null;
  const tMin = frames.length ? Date.parse(frames[0].t) - 900e3 : now - 3600e3;
  const tMax = Math.max(now, base + (nc ? 180 : 30) * 60000) + 900e3;
  const panels = useMemo<Panel[]>(
    () => [
      {
        title: 'Share of the island under cloud',
        height: 92,
        max: 1,
        ticks: [0, 0.25, 0.5, 0.75, 1],
        tickFormat: pctFmt,
        series: [
          { label: 'Any cloud', colour: C.observed, kind: 'area', points: frames.map((f) => [Date.parse(f.t), f.island!.cover]) },
          { label: 'Cold cloud tops', colour: C.cold, kind: 'line', points: frames.map((f) => [Date.parse(f.t), f.island!.cold]) },
          ...(nc && latest
            ? [
                { label: 'Any cloud, nowcast', colour: C.observed, kind: 'dash' as const, points: [[base, latest.island!.cover], ...nc.island.map((l) => [base + l.leadMin * 60000, l.cover])] as [number, number][] },
                { label: 'Cold cloud tops, nowcast', colour: C.cold, kind: 'dash' as const, points: [[base, latest.island!.cold], ...nc.island.map((l) => [base + l.leadMin * 60000, l.cold])] as [number, number][] },
              ]
            : []),
        ],
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [app.frames, app.nowcast],
  );
  if (!latest) return <p className="note">Waiting for the first satellite frame.</p>;
  const heatFrames = frames.slice(-48);
  const d = (a: number, b: number | undefined) => (b == null ? '' : `${a - b >= 0 ? '▲ +' : '▼ −'}${Math.abs((a - b) * 100).toFixed(0)} pts in 30 min`);
  const motion = nc?.motion ?? latest.motion;
  return (
    <>
      <div className="tiles">
        <div className="tile">
          <div className="label">Island cloud cover</div>
          <div className="value">{pct(latest.island!.cover)}</div>
          <div className="delta">{d(latest.island!.cover, prev?.island?.cover)}</div>
        </div>
        <div className="tile">
          <div className="label">Cold cloud tops</div>
          <div className="value">{pct(latest.island!.cold)}</div>
          <div className="delta">{d(latest.island!.cold, prev?.island?.cold)}</div>
        </div>
        <div className="tile">
          <div className="label">Cloud motion</div>
          <div className="value">
            {motion ? motion.speedKmh : '–'}
            <small>km/h</small>
          </div>
          <div className="delta">{motion ? (motion.speedKmh < 4 ? 'nearly stationary' : `towards ${compass(motion.heading)}`) : 'needs two frames'}</div>
        </div>
      </div>
      <Card title="Cloud over Sri Lanka" sub={`Land pixels only · ${frames.length} frame${frames.length === 1 ? '' : 's'} · click to move the map`}>
        <TimeChart panels={panels} tMin={tMin} tMax={tMax} now={now} cursor={time} onPick={onSeek} />
        <Legend
          items={[
            { label: 'Any cloud', colour: C.observed, kind: 'line' },
            { label: 'Cold cloud tops (rain-bearing)', colour: C.cold, kind: 'line' },
            ...(nc ? [{ label: 'Dotted: nowcast', colour: '#b9c1d0', kind: 'dash' as const }] : []),
          ]}
        />
      </Card>
      <Card title="Cloud index by estate" sub="Each cell is one satellite frame; brighter means colder, deeper cloud">
        <Heatmap
          rows={app.estates.map((e) => ({ key: e.slug, label: e.name, values: heatFrames.map((f) => f.estates?.[e.slug]?.mean ?? null) }))}
          times={heatFrames.map((f) => Date.parse(f.t))}
          format={(v) => v.toFixed(2)}
          onPickRow={onSelect}
          cursor={time}
        />
        <HeatLegend low="0 clear" high="1 coldest tops" />
      </Card>
      <Card title="How the numbers are made">
        <dl className="kv">
          <dt>Cloud index</dt>
          <dd>IR brightness, 0–1 (colder = higher)</dd>
          <dt>Cloud</dt>
          <dd>index ≥ {CFG.cloudT}</dd>
          <dt>Cold cloud tops</dt>
          <dd>index ≥ {CFG.coldT}</dd>
          <dt>Deep convection</dt>
          <dd>index ≥ {CFG.deepT}</dd>
          <dt>Satellite rain likelihood</dt>
          <dd>1 − e^(−{CFG.satK} × convective intensity)</dd>
          <dt>Estate area</dt>
          <dd>estate + 12 km buffer</dd>
        </dl>
      </Card>
    </>
  );
}

// ── weather systems ────────────────────────────────────────────────────
const LEVEL_TEXT = { cluster: 'Convective cluster', watch: 'Organising — watch', organised: 'Well organised' } as const;

function describe(s: WeatherSystem): string {
  const where = `${Math.abs(s.lat).toFixed(1)}°${s.lat >= 0 ? 'N' : 'S'} ${s.lon.toFixed(1)}°E`;
  return `${where} · ${num(s.distKm)} km ${compass(s.bearing)} of Sri Lanka`;
}

export function SystemsPanel({ frames, focus, onFocus }: { frames: FrameMeta[]; focus: string | null; onFocus: (s: WeatherSystem) => void }) {
  const withSys = frames.filter((f) => f.systems);
  const latest = withSys[withSys.length - 1];
  if (!latest) return <p className="note">Waiting for the first satellite frame.</p>;
  const systems = [...(latest.systems ?? [])].sort((a, b) => b.org - a.org);
  return (
    <>
      <p className="note">
        Large cold-cloud clusters across the North Indian Ocean in the {istTime(latest.t)} IST frame ({ago(Date.now() - Date.parse(latest.t))}). The score rates how organised a cluster looks — it is not a cyclone forecast or an intensity estimate. Official cyclone bulletins come from the Department of Meteorology and RSMC New Delhi.
      </p>
      {!systems.length && <p className="note">No cold-cloud cluster larger than 8,000 km² in view.</p>}
      {systems.map((s) => {
        const history = withSys.slice(-13).map((f) => f.systems?.find((x) => x.id === s.id)?.org).filter((v): v is number => v != null);
        const eta = s.closingKmh != null && s.closingKmh >= 8 ? s.distKm / s.closingKmh : null;
        const lowPressure = s.model?.pressure != null && s.model.pressure < 1004;
        const strongWind = s.model?.wind != null && s.model.wind >= 40;
        return (
          <button key={s.id} className="sys-card" onClick={() => onFocus(s)} style={focus === s.id ? { borderColor: 'var(--accent)' } : undefined}>
            <div className="top">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{LEVEL_TEXT[s.level]}</div>
                <div className="note">{describe(s)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 22, fontWeight: 650, lineHeight: 1 }}>{Math.round(s.org * 100)}</div>
                <div className="note">of 100</div>
              </div>
            </div>
            <div className="meter" role="img" aria-label={`Organisation ${Math.round(s.org * 100)} of 100`}>
              <div style={{ width: `${s.org * 100}%`, background: s.level === 'organised' ? 'var(--critical)' : s.level === 'watch' ? 'var(--warning)' : 'var(--accent)' }} />
            </div>
            <div className="factors">
              {(
                [
                  ['Size', Math.min(1, s.areaKm2 / 200000)],
                  ['Roundness', s.roundness],
                  ['Depth', Math.min(1, s.deepFrac / 0.55)],
                  ['Spin', s.spin],
                ] as [string, number][]
              ).map(([label, v]) => (
                <div key={label}>
                  {label}
                  <div className="meter" style={{ height: 4, marginTop: 3 }}>
                    <div style={{ width: `${v * 100}%`, background: 'var(--text-2)' }} />
                  </div>
                </div>
              ))}
            </div>
            <dl className="kv">
              <dt>Cold-cloud shield</dt>
              <dd className="num">{num(s.areaKm2)} km²</dd>
              <dt>Movement</dt>
              <dd>{s.speedKmh == null ? 'needs two frames' : s.speedKmh < 5 ? 'nearly stationary' : `${s.speedKmh} km/h towards ${compass(s.heading ?? 0)}`}</dd>
              <dt>Relative to Sri Lanka</dt>
              <dd>{s.closingKmh == null ? '–' : s.closingKmh >= 8 ? `closing at ${s.closingKmh} km/h${eta && eta < 72 ? ` · ~${Math.round(eta)} h away at this rate` : ''}` : s.closingKmh <= -8 ? 'moving away' : 'holding distance'}</dd>
              {s.model && (
                <>
                  <dt>Model at centre</dt>
                  <dd className="num">
                    {num(s.model.pressure)} hPa · wind {num(s.model.wind)} km/h
                  </dd>
                </>
              )}
            </dl>
            {(lowPressure || strongWind) && <div className="note" style={{ color: 'var(--text)' }}>⚠ Model shows {[lowPressure && 'low surface pressure', strongWind && 'strong surface wind'].filter(Boolean).join(' and ')} here.</div>}
            {history.length > 2 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="note">Score, last {history.length} frames</span>
                <Sparkline values={history} width={110} height={22} label="Organisation score history" />
              </div>
            )}
          </button>
        );
      })}
    </>
  );
}

export function frameAgeText(latest: FrameMeta | undefined, now: number): string {
  return latest ? `Latest frame ${istDayTime(latest.t)} IST · ${ago(now - Date.parse(latest.t))}` : 'No frames yet';
}
