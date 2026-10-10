"""CLI: download GTFS feeds and rebuild the SQLite database.

uv run ir-load-gtfs                  # download the source's feeds, rebuild
uv run ir-load-gtfs bart             # agencies: refresh BART only, rebuild from all of them
uv run ir-load-gtfs --source 511     # the 511.org regional feed (needs API_511_KEY)
uv run ir-load-gtfs --skip-download  # rebuild from the zips already on disk
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
from .feeds import FEEDS, REGIONAL_511, SOURCES, Feed
from .loader import build_database

USER_AGENT = "incremental-routing/0.1 (personal trip planner)"
TOKEN_URL = "https://511.org/open-data/token"


class DownloadError(RuntimeError):
    """A feed couldn't be downloaded. The message never includes query parameters (keys)."""


def download_feed(feed: Feed, dest_dir: Path, params: dict[str, str] | None = None) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{feed.feed_id}.zip"
    partial = dest.with_suffix(".zip.part")
    try:
        with httpx.stream(
            "GET",
            feed.url,
            params=params,
            follow_redirects=True,
            timeout=300,
            headers={"User-Agent": USER_AGENT},
        ) as resp:
            if resp.status_code != 200:
                raise DownloadError(f"{feed.name}: HTTP {resp.status_code}")
            with partial.open("wb") as f:
                for chunk in resp.iter_bytes():
                    f.write(chunk)
    except httpx.HTTPError as exc:
        # httpx messages can quote the full URL, key included; report only the kind of error.
        raise DownloadError(f"{feed.name}: {type(exc).__name__}") from None
    partial.replace(dest)
    return dest


def main(argv: list[str] | None = None) -> None:
    settings = Settings()
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "feeds",
        nargs="*",
        metavar="FEED",
        help=f"agencies source only: feeds to download ({', '.join(FEEDS)})",
    )
    parser.add_argument(
        "--source",
        choices=SOURCES,
        default=settings.gtfs_source,
        help="agencies: the Caltrain, BART and VTA feeds; 511: the 511.org regional feed for "
        "every Bay Area operator (needs API_511_KEY). Default: GTFS_SOURCE, else agencies.",
    )
    parser.add_argument(
        "--skip-download", action="store_true", help="rebuild from previously downloaded zips"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if args.source not in SOURCES:
        parser.error(f"GTFS_SOURCE must be one of: {', '.join(SOURCES)}")
    try:
        if args.source == "511":
            zips = _prepare_511(parser, args, settings)
        else:
            zips = _prepare_agencies(parser, args, settings)
    except DownloadError as exc:
        parser.exit(1, f"Download failed: {exc}\n")

    print(f"Building {settings.db_path} from {', '.join(f for f, _ in zips)}")
    build_database(settings.db_path, zips)
    _print_summary(settings.db_path)


def _prepare_agencies(parser, args, settings: Settings) -> list[tuple[str, Path]]:
    unknown = [f for f in args.feeds if f not in FEEDS]
    if unknown:
        parser.error(f"unknown feed(s): {', '.join(unknown)}")
    if not args.skip_download:
        for feed_id in args.feeds or FEEDS:
            print(f"Downloading {FEEDS[feed_id].name} from {FEEDS[feed_id].url}")
            download_feed(FEEDS[feed_id], settings.feeds_dir)
    # Build from every agency feed on disk, so refreshing one keeps the others.
    zips = [
        (feed_id, settings.feeds_dir / f"{feed_id}.zip")
        for feed_id in FEEDS
        if (settings.feeds_dir / f"{feed_id}.zip").exists()
    ]
    if not zips:
        parser.error(f"no downloaded feeds in {settings.feeds_dir}")
    return zips


def _prepare_511(parser, args, settings: Settings) -> list[tuple[str, Path]]:
    if args.feeds:
        parser.error("feed names only apply to --source agencies")
    zip_path = settings.feeds_dir / f"{REGIONAL_511.feed_id}.zip"
    if not args.skip_download:
        if not settings.api_511_key:
            parser.error(f"--source 511 needs API_511_KEY in backend/.env (free: {TOKEN_URL})")
        print(f"Downloading {REGIONAL_511.name} from {REGIONAL_511.url} (this can take minutes)")
        download_feed(REGIONAL_511, settings.feeds_dir, params={"api_key": settings.api_511_key})
    if not zip_path.exists():
        parser.error(f"no downloaded 511 feed at {zip_path}")
    # The regional feed already includes Caltrain, BART and VTA: never load both.
    return [(REGIONAL_511.feed_id, zip_path)]


def _print_summary(db_path: Path) -> None:
    today = dt.date.today().isoformat()
    with closing(sqlite3.connect(db_path)) as conn:
        for feed_id, start, end in conn.execute(
            "SELECT feed_id, start_date, end_date FROM feeds ORDER BY feed_id"
        ):
            stops, trips, agencies = conn.execute(
                "SELECT (SELECT COUNT(*) FROM stops WHERE feed_id = :f),"
                " (SELECT COUNT(*) FROM trips WHERE feed_id = :f),"
                " (SELECT COUNT(DISTINCT agency_name) FROM routes WHERE feed_id = :f)",
                {"f": feed_id},
            ).fetchone()
            warning = "  <-- EXPIRED, re-download" if end and end < today else ""
            print(
                f"  {feed_id:10} {agencies:3} agencies {stops:6} stops {trips:7} trips"
                f"  {start} .. {end}{warning}"
            )


if __name__ == "__main__":
    main()
