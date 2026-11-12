import { getMasks } from '@/lib/server/masks';
import { getForecast } from '@/lib/server/openmeteo';
import { listFrames } from '@/lib/server/store';
import { satProbability } from '@/lib/shared/risk';

export const dynamic = 'force-dynamic';

/** One CSV per estate: observed satellite metrics followed by the Open-Meteo hourly forecast. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const estate = getMasks().estates.find((e) => e.slug === slug);
  if (!estate) return new Response('unknown estate', { status: 404 });
  const rows: string[] = [
    'time_utc,source,cloud_index_mean,cloud_index_max,cloud_cover,cold_cloud_fraction,deep_convection_fraction,satellite_rain_likelihood,precipitation_mm,precipitation_probability_pct,model_cloud_cover_pct,cape_jkg,temperature_c,humidity_pct',
  ];
  for (const f of await listFrames()) {
    const s = f.estates?.[slug];
    if (s) rows.push([f.t, 'insat3ds_ir1', s.mean, s.max, s.cover, s.cold, s.deep, satProbability(s).toFixed(3), '', '', '', '', '', ''].join(','));
  }
  const fc = (await getForecast()).estates.find((e) => e.slug === slug);
  if (fc) {
    const h = fc.hourly;
    const v = (x: number | null | undefined) => x ?? '';
    h.time.forEach((t, i) => {
      rows.push([t, 'open_meteo', '', '', '', '', '', '', v(h.precipitation[i]), v(h.precipitation_probability[i]), v(h.cloud_cover[i]), v(h.cape[i]), v(h.temperature_2m[i]), v(h.relative_humidity_2m[i])].join(','));
    });
  }
  return new Response(rows.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}-cloud-rain.csv"` },
  });
}
