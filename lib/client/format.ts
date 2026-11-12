// Time and number formatting. All clock times are shown in Sri Lanka time (UTC+05:30).
const TZ = 'Asia/Colombo';
const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fDayTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fDay = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fWeekday = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
const fHour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });

export const istTime = (t: number | string) => fTime.format(new Date(t));
export const istDayTime = (t: number | string) => fDayTime.format(new Date(t));
export const istDay = (t: number | string) => fDay.format(new Date(t));
export const istWeekday = (t: number | string) => fWeekday.format(new Date(t));
/** hour of day in Sri Lanka time, 0–23 */
export const istHour = (t: number | string) => Number(fHour.format(new Date(t))) % 24;

export function ago(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h < 24 ? `${h} h ${m ? `${m} min ` : ''}ago` : `${Math.floor(h / 24)} d ago`;
}

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? '–' : `${(x * 100).toFixed(digits)}%`);
export const num = (x: number | null | undefined, digits = 0) => (x == null ? '–' : x.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits }));

const WMO: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
};
export const weatherText = (code: number | null | undefined) => (code == null ? '–' : (WMO[code] ?? `Code ${code}`));
