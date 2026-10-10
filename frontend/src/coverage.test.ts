import { describe, expect, it } from 'vitest';
import type { FeedInfo } from './api';
import { uncoveredOn } from './coverage';

const feed = (over: Partial<FeedInfo>): FeedInfo => ({
  feed_id: 'bayarea',
  timezone: 'America/Los_Angeles',
  start_date: '2021-06-22',
  end_date: '2099-12-31',
  loaded_at: '2026-10-10T16:23:43+00:00',
  has_frequencies: false,
  ...over,
});

describe('uncoveredOn', () => {
  // A regional feed: its own dates span every agency's, so only the agencies can tell.
  const regional = feed({
    agencies: [
      { name: 'VTA', start_date: '2026-08-10', end_date: '2026-10-25' },
      { name: 'Caltrain', start_date: '2026-01-31', end_date: '2027-01-31' },
      { name: null, start_date: '2026-11-01', end_date: '2026-12-31' },
    ],
  });

  it('names the agencies whose schedules have run out or not yet begun', () => {
    expect(uncoveredOn([regional], '2026-10-12')).toEqual(['bayarea']);
    expect(uncoveredOn([regional], '2026-11-02')).toEqual(['VTA']);
    expect(uncoveredOn([regional], '2027-02-01')).toEqual(['VTA', 'Caltrain', 'bayarea']);
  });

  it('falls back to the feed dates when agencies are not listed', () => {
    const old = feed({ feed_id: 'vta', start_date: '2026-08-10', end_date: '2026-10-25' });
    expect(uncoveredOn([old], '2026-10-25')).toEqual([]);
    expect(uncoveredOn([old], '2026-10-26')).toEqual(['vta']);
  });
});
