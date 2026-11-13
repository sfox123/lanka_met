// In-process scheduler: started once from instrumentation.ts when the Next.js server boots.
// Satellite: every 5 minutes (three HEAD requests; a download only when IMD has a new frame).
// Open-Meteo: checked on the same tick, refreshed when the cache is older than 3 hours.
//
// Not used on Vercel: functions do not stay alive between requests, so there Vercel Cron
// calls /api/ingest every 5 minutes instead (see vercel.json), and an
// open dashboard starts a pass through /api/state when none has run for five minutes.
import { runIngest } from './ingest';
import { getForecast } from './openmeteo';

const g = globalThis as unknown as { __lankamet_timer?: NodeJS.Timeout };

export function startScheduler() {
  if (g.__lankamet_timer || process.env.LANKAMET_NO_SCHEDULER === '1' || process.env.VERCEL) return;
  const tick = async () => {
    await runIngest();
    await getForecast();
  };
  g.__lankamet_timer = setInterval(tick, 5 * 60 * 1000);
  g.__lankamet_timer.unref?.();
  setTimeout(tick, 1500);
  console.log('[lankamet] scheduler started (IMD every 5 min, Open-Meteo every 3 h)');
}
