from __future__ import annotations

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


def test_511_download_never_shows_the_key(data_dir, monkeypatch, capsys):
    monkeypatch.setenv("API_511_KEY", SECRET)
    seen = {}

    def fake_stream(method, url, params=None, **kwargs):
        seen["params"] = params
        # httpx errors quote the full request URL, key included.
        raise httpx.ConnectError(f"cannot reach {url}?api_key={params['api_key']}")

    monkeypatch.setattr(download.httpx, "stream", fake_stream)
    with pytest.raises(SystemExit):
        download.main(["--source", "511"])
    out = capsys.readouterr()
    assert seen["params"] == {"api_key": SECRET}
    assert SECRET not in out.out + out.err
    assert "Download failed: 511 SF Bay regional feed: ConnectError" in out.err


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
