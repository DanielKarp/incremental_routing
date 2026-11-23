// Small geometry helpers, ported operation for operation from the server's geo.py, so that
// distances, access times and simplified lines come out as the server's do.

import type { PathMode } from '../api';

export const EARTH_RADIUS_M = 6_371_008.8;

// Straight-line distance understates street distance; this is a typical urban detour factor.
const DETOUR_FACTOR = 1.3;
// Typical speeds on foot and by bike, for estimates when no router is involved.
const SPEEDS_MPS: Record<PathMode, number> = { walk: 1.3, bike: 4.5 };

// As Python's math.radians() and math.degrees() multiply.
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * The great-circle distance between two points, in metres. The browser's Math.cos and the C
 * library's cos (and Python's x ** 2, which is pow()) sometimes differ in the last bit, so a
 * few distances differ from the server's there: by 1e-15 or so, never enough to reorder stops.
 */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG_TO_RAD;
  const p2 = lat2 * DEG_TO_RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * DEG_TO_RAD;
  const sinP = Math.sin(dp / 2);
  const sinL = Math.sin(dl / 2);
  const a = sinP * sinP + Math.cos(p1) * Math.cos(p2) * (sinL * sinL);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Rough time to cover a straight-line distance on foot or by bike, allowing for detours,
 * rounded up to whole minutes like the walk and bike legs the app builds.
 */
export function estimateAccessS(distanceM: number, mode: PathMode = 'walk'): number {
  return Math.ceil((distanceM * DETOUR_FACTOR) / SPEEDS_MPS[mode] / 60) * 60;
}

/** Degrees of latitude and longitude spanned by radiusM around lat. */
export function bboxDeltas(lat: number, radiusM: number): [number, number] {
  const dlat = (radiusM / EARTH_RADIUS_M) * RAD_TO_DEG;
  return [dlat, dlat / Math.max(Math.cos(lat * DEG_TO_RAD), 1e-6)];
}

/**
 * x rounded to `digits` decimal places as Python's round() does it: to the nearest, on x's
 * exact binary value, with exact ties to even. (toFixed() breaks ties away from zero.)
 */
export function pyRound(x: number, digits: number): number {
  const rounded = x.toFixed(digits);
  // Enough digits to show any tie exactly, and to tell a near miss from one.
  const exact = x.toFixed(digits + 24);
  const cut = exact.length - 24;
  if (/^50*$/.test(exact.slice(cut))) {
    const truncated = exact.slice(0, cut);
    if (Number(truncated[truncated.length - 1]) % 2 === 0) return Number(truncated);
  }
  return Number(rounded);
}

/**
 * Drop the [lon, lat] points within toleranceM of a straighter line (Douglas-Peucker). The
 * ends are always kept. For drawing: a line followed to within a few metres looks the same.
 */
export function simplifyLine(points: [number, number][], toleranceM: number): [number, number][] {
  if (points.length < 3) return [...points];
  const cosLat = Math.cos(points[0][1] * DEG_TO_RAD);
  const mPerDeg = DEG_TO_RAD * EARTH_RADIUS_M;
  let xy = points.map(([lon, lat]): [number, number] => [lon * cosLat * mPerDeg, lat * mPerDeg]);
  // First drop points crowding the last one kept: cheap, and it spares the slower pass most
  // of the work on densely drawn shapes.
  const near = [0];
  for (let i = 1; i < points.length - 1; i++) {
    const last = xy[near[near.length - 1]];
    if (Math.hypot(xy[i][0] - last[0], xy[i][1] - last[1]) >= toleranceM) near.push(i);
  }
  near.push(points.length - 1);
  const crowded = points;
  points = near.map((i) => crowded[i]);
  const crowdedXy = xy;
  xy = near.map((i) => crowdedXy[i]);
  const keep = points.map(() => false);
  keep[0] = keep[keep.length - 1] = true;
  const spans: [number, number][] = [[0, points.length - 1]];
  while (spans.length) {
    const [a, b] = spans.pop()!;
    let far: number | null = null;
    let farM = toleranceM;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(xy[i], xy[a], xy[b]);
      if (d > farM) {
        far = i;
        farM = d;
      }
    }
    if (far !== null) {
      keep[far] = true;
      spans.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
