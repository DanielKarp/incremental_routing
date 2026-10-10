"""Runtime settings, read from the environment (and backend/.env if present)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[2]

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
    default_timezone: ZoneInfo = field(
        default_factory=lambda: ZoneInfo(_env("DEFAULT_TIMEZONE") or "America/Los_Angeles")
    )

    @property
    def feeds_dir(self) -> Path:
        return self.data_dir / "feeds"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "gtfs.sqlite"
