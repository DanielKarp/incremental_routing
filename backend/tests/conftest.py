"""A tiny synthetic GTFS feed that exercises the awkward cases.

Line L1 runs north along lon -122.1: Alpha (37.40) -> Bravo (37.41) -> Charlie (37.42) ->
Delta (37.43, a parent station with one platform). Stops are ~1.1 km apart.

- T_MORNING  weekdays 08:00 Alpha .. 08:20 Delta; Charlie has no time (interpolated to 08:13)
- T_LATE     weekdays 23:50 Alpha, past midnight to 24:20 Charlie
- T_SATURDAY Saturdays, plus Thanksgiving 2026-11-26 via calendar_dates
- T_SUNDAY   Sundays 08:00 Alpha -> 08:05 Bravo (2026-11-01 is the DST change day)

Bus B2 (a second agency) leaves Delta's other platform for Echo, ~880 m east:
- T_BUS 08:23 and T_BUS2 08:40 on weekdays.

T_MORNING follows shape SH1 (a point every ~278 m); its stop_times give shape_dist_traveled
except at Charlie, which must be matched geometrically.

transfers.txt, most specific wins: 5 min anywhere within Delta station; 2 min from L1 to B2
between the platforms; and no transfer at all from T_MORNING to T_BUS2.

feed_info.txt is deliberately stale, as in real BART feeds; the calendar must win.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from incremental_routing.config import Settings
from incremental_routing.gtfs.loader import build_database

FEED_FILES = {
    "agency.txt": """\
agency_id,agency_name,agency_url,agency_timezone
TR,Test Rail,https://example.com,America/Los_Angeles
BU,Test Bus,https://example.com,America/Los_Angeles
""",
    "stops.txt": """\
stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station
ALPHA,Alpha,37.400000,-122.100000,0,
BRAVO,Bravo,37.410000,-122.100000,0,
CHARLIE,Charlie,37.420000,-122.100000,0,
DELTA,Delta Station,37.430000,-122.100000,1,
DELTA_1,Delta Platform 1,37.430000,-122.100000,0,DELTA
DELTA_2,Delta Bus Bay,37.430200,-122.100300,0,DELTA
ECHO,Echo,37.430000,-122.090000,0,
""",
    "routes.txt": """\
route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color
L1,TR,L1,Line One,2,E31837,FFFFFF
B2,BU,B2,Bus Two,3,,
""",
    "trips.txt": """\
route_id,service_id,trip_id,trip_headsign,direction_id,bikes_allowed,shape_id
L1,WKDY,T_MORNING,Delta,0,1,SH1
L1,WKDY,T_LATE,Charlie,0,1,
L1,SAT,T_SATURDAY,Charlie,0,2,
L1,SUN,T_SUNDAY,Bravo,0,,
B2,WKDY,T_BUS,Echo,0,1,
B2,WKDY,T_BUS2,Echo,0,1,
""",
    "stop_times.txt": """\
trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,shape_dist_traveled
T_MORNING,08:00:00,08:00:00,ALPHA,1,0,0,0
T_MORNING,08:05:00,08:06:00,BRAVO,2,0,0,1112
T_MORNING,,,CHARLIE,3,0,0,
T_MORNING,08:20:00,08:20:00,DELTA_1,4,0,0,3336
T_LATE,23:50:00,23:50:00,ALPHA,1,,
T_LATE,24:10:00,24:10:00,BRAVO,2,,
T_LATE,24:20:00,24:20:00,CHARLIE,3,,
T_SATURDAY,09:00:00,09:00:00,ALPHA,1,,
T_SATURDAY,09:10:00,09:10:00,CHARLIE,2,,
T_SUNDAY,08:00:00,08:00:00,ALPHA,1,,
T_SUNDAY,08:05:00,08:05:00,BRAVO,2,,
T_BUS,08:23:00,08:23:00,DELTA_2,1,,
T_BUS,08:30:00,08:30:00,ECHO,2,,
T_BUS2,08:40:00,08:40:00,DELTA_2,1,,
T_BUS2,08:47:00,08:47:00,ECHO,2,,
""",
    "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n"
    + "".join(f"SH1,{37.4 + 0.0025 * k:.4f},-122.100000,{k + 1},{278 * k}\n" for k in range(13)),
    "transfers.txt": """\
from_stop_id,to_stop_id,transfer_type,min_transfer_time,from_route_id,to_route_id,from_trip_id,to_trip_id
DELTA,DELTA,2,300,,,,
DELTA_1,DELTA_2,2,120,L1,B2,,
DELTA_1,DELTA_2,3,,,,T_MORNING,T_BUS2
""",
    "calendar.txt": """\
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WKDY,1,1,1,1,1,0,0,20260101,20261231
SAT,0,0,0,0,0,1,0,20260101,20261231
SUN,0,0,0,0,0,0,1,20260101,20261231
""",
    "feed_info.txt": """\
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date
Test Rail,https://example.com,en,20250101,20250630
""",
    "calendar_dates.txt": """\
service_id,date,exception_type
WKDY,20261126,2
SAT,20261126,1
""",
}

ALPHA = (37.40, -122.10)
BRAVO = (37.41, -122.10)
DELTA = (37.43, -122.10)
SOUTH_OF_ALPHA = (37.3937, -122.10)  # ~700 m: 12 min on foot, 4 min by bike


def write_feed(path: Path, files: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return path


@pytest.fixture(scope="session")
def feed_zip(tmp_path_factory) -> Path:
    return write_feed(tmp_path_factory.mktemp("feeds") / "testrail.zip", FEED_FILES)


@pytest.fixture(scope="session")
def bus_ends_early_zip(tmp_path_factory) -> Path:
    """The same feed, except that the bus agency's schedule ends on 2026-10-31."""
    files = dict(FEED_FILES)
    files["calendar.txt"] += "BUS,1,1,1,1,1,0,0,20260101,20261031\n"
    files["trips.txt"] = files["trips.txt"].replace("B2,WKDY,", "B2,BUS,")
    return write_feed(tmp_path_factory.mktemp("feeds") / "busends.zip", files)


@pytest.fixture(scope="session")
def settings(tmp_path_factory, feed_zip) -> Settings:
    settings = Settings(data_dir=tmp_path_factory.mktemp("data"))
    build_database(settings.db_path, [("tr", feed_zip)])
    return settings
