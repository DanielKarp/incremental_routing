"""Downloading the 511 feed and building the full database from it (download.py)."""

from __future__ import annotations

import datetime as dt
import shutil
import sqlite3

import httpx
import pytest

from incremental_routing.config import Settings
from incremental_routing.gtfs import download
from incremental_routing.gtfs.download import RefreshError

SECRET = "not-a-real-key-123"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("IR_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("API_511_KEY", raising=False)
    (tmp_path / "feeds").mkdir()
    return tmp_path


def refresh(data_dir, *, download_feed: bool = True) -> None:
    download.refresh(Settings(), download=download_feed, db_path=data_dir / "gtfs.sqlite")


def feed_ids(db_path) -> list[str]:
    with sqlite3.connect(db_path) as conn:
        return [row[0] for row in conn.execute("SELECT feed_id FROM feeds ORDER BY feed_id")]


def test_511_needs_a_key(data_dir):
    with pytest.raises(RefreshError, match="API_511_KEY"):
        refresh(data_dir)


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
    refresh(data_dir)
    # Both parameters must survive: the operator in the feed URL, and the key added to it.
    assert requests[0].url.params["operator_id"] == "RG"
    assert requests[0].url.params["api_key"] == SECRET
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]


def test_511_download_never_shows_the_key(data_dir, monkeypatch):
    monkeypatch.setenv("API_511_KEY", SECRET)

    def unreachable(request: httpx.Request) -> httpx.Response:
        # httpx errors can quote the full request URL, key included.
        raise httpx.ConnectError(f"cannot reach {request.url}", request=request)

    serve(monkeypatch, unreachable)
    with pytest.raises(RefreshError) as failure:
        refresh(data_dir)
    assert str(failure.value) == "Download failed: 511 SF Bay regional feed: ConnectError"
    assert failure.value.__cause__ is None and failure.value.__suppress_context__


def test_a_download_that_is_not_a_zip_keeps_the_feed_we_have(data_dir, monkeypatch):
    monkeypatch.setenv("API_511_KEY", SECRET)
    (data_dir / "feeds" / "bayarea.zip").write_bytes(b"the previous feed")
    serve(monkeypatch, lambda _: httpx.Response(200, text="<html>Service unavailable</html>"))
    with pytest.raises(RefreshError, match="not a GTFS zip file"):
        refresh(data_dir)
    assert (data_dir / "feeds" / "bayarea.zip").read_bytes() == b"the previous feed"
    assert not (data_dir / "feeds" / "bayarea.zip.part").exists()


def test_511_says_when_the_key_is_rejected(data_dir, monkeypatch):
    monkeypatch.setenv("API_511_KEY", SECRET)
    serve(monkeypatch, lambda _: httpx.Response(401, text="This API key provided is invalid."))
    with pytest.raises(RefreshError) as failure:
        refresh(data_dir)
    assert "HTTP 401: 511.org rejected API_511_KEY" in str(failure.value)
    assert SECRET not in str(failure.value)


def test_builds_from_the_downloaded_feed_without_a_key(data_dir, feed_zip):
    # An agency feed left over from older versions is ignored.
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    shutil.copy(feed_zip, data_dir / "feeds" / "bart.zip")
    refresh(data_dir, download_feed=False)
    assert feed_ids(data_dir / "gtfs.sqlite") == ["bayarea"]


def test_building_needs_a_downloaded_feed(data_dir):
    with pytest.raises(RefreshError, match="no downloaded feed"):
        refresh(data_dir, download_feed=False)


def test_summary_lists_agencies_whose_schedules_run_out(data_dir, bus_ends_early_zip, capsys):
    shutil.copy(bus_ends_early_zip, data_dir / "feeds" / "bayarea.zip")
    refresh(data_dir, download_feed=False)
    capsys.readouterr()
    download._print_summary(data_dir / "gtfs.sqlite", today=dt.date(2026, 11, 15))
    out = capsys.readouterr().out
    assert "Test Bus" in out
    assert "until 2026-10-31  <-- EXPIRED, re-download" in out
    assert "Test Rail" not in out  # until 2026-12-31: not within 30 days
    assert ".." not in out  # no feed-wide date range, which would hide the bus


def test_summary_says_when_no_schedule_ends_soon(data_dir, feed_zip, capsys):
    shutil.copy(feed_zip, data_dir / "feeds" / "bayarea.zip")
    refresh(data_dir, download_feed=False)
    capsys.readouterr()
    download._print_summary(data_dir / "gtfs.sqlite", today=dt.date(2026, 10, 12))
    out = capsys.readouterr().out
    assert "bayarea: 2 agencies, 7 stops, 6 trips" in out
    assert "Every agency's schedule runs past 2026-11-11." in out
