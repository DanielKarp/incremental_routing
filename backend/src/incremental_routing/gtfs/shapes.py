"""Where a trip's stops fall along its shape (shapes.txt), so a ride can be drawn on the map."""

from __future__ import annotations

import bisect
import math
from collections.abc import Sequence

from ..geo import EARTH_RADIUS_M

# (lat, lon, shape_dist_traveled or None)
Point = tuple[float, float, float | None]

# Search no further along the shape than this multiple of the straight-line distance from the
# previous stop (plus an allowance), so a route doubling back can't pull a stop to its far end.
SEARCH_FACTOR = 3.0
SEARCH_SLACK_M = 1000.0
# Among points about equally close to a stop, the earliest wins: loops start and end together.
NEAR_TIE_M = 25.0
# shape_dist_traveled is trusted only while it lands this close to the stop. Some feeds measure
# stop distances along a different path than the shape they publish (Capitol Corridor's run
# 5 km ahead from Richmond on), and the nearest point is then used if it's closer.
DISTANCE_TRUST_M = 100.0
# A stop further than this from the shape isn't on it: the shape is wrong or incomplete there
# (SFO AirTrain's Red line skips three of its stops). It gets no index, so rides to or from it
# are drawn stop to stop.
OFF_SHAPE_M = 500.0


def stop_indices(shape: Sequence[Point], stops: Sequence[Point]) -> list[int | None]:
    """For each stop, in trip order, the index of its point on the shape; never decreasing.

    Uses shape_dist_traveled when the feed gives it for both the stop and the shape and it
    agrees with the geometry; otherwise the nearest point a bounded distance further along the
    shape. None for a stop the shape doesn't pass.
    """
    if not shape:
        return []
    cos_lat = math.cos(math.radians(shape[0][0]))
    along: list[float] = []  # Distances along the shape: worked out only if a stop needs them.
    shape_dists = [p[2] for p in shape]
    by_distance = all(d is not None for d in shape_dists)

    indices: list[int | None] = []
    lo = 0
    previous: Point | None = None
    for stop in stops:
        i, offset = None, math.inf
        if by_distance and stop[2] is not None:
            i = _at_distance(shape_dists, stop[2], lo)  # type: ignore[arg-type]
            offset = _offset(shape, i, stop, cos_lat)
        if offset > DISTANCE_TRUST_M:
            along = along or _cumulative_m(shape, cos_lat)
            limit = None
            if previous is not None:
                limit = along[lo] + SEARCH_FACTOR * _dist(previous, stop, cos_lat) + SEARCH_SLACK_M
            nearest = _nearest(shape, stop, lo, along, limit, cos_lat)
            nearest_offset = _offset(shape, nearest, stop, cos_lat)
            if nearest_offset < offset:
                i, offset = nearest, nearest_offset
        if i is None or offset > OFF_SHAPE_M:
            indices.append(None)  # Later stops keep matching from the last good one.
            continue
        indices.append(i)
        lo = i
        previous = stop
    return indices


def _at_distance(dists: Sequence[float], target: float, lo: int) -> int:
    i = bisect.bisect_left(dists, target, lo)
    if i >= len(dists):
        return len(dists) - 1
    if i > lo and target - dists[i - 1] < dists[i] - target:
        return i - 1
    return i


def _nearest(
    shape: Sequence[Point],
    stop: Point,
    lo: int,
    along: Sequence[float],
    limit: float | None,
    cos_lat: float,
) -> int:
    candidates = []
    for i in range(lo, len(shape)):
        if limit is not None and i > lo and along[i] > limit:
            break
        candidates.append((i, _dist(shape[i], stop, cos_lat)))
    best = min(d for _, d in candidates)
    return next(i for i, d in candidates if d <= best + NEAR_TIE_M)


def _offset(shape: Sequence[Point], i: int, stop: Point, cos_lat: float) -> float:
    """How far the stop is from the shape around point i: the segments either side of it.

    Measured to the segments, not the point, so a stop midway along a long straight segment
    of a sparse shape still counts as on it.
    """
    best = _dist(shape[i], stop, cos_lat)
    for j in (i - 1, i + 1):
        if 0 <= j < len(shape):
            best = min(best, _segment_dist(shape[i], shape[j], stop, cos_lat))
    return best


def _segment_dist(a: Point, b: Point, p: Point, cos_lat: float) -> float:
    """Distance in metres from p to the segment a-b, on a local flat projection around a."""
    bx, by = _local(a, b, cos_lat)
    px, py = _local(a, p, cos_lat)
    length2 = bx * bx + by * by
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, (px * bx + py * by) / length2))
    return math.hypot(px - t * bx, py - t * by)


def _local(origin: Point, p: Point, cos_lat: float) -> tuple[float, float]:
    return (
        EARTH_RADIUS_M * math.radians(p[1] - origin[1]) * cos_lat,
        EARTH_RADIUS_M * math.radians(p[0] - origin[0]),
    )


def _cumulative_m(shape: Sequence[Point], cos_lat: float) -> list[float]:
    along = [0.0]
    for a, b in zip(shape, shape[1:], strict=False):
        along.append(along[-1] + _dist(a, b, cos_lat))
    return along


def _dist(a: Point, b: Point, cos_lat: float) -> float:
    """Equirectangular distance in metres: plenty accurate at city scale, and fast."""
    dx = math.radians(b[1] - a[1]) * cos_lat
    dy = math.radians(b[0] - a[0])
    return EARTH_RADIUS_M * math.hypot(dx, dy)
