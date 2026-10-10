// All times are shown in the planning region's zone, whatever the browser's own zone is.
export const PLAN_TZ = 'America/Los_Angeles';

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PLAN_TZ,
  hour: 'numeric',
  minute: '2-digit',
});

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLAN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PLAN_TZ,
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone: PLAN_TZ, weekday: 'short' });

export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** "Monday, October 12, 2026". */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** Time of day, with the weekday added when it falls on a different local day from `reference`. */
export function formatTimeOnDay(iso: string, reference: string): string {
  const sameDay = formatLocalDateTime(iso).slice(0, 10) === formatLocalDateTime(reference).slice(0, 10);
  return sameDay ? formatTime(iso) : `${weekdayFormat.format(new Date(iso))} ${formatTime(iso)}`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Wall-clock fields of an instant in PLAN_TZ. */
function zonedParts(date: Date): Record<string, number> {
  return Object.fromEntries(
    partsFormat
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The current time in PLAN_TZ as a datetime-local input value ("2026-10-12T07:50"). */
export function nowLocalInput(now: Date = new Date()): string {
  return formatLocalDateTime(now.toISOString()).replace(' ', 'T');
}

/** An instant as a datetime-local input value in PLAN_TZ. */
export function toLocalInput(iso: string): string {
  return nowLocalInput(new Date(iso));
}

/** "2026-10-12 07:30" in PLAN_TZ: unambiguous for files and spreadsheets. */
export function formatLocalDateTime(iso: string): string {
  const p = zonedParts(new Date(iso));
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** A datetime-local value read as PLAN_TZ wall time, as an ISO instant. */
export function localInputToIso(value: string): string {
  const [y, mo, d, h, mi] = value.split(/[-T:]/).map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (utcMs: number) => {
    const p = zonedParts(new Date(utcMs));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
  };
  // Guess with the offset at the wall time, then correct once in case DST changed in between.
  let utcMs = wallAsUtc - offsetAt(wallAsUtc);
  utcMs = wallAsUtc - offsetAt(utcMs);
  return new Date(utcMs).toISOString();
}
