"""Reading the full database loader.py builds: whether it can be used, and what its feeds cover."""

from __future__ import annotations

import datetime as dt
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .loader import SCHEMA_VERSION

REBUILD = "Build it with `uv run ir-build-data` in builder/ (--skip-download reuses the feed)."


class GtfsUnavailable(RuntimeError):
    """The database is missing, or was built by an older version of the builder."""


def check_database(db_path: Path) -> None:
    """Raise GtfsUnavailable, saying why, unless db_path is a database loader.py built."""
    if not db_path.exists():
        raise GtfsUnavailable(f"No GTFS database at {db_path}. {REBUILD}")
    conn = connect(db_path)
    try:
        try:
            row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
        except sqlite3.OperationalError:
            row = None
    finally:
        conn.close()
    if row is None or row[0] != str(SCHEMA_VERSION):
        raise GtfsUnavailable(
            f"The GTFS database at {db_path} was built by an older version of the builder."
            f" {REBUILD}"
        )


def connect(db_path: Path) -> sqlite3.Connection:
    """The database, read-only."""
    return sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)


@dataclass(frozen=True)
class AgencyCoverage:
    name: str | None
    start_date: dt.date | None
    end_date: dt.date | None


def agency_coverage(conn: sqlite3.Connection) -> dict[str, list[AgencyCoverage]]:
    """Per feed, the dates each agency's services cover, by agency name.

    A regional feed merges agencies whose schedules end at different times, so its overall
    date range can't show that one of them has run out.
    """
    rows = conn.execute(
        """
        WITH services AS (
            SELECT DISTINCT t.feed_id, r.agency_name, t.service_id
            FROM trips t JOIN routes r ON r.route_id = t.route_id
        ),
        spans AS (
            SELECT s.feed_id, s.agency_name, c.start_date AS first, c.end_date AS last
            FROM services s JOIN calendar c ON c.service_id = s.service_id
            UNION ALL
            SELECT s.feed_id, s.agency_name, d.date, d.date
            FROM services s JOIN calendar_dates d ON d.service_id = s.service_id
            WHERE d.exception_type = 1
        )
        SELECT feed_id, agency_name, MIN(first), MAX(last) FROM spans
        GROUP BY feed_id, agency_name ORDER BY feed_id, agency_name
        """
    )
    coverage: dict[str, list[AgencyCoverage]] = defaultdict(list)
    for feed_id, name, first, last in rows:
        coverage[feed_id].append(AgencyCoverage(name, _date(first), _date(last)))
    return coverage


def feeds(db_path: Path) -> list[dict]:
    """The feeds, with each agency's dates, as JSON: the manifest lists them for the app.

    The fields and their formats are the ones the server's /api/feeds sent (until commit
    1c15be0), which the app reads (FeedInfo in frontend/src/api.ts).
    """
    check_database(db_path)
    conn = connect(db_path)
    try:
        coverage = agency_coverage(conn)
        rows = conn.execute(
            "SELECT feed_id, timezone, start_date, end_date, loaded_at, has_frequencies"
            " FROM feeds ORDER BY feed_id"
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "feed_id": feed_id,
            "timezone": timezone,
            "start_date": _iso(_date(start_date)),
            "end_date": _iso(_date(end_date)),
            "loaded_at": _iso_datetime(loaded_at),
            "has_frequencies": bool(has_frequencies),
            "agencies": [
                {"name": a.name, "start_date": _iso(a.start_date), "end_date": _iso(a.end_date)}
                for a in coverage.get(feed_id, [])
            ],
        }
        for feed_id, timezone, start_date, end_date, loaded_at, has_frequencies in rows
    ]


def _date(value: str | None) -> dt.date | None:
    return None if value is None else dt.date.fromisoformat(value)


def _iso(value: dt.date | None) -> str | None:
    return None if value is None else value.isoformat()


def _iso_datetime(value: str) -> str:
    """An ISO datetime as the server sent it: "2026-11-23T05:40:32Z" for one in UTC."""
    text = dt.datetime.fromisoformat(value).isoformat()
    return text[:-6] + "Z" if text.endswith("+00:00") else text
