"""Walk/bike routing behind one interface, so providers can be swapped by config."""

from __future__ import annotations

import httpx

from ..config import Settings
from .base import RoutingError, RoutingProvider
from .ors import OrsProvider
from .straight_line import StraightLineProvider
from .valhalla import ValhallaProvider

__all__ = [
    "OrsProvider",
    "RoutingError",
    "RoutingProvider",
    "StraightLineProvider",
    "ValhallaProvider",
    "make_provider",
]


def make_provider(settings: Settings, client: httpx.AsyncClient | None = None) -> RoutingProvider:
    """ROUTING_PROVIDER wins; otherwise ORS when a key is configured, else public Valhalla."""
    choice = (settings.routing_provider or ("ors" if settings.ors_api_key else "valhalla")).lower()
    if choice == "ors":
        if not settings.ors_api_key:
            raise ValueError("ROUTING_PROVIDER=ors requires ORS_API_KEY")
        return OrsProvider(settings.ors_api_key, client)
    if choice == "valhalla":
        return ValhallaProvider(settings.valhalla_route_url, settings.valhalla_api_key, client)
    if choice == "straight-line":
        return StraightLineProvider()
    raise ValueError(f"Unknown ROUTING_PROVIDER {choice!r}")
