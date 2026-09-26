/**
 * Swiss-local date helpers shared by modules.
 *
 * Several tools answer "today"/"this year" questions. Using the UTC date is
 * wrong for the first 1–2 hours after Swiss midnight (CET = UTC+1, CEST =
 * UTC+2), so all such defaults go through Europe/Zurich here.
 */

const SWISS_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar date in Switzerland as YYYY-MM-DD (en-CA formats ISO-style). */
export function swissDate(at: Date = new Date()): string {
  return SWISS_DATE.format(at);
}

/** The calendar year in Switzerland. */
export function swissYear(at: Date = new Date()): number {
  return Number(swissDate(at).slice(0, 4));
}

/** The calendar month in Switzerland as YYYY-MM, shifted by `offset` months. */
export function swissMonth(offset = 0, at: Date = new Date()): string {
  const [y, m] = swissDate(at).split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return d.toISOString().slice(0, 7);
}

/** Shift a YYYY-MM-DD date by whole days (pure calendar arithmetic). */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** True when the string is a real calendar date in YYYY-MM-DD form. */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
