import { NextResponse } from 'next/server';
import { buildState } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const hours = Math.min(24 * 14, Math.max(1, Number(new URL(req.url).searchParams.get('hours')) || 24));
  return NextResponse.json(await buildState(hours), { headers: { 'Cache-Control': 'no-store' } });
}
