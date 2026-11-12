import fsp from 'node:fs/promises';
import { fieldPath } from '@/lib/server/store';
import { CHANNELS, type Channel } from '@/lib/shared/types';
import { DOMAINS, type DomainId } from '@/lib/shared/geo';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ channel: string; domain: string; id: string }> }) {
  const { channel, domain, id } = await ctx.params;
  if (!CHANNELS.includes(channel as Channel) || !(domain in DOMAINS) || !/^\d{8}_\d{4}$/.test(id)) {
    return new Response('bad request', { status: 400 });
  }
  try {
    const buf = await fsp.readFile(fieldPath(channel as Channel, domain as DomainId, id));
    // a frame id never changes meaning, but a reprocess can rewrite it: cache for a day, not forever
    return new Response(new Uint8Array(buf), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
