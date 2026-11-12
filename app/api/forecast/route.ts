import { NextResponse } from 'next/server';
import { getForecast } from '@/lib/server/openmeteo';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getForecast(), { headers: { 'Cache-Control': 'no-store' } });
}
