// Dates, times and time zones for the timetable, as the server works them out with zoneinfo
// (backend/src/incremental_routing/gtfs/timeutil.py), but with nothing more than Intl.
//
// Instants are milliseconds since the epoch (UTC), and may carry microseconds as a fraction.
// Dates are ISO text, "2026-10-12". GTFS times are seconds from the service day's origin: noon
// minus 12 hours, local time, which is midnight except on the days the clocks change.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The wall-clock fields of a local time (month 1-12), with microseconds. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

/** The milliseconds since the epoch of a wall time read as UTC; years 0-99 are taken as given. */
function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The offset from UTC of one UTC day: fixed, or changing once at `at` (DST). */
interface DayOffsets {
  before: number;
  after: number;
  at: number;
}

/**
 * An IANA time zone, e.g. America/Los_Angeles. Offsets come from Intl, once per UTC day (and
 * a binary search on the days the clocks change), so working out many times stays cheap.
 */
export class Zone {
  private readonly format: Intl.DateTimeFormat;
  private readonly days = new Map<number, DayOffsets>();
  private readonly origins = new Map<string, number>();

  constructor(readonly name: string) {
    // Throws a RangeError for a zone Intl doesn't know.
    this.format = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  /** The zone's offset from UTC at an instant, in milliseconds (local minus UTC). */
  offsetAt(ms: number): number {
    const day = Math.floor(ms / DAY_MS);
    let offsets = this.days.get(day);
    if (!offsets) {
      offsets = this.dayOffsets(day * DAY_MS);
      this.days.set(day, offsets);
    }
    return ms < offsets.at ? offsets.before : offsets.after;
  }

  /** An instant's local date, "2026-10-12", as datetime.astimezone(tz).date() gives it. */
  localDate(ms: number): string {
    return isoDate(new Date(ms + this.offsetAt(ms)));
  }

  /**
   * The instant a wall time stands for, as datetime.replace(tzinfo=zone) has it (fold=0): a
   * time the clocks skip, or one they pass twice, takes the offset from before the change.
   */
  localize(wall: WallTime): number {
    const asUtc =
      utcMs(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second) +
      wall.microsecond / 1000;
    const before = this.offsetAt(asUtc - DAY_MS);
    const after = this.offsetAt(asUtc + DAY_MS);
    if (before !== after) {
      // The clocks change within a day of it. Earlier is the first time, if it is one at all.
      if (this.offsetAt(asUtc - before) !== before && this.offsetAt(asUtc - after) === after) {
        return asUtc - after;
      }
    }
    return asUtc - before;
  }

  /** The instant GTFS time 00:00:00 refers to on a service date: noon minus 12 hours. */
  serviceDayOrigin(date: string): number {
    let origin = this.origins.get(date);
    if (origin === undefined) {
      const [year, month, day] = dateFields(date);
      const noon = { year, month, day, hour: 12, minute: 0, second: 0, microsecond: 0 };
      origin = this.localize(noon) - 12 * HOUR_MS;
      this.origins.set(date, origin);
    }
    return origin;
  }

  /**
   * An instant as the server writes it, in this zone: "2026-10-12T08:00:00-07:00". Whole
   * seconds only, as every time the server sends is.
   */
  isoString(ms: number): string {
    const offset = this.offsetAt(ms);
    const local = new Date(ms + offset);
    const time =
      `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:` + pad(local.getUTCSeconds());
    return `${isoDate(local)}T${time}${offsetText(offset)}`;
  }

  /** The wall-clock time of an instant, as milliseconds: what Python compares within a zone. */
  wallMs(ms: number): number {
    return ms + this.offsetAt(ms);
  }

  private rawOffset(ms: number): number {
    const second = Math.floor(ms / 1000) * 1000;
    const fields: Record<string, number> = {};
    for (const part of this.format.formatToParts(second)) {
      if (part.type !== 'literal') fields[part.type] = Number(part.value);
    }
    const { year, month, day, hour, minute } = fields;
    return utcMs(year, month, day, hour, minute, fields.second) - second;
  }

  private dayOffsets(start: number): DayOffsets {
    const before = this.rawOffset(start);
    const after = this.rawOffset(start + DAY_MS);
    if (before === after) return { before, after, at: Infinity };
    // The clocks change during the day: find the first second on the new offset.
    let lo = start;
    let hi = start + DAY_MS;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (this.rawOffset(mid) === before) lo = mid;
      else hi = mid;
    }
    return { before, after, at: hi };
  }
}

/** "-07:00", or "Z" for UTC, as pydantic writes offsets. */
function offsetText(offsetMs: number): string {
  if (offsetMs === 0) return 'Z';
  const sign = offsetMs < 0 ? '-' : '+';
  const total = Math.abs(offsetMs) / 1000;
  const seconds = total % 60;
  const text = `${sign}${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}`;
  return seconds ? `${text}:${pad(seconds)}` : text;
}

function isoDate(utc: Date): string {
  return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

function dateFields(date: string): [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

/** The date `days` after (or before) an ISO date. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = dateFields(date);
  return isoDate(new Date(utcMs(year, month, day + days)));
}

// The calendar table's columns, Monday first, as datetime.date.weekday() counts.
export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

/** The day of the week of an ISO date, as a calendar column name. */
export function weekday(date: string): (typeof WEEKDAYS)[number] {
  const [year, month, day] = dateFields(date);
  return WEEKDAYS[(new Date(utcMs(year, month, day)).getUTCDay() + 6) % 7];
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcMs(year, month + 1, 0)).getUTCDate();
}

/** A request time: a wall time with its UTC offset in seconds, or none (local time). */
export interface RequestTime {
  wall: WallTime;
  offsetS: number | null;
}

/** Why a request time can't be read, in pydantic's words. */
export class TimeSyntaxError extends Error {}

// A date, then perhaps a time (hours and minutes, perhaps seconds and a fraction of one), and
// perhaps Z or an offset.
const DATETIME = new RegExp(
  '^(\\d{4})-(\\d{2})-(\\d{2})' +
    '(?:[Tt _](\\d{2}):(\\d{2})(?::(\\d{2})(?:[.,](\\d+))?)?' +
    '(?:([Zz])|([+-])(\\d{2}):?(\\d{2}))?)?$',
);

/**
 * A datetime as pydantic reads one from a query string: an ISO 8601 date and time (with or
 * without an offset; seconds and fractions optional), a date alone (midnight), or a Unix
 * timestamp in seconds (or milliseconds, for large numbers). Throws TimeSyntaxError.
 */
export function parseDateTime(text: string): { ms: number } | RequestTime {
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    let seconds = Number(text);
    // As pydantic: numbers this large are milliseconds.
    if (Math.abs(seconds) > 2e10) seconds /= 1000;
    return { ms: seconds * 1000 };
  }
  if (text.length < 10) throw new TimeSyntaxError('input is too short');
  const m = DATETIME.exec(text);
  if (!m) {
    if (!/^\d{4}/.test(text)) throw new TimeSyntaxError('invalid character in year');
    if (text[4] !== '-' || text[7] !== '-') {
      throw new TimeSyntaxError('invalid date separator, expected `-`');
    }
    throw new TimeSyntaxError('unexpected extra characters at the end of the input');
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12)
    throw new TimeSyntaxError('month value is outside expected range of 1-12');
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new TimeSyntaxError('day value is outside expected range');
  }
  const [hour, minute, second] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (hour > 23 || minute > 59 || second > 59) {
    throw new TimeSyntaxError('unexpected extra characters at the end of the input');
  }
  // Pydantic keeps microseconds, and drops any further digits.
  const microsecond = m[7] ? Number(m[7].slice(0, 6).padEnd(6, '0')) : 0;
  let offsetS: number | null = null;
  if (m[8]) offsetS = 0;
  else if (m[9]) {
    const [hh, mm] = [Number(m[10]), Number(m[11])];
    if (hh > 23 || mm > 59) {
      throw new TimeSyntaxError('unexpected extra characters at the end of the input');
    }
    offsetS = (m[9] === '-' ? -1 : 1) * (hh * 3600 + mm * 60);
  }
  return { wall: { year, month, day, hour, minute, second, microsecond }, offsetS };
}

/** The instant a parsed request time stands for; times without an offset are in `local`. */
export function requestInstant(time: { ms: number } | RequestTime, local: Zone): number {
  if ('ms' in time) return time.ms;
  if (time.offsetS === null) return local.localize(time.wall);
  const { year, month, day, hour, minute, second, microsecond } = time.wall;
  return utcMs(year, month, day, hour, minute, second) + microsecond / 1000 - time.offsetS * 1000;
}

/**
 * A date as pydantic reads one: "2026-10-12", or a date and time that is exactly midnight.
 * Throws TimeSyntaxError.
 */
export function parseDate(text: string): string {
  if (/^-?\d+(\.\d+)?$/.test(text) || text.length < 10) {
    throw new TimeSyntaxError('input is too short');
  }
  const time = parseDateTime(text);
  if ('ms' in time) throw new TimeSyntaxError('input is too short');
  const { year, month, day, hour, minute, second, microsecond } = time.wall;
  if (hour || minute || second || microsecond || time.offsetS) {
    throw new TimeSyntaxError('datetimes provided to dates should have zero time');
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}
