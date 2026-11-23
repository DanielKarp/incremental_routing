from __future__ import annotations

import os
import subprocess
import sys


def test_time_zones_load_without_a_system_database():
    """Windows has no system zoneinfo database; the tzdata package must stand in for it."""
    code = "from zoneinfo import ZoneInfo; ZoneInfo('America/Los_Angeles')"
    env = {**os.environ, "PYTHONTZPATH": ""}  # Hide /usr/share/zoneinfo, as on Windows.
    result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
