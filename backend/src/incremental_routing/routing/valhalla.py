"""Valhalla /route API: the public FOSSGIS server (no key, fair use) or Stadia Maps (key)."""

from __future__ import annotations

import httpx

from ..geo import decode_polyline
from ..models import LatLon, PathMode, RouteResult
from .base import HttpRoutingProvider, RoutingError

COSTING: dict[PathMode, str] = {"walk": "pedestrian", "bike": "bicycle"}


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
            },
        )
        try:
            trip = data["trip"]
            geometry: list[tuple[float, float]] = []
            for leg in trip["legs"]:
                # Valhalla encodes shapes at 6 decimal places; consecutive legs share endpoints.
                points = [(lon, lat) for lat, lon in decode_polyline(leg["shape"], precision=6)]
                geometry.extend(points[1:] if geometry else points)
            return RouteResult(
                mode=mode,
                provider=self.name,
                distance_m=trip["summary"]["length"] * 1000,
                duration_s=trip["summary"]["time"],
                geometry=geometry,
            )
        except (KeyError, IndexError, TypeError) as exc:
            raise RoutingError(f"{self.name}: unexpected response shape") from exc
