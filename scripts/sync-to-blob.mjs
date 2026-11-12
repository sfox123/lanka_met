// Uploads the local storage/ folder to the Vercel Blob store used in production, so frames
// recorded on this machine appear on the deployed dashboard.
//
//   npm run sync-blob            upload what the store does not have (last 24 hours); merge the frame index
//   npm run sync-blob -- --force also overwrite the small JSON files (nowcast, poll state, ...)
//
// Needs write access to the store: either BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID together with
// VERCEL_OIDC_TOKEN (`npx vercel env pull .env.local` writes the latter). Read from .env.local,
// .env or the environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['.env.local', '.env']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const hasToken = !!process.env.BLOB_READ_WRITE_TOKEN;
const hasOidc = !!process.env.BLOB_STORE_ID && !!process.env.VERCEL_OIDC_TOKEN;
if (!hasToken && !hasOidc) {
  console.error(
    [
      'No credential that can write to the Blob store.',
      process.env.BLOB_STORE_ID ? '  BLOB_STORE_ID is set, but a store id only says which store — it does not grant access.' : '  BLOB_STORE_ID is not set.',
      'Do one of these, then run the command again:',
      '  a) npx vercel link && npx vercel env pull .env.local',
      '     (writes VERCEL_OIDC_TOKEN, valid for about 12 hours, into the git-ignored .env.local)',
      '  b) add BLOB_READ_WRITE_TOKEN=... to .env.local',
      '     (Vercel → Storage → your Blob store → Settings / .env.local tab)',
    ].join('\n'),
  );
  process.exit(1);
}
console.log(`Auth: ${hasToken ? 'read-write token' : 'OIDC token + store id'}`);
const { put, list, get } = await import('@vercel/blob');
// the store connected to the project is private; older stores can be public
const ACCESS = process.env.LANKAMET_BLOB_ACCESS === 'public' ? 'public' : 'private';

const storage = process.env.LANKAMET_STORAGE ?? path.join(root, 'storage');
const force = process.argv.includes('--force');
const IMMUTABLE = /^(raw|fields)\//;
// production keeps this many hours of frames (see keepHours() in lib/server/store.ts); older
// local frames would be deleted again on the next ingest pass, so they are not uploaded
const KEEP_HOURS = Number(process.env.LANKAMET_KEEP_HOURS) || 24;
const cutoff = Date.now() - KEEP_HOURS * 3600e3;
const frameTime = (key) => {
  const m = /\/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\.(?:jpg|webp)$/.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};
const SKIP = /^(review\/|index\.json$)|\.tmp$|^\./;
const TYPES = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };

const local = [];
const walk = (dir, rel) => {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) walk(path.join(dir, it.name), key);
    else local.push({ key, file: path.join(dir, it.name), size: it.isFile() ? fs.statSync(path.join(dir, it.name)).size : 0 });
  }
};
if (!fs.existsSync(storage)) {
  console.error(`No storage folder at ${storage}`);
  process.exit(1);
}
walk(storage, '');

console.log('Listing the Blob store…');
const remote = new Map();
let cursor;
do {
  const page = await list({ cursor, limit: 1000 });
  for (const b of page.blobs) remote.set(b.pathname, b.size);
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
console.log(`  ${remote.size} objects in the store, ${local.length} files locally`);

let uploaded = 0;
let skipped = 0;
let bytes = 0;
async function upload(key, body, mutable) {
  await put(key, body, {
    access: ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: TYPES[path.extname(key)] ?? 'application/octet-stream',
    cacheControlMaxAge: mutable ? 60 : 365 * 86400,
  });
  uploaded++;
  bytes += body.length;
}

// frames and fields: upload whatever the store lacks (same key + same size counts as present)
const tooOld = (f) => IMMUTABLE.test(f.key) && (frameTime(f.key) ?? Infinity) < cutoff;
const queue = local.filter((f) => !SKIP.test(f.key) && !tooOld(f));
const aged = local.filter(tooOld).length;
if (aged) console.log(`  ${aged} local files are older than ${KEEP_HOURS} h and are left out`);
for (let i = 0; i < queue.length; i += 4) {
  await Promise.all(
    queue.slice(i, i + 4).map(async (f) => {
      const immutable = IMMUTABLE.test(f.key);
      if (remote.get(f.key) === f.size && (immutable || !force)) {
        skipped++;
        return;
      }
      if (!immutable && remote.has(f.key) && !force) {
        skipped++; // live state owned by production: only replace it with --force
        return;
      }
      await upload(f.key, fs.readFileSync(f.file), !immutable);
      process.stdout.write(`  ↑ ${f.key}\n`);
    }),
  );
}

// the frame index: merge, never replace, so production keeps frames this machine never saw
const localIndexFile = path.join(storage, 'index.json');
if (fs.existsSync(localIndexFile)) {
  const mine = JSON.parse(fs.readFileSync(localIndexFile, 'utf8'));
  let theirs = [];
  const res = await get('index.json', { access: ACCESS, useCache: false });
  if (res?.stream) theirs = JSON.parse(await new Response(res.stream).text());
  const merged = new Map(theirs.map((f) => [f.id, f]));
  let added = 0;
  let replaced = 0;
  for (const f of mine) {
    const cur = merged.get(f.id);
    // prefer the record that knows more channels (or the local one when forced)
    if (!cur) added++;
    else if (force || Object.keys(f.channels).length > Object.keys(cur.channels).length) replaced++;
    else continue;
    merged.set(f.id, f);
  }
  const out = [...merged.values()].filter((f) => Date.parse(f.t) >= cutoff).sort((a, b) => a.id.localeCompare(b.id));
  await upload('index.json', Buffer.from(JSON.stringify(out)), true);
  console.log(`  index.json: ${theirs.length} remote + ${mine.length} local → ${out.length} frames (${added} added, ${replaced} replaced)`);
}

console.log(`Done: ${uploaded} uploaded (${(bytes / 1048576).toFixed(1)} MB), ${skipped} already there.`);
console.log('Production rebuilds the nowcast on its next ingest pass (or call /api/ingest?run=1&key=… now).');
