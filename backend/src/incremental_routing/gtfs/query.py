"""Read-side queries over the GTFS database built by loader.py."""

from __future__ import annotations

import datetime as dt
import sqlite3
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from zoneinfo import ZoneInfo

from ..geo import bbox_deltas, estimate_walk_s, haversine_m
from ..models import FeedInfo, NearbyStop, RouteInfo, Stop, TransitCall, TripDetail, TripStop
from .loader import WEEKDAYS
from .timeutil import gtfs_to_datetime, seconds_since_origin

ROUTE_COLUMNS = "r.route_id, r.short_name, r.long_name, r.route_type, r.color, r.text_color"


class GtfsUnavailable(RuntimeError):
    """The GTFS database has not been built yet."""


class GtfsStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path

    def available(self) -> bool:
        return self.db_path.exists()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        if not self.db_path.exists():
            raise GtfsUnavailable(
                f"No GTFS database at {self.db_path}. Run `uv run ir-load-gtfs` in backend/."
            )
        conn = sqlite3.connect(f"{self.db_path.as_uri()}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def feeds(self) -> list[FeedInfo]:
        with self._connect() as conn:
            return [
                FeedInfo(**dict(row))
                for row in conn.execute("SELECT * FROM feeds ORDER BY feed_id")
            ]

    def nearby_stops(self, lat: float, lon: float, radius_m: float) -> list[NearbyStop]:
        with self._connect() as conn:
            return _nearby_stops(conn, lat, lon, radius_m)

    def departures(
        self, lat: float, lon: float, when: dt.datetime, radius_m: float, window_s: int, limit: int
    ) -> list[TransitCall]:
        """Trips you could walk to and board from (lat, lon) within window_s after `when`."""
        return self._calls(lat, lon, when, radius_m, window_s, limit, forward=True)

    def arrivals(
        self, lat: float, lon: float, when: dt.datetime, radius_m: float, window_s: int, limit: int
    ) -> list[TransitCall]:
        """Trips you could alight from and walk to (lat, lon) within window_s before `when`."""
        return self._calls(lat, lon, when, radius_m, window_s, limit, forward=False)

    def trip(self, trip_id: str, service_date: dt.date) -> TripDetail:
        with self._connect() as conn:
            row = conn.execute(
                f"""
                SELECT t.feed_id, t.service_id, t.headsign, t.bikes_allowed,
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
                )
                for s in conn.execute(
                    """
                    SELECT st.stop_sequence, st.arrival_s, st.departure_s, st.pickup_type,
                           st.drop_off_type, s.stop_id, s.feed_id, s.name, s.lat, s.lon,
                           s.parent_station
                    FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
                    WHERE st.trip_id = ? AND st.arrival_s IS NOT NULL
                    ORDER BY st.stop_sequence
                    """,
                    (trip_id,),
                )
            ]
            return TripDetail(
                trip_id=trip_id,
                service_date=service_date,
                route=_route_info(row),
                headsign=row["headsign"],
                bikes_allowed=row["bikes_allowed"],
                stops=stops,
            )

    def _calls(
        self,
        lat: float,
        lon: float,
        when: dt.datetime,
        radius_m: float,
        window_s: int,
        limit: int,
        *,
        forward: bool,
    ) -> list[TransitCall]:
        with self._connect() as conn:
            stops_by_feed: dict[str, dict[str, NearbyStop]] = defaultdict(dict)
            for stop in _nearby_stops(conn, lat, lon, radius_m):
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
                        # Leave time to walk between the queried point and the stop.
                        if forward and row["departure_s"] < now_s + stop.walk_s:
                            continue
                        if not forward and row["arrival_s"] > now_s - stop.walk_s:
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
        return calls[:limit]


def _nearby_stops(
    conn: sqlite3.Connection, lat: float, lon: float, radius_m: float
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
                NearbyStop(**dict(row), distance_m=distance, walk_s=estimate_walk_s(distance))
            )
    stops.sort(key=lambda s: s.distance_m)
    return stops


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
        short_name=row["short_name"],
        long_name=row["long_name"],
        route_type=row["route_type"],
        color=row["color"],
        text_color=row["text_color"],
    )


def _qmarks(items) -> str:
    return ", ".join("?" * len(items))
