import type { FeedInfo } from './api';

interface Dated {
  start_date: string | null;
  end_date: string | null;
}

const outside = (r: Dated, day: string) =>
  Boolean((r.end_date && r.end_date < day) || (r.start_date && r.start_date > day));

/**
 * Who has no schedule on `day` (YYYY-MM-DD): each agency whose dates don't include it, or the
 * whole feed when the backend doesn't list agencies.
 */
export function uncoveredOn(feeds: FeedInfo[], day: string): string[] {
  return feeds.flatMap((f) => {
    if (!f.agencies?.length) return outside(f, day) ? [f.feed_id] : [];
    return f.agencies.filter((a) => outside(a, day)).map((a) => a.name ?? f.feed_id);
  });
}
