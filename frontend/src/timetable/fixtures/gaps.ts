// How far apart two lines are, for comparing the timetable's simplified shapes with the
// server's.

import { EARTH_RADIUS_M } from '../geo';

type LonLat = [number, number];

/**
 * How far apart two lines of [lon, lat] points are: the furthest any point of one is from the
 * other line, in metres, either way (on a flat projection, fine at city scale).
 */
export function lineGapM(a: LonLat[], b: LonLat[]): number {
  return Math.max(furthestFrom(a, b), furthestFrom(b, a));
}

/** The furthest any of the points is from the line, in metres. */
export function furthestFrom(points: LonLat[], line: LonLat[]): number {
  if (!points.length || !line.length) return points.length || line.length ? Infinity : 0;
  const cosLat = Math.cos((line[0][1] * Math.PI) / 180);
  const m = (EARTH_RADIUS_M * Math.PI) / 180;
  const xy = ([lon, lat]: LonLat): LonLat => [lon * cosLat * m, lat * m];
  const segments = line.map(xy);
  let furthest = 0;
  for (const point of points) {
    const p = xy(point);
    let nearest = Math.hypot(p[0] - segments[0][0], p[1] - segments[0][1]);
    for (let i = 1; i < segments.length; i++) {
      nearest = Math.min(nearest, segmentM(p, segments[i - 1], segments[i]));
    }
    furthest = Math.max(furthest, nearest);
  }
  return furthest;
}

function segmentM(p: LonLat, a: LonLat, b: LonLat): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length2 = dx * dx + dy * dy;
  const t = length2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2))
    : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The distance between two [lon, lat] points, in metres. */
export function pointGapM(a: LonLat, b: LonLat): number {
  return lineGapM([a], [b]);
}
