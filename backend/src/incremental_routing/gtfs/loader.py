"""Load GTFS zip files into one SQLite database.

Every ID is prefixed with its feed ID ("bart:12TH") so several feeds share one set of tables
without collisions. Stop times are stored as seconds from the service day's origin
(see timeutil) and may exceed 86400 for trips running past midnight.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import logging
import sqlite3
import zipfile
from collections.abc import Iterable, Iterator
from pathlib import Path

from .timeutil import parse_gtfs_date, parse_gtfs_time

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE feeds (
    feed_id TEXT PRIMARY KEY,
    timezone TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    loaded_at TEXT NOT NULL,
    has_frequencies INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE routes (
    route_id TEXT PRIMARY KEY,
    feed_id TEXT NOT NULL,
    short_name TEXT,
    long_name TEXT,
    route_type INTEGER NOT NULL,
    color TEXT,
    text_color TEXT
);
CREATE TABLE stops (
    stop_id TEXT PRIMARY KEY,
    feed_id TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL,
    lon REAL,
    location_type INTEGER NOT NULL DEFAULT 0,
    parent_station TEXT
);
CREATE TABLE trips (
    trip_id TEXT PRIMARY KEY,
    feed_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    headsign TEXT,
    direction_id INTEGER,
    bikes_allowed INTEGER,
    first_seq INTEGER,
    last_seq INTEGER
);
CREATE TABLE stop_times (
    trip_id TEXT NOT NULL,
    stop_sequence INTEGER NOT NULL,
    stop_id TEXT NOT NULL,
    arrival_s INTEGER,
    departure_s INTEGER,
    pickup_type INTEGER NOT NULL DEFAULT 0,
    drop_off_type INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (trip_id, stop_sequence)
) WITHOUT ROWID;
CREATE TABLE calendar (
    service_id TEXT PRIMARY KEY,
    feed_id TEXT NOT NULL,
    monday INTEGER NOT NULL,
    tuesday INTEGER NOT NULL,
    wednesday INTEGER NOT NULL,
    thursday INTEGER NOT NULL,
    friday INTEGER NOT NULL,
    saturday INTEGER NOT NULL,
    sunday INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL
);
CREATE TABLE calendar_dates (
    service_id TEXT NOT NULL,
    feed_id TEXT NOT NULL,
    date TEXT NOT NULL,
    exception_type INTEGER NOT NULL
);
"""

# Built after all feeds are inserted; much faster than maintaining them during bulk load.
INDEXES = """
CREATE INDEX stops_lat ON stops (lat);
CREATE INDEX stop_times_departure ON stop_times (stop_id, departure_s);
CREATE INDEX stop_times_arrival ON stop_times (stop_id, arrival_s);
CREATE INDEX calendar_dates_lookup ON calendar_dates (feed_id, date);
"""

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
REQUIRED_FILES = ("agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt")


def build_database(db_path: Path, feeds: Iterable[tuple[str, Path]]) -> None:
    """(Re)build db_path from (feed_id, zip_path) pairs, replacing it atomically."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = db_path.with_name(db_path.name + ".tmp")
    tmp_path.unlink(missing_ok=True)
    conn = sqlite3.connect(tmp_path)
    try:
        conn.execute("PRAGMA journal_mode = OFF")
        conn.execute("PRAGMA synchronous = OFF")
        conn.executescript(SCHEMA)
        for feed_id, zip_path in feeds:
            load_feed(conn, feed_id, zip_path)
        conn.executescript(INDEXES)
        conn.commit()
    finally:
        conn.close()
    tmp_path.replace(db_path)


def load_feed(conn: sqlite3.Connection, feed_id: str, zip_path: Path) -> None:
    log.info("Loading %s from %s", feed_id, zip_path)

    def p(value: str) -> str:
        return f"{feed_id}:{value}"

    with zipfile.ZipFile(zip_path) as zf:
        members = _index_members(zf)
        missing = [name for name in REQUIRED_FILES if name not in members]
        if "calendar.txt" not in members and "calendar_dates.txt" not in members:
            missing.append("calendar.txt or calendar_dates.txt")
        if missing:
            raise ValueError(f"{zip_path} is missing {', '.join(missing)}")

        def read(name: str) -> Iterator[dict[str, str]]:
            return _read_csv(zf, members.get(name))

        agency = next(read("agency.txt"), None)
        timezone = agency.get("agency_timezone") if agency else None
        if not timezone:
            raise ValueError(f"{zip_path}: agency.txt has no agency_timezone")

        conn.executemany(
            "INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                (
                    p(r["route_id"]),
                    feed_id,
                    r.get("route_short_name") or None,
                    r.get("route_long_name") or None,
                    int(r["route_type"]),
                    r.get("route_color") or None,
                    r.get("route_text_color") or None,
                )
                for r in read("routes.txt")
            ),
        )
        conn.executemany(
            "INSERT INTO stops VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                (
                    p(r["stop_id"]),
                    feed_id,
                    r.get("stop_name", ""),
                    _float(r.get("stop_lat")),
                    _float(r.get("stop_lon")),
                    _int(r.get("location_type")) or 0,
                    p(r["parent_station"]) if r.get("parent_station") else None,
                )
                for r in read("stops.txt")
            ),
        )
        conn.executemany(
            "INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
            (
                (
                    p(r["trip_id"]),
                    feed_id,
                    p(r["route_id"]),
                    p(r["service_id"]),
                    r.get("trip_headsign") or None,
                    _int(r.get("direction_id")),
                    _int(r.get("bikes_allowed")),
                )
                for r in read("trips.txt")
            ),
        )
        conn.executemany(
            "INSERT INTO stop_times VALUES (?, ?, ?, ?, ?, ?, ?)",
            (_stop_time_row(r, p) for r in read("stop_times.txt")),
        )
        conn.executemany(
            "INSERT INTO calendar VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                (
                    p(r["service_id"]),
                    feed_id,
                    *(int(r[day]) for day in WEEKDAYS),
                    parse_gtfs_date(r["start_date"]).isoformat(),
                    parse_gtfs_date(r["end_date"]).isoformat(),
                )
                for r in read("calendar.txt")
            ),
        )
        conn.executemany(
            "INSERT INTO calendar_dates VALUES (?, ?, ?, ?)",
            (
                (
                    p(r["service_id"]),
                    feed_id,
                    parse_gtfs_date(r["date"]).isoformat(),
                    int(r["exception_type"]),
                )
                for r in read("calendar_dates.txt")
            ),
        )

        feed_info = next(read("feed_info.txt"), {})
        has_frequencies = next(read("frequencies.txt"), None) is not None

    _interpolate_missing_times(conn, feed_id)
    conn.execute(
        """
        UPDATE trips SET
            first_seq = (SELECT MIN(stop_sequence) FROM stop_times st
                         WHERE st.trip_id = trips.trip_id),
            last_seq = (SELECT MAX(stop_sequence) FROM stop_times st
                        WHERE st.trip_id = trips.trip_id)
        WHERE feed_id = ?
        """,
        (feed_id,),
    )

    start_date, end_date = _feed_date_range(conn, feed_id, feed_info)
    if has_frequencies:
        log.warning("%s has frequencies.txt; frequency-based trips are not expanded yet", feed_id)
    conn.execute(
        "INSERT INTO feeds VALUES (?, ?, ?, ?, ?, ?)",
        (
            feed_id,
            timezone,
            start_date,
            end_date,
            dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            int(has_frequencies),
        ),
    )


def _stop_time_row(r: dict[str, str], p) -> tuple:
    arrival = parse_gtfs_time(r.get("arrival_time"))
    departure = parse_gtfs_time(r.get("departure_time"))
    # A timepoint may give only one of the two times.
    arrival = departure if arrival is None else arrival
    departure = arrival if departure is None else departure
    return (
        p(r["trip_id"]),
        int(r["stop_sequence"]),
        p(r["stop_id"]),
        arrival,
        departure,
        _int(r.get("pickup_type")) or 0,
        _int(r.get("drop_off_type")) or 0,
    )


def _interpolate_missing_times(conn: sqlite3.Connection, feed_id: str) -> None:
    """Fill non-timepoint stops by linear interpolation between surrounding timepoints."""
    trip_ids = [
        row[0]
        for row in conn.execute(
            """
            SELECT DISTINCT st.trip_id FROM stop_times st
            JOIN trips t ON t.trip_id = st.trip_id
            WHERE t.feed_id = ? AND st.arrival_s IS NULL
            """,
            (feed_id,),
        )
    ]
    updates = []
    for trip_id in trip_ids:
        rows = conn.execute(
            "SELECT stop_sequence, arrival_s, departure_s FROM stop_times "
            "WHERE trip_id = ? ORDER BY stop_sequence",
            (trip_id,),
        ).fetchall()
        known = [i for i, row in enumerate(rows) if row[1] is not None]
        for a, b in zip(known, known[1:], strict=False):
            start, end = rows[a][2], rows[b][1]
            for i in range(a + 1, b):
                t = round(start + (end - start) * (i - a) / (b - a))
                updates.append((t, t, trip_id, rows[i][0]))
    conn.executemany(
        "UPDATE stop_times SET arrival_s = ?, departure_s = ? "
        "WHERE trip_id = ? AND stop_sequence = ?",
        updates,
    )


def _feed_date_range(
    conn: sqlite3.Connection, feed_id: str, feed_info: dict[str, str]
) -> tuple[str | None, str | None]:
    if feed_info.get("feed_start_date") and feed_info.get("feed_end_date"):
        return (
            parse_gtfs_date(feed_info["feed_start_date"]).isoformat(),
            parse_gtfs_date(feed_info["feed_end_date"]).isoformat(),
        )
    row = conn.execute(
        """
        SELECT MIN(d), MAX(d) FROM (
            SELECT start_date AS d FROM calendar WHERE feed_id = :f
            UNION ALL SELECT end_date FROM calendar WHERE feed_id = :f
            UNION ALL SELECT date FROM calendar_dates WHERE feed_id = :f AND exception_type = 1
        )
        """,
        {"f": feed_id},
    ).fetchone()
    return row[0], row[1]


def _index_members(zf: zipfile.ZipFile) -> dict[str, str]:
    """Map 'stops.txt' to its archive path; some publishers nest files in a folder."""
    members: dict[str, str] = {}
    for name in sorted(zf.namelist(), key=lambda n: n.count("/")):
        if not name.endswith("/"):
            members.setdefault(Path(name).name, name)
    return members


def _read_csv(zf: zipfile.ZipFile, member: str | None) -> Iterator[dict[str, str]]:
    if member is None:
        return
    with zf.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        for row in csv.DictReader(text, skipinitialspace=True):
            yield {k.strip(): (v or "").strip() for k, v in row.items() if isinstance(k, str)}


def _int(value: str | None) -> int | None:
    return int(value) if value else None


def _float(value: str | None) -> float | None:
    return float(value) if value else None
