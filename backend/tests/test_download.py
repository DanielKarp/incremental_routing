from __future__ import annotations

import datetime as dt
import shutil
import sqlite3

import httpx
import pytest

from incremental_routing.gtfs import download

SECRET = "not-a-real-key-123"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("IR_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("GTFS_SOURCE", raising=False)
    monkeypatch.delenv("API_511_KEY", raising=False)
    (tmp_path / "feeds").mkdir()
    return tmp_path


def feed_ids(db_path) -> list[str]:
    with sqlite3.connect(db_path) as conn:
        return [row[0] for row in conn.execute("SELECT feed_id FROM feeds ORDER BY feed_id")]


def test_511_needs_a_key(data_dir, capsys):
    with pytest.raises(SystemExit):
        download.main(["--source", "511"])
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
    download.main(["--source", "511"])
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
        download.main(["--source", "511"])
    out = capsys.readouterr()
    assert SECRET not in out.out + out.err
    assert "Download failed: 511 SF Bay regional feed: ConnectError" in out.err


def test_511_says_when_the_key_is_rejected(data_dir, monkeypatch, capsys):
    monkeypatch.setenv("API_511_KEY", SECRET)
    serve(monkeypatch, lambda _: httpx.Response(401, text="This API key provided is invalid."))
    with pytest.raises(SystemExit):
        download.main(["--source", "511"])
    err = capsys.readouterr().err
    assert "HTTP 401: 511.org rejected API_511_KEY" in err
    assert SECRET not in err


def test_511_builds_from_the_regional_feed_only(data_dir, feed_zip):
    # Agency feeds on disk too: they must not be loaded alongside the regional one.
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    shutil.copy(feed_zip, data_dir / "feeds" / "bart.zip")
    download.main(["--source", "511", "--skip-download"])
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]


def test_agencies_ignore_a_downloaded_regional_feed(data_dir, feed_zip):
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    shutil.copy(feed_zip, data_dir / "feeds" / "bart.zip")
    download.main(["--skip-download"])
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bart"]


def test_source_can_come_from_the_environment(data_dir, feed_zip, monkeypatch):
    monkeypatch.setenv("GTFS_SOURCE", "511")
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--skip-download"])
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]


def test_summary_lists_agencies_whose_schedules_run_out(data_dir, bus_ends_early_zip, capsys):
    shutil.copy(bus_ends_early_zip, data_dir / "feeds" / "bayarea.zip")
    download.main(["--source", "511", "--skip-download"])
    capsys.readouterr()
    download._print_summary(data_dir / "gtfs.sqlite", today=dt.date(2026, 11, 15))
    out = capsys.readouterr().out
    assert "Test Bus" in out
    assert "until 2026-10-31  <-- EXPIRED, re-download" in out
    assert "Test Rail" not in out  # until 2026-12-31: not within 30 days
    assert ".." not in out  # no feed-wide date range, which would hide the bus
