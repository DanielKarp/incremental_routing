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
from .query import agency_coverage

USER_AGENT = "incremental-routing/0.1 (personal trip planner)"
TOKEN_URL = "https://511.org/open-data/token"
# In a feed with several agencies, those whose schedules end within this many days are listed.
ENDING_SOON_DAYS = 30


class DownloadError(RuntimeError):
    """A feed couldn't be downloaded. The message never includes query parameters (keys)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def download_feed(feed: Feed, dest_dir: Path, params: dict[str, str] | None = None) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{feed.feed_id}.zip"
    partial = dest.with_suffix(".zip.part")
    # Merged here because httpx's params= replaces a query string already in the URL.
    url = httpx.URL(feed.url).copy_merge_params(params or {})
    try:
        with httpx.stream(
            "GET",
            url,
            follow_redirects=True,
            timeout=300,
            headers={"User-Agent": USER_AGENT},
        ) as resp:
            if resp.status_code != 200:
                raise DownloadError(f"{feed.name}: HTTP {resp.status_code}", resp.status_code)
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
        try:
            download_feed(
                REGIONAL_511, settings.feeds_dir, params={"api_key": settings.api_511_key}
            )
        except DownloadError as exc:
            if exc.status == 401:
                raise DownloadError(f"{exc}: 511.org rejected API_511_KEY", 401) from None
            raise
    if not zip_path.exists():
        parser.error(f"no downloaded 511 feed at {zip_path}")
    # The regional feed already includes Caltrain, BART and VTA: never load both.
    return [(REGIONAL_511.feed_id, zip_path)]


def _print_summary(db_path: Path, today: dt.date | None = None) -> None:
    today = today or dt.date.today()
    with closing(sqlite3.connect(db_path)) as conn:
        coverage = agency_coverage(conn)
        for feed_id, start, end in conn.execute(
            "SELECT feed_id, start_date, end_date FROM feeds ORDER BY feed_id"
        ):
            stops, trips, agencies = conn.execute(
                "SELECT (SELECT COUNT(*) FROM stops WHERE feed_id = :f),"
                " (SELECT COUNT(*) FROM trips WHERE feed_id = :f),"
                " (SELECT COUNT(DISTINCT agency_name) FROM routes WHERE feed_id = :f)",
                {"f": feed_id},
            ).fetchone()
            noun = "agency  " if agencies == 1 else "agencies"
            counts = f"  {feed_id:10} {agencies:3} {noun} {stops:6} stops {trips:7} trips"
            if len(coverage.get(feed_id, [])) <= 1:
                end_date = dt.date.fromisoformat(end) if end else None
                print(f"{counts}  {start} .. {end}{_expired(end_date, today)}")
                continue
            # The feed's overall dates span every agency's, so they'd hide one that has run
            # out: list the agencies whose schedules end soon instead.
            print(counts)
            soon = today + dt.timedelta(days=ENDING_SOON_DAYS)
            ending = sorted(
                (a for a in coverage[feed_id] if a.end_date and a.end_date < soon),
                key=lambda a: a.end_date,
            )
            for a in ending:
                name = a.name or "(no name)"
                print(f"    {name:42} until {a.end_date}{_expired(a.end_date, today)}")


def _expired(end: dt.date | None, today: dt.date) -> str:
    return "  <-- EXPIRED, re-download" if end and end < today else ""


if __name__ == "__main__":
    main()
