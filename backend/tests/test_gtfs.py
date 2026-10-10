from __future__ import annotations

import datetime as dt
import sqlite3
from zoneinfo import ZoneInfo

import pytest
from conftest import ALPHA, BRAVO, DELTA

from incremental_routing.gtfs.query import GtfsStore, _active_service_ids
from incremental_routing.gtfs.timeutil import (
    gtfs_to_datetime,
    parse_gtfs_time,
    service_day_origin,
)

LA = ZoneInfo("America/Los_Angeles")
MONDAY = dt.date(2026, 10, 12)
THANKSGIVING = dt.date(2026, 11, 26)
DST_END = dt.date(2026, 11, 1)  # clocks go back at 02:00


def at(day: dt.date, hh: int, mm: int, ss: int = 0) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(hh, mm, ss), tzinfo=LA)


@pytest.fixture
def store(settings) -> GtfsStore:
    return GtfsStore(settings.db_path)


@pytest.fixture
def conn(settings):
    conn = sqlite3.connect(settings.db_path)
    yield conn
    conn.close()


# --- time handling -----------------------------------------------------------------------


def test_parse_gtfs_time_allows_hours_past_24():
    assert parse_gtfs_time("25:10:00") == 25 * 3600 + 600
    assert parse_gtfs_time("") is None


def test_service_day_origin_is_noon_minus_12h_on_dst_change_day():
    # Noon PST is 20:00 UTC, so the origin is 08:00 UTC = 01:00 PDT, not midnight.
    assert service_day_origin(DST_END, LA) == dt.datetime(2026, 11, 1, 8, tzinfo=dt.UTC)
    assert gtfs_to_datetime(DST_END, 8 * 3600, LA) == at(DST_END, 8, 0)


# --- loader --------------------------------------------------------------------------------


def test_ids_are_prefixed_with_feed_id(conn):
    stop_ids = {row[0] for row in conn.execute("SELECT stop_id FROM stops")}
    assert "tr:ALPHA" in stop_ids
    parent = conn.execute("SELECT parent_station FROM stops WHERE stop_id = 'tr:DELTA_1'")
    assert parent.fetchone()[0] == "tr:DELTA"


def test_missing_stop_times_are_interpolated(conn):
    row = conn.execute(
        "SELECT arrival_s, departure_s FROM stop_times "
        "WHERE trip_id = 'tr:T_MORNING' AND stop_sequence = 3"
    ).fetchone()
    # Halfway between Bravo's 08:06 departure and Delta's 08:20 arrival.
    assert row == (8 * 3600 + 13 * 60, 8 * 3600 + 13 * 60)


def test_trip_sequence_bounds_and_feed_dates_come_from_the_calendar(conn):
    assert conn.execute(
        "SELECT first_seq, last_seq FROM trips WHERE trip_id = 'tr:T_MORNING'"
    ).fetchone() == (1, 4)
    assert conn.execute("SELECT start_date, end_date FROM feeds").fetchone() == (
        "2026-01-01",
        "2026-12-31",
    )


def test_service_calendar_with_exceptions(conn):
    assert _active_service_ids(conn, "tr", MONDAY) == {"tr:WKDY"}
    assert _active_service_ids(conn, "tr", dt.date(2026, 10, 10)) == {"tr:SAT"}
    assert _active_service_ids(conn, "tr", THANKSGIVING) == {"tr:SAT"}


# --- queries -------------------------------------------------------------------------------


def test_nearby_stops_skip_parent_stations(store):
    stops = store.nearby_stops(*DELTA, radius_m=200)
    assert [s.stop_id for s in stops] == ["tr:DELTA_1"]


def test_departures_from_a_stop(store):
    calls = store.departures(*ALPHA, at(MONDAY, 7, 50), 500, 3600, 10)
    assert [(c.trip_id, c.departure) for c in calls] == [("tr:T_MORNING", at(MONDAY, 8, 0))]
    assert calls[0].route.short_name == "L1"
    assert calls[0].stop.name == "Alpha"


def test_departures_leave_time_to_walk_to_the_stop(store):
    # ~222 m north of Alpha: a ~3.7 minute walk, so an 08:00 train needs leaving by ~07:56.
    point = (ALPHA[0] + 0.002, ALPHA[1])
    assert store.departures(*point, at(MONDAY, 7, 55), 500, 3600, 10)
    assert not store.departures(*point, at(MONDAY, 7, 57), 500, 3600, 10)


def test_departures_after_midnight_come_from_previous_service_day(store):
    tuesday = MONDAY + dt.timedelta(days=1)
    calls = store.departures(*BRAVO, at(tuesday, 0, 5), 500, 3600, 10)
    assert [(c.trip_id, c.service_date, c.departure) for c in calls] == [
        ("tr:T_LATE", MONDAY, at(tuesday, 0, 10))
    ]


def test_departures_respect_holiday_exceptions(store):
    calls = store.departures(*ALPHA, at(THANKSGIVING, 7, 50), 500, 2 * 3600, 10)
    assert [c.trip_id for c in calls] == ["tr:T_SATURDAY"]


def test_no_departures_at_a_trips_last_stop(store):
    assert store.departures(*DELTA, at(MONDAY, 8, 15), 500, 3600, 10) == []


def test_departure_times_on_dst_change_day(store):
    calls = store.departures(*ALPHA, at(DST_END, 7, 30), 500, 3600, 10)
    assert [c.departure for c in calls] == [at(DST_END, 8, 0)]


def test_arrivals_for_backward_planning(store):
    calls = store.arrivals(*DELTA, at(MONDAY, 8, 30), 500, 3600, 10)
    assert [(c.trip_id, c.arrival, c.stop.stop_id) for c in calls] == [
        ("tr:T_MORNING", at(MONDAY, 8, 20), "tr:DELTA_1")
    ]
    # Nobody alights at a trip's first stop.
    assert store.arrivals(*ALPHA, at(MONDAY, 8, 30), 500, 3600, 10) == []


def test_trip_detail(store):
    trip = store.trip("tr:T_MORNING", MONDAY)
    assert [s.stop.name for s in trip.stops] == ["Alpha", "Bravo", "Charlie", "Delta Platform 1"]
    assert trip.stops[2].arrival == at(MONDAY, 8, 13)
    assert [s.can_board for s in trip.stops] == [True, True, True, False]
    assert [s.can_alight for s in trip.stops] == [False, True, True, True]


def test_trip_detail_rejects_dates_the_trip_does_not_run(store):
    with pytest.raises(LookupError):
        store.trip("tr:T_MORNING", dt.date(2026, 10, 10))
    with pytest.raises(LookupError):
        store.trip("tr:NOPE", MONDAY)
