// The shapes.points blobs of the compact timetable (see compact_schema.sql): n points in 12n
// bytes, little-endian, no header. First n pairs of int32 (lat, lon) in 1e-5 degree, the first
// pair the first point and each later pair the change from the one before; then n float32
// distances along the shape (shape_dist_traveled), NaN where the feed gives none.

// Shape coordinates are stored as integers in this many units per degree.
const COORD_SCALE = 100_000;

export interface ShapePoint {
  lat: number;
  lon: number;
  /** shape_dist_traveled, in the feed's units; null when the feed gives none. */
  dist: number | null;
}

export function decodeShape(blob: Uint8Array): ShapePoint[] {
  if (blob.length % 12) {
    throw new Error(`A shape blob holds 12 bytes per point, not ${blob.length} in all`);
  }
  const n = blob.length / 12;
  // A DataView reads at any offset: blobs from sql.js needn't be 4-byte aligned.
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const points: ShapePoint[] = [];
  let lat = 0;
  let lon = 0;
  for (let k = 0; k < n; k++) {
    lat += view.getInt32(8 * k, true);
    lon += view.getInt32(8 * k + 4, true);
    const dist = view.getFloat32(8 * n + 4 * k, true);
    // Dividing (rather than multiplying by 1e-5) gives the nearest double to the stored value.
    points.push({
      lat: lat / COORD_SCALE,
      lon: lon / COORD_SCALE,
      dist: isNaN(dist) ? null : dist,
    });
  }
  return points;
}
