import { describe, expect, it } from 'vitest';
import {
  TimeSyntaxError,
  Zone,
  addDays,
  parseDate,
  parseDateTime,
  requestInstant,
  weekday,
} from './zone';

const LA = new Zone('America/Los_Angeles');
const utc = (iso: string) => Date.parse(iso);
const wall = (iso: string) => {
  const time = parseDateTime(iso);
  if ('ms' in time) throw new Error('not a wall time');
  return time.wall;
};

describe('Zone', () => {
  it('knows the offset either side of the clocks changing', () => {
    // 2026-03-08: 02:00 PST becomes 03:00 PDT at 10:00 UTC; 2026-11-01: back at 09:00 UTC.
    expect(LA.offsetAt(utc('2026-03-08T09:59:59Z'))).toBe(-8 * 3600_000);
    expect(LA.offsetAt(utc('2026-03-08T10:00:00Z'))).toBe(-7 * 3600_000);
    expect(LA.offsetAt(utc('2026-11-01T08:59:59Z'))).toBe(-7 * 3600_000);
    expect(LA.offsetAt(utc('2026-11-01T09:00:00Z'))).toBe(-8 * 3600_000);
  });

  it('puts the service day origin at noon minus 12 hours', () => {
    // Noon PST is 20:00 UTC, so the origin is 08:00 UTC = 01:00 PDT, not midnight.
    expect(LA.serviceDayOrigin('2026-11-01')).toBe(utc('2026-11-01T08:00:00Z'));
    // Noon PDT is 19:00 UTC: the origin is 23:00 PST the day before.
    expect(LA.serviceDayOrigin('2026-03-08')).toBe(utc('2026-03-08T07:00:00Z'));
    expect(LA.serviceDayOrigin('2026-10-12')).toBe(utc('2026-10-12T07:00:00Z'));
  });

  it('writes times as the server does', () => {
    const origin = LA.serviceDayOrigin('2026-11-01');
    expect(LA.isoString(origin + 8 * 3600_000)).toBe('2026-11-01T08:00:00-08:00');
    expect(LA.isoString(origin + 1800_000)).toBe('2026-11-01T01:30:00-07:00');
    expect(LA.isoString(origin + 5400_000)).toBe('2026-11-01T01:30:00-08:00');
    // Past midnight: 25:00 on the 7th of March is 01:00 on the 8th, still PST.
    expect(LA.isoString(LA.serviceDayOrigin('2026-03-07') + 25 * 3600_000)).toBe(
      '2026-03-08T01:00:00-08:00',
    );
    expect(new Zone('UTC').isoString(utc('2026-10-12T07:50:00Z'))).toBe('2026-10-12T07:50:00Z');
  });

  it('reads local times as zoneinfo does (fold=0)', () => {
    expect(LA.localize(wall('2026-10-12T07:50'))).toBe(utc('2026-10-12T14:50:00Z'));
    // Skipped: the offset from before the change, so 02:30 is 03:30 PDT.
    expect(LA.localize(wall('2026-03-08T02:30'))).toBe(utc('2026-03-08T10:30:00Z'));
    expect(LA.localize(wall('2026-03-08T03:00'))).toBe(utc('2026-03-08T10:00:00Z'));
    // Passed twice: the first time, in PDT.
    expect(LA.localize(wall('2026-11-01T01:30'))).toBe(utc('2026-11-01T08:30:00Z'));
    expect(LA.localize(wall('2026-11-01T02:00'))).toBe(utc('2026-11-01T10:00:00Z'));
  });

  it('gives the local date of an instant', () => {
    expect(LA.localDate(utc('2026-10-13T06:59:59Z'))).toBe('2026-10-12');
    expect(LA.localDate(utc('2026-10-13T07:00:00Z'))).toBe('2026-10-13');
  });
});

describe('request times', () => {
  const instant = (text: string) => requestInstant(parseDateTime(text), LA);

  it('reads what pydantic reads', () => {
    const at = utc('2026-10-12T14:50:00Z');
    for (const text of [
      '2026-10-12T07:50',
      '2026-10-12T07:50:00',
      '2026-10-12 07:50',
      '2026-10-12t07:50',
      '2026-10-12_07:50',
      '2026-10-12T07:50:00-07:00',
      '2026-10-12T07:50:00-0700',
      '2026-10-12T14:50Z',
      '2026-10-12T14:50:00z',
      String(at / 1000),
      String(at),
    ]) {
      expect(instant(text), text).toBe(at);
    }
    expect(instant('2026-10-12')).toBe(utc('2026-10-12T07:00:00Z'));
    // Microseconds are kept, and further digits dropped.
    expect(instant('2026-10-12T07:50:00.1234567-07:00')).toBe(at + 123.456);
  });

  it("says why it can't read a time, as pydantic does", () => {
    const reason = (text: string) => {
      try {
        parseDateTime(text);
      } catch (e) {
        if (e instanceof TimeSyntaxError) return e.message;
      }
      return null;
    };
    expect(reason('')).toBe('input is too short');
    expect(reason('soon')).toBe('input is too short');
    expect(reason(' 2026-10-12T07:50')).toBe('invalid character in year');
    expect(reason('20261012T0750')).toBe('invalid date separator, expected `-`');
    expect(reason('2026-02-30T07:50')).toBe('day value is outside expected range');
    for (const text of ['2026-10-12T24:00', '2026-10-12T7:50', '2026-10-12T07:50:00+01']) {
      expect(reason(text)).toBe('unexpected extra characters at the end of the input');
    }
  });

  it('reads service dates', () => {
    expect(parseDate('2026-10-12')).toBe('2026-10-12');
    expect(parseDate('2026-10-12T00:00')).toBe('2026-10-12');
    expect(() => parseDate('2026-10-12T01:00')).toThrow(TimeSyntaxError);
    expect(() => parseDate('2026-1-2')).toThrow('input is too short');
  });
});

describe('dates', () => {
  it('count days across months, years and leap days', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('name the weekday as the calendar table does', () => {
    expect(weekday('2026-10-12')).toBe('monday');
    expect(weekday('2026-12-01')).toBe('tuesday');
    expect(weekday('2026-11-01')).toBe('sunday');
  });
});
