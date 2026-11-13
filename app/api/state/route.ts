import { NextResponse, after } from 'next/server';
import { ingestDue, runIngest } from '@/lib/server/ingest';
import { getForecast } from '@/lib/server/openmeteo';
import { buildState } from '@/lib/server/state';

export const dynamic = 'force-dynamic';
/** the response itself is quick; the time is for an ingest pass started after it (see below) */
export const maxDuration = 60;

/** `?day=YYYY-MM-DD` (Sri Lanka date) selects a past day; without it, today. */
export async function GET(req: Request) {
  const state = await buildState(new URL(req.url).searchParams.get('day'));
  // On Vercel nothing runs between requests, and the external cron can stall for hours. The
  // dashboard asks for its state every minute, so let it keep IMD polled: when no pass has run
  // for five minutes, start one once the response has been sent.
  if (await ingestDue()) {
    after(async () => {
      await runIngest();
      await getForecast();
    });
  }
  return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store' } });
}
