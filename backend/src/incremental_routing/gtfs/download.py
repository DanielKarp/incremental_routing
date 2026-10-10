"""CLI: download GTFS feeds and rebuild the SQLite database.

uv run ir-load-gtfs                 # download every feed, rebuild
uv run ir-load-gtfs bart            # refresh BART only, rebuild from all downloaded feeds
uv run ir-load-gtfs --skip-download # rebuild from the zips already on disk
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sqlite3
from contextlib import closing
from pathlib import Path

import httpx

from ..config import Settings
from .feeds import FEEDS, Feed
from .loader import build_database

USER_AGENT = "incremental-routing/0.1 (personal trip planner)"


def download_feed(feed: Feed, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{feed.feed_id}.zip"
    partial = dest.with_suffix(".zip.part")
    with httpx.stream(
        "GET", feed.url, follow_redirects=True, timeout=120, headers={"User-Agent": USER_AGENT}
    ) as resp:
        resp.raise_for_status()
        with partial.open("wb") as f:
            for chunk in resp.iter_bytes():
                f.write(chunk)
    partial.replace(dest)
    return dest


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "feeds", nargs="*", metavar="FEED", help=f"feeds to download ({', '.join(FEEDS)})"
    )
    parser.add_argument(
        "--skip-download", action="store_true", help="rebuild from previously downloaded zips"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    unknown = [f for f in args.feeds if f not in FEEDS]
    if unknown:
        parser.error(f"unknown feed(s): {', '.join(unknown)}")

    settings = Settings()
    if not args.skip_download:
        for feed_id in args.feeds or FEEDS:
            print(f"Downloading {FEEDS[feed_id].name} from {FEEDS[feed_id].url}")
            download_feed(FEEDS[feed_id], settings.feeds_dir)

    zips = [
        (feed_id, settings.feeds_dir / f"{feed_id}.zip")
        for feed_id in FEEDS
        if (settings.feeds_dir / f"{feed_id}.zip").exists()
    ]
    if not zips:
        parser.error(f"no downloaded feeds in {settings.feeds_dir}")

    print(f"Building {settings.db_path} from {', '.join(f for f, _ in zips)}")
    build_database(settings.db_path, zips)
    _print_summary(settings.db_path)


def _print_summary(db_path: Path) -> None:
    today = dt.date.today().isoformat()
    with closing(sqlite3.connect(db_path)) as conn:
        for feed_id, start, end in conn.execute(
            "SELECT feed_id, start_date, end_date FROM feeds ORDER BY feed_id"
        ):
            stops, trips = conn.execute(
                "SELECT (SELECT COUNT(*) FROM stops WHERE feed_id = :f),"
                " (SELECT COUNT(*) FROM trips WHERE feed_id = :f)",
                {"f": feed_id},
            ).fetchone()
            warning = "  <-- EXPIRED, re-download" if end and end < today else ""
            print(f"  {feed_id:10} {stops:6} stops {trips:7} trips  {start} .. {end}{warning}")


if __name__ == "__main__":
    main()
