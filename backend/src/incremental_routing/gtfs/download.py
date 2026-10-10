"""CLI: download the 511.org regional GTFS feed and rebuild the SQLite database.

uv run ir-load-gtfs                  # download the feed (needs API_511_KEY), rebuild
uv run ir-load-gtfs --skip-download  # rebuild from the feed already on disk
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
from .feeds import REGIONAL_511, Feed
from .loader import build_database
from .query import agency_coverage

USER_AGENT = "incremental-routing/0.1 (personal trip planner)"
TOKEN_URL = "https://511.org/open-data/token"
# Agencies whose schedules end within this many days are listed after a build.
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
        "--skip-download", action="store_true", help="rebuild from the feed already on disk"
    )
    # Accepted and ignored: from when the agencies' own feeds were the other choice.
    parser.add_argument("--source", choices=["511"], help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    zip_path = settings.feeds_dir / f"{REGIONAL_511.feed_id}.zip"
    if not args.skip_download:
        if not settings.api_511_key:
            parser.error(f"downloading needs API_511_KEY in backend/.env (free: {TOKEN_URL})")
        print(f"Downloading {REGIONAL_511.name} from {REGIONAL_511.url} (this can take minutes)")
        try:
            download_feed(
                REGIONAL_511, settings.feeds_dir, params={"api_key": settings.api_511_key}
            )
        except DownloadError as exc:
            reason = f"{exc}: 511.org rejected API_511_KEY" if exc.status == 401 else str(exc)
            parser.exit(1, f"Download failed: {reason}\n")
    if not zip_path.exists():
        parser.error(f"no downloaded feed at {zip_path}")

    print(f"Building {settings.db_path} from {zip_path.name}")
    build_database(settings.db_path, [(REGIONAL_511.feed_id, zip_path)])
    _print_summary(settings.db_path)


def _print_summary(db_path: Path, today: dt.date | None = None) -> None:
    today = today or dt.date.today()
    soon = today + dt.timedelta(days=ENDING_SOON_DAYS)
    with closing(sqlite3.connect(db_path)) as conn:
        coverage = agency_coverage(conn)
        for (feed_id,) in conn.execute("SELECT feed_id FROM feeds ORDER BY feed_id"):
            stops, trips = conn.execute(
                "SELECT (SELECT COUNT(*) FROM stops WHERE feed_id = :f),"
                " (SELECT COUNT(*) FROM trips WHERE feed_id = :f)",
                {"f": feed_id},
            ).fetchone()
            agencies = coverage.get(feed_id, [])
            print(f"  {feed_id}: {len(agencies)} agencies, {stops} stops, {trips} trips")
            # Each agency's schedule runs out on its own date; the feed's overall dates would
            # hide one that has.
            ending = sorted(
                (a for a in agencies if a.end_date and a.end_date < soon),
                key=lambda a: a.end_date,
            )
            for a in ending:
                name = a.name or "(no name)"
                print(f"    {name:42} until {a.end_date}{_expired(a.end_date, today)}")
            if not ending:
                print(f"    Every agency's schedule runs past {soon}.")


def _expired(end: dt.date | None, today: dt.date) -> str:
    return "  <-- EXPIRED, re-download" if end and end < today else ""


if __name__ == "__main__":
    main()
