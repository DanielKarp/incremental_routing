import type { PathInfo } from './types';

/**
 * A climb or descent at least this tall (metres) between two points of a ride is a hill worth
 * showing. Gentle rises are left out: Palo Alto Caltrain to Stanford gains 15 m over 3.4 km.
 */
export const SIGNIFICANT_HILL_M = 20;
/** Height changes smaller than this (metres) are wobble, not climbing or descending. */
const NOISE_M = 2;
/** A total climb or descent smaller than this (metres) isn't worth mentioning. */
const MENTION_M = 5;

export interface HillProfile {
  /** [distance along the ride, height], in metres. */
  points: [number, number][];
  climbM: number;
  descentM: number;
  lowM: number;
  highM: number;
}

/** The ride's height profile if it has a significant hill; null if it has none, or no heights. */
export function hillProfile(path: PathInfo): HillProfile | null {
  const heights = path.elevation?.heightsM;
  if (!path.elevation || !heights || heights.length < 2) return null;

  // The biggest rise or drop between two points, in riding order.
  let low = heights[0];
  let high = heights[0];
  let biggest = 0;
  for (const h of heights) {
    biggest = Math.max(biggest, h - low, high - h);
    low = Math.min(low, h);
    high = Math.max(high, h);
  }
  if (biggest < SIGNIFICANT_HILL_M) return null;

  let climb = 0;
  let descent = 0;
  let level = heights[0];
  for (const h of heights) {
    if (Math.abs(h - level) < NOISE_M) continue;
    if (h > level) climb += h - level;
    else descent += level - h;
    level = h;
  }

  const { intervalM } = path.elevation;
  const last = heights.length - 1;
  return {
    points: heights.map((h, i): [number, number] => [
      i === last ? path.distanceM : Math.min(i * intervalM, path.distanceM),
      h,
    ]),
    climbM: Math.round(climb),
    descentM: Math.round(descent),
    lowM: low,
    highM: high,
  };
}

/** What's worth saying about a hilly ride: "climbs 102 m", "descends 85 m". */
export function hillNotes(profile: HillProfile | null): string[] {
  if (!profile) return [];
  const notes: string[] = [];
  if (profile.climbM >= MENTION_M) notes.push(`climbs ${profile.climbM} m`);
  if (profile.descentM >= MENTION_M) notes.push(`descends ${profile.descentM} m`);
  return notes;
}
