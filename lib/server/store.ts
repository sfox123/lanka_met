// Local file store. Everything the app keeps lives under ./storage (override with LANKAMET_STORAGE):
//   raw/{channel}/{id}.jpg              IMD frames exactly as downloaded (pruned after 14 days)
//   fields/{channel}/{domain}/{id}.webp cleaned, georeferenced 8-bit fields (kept)
//   index.json                          one record per frame with all computed metrics
//   nowcast.json, forecast.json, climatology.json, ingest-state.json
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Channel, FrameMeta } from '../shared/types';
import { DOMAINS, type DomainId } from '../shared/geo';

export const STORAGE = process.env.LANKAMET_STORAGE ?? path.join(process.cwd(), 'storage');

export const rawPath = (ch: Channel, id: string) => path.join(STORAGE, 'raw', ch, `${id}.jpg`);
export const fieldPath = (ch: Channel, domain: DomainId, id: string) => path.join(STORAGE, 'fields', ch, domain, `${id}.webp`);
export const storagePath = (...p: string[]) => path.join(STORAGE, ...p);

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

export async function writeFile(file: string, data: Buffer | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
}

// The module graph can be instantiated more than once inside one Next.js server (route bundles,
// instrumentation), so shared mutable state hangs off globalThis.
interface Shared {
  index: Map<string, FrameMeta> | null;
  fieldCache: Map<string, Uint8Array>;
}
const g = globalThis as unknown as { __lankamet_store?: Shared };
const shared: Shared = (g.__lankamet_store ??= { index: null, fieldCache: new Map() });

export async function loadIndex(): Promise<Map<string, FrameMeta>> {
  if (!shared.index) {
    const list = await readJson<FrameMeta[]>(storagePath('index.json'), []);
    shared.index = new Map(list.map((f) => [f.id, f]));
  }
  return shared.index;
}

export async function saveIndex(): Promise<void> {
  const idx = await loadIndex();
  const list = [...idx.values()].sort((a, b) => a.id.localeCompare(b.id));
  shared.index = new Map(list.map((f) => [f.id, f]));
  await writeJson(storagePath('index.json'), list);
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
  await writeFile(fieldPath(ch, domain, id), buf);
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
  const file = fieldPath(ch, domain, id);
  if (!fs.existsSync(file)) return null;
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
