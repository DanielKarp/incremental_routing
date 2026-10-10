"""Runtime settings, read from the environment and the repository's .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BACKEND_DIR.parent

# One .env at the repository root serves Docker Compose and running without it. Values already
# in the environment (from Compose, say) win; backend/.env, the older place, is read last.
load_dotenv(REPO_DIR / ".env")
load_dotenv(BACKEND_DIR / ".env")


def _env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(
        default_factory=lambda: Path(_env("IR_DATA_DIR") or BACKEND_DIR / "data")
    )
    routing_provider: str | None = field(default_factory=lambda: _env("ROUTING_PROVIDER"))
    ors_api_key: str | None = field(default_factory=lambda: _env("ORS_API_KEY"))
    valhalla_route_url: str = field(
        default_factory=lambda: (
            _env("VALHALLA_ROUTE_URL") or "https://valhalla1.openstreetmap.de/route"
        )
    )
    valhalla_api_key: str | None = field(default_factory=lambda: _env("VALHALLA_API_KEY"))
    # For downloading the 511.org regional GTFS feed (ir-load-gtfs).
    api_511_key: str | None = field(default_factory=lambda: _env("API_511_KEY"))
    # The built frontend (npm run build), served at / so that one process runs the whole app.
    static_dir: Path = field(
        default_factory=lambda: Path(_env("IR_STATIC_DIR") or REPO_DIR / "frontend" / "dist")
    )
    # What to do about missing or outdated transit data, if not running ir-load-gtfs by hand.
    data_hint: str | None = field(default_factory=lambda: _env("IR_DATA_HINT"))
    default_timezone: ZoneInfo = field(
        default_factory=lambda: ZoneInfo(_env("DEFAULT_TIMEZONE") or "America/Los_Angeles")
    )

    @property
    def feeds_dir(self) -> Path:
        return self.data_dir / "feeds"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "gtfs.sqlite"
