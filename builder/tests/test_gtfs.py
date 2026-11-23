"""The full database: loading a feed into it (loader.py), and reading it back (database.py)."""

from __future__ import annotations

import datetime as dt
import shutil
import sqlite3

import pytest

from incremental_routing.gtfs.database import (
    GtfsUnavailable,
    agency_coverage,
    check_database,
    feeds,
)
from incremental_routing.gtfs.loader import build_database
from incremental_routing.gtfs.timeutil import parse_gtfs_date, parse_gtfs_time


@pytest.fixture
def conn(full_db):
    conn = sqlite3.connect(full_db)
    yield conn
    conn.close()


# --- time handling -----------------------------------------------------------------------


def test_gtfs_times_may_pass_24_hours():
    assert parse_gtfs_time("25:10:00") == 25 * 3600 + 600
    assert parse_gtfs_time("") is None
    assert parse_gtfs_date("20261012") == dt.date(2026, 10, 12)


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


def test_feeds_report_each_agencys_dates(tmp_path, bus_ends_early_zip):
    db = tmp_path / "gtfs.sqlite"
    build_database(db, [("tr", bus_ends_early_zip)])
    with sqlite3.connect(db) as conn:
        [(feed_id, agencies)] = agency_coverage(conn).items()
    assert feed_id == "tr"
    # The feed as a whole runs to December, but the bus schedule stops in October.
    assert [(a.name, a.start_date, a.end_date) for a in agencies] == [
        ("Test Bus", dt.date(2026, 1, 1), dt.date(2026, 10, 31)),
        ("Test Rail", dt.date(2026, 1, 1), dt.date(2026, 12, 31)),
    ]


def test_feeds_are_listed_as_the_server_listed_them(tmp_path, bus_ends_early_zip):
    db = tmp_path / "gtfs.sqlite"
    build_database(db, [("tr", bus_ends_early_zip)])
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE feeds SET loaded_at = '2026-11-23T05:40:32+00:00'")
    # The fields, their order and their formats, as /api/feeds sent them (pydantic's JSON).
    assert feeds(db) == [
        {
            "feed_id": "tr",
            "timezone": "America/Los_Angeles",
            "start_date": "2026-01-01",
            "end_date": "2026-12-31",
            "loaded_at": "2026-11-23T05:40:32Z",
            "has_frequencies": False,
            "agencies": [
                {"name": "Test Bus", "start_date": "2026-01-01", "end_date": "2026-10-31"},
                {"name": "Test Rail", "start_date": "2026-01-01", "end_date": "2026-12-31"},
            ],
        }
    ]
    assert list(feeds(db)[0]) == [
        "feed_id",
        "timezone",
        "start_date",
        "end_date",
        "loaded_at",
        "has_frequencies",
        "agencies",
    ]


# --- database version --------------------------------------------------------------------


def test_a_missing_or_outdated_database_asks_for_a_rebuild(full_db, tmp_path):
    check_database(full_db)
    with pytest.raises(GtfsUnavailable, match="No GTFS database at .*ir-build-data"):
        check_database(tmp_path / "none.sqlite")
    old = tmp_path / "gtfs.sqlite"
    shutil.copy(full_db, old)
    with sqlite3.connect(old) as conn:
        conn.execute("DROP TABLE meta")
    with pytest.raises(GtfsUnavailable, match="older version of the builder.*ir-build-data"):
        check_database(old)
    with pytest.raises(GtfsUnavailable, match="older version"):
        feeds(old)
