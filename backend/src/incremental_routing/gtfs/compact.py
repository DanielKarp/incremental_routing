"""Derive the compact timetable the static site downloads from the full GTFS database.

compact_schema.sql describes the tables. In short: where a trip goes (its shape, and its stops
with their pickup and drop-off types and shape distances) is a path, and a path with running
times (from the trip's first departure) is a pattern, each stored once; each trip is one row,
its pattern and its start time; and shapes are simplified to SHAPE_TOLERANCE_M and packed into
one blob each. Where the server places each stop on its trip's shape is worked out here, on the
full shape, and kept with the path. Everything else is copied, so check_compact() can confirm
that each table the server's queries read comes back exactly.
"""

from __future__ import annotations

import datetime as dt
import itertools
import logging
import math
import re
import sqlite3
import struct
from collections import defaultdict
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

from ..geo import EARTH_RADIUS_M
from .loader import WEEKDAYS
from .query import GtfsStore, GtfsUnavailable
from .shapes import Point, stop_indices

log = logging.getLogger(__name__)

SCHEMA = Path(__file__).with_name("compact_schema.sql").read_text()
SCHEMA_VERSION = int(re.search(r"^PRAGMA user_version = (\d+);", SCHEMA, re.MULTILINE)[1])

# Every point of a shape is within this many metres of the simplified line: invisible on a map.
SHAPE_TOLERANCE_M = 5.0
# Shape coordinates are stored as integers in this many units per degree (1e-5 degree, ~1.1 m).
COORD_SCALE = 100_000

_DAYS = ", ".join(WEEKDAYS)

# Each table the server's queries read, as the full database holds it and as the compact one
# gives it back: check_compact() runs both and compares them row by row. They also show how to
# read the compact tables. Rows the server can never see are left out on both sides: stop times
# of trips trips.txt lacks, and (as NULLs) stops and routes that aren't in the feed.
ROUND_TRIPS = (
    (
        "feeds",
        "SELECT feed_id, timezone, start_date, end_date, loaded_at, has_frequencies"
        " FROM feeds ORDER BY feed_id",
        "SELECT feed_id, timezone, start_date, end_date, loaded_at, has_frequencies"
        " FROM feeds ORDER BY feed_id",
    ),
    (
        "routes",
        "SELECT route_id, feed_id, agency_name, short_name, long_name, route_type, color,"
        " text_color FROM routes ORDER BY rowid",
        "SELECT r.route_id, f.feed_id, r.agency_name, r.short_name, r.long_name, r.route_type,"
        " r.color, r.text_color FROM routes r JOIN feeds f ON f.id = r.feed ORDER BY r.id",
    ),
    (
        "stops",
        "SELECT stop_id, feed_id, name, lat, lon, location_type, parent_station"
        " FROM stops ORDER BY rowid",
        "SELECT s.stop_id, f.feed_id, s.name, s.lat, s.lon, s.location_type, s.parent_station"
        " FROM stops s JOIN feeds f ON f.id = s.feed ORDER BY s.id",
    ),
    (
        "trips",
        "SELECT t.trip_id, t.feed_id, r.route_id, t.service_id, t.headsign, t.direction_id,"
        " t.bikes_allowed, t.shape_id, t.first_seq, t.last_seq"
        " FROM trips t LEFT JOIN routes r ON r.route_id = t.route_id ORDER BY t.trip_id",
        "SELECT t.trip_id, f.feed_id, r.route_id, v.service_id, t.headsign, t.direction_id,"
        " t.bikes_allowed, h.shape_id, pa.first_seq, pa.last_seq"
        " FROM trips t JOIN feeds f ON f.id = t.feed LEFT JOIN routes r ON r.id = t.route"
        " JOIN services v ON v.id = t.service JOIN patterns p ON p.id = t.pattern"
        " JOIN paths pa ON pa.id = p.path LEFT JOIN shapes h ON h.id = pa.shape"
        " ORDER BY t.id",
    ),
    (
        "stop_times",
        "SELECT st.trip_id, st.stop_sequence, s.stop_id, st.arrival_s, st.departure_s,"
        " st.pickup_type, st.drop_off_type, st.shape_dist"
        " FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id"
        " LEFT JOIN stops s ON s.stop_id = st.stop_id ORDER BY st.trip_id, st.stop_sequence",
        "SELECT t.trip_id, ps.stop_sequence, s.stop_id, t.start + pt.arrival,"
        " t.start + pt.departure, ps.pickup_type, ps.drop_off_type, ps.shape_dist"
        " FROM trips t JOIN patterns p ON p.id = t.pattern"
        " JOIN path_stops ps ON ps.path = p.path"
        " JOIN pattern_times pt ON pt.pattern = p.id AND pt.stop_sequence = ps.stop_sequence"
        " LEFT JOIN stops s ON s.id = ps.stop ORDER BY t.trip_id, ps.stop_sequence",
    ),
    (
        "calendar",
        f"SELECT service_id, feed_id, {_DAYS}, start_date, end_date"
        " FROM calendar ORDER BY service_id",
        f"SELECT v.service_id, f.feed_id, {_DAYS}, c.start_date, c.end_date"
        " FROM calendar c JOIN services v ON v.id = c.service JOIN feeds f ON f.id = c.feed"
        " ORDER BY v.service_id",
    ),
    (
        "calendar_dates",
        "SELECT service_id, feed_id, date, exception_type FROM calendar_dates ORDER BY rowid",
        "SELECT v.service_id, f.feed_id, d.date, d.exception_type FROM calendar_dates d"
        " JOIN services v ON v.id = d.service JOIN feeds f ON f.id = d.feed ORDER BY d.rowid",
    ),
    (
        "transfers",
        "SELECT feed_id, from_stop, to_stop, transfer_type, min_transfer_s, from_route,"
        " to_route, from_trip, to_trip FROM transfers ORDER BY rowid",
        "SELECT f.feed_id, x.from_stop, x.to_stop, x.transfer_type, x.min_transfer_s,"
        " x.from_route, x.to_route, x.from_trip, x.to_trip"
        " FROM transfers x JOIN feeds f ON f.id = x.feed ORDER BY x.rowid",
    ),
    (
        "shape IDs",
        "SELECT shape_id FROM shapes UNION SELECT shape_id FROM trips"
        " WHERE shape_id IS NOT NULL ORDER BY shape_id",
        "SELECT shape_id FROM shapes ORDER BY shape_id",
    ),
)

# A path's stop: (stop_sequence, stop, pickup_type, drop_off_type, shape_dist, timed), with stop
# an integer ID. timed: whether the stop has a time. It isn't stored, but is part of the key,
# so that the patterns sharing a path have times at the same stops, and the server shows (and
# places on the shape) the same stops of each.
PathStop = tuple[int, int | None, int, int, float | None, bool]


class CompactMismatch(ValueError):
    """The compact timetable doesn't give back what the full database holds."""


@dataclass(frozen=True)
class CompactStats:
    trips: int
    stop_times: int
    paths: int
    path_stops: int
    patterns: int
    pattern_times: int
    shapes: int
    shape_points: int
    kept_points: int


def build_compact(full_db: Path, out_path: Path, *, built_at: str | None = None) -> CompactStats:
    """(Re)build out_path from full_db, a database loader.py built, replacing it atomically."""
    problem = GtfsStore(full_db).problem()
    if problem:
        raise GtfsUnavailable(problem)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_name(out_path.name + ".tmp")
    tmp_path.unlink(missing_ok=True)
    src = _read_only(full_db)
    out = sqlite3.connect(tmp_path)
    try:
        out.execute("PRAGMA journal_mode = OFF")
        out.execute("PRAGMA synchronous = OFF")
        out.executescript(SCHEMA)
        built_at = built_at or dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
        out.executemany(
            "INSERT INTO meta VALUES (?, ?)",
            [("built_at", built_at), ("shape_tolerance_m", f"{SHAPE_TOLERANCE_M:g}")],
        )
        stats = _copy(src, out)
        out.commit()
        out.execute("VACUUM")
    finally:
        out.close()
        src.close()
    tmp_path.replace(out_path)
    return stats


def _copy(src: sqlite3.Connection, out: sqlite3.Connection) -> CompactStats:
    # Integer IDs, numbered in the full database's row order, or by text ID for services and
    # shapes (which have no table of their own there) and trips.
    feed: dict[str, int] = {}
    out.executemany(
        "INSERT INTO feeds VALUES (?, ?, ?, ?, ?, ?, ?)",
        _numbered(
            src.execute(
                "SELECT feed_id, timezone, start_date, end_date, loaded_at, has_frequencies"
                " FROM feeds ORDER BY rowid"
            ),
            feed,
        ),
    )
    route: dict[str, int] = {}
    out.executemany(
        "INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        _numbered(
            (
                (r[0], feed[r[1]], *r[2:])
                for r in src.execute(
                    "SELECT route_id, feed_id, agency_name, short_name, long_name, route_type,"
                    " color, text_color FROM routes ORDER BY rowid"
                )
            ),
            route,
        ),
    )
    stop: dict[str, int] = {}
    out.executemany(
        "INSERT INTO stops VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        _numbered(
            (
                (r[0], feed[r[1]], *r[2:])
                for r in src.execute(
                    "SELECT stop_id, feed_id, name, lat, lon, location_type, parent_station"
                    " FROM stops ORDER BY rowid"
                )
            ),
            stop,
        ),
    )

    service_feeds: dict[str, str] = {}
    for service_id, feed_id in src.execute(
        "SELECT service_id, feed_id FROM calendar UNION SELECT service_id, feed_id"
        " FROM calendar_dates UNION SELECT service_id, feed_id FROM trips ORDER BY service_id"
    ):
        service_feeds.setdefault(service_id, feed_id)
    service: dict[str, int] = {}
    out.executemany(
        "INSERT INTO services VALUES (?, ?, ?)",
        _numbered(((s, feed[f]) for s, f in service_feeds.items()), service),
    )
    out.executemany(
        "INSERT INTO calendar VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            (service[r[0]], feed[r[1]], *r[2:])
            for r in src.execute(
                f"SELECT service_id, feed_id, {_DAYS}, start_date, end_date"
                " FROM calendar ORDER BY rowid"
            )
        ),
    )
    out.executemany(
        "INSERT INTO calendar_dates VALUES (?, ?, ?, ?)",
        (
            (service[r[0]], feed[r[1]], *r[2:])
            for r in src.execute(
                "SELECT service_id, feed_id, date, exception_type FROM calendar_dates"
                " ORDER BY rowid"
            )
        ),
    )
    out.executemany(
        "INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            (feed[r[0]], *r[1:])
            for r in src.execute(
                "SELECT feed_id, from_stop, to_stop, transfer_type, min_transfer_s, from_route,"
                " to_route, from_trip, to_trip FROM transfers ORDER BY rowid"
            )
        ),
    )

    # Every shape that shapes.txt has or a trip names.
    shape = {
        shape_id: n
        for n, (shape_id,) in enumerate(
            src.execute(
                "SELECT shape_id FROM shapes UNION SELECT shape_id FROM trips"
                " WHERE shape_id IS NOT NULL ORDER BY shape_id"
            ),
            1,
        )
    }
    # In trip_id order, which packs better than the feed's order and shows in no response.
    trips = src.execute(
        "SELECT trip_id, feed_id, route_id, service_id, headsign, direction_id, bikes_allowed,"
        " shape_id FROM trips ORDER BY trip_id"
    ).fetchall()
    trip_shape = {t[0]: shape.get(t[7]) for t in trips}

    # Paths, keyed by (shape, stops), and patterns, by (path, times); each numbered from 1 in
    # the order first seen.
    paths: dict[tuple[int | None, tuple[PathStop, ...]], int] = {}
    patterns: dict[tuple[int, tuple[tuple[int | None, int | None], ...]], int] = {}
    started: dict[str, tuple[int, int]] = {}  # trip_id -> (pattern, start)
    stop_times = unknown_trip_rows = unknown_stop_rows = 0
    for trip_id, rows in itertools.groupby(
        src.execute(
            "SELECT trip_id, stop_sequence, stop_id, arrival_s, departure_s, pickup_type,"
            " drop_off_type, shape_dist FROM stop_times ORDER BY trip_id, stop_sequence"
        ),
        key=lambda r: r[0],
    ):
        rows = list(rows)
        if trip_id not in trip_shape:
            unknown_trip_rows += len(rows)
            continue
        stop_times += len(rows)
        start = next((r[4] for r in rows if r[4] is not None), 0)
        path_stops = tuple(
            (seq, stop.get(stop_id), pickup, drop, dist, arr is not None)
            for _, seq, stop_id, arr, _, pickup, drop, dist in rows
        )
        unknown_stop_rows += sum(s[1] is None for s in path_stops)
        path = paths.setdefault((trip_shape[trip_id], path_stops), len(paths) + 1)
        times = tuple((_minus(r[3], start), _minus(r[4], start)) for r in rows)
        started[trip_id] = (patterns.setdefault((path, times), len(patterns) + 1), start)
    for trip_id, shape_id in trip_shape.items():
        if trip_id not in started:  # No stop times: a path without stops.
            path = paths.setdefault((shape_id, ()), len(paths) + 1)
            started[trip_id] = (patterns.setdefault((path, ()), len(patterns) + 1), 0)
    if unknown_trip_rows:
        log.warning("Left out %d stop times of trips trips.txt lacks", unknown_trip_rows)
    if unknown_stop_rows:
        log.warning("%d stop times name stops stops.txt lacks", unknown_stop_rows)
    unknown_routes = sum(t[2] not in route for t in trips)
    if unknown_routes:
        log.warning("%d trips name routes routes.txt lacks", unknown_routes)

    # Shapes, simplified, with the points the server places stops at kept: simplified away, a
    # stop would be placed at the nearest point left, which can be kilometres along a straight
    # line. Each path stop's shape_index is that point's index in the simplified shape.
    path_keys = list(paths)
    shape_paths: dict[int, list[int]] = defaultdict(list)
    for path, (shape_id, _) in enumerate(path_keys, 1):
        if shape_id is not None:
            shape_paths[shape_id].append(path)
    coords = {stop[r[0]]: r[1:] for r in src.execute("SELECT stop_id, lat, lon FROM stops")}
    blobs = dict.fromkeys(shape.values(), b"")  # Empty for shapes shapes.txt lacks.
    shape_index: dict[int, list[int | None]] = {}
    shape_points = kept_points = 0
    for shape_id, rows in itertools.groupby(
        src.execute("SELECT shape_id, lat, lon, dist FROM shapes ORDER BY shape_id, seq"),
        key=lambda r: r[0],
    ):
        points = [(lat, lon, dist) for _, lat, lon, dist in rows]
        placed = {
            path: _place_stops(points, path_keys[path - 1][1], coords)
            for path in shape_paths[shape[shape_id]]
        }
        blob, kept = pack_shape(points, {i for p in placed.values() for i in p if i is not None})
        index_of = {i: k for k, i in enumerate(kept)}
        for path, indices in placed.items():
            shape_index[path] = [None if i is None else index_of[i] for i in indices]
        blobs[shape[shape_id]] = blob
        shape_points += len(points)
        kept_points += len(kept)
    missing = sum(blob == b"" for blob in blobs.values())
    if missing:
        log.warning("%d shapes that trips name aren't in shapes.txt", missing)

    out.executemany(
        "INSERT INTO shapes VALUES (?, ?, ?)",
        ((n, shape_id, blobs[n]) for shape_id, n in shape.items()),
    )
    path_rows = []
    path_stop_rows = []
    for path, (shape_id, stops) in enumerate(path_keys, 1):
        first_seq, last_seq = (stops[0][0], stops[-1][0]) if stops else (None, None)
        path_rows.append((path, shape_id, first_seq, last_seq))
        indices = shape_index.get(path) or [None] * len(stops)
        path_stop_rows.extend((path, *s[:5], i) for s, i in zip(stops, indices, strict=True))
    out.executemany("INSERT INTO paths VALUES (?, ?, ?, ?)", path_rows)
    out.executemany("INSERT INTO path_stops VALUES (?, ?, ?, ?, ?, ?, ?)", path_stop_rows)
    out.executemany(
        "INSERT INTO patterns VALUES (?, ?)", ((n, path) for n, (path, _) in enumerate(patterns, 1))
    )
    pattern_times = [
        (n, s[0], arrival, departure)
        for n, (path, times) in enumerate(patterns, 1)
        for s, (arrival, departure) in zip(path_keys[path - 1][1], times, strict=True)
    ]
    out.executemany("INSERT INTO pattern_times VALUES (?, ?, ?, ?)", pattern_times)
    out.executemany(
        "INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            (n, trip_id, feed[feed_id], route.get(route_id), service[service_id])
            + started[trip_id]
            + (headsign, direction_id, bikes_allowed)
            for n, (
                trip_id,
                feed_id,
                route_id,
                service_id,
                headsign,
                direction_id,
                bikes_allowed,
                _,
            ) in enumerate(trips, 1)
        ),
    )
    return CompactStats(
        trips=len(trips),
        stop_times=stop_times,
        paths=len(path_rows),
        path_stops=len(path_stop_rows),
        patterns=len(patterns),
        pattern_times=len(pattern_times),
        shapes=len(blobs),
        shape_points=shape_points,
        kept_points=kept_points,
    )


def _place_stops(
    points: Sequence[Point],
    stops: Sequence[PathStop],
    coords: dict[int, tuple[float | None, float | None]],
) -> list[int | None]:
    """Where on the shape the server places each of a path's stops (query._shape_with_stops).

    None for the stops it doesn't show (without a time, or not in stops.txt), and for every
    stop when the shape has fewer than 2 points. A stop without coordinates can't be placed.
    """
    placed: list[int | None] = [None] * len(stops)
    if len(points) < 2:
        return placed
    shown = [
        k
        for k, (_, s, _, _, _, timed) in enumerate(stops)
        if s is not None and timed and None not in coords[s]
    ]
    found = stop_indices(points, [(*coords[stops[k][1]], stops[k][4]) for k in shown])
    for k, i in zip(shown, found, strict=True):
        placed[k] = i
    return placed


def check_compact(full_db: Path, compact_db: Path) -> None:
    """Raise CompactMismatch unless compact_db gives back what full_db holds (ROUND_TRIPS).

    Shapes are simplified, so of those only the IDs, the ends and the distances there are
    compared, and that each path stop's shape_index is on its shape.
    """
    full, compact = _read_only(full_db), _read_only(compact_db)
    try:
        version = compact.execute("PRAGMA user_version").fetchone()[0]
        if version != SCHEMA_VERSION:
            raise CompactMismatch(f"schema version {version}, expected {SCHEMA_VERSION}")
        for name, full_sql, compact_sql in ROUND_TRIPS:
            pairs = itertools.zip_longest(full.execute(full_sql), compact.execute(compact_sql))
            for n, (expected, actual) in enumerate(pairs, 1):
                if expected != actual:
                    raise CompactMismatch(
                        f"{name}, row {n}: {expected} in the full database, {actual} in the"
                        " compact one"
                    )
        _check_shapes(full, compact)
    finally:
        full.close()
        compact.close()


def _check_shapes(full: sqlite3.Connection, compact: sqlite3.Connection) -> None:
    blobs = dict(compact.execute("SELECT shape_id, points FROM shapes"))
    has_dists = dict(
        full.execute("SELECT shape_id, COUNT(dist) = COUNT(*) FROM shapes GROUP BY shape_id")
    )
    for end, which in ((0, "MIN"), (-1, "MAX")):
        # With a single MIN() or MAX(), SQLite takes the other columns from that row.
        for shape_id, lat, lon, dist, _ in full.execute(
            f"SELECT shape_id, lat, lon, dist, {which}(seq) FROM shapes GROUP BY shape_id"
        ):
            expected = (*_stored(lat, lon), _float32(dist) if has_dists[shape_id] else None)
            actual = decode_shape(blobs[shape_id])[end]
            if actual != expected:
                raise CompactMismatch(
                    f"shape {shape_id}: ends at {actual}, expected {expected} (to 1e-5 degree)"
                )
    for shape_id, size, path, stop_sequence, index in compact.execute(
        "SELECT h.shape_id, COALESCE(LENGTH(h.points), 0) / 12 AS size, ps.path,"
        " ps.stop_sequence, ps.shape_index"
        " FROM path_stops ps JOIN paths pa ON pa.id = ps.path"
        " LEFT JOIN shapes h ON h.id = pa.shape"
        " WHERE ps.shape_index IS NOT NULL"
        " AND NOT ps.shape_index BETWEEN 0 AND COALESCE(LENGTH(h.points), 0) / 12 - 1"
    ):
        raise CompactMismatch(
            f"path {path}, stop_sequence {stop_sequence}: shape_index {index}, but shape"
            f" {shape_id} has {size} points"
        )


def pack_shape(points: Sequence[Point], keep: Iterable[int] = ()) -> tuple[bytes, list[int]]:
    """The shapes.points blob for a shape's (lat, lon, dist) points, and which points it has.

    The ends and the points in `keep` are always among them.
    """
    if any(p[2] is None for p in points):
        # The server ignores a shape's distances unless every point has one.
        points = [(lat, lon, None) for lat, lon, _ in points]
    kept = simplify_shape([(lat, lon) for lat, lon, _ in points], SHAPE_TOLERANCE_M, keep)
    return encode_shape([points[i] for i in kept]), kept


def simplify_shape(
    points: Sequence[tuple[float, float]], tolerance_m: float, keep: Iterable[int] = ()
) -> list[int]:
    """The indices of the (lat, lon) points to keep, by Douglas-Peucker.

    The ends and those in `keep` stay, and enough others that every point is within tolerance_m
    of the line through the kept points as they are stored (rounded to 1e-5 degree), so rounding
    can't push the drawn line further away. Distances are measured on a flat projection around
    each point.
    """
    n = len(points)
    if n < 3:
        return list(range(n))
    m_per_deg = math.radians(1) * EARTH_RADIUS_M
    ys = [lat * m_per_deg for lat, _ in points]
    xs = [lon * m_per_deg for _, lon in points]
    cos_lat = [math.cos(math.radians(lat)) for lat, _ in points]
    stored = [_stored(lat, lon) for lat, lon in points]
    stored_ys = [lat * m_per_deg for lat, _ in stored]
    stored_xs = [lon * m_per_deg for _, lon in stored]
    limit = tolerance_m * tolerance_m
    kept = [False] * n
    for i in (0, n - 1, *keep):
        kept[i] = True
    fixed = [i for i in range(n) if kept[i]]
    spans = list(zip(fixed, fixed[1:], strict=False))
    while spans:
        a, b = spans.pop()
        ax, ay = stored_xs[a], stored_ys[a]
        ex, ey = stored_xs[b] - ax, stored_ys[b] - ay
        far, far_d2 = None, limit
        for i in range(a + 1, b):
            k = cos_lat[i]
            px, py, dx = (xs[i] - ax) * k, ys[i] - ay, ex * k
            length2 = dx * dx + ey * ey
            t = (px * dx + py * ey) / length2 if length2 else 0.0
            t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
            d2 = (px - t * dx) ** 2 + (py - t * ey) ** 2
            if d2 > far_d2:
                far, far_d2 = i, d2
        if far is not None:
            kept[far] = True
            spans += [(a, far), (far, b)]
    return [i for i in range(n) if kept[i]]


def encode_shape(points: Sequence[Point]) -> bytes:
    """Pack (lat, lon, dist) points as compact_schema.sql describes for shapes.points."""
    ints = [round(v * COORD_SCALE) for lat, lon, _ in points for v in (lat, lon)]
    deltas = ints[:2] + [ints[i] - ints[i - 2] for i in range(2, len(ints))]
    dists = [math.nan if d is None else d for _, _, d in points]
    return struct.pack(f"<{len(deltas)}i{len(dists)}f", *deltas, *dists)


def decode_shape(blob: bytes) -> list[Point]:
    """The (lat, lon, dist) points of a shapes.points blob; dist is None where it's NaN."""
    n, rest = divmod(len(blob), 12)
    if rest:
        raise ValueError(f"a shape blob holds 12 bytes per point, not {len(blob)} in all")
    ints = struct.unpack_from(f"<{2 * n}i", blob)
    dists = struct.unpack_from(f"<{n}f", blob, 8 * n)
    points: list[Point] = []
    lat = lon = 0
    for k, dist in enumerate(dists):
        lat += ints[2 * k]
        lon += ints[2 * k + 1]
        points.append((lat / COORD_SCALE, lon / COORD_SCALE, None if math.isnan(dist) else dist))
    return points


def _stored(lat: float, lon: float) -> tuple[float, float]:
    """A point as a shape blob stores it."""
    return round(lat * COORD_SCALE) / COORD_SCALE, round(lon * COORD_SCALE) / COORD_SCALE


def _float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def _numbered(rows: Iterable[tuple], ids: dict) -> Iterator[tuple]:
    """Each row with an integer ID (from 1) in front; ids maps each row's first value to it."""
    for n, row in enumerate(rows, 1):
        ids[row[0]] = n
        yield (n, *row)


def _minus(seconds: int | None, start: int) -> int | None:
    return None if seconds is None else seconds - start


def _read_only(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
