from __future__ import annotations

import pytest
from conftest import ALPHA
from fastapi.testclient import TestClient

from incremental_routing.api import create_app
from incremental_routing.config import Settings
from incremental_routing.routing import StraightLineProvider


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings, StraightLineProvider())) as client:
        yield client


def test_health(client):
    assert client.get("/api/health").json() == {
        "status": "ok",
        "gtfs_loaded": True,
        "routing_provider": "straight-line",
    }


def test_departures_take_naive_times_as_local(client):
    resp = client.get(
        "/api/departures",
        params={"lat": ALPHA[0], "lon": ALPHA[1], "time": "2026-10-12T07:50"},
    )
    assert resp.status_code == 200
    [call] = resp.json()
    assert call["trip_id"] == "tr:T_MORNING"
    assert call["departure"] == "2026-10-12T08:00:00-07:00"


def test_trip_endpoint(client):
    resp = client.get("/api/trip", params={"trip_id": "tr:T_MORNING", "service_date": "2026-10-12"})
    assert resp.status_code == 200
    assert len(resp.json()["stops"]) == 4
    assert (
        client.get(
            "/api/trip", params={"trip_id": "tr:T_MORNING", "service_date": "2026-10-10"}
        ).status_code
        == 404
    )


def test_route_endpoint(client):
    resp = client.post(
        "/api/route",
        json={
            "mode": "bike",
            "origin": {"lat": 37.4, "lon": -122.1},
            "destination": {"lat": 37.41, "lon": -122.1},
        },
    )
    assert resp.status_code == 200
    assert resp.json()["provider"] == "straight-line"


def test_missing_database_is_a_clear_503(tmp_path):
    app = create_app(Settings(data_dir=tmp_path), StraightLineProvider())
    with TestClient(app) as client:
        resp = client.get(
            "/api/departures", params={"lat": 37.4, "lon": -122.1, "time": "2026-10-12T08:00"}
        )
    assert resp.status_code == 503
    assert "ir-load-gtfs" in resp.json()["detail"]
