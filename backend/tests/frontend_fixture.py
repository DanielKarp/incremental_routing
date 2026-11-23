"""Build the timetable fixture the frontend's tests read (frontend/src/timetable/fixtures/).

uv run python tests/frontend_fixture.py     # in backend/

It is conftest.py's synthetic feed plus EXTRA_FILES below, built into the full database by the
loader and published as ir-build-data publishes the real one: a timetable-<hash>.sqlite.gz and a
manifest.json. expected.json holds what the server answers for REQUESTS on the same data, which
the TypeScript port of the queries must answer too. Everything is dated, so the output only
changes when the feed, the requests or the code does.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import sqlite3
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

from conftest import ALPHA, BRAVO, DELTA, FEED_FILES, SOUTH_OF_ALPHA, write_feed
from fastapi.testclient import TestClient

from incremental_routing.api import create_app
from incremental_routing.config import REPO_DIR, Settings
from incremental_routing.gtfs.build_data import publish
from incremental_routing.gtfs.loader import build_database
from incremental_routing.routing import StraightLineProvider

OUT_DIR = REPO_DIR / "frontend" / "src" / "timetable" / "fixtures"
BUILT_AT = dt.datetime(2026, 11, 23, tzinfo=dt.UTC)

# A second line, 13 km from the first so as not to change what's found there, for the cases
# where order decides: Kilo's two platforms share a spot (B is listed first, A sorts first),
# trips leave them at the same minute, a trip calls at both, and Nov's two stops are 44 m apart.
#
# - T_R3A, T_R3D 09:00 Kilo A -> Lima -> Mike 09:10, on wiggly shape SH2 (no distances)
# - T_R3B        09:00 Kilo B -> Lima -> Mike 09:10, without a shape
# - T_R4A        09:00 Kilo A and Kilo B -> Lima; T_R4B 09:00 Kilo B -> Lima (no headsign)
# - T_R3C        09:30 Kilo A (no pickup) -> Lima (no drop-off) -> Mike
# - T_GHOST      Kilo A without a time, a stop stops.txt lacks, then Lima 07:20 -> Mike
# - T_NOROUTE    a route routes.txt lacks: never offered, but drawn
# - T_X, T_Y     10:00 from Nov 1, and T_X from Nov 2 too: the nearer stop takes over
# - T_R3LATE     weekdays to Lima at 24:10; T_R3EARLY from Lima at 00:10 the next day
# - T_SATLATE    Saturdays, Lima 25:30 -> Mike 25:40; T_SUNEARLY Sundays, Lima 01:10 -> 01:20:
#                on 2026-11-01 01:30 PDT, 01:40 PDT, then 01:10 PST, 01:20 PST
# - T_EXTRA      service EXTRA, whose calendar_dates rows conflict (the last one wins)
#
# transfers.txt: two rules as specific as each other, Kilo B -> the station and the station ->
# Kilo A, where the server's order (by from_stop) and the feed's differ; and two for Kilo A ->
# Kilo B, where the feed's order decides.
EXTRA_FILES = {
    "stops.txt": """\
KILO_STN,Kilo Station,37.500000,-122.200000,1,
KILO_B,Kilo Platform B,37.500000,-122.200000,0,KILO_STN
KILO_A,Kilo Platform A,37.500000,-122.200000,0,KILO_STN
LIMA,Lima,37.510000,-122.200000,0,
MIKE,Mike,37.520000,-122.200000,0,
NOV_1,November 1,37.530000,-122.200500,0,
NOV_2,November 2,37.530000,-122.200000,0,
""",
    "routes.txt": """\
R3,TR,R3,Route Three,3,,
R4,TR,R4,Route Four,3,0000FF,FFFFFF
""",
    "trips.txt": """\
R3,WKDY,T_R3A,Mike,0,,SH2
R3,WKDY,T_R3D,Mike,0,,SH2
R3,WKDY,T_R3B,Mike,0,2,
R4,WKDY,T_R4A,,1,1,
R4,WKDY,T_R4B,,1,1,
R3,WKDY,T_R3C,Mike,0,,SH2
R4,WKDY,T_GHOST,Mike,1,,
X9,WKDY,T_NOROUTE,Mike,0,,
R4,WKDY,T_X,Mike,0,,
R3,WKDY,T_Y,Mike,0,,
R3,WKDY,T_R3LATE,Mike,0,,
R3,WKDY,T_R3EARLY,Mike,0,,
R3,SAT,T_SATLATE,Mike,0,,
R3,SUN,T_SUNEARLY,Mike,0,,
R3,EXTRA,T_EXTRA,Mike,0,,
""",
    "stop_times.txt": """\
T_R3A,09:00:00,09:00:00,KILO_A,1,,
T_R3A,09:05:00,09:05:00,LIMA,2,,
T_R3A,09:10:00,09:10:00,MIKE,3,,
T_R3D,09:00:00,09:00:00,KILO_A,1,,
T_R3D,09:05:00,09:05:00,LIMA,2,,
T_R3D,09:10:00,09:10:00,MIKE,3,,
T_R3B,09:00:00,09:00:00,KILO_B,1,,
T_R3B,09:05:00,09:05:00,LIMA,2,,
T_R3B,09:10:00,09:10:00,MIKE,3,,
T_R4A,09:00:00,09:00:00,KILO_A,1,,
T_R4A,09:00:00,09:00:00,KILO_B,2,,
T_R4A,09:06:00,09:06:00,LIMA,3,,
T_R4B,09:00:00,09:00:00,KILO_B,1,,
T_R4B,09:06:00,09:06:00,LIMA,2,,
T_R3C,09:30:00,09:30:00,KILO_A,1,1,0
T_R3C,09:35:00,09:35:00,LIMA,2,0,1
T_R3C,09:40:00,09:40:00,MIKE,3,0,0
T_GHOST,,,KILO_A,1,,
T_GHOST,07:10:00,07:10:00,NOWHERE,2,,
T_GHOST,07:20:00,07:20:00,LIMA,3,,
T_GHOST,07:30:00,07:30:00,MIKE,4,,
T_NOROUTE,09:00:00,09:00:00,LIMA,1,,
T_NOROUTE,09:07:00,09:07:00,MIKE,2,,
T_X,10:00:00,10:00:00,NOV_1,1,,
T_X,10:00:00,10:00:00,NOV_2,2,,
T_X,10:05:00,10:05:00,MIKE,3,,
T_Y,10:00:00,10:00:00,NOV_1,1,,
T_Y,10:06:00,10:06:00,MIKE,2,,
T_R3LATE,23:55:00,23:55:00,KILO_A,1,,
T_R3LATE,24:10:00,24:10:00,LIMA,2,,
T_R3LATE,24:20:00,24:20:00,MIKE,3,,
T_R3EARLY,00:10:00,00:10:00,LIMA,1,,
T_R3EARLY,00:20:00,00:20:00,MIKE,2,,
T_SATLATE,25:30:00,25:30:00,LIMA,1,,
T_SATLATE,25:40:00,25:40:00,MIKE,2,,
T_SUNEARLY,01:10:00,01:10:00,LIMA,1,,
T_SUNEARLY,01:20:00,01:20:00,MIKE,2,,
T_EXTRA,12:00:00,12:00:00,LIMA,1,,
T_EXTRA,12:10:00,12:10:00,MIKE,2,,
""",
    # North from Kilo to Mike, a point every ~11 m, swinging ~180 m east and west.
    "shapes.txt": "".join(
        f"SH2,{37.5 + 0.0001 * k:.6f},{-122.2 + 0.002 * math.sin(k / 30):.6f},{k + 1},\n"
        for k in range(201)
    ),
    "transfers.txt": """\
KILO_STN,KILO_A,2,90,,,,
KILO_B,KILO_STN,2,60,,,,
KILO_A,KILO_B,0,,,,,
KILO_A,KILO_B,1,,,,,
""",
    "calendar.txt": "EXTRA,1,1,1,1,1,0,0,20260101,20261231\n",
    "calendar_dates.txt": """\
EXTRA,20261201,2
EXTRA,20261201,1
EXTRA,20261202,1
EXTRA,20261202,2
EXTRA,20261205,1
""",
}

KILO = (37.50, -122.20)
LIMA = (37.51, -122.20)
MIKE = (37.52, -122.20)
NOV_2 = (37.53, -122.20)
ECHO = (37.43, -122.09)
NOWHERE = (37.0, -121.0)


def calls(lat_lon: tuple[float, float], time: str, **params) -> dict:
    return {"lat": lat_lon[0], "lon": lat_lon[1], "time": time, **params}


# (method, path, query or body). Departures and arrivals get api.ts's defaults spelled out,
# as it sends them; the TypeScript test turns each into the call api.ts would make.
REQUESTS: list[tuple[str, str, dict]] = [
    ("GET", "/api/feeds", {}),
    ("GET", "/api/stops/nearby", {"lat": DELTA[0], "lon": DELTA[1], "radius_m": 200}),
    ("GET", "/api/stops/nearby", {"lat": KILO[0], "lon": KILO[1], "radius_m": 50}),
    (
        "GET",
        "/api/stops/nearby",
        {"lat": SOUTH_OF_ALPHA[0], "lon": SOUTH_OF_ALPHA[1], "radius_m": 1000, "access": "bike"},
    ),
    ("GET", "/api/stops/nearby", {"lat": NOWHERE[0], "lon": NOWHERE[1]}),
    ("GET", "/api/stops/nearby", {"lat": KILO[0], "lon": KILO[1], "radius_m": 0}),
    ("GET", "/api/stops/nearby", {"lat": 91, "lon": KILO[1], "access": "car"}),
    *(
        ("GET", "/api/departures", params)
        for params in [
            calls(ALPHA, "2026-10-12T07:50"),
            calls(ALPHA, "2026-10-12T07:50:00-07:00", limit=10),
            calls(ALPHA, "2026-10-12T14:50Z"),
            calls(ALPHA, "2026-10-12T07:59:59.999999-07:00"),
            calls(ALPHA, "2026-10-12 07:50"),
            calls(ALPHA, "2026-10-12", window_min=360),
            calls(ALPHA, str(int(dt.datetime(2026, 10, 12, 14, 50, tzinfo=dt.UTC).timestamp()))),
            calls((ALPHA[0] + 0.002, ALPHA[1]), "2026-10-12T07:55"),
            calls((ALPHA[0] + 0.002, ALPHA[1]), "2026-10-12T07:57"),
            calls(BRAVO, "2026-10-13T00:05"),
            calls(ALPHA, "2026-11-26T07:50", window_min=120),
            calls(DELTA, "2026-10-12T08:15"),
            calls(DELTA, "2026-10-12T08:15", per_route=1),
            calls(
                DELTA, "2026-10-12T08:20", transfer_stop="tr:DELTA_1", transfer_trip="tr:T_MORNING"
            ),
            calls(DELTA, "2026-10-12T08:20", transfer_stop="tr:DELTA_1"),
            calls(DELTA, "2026-10-12T08:20", transfer_stop="tr:DELTA_2", transfer_trip="tr:T_BUS"),
            calls(SOUTH_OF_ALPHA, "2026-10-12T07:50", radius_m=1000),
            calls(SOUTH_OF_ALPHA, "2026-10-12T07:50", radius_m=1000, access="bike"),
            calls(ALPHA, "2026-11-01T07:30"),
            calls(ALPHA, "2026-03-08T07:30"),
            calls(KILO, "2026-10-12T08:55", radius_m=100),
            calls(KILO, "2026-10-12T08:55", radius_m=100, limit=2),
            calls(KILO, "2026-10-12T08:55", radius_m=100, limit=1),
            calls(KILO, "2026-10-12T08:55", radius_m=100, per_route=1),
            calls(KILO, "2026-10-12T08:55", radius_m=3000, per_route=2, limit=3),
            calls(KILO, "2026-10-12T08:55", radius_m=100, transfer_stop="tr:KILO_B"),
            calls(KILO, "2026-10-12T08:55", radius_m=100, transfer_stop="tr:KILO_A"),
            calls(KILO, "2026-10-12T08:55", transfer_stop="tr:KILO_A", transfer_trip="tr:NOPE"),
            calls(KILO, "2026-10-12T09:25"),
            calls(LIMA, "2026-10-13T00:05"),
            calls(LIMA, "2026-10-13T00:05", per_route=1),
            calls(NOV_2, "2026-10-12T09:55", radius_m=100),
            calls(LIMA, "2026-11-01T01:00:00-07:00", window_min=120),
            calls(LIMA, "2026-11-01T01:00", window_min=120),
            calls(LIMA, "2026-11-01T01:05:00-08:00", window_min=120),
            calls(LIMA, "2026-03-08T00:00", window_min=180),
            calls(LIMA, "2026-03-08T02:30", window_min=180),
            calls(LIMA, "2026-12-01T11:50"),
            calls(LIMA, "2026-12-02T11:50"),
            calls(LIMA, "2026-12-05T11:50"),
            calls(LIMA, "2027-06-01T09:00"),
            calls(NOWHERE, "2026-10-12T09:00", radius_m=3000),
            calls(KILO, "2026-10-12T08:55", radius_m=0, window_min=0, limit=501),
            calls(KILO, "2026-10-12T08:55", radius_m=3001, window_min=361, per_route=21),
            calls(KILO, "2026-10-12T08:55", window_min=1.5, per_route=-1, access="car"),
            calls((91, -181), "nope"),
            calls(KILO, "2026-02-30T08:00"),
            calls(KILO, "2026-10-12T24:00"),
        ]
    ),
    *(
        ("GET", "/api/arrivals", params)
        for params in [
            calls(DELTA, "2026-10-12T08:30"),
            calls(ALPHA, "2026-10-12T08:30"),
            calls(ECHO, "2026-10-12T09:00"),
            calls(ECHO, "2026-10-12T09:00", per_route=1),
            calls(DELTA, "2026-10-12T08:23", transfer_stop="tr:DELTA_2", transfer_trip="tr:T_BUS"),
            calls(BRAVO, "2026-10-13T00:15"),
            calls(MIKE, "2026-10-12T09:15"),
            calls(MIKE, "2026-10-12T09:15", limit=2),
            calls(MIKE, "2026-10-12T09:15", per_route=1),
            calls(LIMA, "2026-10-12T09:40"),
            calls(LIMA, "2026-10-12T07:25"),
            calls(MIKE, "2026-11-01T02:00:00-08:00", window_min=120),
            calls(MIKE, "2026-03-08T02:00", window_min=180),
            calls(MIKE, "2026-10-13T00:30", transfer_stop="tr:MIKE"),
            calls(KILO, "2026-10-12T09:15", radius_m=3000, access="bike", limit=4),
            calls(KILO, "2026-10-12T09:15", window_min=0),
        ]
    ),
    *(
        ("GET", "/api/trip", {"trip_id": trip_id, "service_date": date})
        for trip_id, date in [
            ("tr:T_MORNING", "2026-10-12"),
            ("tr:T_MORNING", "2026-10-10"),
            ("tr:NOPE", "2026-10-12"),
            ("tr:T_BUS", "2026-10-12"),
            ("tr:T_LATE", "2026-10-12"),
            ("tr:T_SUNDAY", "2026-11-01"),
            ("tr:T_SUNDAY", "2026-03-08"),
            ("tr:T_SATURDAY", "2026-11-26"),
            ("tr:T_R3A", "2026-10-12"),
            ("tr:T_R3C", "2026-10-12"),
            ("tr:T_GHOST", "2026-10-12"),
            ("tr:T_SATLATE", "2026-10-31"),
            ("tr:T_NOROUTE", "2026-10-12"),
            ("tr:T_EXTRA", "2026-12-01"),
            ("tr:T_EXTRA", "2026-12-02"),
            ("tr:T_EXTRA", "2026-12-05"),
            ("tr:T_MORNING", "2026-10-12T00:00"),
            ("tr:T_MORNING", "2026-1-2"),
            ("it's", "2026-10-12"),
        ]
    ),
    *(
        ("POST", "/api/lines", {"direction": direction, "trips": trips})
        for direction, trips in [
            ("forward", [("tr:T_MORNING", 2), ("tr:T_BUS", 1)]),
            ("backward", [("tr:T_MORNING", 2)]),
            ("forward", [("tr:NOPE", 1), ("tr:T_MORNING", 99)]),
            ("forward", [("tr:T_R3A", 1), ("tr:T_R3A", 2), ("tr:T_R3B", 1)]),
            ("backward", [("tr:T_R3A", 3), ("tr:T_R3A", 2), ("tr:T_R3A", 1)]),
            ("forward", [("tr:T_NOROUTE", 1), ("tr:T_GHOST", 3), ("tr:T_GHOST", 1)]),
            ("backward", [("tr:T_MORNING", 4), ("tr:T_MORNING", 1)]),
            ("forward", []),
            ("up", [("tr:T_MORNING", 1)]),
            ("forward", [("tr:T_MORNING", 1)] * 501),
        ]
        for trips in [[{"trip_id": t, "stop_sequence": s} for t, s in trips]]
    ),
]


def extended_feed() -> dict[str, str]:
    files = dict(FEED_FILES)
    for name, rows in EXTRA_FILES.items():
        files[name] += rows
    return files


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        full_db = work / "gtfs.sqlite"
        build_database(full_db, [("tr", write_feed(work / "feed.zip", extended_feed()))])
        with sqlite3.connect(full_db) as conn:
            conn.execute("UPDATE feeds SET loaded_at = ?", (BUILT_AT.isoformat(),))
        publish(full_db, OUT_DIR, work, default_timezone="America/Los_Angeles", now=BUILT_AT)

        settings = Settings(data_dir=work, default_timezone=ZoneInfo("America/Los_Angeles"))
        expected = []
        with TestClient(create_app(settings, StraightLineProvider())) as client:
            for method, path, params in REQUESTS:
                if method == "GET":
                    resp = client.get(path, params=params)
                else:
                    resp = client.post(path, json=params)
                body = resp.json()
                if resp.status_code == 422:
                    # Where and what, as errorDetail() in api.ts reads them; not the input again.
                    body["detail"] = [{"loc": e["loc"], "msg": e["msg"]} for e in body["detail"]]
                expected.append(
                    {
                        "method": method,
                        "path": path,
                        "params": params,
                        "status": resp.status_code,
                        "body": body,
                    }
                )
    (OUT_DIR / "expected.json").write_text(json.dumps(expected, indent=1) + "\n")
    print(f"Wrote {OUT_DIR / 'expected.json'} ({len(expected)} requests)")


if __name__ == "__main__":
    main()
