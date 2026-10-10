"""OpenRouteService directions (free API key; 2,000 directions requests/day on the free plan)."""

from __future__ import annotations

import httpx

from ..models import LatLon, PathMode, RouteResult
from .base import HttpRoutingProvider, RoutingError

ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/{profile}/geojson"

# Other useful profiles: cycling-road, cycling-electric, cycling-mountain, foot-hiking.
PROFILES: dict[PathMode, str] = {"walk": "foot-walking", "bike": "cycling-regular"}


class OrsProvider(HttpRoutingProvider):
    name = "ors"

    def __init__(self, api_key: str, client: httpx.AsyncClient | None = None):
        super().__init__(client)
        self._api_key = api_key

    async def route(self, mode: PathMode, origin: LatLon, destination: LatLon) -> RouteResult:
        data = await self._post_json(
            ORS_DIRECTIONS_URL.format(profile=PROFILES[mode]),
            json={"coordinates": [[origin.lon, origin.lat], [destination.lon, destination.lat]]},
            headers={"Authorization": self._api_key},
        )
        try:
            feature = data["features"][0]
            # ORS omits summary fields when origin and destination coincide.
            summary = feature["properties"].get("summary", {})
            return RouteResult(
                mode=mode,
                provider=self.name,
                distance_m=summary.get("distance", 0.0),
                duration_s=summary.get("duration", 0.0),
                geometry=[(c[0], c[1]) for c in feature["geometry"]["coordinates"]],
            )
        except (KeyError, IndexError, TypeError) as exc:
            raise RoutingError(f"{self.name}: unexpected response shape") from exc
