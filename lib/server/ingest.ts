// Ingest: poll IMD politely, store new frames, derive fields and metrics, refresh the nowcast.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DOMAINS, pxKm } from '../shared/geo';
import { advect, computeFlow, meanFlow, type Flow } from '../shared/flow';
import { CFG, cloudStats } from '../shared/risk';
import { CHANNELS, type Channel, type CloudStats, type FrameMeta, type IngestStatus, type Nowcast } from '../shared/types';
import { getMasks } from './masks';
import { annotateSystems } from './openmeteo';
import { readHeaderTime } from './header-time';
import { calibrate, cleanBox, decodeJpeg, fieldDifference, resample } from './process';
import { STORAGE, clearFieldCache, dateFromId, idFromDate, listFrames, loadField, loadIndex, rawPath, readJson, saveField, saveIndex, storagePath, writeFile, writeJson } from './store';
import { detectSystems } from './systems';

const IMD_BASE = process.env.IMD_BASE_URL ?? 'https://mausam.imd.gov.in/Satellite/';
const UA = process.env.LANKAMET_USER_AGENT ?? 'LankaMet/0.1 (Sri Lanka cloud & rain dashboard)';
const RAW_RETENTION_DAYS = 14;
/** IMD publishes a frame 40–45 min after its scan starts. */
const PUBLISH_LAG_MIN = 40;

interface Shared {
  status: IngestStatus;
  busy: Promise<string> | null;
  /** raw files that turned out to be duplicates — no need to decode them again */
  skipped: Set<string>;
}
const g = globalThis as unknown as { __lankamet_ingest?: Shared };
const shared: Shared = (g.__lankamet_ingest ??= {
  status: { running: false, lastRun: null, lastOk: null, lastMessage: 'not run yet', log: [] },
  busy: null,
  skipped: new Set(),
});

export const getIngestStatus = (): IngestStatus => shared.status;

function log(ok: boolean, message: string) {
  const ts = new Date().toISOString();
  shared.status.log.unshift({ ts, ok, message });
  shared.status.log.length = Math.min(shared.status.log.length, 40);
  shared.status.lastRun = ts;
  shared.status.lastMessage = message;
  if (ok) shared.status.lastOk = ts;
  console.log(`[lankamet] ${ok ? 'ok ' : 'ERR'} ${message}`);
}

/**
 * Fallback scan time when the header cannot be read: IMD publishes a frame 40–45 minutes after
 * its scan starts, so back off 40 minutes from the moment we first saw it and floor to :00/:30.
 */
export function estimateScanStart(firstSeen: Date): Date {
  const t = new Date(firstSeen.getTime() - PUBLISH_LAG_MIN * 60000);
  t.setUTCMinutes(t.getUTCMinutes() - (t.getUTCMinutes() % 30), 0, 0);
  return t;
}

async function fetchWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60000) });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  throw last;
}

interface Processed {
  id: string;
  /** 'stored' | 'duplicate' | 'needs_review' */
  outcome: 'stored' | 'duplicate' | 'needs_review';
  note: string;
}

/** Decode one raw frame, work out its scan time, write its fields and register it in the index. */
async function processRaw(ch: Channel, buf: Buffer, info: { hintId?: string; fetchedAt: string }): Promise<Processed> {
  const index = await loadIndex();
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  for (const f of index.values()) {
    if (f.channels[ch]?.sha256 === sha256) return { id: f.id, outcome: 'duplicate', note: `${ch}: same file as ${f.id}` };
  }
  const img = await decodeJpeg(buf);
  const cal = calibrate(img);
  const problem = typeof cal === 'string' ? cal : null;
  const headerTime = readHeaderTime(img);
  const id = headerTime ? idFromDate(headerTime) : (info.hintId ?? idFromDate(estimateScanStart(new Date(info.fetchedAt))));
  const frame: FrameMeta = index.get(id) ?? { id, t: dateFromId(id).toISOString(), fetchedAt: info.fetchedAt, channels: {}, status: 'ok', timeSource: headerTime ? 'header' : 'estimated' };

  if (problem) {
    if (!Object.keys(frame.channels).length) {
      frame.status = 'needs_review';
      frame.reason = `${ch}: ${problem}`;
      index.set(id, frame);
    }
    return { id, outcome: 'needs_review', note: `${ch} ${id}: needs review (${problem})` };
  }
  const box = cleanBox(img, cal as Exclude<typeof cal, string>);
  const sl = resample(box, DOMAINS.sl);
  const region = resample(box, DOMAINS.region);

  // without a header time, guard against the same scan being stored twice under two ids
  if (!headerTime) {
    const before = [...index.values()].filter((f) => f.id < id && f.channels[ch] && f.status === 'ok').sort((a, b) => a.id.localeCompare(b.id));
    const prev = before[before.length - 1];
    const prevField = prev ? await loadField(ch, 'sl', prev.id) : null;
    if (prev && prevField && fieldDifference(prevField, sl) < 0.8) return { id: prev.id, outcome: 'duplicate', note: `${ch}: same picture as ${prev.id}` };
  }

  await saveField(ch, 'sl', id, sl);
  await saveField(ch, 'region', id, region);
  frame.channels[ch] = { sha256, bytes: buf.length };
  if (headerTime) frame.timeSource = 'header';
  if (ch === 'ir1') {
    frame.qa = box.qa;
    frame.geo = { ...box.cal, labelled: box.labelled };
  }
  frame.status = 'ok';
  delete frame.reason;
  index.set(id, frame);
  return { id, outcome: 'stored', note: `${ch} ${id}: stored${headerTime ? '' : ' (scan time estimated)'}` };
}

/** Cloud motion between two frames of a domain, normalised to one 30-minute interval. */
async function flowBetween(domain: 'sl' | 'region', a: FrameMeta, b: FrameMeta): Promise<Flow | null> {
  const gapMin = (Date.parse(b.t) - Date.parse(a.t)) / 60000;
  if (gapMin <= 0 || gapMin > 95) return null;
  const fa = await loadField('ir1', domain, a.id);
  const fb = await loadField('ir1', domain, b.id);
  if (!fa || !fb) return null;
  const d = DOMAINS[domain];
  const flow = computeFlow(fa, fb, d.width, d.height, domain === 'sl' ? { radius: 7, half: 9, step: 6 } : { radius: 6, half: 8, step: 8 });
  const k = CFG.frameMinutes / gapMin;
  if (k !== 1) {
    for (let i = 0; i < flow.u.length; i++) {
      flow.u[i] *= k;
      flow.v[i] *= k;
    }
  }
  return flow;
}

function motionOf(flow: Flow, domain: 'sl' | 'region', lat: number, box?: [number, number, number, number]) {
  const m = box ? meanFlow(flow, ...box) : meanFlow(flow);
  const k = pxKm(DOMAINS[domain], lat);
  const east = m.u * k.x * (60 / CFG.frameMinutes);
  const north = -m.v * k.y * (60 / CFG.frameMinutes);
  let heading = (Math.atan2(east, north) * 180) / Math.PI;
  if (heading < 0) heading += 360;
  return { speedKmh: Math.round(Math.hypot(east, north)), heading: Math.round(heading) };
}

/** Compute every metric of an IR frame: island and estate statistics, cloud motion, systems. */
async function analyse(frame: FrameMeta, withModel: boolean): Promise<void> {
  const sl = await loadField('ir1', 'sl', frame.id);
  const region = await loadField('ir1', 'region', frame.id);
  if (!sl || !region) return;
  const masks = getMasks();
  frame.island = cloudStats(sl, masks.island);
  frame.domain = cloudStats(sl);
  frame.estates = {};
  for (const e of masks.estates) frame.estates[e.slug] = cloudStats(sl, masks.estatePixels[e.slug]);

  const earlier = (await listFrames()).filter((f) => f.id < frame.id && f.channels.ir1 && f.status === 'ok');
  const prev = earlier[earlier.length - 1];
  const slFlow = prev ? await flowBetween('sl', prev, frame) : null;
  const regionFlow = prev ? await flowBetween('region', prev, frame) : null;
  frame.motion = slFlow ? motionOf(slFlow, 'sl', 7.8) : undefined;
  frame.systems = detectSystems(region, regionFlow, CFG.frameMinutes, prev?.systems, frame.id);
  if (withModel) await annotateSystems(frame.systems);
}

/** Extrapolate the latest frame along the recent cloud motion and summarise it per estate. */
async function buildNowcast(): Promise<Nowcast | null> {
  const frames = (await listFrames()).filter((f) => f.channels.ir1 && f.status === 'ok');
  if (frames.length < 2) return null;
  const latest = frames[frames.length - 1];
  const prev = frames[frames.length - 2];
  const flow = await flowBetween('sl', prev, latest);
  if (!flow) return null;
  const used = [prev.id, latest.id];
  // steady the motion with the previous pair when it is available (weights 2:1)
  if (frames.length >= 3) {
    const older = await flowBetween('sl', frames[frames.length - 3], prev);
    if (older) {
      for (let i = 0; i < flow.u.length; i++) {
        flow.u[i] = (2 * flow.u[i] + older.u[i]) / 3;
        flow.v[i] = (2 * flow.v[i] + older.v[i]) / 3;
      }
      used.unshift(frames[frames.length - 3].id);
    }
  }
  const field = await loadField('ir1', 'sl', latest.id);
  if (!field) return null;
  const masks = getMasks();
  const d = DOMAINS.sl;
  const out = new Uint8Array(d.width * d.height);
  const island: Nowcast['island'] = [];
  const perEstate = new Map<string, (CloudStats & { leadMin: number })[]>(masks.estates.map((e) => [e.slug, []]));
  for (const leadMin of CFG.nowcastLeads) {
    advect(field, flow, leadMin / CFG.frameMinutes, out);
    island.push({ leadMin, ...cloudStats(out, masks.island) });
    for (const e of masks.estates) perEstate.get(e.slug)?.push({ leadMin, ...cloudStats(out, masks.estatePixels[e.slug]) });
  }
  const nowcast: Nowcast = {
    baseId: latest.id,
    createdAt: new Date().toISOString(),
    from: used,
    motion: motionOf(flow, 'sl', 7.8),
    estates: masks.estates.map((e) => ({ slug: e.slug, leads: perEstate.get(e.slug) ?? [] })),
    island,
  };
  await writeJson(storagePath('nowcast.json'), nowcast);
  return nowcast;
}

export async function getNowcast(): Promise<Nowcast | null> {
  const nc = await readJson<Nowcast | null>(storagePath('nowcast.json'), null);
  if (!nc) return null;
  const frames = (await listFrames()).filter((f) => f.channels.ir1 && f.status === 'ok');
  return frames.length && frames[frames.length - 1].id === nc.baseId ? nc : null;
}

async function pruneRaw(): Promise<void> {
  const cutoff = Date.now() - RAW_RETENTION_DAYS * 86400e3;
  for (const ch of CHANNELS) {
    const dir = path.join(STORAGE, 'raw', ch);
    if (!fs.existsSync(dir)) continue;
    for (const f of await fsp.readdir(dir)) {
      const id = f.replace(/\.jpg$/, '');
      try {
        if (dateFromId(id).getTime() < cutoff) await fsp.unlink(path.join(dir, f));
      } catch {
        /* not a frame file */
      }
    }
  }
}

/** Process raw files that are on disk but not in the index (or everything, when `all`). */
async function backfill(all: boolean): Promise<number> {
  const index = await loadIndex();
  if (all) {
    index.clear();
    clearFieldCache();
    shared.skipped.clear();
  }
  const todo: { id: string; ch: Channel }[] = [];
  for (const ch of CHANNELS) {
    const dir = path.join(STORAGE, 'raw', ch);
    if (!fs.existsSync(dir)) continue;
    for (const f of await fsp.readdir(dir)) {
      const id = f.replace(/\.jpg$/, '');
      if (!/^\d{8}_\d{4}$/.test(id) || shared.skipped.has(`${ch}/${id}`)) continue;
      if (!index.get(id)?.channels[ch] && index.get(id)?.status !== 'needs_review') todo.push({ id, ch });
    }
  }
  todo.sort((a, b) => a.id.localeCompare(b.id) || a.ch.localeCompare(b.ch));
  const touched = new Set<string>();
  for (const { id, ch } of todo) {
    const file = rawPath(ch, id);
    const stat = await fsp.stat(file);
    const res = await processRaw(ch, await fsp.readFile(file), { hintId: id, fetchedAt: stat.mtime.toISOString() });
    if (res.outcome === 'stored' && res.id !== id) {
      // the file name disagreed with the time printed in the image: the image wins
      await fsp.rename(file, rawPath(ch, res.id)).catch(() => fsp.unlink(file).catch(() => {}));
    } else if (res.outcome !== 'stored') {
      shared.skipped.add(`${ch}/${id}`);
    }
    if (res.outcome === 'stored' && ch === 'ir1') touched.add(res.id);
  }
  const newest = [...index.keys()].sort().pop();
  for (const id of [...touched].sort()) {
    const frame = index.get(id);
    // only the newest frame gets the (current-conditions) model annotation
    if (frame?.channels.ir1 && frame.status === 'ok') await analyse(frame, id === newest);
  }
  if (todo.length) await saveIndex();
  return todo.length;
}

interface PollState {
  /** Content-Length of the file we last downloaded, per channel */
  length: Record<string, string>;
  lastNewAt: string | null;
  lastForcedAt: string | null;
}

async function pollImd(): Promise<string[]> {
  const notes: string[] = [];
  const state = await readJson<PollState>(storagePath('ingest-state.json'), { length: {}, lastNewAt: null, lastForcedAt: null });
  state.length ??= {};
  // Last-Modified is re-stamped every five minutes, so a new frame is recognised by a change of
  // Content-Length. As a safety net, download anyway (at most every 20 minutes) when nothing has
  // changed for over an hour — two frames could in principle have the same byte length.
  const now = Date.now();
  const stale = !state.lastNewAt || now - Date.parse(state.lastNewAt) > 65 * 60000;
  const force = stale && (!state.lastForcedAt || now - Date.parse(state.lastForcedAt) > 20 * 60000);
  const fresh: string[] = [];
  let changed = false;
  for (const ch of CHANNELS) {
    const url = `${IMD_BASE}3Dasiasec_${ch}.jpg`;
    const head = await fetchWithRetry(url, { method: 'HEAD' });
    const length = head.headers.get('content-length') ?? '';
    if (length && state.length[ch] === length && !force) continue;
    const res = await fetchWithRetry(url, { method: 'GET' });
    const buf = Buffer.from(await res.arrayBuffer());
    const done = await processRaw(ch, buf, { fetchedAt: new Date().toISOString() });
    state.length[ch] = String(buf.length);
    changed = true;
    if (done.outcome === 'duplicate') continue;
    // a frame that failed the layout check must never overwrite a good raw file
    await writeFile(done.outcome === 'stored' ? rawPath(ch, done.id) : storagePath('review', `${ch}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`), buf);
    notes.push(done.note);
    if (done.outcome === 'stored') {
      state.lastNewAt = new Date().toISOString();
      if (ch === 'ir1') fresh.push(done.id);
    }
  }
  if (force) state.lastForcedAt = new Date().toISOString();
  const index = await loadIndex();
  for (const id of fresh) {
    const frame = index.get(id);
    if (frame) await analyse(frame, true);
  }
  if (notes.length) await saveIndex();
  if (changed || force) await writeJson(storagePath('ingest-state.json'), state);
  return notes;
}

/**
 * One ingest pass. Safe to call often: it sends three HEAD requests and downloads only what changed.
 * `reprocess` rebuilds every field and metric from the raw files on disk.
 */
export function runIngest(opts: { reprocess?: boolean; offline?: boolean } = {}): Promise<string> {
  if (shared.busy) return shared.busy;
  shared.status.running = true;
  shared.busy = (async () => {
    try {
      const filled = await backfill(!!opts.reprocess);
      const notes = opts.offline ? [] : await pollImd();
      if (filled || notes.length || !(await getNowcast())) await buildNowcast();
      await pruneRaw();
      const message = [filled ? `${filled} raw file(s) processed from disk` : '', ...notes].filter(Boolean).join('; ') || 'no new frames';
      log(true, message);
      return message;
    } catch (err) {
      const message = `ingest failed: ${(err as Error).message}`;
      log(false, message);
      return message;
    } finally {
      shared.status.running = false;
      shared.busy = null;
    }
  })();
  return shared.busy;
}
