import { NextResponse } from 'next/server';
import { getIngestStatus, runIngest } from '@/lib/server/ingest';
import { getForecast, openMeteoCallsToday } from '@/lib/server/openmeteo';

export const dynamic = 'force-dynamic';

/** Ingest health. */
export async function GET() {
  return NextResponse.json({ ...getIngestStatus(), openMeteoCallsToday: openMeteoCallsToday() });
}

/**
 * Run an ingest pass now.
 *   ?reprocess=1  rebuild all fields and metrics from the raw frames on disk
 *   ?offline=1    do not contact IMD (process files already on disk only)
 *   ?forecast=1   also force an Open-Meteo refresh
 */
export async function POST(req: Request) {
  const q = new URL(req.url).searchParams;
  const message = await runIngest({ reprocess: q.get('reprocess') === '1', offline: q.get('offline') === '1' });
  if (q.get('forecast') === '1') await getForecast(true);
  return NextResponse.json({ message, ...getIngestStatus() });
}
