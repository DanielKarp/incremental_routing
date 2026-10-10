"""The interface every walk/bike routing provider implements."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import httpx

from ..models import LatLon, PathMode, RouteResult

USER_AGENT = "incremental-routing/0.1 (personal trip planner)"
TIMEOUT_S = 20.0


class RoutingError(RuntimeError):
    """A provider could not produce a route."""


class RoutingProvider(ABC):
    name: str

    @abstractmethod
    async def route(self, mode: PathMode, origin: LatLon, destination: LatLon) -> RouteResult: ...

    async def aclose(self) -> None:  # noqa: B027 - optional hook
        pass


class HttpRoutingProvider(RoutingProvider):
    """Base for providers that call a web API. Pass `client` to inject a mock transport."""

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(
            timeout=TIMEOUT_S, headers={"User-Agent": USER_AGENT}
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _post_json(self, url: str, **kwargs: Any) -> Any:
        try:
            resp = await self._client.post(url, **kwargs)
        except httpx.HTTPError as exc:
            raise RoutingError(f"{self.name}: request failed: {exc}") from exc
        if resp.status_code != 200:
            raise RoutingError(f"{self.name}: HTTP {resp.status_code}: {resp.text[:300]}")
        return resp.json()
