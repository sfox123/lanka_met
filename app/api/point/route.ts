import { NextResponse } from 'next/server';
import { getPointForecast } from '@/lib/server/openmeteo';
import { POINT_BOUNDS } from '@/lib/shared/geo';

export const dynamic = 'force-dynamic';

/** Open-Meteo forecast for a point picked on the map: /api/point?lat=7.29&lon=80.63 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  const b = POINT_BOUNDS;
  if (!q.get('lat') || !q.get('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < b.south || lat > b.north || lon < b.west || lon > b.east) {
    return NextResponse.json({ error: 'lat and lon must be a point over Sri Lanka' }, { status: 400 });
  }
  try {
    // the same rounded point gives the same answer for a while: let the browser and the CDN keep it
    return NextResponse.json(await getPointForecast(lat, lon), { headers: { 'Cache-Control': 'public, max-age=900, s-maxage=1800' } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
