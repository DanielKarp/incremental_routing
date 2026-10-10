import { describe, expect, it } from 'vitest';
import { hillNotes, hillProfile } from './hills';
import type { PathInfo } from './types';

const ride = (heightsM: number[], distanceM = (heightsM.length - 1) * 30): PathInfo => ({
  provider: 'valhalla',
  distanceM,
  routedDurationS: 600,
  geometry: [],
  elevation: { intervalM: 30, heightsM },
});

/** A steady change from one height to another over n samples. */
const slope = (from: number, to: number, n: number) =>
  Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

describe('hill profiles', () => {
  it('leaves out flat and gentle rides, and rides without heights', () => {
    // Palo Alto Caltrain to Stanford in the real data: 19 to 34 m over 3.4 km.
    expect(hillProfile(ride(slope(19, 34, 115)))).toBeNull();
    expect(hillProfile(ride([0, 19]))).toBeNull();
    expect(hillProfile({ ...ride([0, 50]), elevation: undefined })).toBeNull();
  });

  it('profiles a climb, measuring distance along the ride', () => {
    // Embarcadero to Nob Hill in the real data: 4 to 106 m over 2.4 km.
    const p = hillProfile(ride(slope(4, 106, 83), 2434));
    expect(p).toMatchObject({ climbM: 102, descentM: 0, lowM: 4, highM: 106 });
    expect(p?.points[1]).toEqual([30, expect.closeTo(5.24, 2)]);
    expect(p?.points.at(-1)).toEqual([2434, 106]);
    expect(hillNotes(p)).toEqual(['climbs 102 m']);
  });

  it('counts a hill ridden down, and ignores wobble', () => {
    const down = hillProfile(ride([60, 61, 60, 61, 40, 39, 40, 30]));
    expect(down).toMatchObject({ climbM: 0, descentM: 30 });
    expect(hillNotes(down)).toEqual(['descends 30 m']);
    expect(hillNotes(hillProfile(ride([10, 40, 10])))).toEqual(['climbs 30 m', 'descends 30 m']);
    expect(hillProfile(ride([0, 20]))).not.toBeNull();
  });
});
