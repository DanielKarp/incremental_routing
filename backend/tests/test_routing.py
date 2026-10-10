from __future__ import annotations

import json

import httpx
import pytest

from incremental_routing.config import Settings
from incremental_routing.geo import decode_polyline
from incremental_routing.models import LatLon
from incremental_routing.routing import (
    OrsProvider,
    RoutingError,
    StraightLineProvider,
    ValhallaProvider,
    make_provider,
)

ORIGIN = LatLon(lat=37.4, lon=-122.1)
DEST = LatLon(lat=37.41, lon=-122.1)

# The example from Google's polyline format documentation.
GOOGLE_EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_decode_polyline():
    assert decode_polyline(GOOGLE_EXAMPLE) == pytest.approx(
        [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
    )


@pytest.mark.anyio
async def test_ors_request_and_response():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "features": [
                    {
                        "geometry": {"coordinates": [[-122.1, 37.4], [-122.1, 37.41]]},
                        "properties": {"summary": {"distance": 1234.5, "duration": 300.0}},
                    }
                ]
            },
        )

    provider = OrsProvider("secret", mock_client(handler))
    result = await provider.route("bike", ORIGIN, DEST)

    assert seen["url"].endswith("/v2/directions/cycling-regular/geojson")
    assert seen["auth"] == "secret"
    assert seen["body"] == {"coordinates": [[-122.1, 37.4], [-122.1, 37.41]]}
    assert (result.distance_m, result.duration_s) == (1234.5, 300.0)
    assert result.geometry == [(-122.1, 37.4), (-122.1, 37.41)]


@pytest.mark.anyio
async def test_valhalla_request_and_response():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "trip": {
                    "summary": {"length": 1.5, "time": 1100.0},
                    "legs": [{"shape": GOOGLE_EXAMPLE}],
                }
            },
        )

    provider = ValhallaProvider("https://example.test/route", "k", mock_client(handler))
    result = await provider.route("walk", ORIGIN, DEST)

    assert seen["params"] == {"api_key": "k"}
    assert seen["body"]["costing"] == "pedestrian"
    assert seen["body"]["locations"][0] == {"lat": 37.4, "lon": -122.1}
    assert (result.distance_m, result.duration_s) == (1500.0, 1100.0)
    # Precision 6 and [lon, lat] order.
    assert result.geometry[0] == pytest.approx((-12.02, 3.85))


@pytest.mark.anyio
async def test_provider_http_error_becomes_routing_error():
    provider = OrsProvider("bad", mock_client(lambda r: httpx.Response(403, text="quota")))
    with pytest.raises(RoutingError, match="HTTP 403"):
        await provider.route("walk", ORIGIN, DEST)


@pytest.mark.anyio
async def test_straight_line_provider():
    result = await StraightLineProvider().route("walk", ORIGIN, DEST)
    assert result.distance_m == pytest.approx(1112 * 1.3, rel=0.01)
    assert result.duration_s == pytest.approx(result.distance_m / 1.3)


def test_make_provider_defaults(tmp_path):
    # Explicit values so a developer's own .env can't change the outcome.
    def settings(**overrides) -> Settings:
        return Settings(
            **{"data_dir": tmp_path, "routing_provider": None, "ors_api_key": None, **overrides}
        )

    assert make_provider(settings()).name == "valhalla"
    assert make_provider(settings(ors_api_key="k")).name == "ors"
    assert make_provider(settings(ors_api_key="k", routing_provider="valhalla")).name == "valhalla"
    with pytest.raises(ValueError):
        make_provider(settings(routing_provider="ors"))
