"""Valhalla /route API: the public FOSSGIS server (no key, fair use) or Stadia Maps (key)."""

from __future__ import annotations

import httpx

from ..geo import decode_polyline
from ..models import LatLon, PathMode, RouteResult
from .base import HttpRoutingProvider, RoutingError

COSTING: dict[PathMode, str] = {"walk": "pedestrian", "bike": "bicycle"}
# Bike routes come with heights at this spacing, for the hill profile. Valhalla's own times
# already slow the rider on climbs.
ELEVATION_INTERVAL_M = 30.0
# Below any real Bay Area height: a no-data value from the elevation tiles.
NO_DATA_BELOW_M = -500.0


class ValhallaProvider(HttpRoutingProvider):
    name = "valhalla"

    def __init__(
        self,
        route_url: str,
        api_key: str | None = None,
        client: httpx.AsyncClient | None = None,
    ):
        super().__init__(client)
        self._route_url = route_url
        self._api_key = api_key

    async def route(self, mode: PathMode, origin: LatLon, destination: LatLon) -> RouteResult:
        data = await self._post_json(
            self._route_url,
            params={"api_key": self._api_key} if self._api_key else None,
            json={
                "locations": [
                    {"lat": origin.lat, "lon": origin.lon},
                    {"lat": destination.lat, "lon": destination.lon},
                ],
                "costing": COSTING[mode],
                "units": "kilometers",
                **({"elevation_interval": ELEVATION_INTERVAL_M} if mode == "bike" else {}),
            },
        )
        try:
            trip = data["trip"]
            geometry: list[tuple[float, float]] = []
            for leg in trip["legs"]:
                # Valhalla encodes shapes at 6 decimal places; consecutive legs share endpoints.
                points = [(lon, lat) for lat, lon in decode_polyline(leg["shape"], precision=6)]
                geometry.extend(points[1:] if geometry else points)
            elevation = _elevation(trip["legs"]) if mode == "bike" else None
            return RouteResult(
                mode=mode,
                provider=self.name,
                distance_m=trip["summary"]["length"] * 1000,
                duration_s=trip["summary"]["time"],
                geometry=geometry,
                elevation_m=elevation,
                elevation_interval_m=ELEVATION_INTERVAL_M if elevation else None,
            )
        except (KeyError, IndexError, TypeError) as exc:
            raise RoutingError(f"{self.name}: unexpected response shape") from exc


def _elevation(legs: list[dict]) -> list[float] | None:
    """The heights along a one-leg route, or None if the server sent none or any is missing.

    A server without elevation tiles leaves them out, and a gap would draw a false cliff.
    """
    if len(legs) != 1:
        return None
    heights = legs[0].get("elevation")
    if not heights or len(heights) < 2 or legs[0].get("elevation_interval") != ELEVATION_INTERVAL_M:
        return None
    if any(not isinstance(h, int | float) or h < NO_DATA_BELOW_M for h in heights):
        return None
    return [round(float(h), 1) for h in heights]
