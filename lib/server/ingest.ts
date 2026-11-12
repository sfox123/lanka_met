// Ingest: poll IMD politely, store new frames, derive fields and metrics, refresh the nowcast.
// One call = one pass. Locally the scheduler calls it every 5 minutes; on Vercel an external
// cron hits GET /api/ingest?run=1 and the pass must finish within the function's time limit.
import crypto from 'node:crypto';
import { DOMAINS, pxKm } from '../shared/geo';
import { advect, computeFlow, meanFlow, type Flow } from '../shared/flow';
import { CFG, cloudStats } from '../shared/risk';
import { CHANNELS, type Channel, type CloudStats, type FrameMeta, type IngestStatus, type Nowcast } from '../shared/types';
import { backendWarning } from './backend';
import { getMasks } from './masks';
import { annotateSystems } from './openmeteo';
import { readHeaderTime } from './header-time';
import { calibrate, cleanBox, decodeJpeg, fieldDifference, resample } from './process';
import { KEYS, backendKind, clearFieldCache, dateFromId, deleteKeys, deletesOldImages, getBytes, idFromDate, keepHours, listFrames, listKeys, loadField, loadIndex, putBytes, readJson, saveField, saveIndex, writeJson } from './store';
import { detectSystems } from './systems';

const IMD_BASE = process.env.IMD_BASE_URL ?? 'https://mausam.imd.gov.in/Satellite/';
const UA = process.env.LANKAMET_USER_AGENT ?? 'LankaMet/0.1 (Sri Lanka cloud & rain dashboard)';
const ON_VERCEL = !!process.env.VERCEL;
/** Local folder only: raw frames are needed just for a reprocess, so they go after two weeks. */
const LOCAL_RAW_DAYS = Number(process.env.LANKAMET_RAW_DAYS) || 14;
/** IMD publishes a frame 40–45 min after its scan starts. */
const PUBLISH_LAG_MIN = 40;
// a serverless pass has about 60 s in total, so each IMD request gets less rope there
const FETCH_TIMEOUT_MS = ON_VERCEL ? 20000 : 60000;
const FETCH_TRIES = ON_VERCEL ? 2 : 3;

interface Shared {
  status: IngestStatus | null;
  statusReadAt: number;
  busy: Promise<string> | null;
  /** raw files that turned out to be duplicates — no need to decode them again */
  skipped: Set<string>;
}
const g = globalThis as unknown as { __lankamet_ingest?: Shared };
const shared: Shared = (g.__lankamet_ingest ??= { status: null, statusReadAt: 0, busy: null, skipped: new Set() });

const EMPTY_STATUS: IngestStatus = { running: false, lastRun: null, lastOk: null, lastMessage: 'not run yet', log: [] };

/** Ingest health, shared across server instances through the store. */
export async function getIngestStatus(): Promise<IngestStatus> {
  if (!shared.status || Date.now() - shared.statusReadAt > 20000) {
    shared.status = await readJson<IngestStatus>(KEYS.status, EMPTY_STATUS);
    shared.statusReadAt = Date.now();
  }
  return { ...shared.status, running: !!shared.busy, warning: backendWarning() ?? undefined };
}

async function log(ok: boolean, message: string) {
  const status = await getIngestStatus();
  const ts = new Date().toISOString();
  status.log.unshift({ ts, ok, message });
  status.log.length = Math.min(status.log.length, 40);
  status.lastRun = ts;
  status.lastMessage = message;
  if (ok) status.lastOk = ts;
  shared.status = status;
  console.log(`[lankamet] ${ok ? 'ok ' : 'ERR'} ${message}`);
  await writeJson(KEYS.status, { ...status, running: false }).catch((err) => console.warn('[lankamet] could not save status:', (err as Error).message));
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

async function fetchWithRetry(url: string, init: RequestInit, tries = FETCH_TRIES): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  throw new Error(`IMD ${init.method} failed: ${(last as Error)?.message ?? last}`);
}

interface Processed {
  id: string;
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
  await writeJson(KEYS.nowcast, nowcast);
  return nowcast;
}

export async function getNowcast(): Promise<Nowcast | null> {
  const nc = await readJson<Nowcast | null>(KEYS.nowcast, null);
  if (!nc) return null;
  const frames = (await listFrames()).filter((f) => f.channels.ir1 && f.status === 'ok');
  return frames.length && frames[frames.length - 1].id === nc.baseId ? nc : null;
}

/** Parse "raw/{channel}/{id}.jpg". */
function parseRawKey(key: string): { ch: Channel; id: string } | null {
  const m = /^raw\/(ir1|vis|wv)\/(\d{8}_\d{4})\.jpg$/.exec(key);
  return m ? { ch: m[1] as Channel, id: m[2] } : null;
}

/** Scan time encoded in a raw or field key, or null. */
function frameTimeOfKey(key: string): number | null {
  const m = /^(?:raw\/(?:ir1|vis|wv)|fields\/(?:ir1|vis|wv)\/(?:sl|region))\/(\d{8}_\d{4})\.(?:jpg|webp)$/.exec(key);
  return m ? dateFromId(m[1]).getTime() : null;
}

/**
 * Delete what has aged out. With image deletion on (always on Blob), raw frames, fields and
 * rejected frames older than keepHours() go — the index drops the same frames in saveIndex().
 * Otherwise (local folder, default) only raw frames older than two weeks are removed.
 * Returns the number of objects deleted.
 */
async function prune(): Promise<number> {
  const old: string[] = [];
  if (deletesOldImages()) {
    const cutoff = Date.now() - keepHours() * 3600e3;
    for (const prefix of ['raw/', 'fields/']) {
      for (const e of await listKeys(prefix)) {
        const t = frameTimeOfKey(e.key);
        if (t != null && t < cutoff) old.push(e.key);
      }
    }
    for (const e of await listKeys('review/')) if (Date.parse(e.uploadedAt) < cutoff) old.push(e.key);
  } else {
    const cutoff = Date.now() - LOCAL_RAW_DAYS * 86400e3;
    for (const e of await listKeys('raw/')) {
      const p = parseRawKey(e.key);
      if (p && dateFromId(p.id).getTime() < cutoff) old.push(e.key);
    }
  }
  await deleteKeys(old);
  return old.length;
}

/**
 * Process raw frames that are in the store but not in the index (or everything, when `all`).
 * Locally this picks up files dropped into storage/raw; on blob storage it only runs for a reprocess.
 */
async function backfill(all: boolean): Promise<number> {
  if (backendKind() === 'blob' && !all) return 0;
  const index = await loadIndex();
  if (all) {
    index.clear();
    clearFieldCache();
    shared.skipped.clear();
  }
  const todo: { key: string; id: string; ch: Channel; uploadedAt: string }[] = [];
  for (const e of await listKeys('raw/')) {
    const p = parseRawKey(e.key);
    if (!p || shared.skipped.has(`${p.ch}/${p.id}`)) continue;
    if (!index.get(p.id)?.channels[p.ch] && index.get(p.id)?.status !== 'needs_review') todo.push({ key: e.key, ...p, uploadedAt: e.uploadedAt });
  }
  todo.sort((a, b) => a.id.localeCompare(b.id) || a.ch.localeCompare(b.ch));
  const touched = new Set<string>();
  for (const { key, id, ch, uploadedAt } of todo) {
    const buf = await getBytes(key);
    if (!buf) continue;
    const res = await processRaw(ch, buf, { hintId: id, fetchedAt: uploadedAt });
    if (res.outcome === 'stored' && res.id !== id) {
      // the file name disagreed with the time printed in the image: the image wins
      await putBytes(KEYS.raw(ch, res.id), buf, 'image/jpeg');
      await deleteKeys([key]);
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
  const state = await readJson<PollState>(KEYS.poll, { length: {}, lastNewAt: null, lastForcedAt: null });
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
    await putBytes(done.outcome === 'stored' ? KEYS.raw(ch, done.id) : KEYS.review(ch), buf, 'image/jpeg');
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
  if (changed || force) await writeJson(KEYS.poll, state);
  return notes;
}

/**
 * One ingest pass. Safe to call often: it sends three HEAD requests and downloads only what changed.
 * `reprocess` rebuilds every field and metric from the stored raw frames.
 */
export function runIngest(opts: { reprocess?: boolean; offline?: boolean } = {}): Promise<string> {
  if (shared.busy) return shared.busy;
  shared.busy = (async () => {
    try {
      await loadIndex(true); // another instance may have written since we last looked
      const filled = await backfill(!!opts.reprocess);
      const notes = opts.offline ? [] : await pollImd();
      if (filled || notes.length || !(await getNowcast())) await buildNowcast();
      // listing a Blob store costs API calls, so only tidy up there when a new frame has arrived
      const removed = notes.length || backendKind() === 'fs' ? await prune() : 0;
      // the index must not keep pointing at images that were just deleted
      if (removed && deletesOldImages()) await saveIndex();
      const message = [filled ? `${filled} raw file(s) processed from the store` : '', ...notes, removed ? `${removed} old file(s) deleted` : ''].filter(Boolean).join('; ') || 'no new frames';
      await log(true, message);
      return message;
    } catch (err) {
      const message = `ingest failed: ${(err as Error).message}`;
      await log(false, message);
      return message;
    } finally {
      shared.busy = null;
    }
  })();
  return shared.busy;
}
