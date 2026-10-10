"""The GTFS schedule feeds the planner knows about.

Adding an agency is one entry here. For the whole Bay Area at once, 511.org publishes a
consolidated regional feed (operator_id=RG) that needs a free API key.
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
