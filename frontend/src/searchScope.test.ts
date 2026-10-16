import { describe, expect, it } from 'vitest';
import {
  type SearchScope,
  cutText,
  formatDistance,
  nothingText,
  offersLongWindow,
  scopeText,
  searchRadius,
  widerRadius,
} from './searchScope';

// 9:30 AM in the Bay Area.
const time = '2026-10-20T16:30:00.000Z';
const forward: SearchScope = { direction: 'forward', time, radiusM: 500, windowMin: 60 };
const backward: SearchScope = { ...forward, direction: 'backward' };

describe('what the list searched', () => {
  it('says which way, how far around and how long', () => {
    expect(scopeText(forward)).toBe('Departures in the next hour within 500 m, up to 3 per line.');
    expect(scopeText(backward)).toBe(
      'Arrivals in the hour before 9:30 AM within 500 m, up to 3 per line.',
    );
    expect(scopeText({ ...forward, radiusM: 1500, windowMin: 180 })).toBe(
      'Departures in the next 3 hours within 1.5 km, up to 3 per line.',
    );
  });

  it('says what found nothing', () => {
    expect(nothingText(forward)).toBe('Nothing leaves within 500 m in the next hour.');
    expect(nothingText({ ...backward, radiusM: 1000, windowMin: 180 })).toBe(
      'Nothing arrives within 1 km in the 3 hours before 9:30 AM.',
    );
  });

  it('writes distances as people say them', () => {
    expect(formatDistance(50)).toBe('50 m');
    expect(formatDistance(1000)).toBe('1 km');
    expect(formatDistance(1250)).toBe('1.25 km');
    expect(formatDistance(3000)).toBe('3 km');
  });

  it('searches the radius typed, within limits, or 500 m while the field is blank', () => {
    expect(searchRadius(800)).toBe(800);
    expect(searchRadius(0)).toBe(500);
    expect(searchRadius(10)).toBe(50);
    expect(searchRadius(9000)).toBe(3000);
  });

  it('says when the search stopped at its limit', () => {
    expect(cutText(forward, 500)).toBe(
      'Only the first 500 trips are listed, so lines that leave later may be missing. Try a ' +
        'smaller radius.',
    );
    expect(cutText(backward, 500)).toMatch(/^Only the last 500 trips .* arrive earlier/);
    // Over 3 hours, the hour is a way back too.
    expect(cutText({ ...forward, windowMin: 180 }, 500)).toMatch(
      /Try a smaller radius or just the next hour\.$/,
    );
    expect(cutText({ ...backward, windowMin: 180 }, 500)).toMatch(/or just the hour before\.$/);
  });
});

describe('widening a search', () => {
  it('doubles the radius, up to 3 km', () => {
    expect(widerRadius(500)).toBe(1000);
    expect(widerRadius(2000)).toBe(3000);
    expect(widerRadius(3000)).toBeNull();
  });

  it('offers a longer window once, and under a list only up to 1.5 km', () => {
    expect(offersLongWindow(forward, false)).toBe(true);
    expect(offersLongWindow({ ...forward, radiusM: 3000 }, false)).toBe(true);
    expect(offersLongWindow({ ...forward, radiusM: 1500 }, true)).toBe(true);
    expect(offersLongWindow({ ...forward, radiusM: 2000 }, true)).toBe(false);
    expect(offersLongWindow({ ...forward, windowMin: 180 }, false)).toBe(false);
  });
});
