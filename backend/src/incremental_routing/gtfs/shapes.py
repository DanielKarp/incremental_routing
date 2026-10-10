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


def stop_indices(shape: Sequence[Point], stops: Sequence[Point]) -> list[int]:
    """For each stop, in trip order, the index of its point on the shape; never decreasing.

    Exact when the feed gives shape_dist_traveled for both the stop and the shape; otherwise
    the stop is matched to the nearest point a bounded distance further along the shape.
    """
    if not shape:
        return []
    cos_lat = math.cos(math.radians(shape[0][0]))
    along = _cumulative_m(shape, cos_lat)
    shape_dists = [p[2] for p in shape]
    by_distance = all(d is not None for d in shape_dists)

    indices: list[int] = []
    lo = 0
    previous: Point | None = None
    for stop in stops:
        if by_distance and stop[2] is not None:
            i = _at_distance(shape_dists, stop[2], lo)  # type: ignore[arg-type]
        else:
            limit = None
            if previous is not None:
                limit = along[lo] + SEARCH_FACTOR * _dist(previous, stop, cos_lat) + SEARCH_SLACK_M
            i = _nearest(shape, stop, lo, along, limit, cos_lat)
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
