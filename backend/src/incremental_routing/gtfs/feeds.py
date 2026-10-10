"""The GTFS schedule feeds the planner knows about.

Two sources: the agencies' own feeds (one entry each in FEEDS; adding an agency is one more
entry), or 511.org's consolidated regional feed covering every Bay Area operator, which
needs a free API key. Don't mix them: the regional feed already contains the agencies.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Feed:
    feed_id: str
    name: str
    url: str


FEEDS: dict[str, Feed] = {
    feed.feed_id: feed
    for feed in [
        Feed(
            "caltrain",
            "Caltrain",
            "https://data.trilliumtransit.com/gtfs/caltrain-ca-us/caltrain-ca-us.zip",
        ),
        Feed("bart", "BART", "https://www.bart.gov/dev/schedules/google_transit.zip"),
        Feed("vta", "VTA", "https://gtfs.vta.org/gtfs_vta.zip"),
    ]
}

# operator_id=RG is the regional feed; the API key is added at download time, never logged.
REGIONAL_511 = Feed(
    "bayarea",
    "511 SF Bay regional feed",
    "https://api.511.org/transit/datafeeds?operator_id=RG",
)

SOURCES = ("agencies", "511")
