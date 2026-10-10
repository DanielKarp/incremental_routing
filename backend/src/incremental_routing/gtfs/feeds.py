"""The GTFS schedule feed the planner uses: 511.org's regional feed for every Bay Area operator.

Downloading it needs a free API key (API_511_KEY), which is added at download time and never
logged.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Feed:
    feed_id: str
    name: str
    url: str


# operator_id=RG is the consolidated regional feed.
REGIONAL_511 = Feed(
    "bayarea",
    "511 SF Bay regional feed",
    "https://api.511.org/transit/datafeeds?operator_id=RG",
)
