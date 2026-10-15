import { describe, expect, it } from 'vitest';
import {
  atLocalTime,
  formatClock,
  formatTime,
  isPlausibleInput,
  localInputToIso,
  nowLocalInput,
} from './time';

describe('Bay Area wall time', () => {
  it('converts datetime-local values to instants in summer and winter', () => {
    expect(localInputToIso('2026-10-12T07:30')).toBe('2026-10-12T14:30:00.000Z');
    expect(localInputToIso('2026-12-01T08:00')).toBe('2026-12-01T16:00:00.000Z');
  });

  it('handles the morning clocks go back', () => {
    // 08:00 on 2026-11-01 is after the change, so PST (UTC-8).
    expect(localInputToIso('2026-11-01T08:00')).toBe('2026-11-01T16:00:00.000Z');
  });

  it('round-trips through the input format', () => {
    expect(nowLocalInput(new Date('2026-10-12T14:30:00Z'))).toBe('2026-10-12T07:30');
    // Newer ICU puts a narrow no-break space before AM.
    expect(formatTime('2026-10-12T14:30:00Z')).toMatch(/^7:30\sAM$/);
  });
});

describe('editing a time of day', () => {
  it('formats a time input value', () => {
    expect(formatClock('2026-10-12T14:30:00Z')).toBe('07:30');
  });

  it('picks the matching day nearest the old time, across midnight too', () => {
    // 07:30 local on Oct 12 -> 08:05 the same day.
    expect(atLocalTime('2026-10-12T14:30:00.000Z', '08:05')).toBe('2026-10-12T15:05:00.000Z');
    // 00:10 on Oct 13 -> 23:55 is five minutes earlier, on Oct 12.
    expect(atLocalTime('2026-10-13T07:10:00.000Z', '23:55')).toBe('2026-10-13T06:55:00.000Z');
  });
});

describe('a time still being typed', () => {
  const now = new Date('2026-10-15T18:00:00Z');

  it('takes the years typed on the way to 2026 as not typed yet', () => {
    for (const year of ['0002', '0020', '0202', '202609']) {
      expect(isPlausibleInput(`${year}-10-20T09:00`, now)).toBe(false);
    }
    expect(isPlausibleInput('2026-10-20T09:00', now)).toBe(true);
  });

  it('accepts a few years either side of this one', () => {
    expect(isPlausibleInput('2021-01-01T00:00', now)).toBe(true);
    expect(isPlausibleInput('2031-12-31T23:59', now)).toBe(true);
    expect(isPlausibleInput('2032-01-01T00:00', now)).toBe(false);
    expect(isPlausibleInput('2020-12-31T23:59', now)).toBe(false);
  });

  it('needs the whole date and time', () => {
    expect(isPlausibleInput('', now)).toBe(false);
    expect(isPlausibleInput('2026-10-20', now)).toBe(false);
  });
});
