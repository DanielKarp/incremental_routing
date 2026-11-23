"""Build the timetable fixture the frontend's tests read (frontend/src/timetable/fixtures/).

uv run python tests/frontend_fixture.py     # in builder/

It is conftest.py's synthetic feed plus EXTRA_FILES below, built into the full database by the
loader and published as ir-build-data publishes the real one: a timetable-<hash>.sqlite.gz and a
manifest.json. Everything is dated, so the output only changes when the feed or the code does.

expected.json, beside them, holds requests the FastAPI server answered on this data, with its
answers, which the TypeScript port of its queries must give too. It was recorded by this script
as it was at commit 1c15be0, and is frozen: the server is gone, so a change to the feed here
can't be recorded again, and makes the frontend's golden test fail.
"""

from __future__ import annotations

import datetime as dt
import math
import sqlite3
import tempfile
from pathlib import Path

from conftest import FEED_FILES, write_feed

from incremental_routing.config import REPO_DIR
from incremental_routing.gtfs.build_data import publish
from incremental_routing.gtfs.loader import build_database

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


if __name__ == "__main__":
    main()
