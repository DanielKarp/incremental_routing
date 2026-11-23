"""CLI: download the 511.org regional GTFS feed and rebuild the SQLite database.

uv run ir-load-gtfs                  # download the feed (needs API_511_KEY), rebuild
uv run ir-load-gtfs --skip-download  # rebuild from the feed already on disk
uv run ir-load-gtfs --keep-fresh 7   # keep running: rebuild whenever the data is a week old
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sqlite3
import time
import zipfile
from collections.abc import Callable
from contextlib import closing
from pathlib import Path

import httpx

from ..config import Settings
from .feeds import REGIONAL_511, Feed
from .loader import build_database
from .query import GtfsStore, agency_coverage

USER_AGENT = "incremental-routing/0.1 (personal trip planner)"
TOKEN_URL = "https://511.org/open-data/token"
# Agencies whose schedules end within this many days are listed after a build.
ENDING_SOON_DAYS = 30
# --keep-fresh looks at the data this often, and tries again this soon after a failure.
CHECK_EVERY_S = 6 * 3600
RETRY_AFTER_S = 3600


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
    if not zipfile.is_zipfile(partial):
        # An error page sent with HTTP 200, say: keep the feed we already have.
        partial.unlink()
        raise DownloadError(f"{feed.name}: the download is not a GTFS zip file")
    partial.replace(dest)
    return dest


class RefreshError(RuntimeError):
    """The database couldn't be refreshed; the message says why."""


def refresh(settings: Settings, *, download: bool = True, db_path: Path | None = None) -> None:
    """Download the 511 feed (unless `download` is false) and rebuild the database from it.

    The database is settings.db_path, the server's, unless db_path says otherwise.
    """
    db_path = db_path or settings.db_path
    zip_path = settings.feeds_dir / f"{REGIONAL_511.feed_id}.zip"
    if download:
        if not settings.api_511_key:
            raise RefreshError(f"downloading needs API_511_KEY in .env (free token: {TOKEN_URL})")
        print(f"Downloading {REGIONAL_511.name} from {REGIONAL_511.url} (this can take minutes)")
        try:
            download_feed(
                REGIONAL_511, settings.feeds_dir, params={"api_key": settings.api_511_key}
            )
        except DownloadError as exc:
            reason = f"{exc}: 511.org rejected API_511_KEY" if exc.status == 401 else str(exc)
            raise RefreshError(f"Download failed: {reason}") from None
    if not zip_path.exists():
        raise RefreshError(f"no downloaded feed at {zip_path}")

    print(f"Building {db_path} from {zip_path.name}")
    build_database(db_path, [(REGIONAL_511.feed_id, zip_path)])
    _print_summary(db_path)


def keep_fresh(
    settings: Settings,
    every_days: float,
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.time,
) -> None:
    """Keep the database current, forever: the Docker image runs this beside the server.

    The database is rebuilt when it's missing, outdated, or older than every_days. The feed is
    downloaded again only when the downloaded copy is that old too, so a restart or an app
    update doesn't fetch it needlessly. Failures are reported and retried an hour later.
    """
    max_age_s = every_days * 86400
    zip_path = settings.feeds_dir / f"{REGIONAL_511.feed_id}.zip"
    while True:
        wait = CHECK_EVERY_S
        if _stale(settings.db_path, max_age_s, clock()) or GtfsStore(settings.db_path).problem():
            try:
                refresh(settings, download=_stale(zip_path, max_age_s, clock()))
            except Exception as exc:  # noqa: BLE001 - one bad refresh mustn't stop the next
                print(f"Refreshing the transit data failed: {exc}. Trying again in an hour.")
                wait = RETRY_AFTER_S
        sleep(wait)


def _stale(path: Path, max_age_s: float, now: float) -> bool:
    return not path.exists() or now - path.stat().st_mtime >= max_age_s


def main(argv: list[str] | None = None) -> None:
    settings = Settings()
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--skip-download", action="store_true", help="rebuild from the feed already on disk"
    )
    parser.add_argument(
        "--keep-fresh",
        type=float,
        metavar="DAYS",
        help="keep running, and rebuild whenever the data is DAYS days old (or missing)",
    )
    # Accepted and ignored: from when the agencies' own feeds were the other choice.
    parser.add_argument("--source", choices=["511"], help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if args.keep_fresh is not None:
        if args.keep_fresh <= 0:
            parser.error("--keep-fresh needs a positive number of days")
        keep_fresh(settings, args.keep_fresh)
    try:
        refresh(settings, download=not args.skip_download)
    except RefreshError as exc:
        parser.exit(1, f"{exc}\n")


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
