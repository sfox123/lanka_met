// In-process scheduler: started once from instrumentation.ts when the Next.js server boots.
// Satellite: every 5 minutes (three HEAD requests; a download only when IMD has a new frame).
// Open-Meteo: checked on the same tick, refreshed when the cache is older than 3 hours.
import { runIngest } from './ingest';
import { getForecast } from './openmeteo';

const g = globalThis as unknown as { __lankamet_timer?: NodeJS.Timeout };

export function startScheduler() {
  if (g.__lankamet_timer || process.env.LANKAMET_NO_SCHEDULER === '1') return;
  const tick = async () => {
    await runIngest();
    await getForecast();
  };
  g.__lankamet_timer = setInterval(tick, 5 * 60 * 1000);
  g.__lankamet_timer.unref?.();
  setTimeout(tick, 1500);
  console.log('[lankamet] scheduler started (IMD every 5 min, Open-Meteo every 3 h)');
}
