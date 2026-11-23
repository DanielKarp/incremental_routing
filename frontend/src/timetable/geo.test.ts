import { describe, expect, it } from 'vitest';
import { bboxDeltas, estimateAccessS, haversineM, pyRound, simplifyLine } from './geo';
import { decodeShape } from './shapes';

describe('geometry, as the server works it out', () => {
  it('measures distances as geo.haversine_m does', () => {
    // The server's /api/stops/nearby for Market St & Sansome St from (37.79, -122.4).
    expect(haversineM(37.79, -122.4, 37.79001, -122.40049)).toBe(43.072241812094774);
    expect(haversineM(37.4, -122.1, 37.4, -122.1)).toBe(0);
  });

  it('rounds access times up to whole minutes, walking or cycling', () => {
    expect(estimateAccessS(0)).toBe(0);
    expect(estimateAccessS(43.07)).toBe(60);
    // ~700 m: 12 minutes on foot, 4 by bike.
    expect(estimateAccessS(700)).toBe(720);
    expect(estimateAccessS(700, 'bike')).toBe(240);
  });

  it('widens the bounding box for longitude away from the equator', () => {
    const [dlat, dlon] = bboxDeltas(37.4, 500);
    expect(dlat).toBeCloseTo(0.0044966, 6);
    expect(dlon).toBeCloseTo(dlat / Math.cos((37.4 * Math.PI) / 180), 12);
  });

  it('rounds as Python does, exact ties to even', () => {
    // As Python's round(x, 6) gives them.
    expect(pyRound(-122.1003, 6)).toBe(-122.1003);
    // Just under ...9295 as a double, so down.
    expect(pyRound(37.7749295, 6)).toBe(37.774929);
    expect(pyRound(37.5078115, 6)).toBe(37.507812);
    // 37.5078125 is exactly 4801/128, halfway between 37.507812 and 37.507813: to even.
    expect(pyRound(37.5078125, 6)).toBe(37.507812);
    expect(pyRound(-122.4140625, 6)).toBe(-122.414062);
    expect(pyRound(5e-7, 6)).toBe(0);
  });

  it('simplifies lines as geo.simplify_line does', () => {
    // About 110 m north, with a 3 m wobble halfway: one straight segment.
    const wobble: [number, number][] = [
      [-122.1, 37.4],
      [-122.10003, 37.4005],
      [-122.1, 37.401],
    ];
    expect(simplifyLine(wobble, 10)).toEqual([
      [-122.1, 37.4],
      [-122.1, 37.401],
    ]);
    const corner: [number, number][] = [
      [-122.1, 37.4],
      [-122.1, 37.401],
      [-122.099, 37.401],
    ];
    expect(simplifyLine(corner, 10)).toEqual(corner);
    expect(simplifyLine(corner.slice(0, 2), 10)).toEqual(corner.slice(0, 2));
  });
});

/** A shapes.points blob, as compact.py's encode_shape() packs one. */
function encode(points: [number, number, number | null][]): Uint8Array {
  const n = points.length;
  const view = new DataView(new ArrayBuffer(12 * n));
  let [lat, lon] = [0, 0];
  points.forEach(([pLat, pLon, dist], k) => {
    const [iLat, iLon] = [Math.round(pLat * 1e5), Math.round(pLon * 1e5)];
    view.setInt32(8 * k, iLat - lat, true);
    view.setInt32(8 * k + 4, iLon - lon, true);
    [lat, lon] = [iLat, iLon];
    view.setFloat32(8 * n + 4 * k, dist ?? NaN, true);
  });
  return new Uint8Array(view.buffer);
}

describe('shape blobs', () => {
  it('give back the points, from wherever the blob starts', () => {
    const points: [number, number, number | null][] = [
      [37.40001, -122.09999, 0],
      [37.4025, -122.1, 278.5],
      [37.39, -122.2, 1e6],
    ];
    // Three bytes in: not 4-byte aligned, as sql.js may hand blobs over.
    const blob = encode(points);
    const padded = new Uint8Array(blob.length + 3);
    padded.set(blob, 3);
    expect(decodeShape(padded.subarray(3))).toEqual([
      { lat: 37.40001, lon: -122.09999, dist: 0 },
      { lat: 37.4025, lon: -122.1, dist: 278.5 },
      { lat: 37.39, lon: -122.2, dist: 1e6 },
    ]);
  });

  it('read NaN distances as none, and an empty blob as no points', () => {
    expect(decodeShape(encode([[37.4, -122.1, null]]))).toEqual([
      { lat: 37.4, lon: -122.1, dist: null },
    ]);
    expect(decodeShape(new Uint8Array())).toEqual([]);
    expect(() => decodeShape(new Uint8Array(13))).toThrow('12 bytes per point');
  });
});
