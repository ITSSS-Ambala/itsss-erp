const DAY = 86400000;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;
const withIndiaOffset = (value: string) => value.length === 10 ? `${value}T00:00:00+05:30` : /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+05:30`;
export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function businessDateTime(now: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return `${businessDate(now)}T${time}`;
}
export function validDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) return;
  const date = value.slice(0, 10), parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return;
  if (value.length === 10) return date;
  const instant = new Date(withIndiaOffset(value));
  if (Number.isFinite(instant.getTime())) return businessDate(instant);
}
export function daysFromToday(value: unknown, now: Date): number | undefined {
  const date = validDate(value);
  if (date) return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${businessDate(now)}T00:00:00Z`)) / DAY);
}
export function dueInstant(value: unknown): number | undefined {
  if (!validDate(value)) return;
  const result = Date.parse(withIndiaOffset(String(value)));
  if (Number.isFinite(result)) return result;
}
