import { describe, expect, it } from 'vitest';
import { atLocalTime, formatClock, formatTime, localInputToIso, nowLocalInput } from './time';

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
