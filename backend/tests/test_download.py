from __future__ import annotations

import datetime as dt
import os
import shutil
import sqlite3

import httpx
import pytest

from incremental_routing.config import Settings
from incremental_routing.gtfs import download

SECRET = "not-a-real-key-123"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("IR_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("API_511_KEY", raising=False)
    (tmp_path / "feeds").mkdir()
    return tmp_path


def feed_ids(db_path) -> list[str]:
    with sqlite3.connect(db_path) as conn:
        return [row[0] for row in conn.execute("SELECT feed_id FROM feeds ORDER BY feed_id")]


def test_511_needs_a_key(data_dir, capsys):
    with pytest.raises(SystemExit):
        download.main([])
    assert "API_511_KEY" in capsys.readouterr().err


def serve(monkeypatch, handler) -> list[httpx.Request]:
    """Answer downloads with handler, through httpx's real request building."""
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(record))
    monkeypatch.setattr(download.httpx, "stream", client.stream)
    return requests


def test_511_downloads_the_regional_feed_with_the_key(data_dir, monkeypatch, feed_zip):
    monkeypatch.setenv("API_511_KEY", SECRET)
    requests = serve(monkeypatch, lambda _: httpx.Response(200, content=feed_zip.read_bytes()))
    download.main([])
    # Both parameters must survive: the operator in the feed URL, and the key added to it.
    assert requests[0].url.params["operator_id"] == "RG"
    assert requests[0].url.params["api_key"] == SECRET
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]


def test_511_download_never_shows_the_key(data_dir, monkeypatch, capsys):
    monkeypatch.setenv("API_511_KEY", SECRET)

    def unreachable(request: httpx.Request) -> httpx.Response:
        # httpx errors can quote the full request URL, key included.
        raise httpx.ConnectError(f"cannot reach {request.url}", request=request)

    serve(monkeypatch, unreachable)
    with pytest.raises(SystemExit):
        download.main([])
    out = capsys.readouterr()
    assert SECRET not in out.out + out.err
    assert "Download failed: 511 SF Bay regional feed: ConnectError" in out.err


def test_a_download_that_is_not_a_zip_keeps_the_feed_we_have(data_dir, monkeypatch, capsys):
    monkeypatch.setenv("API_511_KEY", SECRET)
    (data_dir / "feeds" / "bayarea.zip").write_bytes(b"the previous feed")
    serve(monkeypatch, lambda _: httpx.Response(200, text="<html>Service unavailable</html>"))
    with pytest.raises(SystemExit):
        download.main([])
    assert "not a GTFS zip file" in capsys.readouterr().err
    assert (data_dir / "feeds" / "bayarea.zip").read_bytes() == b"the previous feed"
    assert not (data_dir / "feeds" / "bayarea.zip.part").exists()


def test_511_says_when_the_key_is_rejected(data_dir, monkeypatch, capsys):
    monkeypatch.setenv("API_511_KEY", SECRET)
    serve(monkeypatch, lambda _: httpx.Response(401, text="This API key provided is invalid."))
    with pytest.raises(SystemExit):
        download.main([])
    err = capsys.readouterr().err
    assert "HTTP 401: 511.org rejected API_511_KEY" in err
    assert SECRET not in err


def test_rebuilds_from_the_downloaded_feed_without_a_key(data_dir, feed_zip):
    # An agency feed left over from older versions is ignored.
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    shutil.copy(feed_zip, data_dir / "feeds" / "bart.zip")
    download.main(["--skip-download"])
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]


def test_the_old_source_option_still_works(data_dir, feed_zip, capsys):
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--source", "511", "--skip-download"])
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]
    with pytest.raises(SystemExit):
        download.main(["--source", "agencies", "--skip-download"])
    assert "invalid choice: 'agencies'" in capsys.readouterr().err


def test_rebuilding_needs_a_downloaded_feed(data_dir, capsys):
    with pytest.raises(SystemExit):
        download.main(["--skip-download"])
    assert "no downloaded feed" in capsys.readouterr().err


def test_summary_lists_agencies_whose_schedules_run_out(data_dir, bus_ends_early_zip, capsys):
    shutil.copy(bus_ends_early_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--skip-download"])
    capsys.readouterr()
    download._print_summary(data_dir / "gtfs.sqlite", today=dt.date(2026, 11, 15))
    out = capsys.readouterr().out
    assert "Test Bus" in out
    assert "until 2026-10-31  <-- EXPIRED, re-download" in out
    assert "Test Rail" not in out  # until 2026-12-31: not within 30 days
    assert ".." not in out  # no feed-wide date range, which would hide the bus


def test_summary_says_when_no_schedule_ends_soon(data_dir, feed_zip, capsys):
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--skip-download"])
    capsys.readouterr()
    download._print_summary(data_dir / "gtfs.sqlite", today=dt.date(2026, 10, 12))
    out = capsys.readouterr().out
    assert "bayarea: 2 agencies, 7 stops, 6 trips" in out
    assert "Every agency's schedule runs past 2026-11-11." in out


class Stop(Exception):
    """Ends a keep_fresh loop after the rounds a test wants."""


def run_keep_fresh(settings: Settings, rounds: int, now: float = 1e9) -> list[float]:
    waits: list[float] = []

    def sleep(seconds: float) -> None:
        waits.append(seconds)
        if len(waits) == rounds:
            raise Stop

    with pytest.raises(Stop):
        download.keep_fresh(settings, 7, sleep=sleep, clock=lambda: now)
    return waits


def age(path, days: float, now: float = 1e9) -> None:
    os.utime(path, (now - days * 86400, now - days * 86400))


def test_keep_fresh_builds_from_a_recent_download_without_fetching_again(data_dir, feed_zip):
    # A first start where the feed was already downloaded: no key needed, no download.
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    age(data_dir / "feeds" / "bayarea.zip", 1)
    waits = run_keep_fresh(Settings(), rounds=1)
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]
    assert waits == [download.CHECK_EVERY_S]


def test_keep_fresh_leaves_fresh_data_alone(data_dir, feed_zip, monkeypatch):
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--skip-download"])
    age(data_dir / "gtfs.sqlite", 2)
    rebuilt = []
    monkeypatch.setattr(download, "refresh", lambda *a, **k: rebuilt.append(k))
    run_keep_fresh(Settings(), rounds=2)
    assert rebuilt == []


def test_keep_fresh_downloads_again_when_the_data_is_old(data_dir, feed_zip, monkeypatch):
    monkeypatch.setenv("API_511_KEY", SECRET)
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--skip-download"])
    age(data_dir / "gtfs.sqlite", 8)
    age(data_dir / "feeds" / "bayarea.zip", 8)
    requests = serve(monkeypatch, lambda _: httpx.Response(200, content=feed_zip.read_bytes()))
    run_keep_fresh(Settings(), rounds=1)
    assert len(requests) == 1
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]


def test_keep_fresh_rebuilds_a_database_from_an_older_app(data_dir, feed_zip, monkeypatch):
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--skip-download"])
    with sqlite3.connect(data_dir / "gtfs.sqlite") as conn:
        conn.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
    calls = []
    monkeypatch.setattr(download, "refresh", lambda settings, download: calls.append(download))
    run_keep_fresh(Settings(), rounds=1)
    assert calls == [False]  # the downloaded feed is recent: rebuild from it


def test_keep_fresh_retries_an_hour_after_a_failure(data_dir, capsys):
    # No key and nothing downloaded: report it, and keep trying.
    waits = run_keep_fresh(Settings(), rounds=2)
    assert waits == [download.RETRY_AFTER_S, download.RETRY_AFTER_S]
    out = capsys.readouterr().out
    assert "Refreshing the transit data failed: downloading needs API_511_KEY" in out


def test_keep_fresh_needs_a_positive_interval(data_dir, capsys):
    with pytest.raises(SystemExit):
        download.main(["--keep-fresh", "0"])
    assert "positive number of days" in capsys.readouterr().err
