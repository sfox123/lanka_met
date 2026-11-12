'use client';

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { FieldEngine } from '@/lib/client/engine';
import { gridHour, kindAt, type TimeModel } from '@/lib/client/timeline';
import { sampleFlow } from '@/lib/shared/flow';
import { DOMAINS, domainCorners, domainLonLat, domainPx, type DomainId } from '@/lib/shared/geo';
import { PALETTES, colourModel, colourise, upsample, type PaletteId } from '@/lib/shared/palettes';
import { CFG, RISK_LABEL } from '@/lib/shared/risk';
import type { Channel, Estate, EstateState, FrameMeta, GridForecast, WeatherSystem } from '@/lib/shared/types';

const STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/dark';
const RISK_COLOUR: Record<string, string> = { low: '#0ca30c', moderate: '#fab219', high: '#ec835a', 'very-high': '#d03b3b' };
const SL_VIEW: [[number, number], [number, number]] = [
  [78.6, 5.4],
  [82.9, 10.2],
];
const REGION_VIEW: [[number, number], [number, number]] = [
  [62, -4],
  [99, 26],
];
// room for the controls at the top and the clock / legend at the bottom
const VIEW_PADDING = { top: 64, bottom: 40, left: 24, right: 24 };
/** the small Sri Lanka field is enlarged before colouring so contours come out smooth */
const DISPLAY_SCALE: Record<DomainId, number> = { sl: 3, region: 1 };

export interface MapViewProps {
  engine: FieldEngine;
  timeRef: MutableRefObject<number>;
  frames: FrameMeta[];
  timeModel: TimeModel | null;
  grid: GridForecast | null;
  channel: Channel;
  domain: DomainId;
  palette: PaletteId;
  opacity: number;
  smooth: boolean;
  particles: boolean;
  showEstates: boolean;
  estates: Estate[];
  estateState: EstateState[];
  selected: string | null;
  onSelect: (slug: string | null) => void;
  onSystem: (id: string) => void;
  focusSystem: WeatherSystem | null;
}

function circle(lon: number, lat: number, km: number): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * 2 * Math.PI;
    ring.push([lon + ((km / 111.32) * Math.cos(a)) / Math.cos((lat * Math.PI) / 180), lat + (km / 110.574) * Math.sin(a)]);
  }
  return ring;
}

async function loadStyle(): Promise<{ style: maplibregl.StyleSpecification; full: boolean }> {
  try {
    const res = await fetch(STYLE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    return { style: await res.json(), full: true };
  } catch {
    // offline or blocked: a plain dark background; the Sri Lanka outline is added separately
    return { style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1320' } }] }, full: false };
  }
}

export default function MapView(props: MapViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const partEl = useRef<HTMLCanvasElement>(null);
  const probeEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // ── map setup (once) ────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    let raf = 0;
    const canvases: Record<string, HTMLCanvasElement> = {};
    const buffers: Record<string, Uint8Array> = {};
    const images: Record<string, ImageData> = {};
    const big: Record<string, Uint8Array> = {};
    const tmp: Record<string, Float32Array> = {};
    for (const d of Object.values(DOMAINS)) {
      const s = DISPLAY_SCALE[d.id];
      const c = document.createElement('canvas');
      c.width = d.width * s;
      c.height = d.height * s;
      canvases[d.id] = c;
      buffers[d.id] = new Uint8Array(d.width * d.height);
      big[d.id] = new Uint8Array(d.width * s * d.height * s);
      tmp[d.id] = new Float32Array(d.width * d.height);
      images[d.id] = new ImageData(d.width * s, d.height * s);
    }
    const modelCanvas = document.createElement('canvas');
    modelCanvas.width = 2;
    modelCanvas.height = 2;

    void loadStyle().then(({ style, full }) => {
      if (disposed || !mapEl.current) return;
      const map = new maplibregl.Map({
        container: mapEl.current,
        style,
        bounds: propsRef.current.domain === 'sl' ? SL_VIEW : REGION_VIEW,
        fitBoundsOptions: { padding: VIEW_PADDING },
        attributionControl: { compact: true },
        maxZoom: 13,
        minZoom: 2.5,
        dragRotate: false,
        pitchWithRotate: false,
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.touchZoomRotate.disableRotation();

      map.on('load', () => {
        if (disposed) return;
        const layers = map.getStyle().layers ?? [];
        const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
        const fontLayer = layers.find((l) => l.type === 'symbol' && (l.layout as any)?.['text-font']);
        const font = (fontLayer?.layout as any)?.['text-font'] as string[] | undefined;

        for (const d of Object.values(DOMAINS)) {
          map.addSource(`field-${d.id}`, { type: 'canvas', canvas: canvases[d.id], coordinates: domainCorners(d), animate: true } as any);
          map.addLayer({ id: `field-${d.id}`, type: 'raster', source: `field-${d.id}`, paint: { 'raster-fade-duration': 0, 'raster-opacity': 0.9 }, layout: { visibility: 'none' } }, firstSymbol);
        }
        map.addSource('model', {
          type: 'canvas',
          canvas: modelCanvas,
          coordinates: [
            [79, 10],
            [82, 10],
            [82, 6],
            [79, 6],
          ],
          animate: true,
        } as any);
        map.addLayer({ id: 'model', type: 'raster', source: 'model', paint: { 'raster-fade-duration': 0, 'raster-opacity': 0.85 }, layout: { visibility: 'none' } }, firstSymbol);

        // the island outline stays readable through thick cloud colours
        map.addSource('sl-outline', { type: 'geojson', data: '/data/sri-lanka.geojson' });
        map.addLayer({ id: 'sl-outline', type: 'line', source: 'sl-outline', paint: { 'line-color': '#ffffff', 'line-opacity': full ? 0.55 : 0.8, 'line-width': 1 } }, firstSymbol);

        map.addSource('estates', { type: 'geojson', data: '/data/estates.geojson' });
        map.addSource('buffers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addSource('estate-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'buffers', type: 'line', source: 'buffers', paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': 1, 'line-dasharray': [3, 3] }, filter: ['==', ['get', 'slug'], ''] });
        map.addLayer({ id: 'estates-fill', type: 'fill', source: 'estates', minzoom: 8.5, paint: { 'fill-color': '#0ca30c', 'fill-opacity': 0.35 } });
        map.addLayer({ id: 'estates-line', type: 'line', source: 'estates', minzoom: 10, paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 0.5 } });
        // below zoom 8.5 an estate is smaller than a few pixels: show a dot instead
        map.addLayer({
          id: 'estate-dots',
          type: 'circle',
          source: 'estate-points',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 9, 7],
            'circle-color': ['get', 'colour'],
            'circle-stroke-color': '#0b111d',
            'circle-stroke-width': 2,
            'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 1, 10.5, 0],
            'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 1, 10.5, 0],
          },
        });
        map.addLayer({ id: 'estate-selected', type: 'circle', source: 'estate-points', filter: ['==', ['get', 'slug'], ''], paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
        if (font) {
          map.addLayer({
            id: 'estate-labels',
            type: 'symbol',
            source: 'estate-points',
            minzoom: 9,
            layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': false },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b111d', 'text-halo-width': 1.5 },
          });
        }

        const pick = (e: maplibregl.MapMouseEvent) => {
          const hits = map.queryRenderedFeatures(
            [
              [e.point.x - 6, e.point.y - 6],
              [e.point.x + 6, e.point.y + 6],
            ],
            { layers: ['estate-dots', 'estates-fill'] },
          );
          return (hits[0]?.properties?.slug as string | undefined) ?? null;
        };
        map.on('click', (e) => propsRef.current.onSelect(pick(e)));
        map.on('mousemove', (e) => {
          map.getCanvas().style.cursor = pick(e) ? 'pointer' : '';
          probe(e);
        });
        map.on('mouseout', () => {
          if (probeEl.current) probeEl.current.style.display = 'none';
        });
        map.on('move', clearParticles);
        readyRef.current = true;
        syncEstates();
        syncVisibility('');
      });
    });

    // ── hover probe: what the picture says under the pointer ──────────
    let lastKind = 'observed';
    let lastGridHour = 0;
    function probe(e: maplibregl.MapMouseEvent) {
      const el = probeEl.current;
      const p = propsRef.current;
      if (!el) return;
      const { lng, lat } = e.lngLat;
      let text = '';
      if (lastKind === 'model' && p.grid) {
        const g = p.grid;
        const c = Math.floor(((lng - g.west) / (g.east - g.west)) * g.cols);
        const r = Math.floor(((g.north - lat) / (g.north - g.south)) * g.rows);
        if (c >= 0 && r >= 0 && c < g.cols && r < g.rows) {
          const k = r * g.cols + c;
          text = `<b>${g.precipitation[lastGridHour][k].toFixed(1)} mm/h</b> rain · ${Math.round(g.cloud_cover[lastGridHour][k])}% cloud (model)`;
        }
      } else {
        const d = DOMAINS[p.domain];
        const [x, y] = domainPx(d, lng, lat);
        if (x >= 0 && y >= 0 && x < d.width && y < d.height) {
          const v = buffers[d.id][Math.floor(y) * d.width + Math.floor(x)] / 255;
          const what =
            p.channel === 'ir1'
              ? v >= CFG.deepT
                ? 'deep convection'
                : v >= CFG.coldT
                  ? 'cold cloud tops'
                  : v >= CFG.cloudT
                    ? 'cloud'
                    : 'mostly clear'
              : p.channel === 'wv'
                ? v > 0.68
                  ? 'moist upper air'
                  : v < 0.35
                    ? 'dry upper air'
                    : ''
                : '';
          const name = p.channel === 'ir1' ? 'Cloud index' : p.channel === 'wv' ? 'Moisture index' : 'Brightness';
          text = `${name} <b>${v.toFixed(2)}</b>${what ? ` · ${what}` : ''}`;
        }
      }
      if (!text) {
        el.style.display = 'none';
        return;
      }
      el.innerHTML = `${text}<br><span style="color:var(--muted)">${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${lng.toFixed(2)}°E</span>`;
      el.style.display = 'block';
      el.style.left = `${e.point.x}px`;
      el.style.top = `${e.point.y}px`;
    }

    // ── estates styling ───────────────────────────────────────────────
    let estateKey = '';
    function syncEstates() {
      const map = mapRef.current;
      const p = propsRef.current;
      if (!map || !readyRef.current) return;
      const key = JSON.stringify([p.estateState.map((e) => e.level), p.selected, p.showEstates, p.estates.length]);
      if (key === estateKey) return;
      estateKey = key;
      const level = new Map(p.estateState.map((e) => [e.slug, e.level]));
      const match: any[] = ['match', ['get', 'slug']];
      for (const e of p.estates) match.push(e.slug, RISK_COLOUR[level.get(e.slug) ?? 'low']);
      match.push('#8490a6');
      if (p.estates.length) map.setPaintProperty('estates-fill', 'fill-color', match);
      (map.getSource('estate-points') as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: p.estates.map((e) => ({
          type: 'Feature',
          properties: { slug: e.slug, name: e.name, colour: RISK_COLOUR[level.get(e.slug) ?? 'low'], risk: RISK_LABEL[level.get(e.slug) ?? 'low'] },
          geometry: { type: 'Point', coordinates: e.centroid },
        })),
      });
      (map.getSource('buffers') as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: p.estates.map((e) => ({
          type: 'Feature',
          properties: { slug: e.slug },
          geometry: { type: 'LineString', coordinates: circle(e.centroid[0], e.centroid[1], e.radiusKm + e.bufferKm) },
        })),
      });
      map.setFilter('buffers', ['==', ['get', 'slug'], p.selected ?? '']);
      map.setFilter('estate-selected', ['==', ['get', 'slug'], p.selected ?? '']);
      const vis = p.showEstates ? 'visible' : 'none';
      for (const id of ['estates-fill', 'estates-line', 'estate-dots', 'estate-labels', 'buffers', 'estate-selected']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
      }
    }

    let visKey = '';
    function syncVisibility(kind: string) {
      const map = mapRef.current;
      const p = propsRef.current;
      if (!map || !readyRef.current) return;
      const key = `${kind}|${p.domain}|${p.opacity}`;
      if (key === visKey) return;
      visKey = key;
      for (const d of Object.values(DOMAINS)) {
        map.setLayoutProperty(`field-${d.id}`, 'visibility', kind !== 'model' && kind !== '' && d.id === p.domain ? 'visible' : 'none');
        map.setPaintProperty(`field-${d.id}`, 'raster-opacity', p.opacity);
      }
      map.setLayoutProperty('model', 'visibility', kind === 'model' ? 'visible' : 'none');
      map.setPaintProperty('model', 'raster-opacity', Math.min(1, p.opacity + 0.05));
    }

    // ── system markers ────────────────────────────────────────────────
    let markerKey = '';
    function syncMarkers(frame: FrameMeta | undefined) {
      const map = mapRef.current;
      if (!map) return;
      const key = `${frame?.id ?? ''}|${frame?.systems?.length ?? 0}`;
      if (key === markerKey) return;
      markerKey = key;
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      for (const s of frame?.systems ?? []) {
        const el = document.createElement('div');
        el.className = 'sys-marker';
        el.dataset.level = s.level;
        el.title = `Cold-cloud system, organisation ${Math.round(s.org * 100)} / 100`;
        const ring = document.createElement('div');
        ring.className = 'ring';
        ring.textContent = String(Math.round(s.org * 100));
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = s.speedKmh != null && s.speedKmh >= 5 ? `${s.speedKmh} km/h ${arrow(s.heading ?? 0)}` : `${Math.round(s.areaKm2 / 1000)}k km²`;
        el.append(ring, tag);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          propsRef.current.onSystem(s.id);
        });
        markersRef.current.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(map));
      }
    }

    // ── particles: cloud-motion streaks ───────────────────────────────
    const N = 650;
    const px = new Float32Array(N);
    const py = new Float32Array(N);
    const age = new Float32Array(N).fill(1e9);
    let partDomain = '';
    const fo = new Float32Array(2);
    function clearParticles() {
      const c = partEl.current;
      c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    }
    function stepParticles(t: number) {
      const c = partEl.current;
      const map = mapRef.current;
      const p = propsRef.current;
      if (!c || !map) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(c.clientWidth * dpr);
      const h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      const on = p.particles && lastKind !== 'model';
      const got = on ? p.engine.flowAt(p.frames, p.domain, t) : null;
      // fade the existing trails
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = 'rgba(0,0,0,0.93)';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      if (!got) return;
      const d = DOMAINS[p.domain];
      if (partDomain !== d.id) {
        partDomain = d.id;
        age.fill(1e9);
      }
      // about 90 animation frames per satellite interval, independent of the time gap
      const k = 1 / 90;
      ctx.lineWidth = 1.1 * dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        if (age[i] > 110) {
          px[i] = Math.random() * d.width;
          py[i] = Math.random() * d.height;
          age[i] = Math.random() * 60;
        }
        sampleFlow(got.flow, px[i], py[i], fo);
        const speed = Math.hypot(fo[0], fo[1]);
        if (speed < 0.15) {
          age[i] += 8; // nearly still air: retire quickly, draw nothing
          continue;
        }
        const nx = px[i] + fo[0] * k * 3;
        const ny = py[i] + fo[1] * k * 3;
        const a = map.project(domainLonLat(d, px[i] - 0.5, py[i] - 0.5) as [number, number]);
        const b = map.project(domainLonLat(d, nx - 0.5, ny - 0.5) as [number, number]);
        ctx.moveTo(a.x * dpr, a.y * dpr);
        ctx.lineTo(b.x * dpr, b.y * dpr);
        px[i] = nx;
        py[i] = ny;
        age[i]++;
        if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) age[i] = 1e9;
      }
      ctx.stroke();
    }

    // ── render loop ───────────────────────────────────────────────────
    let drawKey = '';
    let modelKey = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const p = propsRef.current;
      const map = mapRef.current;
      if (!map || !readyRef.current || !p.timeModel) return;
      const t = p.timeRef.current;
      const kind = kindAt(p.timeModel, t);
      lastKind = kind;
      syncVisibility(kind);
      syncEstates();

      if (kind === 'model' && p.grid) {
        const g = p.grid;
        const hi = gridHour(g, t);
        lastGridHour = hi;
        const key = `${g.fetchedAt}|${hi}`;
        if (key !== modelKey) {
          modelKey = key;
          if (modelCanvas.width !== g.cols || modelCanvas.height !== g.rows) {
            modelCanvas.width = g.cols;
            modelCanvas.height = g.rows;
            (map.getSource('model') as maplibregl.CanvasSource).setCoordinates([
              [g.west, g.north],
              [g.east, g.north],
              [g.east, g.south],
              [g.west, g.south],
            ]);
          }
          const img = new ImageData(g.cols, g.rows);
          for (let i = 0; i < g.cols * g.rows; i++) {
            const [r, gg, b, a] = colourModel(g.precipitation[hi][i], g.cloud_cover[hi][i]);
            img.data[i * 4] = r;
            img.data[i * 4 + 1] = gg;
            img.data[i * 4 + 2] = b;
            img.data[i * 4 + 3] = a;
          }
          modelCanvas.getContext('2d')?.putImageData(img, 0, 0);
        }
      } else {
        const d = DOMAINS[p.domain];
        const key = `${Math.round(t / 1000)}|${p.channel}|${d.id}|${p.palette}|${p.smooth}|${p.engine.version}|${p.frames.length}`;
        if (key !== drawKey) {
          const info = p.engine.render(p.frames, p.channel, d.id, t, p.smooth, buffers[d.id]);
          if (info.ready && info.kind !== 'none') {
            drawKey = key;
            const s = DISPLAY_SCALE[d.id];
            if (s > 1) upsample(buffers[d.id], d.width, d.height, s, p.palette !== 'raw', tmp[d.id], big[d.id]);
            colourise(s > 1 ? big[d.id] : buffers[d.id], PALETTES[p.palette].lut, images[d.id].data);
            canvases[d.id].getContext('2d')?.putImageData(images[d.id], 0, 0);
          }
        }
      }
      // systems belong to the observation shown (the latest one when looking ahead)
      const ir = p.frames.filter((f) => f.systems);
      let shown = ir[ir.length - 1];
      for (const f of ir) if (Date.parse(f.t) <= t + 60000) shown = f;
      syncMarkers(p.domain === 'region' ? (t >= Date.parse(ir[0]?.t ?? '') ? shown : ir[0]) : undefined);
      stepParticles(t);
    };
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver(() => mapRef.current?.resize());
    if (wrapRef.current) ro.observe(wrapRef.current);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      readyRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // ── view follows the chosen domain ──────────────────────────────────
  const firstDomain = useRef(true);
  useEffect(() => {
    if (firstDomain.current) {
      firstDomain.current = false;
      return;
    }
    mapRef.current?.fitBounds(props.domain === 'sl' ? SL_VIEW : REGION_VIEW, { padding: VIEW_PADDING, duration: 900 });
  }, [props.domain]);

  // fly to a selected estate / system
  useEffect(() => {
    const e = props.estates.find((x) => x.slug === props.selected);
    const map = mapRef.current;
    if (!e || !map || props.domain !== 'sl') return;
    if (map.getZoom() < 8.2 || !map.getBounds().contains(e.centroid)) map.flyTo({ center: e.centroid, zoom: Math.max(map.getZoom(), 9.2), duration: 900 });
  }, [props.selected, props.estates, props.domain]);
  useEffect(() => {
    const s = props.focusSystem;
    if (s) mapRef.current?.fitBounds([[s.bbox[0] - 2, s.bbox[1] - 2], [s.bbox[2] + 2, s.bbox[3] + 2]], { padding: 40, duration: 900, maxZoom: 6.5 });
  }, [props.focusSystem]);

  return (
    <div ref={wrapRef} className="map-wrap">
      <div ref={mapEl} className="map" />
      <canvas ref={partEl} className="particles" />
      <div ref={probeEl} className="probe glass" style={{ display: 'none' }} />
    </div>
  );
}

function arrow(heading: number): string {
  return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][Math.round(heading / 45) % 8];
}
