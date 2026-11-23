"""Download the 511.org regional GTFS feed, and build the full SQLite database from it.

ir-build-data (build_data.py) does this first, then derives the timetable from the database.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
import zipfile
from contextlib import closing
from pathlib import Path

import httpx

from ..config import Settings
from .database import agency_coverage
from .feeds import REGIONAL_511, Feed
from .loader import build_database

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
    if not zipfile.is_zipfile(partial):
        # An error page sent with HTTP 200, say: keep the feed we already have.
        partial.unlink()
        raise DownloadError(f"{feed.name}: the download is not a GTFS zip file")
    partial.replace(dest)
    return dest


class RefreshError(RuntimeError):
    """The feed couldn't be downloaded, or isn't there to build from; the message says why."""


def refresh(settings: Settings, *, download: bool = True, db_path: Path) -> None:
    """Download the 511 feed (unless `download` is false) and build db_path from it."""
    zip_path = settings.feeds_dir / f"{REGIONAL_511.feed_id}.zip"
    if download:
        if not settings.api_511_key:
            raise RefreshError(
                "downloading needs API_511_KEY, in builder/.env or the environment"
                f" (free token: {TOKEN_URL})"
            )
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
