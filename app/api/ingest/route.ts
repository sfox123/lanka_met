import { NextResponse } from 'next/server';
import { getIngestStatus, runIngest } from '@/lib/server/ingest';
import { getForecast, openMeteoCallsToday } from '@/lib/server/openmeteo';
import { backendKind } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
/** One pass downloads up to three frames from IMD and analyses them; allow the full minute. */
export const maxDuration = 60;

/**
 * When CRON_SECRET is set, a run must present it — as `Authorization: Bearer <secret>` (what Vercel
 * Cron and the GitHub Actions workflow send) or as `?key=<secret>`. Without the secret anyone could
 * make the server do a minute of work on demand.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const url = new URL(req.url);
  return req.headers.get('authorization') === `Bearer ${secret}` || url.searchParams.get('key') === secret;
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const message = await runIngest({ reprocess: q.get('reprocess') === '1', offline: q.get('offline') === '1' });
  const forecast = await getForecast(q.get('forecast') === '1');
  return NextResponse.json({ message, forecast: forecast.error ?? `ok (${forecast.fetchedAt})`, ...(await getIngestStatus()) });
}

/**
 * GET: ingest health. With `?run=1`, or when called by Vercel Cron, it performs one ingest pass.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const isCron = (req.headers.get('user-agent') ?? '').startsWith('vercel-cron');
  if (q.get('run') === '1' || isCron) return run(req);
  return NextResponse.json({ ...(await getIngestStatus()), backend: backendKind(), openMeteoCallsToday: openMeteoCallsToday() });
}

/**
 * POST: run an ingest pass now.
 *   ?reprocess=1  rebuild all fields and metrics from the stored raw frames
 *   ?offline=1    do not contact IMD (process stored files only)
 *   ?forecast=1   also force an Open-Meteo refresh
 */
export async function POST(req: Request) {
  return run(req);
}
