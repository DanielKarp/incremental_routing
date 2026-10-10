"""Offline fallback: straight-line distance with a detour factor. Useful for tests and dev."""

from __future__ import annotations

from ..geo import DETOUR_FACTOR, SPEEDS_MPS, haversine_m
from ..models import LatLon, PathMode, RouteResult
from .base import RoutingProvider


class StraightLineProvider(RoutingProvider):
    name = "straight-line"

    async def route(self, mode: PathMode, origin: LatLon, destination: LatLon) -> RouteResult:
        distance = (
            haversine_m(origin.lat, origin.lon, destination.lat, destination.lon) * DETOUR_FACTOR
        )
        return RouteResult(
            mode=mode,
            provider=self.name,
            distance_m=distance,
            duration_s=distance / SPEEDS_MPS[mode],
            geometry=[(origin.lon, origin.lat), (destination.lon, destination.lat)],
        )
