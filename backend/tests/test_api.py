from __future__ import annotations

import pytest
from conftest import ALPHA, DELTA, SOUTH_OF_ALPHA
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
        "gtfs_problem": None,
        "routing_provider": "straight-line",
    }


def test_feeds_list_each_agencys_dates(client):
    [feed] = client.get("/api/feeds").json()
    assert feed["agencies"] == [
        {"name": "Test Bus", "start_date": "2026-01-01", "end_date": "2026-12-31"},
        {"name": "Test Rail", "start_date": "2026-01-01", "end_date": "2026-12-31"},
    ]


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


def test_departures_by_bike(client):
    params = {"lat": SOUTH_OF_ALPHA[0], "lon": SOUTH_OF_ALPHA[1], "time": "2026-10-12T07:50"}
    walking = client.get("/api/departures", params={**params, "radius_m": 1000}).json()
    cycling = client.get(
        "/api/departures", params={**params, "radius_m": 1000, "access": "bike"}
    ).json()
    assert walking == []
    assert [c["trip_id"] for c in cycling] == ["tr:T_MORNING"]
    assert cycling[0]["stop"]["access_s"] < 300


def test_departures_per_route(client):
    params = {"lat": DELTA[0], "lon": DELTA[1], "time": "2026-10-12T08:15"}
    resp = client.get("/api/departures", params={**params, "per_route": 1})
    assert [c["trip_id"] for c in resp.json()] == ["tr:T_BUS"]
    assert client.get("/api/departures", params={**params, "per_route": 0}).status_code == 422


def test_departures_report_transfer_rules(client):
    resp = client.get(
        "/api/departures",
        params={
            "lat": DELTA[0],
            "lon": DELTA[1],
            "time": "2026-10-12T08:20",
            "transfer_stop": "tr:DELTA_1",
            "transfer_trip": "tr:T_MORNING",
        },
    )
    rules = {c["trip_id"]: c["transfer"] for c in resp.json()}
    assert rules == {
        "tr:T_BUS": {"type": 2, "min_transfer_s": 120},
        "tr:T_BUS2": {"type": 3, "min_transfer_s": None},
    }


def test_trip_endpoint_includes_the_shape(client):
    trip = client.get(
        "/api/trip", params={"trip_id": "tr:T_MORNING", "service_date": "2026-10-12"}
    ).json()
    assert len(trip["shape"]) == 13
    assert [s["shape_index"] for s in trip["stops"]] == [0, 4, 8, 12]
