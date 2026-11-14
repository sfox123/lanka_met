import { MSG_PREFIX, MSG_WMS } from '@/lib/shared/meteosat';

export const dynamic = 'force-dynamic';

// The newest Meteosat-9 image time EUMETSAT View can serve, read from the WMS capabilities (the `time` dimension's
// default), so the map never asks for a slot that does not exist yet. Images arrive roughly 45–75 minutes after scan.
let cache: { at: number; body: { latest: string | null; checkedAt: string } } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 5 * 60000) return Response.json(cache.body, { headers: { 'Cache-Control': 'public, max-age=120' } });
  let latest: string | null = null;
  try {
    const res = await fetch(`${MSG_WMS}?service=WMS&request=GetCapabilities&version=1.3.0`, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (res.ok) {
      const xml = await res.text();
      const i = xml.indexOf(`<Name>${MSG_PREFIX}:ir108</Name>`);
      const m = i >= 0 ? /<Dimension name="time"[^>]*default="([^"]+)"/.exec(xml.slice(i, i + 20000)) : null;
      if (m && !isNaN(Date.parse(m[1]))) latest = new Date(m[1]).toISOString().replace('.000Z', 'Z');
    }
  } catch {
    /* fall through: the client falls back to "now minus 75 minutes" */
  }
  const body = { latest, checkedAt: new Date().toISOString() };
  if (latest) cache = { at: Date.now(), body };
  return Response.json(body, { headers: { 'Cache-Control': latest ? 'public, max-age=120' : 'no-store' } });
}
