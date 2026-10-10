"""Read-side queries over the GTFS database built by loader.py."""

from __future__ import annotations

import datetime as dt
import sqlite3
from collections import Counter, defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

from ..geo import bbox_deltas, estimate_access_s, haversine_m
from ..models import (
    AgencyCoverage,
    FeedInfo,
    NearbyStop,
    PathMode,
    RouteInfo,
    Stop,
    TransferRule,
    TransitCall,
    TripDetail,
    TripStop,
)
from .loader import SCHEMA_VERSION, WEEKDAYS
from .shapes import stop_indices
from .timeutil import gtfs_to_datetime, seconds_since_origin

ROUTE_COLUMNS = (
    "r.route_id, r.agency_name, r.short_name, r.long_name, r.route_type, r.color, r.text_color"
)
REBUILD = "Run `uv run ir-load-gtfs` in backend/ (add --skip-download to reuse downloaded feeds)."


class GtfsUnavailable(RuntimeError):
    """The GTFS database is missing, or was built by an older version of the app."""


@dataclass(frozen=True)
class TransferContext:
    """The transit leg next to the one being chosen, for looking up transfer rules."""

    stop_id: str
    trip_id: str | None = None


class GtfsStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path

    def problem(self) -> str | None:
        """Why the database can't be used, or None when it's ready."""
        try:
            with self._connect():
                return None
        except GtfsUnavailable as exc:
            return str(exc)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        if not self.db_path.exists():
            raise GtfsUnavailable(f"No GTFS database at {self.db_path}. {REBUILD}")
        conn = sqlite3.connect(f"{self.db_path.resolve().as_uri()}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            try:
                row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
            except sqlite3.OperationalError:
                row = None
            if row is None or row[0] != str(SCHEMA_VERSION):
                raise GtfsUnavailable(
                    f"The transit database was built by an older version of the app. {REBUILD}"
                )
            yield conn
        finally:
            conn.close()

    def feeds(self) -> list[FeedInfo]:
        with self._connect() as conn:
            coverage = agency_coverage(conn)
            return [
                FeedInfo(**dict(row), agencies=coverage.get(row["feed_id"], []))
                for row in conn.execute("SELECT * FROM feeds ORDER BY feed_id")
            ]

    def nearby_stops(
        self, lat: float, lon: float, radius_m: float, access: PathMode = "walk"
    ) -> list[NearbyStop]:
        with self._connect() as conn:
            return _nearby_stops(conn, lat, lon, radius_m, access)

    def departures(
        self,
        lat: float,
        lon: float,
        when: dt.datetime,
        radius_m: float,
        window_s: int,
        limit: int,
        access: PathMode = "walk",
        transfer: TransferContext | None = None,
        per_route: int | None = None,
    ) -> list[TransitCall]:
        """Trips you could reach (on foot or by bike) and board within window_s after `when`.

        With `transfer`, the leg you'd be changing from: each call carries the matching
        transfers.txt rule, if any. With `per_route`, only the first that many trips of each
        route, headsign and stop, so a busy line can't crowd the others out of the limit.
        """
        return self._calls(
            lat, lon, when, radius_m, window_s, limit, access, transfer, per_route, forward=True
        )

    def arrivals(
        self,
        lat: float,
        lon: float,
        when: dt.datetime,
        radius_m: float,
        window_s: int,
        limit: int,
        access: PathMode = "walk",
        transfer: TransferContext | None = None,
        per_route: int | None = None,
    ) -> list[TransitCall]:
        """Trips you could alight from and get to (lat, lon) from within window_s before `when`.

        With `transfer`, the leg you'd be changing to: each call carries the matching rule.
        With `per_route`, only the last that many arrivals of each route, headsign and stop.
        """
        return self._calls(
            lat, lon, when, radius_m, window_s, limit, access, transfer, per_route, forward=False
        )

    def trip(self, trip_id: str, service_date: dt.date) -> TripDetail:
        with self._connect() as conn:
            row = conn.execute(
                f"""
                SELECT t.feed_id, t.service_id, t.headsign, t.bikes_allowed, t.shape_id,
                       t.first_seq, t.last_seq, {ROUTE_COLUMNS}
                FROM trips t JOIN routes r ON r.route_id = t.route_id
                WHERE t.trip_id = ?
                """,
                (trip_id,),
            ).fetchone()
            if row is None:
                raise LookupError(f"Unknown trip {trip_id!r}")
            if row["service_id"] not in _active_service_ids(conn, row["feed_id"], service_date):
                raise LookupError(f"Trip {trip_id!r} does not run on {service_date}")
            tz = _timezones(conn)[row["feed_id"]]
            stop_rows = conn.execute(
                """
                SELECT st.stop_sequence, st.arrival_s, st.departure_s, st.pickup_type,
                       st.drop_off_type, st.shape_dist, s.stop_id, s.feed_id, s.name, s.lat,
                       s.lon, s.parent_station
                FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
                WHERE st.trip_id = ? AND st.arrival_s IS NOT NULL
                ORDER BY st.stop_sequence
                """,
                (trip_id,),
            ).fetchall()
            shape_rows = (
                conn.execute(
                    "SELECT lat, lon, dist FROM shapes WHERE shape_id = ? ORDER BY seq",
                    (row["shape_id"],),
                ).fetchall()
                if row["shape_id"]
                else []
            )

        indices: list[int | None] = [None] * len(stop_rows)
        shape = None
        if len(shape_rows) > 1:
            indices = list(
                stop_indices(
                    [(p["lat"], p["lon"], p["dist"]) for p in shape_rows],
                    [(s["lat"], s["lon"], s["shape_dist"]) for s in stop_rows],
                )
            )
            shape = [(round(p["lon"], 6), round(p["lat"], 6)) for p in shape_rows]

        stops = [
            TripStop(
                stop=Stop(
                    stop_id=s["stop_id"],
                    feed_id=s["feed_id"],
                    name=s["name"],
                    lat=s["lat"],
                    lon=s["lon"],
                    parent_station=s["parent_station"],
                ),
                stop_sequence=s["stop_sequence"],
                arrival=gtfs_to_datetime(service_date, s["arrival_s"], tz),
                departure=gtfs_to_datetime(service_date, s["departure_s"], tz),
                can_board=s["pickup_type"] != 1 and s["stop_sequence"] != row["last_seq"],
                can_alight=s["drop_off_type"] != 1 and s["stop_sequence"] != row["first_seq"],
                shape_index=index,
            )
            for s, index in zip(stop_rows, indices, strict=True)
        ]
        return TripDetail(
            trip_id=trip_id,
            service_date=service_date,
            route=_route_info(row),
            headsign=row["headsign"],
            bikes_allowed=row["bikes_allowed"],
            stops=stops,
            shape=shape,
        )

    def _calls(
        self,
        lat: float,
        lon: float,
        when: dt.datetime,
        radius_m: float,
        window_s: int,
        limit: int,
        access: PathMode,
        transfer: TransferContext | None,
        per_route: int | None,
        *,
        forward: bool,
    ) -> list[TransitCall]:
        with self._connect() as conn:
            stops_by_feed: dict[str, dict[str, NearbyStop]] = defaultdict(dict)
            for stop in _nearby_stops(conn, lat, lon, radius_m, access):
                stops_by_feed[stop.feed_id][stop.stop_id] = stop
            timezones = _timezones(conn)

            if forward:
                time_col = "departure_s"
                # Can't board at the last stop or where pickup is prohibited.
                usable = "st.pickup_type != 1 AND st.stop_sequence < t.last_seq"
            else:
                time_col = "arrival_s"
                usable = "st.drop_off_type != 1 AND st.stop_sequence > t.first_seq"

            # One call per trip: the nearest stop it serves, if several are in range.
            best: dict[tuple[str, dt.date], TransitCall] = {}
            for feed_id, stops in stops_by_feed.items():
                tz = timezones[feed_id]
                local_day = when.astimezone(tz).date()
                # Yesterday's service day covers trips running past midnight.
                for service_date in (local_day - dt.timedelta(days=1), local_day):
                    service_ids = _active_service_ids(conn, feed_id, service_date)
                    if not service_ids:
                        continue
                    now_s = seconds_since_origin(service_date, tz, when)
                    lo, hi = (now_s, now_s + window_s) if forward else (now_s - window_s, now_s)
                    sql = f"""
                        SELECT st.trip_id, st.stop_id, st.stop_sequence, st.arrival_s,
                               st.departure_s, t.headsign, t.bikes_allowed, {ROUTE_COLUMNS}
                        FROM stop_times st
                        JOIN trips t ON t.trip_id = st.trip_id
                        JOIN routes r ON r.route_id = t.route_id
                        WHERE st.stop_id IN ({_qmarks(stops)})
                          AND st.{time_col} BETWEEN ? AND ?
                          AND t.service_id IN ({_qmarks(service_ids)})
                          AND {usable}
                    """
                    for row in conn.execute(sql, [*stops, lo, hi, *service_ids]):
                        stop = stops[row["stop_id"]]
                        # Leave time to get between the queried point and the stop.
                        if forward and row["departure_s"] < now_s + stop.access_s:
                            continue
                        if not forward and row["arrival_s"] > now_s - stop.access_s:
                            continue
                        key = (row["trip_id"], service_date)
                        if key in best and best[key].stop.distance_m <= stop.distance_m:
                            continue
                        best[key] = TransitCall(
                            trip_id=row["trip_id"],
                            service_date=service_date,
                            route=_route_info(row),
                            headsign=row["headsign"],
                            stop=stop,
                            stop_sequence=row["stop_sequence"],
                            arrival=gtfs_to_datetime(service_date, row["arrival_s"], tz),
                            departure=gtfs_to_datetime(service_date, row["departure_s"], tz),
                            bikes_allowed=row["bikes_allowed"],
                        )

            if forward:
                calls = sorted(best.values(), key=lambda c: c.departure)
            else:
                calls = sorted(best.values(), key=lambda c: c.arrival, reverse=True)
            if per_route is not None:
                calls = _first_per_route(calls, per_route)
            calls = calls[:limit]
            if transfer is not None:
                _attach_transfer_rules(conn, calls, transfer, forward=forward)
        return calls


def _nearby_stops(
    conn: sqlite3.Connection, lat: float, lon: float, radius_m: float, access: PathMode
) -> list[NearbyStop]:
    dlat, dlon = bbox_deltas(lat, radius_m)
    stops = []
    for row in conn.execute(
        """
        SELECT stop_id, feed_id, name, lat, lon, parent_station FROM stops
        WHERE location_type = 0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
        """,
        (lat - dlat, lat + dlat, lon - dlon, lon + dlon),
    ):
        distance = haversine_m(lat, lon, row["lat"], row["lon"])
        if distance <= radius_m:
            stops.append(
                NearbyStop(
                    **dict(row), distance_m=distance, access_s=estimate_access_s(distance, access)
                )
            )
    stops.sort(key=lambda s: s.distance_m)
    return stops


def _attach_transfer_rules(
    conn: sqlite3.Connection, calls: list[TransitCall], ctx: TransferContext, *, forward: bool
) -> None:
    """Set each call's transfer rule for changing from ctx (forward) or to ctx (backward)."""
    ctx_route = None
    if ctx.trip_id:
        found = conn.execute("SELECT route_id FROM trips WHERE trip_id = ?", (ctx.trip_id,))
        ctx_route = (found.fetchone() or [None])[0]
    stop_ids = {ctx.stop_id, *(c.stop.stop_id for c in calls)}
    parents = {
        row[0]: row[1]
        for row in conn.execute(
            f"SELECT stop_id, parent_station FROM stops WHERE stop_id IN ({_qmarks(stop_ids)})",
            list(stop_ids),
        )
    }
    other = (ctx.stop_id, ctx_route, ctx.trip_id)
    for call in calls:
        this = (call.stop.stop_id, call.route.route_id, call.trip_id)
        src, dst = (other, this) if forward else (this, other)
        call.transfer = _transfer_rule(conn, parents, src, dst)


def _transfer_rule(
    conn: sqlite3.Connection,
    parents: dict[str, str | None],
    src: tuple[str, str | None, str | None],
    dst: tuple[str, str | None, str | None],
) -> TransferRule | None:
    """The most specific transfers.txt rule for changing from src to dst (stop, route, trip).

    Rules may name a platform or its parent station, and may be limited to particular routes
    or trips; trip beats route beats stop-only, and a platform beats its station.
    """
    (from_stop, from_route, from_trip), (to_stop, to_route, to_trip) = src, dst
    from_ids = [from_stop] + ([parents[from_stop]] if parents.get(from_stop) else [])
    to_ids = [to_stop] + ([parents[to_stop]] if parents.get(to_stop) else [])
    best, best_score = None, -1
    for rule in conn.execute(
        f"""
        SELECT * FROM transfers
        WHERE from_stop IN ({_qmarks(from_ids)}) AND to_stop IN ({_qmarks(to_ids)})
        """,
        [*from_ids, *to_ids],
    ):
        if (
            (rule["from_trip"] and rule["from_trip"] != from_trip)
            or (rule["to_trip"] and rule["to_trip"] != to_trip)
            or (rule["from_route"] and rule["from_route"] != from_route)
            or (rule["to_route"] and rule["to_route"] != to_route)
        ):
            continue
        score = (
            8 * bool(rule["from_trip"])
            + 8 * bool(rule["to_trip"])
            + 4 * bool(rule["from_route"])
            + 4 * bool(rule["to_route"])
            + (rule["from_stop"] == from_stop)
            + (rule["to_stop"] == to_stop)
        )
        if score > best_score:
            best, best_score = rule, score
    if best is None:
        return None
    return TransferRule(type=best["transfer_type"], min_transfer_s=best["min_transfer_s"])


def _first_per_route(calls: list[TransitCall], n: int) -> list[TransitCall]:
    """The first n calls, in the given order, of each route, headsign and stop."""
    seen: Counter[tuple[str, str | None, str]] = Counter()
    kept = []
    for call in calls:
        key = (call.route.route_id, call.headsign, call.stop.stop_id)
        seen[key] += 1
        if seen[key] <= n:
            kept.append(call)
    return kept


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
        coverage[feed_id].append(AgencyCoverage(name=name, start_date=first, end_date=last))
    return coverage


def _active_service_ids(conn: sqlite3.Connection, feed_id: str, day: dt.date) -> set[str]:
    iso = day.isoformat()
    weekday = WEEKDAYS[day.weekday()]
    service_ids = {
        row[0]
        for row in conn.execute(
            f"SELECT service_id FROM calendar WHERE feed_id = ? AND {weekday} = 1 "
            "AND start_date <= ? AND end_date >= ?",
            (feed_id, iso, iso),
        )
    }
    for service_id, exception_type in conn.execute(
        "SELECT service_id, exception_type FROM calendar_dates WHERE feed_id = ? AND date = ?",
        (feed_id, iso),
    ):
        if exception_type == 1:
            service_ids.add(service_id)
        elif exception_type == 2:
            service_ids.discard(service_id)
    return service_ids


def _timezones(conn: sqlite3.Connection) -> dict[str, ZoneInfo]:
    return {row[0]: ZoneInfo(row[1]) for row in conn.execute("SELECT feed_id, timezone FROM feeds")}


def _route_info(row: sqlite3.Row) -> RouteInfo:
    return RouteInfo(
        route_id=row["route_id"],
        agency=row["agency_name"],
        short_name=row["short_name"],
        long_name=row["long_name"],
        route_type=row["route_type"],
        color=row["color"],
        text_color=row["text_color"],
    )


def _qmarks(items) -> str:
    return ", ".join("?" * len(items))
