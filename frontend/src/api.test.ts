import { describe, expect, it } from 'vitest';
import { errorDetail } from './api';

describe('errorDetail', () => {
  it('passes a message through', () => {
    expect(errorDetail('No trip bayarea:1 on 2026-10-12')).toBe('No trip bayarea:1 on 2026-10-12');
  });

  it('names the fields a request got wrong', () => {
    // What FastAPI sends for /api/departures?time=202609-10-20T09:00&radius_m=5000.
    const detail = [
      {
        type: 'datetime_from_date_parsing',
        loc: ['query', 'time'],
        msg: 'Input should be a valid datetime or date, invalid date separator, expected `-`',
        input: '202609-10-20T09:00',
      },
      {
        type: 'less_than_equal',
        loc: ['query', 'radius_m'],
        msg: 'Input should be less than or equal to 3000',
        input: '5000',
        ctx: { le: 3000 },
      },
    ];
    expect(errorDetail(detail)).toBe(
      'Invalid time: input should be a valid datetime or date, invalid date separator, ' +
        'expected `-`. Invalid radius_m: input should be less than or equal to 3000.',
    );
  });

  it('names nested fields, and the request when no field is given', () => {
    expect(errorDetail([{ loc: ['body', 'origin', 'lat'], msg: 'Field required' }])).toBe(
      'Invalid origin.lat: field required.',
    );
    expect(errorDetail([{ loc: ['body'], msg: 'JSON decode error' }])).toBe(
      'Invalid request: JSON decode error.',
    );
  });

  it('falls back to JSON for anything else', () => {
    expect(errorDetail({ code: 7 })).toBe('{"code":7}');
    expect(errorDetail([1, 2])).toBe('[1,2]');
  });
});
