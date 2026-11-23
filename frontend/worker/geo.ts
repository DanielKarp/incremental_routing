// The geometry the routing needs, ported operation for operation from the server's geo.py
// (backend/src/incremental_routing/geo.py), so that routes come out as the server's did.

const EARTH_RADIUS_M = 6_371_008.8;

// Straight-line distance understates street distance; this is a typical urban detour factor.
export const DETOUR_FACTOR = 1.3;
// Typical speeds on foot and by bike, for estimates when no router is involved.
export const SPEEDS_MPS = { walk: 1.3, bike: 4.5 } as const;

// As Python's math.radians() multiplies.
const DEG_TO_RAD = Math.PI / 180;

/** The great-circle distance between two points, in metres. */
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
 * Decode a Google-style encoded polyline into [lat, lon] pairs. Valhalla uses precision 6;
 * Google and OSRM use precision 5. Throws a RangeError if the text ends mid-point, where
 * Python's version raised an IndexError.
 */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    const deltas: number[] = [];
    for (let k = 0; k < 2; k++) {
      // Plain numbers, not 32-bit ones: a long route's deltas can outgrow 32 bits in the shift.
      let shift = 1;
      let result = 0;
      for (;;) {
        if (index >= encoded.length) throw new RangeError('The polyline ends mid-point.');
        const b = encoded.charCodeAt(index++) - 63;
        result += (b & 0x1f) * shift;
        shift *= 32;
        if (b < 0x20) break;
      }
      // Python's ~(result >> 1) when the low bit is set, else result >> 1.
      deltas.push(result % 2 ? -Math.floor(result / 2) - 1 : Math.floor(result / 2));
    }
    lat += deltas[0];
    lon += deltas[1];
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
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
