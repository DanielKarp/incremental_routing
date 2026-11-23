"""The builder's settings, read from the environment and from .env files."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

BUILDER_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BUILDER_DIR.parent

# Values already in the environment (a CI secret, say) win; then builder/.env, then a .env at
# the repository root, where older versions kept it.
load_dotenv(BUILDER_DIR / ".env")
load_dotenv(REPO_DIR / ".env")


def _env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


@dataclass(frozen=True)
class Settings:
    # Where the downloaded feed (feeds/) and the full database (build/) live.
    data_dir: Path = field(
        default_factory=lambda: Path(_env("IR_DATA_DIR") or BUILDER_DIR / "data")
    )
    # For downloading the 511.org regional GTFS feed.
    api_511_key: str | None = field(default_factory=lambda: _env("API_511_KEY"))
    # Where request times without a UTC offset are, for the app (the manifest's
    # default_timezone).
    default_timezone: ZoneInfo = field(
        default_factory=lambda: ZoneInfo(_env("DEFAULT_TIMEZONE") or "America/Los_Angeles")
    )

    @property
    def feeds_dir(self) -> Path:
        return self.data_dir / "feeds"
