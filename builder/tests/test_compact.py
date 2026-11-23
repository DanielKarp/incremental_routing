"""The compact timetable the static site downloads (compact.py), and its build (build_data.py)."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import logging
import math
import shutil
import sqlite3
import struct

import httpx
import pytest
from conftest import FEED_FILES, write_feed

from incremental_routing.gtfs import build_data, download
from incremental_routing.gtfs.compact import (
    SCHEMA,
    SCHEMA_VERSION,
    SHAPE_TOLERANCE_M,
    CompactMismatch,
    build_compact,
    check_compact,
    decode_shape,
    encode_shape,
    pack_shape,
)
from incremental_routing.gtfs.loader import build_database
from incremental_routing.gtfs.shapes import EARTH_RADIUS_M, stop_indices

SECRET = "not-a-real-key-123"

# A trip's stop times, read from the compact tables as compact_schema.sql shows.
STOP_TIMES = """
    SELECT t.trip_id, ps.stop_sequence, s.stop_id, t.start + pt.arrival, t.start + pt.departure,
           ps.pickup_type, ps.drop_off_type, ps.shape_dist
    FROM trips t JOIN patterns p ON p.id = t.pattern
    JOIN path_stops ps ON ps.path = p.path
    JOIN pattern_times pt ON pt.pattern = p.id AND pt.stop_sequence = ps.stop_sequence
    LEFT JOIN stops s ON s.id = ps.stop
    ORDER BY t.trip_id, ps.stop_sequence
"""


def rows(db, sql: str, params=()) -> list[tuple]:
    with sqlite3.connect(db) as conn:
        return conn.execute(sql, params).fetchall()


def compact_of(tmp_path, files: dict[str, str]):
    """Build the full and the compact database from a feed; returns their paths."""
    full = tmp_path / "gtfs.sqlite"
    build_database(full, [("tr", write_feed(tmp_path / "feed.zip", files))])
    build_compact(full, tmp_path / "timetable.sqlite")
    return full, tmp_path / "timetable.sqlite"


@pytest.fixture(scope="session")
def compact_db(full_db, tmp_path_factory):
    path = tmp_path_factory.mktemp("compact") / "timetable.sqlite"
    build_compact(full_db, path)
    return path


# --- stop times ----------------------------------------------------------------------------


def test_every_stop_time_comes_back_from_its_trips_start_and_pattern(full_db, compact_db):
    full = rows(
        full_db,
        "SELECT trip_id, stop_sequence, stop_id, arrival_s, departure_s, pickup_type,"
        " drop_off_type, shape_dist FROM stop_times ORDER BY trip_id, stop_sequence",
    )
    assert rows(compact_db, STOP_TIMES) == full
    assert len(full) == 15
    # Charlie's interpolated 08:13, and T_LATE's 24:20, both as the loader worked them out.
    assert ("tr:T_MORNING", 3, "tr:CHARLIE", 29580, 29580, 0, 0, None) in full
    assert ("tr:T_LATE", 3, "tr:CHARLIE", 87600, 87600, 0, 0, None) in full
    check_compact(full_db, compact_db)


def test_check_compact_notices_what_doesnt_come_back(full_db, compact_db, tmp_path):
    for sql, what in [
        (
            "UPDATE pattern_times SET departure = departure + 60 WHERE stop_sequence = 2",
            "stop_times",
        ),
        ("UPDATE transfers SET min_transfer_s = 60 WHERE min_transfer_s = 120", "transfers"),
        ("DELETE FROM calendar_dates WHERE exception_type = 2", "calendar_dates"),
        ("UPDATE path_stops SET shape_index = 4 WHERE shape_index = 3", "shape_index 4"),
    ]:
        broken = tmp_path / "broken.sqlite"
        shutil.copy(compact_db, broken)
        with sqlite3.connect(broken) as conn:
            conn.execute(sql)
        with pytest.raises(CompactMismatch, match=what):
            check_compact(full_db, broken)


def test_trips_that_run_alike_share_a_pattern(compact_db):
    trips = {
        trip_id: (pattern, start)
        for trip_id, pattern, start in rows(compact_db, "SELECT trip_id, pattern, start FROM trips")
    }
    # The two buses run the same way, 17 minutes apart; every other trip runs its own way.
    assert trips["tr:T_BUS"][0] == trips["tr:T_BUS2"][0]
    assert (trips["tr:T_BUS"][1], trips["tr:T_BUS2"][1]) == (8 * 3600 + 23 * 60, 8 * 3600 + 40 * 60)
    assert len({pattern for pattern, _ in trips.values()}) == 5
    assert rows(compact_db, "SELECT COUNT(*) FROM paths") == [(5,)]


def test_trips_whose_stops_are_numbered_differently_get_patterns_of_their_own(tmp_path):
    files = dict(FEED_FILES)
    files["stop_times.txt"] = files["stop_times.txt"].replace(
        "T_BUS2,08:40:00,08:40:00,DELTA_2,1,,\nT_BUS2,08:47:00,08:47:00,ECHO,2,,",
        "T_BUS2,08:40:00,08:40:00,DELTA_2,10,,\nT_BUS2,08:47:00,08:47:00,ECHO,20,,",
    )
    full, compact = compact_of(tmp_path, files)
    [(bus,), (bus2,)] = rows(
        compact, "SELECT pattern FROM trips WHERE trip_id LIKE 'tr:T_BUS%' ORDER BY trip_id"
    )
    assert bus != bus2
    assert [r[1] for r in rows(compact, STOP_TIMES) if r[0] == "tr:T_BUS2"] == [10, 20]
    assert rows(
        compact,
        "SELECT pa.first_seq, pa.last_seq FROM trips t JOIN patterns p ON p.id = t.pattern"
        " JOIN paths pa ON pa.id = p.path WHERE t.trip_id = 'tr:T_BUS2'",
    ) == [(10, 20)]
    check_compact(full, compact)


def test_a_sloppy_feed_comes_back_as_the_server_sees_it(tmp_path, caplog):
    files = dict(FEED_FILES)
    files["trips.txt"] += (
        "L1,WKDY,T_EMPTY,Delta,0,,SH1\n"  # no stop times
        "L1,WKDY,T_GHOST,Bravo,0,,MISSING\n"  # a shape shapes.txt lacks
        "X9,WKDY,T_NOROUTE,Echo,0,,\n"  # a route routes.txt lacks
    )
    files["stop_times.txt"] += (
        "T_GHOST,,,ALPHA,1,,\n"  # no time before it to interpolate from
        "T_GHOST,07:10:00,07:10:00,NOWHERE,2,,\n"  # a stop stops.txt lacks
        "T_GHOST,07:20:00,07:20:00,BRAVO,3,,\n"
        "T_NOROUTE,09:00:00,09:00:00,DELTA_2,1,,\n"
        "T_NOROUTE,09:07:00,09:07:00,ECHO,2,,\n"
        "T_ORPHAN,09:00:00,09:00:00,ALPHA,1,,\n"  # a trip trips.txt lacks
    )
    with caplog.at_level(logging.WARNING):
        full, compact = compact_of(tmp_path, files)
    check_compact(full, compact)
    assert [r[1:] for r in rows(compact, STOP_TIMES) if r[0] == "tr:T_GHOST"] == [
        (1, "tr:ALPHA", None, None, 0, 0, None),
        (2, None, 25800, 25800, 0, 0, None),
        (3, "tr:BRAVO", 26400, 26400, 0, 0, None),
    ]
    assert rows(
        compact,
        "SELECT pa.first_seq, pa.last_seq, h.shape_id, t.start FROM trips t"
        " JOIN patterns p ON p.id = t.pattern JOIN paths pa ON pa.id = p.path"
        " JOIN shapes h ON h.id = pa.shape WHERE t.trip_id = 'tr:T_EMPTY'",
    ) == [(None, None, "tr:SH1", 0)]
    assert rows(compact, "SELECT points FROM shapes WHERE shape_id = 'tr:MISSING'") == [(b"",)]
    assert rows(compact, "SELECT route FROM trips WHERE trip_id = 'tr:T_NOROUTE'") == [(None,)]
    assert rows(compact, "SELECT COUNT(*) FROM trips WHERE trip_id = 'tr:T_ORPHAN'") == [(0,)]
    for warning in [
        "Left out 1 stop times of trips trips.txt lacks",
        "1 stop times name stops stops.txt lacks",
        "1 trips name routes routes.txt lacks",
        "1 shapes that trips name aren't in shapes.txt",
    ]:
        assert warning in caplog.text


# --- shapes --------------------------------------------------------------------------------


def wiggle(n: int, dists: bool = True) -> list[tuple[float, float, float | None]]:
    """A line north from Alpha, every ~11 m, swinging ~350 m east and west of it."""
    points: list[tuple[float, float, float | None]] = []
    along = 0.0
    for k in range(n):
        lat, lon = 37.4 + 0.0001 * k, -122.1 + 0.004 * math.sin(k / 40)
        if points:
            along += metres(points[-1][:2], (lat, lon))
        points.append((lat, lon, round(along, 2) if dists else None))
    return points


def metres(a, b) -> float:
    dy = math.radians(b[0] - a[0])
    dx = math.radians(b[1] - a[1]) * math.cos(math.radians(a[0]))
    return EARTH_RADIUS_M * math.hypot(dx, dy)


def to_line(p, line) -> float:
    """Metres from point p to the nearest segment of line, on a flat projection around p."""
    k, m = math.cos(math.radians(p[0])), math.radians(1) * EARTH_RADIUS_M
    xy = [((q[1] - p[1]) * k * m, (q[0] - p[0]) * m) for q in line]
    best = math.inf
    for (ax, ay), (bx, by) in zip(xy, xy[1:], strict=False):
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def server_placement(full, trip_id: str) -> tuple[list[tuple], list[int | None]]:
    """A trip's full shape, and where on it each stop with a time falls, as the server placed
    them (its _shape_with_stops, until commit 1c15be0: stop_indices on the full shape)."""
    with sqlite3.connect(full) as conn:
        [(shape_id,)] = conn.execute("SELECT shape_id FROM trips WHERE trip_id = ?", (trip_id,))
        shape = conn.execute(
            "SELECT lat, lon, dist FROM shapes WHERE shape_id = ? ORDER BY seq", (shape_id,)
        ).fetchall()
        stops = conn.execute(
            "SELECT s.lat, s.lon, st.shape_dist FROM stop_times st"
            " JOIN stops s ON s.stop_id = st.stop_id"
            " WHERE st.trip_id = ? AND st.arrival_s IS NOT NULL ORDER BY st.stop_sequence",
            (trip_id,),
        ).fetchall()
    return shape, stop_indices(shape, stops)


def test_shapes_stay_within_5_m_and_keep_their_distances():
    points = wiggle(600)
    blob, kept = pack_shape(points)
    decoded = decode_shape(blob)
    assert len(decoded) == len(kept) < len(points) / 3
    assert all(to_line(p, decoded) <= SHAPE_TOLERANCE_M for p in points)
    assert kept[0] == 0 and kept[-1] == len(points) - 1
    for (lat, lon, dist), i in zip(decoded, kept, strict=True):
        assert abs(lat - points[i][0]) <= 0.5e-5 and abs(lon - points[i][1]) <= 0.5e-5
        assert dist == float32(points[i][2])


def test_shapes_keep_the_points_asked_for_and_distances_only_when_all_have_them():
    points = wiggle(300, dists=False)
    _, kept = pack_shape(points, keep={123, 200})
    assert {123, 200} <= set(kept)
    assert {d for *_, d in decode_shape(pack_shape(points)[0])} == {None}
    # One point without a distance, and the server ignores the shape's distances: so do we.
    some = wiggle(300)
    some[150] = (*some[150][:2], None)
    assert {d for *_, d in decode_shape(pack_shape(some)[0])} == {None}


def test_shape_blob_layout():
    # Little-endian int32 (lat, lon) in 1e-5 degree, the first absolute and then changes, and
    # then a float32 distance per point, NaN for none.
    points = [(37.4, -122.1, 0.0), (37.40001, -122.10002, 12.5), (37.39999, -122.1, None)]
    blob = encode_shape(points)
    assert blob == struct.pack("<6i3f", 3740000, -12210000, 1, -2, -2, 2, 0.0, 12.5, math.nan)
    assert decode_shape(blob) == points
    assert decode_shape(b"") == []
    with pytest.raises(ValueError):
        decode_shape(blob[:-1])


def test_shape_index_is_where_the_server_places_each_stop(tmp_path):
    curve = wiggle(400)
    files = dict(FEED_FILES)
    files["shapes.txt"] += "".join(
        f"SH2,{lat:.6f},{lon:.6f},{k + 1},{dist}\n" for k, (lat, lon, dist) in enumerate(curve)
    )
    files["stops.txt"] += "".join(
        f"W{k},Wiggle {k},{curve[k][0]:.6f},{curve[k][1] + 0.0002:.6f},0,\n"  # ~18 m east
        for k in (0, 101, 233, 399)
    )
    files["trips.txt"] += "L1,WKDY,T_WIGGLE,W399,0,,SH2\nL1,WKDY,T_WIGGLE_D,W399,0,,SH2\n"
    files["stop_times.txt"] += "".join(
        f"T_WIGGLE,08:{n:02}:00,08:{n:02}:00,W{k},{n + 1},,\n"  # placed by geometry
        f"T_WIGGLE_D,09:{n:02}:00,09:{n:02}:00,W{k},{n + 1},,,{curve[k][2]}\n"  # by distance
        for n, k in enumerate((0, 101, 233, 399))
    )
    full, compact = compact_of(tmp_path, files)
    check_compact(full, compact)
    for trip_id in ["tr:T_WIGGLE", "tr:T_WIGGLE_D", "tr:T_MORNING"]:
        full_shape, placed = server_placement(full, trip_id)
        found = rows(
            compact,
            "SELECT h.points, ps.shape_index FROM trips t JOIN patterns p ON p.id = t.pattern"
            " JOIN paths pa ON pa.id = p.path JOIN shapes h ON h.id = pa.shape"
            " JOIN path_stops ps ON ps.path = pa.id WHERE t.trip_id = ? ORDER BY ps.stop_sequence",
            (trip_id,),
        )
        shape = decode_shape(found[0][0])
        assert len(shape) < len(full_shape)
        for i, (_, index) in zip(placed, found, strict=True):
            # The same point, rounded to 1e-5 degree in the timetable.
            lat, lon, _ = full_shape[i]
            assert abs(shape[index][0] - lat) <= 0.5e-5 and abs(shape[index][1] - lon) <= 0.5e-5
    # T_MORNING's shape is a straight line, so only its ends and the points its stops are
    # placed at are left. Bravo, in the middle, keeps its own point instead of Alpha's.
    assert server_placement(full, "tr:T_MORNING")[1] == [0, 4, 8, 12]
    assert rows(
        compact,
        "SELECT ps.shape_index FROM path_stops ps JOIN paths pa ON pa.id = ps.path"
        " JOIN shapes h ON h.id = pa.shape WHERE h.shape_id = 'tr:SH1' ORDER BY ps.stop_sequence",
    ) == [(0,), (1,), (2,), (3,)]


def test_the_schema_file_makes_an_empty_timetable():
    # As stage 2's fixtures will: the same file, then rows of their own.
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    assert conn.execute("PRAGMA user_version").fetchone() == (SCHEMA_VERSION,)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")}
    assert tables == {
        "meta",
        "feeds",
        "routes",
        "stops",
        "services",
        "calendar",
        "calendar_dates",
        "transfers",
        "shapes",
        "paths",
        "path_stops",
        "patterns",
        "pattern_times",
        "trips",
    }


# --- ir-build-data -------------------------------------------------------------------------


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("IR_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("API_511_KEY", raising=False)
    (tmp_path / "feeds").mkdir()
    return tmp_path


def test_build_data_writes_the_timetable_and_its_manifest(data_dir, feed_zip, monkeypatch):
    monkeypatch.setenv("DEFAULT_TIMEZONE", "America/Denver")
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    out = data_dir / "site"
    build_data.main(["--skip-download", "--out", str(out)])

    manifest = json.loads((out / "manifest.json").read_text())
    timetable = manifest["timetable"]
    packed = (out / timetable["file"]).read_bytes()
    raw = gzip.decompress(packed)
    digest = hashlib.sha256(packed).hexdigest()
    assert sorted(p.name for p in out.iterdir()) == ["manifest.json", timetable["file"]]
    assert timetable == {
        "file": f"timetable-{digest[:12]}.sqlite.gz",
        "gzip_bytes": len(packed),
        "gzip_sha256": digest,
        "sqlite_bytes": len(raw),
        "sqlite_sha256": hashlib.sha256(raw).hexdigest(),
    }
    assert manifest["schema_version"] == SCHEMA_VERSION
    assert manifest["default_timezone"] == "America/Denver"
    assert manifest["timezones"] == ["America/Los_Angeles"]

    # The full database was built in the working folder, beside the feed.
    work = data_dir / "build"
    assert sorted(p.name for p in data_dir.iterdir()) == ["build", "feeds", "site"]
    assert (work / "timetable.sqlite").read_bytes() == raw
    check_compact(work / "gtfs.sqlite", work / "timetable.sqlite")
    assert rows(work / "timetable.sqlite", "PRAGMA user_version") == [(SCHEMA_VERSION,)]
    [(built_at,)] = rows(work / "timetable.sqlite", "SELECT value FROM meta WHERE key = 'built_at'")
    assert built_at == manifest["built_at"]
    assert dt.datetime.fromisoformat(built_at).tzinfo is not None

    # Feeds and each agency's dates, as the server listed them (see test_gtfs.py).
    [feed] = manifest["feeds"]
    assert (feed["feed_id"], feed["start_date"], feed["end_date"]) == (
        "bayarea",
        "2026-01-01",
        "2026-12-31",
    )
    assert [a["name"] for a in feed["agencies"]] == ["Test Bus", "Test Rail"]


def test_build_data_removes_the_timetables_of_earlier_builds(full_db, tmp_path):
    out = tmp_path / "site"
    out.mkdir()
    for name in ["timetable-0123456789ab.sqlite.gz", "timetable-old.sqlite.gz", "notes.txt"]:
        (out / name).write_text("left over")
    monday = dt.datetime(2026, 10, 12, 4, tzinfo=dt.UTC)
    first = build_data.publish(full_db, out, tmp_path / "work", default_timezone="UTC", now=monday)
    assert sorted(p.name for p in out.iterdir()) == sorted(
        ["manifest.json", "notes.txt", first["timetable"]["file"]]
    )
    # The same data packs to the same file; new data replaces it.
    again = build_data.publish(full_db, out, tmp_path / "work", default_timezone="UTC", now=monday)
    assert again["timetable"] == first["timetable"]
    later = build_data.publish(
        full_db,
        out,
        tmp_path / "work",
        default_timezone="UTC",
        now=monday + dt.timedelta(days=7),
    )
    assert later["timetable"]["file"] != first["timetable"]["file"]
    assert sorted(p.name for p in out.iterdir()) == sorted(
        ["manifest.json", "notes.txt", later["timetable"]["file"]]
    )


def serve(monkeypatch, handler) -> list[httpx.Request]:
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(record))
    monkeypatch.setattr(download.httpx, "stream", client.stream)
    return requests


def test_the_key_stays_out_of_the_manifest_the_data_and_the_logs(
    data_dir, feed_zip, monkeypatch, capsys, caplog
):
    monkeypatch.setenv("API_511_KEY", SECRET)
    requests = serve(monkeypatch, lambda _: httpx.Response(200, content=feed_zip.read_bytes()))
    # httpx logs request URLs at INFO; the build must quieten it, whatever ran before.
    logging.getLogger("httpx").setLevel(logging.NOTSET)
    caplog.set_level(logging.DEBUG)
    out = data_dir / "site"
    build_data.main(["--out", str(out)])

    assert requests[0].url.params["api_key"] == SECRET  # it was used...
    printed = capsys.readouterr()
    assert SECRET not in printed.out + printed.err + caplog.text  # ...and never shown
    built = [p for p in [*out.iterdir(), *(data_dir / "build").iterdir()] if p.is_file()]
    assert len(built) == 4
    for path in built:
        data = path.read_bytes()
        assert SECRET.encode() not in (gzip.decompress(data) if path.suffix == ".gz" else data)


def test_build_data_reports_a_failed_download_without_the_key(data_dir, monkeypatch, capsys):
    monkeypatch.setenv("API_511_KEY", SECRET)

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url}", request=request)

    serve(monkeypatch, unreachable)
    with pytest.raises(SystemExit):
        build_data.main(["--out", str(data_dir / "site")])
    printed = capsys.readouterr()
    assert "Download failed: 511 SF Bay regional feed: ConnectError" in printed.err
    assert SECRET not in printed.out + printed.err
    assert not (data_dir / "site").exists()


def test_build_data_from_a_full_database_built_before(full_db, tmp_path):
    out, work = tmp_path / "site", tmp_path / "work"
    build_data.main(["--from-db", str(full_db), "--out", str(out), "--work", str(work)])
    assert (out / "manifest.json").exists()
    assert sorted(p.name for p in work.iterdir()) == ["timetable.sqlite"]


def test_build_data_writes_nothing_unless_the_timetable_checks_out(
    full_db, tmp_path, monkeypatch, capsys
):
    def mismatch(full_db, compact_db):
        raise CompactMismatch("stop_times, row 3: ...")

    monkeypatch.setattr(build_data, "check_compact", mismatch)
    out, work = str(tmp_path / "site"), str(tmp_path / "work")
    with pytest.raises(SystemExit):
        build_data.main(["--from-db", str(full_db), "--out", out, "--work", work])
    assert "doesn't match the full database: stop_times, row 3" in capsys.readouterr().err
    assert not (tmp_path / "site").exists()

    with pytest.raises(SystemExit):
        build_data.main(["--from-db", str(tmp_path / "none.sqlite"), "--out", out, "--work", work])
    assert "No GTFS database" in capsys.readouterr().err
