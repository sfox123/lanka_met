// Byte store behind the app: Vercel Blob in production, a local folder in development.
// Keys look like paths ("fields/ir1/sl/20261112_0600.webp"); the backend decides where they live.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface Entry {
  key: string;
  size: number;
  uploadedAt: string;
}

export interface PutOptions {
  contentType: string;
  /** mutable objects get a short CDN cache; immutable ones are cached for a year */
  mutable: boolean;
}

export interface Backend {
  readonly kind: 'fs' | 'blob';
  /** `fresh` reads the latest copy even if a CDN cache holds an older one (for mutable objects) */
  get(key: string, opts?: { fresh?: boolean }): Promise<Buffer | null>;
  put(key: string, data: Uint8Array, opts: PutOptions): Promise<void>;
  list(prefix: string): Promise<Entry[]>;
  del(keys: string[]): Promise<void>;
}

// ── local folder ───────────────────────────────────────────────────────
export class FsBackend implements Backend {
  readonly kind = 'fs' as const;
  constructor(readonly root: string) {}

  private file(key: string) {
    return path.join(this.root, ...key.split('/'));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fsp.readFile(this.file(key));
    } catch {
      return null;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.file(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // write-then-rename so a reader never sees a half-written file
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  }

  async list(prefix: string): Promise<Entry[]> {
    const out: Entry[] = [];
    const walk = async (dir: string, rel: string) => {
      let items: fs.Dirent[];
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const key = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) {
          if (prefix.startsWith(`${key}/`) || key.startsWith(prefix)) await walk(path.join(dir, it.name), key);
        } else if (key.startsWith(prefix) && !key.endsWith('.tmp')) {
          const st = await fsp.stat(path.join(dir, it.name));
          out.push({ key, size: st.size, uploadedAt: st.mtime.toISOString() });
        }
      }
    };
    await walk(this.root, '');
    return out;
  }

  async del(keys: string[]): Promise<void> {
    for (const k of keys) await fsp.unlink(this.file(k)).catch(() => {});
  }
}

// ── Vercel Blob ────────────────────────────────────────────────────────
// Authenticated through BLOB_READ_WRITE_TOKEN (set automatically when a Blob store is attached to
// the Vercel project). Overwritten objects can be served from the CDN for up to cacheControlMaxAge,
// so mutable JSON is written with the minimum (60 s) and read with the cache bypassed.
export class BlobBackend implements Backend {
  readonly kind = 'blob' as const;

  private sdk() {
    return import('@vercel/blob');
  }

  async get(key: string, opts: { fresh?: boolean } = {}): Promise<Buffer | null> {
    const { get } = await this.sdk();
    const res = await get(key, { access: 'public', useCache: !opts.fresh, abortSignal: AbortSignal.timeout(20000) });
    if (!res || !res.stream) return null;
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }

  async put(key: string, data: Uint8Array, opts: PutOptions): Promise<void> {
    const { put } = await this.sdk();
    await put(key, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: opts.contentType,
      cacheControlMaxAge: opts.mutable ? 60 : 365 * 86400,
    });
  }

  async list(prefix: string): Promise<Entry[]> {
    const { list } = await this.sdk();
    const out: Entry[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ key: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt).toISOString() });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async del(keys: string[]): Promise<void> {
    const { del } = await this.sdk();
    for (let i = 0; i < keys.length; i += 100) await del(keys.slice(i, i + 100));
  }
}

// ── selection ──────────────────────────────────────────────────────────
const g = globalThis as unknown as { __lankamet_backend?: Backend; __lankamet_backend_warning?: string | null };

export function getBackend(): Backend {
  if (g.__lankamet_backend) return g.__lankamet_backend;
  g.__lankamet_backend_warning = null;
  const want = process.env.LANKAMET_BACKEND ?? (process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'fs');
  if (want === 'blob') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('LANKAMET_BACKEND=blob but BLOB_READ_WRITE_TOKEN is not set');
    g.__lankamet_backend = new BlobBackend();
  } else if (process.env.VERCEL && !process.env.LANKAMET_STORAGE) {
    // serverless without a Blob store: the project folder is read-only, only /tmp can be written,
    // and it is wiped whenever the function restarts — run, but say so
    g.__lankamet_backend = new FsBackend('/tmp/lankamet');
    g.__lankamet_backend_warning = 'No Vercel Blob store is attached, so data is kept in the function’s temporary folder and is lost on every restart. In Vercel: Storage → Create → Blob, connect it to this project, then redeploy.';
  } else {
    g.__lankamet_backend = new FsBackend(process.env.LANKAMET_STORAGE ?? path.join(process.cwd(), 'storage'));
  }
  return g.__lankamet_backend;
}

/** A configuration problem worth showing in the UI, or null. */
export function backendWarning(): string | null {
  getBackend();
  return g.__lankamet_backend_warning ?? null;
}
