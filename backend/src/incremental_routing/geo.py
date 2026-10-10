"""Small geometry helpers."""

from __future__ import annotations

import math

EARTH_RADIUS_M = 6_371_008.8

# Straight-line distance understates street distance; this is a typical urban detour factor.
DETOUR_FACTOR = 1.3
WALK_SPEED_MPS = 1.3


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def estimate_walk_s(distance_m: float) -> int:
    """Rough walking time from a straight-line distance; used to filter catchable departures."""
    return round(distance_m * DETOUR_FACTOR / WALK_SPEED_MPS)


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
