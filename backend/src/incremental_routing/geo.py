"""Small geometry helpers."""

from __future__ import annotations

import math

EARTH_RADIUS_M = 6_371_008.8

# Straight-line distance understates street distance; this is a typical urban detour factor.
DETOUR_FACTOR = 1.3
# Typical speeds on foot and by bike, for estimates when no router is involved.
SPEEDS_MPS = {"walk": 1.3, "bike": 4.5}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def estimate_access_s(distance_m: float, mode: str = "walk") -> int:
    """Rough time to cover a straight-line distance on foot or by bike, allowing for detours.

    Used to filter departures you could still reach. Rounded up to whole minutes, like the
    walk and bike legs the frontend builds, so the two agree when the route matches the estimate.
    """
    return math.ceil(distance_m * DETOUR_FACTOR / SPEEDS_MPS[mode] / 60) * 60


def bbox_deltas(lat: float, radius_m: float) -> tuple[float, float]:
    """Degrees of latitude/longitude spanned by radius_m around lat."""
    dlat = math.degrees(radius_m / EARTH_RADIUS_M)
    dlon = dlat / max(math.cos(math.radians(lat)), 1e-6)
    return dlat, dlon


def decode_polyline(encoded: str, precision: int = 5) -> list[tuple[float, float]]:
    """Decode a Google-style encoded polyline into (lat, lon) pairs.

    Valhalla uses precision 6; Google and OSRM use precision 5.
    """
    factor = 10**precision
    coords: list[tuple[float, float]] = []
    index = lat = lon = 0
    while index < len(encoded):
        deltas = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lon += deltas[1]
        coords.append((lat / factor, lon / factor))
    return coords


def simplify_line(
    points: list[tuple[float, float]], tolerance_m: float
) -> list[tuple[float, float]]:
    """Drop the [lon, lat] points within tolerance_m of a straighter line (Douglas-Peucker).

    The ends are always kept. For drawing: a line followed to within a few metres looks the same.
    """
    if len(points) < 3:
        return list(points)
    cos_lat = math.cos(math.radians(points[0][1]))
    m_per_deg = math.radians(1) * EARTH_RADIUS_M
    xy = [(lon * cos_lat * m_per_deg, lat * m_per_deg) for lon, lat in points]
    # First drop points crowding the last one kept: cheap, and it spares the slower pass most
    # of the work on densely drawn shapes.
    near = [0]
    for i in range(1, len(points) - 1):
        last = xy[near[-1]]
        if math.hypot(xy[i][0] - last[0], xy[i][1] - last[1]) >= tolerance_m:
            near.append(i)
    near.append(len(points) - 1)
    points = [points[i] for i in near]
    xy = [xy[i] for i in near]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    spans = [(0, len(points) - 1)]
    while spans:
        a, b = spans.pop()
        far, far_m = None, tolerance_m
        for i in range(a + 1, b):
            d = _segment_distance(xy[i], xy[a], xy[b])
            if d > far_m:
                far, far_m = i, d
        if far is not None:
            keep[far] = True
            spans += [(a, far), (far, b)]
    return [p for p, k in zip(points, keep, strict=True) if k]


def _segment_distance(
    p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dy * dy
    t = (
        0.0
        if length2 == 0
        else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2))
    )
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
