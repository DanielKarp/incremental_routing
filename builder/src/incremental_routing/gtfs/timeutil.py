"""GTFS times and dates.

GTFS stop times are offsets from the *service day's origin*, defined as noon minus 12 hours
local time. That equals midnight except on daylight-saving change days, and offsets may exceed
24:00:00 for trips that run past midnight on the previous service day. The app turns them into
clock times (frontend/src/timetable/zone.ts).
"""

from __future__ import annotations

import datetime as dt


def parse_gtfs_time(value: str | None) -> int | None:
    """'25:10:00' -> 90600. Empty values (non-timepoint stops) return None."""
    if not value:
        return None
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds)


def parse_gtfs_date(value: str) -> dt.date:
    """'20261012' -> date(2026, 10, 12)."""
    return dt.date(int(value[:4]), int(value[4:6]), int(value[6:8]))
