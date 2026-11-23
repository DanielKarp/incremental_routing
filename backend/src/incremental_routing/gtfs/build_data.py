"""CLI: build the timetable the static site downloads, and the manifest that names it.

uv run ir-build-data                                # download the feed (needs API_511_KEY), build
uv run ir-build-data --skip-download                # build from the feed already on disk
uv run ir-build-data --from-db data/gtfs.sqlite     # from a database ir-load-gtfs built

The full database is built as ir-load-gtfs builds it, but in a working folder (backend/data/build
by default, not the server's), and the compact timetable is derived from it and checked against
it (see compact.py). The output folder, frontend/public/data by default, then gets
timetable-<hash>.sqlite.gz and manifest.json, and loses the timetables earlier builds left there.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import logging
from pathlib import Path

from ..config import REPO_DIR, Settings
from .compact import SCHEMA_VERSION, CompactMismatch, build_compact, check_compact
from .download import RefreshError, refresh
from .query import GtfsStore, GtfsUnavailable

DEFAULT_OUT_DIR = REPO_DIR / "frontend" / "public" / "data"
MANIFEST = "manifest.json"
TIMETABLE_GLOB = "timetable-*.sqlite.gz"
# Hex digits of the timetable's SHA-256 in its name: a new name whenever the data changes, so
# browsers can keep each file for good.
HASH_DIGITS = 12


def publish(
    full_db: Path,
    out_dir: Path,
    work_dir: Path,
    *,
    default_timezone: str,
    now: dt.datetime | None = None,
) -> dict:
    """Derive the compact timetable from full_db, check it, and write it and its manifest.

    Returns the manifest. Nothing is written to out_dir unless the timetable checks out.
    """
    built_at = (now or dt.datetime.now(dt.UTC)).isoformat(timespec="seconds")
    compact_db = work_dir / "timetable.sqlite"
    print(f"Deriving {compact_db} from {full_db}")
    stats = build_compact(full_db, compact_db, built_at=built_at)
    print(
        f"  {stats.trips} trips, {stats.stop_times} stop times: {stats.paths} paths"
        f" ({stats.path_stops} stops), {stats.patterns} patterns ({stats.pattern_times} times)"
    )
    print(f"  {stats.shapes} shapes: {stats.kept_points} of {stats.shape_points} points kept")
    check_compact(full_db, compact_db)
    print("  Checked: it gives back every table the server reads")

    raw = compact_db.read_bytes()
    # mtime=0, and no file name inside: the same timetable always packs to the same bytes.
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    digest = hashlib.sha256(packed).hexdigest()
    name = f"timetable-{digest[:HASH_DIGITS]}.sqlite.gz"
    # Just as /api/feeds lists them, each agency's dates included.
    feeds = [feed.model_dump(mode="json") for feed in GtfsStore(full_db).feeds()]
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "built_at": built_at,
        "timetable": {
            "file": name,
            "gzip_bytes": len(packed),
            "gzip_sha256": digest,
            "sqlite_bytes": len(raw),
            "sqlite_sha256": hashlib.sha256(raw).hexdigest(),
        },
        # Where request times without a UTC offset are, as the server's DEFAULT_TIMEZONE.
        "default_timezone": default_timezone,
        # The timezones the feeds' times are in.
        "timezones": sorted({feed["timezone"] for feed in feeds}),
        "feeds": feeds,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    # The timetable first, so a manifest never names a file that isn't there.
    _write(out_dir / name, packed)
    _write(out_dir / MANIFEST, (json.dumps(manifest, indent=2) + "\n").encode())
    print(f"Wrote {out_dir / name} ({_mb(len(packed))}; {_mb(len(raw))} unpacked) and {MANIFEST}")
    for old in sorted(out_dir.glob(TIMETABLE_GLOB)):
        if old.name != name:
            old.unlink()
            print(f"  Removed {old.name}, from an earlier build")
    return manifest


def main(argv: list[str] | None = None) -> None:
    settings = Settings()
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--skip-download", action="store_true", help="build from the feed already on disk"
    )
    parser.add_argument(
        "--from-db",
        type=Path,
        metavar="PATH",
        help="derive the timetable from this database (built by ir-load-gtfs) instead",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT_DIR,
        metavar="DIR",
        help="where the timetable and manifest.json go (default: %(default)s)",
    )
    parser.add_argument(
        "--work",
        type=Path,
        default=settings.data_dir / "build",
        metavar="DIR",
        help="where the full database and the unpacked timetable are built (default: %(default)s)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    # httpx logs each request's URL, and the download's has the key in it.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    try:
        full_db = args.from_db
        if full_db is None:
            full_db = args.work / "gtfs.sqlite"
            refresh(settings, download=not args.skip_download, db_path=full_db)
        publish(full_db, args.out, args.work, default_timezone=settings.default_timezone.key)
    except (RefreshError, GtfsUnavailable) as exc:
        parser.exit(1, f"{exc}\n")
    except CompactMismatch as exc:
        parser.exit(1, f"The compact timetable doesn't match the full database: {exc}\n")


def _write(path: Path, data: bytes) -> None:
    """Write path whole or not at all: a half-written file is never there to be served."""
    tmp_path = path.with_name(path.name + ".tmp")
    tmp_path.write_bytes(data)
    tmp_path.replace(path)


def _mb(size: int) -> str:
    return f"{size / 1e6:.1f} MB"


if __name__ == "__main__":
    main()
