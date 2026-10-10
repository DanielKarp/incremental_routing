"""GTFS time arithmetic.

GTFS stop times are offsets from the *service day's origin*, defined as noon minus 12 hours
local time. That equals midnight except on daylight-saving change days, and offsets may exceed
24:00:00 for trips that run past midnight on the previous service day.
"""

from __future__ import annotations

import datetime as dt
import math
from zoneinfo import ZoneInfo


def parse_gtfs_time(value: str | None) -> int | None:
    """'25:10:00' -> 90600. Empty values (non-timepoint stops) return None."""
    if not value:
        return None
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds)


def parse_gtfs_date(value: str) -> dt.date:
    """'20261012' -> date(2026, 10, 12)."""
    return dt.date(int(value[:4]), int(value[4:6]), int(value[6:8]))


def service_day_origin(service_date: dt.date, tz: ZoneInfo) -> dt.datetime:
    """The absolute instant (UTC) that GTFS time 00:00:00 refers to on service_date."""
    noon = dt.datetime.combine(service_date, dt.time(12), tzinfo=tz)
    # Subtract in UTC: aware-datetime arithmetic in Python is wall-clock arithmetic.
    return noon.astimezone(dt.UTC) - dt.timedelta(hours=12)


def gtfs_to_datetime(service_date: dt.date, seconds: int, tz: ZoneInfo) -> dt.datetime:
    origin = service_day_origin(service_date, tz)
    return (origin + dt.timedelta(seconds=seconds)).astimezone(tz)


def seconds_since_origin(service_date: dt.date, tz: ZoneInfo, when: dt.datetime) -> int:
    """Express an aware datetime as a GTFS time offset on service_date."""
    return math.floor((when - service_day_origin(service_date, tz)).total_seconds())
