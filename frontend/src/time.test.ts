import { describe, expect, it } from 'vitest';
import { formatTime, localInputToIso, nowLocalInput } from './time';

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
