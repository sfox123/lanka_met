import { NextResponse } from 'next/server';
import { buildState } from '@/lib/server/state';

export const dynamic = 'force-dynamic';

/** `?day=YYYY-MM-DD` (Sri Lanka date) selects a past day; without it, today. */
export async function GET(req: Request) {
  return NextResponse.json(await buildState(new URL(req.url).searchParams.get('day')), { headers: { 'Cache-Control': 'no-store' } });
}
