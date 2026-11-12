// Everything the app keeps, as keys in the backend (see backend.ts):
//   raw/{channel}/{id}.jpg              IMD frames exactly as downloaded (pruned after a few days)
//   fields/{channel}/{domain}/{id}.webp cleaned, georeferenced 8-bit fields (kept)
//   review/{channel}_{time}.jpg         frames that failed the layout check
//   index.json                          one record per frame with all computed metrics (last 7 days)
//   nowcast.json, forecast.json, climatology.json, ingest-state.json, ingest-status.json
import sharp from 'sharp';
import type { Channel, FrameMeta } from '../shared/types';
import { DOMAINS, type DomainId } from '../shared/geo';
import { getBackend } from './backend';

export const KEYS = {
  raw: (ch: Channel, id: string) => `raw/${ch}/${id}.jpg`,
  field: (ch: Channel, domain: DomainId, id: string) => `fields/${ch}/${domain}/${id}.webp`,
  review: (ch: Channel) => `review/${ch}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`,
  index: 'index.json',
  nowcast: 'nowcast.json',
  forecast: 'forecast.json',
  climatology: 'climatology.json',
  poll: 'ingest-state.json',
  status: 'ingest-status.json',
} as const;

export const backendKind = () => getBackend().kind;

/** Days of frames kept in index.json (the UI offers up to 7 days of history). */
const INDEX_DAYS = Number(process.env.LANKAMET_INDEX_DAYS) || 7;
/** How long a cached read of a mutable object may be reused before asking the store again. */
const READ_TTL_MS = 20000;

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  const buf = await getBackend().get(key, { fresh: true });
  if (!buf) return fallback;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(key: string, data: unknown): Promise<void> {
  await getBackend().put(key, Buffer.from(JSON.stringify(data)), { contentType: 'application/json', mutable: true });
}

export const getBytes = (key: string) => getBackend().get(key);
export const putBytes = (key: string, data: Uint8Array, contentType: string, mutable = false) => getBackend().put(key, data, { contentType, mutable });
export const listKeys = (prefix: string) => getBackend().list(prefix);
export const deleteKeys = (keys: string[]) => getBackend().del(keys);

// The module graph can be instantiated more than once inside one Next.js server (route bundles,
// instrumentation), so shared mutable state hangs off globalThis. On Vercel every instance has its
// own copy, which is why cached reads expire after READ_TTL_MS.
interface Shared {
  index: Map<string, FrameMeta> | null;
  indexReadAt: number;
  fieldCache: Map<string, Uint8Array>;
}
const g = globalThis as unknown as { __lankamet_store?: Shared };
const shared: Shared = (g.__lankamet_store ??= { index: null, indexReadAt: 0, fieldCache: new Map() });

/** The frame index. `fresh` forces a re-read from the store (used at the start of an ingest run). */
export async function loadIndex(fresh = false): Promise<Map<string, FrameMeta>> {
  const stale = backendKind() === 'blob' && Date.now() - shared.indexReadAt > READ_TTL_MS;
  if (!shared.index || fresh || stale) {
    const list = await readJson<FrameMeta[]>(KEYS.index, []);
    shared.index = new Map(list.map((f) => [f.id, f]));
    shared.indexReadAt = Date.now();
  }
  return shared.index;
}

export async function saveIndex(): Promise<void> {
  const idx = await loadIndex();
  const cutoff = Date.now() - INDEX_DAYS * 86400e3;
  const list = [...idx.values()].filter((f) => Date.parse(f.t) >= cutoff).sort((a, b) => a.id.localeCompare(b.id));
  shared.index = new Map(list.map((f) => [f.id, f]));
  shared.indexReadAt = Date.now();
  await writeJson(KEYS.index, list);
}

/** Frames in time order. */
export async function listFrames(): Promise<FrameMeta[]> {
  return [...(await loadIndex()).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function saveField(ch: Channel, domain: DomainId, id: string, data: Uint8Array): Promise<void> {
  const d = DOMAINS[domain];
  const img = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: d.width, height: d.height, channels: 1 } });
  // the small Sri Lanka field feeds the metrics, so keep it exact; the wide field is for display and tracking
  const buf = await (domain === 'sl' ? img.webp({ lossless: true }) : img.webp({ quality: 86 })).toBuffer();
  await putBytes(KEYS.field(ch, domain, id), buf, 'image/webp');
  cacheField(`${ch}/${domain}/${id}`, data);
}

function cacheField(key: string, data: Uint8Array) {
  shared.fieldCache.set(key, data);
  if (shared.fieldCache.size > 24) shared.fieldCache.delete(shared.fieldCache.keys().next().value as string);
}

export async function loadField(ch: Channel, domain: DomainId, id: string): Promise<Uint8Array | null> {
  const key = `${ch}/${domain}/${id}`;
  const hit = shared.fieldCache.get(key);
  if (hit) return hit;
  const file = await getBytes(KEYS.field(ch, domain, id));
  if (!file) return null;
  const d = DOMAINS[domain];
  const { data, info } = await sharp(file).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== d.width || info.height !== d.height) return null;
  const out = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  cacheField(key, out);
  return out;
}

export function clearFieldCache() {
  shared.fieldCache.clear();
}

/** Frame id (scan start, UTC) ↔ Date. */
export function idFromDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
export function dateFromId(id: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/.exec(id);
  if (!m) throw new Error(`bad frame id ${id}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}
